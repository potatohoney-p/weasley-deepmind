import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Real reflection -> remember -> factory -> writer -> reader against the migrated
// test database. Redis, providers, quota decisions and automatic links are isolated.
// A configured but unavailable database must fail rather than silently skip.
describe("reflection episode workspace (PostgreSQL)", { skip: !process.env.DATABASE_URL }, () => {
  const prefix = `reflect-workspace-${randomUUID()}`;
  const agentId = `${prefix}-agent`;
  const keyId = randomUUID();
  let pool, store, factory, rememberer, ReflectProcessor, lifecycle;

  before(async () => {
    const db = await import("../../lib/tools/db.js");
    const { FragmentStore } = await import("../../lib/memory/write/FragmentStore.js");
    const { FragmentFactory } = await import("../../lib/memory/write/FragmentFactory.js");
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    ({ ReflectProcessor } = await import("../../lib/memory/processors/ReflectProcessor.js"));
    lifecycle = await import("../_lifecycle.js");
    pool = db.getPrimaryPool();
    await pool.query("SELECT 1 FROM agent_memory.fragments LIMIT 0");
    await pool.query(
      `INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix)
       VALUES ($1, $2, $3, 'synthetic')`, [keyId, prefix, randomUUID()]
    );
    store = new FragmentStore();
    factory = new FragmentFactory();
    rememberer = new MemoryRememberer({
      store, factory,
      index: { index: async () => {} },
      quotaChecker: { check: async () => {} },
      postProcessor: { run: async () => {} },
      conflictResolver: { autoLinkOnRemember: async () => {} },
      policyGatingEnabled: false
    });
  });

  for (const [name, scope, expected] of [
    ["explicit", { workspace: "project-a", _defaultWorkspace: "project-b" }, "project-a"],
    ["default", { _defaultWorkspace: "project-b" }, "project-b"],
    ["global", {}, null]
  ]) {
    it(`${name} narrative persists its scope and obeys workspace-filtered reads`, async () => {
      const sessionId = `${prefix}-${name}`;
      const processor = new ReflectProcessor({
        store, factory,
        index: { clearWorkingMemory: async () => {} },
        sessionLinker: {
          consolidateSessionFragments: async () => null,
          autoLinkSessionFragments: async () => ({ linkSuggestions: [] })
        },
        remember: rememberer.remember.bind(rememberer)
      });
      const result = await processor.process({
        sessionId, agentId, _keyId: keyId, ...scope,
        narrative_summary: `${prefix} ${name}: The project completed its release validation.`
      });
      assert.equal(result.breakdown.episode, 1);
      const { rows } = await pool.query(
        `SELECT id, workspace, key_id, agent_id, session_id, type, source
         FROM agent_memory.fragments WHERE session_id = $1 AND agent_id = $2`,
        [sessionId, agentId]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].workspace, expected);
      assert.equal(rows[0].key_id, keyId);
      assert.equal(rows[0].type, "episode");
      assert.equal(rows[0].source, `session:${sessionId}`);

      const read = workspace => store.searchByTopic("session_reflect", {
        agentId, keyId, type: "episode", workspace
      });
      assert.ok((await read(expected ?? "project-a")).some(f => f.id === rows[0].id));
      assert.equal((await read("unrelated-project")).some(f => f.id === rows[0].id), expected === null);
      assert.ok((await read(null)).some(f => f.id === rows[0].id), "unfiltered reads remain unchanged");
    });
  }

  after(async () => {
    try {
      if (pool) {
        await pool.query("DELETE FROM agent_memory.fragments WHERE agent_id = $1", [agentId]);
        await pool.query("DELETE FROM agent_memory.api_keys WHERE id = $1", [keyId]);
      }
    } finally {
      await lifecycle?.teardownTestResources();
      await lifecycle?.assertCleanShutdown();
    }
  });
});
