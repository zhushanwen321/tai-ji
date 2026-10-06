# scheduler-manager 冷启动后 readEntries live client 判定恒失败，面板卡「会话恢复超时」

状态：未解决（2026-10-06 真机验收定时任务 overlay 整合时暴露；缺陷属 scheduler-manager 读链路既有机制，与 overlay 整合改动无关——两入口对照实锤）。

## 现象

dev 实例冷启动后打开历史会话（sidebar 点进，触发会话激活 + pi 进程 spawn），定时任务面板（overlay 定时任务 tab 或托盘 widget 面板）显示「会话恢复超时，请从侧栏重新打开该会话」，此后切换会话再切回（onDidActivateSession 补拉 + 重试预算重置）也不自愈，恒卡死。

## 已核实的事实链

- 树内容「恢复超时」来自插件自身推送：`resources/plugins/scheduler-manager/index.ts` `pushTreeAndBadge` 的 readFailure 分支——`api.sessions.readEntries` 抛错且非终态（会话 status 非 dead/error）→ 按 recovering 重试（READ_RETRY_MS=2s × READ_RETRY_MAX=5）→ 预算耗尽停在该文案。
- 与入口无关实证：overlay 定时任务 tab（ViewHost 挂 `modal-scheduler-manager-scheduler-manager.panel`）与托盘 widget 面板（composer 托盘四方块 → TrayWidgetPanel，按同一 viewId 消费树；meta 缺失时标题兜底显示 viewId 字面）消费同一棵插件推的树，两入口显示同样内容。
- pi 进程实际存活：冷启动点进会话即 spawn（runtime 日志 `[rpc] spawning pi`），`ps` 可见进程存活，但 `readEntries` 仍恒失败——指向 `resolveLiveClient`（`packages/runtime/src/services/plugin-service/api/session-api.ts`：`read.pm.getClient(sessionId)` 空或 `client.exited` 即抛 SESSION_NOT_ACTIVE）与会话↔client 注册链的错配/误标，未定位到具体错配点。
- 重试不自愈的结构原因：重试耗尽后仅「失效/激活信号」可重置预算（scheduleRefresh）；实测激活信号重置后 readEntries 仍失败（非时序窗口问题），故卡死。
- 对照：另一实例上用户开托盘面板时任务列表正常（14:53 实测截图）——该实例 pi 进程在任务触发前后持续存活，读链路通；差异变量 = 冷启动后 mirror 重建路径。

## 影响面

冷启动（或 runtime 重启）后打开有定时任务的历史会话 → 面板不可用（恢复超时文案），任务列表/暂停/删除操作全部不可达；headerAction 时钟按钮仍显示（mirror hidden 保持上次值）但点开即见错误。不影响任务本身触发执行（scheduler 调度在 pi extension 侧，与此读链路无关）。

## 修复方向（待排查立项）

- 排查 `pm.getClient(sessionId)` 对冷启动 spawn 会话的注册键与存活标志（client.exited 是否误标 / 键是否错配）。
- SESSION_NOT_ACTIVE 被 handleReadFailure 归入 recovering（会话 status 非 dead/error 时）的语义是否正确——「无活跃进程」是可自愈态但重试窗口内进程未就绪、进程就绪后又无新信号，两段组合成永久卡死；正常路径修复方向 = 进程就绪信号接入失效刷新族，而非拉长重试窗口。
