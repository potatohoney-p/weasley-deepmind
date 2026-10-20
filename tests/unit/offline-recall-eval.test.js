import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";
import { runEvaluation, scoreReplay } from "../../scripts/recall-eval/evaluate.js";
import { replayEpisodes, validateCorpus } from "../../scripts/recall-eval/corpus.js";
import { readSyntheticRows } from "../../scripts/recall-eval/synthetic-reader.js";

after(async () => {
  const { assertCleanShutdown, teardownTestResources } = await import("../_lifecycle.js");
  await teardownTestResources();
  await assertCleanShutdown();
});

const correction = {
  version: 1,
  name: "correction-tracer",
  budgets: [4, 32, 256],
  episodes: [{
    id: "calibration",
    language: "en",
    events: [
      { op: "put", id: "old", content: "Calibration uses the copper gauge." },
      { op: "put", id: "new", content: "Calibration now uses the silver gauge." },
      { op: "supersede", id: "old" }
    ],
    checkpoints: [{
      id: "corrected",
      after: 3,
      expected: [{ id: "new", content: "Calibration now uses the silver gauge." }],
      admissible: [{ id: "new", content: "Calibration now uses the silver gauge." }]
    }]
  }]
};

describe("offline production recall evaluation", () => {
test("fresh-process production recall rejects a stale correction that the legacy cache mutant returns", async () => {
  const report = await runEvaluation(correction);
  assert.equal(report.passed, true);
  assert.equal(report.restart.ingestExitedBeforeQuery, true);
  assert.equal(report.restart.childInvocations, 2);
  assert.equal(report.cases.length, 6);
  assert.equal(report.summary.staleReturns, 0);
  const legacy = await runEvaluation(correction, { variant: "legacy-cache" });
  assert.equal(legacy.passed, false);
  assert.ok(legacy.summary.staleReturns > 0);
  assert.ok(legacy.cases.some(row => row.cache === "warm-stale" && row.staleIds.includes("old")));
});

test("a report cannot silently drop, duplicate, or invent a case", () => {
  const results = correction.budgets.flatMap(budget => ["cold", "warm-stale"].map(cache => ({
    episode: "calibration", checkpoint: "corrected", budget, cache,
    candidateIds: ["old", "new"], fragments: [], totalTokens: 0, contentTokens: 0
  })));
  const empty = scoreReplay(correction, results);
  assert.equal(empty.summary.fullBudgetMisses, 2);
  assert.equal(empty.passed, false, "empty retrieval must not pass only because it returns no stale facts");
  assert.equal(empty.cases[0].recall, 0);
  assert.equal(empty.cases[0].precision, null);
  assert.throws(() => scoreReplay(correction, results.slice(1)), /case coverage/);
  assert.throws(() => scoreReplay(correction, [...results, results[0]]), /case coverage/);
  assert.throws(() => scoreReplay(correction, [{ ...results[0], checkpoint: "unknown" }, ...results.slice(1)]), /case coverage/);
});

test("corpus validation rejects ambiguous inputs and keeps oracle labels out of replay", () => {
  validateCorpus(correction);
  const replay = replayEpisodes(correction);
  assert.deepEqual(replay[0].checkpoints, [{ id: "corrected", after: 3 }]);
  assert.equal(JSON.stringify(replay).includes('"expected"'), false);
  for (const mutate of [
    corpus => { corpus.budgets = [0, 4, 32]; },
    corpus => { corpus.budgets = [4, 4, 32]; },
    corpus => { corpus.episodes.push(corpus.episodes[0]); },
    corpus => { corpus.episodes[0].checkpoints[0].after = 99; },
    corpus => { corpus.episodes[0].events[0].answer = "leaked"; },
    corpus => { corpus.episodes[0].events[0].op = "unknown"; }
  ]) {
    const corpus = structuredClone(correction);
    mutate(corpus);
    assert.throws(() => validateCorpus(corpus), /Invalid corpus/);
  }
});

test("CLI produces reproducible paired multilingual reports and exposes low-budget loss", async () => {
  const path = fileURLToPath(new URL("../../scripts/evaluate-recall.js", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [path, ...args], { encoding: "utf8", timeout: 60000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, "report contains no timestamps, PIDs or measured latency");
  const report = JSON.parse(first.stdout);
  assert.equal(report.summary.evaluated, 90);
  assert.deepEqual(report.summary.byBudget.map(row => row.expected), [24, 24, 24]);
  assert.equal(report.summary.byBudget[2].recall, 1);
  assert.ok(report.summary.byBudget[0].recall < 1);
  assert.deepEqual(new Set(report.cases.map(row => row.language)), new Set(["en", "ko", "ja"]));
  assert.equal(report.summary.cacheResultDifferences, 0);
  assert.ok(report.cases.filter(row => row.checkpoint === "initial").every(row =>
    row.candidateIds.every(id => id.endsWith("-old") || id.endsWith("-note"))));
  const encoder = getEncoding("cl100k_base");
  for (const row of report.cases) {
    assert.equal(row.contentTokens, row.fragments.reduce((sum, fragment) => sum + encoder.encode(fragment.content).length, 0));
    assert.ok(row.contentTokens <= row.budget);
  }
  const mutant = run("--variant", "legacy-cache");
  assert.equal(mutant.status, 1, mutant.stderr);
  assert.ok(JSON.parse(mutant.stdout).summary.staleReturns > 0);
  const invalid = run("--variant", "unknown");
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  const badFlag = run("--unknown", "yes");
  assert.equal(badFlag.status, 2);
  const corpus = JSON.parse(readFileSync(new URL("../../scripts/recall-eval/fixtures/instrument-revisions.json", import.meta.url)));
  assert.equal(corpus.episodes.reduce((sum, episode) => sum + episode.events.length, 0), 21);
});

test("report oracle checks exact current content, validity and actual tokens", () => {
  const results = correction.budgets.flatMap(budget => ["cold", "warm-stale"].map(cache => ({
    episode: "calibration", checkpoint: "corrected", budget, cache,
    candidateIds: ["old", "new"], fragments: [{ id: "new", content: "wrong content", valid_to: null }],
    totalTokens: 999, contentTokens: 999
  })));
  const report = scoreReplay(correction, results);
  assert.equal(report.summary.staleReturns, 6);
  assert.equal(report.summary.tokenAccountingMismatches, 6);
  assert.equal(report.summary.fullBudgetMisses, 2);
  assert.equal(report.passed, false);
  const duplicate = structuredClone(results);
  duplicate[0].fragments.push(duplicate[0].fragments[0]);
  assert.throws(() => scoreReplay(correction, duplicate), /duplicate fragments/);
});

test("offline workers block network and subprocess provider entry points before use", () => {
  const guardUrl = new URL("../../scripts/recall-eval/offline-guards.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { request } from "node:http";
    import https from "node:https";
    import net from "node:net";
    import tls from "node:tls";
    import { spawn } from "node:child_process";
    import { installOfflineGuards } from ${JSON.stringify(guardUrl)};
    const fail = () => { throw new Error("offline boundary blocked"); };
    installOfflineGuards(fail);
    for (const operation of [() => fetch(), () => request(), () => https.get(),
      () => net.connect(), () => new net.Socket().connect(), () => tls.connect(), () => spawn()]) {
      assert.throws(operation, /offline boundary blocked/);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("oracle labels must exactly describe current event-prefix content, never past or future rows", () => {
  for (const mutation of [
    { op: "supersede", id: "old" },
    { op: "delete", id: "old" },
    { op: "amend", id: "old", content: "The value is silver." }
  ]) {
    const bad = structuredClone(correction);
    bad.episodes[0].events = [{ op: "put", id: "old", content: "The value is copper." }, mutation];
    bad.episodes[0].checkpoints = [{
      id: "invalid-oracle", after: 2,
      expected: [{ id: "old", content: "The value is copper." }],
      admissible: [{ id: "old", content: "The value is copper." }]
    }];
    assert.throws(() => validateCorpus(bad), /oracle.*event prefix/);
  }
  const prefix = structuredClone(correction);
  prefix.episodes[0].checkpoints[0].after = 1;
  assert.throws(() => validateCorpus(prefix), /oracle.*event prefix/, "future correction is not current at the first event");
  prefix.episodes[0].checkpoints[0].expected = [{ id: "old", content: "Calibration uses the copper gauge." }];
  prefix.episodes[0].checkpoints[0].admissible = [...prefix.episodes[0].checkpoints[0].expected];
  assert.doesNotThrow(() => validateCorpus(prefix));
  const empty = structuredClone(prefix);
  empty.episodes[0].events = [{ op: "put", id: "old", content: "Calibration uses the copper gauge." }, { op: "delete", id: "old" }];
  empty.episodes[0].checkpoints = [{ id: "empty", after: 2, expected: [], admissible: [] }];
  assert.doesNotThrow(() => validateCorpus(empty));
  const omitted = structuredClone(correction);
  omitted.episodes[0].checkpoints[0].expected = [];
  omitted.episodes[0].checkpoints[0].admissible = [];
  assert.throws(() => validateCorpus(omitted), /oracle.*event prefix/, "valid current rows cannot be omitted from admissible");
});

test("synthetic reader rejects changed predicates, extra statements and unsupported parameter scopes", () => {
  const sql = `SELECT id, content, topic, keywords, type, importance, utility_score,
    source, linked_to, agent_id, key_id, affect, access_count,
    accessed_at, created_at, ttl_tier, verified_at, is_anchor, valid_to,
    context_summary, session_id, workspace,
    case_id, goal, outcome, phase, resolution_status, assertion_status
    FROM agent_memory.fragments
    WHERE id = ANY($1) AND (agent_id = $2 OR agent_id = 'default') AND valid_to IS NULL
    AND (key_id IS NOT DISTINCT FROM $3 OR key_id = ANY($4::text[]))
    ORDER BY importance DESC, accessed_at DESC NULLS LAST`;
  const params = [["wanted"], "default", "offline-synthetic", ["offline-synthetic"]];
  assert.deepEqual(readSyntheticRows([], "default", sql, params), { rows: [] });
  for (const changed of [
    sql + "; DELETE FROM agent_memory.fragments",
    sql.replace("AND valid_to IS NULL", ""),
    sql.replace("WHERE id = ANY($1)", "WHERE id = ANY($1) AND importance > 0.9"),
    sql.replace("SELECT id,", "SELECT id, embedding,")
  ]) assert.throws(() => readSyntheticRows([], "default", changed, params), /Unsupported synthetic/);
  for (const changed of [null, [...params, "extra"], [params[0], "peer", params[2], params[3]],
    [params[0], "default", null, []], [["wanted", "wanted"], ...params.slice(1)]]) {
    assert.throws(() => readSyntheticRows([], "default", sql, changed), /Unsupported synthetic/);
  }
});
});
