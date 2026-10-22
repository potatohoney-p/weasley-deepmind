/**
 * Offline-provider acceptance: remember -> persistent SQL -> fresh recall objects.
 * Run against an explicitly configured, migrated test PostgreSQL database:
 *   DATABASE_URL=... node --test tests/integration/lexical-text-recall.test.js
 * POSTGRES_* / DB_* configuration is also supported, as in the primary pool.
 *
 * Real: MemoryRememberer, FragmentFactory, FragmentWriter, ConflictResolver's
 * explicit supersession, LinkStore, FragmentReader, FragmentSearch, MemoryRecaller.
 * Disabled/injected: embeddings, Redis, automatic conflict/link/model processing,
 * quota enforcement, access reinforcement and adaptive thresholds. Search event
 * rows remain real and are removed by the unique synthetic key IDs during cleanup.
 * This is a component acceptance test, not HTTP/service/provider/RLS-role QA.
 */
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lexicalRecallFixture as fixture } from "../fixtures/lexical-text-recall.js";

const configured = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST || process.env.DB_HOST);
const runId = randomUUID();
const keyIds = [randomUUID(), randomUUID()];
const agentId = `lexical-${runId}`;
const workspace = `lexical-${runId}`;
const correctionWorkspace = `${workspace}-correction`;
const ownedIds = [];
const records = {};
let pool, modules, rememberer;

function emptyIndex() {
  return {
    index: async () => {},
    searchByKeywords: async () => [],
    searchByTopic: async () => [],
    searchByType: async () => [],
    getRecent: mock.fn(async () => []),
    getCachedFragment: async () => null,
    cacheFragment: async () => {}
  };
}

// Fresh readers/searchers cannot retrieve an in-memory copy of the writes.
function freshRecaller() {
  const store = new modules.FragmentStore();
  store.incrementAccess = async () => {};
  store.touchLinked = async () => {};
  const search = new modules.FragmentSearch();
  search.store = store;
  search.index = emptyIndex();
  return { recaller: new modules.MemoryRecaller({ store, search }), index: search.index };
}

async function recall(query = {}) {
  const { recaller, index } = freshRecaller();
  const result = await recaller.recall({
    _keyId: keyIds[0], agentId, workspace,
    includeLinks: false, tokenBudget: 1000,
    ...query
  });
  if (query.text && !query.keywords?.length && !query.topic) {
    assert.equal(index.getRecent.mock.callCount(), 0, "text recall must not substitute arbitrary recent memories");
  }
  return result;
}

async function remember(label, definition, overrides = {}) {
  const { ageDays, ...params } = definition;
  const result = await rememberer.remember({
    ...params, topic: "deployment-notes", _keyId: keyIds[0],
    agentId, workspace, skipConflictDetection: true, ...overrides
  });
  assert.ok(result.id, "production writer must return a persistent fragment ID");
  ownedIds.push(result.id);
  records[label] = result.id;
  // Fixture-only time control: aging never changes content/keywords or relevance.
  await pool.query(
    "UPDATE agent_memory.fragments SET created_at = NOW() - ($2 * INTERVAL '1 day') WHERE id = $1 AND key_id = $3",
    [result.id, ageDays, overrides._keyId ?? keyIds[0]]
  );
  return result;
}

describe("provider-independent text keyword recall", { skip: !configured }, () => {
  before(async () => {
    // Set before dynamic imports: no provider call, Redis socket or metrics timer.
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
    const [store, factory, search, writer, reader, resolver, db, adaptor, lifecycle] = await Promise.all([
      import("../../lib/memory/write/FragmentStore.js"),
      import("../../lib/memory/write/FragmentFactory.js"),
      import("../../lib/memory/read/FragmentSearch.js"),
      import("../../lib/memory/processors/MemoryRememberer.js"),
      import("../../lib/memory/processors/MemoryRecaller.js"),
      import("../../lib/memory/write/ConflictResolver.js"),
      import("../../lib/tools/db.js"),
      import("../../lib/memory/signals/SearchParamAdaptor.js"),
      import("../_lifecycle.js")
    ]);
    modules = { ...store, ...factory, ...search, ...writer, ...reader, ...lifecycle };
    pool = db.getPrimaryPool();
    // Explicit configuration means DB/schema failures are failures, never skips.
    await pool.query("SELECT id FROM agent_memory.fragments LIMIT 0");
    mock.method(adaptor.getSearchParamAdaptor(), "getMinSimilarity", async () => null);
    mock.method(adaptor.getSearchParamAdaptor(), "recordOutcome", async () => {});
    for (const keyId of keyIds) {
      await pool.query(
        "INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4)",
        [keyId, `lexical-test-${keyId}`, `synthetic-${keyId}`, "synthetic"]
      );
    }
    const writeStore = new modules.FragmentStore();
    const conflicts = new resolver.ConflictResolver(writeStore, null);
    conflicts.autoLinkOnRemember = async () => {};
    rememberer = new modules.MemoryRememberer({
      store: writeStore, factory: new modules.FragmentFactory(), index: emptyIndex(),
      quotaChecker: { check: async () => {} }, postProcessor: { run: async () => {} },
      conflictResolver: conflicts, policyGatingEnabled: false
    });
    for (const label of ["answer", "distractor", "unindexed"]) {
      await remember(label, fixture[label]);
    }
    await remember("otherKey", { ...fixture.answer, content: `${fixture.answer.content} Tenant B.` }, { _keyId: keyIds[1] });
    await remember("otherWorkspace", { ...fixture.answer, content: `${fixture.answer.content} Workspace B.` }, { workspace: `${workspace}-other` });
    await remember("otherAgent", { ...fixture.answer, content: `${fixture.answer.content} Agent B.` }, { agentId: `${agentId}-other` });
    await remember("obsolete", fixture.obsolete, { workspace: correctionWorkspace });
    await remember("correction", fixture.correction, { workspace: correctionWorkspace, supersedes: [records.obsolete] });
    // Discard the writing component before every test constructs fresh readers.
    rememberer = null;
  });

  after(async () => {
    try {
      if (pool) {
        await pool.query("DELETE FROM agent_memory.search_events WHERE key_id = ANY($1)", [keyIds]);
        await pool.query("DELETE FROM agent_memory.fragment_links WHERE from_id = ANY($1) OR to_id = ANY($1)", [ownedIds]);
        await pool.query("DELETE FROM agent_memory.fragments WHERE id = ANY($1) AND key_id = ANY($2)", [ownedIds, keyIds]);
        await pool.query("DELETE FROM agent_memory.api_keys WHERE id = ANY($1)", [keyIds]);
      }
    } finally {
      mock.restoreAll();
      await modules?.teardownTestResources();
      await modules?.assertCleanShutdown();
    }
  });

  it("recovers a six-month-old multi-term answer before a recent weak match at a one-answer budget", async () => {
    const tokenBudget = modules.countTokens(fixture.answer.content);
    assert.ok(modules.countTokens(fixture.distractor.content) < tokenBudget);
    const result = await recall({ text: fixture.question, tokenBudget });
    assert.deepEqual(result.fragments.map(f => f.id), [records.answer]);
    assert.equal(result.fragments[0].content, fixture.answer.content);
    assert.ok(result.totalTokens <= tokenBudget);
    assert.match(result.searchPath, /L2:/);
  });

  it("keeps the multi-term answer first after final recall ranking with a generous budget", async () => {
    const result = await recall({ text: fixture.question });
    assert.deepEqual(result.fragments.map(f => f.id), [records.answer, records.distractor]);
    assert.equal(result.fragments[0].similarity, undefined);
    assert.equal(result.fragments[0].rerankerScore, undefined);
  });

  it("excludes equal-term matches in another key, workspace or agent", async () => {
    const result = await recall({ text: fixture.question });
    assert.ok(result.fragments.some(f => f.id === records.answer), "scope test must retrieve its positive control");
    for (const label of ["otherKey", "otherWorkspace", "otherAgent"]) {
      assert.ok(!result.fragments.some(f => f.id === records[label]), `${label} must be excluded`);
    }
    assert.deepEqual(new Set(result.fragments.map(f => f.id)), new Set([records.answer, records.distractor]));
  });

  it("recalls the correction and excludes the explicitly superseded instruction", async () => {
    const stored = await pool.query("SELECT valid_to FROM agent_memory.fragments WHERE id = $1", [records.obsolete]);
    assert.ok(stored.rows[0].valid_to, "real supersession must have expired the previous instruction");
    const result = await recall({ text: "Orion recovery rollback", workspace: correctionWorkspace });
    assert.deepEqual(result.fragments.map(f => f.id), [records.correction]);
    assert.equal(result.fragments[0].content, fixture.correction.content);
  });

  it("returns no answer for content-only, substring, missing or stopword-only terms", async () => {
    for (const text of [
      "Zephyr evacuation", "ori roll", "quasar restoration", "what was the and for",
      "mercury venus saturn jupiter neptune orion"
    ]) {
      const result = await recall({ text });
      assert.deepEqual(result.fragments, [], `no stored keyword match for ${JSON.stringify(text)}`);
    }
  });

  it("preserves explicit keyword lookup and does not replace explicit terms with text-derived ones", async () => {
    const explicit = await recall({ keywords: ["rollback"] });
    const mixed = await recall({ keywords: ["rollback"], text: "Orion dashboard" });
    assert.deepEqual(explicit.fragments.map(f => f.id), [records.answer]);
    assert.deepEqual(mixed.fragments.map(f => f.id), [records.answer]);
    const absent = await recall({ keywords: ["quasar"], text: fixture.question });
    assert.deepEqual(absent.fragments, []);
  });
});
