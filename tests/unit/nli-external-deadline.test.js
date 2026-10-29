import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

let server;
let classifyNLI;
let detectContradiction;
let handler;
const deadline = 100;
const response = { label: "contradiction", scores: { contradiction: 0.9, entailment: 0.05, neutral: 0.05 } };

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("Connection", "close");
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  mock.module("../../lib/config.js", { namedExports: {
    NLI_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
    NLI_TIMEOUT_MS: deadline
  } });
  mock.module("../../lib/logger.js", { namedExports: { logInfo() {}, logWarn() {} } });
  ({ classifyNLI, detectContradiction } = await import("../../lib/memory/signals/NLIClassifier.js"));
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  mock.restoreAll();
  await teardownTestResources();
  await assertCleanShutdown();
});

async function boundedCall(call) {
  let watchdog;
  try {
    return await Promise.race([
      call(),
      new Promise(resolve => { watchdog = setTimeout(() => resolve("watchdog"), 800); })
    ]);
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    // Let fetch observe socket closure before starting the next request.
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("deadline remains active after headers while JSON body stalls", async () => {
  handler = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); res.write('{"label":'); };
  assert.equal(await boundedCall(() => classifyNLI("old", "new")), null);
});

test("contradiction detection returns its null fallback when body stalls", async () => {
  handler = (_req, res) => { res.writeHead(200); res.flushHeaders(); };
  assert.equal(await boundedCall(() => detectContradiction("old", "new")), null);
});

test("deadline aborts a service that never sends headers", async () => {
  let reached = false;
  handler = () => { reached = true; };
  const started = performance.now();
  assert.equal(await boundedCall(() => classifyNLI("old", "new")), null);
  assert.equal(reached, true);
  assert.ok(performance.now() - started >= deadline * 0.8);
});

test("valid delayed JSON body retains the service result and request", async () => {
  let received;
  handler = (req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received = { method: req.method, path: req.url, body: JSON.parse(body) }; });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify(response)), 15);
  };
  assert.deepEqual(await boundedCall(() => classifyNLI("old", "new")), response);
  assert.deepEqual(received, { method: "POST", path: "/classify", body: { premise: "old", hypothesis: "new" } });
});

test("malformed JSON retains null fallback", async () => {
  handler = (_req, res) => res.end("not json");
  assert.equal(await boundedCall(() => classifyNLI("old", "new")), null);
});

for (const streaming of [false, true]) {
  test(`non-success response closes its ${streaming ? "streaming" : "stalled"} body before test cleanup`, async () => {
    let markClosed;
    const closed = new Promise(resolve => { markClosed = resolve; });
    handler = (_req, res) => {
      let interval;
      res.on("close", () => { clearInterval(interval); markClosed(); });
      res.writeHead(503);
      res.flushHeaders();
      if (streaming) {
        res.write("unavailable");
        interval = setInterval(() => res.write("still unavailable"), 20);
      }
    };
    assert.equal(await boundedCall(async () => {
      assert.equal(await classifyNLI("old", "new"), null);
      // Observe client cancellation before boundedCall forcibly closes sockets.
      await closed;
      return "closed";
    }), "closed");
  });
}

test("transport rejection clears the deadline instead of aborting later", async () => {
  let signal;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { signal = options.signal; throw new Error("offline"); };
  try {
    assert.equal(await classifyNLI("old", "new"), null);
    await new Promise(resolve => setTimeout(resolve, deadline + 40));
    assert.equal(signal.aborted, false);
  } finally { globalThis.fetch = nativeFetch; }
});
