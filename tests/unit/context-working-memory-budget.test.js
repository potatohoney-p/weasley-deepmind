import { after, test } from "node:test";
import assert from "node:assert/strict";
import { ContextBuilder } from "../../lib/memory/read/ContextBuilder.js";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

const fragment = (id, content = `current ${id}`, extra = {}) => ({
  id, content, type: "fact", importance: 0.5, agent_id: "default", valid_to: null,
  workspace: null, ...extra
});
function harness(cached, rows = [], readError = null) {
  const calls = [];
  const seen = [];
  const builder = new ContextBuilder({
    recall: async () => ({ fragments: [] }),
    index: { getWorkingMemory: async () => cached, setSeenIds: async (...args) => seen.push(args) },
    store: {
      searchBySource: async () => [],
      getByIds: async (...args) => {
        calls.push(args);
        if (readError) throw readError;
        return rows.filter(row => args[0].includes(row.id));
      }
    },
    getPool: () => null
  });
  return { builder, calls, seen };
}
const build = (h, params = {}) => h.builder.build({ sessionId: "session", ...params });

for (const structured of [false, true]) {
  test(`oversized newest memory does not starve older fitting memories (structured=${structured})`, async () => {
    const rows = [fragment("older", "useful durable memory"), fragment("large", "x".repeat(3201))];
    const h = harness(rows, rows);
    const result = await build(h, { structured });
    const items = structured ? result.working.current_session : result.fragments;
    assert.deepEqual(items.map(f => f.id), ["older"]);
    assert.deepEqual(h.seen, [["session", ["older"]]]);
  });
}

test("skip a candidate exceeding the remaining budget without truncation or order loss", async () => {
  const rows = [fragment("last", "c".repeat(100)), fragment("overflow", "b".repeat(2100)), fragment("first", "a".repeat(1200))];
  const h = harness(rows, rows);
  const result = await build(h, { tokenBudget: 10000 });
  assert.deepEqual(result.fragments.map(f => f.id), ["first", "last"]);
  assert.deepEqual(result.fragments.map(f => f.content.length), [1200, 100]);
});

test("exact remaining allowance fits after a skipped candidate without exceeding the cap", async () => {
  const rows = [fragment("too-late", "z"), fragment("exact-fit", "c".repeat(2000)),
    fragment("overflow", "b".repeat(2100)), fragment("first", "a".repeat(1200))];
  const h = harness(rows, rows);
  const result = await build(h, { tokenBudget: 10000 });
  assert.deepEqual(result.fragments.map(f => f.id), ["first", "exact-fit"]);
  assert.equal(result.fragments.reduce((total, f) => total + f.content.length, 0), 3200);
});

test("oversized candidates cannot hide eligible memories in a later hydration batch", async () => {
  const rows = [fragment("older", "useful"), ...Array.from({ length: 30 }, (_, i) => fragment(`large-${i}`, "x".repeat(3201)))];
  const h = harness(rows, rows);
  assert.deepEqual((await build(h)).fragments.map(f => f.id), ["older"]);
  assert.deepEqual(h.calls.map(call => call[0].length), [30, 1]);
});

test("skipping oversized candidates preserves the ten-result cap and newest-first order", async () => {
  const small = Array.from({ length: 12 }, (_, i) => fragment(`small-${i}`, "ok"));
  const rows = [...small, fragment("oversized", "x".repeat(3201))];
  const h = harness(rows, rows);
  assert.deepEqual((await build(h)).fragments.map(f => f.id), small.slice(2).reverse().map(f => f.id));
});

test("all oversized candidates return empty context without marking them seen", async () => {
  const rows = [fragment("a", "x".repeat(3201)), fragment("b", "y".repeat(3201))];
  const h = harness(rows, rows);
  assert.equal((await build(h)).wmCount, 0);
  assert.deepEqual(h.seen, [["session", []]]);
});

test("a later hydration failure still rejects rather than returning a partial context", async () => {
  const rows = [fragment("older"), ...Array.from({ length: 30 }, (_, i) => fragment(`large-${i}`, "x".repeat(3201)))];
  let calls = 0;
  const seen = [];
  const builder = new ContextBuilder({
    recall: async () => ({ fragments: [] }),
    index: { getWorkingMemory: async () => rows, setSeenIds: async (...args) => seen.push(args) },
    store: { searchBySource: async () => [], getByIds: async ids => {
      if (++calls === 2) throw new Error("durable read failed");
      return rows.filter(row => ids.includes(row.id));
    } },
    getPool: () => null
  });
  await assert.rejects(builder.build({ sessionId: "session" }), /durable read failed/);
  assert.deepEqual(seen, []);
});

after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
