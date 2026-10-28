import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
let connect;
mock.module('../../lib/tools/db.js', { namedExports: { getPrimaryPool: () => ({ connect: () => connect() }), shutdownPool: async () => {} } });
const { reconsolidate } = await import('../../lib/memory/link/ReconsolidationEngine.js');
const { assertCleanShutdown, teardownTestResources } = await import('../_lifecycle.js');
after(async () => { await teardownTestResources(); await assertCleanShutdown(); mock.restoreAll(); });
let id = 90000;
function fixture({ fail, empty } = {}) {
  const calls = []; let released = 0;
  return { calls, get released() { return released; }, release() { released++; }, async query(sql) {
    calls.push(sql);
    if (fail && sql.includes(fail)) throw new Error(`failure:${fail}`);
    if (empty && sql.includes(empty)) return { rows: [] };
    return { rows: [{ id, weight: 1, confidence: '0.500', new_weight: .85, new_confidence: '.400' }] };
  } };
}
for (const fail of ['connect', 'BEGIN', 'SELECT', 'UPDATE agent_memory', 'INSERT INTO', 'COMMIT']) {
  test(`${fail} failure does not consume cooldown`, async () => {
    const link = id++; const bad = fixture({ fail });
    connect = async () => { if (fail === 'connect') throw new Error('connect'); return bad; };
    await assert.rejects(reconsolidate(link, 'decay'));
    const good = fixture(); connect = async () => good;
    assert.ok(await reconsolidate(link, 'quarantine'));
    assert.ok(good.calls.includes('COMMIT'));
    assert.equal(good.released, 1);
    assert.equal(await reconsolidate(link, 'decay'), null);
  });
}
for (const empty of ['SELECT', 'UPDATE agent_memory']) {
  test(`${empty} missing row allows retry`, async () => {
    const link = id++; connect = async () => fixture({ empty });
    assert.equal(await reconsolidate(link, 'decay'), null);
    connect = async () => fixture();
    assert.ok(await reconsolidate(link, 'decay'));
  });
}
test('in-flight reservation lasts beyond cooldown and cooldown starts at commit', async () => {
  const link = id++; let now = 1000; const clock = mock.method(Date, 'now', () => now);
  let resolve; let connects = 0;
  connect = () => { connects++; return connects === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(fixture()); };
  try {
    const pending = reconsolidate(link, 'decay');
    now += 120000;
    assert.equal(await reconsolidate(link, 'quarantine'), null);
    assert.equal(connects, 1);
    resolve(fixture()); await pending;
    connect = async () => fixture();
    now += 59999; assert.equal(await reconsolidate(link, 'decay'), null);
    now++; assert.ok(await reconsolidate(link, 'decay'));
  } finally { resolve?.(fixture()); clock.mock.restore(); }
});
test('timestamp zero is a valid committed cooldown', async () => {
  const clock = mock.method(Date, 'now', () => 0); const link = id++;
  try { connect = async () => fixture(); assert.ok(await reconsolidate(link, 'decay')); assert.equal(await reconsolidate(link, 'decay'), null); }
  finally { clock.mock.restore(); }
});
test('non-decay action and independent link are not reserved', async () => {
  const first = id++; const second = id++;
  connect = async () => fixture();
  assert.ok(await reconsolidate(first, 'decay'));
  assert.ok(await reconsolidate(first, 'reinforce'));
  assert.ok(await reconsolidate(second, 'decay'));
});
