# @zhushanwen/pi-structured-output

## 6.1.2

### Patch Changes

- 993ee907f: Keep test files out of the npm package: the cross-package contract test now lives under `src/__tests__/`, so the publish surface excludes that directory (the shipped file imported vitest and resolved cross-package paths that do not exist in the published tarball).

## 6.1.1

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4)

## 6.1.0

### Minor Changes

- 802af968f: Gate terminal shutdown now relies solely on the graceful abort + shutdown sequence: the 15-second force-exit fallback timer is removed, along with the `TEARDOWN_FORCE_EXIT_MS` and `armForceExitTeardown` exports (requires pi 1.0.0).

## 6.0.0

### Major Changes

- 0d36077d4: Replaces the `LoopGate` / `RetryState` / `setupLoopGate` public exports with a single `WorkflowGate` export: the soft retry-steering gate and the hard termination gate now live on one state machine with one listener. Removed exports are breaking for direct importers — migrate to `WorkflowGate`.

## 5.1.9

### Patch Changes

- 8285841af: Send the structured-output retry reminder as a custom message (display:false) instead of a user message. The reminder stays fully visible to the LLM but no longer appears as a user bubble in the conversation stream.

## 5.1.8

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
