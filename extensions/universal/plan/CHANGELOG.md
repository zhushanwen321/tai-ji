# @zhushanwen/pi-plan

## 0.4.5

### Patch Changes

- 893b702b6: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.14.0 → @zhushanwen/pi-goal@0.14.1)

## 0.4.4

### Patch Changes

- 4955dad6e: Crash-resilience guard against stale-context async callbacks.

  - **pi-ext-guards**: exports the new `guardStaleCtx` helper. It wraps session-scoped async callbacks so that, once the hosting session is no longer active, late resolves are dropped instead of writing into a dead or recycled context.
  - **pi-plan / pi-scheduler / pi-structured-output**: adopt `guardStaleCtx` around their session-lifetime async flows (plan compaction, scheduler tick handlers, structured-output loop gating), preventing late callbacks from landing in a session that has already ended.

## 0.4.3

### Patch Changes

- 838806898: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.12.2 → @zhushanwen/pi-goal@0.13.0)

## 0.4.2

### Patch Changes

- bbd8e5e8a: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.12.1 → @zhushanwen/pi-goal@0.12.2)

## 0.4.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.4.0

### Minor Changes

- 7b33e6f00: **pi-plan: remove `pi.__planStart` external API mount**

  - The `pi.__planStart(requirement, ctx)` external mount and its `startPlanMode` implementation are removed. The only cross-extension consumer (the goal extension's plan-mode probe) had already been deleted — the probe could never fire across extension boundaries, so the mount was unreachable in practice. `/plan` command, plan tool, and widget behavior are unchanged; this only removes the dead programmatic surface.

## 0.3.15

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.3.14

### Patch Changes

- 23d8fe3cc: **plan: successCriteria built as summary plus numbered step previews**

  - `buildPlanSuccessCriteria` now returns a structured list — one summary line (`All N steps of <plan> executed and verified`) plus up to 3 numbered step previews — instead of a single concatenated string
  - Each preview is truncated to 80 chars and collapsed to a single line, matching the goal-side schema and handler constraints

## 0.3.13

### Patch Changes

- b3a8cf77b: **plan: successCriteria built as summary plus numbered step previews**

  - `buildPlanSuccessCriteria` now returns a structured list — one summary line (`All N steps of <plan> executed and verified`) plus up to 3 numbered step previews — instead of a single concatenated string
  - Each preview is truncated to 80 chars and collapsed to a single line, matching the goal-side schema and handler constraints

## 0.3.12

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.3.11

### Patch Changes

- df69a18fc: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.9.2 → @zhushanwen/pi-goal@0.9.3)

## 0.3.10

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.3.9

### Patch Changes

- 8e52cb3ba: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.9.0 → @zhushanwen/pi-goal@0.9.1)

## 0.3.8

### Patch Changes

- 07b5a813d: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.8.3 → @zhushanwen/pi-goal@0.9.0)

## 0.3.7

### Patch Changes

- 2a724190c: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.8.2 → @zhushanwen/pi-goal@0.8.3)

## 0.3.6

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

## 0.3.5

### Patch Changes

- a0d700161: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.8.1 → @zhushanwen/pi-goal@0.8.2)

## 0.3.4

### Patch Changes

- 571277c62: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.8.0 → @zhushanwen/pi-goal@0.8.1)

## 0.3.3

### Patch Changes

- 90fe9401d: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.7.1 → @zhushanwen/pi-goal@0.8.0)

## 0.3.2

### Patch Changes

- 246cd5e72: chore: refresh dependency range (triggered by @zhushanwen/pi-goal@0.7.0 → @zhushanwen/pi-goal@0.7.1)

## 0.3.1

### Patch Changes

- 75205b1e4: Flip `goal_control` create to proactive + add `successCriteria` field.

  ## What's New

  - **create → proactive**: `goal_control` create now proactively starts goals for complex multi-step work (3+ steps, multi-file, needs completion verification), instead of only when the user explicitly asks. The agent restates the real objective (not a literal echo) and defines checkable success criteria. 3-tier proactive signal via description + promptSnippet + promptGuidelines.
  - **`successCriteria` field**: goals now carry verifiable completion criteria alongside the objective, persisted in `GoalRuntimeState` (optional, backward-compatible). Injected into all steering prompts (contextInjection / continuation / budgetLimit) — `complete` evidence must meet every `successCriteria` condition. Surfaced in TUI widget + RPC GUI + `/goal status`.
  - **`/goal update` keeps criteria**: reshape no longer wipes `successCriteria` — pass `--criteria <text>` to replace it, otherwise the previous criteria are kept (with an objectiveUpdated steering note that completion is judged against the new objective). Previously the criteria were silently lost with no way to restore them.
  - **plan → goal bridge**: `__goalInit` calls from the plan extension now pass a `slug` (derived from the plan file stem) and a `successCriteria` (all plan steps executed and verified), so plan-initiated goals carry verification standards instead of none.

  ## Breaking changes

  - `goal_control(action="create")` now **requires** `successCriteria` (handleCreate throws if missing). External `__goalInit` callers keep it optional (programmatic callers).
  - `@zhushanwen/pi-plan` adds `@zhushanwen/pi-goal` as a peerDependency (type-only import of `GoalInitFn` — runtime unaffected when goal is absent).

## 0.3.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.2.3

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

## 0.2.2

### Patch Changes

- 96aed1d: Fix test infrastructure broken by workflow directory removal: give plan and structured-output their own self-contained mocks/ dirs (previously aliased the now-deleted ../workflow/mocks/\*). Update coding-workflow README to reference @zhushanwen/pi-subagent-workflow (replacing deprecated @zhushanwen/pi-workflow).

## 0.2.1

### Patch Changes

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

  See `docs/adr/002-goal-7-state-machine.md` for the 7-state rationale.

## 0.2.0

### Minor Changes

- b280872: Add new @zhushanwen/pi-plan extension: lightweight plan mode with brainstorming + writing-plans capabilities
