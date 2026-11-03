# NLI assessment contract

`classifyNLI()` is the boundary shared by the HTTP service and in-process model.
Previously, parsed JSON with incomplete or coerced scores reached contradiction
thresholds: missing scores could throw, absent classes became false zero confidence,
and numeric strings or out-of-range values could produce confident decisions.
Nonfinite or incomplete model logits similarly yielded unusable probabilities.

Return null unless the assessment is a non-array object with a known label
(`entailment`, `neutral`, `contradiction`) and an object containing all three finite
numeric probabilities in [0, 1]. Reject the entire result without coercion or
fabricating missing scores. A warning omits response contents. Existing callers
can follow their existing null fallback instead of interpreting malformed data as
confirmed contradiction or confirmed non-contradiction.

Valid results and thresholds are unchanged. This guard does not enforce probability
sum, label/argmax agreement or provider calibration. Extra fields remain allowed.
It does not change service deadlines, preload fallback, model loading, stored
memories, or the caller's later escalation/flagging policy. Returning null itself
is not a guarantee that a downstream caller performs no writes.

## Reproduction

```sh
DOTENV_CONFIG_PATH=.env.test WEASLEY_DEEPMIND_METRICS_DEFAULT=off \
REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test tests/unit/nli-*contract.test.js tests/unit/nli-external-deadline.test.js
npm run test:ci
```

The 21 new tests use production classification and contradiction-decision functions.
Seventeen exercise a real loopback HTTP server; four mock the local model's logits
without downloading or invoking a model. Main `762f5c7`: 16 fail / 5 pass. Fixed:
21 pass, with all eight existing HTTP deadline tests also passing (29 total).
Coverage includes malformed root shapes, missing classes, wrong score types,
negative/out-of-range probabilities, labels, nonfinite/incomplete logits and valid
boundary probabilities. Both test files clean resources and assert shutdown.

These are API-contract regressions, not NLI accuracy, live-provider compatibility,
real-model execution, or durable-store integration evidence. Provider-specific
schemas outside this documented contract now deliberately use the null fallback.
