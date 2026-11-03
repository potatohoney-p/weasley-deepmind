import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teardownTestResources, assertCleanShutdown } from '../_lifecycle.js';

const fixture = fileURLToPath(new URL('../fixtures/server-embedding-shutdown-worker.mjs', import.meta.url));
const scenarios = [
  ['sigterm', 'SIGTERM drains the asynchronously initialized embedding worker'],
  ['sigint', 'SIGINT drains the asynchronously initialized embedding worker'],
  ['fatal', 'fatal shutdown drains the worker and preserves exit code one'],
  ['replacement', 'shutdown reads the current worker rather than a startup snapshot'],
  ['rejected', 'rejected embedding drain preserves all-settled resource cleanup'],
  ['timeout', 'pending embedding drain retains the existing thirty-second deadline'],
  ['absent', 'missing embedding worker does not block shutdown'],
  ['synchronous', 'synchronously supplied embedding worker still drains']
];
for (const [scenario, title] of scenarios) {
  test(title, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fixture, scenario], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, WEASLEY_DEEPMIND_METRICS_DEFAULT: 'off', REDIS_ENABLED: 'false', CACHE_ENABLED: 'false' }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = result.stdout.split('\n').find(line => line.startsWith('RESULT '));
    assert.ok(report, 'fixture must finish its lifecycle assertions');
    assert.equal(JSON.parse(report.slice(7)).scenario, scenario);
  });
}
after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
