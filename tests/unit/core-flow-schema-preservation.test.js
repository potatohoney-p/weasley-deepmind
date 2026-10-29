import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function probe(mode = 'ready') {
  const dir = mkdtempSync(join(tmpdir(), 'deepmind-core-flow-'));
  try {
    const output = join(dir, 'queries.json');
    const env = { ...process.env, POSTGRES_HOST: 'synthetic-db', PROBE_MODE: mode, PROBE_OUTPUT: output };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test-reporter=tap', fileURLToPath(new URL('../fixtures/core-flow-setup-probe.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(run.error);
    return { ...run, ...JSON.parse(readFileSync(output, 'utf8')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('core flow exercises CRUD without replaying schema DDL over migrated indexes', () => {
  const result = probe();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.queries.some(sql => /CREATE\s|ALTER\s|DROP\s/i.test(sql)), false, 'E2E must consume pre-migrated schema, not modify it');
  assert.deepEqual(result.indexes.sort(), ['uq_frag_hash_master', 'uq_frag_hash_per_key']);
  assert.match(result.stdout, /# pass 6/);
});

test('core flow rejects resurrected global hash index instead of masking drift', () => {
  const result = probe('legacy');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /idx_frag_hash/);
});

test('core flow rejects a missing scoped hash index without repairing the database', () => {
  const result = probe('missing');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /uq_frag_hash_per_key/);
  assert.equal(result.queries.some(sql => /CREATE\s|ALTER\s|DROP\s/i.test(sql)), false);
});
