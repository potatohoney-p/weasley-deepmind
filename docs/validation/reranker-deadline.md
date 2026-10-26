# External reranker deadline lifecycle

## Contract

The configured external reranker deadline covers response headers **and JSON body
consumption**. Every completed attempt clears its timer, including transport errors,
HTTP errors and JSON parse failures. Failures retain original candidate scores and
the existing three-failure cooldown; no local model or provider call is required.

## Reproduction and acceptance

Run `node --test tests/unit/reranker-deadline.test.js`.

The loopback HTTP fixture sends headers and an incomplete JSON body. The caller
must return original candidates within a watchdog window, not hang after headers.
Three failed attempts must still enter cooldown. Both score formats and malformed/
HTTP-error responses exercise cleanup; a rejected fetch must not trigger a late abort.

Against main `956b122a2827373ad228b3537ea4f2237a9a0361`, the original seven regression tests
produce four passes and three failures. With the fix, these seven and an additional
valid delayed-body control pass.

`npm test`: 2,282 passed, zero failed, two skipped (2,284 total).
Changed-file ESLint passes.

## Limits

This is a local HTTP fault-injection test, not a live model quality, throughput or
production service benchmark. Dependencies were installed with lifecycle scripts
disabled. Native inference and live external services were not exercised.
