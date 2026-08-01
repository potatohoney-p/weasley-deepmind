/**
 * Unit tests: redactPrompt — 민감 데이터 마스킹
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { redactPrompt } from "../../lib/llm/util/redact-prompt.js";

describe("redactPrompt — 민감 패턴 마스킹", () => {

  it("Authorization Bearer 헤더를 마스킹한다", () => {
    const input  = "Authorization: Bearer sk-ant-abc123def456";
    const result = redactPrompt(input);
    assert.ok(!result.includes("sk-ant-abc123def456"), "원본 토큰이 노출되어서는 안 됨");
    assert.ok(result.includes("Bearer"), "Bearer 접두사는 유지되어야 함");
  });

  it("단독 Bearer 값을 마스킹한다", () => {
    const input  = "Bearer mySecretToken999";
    const result = redactPrompt(input);
    assert.ok(!result.includes("mySecretToken999"), "토큰이 노출되어서는 안 됨");
    assert.ok(result.includes("****"), "마스킹 표시 포함 필요");
  });

  it("mmcp_ API 키를 마스킹한다", () => {
    const input  = "api_key=mmcp_AbCd1234Ef56";
    const result = redactPrompt(input);
    assert.ok(!result.includes("mmcp_AbCd1234Ef56"), "mmcp_ 키가 노출되어서는 안 됨");
    assert.ok(result.includes("mmcp_****"), "mmcp_ 마스킹 패턴 포함 필요");
  });

  it("sk-ant- Anthropic API 키를 마스킹한다 (EXTRA_LLM_PATTERNS)", () => {
    const input  = "Please use sk-ant-api03-XXXXXXXX to call Claude";
    const result = redactPrompt(input);
    assert.ok(!result.includes("sk-ant-api03-XXXXXXXX"), "sk-ant- 키 노출 금지");
    assert.ok(result.includes("sk-ant-****"), "sk-ant- 마스킹 패턴 확인");
  });

  it("sk- OpenAI API 키를 마스킹한다 (EXTRA_LLM_PATTERNS)", () => {
    const input  = "openai_key = sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh";
    const result = redactPrompt(input);
    assert.ok(!result.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh"), "sk- 키 노출 금지");
    assert.ok(result.includes("sk-****"), "sk- 마스킹 패턴 확인");
  });

  it("gsk_ Google API 키를 마스킹한다 (EXTRA_LLM_PATTERNS)", () => {
    const input  = "google_key=gsk_testkey1234abcd";
    const result = redactPrompt(input);
    assert.ok(!result.includes("gsk_testkey1234abcd"), "gsk_ 키 노출 금지");
    assert.ok(result.includes("gsk_****"), "gsk_ 마스킹 패턴 확인");
  });

  it("민감하지 않은 일반 텍스트는 변경하지 않는다", () => {
    const input  = "Hello, world! This is a normal prompt.";
    const result = redactPrompt(input);
    assert.equal(result, input);
  });

  it("빈 문자열은 그대로 반환한다", () => {
    assert.equal(redactPrompt(""), "");
  });

  it("null/undefined는 그대로 반환한다", () => {
    assert.equal(redactPrompt(null), null);
    assert.equal(redactPrompt(undefined), undefined);
  });

  it("복수의 민감 패턴이 혼재할 때 모두 마스킹된다", () => {
    const input  = "key1=mmcp_TESTKEY123 and sk-ant-api-somevalue Authorization: Bearer tok123";
    const result = redactPrompt(input);
    assert.ok(!result.includes("mmcp_TESTKEY123"),     "mmcp_ 키 노출 금지");
    assert.ok(!result.includes("sk-ant-api-somevalue"), "sk-ant- 키 노출 금지");
    assert.ok(!result.includes("tok123"),               "Bearer 토큰 노출 금지");
  });

});
