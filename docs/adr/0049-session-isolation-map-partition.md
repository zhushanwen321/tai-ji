# ADR-0049：Session 隔离统一采用 Map 分区派范式

- **Status**: Accepted
- **Date**: 2026-07-21
- **Topic**: `cw-2026-07-21-session-isolation-arch`

## Context

xyz-agent 前端有大量 per-session 状态（聊天消息、ask-user 队列、命令缓存、文件树、widget 缓冲等）。explorer 审查发现 codebase 存在**两套并行的 session 隔离范式**：

### 范式 A：Map 分区派（主流，10+ 处）

状态存 `Map<sessionId, T>`，每个 session 独立分区。
- `stores/chat.ts`：`chatSessions: Map<sessionId, ChatSessionState>`
- `composables/features/useNewTaskFlow.ts`：per-sessionId flow 状态
- `composables/features/useFileTree.ts` / `useSessionDerivations.ts`
- `stores/fileTree.ts` / `workflow.ts` / `command.ts` / `fileSearch.ts`

### 范式 B：watch 清理派（少数，4 处）

单实例状态（ref/let）+ `watch(sessionId)` 切换时清空。
- `composables/useExtensionUI.ts`（**有 bug**）
- `composables/panel/useComposerHistory.ts`
- `composables/features/useSessionEvents.ts`
- `components/panel/SideDrawer.vue`

### Bug 触发

`useExtensionUI.ts` 两套范式都没做到——既没用 Map 分区，`subscribe(sid)` 切换 session 时又没清空 `queue.value`。导致：

1. Panel A 显示 ask-user overlay（session A 有 pending 请求）
2. 用户切到 session B
3. 同一个 Panel 实例的 `props.sessionId` 变为 B
4. `subscribe(B)` 退订了 A 的 WS 订阅，但 `queue.value` 里 A 的 pending 请求残留
5. `currentAskUserRequest = computed(() => queue.value.find(r => r.askUser))` 仍命中 A 的请求
6. **session B 的 Panel 显示了 session A 的 ask-user overlay**

注释甚至写了"per-sessionId 分区"——**注释与实现不符**，代码异味。

## Decision

**所有 per-session 状态的 composable 统一采用 Map 分区派范式。**

具体落地（经 spec_review 修订，CL4/CL5 定稿）：

1. **新建通用 composable 工厂** `useSessionScopedState<T>(sid: Ref<string | null>, init: () => T)`：内部维护 `Map<sessionId, T>`，按 `sid.value` 查对应分区，`init` 为新 session 惰性初始化。提供 `current` computed（当前 sid 的分区）、`update(updater)` 操作当前分区、`cleanup(sid)` 清理指定 session。null sid 时 `current` 返回 `init()` 默认实例但不写入 Map（防 null key 污染）。

2. **useExtensionUI 改用 Map 分区**：`queue` 从实例级 `ref<ExtensionUIRequest[]>` 改为 `Map<sessionId, ExtensionUIRequest[]>`（直接用通用工厂）。`currentAskUserRequest` / `currentDialogRequest` computed 按当前 sid 查分区。

3. **迁移现有 watch 清理派到 Map 分区派**：
   - `useComposerHistory.ts`：`history` 是 computed（天然 per-session，不迁移）；`browsing/index/savedDraft` 三个裸 `let` 收进 `reactive` 对象再经 `useSessionScopedState` 分区
   - `SideDrawer.vue` 的 widget/status 缓冲态（terminalLines/browserLines/unknownWidget/guiWidgetsByTab/statusMap）经 `useSessionScopedState` 分区
   - **`useSessionEvents.ts` 不迁移**（spec_review D3 决策）：它是订阅编排层（管理 events.on/off 退订），不持有 per-session 业务状态，强套 Map 分区是错配

4. **cleanup 接入 session 销毁链路**（spec_review #2 修订）：plan 阶段定义 cleanup 的唯一调用点（session close / panel unmount / session-tree 删除节点候选之一），防止 Map 分区积累已销毁 session 的条目导致内存泄漏。

### 术语澄清（spec_review #8）

- **Map 分区** = 单例 composable 内部 `Map<sessionId, T>`，按 sid 查分区。本次目标范式。
- **实例级隔离** = 每组件实例各自状态（靠组件树天然多实例）。useExtensionUI 现状（脆弱——切 session 时同一实例的状态没清就泄漏）。
- **watch 清理派** = 单实例状态 + `watch(sessionId)` 切换时清空。SideDrawer/useComposerHistory 现状（正确隔离但范式不统一）。

### 防护层（spec_review D4 修订：ESLint 规则放弃）

| 层 | 措施 | 目的 |
|----|------|------|
| 测试 | 补"同实例切换 sessionId"回归测试（split 双 panel 同 sid 分流也覆盖） | 直接防 useExtensionUI 类 bug 再犯 |
| 代码抽象 | `useSessionScopedState` 通用工厂 | 新 composable 用它天然隔离 |
| 文档 | 本 ADR + 更新 AGENTS.md | 记录范式选择 + 反模式 |

~~ESLint 自定义规则~~：spec_review D4 放弃。理由：AST 检测"composable 内 ref/let 是 per-session 还是 UI 局部"铺天盖地误报，检测语义问题非 ESLint 所长。防护靠工厂（结构隔离）+ 测试（回归）+ 文档（范式约束）。

### Code Review Checklist（范式守护，替代 ESLint 规则）

ESLint 规则放弃后，per-session 范式靠 **code-review 强制检查项** 守护。以下检查项纳入 PR review（pr-cr-fix 的 review checklist）与 AGENTS.md §8 范式说明：

新增/修改 composable 时，reviewer **必须逐条确认**：

1. **该 composable 是否持有 per-session 状态？** 判据：存在 `ref`/`let`/`reactive`/`Map`/`Set`，且内容按 `sessionId` 区分（如 `Map<sessionId, T>`、`Set<sessionId>`、或字段语义是「当前 session 的 X」）。
2. **若是，是否用了 `useSessionScopedState` 工厂？** 必须用。禁止：
   - 模块级 `Map<string, T>` / `Set<string>` 手动管理（除非在工厂 init 函数内部）
   - `watch(sessionId)` 手动逐字段清空（watch 清理派反模式，见上）
   - 实例级状态依赖组件树天然隔离（实例级反模式，useExtensionUI 曾因此 bug）
3. **WS handler 是否用 `updateFor(sid, ...)` 而非 `update(...)`？** WS handler 闭包捕获订阅时 sid，须用 `updateFor(capturedSid, ...)` 显式指定分区，不读 `sid.value` 实时值（防 session 切换退订异步期间的竞态，M1 修复）。
4. **session 销毁时分区是否 cleanup？** 正常路径由 `useSidebar.deleteSession` → `triggerSessionCleanups(id)` 自动触发（工厂 setup 时自动注册，scope dispose 时反注册）。若 composable 有特殊生命周期，确认 cleanup 已挂钩。

#### 覆盖边界：含持 sessionId prop 的组件（2026-08-24 扩，context-consistency G3）

上述 checklist 的措辞是「新增/修改 composable 时」，但**组件在实例 ref 里持有 session 级状态同样是本 ADR 的覆盖对象**——生命周期错位与 composable 同构：组件实例生命周期 ≠ session 生命周期，sessionId prop 变化只触发重订阅（`useSessionEvents` 的 watch 重订），不触发 remount，实例 ref 跨 session 存活、切走被别的 session 帧合法覆盖、切回无人重喂（`ContextCapacityPopover` 的 `stats` ref 实证，详见 `docs/todo/context-consistency-design.md` §2.2 层 3——已删除，git 可追溯），故不另立范式。自本修订起：

- **reviewer 按上述 checklist 检查的范围 = composable + 持 sessionId prop 的组件**：四条判据对组件同样适用（组件内 `ref`/`let` 持有「当前 session 的 X」即命中第 1 条；整改方向 = 状态上移到经 `useSessionScopedState` 分区的 composable、组件纯读——`useContextUsage` 范式，设计文档 D2）。
- 检查触发场景与判定口径沿用约束 C-state-08「session 级 renderer 状态三问」：新增 `ServerMessageType` 的 renderer 消费方 / 新增 `useSessionEvents` 调用点时必查**存哪里（分区 store/composable）？切走谁清（cleanup 编排）？切回谁喂（恢复腿）？**——三问都有明确归属才放行。
- 机器防线 = taste-lint 规则 `no-instance-level-session-state`（error 级，pre-commit 拦截，注册于 `taste-lint/base.mjs`）：只检测收窄反模式「onMessage handler 直写组件实例级 ref」（检测模式与误报面详见 `docs/todo/context-consistency-lint-rule.md`——已删除，git 可追溯；权威口径以 `taste-lint/base.mjs` 规则实现与测试为准）。与上文 D4 放弃的 ESLint 规则不矛盾——D4 放弃的是「AST 判定 ref/let 是否 per-session 语义」的全量检测（铺天盖地误报），本规则收窄到可静态判定的写入形状。

### 例外清单（显式审批记录）

以下 composable **经审批**不采用 `useSessionScopedState` 工厂，记录原因供 review 参考：

| composable | 原因 | 审批
|-----------|------|------
| `useSessionEvents.ts` | 订阅编排层，不持有 per-session 业务状态（registrations 是 handler 路由表，随实例销毁清） | spec_review D3
| `useSessionScopedState` 自身 | 工厂实现，不能自引用 | —

#### 全局 sid 协调器例外类（模块级 Map 合理）

以下模块持有 per-session 状态但采用**模块级单例 Map**，不套 `useSessionScopedState`。判据：它们是「全局 sid 协调器 / 纯函数模块」（无 Vue setup 上下文、无 sidRef 绑定实例的模块级单例）——所有方法显式接收 sessionId 参数（或经绑定查询拿 sid），存的是**非 reactive 数据**（unsub 函数 / 时序戳 / 路由标记），与 per-instance composable（有 sidRef + reactive 容器契约）属不同层。`useSessionScopedState` 要求 sidRef + per-instance reactive 容器，强套会破坏消费者签名 + 语义错位（w4 retrospect 教训 #3：handoff 范式要求需结合代码所在层判断适用性）。

| 模块 | 模块级状态 | 原因 | 审批
|-----|----------|------|------
| `core/domain/chat/useChat.ts` | `streamSubscriptions` / `historyTruncatedSessions` | 全局 sid 协调器（无 sidRef，记录非 reactive 的 unsub 函数）；session 销毁由 `disposeSession` + `triggerSessionCleanups` 编排 | w5 clarify Q1/TD2
| `core/coordination/subscription-state.ts` | `subscriptionStates` | WS 订阅状态（数据完整性层），`routeInbound` 在配置闭包需同步访问；非 per-instance UI 状态（UI 经 events 通道消费，不直接读 lastSeenSeq） | 原实现既定设计（slice TO3）
| `renderer/composables/effects/useForkNoticeEffect.ts` | `feedMap` | 全局 feed SSOT（多 MessageStream 实例共读），各方法显式接收 sessionId，无 sidRef；同 useChat 模式（u16 收敛后分支追踪态 `unreadByBranch` 单例移至 `features/fork-handoff/useForkBranchNotify.ts`，同此例外） | 对齐 useChat w5 clarify
| `core/domain/chat/lru.ts` | `sessionLastAccessed` | 纯函数模块（`touchLru`/`evictIfNeeded`/`evictSessionWithVirtual`/`disposeLruEntry` 独立导出，非 composable，无 setup/sidRef）；Map 存时序戳（number，非 reactive）；清理走 `disposeLruEntry(sid)` 由 `disposeSession` 编排（R5）+ 测试 `_resetLruForTest()` | renderer 重做审查
| `core/domain/drawer/coordination.ts` | `pendingOpenMap` | 纯函数模块（`setPendingOpenForSid`/`consumePendingOpen`/`openTasksDrawerOnFirstData` 独立导出，非 composable，无 setup/sidRef）；Map 存 boolean 路由标记（非 reactive）；清理走 `registerSessionCleanup` 挂载（见文件尾）+ 测试 `_resetDrawerForTest()` | renderer 重做审查
| `core/domain/session/effects/panel-orchestration.ts` | `pendingOpenMap` | 纯函数模块（`openPanelOnSessionEvent`/`consumePendingOpen`/`clearPendingOpen` 独立导出，非 composable，无 setup/sidRef）；Map 存临时路由标记（`'tasks'`\|`'sideDrawer'`，存在即消费、随 `consumePendingOpen` 即删、不跨 session 存活，非 reactive）；清理走 `clearPendingOpen(sid)` 由 `use-session.ts` `cleanupSessionState` 编排（ES3）| renderer 重做审查

#### 模块级分区 + reactive 容器混合例外（useTerminal，W27 终端）

`useTerminal` 命中「全局 sid 协调器例外类」的模块级形态（无 Vue setup 上下文、方法显式接收 sessionId），但分区容器含 **reactive 字段**（ptyAlive/cols/rows 需响应式驱动模板），不满足该类「存非 reactive 数据」的完整判据——作为混合形态单独登记：

| 模块 | 模块级状态 | 偏离点 | 理由 | 审批
|------|-----------|--------|------|------
| `renderer/composables/features/terminal/useTerminal.ts` | `partitions`（`Map<string, TerminalPartition>`）/ `subscribedSids` / `subscriptionUnsubs` / `flushListeners` | 模块级单例 Map（例外类形态），但分区容器是 reactive（视图字段 ptyAlive/cols/rows 需响应式），非纯非响应式数据 | ① R-22（perf plan `.xyz-harness/2026-08-15-perf/plan.md`）「buffer 存组件外」——切 tab（TerminalView `v-else-if` unmount/remount）历史完整要求分区跨组件生命周期存活，`useSessionScopedState` 是 setup-scoped 工厂（onScopeDispose 反注册 cleanup，组件销毁即分区销毁），结构上无法满足；② buffer/outputQueue 用 `markRaw` 包裹非响应式（高频 push 零 reactivity 开销），reactive 字段仅限低频视图状态；③ 方法显式接收 sessionId（appendChunk/updatePartition/clearPartition），WS handler 走 updateFor 语义；④ cleanup 经 `registerSessionCleanup` 挂载（useSidebar.deleteSession → triggerSessionCleanups → 删分区 + 退订 + 清监听器），内存语义与工厂一致 | W27 对抗式审查 Fix-1（2026-08-16）

#### Pinia defineStore 单例 factory 例外类（factory 体内 Map 合理）

以下模块的 per-session Map 声明在 **factory 函数体内**（非模块级），单例性来自调用方——factory 经 Pinia defineStore 按 id 缓存包装，factory body 全应用只执行一次，Map 实质单例。判据：factory 体内非 Vue setup 上下文、无 sidRef: Ref<string|null>；Map 存非 reactive 数据（timer handle / plain object queue state）。与上一小节「全局 sid 协调器例外类」同属 ADR-0049 例外，区别仅在单例性来源（ES module 单例 vs Pinia defineStore factory 单例）。`useSessionScopedState` 是 setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory 体内不适用——强套需把 factory 改造成 setup composable（破坏 Pinia store 单例语义：每次 useStore() 重新执行会重建 Map 丢失单例）+ reactive 容器语义错位（timer handle / queue state 不是响应式状态）。延伸自「renderer 重做审查」延伸项 3——与 c6af1b9 登记的模块级 Map 例外同批判定，仅因当时不在 w4 范围而推迟登记。

| 模块 | factory | Map 变量 | 数据类型 | session 销毁清理 | 审批
|-----|---------|---------|---------|----------------|------
| `core/domain/chat/timers.ts` | `initTimers()`（由 createChatStore setup 调用） | `streamingTimers` / `bashTimers` | timer handle（`ReturnType<typeof setTimeout>`，非 reactive） | `disposeAllTimers()` 由 createChatStore `onScopeDispose` 编排调用（store.ts） | renderer 重做审查 延伸项3
| `core/domain/chat/handoff.ts` | `createHandoffController()`（由 createChatStore setup 调用） | `handingOffTimers` | timer handle（非 reactive） | `clearHandingOffTimer(sid)`（per-session）/ `clearAllTimers()`（全量）由 createChatStore `onScopeDispose` 编排调用（store.ts） | renderer 重做审查 延伸项3
| `core/domain/chat/store.ts` | `createChatStore()`（renderer `defineStore('chat')` 包装） | `pendingSendTimers` | timer handle（非 reactive） | 本文件 `onScopeDispose`（for + clearTimeout + clear） | renderer 重做审查 延伸项3
| `core/domain/drawer/terminal-write-queue.ts` | `createTerminalWriteQueue()`（renderer `defineStore('terminal-write-queue')` 包装；core 是纯 TS 工厂，不 import vue/pinia） | `sessions` | `TerminalSessionState` plain object（`{ ptyAlive, pendingWrites }`，非 reactive，core 零 reactivity 依赖） | `removeSession(sid)`（per-session，session 销毁编排点调） | renderer 重做审查 延伸项3

#### 分区容器形态例外（工厂内 shallowRef 替代 reactive 容器）

`useSessionScopedState` 的标准契约要求 init 工厂返回 **reactive 容器**（plain object mutate 不触发下游 computed）。以下消费方经工厂分区（Map 分区语义完全遵守），但分区值是 `shallowRef` 包裹的 mutable 对象，属容器形态例外：

| 消费方 | 分区值 | 偏离点 | 理由 | 审批
|-------|--------|--------|------|------
| `renderer/components/panel/MessageStream.vue`（TurnRenderCache，W21 D-4） | `shallowRef<TurnRenderCache>`（mutable 纯派生缓存，`toRenderItemsIncremental` 原地 mutate 更新） | 非 reactive 容器：cache mutate 不触发任何下游 | ① 缓存持有 `cachedItems`/`turnSignatures` 里的 **Message 引用**——深代理（reactive）会破坏 D-1 不可变身份语义（引用比较失效，增量复用键失真）且成本高；② 失效本就不由 cache mutate 驱动——`renderItems` 的响应式依赖是 `currentMessages`（shallowRef 源数组）+ `forceWorking`，cache 只是纯派生载体（可随时丢弃重建，无 drift 风险）；③ 工厂消费方式是「读当前分区 `.value` 后传值给纯函数」，非响应式读取分区内部字段 | perf plan W21 M-2 裁决（`.xyz-harness/2026-08-15-perf/plan.md`）

> 新增例外须在此表登记 + 说明理由，否则 review 不通过。

## Alternatives Considered

### 替代方案：watch 清理派（单实例状态 + watch 切换清空）

被否决。理由：
- **脆弱模式**：依赖开发者记得在 `watch(sessionId)` 回调里清空**所有**状态字段。新加字段忘了清，就泄漏。useExtensionUI 的 bug 正是这个模式失效的实例。
- **切 session 数据丢失**：切走再切回，状态丢失（除非从 runtime 重新拉，多一次 RPC）。
- **与 codebase 主流不一致**：10+ 处用 Map 分区，4 处用 watch 清理，应统一到主流。

### 替代方案：不抽象通用工厂，各 composable 各自实现 Map 分区

被否决。理由：
- **重复代码**：每个 composable 都要写一遍 Map 管理 + watch + cleanup 逻辑。
- **不防复发**：新 composable 作者还是要自己知道用 Map 分区，没从结构上强制。

## Consequences

### 正面

- **范式统一**：所有 per-session composable 遵循同一模式，降低认知负担。
- **消除 bug 根因**：Map 分区下，切 session 天然切分区，不存在"忘清空"的失误可能。
- **切 session 不丢数据**：切走再切回，状态自然恢复（如 ask-user pending overlay 重新出现）。
- **从结构上防复发**：新 composable 用 `useSessionScopedState` 工厂天然隔离；ESLint 规则检测违规。
- **与 codebase 主流一致**：10+ 处 Map 分区派的模式得到强化和抽象。

### 负面

- **改动面较大**：新建工厂 + 改 useExtensionUI + 迁移 3 个现有 composable + ESLint 规则。多 Wave 工程。
- **回归风险**：SideDrawer 的 widget 缓冲态迁移涉及多个状态字段（terminalLines/browserLines/unknownWidget/guiWidgetsByTab/statusMap），需充分测试。
- **内存管理**：Map 分区不会自动释放，需在 session 销毁时显式 cleanup（否则内存泄漏）。通用工厂需提供 cleanup 接口 + 在合适的生命周期调用。

## Open Questions（spec_review 后的残留）

1. ~~`useSessionEvents.ts` 是否真要迁移~~ → **已决（D3）：不迁移**
2. ~~ESLint 规则的检测精度~~ → **已决（D4）：放弃 ESLint 规则**
3. **session 销毁时机（何时调 cleanup）** —— 留待 plan 阶段定义调用点 deliverable（FR-4 约束）
4. ~~SideDrawer 切 sid 时缓冲清空时序与 useSessionEvents 退订时序的竞态（AC-4 约束）~~ → **已修复**：useSessionEvents 把订阅时 sid 传给 handler（`(msg, sid) => void`），SideDrawer handler 调 `drawerState.updateFor(sid, ...)` 写「消息所属 sid」分区。从结构上消除竞态（非时序依赖）。commit bf1fffc + 19ea684f。

## Addendum：M1/M2 竞态修复（post-review）

review 阶段发现 M1 竞态（切 sid 的 WS 消息写入）+ M2 测试假绿，曾作为 known risk 留后续。后补充修复（commit 49b2e577 + bf1fffc + 19ea684f）：

- **useSessionScopedState 工厂加 `updateFor(targetSid, updater)`**：显式指定分区，不读 `sid.value` 实时值
- **useExtensionUI handler**（onUIRequest/onUITimeout/getPendingRequests）闭包捕获 subscribe 参数 sid，调 `updateFor(sid, ...)`
- **useSessionEvents 接口扩展**：`onMessage` handler 签名加第二参数 sid（订阅时捕获），分发时透传。其他消费者（useGitStatus/CommandPopover/ContextCapacityPopover）handler 参数更少，TS 允许赋值，无需改
- **SideDrawer handler** 加 sid 参数，调 `drawerState.updateFor(sid, ...)`
- **SideDrawer.test.ts mock** 从 `sidRef.value` 实时匹配改为注册时 sid 快照，对齐真实 useSessionEvents 行为。M2 假绿确证已修（临时验证脚本确认 handler 被真触发）

核心思路：**隔离靠结构（handler 捕获订阅时 sid + updateFor 显式分区），不靠时序（watch flush 退订）**。即使 flush:pre 异步退订窗口内有旧 sid 迟到消息，也只写旧 sid 分区。

## References

- explorer 审查报告（topic `cw-2026-07-21-session-isolation-arch` 的 clarify 记录）
- Bug 首现 commit：`892ca6ba` "fix: cache pending ask-user requests for session switch recovery"（引入 queue 缓存但未分区）
- 现有 Map 分区范例：`packages/renderer/src/stores/chat.ts`
- 现有 watch 清理范例（正确隔离）：`packages/renderer/src/components/panel/SideDrawer.vue`
