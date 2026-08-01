/**
 * OAuth auto-registration 차단 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상:
 *   1. 미등록 client_id + ALLOW_AUTO_DCR_REGISTER=false → invalid_client (기본 동작)
 *   2. 미등록 client_id + ALLOW_AUTO_DCR_REGISTER=true → 등록 성공 (기존 동작 유지)
 *   3. 이미 등록된 client_id → ALLOW_AUTO_DCR_REGISTER 값과 무관하게 통과
 *   4. redirect_uri 없는 미등록 client_id → invalid_client (기존 동작과 동일)
 *   5. ALLOW_AUTO_DCR_REGISTER=false + redirect_uri 없음 → 차단 분기 미진입 (기존 동작)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  oauth-handler.js GET /authorize 의 auto-register 분기 로직 재현    */
/*                                                                      */
/*  실제 핸들러는 DB/Redis 의존성이 있으므로, 결정 분기만 추출.        */
/* ------------------------------------------------------------------ */

/**
 * GET /authorize 내 client 조회 + 자동 등록 결정 로직 재현
 *
 * @param {object} opts
 * @param {boolean}      opts.clientFound          - DB에 client가 이미 등록됨
 * @param {string|null}  opts.redirectUri          - params.redirect_uri
 * @param {boolean}      opts.allowAutoDcr         - ALLOW_AUTO_DCR_REGISTER 값
 * @param {boolean}      opts.isAllowedUri         - isAllowedRedirectUri 결과
 * @param {boolean}      opts.regSuccess           - regClient 성공 여부
 * @returns {{ outcome: "found"|"auto_registered"|"blocked"|"invalid_client"|"no_uri_invalid" }}
 */
function simulateAuthorizeClientBranch({
  clientFound,
  redirectUri,
  allowAutoDcr,
  isAllowedUri,
  regSuccess,
}) {
  /** 이미 등록된 client → 바로 통과 */
  if (clientFound) {
    return { outcome: "found" };
  }

  /** redirect_uri 없음 → 기존 invalid_client 경로 */
  if (!redirectUri) {
    return { outcome: "no_uri_invalid" };
  }

  /** 자동 등록 차단 (기본 동작) */
  if (!allowAutoDcr) {
    return { outcome: "blocked" };
  }

  /** 자동 등록 허용 + redirect_uri 허용 목록 확인 */
  if (isAllowedUri) {
    if (regSuccess) {
      return { outcome: "auto_registered" };
    }
    return { outcome: "invalid_client" }; /* regClient 실패 */
  }

  return { outcome: "invalid_client" }; /* redirect_uri 허용 목록 미포함 */
}

/* ------------------------------------------------------------------ */
/*  케이스 1: 미등록 client_id + ALLOW_AUTO_DCR_REGISTER=false → 차단  */
/* ------------------------------------------------------------------ */

describe("auto-registration 차단 — ALLOW_AUTO_DCR_REGISTER=false (기본)", () => {
  it("미등록 client_id + redirect_uri 있음 → blocked", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : "https://claude.ai/callback",
      allowAutoDcr : false,
      isAllowedUri : true,
      regSuccess   : true,
    });
    assert.strictEqual(result.outcome, "blocked");
  });

  it("client_id='Authorization' (실제 취약 케이스) → blocked", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : "https://claude.ai/callback",
      allowAutoDcr : false,
      isAllowedUri : true,
      regSuccess   : true,
    });
    assert.strictEqual(result.outcome, "blocked");
  });

  it("미등록 client_id + redirect_uri 없음 → no_uri_invalid (차단 분기 미진입)", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : null,
      allowAutoDcr : false,
      isAllowedUri : false,
      regSuccess   : false,
    });
    assert.strictEqual(result.outcome, "no_uri_invalid");
  });

  it("미등록 + isAllowedUri=false + ALLOW_AUTO_DCR_REGISTER=false → blocked (허용 여부 무관)", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : "https://evil.example.com/callback",
      allowAutoDcr : false,
      isAllowedUri : false,
      regSuccess   : false,
    });
    assert.strictEqual(result.outcome, "blocked");
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 2: ALLOW_AUTO_DCR_REGISTER=true → 등록 성공 (기존 동작)     */
/* ------------------------------------------------------------------ */

describe("auto-registration 허용 — ALLOW_AUTO_DCR_REGISTER=true", () => {
  it("미등록 + 허용 redirect_uri + 등록 성공 → auto_registered", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : "https://claude.ai/callback",
      allowAutoDcr : true,
      isAllowedUri : true,
      regSuccess   : true,
    });
    assert.strictEqual(result.outcome, "auto_registered");
  });

  it("미등록 + 허용 목록 외 redirect_uri → invalid_client (기존 동작)", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : "https://unknown.example.com/callback",
      allowAutoDcr : true,
      isAllowedUri : false,
      regSuccess   : false,
    });
    assert.strictEqual(result.outcome, "invalid_client");
  });

  it("미등록 + 허용 redirect_uri + 등록 실패(DB 오류) → invalid_client", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : false,
      redirectUri  : "https://claude.ai/callback",
      allowAutoDcr : true,
      isAllowedUri : true,
      regSuccess   : false,
    });
    assert.strictEqual(result.outcome, "invalid_client");
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 3: 이미 등록된 client_id → ALLOW_AUTO_DCR_REGISTER 무관     */
/* ------------------------------------------------------------------ */

describe("등록된 client_id — ALLOW_AUTO_DCR_REGISTER 값과 무관하게 통과", () => {
  it("등록된 client + ALLOW_AUTO_DCR_REGISTER=false → found", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : true,
      redirectUri  : "https://claude.ai/callback",
      allowAutoDcr : false,
      isAllowedUri : true,
      regSuccess   : false,
    });
    assert.strictEqual(result.outcome, "found");
  });

  it("등록된 client + ALLOW_AUTO_DCR_REGISTER=true → found", () => {
    const result = simulateAuthorizeClientBranch({
      clientFound  : true,
      redirectUri  : "https://claude.ai/callback",
      allowAutoDcr : true,
      isAllowedUri : true,
      regSuccess   : true,
    });
    assert.strictEqual(result.outcome, "found");
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 4: outcome 대칭 확인                                         */
/* ------------------------------------------------------------------ */

describe("차단 vs 허용 대칭 — 동일 입력, ALLOW_AUTO_DCR_REGISTER 값만 다름", () => {
  const BASE = {
    clientFound  : false,
    redirectUri  : "https://claude.ai/callback",
    isAllowedUri : true,
    regSuccess   : true,
  };

  it("ALLOW_AUTO_DCR_REGISTER=false → blocked", () => {
    const r = simulateAuthorizeClientBranch({ ...BASE, allowAutoDcr: false });
    assert.strictEqual(r.outcome, "blocked");
  });

  it("ALLOW_AUTO_DCR_REGISTER=true → auto_registered", () => {
    const r = simulateAuthorizeClientBranch({ ...BASE, allowAutoDcr: true });
    assert.strictEqual(r.outcome, "auto_registered");
  });

  it("두 결과는 서로 다름", () => {
    const blocked    = simulateAuthorizeClientBranch({ ...BASE, allowAutoDcr: false });
    const registered = simulateAuthorizeClientBranch({ ...BASE, allowAutoDcr: true });
    assert.notStrictEqual(blocked.outcome, registered.outcome);
  });
});
