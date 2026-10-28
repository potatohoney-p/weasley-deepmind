import { after, mock, test } from "node:test";
import assert from "node:assert/strict";

let client;
mock.module("../../lib/tools/db.js", { namedExports: { getPrimaryPool: () => ({ connect: async () => client }), shutdownPool: async () => {} } });
const { reconsolidate } = await import("../../lib/memory/link/ReconsolidationEngine.js");
const { assertCleanShutdown, teardownTestResources } = await import("../_lifecycle.js");
after(async () => { await teardownTestResources(); await assertCleanShutdown(); mock.restoreAll(); });
let nextId = 81000;

for (const [action, weight, confidence, newWeight, newConfidence] of [
  ["reinforce", 1.95, "0.980", 2, "1.000"],
  ["decay", 0.05, "0.040", 0, "0.000"],
  ["quarantine", 0.1, "0.000", 0, "0.000"],
  ["restore", 1.9, "1.000", 2, "1.000"],
  ["soft_delete", 1, "0.500", 1, "0.500"],
]) {
  test(`${action}: audit preserves actual locked values at clamp boundaries`, async () => {
    const id = nextId++;
    const calls = [];
    let released = false;
    client = { release() { released = true; }, async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT/.test(sql)) {
        assert.match(sql, /FOR UPDATE/);
        assert.match(sql, /deleted_at IS NULL/);
        assert.deepEqual(params, [id]);
        return { rows: [{ weight, confidence }] };
      }
      if (/UPDATE agent_memory/.test(sql)) return { rows: [{ id, new_weight: newWeight, new_confidence: newConfidence, old_weight: -999, old_confidence: "-999" }] };
      return { rows: [] };
    } };
    const result = await reconsolidate(id, action, { triggeredBy: "fixture", keyId: "key-fixture" });
    assert.equal(result.old_weight, weight);
    assert.equal(result.old_confidence, confidence);
    const audit = calls.find(x => /INSERT INTO/.test(x.sql));
    assert.deepEqual(audit.params, [id, action, weight, newWeight, confidence, newConfidence, "fixture", "fixture", "key-fixture"]);
    assert.ok(calls.findIndex(x => /SELECT/.test(x.sql)) < calls.findIndex(x => /UPDATE agent_memory/.test(x.sql)));
    assert.equal(calls.at(-1).sql, "COMMIT");
    assert.equal(released, true);
  });
}

test("missing/deleted target rolls back without an update or audit", async () => {
  const calls = [];
  client = { release() {}, async query(sql) { calls.push(sql); return { rows: [] }; } };
  assert.equal(await reconsolidate(nextId++, "reinforce"), null);
  assert.ok(calls.some(sql => /SELECT/.test(sql)));
  assert.ok(!calls.some(sql => /UPDATE agent_memory|INSERT INTO/.test(sql)));
  assert.equal(calls.at(-1), "ROLLBACK");
});

for (const stage of ["SELECT", "UPDATE agent_memory", "INSERT INTO"]) {
  test(`${stage} failure rolls back, releases and propagates`, async () => {
    const calls = [];
    const error = new Error("injected storage failure");
    let released = false;
    client = { release() { released = true; }, async query(sql) {
      calls.push(sql);
      if (sql.includes(stage)) throw error;
      return { rows: [{ weight: 1, confidence: "0.500", id: 1, new_weight: 1.2, new_confidence: "0.550" }] };
    } };
    await assert.rejects(reconsolidate(nextId++, "reinforce"), e => e === error);
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(released, true);
    assert.ok(!calls.includes("COMMIT"));
  });
}
