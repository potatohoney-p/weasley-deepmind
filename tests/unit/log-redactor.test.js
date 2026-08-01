/**
 * Winston 로그 redactor 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * redactorFormat이 Bearer 토큰, API 키, Cookie, OAuth 파라미터,
 * 긴 content를 올바르게 마스킹하는지 검증한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactorFormat } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// 헬퍼: redactorFormat을 직접 info 객체에 적용
// ---------------------------------------------------------------------------

function applyRedactor(info) {
  const fmt    = redactorFormat();
  const Symbol_level = Symbol.for("level");
  const Symbol_splat = Symbol.for("splat");
  const enriched     = Object.assign({ [Symbol_level]: info.level ?? "info", [Symbol_splat]: [] }, info);
  return fmt.transform(enriched, {});
}

// ---------------------------------------------------------------------------
// Authorization Bearer 토큰 마스킹
// ---------------------------------------------------------------------------

describe("redactorFormat — Bearer 토큰 마스킹", () => {
  it("message 내 Bearer 토큰을 마스킹한다", () => {
    const result = applyRedactor({ message: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret" });
    assert.ok(result.message.includes("Bearer ****"), `expected masked, got: ${result.message}`);
    assert.ok(!result.message.includes("eyJhbGciOiJIUzI1NiJ9.secret"), "원본 토큰이 노출됨");
  });

  it("메타 객체 내 Authorization 헤더 값을 마스킹한다", () => {
    const result = applyRedactor({
      message : "Request",
      headers : { Authorization: "Bearer my-secret-token" }
    });
    assert.ok(result.headers.Authorization.includes("****"), "Bearer 토큰 미마스킹");
    assert.ok(!result.headers.Authorization.includes("my-secret-token"), "원본 토큰이 노출됨");
  });
});

// ---------------------------------------------------------------------------
// mmcp_ API 키 마스킹
// ---------------------------------------------------------------------------

describe("redactorFormat — mmcp_ API 키 마스킹", () => {
  it("message 내 mmcp_ 키를 마스킹한다", () => {
    const result = applyRedactor({ message: "API key used: mmcp_abc123XYZ" });
    assert.ok(result.message.includes("mmcp_****"), `expected mmcp_****, got: ${result.message}`);
    assert.ok(!result.message.includes("mmcp_abc123XYZ"), "원본 키가 노출됨");
  });

  it("메타 내 mmcp_ 키를 마스킹한다", () => {
    const result = applyRedactor({ message: "key check", apiKey: "mmcp_deadbeef00" });
    assert.strictEqual(result.apiKey, "mmcp_****");
  });
});

// ---------------------------------------------------------------------------
// Cookie mmcp_session 마스킹
// ---------------------------------------------------------------------------

describe("redactorFormat — Cookie mmcp_session 마스킹", () => {
  it("Cookie 헤더의 mmcp_session 값을 마스킹한다", () => {
    const result = applyRedactor({
      message : "Incoming request",
      cookie  : "mmcp_session=abcdef1234567890; other=value"
    });
    assert.ok(result.cookie.includes("mmcp_session=****"), `got: ${result.cookie}`);
    assert.ok(!result.cookie.includes("abcdef1234567890"), "세션 값이 노출됨");
  });
});

// ---------------------------------------------------------------------------
// OAuth 파라미터 마스킹
// ---------------------------------------------------------------------------

describe("redactorFormat — OAuth 파라미터 마스킹", () => {
  it("JSON 직렬화된 code 값을 마스킹한다", () => {
    const payload = JSON.stringify({ code: "auth-code-xyz", state: "s1" });
    const result  = applyRedactor({ message: `OAuth callback: ${payload}` });
    assert.ok(!result.message.includes("auth-code-xyz"), "OAuth code가 노출됨");
    assert.ok(result.message.includes('"code"'), '"code" 키 자체가 사라짐');
  });

  it("refresh_token 값을 마스킹한다", () => {
    const payload = JSON.stringify({ refresh_token: "rt-supersecret", expires_in: 3600 });
    const result  = applyRedactor({ message: payload });
    assert.ok(!result.message.includes("rt-supersecret"), "refresh_token이 노출됨");
  });

  it("access_token 값을 마스킹한다", () => {
    const payload = JSON.stringify({ access_token: "at-mysecrettoken" });
    const result  = applyRedactor({ message: payload });
    assert.ok(!result.message.includes("at-mysecrettoken"), "access_token이 노출됨");
  });
});

// ---------------------------------------------------------------------------
// content 200자 초과 시 트리밍
// ---------------------------------------------------------------------------

describe("redactorFormat — content 트리밍", () => {
  it("200자 이하 content는 그대로 유지한다", () => {
    const short  = "단기 content".repeat(10);  // < 200자
    const result = applyRedactor({ message: "ok", content: short });
    assert.strictEqual(result.content, short);
  });

  it("200자 초과 content는 head 50 + ...[REDACTED]... + tail 50 형태로 트리밍된다", () => {
    const long   = "A".repeat(50) + "B".repeat(200) + "C".repeat(50);  // 300자
    const result = applyRedactor({ message: "long content", content: long });

    assert.ok(result.content.includes("...[REDACTED]..."), "REDACTED 마커 없음");
    assert.ok(result.content.startsWith("A".repeat(50)), "head 50자 누락");
    assert.ok(result.content.endsWith("C".repeat(50)), "tail 50자 누락");
    assert.ok(!result.content.includes("B".repeat(200)), "중간 내용이 트리밍 안 됨");
  });

  it("중첩 객체 내 content도 트리밍된다", () => {
    const long   = "X".repeat(300);
    const result = applyRedactor({ message: "nested", fragment: { content: long } });
    assert.ok(result.fragment.content.includes("...[REDACTED]..."), "중첩 content 트리밍 안 됨");
  });
});

// ---------------------------------------------------------------------------
// 비민감 데이터는 변경되지 않는다
// ---------------------------------------------------------------------------

describe("redactorFormat — 비민감 데이터 보존", () => {
  it("일반 메시지는 변경 없이 그대로 반환한다", () => {
    const result = applyRedactor({ message: "Server started on port 57332" });
    assert.strictEqual(result.message, "Server started on port 57332");
  });

  it("숫자, boolean 값은 변경하지 않는다", () => {
    const result = applyRedactor({ message: "metrics", count: 42, active: true });
    assert.strictEqual(result.count, 42);
    assert.strictEqual(result.active, true);
  });
});
