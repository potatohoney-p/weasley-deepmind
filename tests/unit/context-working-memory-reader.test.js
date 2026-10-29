import { after, mock, test } from "node:test";
import assert from "node:assert/strict";

const captured = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => null,
    shutdownPool: async () => {},
    queryWithAgentVector: async (agentId, sql, params) => {
      captured.push({ agentId, sql, params });
      return { rows: [{ id: "live", content: "durable corrected content", type: "fact",
        importance: 0.5, agent_id: agentId, valid_to: null, workspace: "work" }] };
    }
  }
});
const { ContextBuilder } = await import("../../lib/memory/read/ContextBuilder.js");
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { assertCleanShutdown, teardownTestResources } = await import("../_lifecycle.js");

test("working memory delegates to the real reader's bound current/key/agent SELECT", async () => {
  const reader = new FragmentReader();
  const builder = new ContextBuilder({
    recall: async () => ({ fragments: [] }),
    index: { getWorkingMemory: async () => [{ id: "live", content: "stale content" }], setSeenIds: async () => {} },
    store: { getByIds: reader.getByIds.bind(reader), searchBySource: async () => [] },
    getPool: () => null
  });
  const result = await builder.build({ sessionId: "session", agentId: "worker", _keyId: "key", _groupKeyIds: ["key", "peer-key"], workspace: "work" });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].params, [["live"], "worker", "key", ["key", "peer-key"]]);
  assert.equal(captured[0].agentId, "worker");
  assert.match(captured[0].sql, /id = ANY\(\$1\)/);
  assert.match(captured[0].sql, /\(agent_id = \$2 OR agent_id = 'default'\)/);
  assert.match(captured[0].sql, /valid_to IS NULL/);
  assert.match(captured[0].sql, /key_id IS NOT DISTINCT FROM \$3 OR key_id = ANY\(\$4::text\[\]\)/);
  assert.deepEqual(result.fragments.map(f => f.content), ["durable corrected content"]);
});

after(async () => { await teardownTestResources(); await assertCleanShutdown(); });
