import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCleanShutdown } from '../_lifecycle.js';

const runner = fileURLToPath(new URL('../fixtures/cli-export-output-runner.mjs', import.meta.url));
function run(scenario) {
  const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', runner, scenario], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DOTENV_CONFIG_PATH: '.env.test', REDIS_ENABLED: 'false', CACHE_ENABLED: 'false', WEASLEY_DEEPMIND_METRICS_DEFAULT: 'off' }
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.trim(), 'command must return through resource cleanup');
  return JSON.parse(child.stdout.trim());
}
after(async () => { await assertCleanShutdown(); });

for (const scenario of ['jsonl-file', 'json-file', 'stdout-json']) {
  test(`export preserves ${scenario} bytes and releases its pool`, () => {
    const result = run(scenario);
    assert.equal(result.exitCode, 0);
    assert.equal(result.closed, true);
    assert.equal(result.output, scenario === 'jsonl-file'
      ? result.expected.map(row => JSON.stringify(row)).join('\n') + '\n'
      : JSON.stringify(result.expected, null, 2) + (scenario === 'json-file' ? '\n' : ''));
    assert.deepEqual(result.messages, ['Exported 3 fragments\n']);
    if (scenario === 'stdout-json') assert.equal(result.sinkEnded, false);
  });
}

test('slow JSONL sink applies backpressure before fetching the next database page', () => {
  const result = run('backpressure');
  assert.equal(result.exitCode, 0);
  assert.equal(result.selects, 3);
  assert.ok(result.pendingAtSecondSelect <= 1, `unflushed first-page rows: ${result.pendingAtSecondSelect}`);
  assert.equal(result.written, 401);
  assert.equal(result.returnedBeforeFlush, false);
  assert.equal(result.successBeforeFinish, false);
  assert.equal(result.closed, true);
});

test('file success is reported only after final flush', () => {
  const result = run('delayed-finish');
  assert.equal(result.successBeforeFinish, false);
  assert.equal(result.returnedBeforeFlush, false);
  assert.equal(result.closed, true);
});

test('stdout waits for writes without ending or destroying the caller-owned stream', () => {
  const result = run('stdout-delay');
  assert.equal(result.returnedBeforeFlush, false);
  assert.equal(result.sinkEnded, false);
  assert.equal(result.sinkDestroyed, false);
  assert.equal(result.listeners, 0);
  assert.equal(result.closed, true);
});

for (const scenario of ['open-failure', 'write-failure', 'final-failure', 'close-failure', 'stdout-failure', 'stdout-close', 'setup-failure', 'query-failure']) {
  test(`${scenario} fails without a success report and still closes the pool`, () => {
    const result = run(scenario);
    assert.equal(result.exitCode, 1);
    assert.equal(result.closed, true);
    assert.ok(result.messages.some(message => message.startsWith('[export] ')));
    assert.ok(!result.messages.some(message => message.startsWith('Exported ')));
  });
}

for (const scenario of ['invalid-date', 'invalid-limit']) {
  test(`${scenario} does not open the database or truncate an existing backup`, () => {
    const result = run(scenario);
    assert.equal(result.exitCode, 1);
    assert.equal(result.poolCreated, false);
    assert.equal(result.output, 'existing backup');
    assert.ok(!result.messages.some(message => message.startsWith('Exported ')));
  });
}

for (const scenario of ['empty-jsonl', 'empty-json']) {
  test(`${scenario} completes an empty export`, () => {
    const result = run(scenario);
    assert.equal(result.exitCode, 0);
    assert.equal(result.closed, true);
    assert.equal(result.output, scenario === 'empty-json' ? '[]\n' : '');
    assert.deepEqual(result.messages, ['Exported 0 fragments\n']);
  });
}

test('filters and hard limit retain exact bindings across page boundaries', () => {
  const result = run('filtered-limit');
  assert.equal(result.exitCode, 0);
  assert.equal(result.closed, true);
  assert.deepEqual(result.output.trim().split('\n').map(JSON.parse), result.expected.slice(0, 201));
  assert.equal(result.selects, 2);
  for (const [index, { sql, params }] of result.queries.entries()) {
    assert.deepEqual(params, ['synthetic-owner', 'backup', 'fact', '2026-01-01T00:00:00.000Z', index ? 1 : 200, index ? 200 : 0]);
    assert.match(sql, /valid_to IS NULL AND key_id = \$1 AND topic = \$2 AND type = \$3 AND created_at >= \$4::timestamptz/);
    assert.match(sql, /LIMIT\s+\$5\s+OFFSET \$6/);
  }
});

for (const scenario of ['invalid-limit', 'write-failure', 'jsonl-file']) {
  test(`CLI entrypoint update checks honor ${scenario} outcome`, () => {
    const result = run(`cli-${scenario}`);
    const success = scenario === 'jsonl-file';
    assert.equal(result.exitCode, success ? 0 : 1);
    assert.equal(result.updateChecks, success ? 1 : 0);
    assert.equal(result.closed, scenario !== 'invalid-limit');
  });
}
