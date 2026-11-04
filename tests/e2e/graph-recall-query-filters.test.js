/** Production graph SQL and text-RRF composition against migrated PostgreSQL. */
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrimaryPool, shutdownPool } from "../../lib/tools/db.js";
import { fetchGraphNeighbors } from "../../lib/memory/read/GraphNeighborSearch.js";
import { SearchScope } from "../../lib/memory/read/SearchScope.js";

const enabled = Boolean(process.env.DATABASE_URL);
const prefix = `graph-filters-${randomUUID()}`;
const id = name => `${prefix}-${name}`;
let client;
let queryMock;
let sequence = 0;
const matching = { case_id: "case-a", resolution_status: "resolved", phase: "verification", affect: "confidence" };
const fields = [
  ["caseId", "case_id", "case-b"],
  ["resolutionStatus", "resolution_status", "open"],
  ["phase", "phase", "attempt"],
  ["affect", "affect", "frustration"]
];

before(async () => {
  if (!enabled) return;
  const pool = getPrimaryPool();
  client = await pool.connect();
  await client.query("BEGIN");
  queryMock = mock.method(pool, "query", (...args) => client.query(...args));
});
after(async () => {
  queryMock?.mock.restore();
  try { if (client) await client.query("ROLLBACK"); }
  finally {
    client?.release();
    await shutdownPool();
    const { disconnectRedis } = await import("../../lib/redis.js");
    await disconnectRedis();
  }
});
async function fragment(name, metadata = matching) {
  await client.query(
    `INSERT INTO agent_memory.fragments
      (id, content, content_hash, topic, type, agent_id, importance, case_id, resolution_status, phase, affect)
     VALUES ($1, $2, $1, 'graph-query-filters', 'fact', 'default', 0.8, $3, $4, $5, $6)`,
    [id(name), `Memory ${name}`, metadata.case_id, metadata.resolution_status, metadata.phase, metadata.affect]
  );
}
async function link(seed, neighbor, direction, weight) {
  await client.query(
    `INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type, weight)
     VALUES ($1, $2, 'related', $3)`,
    direction === "out" ? [id(seed), id(neighbor), weight] : [id(neighbor), id(seed), weight]
  );
}
async function fixture(direction, overrides) {
  const tag = `${++sequence}-${direction}`;
  const seed = `${tag}-seed`;
  const match = `${tag}-match`;
  await fragment(seed); await fragment(match);
  await link(seed, match, direction, 1);
  // All ten unqualified candidates would consume the normal graph cap.
  for (let i = 0; i < 10; i++) {
    const miss = `${tag}-miss-${i}`;
    await fragment(miss, { ...matching, ...overrides });
    await link(seed, miss, direction, 5);
  }
  return { seed, match };
}
for (const [option, column, wrong] of fields) {
  for (const direction of ["out", "in"]) {
    test(`${option}: matching ${direction} neighbor survives ten stronger mismatches`, { skip: !enabled }, async () => {
      const { seed, match } = await fixture(direction, { [column]: wrong });
      const opts = { [option]: matching[column] };
      const rows = await fetchGraphNeighbors([id(seed)], 10, "default", null, opts);
      assert.deepEqual(rows.map(row => row.id), [id(match)]);
      assert.equal(new SearchScope(opts).applyTo(rows[0]), true);
      for (const key of Object.keys(matching)) assert.equal(rows[0][key], matching[key]);
    });
  }
}
test("all filters intersect; affect arrays match and empty arrays select no graph candidates", { skip: !enabled }, async () => {
  const { seed, match } = await fixture("out", { case_id: "case-b" });
  for (const [, column, wrong] of fields.slice(1)) {
    const name = `intersection-${column}`;
    await fragment(name, { ...matching, [column]: wrong }); await link(seed, name, "in", 10);
  }
  const opts = { caseId: "case-a", resolutionStatus: "resolved", phase: "verification", affect: ["confidence", "satisfaction"] };
  const rows = await fetchGraphNeighbors([id(seed)], 10, "default", null, opts);
  assert.deepEqual(rows.map(row => row.id), [id(match)]);
  assert.deepEqual(await fetchGraphNeighbors([id(seed)], 10, "default", null, { ...opts, affect: [] }), []);
});
test("absent metadata is not a filter match; unfiltered reads retain the original ranked cap", { skip: !enabled }, async () => {
  const { seed, match } = await fixture("in", { case_id: null, resolution_status: null, phase: null, affect: null });
  const unfiltered = await fetchGraphNeighbors([id(seed)], 10);
  assert.equal(unfiltered.length, 10);
  assert.ok(unfiltered.every(row => row.id !== id(match)));
  for (const [option, column] of fields) {
    const rows = await fetchGraphNeighbors([id(seed)], 10, "default", null, { [option]: matching[column] });
    assert.deepEqual(rows.map(row => row.id), [id(match)]);
  }
});
test("production text-RRF retains the matching graph fragment under every query filter", { skip: !enabled }, async () => {
  const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
  const search = new FragmentSearch({}, {});
  const { seed, match } = await fixture("out", { case_id: "case-b", resolution_status: "open", phase: "attempt", affect: "frustration" });
  search._searchL2 = async () => [{ id: id(seed), content: "Seed", importance: 0.8, agent_id: "default", ...matching }];
  search._searchL3 = async () => [];
  for (const opts of [
    ...fields.map(([option, column]) => ({ [option]: matching[column] })),
    { caseId: "case-a", resolutionStatus: "resolved", phase: "verification", affect: ["confidence"] }
  ]) {
    const path = [];
    const latency = {};
    const rows = await search._buildTextRRF({ ...opts, agentId: "default" }, [], [], false, [], "default", null, null, path, latency);
    assert.ok(rows.some(row => row.id === id(match)), `${JSON.stringify(opts)} must retain matching graph memory`);
    assert.equal(rows.length, 2);
    assert.ok(path.includes("L2.5Graph:1"));
    assert.equal(latency.graphUsed, true);
  }
});
