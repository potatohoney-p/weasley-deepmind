import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

let logits;
const model = async () => ({ logits: { data: logits } });
model.config = { id2label: { 0: "entailment", 1: "neutral", 2: "contradiction" } };
mock.module("../../lib/config.js", { namedExports: { NLI_SERVICE_URL: "", NLI_TIMEOUT_MS: 1000 } });
mock.module("../../lib/logger.js", { namedExports: { logInfo() {}, logWarn() {} } });
mock.module("@huggingface/transformers", { namedExports: {
  AutoTokenizer: { from_pretrained: async () => () => ({}) },
  AutoModelForSequenceClassification: { from_pretrained: async () => model }
} });
const { classifyNLI, detectContradiction } = await import("../../lib/memory/signals/NLIClassifier.js");
for (const [name, data] of [["NaN logits", [NaN, 0, 1]], ["infinite logits", [0, Infinity, 1]], ["missing class logits", [0, 1]]]) {
  test(`in-process ${name} defers the decision`, async () => {
    logits = data;
    assert.equal(await classifyNLI("old", "new"), null);
    assert.equal(await detectContradiction("old", "new"), null);
  });
}
test("valid in-process probabilities retain their class mapping", async () => {
  logits = [0, 0, 5];
  const result = await classifyNLI("old", "new");
  assert.equal(result.label, "contradiction");
  assert.ok(result.scores.contradiction > 0.98);
  const decision = await detectContradiction("old", "new");
  assert.equal(decision.contradicts, true);
  assert.equal(decision.needsEscalation, false);
});

after(async () => {
  mock.restoreAll();
  await teardownTestResources();
  await assertCleanShutdown();
});
