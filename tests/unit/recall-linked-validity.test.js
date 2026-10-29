/**
 * Superseded memories must not re-enter default recall through one-hop links.
 * The database boundary is synthetic; SQL construction and final merge are
 * exercised separately, without copying the production query implementation.
 */

import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (agentId, sql, params) => {
      queries.push({ agentId, sql, params });
      return { rows: [] };
    },
    getPrimaryPool: () => ({ query: async () => ({ rows: [] }) }),
    getBatchPool: () => null,
    shutdownPool: async () => {},
    getPoolStats: () => ({}),
    withTransaction: async (_pool, fn) => fn({ query: async () => ({ rows: [] }) })
  }
});

const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");
const { assertCleanShutdown, teardownTestResources } = await import("../_lifecycle.js");

after(async () => {
  await teardownTestResources();
  mock.restoreAll();
  await assertCleanShutdown();
});

beforeEach(() => { queries.length = 0; });

const fragment = (id, overrides = {}) => ({
  id,
  content: `Synthetic memory ${id}`,
  type: "fact",
  importance: 0.7,
  created_at: "2026-01-01T00:00:00.000Z",
  verified_at: "2026-01-01T00:00:00.000Z",
  agent_id: "agent-a",
  workspace: "workspace-a",
  valid_to: null,
  ...overrides
});
const expiredAt = "2026-02-01T00:00:00.000Z";
const ids = result => result.fragments.map(row => row.id).sort();

function recallerWithLinks(rows) {
  const linked = mock.fn(async () => structuredClone(rows));
  const recaller = new MemoryRecaller({
    store: { getLinkedFragments: linked },
    search: {
      search: async () => ({
        fragments: [fragment("seed")], totalTokens: 4, count: 1, searchPath: "L2"
      })
    }
  });
  return { recaller, linked };
}

describe("LinkStore one-hop validity SQL", () => {
  for (const relationType of [null, "resolved_by", "superseded_by"]) {
    it(`filters both directions before the limit (${relationType ?? "default relations"})`, async () => {
      await new LinkStore().getLinkedFragments(
        ["seed"], relationType, "agent-a", ["key-a", "key-b"],
        { workspace: "workspace-a" }
      );
      const { sql } = queries.at(-1);
      const [outgoing, incoming] = sql.split("UNION ALL");
      assert.match(outgoing, /WHERE l\.from_id = ANY\(\$1\)[\s\S]*AND f\.valid_to IS NULL/);
      assert.match(incoming, /WHERE l\.to_id = ANY\(\$1\)[\s\S]*AND f\.valid_to IS NULL[\s\S]*LIMIT/);
      assert.match(sql, /id, content,[\s\S]*valid_to/);
      assert.equal((sql.match(/f\.valid_to[, ]/g) ?? []).length, 4);
    });
  }

  it("explicit history removes only validity restrictions, not key, agent or workspace scope", async () => {
    const store = new LinkStore();
    for (const includeSuperseded of [false, true]) {
      await store.getLinkedFragments(
        ["seed"], "resolved_by", "agent-a", ["key-a", "key-b"],
        { workspace: "workspace-a", includeSuperseded }
      );
    }
    const [current, history] = queries;
    assert.deepEqual(history.params, current.params);
    assert.equal(history.sql, current.sql.replaceAll("AND f.valid_to IS NULL", ""));
    assert.equal((history.sql.match(/f\.key_id = ANY\(\$3\)/g) ?? []).length, 2);
    assert.equal((history.sql.match(/f\.agent_id = \$4/g) ?? []).length, 2);
    assert.equal((history.sql.match(/f\.workspace = \$5/g) ?? []).length, 2);
  });

  it("peer history preserves the key/workspace filters in both directions", async () => {
    await new LinkStore().getLinkedFragments(
      ["seed"], null, "agent-a", ["key-a"],
      { workspace: "workspace-a", includePeerAgents: true, includeSuperseded: true }
    );
    const { sql, params } = queries.at(-1);
    assert.doesNotMatch(sql, /AND f\.valid_to IS NULL|f\.agent_id = \$/);
    assert.equal((sql.match(/f\.key_id = ANY\(\$2\)/g) ?? []).length, 2);
    assert.equal((sql.match(/f\.workspace = \$3/g) ?? []).length, 2);
    assert.deepEqual(params, [["seed"], ["key-a"], "workspace-a"]);
  });

  it("an empty seed set does not read storage", async () => {
    assert.deepEqual(await new LinkStore().getLinkedFragments([]), []);
    assert.equal(queries.length, 0);
  });
});

describe("MemoryRecaller linked validity boundary", () => {
  const params = { agentId: "agent-a", workspace: "workspace-a", _keyId: "key-a" };

  it("does not reintroduce a superseded neighbor after direct search excluded it", async () => {
    const { recaller, linked } = recallerWithLinks([
      fragment("current"),
      fragment("old-outgoing", { valid_to: expiredAt }),
      fragment("old-incoming", { valid_to: new Date(expiredAt) })
    ]);
    const result = await recaller.recall(params);
    assert.deepEqual(ids(result), ["current", "seed"]);
    assert.equal(result.count, 2);
    assert.equal(result.totalCount, 2);
    assert.equal(linked.mock.calls[0].arguments[4].includeSuperseded, false);
  });

  it("keeps explicitly requested history and its validity metadata", async () => {
    const { recaller, linked } = recallerWithLinks([
      fragment("current"),
      fragment("old", { valid_to: expiredAt })
    ]);
    const result = await recaller.recall({ ...params, includeSuperseded: true });
    assert.deepEqual(ids(result), ["current", "old", "seed"]);
    assert.equal(result.fragments.find(row => row.id === "old").valid_to, expiredAt);
    assert.deepEqual(linked.mock.calls[0].arguments, [
      ["seed"], null, "agent-a", ["key-a"],
      { workspace: "workspace-a", includePeerAgents: false, includeSuperseded: true }
    ]);
  });

  it("explicit history still excludes peer agents and other workspaces", async () => {
    const { recaller } = recallerWithLinks([
      fragment("old-own", { valid_to: expiredAt }),
      fragment("old-peer", { valid_to: expiredAt, agent_id: "agent-b" }),
      fragment("old-other-workspace", { valid_to: expiredAt, workspace: "workspace-b" }),
      fragment("old-global", { valid_to: expiredAt, agent_id: "default", workspace: null })
    ]);
    assert.deepEqual(
      ids(await recaller.recall({ ...params, includeSuperseded: true })),
      ["old-global", "old-own", "seed"]
    );
  });

  it("includeLinks=false leaves the direct result alone and makes no linked read", async () => {
    const { recaller, linked } = recallerWithLinks([fragment("old", { valid_to: expiredAt })]);
    assert.deepEqual(ids(await recaller.recall({ ...params, includeLinks: false })), ["seed"]);
    assert.equal(linked.mock.callCount(), 0);
  });
});
