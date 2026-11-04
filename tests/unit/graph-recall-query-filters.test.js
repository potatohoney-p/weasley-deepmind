import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

let captured;
mock.module("../../lib/tools/db.js", { namedExports: {
  getPrimaryPool: () => ({ query: async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  } }),
  shutdownPool: async () => {}
} });
const { fetchGraphNeighbors } = await import("../../lib/memory/read/GraphNeighborSearch.js");
const { assertCleanShutdown } = await import("../_lifecycle.js");
beforeEach(() => { captured = undefined; });
after(async () => { mock.restoreAll(); await assertCleanShutdown(); });

const filterCases = [
  ["caseId", "case_id", "case-a"],
  ["resolutionStatus", "resolution_status", "resolved"],
  ["phase", "phase", "verification"],
  ["affect", "affect", "confidence"],
  ["affect", "affect", ["confidence", "satisfaction"]],
  ["affect", "affect", []]
];
for (const [option, column, value] of filterCases) {
  test(`bind ${option}=${JSON.stringify(value)} before limiting both graph directions`, async () => {
    await fetchGraphNeighbors(["seed"], 10, "agent-a", ["key-a", "key-b"], {
      workspace: "workspace-a", [option]: value
    });
    const predicate = option === "affect" ? `AND f.${column} = ANY($7::text[])` : `AND f.${column} = $7`;
    for (const arm of captured.sql.split("UNION ALL")) assert.ok(arm.includes(predicate));
    assert.deepEqual(captured.params, [["seed"], ["seed"], 10, ["key-a", "key-b"], "agent-a", "workspace-a",
      option === "affect" && !Array.isArray(value) ? [value] : value]);
  });
}
test("all scope metadata is projected through both directions and distinct selection", async () => {
  await fetchGraphNeighbors(["seed"]);
  const outer = captured.sql.split("FROM (")[1];
  for (const column of ["case_id", "resolution_status", "phase", "affect"]) {
    assert.match(outer, new RegExp(`\\b${column}\\b`));
    for (const arm of captured.sql.split("UNION ALL")) {
      assert.ok(arm.split("WHERE")[0].includes(`f.${column}`));
    }
  }
});
test("combined filters preserve parameter positions when optional agent/key/workspace predicates are absent", async () => {
  await fetchGraphNeighbors(["seed"], 2, "agent-a", null, {
    includePeerAgents: true, caseId: "case-a", resolutionStatus: "resolved", phase: "verification", affect: "confidence"
  });
  assert.deepEqual(captured.params, [["seed"], ["seed"], 2, "case-a", "resolved", "verification", ["confidence"]]);
  for (const arm of captured.sql.split("UNION ALL")) {
    assert.ok(arm.includes("AND f.case_id = $4"));
    assert.ok(arm.includes("AND f.resolution_status = $5"));
    assert.ok(arm.includes("AND f.phase = $6"));
    assert.ok(arm.includes("AND f.affect = ANY($7::text[])"));
  }
});
test("unfiltered graph bindings and current active-edge/fragment gates remain unchanged", async () => {
  await fetchGraphNeighbors(["seed"], 3, "agent-a", "key-a", { workspace: "workspace-a" });
  assert.deepEqual(captured.params, [["seed"], ["seed"], 3, ["key-a"], "agent-a", "workspace-a"]);
  assert.equal((captured.sql.match(/fl\.deleted_at IS NULL/g) || []).length, 2);
  assert.equal((captured.sql.match(/f\.valid_to IS NULL/g) || []).length, 2);
  assert.match(captured.sql, /ORDER BY _link_weight DESC, id\s+LIMIT \$3/);
});
