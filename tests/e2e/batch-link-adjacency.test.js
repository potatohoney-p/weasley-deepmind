import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Hosted E2E initializes the migrated schema. Never connect without an explicit
// test database host; fixtures are isolated and cleaned by their unique IDs.
test("batched links preserve pairwise adjacency and disconnected components", async t => {
  if (!(process.env.POSTGRES_HOST || process.env.DB_HOST)) {
    t.skip("PostgreSQL test host is not configured");
    return;
  }
  const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
  const { getPrimaryPool, shutdownPool } = await import("../../lib/tools/db.js");
  const pool = getPrimaryPool();
  const store = new LinkStore();
  const agent = `batch-adjacency-${randomUUID()}`;
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const [a, b, c, d, e, untouched] = ids;
  try {
    for (const id of ids) {
      await pool.query(`INSERT INTO agent_memory.fragments
        (id, content, topic, type, content_hash, agent_id)
        VALUES ($1, $1, $2, 'fact', $1, $2)`, [id, agent]);
    }
    await pool.query("UPDATE agent_memory.fragments SET linked_to = $2 WHERE id = $1", [a, [e]]);
    const pairs = [{ fromId: a, toId: b }, { fromId: c, toId: d }];
    const sortPairs = p => p.sort((x, y) => [x.fromId, x.toId].sort().join(":").localeCompare([y.fromId, y.toId].sort().join(":")));
    assert.equal((await store.createLinks(sortPairs(pairs), agent)).length, 2);
    const neighbors = async id => (await store.getLinkedIds(id, agent)).sort();
    assert.deepEqual(await neighbors(a), [b, e].sort());
    assert.deepEqual(await neighbors(b), [a]);
    assert.deepEqual(await neighbors(c), [d]);
    assert.deepEqual(await neighbors(d), [c]);
    assert.deepEqual(await neighbors(untouched), []);
    assert.equal(await store.isReachable(a, d, agent), false);
    assert.equal(await store.isReachable(a, b, agent), true);
    // A repeated edge and a node occurring in both source and target positions
    // must not introduce duplicates, self-links, or unrelated neighbors.
    await store.createLinks(sortPairs([{ fromId: a, toId: b }, { fromId: b, toId: c }]), agent);
    assert.deepEqual(await neighbors(a), [b, e].sort());
    assert.deepEqual(await neighbors(b), [a, c].sort());
    assert.deepEqual(await neighbors(c), [b, d].sort());
    assert.deepEqual(await neighbors(d), [c]);
    assert.equal(await store.isReachable(a, d, agent), true);
    assert.deepEqual(await store.createLinks([], agent), []);
  } finally {
    try {
      await pool.query("DELETE FROM agent_memory.fragment_links WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[])", [ids]);
      await pool.query("DELETE FROM agent_memory.fragments WHERE id = ANY($1::text[])", [ids]);
    } finally {
      await shutdownPool();
    }
  }
});
