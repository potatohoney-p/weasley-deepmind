/** Production CLI against the migrated PostgreSQL schema, using synthetic rows. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const host = process.env.POSTGRES_HOST || process.env.DB_HOST;

test('JSONL import persists required hashes and original chronology', { skip: !host }, async () => {
  const pool = new pg.Pool({
    host, port: Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432),
    database: process.env.POSTGRES_DB || process.env.DB_NAME,
    user: process.env.POSTGRES_USER || process.env.DB_USER,
    password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD,
    connectionTimeoutMillis: 3000
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-import-e2e-'));
  const ids = Array.from({ length: 3 }, () => `import-${randomUUID()}`);
  const rows = ids.map((id, index) => ({
    id, content: `한국어 café synthetic restore ${id}`, topic: 'import-regression',
    created_at: index === 1 ? null : '2025-02-03T04:05:06.123+09:00'
  }));
  const moduleUrl = new URL('../../lib/cli/import.js', import.meta.url).href;
  const invoke = (subset, idempotent) => {
    const file = path.join(dir, 'input.jsonl');
    fs.writeFileSync(file, subset.map(row => JSON.stringify(row)).join('\n'));
    const script = `import run from ${JSON.stringify(moduleUrl)}; await run(${JSON.stringify({ input: file, idempotent, json: true })});`;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, DOTENV_CONFIG_PATH: path.join(dir, 'absent.env') } });
    return JSON.parse(stdout);
  };
  try {
    const before = Date.now();
    assert.equal(invoke(rows.slice(0, 2), false).imported, 2);
    assert.equal(invoke(rows.slice(2), true).imported, 1);
    const repeat = invoke([{ ...rows[2], content: 'must not overwrite existing memory',
      created_at: '2026-01-01T00:00:00.000Z' }], true);
    assert.equal(repeat.skipped, 1);
    assert.equal(repeat.errors, 0);
    const result = await pool.query(
      'SELECT id, content_hash, created_at FROM agent_memory.fragments WHERE id = ANY($1::text[])', [ids]);
    assert.equal(result.rows.length, 3);
    for (const actual of result.rows) {
      const input = rows.find(row => row.id === actual.id);
      assert.equal(actual.content_hash, createHash('sha256').update(input.content).digest('hex'));
      if (input.created_at) assert.equal(actual.created_at.toISOString(), '2025-02-02T19:05:06.123Z');
      else assert.ok(actual.created_at.getTime() >= before && actual.created_at.getTime() <= Date.now());
    }
  } finally {
    try {
      await pool.query('DELETE FROM agent_memory.fragments WHERE id = ANY($1::text[])', [ids]);
    } finally {
      await pool.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
