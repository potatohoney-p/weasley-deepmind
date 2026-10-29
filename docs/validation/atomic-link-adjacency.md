# Atomic link and adjacency writes

`createLink` and `createLinks` now keep the edge upsert and both `linked_to`
updates on their existing transaction client. An adjacency error rejects and
rolls back the entire operation instead of leaving a committed edge or one-sided
neighbors. Batch adjacency errors are no longer silently ignored. Callers may
still choose their existing single-link fallback after a rejected batch.

This branch builds on the pairwise adjacency correction in Draft #17. It does
not reimplement that correction or repair already inconsistent records.

Validation includes actual-module failure admission tests and a PGlite fixture
with a real CHECK constraint that rejects the second adjacency update. The
migrated PostgreSQL E2E injects a real division-by-zero SQL error through a scoped
client wrapper, verifies no edge or adjacency survives, then checks a valid
retry. This is deterministic error injection, not a production fault simulation.

Existing agent context, relation/weight rules, advisory lock conventions, and
schema are retained. No policy or credential changes. A transaction holds locks
longer and overlapping concurrent writers may still deadlock and roll back; no
new automatic retry or deadlock-freedom guarantee. An uncertain COMMIT response
remains uncertain. The APIs still do not assert affected-row counts for every
adjacency endpoint, so this is atomicity of executed writes, not proof that
invisible/missing endpoints were updated. No RLS certification or global graph
snapshot is claimed. Redis/index caches are outside this transaction.
