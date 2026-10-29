# Core-flow E2E schema preservation

The hosted E2E job initializes `memory-schema.sql` and then runs the migration
runner before executing tests. The core-flow test previously replayed the base
schema and migrations 001–017. This recreated the global `idx_frag_hash` removed
by migration 031, changing conflict behavior for subsequent tests. Setup errors
were logged and suppressed. PR #27 exposed this when a same-content/key-scoped
regression ran after core-flow.

Core-flow now consumes the prepared schema without DDL. Its read-only catalog
preflight rejects the legacy global index and missing scoped hash indexes, with
an actionable migration instruction. It does not automatically migrate or repair
an existing database. The CI workflow already provides the required setup.
For a fresh local test database, initialize the base schema once, run
`npm run migrate`, then run `npm run test:e2e`. Do not replay the base schema over
an already migrated database.

## Evidence

- `node --experimental-test-module-mocks --test tests/unit/core-flow-schema-preservation.test.js`:
  unchanged main: 0 passed / 3 failed; patched fixture: 3 passed.
- The regression imports the actual core-flow test in isolated child processes.
  Synthetic pg and MemoryManager boundaries prove setup dispatch, rejection and
  all six existing CRUD assertions; they are not live database/MemoryManager proof.
- A separate PGlite 0.5.1 narrow-schema experiment executes the actual base-schema
  global index DDL and migration 031: replay recreates the index and same-content
  master/key insertion fails with 23505. The new actual preflight SELECT preserves
  exact index definitions and both rows coexist. Not full pgvector/RLS evidence.
- Full local unit and integration outcomes are recorded in the PR/run report.

## Limits

This is test harness work, not a new memory feature or production change.
The preflight checks index names, not every index definition or migration state.
Connection/no-configuration skip behavior, cleanup behavior, DATABASE_URL-only
support and other E2E fixtures are unchanged. Existing unconfigured core-flow
cases still return early rather than emitting explicit node:test skips; their
pass count must not be presented as real PostgreSQL evidence. No hosted database
result is claimed until CI runs the exact published tree. PR #27's defensive
transaction-local migration workaround remains separate and unchanged.
