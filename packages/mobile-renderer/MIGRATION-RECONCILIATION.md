# v1 → v2 老能力映射对账（remote-use-mobile-v2 §7.3 M-1~M-18）

对账时点：u-cleanup（W5，u-activity 后全行为定型态）。每条记录验证方式与结论；
迁移类条目（M-3/M-4/M-7/M-8/M-10/M-16）要求承接锚点在场，缺锚点 = blocked。
路径均相对 `packages/mobile-renderer/src/`；行号为对账时点快照。

| # | v1 能力 | 裁决 | 验证方式 | 结论与 v2 承接锚点 |
|---|--------|------|---------|-------------------|
| M-1 | 会话列表/切换/新建（clientUuid 幂等）/重命名/删除/恢复（session.* RPC 全套） | 迁移 | 代码锚点核对 + 既有单测 | ✅ 列表/切换/未读 = `screens/SessionsScreen.vue`（点入 = markSessionVisited + selectSession + navigateRoute('chat')，dead 同入）；删除二次确认/重命名/重新打开 = `features/SessionActionsSheet.vue`（级联三件走 `shell/sessions-runtime.ts` deleteSessionWithCascade）；新建 = `features/NewTaskSheet.vue:87-124`（clientUuid per-open 黏滞槽幂等原样，提交失败重试复用同键）；恢复三步编排 = core lifecycle factory（bootstrap shellEffects 接线，`views/__tests__/session-list.test.ts` 的编排断言由 `shell/__tests__/app-runtime-sessions.test.ts` + `screens/__tests__/sessions-screen.test.ts` 承接）。单测：sessions-screen 11 + app-runtime-sessions 15 绿 |
| M-2 | 发送/中断（delivery.submit / message.abort） | 迁移 | 代码锚点核对 + 既有单测 | ✅ `features/Composer.vue`：发送 = submitDelivery（clientUuid 幂等两口径，§7.1——每次意图新键 + 失败重发同键）；中断 = `Composer.vue:224` useChatInstance.abort（停止键双形态 v1 承接 + §6.20 动作通知）；compact 经命令面板（CommandSheet）。单测：composer.test 10 + chat-screen.test 16 绿 |
| M-3 | 队列取消/编辑/取全文（delivery.cancel/peek/edit） | 迁移（+resync 重试） | 代码锚点核对 + 既有单测 | ✅ `features/QueueStrip.vue` v2：取消 = `shell/app-runtime.ts:354` cancelDelivery；编辑（D6 锚定 peek）= beginQueueEdit + peekDelivery（app-runtime.ts:363）+ editDelivery（:368）原位替换；failed 重试 = resyncDelivery（:645，复审 F6 移入）；状态机 §6.22 四值（queued × / in-flight 禁 / failed 重试 / delivered 滤除；cancelled 离场为词表结构性不显示）。单测：queue-strip-v2.test 7 绿 |
| M-4 | 表单/planReview 作答 + 断连对账（form 通道 + getPendingRequests reconcile） | 迁移（§6.5） | 代码锚点核对 + 既有单测 | ✅ `features/FormSheet.vue`（form/planReview 节）+ `shell/companion-bridge.ts` form 通道（回传 extension.ui_response 原样）；connected 边沿对账 = `App.vue:189` reconcileFormRequests（connected-reconcile 契约 4 用例绿）；作答回传未送达留层 + 内联错误行（App.vue formRespondFailedId，禁吞）；§6.23 断连不清分区（clearAllFormRequests 退役）+ restart 提交挂起 → onSnapshotReconciled 恢复（runtime-unavailable-form-reset.test 6 用例绿） |
| M-5 | 简单 dialog（CompanionBand，confirm/select/input/editor 四型） | 迁移（§6.5，呈现退役能力保留） | 代码锚点核对 + 既有单测 | ✅ 四型全集对账：`features/dialog-methods.ts:15` DIALOG_METHODS = ['confirm','select','input','editor']（自 ExtensionInteractMethod 派生 + 反向穷举编译锁，禁手写字面量）；呈现 = FormSheet dialog 节（editor 多行预填等宽）；CompanionBand 呈现退役、v1 收起/展开（minimize/restore）能力随单槽 Sheet 形态退役非丢失（spec §4.3 互斥 + sheet-manager 单槽，拖拽关闭取代——u-sheets 登记）；dialog-methods.test + form-sheet.test（四型作答 + 取消回传 result:null）绿 |
| M-6 | 权限审批（PermissionRequestDialog + controller） | 迁移（§6.5） | 代码锚点核对 + 既有单测 | ✅ `features/PermissionSheet.vue`（拒绝在左 destructive）+ `shell/companion-bridge.ts:175` mobilePermissionTransport（controller transport 复用，审批源 plugin.approvePermissions/denyPermissions 原样）；§6.18 降级分支 = protocol sessionId? 恒缺省 → 恒无归属一等分支（全局呈现）；过期信号 plugin:permissionRequestExpired 消费联动收槽。单测：permission-sheet.test 5 + mobile-permission.spec 3 绿 |
| M-7 | 消息撤回（UserBubble 常显按钮 → session.revokeMessage） | 迁移（不得因重写丢失） | 代码锚点核对 + DOM 断言单测 | ✅ `views/MobileMessageStream.vue:70-73` deps.onRevokeMessage → useChatInstance.revokeMessage（单入口路由原样）；UserBubble（@taiji/ui）msg-revoke-button 常显在 density=mobile 保留。DOM 断言：chat-screen.test「msg-revoke-button 常显 + revokeMessage 命中」绿 |
| M-8 | 运行中 bash 停止（abortBash） | 迁移 | 代码锚点核对 + DOM 断言单测 | ✅ `views/MobileMessageStream.vue:67-68` deps.abortBash → useChatInstance.abortBash（ToolRow 停止入口，BashOutputBlock 消费）。DOM 断言：chat-screen.test「bash-cancel-btn 在场 + abortBash 命中」绿 |
| M-9 | hover 族 no-op（editAndResend/onForkAsk/onHandoffAsk/openDrawer/onFileClick，D7 触屏不可见） | 维持现状 | 代码锚点核对 | ✅ `views/MobileMessageStream.vue:76-80` 五成员维持 no-op 原样；F13 重试走独立失败条入口（ChatScreen:114 editAndResend 主路径，V-3 结论），不占 hover 语义 |
| M-10 | 子代理运行行（session.subagents → SubagentStatusLine） | 迁移升级 | 代码锚点核对 + 单测（本单元迁位） | ✅ 升级为两级：运行带 `features/RunBand.vue`（runningSubagentRecordsOf 计数，点击 openSheet('subagentList')）+ `features/SubagentSheet.vue`（列表/详情两态 + 停止 + getSubagentHistory 历史派生）；分区宿主自 v1 SubagentStatusLine.vue 迁 `shell/subagent-records.ts`（写口 applySubagentRecords 仍由 bootstrap effects.onSubagents 直挂，接线位断言保留——subagent-records.test 6 用例）；呈现断言迁 `features/__tests__/run-band.test.ts` 3 用例。消费方 import 随迁：RunBand/ActivityScreen/SessionsScreen/bootstrap |
| M-11 | 命令直发（session.getState command 通道 + SlashBarStub 隐藏占位） | 替换 | 代码锚点核对 + 清退核验 | ✅ SlashBarStub.vue 已删除（stubs/ 目录清空）；CommandSheet 承接 = `features/CommandSheet.vue`（getCommands 主动拉 + requestInjection 插入输入框不直接执行，spec §6.13）；聊天页「更多」入口 = ChatScreen openSheet('command') |
| M-12 | CompanionBand/ErrorBar/断线条三层 | 替换 | 代码锚点核对 + 既有单测 | ✅ 三层 → ①重连条 = App.vue shell-reconnecting-banner（28px 细行，hasConnectedOnce 且非 connect 路由）；②壳级错误条 = views/ErrorBar.vue（v2 保留消费，四驱动链：onSessionError/onGlobalError/notifyNotDelivered/core toast 通道）；③对话流内联条 = FormSheet submit-failed-id 内联错误行 + 出错条重试；④浮层全走 Sheet 体系。CompanionBand/PermissionRequestDialog/MobileFormCard 呈现三件已摘除（App.vue 无挂载） |
| M-13 | mermaid 占位 / 图片粘贴文本降级 / 浮层浏览器降级系统浏览器 | 维持现状 | 代码锚点核对 | ✅ mermaid 占位 = `shell/mermaid-placeholder.ts`（v1 边界原样，MobileMessageStream 消费）；图片粘贴降级 = `features/Composer.vue:55` mobile.pasteImageFallback（v1 键与语义原样）；浮层降级系统浏览器 = Sheet 原语内嵌（无 window.open 新面，v1 边界即 v2 边界，spec §1.2 未扩） |
| M-14 | 端口形状对齐成员（session.archive/deleteByCwd/migrateImage/writeSegments/unsubscribe/subagentAction-message） | 维持现状 | 代码锚点核对（对照基线 8c93d44） | ✅ app-runtime.ts：subagentAction（:66）/ archive（:92）/ migrateImage（:96）/ writeSegments（:136）/ unsubscribe（:218 evictLruWithUnsubscribe）全保留。deleteByCwd：v1 基线 app-runtime 即无直接消费点（`git show 8c93d44e8` 核实），对齐面指 core 端口形状成员，v2 同状维持——无回退 |
| M-15 | LRU 订阅（ensureStreamSubscription/unsubscribe） | 维持现状 | 代码锚点核对 | ✅ `shell/app-runtime.ts:215` ensureStreamSubscription（core 模块级原语 4 参形态）+ :218 evictLruWithUnsubscribe（unsubscribe 通道注入），双壳共接防分叉原样 |
| M-16 | 双语 locale 镜像 + 机器检查测试 | 迁移扩展 | 机器检查测试跑过 | ✅ `__tests__/mobile-locale.test.ts`（zh-CN/en-US key 路径集合完全相等 + 顶层 mobile 命名空间）在全套件绿；键域随各单元扩展（activity/sheet/model/command/subagent/chat/notices/runBand/messageStream/queueStrip/sessions/sessionActions 等段）；本单元清退死键 mobile.subagentStatus 段（唯二消费方 SubagentStatusLine + 其测试已随清退删除，zh/en 双侧同步摘除） |
| M-17 | 装配层/通道单测族（~263 例中非视图部分） | 部分保留 | 套件现存核验 | ✅ 装配/通道族保留适配全绿：connection-profile / connection-view / connected-reconcile / form-protocol / companion-exited-reset / runtime-unavailable-form-reset / mobile-form / mobile-permission / mobile-companion-band / assembly-check / main-bootstrap / token-input-view / app-runtime-delivery-passthrough / app-runtime(.test/.sessions) / shell-boot-three-states / route-state-machine / sheet-manager / use-visual-viewport / settings-screen / chatnotice-injection 等；视图族按 v2 重建（chat-screen/sessions-screen/activity-screen/form-sheet/permission-sheet/queue-strip-v2/composer/run-band 等新测试）；v1 视图绑定测试 12 文件随视图同删 |
| M-18 | pinia 挂载（零 store） | 清理 | 清退核验（本单元执行） | ✅ bootstrap.ts `createPinia()` 挂载与 import 已移除（mount 仅 .use(i18n)）；grep 全 src 零 pinia 消费（companion-bridge/app-runtime 仅注释提及「移动壳无 pinia 业务 store」）；package.json dependencies 移除 pinia + pnpm-lock.yaml 同步 |

## 清退清单（本单元执行）

- 删除视图（8，均无 v2 消费方，删前逐文件 grep 核对）：views/MobileChatHeader.vue、views/MobileComposer.vue、views/MobileFormCard.vue、views/MobileSessionList.vue、views/NewTaskSheet.vue、views/QueueStrip.vue、views/SessionListItem.vue、views/SubagentStatusLine.vue（读口先行迁位 shell/subagent-records.ts）
- 保留 views/（v2 组件树消费中，非「已被 v2 替代」）：views/MobileMessageStream.vue（ChatScreen 消费，M-7/M-8/M-9/M-13 载体）、views/ErrorBar.vue（App.vue 壳级错误条，M-12②）
- 删除 stub：shell/stubs/SlashBarStub.vue（M-11 替换，CommandSheet 承接；stubs/ 目录清空）
- 删除死文件：shell/BottomTabBar.vue（v1 两 tab 底栏，零消费方，仅历史注释提及）
- 删除绑定测试（12）：__tests__/{mobile-chat-header,mobile-composer,mobile-new-task,mobile-queue-strip,mobile-session-list,mobile-session-list-item}.spec.ts + views/__tests__/{mobile-composer,mobile-form-card,new-task-sheet,queue-strip,session-list,subagent-status}.test.ts
- pinia：bootstrap.ts 挂载移除 + package.json 依赖移除 + lock 同步
- i18n 死键：mobile.subagentStatus 段（zh/en 双侧）
- 悬空注释清理：app-runtime.ts（MobileComposer 消费提法 ×3 → Composer）、CommandSheet.vue、ErrorBar.vue、safe-area.spec.ts、mobile-shell.spec.ts、app-runtime-delivery-passthrough.spec.ts、App.vue 与 use-visual-viewport.ts（h-screen 字面提法改写，L0 机器 grep 可判）、assembly-check.test.ts（DOC_MENTION_ALLOWLIST 死条目清理）

## L0 静态清单结果（mobile-renderer/src，grep 全量）

| 检查 | 结果 |
|------|------|
| `fixed inset-0 z-` 手写浮层（Sheet 原语唯一出口） | 0 命中 |
| `h-screen` | 0 命中（TokenInputView 满屏高改 `var(--shell-viewport-h,100dvh)`，§6.16 接管形态对齐 App.vue） |
| `text-neutral-dim` 承载文字 | 0 命中（31 处全部改 `text-neutral-mid`——#949494 压 #242428 ≈ 4.85:1 达标 4.5:1，audit P0「状态/时间文字对比度 3.0:1」随新壳消除；含 4 处 ChevronRight 图标统一改色，L0 保持纯机器 grep 可判） |
