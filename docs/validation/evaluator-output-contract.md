# Memory evaluation output contract

The asynchronous `MemoryEvaluator.evaluate()` path uses a parsed provider JSON
response to update durable importance, verification state and rationale keywords.
Successful JSON parsing alone does not guarantee this response has the requested
schema. A numeric string, out-of-range score, unknown action or missing rationale
previously reached the store and could overwrite a valid memory assessment.

Before reading or updating the fragment, require a non-array object, a finite
numeric score in the inclusive range [0, 1], action `keep`, `downgrade` or `discard`,
and a nonblank string rationale. Reject the entire malformed assessment; log a
warning without its contents and leave the memory unchanged. No coercion, clamping
of malformed scores, fabricated rationale or successful-verification claim.

Valid assessments retain existing behavior: keep uses the score and verifies;
downgrade caps importance at 0.3 and clears verification; discard uses importance
0.1 and clears verification. Existing keywords are preserved before appending the
rationale. Extra JSON properties are ignored. This change does not require action
and score to agree with prompt thresholds, alter job queues/retries, repair stored
values, or change database scope, permissions, provider configuration or prompts.

## Reproduction

```sh
node --experimental-test-module-mocks --test tests/unit/evaluator-output-validation.test.js
npm run test:ci
```

The tests import production `MemoryEvaluator` and mock provider/storage/logger
boundaries. On main `762f5c7`, 13 of 18 tests fail and 5 pass. With the guard all
18 pass. Cases cover malformed root shapes; missing, nonnumeric, nonfinite and
out-of-range scores; missing/unknown actions; missing/object/blank rationales;
valid actions at range boundaries; and provider unavailability. Every invalid
assessment is checked for both zero durable reads and zero writes.

These are synthetic provider responses, not live CLI/model quality or real
PostgreSQL acceptance. Existing exception handling remains in place. Rejecting an
assessment does not enqueue a retry or set quality_verified=false; it deliberately
preserves the prior durable state. Rationale length and repeated valid rationale
appends are outside this change.
