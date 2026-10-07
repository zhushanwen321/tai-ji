# @zhushanwen/zcode-subagent-cli

## 0.6.0

### Minor Changes

- 32854b942: Add a runtime model-switch (setModel) protocol across the subagent engine stack. subagent-engine-sdk grows the engine contract: a `setModel` forward method, an optional `capabilities.setModel` flag ("native" | "unsupported"), a dedicated error-code vocabulary (`engine_model_not_in_snapshot`, `engine_credential_missing`, `engine_state_readback_failed`) plus the `engine_run_not_active` not-active code. pi-rpc adds `buildSetModelCommandFrame` for the pi `set_model` RPC command; pi-subagent-cli implements the pi-side control channel (control responses, engine setModel path, stdin writer). zcode-subagent-cli wires the same method through its app-server launcher. subagent-core orchestrates per-record and run-level switches (chat + workflow re-dispatch, override persistence and aggregate replies) and exports the new switch services and types from its barrel.

## 0.5.0

### Minor Changes

- 802af968f: pi 1.0.0 adaptation batch: extension-protocol adds the subagent journal push-channel wire types (marker/report/ack); pi-rpc, subagent-core, session-delivery and zcode-subagent-cli retire the defensive timeout/backoff/retry timer families (finality is now event-driven per ADR-0112/ADR-0122, and session-delivery drops the dead sendAttempts field); pi-subagent-cli passes images and output text through to the subagent drawer projection; subagent-engine-sdk removes the crash-rebuild backoff defense from its surface; session-core accepts pi 1.0.0's four-value message roles so system messages are no longer silently dropped.

## 0.4.4

### Patch Changes

- 0d36077d4: Server frame loop consolidates onto the shared SDK server entry (classify/handle helpers); engine-specific ack semantics unchanged.

## 0.4.3

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.7.0 → @zhushanwen/subagent-engine-sdk@0.7.1)

## 0.4.2

### Patch Changes

- 50f31a73c: Fire-and-forget reverse requests (`host/streamDelta`, `host/handleReady`) no longer risk crashing the engine process via unhandled rejection: a failed reverse request now logs a warning and the run continues without that channel report. A synchronous write failure (e.g. closed stdout) inside a reverse request is contained — the pending entry and its timer are cleaned up and the call rejects with an actionable message. The retired `schemaEnv` context channel is dropped from run-context restoration; schema enforcement now travels as the wire `task.schema` field.

## 0.4.1

### Patch Changes

- 43a50ae2e: Design-code-sync round 1 fixes on the zcode engine side: dangling reference cleanup, message purity, and error-mapping split.

## 0.4.0

### Minor Changes

- 8285841af: App-server launcher survives the 3.12.x built-in provider config relocation: the wrapper rewrites `argv[1]` to the CLI path before import (upstream provider bootstrap anchors on it — without the rewrite the process exits at startup) and derives `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` from the v2 runtime provider directory when not explicitly provided (platform directory covers both Node `<plat>-<arch>` and Rust arch naming such as `darwin-aarch64`, newest semver wins); when no config is found the CLI's own error surfaces with recovery wording instead of failing silently. The session reader accepts tool-part state as an embedded JSON object (0.16.5+ host dbs) in addition to the older JSON-string form, degrading to `state=undefined` when neither parses. Engine behavior: an absent `task.model` no longer forces the fallback default — the create frame omits the model key so zcode's own default resolution (user `defaultModelSelection`) applies, and credential precheck is skipped accordingly; `sandbox` is declared `emulated` (worktree isolation carried by the common worktree manager; the engine consumes `task.cwd` as the session workspacePath). Session-db path segments now import the SSOT constants from `@zhushanwen/subagent-engine-sdk` (`zcode-db-paths`).

## 0.3.2

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
