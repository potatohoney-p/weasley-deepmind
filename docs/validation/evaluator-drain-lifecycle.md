# Shared evaluator drain ownership

`MemoryEvaluator.stop()` promises to wait for the current evaluation to finish.
Previously it used `running` to decide whether a drain existed. The first stop set
that flag false, so a second shutdown caller immediately returned while a provider
or durable write was still active. A start during the drain also launched another
loop, allowing overlapping consumers and potentially preventing shutdown.

Retain the active loop promise separately from the polling flag. All stop callers
await that same promise; starts while running or draining are no-ops. To restart,
await `stop()` before calling `start()` again. Finalization clears ownership and
running state, including an unexpectedly rejected loop, which is logged rather
than left as an unhandled background rejection.

The polling/evaluation/backpressure logic and response validation are unchanged.
Stopping does not abort provider/storage calls or wake an idle/backoff timer, and
an iteration already inside queue I/O can still complete that iteration. This is
process-local lifecycle coordination, not a distributed lock, exactly-once queue
claim, fixed shutdown deadline or automatic restart after drain.

## Validation

```sh
node --experimental-test-module-mocks --test tests/unit/evaluator-drain-lifecycle.test.js
npm run test:ci
```

The original five regressions execute production start/stop/polling with deferred
evaluation and mocked queue boundaries. Main `762f5c7`: two fail / three pass;
fixed: five pass. A sixth test additionally verifies unexpected-loop termination
releases ownership and permits a later explicit start. No live provider or Redis
acceptance is inferred. The scheduler continues to call async `start()` and server
shutdown can continue awaiting `stop()` without call-site changes.
