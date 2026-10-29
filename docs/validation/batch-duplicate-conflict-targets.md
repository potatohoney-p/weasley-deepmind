# Repeated content in a batch

`BatchRememberProcessor` groups inputs into multi-row `INSERT ... ON CONFLICT
DO UPDATE` statements. PostgreSQL rejects a statement that would affect one
conflict target twice (SQLSTATE 21000). Two valid equal-content fragments can
therefore roll back every peer in the batch. Factory normalization can produce
the same conflict hash even when raw inputs differ.

## Contract and change

Start a new chunk before adding an already-present content hash. The batch key
is fixed, so hash equality identifies the applicable conflict target for both
master and keyed requests. Keep input order, the existing byte/row caps, and
one outer transaction. Unique input batches keep their multi-row insert.
Repeated inputs use the same existing upsert policy: greatest importance,
anchor promotion, refreshed access time, and the durable ID returned by SQL.

The existing `inserted` field counts successful input operations, not newly
created durable rows. Three accepted inputs containing a duplicate still report
three, but produce two rows and repeat the durable ID. Quota admission remains
input-based, and is not made duplicate-aware by this change.

## Evidence

- Main `956b122a2827373ad228b3537ea4f2237a9a0361`; inspected open PRs #2–24.
- Eight focused unit tests: baseline seven fail / one pass; fixed eight pass.
- Actual production SQL and processor on embedded PostgreSQL (PGlite): repeated
  conflict target gives 21000; fixed master/keyed batches and replay preserve
  IDs, greatest importance and anchors. A later check violation (23514) rolls
  back earlier inserts, retaining only original rows.
- The embedded fixture uses a narrow schema and TEXT for the unused embedding
  column. It does not establish full migrated-schema, pgvector or RLS behavior.
- Full local unit suite: 2,282 passed, two existing skips, zero failures.
- Added `tests/e2e/batch-duplicate-hash.test.js` for the existing migrated
  PostgreSQL CI job. Without a configured PostgreSQL it explicitly skips.

Run the unit regression:

```sh
DOTENV_CONFIG_PATH=.env.test REDIS_ENABLED=false CACHE_ENABLED=false \
WEASLEY_DEEPMIND_METRICS_DEFAULT=off \
node --test tests/unit/batch-remember-duplicate-hash.test.js
```

## Limits and tradeoffs

A duplicate-heavy batch can require one statement per input (bounded by the
existing 200-input limit). No throughput improvement is claimed. No hash format,
collision policy, quota behavior, async queue contract, transaction boundary,
Redis post-processing or historical-data repair changes. In particular, cache
freshness after importance/anchor promotion is not established by this fix. Existing per-statement
RETURNING-to-input positional mapping is not redesigned here. No live Redis,
provider or model runs; local dependencies installed with lifecycle scripts off.
