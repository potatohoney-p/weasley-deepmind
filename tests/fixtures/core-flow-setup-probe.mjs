import { mock } from 'node:test';
import fs from 'node:fs';
const queries = [];
const indexes = new Set(['uq_frag_hash_master', 'uq_frag_hash_per_key']);
if (process.env.PROBE_MODE === 'legacy') indexes.add('idx_frag_hash');
if (process.env.PROBE_MODE === 'missing') indexes.delete('uq_frag_hash_per_key');
process.on('exit', () => fs.writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify({ queries, indexes: [...indexes] })));
await mock.module('pg', { defaultExport: { Pool: class {
  async query(sql) {
    queries.push(sql);
    if (/CREATE UNIQUE INDEX IF NOT EXISTS idx_frag_hash/i.test(sql)) indexes.add('idx_frag_hash');
    if (/pg_indexes/.test(sql)) return { rows: [...indexes].map(indexname => ({ indexname })) };
    return { rows: [] };
  }
  async end() {}
} } });
// Baseline TCP probe is satisfied without opening a socket.
await mock.module('node:net', { defaultExport: { createConnection(_options, callback) {
  const socket = { destroy() {}, on() { return socket; } };
  globalThis.queueMicrotask(callback);
  return socket;
} } });
let id = 0;
const rows = [];
await mock.module('../../lib/memory/MemoryManager.js', { namedExports: { MemoryManager: {
  getInstance() { return {
    async remember(input) { const result = { ...input, id: `probe-${++id}` }; rows.push(result); return result; },
    async recall() { return { fragments: [...rows] }; },
    async amend(input) { return { updated: true, fragment: input }; },
    async forget() { const deleted = rows.length; rows.length = 0; return { deleted }; },
  }; },
} } });
await import('../e2e/core-flow.test.js');
