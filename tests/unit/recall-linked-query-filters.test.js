import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

const queries = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (agentId, sql, params) => {
      queries.push({ agentId, sql, params });
      return { rows: [] };
    },
    getPrimaryPool: () => ({ query: async () => ({ rows: [] }) }),
    getBatchPool: () => null,
    shutdownPool: async () => {},
    getPoolStats: () => ({}),
    withTransaction: async (_pool, fn) => fn({ query: async () => ({ rows: [] }) })
  }
});
const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");
after(async () => { await teardownTestResources(); mock.restoreAll(); await assertCleanShutdown(); });
beforeEach(() => { queries.length = 0; });

const anchorTime = Date.UTC(2026, 10, 1);
const fragment = (id, overrides = {}) => ({
  id, content: `Synthetic memory ${id}`, type: "fact", estimated_tokens: 10,
  importance: 0.7, rerankerScore: 0.7, created_at: new Date(anchorTime).toISOString(),
  agent_id: "agent-a", workspace: "workspace-a", valid_to: null,
  case_id: "case-a", resolution_status: "resolved", phase: "verification", affect: "confidence",
  ...overrides
});
function harness(rows) {
  const linked = mock.fn(async () => structuredClone(rows));
  const search = mock.fn(async () => ({ fragments: [fragment("seed")], searchPath: "fixture" }));
  const recaller = new MemoryRecaller({ store: { getLinkedFragments: linked }, search: { search } });
  return { linked, search, recall: params => recaller.recall({
    agentId: "agent-a", workspace: "workspace-a", _keyId: "key-a", anchorTime, ...params
  }) };
}
const filters = [
  ["caseId", "case_id", "case-a", "case-b"],
  ["resolutionStatus", "resolution_status", "resolved", "open"],
  ["phase", "phase", "verification", "debugging"],
  ["affect", "affect", "confidence", "frustration"]
];
for (const [option, column, value, mismatch] of filters) {
  test(`linked ${option} matches direct-search filtering before rank and budget`, async () => {
    const h = harness([
      fragment("wrong", { [column]: mismatch, rerankerScore: 1 }),
      fragment("missing", { [column]: null, rerankerScore: 1 }),
      fragment("matching")
    ]);
    const result = await h.recall({ [option]: value, tokenBudget: 20 });
    assert.deepEqual(result.fragments.map(f => f.id), ["seed", "matching"]);
    assert.equal(result.totalTokens, 20);
    assert.equal(h.search.mock.calls[0].arguments[0][option], value);
    assert.equal(h.linked.mock.calls[0].arguments[4][option], value);
  });
}

test("all four filters intersect, and array affect accepts either requested value", async () => {
  const h = harness([
    fragment("satisfied", { affect: "satisfaction" }), fragment("confident"),
    ...filters.map(([, column, , mismatch]) => fragment(`wrong-${column}`, { [column]: mismatch }))
  ]);
  const result = await h.recall({ caseId: "case-a", resolutionStatus: "resolved", phase: "verification",
    affect: ["confidence", "satisfaction"] });
  assert.deepEqual(result.fragments.map(f => f.id).sort(), ["confident", "satisfied", "seed"]);
});

test("absent filters retain cross-case and metadata-free linked memories", async () => {
  const h = harness([fragment("other", { case_id: "case-b", phase: null, affect: null })]);
  assert.deepEqual((await h.recall({})).fragments.map(f => f.id), ["seed", "other"]);
  assert.deepEqual(h.linked.mock.calls[0].arguments[4], {
    workspace: "workspace-a", includePeerAgents: false, includeSuperseded: false
  });
});

test("history and peer opt-in do not waive case filters or workspace", async () => {
  const h = harness([
    fragment("old-peer", { agent_id: "peer", valid_to: new Date(anchorTime).toISOString() }),
    fragment("wrong-case", { agent_id: "peer", case_id: "case-b" }),
    fragment("wrong-workspace", { workspace: "workspace-b" })
  ]);
  const result = await h.recall({ caseId: "case-a", includeSuperseded: true, includePeerAgents: true });
  assert.deepEqual(result.fragments.map(f => f.id).sort(), ["old-peer", "seed"]);
});

test("filtered-out links do not consume cursor positions", async () => {
  const h = harness([fragment("wrong", { case_id: "case-b", rerankerScore: 1 }), fragment("right")]);
  const first = await h.recall({ caseId: "case-a", pageSize: 1 });
  const second = await h.recall({ caseId: "case-a", pageSize: 1, cursor: first.nextCursor });
  assert.deepEqual(first.fragments.map(f => f.id), ["seed"]);
  assert.deepEqual(second.fragments.map(f => f.id), ["right"]);
  assert.equal(first.totalCount, 2); assert.equal(second.hasMore, false);
});

test("includeLinks=false avoids linked reads with all filters", async () => {
  const h = harness([fragment("other")]);
  const result = await h.recall({ includeLinks: false, caseId: "case-a", resolutionStatus: "resolved",
    phase: "verification", affect: "confidence" });
  assert.equal(result.count, 1); assert.equal(h.linked.mock.callCount(), 0);
});

for (const relation of [null, "resolved_by"]) {
  test(`LinkStore binds all filters in both directions before LIMIT (${relation})`, async () => {
    const caseId = "case-a' OR true --";
    await new LinkStore().getLinkedFragments(["seed"], relation, "agent-a", ["key-a", "key-b"], {
      workspace: "workspace-a", caseId, resolutionStatus: "resolved", phase: "verification",
      affect: ["confidence", "satisfaction"]
    });
    const { sql, params } = queries.at(-1);
    const expected = [["seed"], ...(relation ? [relation] : []), ["key-a", "key-b"], "agent-a", "workspace-a",
      caseId, "resolved", "verification", ["confidence", "satisfaction"]];
    assert.deepEqual(params, expected);
    assert.ok(!sql.includes(caseId));
    for (const [, column, , ] of filters) {
      const index = params.length - 3 + filters.findIndex(f => f[1] === column);
      const predicate = column === "affect" ? `f.affect = ANY($${index}::text[])` : `f.${column} = $${index}`;
      for (const direction of sql.split("UNION ALL")) assert.ok(direction.includes(predicate), predicate);
      assert.match(sql.split("FROM (")[0], new RegExp(`\\b${column}\\b`));
    }
    assert.match(sql, /LIMIT 10/);
  });
}

test("LinkStore normalizes scalar affect and preserves empty-array no matches", async () => {
  for (const affect of ["confidence", []]) {
    await new LinkStore().getLinkedFragments(["seed"], null, "agent-a", null, { affect });
    const { sql, params } = queries.at(-1);
    assert.deepEqual(params.at(-1), typeof affect === "string" ? [affect] : []);
    assert.equal((sql.match(/f\.affect = ANY\(/g) ?? []).length, 2);
  }
});

test("LinkStore omitted filters retain existing parameter bindings", async () => {
  await new LinkStore().getLinkedFragments(["seed"], null, "agent-a", ["key-a"], { workspace: "workspace-a" });
  assert.deepEqual(queries.at(-1).params, [["seed"], ["key-a"], "agent-a", "workspace-a"]);
  assert.doesNotMatch(queries.at(-1).sql, /AND f\.(case_id|phase|resolution_status|affect) =/);
});
