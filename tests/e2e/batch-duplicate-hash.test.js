import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

after(async () => { if (teardownTestResources) await teardownTestResources(); });
let teardownTestResources;

test('PostgreSQL batch duplicates upsert sequentially and real errors roll back peers', async t => {
  if (!process.env.POSTGRES_HOST && !process.env.DB_HOST && !process.env.DATABASE_URL) return t.skip('PostgreSQL not configured');
  const { BatchRememberProcessor } = await import('../../lib/memory/write/BatchRememberProcessor.js');
  const { FragmentFactory } = await import('../../lib/memory/write/FragmentFactory.js');
  const { getPrimaryPool } = await import('../../lib/tools/db.js');
  ({ teardownTestResources } = await import("../_lifecycle.js"));
  const pool = getPrimaryPool();
  await pool.query('SELECT 1 FROM agent_memory.fragments LIMIT 1');
  const agentId = `batch-duplicate-${crypto.randomUUID()}`;
  const keyId = crypto.randomUUID();
  const factory = new FragmentFactory();
  const processor = new BatchRememberProcessor({ store: {}, factory, index: { async index() {} } });
  processor.setPool(pool);
  const make = (label, extras = {}) => ({ content: `Batch duplicate E2E ${agentId} ${label}`, topic: agentId, type: 'fact', keywords: ['batch'], ...extras });
  await pool.query('INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1,$2,$3,$4)', [keyId, agentId, crypto.createHash('sha256').update(keyId).digest('hex'), `batch-${keyId.slice(0, 8)}`]);
  try {
    for (const key of [null, keyId]) {
      const suffix = key || 'master';
      const fragments = [make(`${suffix}-repeat`, { importance: .2 }), make(`${suffix}-peer`), make(`${suffix}-repeat`, { importance: .9, isAnchor: true })];
      const result = await processor.process({ agentId, _keyId: key, fragments });
      assert.equal(result.inserted, 3);
      assert.equal(result.results[0].id, result.results[2].id);
      const rows = (await pool.query('SELECT id, importance, is_anchor FROM agent_memory.fragments WHERE agent_id = $1 AND key_id IS NOT DISTINCT FROM $2', [agentId, key])).rows;
      assert.equal(rows.length, 2);
      const repeated = rows.find(row => row.id === result.results[0].id);
      assert.equal(Number(repeated.importance), .9);
      assert.equal(repeated.is_anchor, true);
      const retry = await processor.process({ agentId, _keyId: key, fragments });
      assert.deepEqual(retry.results.map(r => r.id), result.results.map(r => r.id));
    }
    const originalCreate = factory.create.bind(factory);
    factory.create = params => ({ ...originalCreate(params), ...(params.breakConstraint ? { type: 'invalid-fragment-type' } : {}) });
    await assert.rejects(processor.process({ agentId, fragments: [make('rollback'), make('rollback'), make('invalid', { breakConstraint: true })] }), error => error.code === '23514');
    const remaining = (await pool.query('SELECT content FROM agent_memory.fragments WHERE agent_id = $1', [agentId])).rows;
    assert.equal(remaining.length, 4);
    assert.equal(remaining.some(row => row.content.includes('rollback')), false);
  } finally {
    await pool.query('DELETE FROM agent_memory.fragments WHERE agent_id = $1', [agentId]);
    await pool.query('DELETE FROM agent_memory.api_keys WHERE id = $1', [keyId]);
  }
});
