import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let payload;
let requests = 0;
const server = http.createServer((_req, res) => {
  requests++;
  res.setHeader("Content-Type", "application/json");
  res.end(payload);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.RERANKER_URL = `http://127.0.0.1:${server.address().port}`;
process.env.RERANKER_EXTERNAL_FALLBACK = "skip";
process.env.RERANKER_EXTERNAL_COOLDOWN_MS = "60000";
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
let serial = 0;
const fresh = () => import(`../../lib/memory/read/Reranker.js?score-validation=${serial++}`);
const candidates = [{ id: "a", content: "alpha" }, { id: "b", content: "bravo" }];

for (const [name, body] of [
  ["short scores", { scores: [0.9] }],
  ["long scores", { scores: [0.1, 0.9, 0.8] }],
  ["string scores", { scores: "19" }],
  ["numeric strings", { scores: ["0.1", "0.9"] }],
  ["null score", { scores: [null, 0.9] }],
  ["object scores", { scores: { 0: 0.1, 1: 0.9 } }],
  ["missing indexed score", [{ index: 1, score: 0.9 }]],
  ["duplicate index", [{ index: 1, score: 0.1 }, { index: 1, score: 0.9 }]],
  ["invalid index", [{ index: -1, score: 0.1 }, { index: 1, score: 0.9 }]],
  ["string indexed score", [{ index: 0, score: "0.1" }, { index: 1, score: 0.9 }]],
  ["null indexed row", [null, { index: 1, score: 0.9 }]],
  ["empty scores", { scores: [] }]
]) {
  test(`malformed ${name} retains original candidates without truncation`, async () => {
    payload = JSON.stringify(body);
    const { rerank } = await fresh();
    assert.strictEqual(await rerank("q", candidates, 1), candidates);
    assert.equal(Object.hasOwn(candidates[0], "rerankerScore"), false);
  });
}

test("JSON numeric overflow is rejected", async () => {
  payload = '{"scores":[1e400,0.9]}';
  assert.strictEqual(await (await fresh()).rerank("q", candidates), candidates);
});
for (const [name, body] of [
  ["dense", { scores: [-2, 3] }],
  ["reordered indexed", [{ index: 1, score: 3 }, { index: 0, score: -2 }]]
]) {
  test(`complete finite ${name} scores retain ranking and topK`, async () => {
    payload = JSON.stringify(body);
    const result = await (await fresh()).rerank("q", candidates, 1);
    assert.deepEqual(result.map(c => c.id), ["b"]);
    assert.ok(Number.isFinite(result[0].rerankerScore));
  });
}

test("malformed responses enter the existing three-failure cooldown", async () => {
  payload = '{"scores":[0.9]}';
  const { rerank, isRerankerAvailable } = await fresh();
  const before = requests;
  for (let i = 0; i < 3; i++) assert.strictEqual(await rerank("q", candidates), candidates);
  assert.equal(requests - before, 3);
  assert.equal(isRerankerAvailable(), false);
  payload = '{"scores":[0.1,0.9]}';
  assert.strictEqual(await rerank("q", candidates), candidates);
  assert.equal(requests - before, 3);
});

test("valid response resets malformed-response failure count", async () => {
  const { rerank, isRerankerAvailable } = await fresh();
  for (const body of ['{"scores":[]}', '{"scores":[0.1,0.9]}', '{"scores":[]}', '{"scores":[]}']) {
    payload = body;
    await rerank("q", candidates);
  }
  assert.equal(isRerankerAvailable(), true);
});
