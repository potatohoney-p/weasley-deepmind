import { after, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";

let calls = [];
const query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
mock.module("../../lib/tools/db.js", { namedExports: {
  queryWithAgentVector: async (_agent, sql, params) => query(sql, params),
  getPrimaryPool: () => ({ query }),
  withTransaction: async (_pool, fn) => fn({ query })
} });
const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
const { fetchLinkedFragments } = await import("../../lib/memory/read/LinkedFragmentLoader.js");
const store = new LinkStore();
beforeEach(() => { calls = []; });
after(() => mock.restoreAll());

for (const relation of [null, "caused_by", "resolved_by"]) {
  test(`linked recall filters deleted edges in both directions: ${relation}`, async () => {
    await store.getLinkedFragments(["seed"], relation, "agent-a", ["key-a", "key-b"], { workspace: "workspace-a" });
    const { sql, params } = calls[0];
    const branches = sql.split("UNION ALL");
    assert.equal(branches.length, 2);
    for (const branch of branches) assert.match(branch, /AND l\.deleted_at IS NULL/);
    assert.deepEqual(params, relation ? [["seed"], relation, ["key-a", "key-b"], "agent-a", "workspace-a"] : [["seed"], ["key-a", "key-b"], "agent-a", "workspace-a"]);
  });
}
test("RCA chain keeps the seed and excludes deleted causal evidence", async () => {
  await store.getRCAChain("seed", "agent-a", "key-a", ["key-b"]);
  const { sql, params } = calls[0];
  assert.match(sql.split("UNION ALL")[1], /AND l\.deleted_at IS NULL/);
  assert.match(sql, /f2\.valid_to IS NULL/);
  assert.deepEqual(params, ["seed", "key-a", ["key-b"], "key-a", ["key-b"]]);
});
test("preview filters deleted edges before its per-fragment limit", async () => {
  assert.deepEqual(await fetchLinkedFragments(["seed"]), new Map());
  const { sql, params } = calls[0];
  assert.match(sql, /AND fl\.deleted_at IS NULL[\s\S]*ORDER BY fl\.weight DESC[\s\S]*LIMIT 3/);
  assert.deepEqual(params, [["seed"]]);
});
test("empty recall and preview candidates do not query storage", async () => {
  assert.deepEqual(await store.getLinkedFragments([]), []);
  assert.deepEqual(await fetchLinkedFragments([]), new Map());
  assert.equal(calls.length, 0);
});
