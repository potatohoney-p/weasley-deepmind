import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { teardownTestResources, assertCleanShutdown } from '../_lifecycle.js';

let rows = new Map();
const queries = [];
mock.module('../../lib/tools/db.js', { namedExports: {
  queryWithAgentVector: async (_agent, sql, params) => {
    queries.push({ sql, params });
    const batch = sql.includes('AS f');
    const guarded = batch ? sql.includes('f.content = v.content') : sql.includes('content = $3');
    const stride = batch ? (guarded ? 3 : 2) : params.length;
    const persisted = [];
    for (let i = 0; i < params.length; i += stride) {
      const row = rows.get(params[i]);
      if (!row || (guarded && row.content !== params[i + 2])) continue;
      if (sql.includes('embedding IS NULL') && row.embedding !== null) continue;
      row.embedding = JSON.parse(params[i + 1]);
      persisted.push({ id: params[i] });
    }
    return { rows: sql.includes('RETURNING') ? persisted : [], rowCount: persisted.length };
  }
}});
mock.module('../../lib/tools/embedding.js', { namedExports: {
  generateEmbedding: async () => { throw new Error('unexpected provider call'); },
  generateBatchEmbeddings: async () => { throw new Error('unexpected provider call'); },
  prepareTextForEmbedding: text => text,
  vectorToSql: JSON.stringify,
  EMBEDDING_ENABLED: true
}});
const { EmbeddingWorker } = await import('../../lib/memory/embedding/EmbeddingWorker.js');
after(async () => { await teardownTestResources(); await assertCleanShutdown(); });

for (const method of ['_embedChunk', '_embedOne']) {
  for (const change of ['amend', 'delete', 'already-completed', 'unchanged']) {
    test(`${method} only publishes a still-current pending row: ${change}`, async () => {
      const snapshot = { id: 'memory', content: 'original 서울 café' };
      rows = new Map([[snapshot.id, { ...snapshot, embedding: null }]]);
      queries.length = 0;
      const worker = new EmbeddingWorker();
      worker.config = { retryLimit: 1, queueKey: 'test' };
      let release;
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      worker.embeddingCache = { get: async () => {
        entered();
        await new Promise(resolve => { release = resolve; });
        return [1, 0, 0];
      } };
      const ready = [];
      const batches = [];
      worker.on('embedding_ready', event => ready.push(event.fragmentId));
      worker.on('embedding_batch_done', event => batches.push(event.count));
      const pending = worker[method](method === '_embedChunk' ? [snapshot] : snapshot);
      await started;
      if (change === 'amend') rows.get(snapshot.id).content = 'corrected 부산 tea';
      if (change === 'delete') rows.delete(snapshot.id);
      if (change === 'already-completed') rows.get(snapshot.id).embedding = [0, 1, 0];
      release();
      await pending;
      const expected = change === 'unchanged' ? ['memory'] : [];
      assert.deepEqual(ready, expected);
      if (method === '_embedChunk') assert.deepEqual(batches, [expected.length]);
      if (change === 'amend') assert.equal(rows.get(snapshot.id).embedding, null);
      if (change === 'already-completed') assert.deepEqual(rows.get(snapshot.id).embedding, [0, 1, 0]);
      if (change === 'unchanged') assert.deepEqual(rows.get(snapshot.id).embedding, [1, 0, 0]);
      assert.equal(queries.length, 1);
      assert.ok(queries[0].params.includes(snapshot.content));
    });
  }
}
