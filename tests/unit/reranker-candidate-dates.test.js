import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
let documents;
let fail = false;
let calls = 0;
const server = http.createServer(async (req, res) => {
  calls++;
  let body = '';
  for await (const chunk of req) body += chunk;
  documents = JSON.parse(body).documents;
  res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ scores: [0.1, 0.9] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.RERANKER_URL = `http://127.0.0.1:${server.address().port}`;
process.env.RERANKER_EXTERNAL_FALLBACK = 'skip';
process.env.RERANKER_EXTERNAL_COOLDOWN_MS = '60000';
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
let sequence = 0;
const fresh = () => import(`../../lib/memory/read/Reranker.js?dates=${sequence++}`);
const invalidDates = [ 'not-a-date', new Date(NaN), Infinity, 1e20, Symbol('invalid'), 1n ];
for (const [index, created_at] of invalidDates.entries()) {
  test(`malformed candidate date ${index} uses unknown prefix without aborting ranking`, async () => {
    fail = false;
    const candidates = [{ id: 'a', content: 'alpha', created_at }, { id: 'b', content: 'bravo', created_at: '2026-01-02T03:04:05Z' }];
    const { rerank } = await fresh();
    const result = await rerank('q', candidates, 1);
    assert.deepEqual(documents, ['[Date: unknown] alpha', '[Date: 2026-01-02] bravo']);
    assert.deepEqual(result.map(c => c.id), ['b']);
    assert.ok(result.every(c => Number.isFinite(c.rerankerScore)));
    assert.strictEqual(candidates[0].created_at, created_at);
    assert.equal(candidates[0].rerankerScore, undefined);
  });
}
test('valid Date and missing date preserve request contract and ranking', async () => {
  fail = false;
  const { rerank } = await fresh();
  const result = await rerank('q', [{ id: 'a', content: 'a', created_at: new Date('2025-12-31T23:00:00Z') }, { id: 'b', content: 'b' }]);
  assert.deepEqual(documents, ['[Date: 2025-12-31] a', '[Date: unknown] b']);
  assert.deepEqual(result.map(c => c.id), ['b', 'a']);
  assert.ok(result.every(c => Number.isFinite(c.rerankerScore)));
});
test('bad date does not prevent service-failure fallback and cooldown', async () => {
  fail = true;
  const { rerank } = await fresh();
  const candidates = [{ id: 'a', created_at: 'invalid' }, { id: 'b' }];
  const before = calls;
  for (let i = 0; i < 4; i++) assert.strictEqual(await rerank('q', candidates), candidates);
  assert.equal(calls - before, 3);
  fail = false;
});
