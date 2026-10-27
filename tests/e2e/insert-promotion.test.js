import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

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
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.current_agent_id = 'system'");
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
    assert.equal((await client.query('SELECT count(*)::int AS n FROM agent_memory.fragments WHERE content LIKE $1', [`%${nonce}%`])).rows[0].n, 0);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
    await shutdownPool();
    await disconnectRedis();
  }
});
