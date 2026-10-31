import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { teardownTestResources, assertCleanShutdown } from '../_lifecycle.js';

let failBatch;
const batches = [];
const dead = [];
mock.module('../../lib/redis.js', { namedExports: {
  redisClient: { status: 'stub', lpush: async (_key, value) => dead.push(JSON.parse(value)) }
}});
mock.module('../../lib/tools/db.js', { namedExports: {
  queryWithAgentVector: async () => ({ rows: [] })
}});
mock.module('../../lib/tools/embedding.js', { namedExports: {
  generateEmbedding: async () => [1, 0],
  generateBatchEmbeddings: async texts => {
    batches.push(texts);
    // Bound the faulty baseline so it cannot loop forever during regression tests.
    if (batches.length > 3) return texts.map(() => [1, 0]);
    if (failBatch(texts, batches.length)) throw new Error(failBatch.message);
    return texts.map(() => [1, 0]);
  },
  prepareTextForEmbedding: text => text,
  vectorToSql: JSON.stringify,
  EMBEDDING_ENABLED: true
}});
const { EmbeddingWorker } = await import('../../lib/memory/embedding/EmbeddingWorker.js');
after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
const rows = [{ id: 'a', content: 'first' }, { id: 'b', content: 'second' }];

for (const index of ['2', '99', '9007199254740993', '9'.repeat(400)]) {
  test(`out-of-range input[${index.slice(0, 20)}] falls back without retrying identical batch`, async () => {
    batches.length = 0; dead.length = 0;
    failBatch = () => true;
    failBatch.message = `Invalid 'input[${index}]': rejected`;
    const worker = new EmbeddingWorker();
    worker.embeddingCache = { get: async () => null, set: () => {} };
    const single = [];
    worker._embedOne = async row => single.push(row.id);
    await worker._embedChunk(rows);
    assert.equal(batches.length, 1);
    assert.deepEqual(single, ['a', 'b']);
    assert.deepEqual(dead, []);
  });
}
for (const index of [0, 1]) {
  test(`valid index ${index} isolates exactly one row and shrinks retry`, async () => {
    batches.length = 0; dead.length = 0;
    failBatch = (_texts, count) => count === 1;
    failBatch.message = `Invalid 'input[${index}]': rejected`;
    const worker = new EmbeddingWorker();
    worker.config = { queueKey: 'test' };
    worker.embeddingCache = { get: async () => null, set: () => {} };
    worker._embedOne = async () => assert.fail('unexpected single fallback');
    await worker._embedChunk(rows);
    assert.deepEqual(batches.map(x => x.length), [2, 1]);
    assert.deepEqual(dead.map(x => x.fragmentId), [rows[index].id]);
  });
}
test('unindexed error keeps existing single-row fallback', async () => {
  batches.length = 0; dead.length = 0;
  failBatch = () => true; failBatch.message = 'provider unavailable';
  const worker = new EmbeddingWorker();
  worker.embeddingCache = { get: async () => null, set: () => {} };
  const single = [];
  worker._embedOne = async row => single.push(row.id);
  await worker._embedChunk(rows);
  assert.equal(batches.length, 1);
  assert.deepEqual(single, ['a', 'b']);
  assert.deepEqual(dead, []);
});
