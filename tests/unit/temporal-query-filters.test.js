import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../../lib/tools/db.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

const queries = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...db,
    queryWithAgentVector: async (agentId, sql, params) => {
      queries.push({ agentId, sql, params });
      return { rows: [] };
    }
  }
});
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
const reader = new FragmentReader();
const from = new Date("2026-01-01T00:00:00Z");
const to = new Date("2026-02-01T00:00:00Z");

for (const [name, value] of [
  ["topic", "release' topic"], ["type", "decision"], ["minImportance", 0.8],
  ["minImportance", 0], ["isAnchor", true], ["isAnchor", false],
  ["affect", "confidence"], ["affect", ["confidence", "satisfaction"]], ["affect", []]
]) {
  test(`temporal pipeline forwards ${name}=${JSON.stringify(value)}`, async () => {
    const search = Object.create(FragmentSearch.prototype);
    let captured;
    search.store = { searchByTimeRange: async (...args) => { captured = args; return []; } };
    await search._searchTemporal({ timeRange: { from, to }, [name]: value });
    assert.equal(captured[0], from);
    assert.equal(captured[1], to);
    assert.deepEqual(captured[2][name], value);
  });
}

for (const [name, value, clause] of [
  ["topic", "release' topic", "topic = $2"], ["type", "decision", "type = $2"],
  ["minImportance", 0.8, "importance >= $2"], ["minImportance", 0, "importance >= $2"],
  ["isAnchor", true, "is_anchor = $2"], ["isAnchor", false, "is_anchor = $2"]
]) {
  test(`temporal SQL binds ${name}=${JSON.stringify(value)} before LIMIT`, async () => {
    await reader.searchByTimeRange(null, null, { [name]: value, limit: 1 });
    const { sql, params } = queries.at(-1);
    assert.ok(sql.includes(clause), clause);
    assert.ok(sql.indexOf(clause) < sql.indexOf("ORDER BY"));
    assert.match(sql, /LIMIT \$3/);
    assert.deepEqual(params, ["default", value, 1]);
    if (name === "topic") assert.ok(!sql.includes(value), "user value remains parameterized");
  });
}

test("empty affect filter returns no temporal candidates without issuing a query", async () => {
  const count = queries.length;
  assert.deepEqual(await reader.searchByTimeRange(from, to, { affect: [] }), []);
  assert.equal(queries.length, count);
});

test("temporal filters compose with existing interval, scope and history predicates", async () => {
  const search = Object.create(FragmentSearch.prototype);
  search.store = reader;
  await search._searchTemporal({
    timeRange: { from, to }, agentId: "agent-a", keyId: ["a", "b"], workspace: "work",
    caseId: "case", resolutionStatus: "resolved", phase: "result", includeSuperseded: true,
    includePeerAgents: true, topic: "release", type: "decision", minImportance: 0.8,
    isAnchor: false, affect: ["confidence", "satisfaction"]
  });
  const { sql, params, agentId } = queries.at(-1);
  assert.equal(agentId, "agent-a");
  for (const [column, value, op] of [
    ["topic", "release", "="], ["type", "decision", "="], ["importance", 0.8, ">="],
    ["is_anchor", false, "="], ["case_id", "case", "="],
    ["resolution_status", "resolved", "="], ["phase", "result", "="]
  ]) assert.ok(sql.includes(`${column} ${op} $${params.indexOf(value) + 1}`), column);
  const affectIndex = params.findIndex(value => Array.isArray(value) && value[0] === "confidence");
  assert.ok(affectIndex >= 0);
  assert.ok(sql.includes(`affect = ANY($${affectIndex + 1})`));
  assert.match(sql, /created_at >= \$2/);
  assert.match(sql, /created_at < \$3/);
  assert.match(sql, /\$1::text IS NOT NULL/);
  assert.doesNotMatch(sql, /valid_to IS NULL/);
  assert.deepEqual(params.slice(0, 5), ["agent-a", from, to, ["a", "b"], "work"]);
  assert.equal(params.at(-1), 30);
});

test("unfiltered temporal requests preserve existing defaults and skip absent ranges", async () => {
  const search = Object.create(FragmentSearch.prototype);
  search.store = reader;
  await search._searchTemporal({ timeRange: { from, to } });
  const { sql, params } = queries.at(-1);
  assert.match(sql, /valid_to IS NULL/);
  assert.deepEqual(params, ["default", from, to, 30]);
  const count = queries.length;
  assert.deepEqual(await search._searchTemporal({}), []);
  assert.equal(queries.length, count);
});

after(async () => {
  mock.restoreAll();
  await teardownTestResources();
  await assertCleanShutdown();
});
