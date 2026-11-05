/** Run production temporal queries against a fully migrated PostgreSQL database. */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrimaryPool } from "../../lib/tools/db.js";
import { FragmentReader } from "../../lib/memory/read/FragmentReader.js";
import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";
import { MemoryRecaller } from "../../lib/memory/processors/MemoryRecaller.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

const prefix = `temporal-filter-${randomUUID()}`;
const from = new Date("2026-01-01T00:00:00Z");
const to = new Date("2026-02-01T00:00:00Z");
const reader = new FragmentReader();

describe("temporal query filters (PostgreSQL)", { skip: !process.env.DATABASE_URL }, () => {
  let pool, caseId;
  before(async () => {
    pool = getPrimaryPool();
    // A configured but unavailable/unmigrated database is a failure, not a skip.
    await pool.query("SELECT affect FROM agent_memory.fragments LIMIT 0");
  });
  beforeEach(() => { caseId = `${prefix}-${randomUUID()}`; });
  afterEach(async () => {
    if (pool) await pool.query("DELETE FROM agent_memory.fragments WHERE case_id = $1", [caseId]);
  });

  async function add(name, changes = {}, count = 1) {
    const row = {
      topic: "release", type: "decision", importance: 0.8, isAnchor: true,
      affect: "confidence", createdAt: "2026-01-02T00:00:00Z", expired: false,
      workspace: prefix, agentId: "default", phase: "result", resolutionStatus: "resolved",
      ...changes
    };
    const { rows } = await pool.query(
      `INSERT INTO agent_memory.fragments
         (id, content, content_hash, topic, type, importance, is_anchor, affect,
          created_at, valid_to, case_id, workspace, agent_id, phase, resolution_status)
       SELECT $1 || '-' || n, $1 || ' memory ' || n, $1 || '-' || n,
              $2, $3, $4, $5, $6, $7::timestamptz,
              CASE WHEN $8::boolean THEN '2026-01-15'::timestamptz ELSE NULL END,
              $9, $10, $11, $12, $13
         FROM generate_series(1, $14::integer) n
       RETURNING id`,
      [`${caseId}-${name}`, row.topic, row.type, row.importance, row.isAnchor,
        row.affect, row.createdAt, row.expired, caseId, row.workspace, row.agentId,
        row.phase, row.resolutionStatus, count]
    );
    return rows.map(row => row.id);
  }

  function query(filters = {}) {
    return { timeRange: { from, to }, caseId, workspace: prefix, agentId: "default", ...filters };
  }
  function searcher() {
    const search = Object.create(FragmentSearch.prototype);
    search.store = reader;
    return search;
  }
  async function temporal(filters = {}) {
    return searcher()._searchTemporal(query(filters));
  }

  for (const [label, filter, mismatch] of [
    ["topic", { topic: "release" }, { topic: "unrelated" }],
    ["type", { type: "decision" }, { type: "fact" }],
    ["minimum importance", { minImportance: 0.8 }, { importance: 0.79 }],
    ["anchor true", { isAnchor: true }, { isAnchor: false }],
    ["scalar affect", { affect: "confidence" }, { affect: "frustration" }],
    ["array affect", { affect: ["confidence", "satisfaction"] }, { affect: "frustration" }]
  ]) {
    it(`${label}: thirty-two newer mismatches cannot displace the older matching memory`, async () => {
      const expected = await add("matching");
      await add("newer-mismatch", { createdAt: "2026-01-03T00:00:00Z", ...mismatch }, 32);
      assert.deepEqual((await temporal(filter)).map(row => row.id), expected);
    });
  }

  it("anchor false is a real filter rather than an omitted value", async () => {
    const expected = await add("non-anchor", { isAnchor: false });
    await add("anchor", { createdAt: "2026-01-03T00:00:00Z" }, 32);
    assert.deepEqual((await temporal({ isAnchor: false })).map(row => row.id), expected);
  });

  it("empty allowed-affect sets match no memories", async () => {
    await add("candidate");
    assert.deepEqual(await temporal({ affect: [] }), []);
  });

  it("intersects ordinary and narrative filters without admitting absent metadata", async () => {
    const expected = await add("matching");
    for (const change of [
      { topic: "other" }, { type: "fact" }, { importance: 0.79 }, { isAnchor: false },
      { affect: null }, { phase: "planning" }, { resolutionStatus: "open" },
      { phase: null }
    ]) await add(`mismatch-${randomUUID()}`, change);
    const rows = await temporal({ topic: "release", type: "decision", minImportance: 0.8,
      isAnchor: true, affect: ["confidence"], phase: "result", resolutionStatus: "resolved" });
    assert.deepEqual(rows.map(row => row.id), expected);
  });

  it("preserves half-open dates, explicit history and workspace/default-agent behavior", async () => {
    const current = await add("lower-bound", { createdAt: from.toISOString() });
    const global = await add("global", { workspace: null });
    const old = await add("expired", { expired: true });
    await add("upper-bound", { createdAt: to.toISOString() });
    await add("before-range", { createdAt: "2025-12-31T23:59:59Z" });
    await add("other-workspace", { workspace: "other" });
    const peer = await add("peer", { agentId: "peer-agent" });
    const filters = { topic: "release", type: "decision", minImportance: 0.8, isAnchor: true, affect: "confidence" };
    assert.deepEqual((await temporal(filters)).map(row => row.id).sort(), [...current, ...global].sort());
    const history = await temporal({ ...filters, includeSuperseded: true });
    assert.deepEqual(history.map(row => row.id).sort(), [...current, ...global, ...old].sort());
    assert.ok(history.find(row => row.id === old[0]).valid_to);
    assert.deepEqual((await temporal({ ...filters, includeSuperseded: true, includePeerAgents: true })).map(row => row.id).sort(),
      [...current, ...global, ...old, ...peer].sort());
  });

  for (const mode of ["fallback", "text RRF"]) {
    it(`${mode}: temporal candidates retain query filters through final recall budgeting`, async () => {
      const expected = await add("matching");
      await add("newer-mismatch", { topic: "other", createdAt: "2026-01-03T00:00:00Z" }, 32);
      const search = searcher();
      // Isolate the temporal contribution. The production merging and final recall
      // methods still run; provider/Redis candidate generation is not exercised.
      search._searchL2 = async () => [];
      search._searchL3 = async () => [];
      const sq = query({ topic: "release", keywords: [], tokenBudget: 1000 });
      const path = [], latency = {};
      const combined = mode === "fallback"
        ? await search._buildFallbackCombined(sq, [], [], sq.agentId, null, sq.timeRange, path, latency)
        : await search._buildTextRRF(sq, [], [], false, [], sq.agentId, null, sq.timeRange, path, latency);
      const recaller = new MemoryRecaller({
        search: { search: async () => ({ fragments: combined, searchPath: path.join(" → ") }) }
      });
      const result = await recaller.recall({ ...sq, includeLinks: false, excludeSeen: false, pageSize: 50 });
      assert.deepEqual(result.fragments.map(row => row.id), expected);
      assert.equal(result.count, 1);
      assert.ok(result.totalTokens > 0 && result.totalTokens <= 1000);
      assert.ok(path.includes("Temporal:1"));
    });
  }

  it("unfiltered calls preserve the temporal candidate cap", async () => {
    await add("candidate", {}, 32);
    assert.equal((await temporal()).length, 30);
  });
});

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});
