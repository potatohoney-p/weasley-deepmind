import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

let pool;
let batch = async words => words.map(() => [0.1, 0.2]);
let single = async () => [0.1, 0.2];
const warnings = [];
mock.module("../../lib/tools/db.js", { namedExports: {
  getPrimaryPool: () => pool, shutdownPool: async () => {},
} });
const embeddingMock = mock.module("../../lib/tools/embedding.js", { namedExports: {
  generateBatchEmbeddings: words => batch(words), generateEmbedding: word => single(word),
  vectorToSql: vector => JSON.stringify(vector), EMBEDDING_ENABLED: true,
} });
mock.module("../../lib/redis.js", { namedExports: {
  pushToQueue: async () => true, disconnectRedis: async () => {},
} });
mock.module("../../lib/logger.js", { namedExports: {
  logInfo: () => {}, logWarn: message => warnings.push(message), logError: () => {},
} });
mock.module("../../config/memory.js", { namedExports: {
  MEMORY_CONFIG: { morphemeIndex: {}, embeddingWorker: { queueKey: "embedding" }, proactiveRecall: { enabled: false } },
} });
mock.module("../../config/symbolic.js", { namedExports: { SYMBOLIC_CONFIG: { enabled: false } } });
mock.module("../../lib/memory/embedding/MorphemeTokenizer.js", { namedExports: { tokenizeLocal: async () => [] } });
mock.module("../../lib/memory/embedding/EmbeddingWorker.js", { namedExports: { EmbeddingWorker: class {} } });
for (const name of ["ClaimExtractor", "ClaimConflictDetector"]) {
  mock.module(`../../lib/symbolic/${name}.js`, { namedExports: { [name]: class {} } });
}
mock.module("../../lib/symbolic/ClaimStore.js", { namedExports: { ClaimStore: class {}, TENANT_ISOLATION_VIOLATION: "denied" } });
mock.module("../../lib/symbolic/rules/v1/proactive-gate.js", { namedExports: { evaluateProactiveGate: () => ({}) } });
mock.module("../../lib/symbolic/SymbolicMetrics.js", { namedExports: { symbolicMetrics: {} } });
const { MorphemeIndex } = await import("../../lib/memory/embedding/MorphemeIndex.js");
const { processMorphemeBackfill } = await import("../../lib/memory/consolidate/MorphemeBackfill.js");
const { RememberPostProcessor } = await import("../../lib/memory/write/RememberPostProcessor.js");
const { assertCleanShutdown } = await import("../_lifecycle.js");
after(async () => { await assertCleanShutdown(); });

function makePool({ failInsert = false, failVerify = false, discard = [] } = {}) {
  const stored = new Map();
  const updates = [];
  const queries = [];
  return {
    stored, updates, queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id, content/.test(sql)) return { rows: [{ id: "fragment", content: "first second" }] };
      if (/SELECT morpheme, embedding/.test(sql)) {
        return { rows: params[0].filter(word => stored.has(word)).map(word => ({ morpheme: word, embedding: JSON.stringify(stored.get(word)) })) };
      }
      if (/SELECT morpheme\s+FROM/.test(sql)) {
        if (failVerify) throw new Error("verification unavailable");
        return { rows: [...stored.keys()].filter(word => params[0].includes(word) && !discard.includes(word) && stored.get(word) !== null).map(morpheme => ({ morpheme })) };
      }
      if (/INSERT INTO/.test(sql)) {
        if (failInsert) throw new Error("write unavailable");
        for (let i = 0; i < params.length; i += 2) if (!discard.includes(params[i])) stored.set(params[i], JSON.parse(params[i + 1]));
        return { rowCount: params.length / 2 };
      }
      if (/UPDATE .*morpheme_indexed/.test(sql)) { updates.push(params[0]); return { rowCount: 1 }; }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}
function index(words = ["first", "second"]) {
  const idx = new MorphemeIndex();
  idx.tokenize = async () => words;
  return idx;
}
function processor(idx) {
  return new RememberPostProcessor({
    morphemeIndex: idx, store: {},
    conflictResolver: { checkAssertionConsistency: async () => ({ assertionStatus: "observed" }) },
    temporalLinker: { linkTemporalNeighbors: async () => {} },
  });
}
async function remember(idx) {
  const post = processor(idx);
  await post.run({ id: "remembered", content: "first second", type: "fact" }, { agentId: "test", keyId: null });
  await post.drainMorpheme();
  assert.equal(post._morphemePromises.size, 0);
}
beforeEach(() => {
  pool = makePool(); warnings.length = 0;
  batch = async words => words.map(() => [0.1, 0.2]);
  single = async () => [0.1, 0.2];
});

test("backfill retains pending status after a swallowed batch INSERT failure", async () => {
  pool = makePool({ failInsert: true });
  assert.equal(await processMorphemeBackfill({ pool, morphemeIndex: index() }), 0);
  assert.deepEqual(pool.updates, []);
});
test("remember retains pending status after a swallowed batch INSERT failure", async () => {
  pool = makePool({ failInsert: true });
  await remember(index());
  assert.deepEqual(pool.updates, []);
});
test("partial single-item fallback does not complete a fragment", async () => {
  batch = async () => { throw new Error("temporary provider failure"); };
  single = async word => { if (word === "second") throw new Error("still unavailable"); return [0.1, 0.2]; };
  assert.equal(await processMorphemeBackfill({ pool, morphemeIndex: index() }), 0);
  assert.deepEqual([...pool.stored.keys()], ["first"]);
  assert.deepEqual(pool.updates, []);
});
test("isolating a rejected input does not falsely complete remaining missing morphemes", async () => {
  batch = async words => { if (words.includes("second")) throw new Error("Invalid 'input[1]': rejected"); return words.map(() => [0.1, 0.2]); };
  await remember(index());
  assert.deepEqual([...pool.stored.keys()], ["first"]);
  assert.deepEqual(pool.updates, []);
});
test("successful registration marks both production write paths complete", async () => {
  assert.equal(await processMorphemeBackfill({ pool, morphemeIndex: index() }), 1);
  await remember(index());
  assert.deepEqual(pool.updates, ["fragment", "remembered"]);
});
test("later backfill retries missing words and completes after recovery", async () => {
  pool = makePool({ discard: ["second"] });
  assert.equal(await processMorphemeBackfill({ pool, morphemeIndex: index() }), 0);
  const recovered = makePool();
  recovered.stored.set("first", pool.stored.get("first")); pool = recovered;
  const calls = [];
  batch = async words => { calls.push(words); return words.map(() => [0.1, 0.2]); };
  assert.equal(await processMorphemeBackfill({ pool, morphemeIndex: index() }), 1);
  assert.deepEqual(calls, [["second"]]);
});
test("a failed verification read cannot mark the fragment complete", async () => {
  pool = makePool({ failVerify: true });
  await remember(index());
  assert.deepEqual(pool.updates, []);
});
test("a tokenizer exception remains pending rather than becoming an empty success", async () => {
  const idx = index(); idx.tokenize = async () => { throw new Error("tokenizer failed"); };
  await remember(idx);
  assert.deepEqual(pool.updates, []);
});
test("a genuinely empty tokenization completes without embedding or dictionary reads", async () => {
  batch = async () => { assert.fail("no embeddings for empty tokens"); };
  await remember(index([]));
  assert.deepEqual(pool.updates, ["remembered"]);
  assert.equal(pool.queries.length, 1);
});
test("best-effort recall still returns generated vectors when persistence is unavailable", async () => {
  pool = makePool({ failInsert: true });
  assert.deepEqual(await index().getOrRegisterEmbeddings(["first"]), [[0.1, 0.2]]);
  assert.equal(pool.queries.length, 2);
});
test("strict completion checks unique valid words and preserves result order", async () => {
  pool.stored.set("existing", [0.3, 0.4]);
  const vectors = await index().getOrRegisterEmbeddings(["first", "", null, "existing", "first"], { requireComplete: true });
  assert.deepEqual(vectors, [[0.1, 0.2], [0.3, 0.4], [0.1, 0.2]]);
  const verify = pool.queries.find(q => /SELECT morpheme\s+FROM/.test(q.sql));
  assert.deepEqual(verify?.params, [["first", "existing"]]);
});
test("missing database cannot certify nonempty registration", async () => {
  pool = null;
  await assert.rejects(index().getOrRegisterEmbeddings(["first"], { requireComplete: true }), /unavailable/);
});

test("verification remains off the remember response path and participates in drain", async () => {
  const originalQuery = pool.query;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  pool.query = async (sql, params) => {
    if (/SELECT morpheme\s+FROM/.test(sql)) await blocked;
    return originalQuery(sql, params);
  };
  const post = processor(index());
  await post.run({ id: "pending", content: "words", type: "fact" }, { agentId: "test", keyId: null });
  assert.deepEqual(pool.updates, []);
  assert.equal(post._morphemePromises.size, 1);
  let drained = false;
  const draining = post.drainMorpheme().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release(); await draining;
  assert.deepEqual(pool.updates, ["pending"]);
});
test("dictionary rows without embeddings do not establish completion", async () => {
  pool.stored.set("first", null); pool.stored.set("second", [0.1, 0.2]);
  assert.equal(await processMorphemeBackfill({ pool, morphemeIndex: index() }), 0);
  assert.deepEqual(pool.updates, []);
  const verify = pool.queries.find(q => /SELECT morpheme\s+FROM/.test(q.sql));
  assert.match(verify.sql, /embedding IS NOT NULL/);
});
test("disabled embeddings cannot certify nonempty registration but empty input stays a no-op", async () => {
  embeddingMock.restore();
  const disabledMock = mock.module("../../lib/tools/embedding.js", { namedExports: {
    generateBatchEmbeddings: () => assert.fail("disabled provider"),
    generateEmbedding: () => assert.fail("disabled provider"),
    vectorToSql: JSON.stringify, EMBEDDING_ENABLED: false,
  } });
  try {
    const { MorphemeIndex: DisabledIndex } = await import("../../lib/memory/embedding/MorphemeIndex.js?disabled-test");
    const idx = new DisabledIndex();
    assert.deepEqual(await idx.getOrRegisterEmbeddings(["first"]), []);
    await assert.rejects(idx.getOrRegisterEmbeddings(["first"], { requireComplete: true }), /unavailable/);
    assert.deepEqual(await idx.getOrRegisterEmbeddings([], { requireComplete: true }), []);
    assert.equal(pool.queries.length, 0);
  } finally { disabledMock.restore(); }
});
