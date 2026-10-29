# @zhushanwen/pi-structured-output

## 6.2.5

### Patch Changes

- 701143b67: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.25.0 → @zhushanwen/extension-protocol@0.26.0)

## 6.2.4

### Patch Changes

- 3107549df: Register the structured-output tool under the snake_case name models actually emit (`structured_output`; `workflow_script` renamed likewise), so direct tool calls no longer miss. Nested codemode calls no longer mask a missed structured-output turn — the reminder now fires correctly. Session and journal replay still recognize the legacy hyphenated name.

## 6.2.3

### Patch Changes

- da658a786: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.23.0 → @zhushanwen/extension-protocol@0.24.0)

## 6.2.2

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0)

## 6.2.1

### Patch Changes

- 58a70ebc9: Error rounds no longer masquerade as success: a failed structured-output round (for example a schema-validation rejection) used to render the fixed success summary "Final result reported (schema validated)" in the collapsed tool-result line. The render hook now receives the SDK render context and, when the round is flagged as an error, falls back to the first line of the returned content (the actual failure message). Successful rounds keep the fixed one-line summary; callers without the context argument behave as success rounds.

## 6.2.0

### Minor Changes

- 796f01b29: structured-output 两个注册变体新增 TUI renderResult：details 保持模型结构化产出本体不混入 summary，折叠态渲染固定摘要行。

## 6.1.3

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0)

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
