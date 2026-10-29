import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

test('repeated insert promotes durable importance/anchor and external rollback remains atomic', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL not configured'
}, async () => {
  const { FragmentWriter } = await import('../../lib/memory/write/FragmentWriter.js');
  const { shutdownPool } = await import('../../lib/tools/db.js');
  const { disconnectRedis } = await import('../../lib/redis.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const nonce = randomUUID();
  const keyId = `promotion-${nonce}`;
  const writer = new FragmentWriter();
  writer.schemaInitialized = true;
  const indexInventorySql = "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='agent_memory' AND tablename='fragments' ORDER BY indexname";
  try {
    const { rows: originalIndexes } = await client.query(indexInventorySql);
    // Missing migration 031 is an environment failure, not something to hide.
    assert.ok(originalIndexes.some(row => row.indexname === 'uq_frag_hash_master'));
    assert.ok(originalIndexes.some(row => row.indexname === 'uq_frag_hash_per_key'));
    await client.query('BEGIN');
    await client.query("SET LOCAL app.current_agent_id = 'system'");
    // core-flow.test.js replays the base schema after the migration job, which
    // recreates idx_frag_hash. Restore the already-migrated index contract only
    // inside this rollback-only fixture; do not change the deployed schema.
    await client.query(await readFile(new URL(
      '../../lib/memory/migrations/migration-031-content-hash-per-key.sql', import.meta.url
    ), 'utf8'));
    const { rows: indexes } = await client.query(indexInventorySql);
    assert.ok(!indexes.some(row => row.indexname === 'idx_frag_hash'));
    assert.ok(indexes.some(row => row.indexname === 'uq_frag_hash_master'));
    assert.ok(indexes.some(row => row.indexname === 'uq_frag_hash_per_key'));
    await client.query(`INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1,$2,$3,$4)`,
      [keyId, 'insert promotion regression', createHash('sha256').update(nonce).digest('hex'), nonce.slice(0, 12)]);
    for (const scope of [null, keyId]) {
      const id = `promotion-${randomUUID()}`;
      const base = { id, content: `Preserve this durable memory ${nonce}`, topic: 'insert-promotion', type: 'fact', keywords: ['original'], importance: 0.3, key_id: scope, agent_id: 'default' };
      assert.equal(await writer.insert(base, { client }), id);
      assert.equal(await writer.insert({ ...base, id: `retry-${randomUUID()}`, importance: 0.9, is_anchor: true, topic: 'ignored', keywords: ['ignored'] }, { client }), id);
      let { rows: [row] } = await client.query('SELECT * FROM agent_memory.fragments WHERE id=$1', [id]);
      assert.equal(row.is_anchor, true);
      assert.ok(Math.abs(row.importance - 0.9) < 0.00001);
      assert.equal(row.topic, base.topic);
      assert.deepEqual(row.keywords, base.keywords);
      await writer.insert({ ...base, id: `retry-${randomUUID()}`, importance: 0.1, is_anchor: false }, { client });
      ({ rows: [row] } = await client.query('SELECT * FROM agent_memory.fragments WHERE id=$1', [id]));
      assert.equal(row.is_anchor, true);
      assert.ok(Math.abs(row.importance - 0.9) < 0.00001);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM agent_memory.fragments WHERE content=$1 AND key_id IS NOT DISTINCT FROM $2', [base.content, scope])).rows[0].n, 1);
    }
    await client.query('ROLLBACK');
    assert.deepEqual((await client.query(indexInventorySql)).rows, originalIndexes);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM agent_memory.fragments WHERE content LIKE $1', [`%${nonce}%`])).rows[0].n, 0);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
    await shutdownPool();
    await disconnectRedis();
  }
});
