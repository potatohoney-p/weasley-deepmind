import { after, mock, test } from "node:test";
import assert from "node:assert/strict";

let captured;
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({ query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [
        { id: "b", _link_weight: 1, _relation_type: "related" },
        { id: "a", _link_weight: 1, _relation_type: "caused_by" }
      ] };
    } }),
    shutdownPool: async () => {}
  }
});
const { fetchGraphNeighbors } = await import("../../lib/memory/read/GraphNeighborSearch.js");
const { assertCleanShutdown } = await import("../_lifecycle.js");
after(async () => { await assertCleanShutdown(); });

test("distinct-neighbor selection is enclosed before the global weight order and limit", async () => {
  await fetchGraphNeighbors(["seed"], 2, "agent", ["key1", "key2"], { workspace: "workspace" });
  assert.match(captured.sql, /SELECT \* FROM \(\s*SELECT DISTINCT ON \(id\)/);
  assert.match(captured.sql, /ORDER BY id, _link_weight DESC\s*\) neighbors\s*ORDER BY _link_weight DESC, id\s*LIMIT \$3/);
  assert.deepEqual(captured.params, [["seed"], ["seed"], 2, ["key1", "key2"], "agent", "workspace"]);
  assert.equal((captured.sql.match(/f\.valid_to IS NULL/g) || []).length, 2);
  assert.equal((captured.sql.match(/fl\.deleted_at IS NULL/g) || []).length, 2);
});

test("post-selection relation boosts retain their existing scoring semantics", async () => {
  const rows = await fetchGraphNeighbors(["seed"], 2);
  assert.deepEqual(rows.map(row => row.id), ["a", "b"]);
  assert.equal(rows[0]._graphScore, Math.tanh(0.5) * 1.5);
  assert.equal(rows[1]._graphScore, Math.tanh(0.5));
});

test("empty seed or key scopes do not query the database", async () => {
  captured = undefined;
  assert.deepEqual(await fetchGraphNeighbors([], 2), []);
  assert.deepEqual(await fetchGraphNeighbors(["seed"], 2, "agent", []), []);
  assert.equal(captured, undefined);
});
