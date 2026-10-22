# Text recall with optional embeddings

`recall({ text: "What was the Orion rollback procedure?" })` can retrieve a persisted memory with `keywords: ["orion", "rollback", "procedure"]` even when embeddings are disabled or unavailable. Fresh readers query PostgreSQL; no warm Redis cache or provider call is required for this keyword path.

When no explicit `keywords` or `topic` is supplied, recall derives at most the first five distinct terms after lowercasing and stopword removal. Terms contain Latin letters, digits or Hangul, with internal dots, underscores and hyphens; terms shorter than three characters and trailing punctuation are removed. The existing stored-keyword overlap query returns at most 30 candidates with the normal key/group, agent, workspace, type, importance, validity and other query filters. A type filter alone does not seed unrelated cached memories.

Without semantic similarity or reranker scores, the number of distinct matching stored keywords is the primary rank before the search token budget and final recall sorting. Existing rank scores break coverage ties. With semantic or reranker evidence, the existing hybrid ranking applies. Explicit keywords/topic retain their existing retrieval behavior. `searchPath` reports keyword candidates as `L2:N`; derived terms are not sent back as similarity scores or public metadata.

This path matches indexed keywords, not arbitrary content, substrings, paraphrases or all languages. Missing keyword coverage can still return no results. Time-range and graph expansion retain their existing behavior. Semantic and reranker providers remain optional and retain their own timeouts; keyword retrieval does not cancel a pending provider request. The search budget precedes linked-fragment expansion and pagination, whose existing accounting is outside this change.

## Reproduce

Run provider-disabled, provider-failure, empty-semantic, hybrid and reranker public-tool acceptance without credentials or services:

```sh
node --experimental-test-module-mocks --test tests/unit/text-query-recall.test.js
```

For durable acceptance, initialize a disposable test PostgreSQL database using `lib/memory/memory-schema.sql` and `npm run migrate`, as in `.github/workflows/test.yml`, then run:

```sh
DATABASE_URL=postgresql://user:password@localhost/test_db node --test tests/integration/lexical-text-recall.test.js
```

The suite writes synthetic memories through `MemoryRememberer`, `FragmentFactory` and `FragmentWriter`, explicitly supersedes an old instruction, and constructs fresh reader/search/recall objects. It covers a six-month-old answer against a recent partial match at a one-answer token budget, final ranking, cross-key/workspace/agent exclusions, correction retrieval, no-match cases and explicit-keyword controls. Each run uses unique synthetic keys and removes only its own rows. A missing database configuration skips the suite; an explicitly configured but unavailable or unmigrated database fails it.

Embeddings, Redis, quotas, automatic conflict/model processing, access reinforcement and adaptive thresholds are disabled or injected at component boundaries. This validates persistence and retrieval, not HTTP transport, production RLS roles, live models or real-world semantic answer quality. The repository CI runs the suite on PostgreSQL 15 with pgvector; local WASM PostgreSQL fixture results should be reported separately from that service-backed run.
