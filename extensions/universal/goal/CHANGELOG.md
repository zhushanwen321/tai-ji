# @zhushanwen/pi-goal

## 0.14.1

### Patch Changes

- 893b702b6: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.9.0 → @xyz-agent/extension-protocol@0.10.0, @zhushanwen/pi-pending-notifications@0.7.0 → @zhushanwen/pi-pending-notifications@0.7.1)

## 0.14.0

### Minor Changes

- 4955dad6e: Simplify goal internals and normalize extension events to pi SDK types.

  - Event payloads are now typed with pi SDK event types instead of local look-alike interfaces.
  - Write-only persisted goal fields are dropped from the on-disk record; projection and UI ports were slimmed accordingly (`UiPort.theme` declared explicitly, `SessionPort` reduced to actual usage).
  - The internal barrel/shared/budget-dimension helpers were removed; behavior of the goal tools is unchanged.

## 0.13.0

### Minor Changes

- 838806898: Add dual-dimension continuation circuit breaker: a persisted hard total-count cap (never reset by tool activity) combined with no-progress backoff that clears on resume. Defer notifications are now deduplicated by pending-set changes.

## 0.12.2

### Patch Changes

- bbd8e5e8a: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.1 → @xyz-agent/extension-protocol@0.8.2)

## 0.12.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.12.0

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

## 0.11.1

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.11.0

### Minor Changes

- 23d8fe3cc: **goal: successCriteria as a structured list with per-item status**

  - `successCriteria` is now a `string[]` (previously a single free-form string), rendered as a numbered checklist with per-item completion status
  - Legacy single-string goals migrate transparently: criteria are split by lines with defensive normalization, no user action needed
  - Plan-initiated goals display one summary line plus numbered step previews instead of one long concatenated string

  > Erratum (post-release, 2026-08-31): the "numbered checklist with per-item completion status" wording above does not match the shipped rendering. The TUI widget renders criteria as one truncated line joined with `"; "` and the RPC GUI renders them as an unnumbered list-tree with no per-item status; per-item numbered display exists only in `/goal status`.

## 0.10.0

### Minor Changes

- b3a8cf77b: **goal: successCriteria as a structured list with per-item status**

  - `successCriteria` is now a `string[]` (previously a single free-form string), rendered as a numbered checklist with per-item completion status
  - Legacy single-string goals migrate transparently: criteria are split by lines with defensive normalization, no user action needed
  - Plan-initiated goals display one summary line plus numbered step previews instead of one long concatenated string

## 0.9.4

### Patch Changes

- d4f466667: chore: refresh dependency range (triggered by @zhushanwen/pi-pending-notifications@0.3.4 → @zhushanwen/pi-pending-notifications@0.3.5)

## 0.9.3

### Patch Changes

- df69a18fc: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.5.1 → @xyz-agent/extension-protocol@0.6.0)

## 0.9.2

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.9.1

### Patch Changes

- 8e52cb3ba: Align extension behavior with installed pi 0.84.1 semantics (pi-assumption remediation)

  - Tool/command errors are now thrown instead of returned with `isError: true` — pi only honors thrown errors; `isError` in return values is discarded by agent-loop (ask-user, scheduler)
  - ask-user: guard undefined custom-dialog result in json/print mode (noOpUIContext returns undefined); drop ineffective `isError` field from execute result type
  - model-switch: actually switches by calling `ctx.api.setModel` — previous path silently no-op'd; pi clamps unsupported thinking levels silently, effective level returned in reply
  - pending-notifications: correct stale-listener rationale — pi tracks event-bus subscriptions and auto-unsubscribes on invalidate/session replace
  - permission / unified-hooks: correct ctx.ui theme/undefined assumptions per pi 0.84.1 type authority
  - goal: remove stale-context pattern matching no longer reachable under pi 0.84.1 lifecycle

## 0.9.0

### Minor Changes

- 07b5a813d: Move widget rendering from tool-result payloads to widget-panel pushes (`guiSetWidget`)

  The `details.__gui__` field is no longer attached to `todo` / `goal_control` tool results in RPC mode. GUI state is now pushed through the extension-protocol `guiSetWidget` channel (marker-encoded `GuiRenderResult` over the native `setWidget` transport), which hosts decode and render as a dedicated widget panel in the conversation flow. Tool results carry plain text in every mode, so state display no longer duplicates into each tool result.

  Widget payloads were restructured to the v1.1 meta-head architecture (`WidgetMeta`): the host shell renders a single head row (title, status dot, progress count "N/M", mini progress bar) while the body is a numbered list-tree whose item status is expressed solely by a trailing dot — per-row icons and ids burned into labels are gone. Goal widgets map `GoalStatus` onto the same head semantics (active = running, complete = done, blocked/budget_limited/cancelled = failed, paused = idle). The goal `UiPort` interface gains `setGuiWidget` and an `isGui` flag so the projection layer picks the GUI or TUI rendering path.

  Impact for consumers: code reading `details.__gui__` from these tool results must switch to the widget channel; `@xyz-agent/extension-protocol` 0.4.0 keeps `extractGui` as a legacy read path with v1/v1.1 dual-format support during the transition. TUI/CLI behaviour is unchanged — when the host is not GUI-capable, native text widgets and status lines are used exactly as before.

## 0.8.3

### Patch Changes

- 2a724190c: chore: refresh dependency range (triggered by @zhushanwen/pi-pending-notifications@0.3.1 → @zhushanwen/pi-pending-notifications@0.3.2)

## 0.8.2

### Patch Changes

- a0d700161: cw 生态改进：worktree-fork 解耦、cw-tool workspace gate、goal budget 默认策略

  - **pi-cw-tool**: 新增 workspace gate——探测 cw-cli store-normalization 能力，支持时作为纯 wrapper（不传 `--workspace`），不支持时回退 detectRepoWorkspace + `--workspace`。placeholder 版本号（99.0.0）保持当前行为不变，待 coding-workflow S1 落地后激活。同时把 planning-agent / wave-agent / pi-cw skill 的 `fork` 默认值改为 false。
  - **pi-subagent-workflow**: worktree（文件隔离）与 fork（上下文继承）解耦——移除 "worktree 必须配 fork" 的强约束，`worktree:true + fork:false` 现在可用。subagent-tool / types / notifier / bg-notify-render 同步去掉 fork+worktree 耦合描述。
  - **pi-goal**: 强化 budget 默认策略——tokenBudget 参数 description、tool description、promptGuideline 三处一致声明「默认不设预算；仅在用户显式要求或明确同意时才设；切勿自行决定」（timeBudget 已在上游 main 移除，本 PR 适配到 main 的新 schema 结构）。

## 0.8.1

### Patch Changes

- 571277c62: Flatten tool parameters schema to a single top-level Type.Object for OpenAI compatibility.

  `goal_control` and `todo` registered `Type.Union([...])` as `registerTool` parameters,
  which serializes to `{ anyOf: [...] }` with no `type` field. Strict OpenAI-compatible
  gateways reject this with HTTP 400, blocking the whole session from starting.

  Both tools now use a flat `Type.Object` with an action field-level literal union (matching
  scheduler's `ScheduleControlParams` pattern) + `Static<typeof Schema>` derived types +
  runtime handler branch validation. Branch isolation moves from the schema layer to runtime
  handler checks (field-presence guards with actionable error messages).

  No behavior change for well-formed calls. Missing required fields previously rejected at
  the schema layer now throw at runtime with correct-call hints. Dual-form trap detection
  (todo `text`/`texts`, `id`/`ids`) is preserved unchanged.

## 0.8.0

### Minor Changes

- 90fe9401d: # pi-todo + pi-goal 全面优化

  > type 初判 minor（0.x 语义下 breaking 升 minor/major，merge 时人工定最终版本——参见 AGENTS npm 发布 main 线人工版本判定）。两个包均为 breaking。

  ## @zhushanwen/pi-todo（breaking）

  - **状态三态化**：删除 `cancelled` 状态（pending/in_progress/completed 三态）；`migrateTodo` 将历史 `cancelled` 映射为 `completed`（解除 auto-clear/completion steer 死锁）
  - **删除 clear action**：auto-clear 已覆盖「全部完成自动清理」，clear 与 delete 重复
  - **schema discriminated union**：`TodoParams` 改为按 action 区分的 union（list/add/update/delete），各分支 `additionalProperties:false`，缺失必填在 schema 层拒绝
  - **突变结果附带完整列表**：add/update/delete 成功后 content 附带 `formatTodoList` 完整列表（消除突变后失明）
  - **text 校验统一**：单条/批量/add 三处一致 trim + 空串 throw
  - **reminder 单通道合并**：删除 stall/reminder 通道，保留 before_agent_start 每轮 context 注入
  - **description 中文重写** + 删除 Examples/Don't 段
  - **H1 reconstructState GC 修正**：删除无效 splice 段，变纯读

  ## @zhushanwen/pi-goal（breaking）

  - **去时间预算**：删除 `time_limited` 状态 + `timeBudgetMinutes` 参数 + `/goal set --timeout` + 时间预算检查 + 时间进度条；保留 `timeUsedSeconds` 记账显示（对齐 Codex：time 仅记账不设限）
  - **旧数据迁移**：升级时若历史持久化 entry 含已删除的 `time_limited` 状态（npm 0.7.x 时间预算格式），deserialize 自动归一化为 `budget_limited`（预算耗尽终态），避免僵尸 goal 功能死锁（`/goal clear` 抛 invalid transition / `goal_control create` 误报 already active / resume 拒绝）；遗留 `timeWarning70Sent`/`timeWarning90Sent` 字段被忽略。旧 goal-history entry 的 `time_limited` 仅影响历史列表图标展示，不参与状态机
  - **schema discriminated union**：`goal_control` 按 create/complete/report_blocked 分支，各分支 `additionalProperties:false`
  - **prompt 双通道合并**：`contextInjectionPrompt` 精简到 ≤600 chars（每轮锚定），`continuationPrompt` 保留审计细节（续跑详尽），去重收敛
  - **description 中文重写** + §2.5 终态语义（complete 报 token / pause-resume 归用户 / blocked 时间维度 + 不反复报告）
  - **删除 completedTasks 参数**（运行时消费方为 0）
  - **死代码清理**：agent_start 死链路、acquireProcessing、isExternalInit、formatBudget 死函数、BUDGET_RATIO_TIGHT、GoalHistoryData/MessageEndLikeEvent 双份合并、buildPorts 6→1
  - **架构修正**：H2 persist 合并、H3 EventEffect 删除（applyEvent void）、H4 gui 拆层（projection/gui.ts）+ getBudgetSeverity 阈值单源化
  - **描述准确性修正**：A1 reason desc / A4 create 行 / A6 /goal pause / A7 every 小写 / slug 降级真 optional

  ## 测试

  - pi-todo: 108 tests passed
  - pi-goal: 316 tests passed（5 wave 累计，全量绿）
  - tsc + extensions:typecheck/lint 全 clean

## 0.7.1

### Patch Changes

- 246cd5e72: Align the `@xyz-agent/extension-protocol` dependency specifier to `^0.4.0`. The previous `^0.3.1` range does not satisfy the 0.4.0 breaking bump, so consumers installing these packages would fail to resolve protocol 0.4.0 (ERESOLVE).

## 0.7.0

### Minor Changes

- 75205b1e4: Flip `goal_control` create to proactive + add `successCriteria` field.

  ## What's New

  - **create → proactive**: `goal_control` create now proactively starts goals for complex multi-step work (3+ steps, multi-file, needs completion verification), instead of only when the user explicitly asks. The agent restates the real objective (not a literal echo) and defines checkable success criteria. 3-tier proactive signal via description + promptSnippet + promptGuidelines.
  - **`successCriteria` field**: goals now carry verifiable completion criteria alongside the objective, persisted in `GoalRuntimeState` (optional, backward-compatible). Injected into all steering prompts (contextInjection / continuation / budgetLimit) — `complete` evidence must meet every `successCriteria` condition. Surfaced in TUI widget + RPC GUI + `/goal status`.
  - **`/goal update` keeps criteria**: reshape no longer wipes `successCriteria` — pass `--criteria <text>` to replace it, otherwise the previous criteria are kept (with an objectiveUpdated steering note that completion is judged against the new objective). Previously the criteria were silently lost with no way to restore them.
  - **plan → goal bridge**: `__goalInit` calls from the plan extension now pass a `slug` (derived from the plan file stem) and a `successCriteria` (all plan steps executed and verified), so plan-initiated goals carry verification standards instead of none.

  ## Breaking changes

  - `goal_control(action="create")` now **requires** `successCriteria` (handleCreate throws if missing). External `__goalInit` callers keep it optional (programmatic callers).
  - `@zhushanwen/pi-plan` adds `@zhushanwen/pi-goal` as a peerDependency (type-only import of `GoalInitFn` — runtime unaffected when goal is absent).

## 0.6.5

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

## 0.6.4

### Patch Changes

- dc86803: Fix goal continuation loop while background subagents/workflows are running.

  `agent_end` unconditionally queued a `followUp` continuation even when
  background subagents/workflows were still active. The queued message drove
  `_handlePostAgentRun`'s `hasQueuedMessages()` loop, so the main agent spun
  (continuation -> new turn -> agent_end -> continuation) on top of the
  subagent completion notifications.

  Add a pending guard in `handleContinuation`: read the pending
  register/unregister entry diff from session entries (deliberately NOT
  checking `expiresAt` — long-running subagents over the 1h TTL still
  `triggerTurn` on completion, so treating them as inactive would reintroduce
  the loop). When active pending > 0, emit a `goal:log` diagnostic and skip
  the followUp; rely on the subagent/workflow completion
  `sendMessage({triggerTurn:true})` to resume the main agent.

  Also remove the redundant `pendingHint` from `before_agent_start` context
  injection: it was a second, possibly-inconsistent source next to the
  `pending_notifications` tool (mandatory) and the tool-call history. Goal no
  longer summarizes pending state for the LLM.

## 0.6.3

### Patch Changes

- 16f2254: Add `promptGuidelines` to the `goal_control` tool so the agent proactively calls `complete` / `report_blocked`:

  - `complete`: call when the active goal's objective is actually achieved with concrete evidence (finishing all todos incl. verification todos is the usual readiness signal, but the objective being met is the real bar)
  - `report_blocked`: call when genuinely blocked after ≥3 distinct alternative approaches — do not silently stop or leave the goal hanging

  `create` deliberately omitted — its "only when user asks" deterrence is already covered by the tool description and promptSnippet.

## 0.6.2

### Patch Changes

- Updated dependencies [6e2e453]
  - @xyz-agent/extension-protocol@0.3.1

## 0.6.2-dev.0

### Patch Changes

- Updated dependencies [6e2e453]
  - @xyz-agent/extension-protocol@0.3.1-dev.0

## 0.6.1

### Patch Changes

- Updated dependencies [74a0b10]
  - @xyz-agent/extension-protocol@0.3.0

## 0.6.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.5.2

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

## 0.5.1

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

## 0.5.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

## 0.4.1

### Patch Changes

- 2a3fed0: Introduce `pending-notifications` extension and wire workflow/subagent background operations into it.

  - New `pending-notifications` extension tracks active async operations (workflow/subagent) via EventBus + session entries.
  - Workflow `run` / `abort` / terminal error paths emit `pending:register` and `pending:unregister` through a single EventBus port.
  - Subagent background mode now emits the same events via `pi.events.emit`; stale-context errors during subagent child sessions are now tolerated.
  - Goal's `before_agent_start` reads pending entries and injects a waiting hint when async work is active.
  - Added `workflow:log`, `pending:log`, and `goal:log` debug entries for tracing the register/unregister flow.
  - Workflow UI rendering improvements: themed border helpers and fixed overlay ghost rows.

## 0.4.0

### Minor Changes

- b868113: Architecture rewrite + Codex-parity behavior model for `@zhushanwen/pi-goal`.

  **Round 1 — 6-layer ports/adapters architecture:**

  - Layered split: `engine/` (zero Pi deps, pure state machines) → `ports.ts`
    (machine-checkable boundary) → `service.ts` (dual entry) → `adapters/` →
    `projection/` → `index.ts` (thin factory)
  - Deleted 9 legacy god-files (state/budget/widget/templates/tool-handler/
    action-handlers/command-handler/agent-end-handler/before-agent-start-handler)
  - Engine never imports `@mariozechner/*`; budget decisions and persistence are
    pure and independently tested
  - FR-5: strict serialize/deserialize (no legacy format compat — clean break)
  - FR-6.2: token/time budget warning flags are independent (4 flags)
  - FR-6.5: time accumulation extracted to a pure `tick()` (no double-write)
  - FR-6.7: ESC is a pure interrupt via `ctx.signal.aborted`; removed
    `pendingPause` field and module-level `lastCtx`

  **Round 2 — Codex-parity behavior model (FR-1…FR-7):**

  - FR-1: goal reuses `pi-todo` as its task model. `pi-todo` upgraded to a
    four-state model (`pending`/`in_progress`/`completed`/`cancelled`) with an
    optional `isVerification` flag and legacy migration
  - FR-2: new lightweight `goal_control` tool (`create`/`complete`/
    `report_blocked`); `goal_manager` task CRUD retired
  - FR-3: **7-state goal machine** per ADR-002
    (`active | paused | blocked | complete | budget_limited | time_limited |
cancelled`). Pi adds `time_limited` + `cancelled` vs Codex and deliberately
    omits `usage_limited` (Extension model doesn't own session-level quotas).
    `paused` is retained — `/goal pause` + `/goal resume` (recovers
    `paused|blocked → active`) work as before
  - FR-4: staleness reminder via `lastUpdatedTurn`; `agent_end` is warning-only
    with a single budget checkpoint
  - FR-5: budget auto-trigger on the event path (`persistAndUpdate` fallback,
    fires only for `active`)
  - FR-6: prompt-driven completion audit — `complete` is a soft suggestion, not
    a hard tool action; prerequisites enforced
  - FR-7: plan↔goal automatic linkage; goal↔todo dependency is `optional`
    (degrades gracefully when todo is missing)

  `pi-coding-workflow` / `pi-plan` receive a patch: their inline `GoalInitFn`
  type alias is updated to mirror goal's new required-`ctx` signature (no runtime
  change; callers already pass `ctx`).

  See `docs/extensions/adr/pi-ext-002-goal-7-state-machine.md` for the 7-state rationale.

## 0.3.0

### Minor Changes

- Goal abort command, task verification lifecycle, ESC pause, subtask support, enriched steering prompts, and unit tests

## 0.2.0

### Minor Changes

- Add Review-Gate auto-loop, Test-Fix Loop, and cross-extension Goal integration

  - goal: expose `initializeGoalFromExternal()` via `pi.__goalInit` for cross-extension access
  - coding-workflow: Review-Gate standard loop (Phase 1/2), Phase 3 three-stage review, Phase 4 Test-Fix Loop, Goal auto-init, Phase-Gate bug fixes
  - workflow: agent file discovery (project/user/npm/local), `resolveAgentOpts()` extraction, structured output failure handling

## 0.1.6

### Patch Changes

- 15b68f6: Fix evolve analyzer to find session files in project subdirectories, unify pi.extensions to ./index.ts

## 0.1.5

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.1.4

### Patch Changes

- ffd4c59: fix: remove hasPendingInjection blocking agent_end continuation; align maxTurns with currentTurnIndex

## 0.1.3

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.1.2

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
