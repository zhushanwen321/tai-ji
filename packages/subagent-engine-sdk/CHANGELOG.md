# @zhushanwen/subagent-engine-sdk

## 0.6.1

### Patch Changes

- 43a50ae2e: Design-code-sync round 1: fixes dangling references, tightens message purity, and splits the error-mapping path.

## 0.6.0

### Minor Changes

- 8285841af: Protocol surface hardening plus a shared zcode path module. `RunContextParams.cwd` is now optional — absent means the engine falls back to its own process cwd (additive wire semantics; worktree-isolated runs still carry the worktree path). Tolerant semantics for unknown members are codified: engines must answer unknown forward methods with the registered `engine_method_unsupported` passthrough error code (never hang or crash), and hosts answer unknown `host/*` reverse channels with `{unsupported:true}` so the sending engine takes its own degradation path. The AgentEvent vocabulary is compile-locked (per-member `EventName` constraint, SSOT constant, noop-safe markers for unknown-event tolerance), and the field-attribution criteria and evolution policy are codified as the protocol constitution headers (ADR-0071). New `zcode-db-paths` module exports `ZCODE_HOST_DB_SUFFIX` / `ZCODE_ISOLATED_DB_SEGMENTS` as the single source of the zcode session-db path contract shared by the engine write side and the host read side. The engine env deny list additionally strips `TAIJI_PRESET_FALLBACK_FROM` / `TAIJI_PRESET_FALLBACK_TO` (per-run facts that would false-disclose when inherited one hop into sub-agents).

## 0.5.1

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
