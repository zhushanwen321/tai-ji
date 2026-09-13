# @zhushanwen/pi-session-reader

## 0.6.0

### Minor Changes

- **session-reader: thin wrapper exports removed; `family` subagents lines now carry status / agent / task summary**

  **Breaking changes (npm deep imports):**

  - `listMainSessions` and `listSubagentSessions` are removed from `src/discovery/roots.ts`. Both were one-line wrappers over `resolveSessionRoots` + filter with no remaining consumers in the package (the last one, `subagents.ts`, calls `resolveSessionRoots` directly). Migration: call `resolveSessionRoots({ agentDir })` yourself and either take `roots.filter((r) => r.source === 'main' && r.dedupedInto === undefined).flatMap((r) => r.files)` (former `listMainSessions`) or `roots.find((r) => r.kind === 'subagent')?.files ?? []` (former `listSubagentSessions`). The package entry surface is unchanged.

  **Behavior changes (LLM-facing output, intentional):**

  - `session_read {action:"family"}` subagents lines now render the manifest/identity rich fields that were already assembled but never shown: a terminal status tag (`[completed]` / `[failed]` / `[running]`), the agent name, and a single-line task summary truncated at 60 characters (whitespace flattened so a multi-line task cannot break the line structure). Cleaned-up orphans still render `[已清理]` and do not expand the summary (the session file is gone, so there is no deep-read entry to advertise).
  - The internal `enrichRefs` backfill is deleted: on the `family` path, `root`/`parents`/`forks`/`subagents` refs keep the empty-string placeholders for `fileName` and `cwd` (the backfilled values had zero readers; the text output never showed them). `details` consumers wanting the subagent file path should read `subagents[].sessionFile`, which stays populated from the manifest / alive file scan.

## 0.5.0

### Minor Changes

- ab07bdb4a: session_read resolves its session roots explicitly and gains cross-session search plus a one-shot diagnostics action.

  - **Explicit root discovery**: session roots are now resolved from labeled candidate roots (pi default layout, legacy layout, explicit environment override) and the matched label is reported, instead of assuming a single fixed layout. `resolveSessionRoots` replaces the previous single-path derivation.
  - **Environment detection**: the extension now tells a hosted run (spawned by the xyz-agent runtime) apart from a standalone pi run by a conjunction of signals, and carries the resulting mode through the tool handler so every action reports the roots it actually used.
  - **New `doctor` action**: probes the resolved roots for residual or orphaned session entries, and caches the resolved root for the turn so repeated calls do not re-walk the filesystem.
  - **Cross-session content search**: matching now covers message content across every session file under the resolved roots, in addition to the existing metadata matches.
  - **Title search**: titles are matched through `SessionManager.listAll`, so a session whose title exists only in the manager index is still found.
  - **Grouped `find` output**: results are grouped by session and print full session ids, so a returned id can be pasted straight into a follow-up call without an extra lookup step.
  - **UUID normalization**: session ids supplied in any of the accepted forms are normalized to the canonical id before lookup, and lookups self-check the id they report.

## 0.4.0

### Minor Changes

- bbd8e5e8a: session_read gains a result action to retrieve collected subagent results directly from a session.

## 0.3.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.3.0

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

## 0.2.4

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.2.3

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.2.2

### Patch Changes

- 8e52cb3ba: Cross-process write governance and cache correctness (integrity hardening)

  - file-lock: shared cross-process lock module (withFileLockSync) used by runtime and extensions; field-scope merge on concurrent config writes
  - llm-shared: config saves under file lock; unique tmp file names (pid + random suffix) eliminate concurrent same-name tmp collisions between processes
  - quota-providers: disk cache prunes removed/disabled provider entries on providers.json mtime change instead of waiting for TTL expiry; value domains aligned to pi 0.84.1 via SSOT derivation
  - session-reader: main session file resolved by sessionId (not getSessionFile), passed by value into initSession; entry-only orphan recovery after spawn-window deaths

## 0.2.1

### Patch Changes

- a769aea2f: Accept `wf-run-v2` workflow snapshots written by `@zhushanwen/pi-subagent-workflow` 8.x (one-shot lifecycle):

  - **Workflow discovery and overview now read v2 runs.** The sibling extension bumped its run snapshot format from `wf-run-v1` to `wf-run-v2`; until this patch, session-reader's version guards only accepted v1, so `family`/`workflows` discovery silently returned an empty `calls` list for every v2 run (all agent call session file references lost) and the `workflow` overview action returned no result for them. The v2 reading surface is shape-compatible with v1 — `state.calls[].sessionFile` / `result.sessionFile` are unchanged — so only the version literals were widened (`extractCallSessionFiles` NEW branch and `parseRunSnapshot` NEW branch), and `WorkflowOverview.version` now reports `'wf-run-v2'` for v2 snapshots. Legacy no-`v` (`callCache`) snapshots keep the existing best-effort parsing; future formats (e.g. a hypothetical `wf-run-v3`) still parse as null until explicitly evaluated.

## 0.2.0

### Minor Changes

- 4f6e24f45: Add nested execution tree reading and workflow/session record discovery

  - `session-reader`: resolveSessionId now supports three forms (sessionId, taskId/runId, subagent slug), builds nested execution trees via parentRecordId (family mode), discovers workflow runs, enriches SubagentRef records with agent name and manifest/parent fallbacks, and adds find-by-task/slug/agentName matching with source filtering.
  - `subagent-workflow`: persist parentRecordId in the subagent manifest so session-reader can reconstruct the nested execution tree.

## 0.1.0

### Minor Changes

- bc336c3b5: 首次发布：pi session 读取能力扩展包

  - **M1 core**: parser/turns/tree/render/family 纯逻辑核（turns 渲染、family 索引跨代 subagent 关联），零 pi 依赖
  - **M2 discovery**: roots + find（agentDir 注入、first-line scan）+ subagents 子进程会话发现
  - **M3 tool-adapter**: 注册 `session_read` tool（tool-handler 支持 outline/expand/detail/search/extract/export/family 八种读取模式）
  - **M4 TUI**: `#` autocomplete provider（hash 前缀唯一化）+ `/session-pick` 命令（当前 cwd 范围弹窗）
  - **M5 验收记录**: V1-V6 状态记录于 design.md §4.1
  - **v2 优化**: O1 outline assistantBrief/toolSummary、O2 typed toolResult summary、O3 detail 默认 summary、O4 extract action（user-messages/commands/files/commits/tool-results）、O5 hash 冲突唯一前缀（全局 session id set）

## 0.1.0 (unreleased)

- M1: core 纯逻辑核（parser/turns/tree/render/family），零 pi 依赖。
