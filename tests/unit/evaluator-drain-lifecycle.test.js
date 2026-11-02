import { mock, test } from "node:test";
import assert from "node:assert/strict";

let nextJob = null;
mock.module("../../lib/redis.js", { namedExports: {
  getQueueLength: async () => 0,
  popFromQueue: async () => { const job = nextJob; nextJob = null; return job; }
} });
mock.module("../../lib/memory/MemoryManager.js", { namedExports: {
  MemoryManager: { getInstance: () => ({ store: {} }) }
} });
mock.module("../../lib/gemini.js", { namedExports: {
  geminiCLIJson: async () => ({}), isGeminiCLIAvailable: async () => false
} });
mock.module("../../lib/logger.js", { namedExports: {
  logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {}
} });
const { MemoryEvaluator } = await import("../../lib/memory/signals/MemoryEvaluator.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function activeWorker() {
  const entered = deferred();
  const release = deferred();
  const worker = new MemoryEvaluator();
  worker.interval = 1;
  let loops = 0;
  const loop = worker._loop.bind(worker);
  worker._loop = () => { loops++; return loop(); };
  worker.evaluate = async () => { entered.resolve(); await release.promise; };
  nextJob = { fragmentId: "one" };
  await worker.start();
  await entered.promise;
  return { worker, release, loops: () => loops };
}

test("every repeated stop waits for the in-flight evaluation", async () => {
  const { worker, release } = await activeWorker();
  const first = worker.stop();
  const second = worker.stop();
  let settled = false;
  second.then(() => { settled = true; });
  try { await tick(); assert.equal(settled, false); assert.strictEqual(first, second); }
  finally { release.resolve(); await first; await second; }
  assert.equal(settled, true);
});

test("start during drain cannot launch a second loop or cancel the drain", async () => {
  const { worker, release, loops } = await activeWorker();
  const stopped = worker.stop();
  try {
    await worker.start();
    assert.equal(loops(), 1);
    assert.equal(worker.running, false);
  } finally { worker.running = false; release.resolve(); await stopped; }
});

test("a fresh start after completed drain runs one new loop", async () => {
  const { worker, release, loops } = await activeWorker();
  const stopped = worker.stop();
  release.resolve();
  await stopped;
  await worker.start();
  await worker.start();
  assert.equal(loops(), 2);
  await worker.stop();
  await worker.stop();
  assert.equal(worker.running, false);
});

test("duplicate starts while running do not create another consumer", async () => {
  const { worker, release, loops } = await activeWorker();
  try { await worker.start(); assert.equal(loops(), 1); }
  finally { const stopped = worker.stop(); release.resolve(); await stopped; }
});

test("repeated stops before start are harmless", async () => {
  const worker = new MemoryEvaluator();
  await worker.stop();
  await worker.stop();
  assert.equal(worker.running, false);
});

test("unexpected loop termination releases ownership and allows a later start", async () => {
  const worker = new MemoryEvaluator();
  let loops = 0;
  worker._loop = async () => { loops++; throw new Error("unexpected loop failure"); };
  await worker.start();
  await tick();
  assert.equal(worker.running, false);
  await worker.stop();
  await worker.start();
  await tick();
  assert.equal(loops, 2);
  assert.equal(worker.running, false);
});
