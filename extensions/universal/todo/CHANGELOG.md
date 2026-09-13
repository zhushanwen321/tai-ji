# @zhushanwen/pi-todo

## 0.9.1

### Patch Changes

- 893b702b6: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.9.0 → @xyz-agent/extension-protocol@0.10.0)

## 0.9.0

### Minor Changes

- 14d1d4567: todo add learns stale-list auto-GC and list-scale guidance.

  - **add-time auto-GC**: when every existing todo is `completed`, `add` now clears the stale list before appending the new items and resets `nextId` to 1 — starting a new task no longer leaves the finished backlog attached to it (previously the stale items lingered until the delayed 2-round auto-clear). The tool result reports the cleared count. `handleAdd` also resets `completionSteered` / `allCompletedAtCount` so a new task cycle gets its own completion quality-check steer.
  - **Soft scale cap**: the recommended maximum is now 10 todos per session (`RECOMMENDED_MAX_TODOS`). When `add` pushes the total above 10, the tool result appends a reminder to consolidate fine-grained steps or delete items no longer needed. Advisory only — the call is never rejected.
  - **Tool description / promptGuidelines** document both behaviors (keep the list under ~10 items; finished lists are cleared automatically on the next `add`).

## 0.8.10

### Patch Changes

- 4955dad6e: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.2 → @xyz-agent/extension-protocol@0.9.0, @zhushanwen/pi-extension-logger@0.5.0 → @zhushanwen/pi-extension-logger@0.6.0)

## 0.8.9

### Patch Changes

- bbd8e5e8a: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.1 → @xyz-agent/extension-protocol@0.8.2)

## 0.8.8

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.8.7

### Patch Changes

- 7b33e6f00: **todo / pending-notifications: dead-surface and type cleanup from the drift-cleanup sweep**

  - `pi-todo`: the dead `getDisplayStatus` export is removed (`model.ts`) — it was an internal-equivalent wrapper over `migrateTodo(t).status` whose only in-repo caller inlined it directly, and the `todo_list` tool description now says "View all todos for the current session" (matches actual per-session behavior, not per-branch). Tool-detector types narrow `unknown` fields to `string | undefined`.
  - `pi-pending-notifications`: the pending tool-result shape declares `result`/`error`/`patchFile` as `string | undefined` instead of `unknown` — matching the `typeof === "string"` guards already applied at every extraction site; no runtime behavior change.

## 0.8.6

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.8.5

### Patch Changes

- b3a8cf77b: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.6.0 → @xyz-agent/extension-protocol@0.7.0)

## 0.8.4

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.8.3

### Patch Changes

- df69a18fc: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.5.1 → @xyz-agent/extension-protocol@0.6.0)

## 0.8.2

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.8.1

### Patch Changes

- 8e52cb3ba: Dependency range correction: pin `@xyz-agent/extension-protocol` from `workspace:^0.4.0` to `workspace:*` (align with current workspace version, eliminate install drift flagged in review), plus dev-only coverage tooling declaration. No runtime behavior change.

## 0.8.0

### Minor Changes

- 07b5a813d: Move widget rendering from tool-result payloads to widget-panel pushes (`guiSetWidget`)

  The `details.__gui__` field is no longer attached to `todo` / `goal_control` tool results in RPC mode. GUI state is now pushed through the extension-protocol `guiSetWidget` channel (marker-encoded `GuiRenderResult` over the native `setWidget` transport), which hosts decode and render as a dedicated widget panel in the conversation flow. Tool results carry plain text in every mode, so state display no longer duplicates into each tool result.

  Widget payloads were restructured to the v1.1 meta-head architecture (`WidgetMeta`): the host shell renders a single head row (title, status dot, progress count "N/M", mini progress bar) while the body is a numbered list-tree whose item status is expressed solely by a trailing dot — per-row icons and ids burned into labels are gone. Goal widgets map `GoalStatus` onto the same head semantics (active = running, complete = done, blocked/budget_limited/cancelled = failed, paused = idle). The goal `UiPort` interface gains `setGuiWidget` and an `isGui` flag so the projection layer picks the GUI or TUI rendering path.

  Impact for consumers: code reading `details.__gui__` from these tool results must switch to the widget channel; `@xyz-agent/extension-protocol` 0.4.0 keeps `extractGui` as a legacy read path with v1/v1.1 dual-format support during the transition. TUI/CLI behaviour is unchanged — when the host is not GUI-capable, native text widgets and status lines are used exactly as before.

## 0.7.1

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

## 0.7.0

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

## 0.6.1

### Patch Changes

- 246cd5e72: Align the `@xyz-agent/extension-protocol` dependency specifier to `^0.4.0`. The previous `^0.3.1` range does not satisfy the 0.4.0 breaking bump, so consumers installing these packages would fail to resolve protocol 0.4.0 (ERESOLVE).

## 0.6.0

### Minor Changes

- 878e439: Remove the `isVerification` structured field from the todo data model.

  Verification guidance now lives only in the tool prompt: the AI is nudged to add a separate todo for checks like running tests / typecheck, but there is no persisted flag and no longer a "verification todo cannot be cancelled" guard.

  Removed: `Todo.isVerification` field, `addTodos` 4th param, schema `isVerification`, both `updateTodos`/`handleSingleUpdate` verification guards, `migrateTodo` flag preservation, and the related test cases.

## 0.5.2

### Patch Changes

- Updated dependencies [6e2e453]
  - @xyz-agent/extension-protocol@0.3.1

## 0.5.2-dev.0

### Patch Changes

- Updated dependencies [6e2e453]
  - @xyz-agent/extension-protocol@0.3.1-dev.0

## 0.5.1

### Patch Changes

- Updated dependencies [74a0b10]
  - @xyz-agent/extension-protocol@0.3.0

## 0.5.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.4.2

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

## 0.4.1

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

## 0.4.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

## 0.3.0

### Minor Changes

- Four-state task model + verification flag for goal↔todo merge (FR-1).

  `pi-todo` is upgraded from a three-state to a **four-state** model to become
  the shared task backend for `@zhushanwen/pi-goal` (0.4.0+) and to mirror
  Codex's task lifecycle:

  - Status enum: `pending | in_progress | completed | cancelled`
    (`cancelled` is terminal and non-recoverable)
  - New optional `isVerification` field — marks verification tasks used by
    goal's prompt-driven completion audit (FR-6). Verification tasks must reach
    `completed`, never `cancelled`
  - Legacy data migration on read:
    - `status: "verifying"` → `"in_progress"`
    - `status: "failed"` → `"pending"`
    - `done: boolean` → `status: "completed" | "pending"`
    - `isVerification` preserved when present (absent on old data is fine — field
      is optional)

  Backward compatible: existing stored todo lists load unchanged after migration.
  Goal 0.4.0 depends on this model — pair this release with `pi-goal@0.4.0`.

## 0.2.0

### Minor Changes

- ee8a22d: Simplify the todo state model from 4 states (pending / in_progress / verifying / failed) to 3 states (pending / in_progress / completed) and remove the verification interception. The dual-column TUI widget is now CJK-aware via `pi-tui`'s `visibleWidth`, and a completion steer is injected when every todo is done.

  **Breaking changes**

  - Removed `verifying` and `failed` states; `verifyText` / `verifyAttempts` / `evidence` fields are gone
  - Removed the `verify` action and the `verifyTexts` / `verified` / `evidence` parameters on `update` actions
  - `migrateTodo` now maps `verifying → in_progress` and `failed → pending` on legacy state load

  **Additions**

  - Dual-column widget layout (active list on the left, completed list on the right) with a vertical divider
  - CJK-aware column sizing using `pi-tui`'s `visibleWidth` (replaces custom `visualLen` that ignored east-asian width)
  - Completion steer: when every todo is `completed`, a one-shot summary check is injected into the next agent turn
  - Reduced reminder interval (3 → 2) and switched to a minimal reminder that mentions only the next pending task

### Patch Changes

- 167fdf3: Widget layout now switches between single and dual column based on Pi's widget line limit.

  - Discovered Pi caps extension widgets at `InteractiveMode.MAX_WIDGET_LINES = 10` strings per widget.
  - Todo widget reserves the header line and uses `max - 1 = 9` as the safe content budget.
  - When the task count is 8 or fewer, the widget renders in a single column; 9 or more tasks switch to the existing dual-column layout to stay within the budget and avoid Pi's truncation.

## 0.1.6

### Patch Changes

- 15b68f6: Fix evolve analyzer to find session files in project subdirectories, unify pi.extensions to ./index.ts

## 0.1.5

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.1.4

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.1.3

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring

## 0.1.1

### Patch Changes

- Test CI release pipeline
