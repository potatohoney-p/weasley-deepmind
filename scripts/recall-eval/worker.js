// This process has no real database, Redis client, embedding provider or telemetry.
// Only the synthetic boundary below is replaced; recall/index/reader/tokenizer run
// from this checkout. Unexpected SQL fails instead of silently inventing results.
import { mock } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { installOfflineGuards } from "./offline-guards.js";
import { readSyntheticRows } from "./synthetic-reader.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const forbidden = [];
const fail = () => {
  forbidden.push("unexpected boundary");
  throw new Error("Unavailable in offline recall evaluation");
};
// Fail before any socket or provider operation, even if a future import tries it.
installOfflineGuards(fail);
const noop = () => {};
let state = { rows: [], strings: {}, sets: {} };
const redis = {
  status: "ready",
  async get(key) { return state.strings[key] ?? null; },
  async setex(key, _ttl, value) { state.strings[key] = value; },
  async smembers(key) { return state.sets[key] ?? []; },
  pipeline() {
    const operations = [];
    const pipe = {
      sadd(key, id) {
        operations.push(() => { state.sets[key] = [...new Set([...(state.sets[key] ?? []), id])]; });
        return pipe;
      },
      zadd(key, _score, id) { return pipe.sadd(key, id); },
      expire() { return pipe; },
      async exec() { operations.forEach(operation => operation()); return []; }
    };
    return pipe;
  }
};
mock.module("../../lib/redis.js", { namedExports: { redisClient: redis, disconnectRedis: async () => {} } });
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: noop, logInfo: noop, logWarn: noop, logError: noop }
});
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => null, getBatchPool: () => null,
    shutdownPool: async () => {}, getPoolStats: () => ({}), withTransaction: fail,
    queryWithAgentVector: async (agent, sql, params) => readSyntheticRows(state.rows, agent, sql, params)
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED: false, computeContentHash: text => createHash("sha256").update(text).digest("hex"),
    generateBatchEmbeddings: fail, generateEmbedding: fail,
    prepareTextForEmbedding: text => text, vectorToSql: fail
  }
});
// Learning/telemetry side effects are deliberately excluded from this read-only
// replay. They are not part of the candidate, scope, rank or budget algorithms.
mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: { getSearchMetrics: async () => ({ record: noop }) }
});
mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: { getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null }) }
});
mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: { commitSearchSideEffects: async () => null }
});
mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: { isRerankerAvailable: () => false, rerank: fail }
});

const { FragmentIndex } = await import("../../lib/memory/FragmentIndex.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
const { countTokens } = await import("../../lib/memory/write/FragmentFactory.js");
const fixedTime = "2026-01-01T00:00:00.000Z";
const keyId = "offline-synthetic";

function newSearch(variant) {
  const search = new FragmentSearch();
  search.store.incrementAccess = noop;
  search.store.touchLinked = async () => {};
  if (variant === "legacy-cache") {
    // Intentional negative control: the historical cache-trusting behavior.
    // Never installed in the production class or used outside this child.
    search._tryHotCache = async (ids, key, scope) => {
      const cached = await Promise.all(ids.slice(0, 30).map(id => search.index.getCachedFragment(id, key)));
      return cached.filter(row => row?.content && (!scope || scope.applyTo(row)));
    };
  }
  return search;
}

async function ingest() {
  const snapshots = [];
  for (const episode of input.episodes) {
    state = { rows: [], strings: {}, sets: {} };
    const index = new FragmentIndex();
    for (let i = 0; i < episode.events.length; i++) {
      const event = episode.events[i];
      const existing = state.rows.find(row => row.id === event.id);
      if (event.op === "put") {
        const row = {
          id: event.id, content: event.content, case_id: episode.id,
          keywords: [], topic: episode.id, type: "fact", importance: event.importance ?? 0.8,
          created_at: fixedTime, valid_to: null, agent_id: "default", key_id: keyId, workspace: null
        };
        state.rows.push(row);
        await index.index(row, null, keyId);
        await index.cacheFragment(row.id, row, keyId);
      } else if (event.op === "supersede") {
        existing.valid_to = fixedTime;
      } else if (event.op === "amend") {
        existing.content = event.content;
      } else if (event.op === "delete") {
        state.rows = state.rows.filter(row => row.id !== event.id);
      }
      // Keep old index/cache state to model a surviving or late stale refill.
      for (const checkpoint of episode.checkpoints.filter(point => point.after === i + 1)) {
        snapshots.push({ episode: episode.id, checkpoint: checkpoint.id, state: structuredClone(state) });
      }
    }
  }
  writeFileSync(input.snapshotPath, JSON.stringify(snapshots));
  return { snapshots: snapshots.length };
}

async function query() {
  const snapshots = JSON.parse(readFileSync(input.snapshotPath, "utf8"));
  const results = [];
  for (const snapshot of snapshots) {
    for (const budget of input.budgets) {
      for (const cache of ["cold", "warm-stale"]) {
        state = structuredClone(snapshot.state);
        if (cache === "cold") state.strings = {};
        const search = newSearch(input.variant);
        const candidateIds = await search.index.searchByType("fact", keyId);
        const result = await search.search({
          type: "fact", caseId: snapshot.episode, keyId, agentId: "default",
          tokenBudget: budget, anchorTime: Date.parse(fixedTime)
        });
        results.push({
          episode: snapshot.episode, checkpoint: snapshot.checkpoint, budget, cache,
          candidateIds,
          fragments: result.fragments.map(row => ({ id: row.id, content: row.content, valid_to: row.valid_to })),
          totalTokens: result.totalTokens,
          contentTokens: result.fragments.reduce((sum, row) => sum + countTokens(row.content), 0),
          searchPath: result.searchPath
        });
      }
    }
  }
  return { results };
}

try {
  if (!["ingest", "query"].includes(input.mode)) throw new Error("Unknown worker mode");
  const result = input.mode === "ingest" ? await ingest() : await query();
  if (forbidden.length) throw new Error("Offline replay attempted an unexpected boundary");
  process.stdout.write(JSON.stringify(result));
} finally {
  mock.restoreAll();
}
