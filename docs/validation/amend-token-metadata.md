# Amendment token metadata consistency

## Contract and scope

When content is amended, persist its `estimated_tokens` in the same UPDATE as
content, content hash and embedding invalidation. Return the estimate so the
amendment's existing Redis reindex path receives the same metadata instead of
falling back to a character-count estimate. Topic-only changes retain the estimate.
Duplicate-content merges and failed writes retain the existing rollback behavior.

This fixes both growth (an old small estimate admits too much text) and shrinkage
(an old large estimate excludes content that now fits). It does not change search
ranking, link expansion, tokenizer policy, or the public amendment validation.
Previously stale rows are not backfilled; their next content amendment refreshes
metadata. The existing cl100k_base helper retains its documented character-count
fallback if tokenizer initialization fails; this is not model-provider billing.

## Reproduction and acceptance

- Baseline main: `956b122a2827373ad228b3537ea4f2237a9a0361`.
- `REDIS_ENABLED=false WEASLEY_DEEPMIND_METRICS_DEFAULT=off node --test tests/unit/amend-token-metadata.test.js`
- Same nine tests before the fix: **2 passed, 7 failed**. After: **9 passed**.
- Covers growth, shrinkage, Korean, mixed Unicode, empty storage-layer content,
  production recall budget selection, metadata-only changes, merge and rollback.
- `npm test`: **2,283 passed, 0 failed, 2 skipped** on Node 24.22.1.
- Changed-file ESLint and `git diff --check` pass. Repository lint: zero errors,
  126 pre-existing warnings.

The unit fixture executes the production writer transaction and parameterized
UPDATE but is not a database engine. `tests/e2e/amend-token-metadata.test.js` uses
actual PostgreSQL, checks fresh stored rows and two archived versions, and skips
explicitly when no test database is configured. The existing hosted E2E workflow
provides migrated PostgreSQL/pgvector. No local database was available in the cloud
workspace; local E2E was skipped, not counted as passed. No live model/provider or
performance benchmark was run. Dependencies were installed with scripts disabled.
