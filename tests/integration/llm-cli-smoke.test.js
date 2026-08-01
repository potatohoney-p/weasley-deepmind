/**
 * LLM CLI Smoke 통합 테스트 — 실제 바이너리 end-to-end 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 실행 방법:
 *   E2E_LLM_CLI=1 node --test tests/integration/llm-cli-smoke.test.js
 *
 * E2E_LLM_CLI 미설정(또는 "0") 시 전체 describe가 skip된다.
 * auth 미완료 CLI는 FAIL로 보고되며 별도 skip 처리하지 않는다.
 */

import { describe, it, before } from "node:test";
import assert                    from "node:assert/strict";
import "./_cleanup.js";

const ENABLED     = process.env.E2E_LLM_CLI === "1";
const TIMEOUT_MS  = 120_000;

// ---------------------------------------------------------------------------
// gemini-cli
// ---------------------------------------------------------------------------

describe("LLM CLI Smoke — gemini-cli", { skip: !ENABLED, timeout: 240_000 }, () => {
  let geminiProvider;

  before(async () => {
    const { GeminiCliProvider } = await import("../../lib/llm/providers/GeminiCliProvider.js");
    geminiProvider = new GeminiCliProvider();
  });

  it("_rawIsGeminiCLIAvailable이 true를 반환한다", async () => {
    const { _rawIsGeminiCLIAvailable } = await import("../../lib/gemini.js");
    const available                    = await _rawIsGeminiCLIAvailable();
    assert.equal(available, true, "gemini 바이너리가 PATH에 없음 — `which gemini` 확인 필요");
  });

  it("callJson: 단순 JSON 배열을 반환한다", async () => {
    const prompt = 'Return ONLY this JSON array with no markdown: ["apple", "banana"]';
    const result = await geminiProvider.callJson(prompt, { timeoutMs: TIMEOUT_MS });
    assert.ok(
      Array.isArray(result) || (result !== null && typeof result === "object"),
      `gemini callJson 반환값이 배열/객체가 아님: ${JSON.stringify(result)}`
    );
  });

  it("callJson: 빈 문자열 프롬프트에 대해 에러를 throw한다", async () => {
    await assert.rejects(
      () => geminiProvider.callJson("", { timeoutMs: TIMEOUT_MS }),
      (err) => {
        assert.ok(err instanceof Error, "Error 인스턴스여야 함");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// codex-cli
// ---------------------------------------------------------------------------

describe("LLM CLI Smoke — codex-cli", { skip: !ENABLED, timeout: 240_000 }, () => {
  let codexProvider;

  before(async () => {
    const { CodexCliProvider } = await import("../../lib/llm/providers/CodexCliProvider.js");
    codexProvider = new CodexCliProvider();
  });

  it("_rawIsCodexCLIAvailable이 true를 반환한다", async () => {
    const { _rawIsCodexCLIAvailable } = await import("../../lib/codex.js");
    const available                   = await _rawIsCodexCLIAvailable();
    assert.equal(available, true, "codex 바이너리가 PATH에 없음 — `which codex` 확인 필요");
  });

  it("callJson: 단순 JSON 객체를 반환한다", async () => {
    const prompt = 'Return ONLY this JSON object with no markdown: {"status": "ok"}';
    const result = await codexProvider.callJson(prompt, { timeoutMs: TIMEOUT_MS });
    assert.ok(
      result !== null && typeof result === "object",
      `codex callJson 반환값이 객체가 아님: ${JSON.stringify(result)}`
    );
  });
});

// ---------------------------------------------------------------------------
// copilot-cli
// ---------------------------------------------------------------------------

describe("LLM CLI Smoke — copilot-cli", { skip: !ENABLED, timeout: 240_000 }, () => {
  let copilotProvider;

  before(async () => {
    const { CopilotCliProvider } = await import("../../lib/llm/providers/CopilotCliProvider.js");
    copilotProvider = new CopilotCliProvider();
  });

  it("_rawIsCopilotCLIAvailable이 true를 반환한다", async () => {
    const { _rawIsCopilotCLIAvailable } = await import("../../lib/copilot.js");
    const available                     = await _rawIsCopilotCLIAvailable();
    assert.equal(available, true, "copilot 바이너리가 PATH에 없음 — `which copilot` 확인 필요");
  });

  it("callJson: 단순 JSON 배열을 반환한다 (extractJsonBlock 통과)", async () => {
    const prompt = "Return ONLY this JSON array with no prose or markdown fence: [1, 2, 3]";
    const result = await copilotProvider.callJson(prompt, { timeoutMs: TIMEOUT_MS });
    assert.ok(
      Array.isArray(result) || (result !== null && typeof result === "object"),
      `copilot callJson 반환값이 배열/객체가 아님: ${JSON.stringify(result)}`
    );
  });
});
