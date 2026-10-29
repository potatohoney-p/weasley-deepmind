# Complete topic forgetting

The supported `forget(topic)` operation promises all topic fragments, protects permanent memories unless forced, and offers a non-mutating dry-run. Main `956b122a2827373ad228b3537ea4f2237a9a0361` selects only 200 rows and omits `ttl_tier`; topic dry-run falls through to deletion. This can leave obsolete current instructions available to a fresh, provider-free recall with a 128-token budget. Existing drafts address cache hydration, linked validity and ranking; they do not fix this write operation.

## Acceptance contract

1. One topic forget deletes all eligible records selected in the existing agent/default and owning-key scope, including superseded rows. Group visibility never expands write ownership; no workspace filter is introduced.
2. Permanent records, their versions and unrelated links survive unless `force=true`. Explicit forgetting keeps the existing hard-delete contract and schema cascades; amend and supersession retain their existing semantics.
3. Topic dry-run reports matched, would-delete, protected and incident-link counts without mutating storage or cache. An explicit ID takes precedence, as the existing tool schema states.
4. Link cleanup and fragment deletion commit together. A failure rolls back both, leaving cache invalidation unstarted. Invalidation processes only committed deletions, with bounded concurrency.
5. Fresh SQL-backed recall returns no deleted answer after successful forgetting, including when the topic exceeds 200 records, embeddings are disabled and the token budget is tight.

## Reproduction

With the existing migrated PostgreSQL test database and no live providers:

```sh
EMBEDDING_ENABLED=false REDIS_ENABLED=false node --test tests/integration/topic-forget-lifecycle.test.js
```

Set `DATABASE_URL` or the repository's `POSTGRES_HOST`/`POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` variables. The suite skips when no database is configured; a configured but unavailable database fails. It uses unique synthetic keys and IDs and cleans up only those fixtures. CI runs the suite explicitly after schema migrations on PostgreSQL 15 with pgvector.

The suite exercises production remember, amend/forget, store, reader, search and recaller paths. Quota checks, automatic/model processing, reinforcement and cache transport are controlled test boundaries. This verifies the lifecycle contract on synthetic instructions, not real-world retrieval quality. It does not verify live Redis, production roles/RLS, concurrent writers or provider behavior. Locking protects selected rows; concurrent inserts after selection can require another call. Cache invalidation remains best-effort and is not a distributed transaction. Exact-ID deletion retains its existing implementation apart from documented ID precedence.
