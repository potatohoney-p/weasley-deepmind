# Final recall content-token budget

`memory_recall.tokenBudget` is documented as the maximum returned token count.
Previously only the initial search candidates were trimmed. One-hop linked
memories were appended afterward, and `totalTokens` retained the search total
even after linked expansion, filters and cursor pagination. For example, a
60-token direct memory plus a 60-token linked memory could return under budget
100 while the response claimed only 60 tokens.

Recall now uses one effective budget for search and final selection. After the
existing rank, threshold, depth and seen-ID filters, it greedily selects fitting
memories in rank order. A candidate that cannot fit is skipped so later smaller
candidates can fill the remainder. Selection happens before pagination: cursor
offsets address the selected set, not rows removed after a page was advanced.
`totalCount` counts this selected set; `count` and `totalTokens` describe only the
returned page. Case mode receives the same bounded page and token count.

The estimator is unchanged: `estimated_tokens` when truthy, otherwise the existing
`countTokens(content)` implementation (cl100k_base with its existing fallback).
This constrains estimated fragment content, **not** total serialized response,
metadata, case narratives, downstream prompt overhead or a provider's billable
tokenization. It does not validate stored estimates or retrieve candidates that
initial search already excluded. Existing zero/falsy budget fallback remains
1000. There is no new authorization, schema, SQL, cache or model contract.

This may intentionally omit linked memories that previously exceeded the budget.
A higher-ranked linked memory can displace lower-ranked direct content. With a
stable candidate set and anchor, cursor traversal preserves the selected order.
Existing cursor-anchor handling, concurrent memory changes and search limits are
not repaired by this change; this is not snapshot-consistent pagination.

## Reproduction

```
REDIS_ENABLED=false CACHE_ENABLED=false EMBEDDING_ENABLED=false \
WEASLEY_DEEPMIND_METRICS_DEFAULT=off node --experimental-test-module-mocks \
  --test tests/unit/recall-final-token-budget.test.js
```

Tests invoke the actual MemoryRecaller with synthetic search/link storage,
existing scope/ranking logic, the real content estimator and explicit resource
cleanup. They cover linked expansion, rank competition, exact fit, oversized
candidates, filters, seen IDs, cursor pages, empty pages, default budgets and case
mode. No live database, embedding provider, Redis or model calls are exercised by
these regressions; the separate full-suite/CI evidence must not broaden that
claim.
