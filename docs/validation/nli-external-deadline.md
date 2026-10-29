# External NLI response deadline

Main `956b122` cleared `NLI_TIMEOUT_MS` as soon as HTTP headers arrived.
A successful response with an unfinished JSON body could therefore leave
`classifyNLI()` and `detectContradiction()` pending indefinitely. A rejected
transport also retained its abort timer until expiry.

Keep the existing AbortController active through awaited JSON consumption and
clear its timer in `finally`. Cancel unread non-success bodies before returning.
HTTP errors, malformed JSON and timeouts continue
to return `null` for the existing caller fallback. Request format, configuration,
in-process ONNX inference and confidence policy are unchanged.

## Evidence

- All 30 open PR scopes inspected; this is independent of the external reranker
  deadline repair in #23. Main has no ROADMAP file; the features ledger remains
  the capability inventory. No new model-quality capability is claimed.
- Initial seven actual-module tests use loopback HTTP and a synthetic service, with no
  live provider, credentials or model downloads. Baseline: four pass / three
  fail. Fixed: seven pass. Both classification and contradiction callers resolve
  `null` on stalled bodies; delayed valid JSON and the POST payload are preserved.
  Other controls cover no headers, malformed JSON, non-OK status and transport
  rejection timer cleanup. A separate watchdog bounds baseline reproduction.
- Follow-up loopback reproduction at `8a04a2e`: a streaming HTTP 503 returned
  `null` but remained open after four 100 ms deadlines, receiving 20 more chunks.
  Aborting the rejected response closes that response without consuming its body.
  Both stalled and streaming regressions fail before the fix and pass afterward;
  they await server-observed response closure before forced test cleanup. The
  updated focused suite passes all eight cases. This is not a guarantee that
  fetch's entire connection pool has no idle sockets.
- Full units after cleanup fix: 2,282 passed / two existing skips. Full lint: zero errors / 126
  existing warnings; changed-file strict lint, migration lint and whitespace pass.
- Broad integration on branch and pristine main: 50 pass / four existing failures
  / four skips. The failures are reflect-large-payload's database dependency and
  three session-rotate authentication cases. Local full test:ci is not green.

## Limits

The deadline uses native fetch abort semantics and the event loop. It is not a
hard real-time/CPU parsing limit or a timeout for in-process model inference.
Malformed service schema validation, retries, connection pooling policy, overall
remember deadlines and live NLI quality are outside this patch. Local dependencies
were installed with lifecycle scripts disabled. Hosted CI is reported on the PR;
no merge, deployment, live PostgreSQL or ONNX validation is implied by these tests.
