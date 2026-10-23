import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FragmentReader } from "../../lib/memory/read/FragmentReader.js";
import { getPrimaryPool } from "../../lib/tools/db.js";
import { teardownTestResources } from "../_lifecycle.js";

const caseId = `temporal-history-${randomUUID()}`;
const reader = new FragmentReader();
let dbAvailable = false;

before(async () => {
  try {
    await getPrimaryPool().query("SELECT 1 FROM agent_memory.fragments LIMIT 0");
  } catch {
    return;
  }
  dbAvailable = true;
  await getPrimaryPool().query(`
    INSERT INTO agent_memory.fragments
      (id, content, content_hash, topic, type, importance, agent_id,
       created_at, valid_to, case_id, workspace)
    VALUES
      ($1, 'current', $1, 'temporal-history', 'fact', 0.5, 'default',
       '2026-01-02T00:00:00Z', NULL, $3, 'temporal-test'),
      ($2, 'expired', $2, 'temporal-history', 'fact', 0.5, 'default',
       '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z', $3, 'temporal-test')`,
  [`${caseId}-current`, `${caseId}-expired`, caseId]);
});

test("production temporal reader includes superseded history only on request, before LIMIT", async (t) => {
  if (!dbAvailable) return t.skip("PostgreSQL unavailable; not validated by this run");
  const from = new Date("2026-01-01T00:00:00Z");
  const to = new Date("2026-02-01T00:00:00Z");
  const options = { caseId, workspace: "temporal-test", limit: 1 };
  const current = await reader.searchByTimeRange(from, to, options);
  assert.deepEqual(current.map(row => row.id), [`${caseId}-current`]);
  const history = await reader.searchByTimeRange(from, to, { ...options, includeSuperseded: true });
  assert.deepEqual(history.map(row => row.id), [`${caseId}-expired`]);
  const outsideRange = await reader.searchByTimeRange(to, null, { ...options, includeSuperseded: true });
  assert.deepEqual(outsideRange, []);
});

after(async () => {
  try {
    if (dbAvailable) {
      await getPrimaryPool().query("DELETE FROM agent_memory.fragments WHERE case_id = $1", [caseId]);
    }
  } finally {
    await teardownTestResources();
  }
});
