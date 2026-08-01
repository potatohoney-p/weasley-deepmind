/**
 * Symbolic Rule Pack Registry
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 규칙 패키지를 rule_version 단위로 등록한다. Orchestrator 는 이 registry 를
 * 통해서만 규칙에 접근한다. 새로운 rule_version (v2, v3...) 추가 시 이 파일에
 * 신규 pack 을 등록하고 fragment_claims.rule_version 컬럼과 매칭시킨다.
 *
 * Phase 0 에서 실구현되는 모드는 explain / shadow 뿐. 나머지 모드는 Phase 3+
 * 에서 확장된다.
 */

import { buildReasonCodes } from "./v1/explain.js";

const SUPPORTED_MODES_V1 = new Set(["recall", "remember", "link", "explain", "shadow"]);

/**
 * v1 RulePack — explain / shadow 모드에서 reason code 빌더 호출
 */
const rulePackV1 = Object.freeze({
  version: "v1",

  /**
   * @param {string} mode                      - evaluate mode
   * @param {Array}  candidates                - 평가 대상 (모드별 의미 상이)
   * @param {Object} ctx                       - 호출 컨텍스트 (searchPath 등 포함)
   * @param {string} [correlationId]           - 상관관계 ID (추후 로깅/트레이싱용)
   * @returns {Promise<Array> | Array}
   */
  evaluate(mode, candidates, ctx /* , correlationId */) {
    if (!SUPPORTED_MODES_V1.has(mode)) {
      return [];
    }

    if (mode === "explain" || mode === "shadow") {
      const list = Array.isArray(candidates) ? candidates : [];
      return list.map((fragment) => ({
        fragmentId: fragment && fragment.id,
        reasons   : buildReasonCodes(fragment, ctx || {})
      }));
    }

    /** recall / remember / link 는 Phase 3 이후 실구현, Phase 0 은 빈 결과 */
    return [];
  }
});

const RULE_PACKS = Object.freeze({
  v1: rulePackV1
});

/**
 * rule_version 식별자로 rule pack 을 조회한다.
 * @param {string} version
 * @returns {{version:string, evaluate:Function} | null}
 */
export function getRulePack(version) {
  if (!version) return null;
  return RULE_PACKS[version] || null;
}

/** 등록된 rule version 목록 (선택적 디버깅 용도) */
export function listRuleVersions() {
  return Object.keys(RULE_PACKS);
}
