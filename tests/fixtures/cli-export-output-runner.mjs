import { mock } from 'node:test';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const entrypoint = process.argv[2].startsWith('cli-');
const scenario = entrypoint ? process.argv[2].slice(4) : process.argv[2];
let updateChecks = 0;
const realStdout = process.stdout;
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmind-export-output-'));
const messages = [];
const chunks = [];
let closed = false;
let poolCreated = false;
let selects = 0;
let written = 0;
let pendingAtSecondSelect = null;
let successBeforeFinish = false;
let finished = false;
let returnedBeforeFlush = false;
let output;
let args = { output: path.join(dir, 'backup.jsonl') };
const queries = [];
const rows = Array.from({ length: scenario.startsWith('empty-') ? 0 : scenario === 'backpressure' || scenario === 'filtered-limit' ? 401 : 3 }, (_, i) => ({
  id: `fragment-${i}`, content: `한국어 memory ${i} ` + (scenario === 'backpressure' ? 'x'.repeat(1024) : ''),
  topic: 'backup', keywords: ['recall'], created_at: '2026-01-01T00:00:00.000Z'
}));

mock.module('pg', { defaultExport: { Pool: class {
  constructor() { poolCreated = true; }
  async query(sql, params) {
    if (sql.startsWith('SET ')) {
      if (scenario === 'setup-failure') throw new Error('synthetic setup failure');
      if (scenario === 'open-failure') await new Promise(r => setTimeout(r, 20));
      return { rows: [] };
    }
    selects++;
    queries.push({ sql, params });
    if (selects === 2) pendingAtSecondSelect = 200 - written;
    if (scenario === 'query-failure') throw new Error('synthetic query failure');
    const [limit, offset] = params.slice(-2);
    return { rows: rows.slice(offset, offset + limit) };
  }
  async end() { closed = true; }
} } });

const isStdout = scenario.startsWith('stdout-');
const synthetic = ['backpressure', 'final-failure', 'write-failure', 'close-failure', 'delayed-finish', 'stdout-delay', 'stdout-failure', 'stdout-close'].includes(scenario);
if (synthetic) {
  output = new Writable({
    highWaterMark: scenario === 'backpressure' ? 1 : 64 * 1024,
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      if (scenario === 'write-failure' || scenario === 'stdout-failure') {
        setImmediate(() => callback(Object.assign(new Error('synthetic sink failure'), { code: 'EPIPE' })));
      } else if (scenario === 'close-failure' || scenario === 'stdout-close') {
        setImmediate(() => this.destroy());
      } else {
        setTimeout(() => { written++; callback(); }, scenario === 'backpressure' ? 1 : 15);
      }
    },
    final(callback) {
      setTimeout(() => {
        if (scenario === 'final-failure') callback(new Error('synthetic final failure'));
        else { finished = true; callback(); }
      }, 15);
    }
  });
  if (isStdout) {
    args = {};
    Object.defineProperty(process, 'stdout', { configurable: true, value: output });
  } else {
    mock.method(fs, 'createWriteStream', () => output);
  }
}
if (scenario === 'open-failure') args.output = path.join(dir, 'missing', 'backup.jsonl');
if (scenario === 'json-file' || scenario === 'empty-json') args.json = true;
if (scenario === 'filtered-limit') args = { ...args, key: 'synthetic-owner', topic: 'backup', type: 'fact', since: '2026-01-01', limit: '201' };
if (scenario === 'stdout-json') { args = { json: true }; output = new Writable({ write(c, e, cb) { chunks.push(c.toString()); written++; cb(); } }); Object.defineProperty(process, 'stdout', { configurable: true, value: output }); }
if (scenario === 'invalid-date') { fs.writeFileSync(args.output, 'existing backup'); args.since = 'invalid-date'; }
if (scenario === 'invalid-limit') { fs.writeFileSync(args.output, 'existing backup'); args.limit = '-1'; }
mock.method(process.stderr, 'write', message => {
  messages.push(String(message));
  if (String(message).startsWith('Exported ') && synthetic && !isStdout && !finished) successBeforeFinish = true;
  return true;
});
mock.method(console, 'error', message => messages.push(String(message)));

if (entrypoint) {
  mock.module('../../lib/updater/cache.js', { namedExports: { UpdateCache: class {
    constructor() { updateChecks++; }
    isExpired() { return false; }
  } } });
}

try {
  if (entrypoint) {
    process.env.UPDATE_CHECK_DISABLED = 'false';
    process.argv = [process.execPath, 'weasley-deepmind.js', 'export',
      ...Object.entries(args).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)])];
    await import('../../bin/weasley-deepmind.js');
    await new Promise(resolve => process.once('beforeExit', resolve));
  } else {
  const { default: exportCmd } = await import('../../lib/cli/export.js');
  await exportCmd(args);
  }
  const exitCode = process.exitCode ?? 0;
  returnedBeforeFlush = synthetic && !['write-failure', 'final-failure', 'close-failure', 'stdout-failure', 'stdout-close'].includes(scenario) && written !== rows.length;
  const sinkEnded = output?.writableEnded;
  const sinkDestroyed = output?.destroyed;
  const listeners = output?.listenerCount('error');
  if (!isStdout && args.output && fs.existsSync(args.output)) chunks.push(fs.readFileSync(args.output, 'utf8'));
  mock.restoreAll();
  Object.defineProperty(process, 'stdout', stdoutDescriptor);
  process.exitCode = 0;
  realStdout.write(JSON.stringify({ scenario, entrypoint, updateChecks, exitCode, closed, poolCreated, selects, written, pendingAtSecondSelect, queries,
    successBeforeFinish, returnedBeforeFlush, sinkEnded, sinkDestroyed, listeners, messages,
    output: chunks.join(''), expected: rows }) + '\n');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
