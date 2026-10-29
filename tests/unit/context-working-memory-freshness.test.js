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

test("amended durable content replaces a cached working-memory snapshot", async () => {
  const h = harness([fragment("a", "obsolete cached content")], [fragment("a", "corrected content")]);
  const result = await build(h);
  assert.deepEqual(result.fragments.map(f => f.content), ["corrected content"]);
  assert.ok(!result.injectionText.includes("obsolete"));
});

test("deleted and superseded IDs cannot be reintroduced by working memory", async () => {
  const h = harness([fragment("deleted"), fragment("expired")], []);
  const result = await build(h);
  assert.equal(result.wmCount, 0);
  assert.deepEqual(h.seen, [["session", []]]);
});

test("current validity and anchor flags override stale cached flags", async () => {
  const h = harness([fragment("expired"), fragment("anchor"), fragment("live", "old", { is_anchor: true })], [
    fragment("expired", "bad", { valid_to: "2020-01-01" }),
    fragment("anchor", "anchor", { is_anchor: true }), fragment("live")
  ]);
  assert.deepEqual((await build(h)).fragments.map(f => f.id), ["live"]);
});

test("reader receives normalized agent, key and group scope", async () => {
  const h = harness([fragment("a")], []);
  await build(h, { agentId: "worker", _keyId: "key-a", _groupKeyIds: ["key-a", "key-b"] });
  assert.deepEqual(h.calls, [[["a"], "worker", "key-a", ["key-a", "key-b"]]]);
});

test("default key scope is normalized and explicit empty groups reach the existing reader policy", async () => {
  const h = harness([fragment("a")]);
  await build(h, { _keyId: "key-a" });
  assert.deepEqual(h.calls[0].slice(1), ["default", "key-a", ["key-a"]]);
  const empty = harness([fragment("a")]);
  await build(empty, { _keyId: "key-a", _groupKeyIds: [] });
  assert.deepEqual(empty.calls[0].slice(1), ["default", "key-a", []]);
});

test("current workspace and agent scope exclude moved working memories", async () => {
  const h = harness([fragment("other"), fragment("peer"), fragment("global"), fragment("local")], [
    fragment("other", "other", { workspace: "elsewhere" }),
    fragment("peer", "peer", { agent_id: "other-agent" }),
    fragment("global"), fragment("local", "local", { workspace: "work", agent_id: "worker" })
  ]);
  assert.deepEqual((await build(h, { agentId: "worker", _defaultWorkspace: "work" })).fragments.map(f => f.id), ["local", "global"]);
});

test("durable order cannot override newest cached-ID order; duplicates hydrate once", async () => {
  const cached = [fragment("a"), fragment("b"), fragment("a")];
  const h = harness(cached, [fragment("b"), fragment("a")]);
  assert.deepEqual((await build(h)).fragments.map(f => f.id), ["a", "b"]);
  assert.deepEqual(h.calls[0][0], ["a", "b"]);
  assert.deepEqual(cached.map(f => f.id), ["a", "b", "a"]);
});

test("ID-less cached payloads are never treated as durable memories", async () => {
  const h = harness([fragment(undefined, "unverified"), fragment("", "unverified")]);
  assert.equal((await build(h)).wmCount, 0);
  assert.equal(h.calls.length, 0);
});

test("read failure rejects context and does not mark stale payloads seen", async () => {
  const error = new Error("durable read unavailable");
  const h = harness([fragment("a")], [], error);
  await assert.rejects(build(h), error);
  assert.equal(h.seen.length, 0);
});

test("working-memory character budget uses current content, not short stale content", async () => {
  const h = harness([fragment("a", "short")], [fragment("a", "x".repeat(3201))]);
  assert.equal((await build(h)).wmCount, 0);
});

test("bounded hydration batches continue past missing IDs to older live candidates", async () => {
  const cached = Array.from({ length: 70 }, (_, i) => fragment(`id-${i}`));
  const rows = cached.slice(0, 2).map(f => fragment(f.id, "durable"));
  const h = harness(cached, rows);
  assert.deepEqual((await build(h)).fragments.map(f => f.id), ["id-1", "id-0"]);
  assert.deepEqual(h.calls.map(c => c[0].length), [30, 30, 10]);
});

test("structured context uses only the rehydrated working rows", async () => {
  const h = harness([fragment("a", "old")], [fragment("a", "current")]);
  const result = await build(h, { structured: true });
  assert.deepEqual(result.working.current_session.map(f => f.content), ["current"]);
  assert.ok(result.rankedInjection.items.every(f => f.content !== "old"));
});

test("empty session memory and absent session require no durable lookup", async () => {
  const h = harness([]);
  assert.equal((await build(h)).wmCount, 0);
  await h.builder.build({});
  assert.equal(h.calls.length, 0);
});

after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
