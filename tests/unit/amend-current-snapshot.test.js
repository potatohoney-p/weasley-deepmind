import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let current, queries, archives, released, failUpdate;
const row = (content = 'current content') => ({ id: 'memory-1', content, topic: 'topic', keywords: [], type: 'fact', importance: 0.7, key_id: 'key-1' });
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/SELECT .*FROM agent_memory.fragments/s.test(sql) && /WHERE id = \$1/.test(sql)) return { rows: current ? [{ ...current }] : [] };
    if (/SELECT id FROM agent_memory.fragments/.test(sql)) return { rows: [] };
    if (/INSERT INTO agent_memory.fragment_versions/.test(sql)) { archives.push(params); return { rows: [] }; }
    if (/UPDATE agent_memory.fragments/.test(sql)) {
      if (failUpdate) throw new Error('update failed');
      return { rows: [{ ...current, topic: 'changed' }] };
    }
    if (sql === 'ROLLBACK') archives.length = 0;
    return { rows: [] };
  },
  release() { released++; }
};
mock.module('../../lib/tools/db.js', { namedExports: {
  getPrimaryPool: () => ({ connect: async () => client }),
  queryWithAgentVector: async () => ({ rows: current ? [{ ...current }] : [] })
} });
const { FragmentWriter } = await import('../../lib/memory/write/FragmentWriter.js');
beforeEach(() => { current = row(); queries = []; archives = []; released = 0; failUpdate = false; });
const writer = new FragmentWriter();

test('archives current durable content, not the caller snapshot', async () => {
  await writer.update('memory-1', { topic: 'changed' }, 'default', 'key-1', row('stale content'));
  assert.equal(archives[0][1], 'current content');
});
test('locks and reads within the transaction before archiving', async () => {
  await writer.update('memory-1', { topic: 'changed' }, 'default', 'key-1');
  const lock = queries.findIndex(q => /FOR UPDATE/.test(q.sql));
  assert.ok(lock > queries.findIndex(q => q.sql === 'BEGIN'));
  assert.ok(lock < queries.findIndex(q => /INSERT INTO/.test(q.sql)));
});
test('a deleted row does not create a stale archive', async () => {
  current = null;
  assert.equal(await writer.update('memory-1', { topic: 'changed' }, 'default', 'key-1', row()), null);
  assert.equal(archives.length, 0);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
  assert.equal(released, 1);
});
test('ownership uses the locked row rather than stale ownership', async () => {
  current.key_id = 'key-2';
  assert.equal(await writer.update('memory-1', { topic: 'changed' }, 'default', 'key-1', row()), null);
  assert.equal(archives.length, 0);
  assert.equal(released, 1);
});
test('a stale denial does not override current ownership', async () => {
  const stale = { ...row(), key_id: 'key-2' };
  assert.equal((await writer.update('memory-1', { topic: 'changed' }, 'default', 'key-1', stale)).topic, 'changed');
});
test('no-op returns the current row and rolls back archive', async () => {
  const result = await writer.update('memory-1', {}, 'default', 'key-1', row('stale'));
  assert.equal(result.content, 'current content');
  assert.equal(archives.length, 0);
});
test('failed update rolls back the archive and releases client', async () => {
  failUpdate = true;
  await assert.rejects(writer.update('memory-1', { topic: 'changed' }, 'default', 'key-1'), /update failed/);
  assert.equal(archives.length, 0);
  assert.equal(released, 1);
});
test('master amendment uses current row too', async () => {
  await writer.update('memory-1', { topic: 'changed' }, 'default', null, row('old'));
  assert.equal(archives[0][1], 'current content');
  assert.equal(released, 1);
});
