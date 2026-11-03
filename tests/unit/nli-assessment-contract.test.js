import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";
import http from "node:http";

let server;
let payload;
let classifyNLI;
let detectContradiction;
const valid = { label: "contradiction", scores: { contradiction: 0.9, entailment: 0.05, neutral: 0.05 } };
before(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("Connection", "close");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  mock.module("../../lib/config.js", { namedExports: {
    NLI_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, NLI_TIMEOUT_MS: 2000
  } });
  mock.module("../../lib/logger.js", { namedExports: { logInfo() {}, logWarn() {} } });
  ({ classifyNLI, detectContradiction } = await import("../../lib/memory/signals/NLIClassifier.js"));
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  mock.restoreAll();
  await teardownTestResources();
  await assertCleanShutdown();
});

for (const [name, value] of [
  ["null", null], ["array", [valid]], ["primitive", "contradiction"],
  ["missing scores", { label: "neutral" }], ["null scores", { label: "neutral", scores: null }],
  ["missing contradiction", { label: "neutral", scores: { neutral: 1, entailment: 0 } }],
  ["missing neutral", { label: "contradiction", scores: { contradiction: 1, entailment: 0 } }],
  ["coerced contradiction", { ...valid, scores: { ...valid.scores, contradiction: "0.9" } }],
  ["boolean entailment", { ...valid, scores: { ...valid.scores, entailment: true } }],
  ["null score", { ...valid, scores: { ...valid.scores, neutral: null } }],
  ["out-of-range score", { ...valid, scores: { ...valid.scores, contradiction: 9 } }],
  ["negative score", { ...valid, scores: { ...valid.scores, neutral: -0.1 } }],
  ["unknown label", { ...valid, label: "positive" }], ["missing label", { scores: valid.scores }]
]) {
  test(`malformed ${name} returns null rather than a contradiction decision`, async () => {
    payload = value;
    assert.equal(await classifyNLI("old memory", "new memory"), null);
    assert.equal(await detectContradiction("old memory", "new memory"), null);
  });
}
for (const [label, scores, expected] of [
  ["contradiction", { contradiction: 1, entailment: 0, neutral: 0 }, { contradicts: true, confidence: 1, needsEscalation: false }],
  ["entailment", { contradiction: 0, entailment: 1, neutral: 0 }, { contradicts: false, confidence: 1, needsEscalation: false }],
  ["neutral", { contradiction: 0.3, entailment: 0.1, neutral: 0.6 }, { contradicts: false, confidence: 0.6, needsEscalation: true }]
]) {
  test(`valid ${label} retains existing threshold semantics`, async () => {
    payload = { label, scores };
    assert.deepEqual(await classifyNLI("old", "new"), payload);
    assert.deepEqual(await detectContradiction("old", "new"), { ...expected, scores });
  });
}
