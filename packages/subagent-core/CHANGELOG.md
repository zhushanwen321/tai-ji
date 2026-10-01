# @zhushanwen/subagent-core

## 1.0.0

### Major Changes

- 0d36077d4: Breaking: the notify delivery contract in `core/notify-ports.ts` drops two members — `DeliveryPort.hasPendingMessages()` and `DeliveryConfig.busyPolicy` (`'retry-force' | 'park'`). Busy gating is no longer a port capability or a caller policy: delivery progress is driven by the send settle contract (a returned promise must settle; timeouts close as send failures) plus the settled-edge flush, so callers no longer poll pending counts and `retry-force` is the built-in behavior of the backoff chain. `DeliveryHandle.send` options are now the newly exported `DeliverySubmitOptions` — a structural superset of the previous `{ merge?: boolean }` that adds the optional `receiptAnchor` declaration (`'marker'` default | `'acceptance'`: acceptance-without-receipt-anchor submits settle as delivered on acceptance). Host adapters that implemented `hasPendingMessages` or passed `busyPolicy` must remove those members; the built-in notifier's own stub (`hasPendingMessages: () => false`) and config entry (`busyPolicy: 'retry-force'`) were removed with the same change. This mirrors the upstream `@zhushanwen/session-delivery` contract (hand-transcribed types; drift is guarded by the notifier-receipt-anchor behavior-lock test).

## 0.13.0

### Minor Changes

- 8aa4b40e8: Managed-session completion notifications now fire exactly once (notify-once claim ledger):

  - `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
  - `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
  - `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
  - `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
  - `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

- 8aa4b40e8: Internalized retention helpers: `DEFAULT_STATE_TTL_MS`, `resolveStateTtlMs`, `DEFAULT_ORPHAN_RUN_GRACE_WINDOW_MS` and `resolveOrphanRunGraceWindowMs` are no longer exported from run-state-evidence — they are module-private implementation details with no external consumers. The `TAIJI_SUBAGENT_STATE_TTL_MS` / `TAIJI_WORKFLOW_ORPHAN_RUN_GRACE_WINDOW_MS` env override channels and all retention entry points (`pruneTerminalRunFiles`, `runRetentionMaintenanceRound`, `reapOrphanRuns`) are unchanged.

## 0.12.0

### Minor Changes

- 50f31a73c: Make the available-workflow list item template single-sourced: core's formatAvailableWorkflowRefs gains two boolean options (includeLocation, includeSource — defaults keep the run-rejection format byte-identical) and the two hand-rolled forks in the workflow-script tool now consume it. Deliberate LLM-visible changes: the lint not-found suggestions list now includes the location line (aligned with the run-rejection self-recovery guidance), and the actionList items switch from "[source] name — desc" to "- [source] name: desc" (separator unified to ":"). actionList's LLM-visible output goes from zero coverage to black-box tested (full text, empty state, details/GUI projection), and the formatter itself gains table-driven direct tests over both option axes plus the available filter.

- 50f31a73c: Converge the pi-host sessionDir layout (cwd slug + existsSync probe) into a single source of truth: `resolvePiSessionScopedDir` is now exported from the subagent-core barrel, and the shell extension's `resolveSessionDir` became a thin consumer that injects the live pi SDK `getAgentDir()` via `opts.agentDir`. The previously duplicated slug rule (shell + core copies cross-referenced only by comments, with drift surfacing as runtime failures such as the reconcile sweep wrongly unregistering active runs) is gone; `resolvePiWorkflowStateDir` is now a pure workflow-state suffix derivation over the shared resolver with byte-identical behavior.

- 50f31a73c: Single-source the notify-channel custom_message customType vocabulary in the protocol package (new exports: WORKFLOW_RESULT_CUSTOM_TYPE, SUBAGENT_BG_NOTIFY_CUSTOM_TYPE, SUBAGENT_DIRECTIVE_CUSTOM_TYPE — values unchanged, byte-identical). Producers and consumers now import the same constants instead of mirrored string literals that had zero cross-side anchoring: the shell's completion-notify sender, messageRenderer registration, and directive-entry writer; subagent-core's NOTIFY_CUSTOM_TYPE (compat alias) and the abandoned-notification recovery-hint channel check; the shared COMPLETE_NOTIFY_CUSTOM_TYPES set is now assembled from the constants (with SUBAGENT_DIRECTIVE_CUSTOM_TYPE re-exported), and runtime's event-interpreter / subagent-extractor plus core's notify-summary compare against them. A conformance test in the shell locks the three values and forbids local re-definitions at the producer sites. Also folded into the shell: the fourth GUI attach point now goes through the shared withGuiAttach helper (returns a new object instead of in-place mutation, byte-equivalent payloads), and the in-flight reporter creation plus setInFlightListener wiring moved from the factory root into setupWorkflowDomain (index.ts passes no wiring; behavior unchanged).

- 50f31a73c: **@zhushanwen/subagent-core**: exports `conventionRootDirs` — the ordered convention-root path set (`~/.agents/<kind>`, `<workspaceRoot>/.pi/<kind>`, `<workspaceRoot>/.pi/<kind>/.tmp` when `includeTmp`, `<workspaceRoot>/.agents/<kind>`) derived from the same single-source helpers that `buildScanTargets` consumes for its hardcoded slots.

  **@zhushanwen/pi-subagent-workflow**: the empty-state discovery-roots hint (`(none discovered; roots: ...)`) now projects the core `conventionRootDirs` derivation instead of duplicating the four convention-root joins — convention-root changes land in core only. Injector tests also hardcode the LIST_GUIDE texts as expectations, so guide copy rewrites now fail tests instead of passing silently.

- 50f31a73c: Subagent crash kill-chain hardening (from the 2026-09-24 kill-chain forensics: every "crash" that day was a host-side SIGTERM, and 41 of 64 kill-on-disconnect log lines were normal post-settled reaping). Exit-code folding for signal-killed children is now POSIX 128+signo (SIGTERM reads 143, matching the runtime-side view; bare 128 misled triage). The relay proxy sends a goodbye frame before exiting on host SIGTERM, so runtime logs distinguish normal teardown (info) from abnormal disconnects (warn + kill decision) — kill behavior is unchanged. The orphan sweep tiers disposal by activity: idle orphans are reaped immediately, still-productive ones are marked pending (persisted in the pid file), deferred with a 30-minute hard cap and a recheck timer, ending the restart-storm oscillation where a just-recovered subagent was reaped by the next runtime generation; re-registering a recordId also reaps the superseded live pid instead of orphaning its ledger entry. Shutdown now waits for in-flight kill chains before the runtime exits (unref timers previously died with the process, leaving SIGTERMed-but-alive children). Failure notices to the main agent carry a recovery tail that warns to check action:'list' before manually taking over (parallel recovery rounds duplicated work in the incident), and dispose-time killAll logs which still-active children it is about to kill — the previously missing first-scene evidence for host-side disconnects.

- 50f31a73c: Converge the subagent-record entry vocabulary on subagent-core as the single source: the record store's four appendEntry write sites now use the SUBAGENT_RECORD_CUSTOM_TYPE constant instead of bare literals (the constant is already exported via the core barrel), and the runtime consumers (event-adapter, session-records, subagent-extractor) import it from the core barrel instead of @taiji/shared. The @taiji/shared copy remains as a renderer-only mirror (the renderer bundle does not depend on the Node-side core package) with its stale header comment rewritten to name the real source, and its value is now pinned by literal locks on both sides (shared constants.test.ts and core record-entry-collect.test.ts) so any drift turns red at the offending package.

- 50f31a73c: Move the state-retention cap env parsing into subagent-core: resolveStateMaxRuns and STATE_MAX_RUNS_ENV are now exported from the core barrel, replacing the shell's identical local implementation. The shell's JsonlRunStore also declares `implements RunStore` against the core port type (signature drift is now caught at compile time) and its class doc gains an index of its five interface facets.

- 50f31a73c: Consolidate the workflow-record entry vocabulary and v1 guard into subagent-core as the single source: new exports WORKFLOW_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_ENTRY_VERSION, and classifyWorkflowRecordEntryData (pure classification, logging policy stays with callers). The pi shell store and the runtime extractors now consume the core barrel instead of holding their own copies, and the duplicated constant in @taiji/shared is removed.

- 50f31a73c: BREAKING CHANGE: the nested `workflow()` orchestration API family is removed (workflow capability audit verdicts C-1/C-2 + A-1, commit 6960477cf).

  - Worker-script `workflow(name, args)` global no longer exists. Scripts saved in `.pi/workflows/` / `~/.pi/agent/workflows/` that call `workflow()` now fail at run start with a ReferenceError — this is not caught by script lint, so existing scripts only break when run. Migration: inline the sub-workflow's steps as direct `agent()` calls, or split the composition into separate `workflow run` invocations. The built-in orchestration workflows (chain / parallel / fan-out / scatter-gather / map-reduce / review-fix-loop in the `workflows/` directory of `@zhushanwen/subagent-core`) remain available; they compose via `agent()` directly.
  - `pipeline()` only accepts the single-array form `pipeline([stage1, stage2, ...])`; the multi-argument Cartesian form `pipeline([items], stage1, stage2, ...)` is removed. Migration: map items through the stages manually, e.g. `await parallel(items.map((item) => stage1(item).then(stage2)))` or an explicit for-loop.
  - `pi.__workflowRun` cross-extension programming API is removed from the extension registration surface. No migration needed: the channel was already unreachable at runtime under pi 0.84.4 per-extension API isolation and had zero consumers.

- 50f31a73c: New `isTerminalDoneReason(reason)` predicate exports the DoneReason terminality verdict (exhaustive switch, no default — adding a DoneReason member forces an explicit classification here at compile time). The shell's anti-laziness wrap-up directive in run-completion notifications now consumes this core predicate instead of a local `TERMINAL_REASONS` string-set mirror, which had already drifted: it contained a ghost member `circular` that core's vocabulary never produces. The shell module is also renamed from `interface/helpers.ts` to `src/workflow-notify.ts` (its content was always workflow-domain notification production, single production consumer `workflow-events.ts`) — internal move, no public surface change.

## 0.11.1

### Patch Changes

- 43a50ae2e: listModels now maps a dynamic empty catalog to null instead of surfacing an error (B1), and round-idle bookkeeping writes the derived manifest projection so reloaded runs observe the manifest without waiting for the next full rebuild (B2). Also recalibrates the D2 latency threshold for instrumented-load runs.

## 0.11.0

### Minor Changes

- 8285841af: Review-fix-loop workflow rework: reviews run in parallel and fixes are dispatched as aggregate-driven groups over a disjoint file bus, reviewer batching is rank-driven (fixed 3 + dynamic 1 per batch), and aggregator issue ids stay continuous across rounds. A disputed lane replaces the old fixer-abort-on-false-positive: a fixer that verifies a finding to be a false positive appeals it with counter-evidence instead of silently skipping or aborting; a human adjudicates after the run. Also ships: run finalize now unregisters pending notifications durably via a direct appendEntry write (closing the reload/factory-ordering window where an emitted unregister could be lost), reconcile sweeps map unregister reasons to statuses instead of hard-coding one, and pi worktree cwd conduction broken by engine protocolization is restored.

## 0.10.5

### Patch Changes

- a59739edb: feat(subagent-core): packageVersion in engine stable identity (D2b version face)
