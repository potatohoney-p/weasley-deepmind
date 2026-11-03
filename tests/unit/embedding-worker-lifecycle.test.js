import { after, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { teardownTestResources, assertCleanShutdown } from '../_lifecycle.js';

let readQueue;
let query;
const queueCalls = [];
mock.module('../../lib/redis.js', { namedExports: {
  redisClient: { rpop: async key => { queueCalls.push(key); return readQueue(); } }
} });
mock.module('../../lib/tools/db.js', { namedExports: {
  queryWithAgentVector: (...args) => query(...args)
} });
mock.module('../../lib/tools/embedding.js', { namedExports: {
  generateEmbedding: async () => [1, 0],
  generateBatchEmbeddings: async texts => texts.map(() => [1, 0]),
  prepareTextForEmbedding: text => text,
  vectorToSql: JSON.stringify,
  EMBEDDING_ENABLED: true
} });
mock.module('../../lib/memory/embedding/EmbeddingCache.js', { namedExports: {
  EmbeddingCache: class {
    async get() { return null; }
    async set() {}
  }
} });
const { EmbeddingWorker } = await import('../../lib/memory/embedding/EmbeddingWorker.js');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeWorker() {
  const worker = new EmbeddingWorker();
  worker.config = { batchSize: 1, intervalMs: 100, queueKey: 'lifecycle', retryLimit: 1 };
  return worker;
}
function observe(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; });
  return state;
}

beforeEach(() => {
  queueCalls.length = 0;
  readQueue = async () => null;
  query = async () => ({ rows: [] });
});
after(async () => { await teardownTestResources(); await assertCleanShutdown(); });

test('all stop callers drain the real batch through durable write and ready notification', async () => {
  const write = deferred();
  const enteredWrite = deferred();
  readQueue = async () => JSON.stringify({ fragmentId: 'memory-1' });
  query = async (_agent, sql) => {
    if (sql.includes('SELECT')) return { rows: [{ id: 'memory-1', content: 'a durable memory' }] };
    enteredWrite.resolve();
    return write.promise;
  };
  const worker = makeWorker();
  const ready = [];
  worker.on('embedding_ready', value => ready.push(value.fragmentId));
  await worker.start();
  await enteredWrite.promise;
  const first = worker.stop();
  const second = worker.stop();
  const states = [observe(first), observe(second)];
  await flush();
  assert.deepEqual(states.map(x => x.settled), [false, false]);
  assert.deepEqual(ready, []);
  write.resolve({ rows: [{ id: 'memory-1' }] });
  await flush();
  assert.deepEqual(states.map(x => x.settled), [true, true]);
  assert.strictEqual(first, second, 'concurrent stop calls share one drain');
  assert.deepEqual(ready, ['memory-1']);
  assert.equal(worker._processing, false);
  assert.equal(worker.timer, null);
});

test('start while a queue read is draining cannot launch another poll', async () => {
  const queue = deferred();
  readQueue = () => queue.promise;
  const worker = makeWorker();
  await worker.start();
  const stopped = observe(worker.stop());
  await worker.start();
  const callsBeforeRelease = queueCalls.length;
  const runningBeforeRelease = worker.running;
  worker.stop();
  queue.resolve(null);
  await flush();
  assert.equal(callsBeforeRelease, 1);
  assert.equal(runningBeforeRelease, false);
  assert.equal(stopped.settled, true);
  assert.equal(worker.timer, null);
});

test('repeated starts are idempotent and a completed stop permits an explicit restart', async () => {
  let queue = deferred();
  readQueue = () => queue.promise;
  const worker = makeWorker();
  await worker.start();
  await worker.start();
  assert.equal(queueCalls.length, 1);
  const firstDrain = worker.stop();
  queue.resolve(null);
  await firstDrain;
  await worker.stop();
  queue = deferred();
  await worker.start();
  assert.equal(queueCalls.length, 2);
  assert.equal(worker.running, true);
  const secondDrain = worker.stop();
  queue.resolve(null);
  await secondDrain;
  assert.equal(worker._processing, false);
  assert.equal(worker.timer, null);
});

test('rejected batch releases every stop waiter and remains restartable', async () => {
  let queue = deferred();
  readQueue = () => queue.promise;
  const worker = makeWorker();
  await worker.start();
  const states = [observe(worker.stop()), observe(worker.stop()), observe(worker.stop())];
  queue.reject(new Error('queue unavailable'));
  await flush();
  assert.deepEqual(states.map(x => x.settled), [true, true, true]);
  assert.equal(worker._backoff, 2000);
  assert.equal(worker._processing, false);
  assert.equal(worker.timer, null);
  queue = deferred();
  await worker.start();
  const stopped = worker.stop();
  queue.resolve(null);
  await stopped;
  assert.equal(worker._backoff, 1000);
});

test('stop cancels the scheduled next poll and repeated idle stops resolve', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = makeWorker();
  await worker.start();
  await flush();
  assert.notEqual(worker.timer, null);
  await worker.stop();
  await worker.stop();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(queueCalls.length, 1);
  assert.equal(worker.timer, null);
});

test('failure backoff schedules one retry which can be cancelled without an extra batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  readQueue = async () => { throw new Error('temporary queue failure'); };
  const worker = makeWorker();
  await worker.start();
  await flush();
  assert.equal(worker._backoff, 2000);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(queueCalls.length, 1);
  readQueue = async () => null;
  t.mock.timers.tick(1);
  await flush();
  assert.equal(queueCalls.length, 2);
  assert.equal(worker._backoff, 1000);
  await worker.stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(queueCalls.length, 2);
});

test('stopping before first start and across repeated cycles leaves no residual drain', async () => {
  const worker = makeWorker();
  await worker.stop();
  for (let i = 0; i < 3; i++) {
    const queue = deferred();
    readQueue = () => queue.promise;
    await worker.start();
    const states = [observe(worker.stop()), observe(worker.stop())];
    queue.resolve(null);
    await flush();
    assert.deepEqual(states.map(x => x.settled), [true, true]);
    assert.equal(worker._processing, false);
    assert.equal(worker.timer, null);
  }
  assert.equal(queueCalls.length, 3);
});
