# @zhushanwen/zcode-subagent-cli

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
