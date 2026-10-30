import { after, test } from "node:test";
import assert from "node:assert/strict";
import { HistoryReconstructor } from "../../lib/memory/read/HistoryReconstructor.js";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const fragment = (id, status = "open") => ({ id, content: id, resolution_status: status });
const link = (from_id, to_id, relation_type = "caused_by") => ({ from_id, to_id, relation_type });
const ids = chain => chain.chain.map(f => f.id);

async function reconstruct(fragments, links) {
  const reader = new HistoryReconstructor(null, null);
  reader._fetchTimelineParameterized = async () => fragments;
  reader._fetchLinks = async () => links;
  return reader.reconstruct({ caseId: "cyclic-history" });
}

test("a rootless causal cycle remains a chain rather than unrelated supporting evidence", async () => {
  const result = await reconstruct([fragment("a"), fragment("b")], [link("a", "b"), link("b", "a")]);
  assert.equal(result.causal_chains.length, 1);
  assert.deepEqual(ids(result.causal_chains[0]), ["a", "b"]);
  assert.deepEqual(result.supporting_fragments, []);
  assert.deepEqual(result.unresolved_branches.map(f => f.id), ["a", "b"]);
});

test("a self-loop terminates and retains its one fragment exactly once", async () => {
  const result = await reconstruct([fragment("a")], [link("a", "a")]);
  assert.equal(result.causal_chains.length, 1);
  assert.deepEqual(ids(result.causal_chains[0]), ["a"]);
  assert.equal(result.causal_chains[0].length, 1);
});

test("disconnected cycles are retained alongside natural-root chains", async () => {
  const result = await reconstruct(["r", "s", "a", "b", "x", "y", "alone"].map(id => fragment(id)), [
    link("r", "s"), link("a", "b"), link("b", "a"), link("x", "y"), link("y", "x")
  ]);
  assert.deepEqual(result.causal_chains.map(ids), [["r", "s"], ["a", "b"], ["x", "y"]]);
  assert.deepEqual(result.supporting_fragments.map(f => f.id), ["alone"]);
});

test("a cycle with an outgoing resolution retains existing resolution classification", async () => {
  const result = await reconstruct([fragment("a"), fragment("b"), fragment("fixed", "resolved")], [
    link("a", "b"), link("b", "a"), link("b", "fixed", "resolved_by")
  ]);
  assert.deepEqual(result.causal_chains.map(ids), [["a", "b", "fixed"]]);
  assert.equal(result.causal_chains[0].is_resolved, true);
  assert.deepEqual(result.unresolved_branches, []);
});

test("a rooted cycle is not traversed again as a fallback component", async () => {
  const result = await reconstruct(["root", "a", "b"].map(id => fragment(id)), [
    link("root", "a"), link("a", "b"), link("b", "a"), link("a", "b")
  ]);
  assert.deepEqual(result.causal_chains.map(ids), [["root", "a", "b"]]);
  assert.deepEqual(result.causal_chains[0].chain.map(f => f._chain_position), [0, 1, 2]);
});

test("distinct natural roots preserve their shared tail in both chains", async () => {
  const result = await reconstruct(["r1", "r2", "tail"].map(id => fragment(id)), [link("r1", "tail"), link("r2", "tail")]);
  assert.deepEqual(result.causal_chains.map(ids), [["r1", "tail"], ["r2", "tail"]]);
});

test("non-causal cycles do not become causal chains", async () => {
  const result = await reconstruct([fragment("a"), fragment("b")], [link("a", "b", "related"), link("b", "a", "related")]);
  assert.deepEqual(result.causal_chains, []);
  assert.deepEqual(result.supporting_fragments.map(f => f.id), ["a", "b"]);
});
