# @zhushanwen/subagent-engine-sdk

## 0.9.0

### Minor Changes

- 802af968f: pi 1.0.0 adaptation batch: extension-protocol adds the subagent journal push-channel wire types (marker/report/ack); pi-rpc, subagent-core, session-delivery and zcode-subagent-cli retire the defensive timeout/backoff/retry timer families (finality is now event-driven per ADR-0112/ADR-0122, and session-delivery drops the dead sendAttempts field); pi-subagent-cli passes images and output text through to the subagent drawer projection; subagent-engine-sdk removes the crash-rebuild backoff defense from its surface; session-core accepts pi 1.0.0's four-value message roles so system messages are no longer silently dropped.

## 0.8.0

### Minor Changes

- 0d36077d4: 修复 npm 发布形态 `./server` 导出入口断裂：publishConfig.exports['./server'] 的 import/default 条件此前误指 TS 源码（src/server/index.ts），而 files 白名单不含 src，npm 消费者经 ESM/default 条件解析必报 MODULE_NOT_FOUND；现全部条件改指 dist 产物，对齐 './' 与 './protocol' 出口形态。

## 0.7.1

### Patch Changes

- 8aa4b40e8: Source-only annotation pass: oe-exempt framework markers added to protocol contract type exports (ReconciledMarkerData / ModelCatalogEntry); no behavior change.

## 0.7.0

### Minor Changes

- 50f31a73c: New `relay-frames` module exports the relay channel frame vocabulary as the single source: `RELAY_FRAME_KINDS` (handshake/accept/reject/data/exit), `RELAY_FRAME_DIRS` (down/up/up-stderr), and `RELAY_REJECT_REASONS` (version/identity/duplicate/malformed), plus derived union types. The runtime relay registry previously spelled these sixteen frame literals inline at construction and comparison sites — the runtime side now imports the constants, and the zero-dependency relay.mjs proxy keeps its embedded literals but gains conformance assertions locking every protocol point (frame construction, negotiation comparison, pump direction, exit) to the SSOT values, closing the gap where the env-constant family had a static lock while the frame vocabulary relied only on end-to-end behavioral tests.

- 50f31a73c: Subagent crash kill-chain hardening (from the 2026-09-24 kill-chain forensics: every "crash" that day was a host-side SIGTERM, and 41 of 64 kill-on-disconnect log lines were normal post-settled reaping). Exit-code folding for signal-killed children is now POSIX 128+signo (SIGTERM reads 143, matching the runtime-side view; bare 128 misled triage). The relay proxy sends a goodbye frame before exiting on host SIGTERM, so runtime logs distinguish normal teardown (info) from abnormal disconnects (warn + kill decision) — kill behavior is unchanged. The orphan sweep tiers disposal by activity: idle orphans are reaped immediately, still-productive ones are marked pending (persisted in the pid file), deferred with a 30-minute hard cap and a recheck timer, ending the restart-storm oscillation where a just-recovered subagent was reaped by the next runtime generation; re-registering a recordId also reaps the superseded live pid instead of orphaning its ledger entry. Shutdown now waits for in-flight kill chains before the runtime exits (unref timers previously died with the process, leaving SIGTERMed-but-alive children). Failure notices to the main agent carry a recovery tail that warns to check action:'list' before manually taking over (parallel recovery rounds duplicated work in the incident), and dispose-time killAll logs which still-active children it is about to kill — the previously missing first-scene evidence for host-side disconnects.

## 0.6.1

### Patch Changes

- 43a50ae2e: Design-code-sync round 1: fixes dangling references, tightens message purity, and splits the error-mapping path.

## 0.6.0

### Minor Changes

- 8285841af: Protocol surface hardening plus a shared zcode path module. `RunContextParams.cwd` is now optional — absent means the engine falls back to its own process cwd (additive wire semantics; worktree-isolated runs still carry the worktree path). Tolerant semantics for unknown members are codified: engines must answer unknown forward methods with the registered `engine_method_unsupported` passthrough error code (never hang or crash), and hosts answer unknown `host/*` reverse channels with `{unsupported:true}` so the sending engine takes its own degradation path. The AgentEvent vocabulary is compile-locked (per-member `EventName` constraint, SSOT constant, noop-safe markers for unknown-event tolerance), and the field-attribution criteria and evolution policy are codified as the protocol constitution headers (ADR-0071). New `zcode-db-paths` module exports `ZCODE_HOST_DB_SUFFIX` / `ZCODE_ISOLATED_DB_SEGMENTS` as the single source of the zcode session-db path contract shared by the engine write side and the host read side. The engine env deny list additionally strips `TAIJI_PRESET_FALLBACK_FROM` / `TAIJI_PRESET_FALLBACK_TO` (per-run facts that would false-disclose when inherited one hop into sub-agents).

## 0.5.1

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
