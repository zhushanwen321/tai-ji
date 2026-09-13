# @zhushanwen/zcode-subagent-cli

## 0.3.0

### Minor Changes

- 893b702b6: New features for the zcode engine: session TTL sweep with batched deletion (<=500 bind params per batch, single transaction across batches) covering session_task_link cleanup in both directions and NULL-ing parent keys on workflow_run / workflow_activity; resume anchor dbPath is now validated against the engine data-dir allowlist (closed-set match), and relative dbPath candidates are resolved and containment-checked against the pool directory before use.

## 0.2.1

### Patch Changes

- 14d1d4567: Protocol alignment with the engine-sdk chat-run unification: continuation rounds are dispatched as session-form runs keyed by `run.resume` (the legacy `chat` key is retired from the wire contract the engine consumes). No breaking public API surface change — one additive internal refactor: the module-private failed-terminal-status predicate was consolidated as an exported `isFailedTerminalStatus` in `constants.ts` (package-internal consumers only; not re-exported from the package entry, so the public entry surface is unchanged). Behavior is unchanged for same-version host/engine pairs. Pair with a `@zhushanwen/subagent-core` bump from the same release batch to avoid old-protocol/new-core resume mismatches.

## 0.2.0

### Minor Changes

- 4955dad6e: zcode engine in-flight snapshot support.

  Adds the `inFlightSnapshot()` public method to ZcodeEngine (plus connection plumbing) exposing the engine-side in-flight subagent view that feeds the rolling-restart defer-decision input (design D5) and the subagent-workflow in-flight reporting leg. Purely additive.

## 0.1.2

### Patch Changes

- ab07bdb4a: Align test-guard comments with the v2 data-directory layout (comment-only; no runtime behavior change).

## 0.1.1

### Patch Changes

- 838806898: W9 packaging & distribution registration (subagent-engine-protocolization): engine CLI packages are npm-publishable and declared as dependencies of @zhushanwen/pi-subagent-workflow so standalone installs get engines automatically. Electron packaged form bundles both engines to resources/engines/<id>/ (discovered via XYZ_AGENT_ENGINE_ROOTS); zsw vendored form adds engine package directories under lib/vendor/ (owner: z-code-plugin-workspace z-subagent-workflow repo).
