# session-manager send 通路受理成功后不清旧终态 sidecar

状态：未修复（dev-merge 前置 branch-review 第 2 轮 minor 发现 dmg-r2-1，2026-10-25 登记；随 fix-chat-flow-order 分支合入，留终局 PR 期复核）。

现象：跨回合新终态被第一终态优先拦截——第一回合结束后 sidecar 留存旧终态，第二回合经 session-manager send 通路跑完写新终态时被「已有终态」判定吞掉。message-dispatcher 受理通路已在 dmg-r1-1 修复（新回合受理成功后清 sidecar，`clearSessionOutcome`），本条是该修复在 session-manager send 这一第二生产通路的残留缺口。

修复方向：session-manager-handler 受理成功后调用同一 `clearSessionOutcome`（唯一写入口径对齐 dmg-r1-1），配套 session-outcome-first-terminal 测试补 session-manager 通路用例。

相关文件：`packages/runtime/src/interfaces.ts`、`packages/runtime/src/transport/session-manager-handler.ts`、`packages/runtime/src/services/session/session-internal.ts`、`packages/runtime/src/services/session/__tests__/session-outcome-first-terminal.test.ts`。
