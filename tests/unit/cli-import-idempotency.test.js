import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import importCmd from '../../lib/cli/import.js';
import { assertCleanShutdown } from '../_lifecycle.js';

after(async () => { await assertCleanShutdown(); });

async function runImport(t, { idempotent = false, dryRun = false, responses }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-import-identity-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.jsonl');
  const rows = responses.map((_, i) => ({ content: `memory ${i}`, topic: 'test', idempotency_key: `key-${i}` }));
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
  const inserts = [];
  let closed = false;
  const poolMock = t.mock.method(pg, 'Pool', function () {
    return {
      query: async (sql, params) => {
        if (sql.startsWith('SET ')) return { rowCount: 0 };
        const response = responses[inserts.length];
        inserts.push({ sql, params });
        if (response instanceof Error) throw response;
        return { rowCount: response };
      },
      end: async () => { closed = true; }
    };
  });
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(process.stderr, 'write', () => true);
  await importCmd({ input: file, idempotent, 'dry-run': dryRun, json: true });
  return { inserts, closed, pools: poolMock.mock.callCount(), summary: JSON.parse(log.mock.calls[0].arguments[0]) };
}

test('idempotent import lets PostgreSQL arbitrate every unique identity without a preflight read', async t => {
  const { inserts, closed, summary } = await runImport(t, { idempotent: true, responses: [0, 1, 0] });
  assert.deepEqual(summary, { imported: 1, skipped: 2, errors: 0, dryRun: false, lines: 3 });
  assert.equal(inserts.length, 3);
  for (const [i, { sql, params }] of inserts.entries()) {
    assert.match(sql, /ON CONFLICT\s+DO NOTHING\s*$/);
    assert.doesNotMatch(sql, /DO UPDATE|WHERE NOT EXISTS/);
    assert.equal(params[11], `key-${i}`);
  }
  assert.equal(closed, true);
});

for (const [label, code] of [['duplicate', '23505'], ['check', '23514'], ['connection', '08006']]) {
  test(`ordinary import reports ${label} failure and continues`, async t => {
    const { inserts, summary, closed } = await runImport(t, {
      responses: [Object.assign(new Error(label), { code }), 1]
    });
    assert.deepEqual(summary, { imported: 1, skipped: 0, errors: 1, dryRun: false, lines: 2 });
    assert.ok(inserts.every(({ sql }) => !sql.includes('ON CONFLICT')));
    assert.equal(closed, true);
  });
}

for (const code of ['23505', '23514', '08006']) {
  test(`idempotent mode does not relabel thrown database error ${code} as a skip`, async t => {
    const { summary, closed } = await runImport(t, {
      idempotent: true, responses: [Object.assign(new Error('database failure'), { code }), 1]
    });
    assert.deepEqual(summary, { imported: 1, skipped: 0, errors: 1, dryRun: false, lines: 2 });
    assert.equal(closed, true);
  });
}

test('idempotent dry-run validates input without claiming database duplicate detection', async t => {
  const { summary, pools, inserts } = await runImport(t, { idempotent: true, dryRun: true, responses: [0, 0] });
  assert.deepEqual(summary, { imported: 2, skipped: 0, errors: 0, dryRun: true, lines: 2 });
  assert.equal(pools, 0);
  assert.equal(inserts.length, 0);
});
