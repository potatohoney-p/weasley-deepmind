import { after, afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
const writes = [];
let respond;
const vectors = { alpha: [3, 0], beta: [0, 4], gamma: [3, 4] };
const normalized = { alpha: [1, 0], beta: [0, 1], gamma: [0.6, 0.8] };
const encode = embedding => Buffer.from(new Float32Array(embedding).buffer).toString("base64");
const result = (index, embedding = [1, 0]) => ({ object: "embedding", index, embedding: encode(embedding) });
const goodResponse = body => ({ data: (Array.isArray(body.input) ? body.input : [body.input])
  .map((text, index) => result(index, vectors[text])) });
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push(body);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(respond(body)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

mock.module("../../lib/config.js", { namedExports: {
  OPENAI_API_KEY: "", EMBEDDING_API_KEY: "loopback-test-key", EMBEDDING_ENABLED: true,
  EMBEDDING_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  EMBEDDING_PROVIDER: "custom", EMBEDDING_MODEL: "fixture-model", EMBEDDING_DIMENSIONS: 2,
  EMBEDDING_SUPPORTS_DIMS_PARAM: true, EMBEDDING_TIMEOUT_MS: 2000,
  EMBEDDING_MAX_RETRIES: 0, EMBEDDING_CONCURRENCY: 1, EMBEDDING_SEM_WAIT_MS: 100
} });
mock.module("../../lib/metrics.js", { namedExports: { recordEmbeddingSemaphoreWaitExceeded() {} } });
mock.module("../../lib/logger.js", { namedExports: { logInfo() {}, logWarn() {}, logError() {} } });
mock.module("../../lib/redis.js", { namedExports: {
  redisClient: { status: "stub", lpush: async () => {} }, disconnectRedis: async () => {}
} });
const pool = { async query(sql, params) {
  if (sql.includes("SELECT")) return { rows: [] };
  writes.push({ sql, params });
  return { rows: [] };
} };
mock.module("../../lib/tools/db.js", { namedExports: {
  getPrimaryPool: () => pool, shutdownPool: async () => {},
  queryWithAgentVector: async (_agent, sql, params) => {
    writes.push({ sql, params });
    const ids = sql.includes("AS f") ? params.filter((_, i) => i % 3 === 0) : [params[0]];
    return { rows: ids.map(id => ({ id })) };
  }
} });
const { generateBatchEmbeddings } = await import("../../lib/tools/embedding.js");
const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
const { MorphemeIndex } = await import("../../lib/memory/embedding/MorphemeIndex.js");
const { getSemaphore } = await import("../../lib/llm/util/semaphore.js");
const { assertCleanShutdown, teardownTestResources } = await import("../_lifecycle.js");
beforeEach(() => { requests.length = 0; writes.length = 0; respond = goodResponse; });
afterEach(() => {
  const semaphore = getSemaphore("embedding", 1, 100);
  assert.equal(semaphore.active(), 0);
  assert.equal(semaphore.waiting(), 0);
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await teardownTestResources();
  await assertCleanShutdown();
  mock.restoreAll();
});

for (const [label, data] of [
  ["empty data", []],
  ["missing first result", [result(1, vectors.beta)]],
  ["missing last result", [result(0, vectors.alpha)]],
  ["duplicate index", [result(0, vectors.alpha), result(0, vectors.beta)]],
  ["extra result", [result(0), result(1), result(2)]],
  ["negative index", [result(-1), result(1)]],
  ["out-of-range index", [result(0), result(2)]],
  ["fractional index", [result(0), result(0.5)]],
  ["string index", [result(0), result("1")]],
  ["boolean index", [result(0), result(true)]],
  ["null index", [result(0), result(null)]],
  ["missing index", [result(0), { embedding: encode(vectors.beta) }]],
]) {
  test(`rejects ${label} without returning misassociated vectors`, async () => {
    respond = () => ({ data });
    await assert.rejects(generateBatchEmbeddings(["alpha", "beta"]), /Invalid embedding batch response:/);
    assert.equal(requests.length, 1, "response validation must not retry the HTTP request");
    respond = goodResponse;
    assert.deepEqual(await generateBatchEmbeddings(["alpha", "beta"]), [[1, 0], [0, 1]]);
  });
}

test("shuffled complete indices preserve input order and L2 normalization", async () => {
  respond = body => ({ data: goodResponse(body).data.reverse() });
  assert.deepEqual(await generateBatchEmbeddings(["alpha", "beta", "gamma"]), [[1, 0], [0, 1], [0.6, 0.8]]);
  assert.equal(requests[0].model, "fixture-model");
  assert.equal(requests[0].dimensions, 2);
});

test("identical inputs still require separate positional results", async () => {
  assert.deepEqual(await generateBatchEmbeddings(["alpha", "alpha"]), [[1, 0], [1, 0]]);
});

test("each HTTP chunk uses its own zero-based indices", async () => {
  respond = body => ({ data: goodResponse(body).data.reverse() });
  assert.deepEqual(await generateBatchEmbeddings(["alpha", "beta", "gamma", "alpha", "beta"], 2),
    [[1, 0], [0, 1], [0.6, 0.8], [1, 0], [0, 1]]);
  assert.deepEqual(requests.map(body => body.input.length), [2, 2, 1]);
});

test("a malformed later chunk rejects the complete call without returning a partial prefix", async () => {
  respond = body => requests.length === 1 ? goodResponse(body) : { data: [] };
  await assert.rejects(generateBatchEmbeddings(["alpha", "beta", "gamma"], 2), /Invalid embedding batch response:/);
  assert.equal(requests.length, 2);
});

test("empty input performs no HTTP request", async () => {
  assert.deepEqual(await generateBatchEmbeddings([]), []);
  assert.equal(requests.length, 0);
});

for (const defect of ["missing", "duplicate"]) {
  test(`worker ${defect} index response takes single-item fallback before cache or durable writes`, async () => {
    respond = body => Array.isArray(body.input)
      ? { data: defect === "missing" ? [result(1, vectors.beta)]
        : [result(0, vectors.alpha), result(0, vectors.alpha)] }
      : goodResponse(body);
    const worker = new EmbeddingWorker();
    worker.config = { retryLimit: 1, queueKey: "fixture" };
    const cached = [];
    worker.embeddingCache = { get: async () => null, set: (text, vector) => cached.push([text, vector]) };
    const ready = [];
    worker.on("embedding_ready", event => ready.push(event.fragmentId));
    await worker._embedChunk([{ id: "a", content: "alpha" }, { id: "b", content: "beta" }]);
    assert.deepEqual(requests.map(body => body.input), [["alpha", "beta"], "alpha", "beta"]);
    assert.deepEqual(cached, [["alpha", normalized.alpha], ["beta", normalized.beta]]);
    assert.deepEqual(writes.map(write => write.params), [["a", "[1,0]", "alpha"], ["b", "[0,1]", "beta"]]);
    assert.deepEqual(ready, ["a", "b"]);
    assert.ok(writes.every(write => !write.sql.includes("VALUES")), "invalid batch must never be persisted");
  });
}

test("morpheme registration cannot assign a duplicate-index vector to another token", async () => {
  respond = body => Array.isArray(body.input)
    ? { data: [result(0, vectors.alpha), result(0, vectors.alpha)] }
    : goodResponse(body);
  assert.deepEqual(await new MorphemeIndex().getOrRegisterEmbeddings(["alpha", "beta"]), [[1, 0], [0, 1]]);
  assert.deepEqual(requests.map(body => body.input), [["alpha", "beta"], "alpha", "beta"]);
  assert.deepEqual(writes.map(write => write.params), [["alpha", "[1,0]"], ["beta", "[0,1]"]]);
});
