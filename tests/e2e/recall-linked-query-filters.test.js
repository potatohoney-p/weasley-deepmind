import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Real PostgreSQL fixtures and production SQL; direct search is intentionally
// injected so these checks do not need a model, Redis or live search ranking.
describe("linked recall query filters (PostgreSQL)", { skip: !process.env.DATABASE_URL }, () => {
  let pool, client, store, MemoryRecaller, lifecycle;
  const prefix = `linked-filters-${randomUUID()}`;
  const seed = `${prefix}-seed`;
  const filters = { caseId: "case-a", resolutionStatus: "resolved", phase: "verification", affect: "confidence" };

  before(async () => {
    const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
    ({ MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js"));
    lifecycle = await import("../_lifecycle.js");
    store = new LinkStore();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    client = await pool.connect();
  });
  beforeEach(async () => { await client.query("BEGIN"); await addFragment("seed"); });
  afterEach(async () => { if (client) await client.query("ROLLBACK"); });
  after(async () => {
    client?.release(); await pool?.end();
    await lifecycle?.teardownTestResources(); await lifecycle?.assertCleanShutdown();
  });

  async function addFragment(name, overrides = {}) {
    const fields = { case_id: "case-a", resolution_status: "resolved", phase: "verification", affect: "confidence", ...overrides };
    const id = `${prefix}-${name}`;
    await client.query(`INSERT INTO agent_memory.fragments
      (id, content, content_hash, topic, type, agent_id, importance, case_id, resolution_status, phase, affect)
      VALUES ($1, $2, $1, $3, 'fact', 'default', 0.7, $4, $5, $6, $7)`,
    [id, `Synthetic memory ${name}`, prefix, fields.case_id, fields.resolution_status, fields.phase, fields.affect]);
    return id;
  }
  async function addLink(name, overrides = {}, incoming = false) {
    const id = await addFragment(name, overrides);
    await client.query(`INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type)
      VALUES ($1, $2, 'related')`, incoming ? [id, seed] : [seed, id]);
    return id;
  }
  async function readLinked(options = {}) {
    const { sql, params } = store._buildLinkedFragmentsSql({
      fromIds: [seed], safeRelationType: null, keyId: null, ...options
    });
    return (await client.query(sql, params)).rows;
  }

  for (const [option, column, value, mismatch] of [
    ["caseId", "case_id", "case-a", "case-b"],
    ["resolutionStatus", "resolution_status", "resolved", "open"],
    ["phase", "phase", "verification", "debugging"],
    ["affect", "affect", "confidence", "frustration"]
  ]) {
    it(`${option} filters both directions before unrelated rows exhaust the limit`, async () => {
      for (let i = 0; i < 12; i++) await addLink(`a-wrong-${i}`, { [column]: mismatch }, i % 2 === 0);
      await addLink("b-missing", { [column]: null });
      const outgoing = await addLink("z-outgoing");
      const incoming = await addLink("z-incoming", {}, true);
      assert.equal((await readLinked()).length, 10, "unfiltered query retains the existing cap");
      const rows = await readLinked({ [option]: value });
      assert.deepEqual(rows.map(row => row.id).sort(), [outgoing, incoming].sort());
      assert.ok(rows.every(row => row[column] === value), "filter metadata survives projection");
    });
  }

  it("combined filters and affect arrays reach final recall without contaminating its budget", async () => {
    for (let i = 0; i < 12; i++) await addLink(`a-other-case-${i}`, { case_id: "case-b" }, i % 2 === 0);
    await addLink("b-open", { resolution_status: "open" });
    await addLink("b-debugging", { phase: "debugging" });
    await addLink("b-frustration", { affect: "frustration" });
    const confident = await addLink("z-confident");
    const satisfied = await addLink("z-satisfied", { affect: "satisfaction" }, true);
    const direct = (await client.query("SELECT * FROM agent_memory.fragments WHERE id = $1", [seed])).rows[0];
    const recaller = new MemoryRecaller({
      search: { search: async () => ({ fragments: [{ ...direct }], searchPath: "fixture" }) },
      store: { getLinkedFragments: async (_ids, _relation, _agent, _keys, options) => readLinked(options) }
    });
    const result = await recaller.recall({ ...filters, affect: ["confidence", "satisfaction"],
      tokenBudget: 1000, includePeerAgents: true });
    assert.deepEqual(result.fragments.map(row => row.id).sort(), [seed, confident, satisfied].sort());
    assert.equal(result.count, 3);
    assert.ok(result.totalTokens > 0 && result.totalTokens <= 1000);
    assert.ok(result.fragments.every(row => row.case_id === "case-a" && row.resolution_status === "resolved"));
  });

  it("empty affect arrays match no linked rows", async () => {
    await addLink("neighbor");
    assert.deepEqual(await readLinked({ affect: [] }), []);
  });
});
