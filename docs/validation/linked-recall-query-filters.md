# Linked recall query filters

The recall tool documents `caseId`, `resolutionStatus`, `phase` and `affect` as
filters. Direct search already applies them, but the subsequent one-hop linked
expansion previously passed only workspace, agent and validity options. A related
memory from another case or phase could therefore enter the final result and
consume the content-token budget ahead of a matching memory.

`MemoryRecaller` now forwards those four explicit filters and applies the existing
`SearchScope` to returned neighbors. `LinkStore` binds the same predicates in both
incoming and outgoing SELECTs before their combined neighbor limit, and projects
the four corresponding columns for the final scope check. Filtering only after
the limit would still hide matching neighbors behind ten unrelated IDs.

The filters intersect. Scalar affect is normalized to one value; an array accepts
any listed value, and an empty array accepts no linked rows. Missing metadata does
not match a requested value. Omitted/empty-string case filters retain the current
direct-search behavior. History and peer opt-ins do not waive these filters.

## Verification

- Thirteen new unit checks invoke the production recaller and LinkStore with a
  synthetic database boundary. On untouched main `762f5c7`, ten failed and three
  controls passed. All thirteen pass with the fix.
- Unit coverage includes filter forwarding, both SQL branches and bound values,
  metadata projection, scalar/array affect, missing metadata, filter intersection,
  ranking/token competition, cursor positions, history/peer/workspace controls,
  absent filters and `includeLinks=false`.
- Six PostgreSQL acceptance cases create only synthetic transaction-local rows.
  Each individual filter is tested with twelve earlier-sorting mismatches, a
  missing value and matching incoming/outgoing neighbors. A combined-filter case
  exercises production recall with the real linked SQL and injected direct
  search; another verifies empty affect arrays. Every fixture rolls back.
- A local PGlite 0.5.15 + pgvector fixture applied the untouched base schema and
  all 37 migration files. All six checked-in acceptance cases fail on untouched
  main and pass with the fix, without skips. This embedded SQL evidence is not native PostgreSQL acceptance.
- Full local `npm run test:ci`: 2,544 unit passed / 2 existing skips; 54 offline
  integration passed / 21 environment-dependent skipped suites/cases. No failures.
- Changed-file strict ESLint, migration lint and diff check passed. Full lint has
  no errors and 124 existing warnings.

## Scope and limits

No new tool parameters, migration, dependencies, write path or workflow. Key,
agent, workspace, active-link, validity and relation filters are preserved.
Unfiltered recall still may return cross-case neighbors. Other filter types and
separate case-summary/event enrichment are outside this change.

The existing neighbor cap and ID-based ordering remain; this is not exhaustive
retrieval, a ranking-quality benchmark, a snapshot guarantee or a performance
claim. Injected direct search does not validate live providers or Redis. A
PostgreSQL service run is needed to establish native database acceptance; embedded
SQL or unit tests alone do not establish production RLS behavior.
