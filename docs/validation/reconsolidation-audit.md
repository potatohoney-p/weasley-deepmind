# Reconsolidation audit snapshots

The link reconsolidation ledger must record the values actually overwritten.
Reversing a delta from the new value is invalid after weight/confidence clamping:
a link at weight 1.95 / confidence 0.98 reinforced to 2 / 1 previously claimed
old values 1.8 / 0.95. Six of eight actual-SQL boundary cases reproduced this.

The existing transaction now selects the active link `FOR UPDATE` before the
update. Returned and persisted old values come from that locked row; new values
still come from the unchanged update. Missing/deleted rows return null without
writing history. A failed history insert still rolls back the update.

## Reproduction and evidence

- Node 24.22.1; actual-module unit regression: original 7 failures / 2 passes,
  fixed 9 passes. Covers all five actions, missing target and each storage stage.
- Full units: 2,283 passes / 2 existing skips. Full ESLint: zero errors and 126
  existing warnings. Changed files pass strict lint; migration lint passes.
- Actual module and SQL on PGlite 0.5.1 with narrow link/audit tables: original
  six failures among eight clamp/control cases; fixed all eight pass. Independent
  constraints-based SQL probes cover missing/deleted rows and actual audit-failure
  rollback. PGlite is not proof of multi-client locking or migrated PostgreSQL.
- `node --test tests/e2e/reconsolidation-audit.test.js`: explicitly skips without
  DATABASE_URL. A configured database failure fails. Existing hosted PostgreSQL
  CI runs this test against migrations: stored clamp history, rollback, deleted
  link and a competing row lock observed through `pg_blocking_pids`.
- Broad local integration retains four pre-existing failures (reflect fixture and
  session authentication); no local full `test:ci` success claim.

## Limits

One additional SELECT and single-row lock per eligible call. No schema changes,
new transaction, policy/permission changes or historical ledger repair. Existing
process-local decay/quarantine limiter, including its pre-transaction timestamp,
is unchanged. No cross-process throttling, automatic retry, RLS certification,
production DB/provider access, latency claim or global graph snapshot.
