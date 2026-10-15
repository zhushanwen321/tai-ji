# @zhushanwen/zcode-subagent-cli

## 0.8.1

### Patch Changes

- f6248708b: fix(zcode-engine): mirror resolved reasoningLevel into create thoughtLevel — sole effective reasoning channel on zcode CLI 3.15.x

  zcode CLI 的 session/create 处理器把 model 经 formatProtocolModelSelection 转 "provider/modelId" 字符串时丢弃 model.options（schema 声明并接收、handler 不透传），reasoning 档位实际只由独立 thoughtLevel → app.setThoughtLevel 应用。引擎此前只发 model.options.reasoningLevel：thinkingLevel 缺席（子代理派发默认形态）与 thinkingLevel=off/minimal（CLI 值域无 off 档被跳过）两个形态的会话推理档位为空，turn 阶段被拒 reasoning-level-missing（"Reasoning level is required"）。修复：解析出的 reasoningLevel 镜像为 create 帧 thoughtLevel（reasoningLevelFor 已把缺席/off 族/非命中档归一到值域内，镜像值即意图档位）；options 保留兼容旧 CLI 代际；无值域模型维持 thinkingLevel 透传现状。同批同步 RX2-F1 非常见档位提示措辞（透传 → 解析后下发）。

## 0.8.0

### Minor Changes

- 993ee907f: Fix reasoning-level resolution for registry models whose catalog rules use lowercase stems (match case-insensitively — GLM-5.3-Flash was rejected with reasoning-level-not-supported) and let an explicit thinking level pick within the catalog value domain. Allow `account:*` model refs for engine dispatches: the app-server launcher injects `entitled:true` for zhipu-account builtin entries and neutralizes the external-spawn account gate in the CLI bundle (in-memory, no files touched), so plan-family account providers (e.g. account:zai-individual-coding-plan) load into the registry.

- 993ee907f: Launcher skip log now distinguishes "catalog unreadable/corrupt" from "no zhipu-account entries" when the built-in provider patch layer is skipped, so troubleshooting points at the actual cause.

## 0.7.0

### Minor Changes

- 0c4bec66e: Provider startup sync: pi provider configuration is mapped into zcode's config at spawn time, and real provider_config.json reads are intercepted to serve a merged (real + injected) view so credentials and model entries stay consistent across both engines.

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
