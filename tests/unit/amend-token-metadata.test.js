import { after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { FragmentWriter } from "../../lib/memory/write/FragmentWriter.js";
import { countTokens } from "../../lib/memory/write/FragmentFactory.js";
import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";
import { getPrimaryPool } from "../../lib/tools/db.js";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

after(async () => { mock.restoreAll(); await teardownTestResources(); await assertCleanShutdown(); });

// Execute the actual transaction and bound UPDATE fields against an isolated row.
// This is a SQL-contract fixture, not a PostgreSQL substitute; the DB E2E covers SQL.
async function amend(content, updates, { duplicate = false, fail = false } = {}) {
  const original = { id: "memory", content, estimated_tokens: countTokens(content),
    topic: "tokens", keywords: [], type: "fact", importance: 0.5, key_id: null };
  let row = { ...original };
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push(sql);
      if (sql.includes("SELECT * FROM") && sql.includes("FOR UPDATE")) return { rows: [{ ...row }] };
      if (sql.includes("SELECT id FROM")) return { rows: duplicate ? [{ id: "other" }] : [] };
      if (sql === "ROLLBACK") row = { ...original };
      if (sql.startsWith("UPDATE")) {
        if (fail) throw new Error("fixture write failure");
        const set = sql.split("SET ")[1].split("WHERE")[0];
        for (const [, name, index] of set.matchAll(/(\w+) = \$(\d+)/g)) row[name] = params[Number(index) - 1];
        const returned = {};
        for (const name of sql.split("RETURNING ")[1].split(",").map(s => s.trim())) returned[name] = row[name];
        return { rows: [returned] };
      }
      return { rows: [] };
    },
    release: mock.fn()
  };
  const stub = mock.method(getPrimaryPool(), "connect", async () => client);
  try {
    const result = await new FragmentWriter().update(original.id, updates, "default", null, original);
    return { row, result, calls, client };
  } catch (error) {
    error.fixture = { row, calls, client };
    throw error;
  } finally { stub.mock.restore(); }
}

for (const [name, oldText, newText] of [
  ["growth", "Brief.", "Store the updated deployment recovery procedure. ".repeat(12)],
  ["shrinkage", "An obsolete lengthy explanation. ".repeat(12), "Brief."],
  ["Korean", "Short English.", "변경된 기억의 토큰 수는 저장된 내용과 일치해야 합니다."],
  ["mixed Unicode", "Old.", "中文记忆 日本語の記憶 🚀 deployment"],
  ["empty content at storage boundary", "Old.", ""]
]) {
  test(`amend persists and returns the new token estimate: ${name}`, async () => {
    const { row, result, calls, client } = await amend(oldText, { content: newText });
    assert.equal(row.estimated_tokens, countTokens(newText));
    assert.equal(result.estimated_tokens, row.estimated_tokens);
    assert.ok(calls.includes("COMMIT"));
    assert.equal(client.release.mock.calls.length, 1);
  });
}

test("durable amended rows obey recall's existing budget in both directions", async () => {
  const long = "A longer recovery procedure requires additional content tokens. ".repeat(10);
  const short = "Brief.";
  const search = Object.create(FragmentSearch.prototype);
  const grown = await amend(short, { content: long });
  assert.deepEqual(search._trimToTokenBudget([grown.row], countTokens(short)), []);
  const shrunk = await amend(long, { content: short });
  assert.deepEqual(search._trimToTokenBudget([shrunk.row], countTokens(short)).map(f => f.id), ["memory"]);
});

test("metadata-only amendments retain and return the existing token estimate", async () => {
  const { row, result } = await amend("Original content.", { topic: "changed" });
  assert.equal(row.estimated_tokens, countTokens("Original content."));
  assert.equal(result.estimated_tokens, row.estimated_tokens);
});

test("duplicate merge leaves original token metadata untouched", async () => {
  const { row, result, calls } = await amend("Original.", { content: "Duplicate content with more tokens." }, { duplicate: true });
  assert.deepEqual(result, { merged: true, existingId: "other" });
  assert.equal(row.estimated_tokens, countTokens("Original."));
  assert.ok(calls.includes("ROLLBACK"));
});

test("write failures retain the existing rollback contract", async () => {
  await assert.rejects(amend("Original.", { content: "Changed content." }, { fail: true }), error => {
    assert.match(error.message, /fixture write failure/);
    const { row, calls, client } = error.fixture;
    assert.ok(calls.includes("ROLLBACK"));
    assert.ok(!calls.includes("COMMIT"));
    assert.equal(client.release.mock.calls.length, 1);
    assert.equal(row.content, "Original.");
    assert.equal(row.estimated_tokens, countTokens("Original."));
    return true;
  });
});
