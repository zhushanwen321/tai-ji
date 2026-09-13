# @zhushanwen/pi-pending-notifications

## 0.7.1

### Patch Changes

- 893b702b6: Map new subagent stop reasons (interrupted / interrupted-by-restart / interrupted-by-parent / reopened) to correct pending statuses instead of falling through to completed.

## 0.7.0

### Minor Changes

- 4955dad6e: Make session entries the single source of truth and delete the dead session-tier machine.

  The in-memory pending registry is removed: the `pending_notifications` tool projection and both write-side pre-pend checks (register dedup / unregister active check) now compute against `sessionManager.getEntries()` via the same `countActiveFromEntries` primitive already consumed by goal and subagent-workflow, so "what got persisted" and "what gets queried" can no longer diverge (root-fixes the documented bte reconcile divergence). The unused session-tier machinery — TTL expiry, cross-session flush, shutdown cancellation, and the `PENDING_LIFECYCLE` / `PENDING_TTL_MS` constants — serves 0 of 3 current pending types and is deleted along with `PendingEntry.expiresAt`. Write-side entry shape and tool output semantics are unchanged. Named exports shrink from 14 to 5 (`countActiveFromEntries` plus its signature types `CountActiveOptions` / `CountActiveResult` / `PendingEntry` / `PendingType`); the removed symbols were production-unused outside this package. Breaking for standalone consumers importing the removed symbols — shipped as a minor bump per the repo's 0.x convention (minor = breaking).

## 0.6.0

### Minor Changes

- 838806898: Align with engine protocol v1.x: background-task (subagent/workflow) pending registrations are pinned to the process tier, and read-side consumers filter by sessionId so cross-session views no longer silently drop long-running registrations.

## 0.5.3

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.5.2

### Patch Changes

- 7b33e6f00: **todo / pending-notifications: dead-surface and type cleanup from the drift-cleanup sweep**

  - `pi-todo`: the dead `getDisplayStatus` export is removed (`model.ts`) — it was an internal-equivalent wrapper over `migrateTodo(t).status` whose only in-repo caller inlined it directly, and the `todo_list` tool description now says "View all todos for the current session" (matches actual per-session behavior, not per-branch). Tool-detector types narrow `unknown` fields to `string | undefined`.
  - `pi-pending-notifications`: the pending tool-result shape declares `result`/`error`/`patchFile` as `string | undefined` instead of `unknown` — matching the `typeof === "string"` guards already applied at every extraction site; no runtime behavior change.

## 0.5.1

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.5.0

### Minor Changes

- 23d8fe3cc: **pending-notifications: `bash` task type and `process` lifecycle tier**

  - Extensions can now register async operations with a `process` lifecycle tier alongside the existing `session` tier
  - `process`-tier entries are exempt from the 1h TTL expiry, survive across sessions and are not flushed on shutdown — long-running background tasks no longer get their completion notifications silently dropped while still running
  - Adds the `bash` task type (used by pi-base-tool-enhance background tasks); type registry stays open for future extension-defined types

## 0.4.0

### Minor Changes

- b3a8cf77b: **pending-notifications: `bash` task type and `process` lifecycle tier**

  - Extensions can now register async operations with a `process` lifecycle tier alongside the existing `session` tier
  - `process`-tier entries are exempt from the 1h TTL expiry, survive across sessions and are not flushed on shutdown — long-running background tasks no longer get their completion notifications silently dropped while still running
  - Adds the `bash` task type (used by pi-base-tool-enhance background tasks); type registry stays open for future extension-defined types

## 0.3.5

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

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

- 2a724190c: **extension-logger / pending-notifications / subagent-workflow: unify debug env switches on XYZ_AGENT_DEBUG**

  - File-log gating in `extension-logger` now reads `XYZ_AGENT_DEBUG=1` (previously `PI_EXT_DEBUG`); `pending-notifications` console debug logs switch from `PENDING_DEBUG` to `XYZ_AGENT_DEBUG`; `subagent-workflow` debug traces likewise moved to `XYZ_AGENT_DEBUG`.
  - One switch now toggles debug logging across all extensions that follow the logging conventions doc — no per-extension env vars to remember.

## 0.3.1

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

## 0.3.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.2.1

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

## 0.2.0

### Minor Changes

- 2a3fed0: Introduce `pending-notifications` extension and wire workflow/subagent background operations into it.

  - New `pending-notifications` extension tracks active async operations (workflow/subagent) via EventBus + session entries.
  - Workflow `run` / `abort` / terminal error paths emit `pending:register` and `pending:unregister` through a single EventBus port.
  - Subagent background mode now emits the same events via `pi.events.emit`; stale-context errors during subagent child sessions are now tolerated.
  - Goal's `before_agent_start` reads pending entries and injects a waiting hint when async work is active.
  - Added `workflow:log`, `pending:log`, and `goal:log` debug entries for tracing the register/unregister flow.
  - Workflow UI rendering improvements: themed border helpers and fixed overlay ghost rows.
