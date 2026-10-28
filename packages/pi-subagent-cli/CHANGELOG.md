# @zhushanwen/pi-subagent-cli

## 0.9.0

### Minor Changes

- da658a786: Engine fact chain hardening: queue edges, exit-0 anti-forgery, auto_retry frames, and the late-terminal contract; raw stop reasons and diagnostics now bind to the stop frame with same-frame semantics.

## 0.8.1

### Patch Changes

- a89eb7208: fix: resolve task-pi spawn correctly when the engine process runs under the Electron executor

  Packaged taiji spawns the engine CLI with the host Electron binary as the node
  executor (ELECTRON_RUN_AS_NODE=1), so the engine process execPath is Electron,
  not the pi binary. getPiInvocation's "non-node/bun execPath means pi binary"
  heuristic then spawned Electron with pi CLI flags, which the node option parser
  rejects ("bad option: --mode", exit 9) — every subagent/workflow dispatch failed
  within milliseconds. Branch 2 now requires the execPath basename to match the pi
  binary naming (npm bin or pi-<platform>-<arch>); otherwise it falls through to
  `pi` on PATH, which the runtime already makes resolvable via the injected PATH
  prefix.

## 0.8.0

### Minor Changes

- 58a70ebc9: Prompt 送达回执制度化 + fd3 raw 镜像（relay-spawn-transport M2/M3，ADR-0145）：

  - 新增 prompt-ack tracker：pi 的 prompt response 是唯一成功回执（`success:true` + disposition `started` / `queued` / `handled` 三态皆受理），stdout 活性只取消「写入后 30s 完全零输出」计时器（`TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS` 可覆盖/关闭）——零输出 → `engine_prompt_not_delivered`、`success:false` → `engine_prompt_rejected`（带 pi error 文本）、stdin 不可用 / EPIPE 立即失败；**不自动重试**（prompt 可能已产生副作用）。
  - 新增 fd3 raw stdout 镜像写入：`TAIJI_ENGINE_RAW_MIRROR=1` 宣告后按字节层行切分写 `{v,recordId,seq,b64}` NDJSON 到 fd3，per-recordId 进程级单调 seq，写失败/队列超限丢弃计数（不阻塞主链，live 流是派生视图）。
  - spawn 环境形状随之调整：control env 取代 relay env，任务 pi env 出站契约与 `TAIJI_ENGINE_RAW_MIRROR` 剥除由测试锁定。

## 0.7.2

### Patch Changes

- 993ee907f: chore: refresh dependency range (triggered by @zhushanwen/pi-rpc@1.2.0 → @zhushanwen/pi-rpc@1.3.0)

## 0.7.1

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.10.0 → @zhushanwen/subagent-engine-sdk@0.10.1)

## 0.7.0

### Minor Changes

- 32854b942: Add a runtime model-switch (setModel) protocol across the subagent engine stack. subagent-engine-sdk grows the engine contract: a `setModel` forward method, an optional `capabilities.setModel` flag ("native" | "unsupported"), a dedicated error-code vocabulary (`engine_model_not_in_snapshot`, `engine_credential_missing`, `engine_state_readback_failed`) plus the `engine_run_not_active` not-active code. pi-rpc adds `buildSetModelCommandFrame` for the pi `set_model` RPC command; pi-subagent-cli implements the pi-side control channel (control responses, engine setModel path, stdin writer). zcode-subagent-cli wires the same method through its app-server launcher. subagent-core orchestrates per-record and run-level switches (chat + workflow re-dispatch, override persistence and aggregate replies) and exports the new switch services and types from its barrel.

## 0.6.0

### Minor Changes

- 802af968f: pi 1.0.0 adaptation batch: extension-protocol adds the subagent journal push-channel wire types (marker/report/ack); pi-rpc, subagent-core, session-delivery and zcode-subagent-cli retire the defensive timeout/backoff/retry timer families (finality is now event-driven per ADR-0112/ADR-0122, and session-delivery drops the dead sendAttempts field); pi-subagent-cli passes images and output text through to the subagent drawer projection; subagent-engine-sdk removes the crash-rebuild backoff defense from its surface; session-core accepts pi 1.0.0's four-value message roles so system messages are no longer silently dropped.

## 0.5.0

### Minor Changes

- 0d36077d4: Writes the subagent identity env chain into spawned child processes (selfRecordId / agent / task / depth / rootSessionId / rootCwd per the SDK identity-env key table), applied after the outbound-env deny list.

## 0.4.5

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.7.0 → @zhushanwen/subagent-engine-sdk@0.7.1)

## 0.4.4

### Patch Changes

- 50f31a73c: Subagent crash kill-chain hardening (from the 2026-09-24 kill-chain forensics: every "crash" that day was a host-side SIGTERM, and 41 of 64 kill-on-disconnect log lines were normal post-settled reaping). Exit-code folding for signal-killed children is now POSIX 128+signo (SIGTERM reads 143, matching the runtime-side view; bare 128 misled triage). The relay proxy sends a goodbye frame before exiting on host SIGTERM, so runtime logs distinguish normal teardown (info) from abnormal disconnects (warn + kill decision) — kill behavior is unchanged. The orphan sweep tiers disposal by activity: idle orphans are reaped immediately, still-productive ones are marked pending (persisted in the pid file), deferred with a 30-minute hard cap and a recheck timer, ending the restart-storm oscillation where a just-recovered subagent was reaped by the next runtime generation; re-registering a recordId also reaps the superseded live pid instead of orphaning its ledger entry. Shutdown now waits for in-flight kill chains before the runtime exits (unref timers previously died with the process, leaving SIGTERMed-but-alive children). Failure notices to the main agent carry a recovery tail that warns to check action:'list' before manually taking over (parallel recovery rounds duplicated work in the incident), and dispose-time killAll logs which still-active children it is about to kill — the previously missing first-scene evidence for host-side disconnects.

## 0.4.3

### Patch Changes

- 43a50ae2e: Test hardening: pin git locale and strip ambient relay env in baseline suites so suite results no longer depend on host locale/relay state.

## 0.4.2

### Patch Changes

- 8285841af: Restores worktree cwd conduction lost by engine protocolization: a `cwd` present on the run-context wire is now merged back into the local full task before `engine.run`. Absent `cwd` stays absent (additive wire semantics) and the engine falls back to its own process cwd, so worktree-isolated subagent sessions spawn with the intended working directory again.

## 0.4.1

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
