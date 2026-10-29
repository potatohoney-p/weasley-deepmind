import { after, test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let route = "scores";
const server = http.createServer((_req, res) => {
  if (route === "delayed-body") {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ scores: [0.1, 0.9] })), 25);
  } else if (route === "stalled-body") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    res.write('{"scores":[');
  } else if (route === "invalid-json") {
    res.end("not JSON");
  } else if (route === "error") {
    res.writeHead(503);
    res.end("unavailable");
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(route === "tei" ? [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }] : { scores: [0.1, 0.9] }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.RERANKER_URL = `http://127.0.0.1:${server.address().port}`;
process.env.RERANKER_TIMEOUT_MS = "500";
process.env.RERANKER_EXTERNAL_FALLBACK = "skip";
process.env.RERANKER_EXTERNAL_COOLDOWN_MS = "60000";
after(async () => {
  mock.restoreAll();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
let serial = 0;
const fresh = () => import(`../../lib/memory/read/Reranker.js?deadline=${serial++}`);
const candidates = [{ id: "a", content: "alpha" }, { id: "b", content: "bravo" }];

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve("watchdog"), 2500); })]);
  } finally { clearTimeout(timer); }
}

test("valid delayed JSON body within the deadline preserves ranking", async () => {
  route = "delayed-body";
  const { rerank } = await fresh();
  assert.deepEqual((await rerank("q", candidates)).map(x => x.id), ["b", "a"]);
});

test("headers do not end the deadline while JSON body is stalled", async () => {
  route = "stalled-body";
  const { rerank } = await fresh();
  try {
    assert.strictEqual(await bounded(rerank("q", candidates)), candidates);
  } finally { server.closeAllConnections(); }
});

test("stalled body failures retain existing three-failure cooldown", async () => {
  route = "stalled-body";
  const { rerank } = await fresh();
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual(await bounded(rerank("q", candidates)), candidates);
    route = "scores";
    assert.strictEqual(await rerank("q", candidates), candidates);
  } finally { server.closeAllConnections(); }
});

for (const response of ["scores", "tei", "invalid-json", "error"]) {
  test(`clears the deadline after ${response}`, async () => {
    mock.method(globalThis, "fetch", async () => new globalThis.Response(
      response === "invalid-json" ? "not JSON" : JSON.stringify(
        response === "tei" ? [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }] : { scores: [0.1, 0.9] }
      ), { status: response === "error" ? 503 : 200 }
    ));
    const { rerank } = await fresh();
    const active = new Set();
    const nativeSet = globalThis.setTimeout;
    const nativeClear = globalThis.clearTimeout;
    mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
      const handle = nativeSet(fn, ms, ...args);
      if (ms === 500) active.add(handle);
      return handle;
    });
    mock.method(globalThis, "clearTimeout", handle => { active.delete(handle); return nativeClear(handle); });
    try {
      const result = await rerank("q", candidates);
      if (response === "scores" || response === "tei") assert.deepEqual(result.map(x => x.id), ["b", "a"]);
      else assert.strictEqual(result, candidates);
      assert.equal(active.size, 0);
    } finally { for (const handle of active) nativeClear(handle); mock.restoreAll(); }
  });
}

test("clears the deadline when fetch rejects before headers", async () => {
  const { rerank } = await fresh();
  let signal;
  mock.method(globalThis, "fetch", async (_url, options) => { signal = options.signal; throw new Error("offline fixture"); });
  try {
    assert.strictEqual(await rerank("q", candidates), candidates);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(signal.aborted, false, "completed failed call must not retain a late abort timer");
  } finally { mock.restoreAll(); }
});
