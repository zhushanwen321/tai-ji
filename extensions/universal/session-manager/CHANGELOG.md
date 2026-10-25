# @zhushanwen/pi-session-manager

## 0.6.1

### Patch Changes

- 318994f4a: `create_managed_session` is now always declared to the model (resident); the other seven session tools remain deferred behind tool_search.

## 0.6.0

### Minor Changes

- df839883b: Adds two new session tools: archive_session tidies a finished session into the user-reversible archive area (safe to call on the agent's own initiative), and delete_session permanently removes a session with all its derived data (strictly user-initiated only); all tools also gain concise prompt snippets and richer descriptions with examples and stale-id recovery guidance.

## 0.5.0

### Minor Changes

- 58a70ebc9: managed session 通知改经统一投递端口提交，批量通知按批内全部会话键申报收取（collect_results 逐键展开收取）；pending:register 事件新增可选 kind 字段（"lifetime" 标记终身条目）。

## 0.4.0

### Minor Changes

- 796f01b29: 六个 session 管理工具结果 details 新增 summary 收起态一行摘要（经 toSummary 统一组装），并新增 TUI 折叠态渲染。

## 0.3.4

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.20.0 → @zhushanwen/extension-protocol@0.21.0, @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0, @zhushanwen/pi-notify-ledger-host@0.3.3 → @zhushanwen/pi-notify-ledger-host@0.3.4, @zhushanwen/subagent-core@1.5.1 → @zhushanwen/subagent-core@1.5.2)

## 0.3.3

### Patch Changes

- 993ee907f: Mark the six managed-session tools exposure:deferred (they activate on a tool_search hit instead of the resident tool list) and tighten their descriptions, cutting standing prompt tokens for the session toolkit.

  Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

## 0.3.2

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.19.0 → @zhushanwen/extension-protocol@0.20.0, @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4, @zhushanwen/pi-notify-ledger-host@0.3.1 → @zhushanwen/pi-notify-ledger-host@0.3.2, @zhushanwen/subagent-core@1.4.0 → @zhushanwen/subagent-core@1.5.0)

## 0.3.1

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.18.0 → @zhushanwen/extension-protocol@0.19.0, @zhushanwen/pi-notify-ledger-host@0.3.0 → @zhushanwen/pi-notify-ledger-host@0.3.1, @zhushanwen/subagent-core@1.3.0 → @zhushanwen/subagent-core@1.4.0)

## 0.3.0

### Minor Changes

- 802af968f: Session management tools (`create`/`send`/`history`/`status`/`list`/`abort`) no longer time out after 30–60 seconds: a slow runtime response resolves whenever it arrives, and the transport-failure error text now reads "cancelled or channel error" (requires pi 1.0.0).

## 0.2.4

### Patch Changes

- 492e02447: chore: refresh dependency range (triggered by @zhushanwen/pi-notify-ledger-host@0.2.3 → @zhushanwen/pi-notify-ledger-host@0.2.4, @zhushanwen/subagent-core@1.2.0 → @zhushanwen/subagent-core@1.2.1)

## 0.2.3

### Patch Changes

- b44f1316b: chore: refresh dependency range (triggered by @zhushanwen/pi-notify-ledger-host@0.2.2 → @zhushanwen/pi-notify-ledger-host@0.2.3, @zhushanwen/subagent-core@1.1.0 → @zhushanwen/subagent-core@1.2.0)

## 0.2.2

### Patch Changes

- a9b6a9fc7: chore: refresh dependency range (triggered by @zhushanwen/pi-notify-ledger-host@0.2.1 → @zhushanwen/pi-notify-ledger-host@0.2.2, @zhushanwen/subagent-core@1.0.0 → @zhushanwen/subagent-core@1.1.0)

## 0.2.1

### Patch Changes

- 0d36077d4: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.16.0 → @zhushanwen/extension-protocol@0.17.0, @zhushanwen/pi-notify-ledger-host@0.2.0 → @zhushanwen/pi-notify-ledger-host@0.2.1, @zhushanwen/subagent-core@0.13.0 → @zhushanwen/subagent-core@1.0.0)

## 0.2.0

### Minor Changes

- 8aa4b40e8: Managed-session completion notifications now fire exactly once (notify-once claim ledger):

  - `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
  - `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
  - `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
  - `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
  - `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

## 0.1.16

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.14.0 → @zhushanwen/extension-protocol@0.15.0)

## 0.1.15

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0)

## 0.1.14

### Patch Changes

- 8285841af: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.12.0 → @zhushanwen/extension-protocol@0.13.0)

## 0.1.13

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 0.1.12

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
