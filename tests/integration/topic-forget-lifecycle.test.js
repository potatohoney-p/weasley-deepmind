/**
 * SQL-backed lifecycle acceptance: production remember/forget -> fresh recall.
 * Opt in with DATABASE_URL or POSTGRES_HOST/DB_HOST for a migrated test DB.
 * Configured but unavailable databases fail; an unconfigured suite skips.
 *
 * Real: MemoryRememberer, Factory, Writer, Reader, LinkStore, FragmentSearch and
 * MemoryRecaller. No HTTP, provider, Redis, RLS-role or concurrency claims.
 * Quota, automatic/model processing and recall reinforcement are no-op boundaries.
 * A tiny cache stand-in observes deindex mutations; fresh recall reads real SQL.
 * Every write and cleanup is restricted to unique synthetic keys/fragment IDs.
 */
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const configured = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST || process.env.DB_HOST);
const runId = randomUUID();
const keyIds = [randomUUID(), randomUUID()];
const agentId = `forget-${runId}`;
const ownedIds = [];
const ownedSearchEventIds = [];
const cache = new Map();
const deindexed = [];
let pool, modules;

const topicFor = name => `forget-${runId}-${name}`;
const context = { _keyId: keyIds[0], agentId };

function emptyIndex() {
  return {
    index: async fragment => { cache.set(fragment.id, fragment); },
    deindex: async id => { deindexed.push(id); cache.delete(id); },
    searchByKeywords: async () => [], searchByTopic: async () => [],
    searchByType: async () => [], getRecent: async () => [],
    getCachedFragment: async () => null, cacheFragment: async () => {}
  };
}

function freshRememberer() {
  const store = new modules.FragmentStore();
  const conflictResolver = new modules.ConflictResolver(store, null);
  conflictResolver.autoLinkOnRemember = async () => {};
  return new modules.MemoryRememberer({
    store, factory: new modules.FragmentFactory(),
    index: emptyIndex(), quotaChecker: { check: async () => {} },
    postProcessor: { run: async () => {} },
    conflictResolver,
    policyGatingEnabled: false
  });
}

async function remember(topic, label, overrides = {}) {
  const result = await freshRememberer().remember({
    ...context, topic, content: `Orion rollback instruction ${label}: restore the verified release before enabling traffic.`,
    keywords: ["orion", "rollback"], type: "procedure", importance: 0.5,
    skipConflictDetection: true, ...overrides
  });
  assert.ok(result.id);
  ownedIds.push(result.id);
  return result.id;
}

async function recall(topic, overrides = {}) {
  const store = new modules.FragmentStore();
  store.incrementAccess = async () => {};
  store.touchLinked = async () => {};
  const search = new modules.FragmentSearch();
  search.store = store;
  search.index = emptyIndex();
  const recaller = new modules.MemoryRecaller({ store, search });
  const result = await recaller.recall({ ...context, topic, keywords: ["rollback"], tokenBudget: 128, includeLinks: false, ...overrides });
  if (result._searchEventId != null) ownedSearchEventIds.push(result._searchEventId);
  return result;
}

async function forget(topic, overrides = {}) {
  return freshRememberer().forget({ ...context, topic, ...overrides });
}

async function snapshot(ids) {
  const fragments = await pool.query("SELECT * FROM agent_memory.fragments WHERE id = ANY($1) ORDER BY id", [ids]);
  const versions = await pool.query("SELECT * FROM agent_memory.fragment_versions WHERE fragment_id = ANY($1) ORDER BY id", [ids]);
  const links = await pool.query("SELECT * FROM agent_memory.fragment_links WHERE from_id = ANY($1) OR to_id = ANY($1) ORDER BY id", [ids]);
  return { fragments: fragments.rows, versions: versions.rows, links: links.rows };
}

async function archive(id) {
  const store = new modules.FragmentStore();
  const fragment = await store.getById(id, agentId, keyIds[0]);
  assert.ok(fragment);
  await store.archiveVersion(fragment, agentId);
  const saved = await pool.query("SELECT fragment_id FROM agent_memory.fragment_versions WHERE fragment_id = $1", [id]);
  assert.equal(saved.rows.length, 1, "production archiveVersion must persist the fixture history");
}

describe("topic forget lifecycle", { skip: !configured }, () => {
  before(async () => {
    process.env.DOTENV_CONFIG_PATH = ".env.test";
    process.env.EMBEDDING_ENABLED = "false";
    process.env.REDIS_ENABLED = "false";
    process.env.CACHE_ENABLED = "false";
    process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT = "off";
    process.env.WEASLEY_DEEPMIND_REMEMBER_ATOMIC = "false";
    process.env.ENABLE_SPREADING_ACTIVATION = "false";
    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      process.env.POSTGRES_HOST = url.hostname;
      process.env.POSTGRES_PORT = url.port || "5432";
      process.env.POSTGRES_DB = decodeURIComponent(url.pathname.slice(1));
      process.env.POSTGRES_USER = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password);
    }
    const [store, factory, search, writer, reader, db, adaptor, lifecycle, resolver] = await Promise.all([
      import("../../lib/memory/write/FragmentStore.js"),
      import("../../lib/memory/write/FragmentFactory.js"),
      import("../../lib/memory/read/FragmentSearch.js"),
      import("../../lib/memory/processors/MemoryRememberer.js"),
      import("../../lib/memory/processors/MemoryRecaller.js"),
      import("../../lib/tools/db.js"),
      import("../../lib/memory/signals/SearchParamAdaptor.js"),
      import("../_lifecycle.js"),
      import("../../lib/memory/write/ConflictResolver.js")
    ]);
    modules = { ...store, ...factory, ...search, ...writer, ...reader, ...lifecycle, ...resolver };
    pool = db.getPrimaryPool();
    await pool.query("SELECT id FROM agent_memory.fragments LIMIT 0");
    mock.method(adaptor.getSearchParamAdaptor(), "getMinSimilarity", async () => null);
    mock.method(adaptor.getSearchParamAdaptor(), "recordOutcome", async () => {});
    for (const id of keyIds) {
      await pool.query("INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4)",
        [id, `forget-test-${id}`, `synthetic-${id}`, "synthetic"]);
    }
  });

  after(async () => {
    try {
      if (pool) {
        await pool.query("DELETE FROM agent_memory.search_events WHERE key_id = ANY($1) OR id = ANY($2)", [keyIds, ownedSearchEventIds]);
        await pool.query("DELETE FROM agent_memory.fragment_links WHERE from_id = ANY($1) OR to_id = ANY($1)", [ownedIds]);
        await pool.query("DELETE FROM agent_memory.fragment_versions WHERE fragment_id = ANY($1)", [ownedIds]);
        await pool.query("DELETE FROM agent_memory.fragments WHERE id = ANY($1) AND (key_id = ANY($2) OR key_id IS NULL)", [ownedIds, keyIds]);
        await pool.query("DELETE FROM agent_memory.api_keys WHERE id = ANY($1)", [keyIds]);
      }
    } finally {
      mock.restoreAll();
      await modules?.teardownTestResources();
      await modules?.assertCleanShutdown();
    }
  });

  it("forgets all 205 ordinary topic memories once, leaving no stale current recall", async () => {
    const topic = topicFor("complete");
    const ids = [];
    for (let n = 0; n < 205; n++) ids.push(await remember(topic, `deployment-${n}`));
    const beforeRecall = await recall(topic);
    assert.ok(beforeRecall.fragments.length > 0, "tight budget must still admit stored instructions");
    const result = await forget(topic);
    const afterRecall = await recall(topic);
    assert.deepEqual(afterRecall.fragments, [], "one supported forget operation must remove every current answer, including beyond the old 200-row cap");
    assert.deepEqual(result, { deleted: 205, protected: 0 });
    assert.equal((await snapshot(ids)).fragments.length, 0);
    assert.ok(ids.every(id => !cache.has(id)), "all deleted memories must be deindexed");
  });

  it("preserves permanent memories, their history and unrelated links by default", async () => {
    const topic = topicFor("protected");
    const ordinary = await remember(topic, "ordinary");
    const permanent = await remember(topic, "permanent", { type: "preference" });
    const neighbor = await remember(topicFor("protected-neighbor"), "neighbor");
    await archive(permanent);
    await new modules.FragmentStore().createLink(permanent, neighbor, "related", agentId);
    const protectedBefore = await snapshot([permanent, neighbor]);
    const result = await forget(topic);
    assert.deepEqual(await snapshot([permanent, neighbor]), protectedBefore, "protected fragment, history and links must survive unchanged");
    assert.deepEqual(result, { deleted: 1, protected: 1 });
    assert.deepEqual((await recall(topic)).fragments.map(f => f.id), [permanent]);
    assert.ok(cache.has(permanent));
    assert.ok(!cache.has(ordinary));
  });

  it("force removes permanent and ordinary memories, including dependent history and links", async () => {
    const topic = topicFor("force");
    const ordinary = await remember(topic, "forced-ordinary");
    const permanent = await remember(topic, "forced-permanent", { type: "preference" });
    await archive(permanent);
    await new modules.FragmentStore().createLink(ordinary, permanent, "related", agentId);
    assert.deepEqual(await forget(topic, { force: true }), { deleted: 2, protected: 0 });
    assert.deepEqual(await snapshot([ordinary, permanent]), { fragments: [], versions: [], links: [] });
    assert.deepEqual((await recall(topic)).fragments, []);
  });

  it("topic dry-run previews deletion impact without changing SQL rows, history, links or cache", async () => {
    const topic = topicFor("preview");
    const first = await remember(topic, "preview-one");
    const second = await remember(topic, "preview-two");
    const permanent = await remember(topic, "preview-permanent", { type: "preference" });
    const outside = await remember(topicFor("preview-outside"), "preview-outside");
    await archive(first);
    const store = new modules.FragmentStore();
    await store.createLink(first, second, "related", agentId);
    await store.createLink(permanent, outside, "related", agentId);
    const ids = [first, second, permanent, outside];
    const beforeState = await snapshot(ids);
    const beforeCache = [...cache.entries()];
    const beforeDeindexed = [...deindexed];
    const result = await forget(topic, { dryRun: true });
    assert.deepEqual(await snapshot(ids), beforeState, "dryRun must never execute deletion SQL");
    assert.deepEqual([...cache.entries()], beforeCache);
    assert.deepEqual(deindexed, beforeDeindexed);
    assert.deepEqual(result, { dryRun: true, simulated: {
      topic, matched_count: 3, would_delete_count: 2, protected_count: 1, linked_count: 1
    } });
  });

  it("force dry-run includes permanent memories and their links without executing deletion", async () => {
    const topic = topicFor("force-preview");
    const ordinary = await remember(topic, "force-preview-ordinary");
    const permanent = await remember(topic, "force-preview-permanent", { type: "preference" });
    const outside = await remember(topicFor("force-preview-outside"), "force-preview-outside");
    await archive(permanent);
    const store = new modules.FragmentStore();
    await store.createLink(ordinary, permanent, "related", agentId);
    await store.createLink(permanent, outside, "related", agentId);
    const ids = [ordinary, permanent, outside];
    const beforeState = await snapshot(ids);
    const beforeCache = [...cache.entries()];
    const beforeDeindexed = [...deindexed];
    const result = await forget(topic, { force: true, dryRun: true });
    assert.deepEqual(await snapshot(ids), beforeState);
    assert.deepEqual([...cache.entries()], beforeCache);
    assert.deepEqual(deindexed, beforeDeindexed);
    assert.deepEqual(result, { dryRun: true, simulated: {
      topic, matched_count: 2, would_delete_count: 2, protected_count: 0, linked_count: 2
    } });
  });

  it("hard-deletes amended and explicitly superseded topic memories while retaining protected and unrelated history", async () => {
    const topic = topicFor("lifecycle-history");
    const obsolete = await remember(topic, "historical-release-16");
    const permanent = await remember(topic, "permanent-history", { type: "preference" });
    const unrelated = await remember(topicFor("unrelated-history"), "unrelated-history");
    const rememberer = freshRememberer();
    for (const [id, label] of [[obsolete, "old runbook"], [permanent, "protected preference"], [unrelated, "unrelated runbook"]]) {
      const result = await rememberer.amend({ ...context, id,
        content: `Revised ${label}: Orion rollback requires checksum verification before routing traffic.` });
      assert.equal(result.updated, true, "public amend must create the fixture history");
    }
    const correction = await remember(topic, "corrected-release-17", { supersedes: [obsolete] });
    await new modules.FragmentStore().createLink(permanent, unrelated, "related", agentId);
    const beforeState = await snapshot([obsolete, correction, permanent, unrelated]);
    assert.deepEqual(new Set(beforeState.versions.map(v => v.fragment_id)), new Set([obsolete, permanent, unrelated]));
    assert.ok(beforeState.fragments.find(f => f.id === obsolete).valid_to, "public supersedes must expire the obsolete row");
    assert.ok(beforeState.links.some(l => l.from_id === obsolete && l.to_id === correction && l.relation_type === "superseded_by"));
    const beforeRecall = await recall(topic);
    assert.ok(beforeRecall.fragments.some(f => f.id === correction));
    assert.ok(!beforeRecall.fragments.some(f => f.id === obsolete));
    const preservedBefore = await snapshot([permanent, unrelated]);
    const result = await forget(topic);
    assert.deepEqual(await snapshot([obsolete, correction]), { fragments: [], versions: [], links: [] });
    assert.deepEqual(await snapshot([permanent, unrelated]), preservedBefore);
    assert.deepEqual(result, { deleted: 2, protected: 1 });
    assert.deepEqual((await recall(topic)).fragments.map(f => f.id), [permanent]);
    assert.ok(!cache.has(obsolete) && !cache.has(correction));
  });

  it("master-key topic deletion spans keys but keeps the requested agent scope and permanent protection", async () => {
    const topic = topicFor("master-scope");
    const own = await remember(topic, "master-scope-owned");
    const otherKey = await remember(topic, "master-scope-other-key", { _keyId: keyIds[1] });
    const shared = await remember(topic, "master-scope-shared", { _keyId: null, agentId: "default" });
    const peer = await remember(topic, "master-scope-peer", { _keyId: keyIds[1], agentId: `${agentId}-peer` });
    const permanent = await remember(topic, "master-scope-permanent", { _keyId: null, type: "preference" });
    const preservedBefore = await snapshot([peer, permanent]);
    const result = await forget(topic, { _keyId: null });
    assert.deepEqual(await snapshot([peer, permanent]), preservedBefore);
    assert.deepEqual(result, { deleted: 3, protected: 1 });
    assert.equal((await snapshot([own, otherKey, shared])).fragments.length, 0);
    assert.deepEqual((await recall(topic, { _keyId: null })).fragments.map(f => f.id), [permanent]);
    assert.ok([own, otherKey, shared].every(id => !cache.has(id)));
    assert.ok(cache.has(peer) && cache.has(permanent));
  });

  it("keeps other keys, peer agents and topics intact, even when group keys are supplied", async () => {
    const topic = topicFor("scope");
    const own = await remember(topic, "scope-owned");
    const shared = await remember(topic, "scope-shared", { agentId: "default" });
    const peer = await remember(topic, "scope-peer", { agentId: `${agentId}-peer` });
    const siblingKey = await remember(topic, "scope-sibling", { _keyId: keyIds[1] });
    const otherTopic = await remember(topicFor("scope-other"), "scope-other-topic");
    await archive(otherTopic);
    const store = new modules.FragmentStore();
    await store.createLink(own, otherTopic, "related", agentId);
    await store.createLink(peer, otherTopic, "related", agentId);
    const before = await snapshot([peer, siblingKey, otherTopic]);
    const start = deindexed.length;
    const result = await forget(topic, { _groupKeyIds: keyIds });
    assert.deepEqual(result, { deleted: 2, protected: 0 });
    assert.deepEqual(new Set(deindexed.slice(start)), new Set([own, shared]), "read groups must not expand cache mutation scope");
    const afterState = await snapshot([peer, siblingKey, otherTopic]);
    assert.deepEqual(afterState.versions, before.versions, "unrelated version history remains");
    assert.equal(afterState.fragments.length, 3);
    assert.deepEqual(afterState.links.map(l => [l.from_id, l.to_id]), [[peer, otherTopic]]);
    for (const fragment of afterState.fragments) {
      const original = before.fragments.find(f => f.id === fragment.id);
      assert.deepEqual(fragment, { ...original, linked_to: original.linked_to.filter(id => id !== own) });
      assert.ok(cache.has(fragment.id));
    }
    assert.deepEqual((await recall(topic)).fragments, []);
  });

  it("rolls back SQL changes and leaves cache intact when topic deletion fails", async () => {
    const topic = topicFor("rollback");
    const target = await remember(topic, "rollback-target");
    const neighbor = await remember(topicFor("rollback-neighbor"), "rollback-neighbor");
    await archive(target);
    await archive(neighbor);
    await new modules.FragmentStore().createLink(target, neighbor, "related", agentId);
    const ids = [target, neighbor];
    const beforeState = await snapshot(ids);
    const beforeCache = [...cache.entries()];
    const beforeDeindexed = [...deindexed];
    const connect = pool.connect.bind(pool);
    let injected = false;
    const interception = mock.method(pool, "connect", async () => {
      const client = await connect();
      return {
        query: async (...args) => {
          const sql = typeof args[0] === "string" ? args[0] : args[0].text;
          if (!injected && /DELETE\s+FROM\s+agent_memory\.fragments\b/i.test(sql)) {
            injected = true;
            throw new Error("synthetic topic-delete failure");
          }
          return client.query(...args);
        },
        release: client.release.bind(client)
      };
    });
    try {
      await assert.rejects(forget(topic), /synthetic topic-delete failure/);
      assert.ok(injected, "the failure must occur at real fragment deletion SQL");
    } finally {
      interception.mock.restore();
    }
    assert.deepEqual({ stored: await snapshot(ids), cache: [...cache.entries()], deindexed },
      { stored: beforeState, cache: beforeCache, deindexed: beforeDeindexed },
      "failed deletion must roll back fragments, versions, links and leave cache mutations unstarted");
  });

  it("gives exact ID precedence when both id and topic are supplied", async () => {
    const id = await remember(topicFor("id-precedence"), "selected-exact-id");
    const otherTopic = topicFor("id-precedence-other");
    const unrelated = await remember(otherTopic, "unrelated-topic-survivor");
    await archive(unrelated);
    const beforeState = await snapshot([unrelated]);
    const result = await freshRememberer().forget({ ...context, id, topic: otherTopic });
    assert.deepEqual(await snapshot([unrelated]), beforeState, "topic must not broaden an explicit-ID deletion");
    assert.deepEqual(result, { deleted: 1, protected: 0 });
    assert.equal((await snapshot([id])).fragments.length, 0);
    assert.ok(cache.has(unrelated));
    assert.deepEqual((await recall(otherTopic)).fragments.map(f => f.id), [unrelated]);
  });

  it("preserves the existing exact-ID dry-run and permanent/force behavior", async () => {
    const id = await remember(topicFor("exact"), "exact-permanent", { type: "preference" });
    const rememberer = freshRememberer();
    const beforeState = await snapshot([id]);
    const preview = await rememberer.forget({ ...context, id, dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.simulated.would_delete, false);
    assert.deepEqual(await snapshot([id]), beforeState);
    const protectedResult = await rememberer.forget({ ...context, id });
    assert.equal(protectedResult.deleted, 0);
    assert.equal(protectedResult.protected, 1);
    assert.deepEqual(await rememberer.forget({ ...context, id, force: true }), { deleted: 1, protected: 0 });
    assert.equal((await snapshot([id])).fragments.length, 0);
  });
});
