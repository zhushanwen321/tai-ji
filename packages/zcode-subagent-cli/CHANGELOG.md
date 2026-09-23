# @zhushanwen/zcode-subagent-cli

## 0.4.0

### Minor Changes

- 8285841af: App-server launcher survives the 3.12.x built-in provider config relocation: the wrapper rewrites `argv[1]` to the CLI path before import (upstream provider bootstrap anchors on it — without the rewrite the process exits at startup) and derives `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` from the v2 runtime provider directory when not explicitly provided (platform directory covers both Node `<plat>-<arch>` and Rust arch naming such as `darwin-aarch64`, newest semver wins); when no config is found the CLI's own error surfaces with recovery wording instead of failing silently. The session reader accepts tool-part state as an embedded JSON object (0.16.5+ host dbs) in addition to the older JSON-string form, degrading to `state=undefined` when neither parses. Engine behavior: an absent `task.model` no longer forces the fallback default — the create frame omits the model key so zcode's own default resolution (user `defaultModelSelection`) applies, and credential precheck is skipped accordingly; `sandbox` is declared `emulated` (worktree isolation carried by the common worktree manager; the engine consumes `task.cwd` as the session workspacePath). Session-db path segments now import the SSOT constants from `@zhushanwen/subagent-engine-sdk` (`zcode-db-paths`).

## 0.3.2

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
