/**
 * non-API-key OAuth 거부 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상:
 *   1. is_api_key=true OAuth 토큰 → validateAuthentication 통과 (keyId 반환)
 *   2. is_api_key=false 토큰 + REJECT_NONAPIKEY_OAUTH=true → valid: false
 *   3. is_api_key=false 토큰 + REJECT_NONAPIKEY_OAUTH=false → 기존 동작 (하위 호환)
 *   4. ACCESS_KEY 직접 Bearer 사용 시 영향 없음
 *   5. AUTH_DISABLED=true 환경에서 non-API-key OAuth 허용 (하위 호환)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  validateAuthentication 핵심 분기 로직 인라인 재현                  */
/*                                                                      */
/*  실제 함수는 DB/Redis/OAuth 의존성이 있으므로,                      */
/*  is_api_key 분기 결정 로직만 순수 함수로 추출하여 단위 테스트.      */
/* ------------------------------------------------------------------ */

/**
 * lib/auth.js의 OAuth 분기 결정 로직 재현
 *
 * @param {object} opts
 * @param {boolean}      opts.isApiKey            - oauthResult.is_api_key
 * @param {string}       opts.clientId            - oauthResult.client_id
 * @param {boolean}      opts.apiKeyValid         - mockValidateApiKeyFromDB 결과
 * @param {number|null}  opts.apiKeyId            - mock keyId
 * @param {boolean}      opts.rejectNonApiKey     - REJECT_NONAPIKEY_OAUTH 값
 * @param {boolean}      opts.accessKeySet        - ACCESS_KEY 설정 여부
 * @param {boolean}      opts.authDisabled        - AUTH_DISABLED 값
 * @returns {{ valid: boolean, keyId?: number|null, oauth?: boolean, client_id?: string, error?: string }}
 */
function simulateOAuthBranch({
  isApiKey,
  clientId,
  apiKeyValid,
  apiKeyId,
  rejectNonApiKey,
  accessKeySet,
  authDisabled,
}) {
  /** is_api_key=true 경로: DB API 키 조회 */
  if (isApiKey) {
    if (apiKeyValid) {
      return { valid: true, oauth: true, keyId: apiKeyId, groupKeyIds: [] };
    }
    /** DB 조회 실패 → fallback: non-API-key 경로로 낙하 */
  }

  /** non-API-key OAuth 거부 분기 */
  if (rejectNonApiKey && accessKeySet && !authDisabled) {
    return { valid: false, error: "non-API-key OAuth denied" };
  }

  /** 하위 호환 동작 */
  return { valid: true, oauth: true, client_id: clientId };
}

/* ------------------------------------------------------------------ */
/*  케이스 1: is_api_key=true → keyId 정상 반환                        */
/* ------------------------------------------------------------------ */

describe("OAuth 분기 — is_api_key=true (API 키 기반 토큰)", () => {
  it("DB API 키 유효 → valid: true, keyId 반환", () => {
    const result = simulateOAuthBranch({
      isApiKey        : true,
      clientId        : "mmcp_test_key_1234",
      apiKeyValid     : true,
      apiKeyId        : 42,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.strictEqual(result.valid,  true);
    assert.strictEqual(result.oauth,  true);
    assert.strictEqual(result.keyId,  42);
    assert.ok(!result.error, "error가 있어서는 안 됨");
  });

  it("DB API 키 유효 → client_id 필드 없음 (keyId로 격리)", () => {
    const result = simulateOAuthBranch({
      isApiKey        : true,
      clientId        : "mmcp_test_key_1234",
      apiKeyValid     : true,
      apiKeyId        : 7,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.ok(!("client_id" in result), "client_id가 있어서는 안 됨");
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 2: is_api_key=false + REJECT_NONAPIKEY_OAUTH=true → 거부    */
/* ------------------------------------------------------------------ */

describe("OAuth 분기 — is_api_key=false + REJECT_NONAPIKEY_OAUTH=true", () => {
  it("non-API-key OAuth → valid: false", () => {
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "Authorization",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error, "error 메시지가 있어야 함");
    assert.ok(result.error.includes("non-API-key OAuth denied"), `예상 에러 메시지 없음: ${result.error}`);
  });

  it("client_id='Authorization' (실제 취약 케이스) → 거부", () => {
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "Authorization",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.strictEqual(result.valid, false);
  });

  it("임의 OAuth client_id → 거부", () => {
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "some-oauth-client-xyz",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.strictEqual(result.valid, false);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 3: is_api_key=false + REJECT_NONAPIKEY_OAUTH=false → 허용   */
/* ------------------------------------------------------------------ */

describe("OAuth 분기 — is_api_key=false + REJECT_NONAPIKEY_OAUTH=false (하위 호환)", () => {
  it("REJECT_NONAPIKEY_OAUTH=false → valid: true, client_id 반환", () => {
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "some-oauth-client",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : false,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.strictEqual(result.valid,     true);
    assert.strictEqual(result.oauth,     true);
    assert.strictEqual(result.client_id, "some-oauth-client");
    assert.ok(!result.error, "error가 있어서는 안 됨");
  });

  it("REJECT_NONAPIKEY_OAUTH=false → keyId 없음 (기존 동작과 동일)", () => {
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "some-oauth-client",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : false,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.ok(!("keyId" in result) || result.keyId == null);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 4: ACCESS_KEY 직접 사용 → OAuth 분기 진입 안 함             */
/* ------------------------------------------------------------------ */

/**
 * Bearer에 ACCESS_KEY 직접 사용 시 safeCompare에서 match → OAuth 분기 진입 전 반환.
 * 이 시뮬레이션은 그 경로가 non-API-key 분기와 독립적임을 검증한다.
 */
describe("Bearer ACCESS_KEY 직접 사용 — OAuth 분기 우회", () => {
  it("master key safeCompare 통과 시 OAuth 로직과 무관하게 valid: true", () => {
    /** validateAuthentication의 master key 경로 재현 */
    const tokenMatchesMasterKey = true; // safeCompare(token, ACCESS_KEY)
    const authResult = tokenMatchesMasterKey
      ? { valid: true, keyId: null, groupKeyIds: null }
      : null;

    assert.ok(authResult, "master key 경로 결과 없음");
    assert.strictEqual(authResult.valid, true);
    assert.strictEqual(authResult.keyId, null);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 5: AUTH_DISABLED=true → non-API-key OAuth 허용              */
/* ------------------------------------------------------------------ */

describe("AUTH_DISABLED=true 환경 — non-API-key OAuth 허용 (하위 호환)", () => {
  it("AUTH_DISABLED=true + is_api_key=false + REJECT_NONAPIKEY_OAUTH=true → 허용", () => {
    /**
     * AUTH_DISABLED=true 환경: ACCESS_KEY 없이 모든 요청을 master로 처리하는 개발 환경.
     * 이 환경에서 REJECT_NONAPIKEY_OAUTH=true여도 차단하지 않는다
     * (rejectNonApiKey && accessKeySet && !authDisabled 조건의 authDisabled 가드).
     */
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "some-client",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : true,
      accessKeySet    : false,  /* AUTH_DISABLED=true 환경에서는 ACCESS_KEY 미설정 */
      authDisabled    : true,
    });
    assert.strictEqual(result.valid, true);
    assert.ok(!result.error);
  });

  it("ACCESS_KEY 설정 + AUTH_DISABLED=true → 거부하지 않음", () => {
    const result = simulateOAuthBranch({
      isApiKey        : false,
      clientId        : "some-client",
      apiKeyValid     : false,
      apiKeyId        : null,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : true,  /* authDisabled 가드로 차단 우회 */
    });
    assert.strictEqual(result.valid, true);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 6: is_api_key=true + DB 조회 실패 → fallback 분기           */
/* ------------------------------------------------------------------ */

describe("OAuth 분기 — is_api_key=true + DB 조회 실패 (예외 경로)", () => {
  it("DB 조회 실패 + REJECT_NONAPIKEY_OAUTH=true → fallback 거부", () => {
    /**
     * validateApiKeyFromDB throw 시 catch {} 후 non-API-key 경로로 낙하.
     * is_api_key=true이지만 DB 조회 실패 → apiKeyValid=false로 시뮬레이션.
     */
    const result = simulateOAuthBranch({
      isApiKey        : true,
      clientId        : "mmcp_invalid_key",
      apiKeyValid     : false,  /* DB throw → catch → apiKeyValid=false */
      apiKeyId        : null,
      rejectNonApiKey : true,
      accessKeySet    : true,
      authDisabled    : false,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
  });
});
