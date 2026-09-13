# @zhushanwen/subagent-engine-sdk

## 0.4.0

### Minor Changes

- 893b702b6: BREAKING CHANGE (0.x, carried as minor): `RunContextParams.poolKey` (required string) has been removed — the pool abstraction is retired on the protocol surface and the journal now always lands under the engine's shared directory. Engine implementations implementing `RunContextParams` must drop the field; no replacement is needed.

  Other protocol-surface adjustments in this release: reverse-channel surface consolidated for engine-protocol v1, resume anchor carried via `run.params.resume` (generic rename of the former chat params, payload unchanged).

## 0.3.0

### Minor Changes

- 14d1d4567: Protocol surface narrowing aligned with the chat-run unification ([H1]) and the subagent service decomposition ([H3]). Breaking changes to the wire protocol and published types — hosts and engines MUST be upgraded in lockstep with `@zhushanwen/subagent-core` in the same release batch (old-protocol engines paired with new-core `resume` runs would silently lose session continuity: each round would spawn a fresh session file and overwrite the previous one).

  - **`interact` method family removed** (protocol methods 10 → 9): chat continuity is unified into the `run` method — a continuation round is a new run carrying a `resume` anchor (design: subagent-chat-run-unification §3.3 D5/D7, units U5/U6). `InteractAction` / `InteractResult` contract types are removed with it.
  - **`RunChatParams` renamed to `RunResumeParams`** and the run session-form key switched from `chat` to `resume` (read/write sides switched in the same batch, no dual-key window; payload shape unchanged: `recordId` + optional `ResumeAnchor`).
  - **Reverse channel family narrowed** (9 → 8): the `host/roundLifecycle` phase channel is retired — per-round phase frames and the recordId-keyed routing died with the chat-domain phase machine; streaming deltas flow through `host/streamDelta` (runId-keyed run-scoped channel).
  - `HostStreamDeltaParams` comment semantics corrected: the recordId-association branch is a legacy v1.x engine compatibility payload, not a current-write shape.
  - **Additive public surface shipped in the same batch** (non-breaking; listed here for CHANGELOG completeness):
  - `SHARED_POOL_KEY` constant export (`port-contract.ts`);
  - `RunContext` gained three optional members `sessionRootId?` / `sessionDir?` / `onChildStateChanged?` (old hosts simply omit them);
  - `AgentEvent` union gained a `{ type: "activity" }` variant and the `notificationFrameSchema` event-type enum gained `"activity"` — wire-additive, but old hosts that enum-validate notification frames strictly will reject the new frame type, so the lockstep warning above applies to this direction as well;
  - `runSessionParamsSchema` export (`schema.ts`);
  - `ENGINE_ENV_DENY_LIST` narrowed by the three retired `XYZ_SUBAGENT_RELAY_STDIN/STDOUT/STDERR` keys (downstream-visible: the SDK-side spawn scrub list no longer strips them; all writers were removed in the same batch — zero production references remain, verified by grep).

## 0.2.1

### Patch Changes

- ab07bdb4a: Align test-guard comments with the v2 data-directory layout (comment-only; no runtime behavior change).

## 0.2.0

### Minor Changes

- 838806898: Expose the engine-side SDK surfaces for process spawn, schema emulation, and UI channels/types, so engine packages build against one shared contract.
