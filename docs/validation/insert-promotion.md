# Repeated single-memory promotion

The single-memory writer returned a preflight duplicate ID before executing its
existing `ON CONFLICT DO UPDATE` statement. Consequently, sequential retries did
not apply the same greatest-importance / sticky-anchor rules as racing inserts
or batch writes. An explicitly promoted anchor could remain eligible for GC.

The writer now delegates conflict detection to the existing scoped partial unique
index and executes that upsert for both new and repeated content. Content, topic,
keywords, chronology and other immutable-on-conflict fields are unchanged. The
same durable ID is returned. External transactions still belong to their caller;
write failures propagate rather than becoming false success.

## Reproduction

`tests/unit/fragment-insert-promotion.test.js` runs the actual writer with a
controlled database seam. On main 956b122: five fail, one passes. With the fix:
six pass. Master/keyed and standalone/external-client routes are covered.

`tests/e2e/insert-promotion.test.js` exercises the actual writer against the
migrated PostgreSQL schema: master and keyed promotion, lower-priority retries,
immutable metadata, single durable row, and caller rollback. Without
DATABASE_URL it explicitly skips; an explicitly configured database failure
fails the test. Local PostgreSQL was unavailable; hosted CI is required before
claiming this full database regression passed.

An additional PGlite narrow-schema probe runs the actual generated production
SQL (not a mock SQL evaluator). It distinguishes baseline and fixed durable
values. This is not full migrations, pgvector, RLS or live PostgreSQL service
validation.

## Limits

Quota admission remains input-based. The public idempotency-key early return is
unchanged. Historical metadata and stale cache payloads are not repaired. This
is not generalized exactly-once delivery or complete remember-path cache
coherence. Repeated writes now perform the intended UPDATE, including accessed_at,
and can fail if that write fails; formerly the preflight read could hide that.
No schema, dependency, security policy, permissions, paid calls or deployment
changes.
