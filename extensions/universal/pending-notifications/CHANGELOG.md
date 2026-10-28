# @zhushanwen/pi-pending-notifications

## 0.11.1

### Patch Changes

- 3107549df: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.24.0 → @zhushanwen/extension-protocol@0.25.0, @zhushanwen/pi-delivery-port@0.3.0 → @zhushanwen/pi-delivery-port@0.3.1)

## 0.11.0

### Minor Changes

- da658a786: `collect_results` 的 `outcome` 终态标注改读注销 reason 的结清解析（不可判读时新增 `unknown` 标注）；unregister 事件 reason 缺失或畸形时按 `no_result` 结算并留痕告警，不再误标为 `completed`。

## 0.10.1

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0, @zhushanwen/pi-delivery-port@0.2.0 → @zhushanwen/pi-delivery-port@0.2.1)

## 0.10.0

### Minor Changes

- 58a70ebc9: 新增 collect_results 工具：一次调用等待并批量收取后台操作结果（bash 后台命令、workflow 等）；未指定 ids 时缺省收取当前会话全部活跃操作（自动排除 managed-session 终身条目），超时返回已到达子集、其余照常推送。

## 0.9.0

### Minor Changes

- 796f01b29: pending_notifications 结果 details 新增 summary 收起态一行摘要，并新增 TUI 折叠态渲染。

## 0.8.6

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.20.0 → @zhushanwen/extension-protocol@0.21.0)

## 0.8.5

### Patch Changes

- 993ee907f: Trim the pending_notifications description by dropping the internal state-maintenance note (EventBus/session-entries bookkeeping is invisible to callers), as part of the tool-declaration slimming pass.

## 0.8.4

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.19.0 → @zhushanwen/extension-protocol@0.20.0)

## 0.8.3

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.18.0 → @zhushanwen/extension-protocol@0.19.0)

## 0.8.2

### Patch Changes

- 802af968f: (no changeset body; patch version bump)

## 0.8.1

### Patch Changes

- 0d36077d4: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.16.0 → @zhushanwen/extension-protocol@0.17.0)

## 0.8.0

### Minor Changes

- 8aa4b40e8: Managed-session completion notifications now fire exactly once (notify-once claim ledger):

  - `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
  - `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
  - `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
  - `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
  - `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

## 0.7.7

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0)

## 0.7.6

### Patch Changes

- 8285841af: Documents the direct appendEntry unregister producers (workflow finalizeRun, reconcile sweeps, session-start reconcile) in the event contract header so the emit-side producer list matches the durable write path; no behavior change.

## 0.7.5

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
