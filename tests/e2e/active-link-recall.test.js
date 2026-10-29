import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

test("linked recall excludes soft-deleted edges before limiting PostgreSQL rows", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
  const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const prefix = `active-links-${randomUUID()}`;
    const seed = `${prefix}-seed`;
    const outgoing = `${prefix}-a-out`;
    const incoming = `${prefix}-b-in`;
    const live = `${prefix}-z-live`;
    const deleted = Array.from({ length: 12 }, (_, i) => `${prefix}-a-deleted-${i}`);
    for (const id of [seed, outgoing, incoming, live, ...deleted]) {
      await client.query(`INSERT INTO agent_memory.fragments
        (id, content, content_hash, topic, type) VALUES ($1, $1, $1, $2, 'fact')`, [id, prefix]);
    }
    for (const [from, to] of [[seed, outgoing], [incoming, seed], [seed, live]]) {
      await client.query(`INSERT INTO agent_memory.fragment_links
        (from_id, to_id, relation_type) VALUES ($1, $2, 'related')`, [from, to]);
    }
    const store = new LinkStore();
    const read = async () => {
      const { sql, params } = store._buildLinkedFragmentsSql({ fromIds: [seed], safeRelationType: null, keyId: null });
      return (await client.query(sql, params)).rows.map(row => row.id).sort();
    };
    assert.deepEqual(await read(), [outgoing, incoming, live].sort());
    await client.query(`UPDATE agent_memory.fragment_links SET deleted_at = NOW()
      WHERE (from_id = $1 AND to_id = $2) OR (from_id = $3 AND to_id = $1)`, [seed, outgoing, incoming]);
    for (const id of deleted) await client.query(`INSERT INTO agent_memory.fragment_links
      (from_id, to_id, relation_type, deleted_at) VALUES ($1, $2, 'related', NOW())`, [seed, id]);
    assert.deepEqual(await read(), [live], "deleted edges cannot consume the ten-row limit");
    await client.query(`UPDATE agent_memory.fragment_links SET deleted_at = NULL WHERE from_id = $1 AND to_id = $2`, [seed, outgoing]);
    assert.deepEqual(await read(), [outgoing, live].sort());
  } finally {
    try { if (client) await client.query("ROLLBACK"); }
    finally {
      client?.release();
      await pool.end();
      await teardownTestResources();
      await assertCleanShutdown();
    }
  }
});
