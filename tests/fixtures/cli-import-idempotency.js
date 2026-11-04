import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Shared acceptance assertions; invoke runs the production import command. */
export async function verifyImportIdempotency({ query, invoke }) {
  const prefix = `import-identity-${randomUUID()}`;
  const topic = prefix;
  const row = (suffix, extra = {}) => ({
    id: `${prefix}-${suffix}`, content: `${prefix} content ${suffix}`, topic, ...extra
  });
  const saved = [row('id'), row('key', { idempotency_key: `${prefix}-key` }),
    row('hash'), row('anonymous', { id: undefined })];
  const summary = (imported, skipped, errors, lines) =>
    ({ imported, skipped, errors, dryRun: false, lines });
  try {
    assert.deepEqual(await invoke(saved, true), summary(4, 0, 0, 4), 'initial restore');
    const before = (await query('SELECT * FROM agent_memory.fragments WHERE topic = $1 ORDER BY id', [topic])).rows;
    const duplicates = [
      row('id', { content: `${prefix} changed content`, topic: `${prefix}-changed` }),
      row('new-key-id', { idempotency_key: `${prefix}-key` }),
      row('new-hash-id', { content: saved[2].content }),
      saved[3]
    ];
    const results = [];
    for (const duplicate of duplicates) results.push(await invoke([duplicate], true));
    const after = (await query('SELECT * FROM agent_memory.fragments WHERE topic = $1 ORDER BY id', [topic])).rows;
    assert.deepEqual(after, before, 'skipping duplicates must not mutate stored rows');
    for (const [index, kind] of ['id', 'idempotency key', 'content hash', 'generated id'].entries()) {
      assert.deepEqual(results[index], summary(0, 1, 0, 1), `${kind} collision is a skip`);
    }
    assert.deepEqual(await invoke([
      duplicates[1], row('new-a'), duplicates[2], row('new-b')
    ], true), summary(2, 2, 0, 4), 'duplicates do not stop later valid rows');
    assert.deepEqual(await invoke([saved[0], duplicates[1], duplicates[2]], false),
      summary(0, 0, 3, 3), 'ordinary import retains duplicate errors');
    assert.deepEqual(await invoke([
      row('bad', { importance: 2 }), row('after-bad')
    ], true), summary(1, 0, 1, 2), 'idempotent import retains CHECK errors and continues');
    assert.deepEqual(await invoke([row('id', { importance: 2 })], true),
      summary(0, 0, 1, 1), 'invalid duplicate is not treated as successful validation');
    const final = await query('SELECT id FROM agent_memory.fragments WHERE topic = $1', [topic]);
    assert.equal(final.rows.length, 7, 'only successful new rows persisted');
  } finally {
    await query('DELETE FROM agent_memory.fragments WHERE topic = ANY($1::text[])', [[topic, `${prefix}-changed`]]);
  }
}
