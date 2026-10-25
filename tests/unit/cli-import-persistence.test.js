import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import importCmd from '../../lib/cli/import.js';
import { FragmentWriter } from '../../lib/memory/write/FragmentWriter.js';
import { assertCleanShutdown, teardownTestResources } from '../_lifecycle.js';

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

for (const idempotent of [false, true]) {
  test(`import binds durable hash and timestamp (idempotent=${idempotent})`, { timeout: 2000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-import-'));
    const file = path.join(dir, 'rows.jsonl');
    const rows = [
      { content: '한국어 café memory', topic: 'history', created_at: '2025-02-03T04:05:06.123+09:00' },
      { content: 'second memory', topic: 'history', created_at: null },
      { content: 'third memory', topic: 'history' }
    ];
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n'));
    const queries = [];
    let closed = false;
    mock.method(pg, 'Pool', function () {
      return { query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.startsWith('SET ')) await new Promise(resolve => setTimeout(resolve, 30));
        return { rowCount: 1 };
      },
        end: async () => { closed = true; } };
    });
    const log = mock.method(console, 'log', () => {});
    try {
      await importCmd({ input: file, idempotent, json: true });
      const inserts = queries.filter(q => q.sql.includes('INSERT INTO'));
      assert.equal(inserts.length, 3);
      for (const [index, { sql, params }] of inserts.entries()) {
        const columns = sql.match(/fragments\s*\(([^)]+)\)/s)[1].split(',').map(s => s.trim());
        const hashIndex = columns.indexOf('content_hash');
        const dateIndex = columns.indexOf('created_at');
        assert.ok(hashIndex >= 0, 'required content_hash must be inserted');
        assert.ok(dateIndex >= 0, 'exported created_at must be inserted');
        assert.equal(params[hashIndex], createHash('sha256').update(rows[index].content).digest('hex'));
        assert.equal(params[hashIndex],
          FragmentWriter.prototype._prepareInsertRow(rows[index]).contentHash);
        assert.equal(params[dateIndex], rows[index].created_at ?? null);
        assert.match(sql, new RegExp(`COALESCE\\(\\$${dateIndex + 1}::timestamptz, NOW\\(\\)\\)`));
        assert.equal(sql.includes('ON CONFLICT (id) DO NOTHING'), idempotent);
      }
      assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]),
        { imported: 3, skipped: 0, errors: 0, dryRun: false, lines: 3 });
      assert.ok(closed);
    } finally {
      mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('dry-run never creates a database pool', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-import-dry-'));
  const file = path.join(dir, 'rows.jsonl');
  fs.writeFileSync(file, JSON.stringify({ content: 'sample', topic: 'test' }));
  mock.method(pg, 'Pool', () => { throw new Error('unexpected pool'); });
  const log = mock.method(console, 'log', () => {});
  try {
    await importCmd({ input: file, 'dry-run': true, json: true });
    assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).imported, 1);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid content shapes are skipped before hashing or persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-import-invalid-'));
  const file = path.join(dir, 'rows.jsonl');
  fs.writeFileSync(file, [null, [], { content: 12, topic: 't' },
    { content: {}, topic: 't' }, { content: 'valid', topic: 't' }]
    .map(row => JSON.stringify(row)).join('\n'));
  let inserts = 0;
  let closed = false;
  mock.method(pg, 'Pool', function () {
    return { query: async sql => { if (sql.includes('INSERT')) inserts++; return { rowCount: 1 }; },
      end: async () => { closed = true; } };
  });
  const log = mock.method(console, 'log', () => {});
  mock.method(process.stderr, 'write', () => true);
  try {
    await importCmd({ input: file, json: true });
    assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]),
      { imported: 1, skipped: 0, errors: 4, dryRun: false, lines: 5 });
    assert.equal(inserts, 1);
    assert.ok(closed);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('database setup failure closes the pool before returning a failing exit code', async () => {
  let closed = false;
  const previousExitCode = process.exitCode;
  mock.method(pg, 'Pool', function () {
    return { query: async () => { throw new Error('synthetic setup failure'); },
      end: async () => { closed = true; } };
  });
  mock.method(console, 'error', () => {});
  try {
    await importCmd({ input: '/unused-input-after-failed-setup', json: true });
    assert.equal(process.exitCode, 1);
    assert.ok(closed);
  } finally {
    process.exitCode = previousExitCode;
    mock.restoreAll();
  }
});


test('missing input after database setup still closes the pool', async () => {
  let closed = false;
  const previousExitCode = process.exitCode;
  mock.method(pg, 'Pool', function () {
    return { query: async () => ({ rowCount: 0 }), end: async () => { closed = true; } };
  });
  const error = mock.method(console, 'error', () => {});
  try {
    await importCmd({ input: path.join(os.tmpdir(), `missing-import-${crypto.randomUUID()}`), json: true });
    assert.equal(process.exitCode, 1);
    assert.ok(closed);
    assert.match(error.mock.calls[0].arguments[0], /File not found/);
  } finally {
    process.exitCode = previousExitCode;
    mock.restoreAll();
  }
});
