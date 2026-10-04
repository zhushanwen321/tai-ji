# remote-use 双壳统一化：保留差异白名单（D9②）

状态：登记生效（随 U20 交付首笔落档；本文件是 remote-use-shell-unification 设计 D9②「真差异白名单」的登记容器——双壳保留差异逐条登记于此，未来新增差异先对照本表分类：真差异（业务含义/变化原因不同）登记保留，假差异（形式语义都同构）收敛）。

设计源：`.tmp/tech-design/remote-use-shell-unification.md` §3.3 D9（防复发 = 双壳共享装配检查 helper + 真差异白名单）。

## 1. 列表状态派生谓词 blockingOverlay 输入：移动恒 false（U20/A14）

- **差异**：core `deriveSessionStatus`（`packages/core/src/domain/session/store.ts`，SessionStatusInputs 参数化输入契约）的 `hasBlockingOverlay` 输入——桌面全量投影（extensionUI store `hasPendingBlockingOverlay`，form/planReview 键，D12 拓宽口径）→ waiting 态；移动壳无 extensionUI store（面板族 Phase 2 裁剪的既定壳形态），输入源不存在，恒缺省 false。
- **语义损失（登记的代价面）**：移动会话列表状态点对「富交互表单/plan 审批 pending」不显 waiting——移动的表单请求呈现是页面级 MobileFormCard（呈现即用户可感知），列表状态点不承载该信号；waiting 态在移动列表仅由 toolCall running 分支达成（A14 裁决的收益面「运行中/流式中可见」不受影响）。
- **判定**：真差异（数据源在移动壳形态下不存在，非漏接——extensionUI 请求通道的移动呈现载体是 MobileFormCard 页面而非状态点），非装配缺口，不补。
- **退役/复审条件**：移动壳若引入 extensionUI 分区（W4/W5 通知体系立项时），该输入按桌面同式接入本谓词，本条随之删除。

## 2. exited 清理形态双壳差异（D5/D9②）

- **差异**：同一防御语义（M8：死会话的残留 dialog/form 请求不重弹、作答不石沉大海）下的两种实现形态——桌面 = `extensionUIStore.clearSession` 单点（`packages/renderer/src/composables/effects/useMessageEffects.ts` exited 回调内具名清理）；移动 = 分通道重置编排（`packages/mobile-renderer/src/bootstrap.ts` onSessionExited：core lifecycle factory 序列 + `resetCompanionChannelsForExitedSession`——dialog `queue.resetFor` + form Map 具名清理）。
- **差异根因**：数据载体不同——桌面 dialog 状态载体是壳侧 pinia store（clearSession 一次清两通道），移动是 ui 共享队列 + 模块级 Map 分区（逐通道具名清理）。清理语义分界（exited = 分通道重置语义，删除 = 注册表销毁语义）见设计 §3.3 D5「exited 清理与拦截解绑」段。
- **判定**：真差异（载体不同清理通路随之不同），不收敛。
- **关联义务（新增请求类通道的双登记）**：移动壳未来新增请求类 per-session 通道状态（dialog/form 同类）时，必须两处各登记一条——① exited 分通道重置编排（漏登记复活 S3：exited 窗口请求静默丢失）；② 删除路径销毁注册表 `registerSessionCleanup`（漏登记复活 M8：已删会话残留请求重弹）。接线单测随通道落地（先例：U6 resetFor 单测）。桌面经 `extensionUIStore.clearSession` 单点覆盖两语义，无此义务。

## 3. sessionEntry 合法缺省成员（D9② × 装配检查 helper 对齐）

- **差异**：SessionEntryPort 的 `cancelActiveFlow` / `preloadFileTree` / `clearUnread` 三成员——桌面全接线（useSidebar），移动壳缺省 no-op（无 new-task flow 取消面 / 文件树 / 未读体系，core use-session 链内 `?? noop` 解析是契约允许形态）。
- **判定**：真差异（移动壳无对应功能面），不补。
- **对齐锚点**：装配检查 helper（`packages/core/src/assembly/assembly-check.ts`）的断言清单 = `ensureStreamSubscription` / `touchRecency` / `evictLru` 三成员（双壳必接，EXEMPT_SESSION_ENTRY_MEMBERS = 本条三成员）；两清单的互斥覆盖由 core 侧契约测试锁死。

## 4. turnExpansionMap 的 LRU 驱逐残留（A15）

- **差异**：LRU 驱逐路径（双壳统一复合入口 `evictLruWithUnsubscribe`——桌面 useSidebar evictLru 已改接同源）不清 turnExpansionMap——驱逐只清消息分区与派生键，不触发 session 级 cleanup 注册表；双壳同样只在删除路径清（删除路径清理已接：`registerSessionCleanup` 注册项随删除一次全清）。
- **量级**：每会话一个 `Set<turnKey>`，可忽略。
- **判定**：真差异（与桌面 useTurnExpansion 既有行为对齐的既定形态），不补。
- **边界**：驱逐路径的另一残留（streamSubscriptions 订阅不随驱逐失效）不登记本清单——已由 D2 驱逐连带退订消除。
- **退役/复审条件**：驱逐路径接入 session 级 cleanup 编排时，本条随之删除。

## 5. 生命周期外三个 effects 回调移动壳不接（D5 去留表）

- **差异**：`onMessageComplete` / `onWorkflowUpdate` / `onSubagentEntries` 三个 InboundEffects 回调——桌面全接（useMessageEffects：完成通知音/角标、workflow 状态投影、subagent entry 抽屉数据），移动壳 effects 装配不含（`packages/mobile-renderer/src/bootstrap.ts` shellEffects，注释明示「本波不接」）。
- **差异根因**：三个回调的消费方移动 v1 均无承载——完成通知音/角标属 W4 通知体系（未立项），workflow 列表与 subagent entry 抽屉属桌面面板族（移动壳 Phase 2 裁剪形态）；无消费方时接线是空转注册。
- **语义损失（登记的代价面）**：移动端轮次完成无提示音/角标、无 workflow 状态与 subagent entry 浏览面——消息主链与 subagent 运行状态行（onSubagents，已接）不受影响。
- **判定**：真差异（消费方在移动壳形态下不存在，非漏接），不补。
- **退役/复审条件**：W4/W5 通知体系立项时按通道接线（onMessageComplete 首个候选），面板族消费方若立项则随 UI 载体逐个接入，接入后删本条对应回调段；全部接入后删本条。

## 6. 取消回填通道恒 text-only：reply.segments 快照移动壳不消费（D7）

- **差异**：`delivery.cancel` reply 携带 `segments` 快照（提交时随 delivery.submit 上行、runtime 按 clientUuid 持有，`packages/shared/src/protocol.ts` 明示「供文本回输入框草稿」）——桌面取消回填走 `restoreToDraft`（`packages/renderer/src/composables/panel/composer-shell.ts`）：空输入分支 `restoreSegments` 整段恢复 text + image/file chip；移动壳 `QueueStrip.requestDraftRestore` 恒走 text-only `composerInjection` 通道，segments 快照被丢弃（文本仍恢复，chip 部分静默丢）。
- **差异根因**：移动 composer 无 chip 呈现载体——`pasteImage` 无 IPC 落盘通路恒文本降级（`MobileComposer.vue`）、`renderIcon` 恒 false，结构性无法消费 segments；与图片粘贴文本降级同因。
- **语义损失（登记的代价面）**：双端同看同一会话时，在手机上取消桌面发出的含 chip 条目，chip 部分不回草稿（文本恢复不受影响）。
- **判定**：真差异（移动壳无 chip 消费方，非漏接），不补。
- **退役/复审条件**：W4 图片粘贴真实化立项（移动 composer 获得 chip 呈现载体）时，回填通道随之接 segments 整段恢复并删本条。
