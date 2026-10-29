import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ContextBuilder, buildRankedInjection } from "../../lib/memory/read/ContextBuilder.js";
import { countTokens } from "../../lib/memory/write/FragmentFactory.js";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const fragment = (id, content, importance = 0.5) => ({ id, content, importance, type: "preference" });
const weights = { importance: 0.6, ema_activation: 0.4 };

function harness({ core = [], working = [], anchors = [] } = {}) {
  const index = {
    getWorkingMemory: mock.fn(async () => [...working]),
    setSeenIds: mock.fn(async () => {}),
  };
  const builder = new ContextBuilder({
    recall: async params => ({ fragments: params.type === "preference" ? core : [] }),
    store: {
      searchBySource: async () => [],
      getByIds: async ids => working.filter(row => ids.includes(row.id)).map(row => ({ ...row, agent_id: "default" })),
    },
    index,
    getPool: () => ({ query: async () => ({ rows: anchors }) }),
  });
  return { builder, index };
}

describe("context injection consistency", () => {
  it("deduplicates cross-layer memories before rendering and token accounting", async () => {
    const shared = fragment("shared", "Use Korean for explanations.");
    const local = fragment("local", "Document the reproduction.");
    const { builder, index } = harness({ core: [shared, local], working: [shared, local], anchors: [shared] });
    const result = await builder.build({ sessionId: "test", types: ["preference"] });

    assert.equal(result.injectionText.split(shared.content).length - 1, 1);
    assert.equal(result.injectionText.split(local.content).length - 1, 1);
    assert.deepEqual(result.fragments.map(f => f.id), ["shared", "local"]);
    assert.equal(result.wmCount, 0);
    assert.equal(result.wmTokens, 0);
    assert.equal(result.totalTokens, countTokens(shared.content) + countTokens(local.content));
    assert.deepEqual(index.setSeenIds.mock.calls[0].arguments, ["test", ["shared", "local"]]);
  });

  it("deduplicates structured categories with anchor, core, then working precedence", async () => {
    const shared = fragment("shared", "Current preference.");
    const { builder } = harness({ core: [shared], working: [shared], anchors: [shared] });
    const result = await builder.build({ sessionId: "test", types: ["preference"], structured: true });

    assert.deepEqual(result.anchors.permanent.map(f => f.id), ["shared"]);
    assert.deepEqual(result.core.preferences, []);
    assert.deepEqual(result.working.current_session, []);
    assert.equal(result.count, 1);
    assert.equal(result.totalTokens, result.rankedInjection.totalTokens);
  });

  for (const structured of [false, true]) {
    it(`honors multilingual content budgets and seen IDs (structured=${structured})`, async () => {
      const korean = fragment("ko", "한글 기억은 토큰 예산을 정확히 계산해야 합니다.", 0.9);
      const english = fragment("en", "Keep the tests deterministic.", 0.5);
      const budget = countTokens(korean.content);
      const { builder, index } = harness({ core: [korean, english] });
      const result = await builder.build({ sessionId: "test", types: ["preference"], structured, tokenBudget: budget });
      const selected = structured ? result.rankedInjection.items : result.fragments;

      assert.deepEqual(selected.map(f => f.id), ["ko"]);
      assert.equal(result.totalTokens, budget);
      assert.deepEqual(index.setSeenIds.mock.calls[0].arguments, ["test", ["ko"]]);
      if (structured) assert.deepEqual(result.core.preferences.map(f => f.id), ["ko"]);
    });
  }

  it("retains fitting lower-ranked memories after an oversized candidate", () => {
    const large = fragment("large", "서울의 장기 기억 평가 ".repeat(30), 0.9);
    const small = fragment("small", "Run local tests.", 0.5);
    const result = buildRankedInjection([], [large, small], countTokens(small.content), weights);
    assert.deepEqual(result.items.map(f => f.id), ["small"]);
    assert.equal(result.totalTokens, countTokens(small.content));
  });

  it("preserves mandatory anchors when they exceed the budget, with honest totals", async () => {
    const anchor = fragment("anchor", "항상 보존하는 필수 기억입니다.");
    const { builder } = harness({ core: [fragment("other", "Optional memory.")], anchors: [anchor] });
    const result = await builder.build({ types: ["preference"], tokenBudget: 0, structured: true });
    assert.deepEqual(result.rankedInjection.items.map(f => f.id), ["anchor"]);
    assert.equal(result.totalTokens, countTokens(anchor.content));
    assert.equal(result.rankedInjection.totalTokens, result.totalTokens);
  });

  for (const [language, content] of Object.entries({
    English: "The memory should fit the selected context budget.",
    Korean: "기억의 토큰 수를 정확하게 계산합니다.",
    Chinese: "长期记忆应该遵守上下文预算。",
    Japanese: "長期記憶のトークン数を正確に計算します。",
    mixed: "서울 → Tokyo → 北京: café ☕ memory",
  })) {
    it(`uses the existing content tokenizer for ${language}`, () => {
      const input = fragment(language, content);
      const tokens = countTokens(content);
      assert.deepEqual(buildRankedInjection([], [input], tokens - 1, weights).items, []);
      const exact = buildRankedInjection([], [input], tokens, weights);
      assert.deepEqual(exact.items.map(f => f.id), [language]);
      assert.equal(exact.totalTokens, tokens);
    });
  }

  it("keeps distinct ID-less fragments in ranked injection and anchors", async () => {
    const fragments = [fragment(null, "First memory."), fragment(null, "Second memory.")];
    assert.equal(buildRankedInjection([], fragments, 100, weights).items.length, 2);
    const { builder } = harness({ anchors: fragments });
    const result = await builder.build({ types: [], tokenBudget: 100 });
    assert.equal(result.count, 2);
    assert.deepEqual(result.fragments.map(f => f.content), ["First memory.", "Second memory."]);
  });

  it("does not inject ID-less working cache entries without durable identity", async () => {
    const { builder } = harness({ working: [fragment(null, "Unverified cached memory.")] });
    const result = await builder.build({ sessionId: "test", types: [], tokenBudget: 100 });
    assert.deepEqual(result.fragments, []);
  });

  it("zero budget excludes optional memories from every response and seen IDs", async () => {
    const { builder, index } = harness({ core: [fragment("optional", "Optional content.")] });
    const result = await builder.build({ sessionId: "test", types: ["preference"], tokenBudget: 0 });
    assert.deepEqual(result.fragments, []);
    assert.equal(result.totalTokens, 0);
    assert.equal(result.injectionText, "");
    assert.deepEqual(index.setSeenIds.mock.calls[0].arguments, ["test", []]);
  });
});
