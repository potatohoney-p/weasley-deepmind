# Offline correction and retraction recall evaluation

This command runs production `FragmentSearch`, `FragmentStore`/`FragmentReader`,
`FragmentIndex` and content tokenization against synthetic storage boundaries.
It catches stale cached facts after correction, amendment, retraction or deletion
and compares recall under fixed content-token budgets.

Use **Node.js 24** and the repository's installed, locked dependencies. This
development command uses Node's experimental module mocks; the server's Node
20.19 engine requirement is unchanged. Once dependencies are installed, no model
download, embedding provider, database, Redis server or network access is needed.

```bash
node scripts/evaluate-recall.js > current.json
# Equivalent: npm run --silent eval:recall > current.json

node scripts/evaluate-recall.js --variant legacy-cache > legacy.json
# Expected exit 1: the negative control returns stale content.

node scripts/evaluate-recall.js --corpus scripts/recall-eval/fixtures/instrument-revisions.json
```

Exit **0** means every gate passed. Exit **1** preserves a complete JSON report
with failing gates. Exit **2** means malformed input, unsupported arguments,
incomplete/duplicate replay cases or worker failure; it is not a passing report.
The default fixture lives under `scripts/` so packaged installations retain it.

## What the replay does

The independently authored corpus has three instrument scenarios, English,
Korean and Japanese content, 21 events, and 15 checkpoints. Each checkpoint runs
at budgets 8, 32 and 256 on both cold and warm/stale payload caches: **90 cases**.
The query is the same explicit `type: fact` plus scenario `caseId`, not a natural
language question. Each scenario includes an admissible but irrelevant distractor.

1. An ingest child applies the ordered events to synthetic durable rows and calls
   the production index/cache methods. It serializes state after each checkpoint.
   No later event is present in an earlier snapshot. Expected/admissible answer
   labels are withheld from this child; they remain in the evaluator.
2. The ingest process exits successfully. A separately spawned query child reads
   the persisted snapshots and calls production `search()` through the existing
   reader. This is a **synthetic-backend process restart**, not PostgreSQL/Redis
   recovery, a production write-path replay, or an operating-system crash test.
   The two completed sequential child invocations establish the boundary; PID
   uniqueness is not used as proof.
3. For each checkpoint and budget, both cache modes start from a separate copy of
   the same snapshot and inverted-index IDs. Cold clears payloads only. Warm/stale
   retains the original payloads even after row mutation, modeling surviving or
   late stale refill. Each query's side effects are discarded before the next.
4. Production row lookup, scope filtering, ranking and trimming run normally.
   L3, reranking, learning/telemetry and access-write side effects are excluded.
   Only the exact current by-ID SELECT and the fixture's scalar-key/default-agent
   parameter contract are supported by the synthetic DB; changed projections,
   predicates, extra statements or unsupported parameters fail for adapter review.
   It does not parse general SQL. Socket, fetch and subprocess/provider entry points are blocked.
   Workers use a disposable synthetic home and working directory, not caller
   credentials, `.env` files or a user's memory directory.

`legacy-cache` changes only the child's hot-cache reader to trust cached payloads,
matching the previous behavior. It uses the same corpus, indices, ranking,
tokenizer and evaluator. It is a deliberate negative control, never a production
configuration or an alternative provider.

## Report and gates

Reports contain no clock timestamps, PIDs or latency measurements. Repeated runs
of the same corpus/code/dependencies produce identical JSON. `corpusSha256` hashes
the parsed corpus serialized with `JSON.stringify`, including oracle labels.

Each case exposes returned IDs/content, index candidates, search path, budget,
exact content tokens, relevant/expected/returned counts, precision and recall.
The evaluator independently encodes returned content with `cl100k_base` and
compares it with production accounting. It fails if tokenizer initialization is
unavailable rather than substituting chars/4. Tokens cover fragment content only,
not MCP/JSON wrappers, instructions, generated answers or a full model context.
Fixture rows and cached payloads deliberately omit `estimated_tokens`, so this
exercises the production tokenizer path, not behavior with stored or stale token
estimates. This branch builds on the cache-coherence change (#4); it does not
include or claim to retest the separate context/budget fixes in #2.

- A **stale return** has invalid validity metadata or an ID/content pair absent
  from the checkpoint's literal `admissible` oracle.
- **Recall** = exact relevant ID/content matches / expected answers. With no
  expected answer (retracted checkpoint), recall is `null`.
- **Precision** = exact relevant matches / returned fragments. With no returned
  fragment, precision is `null`. Valid distractors lower precision, not safety.
- Budget summaries sum those counts across both cache paths; these are paired
  replays, not independent observations or statistical confidence estimates.
- Safety gates require zero stale returns, content-budget overflows and token
  accounting mismatches. Every expected answer must be recovered at the largest
  configured budget, preventing an empty-result implementation from passing.
- Comparison gates require identical candidates and ordered returned ID/content/
  validity across the paired caches. Missing, duplicate or unknown cases are
  errors, never skipped. Smaller-budget recall loss is reported, not hidden by a
  threshold. The production untagged trimming policy can stop at an oversized
  fragment even if a later smaller fragment could fit.

Default-corpus results on the parent cache-coherence fix:

| Budget | Relevant / expected (both paths) | Recall | Relevant / returned | Precision |
| --- | --- | --- | --- | --- |
| 8 | 4 / 24 | 16.67% | 4 / 6 | 66.67% |
| 32 | 18 / 24 | 75% | 18 / 32 | 56.25% |
| 256 | 24 / 24 | 100% | 24 / 54 | 44.44% |

Current recall has zero stale returns, budget/accounting failures, full-budget
misses or cache differences. The legacy-cache control produces **40 stale returns,
3 full-budget case misses and 28 cache-result differences**, and exits 1.

## Extending the fixture

The version-1 schema accepts exactly three increasing positive integer budgets,
up to ten episodes, forty events and ten checkpoints per episode, and at most
25 unique fragment IDs per episode (below the production hot-cache bound of 30).
Unknown fields, duplicate IDs, invalid positions or nonexistent mutation targets
are rejected. `put` creates a new ID; `amend` changes content; `supersede` marks the
row inactive; `delete` removes it. Restoration uses a new ID. Mutations deliberately
do not refresh old cache payloads.

Write expected and admissible ID/content pairs explicitly at each checkpoint.
`admissible` must exactly equal the current live ID/content set from an independent
event-prefix replay in corpus validation. It cannot bless superseded/deleted or
old amended content, future rows, or omit current distractors. Manually authored
`expected` must be a subset of `admissible`; do not derive gold answers from the
production implementation under evaluation. Choose a largest budget that fits the intended
answers. The file is synthetic and public: “held out” means labels are withheld
from replay workers, not an undisclosed benchmark or a statistically held-out
training/test split.

This does not measure semantic retrieval, language understanding, model quality,
real SQL execution/RLS, cache-service behavior, concurrent-read linearizability,
index freshness or production storage recovery. It complements existing targeted
regressions and live integration/E2E tests. Future evaluation should connect real
storage and semantic adapters only with separately specified datasets and costs.
