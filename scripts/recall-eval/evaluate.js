import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { replayEpisodes, validateCorpus } from "./corpus.js";

const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
const encoder = getEncoding("cl100k_base"); // Fail explicitly, never use chars/4.

function worker(input) {
  // Deliberately omit caller credentials/provider configuration and NODE_OPTIONS.
  const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP"].flatMap(key =>
    process.env[key] ? [[key, process.env[key]]] : []));
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", workerPath], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    cwd: dirname(input.snapshotPath),
    env: {
      HOME: dirname(input.snapshotPath), USERPROFILE: dirname(input.snapshotPath),
      WEASLEY_DEEPMIND_HOME: dirname(input.snapshotPath),
      ...env, DOTENV_CONFIG_PATH: fileURLToPath(new URL("./no-dotenv", import.meta.url)),
      WEASLEY_DEEPMIND_METRICS_DEFAULT: "off", REDIS_ENABLED: "false", CACHE_ENABLED: "false",
      EMBEDDING_ENABLED: "false", WEASLEY_DEEPMIND_SYMBOLIC_ENABLED: "false"
    }
  });
  if (child.error || child.status !== 0) throw new Error(`Offline worker failed: ${child.error?.message ?? child.stderr}`);
  return JSON.parse(child.stdout);
}

export async function runEvaluation(corpus, { variant = "current" } = {}) {
  validateCorpus(corpus);
  if (!["current", "legacy-cache"].includes(variant)) throw new Error("Unknown variant");
  const dir = mkdtempSync(join(tmpdir(), "weasley-recall-eval-"));
  if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error("Unexpected temporary directory");
  try {
    const snapshotPath = join(dir, "state.json");
    // Checkpoint answers never cross the child-process boundary.
    const episodes = replayEpisodes(corpus);
    const ingest = worker({ mode: "ingest", episodes, snapshotPath });
    if (ingest.snapshots !== episodes.reduce((sum, episode) => sum + episode.checkpoints.length, 0)) {
      throw new Error("Invalid replay: incomplete persisted checkpoints");
    }
    const query = worker({ mode: "query", snapshotPath, budgets: corpus.budgets, variant });
    const report = scoreReplay(corpus, query.results);
    return {
      version: 1, corpus: corpus.name, variant, tokenizer: "cl100k_base",
      corpusSha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
      // Two successful, sequential spawnSync invocations establish the process
      // boundary. PID uniqueness is not evidence (operating systems can reuse it).
      restart: { ingestExitedBeforeQuery: true, childInvocations: 2 },
      ...report
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Score the complete paired replay; missing/duplicate cases are errors, not skips. */
export function scoreReplay(corpus, results) {
  validateCorpus(corpus);
  const caseKey = row => JSON.stringify([row.episode, row.checkpoint, row.budget, row.cache]);
  const wanted = new Set(corpus.episodes.flatMap(episode => episode.checkpoints.flatMap(checkpoint =>
    corpus.budgets.flatMap(budget => ["cold", "warm-stale"].map(cache => caseKey({
      episode: episode.id, checkpoint: checkpoint.id, budget, cache
    }))))));
  if (!Array.isArray(results) || results.length !== wanted.size ||
    new Set(results.map(caseKey)).size !== wanted.size || results.some(row => !wanted.has(caseKey(row)))) {
    throw new Error("Invalid replay: case coverage must match every checkpoint, budget and cache path exactly");
  }
  const cases = results.map(result => {
      if (!Array.isArray(result.fragments) || !Array.isArray(result.candidateIds) ||
        result.fragments.some(row => typeof row.id !== "string" || typeof row.content !== "string") ||
        new Set(result.fragments.map(row => row.id)).size !== result.fragments.length) {
        throw new Error("Invalid replay: malformed or duplicate fragments");
      }
      const episode = corpus.episodes.find(item => item.id === result.episode);
      const gold = episode.checkpoints.find(item => item.id === result.checkpoint);
      const tokens = result.fragments.reduce((sum, row) => sum + encoder.encode(row.content).length, 0);
      const relevant = result.fragments.filter(row => gold.expected.some(want => row.id === want.id && row.content === want.content));
      const staleIds = result.fragments.filter(row => row.valid_to != null ||
        !gold.admissible.some(want => want.id === row.id && want.content === row.content)).map(row => row.id);
      return {
        ...result, language: episode.language, expectedCount: gold.expected.length,
        relevantCount: relevant.length, returnedCount: result.fragments.length,
        recall: gold.expected.length ? relevant.length / gold.expected.length : null,
        precision: result.fragments.length ? relevant.length / result.fragments.length : null,
        staleIds, budgetViolation: tokens > result.budget,
        tokenAccountingMismatch: tokens !== result.totalTokens || tokens !== result.contentTokens
      };
    }).sort((a, b) => caseKey(a).localeCompare(caseKey(b), "en"));
  const fullBudget = corpus.budgets.at(-1);
  const pairs = cases.filter(row => row.cache === "cold").map(cold => {
    const warm = cases.find(row => row.episode === cold.episode && row.checkpoint === cold.checkpoint &&
      row.budget === cold.budget && row.cache === "warm-stale");
    return {
      episode: cold.episode, checkpoint: cold.checkpoint, budget: cold.budget,
      sameCandidates: JSON.stringify(cold.candidateIds) === JSON.stringify(warm.candidateIds),
      sameReturnedContent: JSON.stringify(cold.fragments) === JSON.stringify(warm.fragments),
      recallDelta: cold.recall === null ? null : warm.recall - cold.recall
    };
  });
  const summary = {
      evaluated: cases.length,
      staleReturns: cases.reduce((sum, row) => sum + row.staleIds.length, 0),
      budgetViolations: cases.filter(row => row.budgetViolation).length,
      tokenAccountingMismatches: cases.filter(row => row.tokenAccountingMismatch).length,
      fullBudgetMisses: cases.filter(row => row.budget === fullBudget && row.relevantCount < row.expectedCount).length,
      candidateMismatches: pairs.filter(row => !row.sameCandidates).length,
      cacheResultDifferences: pairs.filter(row => !row.sameReturnedContent).length,
      byBudget: corpus.budgets.map(budget => {
        const selected = cases.filter(row => row.budget === budget);
        const relevant = selected.reduce((sum, row) => sum + row.relevantCount, 0);
        const expected = selected.reduce((sum, row) => sum + row.expectedCount, 0);
        const returned = selected.reduce((sum, row) => sum + row.returnedCount, 0);
        return {
          budget, cases: selected.length, relevant, expected, returned,
          recall: expected ? relevant / expected : null, precision: returned ? relevant / returned : null
        };
      })
    };
  return {
    passed: ["staleReturns", "budgetViolations", "tokenAccountingMismatches", "fullBudgetMisses",
      "candidateMismatches", "cacheResultDifferences"].every(key => summary[key] === 0),
    summary, pairs, cases
  };
}
