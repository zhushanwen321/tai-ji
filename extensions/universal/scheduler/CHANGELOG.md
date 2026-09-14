# @zhushanwen/pi-scheduler

## 0.6.0

### Minor Changes

- ext-simplify-08: croner moved from optional peer to dependencies with static
  import — cron scheduling now works in standalone npm installs and the
  invalid-expression error is no longer masked by a missing parser; low-group
  cleanup (error-code channel, delivery-handle indirection, ctx narrowing,
  HISTORY_LIMIT single source, pass-through handler removal)
- Requires @xyz-agent/session-delivery >= 0.4.0 (per-message onSettled kernel).

## 0.5.2

### Patch Changes

- 4955dad6e: Crash-resilience guard against stale-context async callbacks.

  - **pi-ext-guards**: exports the new `guardStaleCtx` helper. It wraps session-scoped async callbacks so that, once the hosting session is no longer active, late resolves are dropped instead of writing into a dead or recycled context.
  - **pi-plan / pi-scheduler / pi-structured-output**: adopt `guardStaleCtx` around their session-lifetime async flows (plan compaction, scheduler tick handlers, structured-output loop gating), preventing late callbacks from landing in a session that has already ended.

## 0.5.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.5.0

### Minor Changes

- 7b33e6f00: **Drift cleanup across extension packages: agent-facing text synced with actual behavior, dead surface removed**

  > Scope note: accumulated post-convergence cleanup across several development sessions. Every removal below was verified to have zero non-test consumers; runtime behavior is unchanged unless a bullet says otherwise. `src/` ships in these npm packages, hence minor where exported surface shrank.

  **ask-user: drop the dead `ErrorDetails` surface; docs aligned with the throw-based error contract**

  - The exported `ErrorDetails` interface is removed and `AskUserDetails` narrows to plain `Result`: since the W4 fix every error path in `execute` throws (pi marks the tool result `isError` with empty details), so the `{error}` details shape — and the `renderResult` branch rendering `✗ <error>` — was unreachable. Runtime output is unchanged; the removal only affects deep imports of `src/types.ts` (the package entry keeps exporting only the extension factory).
  - README/ARCHITECTURE synced to the shipped behavior: validation failures and headless tool removal documented as throws, `←/→` (not Tab) documented as the question-tab navigation keys, and the `allowComment` parameter dropped from the docs — it does not exist in the code.

  **cw-tool: `cw_query` tool description corrected on `details.data`**

  - The tool description now says `details.data` holds the parsed result whenever the command's stdout is parseable as JSON, instead of implying it appears only with `--json` — matching what the runner already does. README/SKILL drop stale cross-repo doc references.

  **goal: dead exports removed, never-consumed prompt parameters dropped, criteria validation deduplicated**

  - Dead exports removed: `BUDGET_PERCENT_HIGH` / `BUDGET_PERCENT_LOW` (constants) and `checkResumeBudget` (service); `goalStatusSeverity` and `getTitle` become module-private. The exported prompt builders `formatBudget` / `continuationPrompt` / `contextInjectionPrompt` drop the `timeUsedSeconds` placeholder argument that was explicitly `void`-ed — output text is byte-identical, but deep-import call sites should drop the argument.
  - successCriteria per-item validation (string / non-empty / single-line) is extracted into `adapters/success-criteria.ts` shared by the `goal_control create` tool path and `/goal update`; validation order and message wording are unchanged, only the `Correct:` recovery example is parameterized per channel.
  - README / CHANGELOG erratum / package description synced with shipped behavior: token-only budget (time budget removed), agent-reported blocking, append-only persistence with no entry GC.

  **scheduler: skip-reason wording and tool text synced with the delivery-kernel behavior; dead surface dropped**

  - `schedule_control run`'s `DISPATCH_SKIPPED` message no longer lists "busy" as a skip reason (`disabled, rate-limited, or already queued for delivery`) — non-force tasks are already enqueued in the session delivery kernel when the agent is busy and delivered once idle, and the message now says so. The `expires` parameter description notes it only applies to recurring tasks, the `run` guideline describes enqueue-then-deliver semantics, and the `/schedule` command description no longer promises a no-args TUI (bare `/schedule` returns a not-implemented notice pointing at `/schedule list`).
  - Dead surface removed: `ExecutionRecord.snippet` (declared, never populated), `SchedulerRuntime.getTaskCount()`, and the `note` field of `normalizeCronExpression`'s return type (now a plain string).

  **session-manager: tool descriptions aligned with actual runtime statuses**

  - `get_session_status` now documents status values as `active / idle / error` (not `running`), and `abort_session` says the final status will be `stopped` instead of an "aborted state" — matching what the xyz-agent runtime handler actually reports. README syncs the select-timeout tiers (create/history 60s, others 30s) and notes `list_my_sessions` takes no filter parameters.

  **session-reader: LLM-facing wording corrected across the tool surface; dead fields dropped**

  - Tool description and parameter descriptions now match the implementation: outline is a ~1500-token overview (render budget hard-coded at 2000), `turns` applies to detail and extract, `allBranches` applies to outline/export but not family, `source` filters find and session-resolving actions, TUI `#` references insert full uuids, and the current-session advice no longer names a nonexistent `get_messages` tool. Error and hint texts reworded for accuracy: an unmatched `sa-` id now says the record may not be flushed yet, and the truncated-outline hint points at `detail`'s `turns` range instead of a budget knob.
  - Dead optional fields removed from shipped types (`SessionRef.name`, `AutocompleteCandidate.description` — never populated), and the duplicated `formatOmitted` helper now reuses the exported `formatBytesMarker`.

  **structured-output: correction hints now spell the real tool name**

  - `CORRECT_USAGE_HINT` and the tool description's usage examples now write `structured-output(...)` — the registered `TOOL_NAME`, hyphenated — instead of `structured_output(...)`: an LLM following the old underscore spelling would call a tool name that does not exist. Comments re-anchor the cross-package schema-env contract to `packages/subagent-core`, and the npm description now covers both the workflow mode and the interactive Ajv-validated mode.

## 0.4.3

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.4.2

### Patch Changes

- 23d8fe3cc: chore: refresh dependency range (triggered by @xyz-agent/session-delivery@0.2.0 → @xyz-agent/session-delivery@0.3.0)

## 0.4.1

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.4.0

### Minor Changes

- df69a18fc: Migrate scheduler dispatch to the unified session delivery kernel: park mode + after-run intent replace the ad-hoc dispatch path, with behavior parity verified against frozen golden snapshots.

## 0.3.4

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.3.3

### Patch Changes

- 8e52cb3ba: Align extension behavior with installed pi 0.84.1 semantics (pi-assumption remediation)

  - Tool/command errors are now thrown instead of returned with `isError: true` — pi only honors thrown errors; `isError` in return values is discarded by agent-loop (ask-user, scheduler)
  - ask-user: guard undefined custom-dialog result in json/print mode (noOpUIContext returns undefined); drop ineffective `isError` field from execute result type
  - model-switch: actually switches by calling `ctx.api.setModel` — previous path silently no-op'd; pi clamps unsupported thinking levels silently, effective level returned in reply
  - pending-notifications: correct stale-listener rationale — pi tracks event-bus subscriptions and auto-unsubscribes on invalidate/session replace
  - permission / unified-hooks: correct ctx.ui theme/undefined assumptions per pi 0.84.1 type authority
  - goal: remove stale-context pattern matching no longer reachable under pi 0.84.1 lifecycle

## 0.3.2

### Patch Changes

- 87ee3e571: Fix stale tools/ path reference in sdk-contract test comment

  The comment in `sdk-contract.test.ts` still pointed to `tools/verify-scheduler-e2e.cjs` after the script was migrated to `scripts/`. Comment-only change, no runtime behavior affected.

- a55773e67: Use a single now basis for relative-time labels in create/list messages

  `formatRelativeTime` previously read `Date.now()` independently from the injected `backend.now()`, so task summaries could drift at unit boundaries (`in 1h` → `in 59m`). create/list now capture one `now` and pass it to all relative-time formatting, eliminating the flake.

## 0.3.1

### Patch Changes

- a769aea2f: Fix a pi-process crash caused by a leaked tick timer after session replacement:

  - **Root cause**: when a scheduled task dispatch was inside its `await sendMessage` window and the session got replaced (`new_session` / `switch_session`), the old 30s tick timer could survive. Its next tick called `refreshWidget` on the captured stale ctx whose `ui` getter throws, and the fire-and-forget `void tickScheduler()` turned that rejection into an `unhandledRejection` that killed the pi process (exit 1).
  - **Source fix**: the `session_start` handler now stops the prior runtime's timer first (`service?.runtime.stopScheduler()`) — an idempotent guard against multi-fired/re-entered `session_start` leaking the previous interval. On the production factory-rerun topology (`newSession`/`fork`/`switchSession`), pi re-runs the extension factory and the new closure's `service` is still null at `session_start`, so this stopScheduler call is a no-op there — the real stop point for those replacement paths is the `session_shutdown` teardown that pi awaits (fires) before creating the replacement runtime.
  - **Defense in depth**: the tick interval callback now catches tick rejections, and stale-ctx triage runs in two layers. Primary: a module-level session generation counter — every `session_start` increments it, each runtime captures its generation at construction, and ticks bail out early (or self-retire on in-flight errors) once the generation flips. This covers the session replacement paths (`newSession`/`fork`/`switchSession`), where pi re-runs the extension factory but the cached factory shares one module environment, so the counter survives across factory re-runs. Fallback: stale-ctx error text matching ("stale after session replacement") covers the residual blind spot — an explicit reload (or cwd change) clears pi's extension cache and re-imports the module into a fresh environment, freezing the old closures' generation reference; there, only the error text can still identify a stale ctx. Other errors warn and keep scheduling. The timer is deliberately not `unref`-ed — in rpc/daemon mode that would let the process exit early and kill scheduled tasks.
  - **Companion hardening (not part of the crash fix itself)**: `dispatchTask` now keeps a per-task in-flight guard. A tick is fire-and-forget, so if a dispatch's `await sendMessage` hangs longer than the 30s tick interval (e.g. pi unresponsive), the next tick could start a second dispatch of the same task and double-inject the prompt (force tasks bypass the idle gate). The guard skips the task for that tick with a warning and clears on settle; other tasks are unaffected. Included here because it hardens the same dispatch path the crash fix touched, but it prevents duplicate task execution rather than the crash.

## 0.3.0

### Minor Changes

- 1565e57fa: **Shared LLM/config library + config path consolidation (first release of `@zhushanwen/pi-llm-shared`)**

  - **pi-llm-shared (new)**: shared library for extensions — generic config IO (`<agentDir>/config/<pkg>-ext-config.json`, mtime+size read-through cache, atomic write), unified LLM call helper (`callLLM`), `ModelSelector` resolution (ref/fallback/available/scoped), and `migrateLegacyConfig` (idempotent best-effort rename used by session_start migration hooks). Note: must publish together with (or before) its consumers below; the packages resolve it via `workspace:*`.

  - **pi-permission**: config file moved from `<agentDir>/permission-config.json` to `<agentDir>/config/permission-ext-config.json` (one-shot idempotent migration on session_start, old file removed after move); LLM classifier plumbing now goes through pi-llm-shared (`callLLM` + `ModelSelector`); classifier model `auto` semantics now pick the first available scoped model instead of the globally cheapest.

  - **pi-rename-session**: switch and settings now live in `<agentDir>/config/rename-session-ext-config.json` (`enabled` / `model` / `maxTitleLength`); title generation uses an independent slim system prompt with explicit `tools: []` and its own model selector (default `scoped`) instead of piggybacking the main session model. The legacy `<agentDir>/auto-rename-enabled` flag file is kept as a live override (checked every turn) so the released xyz-agent runtime toggle keeps working — `/auto-rename on|off` syncs both mechanisms.

  - **pi-model-switch**: config file moved from `<agentDir>/model-policy.json` to `<agentDir>/config/model-switch-ext-config.json` (session_start migration); new `model-switch-ext-config` skill documenting schema and defaults.

  - **pi-scheduler**: new `scheduler-ext-config` skill (cron/interval formats, JSONL event-sourcing storage); legacy store import now resolves candidate dirs via `getAgentDir()` so isolated agent dirs (`PI_CODING_AGENT_DIR`) work.

  - **pi-quota-providers**: quota cache moved from `<agentDir>/statusline_cache.json` to `<agentDir>/config/quota-cache.json` (first-load migration, old cache ignored → cold refetch); all paths derive from `getAgentDir()` for instance isolation.

  - **pi-subagent-workflow**: fix worktree registry pid staying 0 in RPC mode (reaper could reap live worktrees after grace timeout — pid is now registered right after spawn); skill/session-dir resolution derives from `getAgentDir()` instead of hard-coded `~/.pi/agent`.

  - **pi-plan**: global plan-template directory derives from `getAgentDir()` so isolated agent dirs (`PI_CODING_AGENT_DIR`) are respected.

## 0.2.0

### Minor Changes

- 54895962b: Migrate task store to session-scoped append-only CustomEntry storage

  - Replace file-based task store with append-only CustomEntry records written to the session JSONL, so scheduled tasks survive session resumption and are scoped per session
  - Add legacy store importer that migrates existing `tasks.json` data on first run
  - Fix toggle-enable not persisting recalculated `nextRunAt` (tasks lost scheduling after resume)
  - Fix residual pending tasks when toggle-enable recalculates `nextRunAt` to the future
  - Trim once-task echo to a single run and inject the `now` source for consistent scheduling

## 0.1.1

### Patch Changes

- 246cd5e72: Extract `SchedulerBackend` and unify tool/command dispatch through `SchedulerService`. Fix the cron fallback loop and correct the misleading "every X" display for once tasks (now shown as "once in X").

## 0.1.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.0.5

### Patch Changes

- Publish as public package via .npmrc access=public.

## 0.0.4

### Patch Changes

- Publish with --access public for first-time scoped package.

## 0.0.2

### Patch Changes

- b4b9fa5: Fix cron expression parsing in /schedule command: add quote-aware tokenizer so quoted cron expressions (e.g. `cron '*/10 * * * *' prompt`) are correctly handled.
