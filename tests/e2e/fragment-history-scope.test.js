import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FragmentReader } from "../../lib/memory/read/FragmentReader.js";
import { getPrimaryPool, shutdownPool } from "../../lib/tools/db.js";

// Only synthetic fixtures in the explicitly configured test database.
after(async () => { await shutdownPool(); });
test("production history reads expired sources and scoped successors", async t => {
  if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL not configured");
  const pool = getPrimaryPool();
  const prefix = `history-${randomUUID()}`;
  const ids = ["old", "new", "peer", "foreign"].map(x => `${prefix}-${x}`);
  const keys = [randomUUID(), randomUUID()];
  const reader = new FragmentReader();
  try {
    for (const key of keys) {
      await pool.query(`INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix)
        VALUES ($1, $2, $3, $4)`, [key, `${prefix}-${key}`, randomUUID(), "history-test"]);
    }
    for (let i = 0; i < ids.length; i++) {
      await pool.query(`INSERT INTO agent_memory.fragments
        (id, content, topic, type, importance, content_hash, agent_id, key_id, valid_to)
        VALUES ($1, $2, $3, 'fact', 0.7, $4, $5, $6, $7)`,
      [ids[i], `synthetic ${i}`, prefix, randomUUID(), i === 2 ? "peer-history" : "owner-history",
        i === 3 ? keys[1] : keys[0], i === 0 ? "2026-01-01T00:00:00Z" : null]);
    }
    await pool.query(`INSERT INTO agent_memory.fragment_versions (fragment_id, content)
      VALUES ($1, 'synthetic previous version')`, [ids[0]]);
    for (const id of ids.slice(1)) {
      await pool.query(`INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type)
        VALUES ($1, $2, 'superseded_by')`, [ids[0], id]);
    }
    assert.equal(await reader.getById(ids[0], "owner-history", keys[0]), null);
    const result = await reader.getHistory(ids[0], "owner-history", keys[0]);
    assert.equal(result.current.id, ids[0]);
    assert.ok(result.current.valid_to);
    assert.equal(result.versions[0].content, "synthetic previous version");
    assert.deepEqual(result.superseded_by_chain.map(x => x.to_id), [ids[1]]);
    const peer = await reader.getHistory(ids[0], "owner-history", keys[0], [], { includePeerAgents: true });
    assert.deepEqual(peer.superseded_by_chain.map(x => x.to_id).sort(), [ids[1], ids[2]].sort());
    const denied = await reader.getHistory(ids[0], "owner-history", keys[1]);
    assert.deepEqual(denied, { current: null, versions: [], superseded_by_chain: [] });
    const group = await reader.getHistory(ids[0], "owner-history", keys[0], keys);
    assert.deepEqual(group.superseded_by_chain.map(x => x.to_id).sort(), [ids[1], ids[3]].sort());
  } finally {
    await pool.query("DELETE FROM agent_memory.fragments WHERE id = ANY($1::text[])", [ids]);
    await pool.query("DELETE FROM agent_memory.api_keys WHERE id = ANY($1::text[])", [keys]);
  }
});
