import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';

let execute;
mock.module('../../lib/tools/db.js', { namedExports: {
  getPrimaryPool: () => ({}),
  shutdownPool: async () => {},
  queryWithAgentVector: async (agent, sql, params) => execute(sql, params, agent)
} });
const { FragmentWriter } = await import('../../lib/memory/write/FragmentWriter.js');
const { disconnectRedis } = await import('../../lib/redis.js');
const { assertCleanShutdown } = await import('../_lifecycle.js');
after(async () => { await disconnectRedis(); await assertCleanShutdown(); });

for (const external of [false, true]) {
  for (const keyId of [null, 'key-a']) {
    test(`repeat insert executes promotion upsert (external=${external}, key=${keyId})`, async () => {
      const calls = [];
      execute = async (sql, params, agent) => {
        calls.push({ sql, params, agent });
        if (sql.includes('SELECT id FROM')) return { rows: [{ id: 'durable-id' }] };
        return { rows: [{ id: 'durable-id' }] };
      };
      const writer = new FragmentWriter();
      writer.schemaInitialized = true;
      const fragment = { id: 'attempt-id', content: 'A repeated important memory with sufficient length', topic: 'test', type: 'fact', importance: 0.9, is_anchor: true, key_id: keyId, agent_id: 'alice' };
      const client = { query: (sql, params) => execute(sql, params) };
      assert.equal(await writer.insert(fragment, external ? { client } : {}), 'durable-id');
      const inserts = calls.filter(c => c.sql.startsWith('INSERT INTO'));
      assert.equal(inserts.length, 1, 'existing rows must pass through the atomic promotion statement');
      assert.equal(inserts[0].params[5], 0.9);
      assert.equal(inserts[0].params[14], true);
      assert.match(inserts[0].sql, /importance\s*= GREATEST/);
      assert.match(inserts[0].sql, /is_anchor\s*= .* OR EXCLUDED.is_anchor/);
      assert.equal(inserts[0].params[13], keyId);
      assert.equal(calls.some(c => c.sql.startsWith('COMMIT') || c.sql.startsWith('BEGIN')), false);
    });
  }
}

test('new unanchored inserts retain importance clamps and actual returned ID', async () => {
  let captured;
  execute = async (sql, params) => {
    if (sql.startsWith('SELECT')) return { rows: [] };
    captured = params;
    return { rows: [{ id: 'stored-id' }] };
  };
  const writer = new FragmentWriter(); writer.schemaInitialized = true;
  assert.equal(await writer.insert({ id: 'new-id', content: 'short', type: 'fact', importance: 0.9 }), 'stored-id');
  assert.equal(captured[5], 0.2);
  assert.equal(captured[14], false);
});

test('write errors remain errors, not duplicate success', async () => {
  const failure = new Error('write rejected');
  execute = async sql => { if (sql.startsWith('SELECT')) return { rows: [{ id: 'old' }] }; throw failure; };
  const writer = new FragmentWriter(); writer.schemaInitialized = true;
  await assert.rejects(writer.insert({ id: 'new', content: 'memory', type: 'fact' }), error => error === failure);
});
