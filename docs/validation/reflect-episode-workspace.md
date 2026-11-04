# Reflection episode workspace

## Defect and change

The reflect tool documents workspace inheritance in
`lib/tools/memory-schemas.js`: explicit workspace, then API key default, then global
NULL. `ReflectProcessor.process` already resolves that value and applies it to
ordinary reflection fragments. Its separate narrative episode `remember` call
omitted both workspace and default, so `MemoryRememberer` created a global fragment.
Workspace-filtered reads include global fragments, making a newly inserted episode
visible in unrelated workspaces within its existing key/agent scope.

Pass the already resolved workspace into the episode call. This covers explicit
and automatically generated narratives without changing the resolution rule,
storage schema, reader policy or public tool parameters. The repository has no
ROADMAP file; the actual tool contract, existing feature ledger and production
call chain are the basis for this correction. Open Drafts #35–55 do not change
this call site; the earlier context hydration work concerns a different path.

## Reproduction and checks

With Node 24 and the locked dependencies:

```sh
npm ci
DOTENV_CONFIG_PATH=.env.test WEASLEY_DEEPMIND_METRICS_DEFAULT=off \
REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test tests/unit/reflect-episode-workspace.test.js
npm run test:ci
```

The 15 regressions execute production reflection, remember normalization and
fragment creation with synthetic storage/provider boundaries. Pristine main
`762f5c7` fails 12 and passes 3 controls; the corrected source passes all 15.
Cases cover explicit/default/null/empty workspace normalization, generated and
supplied narratives, ordinary fragment scope parity, tenant/agent/session/source
metadata, narrative-only requests, no-op reflection and persistence failure.
The empty-string case checks the existing pre-writer nullish normalization;
`FragmentWriter` still stores an empty workspace as NULL.

`tests/e2e/reflect-episode-workspace.test.js` runs automatically in the existing
PostgreSQL E2E job. Three cases use production reflection, remember, factory,
writer and reader code against the migrated database, asserting stored workspace
and same/other/unfiltered workspace visibility. Redis, provider calls, quota
decisions and automatic linking are isolated. Without DATABASE_URL the suite
skips; a configured but unavailable database fails. No workflow change is needed.
For a local database run, DATABASE_URL enables the suite; the production pool
also requires matching POSTGRES_* (or DB_*) settings, as in the existing CI job.

## Limits

This corrects the workspace passed for new writes; it does not repair or reclassify
existing global episodes. The existing per-key content-hash deduplication can reuse
a previously stored row and its workspace; that policy is unchanged. Unit storage
is synthetic; the PostgreSQL suite is distinct evidence. No live Redis/provider,
retrieval-quality, production RLS, concurrent-writer or cross-workspace deduplication
claim. Session input selection, explicit global behavior, episode content and
post-processing remain unchanged.
