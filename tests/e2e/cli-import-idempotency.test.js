/** Real import commands against the migrated PostgreSQL uniqueness constraints. */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { verifyImportIdempotency } from '../fixtures/cli-import-idempotency.js';

const host = process.env.POSTGRES_HOST || process.env.DB_HOST;

test('idempotent import preserves stored rows across every supported duplicate identity', { skip: !host }, async () => {
  const pool = new pg.Pool({
    host, port: Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432),
    database: process.env.POSTGRES_DB || process.env.DB_NAME,
    user: process.env.POSTGRES_USER || process.env.DB_USER,
    password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD,
    connectionTimeoutMillis: 3000
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-import-identity-'));
  const moduleUrl = new URL('../../lib/cli/import.js', import.meta.url).href;
  try {
    await verifyImportIdempotency({
      query: (sql, params) => pool.query(sql, params),
      invoke: async (rows, idempotent) => {
        const file = path.join(dir, 'input.jsonl');
        fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
        const script = `import run from ${JSON.stringify(moduleUrl)}; await run(${JSON.stringify({ input: file, idempotent, json: true })});`;
        return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8', timeout: 15000,
          env: { ...process.env, DOTENV_CONFIG_PATH: path.join(dir, 'absent.env') }
        }));
      }
    });
  } finally {
    try { await pool.end(); } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
