/** Actual worker SQL against migrated PostgreSQL; synthetic cached vectors only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const host = process.env.POSTGRES_HOST || process.env.DB_HOST;
test('late embedding publication cannot overwrite amended or completed memory', { skip: !host }, async () => {
  const { EmbeddingWorker } = await import('../../lib/memory/embedding/EmbeddingWorker.js');
  const { shutdownPool } = await import('../../lib/tools/db.js');
  const { teardownTestResources } = await import('../_lifecycle.js');
  const pool = new pg.Pool({
    host, port: Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432),
    database: process.env.POSTGRES_DB || process.env.DB_NAME,
    user: process.env.POSTGRES_USER || process.env.DB_USER,
    password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD,
    connectionTimeoutMillis: 3000
  });
  const ids = Array.from({ length: 3 }, () => `embedding-freshness-${randomUUID()}`);
  const snapshots = ids.map((id, i) => ({ id, content: `synthetic 서울 café memory ${i} ${id}` }));
  const vector = value => Array.from({ length: 1536 }, (_, i) => i === 0 ? value : 0);
  const hash = content => createHash('sha256').update(content).digest('hex');
  const read = async id => (await pool.query(
    'SELECT content, embedding::text AS embedding FROM agent_memory.fragments WHERE id = $1', [id])).rows[0];
  const worker = new EmbeddingWorker();
  worker.config = { retryLimit: 1, queueKey: 'synthetic-unused' };
  const ready = [];
  const batches = [];
  worker.on('embedding_ready', event => ready.push(event.fragmentId));
  worker.on('embedding_batch_done', event => batches.push(event.count));
  let release;
  let pending;
  try {
    for (const row of snapshots) {
      await pool.query(`INSERT INTO agent_memory.fragments
        (id, content, content_hash, type, topic, agent_id) VALUES ($1,$2,$3,'fact','freshness-regression','system')`,
      [row.id, row.content, hash(row.content)]);
    }
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    worker.embeddingCache = { get: async () => { entered(); await gate; return vector(1); } };
    pending = worker._embedChunk(snapshots);
    await started;
    const amended = `${snapshots[0].content} corrected 부산`;
    await pool.query(`UPDATE agent_memory.fragments SET content=$2, content_hash=$3, embedding=NULL WHERE id=$1`,
      [ids[0], amended, hash(amended)]);
    await pool.query('DELETE FROM agent_memory.fragments WHERE id=$1', [ids[2]]);
    release();
    await pending;
    assert.equal((await read(ids[0])).embedding, null);
    assert.equal(JSON.parse((await read(ids[1])).embedding)[0], 1);
    assert.deepEqual(ready, [ids[1]]);
    assert.deepEqual(batches, [1]);

    worker.embeddingCache = { get: async () => vector(2) };
    await worker._embedOne(snapshots[0]); // old fallback snapshot must also be rejected
    await worker._embedOne(snapshots[2]); // deleted row must not be announced
    assert.deepEqual(ready, [ids[1]]);
    assert.equal((await read(ids[0])).embedding, null);
    await worker._embedOne({ id: ids[0], content: amended });
    assert.equal(JSON.parse((await read(ids[0])).embedding)[0], 2);
    assert.deepEqual(ready, [ids[1], ids[0]]);
    worker.embeddingCache = { get: async () => vector(3) };
    await worker._embedChunk([{ id: ids[0], content: amended }]);
    await worker._embedOne({ id: ids[0], content: amended });
    assert.equal(JSON.parse((await read(ids[0])).embedding)[0], 2);
    assert.deepEqual(ready, [ids[1], ids[0]]);
    assert.deepEqual(batches, [1, 0]);
  } finally {
    release?.();
    if (pending) await pending.catch(() => {});
    try { await pool.query('DELETE FROM agent_memory.fragments WHERE id = ANY($1::text[])', [ids]); }
    finally { await pool.end(); await shutdownPool(); await teardownTestResources(); }
  }
});
