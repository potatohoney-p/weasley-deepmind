/**
 * SymbolicOrchestrator — symbolic 서브시스템 진입점 (v2.8.0 Phase 0)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 설계 원칙:
 * 1. ctx.keyId 는 서버 인증 계층에서 주입한 값만 신뢰한다. 클라이언트 payload
 *    의 _keyId 는 여기까지 전파되지 않아야 한다 (RBAC/tenant isolation 유지).
 * 2. 모든 evaluate 호출은 rule_version 과 correlation_id 를 동반한다.
 * 3. timeout 초과 시 degraded=true 로 반환하며 절대 throw 하지 않는다
 *    (신경 경로가 symbolic 문제로 실패하면 안 된다).
 * 4. config.enabled=false 이면 즉시 Noop 반환 (비용 0).
 *
 * 지원 모드:
 * - recall   : recall 후 결과 필터링/정렬 힌트
 * - remember : remember 시 claim/정책 검증
 * - link     : 링크 생성 시 integrity 검증
 * - explain  : recall 결과에 대한 reason code 생성 (Phase 2)
 * - shadow   : 규칙 평가를 기록만 하고 적용하지 않음 (Phase 1)
 *
 * Phase 0 에서는 explain / shadow 만 실제 규칙 실행. 나머지 모드는 빈 결과.
 */

import { SYMBOLIC_CONFIG } from "../../config/symbolic.js";
import { symbolicMetrics } from "./SymbolicMetrics.js";
import { getRulePack }     from "./rules/index.js";
import { logWarn }         from "../logger.js";

/** 지원 모드 집합 (평가 전 guard) */
const SUPPORTED_MODES = new Set(["recall", "remember", "link", "explain", "shadow"]);

/** 에러 코드 상수 */
const ERROR_CODES = Object.freeze({
  UNSUPPORTED_MODE        : "UNSUPPORTED_MODE",
  RULE_VERSION_UNSUPPORTED: "RULE_VERSION_UNSUPPORTED",
  TIMEOUT                 : "TIMEOUT",
  EVAL_ERROR              : "EVAL_ERROR"
});

export class SymbolicOrchestrator {
  /**
   * @param {Object} [deps]
   * @param {Object}   [deps.config]       - SYMBOLIC_CONFIG 오버라이드 (테스트용)
   * @param {Object}   [deps.metrics]      - SymbolicMetrics facade 오버라이드 (테스트용)
   * @param {Function} [deps.rulePackLoader] - (version) => rulePack 주입 (테스트용).
   *                                            프로덕션은 rules/index.js 의 getRulePack 사용.
   */
  constructor({ config = SYMBOLIC_CONFIG, metrics = symbolicMetrics, rulePackLoader = getRulePack } = {}) {
    this.config         = config;
    this.metrics        = metrics;
    this.rulePackLoader = rulePackLoader;
  }

  /**
   * 내부: Noop 결과 빌더
   * @param {string} ruleVersion
   * @param {number} runtimeMs
   * @returns {Object}
   */
  _noopResult(ruleVersion, runtimeMs) {
    return {
      ok         : true,
      results    : [],
      degraded   : false,
      runtimeMs  : runtimeMs,
      ruleVersion: ruleVersion
    };
  }

  /**
   * 내부: 에러 결과 빌더
   * @param {string} errorCode
   * @param {boolean} degraded
   * @param {string} ruleVersion
   * @param {number} runtimeMs
   * @returns {Object}
   */
  _errorResult(errorCode, degraded, ruleVersion, runtimeMs) {
    return {
      ok         : false,
      results    : [],
      degraded   : degraded,
      errorCode  : errorCode,
      runtimeMs  : runtimeMs,
      ruleVersion: ruleVersion
    };
  }

  /**
   * symbolic 규칙 평가
   *
   * @param {Object} input
   * @param {('recall'|'remember'|'link'|'explain'|'shadow')} input.mode
   * @param {Array}  [input.candidates]    - 평가 대상 (모드별 의미 상이)
   * @param {Object} [input.ctx]           - 호출 컨텍스트 (keyId 는 서버 인증값)
   * @param {number} [input.timeoutMs]     - 단일 호출 timeout (기본 config)
   * @param {string} [input.ruleVersion]   - 규칙 패키지 버전 (기본 config)
   * @param {string} [input.correlationId] - 상관관계 ID
   * @returns {Promise<{
   *   ok: boolean,
   *   results: Array,
   *   degraded: boolean,
   *   errorCode?: string,
   *   runtimeMs: number,
   *   ruleVersion: string
   * }>}
   */
  async evaluate(input) {
    const t0          = Date.now();
    const ruleVersion = (input && input.ruleVersion) || this.config.ruleVersion;

    /** 1. 마스터 킬 스위치: enabled=false → 즉시 Noop */
    if (!this.config.enabled) {
      return this._noopResult(ruleVersion, 0);
    }

    if (!input || typeof input !== "object") {
      return this._errorResult(ERROR_CODES.UNSUPPORTED_MODE, false, ruleVersion, Date.now() - t0);
    }

    const mode          = input.mode;
    const candidates    = input.candidates || [];
    const ctx           = input.ctx || {};
    const timeoutMs     = Number.isFinite(input.timeoutMs) ? input.timeoutMs : this.config.timeoutMs;
    const correlationId = input.correlationId;

    /** 2. 모드 guard */
    if (!SUPPORTED_MODES.has(mode)) {
      return this._errorResult(ERROR_CODES.UNSUPPORTED_MODE, false, ruleVersion, Date.now() - t0);
    }

    /** 3. rule_version guard */
    const rulePack = this.rulePackLoader(ruleVersion);
    if (!rulePack) {
      return this._errorResult(ERROR_CODES.RULE_VERSION_UNSUPPORTED, false, ruleVersion, Date.now() - t0);
    }

    /** 4. timeout race + 에러 격리 */
    let timeoutHandle = null;
    try {
      const evalPromise = Promise.resolve().then(() => rulePack.evaluate(mode, candidates, ctx, correlationId));
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
      });

      const result = await Promise.race([evalPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);

      const runtimeMs = Date.now() - t0;
      this.metrics.observeLatency(`orchestrator.${mode}`, runtimeMs);

      return {
        ok         : true,
        results    : Array.isArray(result) ? result : [],
        degraded   : false,
        runtimeMs  : runtimeMs,
        ruleVersion: ruleVersion
      };
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const runtimeMs = Date.now() - t0;
      const isTimeout = err && err.message === "TIMEOUT";

      if (!isTimeout) {
        logWarn(`[SymbolicOrchestrator] evaluate failed (${mode}): ${err && err.message}`, {
          mode,
          ruleVersion,
          correlationId
        });
      }

      /** degraded=true : 신경 경로 fallback 으로 처리되어야 함 */
      return this._errorResult(
        isTimeout ? ERROR_CODES.TIMEOUT : ERROR_CODES.EVAL_ERROR,
        true,
        ruleVersion,
        runtimeMs
      );
    }
  }
}

/** 에러 코드 re-export (호출부 switch 용) */
export { ERROR_CODES as SYMBOLIC_ERROR_CODES };
