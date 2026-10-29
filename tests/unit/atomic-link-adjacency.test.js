import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
let calls, failAt, updates, committed;
const query = async (sql, params) => {
  calls.push({ sql, params });
  if (sql.includes('UPDATE agent_memory.fragments') && ++updates === failAt) throw new Error('adjacency failed');
  return { rows: sql.includes('INSERT INTO') ? [{ id: 'edge' }] : [] };
};
mock.module('../../lib/tools/db.js', { namedExports: {
  getPrimaryPool: () => ({}),
  withTransaction: async (_, fn) => { const result = await fn({ query }); committed = true; return result; },
  queryWithAgentVector: async (_, sql, params) => query(sql, params)
} });
const { LinkStore } = await import('../../lib/memory/link/LinkStore.js');
for (const kind of ['single', 'batch']) {
  const run = () => kind === 'single' ? new LinkStore().createLink('a', 'b', 'related', 'test') : new LinkStore().createLinks([{ fromId: 'a', toId: 'b' }], 'test');
  for (const failure of [1, 2]) test(`${kind}: adjacency failure ${failure} prevents commit`, async () => {
    calls = []; failAt = failure; updates = 0; committed = false;
    await assert.rejects(run(), /adjacency failed/);
    assert.equal(committed, false);
  });
  test(`${kind}: both adjacency writes precede commit`, async () => {
    calls = []; failAt = 0; updates = 0; committed = false;
    await run(); assert.equal(updates, 2); assert.equal(committed, true);
    assert.match(calls.find(q => q.sql.includes('app.current_agent_id')).sql, /'test'/);
  });
}
