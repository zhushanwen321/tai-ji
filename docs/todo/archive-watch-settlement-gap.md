# 归档债权收尾两入口不对称：GUI 归档路径不收尾 completion-watch

状态：已解决（2026-10-23 just-do-it 批次 2 条目 28 按登记长期方案修复）：`SessionDeathDisposition` 增 `'archive'` 值，归档 teardown（archive-service teardownForArchive → fireArchiveDisposition）改发该值；组合根对该值统一 `speakSessionDeath(sid, 'exit')` 并照立 suppressedDeaths 抑制标——GUI 侧栏归档与 agent 工具 archive_session 两入口同判，收尾回到单一汇聚点；session-manager-handler.handleArchive 的手动收尾已删除（JSDoc 缺口登记随之清除）。测试锚定：archive-service 处置探针 + session-lifecycle-death-disposition GUI 触发用例 + session-manager-handler 汇聚点收尾用例

## 现状

session 死亡时父 agent 挂起的 completion-watch（notify-claims 债权）需要收尾（onSessionDeath → deliverRespondTargets → clearSession，实装收敛于 `settleClaimsOnDeath`）。当前收尾发声点共五处汇聚：

- 组合根 `speakSessionDeath`（packages/runtime/src/index.ts）承接 delete / forceQuit / 非 respawn 链 exit / 熔断四点
- `SessionManagerHandler.handleArchive`（packages/runtime/src/transport/session-manager-handler.ts，agent 工具 `archive_session` 路径）承接第五点——归档成功后收尾，watch 收 `'exited'`

**GUI 入口不对称**：侧栏归档按钮走 `session.archive` WS RPC（`session-message-handler.ts` `handleSessionArchive`），该路径只调 `archiveService.archive()` 后 reply，**不收尾 watch**。归档 teardown 对活跃子会话发 `'suppress'` 处置（`archive-service.ts` `teardownForArchive` → `fireSuppressDisposition`），而组合根 `subscribeSessionDeathDisposition` 仅对 `'delete'` 发声——`'suppress'` 被静默跳过。

## 影响

经 GUI 归档一个带有活跃子会话（子会话上有父 agent 挂起的 completion-watch）的 session 时，父 agent 的 watch 无终态回包，挂起至 runtime 重启（重启扫描按死亡处置补收尾）。无数据丢失，属通知时延缺口。

## 修复方向（长期方案）

`SessionDeathDisposition`（`session-lifecycle.ts`，现为 `'delete' | 'suppress'`）增 `'archive'` 值，归档 teardown 改发 `'archive'`；组合根对该值统一 `speakSessionDeath(sid, 'exit')`，GUI 与 agent 工具两入口同判——收尾逻辑回到单一汇聚点，不再依赖各入口自觉调用。代码侧缺口现以 JSDoc 登记于 `session-manager-handler.ts` `handleArchive`（「GUI 入口已知缺口与长期方案」段）。
