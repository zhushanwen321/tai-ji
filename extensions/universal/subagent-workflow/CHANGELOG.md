# @zhushanwen/pi-subagent-workflow

## 8.12.0

### Minor Changes

- 14d1d4567: Align the extension with the subagent-core execution-runtime extraction and harden run lifecycle behavior.

  - **Elapsed freeze**: a finished run's displayed duration is now frozen at its `completedAt` instead of growing with every status query.
  - **Manifest as rebuildable cache**: startup tmp-file recovery is retired in favor of a silent sweep plus full `rebuildIndexes` boot leg — the record manifest is treated as disposable and rebuilt from the authoritative `.state` markers.
  - **Store-backed workflow dispatch**: the legacy pump-bypass progress-record family is retired; workflow dispatch and view projections read through the record store (origin/parentRunId identity + persistence chain included).
  - **Safer fork-from**: the fork guard now probes for a foreign live instance instead of relying on the old three-switch check.
  - Execution runtime moved to `@zhushanwen/subagent-core` — this package keeps only the registration surface and pi host adapters.

## 8.11.0

### Minor Changes

- 4955dad6e: In-flight subagent reporting channel.

  Adds a production-side reporting channel for in-flight subagent activity (design D5): running subagents are reported while they execute instead of only surfacing at completion, and a retention debug IPC plus stale-context guards harden the reporting path.

## 8.10.1

### Patch Changes

- ab07bdb4a: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-cli@0.1.1 → @zhushanwen/pi-subagent-cli@0.1.2, @zhushanwen/zcode-subagent-cli@0.1.1 → @zhushanwen/zcode-subagent-cli@0.1.2)

## 8.10.0

### Minor Changes

- 838806898: Adopt engine protocol v1.x: subagent runs go through protocolized engine CLI packages, with forkSource carried end-to-end over the protocol; the in-process pi engine borrowing path is removed.

## 8.9.0

### Minor Changes

- bbd8e5e8a: Sync batch collection v2: batch-member manifests are written at finalized exit, settled-state rescans are bounded, and batch markers survive orphan overwrites, making collect recoverable across crash windows. Also fixes the published npm package missing session-lifecycle.ts (8.8.1 regression).

## 8.8.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 8.8.0

### Minor Changes

- 7b33e6f00: **base-tool-enhance: orphan reaping sunk to the xyz-agent runtime; permission / subagent-workflow: session_start side effects guarded**

  - `@zhushanwen/pi-base-tool-enhance`: orphaned background-task reaping no longer runs inside every pi process (the global session_start scan with the global `reaper.lock` — the crash trigger surface of the 2026-09-01 incident). The xyz-agent runtime now owns collection with two trigger faces: at session destruction (covers delete/process-exit/forceQuit/restore cleanup) and as a startup full scan chained after orphaned-pi reaping. This package keeps writing only its own session's registry (now typed by the `@xyz-agent/extension-protocol` contract, a new dependency) and the per-session pending reconcile; `bash_kill`'s user-facing hint now points at runtime collection instead of "the reaper will collect at next session start".
  - `@zhushanwen/pi-permission`: the legacy-config migration in session_start is wrapped with `oncePerProcess` (replacing the package's inline module-level flag), so a factory double-invocation can no longer re-run the agentDir-global file migration. New dependency: `@zhushanwen/pi-ext-guards`.
  - `@zhushanwen/pi-subagent-workflow`: the six cross-session side effects in the session_start handler (engines.json sync, idle GC timer registration, expired session-file cleanup, manifest tmp recovery, orphan worktree scan, crashed-run recovery) are each wrapped with `oncePerProcess` — process-level maintenance now runs at most once per process under handler accumulation, while session-scoped operations (identity appendEntry, notify-ledger bind/recover, service init, sessionState) keep per-event semantics. New dependency: `@zhushanwen/pi-ext-guards`.

- 7b33e6f00: **subagent-core: host-surface expansion + zcode app-server resident engine**

  > Release-scope note: this changeset covers all unreleased changes since `0.2.0`. The local `0.3.0` bump was never published (npm has no 0.3.0 tarball), so changes from that window — including the cross-repo adaptation review round (788218dcb et al.) — ship with 0.4.0.

  - `runAndWait` gains an optional `model` parameter (6th positional, threaded into `RunSpec.model` → worker `$MODEL` → `agent()` fallback): the synchronous programmatic entry previously had no model channel, so hosts driving it (zsw CLI `--model` on the blocking run face) had to silently drop the override while the async `runWorkflow` entry honored it — same parameter, two entry points, divergent behavior. Omitting it keeps the existing resolution order (in-script `agent()` explicit arg → agent `.md` → engine default)
  - `recoverCrashedRuns` now resolves to `{ loaded, recovered }` counts instead of `void`: `recovered` counts only running→done,failed conversions, `loaded` is the full rehydration size (including done history) — hosts no longer need a pre-read `loadAll` just to report startup recovery numbers, and the two counts are separated so "rehydrated N" is never misread as "recovered N"

  - Barrel expansion (host shell assembly surface, all additions — nothing removed): fine-grained lifecycle orchestration (`terminateRunningRuns` / `evictDoneRunsBeyondCap` / `scheduleTimeBudget` / `MAX_RETAINED_DONE_RUNS`), launcher layer (`runAndWait` / `executeNestedWorkflow` + `LauncherDeps` / `WorkflowRunResult`), infra implementations for the orchestration ports (`WorkerHostImpl`, `WorkflowScriptRegistryImpl`, `lintScript` + `LintFinding` / `LintResult`), workflow discovery (`discoverWorkflows` / `loadWorkflows` / `getWorkflow` / `getWorkflowByPath` / `invalidateCache` + `WorkflowScanConfig` / `CachedWorkflowMeta` / `WorkflowMeta` / `WorkflowSource`), the port contract types (`AgentRunner` / `RunStore` / `WorkerHost` / `WorkerHandlers`), the zcode engine registration face (`registerZcodeEngine` / `createZcodeEngine` / `ZcodeEngineDeps`), and `killAllSpawnedChildren` — hosts assembling `LifecycleDeps` themselves previously had to reach these via deep paths, which are unreachable in the published npm surface
  - New `FileRunStore`: host-agnostic `RunStore` implementation persisting run snapshots to `<dataRoot>/workflow-state/<runId>.jsonl` (append-only full snapshots; `loadAll` takes the last valid line per file, skipping corrupted lines with a warn). The existing pi-side `JsonlRunStore` is anchored to pi session facilities (appendEntry/sessionManager) that zcode hosts do not have; this closes failure-mode-B ("behavior drifts, each host patches its own copy") for workflow state persistence
  - New `build:bundle` script producing `dist.bundle/index.cjs`: a single-file self-contained CJS bundle with all runtime dependencies (`@xyz-agent/*`, `ajv`, `yaml`, `proper-lockfile`) inlined via tsup `noExternal` — for hosts that vendor the package into a directory with no node_modules resolution surface (zsw plugin copies). The existing `build` output is unchanged (config switches on the running script name)
  - `findIssueKey` in `workflows/review-fix-loop-utils.cjs` now guards its first lookup with `Object.hasOwn` instead of a truthy check, so prototype-chain keys (`__proto__` / `toString` / `constructor`) from LLM-produced issue IDs can no longer be misreported as tracked ledger keys — upstreams the same fix already applied independently on the zsw side (the live example of failure-mode B). The same hardening is applied to `translateId` in the utils and the round-1 issue registration lookup in `workflows/review-fix-loop.js`
  - Zcode engine gains an app-server resident mode alongside the existing spawn path: one long-lived zcode app-server process per engine instance runs over a persistent HOME directory (directory lock with pid + heartbeat, orphan pidfile recovery, derived `home-appserver-N` directories on cross-process contention), with sessions created/destroyed per task on a single connection — removing the per-task process spawn and the ~128KB argv prompt budget; abort maps to `session/stop` instead of killing a process
  - Channel selection: `XYZ_ZCODE_MODE=appserver|spawn` pins a channel explicitly (no probe, no degradation); the default mode gates the first use of the resident channel behind a 10s protocol smoke probe (independent short-lived connection: create → close → shutdown, no model requests, no cost), with the probe conclusion cached in memory bound to the CLI file mtime and re-run when the mtime changes
  - Protocol drift handling: a first task hitting drift-class RPC errors (`-32601`/`-32602`) on the app-server channel falls back to a spawn rerun of that same task (result records `degraded`), and subsequent tasks go straight to spawn; the degraded flag is in-memory, so recovery is a host process restart followed by the probe gate rebuild (daemon hosts need a daemon restart)
  - Capabilities now declare `eventGranularity: stream` for the zcode engine (events flow during the turn, e.g. `text_delta` before the terminal event, instead of being synthesized post-hoc); `EnginePort` gains an optional `dispose()` shutdown surface (close sessions → SIGTERM → grace → SIGKILL, idempotent) and `RunContext` an optional `onHandleReady` callback for mid-run handle backfill
  - Sink-wave barrel expansion (all additions — nothing removed; ~62 symbols closing the "implemented but not exported" gap that forced per-host replicas): agent-ref face (`normalizeRef` now rejects `..` path segments — a declared behavior change, both hosts previously allowed; `invalidAgentRefMessage(ref, {howToList})` error factory; `AGENT_REF_EXT` / `WORKFLOW_REF_EXT` / `displayAgentName` / `SLUG_MAX_LENGTH`), `normalizeWorkflowRef(ref, {knownNames})` (name/path bisection + reserved-word ruling; built-in-name priority is expressed by the host's knownNames construction — core returns on first name hit), tolerant `parseAgentProfile` (never throws, `warnings[]`, optional execution fields maxTurns/disallowedTools/skills) + `discoverAgents(workspaceRoot, hostRoots)` assembly (dedup by frontmatter name, codepoint order; several hardcoded roots always participate in scanning — see jsdoc), `maxTurnsToWatchdogMs` (30-minute floor), `createConcurrencyPool({maxConcurrent, queuePolicy})` factory (default `priority` preserves existing behavior; `strict-fifo` grants re-check `effectiveMaxConcurrent`), the `worktree-git-ops` module (`collectWorktreePatch({worktreePath, patchFile, anchor, timeout?})` with baseline-anchor abstraction — anchors must live outside the worktree; missing/corrupt anchor and add failure degrade to bare diff with `patchIncomplete: true` trails; fidelity stdout reads, `listWorktreePorcelain` raw output), `writeAtomicFileSync` + `listStaleTmpFiles`/`cleanupStaleTmpFiles` and `bounded-serialize`, `recoverCrashedRuns(store, runs, reason, hooks?)`, `FileRunStore.pruneStateFilesBeyondCap`, `runSummary` / `isScriptRunning`, the run-snapshot codec (`toRunSnapshot` / `fromRunSnapshot` / `SNAPSHOT_VERSION = "wf-run-v2"`; legacy no-`v` lines are tolerated at the store layer, version-mismatched lines are skipped with an actionable warn), args-meta helpers (`normalizeArgsByMeta` / `argKeysFromMeta` / `findFlattenedArgKeys` — all accept an optional `reservedKeys` option; hosts must inject their own top-level envelope keys or envelope-named params are misjudged as flattened), and `loadWorkflowScriptByPath` + the `WorkflowScript` class
  - Execution runtime face exported under `@experimental` (signature micro-adjustments allowed within one minor): `SubagentService` / `SubagentServiceInit` / `createSubagentService(deps)` plus `ModelConfigService` so the documented third-host construction (`new ModelConfigService({cwd, agentDir})`) is reachable from the barrel alone, record/registry query surface, and the `subagent-actions-core` domain kernel (six-handler validation, guard chains, ownership, terminal mapping) extracted from pi-sw's action layer

  **pi-subagent-workflow: builtin agents move to @zhushanwen/subagent-core, tools whitelist dropped from templates, workflow run accepts builtin names**

  - The 10 builtin agent templates (analyst/coder/debugger/doc-reviewer/explorer/general-purpose/orchestrator/planner/researcher/reviewer) now ship with `@zhushanwen/subagent-core` (the `agents/` asset directory, distributed via the package dependency) instead of inside this package — their `<location>` in the `<available_subagents>` injection points at the core package directory; discovery priority is unchanged (user-level < builtin < project-level)
  - The templates no longer declare a `tools:` frontmatter whitelist (orchestrator and 8 others): subagents are no longer started with a `--tools` allowlist, tool constraints return to the host's default toolset. To restore a per-role whitelist, drop a same-name `.md` override into `<workspace>/.agents/agents/` — the project-level source is the escape hatch that shadows the builtin
  - `workflow run` now accepts a builtin/saved workflow name (e.g. `{"action":"run","name":"review-fix-loop"}`) in addition to absolute script paths — resolving names first, then paths (strict superset; existing path usage unchanged)
  - The `<available_subagents>` injection guide was updated to match the current subagent tool parameter surface: agent refs are `<location>` paths (not bare names), and unmatched tasks should omit the agent param (falls back to general-purpose) — the old "pass systemPrompt" hint referenced a parameter that no longer exists
  - Workflow run argument validation now consumes the core args-meta helpers (`argKeysFromMeta` / `findFlattenedArgKeys`) instead of local replicas, injecting `TOOL_TOP_LEVEL` as `reservedKeys`; behavior is equivalent (71 files / 917 tests unchanged), and schema-driven known-key sets mean workflow parameters added to an asset's `@pi-meta` are picked up without code changes
  - session_start crash recovery now consumes core `recoverCrashedRuns` instead of the local four-step loop (`pending:unregister` moves to the `onRunRecovered` hook; the `storeHealthy` fail-fast on `loadAll` failure stays host-side), and the status summary consumes core `runSummary` with the host `stateFile` field overlaid — behavior-equivalent rewire that removes the last two dual implementations of already-sunk core capabilities

## 8.7.0

### Minor Changes

- 71c283d25: **subagent-workflow: engine awareness injection + config three-state read**

  - The system prompt now carries an ever-present engine state section: current engine (with routing verdict) plus a per-engine list annotated with credentialed/available state, so the agent always knows which engine dispatches subagents and what alternatives exist
  - Per-turn engine switch detection: when the effective engine changes mid-session, a flow notice is emitted the same turn (not silently on next dispatch)
  - Config reads are now three-state (configured / unconfigured / error) with a single normalize authority; a new `reloadGlobalConfig` action lets clients repair a broken config without restarting, and the baseline branch reloads the service cache so a failed startup read no longer leaves a permanently stale cache
  - `listModels` degrade hints are split by cause: unimplemented/null aligns to core registry semantics (port contract), empty/throw keeps a credentialed-config hint
  - Engine section output is byte-stable per config state (ordering + tail-only-change guarded by tests)

## 8.6.0

### Minor Changes

- 23d8fe3cc: **subagent-workflow: engine-neutral core with zcode engine support**

  - Subagent execution is now engine-neutral: an engine registry with 3-tier routing (explicit request → configured default → guarded fallback) picks the engine per task, with engine provenance recorded on every execution record
  - New `zcode` engine runs subagents through a single-shot zcode CLI adapter (launcher / parser / preparer / reader); pi remains the default engine with unchanged behavior
  - Shared degradation layer (schema emulation, kill-chain, event journal, persona router, nesting guard, pool manager) applies uniformly across engines
  - zcode credentials now use v2-only discovery — the legacy `~/.zcode/cli/config.json` dependency is removed
  - Extension data-dir layout for engines is standardized via a shared `engine/paths.ts` SSOT used by both the extension writer and the runtime validator

## 8.5.0

### Minor Changes

- b3a8cf77b: **subagent-workflow: engine-neutral core with zcode engine support**

  - Subagent execution is now engine-neutral: an engine registry with 3-tier routing (explicit request → configured default → guarded fallback) picks the engine per task, with engine provenance recorded on every execution record
  - New `zcode` engine runs subagents through a single-shot zcode CLI adapter (launcher / parser / preparer / reader); pi remains the default engine with unchanged behavior
  - Shared degradation layer (schema emulation, kill-chain, event journal, persona router, nesting guard, pool manager) applies uniformly across engines
  - zcode credentials now use v2-only discovery — the legacy `~/.zcode/cli/config.json` dependency is removed
  - Extension data-dir layout for engines is standardized via a shared `engine/paths.ts` SSOT used by both the extension writer and the runtime validator

## 8.4.0

### Minor Changes

- ee74773da: Add `message` and `start` actions to the `/subagents` RPC surface: GUI clients can now send a directed message to a running subagent or start a new one without going through the main agent LLM. Successful dispatches are recorded in the main session as `subagent-directive` custom_message entries (hidden from TUI) so the conversation stays auditable and reload-safe

## 8.3.0

### Minor Changes

- d4f466667: Forward fire-and-forget UI requests (notify / setStatus / setWidget / setTitle / set_editor_text) from rpc-mode subprocesses to the host UI instead of dropping them, and grade resource-shadowing warnings: machine-source duplicates are demoted to debug while true user-source conflicts are reported once per process with dedup

## 8.2.0

### Minor Changes

- df69a18fc: Migrate BgNotifier to the unified session delivery kernel; add available_provider_models injector (codepoint-sorted provider model list) replacing the removed model-switch extension (its last shared dependency @zhushanwen/pi-quota-providers was removed in the same cycle — no replacement needed, model listing now comes from the pi ModelRegistry); resource-discovery and subagent-service refinements.

## 8.1.1

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 8.1.0

### Minor Changes

- 8e52cb3ba: Review-fix-loop tier-1 efficiency optimization

  - M0 observability foundation: per-round metrics files, execution traces, stage timings
  - M1 aggregation data chain: cross-batch score collection, dedup keys, aggregated report generation with authority guards (absent vs empty must_fix_ids)
  - M2 scoring/eval: exec-review scoring rubric, dormant-partition directed tests, prompt contract enforcement
  - MP prompt prefix stabilization (tier-1 T9): deterministic prompt prefixes across rounds
  - Worktree registry lock + physical reconciliation (W4), orphan terminal fallback + execution-state projection (U2-U4), kill-9 recovery terminal state (U1)
  - Round-finalized subagents never show working; markDead/revive via applySnapshot
  - Sidebar status sync: subagent/workflow lists re-pull on reconnect, empty RPC result guards
  - Lint backlog cleared (25 warnings)

## 8.0.0

### Major Changes

- a769aea2f: Incremental round notifications and transcript pointer for chatMode subagents:

  - **Round notifications now carry per-round increments instead of the full transcript.** Previously each round notification resent all previous rounds' text (`record.result` derived from the full turn history), making total notification volume grow quadratically with the number of rounds (O(N²)). Each notification now contains only the current round's reply text. If a round produced no non-empty increment (pure tool round, interrupted round, empty model reply), the notification falls back to `"(no output this round)"` (or a `round did not complete: <error>` line for failed rounds).
  - **Notifications now end with a `Full transcript: <sessionFile>` pointer line** (blank-line separated). chatMode round/close notifications transparently pass the subagent's session file path so the parent LLM can read the full transcript on demand — this is the recovery channel if a round's increment is lost in an async flush window. The pointer line is omitted when the session file is not (yet) known, and is not appended to `cancelled` / failed notifications.
  - **Closing a chatMode subagent now sends a distinct final notification** (dedup identity separate from the last round notification, so both are delivered): an idle close carries an empty body plus the pointer line (the last round's increment was already delivered by its round notification), while a close requested mid-round carries that round's increment. chatMode close notifications include a round count (`completed after N rounds.`); one-shot completion notifications keep the unchanged `completed. Result:` wording.
  - **one-shot subagent notifications are byte-for-byte unchanged** — the session file is only passed through for conversation-mode (`chatMode`) records.
  - Consumer-visible impact: the `/subagents` detail Result section shows shorter text per round (incremental semantics; the detail view already directs readers to the session file for full history). The TUI notification card is unaffected by the pointer line — `bg-notify-render` renders from `message.details` fields (title line for round notifications, first line of `result` for completed ones) and never reads `message.content`, so the pointer line is visible to the LLM only.

- a769aea2f: v4 one-shot lifecycle convergence for background and conversation-mode subagents — BREAKING major bump:

  - **BREAKING — one-shot lifecycle: remove pause/resume across the workflow tool, /workflows command, and session lifecycle**

  Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.

  1. **`workflow` tool action enum narrows to `run`/`status`/`abort`.** Calls with `{"action":"pause"}` / `{"action":"resume"}` now fail pi schema validation with `Validation failed for tool "workflow"` (structured error listing the allowed enum — self-correctable by switching to abort or starting a new run).
  2. **`/workflows` command verbs narrow to `abort`.** `/workflows pause|resume <runId>` no longer pauses/resumes; both verbs now return the removed-capability hint `Workflow <verb> has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>` (warning level). Command completion no longer offers pause/resume; the TUI `p` keybinding is removed (`a` abort remains).
  3. **Session switch/shutdown now terminates running runs as `done,failed`** (previously auto-paused and resumable). Each terminated run persists `state.error = "Session switched: run terminated"` / `"Session shutdown: run terminated"`; token spend on terminated runs is forfeited and resume is unreachable in any form — start a new run instead.

  Behavior notes (non-breaking): on worker crash the runtime rebuild (up to 3 retries, unchanged) discards in-flight agent calls that the old runtime aborted (they re-run fresh), while genuinely-done calls keep their replay cache — a completed step is not re-billed after a crash. Verified in real-pi E2E: after a mid-flight crash the alpha call replayed from cache (exactly 1 subagent session file) and beta re-ran fresh (2 session files).

  - **BREAKING — type narrowing: RunStatus two states, snapshot wf-run-v2, create-as-running**

  **Run snapshot format bumps `wf-run-v1` → `wf-run-v2`.** Old v1 snapshot files are silently skipped on load (accepted boundary per design D-5) — runs persisted by previous versions disappear from the run list after upgrade. The state machine is now two-state (`running → done`, `done` the only terminal state): the `paused` status and the `meta.pausedAt` field are gone, runs are created directly as `running` (the transient paused construction step no longer exists), and `ReleaseMode` narrows to `"terminal"`.

  - **BREAKING — ExecutionStatus collapsed to two states** (`running` / `closed`). The former `done` / `failed` / `crashed` terminal states and the short-lived `idle` state are merged into `closed`, with the L2 reason carried by the new `closedReason` field (`parent-shutdown` / `parent-fork` / `parent-new` / `user-close` / `cancelled` / `gc`). Consumers that switch on the old status enum in `list` responses or tool details must be updated. Legacy-data display note: the companion xyz-agent release flips `normalizeSubagentStatus`'s unknown-value fallback from `running` to `closed`, so `idle` list items persisted by 7.3.x extensions (conversation-mode subagents waiting for a follow-up) now display as closed/done instead of a perpetual spinner when an old session is reopened.

  - **Conversation mode now sustains multiple rounds.** New `message` and `close` tool actions let the parent agent keep chatting with a conversation-mode subagent (`start` with `conversation: true`) across rounds, close it after a round, or auto-upgrade a finished one-shot subagent by sending it a first message.

  - **`list` responses now report the `agent` field as a short display name.** The LLM-visible `subagent` tool's `list` action result previously echoed the full agent definition path (e.g. `/home/user/.pi/agent/agents/dev.md`); it now carries the basename without extension (`dev`). This is a display-only change — the underlying record keeps the full path, and no other `list` fields are affected.

  - **BREAKING — bg-notify payload contract change.** `subagent-bg-notify` records now carry `status: "running"` (a conversation round finished, result included, `round` counter used for dedup) or `"closed"` (terminal, reason in `closedReason`); the legacy `done` / `failed` / `cancelled` values are no longer emitted, and `closedReason` / `round` are new fields. This is a cross-process wire contract — xyz-agent itself consumes it and ships a matching `@xyz-agent/shared` parser in the same release; other consumers of the notify details must align.

  - **Recursion guardrails for nested subagents.** The `subagent` tool description now documents tree-shaped task criteria, self-contained task requirements, independent acceptance criteria per level, depth-as-safety-rail positioning (not a budget), and fork cost warnings, preventing LLMs from treating the 10-level cap as encouragement for deep nesting.

## 7.4.0

### Minor Changes

- 07b5a813d: Redesign built-in agents into 9 orthogonal roles; stop tool-call deltas from polluting streamed text

  The built-in agent set is redesigned around nine orthogonal roles: `coder`, `debugger` and `reviewer` are added while `worker`, `code-reviewer`, `context-builder` and `oracle` are removed, and the prompts for `planner`, `orchestrator`, `explorer`, `researcher`, `general-purpose` and `doc-reviewer` are rewritten — clearer when/notFor semantic routing, explicit data-vs-instruction injection guards, and reviewer-type roles stay read-only. The fallback agent for calls without an explicit agent name remains `general-purpose` (the old `worker` fallback no longer exists).

  Streaming is also fixed: `message_update` events now go through a dedicated `mapAssistantMessageDelta` helper that only forwards `text_delta` / `thinking_delta`. Previously tool-call argument deltas (raw JSON fragments such as `{"path":"..."}`) leaked into the streamed assistant text and interleaved with it; tool calls are now displayed only via the fetched history cards, never via the streaming channel.

  Data-directory resolution (`resolveSessionDir`, skill discovery) migrated from hardcoded `~/.pi/agent` to pi's `getAgentDir()`, so `PI_CODING_AGENT_DIR` overrides are respected.

  Impact for consumers: prompts or workflows referencing the removed agents by name (`worker`, `code-reviewer`, `context-builder`, `oracle`) must be updated to the new roles; streamed subagent output no longer contains JSON tool-argument fragments.

## 7.3.4

### Patch Changes

- 2a724190c: **extension-logger / pending-notifications / subagent-workflow: unify debug env switches on XYZ_AGENT_DEBUG**

  - File-log gating in `extension-logger` now reads `XYZ_AGENT_DEBUG=1` (previously `PI_EXT_DEBUG`); `pending-notifications` console debug logs switch from `PENDING_DEBUG` to `XYZ_AGENT_DEBUG`; `subagent-workflow` debug traces likewise moved to `XYZ_AGENT_DEBUG`.
  - One switch now toggles debug logging across all extensions that follow the logging conventions doc — no per-extension env vars to remember.

## 7.3.3

### Patch Changes

- 1565e57fa: **Shared LLM/config library + config path consolidation (first release of `@zhushanwen/pi-llm-shared`)**

  - **pi-llm-shared (new)**: shared library for extensions — generic config IO (`<agentDir>/config/<pkg>-ext-config.json`, mtime+size read-through cache, atomic write), unified LLM call helper (`callLLM`), `ModelSelector` resolution (ref/fallback/available/scoped), and `migrateLegacyConfig` (idempotent best-effort rename used by session_start migration hooks). Note: must publish together with (or before) its consumers below; the packages resolve it via `workspace:*`.

  - **pi-permission**: config file moved from `<agentDir>/permission-config.json` to `<agentDir>/config/permission-ext-config.json` (one-shot idempotent migration on session_start, old file removed after move); LLM classifier plumbing now goes through pi-llm-shared (`callLLM` + `ModelSelector`); classifier model `auto` semantics now pick the first available scoped model instead of the globally cheapest.

  - **pi-rename-session**: switch and settings now live in `<agentDir>/config/rename-session-ext-config.json` (`enabled` / `model` / `maxTitleLength`); title generation uses an independent slim system prompt with explicit `tools: []` and its own model selector (default `scoped`) instead of piggybacking the main session model. The legacy `<agentDir>/auto-rename-enabled` flag file is kept as a live override (checked every turn) so the released xyz-agent runtime toggle keeps working — `/auto-rename on|off` syncs both mechanisms.

  - **pi-model-switch**: config file moved from `<agentDir>/model-policy.json` to `<agentDir>/config/model-switch-ext-config.json` (session_start migration); new `model-switch-ext-config` skill documenting schema and defaults.

  - **pi-scheduler**: new `scheduler-ext-config` skill (cron/interval formats, JSONL event-sourcing storage); legacy store import now resolves candidate dirs via `getAgentDir()` so isolated agent dirs (`PI_CODING_AGENT_DIR`) work.

  - **pi-quota-providers**: quota cache moved from `<agentDir>/statusline_cache.json` to `<agentDir>/config/quota-cache.json` (first-load migration, old cache ignored → cold refetch); all paths derive from `getAgentDir()` for instance isolation.

  - **pi-subagent-workflow**: fix worktree registry pid staying 0 in RPC mode (reaper could reap live worktrees after grace timeout — pid is now registered right after spawn); skill/session-dir resolution derives from `getAgentDir()` instead of hard-coded `~/.pi/agent`.

  - **pi-plan**: global plan-template directory derives from `getAgentDir()` so isolated agent dirs (`PI_CODING_AGENT_DIR`) are respected.

## 7.3.2

### Patch Changes

- 2f38dbd86: Inject worktree guidance prompt so subagents know their cwd is a git worktree.

  Subagents spawned with `worktree:true` received no prompt explaining their
  cwd was a dedicated git worktree checkout. The worktree is placed under
  `os.tmpdir()` (e.g. `/private/var/folders/.../pi-subagents/.../pi-sub-<id>`),
  which looks like a temporary sandbox. Subagents misjudged it as an empty
  isolation directory and `cd`'d elsewhere (e.g. the parent worktree),
  abandoning their isolated workspace — observed in a cw wave-agent session
  where the agent thought its worktree was an empty sandbox and operated in
  the parent worktree instead.

  Now when `worktree:true` is set, a `WORKTREE_GUIDANCE_PROMPT` is injected
  into the subagent's append-system-prompt, stating: the cwd is a git worktree
  with the complete project source, how to find the repo root
  (`git rev-parse --git-common-dir`), that file changes are auto-captured as
  a patch (no need to commit/push), and explicitly NOT to `cd` elsewhere
  looking for "the real project".

## 7.3.1

### Patch Changes

- 291d9645a: fix: register worktree pid synchronously after spawn + robust cw spawn errors

  - `subagent-workflow` session-runner: register the worktree pid synchronously right after `spawn()` returns (`child.pid` is available synchronously), instead of only in the stdout header branch which never fires in RPC mode. Previously the pid stayed 0 and the orphan reaper deleted **live** worktrees after the 60s grace period — killing wave-agent cwds and breaking recursive orchestration. Adds warn logs for pid=0 entries past grace and pid-write failures (observability loop).
  - `cw-tool` cw-spawn: check cwd exists before spawning, and include the cwd in ENOENT error messages (previously only the command name was shown, causing misdiagnosis of missing worktree directories).

## 7.3.0

### Minor Changes

- 4f6e24f45: Add nested execution tree reading and workflow/session record discovery

  - `session-reader`: resolveSessionId now supports three forms (sessionId, taskId/runId, subagent slug), builds nested execution trees via parentRecordId (family mode), discovers workflow runs, enriches SubagentRef records with agent name and manifest/parent fallbacks, and adds find-by-task/slug/agentName matching with source filtering.
  - `subagent-workflow`: persist parentRecordId in the subagent manifest so session-reader can reconstruct the nested execution tree.

## 7.2.0

### Minor Changes

- bc336c3b5: Recursive subagent cross-process visibility: `/subagents` now shows the full recursive tree (A->B->C...), not just level-1

  - Identity fields (rootSessionId/parentRecordId/depth) propagated across process boundaries via 3 new env vars (PI_SUBAGENT_ROOT_SESSION_ID / SELF_RECORD_ID / DEPTH), mirroring the existing PI_SUBAGENT_FORK_DEPTH mechanism
  - A 4th env var (PI_SUBAGENT_ROOT_CWD) carries the true ROOT cwd into child processes: with worktree isolation (spawn cwd = checkout path) the session/record persistence dirs are now uniformly encoded under enc(ROOT cwd), so deep (depth >= 2) records remain visible to the ROOT process's disk reconstruction (previously they landed in enc(checkout) and vanished from /subagents)
  - createRecordForMode uses the propagated true root session id instead of the per-process session id, so deep recursive records survive the collectRecords rootSessionId filter
  - Fork-branch subagents now attach to the top ROOT and are visible from the main session
  - Process-level baselines (execCtxBaseline/forkDepthBaseline) as fallback for ALS reads, since RPC mode ALS stores do not propagate across independent async chains
  - Behavior change: the nesting guard now counts from the propagated process baseline (previously ALS gaps could reset depth to 0 in child processes), so flows nesting beyond MAX_FORK_DEPTH are now rejected with ForkDepthExceededError instead of silently passing

## 7.1.0

### Minor Changes

- a0d700161: cw 生态改进：worktree-fork 解耦、cw-tool workspace gate、goal budget 默认策略

  - **pi-cw-tool**: 新增 workspace gate——探测 cw-cli store-normalization 能力，支持时作为纯 wrapper（不传 `--workspace`），不支持时回退 detectRepoWorkspace + `--workspace`。placeholder 版本号（99.0.0）保持当前行为不变，待 coding-workflow S1 落地后激活。同时把 planning-agent / wave-agent / pi-cw skill 的 `fork` 默认值改为 false。
  - **pi-subagent-workflow**: worktree（文件隔离）与 fork（上下文继承）解耦——移除 "worktree 必须配 fork" 的强约束，`worktree:true + fork:false` 现在可用。subagent-tool / types / notifier / bg-notify-render 同步去掉 fork+worktree 耦合描述。
  - **pi-goal**: 强化 budget 默认策略——tokenBudget 参数 description、tool description、promptGuideline 三处一致声明「默认不设预算；仅在用户显式要求或明确同意时才设；切勿自行决定」（timeBudget 已在上游 main 移除，本 PR 适配到 main 的新 schema 结构）。

## 7.0.1

### Patch Changes

- 246cd5e72: Align the `@xyz-agent/extension-protocol` dependency specifier to `^0.4.0`. The previous `^0.3.1` range does not satisfy the 0.4.0 breaking bump, so consumers installing these packages would fail to resolve protocol 0.4.0 (ERESOLVE).

## 7.0.0

### Major Changes

- 1acbdd2ff: reviewer agent renamed to code-reviewer (BREAKING). Enhanced review agents with adversarial stance, root-cause vs symptom check, and systematic side-effect auditing.

  - **reviewer → code-reviewer** rename (breaking: `batch1=reviewer` / `agent: "reviewer"` no longer resolves). Major bump.
  - **code-reviewer**: adversarial default-suspicion stance, core-logic-first prioritization over trivia, systematic side-effects & omissions checklist (callers / error-reset / async / blast radius).
  - **oracle**: upgraded from checklist matcher to root-cause auditor — adversarial stance, root-cause vs symptom judgment (treats-symptom red flags), sibling-requirement drift check.
  - **doc-reviewer**: adversarial stance (verify every claim against source), strengthened Pass 2 mechanism tracing.
  - review-business-logic (project agent, not published): adversarial stance, root-cause category, systematic side-effects checklist.

  Linked group (`@zhushanwen/pi-structured-output`, `@zhushanwen/pi-subagent-workflow`, `@zhushanwen/pi-ask-user`): companions are reference-bumped only (`updateInternalDependencies: patch`), no forced major — the major bump is scoped to `@zhushanwen/pi-subagent-workflow` (renames are contained to this package; structured-output / ask-user APIs are untouched).

## 6.0.0

### Minor Changes

- 7e6cddc: resource-discovery scans XYZ_EXTENSION_PATHS (dev-link) for agents/workflows.

  Extension agents/workflows shipped in dev-linked packages (XYZ_EXTENSION_PATHS) are now discovered via the same processPackage path as npm packages. Previously only skills+tools were found via dev-link (pi core resources_discover), while agents/workflows were missed — resource-discovery only scanned agentDir fixed dirs (npm / extensions). New source `user-extension-paths` sits between npm-dev and project-pi in priority (dev-link overrides npm, but project wins). Closes the dev-link asymmetry where a dev-linked cw-tool exposed its pi-cw skill but not its 5 agents.

  resource-discovery 现扫描 XYZ_EXTENSION_PATHS（dev-link 扩展源码路径）发现 agents/workflows，走与 npm 包相同的 processPackage 路径。此前 dev-link 扩展只能被发现 skill+工具（pi core），agents/workflows 丢失（resource-discovery 只扫 agentDir 固定目录）。新增源 `user-extension-paths` 优先级介于 npm-dev 与 project-pi 之间（dev-link 覆盖 npm，但 project 优先）。

## 5.0.2

### Patch Changes

- 4231ad1: Adjust review-fix-loop stage timeouts to accommodate longer retry backoff and long-running write operations:

  - reviewer / aggregate: 30min → 1h (read-only review stages; gives retry backoff more room before wall-clock cutoff)
  - fix: 30min → unlimited (remove `timeoutMs`; write operations such as large refactors / multi-file edits must not be interrupted by a wall-clock timeout)

## 5.0.1

### Patch Changes

- b5c36a2: Land cw recursive orchestration tooling and harden subagent-workflow keep-alive.

  - **pi-cw-tool** (new): role-restricted wrapper around the `cw` CLI. Forwards
    `--workspace <repo root>` so cw operates on the caller's repo regardless of
    the agent's cwd, and maps cw E1 actions (`design`/`execute`/`review`/...) to
    capability-restricted tool surfaces for each recursive-split agent role
    (planning/wave/dev/review/merge).
  - **pi-subagent-workflow**: split the single `agent_end` keep-alive timeout
    into spawn grace (MF-3) and long-running descendants grace (MF-4); add a
    recent-unregister window so a subagent that just unregistered does not
    immediately kill its layer-owner agent (race fix); keep layer-owner agents
    alive while descendants are still pending; guard null entries (S-10).
  - **pi-goal**: align `agent_end` handler with the new keep-alive contract.
  - **pi-pending-notifications**: track pending-descendants state consumed by
    the keep-alive guard.

- Updated dependencies [b5c36a2]
  - @zhushanwen/pi-pending-notifications@0.3.1

## 5.0.0

### Major Changes

- ab166bf: Add workflow-script lint warnings: missing agent() description (nodes unnamed in TUI), meta.phases as object array (ignored by engine), declared phases vs phase() calls mismatch; document description + phase display conventions in workflow-script-format SKILL.md.

  **Breaking change — review-fix-loop built-in workflow behavior (vs 4.0.0):**

  1. **No default batch**: 4.0.0 defaulted to a single `["reviewer"]` batch when no `batch1..batchN`/`agents` args were passed. Now `batch1..batchN` or `agents` is **required** — invoking without them fails fast with `缺少批次参数`. Update existing invocations to pass an explicit batch.
  2. **`recheckAfterFix` default stays `false` (same as 4.0.0)**: strong regression protection is opt-in — pass `recheckAfterFix=true` to re-dispatch all agents (including previously clean ones) after a fix round. No call-site change needed for existing invocations.
  3. `meta.phases` changed from object array to string array (`["Review", "Fix"]`) per the new lint rule.
  4. Pure functions (arg validation / batch parsing / aggregation parsing / review-instruction building) extracted into `review-fix-loop-utils.cjs` with vitest coverage — no behavior change, internal refactor.

  The implementation intentionally diverges from main's 4.0.0 version (branch version keeps the utils module + tests + `fallow-scan` support). The two versions conflict on merge (add/add); resolve keeping this branch's version.

### Patch Changes

- 531cd86: Fix-phase now consumes custom fixer.md `model` frontmatter field (was dropped — only global `--args model=` took effect). Aligns with review-phase semantics (`MODEL || def.model`). Also documents the `fixAgent` + convergence params (`maxFixAttempts`/`convergeNewIssues`/`convergeRounds`) in the workflow tool description so LLMs discover them.
- Updated dependencies [6e2e453]
- Updated dependencies [2eff0c7]
  - @xyz-agent/extension-protocol@0.3.1
  - @zhushanwen/pi-structured-output@5.0.0

## 5.0.0-dev.1

### Patch Changes

- Fix-phase now consumes custom fixer.md `model` frontmatter field (was dropped — only global `--args model=` took effect). Aligns with review-phase semantics (`MODEL || def.model`). Also documents the `fixAgent` + convergence params (`maxFixAttempts`/`convergeNewIssues`/`convergeRounds`) in the workflow tool description so LLMs discover them.

## 5.0.0-dev.0

### Major Changes

- ab166bf: Add workflow-script lint warnings: missing agent() description (nodes unnamed in TUI), meta.phases as object array (ignored by engine), declared phases vs phase() calls mismatch; document description + phase display conventions in workflow-script-format SKILL.md.

  **Breaking change — review-fix-loop built-in workflow behavior (vs 4.0.0):**

  1. **No default batch**: 4.0.0 defaulted to a single `["reviewer"]` batch when no `batch1..batchN`/`agents` args were passed. Now `batch1..batchN` or `agents` is **required** — invoking without them fails fast with `缺少批次参数`. Update existing invocations to pass an explicit batch.
  2. **`recheckAfterFix` default stays `false` (same as 4.0.0)**: strong regression protection is opt-in — pass `recheckAfterFix=true` to re-dispatch all agents (including previously clean ones) after a fix round. No call-site change needed for existing invocations.
  3. `meta.phases` changed from object array to string array (`["Review", "Fix"]`) per the new lint rule.
  4. Pure functions (arg validation / batch parsing / aggregation parsing / review-instruction building) extracted into `review-fix-loop-utils.cjs` with vitest coverage — no behavior change, internal refactor.

  The implementation intentionally diverges from main's 4.0.0 version (branch version keeps the utils module + tests + `fallow-scan` support). The two versions conflict on merge (add/add); resolve keeping this branch's version.

### Patch Changes

- Updated dependencies [6e2e453]
- Updated dependencies [2eff0c7]
  - @xyz-agent/extension-protocol@0.3.1-dev.0
  - @zhushanwen/pi-structured-output@5.0.0-dev.0

## 4.0.0

### Minor Changes

- 74a0b10: Two changes ship in this PR:

  1. Remove the ask-user comment feature end-to-end:

     - `@xyz-agent/extension-protocol`: remove `getAskUserComment` helper and
       `allowComment` field from the ask-user protocol (breaking — package is
       still 0.x, so a `minor` bump denotes a breaking change per semver).
     - `@zhushanwen/pi-ask-user`: remove the public tool-schema field
       `allowComment`, the `ANSWER_COMMENT_SEPARATOR` split, the comment
       interaction mode, and `getAskUserComment` usage (breaking — public API
       removal, `major` bump).

  2. Add `thinkingLevel` support to subagent-workflow's `agent()`:
     - `@zhushanwen/pi-subagent-workflow`: `agent()` now accepts an optional
       `thinkingLevel` option (off|minimal|low|medium|high|xhigh) propagated
       through to the pi CLI spawn args (additive feature, `minor` bump).

  `@zhushanwen/pi-structured-output` is in the same changeset `linked` group as
  the two `@zhushanwen/pi-*` packages and has no code changes; `changeset
version` will reconcile it to the group's highest bump automatically.

### Patch Changes

- 8e222bc: Add review-fix-loop built-in workflow (multi-batch serial review-fix loop); grant reviewer agent structured-output tool; improve review-fix-loop failure diagnostics.
- Updated dependencies [74a0b10]
  - @xyz-agent/extension-protocol@0.3.0

## 3.0.0

### Minor Changes

- 07ee286: Add worktree support and returnMeta mode to workflow agent() calls.

  - **W1 — worktree support for `agent()` calls**: subagent-service and worker-script-builder now accept a `worktree` option, allowing workflow-spawned agents to run in dedicated git worktrees instead of the main worktree.
  - **W2 — `returnMeta` mode**: a new execution mode that returns `worktreePath` and `sessionFile` metadata from spawned subagents, so parent workflows can reference the child's worktree and session.

### Patch Changes

- e33b3a6: Migrate bare console.\* to shared extension-logger (three-channel routing via appendEntry/file-log). Eliminates TUI raw stderr pollution and redundant tool-error notify.

  <!-- TODO(monorepo-impact): 三个包不在同一 linked 组。pi-extension-logger 作为 -->
  <!-- 静态强依赖出现在 subagent-workflow/unified-hooks 的 dependencies，值为 -->
  <!-- `workspace:*`，发布时会被 workspace 工具替换为精确版本号（无 `^`/`>=` 范围保护）。 -->
  <!-- logger 未来若发 breaking，已装 consumer 不感知。logger 语义稳定前可接受。 -->
  <!-- 如需加固：发布后人工核对 consumer package.json 产物是否带 caret，必要时 -->
  <!-- 改 `publishConfig` 或发布后手动改成 `^0.1.0`。提示非阻塞。 -->

- Updated dependencies [1e33329]
  - @zhushanwen/pi-extension-logger@0.2.0

## 2.0.1

### Patch Changes

- deafa7f: Fix silent schema-bypass in workflow mode: structured-output now validates data against the authoritative schema from PI_WORKFLOW_SCHEMA env instead of the LLM-supplied schema parameter. Workflow-mode prompts updated to guide LLM to pass only data.

  Workflow-mode structured-output prompt sync (subagent-workflow): the system-prompt instruction written by `resolveAgentOpts` for the `agent({schema})` override and the `formatSchemaInstruction` helper now instruct the LLM to pass ONLY the `data` parameter and do NOT pass a `schema` parameter, because the schema is enforced by the system.

- Updated dependencies [deafa7f]
  - @zhushanwen/pi-structured-output@2.0.1

## 2.0.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

### Patch Changes

- Updated dependencies [83e97ab]
  - @zhushanwen/pi-structured-output@2.0.0

## 0.4.3

### Patch Changes

- 486746a: Fix: all built-in workflows (parallel/chain/map-reduce/scatter-gather) crashed with "Worker exited with code 1".

  Two root-cause bugs in `worker-script-builder.ts` (the generator of Worker-thread source code), both slipped through because existing tests were pure string `toContain` assertions that never executed the generated code:

  1. **`_safePost` scope bug**: `_safePost` was declared inside the async IIFE but used in the outer `.then()`/`.catch()` return/error handlers (outside the IIFE scope). Every script `return` triggered `ReferenceError: _safePost is not defined` → Worker exit 1. Fix: hoist `_safePost` (and the `parentPort`/`workerData` handles) to module scope.

  2. **`parallel()` Promise-array bug**: CC-compatible scripts write `parallel([agent({...}), ...])` passing an array of already-instantiated Promises. The implementation passed each Promise back into `agent()` as opts → `postMessage` `DataCloneError` → all agents rejected. Fix: thenable duck-type check at the top of the `parallel()` map callback to return in-flight Promises directly.

  Also adds a three-layer test strategy (documented in `docs/extensions/subagents/testing.md`):

  - **L2 runtime tests** (`worker-script-builder-runtime.test.ts`): spin up a real `node:worker_threads` Worker to execute the generated code, covering return/throw/agent/abort/workflow/execute paths plus the Promise-array regression.
  - **L3 workflow E2E** (`workflows-e2e.test.ts`): run all 4 built-in workflows through the real `runAndWait` orchestration (real Worker thread + real scripts + real JsonlRunStore), mocking only the LLM `AgentRunner`. All 4 workflows now pass.

## 0.4.2

### Patch Changes

- 83da227: Change parallel builtin workflow aggregate output shape from object to string.

  The `parallel` workflow's aggregate phase no longer calls an LLM with a `{overallScore, topIssues, consensus}` object schema. Instead it produces a pure-code concatenation of per-perspective findings as a single string (`[perspective] finding1; finding2\n...`). The `aggregate` field of the workflow result is now a plain string rather than the previous structured object.

  Rationale: removing the LLM aggregate call makes the parallel workflow deterministic and cost-bounded; downstream consumers of `aggregate` must read it as a string.

## 0.4.1

### Patch Changes

- 9169119: Migrate all Pi SDK references from the deprecated `@mariozechner/pi-*` namespace to the active `@earendil-works/pi-*` namespace. This eliminates the five deprecation warnings emitted during `pnpm install` (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, transitive `@mariozechner/pi-agent-core`, and transitive `node-domexception`).

  **Changes:**

  - **package.json**: all `peerDependencies` / `peerDependenciesMeta` referencing `@mariozechner/pi-*` updated to `@earendil-works/pi-*` (versions unchanged: `*`)
  - **TypeScript sources**: all `import ... from "@mariozechner/pi-*"` updated to `import ... from "@earendil-works/pi-*"` across 98 files (438 import occurrences including `declare module` and dynamic `import()` types)
  - **`tsconfig.json` paths**: removed `@mariozechner/pi-*` dual-alias entries; kept only `@earendil-works/pi-*`
  - **`vitest.config.ts` aliases**: removed `@mariozechner/pi-*` entries; updated stub path targets to `./shared/types/earendil-works/index`
  - **`shared/types/mariozechner/` → `shared/types/earendil-works/`**: stub directory renamed, `declare module` names updated, `shared/types/package.json` `main` and `files` fields updated
  - **Monorepo cross-package references**: `extensions/ask-user` (`@zhushanwen/pi-subagent-workflow`) and `extensions/subagent-workflow` (`@zhushanwen/pi-structured-output`) switched from `*` to `workspace:*` so local development uses the just-edited sources instead of pulling deprecated versions from npm
  - **`pnpm.allowedDeprecatedVersions.node-domexception = "1.0.0"`**: silences the remaining unavoidable transitive deprecation (`@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios@7` → `node-fetch@3` → `node-domexception`); `node-domexception` is a Node 22+ redundant polyfill, not a functional issue

  **No functional changes** to extension behavior, types, or APIs. `pnpm install`, `pnpm -r typecheck`, and `pnpm -r test` all pass cleanly with zero deprecation warnings.

  **Follow-up hardening (no functional impact):**

  - **`.githooks/validate-no-mariozechner-pi`** (new): standalone grep-based scanner that errors when `@mariozechner/pi-` appears in staged files or in workspace path checks. Can also be called manually for ad-hoc audits (`bash .githooks/validate-no-mariozechner-pi [<files>]`).
  - **`.githooks/pre-commit`** (`-0.` namespace check): wired `validate-no-mariozechner-pi` as a pre-manifest gate. Any staged file in `extensions/` or `shared/` (including `package.json`, `vitest.config.ts`, `.d.ts`) containing the deprecated namespace blocks the commit. `SKIP_NAMESPACE_CHECK=1` hotfix bypass must be justified in the PR description and tracked with an issue.
  - **`.githooks/pre-commit`** (`0b` peerDep check): the package.json deep check now requires `@earendil-works/pi-coding-agent` and explicitly rejects `@mariozechner/pi-coding-agent` (was incorrectly accepting the deprecated name as the success signal).
  - **AGENTS.md** new section "禁止使用已废弃的 Pi SDK namespace [MANDATORY]": documents the namespace rule, the gate script location, and what to do if Pi renames the namespace again.
  - **docs/STANDARDS.md / docs/monorepo-conventions.md / docs/quality-gates.md**: updated example `package.json`, import snippets, and `peerDependencies` descriptions to use `@earendil-works/pi-*`. Old historical docs (`docs/evolution/`, `docs/third-party-extensions/`, `docs/research/`) retain the deprecated references as factual record of past investigations.
  - **Bonus fix**: `pre-commit` had a latent bash bug `${#TEST_PKGS[@]:-}` (not a valid parameter expansion). Fixed to `${#TEST_PKGS[@]}` while validating the new gate.

- Updated dependencies [9169119]
  - @zhushanwen/pi-structured-output@0.3.5

## 0.4.0

### Minor Changes

- a090b61: > **版本口径**：本包处于 0.x 阶段。按 SemVer §6「0.x 可能在任何次版本引入破坏性变更」，minor bump 允许含 breaking。下方标注的 **Breaking** 是改动性质说明，不对应 major bump。

  重构 subagent-workflow tool 面，提升弱模型调用正确率：

  **Breaking** — `workflow` tool 删除 `retry-node` / `skip-node` 两个 action（7 → 5 action：run/status/pause/resume/abort）。这两个 action 语义尴尬（retry-node 重跑失败节点但不改脚本输出；skip-node 注入零 usage 占位结果），删除后 `node-ops.ts` 整文件移除。共享基础设施 `executeAgentCall` / `postBudgetUpdate` 仍由主路径使用，无死代码。`callId` schema 字段随之移除。

  **Feat** — subagent ID 从纯 UUID 改为 `sa-<uuid>` 前缀格式，与 workflow runId 的 `wf-` 前缀风格统一。前缀是视觉辅助（所有消费方零格式校验，不进入程序逻辑判别），帮助 LLM/人眼通过 ID 区分 subagent 与 workflow。`shortId` 显示层加 `sa-` 感知分支保持信息量。向后兼容：旧纯 UUID ID 可正常反序列化。

  **Refactor** — `subagent` tool 的 `startParam` 13 字段（task/slug/agent/model/thinkingLevel/skillPath/appendSystemPrompt/schema/maxTurns/graceTurns/fork/worktree/cwd）从嵌套 envelope 拍平到顶层 schema。解决 flat JSON Schema 无法表达条件必填导致弱模型（GLM/DeepSeek）把 task/slug 平铺到顶层的痛点。删除 `hasFlattenedStartFields` runtime guard（拍平后语义反转）+ `hasStartParam` helper。`listParam` / `cancelParam` 保留嵌套（字段少，保留隔离）。`description` TDD 重写（432 词），正例改平铺。service 层契约（`ExecuteOptions`）不变，改动收敛在 tool 层。

  不新增统一管理 tool（保持 3 tool：subagent / workflow / workflow-script）。

### Patch Changes

- b5f53fd: 修正内置 agent 模板的 `tools:` 字段与 body 描述：

  - `researcher`：tools 由 `read` 改为 `read, bash`（tavily-web-search 是 CLI 类型 skill，必须 bash 执行）。body 重写 skill 调用方式——Pi 没有 `Skill` 工具，skill 通过 `<available_skills>` 注入，LLM 用 `read` 读 SKILL.md 再用 `bash` 跑命令。同时 body 收窄了 read-only 范围（仅禁止改源文件，不禁止跑 tavily CLI）。
  - `explorer`：tools 增 `find, ls`（结构化文件/目录查询工具，优于 shell `find`/`ls`）。body free-to-run 列表移除 `find`/`grep`/`ls` 字眼（避免与 Pi 工具语义混淆），新增工具优先级提示。
  - `orchestrator`：tools 增 `ask_user`（扩展工具，由 `@zhushanwen/pi-ask-user` 提供）。body 提示该工具在未装 ask-user 扩展的 pi 环境中静默兼容（Pi 端 `_rebuildSystemPrompt` 静默过滤未注册工具，subagent-workflow 不做特殊处理，纯透传 `--tools` 参数）。新增「遇到需求歧义时反问用户」指引。
  - 测试断言补齐：原 `arrayContaining(["worker", ...7 个])` 改为全部 9 个 agent 精确断言 + 每个 agent 的 `tools` 字段精确匹配 frontmatter（`worker`/`general-purpose` 为 `undefined`、其余为具体数组）。未来改 frontmatter 会立即报错。

  未变更：`worker` / `general-purpose` 模板保持工具全开 + prompt 软约束（按用户要求不增加 Tool scope 风险标注）。

## 0.3.3

### Patch Changes

- 72e6a61: Fix non-deterministic loss of subagent completion notifications.

  Subagent completion notifications are delivered via a detached microtask
  calling `sendMessage({ triggerTurn: true, deliverAs: "steer" })`. When this
  microtask lands inside the main agent's `agent_end` → `finishRun` race window
  (`isStreaming` still `true`), pi's `sendCustomMessage` takes the steer branch:
  the message is enqueued into `steeringQueue`, but the run loop has already
  ended and nothing drains the queue — the notification is silently dropped and
  the main agent never produces a follow-up turn.

  Fix: add an `isIdle()` gate in `BgNotifier.flushPendingNotifications`. When the
  main agent is still streaming, flush backs off (`setTimeout` 100ms) and retries
  until idle, then sends synchronously. Because `isIdle()` and `sendMessage`
  share the same synchronous read of `agent.state.isStreaming` (host.sendMessage
  does not await), once `isIdle` returns `true` the subsequent `sendMessage` is
  guaranteed to hit the `triggerTurn` branch and start a new turn. A backoff cap
  (50 × 100ms = 5s) forces a fallback send to avoid notification starvation when
  the main agent stays busy for a long turn.

  `isIdle` is injected from `ctx.isIdle()` in `session_start`, threaded through
  `SubagentService` → `piAdapter()` → `NotifierHost`. It is optional, so legacy
  hosts without it keep the original immediate-send behavior.

## 0.3.2

### Patch Changes

- 4ed62ca: Subagent 子进程镜像主进程的 extension/approve flag

  新增 `mirrorMainProcessFlags(argv)`：从主 pi 进程的 `process.argv` 解析
  `--extension` / `--no-extensions` / `--approve`，透传给 `buildSpawnArgs`，
  让 subagent 子进程的 extension 加载行为与主进程一致（之前子进程完全不继承，
  会加载全局自动发现的 extension 且不信任项目级 .pi/skills）。

  - 数据源是主进程 argv（已运行时验证完整保留启动 flag），非 env 传递
  - 向后兼容：argv 无这些 flag 时 `buildSpawnArgs` 行为完全不变
  - 对任意 pi 宿主通用（不只 xyz-agent），xyz-agent 侧零改动
  - 嵌套 subagent（孙进程）自动继承——镜像后父进程 argv 自带这些 flag

## 0.3.1

### Patch Changes

- bb86ee9: Harden 5 tool descriptions + runtime validation against weak-model first-call parameter misuse.

  Triggered by a real session where a flash-tier model (step-3.7-flash) called the `subagent` tool with `task`/`slug` flattened to the top level (missing the `startParam` envelope) and needed a round-trip to self-correct. Root cause analysis found a systemic debt pattern across 5 tools: conditional-required fields expressed as `Type.Optional`, zero JSON call examples in descriptions, no parameter-structure anti-patterns, dry runtime error messages with no Correct example, and no prompt-quality regression tests.

  Three-layer fix applied uniformly to all 5 tools (subagent + workflow + goal_control + todo + ask-user + structured-output):

  - **Runtime friendly correction**: required-field throws now append a copy-pasteable `Correct: {full JSON}` example; common-misuse detectors catch the highest-frequency errors and return a corrected shape (subagent `startParam` flattening; workflow `args` sub-field flattening — a P0 silent failure; todo `text`/`texts` + `id`/`ids` dual-shape trap; ask-user string `options` array).
  - **Description examples + structural anti-patterns**: each tool now ships complete JSON call examples for every high-risk action and a Don't section listing parameter-structure mistakes.
  - **Prompt-quality regression tests**: new source-text assertion test per tool locks the examples / anti-patterns / Correct-usage strings so they cannot silently regress.

  Notable silent-failure closures (worse than the original throw-based failure because they did not error at all):

  - **structured-output**: `schema`/`data` swap detection + keyword-less schema rejection. Previously `Type.Unknown()` + `ajv strict:false` compiled a keyword-less object (e.g. `{}`, `{a:1}`) into an accept-anything validator — swapping schema and data then passed validation and stored garbage silently. Now detected and rejected with a Correct hint.
  - **workflow**: flattened `args` sub-fields (task/items/...) previously fell through to `args = params.args ?? {}`, silently launching a run missing its parameters.

  Other changes:

  - **subagent + workflow**: `slug` `maxLength` relaxed 20 → 35 (single source `SLUG_MAX_LENGTH`; both schemas now reference the constant). Descriptive kebab-case slugs like `fix-subagent-wf-tools` (21) no longer collide; over-limit error now suggests a shorter label.
  - **ask-user**: `InputSchema.options` element intentionally loosened to `OptionSchema | string` so a mistyped string-array `options` reaches `validateInput` (friendly Correct error) instead of being killed by the schema layer's raw ajv error before `execute` runs. Internal `Question`/`Option` types stay strict.
  - **structured-output**: extracted `executeStructuredOutput()` for direct unit testing (internal test helper — not re-exported from the package root, so not part of the public API); deleted stale `STRUCTURED_OUTPUT_SCHEMA` env-name + tool_call block tests (0.3.0 changed to unconditional registration, real env name is `PI_WORKFLOW_SCHEMA`).

  Review follow-up (addressed in the same PR after a 6-dimension multi-agent code review):

  - **structured-output**: `SCHEMA_KEYWORDS` completed with the remaining draft-07 validation keywords (`if`/`then`/`else`/`dependencies`/`propertyNames`/`contains`/`$defs`/`definitions`) so a conditional root schema is no longer wrongly rejected as keyword-less; `executeStructuredOutput` return type widened from `Record<string,unknown>` to `unknown` (data may be a primitive/array per its own tests); `getOrCompileValidator` now accepts `object | boolean` (boolean root schemas are valid draft-07), eliminating an unsafe cast; `tool_execution_end` handler uses a runtime type guard instead of a bare cast; `echo()` now tolerates `undefined` (`JSON.stringify(undefined)` returns undefined and previously crashed `.length` — a latent bug surfaced by the new edge-case tests).
  - **subagent-workflow + todo**: detectors (`hasFlattenedStartFields`, workflow `findFlattenedArgKeys`, todo `handleAdd`/`handleDelete`) now exported to enable behavioural trigger/no-trigger tests — the P0 workflow flatten detector previously had only a fragile source-text lock. Added slug boundary tests (35/36) and a workflow-side runtime slug guard matching subagent's.
  - goal_control `hasGoalDetails` guard tightened to validate the `details` value is an object (not just that the key exists).

  All five packages are bumped `patch`: no breaking API changes, no new public exports forming a supported API contract (the exported detectors are test helpers, not a stable surface), and the ask-user schema loosening + structured-output keyword-less rejection only surface clearer errors for inputs that were already malformed (previously silently corrupted or raw-ajv-rejected). This is defensive hardening + prompt-quality work, conservatively versioned as patch.

- Updated dependencies [bb86ee9]
  - @zhushanwen/pi-structured-output@0.3.4

## 0.3.0

### Minor Changes

- bd68203: Decouple subagent execution record identity from transcript lifecycle (ADR-035):

  - Record id uses `crypto.randomUUID()` for global uniqueness across restarts
  - Atomic manifest persistence (`<uuid>.json`) carrying sessionFile, status, timestamps
  - RPC `get_state` handshake after spawn to resolve sessionFile/sessionId robustly
  - Orphan session detection + tmp residue recovery on startup
  - PID alive timeout narrowed (24h → 1h) to bound stale-record window
  - Manifest write failures surface as errors (no silent swallow)
  - Manifest status enum expanded from 3-state to 4-state (add cancelled; crashed stays as reconstruction-derived state, not persisted in manifest)

### Patch Changes

- 4fe4906: Fix subagent ask_user end-to-end unavailability and generalize UI transit to a two-dimension orthogonal architecture (method interaction model + channel registry).

  Root causes fixed:

  - Protocol format error (expected JSON-RPC 2.0 but Pi emits flattened `{type, method, ...}`)
  - Handler injection completely missing (index.ts session_start did not pass uiRequestHandler)
  - No method/channel dispatch (all UI requests merged into single handler)
  - No TUI/GUI/headless mode dispatch (W4 prompt injected unconditionally)
  - Silent failure when handler missing (no observability)
  - No cross-subprocess concurrency queue (multiple ask_user flood parent UI)

  Architecture (ADR-033): two orthogonal dimensions:

  - Transit + queue strategy determined by method interaction model (dialog classes transit + L2 queue; fire-and-forget not transited under TUI)
  - Business routing determined by channel registry (ask_user / gui_widget / future)

## 0.2.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

- 2003e64: Add RPC-mode lifecycle control to /subagents and /workflows command handlers so xyz-agent GUI can trigger cancel/pause/resume/abort via slash command (e.g. `client.prompt("/subagents cancel <id>")`) without LLM round-trip. TUI paths unchanged; headless (print/json) guard tightened from `!ctx.hasUI` to `ctx.mode !== "tui"`.

### Patch Changes

- Updated dependencies [96aed1d]
  - @zhushanwen/pi-structured-output@0.3.3
