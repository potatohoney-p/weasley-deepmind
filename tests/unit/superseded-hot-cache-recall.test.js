import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Synthetic Redis survives reconstruction of the production search/index objects.
const strings = new Map();
const sets = new Map();
const rows = new Map();
const links = [];
const reads = [];
let readError = null;
const redis = {
  status: "ready",
  async get(key) { return strings.get(key) ?? null; },
  async setex(key, _ttl, value) { strings.set(key, value); return "OK"; },
  async smembers(key) { return [...(sets.get(key) ?? [])]; },
  async zrevrange(key, start, stop) { return [...(sets.get(key) ?? [])].reverse().slice(start, stop + 1); },
  pipeline() {
    const operations = [];
    const pipeline = {
      sadd(key, id) {
        operations.push(() => {
          if (!sets.has(key)) sets.set(key, new Set());
          sets.get(key).add(id);
        });
        return pipeline;
      },
      srem(key, id) { operations.push(() => sets.get(key)?.delete(id)); return pipeline; },
      del(key) { operations.push(() => strings.delete(key)); return pipeline; },
      zadd(key, _score, id) { return pipeline.sadd(key, id); },
      zrem() { return pipeline; },
      expire() { return pipeline; },
      async exec() { operations.forEach(operation => operation()); return []; }
    };
    return pipeline;
  }
};

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: redis, disconnectRedis: async () => {} }
});
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        assert.match(sql, /UPDATE agent_memory\.fragments/);
        assert.match(sql, /valid_to\s*=\s*NOW\(\)/);
        const row = rows.get(params[0]);
        if (!row || row.valid_to || (params.length > 1 && row.key_id !== params[1])) {
          return { rows: [], rowCount: 0 };
        }
        row.valid_to = "2026-10-20T12:00:00.000Z";
        row.importance *= 0.5;
        return { rows: /RETURNING/i.test(sql) ? [structuredClone(row)] : [], rowCount: 1 };
      }
    }),
    queryWithAgentVector: async (agentId, sql, params) => {
      reads.push({ agentId, sql, params: structuredClone(params) });
      if (readError) throw readError;
      assert.match(sql, /WHERE id = ANY\(\$1\)/);
      const [ids, requestedAgent, scalarKey, groupKeys] = params;
      return { rows: [...rows.values()].filter(row =>
        ids.includes(row.id)
        && (!sql.includes("valid_to IS NULL") || row.valid_to === null)
        && (!sql.includes("agent_id = $2") || row.agent_id === requestedAgent || row.agent_id === "default")
        && (scalarKey === undefined || row.key_id === scalarKey || groupKeys.includes(row.key_id))
      ).map(row => structuredClone(row)) };
    },
    getBatchPool: () => null,
    shutdownPool: async () => {},
    getPoolStats: () => ({}),
    withTransaction: async () => { throw new Error("Unexpected transaction in offline fixture"); }
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED: false,
    computeContentHash: () => "synthetic-hash",
    generateBatchEmbeddings: async () => { throw new Error("No model calls allowed"); },
    generateEmbedding: async () => { throw new Error("No model calls allowed"); },
    prepareTextForEmbedding: text => String(text ?? ""),
    vectorToSql: vector => `[${vector.join(",")}]`
  }
});
mock.module("../../lib/memory/write/FragmentFactory.js", {
  namedExports: {
    FragmentFactory: class { extractKeywords() { return []; } },
    countTokens: text => Math.ceil(String(text ?? "").length / 4)
  }
});
mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: { getSearchMetrics: async () => ({ record: () => {} }) }
});
mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: { getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null }) }
});
mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: { commitSearchSideEffects: async () => null }
});
mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: { isRerankerAvailable: () => false, rerank: async () => null }
});

const { FragmentIndex } = await import("../../lib/memory/FragmentIndex.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { SearchScope } = await import("../../lib/memory/read/SearchScope.js");
const { ConflictResolver } = await import("../../lib/memory/write/ConflictResolver.js");
const { assertCleanShutdown } = await import("../_lifecycle.js");

const keyId = "synthetic-key";
const query = { topic: "release-day", agentId: "default", keyId, tokenBudget: 2000 };
const fragment = (id, content) => ({
  id, content, topic: query.topic, keywords: ["release"], type: "fact",
  importance: 0.8, created_at: "2026-10-20T10:00:00.000Z", valid_to: null,
  agent_id: "default", key_id: keyId, workspace: null
});
const oldFact = fragment("old-fact", "The synthetic release is on Monday.");
const correction = fragment("corrected-fact", "Correction: the synthetic release is on Tuesday.");

function makeSearch() {
  const search = Object.create(FragmentSearch.prototype);
  search.index = new FragmentIndex();
  const copy = values => values.map(value => structuredClone(value));
  search.store = {
    searchByTopic: async (topic, options) => copy([...rows.values()].filter(row =>
      row.topic === topic && (options.includeSuperseded || row.valid_to === null))),
    searchByKeywords: async () => [],
    getByIds: (...args) => new FragmentReader().getByIds(...args),
    createLink: async (...args) => { links.push(args); },
    incrementAccess: () => {},
    touchLinked: async () => {}
  };
  return search;
}

beforeEach(() => {
  strings.clear(); sets.clear(); rows.clear(); links.length = 0; reads.length = 0;
  readError = null;
  redis.status = "ready";
});
after(async () => { mock.restoreAll(); await assertCleanShutdown(); });

describe("durable correction followed by cached recall", () => {
  it("control: uncached superseded facts are excluded and explicit history still returns them", async () => {
    const search = makeSearch();
    rows.set(oldFact.id, structuredClone(oldFact));
    rows.set(correction.id, structuredClone(correction));
    const resolver = new ConflictResolver(search.store, search);
    await resolver.supersede(oldFact.id, correction.id, "default", keyId);
    const current = await search.search(query);
    assert.deepEqual(current.fragments.map(row => row.id), [correction.id]);
    const history = await search.search({ ...query, includeSuperseded: true });
    assert.deepEqual(new Set(history.fragments.map(row => row.id)), new Set([oldFact.id, correction.id]));
  });

  it("excludes a superseded cached fact after reconstructing the search objects", async () => {
    const search = makeSearch();
    rows.set(oldFact.id, structuredClone(oldFact));
    await search.index.index(oldFact, null, keyId);
    const initial = await search.search(query);
    assert.deepEqual(initial.fragments.map(row => row.id), [oldFact.id]);
    assert.equal((await search.index.getCachedFragment(oldFact.id, keyId)).valid_to, null);

    rows.set(correction.id, structuredClone(correction));
    await search.index.index(correction, null, keyId);
    const resolver = new ConflictResolver(search.store, search);
    await resolver.supersede(oldFact.id, correction.id, "default", keyId);
    assert.ok(rows.get(oldFact.id).valid_to, "durable supersession completed");
    assert.deepEqual(links[0], [oldFact.id, correction.id, "superseded_by", "default"]);

    // New objects, same durable rows and serialized Redis cache: process restart model.
    const restartedSearch = makeSearch();
    const recalled = await restartedSearch.search(query);
    assert.deepEqual(recalled.fragments.map(row => row.id), [correction.id]);
  });

  it("a stale refill after supersession cannot poison a later recall", async () => {
    const search = makeSearch();
    rows.set(oldFact.id, structuredClone(oldFact));
    rows.set(correction.id, structuredClone(correction));
    await search.index.index(oldFact, null, keyId);
    await new ConflictResolver(search.store, search).supersede(oldFact.id, correction.id, "default", keyId);
    // Model an old in-flight read completing its cache write after the mutation.
    await search.index.cacheFragment(oldFact.id, oldFact, keyId);
    const result = await makeSearch().search(query);
    assert.deepEqual(result.fragments.map(row => row.id), [correction.id]);
  });

  it("deleted cached candidates do not reappear in current or explicit history recall", async () => {
    const search = makeSearch();
    await search.index.index(oldFact, null, keyId);
    await search.index.cacheFragment(oldFact.id, oldFact, keyId);
    // The durable fixture intentionally has no row after deletion.
    assert.equal((await search.search(query)).count, 0);
    assert.equal((await search.search({ ...query, includeSuperseded: true })).count, 0);
  });

  it("ranks and budgets current amended content instead of the cached short version", async () => {
    const search = makeSearch();
    await search.index.index(oldFact, null, keyId);
    await search.index.cacheFragment(oldFact.id, oldFact, keyId);
    const amended = { ...oldFact, content: "Current corrected detail. ".repeat(100) };
    rows.set(amended.id, amended);
    const noFilter = { agentId: "default", keyId, tokenBudget: 20 };
    assert.equal((await search.search(noFilter)).count, 0, "old short cache must not bypass the new content budget");
    const result = await search.search({ ...noFilter, tokenBudget: 2000 });
    assert.equal(result.fragments[0].content, amended.content);
    assert.equal(result.totalTokens, Math.ceil(amended.content.length / 4));
  });

  for (const extra of [{}, { type: "fact" }]) {
    it(`explicit history preserves durable validity metadata with ${extra.type ? "type-only" : "no-filter"} recall`, async () => {
      const search = makeSearch();
      rows.set(oldFact.id, { ...oldFact, valid_to: "2026-10-20T12:00:00.000Z" });
      await search.index.index(oldFact, null, keyId);
      await search.index.cacheFragment(oldFact.id, oldFact, keyId);
      const result = await search.search({ agentId: "default", keyId, ...extra, includeSuperseded: true });
      assert.equal(result.count, 1);
      assert.equal(result.fragments[0].valid_to, rows.get(oldFact.id).valid_to);
      assert.ok(reads.some(read => !read.sql.includes("valid_to IS NULL")));
    });
  }

  it("scope selection uses current workspace, affect and peer-agent fields", async () => {
    const search = makeSearch();
    const before = { ...oldFact, workspace: "old-workspace", affect: "negative", agent_id: "peer" };
    await search.index.cacheFragment(before.id, before, keyId);
    rows.set(before.id, { ...before, workspace: "selected", affect: "positive", agent_id: "default" });
    const scope = new SearchScope({ agentId: "own", workspace: "selected", affect: "positive" });
    let result = await search._tryHotCache([before.id], keyId, scope);
    assert.equal(result.length, 1, "stale scope fields must not reject a now-valid row");
    assert.equal(result[0].affect, "positive");
    rows.get(before.id).affect = "negative";
    assert.deepEqual(await search._tryHotCache([before.id], keyId, scope), []);
    rows.get(before.id).affect = "positive";
    rows.get(before.id).workspace = null;
    rows.get(before.id).agent_id = "peer";
    assert.deepEqual(await search._tryHotCache([before.id], keyId, scope), []);
    scope.includePeerAgents = true;
    result = await search._tryHotCache([before.id], keyId, scope);
    assert.equal(result.length, 1, "explicit peers and global workspace remain supported");
  });

  it("batches at most 30 requested cache keys and does not trust payload IDs", async () => {
    const search = makeSearch();
    const ids = Array.from({ length: 35 }, (_unused, i) => `fact-${i}`);
    for (const id of ids) {
      rows.set(id, fragment(id, `Current ${id}`));
      await search.index.cacheFragment(id, { ...oldFact, id: "unrequested-id" }, keyId);
    }
    const result = await search._tryHotCache(ids, keyId);
    assert.equal(result.length, 30);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].params[0], ids.slice(0, 30));
    assert.equal(result.some(row => row.id === "unrequested-id"), false);
  });

  it("L1 miss fallback cannot reintroduce current rows rejected by the requested scope", async () => {
    for (const [queryField, rowField] of [
      ["affect", "affect"], ["caseId", "case_id"],
      ["resolutionStatus", "resolution_status"], ["phase", "phase"]
    ]) {
      strings.clear(); sets.clear(); rows.clear();
      const search = makeSearch();
      const cached = { ...oldFact, [rowField]: "selected" };
      await search.index.index(cached, null, keyId);
      await search.index.cacheFragment(cached.id, cached, keyId);
      rows.set(cached.id, { ...cached, [rowField]: "changed" });
      const result = await search.search({
        agentId: "default", keyId, type: "fact", [queryField]: "selected"
      });
      assert.equal(result.count, 0, `${queryField}: fallback must retain the hydrated scope decision`);
    }
  });

  it("cache misses and unavailable Redis need no validation query; durable failure propagates", async () => {
    const search = makeSearch();
    assert.deepEqual(await search._tryHotCache([], keyId), []);
    assert.deepEqual(await search._tryHotCache([oldFact.id], keyId), []);
    await search.index.cacheFragment(oldFact.id, oldFact, keyId);
    redis.status = "end";
    assert.deepEqual(await search._tryHotCache([oldFact.id], keyId), []);
    assert.equal(reads.length, 0);
    redis.status = "ready";
    readError = new Error("synthetic durable read failure");
    await assert.rejects(search._tryHotCache([oldFact.id], keyId), /synthetic durable read failure/);
  });
});

describe("hydration reader SQL contract", () => {
  for (const [name, requestKey, expectedParams] of [
    ["master", null, [[oldFact.id], "default"]],
    ["scalar", keyId, [[oldFact.id], "default", keyId, [keyId]]],
    ["group", [keyId, "peer-key"], [[oldFact.id], "default", keyId, [keyId, "peer-key"]]]
  ]) {
    it(`${name} key form uses existing parameterized reader predicates`, async () => {
      const search = makeSearch();
      await search._getScopedByIds([oldFact.id], "default", requestKey, {});
      assert.deepEqual(reads[0].params, expectedParams);
      assert.match(reads[0].sql, /\(agent_id = \$2 OR agent_id = 'default'\)/);
      assert.match(reads[0].sql, /valid_to IS NULL/);
      if (requestKey !== null) assert.match(reads[0].sql, /key_id IS NOT DISTINCT FROM \$3 OR key_id = ANY\(\$4::text\[\]\)/);
      assert.match(reads[0].sql, /agent_id, key_id, affect, access_count/);
    });
  }

  it("empty key groups never become an unscoped read", async () => {
    const search = makeSearch();
    assert.deepEqual(await search._getScopedByIds([oldFact.id], "default", [], {}), []);
    assert.equal(reads.length, 0);
  });

  it("history and peer opt-ins change only their own predicates", async () => {
    const search = makeSearch();
    await search._getScopedByIds([oldFact.id], "own", keyId, { includeSuperseded: true, includePeerAgents: true });
    assert.doesNotMatch(reads[0].sql, /valid_to IS NULL|agent_id = \$2/);
    assert.match(reads[0].sql, /key_id IS NOT DISTINCT FROM \$3/);
    assert.deepEqual(reads[0].params, [[oldFact.id], "own", keyId, [keyId]]);
  });
});
