import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { MemoryRecaller } from '../../lib/memory/processors/MemoryRecaller.js';
import { CaseRecall } from '../../lib/memory/read/CaseRecall.js';
import { countTokens } from '../../lib/memory/write/FragmentFactory.js';
import { assertCleanShutdown, teardownTestResources } from '../_lifecycle.js';

after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
const now = Date.UTC(2026, 9, 26);
const fragment = (id, tokens, score, extra = {}) => ({
  id, agent_id: 'default', type: 'fact', content: `Synthetic ${id}`, estimated_tokens: tokens,
  rerankerScore: score, created_at: new Date(now).toISOString(), ...extra,
});
function harness(direct, linked = [], seen = []) {
  let searchQuery;
  const recaller = new MemoryRecaller({
    search: { search: async query => { searchQuery = query; return { fragments: structuredClone(direct),
      count: direct.length, totalTokens: direct.reduce((n, f) => n + (f.estimated_tokens || countTokens(f.content)), 0), searchPath: 'synthetic' }; } },
    store: { getLinkedFragments: async () => structuredClone(linked) },
    index: { getSeenIds: async () => new Set(seen) },
  });
  return { recall: params => recaller.recall({ anchorTime: now, ...params }), query: () => searchQuery };
}

test('linked expansion cannot exceed the final ranked recall budget', async () => {
  const h = harness([fragment('direct', 60, 0.9)], [fragment('linked', 60, 0.8)]);
  const r = await h.recall({ tokenBudget: 100 });
  assert.deepEqual(r.fragments.map(f => f.id), ['direct']);
  assert.equal(r.totalTokens, 60); assert.equal(r.totalCount, 1);
});
test('higher-ranked linked memory competes under the same final budget', async () => {
  const h = harness([fragment('direct', 60, 0.7)], [fragment('linked', 70, 0.9)]);
  const r = await h.recall({ tokenBudget: 100 });
  assert.deepEqual(r.fragments.map(f => f.id), ['linked']); assert.equal(r.totalTokens, 70);
});
test('fitting lower-ranked memories survive a larger fragment that cannot fit', async () => {
  const h = harness([fragment('direct', 40, 0.9)], [fragment('large', 100, 0.8), fragment('small', 30, 0.7)]);
  const r = await h.recall({ tokenBudget: 70 });
  assert.deepEqual(r.fragments.map(f => f.id), ['direct', 'small']); assert.equal(r.totalTokens, 70);
});
test('returned-page accounting includes linked memory rather than stale search totals', async () => {
  const h = harness([fragment('direct', 20, 0.9)], [fragment('linked', 30, 0.8)]);
  const r = await h.recall({ tokenBudget: 100 });
  assert.equal(r.totalTokens, 50); assert.equal(r.count, 2);
});
test('threshold and depth filters release budget before final selection', async () => {
  const h = harness([fragment('excluded', 40, 0.9, { type: 'decision', similarity: 0.1 })], [fragment('linked', 40, 0.8, { similarity: 0.9 })]);
  const r = await h.recall({ tokenBudget: 50, threshold: 0.5, depth: 'tool-level' });
  assert.deepEqual(r.fragments.map(f => f.id), ['linked']); assert.equal(r.totalTokens, 40);
});
test('each cursor page counts only returned memories and never skips budget-selected rows', async () => {
  const h = harness([fragment('a', 30, 0.9)], [fragment('b', 40, 0.8), fragment('c', 20, 0.7)]);
  const first = await h.recall({ tokenBudget: 70, pageSize: 1 });
  const second = await h.recall({ tokenBudget: 70, pageSize: 1, cursor: first.nextCursor });
  assert.deepEqual(first.fragments.map(f => f.id), ['a']); assert.equal(first.totalTokens, 30);
  assert.deepEqual(second.fragments.map(f => f.id), ['b']); assert.equal(second.totalTokens, 40);
  assert.equal(first.totalCount, 2); assert.equal(second.totalCount, 2); assert.equal(second.hasMore, false);
});
test('out-of-range cursor yields zero returned tokens', async () => {
  const h = harness([fragment('a', 30, 0.9)]);
  const r = await h.recall({ includeLinks: false, cursor: Buffer.from(JSON.stringify({ offset: 9, anchorTime: now })).toString('base64url') });
  assert.equal(r.count, 0); assert.equal(r.totalTokens, 0);
});
test('missing and zero token estimates use the existing content estimator', async () => {
  const f = fragment('a', 0, 0.9);
  const g = fragment('b', undefined, 0.8);
  const budget = countTokens(f.content) + countTokens(g.content);
  const r = await harness([f], [g]).recall({ tokenBudget: budget });
  assert.equal(r.count, 2); assert.equal(r.totalTokens, budget);
});
test('default budget also constrains expansion and is passed unchanged to search', async () => {
  const h = harness([fragment('a', 700, 0.9)], [fragment('b', 500, 0.8)]);
  const r = await h.recall({});
  assert.equal(h.query().tokenBudget, 1000); assert.deepEqual(r.fragments.map(f => f.id), ['a']); assert.equal(r.totalTokens, 700);
});
test('empty recall retains empty accounting and existing metadata', async () => {
  const r = await harness([]).recall({ tokenBudget: 100, includeLinks: false });
  assert.deepEqual(r.fragments, []); assert.equal(r.totalTokens, 0); assert.equal(r.searchPath, 'synthetic');
});

test('seen memories are excluded before budget without leaking their token count', async () => {
  const h = harness([fragment('seen', 40, 0.9)], [fragment('new', 40, 0.8)], ['seen']);
  const r = await h.recall({ sessionId: 'synthetic-session', tokenBudget: 50 });
  assert.deepEqual(r.fragments.map(f => f.id), ['new']); assert.equal(r.totalTokens, 40);
});
test('case mode receives the same bounded page and corrected token count', async t => {
  let ids;
  t.mock.method(CaseRecall.prototype, 'buildCaseTriples', async fragments => { ids = fragments.map(f => f.id); return []; });
  const h = harness([fragment('direct', 20, 0.9)], [fragment('linked', 30, 0.8)]);
  const r = await h.recall({ tokenBudget: 100, caseMode: true });
  assert.deepEqual(ids, ['direct', 'linked']); assert.equal(r.totalTokens, 50); assert.equal(r.count, 2);
});
