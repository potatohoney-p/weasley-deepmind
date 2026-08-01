/**
 * LLM Timeout 실측 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 실행 방법:
 *   E2E_LLM_TIMEOUT=1 node --test tests/integration/llm-timeout.test.js
 *
 * 선택 환경 변수:
 *   OLLAMA_BASE_URL  — Ollama 서버 주소 (기본 "http://localhost:11434")
 *   OLLAMA_MODEL     — Ollama 모델 (기본 "glm-5.1:cloud")
 *
 * E2E_LLM_TIMEOUT 미설정(또는 "0") 시 전체 describe가 skip된다.
 * circuit breaker 오염 방지를 위해 각 describe 전에 Redis 키를 초기화한다.
 */

import { describe, it, before } from "node:test";
import assert                    from "node:assert/strict";
import { performance }           from "node:perf_hooks";
import "./_cleanup.js";

const ENABLED       = process.env.E2E_LLM_TIMEOUT === "1";
const OLLAMA_URL    = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL    ?? "glm-5.1:cloud";

/** 짧은 JSON 응답만 요구하여 네트워크/토큰 대기 시간 편향 최소화 */
const SIMPLE_PROMPT = "Return ONLY this JSON array, no markdown, no explanation: [1, 2, 3]";

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/**
 * circuit breaker Redis 키를 초기화하여 연속 실패로 인한 circuit open 방지.
 * Redis가 비활성화(stub)된 경우 in-memory 상태를 직접 리셋한다.
 *
 * @param {...string} names - provider 이름 목록
 */
async function resetCircuitBreakers(...names) {
  const { circuitBreaker } = await import("../../lib/llm/util/circuit-breaker.js");
  for (const name of names) {
    await circuitBreaker.reset(name);
  }
}

/**
 * provider.callJson을 호출하고 latency(ms)와 결과를 반환한다.
 *
 * @param {import("../../lib/llm/LlmProvider.js").LlmProvider} provider
 * @param {string}  prompt
 * @param {object}  options
 * @returns {Promise<{elapsedMs: number, result: *}>}
 */
async function measureCallJson(provider, prompt, options = {}) {
  const start      = performance.now();
  const result     = await provider.callJson(prompt, options);
  const elapsedMs  = performance.now() - start;
  return { elapsedMs, result };
}

// ---------------------------------------------------------------------------
// 1. 각 provider 응답 시간 측정
// ---------------------------------------------------------------------------

describe("LLM Timeout — 각 provider 응답 시간 측정", { skip: !ENABLED, timeout: 600_000 }, () => {

  before(async () => {
    await resetCircuitBreakers("gemini-cli", "codex-cli", "copilot-cli", "ollama");
  });

  it("gemini-cli callJson 응답 시간이 60s 이내 완료된다", async () => {
    const { GeminiCliProvider } = await import("../../lib/llm/providers/GeminiCliProvider.js");
    const provider              = new GeminiCliProvider();

    const available = await provider.isAvailable();
    if (!available) {
      console.log("[timeout-test] gemini-cli: 바이너리 없음 — skip");
      return;
    }

    const { elapsedMs, result } = await measureCallJson(provider, SIMPLE_PROMPT, { timeoutMs: 60_000 });

    console.log(`[timeout-test] gemini-cli latency: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(elapsedMs < 60_000, `gemini-cli exceeded 60s: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(
      Array.isArray(result) || (result !== null && typeof result === "object"),
      `gemini-cli: 반환값이 배열/객체가 아님: ${JSON.stringify(result)}`
    );
  });

  it("codex-cli callJson 응답 시간이 120s 이내 완료된다", async () => {
    const { CodexCliProvider } = await import("../../lib/llm/providers/CodexCliProvider.js");
    const provider             = new CodexCliProvider();

    const available = await provider.isAvailable();
    if (!available) {
      console.log("[timeout-test] codex-cli: 바이너리 없음 — skip");
      return;
    }

    const { elapsedMs, result } = await measureCallJson(provider, SIMPLE_PROMPT, { timeoutMs: 120_000 });

    console.log(`[timeout-test] codex-cli latency: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(elapsedMs < 120_000, `codex-cli exceeded 120s: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(
      Array.isArray(result) || (result !== null && typeof result === "object"),
      `codex-cli: 반환값이 배열/객체가 아님: ${JSON.stringify(result)}`
    );
  });

  it("copilot-cli callJson 응답 시간이 180s 이내 완료된다", async () => {
    const { CopilotCliProvider } = await import("../../lib/llm/providers/CopilotCliProvider.js");
    const provider               = new CopilotCliProvider();

    const available = await provider.isAvailable();
    if (!available) {
      console.log("[timeout-test] copilot-cli: 바이너리 없음 — skip");
      return;
    }

    const { elapsedMs, result } = await measureCallJson(provider, SIMPLE_PROMPT, { timeoutMs: 180_000 });

    console.log(`[timeout-test] copilot-cli latency: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(elapsedMs < 180_000, `copilot-cli exceeded 180s: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(
      Array.isArray(result) || (result !== null && typeof result === "object"),
      `copilot-cli: 반환값이 배열/객체가 아님: ${JSON.stringify(result)}`
    );
  });

  it(`ollama(${OLLAMA_MODEL}) callJson 응답 시간이 60s 이내 완료된다`, async () => {
    const { OllamaProvider } = await import("../../lib/llm/providers/OllamaProvider.js");
    const provider           = new OllamaProvider({
      baseUrl: OLLAMA_URL,
      model  : OLLAMA_MODEL
    });

    const available = await provider.isAvailable();
    if (!available) {
      console.log(`[timeout-test] ollama(${OLLAMA_MODEL}): 서버 미설정 — skip`);
      return;
    }

    const { elapsedMs, result } = await measureCallJson(provider, SIMPLE_PROMPT, { timeoutMs: 60_000 });

    console.log(`[timeout-test] ollama(${OLLAMA_MODEL}) latency: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(elapsedMs < 60_000, `ollama exceeded 60s: ${elapsedMs.toFixed(0)}ms`);
    assert.ok(
      Array.isArray(result) || (result !== null && typeof result === "object"),
      `ollama: 반환값이 배열/객체가 아님: ${JSON.stringify(result)}`
    );
  });
});

// ---------------------------------------------------------------------------
// 2. timeout 강제 실측
// ---------------------------------------------------------------------------

describe("LLM Timeout — timeout 강제 실측", { skip: !ENABLED, timeout: 600_000 }, () => {

  before(async () => {
    await resetCircuitBreakers("gemini-cli", "codex-cli", "copilot-cli");
  });

  it("callJson timeoutMs=1000 지정 시 1-5초 내에 timeout 에러를 throw한다 (gemini-cli)", async () => {
    const { GeminiCliProvider } = await import("../../lib/llm/providers/GeminiCliProvider.js");
    const provider              = new GeminiCliProvider();

    const available = await provider.isAvailable();
    if (!available) {
      console.log("[timeout-test] gemini-cli: 바이너리 없음 — skip");
      return;
    }

    /** circuit open 상태 우회 — 강제 timeout 테스트는 실패를 반드시 기록한다 */
    await resetCircuitBreakers("gemini-cli");

    const start   = performance.now();
    let errored   = false;
    let thrownErr = null;

    try {
      await provider.callJson(SIMPLE_PROMPT, { timeoutMs: 1_000 });
    } catch (err) {
      errored   = true;
      thrownErr = err;
    }

    const tookMs = performance.now() - start;
    console.log(`[timeout-test] gemini-cli forced-timeout tookMs: ${tookMs.toFixed(0)}ms`);

    assert.ok(errored, "expected timeout error but callJson resolved");
    assert.ok(
      tookMs >= 800 && tookMs < 5_000,
      `timeout enforcement out of range [800, 5000]: ${tookMs.toFixed(0)}ms (err: ${thrownErr?.message})`
    );
    /** circuit breaker 오염 해소 */
    await resetCircuitBreakers("gemini-cli");
  });

  it("callJson timeoutMs=500 지정 시 0.5-3초 내에 에러를 throw한다 (codex-cli)", async () => {
    const { CodexCliProvider } = await import("../../lib/llm/providers/CodexCliProvider.js");
    const provider             = new CodexCliProvider();

    const available = await provider.isAvailable();
    if (!available) {
      console.log("[timeout-test] codex-cli: 바이너리 없음 — skip");
      return;
    }

    await resetCircuitBreakers("codex-cli");

    const start   = performance.now();
    let errored   = false;
    let thrownErr = null;

    try {
      await provider.callJson(SIMPLE_PROMPT, { timeoutMs: 500 });
    } catch (err) {
      errored   = true;
      thrownErr = err;
    }

    const tookMs = performance.now() - start;
    console.log(`[timeout-test] codex-cli forced-timeout tookMs: ${tookMs.toFixed(0)}ms`);

    assert.ok(errored, "expected timeout error but callJson resolved");
    assert.ok(
      tookMs >= 300 && tookMs < 3_000,
      `timeout enforcement out of range [300, 3000]: ${tookMs.toFixed(0)}ms (err: ${thrownErr?.message})`
    );
    await resetCircuitBreakers("codex-cli");
  });

  it("callJson timeoutMs=500 지정 시 0.5-3초 내에 에러를 throw한다 (copilot-cli)", async () => {
    const { CopilotCliProvider } = await import("../../lib/llm/providers/CopilotCliProvider.js");
    const provider               = new CopilotCliProvider();

    const available = await provider.isAvailable();
    if (!available) {
      console.log("[timeout-test] copilot-cli: 바이너리 없음 — skip");
      return;
    }

    await resetCircuitBreakers("copilot-cli");

    const start   = performance.now();
    let errored   = false;
    let thrownErr = null;

    try {
      await provider.callJson(SIMPLE_PROMPT, { timeoutMs: 500 });
    } catch (err) {
      errored   = true;
      thrownErr = err;
    }

    const tookMs = performance.now() - start;
    console.log(`[timeout-test] copilot-cli forced-timeout tookMs: ${tookMs.toFixed(0)}ms`);

    assert.ok(errored, "expected timeout error but callJson resolved");
    assert.ok(
      tookMs >= 300 && tookMs < 3_000,
      `timeout enforcement out of range [300, 3000]: ${tookMs.toFixed(0)}ms (err: ${thrownErr?.message})`
    );
    await resetCircuitBreakers("copilot-cli");
  });
});
