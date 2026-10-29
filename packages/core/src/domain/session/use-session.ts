/**
 * createUseSession —— session 管理编排（IF4，w3，core 平台无关）。
 *
 * [归位] 迁自 renderer composables/features/useSidebar.ts（570 行）的 session 管理编排部分
 * （selectSession/newSession/renameSession/deleteSession/deleteFolder/loadSessions/
 * retryHistory/syncSessionToPanel + focusedSessionId/focusedSession）。原样迁移 + deps 注入：
 * 后端调用经 SessionApiPort（w2）、panel 编排经 PanelOrchestrationPort（w2 + w3 追加
 * activePanelId/findPanelBySession）、历史回填经 ChatHydratePort、导航经 NavigationPort、
 * 跨 store 清理经 SessionCleanupHooks（DM2；[U7] overlay 相关 hook 已移除）、
 * 新建任务流程经 NewTaskFlowPort（可选，C-W3-2）。core 不 import @/api / @/stores / @/composables。
 *
 * 保留契约：
 * - deleteSession 是「session 销毁唯一编排点」——triggerSessionCleanups(id)（ADR-0049 AC-8）
 *   只经 deleteSession/deleteFolder/archiveSession 触发（归档 = 前端侧退场，清理同族，
 *   session-archive 设计 D14），跨 store 分区释放全在 cleanupSessionState 内按 S3 顺序执行
 *
 * [P4 s5 drawer-widget-removal] selectSession 内 consumePendingOpen / cleanupSessionState 内
 * clearPendingOpen 已删除：pendingOpen 路由机制随 tasks 域移除（PluginViewContainer 承接）。
 *
 * [renderer-deepening D3/D4] 原 w5 壳组合项（ensureStreamSubscription / chat.touchLru /
 * evictIfNeeded / clearUnread / fileTree 预加载 / flow.cancelFlow，原 C-W3-4「壳补齐时序」
 * 立场）已升级为 sessionEntry 端口束（SessionEntryPort，api-port.ts）注入 selectSession
 * 完整 13 步切入链——链本体在本文件单点编排（唯一载体），原三份实现（core/壳新/壳旧）的
 * 时序漂移由此收敛。时序采壳版 panel-first（D4 行为纠正：panel/navigation 先于 hydrate）。
 *
 * 命名说明：IF4 字面签名写 useSession；core 内 factory 统一 create* 前缀
 * （createSessionStore/createChatStore/createUseChat 先例），故命名 createUseSession。
 */
import { computed, onScopeDispose } from 'vue'
import type { BatchDeleteResult, Message, ServerMessageMap, SessionGroup, SessionSummary } from '@taiji/shared'
import { triggerSessionCleanups } from '../../foundation/use-session-scoped-state'
// [W2 权威拉取与冷读] 状态层契约（读口 liveStateOf + 唯一写口 applyLiveState）。core 侧
// 拉取对账经此把 session.getState 的 reply 落进状态层——与状态消息（state_changed /
// thinkingLevelSet）、操作回执（applySwitchReceipt）走**同一个** applyLiveState reducer
// （设计 §7 验收项 8「三源经同一 reducer 合并」）。
import type { SessionLiveStateStore } from './live-state.js'
// [u4d] getHistory 响应 → 截断窗口状态归一（SSOT 在 domain/chat/truncated-window）；
// [D6-⑨ 缺陷#2] toolResult 图片落盘编排（hydrate 通路统一收敛，见 reconcileFromReply）。
// session→chat 单向依赖（chat 域不 import session 域，无环；truncated-window 同先例）；
// AC10：跨域经 '@taiji/core/domain/chat' 公开 index API 消费（self-reference）。
import { historyWindowFromReply } from '@taiji/core/domain/chat'
import { collectImagesFromMessages, persistImagesNewestFirst } from '@taiji/core/domain/chat'
import type { SessionApiPort, PanelOrchestrationPort, SessionEntryPort } from './api-port'
import type { createSessionStore } from './store'
import { toErrorMessage } from '../../utils/error-message'

/**
 * 导航端口（壳注入 useNavigationStore().push 适配）。
 * core 只 push chat 路由（view:'chat' + sessionId），view 类型收窄为 string 保持平台无关。
 */
export interface NavigationPort {
  push(route: NavigationRoute): void
}

/** core 侧导航路由最小结构（壳适配 NavEntry：view 映射 + sessionId 透传） */
export interface NavigationRoute {
  view: string
  sessionId?: string | null
}

/**
 * chat 域历史回填端口（selectSession/retryHistory 的 hydrate 经此注入，壳适配
 * useChat()：isHydrated/hydrate/markHistoryFailed 等映射 chat store。
 * [P4 s5 w2] hydrateTasksFromMessages 随 tasks 域删除（原映射 tasks.hydrateFromMessages
 * 关键规则 9 持久化链路——tasks store 已删，goal/todo 快照渲染走 GuiComponentRenderer 历史消息）。
 */
export interface ChatHydratePort {
  /**
   * 拉取 session 历史（session.history RPC；u4b 双预算窗口可能截断）。
   * [u6] 窗口契约字段必填（legacy historyTruncated 退役，偏差表 D7 双轨收敛），
   * 经 historyWindowFromReply 归一后随 reconcileHistory 写入 chat store 截断窗口状态。
   */
  getHistory(sessionId: string): Promise<{
    messages: Message[]
    truncated: boolean
    loadedTurns: number
    totalTurnsEstimate: number
    /** [U8 重启中断标记] 可选，true = 离线读取判定文件尾部为中断形态 */
    interrupted?: boolean
  }>
  /** 该 session 是否已 hydrate（幂等检查：已回填不重复拉取） */
  isHydrated(sessionId: string): boolean
  /** 注入历史消息（chat store hydrate） */
  hydrate(sessionId: string, messages: Message[]): void
  /**
   * 切入 reconcile：entry 历史为基线 + 分区尾部 streaming 实体保留（后台 session 切入刷新，
   * 防 pi entries 不含进行中消息导致的 delta 断链——见 chat store reconcileHistory 注释）。
   * [u4d] window（可选）随刷新写入截断窗口状态——truncated 必须与分区当前内容同步
   * （窗口响应把分区截回尾窗时 truncated=true，「加载更早」顶部条重显）。
   * [U8] interrupted 可选随 window 透传（离线判定的中断形态标记，渲染尾部提示条依据）。
   */
  reconcileHistory(sessionId: string, messages: Message[], window?: { truncated: boolean; loadedTurns: number; totalTurnsEstimate: number; interrupted?: boolean }): void
  /** 清历史加载失败态（retryHistory 先清再拉） */
  clearHistoryError(sessionId: string): void
  /** 标记历史加载失败（landing 显重试出口，不永久卡住） */
  markHistoryFailed(sessionId: string): void
  /**
   * [session-cold-switch-perf §3.3-3] historyCacheReady 通知编排的 chat store 读写子端口
   * （后台全量重建失败态 + 快照版本对账，SSOT 在 chat store 分区）。可选成员：壳未注入
   * （headless / mock 装配）时通知编排的相关分支跳过——重拉/失败收敛由下一次 getHistory
   * 拉取自然承接（ADR-0097 拉为主推补充）。
   */
  historyCache?: {
    /** 后台全量重建失败（historyCacheReady 失败帧）→「加载更早」收敛失败重试入口 */
    markCacheFailed(sessionId: string): void
    /** 清除后台重建失败态（该会话任一次 history 拉取成功收敛） */
    clearCacheFailed(sessionId: string): void
    /**
     * 快照版本对账：分区尾消息的文件侧身份 === snapshotLeafId（true = 重建期间无新追加，
     * 重拉安全；false = 过期/未 hydrate，不重拉由尾部保护段衔接）。
     */
    isSnapshotFresh(sessionId: string, snapshotLeafId: string): boolean
  }
}

/**
 * 跨 store 清理钩子集（DM2 + w3 追加）。deleteSession/deleteFolder 的 cleanupSessionState
 * 按 S3 顺序逐一调用；壳把 renderer 各 store 的清理方法包装传入，core 零跨包 import。
 *
 * [HISTORICAL] clearBoundPanelOverlays + clearSubagentTombstones 已随 U7 overlay 移除从接口删除
 * （overlay viewing 状态机 + tombstone 防复活均为 overlay 全屏替换模式产物，drawer tab 化后无用）。
 * 映射关系（renderer cleanupSessionState 原序）：
 * - clearFileTree → useFileTreeStore().clearSession（[P4 s5 w2] clearTasks 随 tasks 域删除）
 * - clearSubagent → subagentStore.clearSession；clearWorkflow → workflowStore.clearSession
 * - clearExtensionUI → extensionUIStore.clearSession
 * - clearExtensionHost → 壳层 bus.emit({kind:'session-destroyed', sessionId})——extension-host 的
 *   ViewHostStore/OverlayLifecycle 两处 createSessionScopedMap 分区不注册
 *   triggerSessionCleanups（那是 useSessionScopedState 机制），唯一清理路径是 bus 事件，
 *   而该事件零生产者（M1-03）：必须由本编排点经 hook 显式触发
 * - evictChat → chatStore.evictSessionWithVirtual（须先于 disposeChat，D5 时序）
 * - [U7 已删] clearSubagentTombstones（overlay tombstone，随 overlay 移除）
 * - evictVirtualKeys → workflowStore.getAgentCallVirtualIdsByMain + chatStore.evictVirtualKey
 * - clearAgentCallMapping → workflowStore.clearAgentCallMapping
 * - disposeChat → useChat().disposeSession；invalidateStatus → invalidateStatusCache
 * - browserDestroy → 壳层 lib/ipc browserDestroy(sid)（.catch 消化 rejection；B4，2026-09-14 内存审计）
 * - clearTerminalQueue → 壳层 useTerminalWriteQueueStore().removeSession（G1，可选）
 * - clearSlashCommands → 壳层 useCommandStore().clearCommands（G1，可选）
 * - clearForkNotices → 壳层 useForkNoticeFeed().clearSession（G1，可选）
 */
export interface SessionCleanupHooks {
  clearFileTree(sid: string): void
  clearSubagent(sid: string): void
  clearWorkflow(sid: string): void
  clearExtensionUI(sid: string): void
  /** extension-host per-session 分区清理（M1-03）：壳层实现 emit session-destroyed 到 InternalEventBus，
   *  触发 ViewHostStore/OverlayLifecycle 的 scoped map cleanup */
  clearExtensionHost(sid: string): void
  /** chat.evictSessionWithVirtual：先按 mainSid 前缀扫 subagent 虚拟 key，再 dispose 主 session */
  evictChat(sid: string): void
  /** agentcall 两段式无 mainSid 前缀，经 workflow 映射清全部 agentcall virtualId */
  evictVirtualKeys(sid: string): void
  clearAgentCallMapping(sid: string): void
  disposeChat(sid: string): void
  invalidateStatus(sid: string): void
  /**
   * [B4 / 2026-09-14 内存审计 §2.1] 销毁该 session 的 main 侧 WebContentsView
   * （browserDestroy IPC）。此前 browserDestroy 是全仓零调用死 API——已删 session 的 view
   * （独立 Chromium 渲染进程，重页面百 MB 级）驻留至 LRU 挤出/app 退出。目标面（browser
   * drawer）生产入口休眠中，本 hook 是接线预备 + 堵「同 id 复活脏旧页面」洞（create 幂等
   * 复用旧 entry）。实现必须 best-effort：IPC rejection 显式 .catch 消化（preload invoke
   * 透传 rejection，不 catch 会成 unhandledrejection 上报 error-reporter）。
   */
  browserDestroy(sid: string): void
  /**
   * [G1 / 2026-09-14 内存审计 §3.4] 以下三项为「死清理 API 接线组」可选 hook（旧实现零破坏）。
   * 三个清理函数此前实现完整但全仓零调用——terminal-write-queue.removeSession /
   * command-store.clearCommands / useForkNoticeFeed.clearSession——删除 session 后各自的
   * per-session Map 分区（≤100 条待写命令 / slash 命令历史 / transient fork 通知）永久残留。
   * 设计形态：可选成员 + 编排点 ?. 调用（壳接线后生效，headless/测试夹具不注入即跳过）；
   * 三者均为同步内存操作，无可消化 rejection 面（区别于 browserDestroy 的 IPC .catch 契约）。
   */
  /** terminal 写队列 sessions 分区释放（含 ≤100 条待写命令） */
  clearTerminalQueue?(sid: string): void
  /** slash 命令历史分区（commandsBySession）释放 */
  clearSlashCommands?(sid: string): void
  /** fork 通知 transient feed 分区（feedMap）释放 */
  clearForkNotices?(sid: string): void
  /**
   * workflow-viz overlay 关闭（workflow-visualization U6/D11⑤ 可选 hook）：删除的
   * session 是 overlay 当前发起 session 时关 overlay（overlay 全局单例、绑定发起 pane
   * 的 session）。事件流缓存与活跃锚的数据范围清理由 clearWorkflow（store.clearSession）
   * 承担，本 hook 只做 UI 关闭编排。
   */
  closeWorkflowOverlay?(sid: string): void
  /**
   * [W1 会话架构四层分离] 状态层条目释放（可选 hook：**会话删除**是唯一清退时机——设计
   * §2.4 I3「状态条目生命周期独立于列表，只有会话删除才移除」）。
   * 只挂 deleteSession / deleteFolder（真删除）；**归档不挂**（归档是前端退场，恢复后状态
   * 仍在——设计 §7 验收项 3 明确归档后已缓存状态保留），也不随列表刷新/过滤触发。
   */
  clearLiveState?(sid: string): void
}

/**
 * 新建任务流程端口（C-W3-2；可选，壳未接线时 newSession 返回 null 降级）。
 * 壳适配 useNewTaskFlow（workspaceStore.defaultCwd 兜底留在壳适配层）；
 * FR5 new-task-search 域迁移后换 create-session-flow 原语，端口签名不变。
 */
export interface NewTaskFlowPort {
  /** 启动新建任务流程（延迟 create：startFlow 本身不建 session） */
  startFlow(presetCwd?: string): Promise<void>
  /** 当前流程产出的 session（null = 未创建，延迟 create 路径） */
  currentSession(): SessionSummary | null
}

/** createUseSession factory 的依赖注入接口（IF4 deps + w3 演进项） */
export interface UseSessionDeps {
  /** session 列表 store（w1 交付的纯 factory 实例，壳显式持有） */
  store: ReturnType<typeof createSessionStore>
  /** session 后端唯一通道（w2 SessionApiPort） */
  api: SessionApiPort
  /** panel 编排（w2 PanelOrchestrationPort + w3 追加 activePanelId/findPanelBySession） */
  panel: PanelOrchestrationPort
  /** 导航（壳注入 useNavigationStore().push 适配） */
  navigation: NavigationPort
  /** chat 历史回填（壳注入 useChat + tasks 适配） */
  chat: ChatHydratePort
  /** 跨 store 清理钩子（DM2 + B4 browserDestroy 必选 11 项 + 可选 4 项 = G1 3 项 + workflow-viz overlay 1 项） */
  hooks: SessionCleanupHooks
  /** 新建任务流程（可选；缺省时 newSession 返回 null——壳未接线状态，w5 必须接线） */
  flow?: NewTaskFlowPort
  /**
   * wasActive 回退路径的壳版 selectSession（可选，C-W5-1 债务清偿）。
   * deleteSession/deleteFolder 删 active 后回退 list[0] 时优先走本端口——壳（useSidebar）
   * 注入含 renderer 时序（ensureStreamSubscription 须先于 panel 载入，2026-07-29 handoff
   * 回复丢失事故）的 selectSession；缺省走 core headless selectSession（headless/mobile 形态）。
   */
  selectSessionFallback?: (id: string) => Promise<void>
  /**
   * sessionEntry 端口束（可选，D3）：切入链的跨域步骤（flow 取消/未读/流订阅/LRU/文件树）。
   * 成员级可选、缺省 no-op——headless 路径零新增步骤执行完整链，时序按 D4 统一链。
   */
  sessionEntry?: SessionEntryPort
  /**
   * [W2 权威拉取与冷读] 会话运行时状态层（按会话 id 寄存；唯一写口 applyLiveState）。
   *
   * 拉取对账（打开视图 / 重连）的落点：`session.getState` 的 reply 经 applyLiveState
   * 写状态层，与状态消息、操作回执共用同一 reducer（设计 §7 验收项 8）。可选成员：
   * 未注入（headless / 旧装配）时 refreshLiveState 整体跳过——不写任何容器。
   */
  liveState?: SessionLiveStateStore
}

// ── session.list server-push 订阅（#7 方案 A；listener 防重复注册）──
// useSidebar 被 5+ 组件实例化（Sidebar/Turn/AppShell/PanelContainer/Workspace），
// 若每实例各注册一次 onGlobalType，每次广播会触发 N 次相同整表快照应用（事件处理翻倍）。
// 模块级 refCount：首个实例注册，末个实例卸载时取消，中间实例共享同一监听。
let sessionListSubCount = 0
let sessionListUnsub: (() => void) | null = null

function bindSessionListBroadcast(
  api: SessionApiPort,
  applyListSnapshot: (groups: SessionGroup[]) => void,
): void {
  sessionListSubCount += 1
  if (sessionListSubCount === 1) {
    sessionListUnsub = api.onConfigSessions((groups) => applyListSnapshot(groups))
  }
}

function unbindSessionListBroadcast(): void {
  sessionListSubCount = Math.max(0, sessionListSubCount - 1)
  if (sessionListSubCount === 0 && sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
}

/** 测试隔离：重置模块级订阅计数（与 resetChatModuleStateForTest 同模式，beforeEach 调）。 */
export function resetSessionListSubForTest(): void {
  if (sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
  sessionListSubCount = 0
}

// ── session.historyCacheReady 通知订阅（session-cold-switch-perf §3.3-3；refCount 单飞）──
// 与上方 session.list 订阅同构：useSidebar 被 6+ 组件实例化，factory 每实例注册一次会
// 重复消费通知（重拉 ×N）。模块级 refCount：首个实例注册，末个实例卸载时取消。
// 消费通道 = crossSession（帧带 sessionId，ROUTE_TABLE 'session.historyCacheReady' 条目
// 声明），handler 只该有一份（全局单消费面）——非活跃会话/btw 线分区的帧在编排内按
// activeId 匹配判定静默忽略。
let historyCacheSubCount = 0
let historyCacheUnsub: (() => void) | null = null

function bindHistoryCacheReady(
  api: SessionApiPort,
  handle: (sessionId: string, payload: ServerMessageMap['session.historyCacheReady']) => void,
): void {
  historyCacheSubCount += 1
  if (historyCacheSubCount === 1 && api.onHistoryCacheReady) {
    historyCacheUnsub = api.onHistoryCacheReady(handle)
  }
}

function unbindHistoryCacheReady(): void {
  historyCacheSubCount = Math.max(0, historyCacheSubCount - 1)
  if (historyCacheSubCount === 0 && historyCacheUnsub) {
    historyCacheUnsub()
    historyCacheUnsub = null
  }
}

/** 测试隔离：重置通知订阅计数（beforeEach 调，防上一用例的 handler 残留单槽）。 */
export function resetHistoryCacheSubForTest(): void {
  if (historyCacheUnsub) {
    historyCacheUnsub()
    historyCacheUnsub = null
  }
  historyCacheSubCount = 0
}

/**
 * createUseSession factory —— session 管理编排（IF4 落地）。
 *
 * 使用方式：壳（w5）注入六端口 + 可选 flow，包装为 renderer composable（useSidebar）；
 * 测试注入 mock 端口断言编排（见 __tests__/store.test.ts 的 selectSession describe 与
 * __tests__/use-session-history-cache.test.ts——原 use-session.test.ts 已并入 store.test.ts）。
 */
export function createUseSession(deps: UseSessionDeps) {
  const { store, api, panel, navigation, chat, hooks } = deps

  // ── sessionEntry 端口解析（D3）：成员级可选 → 显式 no-op 默认，链内零 undefined 崩溃路径 ──
  const noop = (): void => {}
  const entry: Required<SessionEntryPort> = {
    cancelActiveFlow: deps.sessionEntry?.cancelActiveFlow ?? noop,
    clearUnread: deps.sessionEntry?.clearUnread ?? noop,
    ensureStreamSubscription: deps.sessionEntry?.ensureStreamSubscription ?? noop,
    touchRecency: deps.sessionEntry?.touchRecency ?? noop,
    preloadFileTree: deps.sessionEntry?.preloadFileTree ?? noop,
    evictLru: deps.sessionEntry?.evictLru ?? noop,
  }

  /**
   * 当前焦点 panel 绑定的 session（UI 高亮 SSOT）。
   * 与 store.activeId 解耦：activeId 收敛为导航/启动语义，不再驱动 UI 高亮。
   * 空 panel（sessionId=null）→ 返回 null（文件树显空态占位）。
   */
  const focusedSessionId = computed<string | null>(() => panel.focusedSessionId())

  /** 焦点 session 的 summary（FileView label/branch 用）；找不到则 null */
  const focusedSession = computed<SessionSummary | null>(
    () => store.getList().find((s) => s.id === focusedSessionId.value) ?? null,
  )

  /**
   * session.list server-push 订阅（#7 方案 A）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组，
   * 这里 applySnapshot（整表形态）更新列表——只换列表，不重载历史。
   * refCount + onScopeDispose：多实例只注册一次，随组件卸载自动收尾。
   */
  bindSessionListBroadcast(api, (groups) => store.applySnapshot({ groups }))
  onScopeDispose(unbindSessionListBroadcast)
  // [session-cold-switch-perf §3.3-3] historyCacheReady 通知订阅（refCount 单飞；端口未
  // 注入 = 整体不注册，重拉/失败收敛由下一次 getHistory 拉取自然承接）
  bindHistoryCacheReady(api, (sessionId, payload) => {
    void handleHistoryCacheReady(sessionId, payload)
  })
  onScopeDispose(unbindHistoryCacheReady)

  /**
   * 同步 session 到 panel（sidebar 选 session 与 ⌘[/⌘] 导航共用）。
   * 单 panel 下直接载入活跃 panel。幂等：同 sessionId 重复调用，loadSession 同值不变。
   * 编排点在 features 层而非组件 watch——避免「空态时不渲染→watch 不注册→loadSession 不触发」
   * 的初始化时序死锁（原 PanelContainer watch bug）。
   */
  function syncSessionToPanel(sessionId: string): void {
    const pid = panel.activePanelId()
    if (pid) panel.loadSession(pid, sessionId)
  }

  /**
   * getHistory 响应 → store 回填 + toolResult 图片落盘编排统一收敛（D6-⑨）。
   *
   * use-session 侧所有「history 消息写入 store」的通路（runEntryChain 首次切入 / 已
   * hydrate 刷新 / retryHistory）必须经此 helper，禁止直接调 chat.reconcileHistory——
   * 编排漏挂即旁路（Gate B A9③ 缺陷#2：persistImagesNewestFirst 此前只挂
   * useChat.hydrateHistory 通路，主流点击切入三处 reconcile 零落盘，cache 帽满占位 /
   * LRU 命中在主流路径全部无法触发）。幂等保障：persistImagesNewestFirst 内部按内容
   * hash 剔除已落盘图（重复 hydrate 不双写）、无图消息零开销早退；fire-and-forget
   * （D6-⑨ 契约）：不阻塞回填，内部消化异常——图片缓存故障不放大为历史加载失败。
   */
  function reconcileFromReply(sessionId: string, reply: Awaited<ReturnType<ChatHydratePort['getHistory']>>): void {
    // [u4d] 窗口状态随 reconcile 一并写入 chat store（truncated/loadedTurns/totalTurnsEstimate
    // 单点存截断窗口状态；合并语义见 store.reconcileHistory——truncated=true 窗口段覆盖、
    // 更早历史保留，false 收敛顶部条）
    chat.reconcileHistory(sessionId, reply.messages, historyWindowFromReply(reply))
    void persistImagesNewestFirst(sessionId, collectImagesFromMessages(reply.messages))
  }

  /**
   * 刷新已 hydrate 会话的历史到最新（remote-use U9 / A6，connected 边沿重连对账入口）。
   *
   * 编排 = getHistory + reconcileFromReply（窗口归一 + 图片落盘随行）——与切入链步 9
   * 已 hydrate 分支共用同一入口（单一编排定义点）。未 hydrate 会话 no-op：首次回填属
   * 切入链步 9 hydrate 分支职责，重连对账不承担（否则断连恢复会对无历史分区的会话
   * 触发整段拉取，超出「当前已 hydrate 会话对账」的射程）。失败静默不抛（对齐步 9
   * 已 hydrate 分支语义——旧数据仍在，下次切入/重连重试），不 markHistoryFailed
   * （失败态语义属未 hydrate 通路的 landing 重试出口）。
   */
  async function refreshHistory(sessionId: string): Promise<void> {
    if (!chat.isHydrated(sessionId)) return
    try {
      const reply = await chat.getHistory(sessionId)
      reconcileFromReply(sessionId, reply)
    } catch (e) {
      // 已 hydrate 对账失败不阻断——旧数据仍在，下次切入/重连重试；warn 留排查痕迹
      console.warn(`[use-session] background reconcile refresh failed for ${sessionId}:`, e)
    }
  }

  /**
   * [W2 权威拉取与冷读] 状态层拉取对账（设计 §5-W2 的渲染层三时机）。
   *
   * 三时机 = ① **打开视图**（runEntryChain 切入链尾部）② **重连**（壳 onConnected 对
   * 聚焦 session 调本方法）③ **缓存缺失**——③ 是前两个时机的门控而非独立触发点：状态层
   * 无该 session 条目（显式未知）才发 RPC，有条目即跳过（不覆盖推送已更新的值）。
   *
   * 语义（ADR-0097 拉为真理通道 + ADR-0122 事实驱动）：
   * - 活/冷会话由 runtime 同一入口分派（活读实例快照 / 冷读会话文件），本层不感知；
   * - 失败静默不抛（断连 / SESSION_NOT_FOUND / 会话不存在）：显式未知保持，下次时机
   *   重试——**不回退主会话 / 默认模型 / 其他会话的值**；
   * - fire-and-forget：调用方（切入链 / 重连对账）不等 RPC 返回，不阻塞用户操作。
   */
  async function refreshLiveState(sessionId: string): Promise<void> {
    const liveState = deps.liveState
    const getState = deps.api.getState
    if (!liveState || !getState) return
    // 缓存缺失才拉（③）：已有条目 = 推送/回执已填，拉取只会覆盖同源值
    if (liveState.liveStateOf(sessionId) !== undefined) return
    try {
      const state = await getState(sessionId)
      // 键取**请求的** sessionId（不信任 reply 的 sessionId 回显：协议漂移时回显值可能
      // 与请求不一致，落点必须是调用方已知的那个会话）
      liveState.applyLiveState(sessionId, {
        modelId: state.modelId,
        thinkingLevel: state.thinkingLevel,
      })
    } catch (e) {
      // 拉取失败 = 显式未知保持（不猜、不回退）；warn 留排查痕迹
      console.warn(`[use-session] live state pull failed for ${sessionId}:`, e)
    }
  }

  /**
   * 切入链步 9 的历史拉取统一入口（[session-cold-switch-perf §3.3-4] 并行切口）。
   *
   * selectSession 在 switchSession **之前**发出（尾读快路径不依赖 pi 进程，runtime 侧
   * 四态分派按 sessionId 独立查询），reply 落库编排在此独立完成——**独立于链短路**：
   * switch 失败在步 2 短路后续步骤时，本 promise 不受影响照常落库（pi 不可用时查看数据
   * 仍可得，场景 6 数据层断言的载体；显示层无载体 panel 不挂载 = 现状失败语义）。
   * promise 内部消化全部错误恒 resolve（无 unhandled rejection 面），selectSession 把
   * 它交给 runEntryChain 步 9 await——早到即直通，保住链内步 10-12 的时序（与旧链等价）。
   *
   * 落库语义与旧步 9 两分支对齐：未 hydrate = reconcile + clearHistoryError（失败
   * markHistoryFailed 走 landing 重试出口）；已 hydrate = 静默刷新（refreshHistory 同款，
   * 失败 warn 不抛——失败态语义属未 hydrate 通路的 landing 重试出口）。拉取成功同时
   * 收敛后台重建失败态（historyCacheReady 失败帧的「重试成功」收敛点之一）。
   */
  function startEntryHistoryPull(id: string): Promise<void> {
    return chat.getHistory(id).then(
      (reply) => {
        const wasHydrated = chat.isHydrated(id)
        reconcileFromReply(id, reply)
        if (!wasHydrated) chat.clearHistoryError(id)
        chat.historyCache?.clearCacheFailed(id)
      },
      (e) => {
        if (chat.isHydrated(id)) {
          // 已 hydrate 对账失败不阻断——旧数据仍在，下次切入/重连重试；warn 留排查痕迹
          console.warn(`[use-session] background reconcile refresh failed for ${id}:`, e)
        } else {
          chat.markHistoryFailed(id)
        }
      },
    )
  }

  /**
   * [session-cold-switch-perf §3.3-3] session.historyCacheReady 通知编排（后台全量重建
   * 完成后的显示合并：尾读首屏 → 全量精化）。
   *
   * 帧语义（shared protocol SSOT）：成功/失败都推；snapshotLeafId = 重建快照末条 entry id。
   * 四步判定（任一不过即静默忽略，通知帧按 sessionId 定向不串显示）：
   * ① 活跃会话匹配——非活跃会话与 btw 线分区（drawer 选中线 ≠ activeId）不动作：
   *    btw 回放窗口保持（尾读 + live 帧按现状继续填充），缓存收益在下次重开回放兑现；
   * ② 失败帧（error 非空）不重拉（ADR-0122 失败显式上报、首败即停，不建自动重试）——
   *    「正在加载更早」指示收敛为「加载更早失败 + 重试入口」（复用手动翻页失败呈现，
   *    renderer useLoadMoreHistory 合并 chat store historyCacheFailed 分区）；重试由
   *    下一次 getHistory 派单（手动重试/切入/重连对账）按四态重新决策，消费驱动；
   * ③ 未 hydrate 跳过——首屏加载由切入链并行 pull 承担（它按四态重新分派，命中缓存
   *    即毫秒级），防双拉；
   * ④ 快照版本对账（isHistorySnapshotFresh）——重建期间会话有新追加（用户发送过消息）
   *    则快照基准不匹配，不重拉：由尾部保护段继续衔接 live 数据，等下一轮索引。
   *
   * 通过后重拉 getHistory（此时命中缓存，毫秒级）→ reconcileFromReply → 现有
   * reconcileHistory 合并上屏（基线替换 + 尾部 live 保护段承载「全量精化不打扰用户当前
   * 阅读与在途消息」）。await 窗口后二次核对活跃态：用户切走则放弃落库（切回时切入链
   * 重新拉取），per-session 分区本身无串话。滚动位置保持：贴底场景由 follow 机制承载；
   * 用户已上滑时基线替换在分区头部插入更早历史，chat store 记基线前置事件计数
   * （getBaselinePrependTick）→ renderer useLoadMoreHistory 转一拍 isPrepend 喂
   * virtua :shift 保位（shift=false 时 virtua 对头部插入无补偿，scrollTop 不变 +
   * 前方插入 = 视口内容前移跳变）。
   */
  async function handleHistoryCacheReady(
    sessionId: string,
    payload: ServerMessageMap['session.historyCacheReady'],
  ): Promise<void> {
    // ① 活跃会话匹配（btw 线分区 / 非活跃会话静默忽略）
    if (store.getActiveId() !== sessionId) return
    // ② 失败帧：不重拉，收敛失败重试入口
    if (payload.error !== undefined) {
      chat.historyCache?.markCacheFailed(sessionId)
      return
    }
    // ③ 未 hydrate：首屏加载由切入链并行 pull 承担
    if (!chat.isHydrated(sessionId)) return
    // ④ 快照版本对账：过期快照不重拉（尾部保护段衔接，等下一轮索引）
    if (!chat.historyCache?.isSnapshotFresh(sessionId, payload.snapshotLeafId)) return
    try {
      const reply = await chat.getHistory(sessionId)
      if (store.getActiveId() !== sessionId) return
      reconcileFromReply(sessionId, reply)
      chat.historyCache?.clearCacheFailed(sessionId)
    } catch (e) {
      // 缓存快路径失败（罕见）：保持现状（尾读数据 + truncated 入口仍在），warn 留痕，
      // 下一次 getHistory 派单按四态重新决策
      console.warn(`[use-session] history cache refresh failed for ${sessionId}:`, e)
    }
  }

  /**
   * 切入链主体（原壳 useSidebar.postLoadSession，D3 入 core）：统一链步 4-13。
   * 前置：switchSession 已成功 + activeId 已置——ensureStreamSubscription /
   * syncSessionToPanel 依赖当前 activeId 路由到正确 session 分区（ADR-0049 + 架构约定 #7）。
   *
   * [session-cold-switch-perf §3.3-4] historyPull 参数 = selectSession 在 switch 前并行
   * 发出的步 9 拉取（见 startEntryHistoryPull）——本链只 await 同一 promise，不再发请求。
   */
  async function runEntryChain(id: string, historyPull: Promise<void>): Promise<void> {
    // 4. 清未读：用户主动查看该 session，未读 badge 即消
    entry.clearUnread(id)
    // 5. 流订阅：[C-W3-4 / 2026-07-29 handoff 回复丢失事故] 必须先于 syncSessionToPanel——
    //    panel 载入后 MessageStream 挂载，订阅必须先就绪否则 snapshot 回放事件被丢
    entry.ensureStreamSubscription(id)
    // 6. LRU recency：panel 载入前刷新，确保当前 session 不被本链末尾的驱逐逐出（W3 H3）
    entry.touchRecency(id)
    // 7. panel 载入（D4 panel-first：panel 立即挂载，历史异步回填）
    syncSessionToPanel(id)
    // 8. 导航
    navigation.push({ view: 'chat', sessionId: id })
    // 9. 历史回填：pull 已在 selectSession 与 switch 并行发出（§3.3-4），此处仅 await
    //    同一 promise 保住步 10-12 时序；promise 内部消化错误（hydrate 失败标
    //    failedHistory 不抛穿，AC-2.6 landing 显重试出口）
    await historyPull
    // 10. 文件树预加载：切 session 即拉取，侧栏「文件」tab 计数立即更新。fire-and-forget 失败不阻断
    entry.preloadFileTree(id)
    // 11. [lru-panel-exempt-fix] 驱逐前刷新 panel 绑定 session 的 LRU recency——若在驱逐侧
    //     加 panel 检查会让 deleteSession 流程中被删 session 被 exempt 拦截（内存泄漏）
    const panelSessionId = panel.focusedSessionId()
    if (panelSessionId) entry.touchRecency(panelSessionId)
    // 12. LRU 驱逐
    entry.evictLru(panelSessionId)
    // 13. [W2] 状态层拉取对账（打开视图时机；缓存缺失门控 + fire-and-forget）
    void refreshLiveState(id)
  }

  /**
   * 选择 session：完整 13 步切入链（D3/D4，renderer-deepening）——链的唯一载体，改时序只改这里。
   * 1 cancelActiveFlow → 2 switchSession → 3 setActiveId → 4 clearUnread →
   * 5 ensureStreamSubscription → 6 touchRecency → 7 syncSessionToPanel → 8 navigation.push →
   * 9 hydrate/reconcile → 10 preloadFileTree → 11 touchRecency(panel 绑定 session) → 12 evictLru →
   * 13 refreshLiveState。
   *
   * 时序采壳版（D4 行为纠正）：panel/navigation 先于 hydrate——panel 立即挂载、历史异步
   * 回填；旧 core hydrate-first 让 panel 载入等历史 RPC 返回，切换感知延迟长（UX 回退）。
   * [session-cold-switch-perf §3.3-4 最小切口] 步 9 getHistory 提前到与步 2 switchSession
   * **并行发出**（「查看数据获取」与「执行就绪」解耦——冷切首屏不再等 spawn/全量重建）；
   * panel 挂载（步 7）仍随 switch 返回，其余链序不动。失败语义：switchSession 失败抛错由
   * UI 层捕获（不更新 activeId，后续步骤含 panel 挂载全部短路，现状语义）；并行发出的
   * history pull 不受短路影响（独立落库，见 startEntryHistoryPull）；hydrate 失败标
   * failedHistory 不抛穿（AC-2.6 landing 显重试出口），尾部步骤照常执行。
   */
  async function selectSession(id: string): Promise<void> {
    // 1. flow 活跃（landing/overlay）时切 session → cancelled（AC-3.10，防 overlay 卡死 + landing 残留）
    entry.cancelActiveFlow()
    // 9′. 历史拉取并行发出（原步 9 提前）：尾读快路径不依赖进程，与 switch 竞速——
    //     无论谁先返回，两种到达顺序都收敛到同一终态（消息先到、panel 到达即显示）
    const historyPull = startEntryHistoryPull(id)
    // 2. 通知 runtime 切换（失败抛错，后续步骤全部短路；historyPull 独立浮动不受短路影响）
    await api.switchSession(id)
    // 3. activeId（步 5/7 依赖 activeId 路由到正确 session 分区）
    store.setActiveId(id)
    // 4-13（步 9 消费并行 pull）
    await runEntryChain(id, historyPull)
  }

  /**
   * 重试加载历史（landing 重试按钮，#2 AC-2.6）：清失败态 + 重新拉取 hydrate。
   */
  async function retryHistory(sessionId: string): Promise<void> {
    chat.clearHistoryError(sessionId)
    try {
      const reply = await chat.getHistory(sessionId)
      // [u4d] 窗口状态随 reconcile 写入 + 图片落盘编排（同 runEntryChain 收敛）
      reconcileFromReply(sessionId, reply)
    } catch {
      chat.markHistoryFailed(sessionId)
    }
  }

  /**
   * 新建 session（延迟 create 终态，C-W3-2）：委托 NewTaskFlowPort.startFlow 编排状态机。
   * startFlow 恒不建 session（session 由首发提交 submitFirstMessage 创建并绑定，startFlow
   * 末尾恒 bindCurrentSession(null)），故本方法恒进 chat view 让 Panel 渲染 landing 空态，
   * 恒返回 null。返回类型保持 string | null 对齐端口契约形状（调用方均不消费返回值）。
   *
   * per-instance in-flight 检查（renderer 同构：6+ 组件实例各自独立检查，模块级会互相阻塞）。
   * flow 未接线（deps.flow 缺省）时返回 null 降级——壳（w5）接线后语义完整。
   */
  let newTaskInFlight = false
  async function newSession(presetCwd?: string): Promise<string | null> {
    if (newTaskInFlight) return null
    if (!deps.flow) return null
    newTaskInFlight = true
    try {
      await deps.flow.startFlow(presetCwd)
      // 延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
      navigation.push({ view: 'chat' })
      return null
    } finally {
      newTaskInFlight = false
    }
  }

  /**
   * 重命名 session（API + 乐观更新 store）。
   * 编排点在 features 层：跨 api + store 的唯一合法层。
   * 乐观更新 = applySnapshot 本地入参只带 label；权威确认经 config.sessions 整表广播回流。
   */
  async function renameSession(id: string, label: string): Promise<void> {
    await api.rename(id, label)
    store.applySnapshot(id, { label })
  }

  /**
   * 单 session 的本地状态清理（panel 解绑 + 跨 store 分区释放）。
   *
   * 从 deleteSession 主体提取（供 deleteFolder 复用）：删 session 后同步清 panel 绑定 +
   * 全部 per-session store 分区 + 派生状态缓存，防内存泄漏与悬空引用。
   * 与 deleteSession 不同——这里不做 WS 删除（调用方已保证 session 在后端已删），
   * 也不做 wasActive 回退（deleteFolder 统一在循环结束后回退）。
   *
   * S3 顺序（与 renderer cleanupSessionState 逐条对齐）：
   * panel 解绑 → removeFromList →
   * 11 项必选跨 store 钩子（clearFileTree→…→invalidateStatus→browserDestroy）→
   * G1 三钩子（clearTerminalQueue/clearSlashCommands/clearForkNotices）→
   * closeWorkflowOverlay（workflow-viz overlay UI 关闭，第 4 项可选，U6/D11⑤）→
   * triggerSessionCleanups。
   */
  function cleanupSessionState(id: string): void {
    // 删除的 session 若绑定到 panel，清空 panel 绑定，避免悬空引用指向已删 session。
    const boundPanel = panel.findPanelBySession(id)
    if (boundPanel) {
      panel.loadSession(boundPanel.id, null)
      // [U7] overlay viewing 状态机已移除，clearBoundPanelOverlays 兜底清理随之删除。
      // 虚拟 key 清理走下面 evictChat（subagent: 前缀）+ evictVirtualKeys（agentcall 映射）两条独立路径。
    }
    store.removeFromList(id)
    // 跨 store 清理（S3）：fileTree + subagent + workflow + extensionUI + chat evict
    // + tombstones + agentcall virtuals + dispose + 派生状态缓存（[P4 s5 w2] tasks 已删）
    hooks.clearFileTree(id)
    // ADR-0049 Map 分区派：释放 subagent/workflow/extensionUI 的 per-session 分区（防泄漏，AC-8）
    hooks.clearSubagent(id)
    hooks.clearWorkflow(id)
    hooks.clearExtensionUI(id)
    // M1-03：extension-host scoped map 分区（ViewHostStore/OverlayLifecycle）
    // 只订阅 session-destroyed bus 事件，而该事件无生产者——本编排点必须显式触发清理
    hooks.clearExtensionHost(id)
    // evictSessionWithVirtual 在 disposeSession 之前：先按 mainSid 前缀扫 subagent 虚拟 key，
    // 再 dispose 主 session（dispose 后主记录已删，evict 无法反查）。D5 时序。
    hooks.evictChat(id)
    // agentcall 两段式无 mainSid 前缀，经 workflow 映射清全部 agentcall virtualId
    hooks.evictVirtualKeys(id)
    hooks.clearAgentCallMapping(id)
    hooks.disposeChat(id)
    // 清除该 session 的 derivedStatus 缓存，避免已删 session 的 computed 残留
    hooks.invalidateStatus(id)
    // [B4 / 2026-09-14 内存审计 §2.1] main 侧 WebContentsView 销毁接线（hooks 序列末位追加）：
    // fire-and-forget——rejection 由 hook 实现方显式 .catch 消化（见接口契约），不阻塞删除链。
    hooks.browserDestroy(id)
    // [G1 / 2026-09-14 内存审计 §3.4] 死清理 API 接线组（可选成员 ?. 防御调用——旧实现
    // 不注入即跳过，零破坏）：terminal 写队列 / slash 命令历史 / fork 通知 feed 三类
    // per-session Map 分区随 session 销毁释放。同步内存操作，无 rejection 面。
    hooks.clearTerminalQueue?.(id)
    hooks.clearSlashCommands?.(id)
    hooks.clearForkNotices?.(id)
    // workflow-viz overlay UI 关闭（U6/D11⑤，可选 hook——壳未接线即跳过；数据范围在 clearWorkflow）
    hooks.closeWorkflowOverlay?.(id)
    // ADR-0049 W5：触发所有 useSessionScopedState 实例清理该 sid 的 Map 分区，
    // 防已销毁 session 的 per-session 状态条目在 Map 中积累导致内存泄漏（AC-8）。
    // 销毁唯一编排点契约：triggerSessionCleanups 只经 deleteSession/deleteFolder/
    // archiveSession（归档退场，D14）触发。
    triggerSessionCleanups(id)
  }

  /**
   * [D7 空态承接] 删除路径的空态出口统一编排（deleteSession/deleteFolder/archiveSession 专用）：
   * push chat 空态 + 显式 startFlow——终态下 landing 渲染需 flow 活跃，flow=idle 时
   * 面板落入无输入范围死态 empty（旧壳 enterEmptyChatState 同构上收）。
   * flow 未接线（headless 形态）时只 push。不用于 newSession 延迟 create 分支——
   * 无参 startFlow 的 pendingCwd=null 会清掉 newSession 刚回灌的 fallback cwd。
   */
  function enterEmptyChatState(): void {
    navigation.push({ view: 'chat' })
    void deps.flow?.startFlow()
  }

  /**
   * 删除 session（API + 本地状态清理）。
   * 删除当前 active 时回退到列表首项（若无则停留空态）。
   *
   * S3 跨 store 清理由 cleanupSessionState 统一承担（panel 解绑 + 全部 per-session 分区释放）。
   * S4 / ES1 fallback：删 active 后 selectSession(next) 失败兜底——cleanupSessionState 已把
   * activeId 回退到 list[0]，若随后的回退 selectSession 因网络抖动 reject，activeId=next 但
   * panel 空载 → 跨 store 撕裂。失败时 fallback 到 [D7] 空态承接：push chat + startFlow
   * （flow 未接线时只 push——headless 形态无 landing 承接需求）。
   */
  async function deleteSession(id: string): Promise<void> {
    await api.remove(id)
    const wasActive = store.getActiveId() === id
    cleanupSessionState(id)
    // [W1] 状态层条目显式清退（不随列表差集推断，设计 §3.3「删除会话：显式清除」；
    // 归档不走此处——归档后恢复会话时已缓存状态应仍在，见 SessionCleanupHooks.clearLiveState）
    hooks.clearLiveState?.(id)
    if (wasActive) {
      const next = store.getList()[0]
      if (next) {
        try {
          await (deps.selectSessionFallback ?? selectSession)(next.id)
        } catch {
          // 回退 selectSession 失败（网络抖动）→ [D7] 空态承接，避免 activeId=next 但 panel 空载撕裂（S4）
          enterEmptyChatState()
        }
      } else {
        enterEmptyChatState()
      }
    }
  }

  /**
   * 归档 session（session-archive 设计 D14：发起窗口本地编排与 deleteSession 同款）。
   *
   * RPC 成功后：wasActive 快照 → cleanupSessionState（panel 解绑 + 全部 per-session
   * 分区释放 + triggerSessionCleanups——与 deleteSession 共用同一清理链，归档 session
   * 对前端即退场）→ wasActive 时回退 list[0] / 空态（归档的恰是当前查看的 session 时
   * 切回相邻 session）。列表数据刷新由 runtime broadcastSessionList 帧回流（远端窗口
   * 同款，P7——本编排不做额外远端通知）。
   *
   * 与 deleteSession 的差异仅在 RPC 与语义（归档非销毁，恢复后完整回场）；清理编排
   * 完全同族——归档 session 的全部前端 per-session 状态（chat 分区/流订阅/LRU/文件树）
   * 随退场释放，恢复后按普通重开路径重建。
   */
  async function archiveSession(id: string): Promise<void> {
    await api.archive(id)
    const wasActive = store.getActiveId() === id
    cleanupSessionState(id)
    if (wasActive) {
      const next = store.getList()[0]
      if (next) {
        try {
          await (deps.selectSessionFallback ?? selectSession)(next.id)
        } catch {
          // 回退 selectSession 失败（网络抖动）→ [D7] 空态承接（与 deleteSession S4 同款）
          enterEmptyChatState()
        }
      } else {
        enterEmptyChatState()
      }
    }
  }

  /**
   * 批量删除指定 cwd（folder）下所有 session。
   *
   * 调 api.removeByCwd 拿 BatchDeleteResult，对 res.deleted 逐个调
   * cleanupSessionState（复用 deleteSession 提取的清理逻辑）。wasActiveInFolder
   * 在调 WS 前快照，循环结束后统一回退（不依赖 removeFromList 中间态）。
   * 返回 BatchDeleteResult——caller（Sidebar.onDeleteFolder）读 res.failed 决定 toast。
   */
  async function deleteFolder(cwd: string): Promise<BatchDeleteResult> {
    // 用已派生的 store.list（单一真源 groups → list，与下文回退 store.list[0] 同源），
    // 避免再 flatMap 一次重复 groups.flatMap(g => g.sessions)。
    const wasActiveInFolder = store.getList()
      .filter((s) => s.cwd === cwd)
      .some((s) => s.id === store.getActiveId())
    const res = await api.removeByCwd(cwd)
    for (const sid of res.deleted) {
      cleanupSessionState(sid)
      hooks.clearLiveState?.(sid) // [W1] 批量删除同属真删除：状态条目显式清退
    }
    if (wasActiveInFolder) {
      const next = store.getList()[0]
      if (next) {
        try {
          await (deps.selectSessionFallback ?? selectSession)(next.id)
        } catch {
          enterEmptyChatState()
        }
      } else {
        enterEmptyChatState()
      }
    }
    return res
  }

  /**
   * 加载 session 列表（去全量预 hydrate）。
   * 铁律 1：api 调用只在 features 层，组件不直接 import api。
   * sessionApi.list() 返 SessionGroup[]（按 cwd 分组，D7），applySnapshot 整表形态填入分组真源。
   * 失败（ES2/S5）：setListLoadError(msg)，SessionList 据此显示「加载失败，点击重试」。
   */
  async function loadSessions(): Promise<void> {
    try {
      const groups = await api.list()
      store.applySnapshot({ groups })
      store.setListLoadError(null)
    } catch (e) {
      const msg = toErrorMessage(e)
      store.setListLoadError(msg)
    }
  }

  return {
    focusedSessionId,
    focusedSession,
    syncSessionToPanel,
    selectSession,
    retryHistory,
    refreshHistory,
    newSession,
    renameSession,
    deleteSession,
    archiveSession,
    deleteFolder,
    loadSessions,
    refreshLiveState,
  }
}
