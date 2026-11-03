// Exercise the real server entrypoint without opening sockets or external services.
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const scenario = process.argv[2];
const events = [];
let listening;
let schedulerRef;
let healthRef;
let fatal;
let release;
const drain = new Promise(resolve => { release = resolve; });
const worker = {
  stop() {
    events.push('embedding-stop');
    return scenario === 'rejected' ? Promise.reject(new Error('embedding failed')) : drain;
  }
};
const staleWorker = { stop() { events.push('stale-stop'); return Promise.resolve(); } };
const noop = () => {};
const asyncNoop = async () => {};
const stub = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });

mock.module('http', { defaultExport: { createServer: () => ({
  on: noop,
  listen(_port, _host, callback) { listening = callback; },
  close(callback) { events.push('http-close'); callback(); }
}) } });
stub('../../lib/config.js', {
  HOST: '127.0.0.1', PORT: 0, ACCESS_KEY: 'test-only', AUTH_DISABLED: false,
  SESSION_TTL_MS: 60000, LOG_DIR: '.', RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_PER_IP: 100, RATE_LIMIT_PER_KEY: 100,
  detectPgvectorSchema: asyncNoop, PGVECTOR_SCHEMA: null, ENABLE_OPENAPI: false
});
stub('../../config/memory.js', { MEMORY_CONFIG: { morphemeIndex: { tokenizer: 'llm' } } });
stub('../../config/validate-memory-config.js', { validateMemoryConfig: noop });
stub('../../lib/rate-limiter.js', { DualRateLimiter: class { cleanup() {} } });
stub('../../lib/utils.js', { validateOrigin: () => true });
stub('../../lib/sessions.js', {
  closeStreamableSession: asyncNoop, closeLegacySseSession: asyncNoop,
  getAllSessionIds: () => { events.push('sessions-close'); return { streamableIds: [], legacyIds: [] }; }
});
stub('../../lib/tools/index.js', { saveAccessStats: async () => { events.push('stats-save'); } });
stub('../../lib/tools/db.js', {
  shutdownPool: async () => { events.push('db-close'); }, getPrimaryPool: () => null
});
stub('../../lib/memory/signals/MemoryEvaluator.js', {
  getMemoryEvaluator: () => ({ stop: () => { events.push('evaluator-stop'); return Promise.resolve(); } })
});
stub('../../lib/memory/write/BatchRememberWorker.js', {
  getBatchRememberWorker: () => ({ stop: () => { events.push('batch-stop'); return Promise.resolve(); } })
});
stub('../../lib/memory/MemoryManager.js', {
  MemoryManager: { getInstance: () => ({ drainMorpheme: () => {
    events.push('morpheme-drain'); return Promise.resolve();
  } }) }
});
stub('../../lib/metrics.js', { recordHttpRequest: noop });
stub('../../lib/scheduler.js', { startSchedulers: ({ globalEmbeddingWorkerRef }) => {
  schedulerRef = globalEmbeddingWorkerRef;
  if (scenario === 'synchronous') schedulerRef.current = worker;
  if (scenario === 'replacement') schedulerRef.current = staleWorker;
} });
stub('../../lib/memory/read/Reranker.js', { preloadReranker: asyncNoop });
stub('../../lib/memory/embedding/MorphemeTokenizer.js', { warmup: asyncNoop });
stub('../../lib/logger.js', { logInfo: noop, logWarn: noop, logError: noop });
stub('../../lib/process-guards.js', { installProcessGuards: options => { fatal = options.onFatal; } });
stub('../../lib/network-safety.js', { assertSafeAuthBinding: noop });
stub('../../scripts/check-embedding-consistency.js', { checkEmbeddingConsistency: async () => true });
stub('../../lib/auth.js', { validateAuthentication: async () => ({ valid: true }) });
stub('../../lib/openapi.js', { buildSpec: () => ({}) });
stub('../../lib/http-handlers.js', {
  ...Object.fromEntries([
    'handleHealth', 'handleMetrics', 'handleMcpPost', 'handleMcpGet', 'handleMcpDelete',
    'handleLegacySseGet', 'handleLegacySsePost', 'handleOAuthServerMetadata',
    'handleOAuthResourceMetadata', 'handleOAuthAuthorize', 'handleOAuthToken',
    'handleOAuthRegister', 'handleSessionRotate', 'handleAdminUi', 'handleAdminImage',
    'handleAdminStatic', 'handleAdminApi', 'getAllowedOrigin'
  ].map(name => [name, noop])),
  setWorkerRefs: ({ embeddingWorkerRef }) => { healthRef = embeddingWorkerRef; }
});

const oldTerm = new Set(process.listeners('SIGTERM'));
const oldInt = new Set(process.listeners('SIGINT'));
mock.method(process, 'exit', code => { events.push(`exit:${code}`); });
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const flush = () => new Promise(resolve => setImmediate(resolve));
try {
  await import('../../server.js');
  await import('../../lib/memory/MemoryManager.js');
  listening();
  assert.strictEqual(schedulerRef, healthRef, 'health and scheduler share ownership');
  // Scheduler's production dynamic import assigns current after listen setup returns.
  await flush();
  if (scenario !== 'absent') schedulerRef.current = worker;

  let shutdown;
  if (scenario === 'fatal') fatal();
  else {
    const signal = scenario === 'sigint' ? 'SIGINT' : 'SIGTERM';
    const before = signal === 'SIGINT' ? oldInt : oldTerm;
    shutdown = process.listeners(signal).find(listener => !before.has(listener))();
  }
  await flush();
  await flush();

  if (scenario === 'absent') {
    await shutdown;
    assert.ok(!events.includes('embedding-stop'));
    assert.ok(events.includes('exit:0'));
  } else {
    assert.equal(events.filter(event => event === 'embedding-stop').length, 1,
      `shutdown must stop the live worker: ${events.join(', ')}`);
    assert.ok(!events.includes('stale-stop'));
    if (scenario !== 'rejected') {
      assert.ok(!events.includes('db-close'), 'do not close database before drain');
      assert.ok(!events.includes('sessions-close'), 'do not close sessions before drain');
      assert.ok(!events.includes('stats-save'));
      assert.ok(!events.some(event => event.startsWith('exit:')));
      if (scenario === 'timeout') {
        mock.timers.tick(29999);
        await flush();
        assert.ok(!events.includes('db-close'));
        mock.timers.tick(1);
      } else release();
    }
    if (shutdown) await shutdown;
    await flush();
    assert.ok(events.includes(scenario === 'fatal' ? 'exit:1' : 'exit:0'));
    assert.ok(events.indexOf('embedding-stop') < events.indexOf('db-close'));
    assert.ok(events.indexOf('db-close') < events.indexOf('stats-save'));
  }
  process.stdout.write(`RESULT ${JSON.stringify({ scenario, events })}\n`);
} finally {
  release();
  for (const listener of process.listeners('SIGTERM')) if (!oldTerm.has(listener)) process.removeListener('SIGTERM', listener);
  for (const listener of process.listeners('SIGINT')) if (!oldInt.has(listener)) process.removeListener('SIGINT', listener);
  mock.timers.reset();
  mock.restoreAll();
}
