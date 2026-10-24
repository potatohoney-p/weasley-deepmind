import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let updates;
let transactionQueries;
let failInsert;
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({}),
    withTransaction: async (_pool, fn) => fn({ query: async (sql, params) => {
      transactionQueries.push({ sql, params });
      if (sql.includes("INSERT INTO")) {
        if (failInsert) throw new Error("fixture insert failure");
        return { rows: [{ id: "edge-a" }, { id: "edge-b" }] };
      }
      return { rows: [] };
    } }),
    queryWithAgentVector: async (agent, sql, params, mode) => {
      updates.push({ agent, sql, params, mode });
      return { rows: [] };
    }
  }
});
const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
beforeEach(() => { updates = []; transactionQueries = []; failInsert = false; });
const pairs = [{ fromId: "a", toId: "b" }, { fromId: "c", toId: "d", relationType: "caused_by" }];

test("batch adjacency binds zipped pairs in both directions with caller scope", async () => {
  assert.deepEqual(await new LinkStore().createLinks(pairs, "fixture-agent"), ["edge-a", "edge-b"]);
  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.equal(update.agent, "fixture-agent");
    assert.equal(update.mode, "write");
    assert.match(update.sql, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
    assert.match(update.sql, /WHERE pair\.from_id = f\.id/);
    assert.match(update.sql, /SELECT unnest\(f\.linked_to\)/);
  }
  assert.deepEqual(updates[0].params, [["a", "c"], ["b", "d"]]);
  assert.deepEqual(updates[1].params, [["b", "d"], ["a", "c"]]);
  const insert = transactionQueries.find(q => q.sql.includes("INSERT INTO"));
  assert.deepEqual(insert.params, ["a", "b", "related", "c", "d", "caused_by"]);
});

test("empty batch performs no transaction or adjacency writes", async () => {
  assert.deepEqual(await new LinkStore().createLinks([]), []);
  assert.equal(transactionQueries.length, 0);
  assert.equal(updates.length, 0);
});

test("failed edge insert does not update adjacency", async () => {
  failInsert = true;
  await assert.rejects(new LinkStore().createLinks(pairs), /fixture insert failure/);
  assert.equal(updates.length, 0);
});

test("overlapping source and target IDs retain positional correspondence", async () => {
  await new LinkStore().createLinks([{ fromId: "a", toId: "b" }, { fromId: "b", toId: "c" }]);
  assert.deepEqual(updates[0].params, [["a", "b"], ["b", "c"]]);
  assert.deepEqual(updates[1].params, [["b", "c"], ["a", "b"]]);
});
