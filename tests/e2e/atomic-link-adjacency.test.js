import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('link edge and both adjacency writes roll back together on database error', async t => {
  if (!(process.env.POSTGRES_HOST || process.env.DB_HOST)) { t.skip('PostgreSQL test host not configured'); return; }
  const { LinkStore } = await import('../../lib/memory/link/LinkStore.js');
  const { getPrimaryPool, shutdownPool } = await import('../../lib/tools/db.js');
  const pool = getPrimaryPool();
  const agent = `atomic-link-${randomUUID()}`;
  const ids = [randomUUID(), randomUUID()];
  const originalConnect = pool.connect;
  try {
    for (const id of ids) await pool.query(`INSERT INTO agent_memory.fragments
      (id, content, topic, type, content_hash, agent_id) VALUES ($1,$1,$2,'fact',$1,$2)`, [id, agent]);
    for (const batch of [false, true]) {
      // Scoped client wrapper injects a real SQL error on the second adjacency
      // write. No schema mutation or production fault hook is introduced.
      pool.connect = async () => {
        const client = await originalConnect.call(pool);
        let writes = 0;
        return { query: (sql, params) => {
          if (sql.includes('UPDATE agent_memory.fragments') && ++writes === 2) return client.query('SELECT 1 / 0');
          return client.query(sql, params);
        }, release: () => client.release() };
      };
      try {
        const store = new LinkStore();
        await assert.rejects(batch ? store.createLinks([{ fromId: ids[0], toId: ids[1] }], agent)
          : store.createLink(ids[0], ids[1], 'related', agent), { code: '22012' });
      } finally { pool.connect = originalConnect; }
      assert.equal((await pool.query('SELECT * FROM agent_memory.fragment_links WHERE from_id=$1', [ids[0]])).rowCount, 0);
      assert.deepEqual((await pool.query('SELECT linked_to FROM agent_memory.fragments WHERE id=ANY($1::text[])', [ids])).rows.map(r => r.linked_to), [[], []]);
    }
    await new LinkStore().createLink(ids[0], ids[1], 'related', agent);
    assert.equal((await pool.query('SELECT * FROM agent_memory.fragment_links WHERE from_id=$1', [ids[0]])).rowCount, 1);
    const rows = (await pool.query('SELECT id, linked_to FROM agent_memory.fragments WHERE id=ANY($1::text[])', [ids])).rows;
    for (const row of rows) assert.deepEqual(row.linked_to, [ids.find(id => id !== row.id)]);
  } finally {
    pool.connect = originalConnect;
    try {
      await pool.query('DELETE FROM agent_memory.fragment_links WHERE from_id=ANY($1::text[]) OR to_id=ANY($1::text[])', [ids]);
      await pool.query('DELETE FROM agent_memory.fragments WHERE id=ANY($1::text[])', [ids]);
    } finally { await shutdownPool(); }
  }
});
