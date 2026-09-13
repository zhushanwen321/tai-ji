# @zhushanwen/pi-subagent-cli

## 0.3.0

### Minor Changes

- 893b702b6: Aligned with engine-protocol v1: child-exit reporting now carries the killed flag, process kill handling was consolidated onto the shared @zhushanwen/pi-rpc kill chain (new dependency), and stdin frame assembly reuses the shared RPC layer. Behavior-compatible refactor for embedders; protocol surface unchanged beyond the SDK-side poolKey retirement.

## 0.2.0

### Minor Changes

- 14d1d4567: Align with the subagent-core chat-run unification ([H1]). Breaking changes to the package's public exports — hosts MUST be upgraded in lockstep with `@zhushanwen/subagent-core` in the same release batch.

  - **`ChatSessionRegistry` family exports removed** (`ChatSessionRegistry`, `ChatSessionRegistryDeps` and related session-registry types from the barrel): the "session outlives runs, askUser binds per chat session" special case is retired. With chat-run unification every chat round is a run dispatched as a session-form run (`run.resume`), and host/askUser two-phase channels are bound per-run (`bindAskUser` per active run, unbound on run exit).
  - Protocol behavior follows the engine-sdk surface narrowing: `run.resume` is the only session-form key, the `interact` method and `host/roundLifecycle` channel are gone.

## 0.1.2

### Patch Changes

- ab07bdb4a: Align test-guard comments with the v2 data-directory layout (comment-only; no runtime behavior change).

## 0.1.1

### Patch Changes

- 838806898: W9 packaging & distribution registration (subagent-engine-protocolization): engine CLI packages are npm-publishable and declared as dependencies of @zhushanwen/pi-subagent-workflow so standalone installs get engines automatically. Electron packaged form bundles both engines to resources/engines/<id>/ (discovered via XYZ_AGENT_ENGINE_ROOTS); zsw vendored form adds engine package directories under lib/vendor/ (owner: z-code-plugin-workspace z-subagent-workflow repo).
