# External embedding batch identity

## Failure

The OpenAI-compatible embedding wrapper sorted provider results by index but did
not verify coverage. A response missing index zero shifted the vector for the
second text onto the first. Equal-length responses with repeated indices also
passed the morpheme registrar's length check. The embedding worker could cache
and persist these mismatched vectors before emitting its ready event.

Main has no separate roadmap file. This fixes the implemented embedding-worker
and morpheme-index entries in the features ledger, rather than adding an already
implemented feature. The existing cache binary-payload and durable freshness
checks solve different problems; neither verifies provider result identity.

## Contract

For each external HTTP chunk, require a data array of exactly the input count.
Every result must have a numeric integer index in the chunk's zero-based range,
and no index may occur twice. Place each result at its validated index before
L2 normalization. The count plus unique in-range indices guarantees coverage.

A malformed chunk rejects the complete generateBatchEmbeddings call, including
when earlier chunks succeeded. No partial vector list is returned. The existing
semaphore is released, and subsequent calls remain usable. Validation neither
retries the request nor identifies a supposedly bad input: existing worker and
morpheme failure handlers choose their normal single-item fallback instead.
Valid out-of-order responses, repeated input text, per-chunk indices, dimensions
request parameters and normalization remain supported. Empty inputs send no HTTP
request. The provider's response array is no longer sorted in place.

## Reproduction

After npm ci, run:

```sh
DOTENV_CONFIG_PATH=.env.test WEASLEY_DEEPMIND_METRICS_DEFAULT=off \
  REDIS_ENABLED=false CACHE_ENABLED=false \
  node --experimental-test-module-mocks --test \
  tests/unit/embedding-batch-response.test.js
```

Twenty tests run the production wrapper with the installed OpenAI SDK against a
real loopback HTTP fixture. The fixture returns base64 Float32 vectors matching
the SDK's requested wire encoding. Twelve malformed result-index scenarios,
valid ordering and chunk boundaries, later-chunk rejection, empty input and
semaphore cleanup are covered. Production EmbeddingWorker and MorphemeIndex
also run through the same real HTTP boundary, with synthetic cache/database
boundaries proving that only correctly associated single-item fallback vectors
reach writes. Main 762f5c7: 16 failed / 4 passed. Fixed tree: 20 passed.

## Limits

This is positional integrity, not embedding-quality validation. A provider that
labels the wrong vector with a valid index cannot be detected. Vector dimensions,
coordinate validity and L2 normalization policy are unchanged, as are the local
Transformers path and single-item provider wrapper. No stored-vector repair,
cache invalidation, live provider quality, database performance or real Redis
claim. Fallback can make additional provider requests; its retry/dead-letter
policy is unchanged. No schema, provider configuration, dependencies or workflow
changes are required.
