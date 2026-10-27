# Current-row amendment history

Amendment used to archive a caller snapshot obtained before its transaction. If
another writer committed in between, the archive omitted the version that was
actually overwritten. A caller snapshot could also make ownership/no-op handling
stale after the durable row changed or disappeared.

The writer now locks and reads the target inside the amendment transaction,
after setting the agent context. Archive, duplicate-content checks and update use
that row. Missing or no-longer-owned targets roll back before archiving.
The optional caller snapshot remains accepted for compatibility, but is not
trusted as the archive source. The lock is released on commit/rollback.

## Acceptance and evidence

- Eight runtime unit cases: original 7 failures / 1 pass; fixed 8 passes.
- Migrated-PostgreSQL E2E: a separate connection holds an updated row; the test
  confirms a real server lock wait before commit, then verifies the archived
  version, preserved non-patched content, ownership refusal and failed-update
  archive rollback.
- Full unit and hosted database results are recorded in the pull request.

## Limits

This is not compare-and-swap or stale-edit rejection: supplied content patches
still use last-writer-wins semantics. Redis deindexing and case-event summaries
in the higher-level amend processor still use its original snapshot and are not
made transactionally fresh here. The lock protects one target row, not arbitrary
cross-fragment content-hash races. No deadlock retry is added. PostgreSQL errors
continue to roll back and propagate. No migration or historical archive repair.
