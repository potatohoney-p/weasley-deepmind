import { mock, test } from "node:test";
import assert from "node:assert/strict";

let response;
let available = true;
const reads = [];
const writes = [];
mock.module("../../lib/redis.js", { namedExports: {
  popFromQueue: async () => null, getQueueLength: async () => 0
} });
mock.module("../../lib/memory/MemoryManager.js", { namedExports: {
  MemoryManager: { getInstance: () => ({ store: {
    getById: async (...args) => { reads.push(args); return { keywords: ["original"] }; },
    update: async (...args) => { writes.push(args); }
  } }) }
} });
mock.module("../../lib/gemini.js", { namedExports: {
  geminiCLIJson: async () => response, isGeminiCLIAvailable: async () => available
} });
mock.module("../../lib/logger.js", { namedExports: {
  logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {}
} });
const { MemoryEvaluator } = await import("../../lib/memory/signals/MemoryEvaluator.js");
const valid = { score: 0.8, action: "keep", rationale: "Reusable knowledge" };
async function evaluate(value) {
  response = value; reads.length = 0; writes.length = 0;
  await new MemoryEvaluator().evaluate({ fragmentId: "memory", agentId: "worker", type: "fact", content: "A durable fact" });
}
for (const [label, value] of [
  ["null", null], ["array", [valid]], ["primitive", "keep"],
  ["missing score", { action: "keep", rationale: "reason" }],
  ["numeric string", { ...valid, score: "0.8" }],
  ["NaN", { ...valid, score: NaN }], ["Infinity", { ...valid, score: Infinity }],
  ["negative score", { ...valid, score: -0.1 }], ["score above one", { ...valid, score: 1.1 }],
  ["missing action", { score: 0.8, rationale: "reason" }],
  ["unknown action", { ...valid, action: "delete" }],
  ["missing rationale", { score: 0.8, action: "keep" }],
  ["object rationale", { ...valid, rationale: { reason: "useful" } }],
  ["blank rationale", { ...valid, rationale: "  \n " }]
]) {
  test(`malformed evaluation ${label} leaves durable memory untouched`, async () => {
    await evaluate(value);
    assert.deepEqual(writes, []);
    assert.deepEqual(reads, []);
  });
}
for (const [action, score, importance, verified] of [
  ["keep", 1, 1, true], ["downgrade", 0.5, 0.3, false], ["discard", 0, 0.1, false]
]) {
  test(`valid ${action} preserves existing update semantics`, async () => {
    await evaluate({ score, action, rationale: "Evidence worth keeping" });
    assert.deepEqual(reads, [["memory", "worker", null, []]]);
    assert.deepEqual(writes, [["memory", { importance, quality_verified: verified,
      keywords: ["original", "Rationale: Evidence worth keeping"] }, "worker"]]);
  });
}
test("unavailable provider still leaves memory untouched", async () => {
  available = false;
  try { await evaluate(valid); assert.deepEqual(writes, []); assert.deepEqual(reads, []); }
  finally { available = true; }
});
