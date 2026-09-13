# @zhushanwen/subagent-core

## 0.10.0

### Minor Changes

- 893b702b6: BREAKING CHANGE (0.x, carried as minor): public surface narrowed. The barrel export shrinks from 298 to 229 symbols, and the `./engines/zcode/reader` and `./engines/zcode/constants` subpath entries are removed — zcode engine reading now lives in the standalone `@zhushanwen/zcode-subagent-cli` package, so consumers of those subpaths must import from its main entry instead. A new `./engine/engine-discovery-scan` subpath entry exposes engine discovery scanning (alongside the existing `./engine/paths`, `./relay-env`, `./workflows/*`). Consumers importing removed barrel symbols must switch to the remaining declared entries or own the logic locally.

## 0.9.0

### Minor Changes

- 14d1d4567: Execution-runtime extraction and chat-run unification alignment ([H1]–[H4]). Breaking and behavioral changes — release in lockstep with `@zhushanwen/subagent-engine-sdk`, `@zhushanwen/pi-subagent-cli` and `@zhushanwen/zcode-subagent-cli` from the same batch (new-core `resume` runs against old-protocol engines would silently lose session continuity).

  - **Execution runtime absorbed from pi-subagent-workflow** ([H1–H4] alignment): the workflow run engine, record store and persistence family now live in this package; pi-subagent-workflow keeps only the registration surface and pi host adapters.
  - **`InteractAction` / `InteractResult` exports removed** (barrel `src/index.ts`): the interact protocol family retired with chat-run unification — chat continuation is a new run with a `resume` anchor.
  - **`LifecycleDeps.streamSink` replaced by `workflowAgentDispatch`**: stream consumption is wired through the workflow agent dispatch closure (carrying the real `run.runId`) instead of a stream sink port.
  - **`ExecutionTraceNode.live` field removed**: the "clear live on completion" mechanism collapses into the type layer — nodes carry no runtime-attached object anymore.
  - **`RecordStore.collectRecords` defaults to hiding workflow-origin records**: the `origin === "workflow"` filter is on by default for list/TUI-facing queries; pass the new `includeWorkflow: true` (4th parameter) to see workflow-dispatched records (diagnostics/drill-down channels). Governance paths (orphan recovery / revive) are unaffected and always see all records.
  - `SubagentService` singleton accessors (`getSubagentService` / `setSubagentService`) and the init interface moved to `execution/service/service-bootstrap.ts`; the barrel re-points at it so the exported symbol set is unchanged (consumers unaffected).

## 0.8.0

### Minor Changes

- 4955dad6e: In-flight subagent snapshot API + size-rotated engine journal stream.

  Adds `setInFlightListener` / `getInFlightSnapshot` / `InFlightSnapshot` / `InFlightListener` exports (index.ts barrel + execution/engine/inflight-snapshot.ts), the engine port surface for in-flight snapshots, and a size-rotated journal stream for engine clients. Consumed by `@zhushanwen/pi-subagent-workflow` in-flight reporting (D5). Purely additive.

  NOTE for release (apply-version): bump 时必须同步 `src/index.ts` 的 `CORE_PACKAGE_VERSION = "0.7.1"` 双源字面量到新版本号（`check-subagent-core-closure.mjs` 检查项 0 会拦截漏同步）。

## 0.7.1

### Patch Changes

- ab07bdb4a: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.2.0 → @zhushanwen/subagent-engine-sdk@0.2.1)

## 0.7.0

### Minor Changes

- 838806898: Align with engine protocol v1.x: protocol-first engine session-history reads land with journal fallback, and the shared schema-env byte-limit contract moves to the engine CLI package.

## 0.6.0

### Minor Changes

- bbd8e5e8a: Sync batch collection v2: collectCoordinator routing, batch buffer with notifyBatch, two-stage budget with truncation pointer, crash-recovery hook and dispose conversion, batch-member manifests written at finalized exit, bounded agent_settled rescans, and batch markers preserved across orphan overwrites — making collect recoverable across crash windows.

## 0.5.1

### Patch Changes

- 730fa1779: Consolidate engine transport layers: migrated renderer api middleware and mock layer into core/transport, and converged the zcode engine to a single resident app-server form (launcher rewrite, session-channel turn timers and dispose-harvest, model validation for engine params). Worker message pump extracted from error-recovery with postMessage hardening, plus settled-watchdog and round-settlement improvements for more reliable subagent lifecycle handling.

## 0.5.0

### Major Changes

- 9520e5294: **subagent-core: zcode engine drops the CLI spawn chain and HOME pools — single app-server mode with shared host HOME**

  - The zcode engine now runs exclusively over the app-server RPC channel; the CLI spawn fallback chain is deleted. This removes the probe gate (10s protocol smoke probe gating first use of the resident channel), the protocol-drift first-failure degradation (drift-class RPC errors `-32601`/`-32602` falling back to a spawn rerun with `degraded` records), and the `XYZ_ZCODE_MODE=appserver|spawn` pinning env — protocol drift now surfaces as an actionable error instead of degrading
  - HOME pooling is deleted: spawn env no longer overrides HOME, so db/plugins/MCP all inherit the host HOME and engine sessions write the real `~/.zcode/cli/db/db.sqlite` (shared with the GUI, WAL-concurrency safe). The pooled-HOME machinery (directory lock + pid + heartbeat, orphan pidfile recovery, derived `home-appserver-N` directories, per-pool `config.json` seeding) is gone
  - Credentials are supplied via a new fs-interception launcher (`appserver-launcher.ts`): the CLI-form app-server only reads providers from `~/.zcode/cli/config.json` while the GUI keeps login credentials in `~/.zcode/v2/config.json`, so the engine spawns a wrapper that patches `fs.readFileSync`/`fsPromises.readFile`/`existsSync` to redirect reads of the former to an in-memory merge of "real file + v2 provider injection" (v2 entry wins wholesale on id collision — v2 is the authoritative credential source, replicating the GUI's direct `modelConfig` hand-off out of process). HOME keeps its real value; the drift surface is that a zcode upgrade changing the config read path/way fails loudly with missing baseURL / Model config is missing
  - Breaking export removals from the `engines/zcode/constants` semantic subentry (the export face is the semver contract): `ZCODE_POOL_CONFIG_SUFFIX`, `ZCODE_POOL_DB_RELATIVE_PATH`, `ZCODE_APPSERVER_POOL_KEY`, `ZCODE_APPSERVER_LOCKFILE_NAME`, `ZCODE_APPSERVER_PIDFILE_NAME`, `ZCODE_APPSERVER_LOCK_HEARTBEAT_MS`, `ZCODE_APPSERVER_MAX_DERIVED_HOMES`, `ZCODE_APPSERVER_PIDFILE_GRACE_MS`, `ZCODE_MODE_ENV_VAR`, `ZCODE_APPSERVER_PROBE_BUDGET_MS`, `ZCODE_APPSERVER_DRIFT_RPC_CODES`, `ZCODE_APPSERVER_PROBE_CONN_ENV` — all twelve anchored only the deleted spawn-fallback/HOME-pool machinery
  - `ZCODE_ADAPTER_VERSION` bumps `1.0.0` → `2.0.0` (handle.adapterVersion data source — golden-sample alignment anchor for the new single-mode form)
  - Journal grouping key is now the fixed `'shared'` (`ZCODE_SHARED_POOL_KEY`, mirroring the pi engine's `PI_POOL_KEY` — journals land in `engines/zcode/shared/`), and `handle.sessionRef.dbPath` is an absolute path anchored on `ZCODE_HOST_DB_SUFFIX` instead of a pool-relative one

## 0.4.0

### Minor Changes

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

## 0.2.0

### Minor Changes

- 71c283d25: **subagent-core: new dual-form package with finalized public API surface**

  - New package `@zhushanwen/subagent-core` extracted from the subagent-workflow pi extension: the engine-neutral execution layer (EnginePort, pi/zcode engines), workflow orchestration, and workflow script assets live in one authoritative implementation shared by both hosts (pi extension workspace dependency, zsw npm dependency)
  - Public API surface (semver contract): main-entry barrel exporting host port wiring (configureCore/DEFAULT_DATA_ROOT/HostServices, getLogger, NotifyDomainPorts), the engine contract (EnginePort + neutral types, routeEngine), orchestration entries (runWorkflow/abortRun/RunSpec/LifecycleDeps), plus four semantic subentries (`engines/zcode/reader`, `engines/zcode/constants`, `engine/paths`, `relay-env`) and the `workflows/*` asset subentry; the shell-only `./* -> src/*` deep-path wildcard is kept out of the published surface
  - Dual-form packaging: TS source for workspace consumers (export `import` condition -> src), tsup dist (ESM + CJS, multi-entry shape-preserving output with full d.ts/d.cts) for npm consumers via publishConfig; the `require` condition pointing to dist CJS is a first in this repo — the CJS build enforces a defensive noExternal bundle boundary for `@xyz-agent/extension-protocol` (its npm dist is ESM-only while the zsw host requires CJS on node>=20; current entry closures carry no protocol runtime reference, dist verified constant-free)
  - Dependency closure fixed to `@xyz-agent/extension-protocol` + `proper-lockfile` + `ajv` + `yaml`; host services (logging, data root, discovery roots, notify) are injected via ports, keeping the pi SDK out of the closure
  - Package README documents the full API table, both host onboarding examples (pi shell / standalone CJS host, also the landing spot for the `core_host_not_configured` recovery guidance), and the workflow scriptPath anchoring mechanism behind `core_module_load_failed`
