# 归档债权收尾两入口不对称：GUI 归档路径不收尾 completion-watch

状态：未解决（2026-10-21 登记；dev-merge branch-review dmg-r3-3，缺口基线既有、非 session-manager-archive-delete 分支引入——该分支的 agent 工具路径已收尾，本登记为 GUI 路径的存量缺口）

## 现状

session 死亡时父 agent 挂起的 completion-watch（notify-claims 债权）需要收尾（onSessionDeath → deliverRespondTargets → clearSession，实装收敛于 `settleClaimsOnDeath`）。当前收尾发声点共五处汇聚：

- 组合根 `speakSessionDeath`（packages/runtime/src/index.ts）承接 delete / forceQuit / 非 respawn 链 exit / 熔断四点
- `SessionManagerHandler.handleArchive`（packages/runtime/src/transport/session-manager-handler.ts，agent 工具 `archive_session` 路径）承接第五点——归档成功后收尾，watch 收 `'exited'`

**GUI 入口不对称**：侧栏归档按钮走 `session.archive` WS RPC（`session-message-handler.ts` `handleSessionArchive`），该路径只调 `archiveService.archive()` 后 reply，**不收尾 watch**。归档 teardown 对活跃子会话发 `'suppress'` 处置（`archive-service.ts` `teardownForArchive` → `fireSuppressDisposition`），而组合根 `subscribeSessionDeathDisposition` 仅对 `'delete'` 发声——`'suppress'` 被静默跳过。

## 影响

经 GUI 归档一个带有活跃子会话（子会话上有父 agent 挂起的 completion-watch）的 session 时，父 agent 的 watch 无终态回包，挂起至 runtime 重启（重启扫描按死亡处置补收尾）。无数据丢失，属通知时延缺口。

## 修复方向（长期方案）

`SessionDeathDisposition`（`session-lifecycle.ts`，现为 `'delete' | 'suppress'`）增 `'archive'` 值，归档 teardown 改发 `'archive'`；组合根对该值统一 `speakSessionDeath(sid, 'exit')`，GUI 与 agent 工具两入口同判——收尾逻辑回到单一汇聚点，不再依赖各入口自觉调用。代码侧缺口现以 JSDoc 登记于 `session-manager-handler.ts` `handleArchive`（「GUI 入口已知缺口与长期方案」段）。
