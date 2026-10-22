// Public tool -> MemoryRecaller -> FragmentSearch; synthetic storage/provider boundaries.
import assert from "node:assert/strict";
import { mock } from "node:test";
const mode = process.argv[2];
assert.ok(["disabled", "failed", "empty", "semantic", "reranker"].includes(mode));
let embeddingCalls = 0;
const reads = [];
const anchor = Date.parse("2026-10-01T12:00:00Z");
mock.method(Date, "now", () => anchor);
mock.module("../../lib/tools/embedding.js", { namedExports: {
  EMBEDDING_ENABLED: mode !== "disabled", computeContentHash: () => "synthetic",
  prepareTextForEmbedding: String, vectorToSql: JSON.stringify,
  generateEmbedding: async () => {
    embeddingCalls++;
    if (mode === "failed" || mode === "disabled") throw new Error("simulated provider unavailable");
    return [1, 0];
  },
  generateBatchEmbeddings: async () => { throw new Error("Unexpected provider call"); }
} });
mock.module("../../lib/logger.js", { namedExports: {
  logInfo() {}, logDebug() {}, logWarn() {}, logError() {}
} });
mock.module("../../lib/tools/db.js", { namedExports: {
  queryWithAgentVector: async () => { throw new Error("Unexpected SQL outside storage boundary"); },
  getPrimaryPool: () => ({ query: async () => ({ rows: [] }) }), getBatchPool: () => null,
  shutdownPool: async () => {}, getPoolStats: () => ({}), withTransaction: async () => {}
} });
mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: { commitSearchSideEffects: async () => null }
});
mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: { getSearchMetrics: async () => ({ record() {} }) }
});
mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: { getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null }) }
});
mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: {
    isRerankerAvailable: () => mode === "reranker",
    rerank: async (_query, fragments) => fragments.map(f => ({
      ...f, rerankerScore: f.id === "recent" ? 0.99 : 0.1
    })).sort((a, b) => b.rerankerScore - a.rerankerScore)
  }
});
let recaller;
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { MemoryManager: class { static getInstance() { return { recall: args => recaller.recall(args) }; } } }
});
mock.module("../../lib/memory/processors/SessionActivityTracker.js", {
  namedExports: { SessionActivityTracker: { record: async () => {} } }
});
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");
const { countTokens } = await import("../../lib/memory/write/FragmentFactory.js");
const { tool_recall } = await import("../../lib/tools/memory.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");
const row = (id, content, keywords, extra = {}) => ({
  id, content, keywords, type: "procedure", topic: "operations", importance: 0.5,
  created_at: "2026-01-01T00:00:00Z", valid_to: null, key_id: "key-a",
  agent_id: "operator", workspace: "orion", ...extra
});
const answer = row("rollback", "Orion rollback procedure: restore the previous release revision.", ["orion", "rollback", "procedure"]);
const recent = row("recent", "Orion team lunch is on Friday.", ["orion"], {
  importance: 0.9, created_at: "2026-10-01T00:00:00Z"
});
const current = row("current-port", "Orion gateway port is now 9443.", ["orion", "gateway", "port"]);
const old = row("old-port", "Orion gateway port was 8443.", ["orion", "gateway", "port"], {
  valid_to: "2026-02-01T00:00:00Z"
});
const semantic = row("semantic", "Use the archived release image to recover the service.", ["recovery"], {
  importance: 0.9, similarity: 0.99, created_at: "2026-10-01T00:00:00Z"
});
const rows = [answer, recent, current, old,
  row("other-key", answer.content, answer.keywords, { key_id: "key-b" }),
  row("other-workspace", answer.content, answer.keywords, { workspace: "vega" }),
  row("other-agent", answer.content, answer.keywords, { agent_id: "outsider" })];
const search = Object.create(FragmentSearch.prototype);
search.index = {
  searchByKeywords: async () => [], searchByTopic: async () => [], searchByType: async () => [],
  getRecent: async () => [], cacheFragment: async () => {}
};
search.embeddingCache = { get: async () => null, set() {} };
search._morphemeIndex = { textToMorphemeVector: async () => null };
search.store = {
  searchByKeywords: async (keywords, options) => {
    reads.push({ keywords: [...keywords], options });
    return structuredClone(rows.filter(f => keywords.some(k => f.keywords.includes(k))
      && (options.includeSuperseded || !f.valid_to)
      && options.keyId.includes(f.key_id) && f.agent_id === options.agentId
      && f.workspace === options.workspace && (!options.type || options.type === f.type)));
  },
  searchBySemantic: async () => mode === "semantic" ? [structuredClone(semantic)] : [],
  incrementAccess() {}, touchLinked: async () => {}
};
recaller = new MemoryRecaller({ search, store: search.store });
const ask = args => tool_recall({ _keyId: "key-a", agentId: "operator", workspace: "orion",
  includeLinks: false, tokenBudget: 1000, ...args });
try {
  if (mode !== "semantic" && mode !== "reranker") {
    const tight = await ask({ text: "What is the Orion rollback procedure?", tokenBudget: countTokens(answer.content) });
    assert.equal(tight.success, true);
    assert.deepEqual(tight.fragments.map(f => f.id), [answer.id], "old multi-term evidence must survive the tight budget");
    assert.equal(tight.totalTokens, countTokens(answer.content));
    const wide = await ask({ text: "What is the Orion rollback procedure?" });
    assert.equal(wide.fragments[0]?.id, answer.id, "coverage remains primary after final recall ranking");
    assert.equal((await ask({ text: "Orion rollback procedure." })).fragments[0]?.id, answer.id);
    assert.equal(wide._lexicalKeywords, undefined, "private ranking context must not leak");
    assert.ok(wide.fragments.every(f => !f.id.startsWith("other-")));
    const corrected = await ask({ text: "What is the Orion gateway port?" });
    assert.equal(corrected.fragments[0]?.id, current.id);
    assert.ok(corrected.fragments.every(f => f.id !== old.id));
    for (const text of ["Does zephyr support marble?", "what is the"]) {
      assert.deepEqual((await ask({ text })).fragments, [], "no arbitrary recent fallback");
    }
    search.index.searchByType = async () => { throw new Error("type alone must not seed text retrieval"); };
    assert.deepEqual((await ask({ text: "quasar restoration", type: "procedure" })).fragments, []);
    assert.equal((await ask({ text: "Orion rollback procedure", type: "procedure" })).fragments[0]?.id, answer.id);
    const request = { keywords: ["gateway"], text: "Unrelated question wording" };
    const explicit = await ask(request);
    assert.deepEqual(explicit.fragments.map(f => f.id), [current.id]);
    assert.deepEqual(reads.at(-1).keywords, request.keywords);
  } else {
    const hybrid = await ask({ text: "What is the Orion rollback procedure?" });
    assert.equal(hybrid.success, true);
    assert.equal(hybrid.fragments[0]?.id, mode === "semantic" ? semantic.id : recent.id,
      "retain existing semantic/reranker ranking when available");
    assert.ok(hybrid.fragments.some(f => f.id === answer.id), "lexical discovery runs alongside semantic retrieval");
    assert.match(hybrid.searchPath, /L2:[1-9]/);
    assert.match(hybrid.searchPath, mode === "semantic" ? /L3:1/ : /Rerank:/);
  }
  assert.equal(embeddingCalls === 0, mode === "disabled");
  assert.ok(reads.every(({ keywords, options }) => keywords.length <= 5 && options.limit === 30));
  console.log(JSON.stringify({ mode, passed: true, embeddingCalls, durableReads: reads.length }));
} finally { await teardownTestResources(); mock.restoreAll(); await assertCleanShutdown(); }
