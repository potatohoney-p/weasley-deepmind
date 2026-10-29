import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let calls;
let query;
mock.module("../../lib/tools/db.js", {
  namedExports: { queryWithAgentVector: (...args) => {
    calls.push(args);
    return query(...args);
  } }
});
mock.module("../../lib/tools/embedding.js", { namedExports: { vectorToSql: x => x } });
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
beforeEach(() => {
  calls = [];
  query = async (_agent, sql) => ({ rows: sql.includes("fragment_versions") ? [{ content: "previous" }] :
    sql.includes("fragment_links") ? [{ to_id: "new" }] :
      sql.includes("valid_to IS NULL") ? [] : [{ id: "old", valid_to: "2026-01-01" }] });
});

test("explicit history loads the superseded source without changing ordinary reads", async () => {
  const reader = new FragmentReader();
  assert.equal(await reader.getById("old", "agent-a", "key-a"), null);
  const history = await reader.getHistory("old", "agent-a", "key-a");
  assert.equal(history.current?.id, "old");
  assert.equal(history.versions[0].content, "previous");
  assert.equal(history.superseded_by_chain[0].to_id, "new");
  const source = calls[1];
  assert.match(source[1], /agent_id = \$2/);
  assert.match(source[1], /key_id IS NOT DISTINCT FROM \$3/);
  assert.deepEqual(source[2], ["old", "agent-a", "key-a", ["key-a"]]);
});

test("missing or inaccessible history source does not query child history", async () => {
  query = async () => ({ rows: [] });
  const result = await new FragmentReader().getHistory("missing", "agent-a", "key-a");
  assert.deepEqual(result, { current: null, versions: [], superseded_by_chain: [] });
  assert.equal(calls.length, 1);
});

test("history successor query applies the same key group and agent scope", async () => {
  query = async () => ({ rows: [{ id: "source" }] });
  await new FragmentReader().getHistory("source", "agent-a", "key-a", ["key-b"]);
  const chain = calls.find(c => c[1].includes("fragment_links"));
  assert.match(chain[1], /f\.agent_id = \$2/);
  assert.match(chain[1], /f\.key_id IS NOT DISTINCT FROM \$3/);
  assert.deepEqual(chain[2], ["source", "agent-a", "key-a", ["key-b"]]);
});

test("peer-agent history widens only agent scope", async () => {
  query = async () => ({ rows: [{ id: "source" }] });
  await new FragmentReader().getHistory("source", "agent-a", "key-a", [], { includePeerAgents: true });
  const chain = calls.find(c => c[1].includes("fragment_links"));
  assert.match(chain[1], /\$2::text IS NOT NULL/);
  assert.match(chain[1], /f\.key_id IS NOT DISTINCT FROM \$3/);
});

for (const value of [undefined, false, "true", 1]) {
  test(`ordinary read stays current-only for includeSuperseded=${String(value)}`, async () => {
    const row = await new FragmentReader().getById("old", "agent-a", null, [], { includeSuperseded: value });
    assert.equal(row, null);
    assert.match(calls[0][1], /valid_to IS NULL/);
  });
}

test("master history omits key filtering but retains agent filtering", async () => {
  query = async () => ({ rows: [{ id: "source" }] });
  await new FragmentReader().getHistory("source", "agent-a");
  const chain = calls.find(c => c[1].includes("fragment_links"));
  assert.match(chain[1], /f\.agent_id = \$2/);
  assert.doesNotMatch(chain[1], /f\.key_id/);
  assert.deepEqual(chain[2], ["source", "agent-a"]);
});
