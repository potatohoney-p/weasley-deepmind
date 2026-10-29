import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { BatchRememberProcessor } from '../../lib/memory/write/BatchRememberProcessor.js';
import { FragmentFactory } from '../../lib/memory/write/FragmentFactory.js';
import { teardownTestResources, assertCleanShutdown } from '../_lifecycle.js';

after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
const item = (content, extra = {}) => ({ content, type: 'fact', topic: 'duplicate-test', keywords: ['test'], ...extra });
const A = 'Repeated content is valid and must not abort the transaction.';
const B = 'A distinct peer must remain in the same committed batch.';
function fixture({ failAt = 0 } = {}) {
  const statements = [], stored = new Map();
  let released = false;
  const client = { release() { released = true; }, async query(sql, params = []) {
    statements.push({ sql, params });
    if (!sql.startsWith('INSERT INTO')) return { rows: [] };
    const hashes = [];
    for (let i = 0; i < params.length; i += 24) hashes.push(params[i + 6]);
    assert.equal(new Set(hashes).size, hashes.length, 'one INSERT must not affect the same conflict target twice');
    if (failAt && statements.filter(s => s.sql.startsWith('INSERT INTO')).length === failAt) throw new Error('injected constraint failure');
    return { rows: hashes.map((hash, i) => {
      const offset = i * 24;
      const old = stored.get(hash);
      const row = old || { id: params[offset], importance: 0, anchor: false };
      row.importance = Math.max(row.importance, params[offset + 5]);
      row.anchor ||= params[offset + 14];
      stored.set(hash, row);
      return { id: row.id };
    }) };
  } };
  const processor = new BatchRememberProcessor({ store: {}, index: { async index() {} }, factory: new FragmentFactory() });
  processor.setPool({ async connect() { return client; } });
  return { processor, statements, stored, released: () => released };
}
for (const [name, contents] of [['adjacent', [A, A]], ['separated', [A, B, A]], ['interleaved', [A, B, A, B]], ['all repeated', Array(200).fill(A)]]) {
  test(`same-hash ${name} inputs succeed and share durable IDs`, async () => {
    const f = fixture();
    const r = await f.processor.process({ fragments: contents.map(c => item(c)), agentId: 'batch-test' });
    assert.equal(r.inserted, contents.length); // historical count is successful inputs, not new rows
    assert.equal(r.skipped, 0);
    assert.equal(f.stored.size, new Set(contents).size);
    for (let i = 0; i < contents.length; i++) assert.equal(r.results[i].id, r.results[contents.indexOf(contents[i])].id);
    assert.equal(f.statements.filter(s => s.sql === 'COMMIT').length, 1);
    assert.equal(f.released(), true);
  });
}
test('sequential duplicates retain greatest importance and anchor promotion', async () => {
  const f = fixture();
  await f.processor.process({ fragments: [item(A, { importance: .2 }), item(A, { importance: .9, isAnchor: true }), item(A, { importance: .1 })] });
  assert.equal([...f.stored.values()][0].importance, .9);
  assert.equal([...f.stored.values()][0].anchor, true);
});
test('hash collisions after normalization also split', async () => {
  const f = fixture();
  const r = await f.processor.process({ fragments: [item(A), item(`  ${A}  `)] });
  assert.equal(r.results[0].id, r.results[1].id);
});
test('unique inputs retain a single multi-row insert', async () => {
  const f = fixture();
  await f.processor.process({ fragments: [item(A), item(B)] });
  assert.equal(f.statements.filter(s => s.sql.startsWith('INSERT INTO')).length, 1);
});
test('a later constraint failure rolls back the whole transaction', async () => {
  const f = fixture({ failAt: 2 });
  await assert.rejects(f.processor.process({ fragments: [item(A), item(B), item(A)] }), /injected constraint failure/);
  assert.equal(f.statements.some(s => s.sql === 'COMMIT'), false);
  assert.equal(f.statements.at(-1).sql, 'ROLLBACK');
  assert.equal(f.released(), true);
});
