import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import * as db from "../../lib/tools/db.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

let captured;
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...db,
    queryWithAgentVector: async (agentId, sql, params) => {
      captured = { agentId, sql, params };
      return { rows: [] };
    }
  }
});
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const reader = new FragmentReader();

test("temporal reads exclude expired rows unless explicitly enabled", async () => {
  for (const includeSuperseded of [undefined, false, "true", 1]) {
    await reader.searchByTimeRange(null, null, { includeSuperseded });
    assert.match(captured.sql, /valid_to IS NULL/);
  }
  await reader.searchByTimeRange(null, null, { includeSuperseded: true });
  assert.doesNotMatch(captured.sql, /valid_to IS NULL/);
});

test("temporal history preserves bound scope, interval, ordering and limit", async () => {
  const from = new Date("2026-01-01T00:00:00Z");
  const to = new Date("2026-02-01T00:00:00Z");
  await reader.searchByTimeRange(from, to, {
    agentId: "agent-a", keyId: ["key-a", "key-group"], workspace: "project-a",
    caseId: "case-a", resolutionStatus: "resolved", phase: "result", affect: "calm",
    includeSuperseded: true, limit: 2
  });
  assert.equal(captured.agentId, "agent-a");
  assert.match(captured.sql, /\(agent_id = \$1 OR agent_id = 'default'\)/);
  for (const clause of ["created_at >= $2", "created_at < $3", "key_id = ANY($4)",
    "(workspace = $5 OR workspace IS NULL)", "case_id = $6", "resolution_status = $7",
    "phase = $8", "ORDER BY created_at DESC", "LIMIT $10"]) {
    assert.ok(captured.sql.includes(clause), clause);
  }
  assert.deepEqual(captured.params, ["agent-a", from, to, ["key-a", "key-group"],
    "project-a", "case-a", "resolved", "result", "calm", 2]);
});

after(async () => {
  mock.restoreAll();
  await teardownTestResources();
  await assertCleanShutdown();
});
