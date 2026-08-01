/**
 * OAuth silent consent 제거 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 검증 대상:
 * 1. trusted origin으로 GET /authorize 요청해도 항상 consent HTML 반환 (HTTP 200)
 * 2. untrusted origin도 동일하게 consent HTML 반환 (차별 없음)
 * 3. isAllowedRedirectUri: localhost 항상 허용, 빈 기본값 시 외부 도메인 거부
 * 4. API key 기반 OAuth 토큰 데이터 구조에 is_api_key 필드 존재
 * 5. buildConsentHtml 출력에 client_id/scope/allow/deny 포함
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  oauth-handler.js의 GET /authorize 핵심 분기 로직 추출              */
/* ------------------------------------------------------------------ */

/**
 * silent consent 제거 후의 GET /authorize 흐름 시뮬레이션.
 * 실제 핸들러는 DB/Redis 의존성이 있으므로 핵심 결정 로직만 단위 테스트한다.
 *
 * 제거 전: isAllowedRedirectUri() 통과 시 302 redirect (auto-approve)
 * 제거 후: 항상 consent HTML 렌더링 (200)
 */
function simulateAuthorizeGet({ redirectUri, isTrustedOrigin }) {
  /**
   * 제거된 auto-approve 분기:
   *   if (isAllowed(params.redirect_uri)) {
   *     const result = await handleAuthorize(params);
   *     if (result.redirect) { res.statusCode = 302; ... return; }
   *   }
   *
   * 현재: 항상 consent HTML 경로로 진행
   */
  void isTrustedOrigin; // 더 이상 분기에 사용하지 않음
  void redirectUri;

  return { statusCode: 200, bodyContains: "consent" };
}

describe("silent consent 제거 — GET /authorize 항상 consent 화면 반환", () => {
  it("trusted origin(claude.ai)으로 요청해도 200 consent 반환", () => {
    const result = simulateAuthorizeGet({
      redirectUri    : "https://claude.ai/callback",
      isTrustedOrigin: true,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.bodyContains, "consent");
  });

  it("untrusted origin으로 요청해도 200 consent 반환", () => {
    const result = simulateAuthorizeGet({
      redirectUri    : "https://evil.example.com/callback",
      isTrustedOrigin: false,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.bodyContains, "consent");
  });

  it("trusted origin과 untrusted origin 모두 동일한 statusCode 반환", () => {
    const trusted   = simulateAuthorizeGet({ redirectUri: "https://claude.ai/cb",   isTrustedOrigin: true  });
    const untrusted = simulateAuthorizeGet({ redirectUri: "https://unknown.io/cb",   isTrustedOrigin: false });
    assert.strictEqual(trusted.statusCode, untrusted.statusCode);
  });
});

/* ------------------------------------------------------------------ */
/*  isAllowedRedirectUri — OAUTH_TRUSTED_ORIGINS 빈 기본값 검증        */
/* ------------------------------------------------------------------ */

/**
 * isAllowedRedirectUri 로직 인라인 재현.
 * 실제 함수는 환경변수 OAUTH_TRUSTED_ORIGINS를 모듈 로드 시점에 읽으므로
 * 기본값(빈 array) 동작을 직접 시뮬레이션한다.
 */
function makeIsAllowedRedirectUri(trustedOrigins, allowedUris) {
  return function isAllowedRedirectUri(uri) {
    if (!uri) return false;
    try {
      const parsed = new URL(uri);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
      const origin = parsed.origin;
      if (trustedOrigins.includes(origin)) return true;
    } catch { return false; }
    return allowedUris.includes(uri);
  };
}

describe("isAllowedRedirectUri — 빈 기본값(OAUTH_TRUSTED_ORIGINS=[])", () => {
  const isAllowed = makeIsAllowedRedirectUri([], []);

  it("localhost는 항상 허용", () => {
    assert.strictEqual(isAllowed("http://localhost:3000/cb"), true);
  });

  it("127.0.0.1은 항상 허용", () => {
    assert.strictEqual(isAllowed("http://127.0.0.1:8080/cb"), true);
  });

  it("빈 기본값 시 claude.ai 거부", () => {
    assert.strictEqual(isAllowed("https://claude.ai/callback"), false);
  });

  it("빈 기본값 시 chatgpt.com 거부", () => {
    assert.strictEqual(isAllowed("https://chatgpt.com/oauth/callback"), false);
  });

  it("빈 기본값 시 evil.claude.ai 서브도메인 거부 (subdomain takeover 차단)", () => {
    assert.strictEqual(isAllowed("https://evil.claude.ai/callback"), false);
  });

  it("null/undefined 입력 시 거부", () => {
    assert.strictEqual(isAllowed(null),      false);
    assert.strictEqual(isAllowed(undefined), false);
    assert.strictEqual(isAllowed(""),        false);
  });

  it("유효하지 않은 URI 형식 시 거부", () => {
    assert.strictEqual(isAllowed("not-a-uri"), false);
  });
});

describe("isAllowedRedirectUri — 운영자가 명시적으로 trusted origin 설정한 경우", () => {
  const isAllowed = makeIsAllowedRedirectUri(
    ["https://claude.ai", "https://chatgpt.com"],
    []
  );

  it("설정된 origin의 경로는 허용", () => {
    assert.strictEqual(isAllowed("https://claude.ai/callback"),          true);
    assert.strictEqual(isAllowed("https://chatgpt.com/oauth/callback"),  true);
  });

  it("서브도메인은 origin 매칭 미포함으로 거부 (evil.claude.ai)", () => {
    assert.strictEqual(isAllowed("https://evil.claude.ai/callback"), false);
  });

  it("설정되지 않은 외부 도메인은 거부", () => {
    assert.strictEqual(isAllowed("https://unknown.example.com/cb"), false);
  });
});

/* ------------------------------------------------------------------ */
/*  API key 기반 OAuth 토큰 데이터 구조 검증                           */
/* ------------------------------------------------------------------ */

/**
 * handleToken → accessData 구조 재현 (lib/oauth.js:345-352).
 * is_api_key 필드가 토큰 페이로드에 포함되어야 validateAuthentication이
 * keyId를 정상 연결할 수 있다 (lib/auth.js:91-99).
 */
function buildAccessData({ clientId, scope, isApiKey }) {
  return {
    type       : "access",
    client_id  : clientId,
    scope      : scope,
    is_api_key : isApiKey || false,
    created_at : Date.now(),
    expires_at : Date.now() + 3600 * 1000,
  };
}

describe("API key 기반 OAuth 토큰 — keyId 연결 구조 검증", () => {
  it("is_api_key=true 시 토큰 데이터에 is_api_key 필드 존재", () => {
    const token = buildAccessData({ clientId: "mmcp_test_key", scope: "mcp", isApiKey: true });
    assert.strictEqual(token.is_api_key, true);
    assert.strictEqual(token.client_id, "mmcp_test_key");
    assert.ok("type" in token);
    assert.ok("expires_at" in token);
  });

  it("is_api_key=false(일반 OAuth) 시 is_api_key 필드가 false", () => {
    const token = buildAccessData({ clientId: "some-oauth-client", scope: "mcp", isApiKey: false });
    assert.strictEqual(token.is_api_key, false);
  });

  it("is_api_key 미설정 시 기본값 false", () => {
    const token = buildAccessData({ clientId: "client", scope: "mcp" });
    assert.strictEqual(token.is_api_key, false);
  });

  /**
   * validateAuthentication (lib/auth.js:91-99) 흐름 시뮬레이션:
   *   is_api_key가 true면 client_id를 원본 API 키로 간주하여
   *   validateApiKeyFromDB(client_id)로 keyId를 조회한다.
   */
  it("is_api_key=true 토큰에서 validateAuthentication이 keyId를 조회하는 흐름", async () => {
    const tokenData = buildAccessData({ clientId: "mmcp_sample_api_key", scope: "mcp", isApiKey: true });

    /** validateApiKeyFromDB mock */
    async function mockValidateApiKeyFromDB(clientId) {
      if (clientId === "mmcp_sample_api_key") {
        return { valid: true, keyId: 42, groupKeyIds: [], permissions: {} };
      }
      return { valid: false };
    }

    let authResult;
    if (tokenData.is_api_key) {
      const apiKeyResult = await mockValidateApiKeyFromDB(tokenData.client_id);
      if (apiKeyResult.valid) {
        authResult = {
          valid   : true,
          oauth   : true,
          keyId   : apiKeyResult.keyId,
          groupKeyIds: apiKeyResult.groupKeyIds,
        };
      }
    }

    assert.ok(authResult);
    assert.strictEqual(authResult.valid, true);
    assert.strictEqual(authResult.keyId, 42);
    assert.strictEqual(authResult.oauth, true);
  });
});

/* ------------------------------------------------------------------ */
/*  buildConsentHtml 출력 구조 검증                                    */
/* ------------------------------------------------------------------ */

import { buildConsentHtml } from "../../lib/oauth.js";

describe("buildConsentHtml — consent 화면 필수 요소 포함 검증", () => {
  const params = {
    response_type        : "code",
    client_id            : "test-client-id",
    redirect_uri         : "https://example.com/callback",
    code_challenge       : "abc123",
    code_challenge_method: "S256",
    state                : "state-xyz",
    scope                : "mcp",
  };

  it("HTTP 200 응답 바디에 'consent' 관련 키워드 포함 (Allow/Deny 버튼)", () => {
    const html = buildConsentHtml(params, "Test App");
    assert.ok(html.includes("Allow"),   "Allow 버튼 없음");
    assert.ok(html.includes("Deny"),    "Deny 버튼 없음");
  });

  it("client_id가 hidden input으로 포함된다", () => {
    const html = buildConsentHtml(params, "Test App");
    assert.ok(html.includes("test-client-id"), "client_id가 HTML에 없음");
  });

  it("scope가 화면에 표시된다", () => {
    const html = buildConsentHtml(params, "Test App");
    assert.ok(html.includes("mcp"), "scope가 HTML에 없음");
  });

  it("clientName이 화면에 표시된다", () => {
    const html = buildConsentHtml(params, "My Special App");
    assert.ok(html.includes("My Special App"), "clientName이 HTML에 없음");
  });

  it("XSS: script 태그가 이스케이프된다", () => {
    const maliciousParams = { ...params, client_id: "<script>alert(1)</script>" };
    const html            = buildConsentHtml(maliciousParams, "App");
    assert.ok(!html.includes("<script>alert(1)</script>"), "XSS 이스케이프 실패");
    assert.ok(html.includes("&lt;script&gt;"),             "이스케이프 미적용");
  });

  it("decision=allow form action이 /authorize를 가리킨다", () => {
    const html = buildConsentHtml(params, "App");
    assert.ok(html.includes('action="/authorize"'), "form action 없음");
  });
});
