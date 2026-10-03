# @zhushanwen/pi-subagent-workflow

## 9.2.0

### Minor Changes

- b44f1316b: The subagent/subagents/workflow tools accept any valid absolute path as the target ref, not only `<location>` values from the injected lists — the file must exist and parse as an agent definition (`.md`) or a `@pi-meta` workflow script (`.js`); bare names and relative paths stay rejected. Display layering lands across rendering surfaces: compact tool lines and tray rows show basename short names (`worker`, `batch`), expanded/detail views keep the full ref, and workflow runs now project `scriptPath` so the GUI header shows the script's absolute path (older runs without the field fall back to `scriptName`).

## 9.1.1

### Patch Changes

- a9b6a9fc7: chore: refresh dependency range (triggered by @zhushanwen/pi-notify-ledger-host@0.2.1 → @zhushanwen/pi-notify-ledger-host@0.2.2, @zhushanwen/subagent-core@1.0.0 → @zhushanwen/subagent-core@1.1.0)

## 9.1.0

### Minor Changes

- 0d36077d4: run 恢复重建与会话替换可靠性增强：record 流折叠重建现在恢复生效预算（budgetTimeMs/budgetTokens 按 run-resumed > run-created 三档回落）、真实 token 会计与 errorLogs 诊断日志（此前重建产物为空/零值）；终局事实随重建注入 core 终局记录注册表。会话替换（switchSession / reload）时作废 core pi 读面绑定，避免旧失效句柄上的 assertActive 抛错打断在途 run 的轮终收尾。历史格式条目（v1 快照 / 旧指针）不再识别、从读取面消失；record 锚点字段与常量对齐 subagent-core 改名（journalPath → recordPath、RUN_EVENT_JOURNAL_SUFFIX → RUN_EVENTS_SUFFIX），跨包 slot key 收敛到 core `GLOBAL_SLOT_KEYS`。

## 9.0.1

### Patch Changes

- 8aa4b40e8: Notify-ledger host assembly (five-port wiring + stale-ctx guarded delivery) now comes from the shared `@zhushanwen/pi-notify-ledger-host` factory instead of an inline literal. Delivery semantics are unchanged: single `{ triggerTurn: true }` wake-up channel, silent downgrade on stale context, abandon display messages stay non-waking; guard labels keep the `subagent-workflow:` prefix and warnings stay attributed to this package's logger.

## 9.0.0

### Major Changes

- 50f31a73c: Symmetrize the abort check across the three tools: the workflow-script tool now honors an aborted AbortSignal at the execute entry for all five actions (previously only generate checked it — lint/save/delete/list ran anyway), with the in-action check removed from actionGenerate (which no longer takes a signal). Also converged the six required-parameter rejection messages onto one template — `<subject> requires '<param>' parameter. Correct: <minimal call example>` — so weaker models can self-correct from a consistent shape: run (dropped the optional args from the example), abort (reordered to match the template), lint/save/delete (gained a Correct example), and subagents tasks (subject now named). New black-box tests lock the five early-exit paths (zero side effects) and the updated copy; the run-finality evidence read order across the three disk channels is now declared once in subagent-core's run-events.ts header, with the four scattered comment sites reduced to pointers.

- 50f31a73c: Make the available-workflow list item template single-sourced: core's formatAvailableWorkflowRefs gains two boolean options (includeLocation, includeSource — defaults keep the run-rejection format byte-identical) and the two hand-rolled forks in the workflow-script tool now consume it. Deliberate LLM-visible changes: the lint not-found suggestions list now includes the location line (aligned with the run-rejection self-recovery guidance), and the actionList items switch from "[source] name — desc" to "- [source] name: desc" (separator unified to ":"). actionList's LLM-visible output goes from zero coverage to black-box tested (full text, empty state, details/GUI projection), and the formatter itself gains table-driven direct tests over both option axes plus the available filter.

- 50f31a73c: Converge the pi-host sessionDir layout (cwd slug + existsSync probe) into a single source of truth: `resolvePiSessionScopedDir` is now exported from the subagent-core barrel, and the shell extension's `resolveSessionDir` became a thin consumer that injects the live pi SDK `getAgentDir()` via `opts.agentDir`. The previously duplicated slug rule (shell + core copies cross-referenced only by comments, with drift surfacing as runtime failures such as the reconcile sweep wrongly unregistering active runs) is gone; `resolvePiWorkflowStateDir` is now a pure workflow-state suffix derivation over the shared resolver with byte-identical behavior.

- 50f31a73c: Single-source the notify-channel custom_message customType vocabulary in the protocol package (new exports: WORKFLOW_RESULT_CUSTOM_TYPE, SUBAGENT_BG_NOTIFY_CUSTOM_TYPE, SUBAGENT_DIRECTIVE_CUSTOM_TYPE — values unchanged, byte-identical). Producers and consumers now import the same constants instead of mirrored string literals that had zero cross-side anchoring: the shell's completion-notify sender, messageRenderer registration, and directive-entry writer; subagent-core's NOTIFY_CUSTOM_TYPE (compat alias) and the abandoned-notification recovery-hint channel check; the shared COMPLETE_NOTIFY_CUSTOM_TYPES set is now assembled from the constants (with SUBAGENT_DIRECTIVE_CUSTOM_TYPE re-exported), and runtime's event-interpreter / subagent-extractor plus core's notify-summary compare against them. A conformance test in the shell locks the three values and forbids local re-definitions at the producer sites. Also folded into the shell: the fourth GUI attach point now goes through the shared withGuiAttach helper (returns a new object instead of in-place mutation, byte-equivalent payloads), and the in-flight reporter creation plus setInFlightListener wiring moved from the factory root into setupWorkflowDomain (index.ts passes no wiring; behavior unchanged).

- 50f31a73c: New `relay-frames` module exports the relay channel frame vocabulary as the single source: `RELAY_FRAME_KINDS` (handshake/accept/reject/data/exit), `RELAY_FRAME_DIRS` (down/up/up-stderr), and `RELAY_REJECT_REASONS` (version/identity/duplicate/malformed), plus derived union types. The runtime relay registry previously spelled these sixteen frame literals inline at construction and comparison sites — the runtime side now imports the constants, and the zero-dependency relay.mjs proxy keeps its embedded literals but gains conformance assertions locking every protocol point (frame construction, negotiation comparison, pump direction, exit) to the SSOT values, closing the gap where the env-constant family had a static lock while the frame vocabulary relied only on end-to-end behavioral tests.

- 50f31a73c: **@zhushanwen/subagent-core**: exports `conventionRootDirs` — the ordered convention-root path set (`~/.agents/<kind>`, `<workspaceRoot>/.pi/<kind>`, `<workspaceRoot>/.pi/<kind>/.tmp` when `includeTmp`, `<workspaceRoot>/.agents/<kind>`) derived from the same single-source helpers that `buildScanTargets` consumes for its hardcoded slots.

  **@zhushanwen/pi-subagent-workflow**: the empty-state discovery-roots hint (`(none discovered; roots: ...)`) now projects the core `conventionRootDirs` derivation instead of duplicating the four convention-root joins — convention-root changes land in core only. Injector tests also hardcode the LIST_GUIDE texts as expectations, so guide copy rewrites now fail tests instead of passing silently.

- 50f31a73c: Subagent crash kill-chain hardening (from the 2026-09-24 kill-chain forensics: every "crash" that day was a host-side SIGTERM, and 41 of 64 kill-on-disconnect log lines were normal post-settled reaping). Exit-code folding for signal-killed children is now POSIX 128+signo (SIGTERM reads 143, matching the runtime-side view; bare 128 misled triage). The relay proxy sends a goodbye frame before exiting on host SIGTERM, so runtime logs distinguish normal teardown (info) from abnormal disconnects (warn + kill decision) — kill behavior is unchanged. The orphan sweep tiers disposal by activity: idle orphans are reaped immediately, still-productive ones are marked pending (persisted in the pid file), deferred with a 30-minute hard cap and a recheck timer, ending the restart-storm oscillation where a just-recovered subagent was reaped by the next runtime generation; re-registering a recordId also reaps the superseded live pid instead of orphaning its ledger entry. Shutdown now waits for in-flight kill chains before the runtime exits (unref timers previously died with the process, leaving SIGTERMed-but-alive children). Failure notices to the main agent carry a recovery tail that warns to check action:'list' before manually taking over (parallel recovery rounds duplicated work in the incident), and dispose-time killAll logs which still-active children it is about to kill — the previously missing first-scene evidence for host-side disconnects.

- 50f31a73c: Move the state-retention cap env parsing into subagent-core: resolveStateMaxRuns and STATE_MAX_RUNS_ENV are now exported from the core barrel, replacing the shell's identical local implementation. The shell's JsonlRunStore also declares `implements RunStore` against the core port type (signature drift is now caught at compile time) and its class doc gains an index of its five interface facets.

- 50f31a73c: Consolidate the workflow-record entry vocabulary and v1 guard into subagent-core as the single source: new exports WORKFLOW_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_ENTRY_VERSION, and classifyWorkflowRecordEntryData (pure classification, logging policy stays with callers). The pi shell store and the runtime extractors now consume the core barrel instead of holding their own copies, and the duplicated constant in @taiji/shared is removed.

- 50f31a73c: Refactor: converge the duplicated tool-interface plumbing in `src/interface/` — the RPC-mode `__gui__` attach (now the single `withGuiAttach` helper in `tool-shared.ts`), the prefixed catch re-throw (`throwPrefixed`), and the expanded/compact render branches (non-list expanded output now reuses `buildCompactLines` byte-for-byte). The `workflow-script` tool result now uses the shared `WorkflowToolResult` base instead of a local `TextContent` interface, and `AdapterInput` is exported for type-only test imports. Within this refactor there is no user-visible behavior change: error messages, rendered output, and GUI payloads are byte-identical. User-script API removals shipped on the same branch (worker `workflow()` global, `pipeline()` Cartesian form, `pi.__workflowRun`) are breaking and covered separately in `workflow-nested-orchestration-api-retired.md`.

- 50f31a73c: BREAKING CHANGE: the nested `workflow()` orchestration API family is removed (workflow capability audit verdicts C-1/C-2 + A-1, commit 6960477cf).

  - Worker-script `workflow(name, args)` global no longer exists. Scripts saved in `.pi/workflows/` / `~/.pi/agent/workflows/` that call `workflow()` now fail at run start with a ReferenceError — this is not caught by script lint, so existing scripts only break when run. Migration: inline the sub-workflow's steps as direct `agent()` calls, or split the composition into separate `workflow run` invocations. The built-in orchestration workflows (chain / parallel / fan-out / scatter-gather / map-reduce / review-fix-loop in the `workflows/` directory of `@zhushanwen/subagent-core`) remain available; they compose via `agent()` directly.
  - `pipeline()` only accepts the single-array form `pipeline([stage1, stage2, ...])`; the multi-argument Cartesian form `pipeline([items], stage1, stage2, ...)` is removed. Migration: map items through the stages manually, e.g. `await parallel(items.map((item) => stage1(item).then(stage2)))` or an explicit for-loop.
  - `pi.__workflowRun` cross-extension programming API is removed from the extension registration surface. No migration needed: the channel was already unreachable at runtime under pi 0.84.4 per-extension API isolation and had zero consumers.

- 50f31a73c: New `isTerminalDoneReason(reason)` predicate exports the DoneReason terminality verdict (exhaustive switch, no default — adding a DoneReason member forces an explicit classification here at compile time). The shell's anti-laziness wrap-up directive in run-completion notifications now consumes this core predicate instead of a local `TERMINAL_REASONS` string-set mirror, which had already drifted: it contained a ghost member `circular` that core's vocabulary never produces. The shell module is also renamed from `interface/helpers.ts` to `src/workflow-notify.ts` (its content was always workflow-domain notification production, single production consumer `workflow-events.ts`) — internal move, no public surface change.

## 8.14.7

### Patch Changes

- 43a50ae2e: Test hardening: pin git locale and strip ambient relay env in baseline suites so suite results no longer depend on host locale/relay state.

## 8.14.6

### Patch Changes

- 8285841af: Workflow runs finalize their pending-notification unregister by writing the entry directly instead of relying on the event bus, closing the reload window where the emitted unregister could be lost and the entry never recorded.

## 8.14.5

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 8.14.4

### Patch Changes

- a59739edb: The `/subagents` and `/workflows` noop hints now point to the composer task

  tray instead of the retired sidebar Agents/Flows tabs, and tool guidance now
  explicitly forbids `bash sleep` busy-waiting while a subagent or workflow run
  completes in the background (completion is auto-delivered).
