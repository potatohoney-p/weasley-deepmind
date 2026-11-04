# Graph recall query filters

## Behavior

The L2.5 graph stage of text recall now forwards `caseId`, `resolutionStatus`,
`phase` and `affect` into `fetchGraphNeighbors`. Both link directions bind these
predicates before distinct-neighbor weight ordering and the shared ten-neighbor
cap. All four metadata columns survive the SQL projection so the existing
`SearchScope` check can retain matching memories before reciprocal rank fusion.

Previously, graph SQL omitted these columns, so valid filtered text queries
rejected even matching graph candidates. Merely restoring columns would leave a
second problem: ten higher-weight mismatches could consume the cap before the
matching candidate reached the defensive filter.

Scalar and array affect filters preserve the existing SearchScope semantics;
an empty array admits no graph candidate. Unfiltered calls keep the original
selection, including cross-case neighbors. Seed exclusion, distinct IDs, active
edges/current fragments, key/agent/workspace conditions, global weight ordering
and post-selection relation boosts are unchanged.

This addresses the L2.5 stage in `FragmentSearch`/`GraphNeighborSearch`, separate
from the later `MemoryRecaller`/`LinkStore` expansion in draft #57. No schema,
public tool parameter, dependency, write path or workflow changes are required.

## Verification

- Nine production-function unit checks cover both directional predicates,
  bound parameter positions, scalar/array/empty affect, projected metadata,
  combined options and unchanged active-edge/current-fragment gates. On main
  `762f5c7`, eight fail and the unchanged-behavior control passes. All nine pass
  after the fix; the three existing graph-limit checks also pass.
- Eleven database acceptance tests cover each filter in both directions, ten
  stronger mismatches before a matching neighbor, missing metadata, combined
  predicates, affect arrays and production text-RRF composition. Existing
  graph-limit tests cover weight ties, deduplication, workspace/agent conditions,
  inactive fragments and deleted edges.
- A local PGlite 0.5.15 + pgvector 0.0.16 fixture applies the untouched base schema
  and all 37 migrations, then runs the checked-in acceptance file with only its
  database transport replaced. All eleven cases fail on main and pass with the
  fix, without skips. This is embedded PostgreSQL evidence, not native hosted
  PostgreSQL acceptance.
- Full local `npm run test:ci`: 2,540 unit passed / two existing skips;
  54 offline integration passed / 32 database/environment-dependent skips,
  including the eleven new acceptance cases. No failures.
- Strict changed-file ESLint, migration lint and diff checks pass. Full ESLint
  reports zero errors / 124 existing warnings; changed files have zero warnings.
- Package dry-run passes (355 files). Offline recall evaluation passes all
  90 cases with zero stale returns, budget/accounting violations or full-budget
  misses. These existing fixtures do not measure the new graph-filter behavior.
- Independent read-only review found no blocker and independently reran
  34 focused graph/scope checks plus all eleven migrated PGlite acceptance cases.

## Limits

The text-RRF acceptance isolates keyword and vector candidate retrieval, then
uses production graph SQL, scope filtering and RRF. It does not exercise real
embedding/reranker providers, Redis, the MCP transport or production RLS. Tests
establish candidate eligibility, not a measured semantic-quality improvement.

Graph retrieval remains bounded and current-only. This change does not add
exhaustive retrieval, historical graph expansion, other filter types, atomic
snapshots with concurrent changes, database-performance guarantees or repairs
to existing stored rows. Case-summary/event enrichment is outside this scope.
