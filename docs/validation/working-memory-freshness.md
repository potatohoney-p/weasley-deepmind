# Durable Working Memory context

## Defect and acceptance

`ContextBuilder` previously injected the content and metadata serialized into Redis
when a memory entered a session. A later durable amendment, deletion, supersession,
workspace move or anchor change did not refresh that snapshot. The ordinary recall
hot-cache validation does not cover this separate Working Memory path.

Treat session snapshots as candidate IDs. Load current rows through the existing
`FragmentReader.getByIds` API with the normalized agent/key/group scope. Apply the
current workspace and agent scope, validity and anchor flags before the existing
Working Memory character/count limits. Preserve newest-ID order, deduplicate IDs
and ignore ID-less snapshots. Do not fall back to stale contents after a durable
read failure, or mark any result seen when hydration fails.

Each SELECT contains at most 30 IDs. Continue past missing or ineligible candidates
until the existing result/character cap or the candidate list ends. This bounds
individual queries, not total Redis list size, candidate scan or worst-case latency.
No Redis mutation, schema, permissions, provider or API parameter changes.

## Reproduction

Run with Node 24 and the locked dependencies:

```sh
npm ci --ignore-scripts
DOTENV_CONFIG_PATH=.env.test WEASLEY_DEEPMIND_METRICS_DEFAULT=off \
REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test tests/unit/context-working-memory-*.test.js
npm test
```

The 13 context regressions on main `956b122` fail 12 / pass 1. After hydration all
13 pass. An additional actual-reader test also fails on unchanged main (14 total: 13 fail / 1 pass) and checks generated SQL and bound agent,
key/group and current-validity predicates through a synthetic database boundary.
An existing Working Memory fixture now supplies a durable row, rather than relying
on cached payloads as authoritative. No existing assertion is removed.

## Limits

The tests execute production context and reader code with synthetic storage; they
are not live Redis/PostgreSQL/RLS or model-quality/performance evidence. A durable
read overlapping mutation is not a linearizable snapshot of the whole context.
Core/anchor/learning loading, seen-ID writes and Redis list maintenance are unchanged.
The existing 3,200-character Working Memory cap is preserved, including stopping
at an oversized current item. General content-token budgeting remains separate.
Current anchors are excluded from Working Memory and remain the anchor loader's
responsibility. Cache-only/ID-less memories are no longer injected. Context can
now fail when durable hydration is unavailable instead of returning stale facts.

## Final local evidence

- Full units: 2,288 passed / 2 existing skips / 0 failures.
- Changed-file strict ESLint passes; full lint has 0 errors / 126 existing warnings.
- Broad integration remains 50 passed / 4 failures / 4 skips, the same reflect
  database and three session-authentication failures on pristine main.
- Independent review: all 14 focused tests and 11 additional edge probes pass.
- Scratch composition with PRs #2 and #4 requires two ContextBuilder conflict
  resolutions (imports and the scoped call retaining #2's loadedWorking binding)
  and durable-row test fixtures. Raw full run: 2,316 passed / 1 failed / 2 skipped.
  The sole failure is #2's legacy expectation that two ID-less Working Memory
  payloads remain injectable, which conflicts with this intentional durable-only
  contract. Neither existing published PR was modified. The raw failure is not
  reported as a clean merge or a green unmodified composition.

Dependencies were installed with lifecycle scripts disabled; native ONNX and
live model execution are not validated. Hosted CI is separate from local evidence.

A second scratch composition run explicitly migrates only that legacy ID-less
Working Memory expectation to exclusion: 2,317 passed / 2 skips / 0 failures.
This adapted result does not erase the recorded raw compatibility failure.
