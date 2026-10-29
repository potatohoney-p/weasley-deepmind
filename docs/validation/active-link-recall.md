# Soft-deleted relationship reads

## Objective and acceptance

After reconsolidation soft-deletes a relationship, later linked recall, RCA chains
and attached previews must not use that edge. Active edges remain usable in either
recall direction; deleted edges must not consume candidate limits. The seed itself
remains part of RCA output. A fragment may still be found by direct search or via a
different active edge: deleting a relationship does not delete a memory.

Main inspected: `956b122a2827373ad228b3537ea4f2237a9a0361`, open drafts #2–28.
This closes relationship-based recall and preview reads, not #15's narrative
history reconstruction or #7's fragment supersession policy. The existing graph
neighbor lane already filters `deleted_at`; these reads did not.

## Change

Add `deleted_at IS NULL` to both LinkStore neighbor branches, the RCA relationship
branch and LinkedFragmentLoader's LATERAL preview query. All existing parameters,
key/agent/workspace filters, relation filters, ordering and limits are retained.
No schema, dependency or mutation path changes.

## Validation

- Six new actual-module query-contract unit cases: unchanged main 5 fail/1 pass;
  fixed 6 pass. They assert both directions and that filtering precedes limits.
- Full local units: 2,280 passed, 2 existing skips, zero failures.
- Full ESLint: zero errors, 126 existing warnings. Changed-file strict lint passes.
- Actual production SQL on PGlite 0.5.1 synthetic narrow schema reproduces baseline
  returned IDs `[a-out,b-in,z-live]` after edge deletion, instead of `[z-live]`.
  Fixed lifecycle passes active/deleted/restored transitions, incoming/outgoing
  links, RCA seed preservation, previews, owning-key filter, and twelve deleted
  candidates crowding out the live result before the existing limits.
- Added rollback-only migrated PostgreSQL E2E for production neighbor SQL. Local
  run explicitly skips because DATABASE_URL is absent. Hosted execution is pending.
- Dependencies installed with lifecycle scripts disabled; no native/model checks.

## Compatibility and limits

`includeSuperseded` concerns fragment history and must not reactivate deleted
relationships. Scratch composition with #7 preserves both predicates; contextual
patch application is required because both edit neighboring SQL lines. Published
#7 is untouched; this is not a clean-merge guarantee.

The narrow SQL fixture is not full migrations, live PostgreSQL/Redis, RLS or model
quality evidence. The preview reader's existing authorization policy is unchanged,
not newly certified. This patch does not update denormalized `linked_to`, change
`getLinkedIds`/`isReachable`, repair historical data, resurrect deleted links in
createLink, change quarantine policy, or establish concurrent snapshot consistency.
No merge or deployment was performed.

Final local integration comparison: unchanged main 50 passed / 4 failed / 4 skipped;
patch 50 passed / the same 4 failed / 5 skipped (new PostgreSQL case). Failures are
reflect-large-payload and three session-rotate authentication assertions. No full
`test:ci` green claim. Scratch #7 composition: 2,290 passed / 2 skips / 0 failed.
