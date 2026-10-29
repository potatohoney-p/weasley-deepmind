/** Graph neighbor selection must rank distinct candidates before applying its limit. */
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrimaryPool, shutdownPool } from "../../lib/tools/db.js";
import { fetchGraphNeighbors } from "../../lib/memory/read/GraphNeighborSearch.js";

const prefix = `graph-limit-${randomUUID()}`;
const id = name => `${prefix}-${name}`;
let client;
let queryMock;
// DATABASE_URL opts in; getPrimaryPool uses POSTGRES_*/DB_* connection settings, as in CI.
const enabled = Boolean(process.env.DATABASE_URL);

before(async () => {
  if (!enabled) return;
  const pool = getPrimaryPool();
  client = await pool.connect();
  await client.query("BEGIN");
  queryMock = mock.method(pool, "query", (...args) => client.query(...args));
  // All fixtures live in one rollback-only transaction, including production reads.
});

after(async () => {
  queryMock?.mock.restore();
  try { if (client) await client.query("ROLLBACK"); }
  finally { client?.release(); await shutdownPool(); }
});

async function fragment(name, { agent = "default", workspace = null, expired = false } = {}) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, content_hash, topic, type, agent_id, workspace, valid_to)
     VALUES ($1, $2, $1, 'graph-limit-test', 'fact', $3, $4, $5)`,
    [id(name), name, agent, workspace, expired ? "2020-01-01T00:00:00Z" : null]
  );
}

async function link(from, to, weight, relation = "related", deleted = false) {
  await client.query(
    `INSERT INTO agent_memory.fragment_links (from_id, to_id, weight, relation_type, deleted_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id(from), id(to), weight, relation, deleted ? "2020-01-01T00:00:00Z" : null]
  );
}

test("strong outgoing and incoming neighbors survive the limit regardless of ID order", { skip: !enabled }, async () => {
  for (const direction of ["out", "in"]) {
    const seed = `${direction}-seed`;
    const weak = `${direction}-a-weak`;
    const strong = `${direction}-z-strong`;
    for (const name of [seed, weak, strong]) await fragment(name);
    if (direction === "out") {
      await link(seed, weak, 1); await link(seed, strong, 4);
    } else {
      await link(weak, seed, 1); await link(strong, seed, 4);
    }
    const result = await fetchGraphNeighbors([id(seed)], 1);
    assert.deepEqual(result.map(row => row.id), [id(strong)]);
    assert.equal(result[0]._link_weight, 4);
  }
});

test("deduplicate both directions and multiple seeds before selecting the strongest distinct neighbors", { skip: !enabled }, async () => {
  for (const name of ["dedup-seed1", "dedup-seed2", "dedup-a", "dedup-b", "dedup-z"]) await fragment(name);
  await link("dedup-seed1", "dedup-a", 1);
  await link("dedup-seed1", "dedup-z", 4);
  await link("dedup-z", "dedup-seed2", 3);
  await link("dedup-seed2", "dedup-b", 2);
  await link("dedup-seed1", "dedup-seed2", 10);
  const result = await fetchGraphNeighbors([id("dedup-seed1"), id("dedup-seed2")], 2);
  assert.deepEqual(result.map(row => row.id), [id("dedup-z"), id("dedup-b")]);
  assert.equal(result[0]._link_weight, 4);
});

test("scope, expired fragments and deleted links are filtered before the ranked limit", { skip: !enabled }, async () => {
  await fragment("scope-seed");
  await fragment("scope-a-foreign", { agent: "another-agent" });
  await fragment("scope-b-workspace", { workspace: "another-workspace" });
  await fragment("scope-c-expired", { expired: true });
  await fragment("scope-d-deleted");
  await fragment("scope-z-current", { workspace: "requested-workspace" });
  for (const name of ["scope-a-foreign", "scope-b-workspace", "scope-c-expired"]) await link("scope-seed", name, 10);
  await link("scope-seed", "scope-d-deleted", 10, "related", true);
  await link("scope-seed", "scope-z-current", 1);
  const result = await fetchGraphNeighbors([id("scope-seed")], 1, "default", null, { workspace: "requested-workspace" });
  assert.deepEqual(result.map(row => row.id), [id("scope-z-current")]);
});

test("equal-weight selection uses ID order while the existing relation boost still ranks selected rows", { skip: !enabled }, async () => {
  for (const name of ["ties-seed", "ties-a", "ties-b", "ties-c"]) await fragment(name);
  await link("ties-seed", "ties-c", 1);
  await link("ties-seed", "ties-b", 1, "caused_by");
  await link("ties-seed", "ties-a", 1);
  const result = await fetchGraphNeighbors([id("ties-seed")], 2);
  assert.deepEqual(result.map(row => row.id), [id("ties-b"), id("ties-a")]);
  assert.ok(result[0]._graphScore > result[1]._graphScore);
});
