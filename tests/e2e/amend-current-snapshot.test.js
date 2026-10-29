import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPrimaryPool } from '../../lib/tools/db.js';
import { FragmentWriter } from '../../lib/memory/write/FragmentWriter.js';

const pool = getPrimaryPool();
after(async () => { await pool.end(); });

test('amend archives the locked current version after a concurrent writer commits', { skip: !process.env.DATABASE_URL }, async () => {
  const id = `amend-lock-${randomUUID()}`;
  const blocker = await pool.connect();
  const writer = new FragmentWriter();
  let pending;
  try {
    await pool.query(`INSERT INTO agent_memory.fragments
      (id, content, content_hash, topic, type, importance, agent_id)
      VALUES ($1, 'version zero', $2, 'original', 'fact', 0.5, 'default')`, [id, randomUUID()]);
    const stale = (await pool.query('SELECT * FROM agent_memory.fragments WHERE id = $1', [id])).rows[0];
    await blocker.query('BEGIN');
    await blocker.query("UPDATE agent_memory.fragments SET content = 'version one' WHERE id = $1", [id]);
    // Prime the blocker's transaction-local activity snapshot before the writer
    // starts. An observer reusing this transaction would remain stale.
    // The idle writer connection must not retain a previous fragments query:
    // wait events can be live even when the activity query text is cached.
    await pool.query("SELECT 'amend observer priming'");
    await blocker.query('SELECT pid, query FROM pg_stat_activity');
    pending = writer.update(id, { topic: 'changed' }, 'default', null, stale);
    // The other connection must really be waiting on this row, not just scheduled later.
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      // Use an autocommit observer, not the transaction retaining the row lock.
      // Identify our blocker explicitly so unrelated lock waits cannot satisfy it.
      const result = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND $1 = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock' AND query LIKE '%agent_memory.fragments%'`, [blocker.processID]);
      if (result.rows.length) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(blocked, 'amend should wait for the concurrent row transaction');
    const staleObservation = await blocker.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid != pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%agent_memory.fragments%'`);
    assert.equal(staleObservation.rows.length, 0,
      'the primed transaction-local activity snapshot cannot observe the later wait');
    await blocker.query('COMMIT');
    const result = await pending;
    assert.equal(result.content, 'version one');
    assert.equal(result.topic, 'changed');
    const history = await pool.query('SELECT content FROM agent_memory.fragment_versions WHERE fragment_id = $1', [id]);
    assert.deepEqual(history.rows.map(row => row.content), ['version one']);
    assert.equal(await writer.update(id, { topic: 'denied' }, 'default', 'other-key', stale), null);
    await assert.rejects(writer.update(id, { importance: -1 }, 'default', null, stale));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_memory.fragment_versions WHERE fragment_id = $1', [id])).rows[0].n, 1);
  } finally {
    await blocker.query('ROLLBACK');
    await pending?.catch(() => {});
    await pool.query('DELETE FROM agent_memory.fragment_versions WHERE fragment_id = $1', [id]);
    await pool.query('DELETE FROM agent_memory.fragments WHERE id = $1', [id]);
    blocker.release();
  }
});
