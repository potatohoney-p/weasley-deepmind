import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaChecker, clearUsageCache, invalidateUsageCache } from '../../lib/memory/QuotaChecker.js';

afterEach(clearUsageCache);
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const entered = deferred();
  const release = deferred();
  let count = 1;
  let connects = 0;
  const checker = new QuotaChecker();
  checker.setPool({ async connect() {
    const first = ++connects === 1;
    return { async query(sql) {
      if (sql.includes('COUNT')) {
        const snapshot = count;
        if (first) { entered.resolve(); await release.promise; }
        return { rows: [{ count: snapshot }] };
      }
      if (sql.includes('fragment_limit')) return { rows: [{ fragment_limit: 100 }] };
      return { rows: [] };
    }, release() {} };
  } });
  return { checker, entered, release, setCount(v) { count = v; }, connects: () => connects };
}
for (const operation of ['invalidate', 'clear']) {
  test(`${operation} prevents an in-flight old result from repopulating quota cache`, async () => {
    const f = fixture();
    const old = f.checker.getUsage('key');
    await f.entered.promise;
    f.setCount(7);
    if (operation === 'clear') clearUsageCache(); else invalidateUsageCache('key');
    f.release.resolve();
    assert.equal((await old).current, 1, 'original caller keeps its transaction snapshot');
    assert.equal((await f.checker.getUsage('key')).current, 7, 'later caller re-reads after invalidation');
    assert.equal(f.connects(), 2);
  });
}
test('older read cannot overwrite a newer post-invalidation cache result', async () => {
  const f = fixture();
  const old = f.checker.getUsage('key');
  await f.entered.promise;
  invalidateUsageCache('key');
  f.setCount(9);
  assert.equal((await f.checker.getUsage('key')).current, 9);
  f.release.resolve();
  await old;
  assert.equal((await f.checker.getUsage('key')).current, 9);
  assert.equal(f.connects(), 2, 'new cache remains reusable');
});
test('invalidating another key does not discard an unaffected in-flight result', async () => {
  const f = fixture();
  const old = f.checker.getUsage('key');
  await f.entered.promise;
  invalidateUsageCache('other');
  f.release.resolve();
  await old;
  assert.equal((await f.checker.getUsage('key')).current, 1);
  assert.equal(f.connects(), 1);
});
