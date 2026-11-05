# Temporal candidate query filters

The recall contract describes `topic`, `type`, `minImportance`, `isAnchor` and
`affect` as filters. The separate time-range candidate query previously omitted
these options when called by `FragmentSearch`; its reader also lacked SQL
predicates for the first four. A dated request could therefore admit nonmatching
memories through the temporal branch even when the ordinary keyword/vector
branch rejected them.

`FragmentSearch._searchTemporal` now forwards the existing options.
`FragmentReader.searchByTimeRange` binds their predicates before date ordering
and the candidate limit, so newer mismatches cannot consume all 30 slots. An
explicit empty affect array returns no candidates, consistent with
`SearchScope`'s empty allowed set. Boolean false and minimum importance zero
remain explicit values. Topic/type equality, inclusive minimum importance,
scalar/set affect and existing case/phase/resolution predicates are intersected.

## Verification

The new unit tests invoke production methods. On unchanged main `762f5c7`,
17 fail and one unfiltered control passes. After the fix all 18 pass. Together
with the existing temporal history and range tests, all 31 pass.

Database acceptance uses the production reader and checked-in E2E test cases.
Each ordinary filter is tested against 32 newer mismatches ahead of an older
match. Other cases cover empty affect, false anchors, combined filters and
missing nullable metadata, half-open date boundaries, explicit historical rows,
workspace/global and default/peer-agent behavior, and the unchanged cap.
Both production fallback and text/RRF merge functions feed final recall ranking
and token budgeting with isolated empty non-temporal candidate generators.

The same 13 checked-in database cases run locally using PGlite 0.5.15 with
pgvector 0.0.16, the unchanged base schema and all 37 migrations. Unchanged main
fails 11 cases and passes two controls; the fix passes all 13 without skips.
The local adapter substitutes the database connection boundary, not the SQL or
test assertions. This is embedded PostgreSQL evidence, not native hosted
PostgreSQL, production role/RLS acceptance or a real service deployment.

## Scope and limits

No new parameters, migrations, dependencies or write paths. Existing key/agent,
workspace and current/history predicates remain. The 30-candidate cap and
created-time ordering remain. Timestamp ties are not made deterministic.

This repairs the temporal candidate source, not all other recall layers.
Graph/linked expansion, stale L1 topic/type hints, case enrichment, point-in-time
`asOf`, keyword matching and post-search side effects are unchanged. The
composition tests do not exercise Redis, embeddings, external rerankers or MCP
transport, and establish no semantic-quality, production-RLS or latency claim.
