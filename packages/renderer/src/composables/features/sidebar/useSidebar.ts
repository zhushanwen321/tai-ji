/**
 * useSidebar —— sidebar 业务编排（R2 features 层，session-sidebar 域 P3 绞杀终态）。
 *
 * 这是「唯一跨 api + stores 的层」（R2 铁律 1）：包装 core createUseSession（w3）+ 注入
 * 端口适配（SessionApiPort/PanelOrchestrationPort/NavigationPort/ChatHydratePort/
 * SessionCleanupHooks/NewTaskFlowPort + selectSessionFallback 回退端口）+ renderer 专属编排
 * （restoreSession / assignSessionToProject / newSession 兜底 / 启动编排）。
 *
 * 关键裁决：
 * - C-W5-1 → [HISTORICAL]（renderer-deepening D3/D4 推翻，u5.2）：selectSession 曾壳重编排
 *   （理由「core.selectSession 是自包含函数，renderer 步骤无法插入」）——u5.1 起 core 持完整
 *   13 步切入链 + sessionEntry 端口束，renderer 专属步骤（取消 flow/清未读/流订阅/LRU/文件树）
 *   经端口注入。壳 selectSession 现为一行代理 core.selectSession，链唯一载体在
 *   core domain/session/use-session.ts（改时序只改那一处，13 步顺序有接口级断言）。
 *   deleteSession/deleteFolder 的 wasActive 回退原「缺 ensureStreamSubscription」接缝债随之清偿
 *   （回退路径经同一 core 链，端口已接线；main 侧曾以 selectSessionFallback 端口注入壳版
 *   selectSession 清偿同一债务——D3 路线下 core 链即完整链，壳不再注入该端口）。
 * - C-W5-5（ADR-0059 重构）：sessionStore 经 pinia useSessionStore() cast 成 core factory 类型。
 *   core createUseSession 经方法访问 store（getActiveId/setActiveId/getList，ADR-0059 决策 1），
 *   方法闭包持原始 ref，pinia unwrap 不影响方法内部 .value。消除原 raw 双轨 + config.sessions 桥接。
 *
 * 边界（C-W4-3 / FU-1）：thinkingLevel apply / panel.loadSession / navigation.push / send /
 * transition 留 useNewTaskFlow 壳（submitFirstMessage 改调 core createSessionFlow，见该文件）。
 *
 * 命名收尾（2026-09-03 dev-merge dev-0.9.14）：本文件由 useSidebar.ts 重命名接管原名——
 * main 侧 2026-08-31 已独立完成同一 strangler 收尾（af96fa94c），两侧合并时采纳其终态命名。
 *
 * 未来替换挂载实现：P4 挂载实际以 core bootstrap.ts 的 registerMountPoints 五挂载点注册表
 * 落地（sidebar.tab / panel.header / composer.toolbar / modal，无 'sessions' 挂载点）；

 * 如需替换挂载实现，走该注册表（packages/core/src/bootstrap.ts），勿另起壳侧入口。
 */
import type { ComputedRef } from 'vue'
import type { BatchDeleteResult, SessionSummary } from '@taiji/shared'
import {
  createSessionStore,
  createUseSession,
  evictLruWithUnsubscribe,
  resetSessionListSubForTest,
  registerDataDomain,
  registerAuxiliaryRefresh,
  ensureConnectionEdgeSync,
  requestDomainSync,
  whenSettled,
  resetConnectionEdgeSyncForTest,
} from '@taiji/core'
import * as transportEvents from '@taiji/core/transport/api'
import type {
  ChatStoreInstance,
  SessionApiPort,
  PanelOrchestrationPort,
  ChatHydratePort,
  NavigationPort,
  SessionCleanupHooks,
  NewTaskFlowPort,
  SessionEntryPort,
} from '@taiji/core'
import { chat as chatApi, session as sessionApi, extension as extensionApi } from '@/api'
import { buildSessionApiPort } from '@/api/session-api-port'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
// [可视化 U6/D11⑤] overlay 关闭编排（deleteSession 级联经 SessionCleanupHooks.closeWorkflowOverlay）
import { closeWorkflowVizOverlayForSession } from '@/components/panel/workflow-viz/overlay/workflow-viz-overlay'
// [M4-a / btw-question D4 消费方①] deleteSession 级联的前端路径：枚举/处置/清映射三函数
//（与 m7/agentcall 的 evictVirtualKeys 先例同构，登记结构在 useBtwTabData）。
import { getBtwSessionIdsByMain, clearBtwVirtualKeyMapping, disposeBtwLinePartitions } from '@/composables/panel/useBtwTabData'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChat, ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { useSessionLiveStateStore } from '@/stores/session-live-state'
import { useTurnExpansionStore } from '@/stores/turn-expansion'
import { useTtsPlayer } from '@/composables/features/chat/useTtsPlayer'
import { invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { browserDestroy as browserDestroyIpc } from '@/lib/ipc'
// [display-containers §7.4 发起会话删除级联] 浮层 browser 内容的 UI 关闭编排（core 协调层，
// 条件式：仅发起会话被删才关，删非发起会话不动浮层——S5 反向断言）
import { closeBrowserOverlayForSession } from '@taiji/core/domain/overlay'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useForkNoticeFeed } from '@/composables/effects/useForkNoticeEffect'
import { clearUnread } from '@/composables/useSessionMarkers'
import { clearUnread as clearForkBranchUnread } from '@/composables/features/fork-handoff/useForkBranchNotify'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { registerAppCommands } from '@/composables/features/command/useAppCommands'
import { useForkActions } from '@/composables/features/fork-handoff/useForkActions'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import type { NavEntry } from '@/types'

// ── App 启动编排幂等检查 ──
let appBootstrapped = false

/**
 * project.changed 失效信号的消费动作（connection-datasync-ssot §6.6）：触发 project 域
 * 重新拉取。模块级稳定引用——useSidebar 多实例重复注册时 onGlobalType 底层 Set 按引用
 * 去重（见装配段注释）；域未登记时 requestDomainSync 自行 warn（装配缺失留痕排障）。
 */
function onProjectChanged(): void {
  requestDomainSync('project')
}

/** 测试隔离：重置启动编排检查 + 域同步器登记/代次 + session.list 订阅计数（beforeEach 调）。 */
export function resetAppBootstrap(): void {
  appBootstrapped = false
  resetConnectionEdgeSyncForTest()
  resetSessionListSubForTest()
}

/**
 * 测试后门命名空间（生产代码禁止消费，对齐 useExtensionHostBridge / app-runtime __testing
 * 先例）：装配检查断言入口——sessionEntry 端口束原始注入点（composable 内构造，useSidebar()
 * 调用时填充）。remote-use D9/U21 装配检查 helper 双壳测试的桌面壳断言源：未来重构 useSidebar
 * 静默删 sessionEntry 注入时，core helper 断言在测试期报红（生产零消费由 assembly-check
 * grep 断言守护，出口不扩大 API 面常驻语义）。
 */
export const __testing: { sessionEntry?: SessionEntryPort } = {}

/**
 * 未读两源同点清除（D9 合流）：① session 标记（后台完成 → markUnread，localStorage）；
 * ② fork 分支角标（useForkBranchNotify 模块级单例，SessionItemDisplay 同一枚 dot 读两源）。
 *
 * core select 链 step 4 的壳侧实现（core 零改动，见 packages/core/src/domain/session/use-session.ts:308）。
 * 导出为纯函数供单测直接锁定「两源同点」语义——清除点在编排层，组件层只 emit select，
 * 无法从 DOM 观测清除动作本身。
 */
export function clearSessionUnread(sid: string): void {
  clearUnread(sid)
  clearForkBranchUnread(sid)
}

export function useSidebar() {
  const navigation = useNavigationStore()
  const chat = useChatStore()
  const sidebar = useSidebarStore()
  const panel = usePanelStore()
  const workspaceStore = useWorkspaceStore()
  const { t } = useI18n()
  const { error: toastError } = useToast()

  // ── 端口适配层（core 定义接口、壳注入 renderer 实现）──
  const api: SessionApiPort = buildSessionApiPort()

  const panelPort: PanelOrchestrationPort = {
    focusedSessionId: () => panel.focusedSessionId,
    activePanelId: () => panel.activePanelId,
    findPanelBySession: (sid) => panel.findPanelBySession(sid),
    loadSession: (panelId, sid) => panel.loadSession(panelId, sid),
    // [P4 s5 drawer-widget-removal] tasks drawer 分支已删（tasks tab 移除），统一 open sideDrawer
    openPanel: (sid) => {
      const { open } = useSideDrawer()
      open()
      void sid // sideDrawer 内部按 focusedSessionId 路由，sid 透传无运行时消费（core 契约对齐）
    },
  }

  const navigationPort: NavigationPort = {
    push: (route) => {
      const entry: NavEntry = { view: route.view as NavEntry['view'] }
      if (route.sessionId !== undefined && route.sessionId !== null) entry.sessionId = route.sessionId
      navigation.push(entry)
    },
  }

  const chatPort: ChatHydratePort = {
    getHistory: (sid) => chatApi.getHistory(sid),
    isHydrated: (sid) => chat.isHydrated(sid),
    hydrate: (sid, messages) => chat.hydrate(sid, messages),
    // [u4d] window 透传 store reconcile——截断窗口状态 SSOT 在 chat store（N1 setHistoryTruncated 退役）
    reconcileHistory: (sid, messages, window) => {
      // [chat-flow-consistency C4 两段式契约] 磁盘重载基线接管点清展开分区：本映射是
      // use-session 全部「history 写入 store」通路的编排单点（切入链步 9 / refreshHistory /
      // retryHistory），其中走盘重载形态 = 未 hydrate（首次切入 / LRU 驱逐后切回——store.
      // reconcileHistory 内部此门走 hydrate 全量基线接管）。turn 稳定 id 在 live 与盘上两侧
      // 不相交（pi 事件不带 entry id），重载后键失配本就回落收起——此处显式清分区把「静默
      // 失配」变「可断言重置」（内存卫生）。驻留期切回（已 hydrate → 增量 reconcile）不清，
      // 手动展开保持——「内存驻留期间保持、磁盘重载后重置」两段契约的重置侧落点。
      if (!chat.isHydrated(sid)) useTurnExpansionStore().clearSession(sid)
      chat.reconcileHistory(sid, messages, window)
    },
    clearHistoryError: (sid) => chat.clearHistoryError(sid),
    markHistoryFailed: (sid) => chat.markHistoryFailed(sid),
    // [session-cold-switch-perf §3.3-3] historyCacheReady 编排的 chat store 读写映射
    //（后台重建失败态分区 + 快照版本对账，SSOT 在 chat store）
    historyCache: {
      markCacheFailed: (sid) => chat.markHistoryCacheFailed(sid),
      clearCacheFailed: (sid) => chat.clearHistoryCacheFailed(sid),
      isSnapshotFresh: (sid, snapshotLeafId) => chat.isHistorySnapshotFresh(sid, snapshotLeafId),
    },
  }

  const hooks: SessionCleanupHooks = {
    // [U7] clearBoundPanelOverlays 已随 overlay 移除从 SessionCleanupHooks 接口删除。
    clearFileTree: (sid) => useFileTreeStore().clearSession(sid),
    clearSubagent: (sid) => useSubagentStore().clearSession(sid),
    clearWorkflow: (sid) => useWorkflowStore().clearSession(sid),
    clearExtensionUI: (sid) => useExtensionUIStore().clearSession(sid),
    // M1-03：extension-host scoped map 分区（ViewHostStore/OverlayLifecycle）
    // 只订阅 session-destroyed bus 事件（该事件无生产者），经 bus 显式 emit 触发分区 cleanup
    clearExtensionHost: (sid) => getExtensionBus().emit({ kind: 'session-destroyed', sessionId: sid }),
    evictChat: (sid) => chat.evictSessionWithVirtual(sid),
    // [U7] clearSubagentTombstones 已随 overlay tombstone 移除从接口删除。
    evictVirtualKeys: (sid) => {
      const workflowStore = useWorkflowStore()
      for (const acsVirtualId of workflowStore.getAgentCallVirtualIdsByMain(sid)) {
        chat.evictVirtualKey(acsVirtualId)
      }
      // [M4-a / btw-question D4 消费方① + D9④ 清派生键] deleteSession 级联的前端路径：
      // **枚举先于清映射**（顺序约束）——主会话名下全部 btw 线逐线处置（线分区 +
      // 派生 subagent/agentcall 键 + 两 store 记录分区，单入口幂等），随后清反查表
      //（主已删，映射无意义）。runtime 半边（杀线进程 + 删线目录）在 session-lifecycle
      // 的级联支线；失效路径（闲置回收/进程亡）不进本路径——分区保留待重载链回填（D9④）。
      for (const lineSessionId of getBtwSessionIdsByMain(sid)) disposeBtwLinePartitions(lineSessionId)
      clearBtwVirtualKeyMapping(sid)
    },
    clearAgentCallMapping: (sid) => useWorkflowStore().clearAgentCallMapping(sid),
    // [投递所有权内核 u3c / ADR-0049 范围修订] 队列区 per-session 分区的销毁编排**收窄**：
    // 旧 defer 队列（useCompactQueue 经 useSessionScopedState 注册的 registerSessionCleanup）
    // 已随其退役从编排清单消失；现役队列状态 = 内核 session.delivery 派生视图，清理点在 core
    // useChat.disposeSession 内（clearDeliveryProjection），随本 hook 一并执行——「session
    // 销毁唯一编排点」仍是 deleteSession → triggerSessionCleanups → 本 hooks，renderer 侧
    // 不再多注册一个分区清理项。
    disposeChat: (sid) => useChat().disposeSession(sid),
    invalidateStatus: (sid) => invalidateStatusCache(sid),
    // [B4 / 2026-09-14 内存审计 §2.1] main 侧 WebContentsView 销毁接线：browserDestroy IPC
    // fire-and-forget——preload invoke 透传 rejection，显式 .catch(console.warn 级) 消化，
    // 防 unhandledrejection 上报 error-reporter；失败仅降级为 view 驻留至 LRU 挤出（best-effort）。
    browserDestroy: (sid) => {
      // [display-containers §7.4 发起会话删除级联 browser 分支] 关浮层（仅当浮层当前内容
      // 是该会话的 browser——否则浮层不动）+ 销毁该会话 view（B4 语义保留）。
      closeBrowserOverlayForSession(sid)
      browserDestroyIpc(sid).catch((e) => console.warn(`[useSidebar] browserDestroy(${sid}) failed:`, e))
    },
    // [G1 / 2026-09-14 内存审计 §3.4] 死清理 API 接线组：三个此前全仓零调用的清理 API
    // （terminal-write-queue.removeSession / command-store.clearCommands /
    // useForkNoticeFeed.clearSession）接入销毁编排，已删 session 的 per-session Map 分区
    // 不再永久残留。可选成员（core 侧 ?. 调用）+ 同步内存操作：无可消化 rejection 面
    // （B4 browserDestroy 的 .catch 防御不适用）；useCommandStore 延迟到 hook 调用点取
    // （AppShell providePlatform 之后，对齐 useFileTreeStore 惰性取用范式）。
    clearTerminalQueue: (sid) => useTerminalWriteQueueStore().removeSession(sid),
    clearSlashCommands: (sid) => useCommandStore().clearCommands(sid),
    // [可视化 U6/D11⑤] workflow-viz overlay UI 关闭：删除的 session 是 overlay 当前发起
    // session 时关 overlay（数据范围——事件流缓存 + 活跃锚——由 clearWorkflow/store.clearSession 收尾）。
    closeWorkflowOverlay: (sid) => closeWorkflowVizOverlayForSession(sid),
    clearForkNotices: (sid) => useForkNoticeFeed().clearSession(sid),
    // [W1 会话架构四层分离] 状态层条目显式清退（只挂真删除；归档不挂——归档恢复后
    // 已缓存状态仍在，见 core SessionCleanupHooks.clearLiveState 契约）
    clearLiveState: (sid) => useSessionLiveStateStore().removeLiveState(sid),
  }

  const flow: NewTaskFlowPort = {
    startFlow: (presetCwd) => useNewTaskFlow().startFlow(presetCwd),
    currentSession: () => useNewTaskFlow().currentSession.value,
  }

  // ── sessionEntry 端口束接线（D3，u5.2）：切入链跨域步骤注入 core 13 步链 ──
  // 时序不变量（含 C-W3-4「订阅先于 panel 载入」）由 core 链本体保证，实现侧无需关心顺序；
  // 适配映射：cancelActiveFlow←useNewTaskFlow / clearUnread←clearSessionUnread（两源同点：
  // useSessionMarkers + useForkBranchNotify 分支角标，D9 合流） /
  // ensureStreamSubscription←useChat 壳包装（(sid, chat, sessionStore) 签名收窄为 (sid)）/
  // touchRecency←chat store LRU / evictLru←D2 驱逐+退订复合入口 / preloadFileTree←useFileTree。
  const sessionEntry: SessionEntryPort = {
    cancelActiveFlow: () => {
      const newTaskFlow = useNewTaskFlow()
      if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()
    },
    clearUnread: clearSessionUnread,
    ensureStreamSubscription: (sid) =>
      ensureStreamSubscription(sid, chat, useSessionStore()),
    touchRecency: (sid) => chat.touchLru(sid),
    preloadFileTree: (sid) => {
      void useFileTree().loadTree(sid)
    },
    // panelSessionId 由 core 链在步 11 已完成 recency 刷新后透传；壳实现执行驱逐本体即可。
    // [remote-use D2] 双壳同接驱逐+退订复合入口（桌面原裸接 chat.evictIfNeeded，一并改接
    // 防双壳分叉）：被驱逐会话同步失效订阅簿记 + 发 session.unsubscribe RPC——不退订则
    // 订阅残留、后续消息经 commitMessages 重建分区使驱逐白做（V16 桌面改变面第一条）。
    // cast = pinia unwrap 类型鸿沟（messages 解包为 Map 本体，readPartitionKeys 内双形态
    // 运行时归一），先例同函数下方 sessionStore 的 ADR-0059 cast。
    evictLru: () =>
      evictLruWithUnsubscribe(chat as unknown as ChatStoreInstance, {
        unsubscribe: sessionApi.unsubscribe,
      }),
  }
  // [remote-use D9/U21] 装配检查断言源填充（见模块级 __testing 注释；非消费，仅出口登记）
  __testing.sessionEntry = sessionEntry

  // ── sessionStore：pinia useSessionStore cast 成 core factory 类型（ADR-0059 cast 接缝）──
  // pinia setup store unwrap ref（外部拿值非 ref），与 core createSessionStore 返回的 ref 类型不兼容。
  // cast 是 pinia + core factory 结合的固有类型鸿沟（ADR-0059 决策 3）。createUseSession 内部经方法
  // 访问（getActiveId/setActiveId/getList），方法闭包持原始 ref，pinia/raw 双模式下都正常工作。
  const sessionStore = useSessionStore() as unknown as ReturnType<typeof createSessionStore>

  // ── core createUseSession（13 步切入链唯一载体；sessionEntry 接线后全链生效）──
  const core = createUseSession({
    store: sessionStore,
    api,
    panel: panelPort,
    navigation: navigationPort,
    chat: chatPort,
    hooks,
    flow,
    sessionEntry,
    // [W2 权威拉取与冷读] 状态层：session.getState reply 的唯一落点（与状态消息 /
    // 操作回执共用 applyLiveState 这一个 reducer，设计 §7 验收项 8）
    liveState: useSessionLiveStateStore(),
  })

  /** 当前焦点 panel 绑定的 session（UI 高亮 SSOT）——代理 core.focusedSessionId */
  const focusedSessionId: ComputedRef<string | null> = core.focusedSessionId
  const focusedSession: ComputedRef<SessionSummary | null> = core.focusedSession

  /**
   * syncSessionToPanel——代理 core（无 renderer 专属时序）。
   * 单 panel 下直接载入活跃 panel，幂等。
   */
  const syncSessionToPanel = core.syncSessionToPanel

  /**
   * selectSession —— 一行代理 core.selectSession（D3/D4，u5.2）。
   *
   * 完整 13 步切入链在 core domain/session/use-session.ts 单点编排（唯一载体）：
   * cancelActiveFlow → switchSession → setActiveId → clearUnread → ensureStreamSubscription →
   * touchRecency → syncSessionToPanel → navigation.push → hydrate/reconcile → preloadFileTree →
   * touchRecency(panel 绑定 session) → evictLru → refreshLiveState（步 13 异步不阻塞链）。
   * renderer 专属步骤经上方 sessionEntry 端口注入；
   * C-W3-4 时序前提（订阅先于 panel 载入，防 snapshot 回放丢失）由 core 链步 5→7 顺序保证。
   */
  const selectSession = core.selectSession

  /**
   * refreshLiveState —— 代理 core（[W2 权威拉取与冷读] 状态层拉取对账入口）。
   *
   * 主路径触发点 = core 13 步切入链步 13（打开视图时机）与本文件 onConnected（重连
   * 时机）；btw 线视图激活点（BtwPanel 选中线）经本出口复用同一入口——线不走
   * selectSession 切入链（drawer 旁路呈现，主会话焦点不变），两件事（缓存缺失门控 +
   * fire-and-forget 语义）由 core 单点保证，壳不另造第二套。
   */
  const refreshLiveState = core.refreshLiveState

  /**
   * restoreSession —— 显式重开 dead session（重新 spawn pi）。
   * 编排对齐 selectSession，但切入 RPC 用 sessionApi.restoreSession（显式重新 spawn，区别于
   * switchSession 的「内存已有则纯切换」语义）替代。壳侧职责收缩为：restore RPC 前置取消 flow
   * （保持取消先于 RPC 的原时序）+ 成功后经 core 13 步链切入 + revive（dead→idle 统一收尾）。
   *
   * 与壳版链的两处已知等价偏差（u5.2 记录）：① core 链步 1 的 cancelActiveFlow 对本路径是
   * no-op 冗余（壳已在 RPC 前取消）；② core 链步 2 会补发一次 switchSession RPC——runtime 对
   * 已存在 session 的 switch 是纯读 + reply（session-message-handler.ts session.switch 分支），
   * 无副作用，代价仅一次往返（紧邻的 getHistory 本就是 RPC）。
   */
  async function restoreSession(id: string): Promise<void> {
    // flow 活跃（landing/overlay）时重开 session → cancelled（AC-3.10，避免 overlay 卡死 + landing 残留）
    const newTaskFlow = useNewTaskFlow()
    if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()

    await sessionApi.restoreSession(id)
    // [T4→D3] respawnPending 过渡态的收尾权归 runtime：restore RPC 成功即走 facade 尾部
    // 三合一出口（msg-pipeline-debloat D3）——respawn 编排上下文命中（失败计数>0 含熔断
    // 态 / 抢占窗口 pending timer / attemptInFlight）时发布 session.restored，帧经恢复窗口
    // 订阅到达驱动收尾（useMessageEffects.handleSessionRestored）。本地 clearRespawnPending
    // 逐条处理完毕（关闭）已删（与根源同缺口的补偿，发布点补齐后为纯噪音）。runtime 重启后编排器状态全
    // 内存即清、三信号构造性 miss 无帧——该场景由下方 revive-on-RPC-reply 收尾（保留件），
    // 30s TTL 兜底过渡态回收。
    // revive 不被切入失败阻断：restore RPC 成功 = runtime 侧 spawn+attach 已完成，revive 语义
    // 是 UI 死态清除，与切入 RPC 成败解耦——不 revive 会留下「进程已恢复、列表仍置灰」的
    // 半完成窗口。切入失败留痕不吞（用户重试本路径时，runtime 对已 spawn session 的二次
    // restore 幂等性未核实，仅 handler 注释称 switch 为纯读——重试行为以 runtime 实装为准）。
    try {
      await core.selectSession(id)
    } catch (e) {
      // 有意降级：切入失败不回滚、不重抛（revive 照常执行，理由见上），但必须用户可见出声——
      // 原路径该错误传播到 onSelectSession 的 toast，本层消化后在此补同 key toast，可见性等价。
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.switchSessionFailed', { msg }))
      console.warn(`[useSidebar.restoreSession] selectSession(${id}) failed after restore:`, e)
    }
    sessionStore.revive(id)
  }

  /**
   * 当前选中 session 的 cwd（新建任务预填，用户裁决 2026-10-22「选中 session 后新建，
   * 默认 cwd = 选中 session 的 cwd」）。必须在 startFlow 之前取：startFlow 内部强制清
   * activeId（core flow.ts 不变量），landing 态再取恒空。
   */
  function activeSessionCwd(): string | undefined {
    // 走未 cast 的 pinia store 实例（activeId 解包为 string | null）——cast 后的 sessionStore
    // 类型层是 core factory 返回形态（activeId 为 Ref，未解包）。
    const id = useSessionStore().activeId
    if (!id) return undefined
    return sessionStore.getList().find((s) => s.id === id)?.cwd
  }

  /**
   * newSession——壳重编排（不代理 core.newSession：壳侧补 cwd 预填链，core 版无此回退）。
   * 预填链（用户裁决 2026-10-22）：入口显式 cwd（目录行「+」）→ 当前选中 session 的 cwd
   * → workspaceStore.defaultCwd。委托 useNewTaskFlow.startFlow 进 landing。
   * 延迟 create 终态：startFlow 恒不建 session（session 由首发提交 submitFirstMessage 创建并
   * 绑定），此处恒进 chat view 让 Panel 渲染 landing 空态，恒返回 null。返回类型保持
   * string | null 对齐 core NewTaskFlowPort 契约形状（当前调用方均不消费返回值）。
   */
  let newTaskInFlight = false
  async function newSession(presetCwd?: string): Promise<string | null> {
    if (newTaskInFlight) return null
    newTaskInFlight = true
    try {
      const newTaskFlow = useNewTaskFlow()
      const fallback = presetCwd ?? activeSessionCwd() ?? workspaceStore.defaultCwd
      await newTaskFlow.startFlow(fallback)
      // 延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
      navigationPort.push({ view: 'chat' })
      return null
    } finally {
      newTaskInFlight = false
    }
  }

  // ── 代理 core 方法（deleteSession/deleteFolder/retryHistory/renameSession/loadSessions）──
  // [D3 接缝债已清偿] deleteSession/deleteFolder 的 wasActive 回退走 core.selectSession——
  // sessionEntry 端口接线后回退路径执行完整 13 步链（含 ensureStreamSubscription），
  // 原「回退后新 session 无流订阅」债务消除。
  const retryHistory = core.retryHistory
  const renameSession = core.renameSession
  // [ai-voice-tts D11] 播放中删除 session 的停播编排：消息与朗读按钮随会话消失后继续播
  // 会失去可见停止入口——例外单例（useTtsPlayer 全局播放态）的 cleanup 走 deleteSession
  // 统一编排惯例（ADR-0049 例外清单登记项），不另设自清理路径。stop 无参（全局单例语义），
  // 与「点击停止」同源复用。
  const deleteSession = async (id: string): Promise<void> => {
    useTtsPlayer().stop()
    await core.deleteSession(id)
  }
  // [ai-voice-tts D11] 删除整个文件夹同理：内含正在播放的 session 时音频会失去可见停止入口
  // stop 无参全局单例语义，播谁停谁，无需逐 session 枚举。
  const deleteFolder = async (id: string): Promise<BatchDeleteResult> => {
    useTtsPlayer().stop()
    return core.deleteFolder(id)
  }
  const loadSessions = core.loadSessions
  // [session-archive D14，u-renderer-entry] 归档发起侧编排代理 core（cleanupSessionState
  // 同族 + wasActive 回退——与 deleteSession 同款；归档后 TTS 停播同 delete 惯例：归档的
  // 恰是正在播放的 session 时，消息与停止入口随行消失）。
  const archiveSession = async (id: string): Promise<void> => {
    useTtsPlayer().stop()
    await core.archiveSession(id)
  }

  /**
   * 归入项目（D14 语义修正 2026-08-04）：RPC 写归属 sidecar + 乐观更新 pinia store。
   * projectId 空串 = 归回默认项目（runtime 删除绑定）。广播 config.sessions 全量覆盖，幂等。
   * 乐观更新写 pinia store（SessionList 数据源）；raw sessionStore 由广播统一刷新。
   */
  async function assignSessionToProject(sessionId: string, projectId: string): Promise<void> {
    await sessionApi.setProject(sessionId, projectId)
    sessionStore.updateProjectId(sessionId, projectId)
  }

  /** 切换折叠态（C）。展开/折叠 toggle，spec §收起态。委托 store 用户意图切换（collapsed 是只读派生，见 stores/sidebar）。 */
  function toggleCollapse(): void {
    sidebar.toggleCollapsed()
  }

  /**
   * 应用启动编排（#1/#3 启动钩子，§6.4②③ 瘦身终态）。
   * 时序：registerAppCommands → 等 project 域首次同步落定（成功或失败均落定——create 归属
   * 读 activeProjectId 做归属预填的时序约束由落定 promise 承载）→ newSession（同步进
   * landing）。recentCwd 预填挂 sessions+workspace 两域首次落定之后（消费内存态、不阻塞
   * 落地页进入；landing 晚到回灌即现状设计形态）。域数据加载（project/sessions/workspace）
   * 由域同步器在连接边沿触发，不在本编排内逐域 await。
   */
  async function initApp(): Promise<void> {
    if (appBootstrapped) return
    appBootstrapped = true
    const newTaskFlow = useNewTaskFlow()
    try {
      registerAppCommands({
        newSession: () => { void newSession() },
      })
      // project 域首次落定后进落地页（§6.4②）：首轮未发起时 whenSettled 即发起（编排先于
      // 边沿 watch 消费的形态序收敛）；失败也落定（失败呈现走 project store 状态机）。
      await whenSettled('project')
      // 同步进 landing（空 chip 态）
      await newSession()
      // 预填 cwd（G1.1「沿用最近 session 目录」）：取 sessionStore.list 中 lastActiveAt 最大
      // 者，无会话时回退 workspaceStore.defaultCwd。挂 sessions+workspace 两域首次落定之后
      // （§6.4③，与现状时序等价：现状即 loadSessions+workspace.load 完成后预填），不阻塞
      // 落地页进入。两落定 promise 设计上永不 reject（失败也落定），allSettled 表达「独立
      // 数据源各自等待」语义。
      void Promise.allSettled([whenSettled('sessions'), whenSettled('workspace')]).then(() => {
        const sessions = sessionStore.getList()
        let recentCwd: string | undefined
        if (sessions.length > 0) {
          const latest = sessions.reduce((a, b) => (a.lastActiveAt >= b.lastActiveAt ? a : b))
          recentCwd = latest.cwd
        }
        if (!recentCwd) recentCwd = workspaceStore.defaultCwd
        if (recentCwd) newTaskFlow.presetCwd(recentCwd)
      })
    } catch (e) {
      console.error('[useSidebar.initApp] bootstrap failed:', e)
      // 复位 appBootstrapped 保留显式重试通道：重调 initApp（如启动失败重试入口）可重新编排。
      // 域数据失败不经此通道（各域失败语义呈现：project 状态条 / sessions 状态条 / workspace
      // 留痕），catch 只兜 initApp 自身编排错误（注册命令、落地页进入）。
      appBootstrapped = false
      // 失败必须用户可见：无提示时用户看到空 landing 无法区分「加载中」与「失败」。
      // 恢复动作 = 刷新页面重试（无运行时内自动重试，符合任务级默认无超时/无自动重试约定）。
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('app.bootstrapFailed', { msg }))
    }
  }

  // ── 连接边沿域同步器登记（connection-datasync-ssot §6.4）──
  // 数据域三元组 {同步函数, 何时需要同步, 失败语义} + 辅助刷新层，替代「initApp 一次性
  // 编排 + onConnected 重连分支逐域手写刷新」两套编排。登记幂等（同 id 覆盖描述符、保留
  // 同步进度），本段在 useSidebar() 装配时执行——早于首连 connected 边沿（App.vue setup 内
  // useSidebar() 先于其 connectionState watch），首连边沿即可触发首轮同步。
  registerDataDomain({
    // project 域（阻断型，拦截型接线）：failed、实例变更、任何重连边沿都重拉（§6.4）——
    // failed 恢复与实例变更必经连接边沿，恒真谓词即全量覆盖。sync 只拉取（状态机转移
    // 在 store.syncLoad 内：进 loading、失败转 failed 后 rethrow 交本模块留痕）；apply
    // 由本模块在代次/revision 两道裁决通过后调用（loading→loaded 提交回执）——「失败
    // 保留旧值」「旧代/过时 revision 回执不提交」构造性成立（§6.4 命令×同步交错：
    // 在途 load 期间命令回执先提交时，旧快照按 isStaleReceipt 判旧丢弃 + 丢弃点补发，
    // 不回滚命令结果）。首次落定 promise 成功与失败均 settle（落地页只等落定不等成功）。
    id: 'project',
    sync: () => useProjectStore().syncLoad(),
    apply: (receipt) => useProjectStore().applyLoadReceipt(receipt),
    isStaleReceipt: (receipt) => useProjectStore().isStaleLoadReceipt(receipt),
    whenToSync: () => true,
    failure: 'blocking',
  })
  registerDataDomain({
    // sessions 域（重试型）：每次连接边沿重拉；loadSessions 失败在 store 内 setListLoadError
    //（侧栏「加载失败，点击重试」承载），不抛。
    id: 'sessions',
    sync: () => loadSessions(),
    whenToSync: () => true,
    failure: 'retryable',
  })
  registerDataDomain({
    // workspace 域（降级型）：每次连接边沿重拉；load 失败保留旧 records（§6.4 降级型显式
    // 行为改进，原置空口径已废）+ loadDefaultSessionDir 失败降级空串——两个数据源均不抛，
    // 串行提交（幂等拉取，重连后默认目录可能刷新，§6.4③）。
    id: 'workspace',
    sync: async () => {
      const ws = useWorkspaceStore()
      await ws.load()
      await ws.loadDefaultSessionDir()
    },
    whenToSync: () => true,
    failure: 'degraded',
  })
  // project.changed 失效信号消费（§6.6：事件只作失效信号不带数据——各窗口收到后触发
  // project 域重新拉取，拉为主、推补充 ADR-0097；重拉撞在途 load 由域同步器并发合流，
  // 命令×同步交错由 isStaleReceipt 判据处置）。域同步器是模块级单例，本监听是全局单例
  // 消费——handler 取模块级稳定引用，onGlobalType 底层 Set 按引用去重，多组件实例化
  // useSidebar 重复注册幂等、不随组件卸载退订（与装配段域登记同生命周期）。
  transportEvents.onGlobalType('project.changed', onProjectChanged)
  // 辅助刷新 5 处（原 onConnected 重连分支零散调用）：纳入统一触发点，各自保留 catch 降级
  // 语义。聚焦 session 四项在触发时读当前焦点（首连时无焦点 = null，跳过——与原 `if (sid)`
  // 保护一致）。
  registerAuxiliaryRefresh({
    label: 'extension-scan',
    refresh: () =>
      extensionApi.scan().catch((e) => console.warn('[useSidebar] extension scan on reconnect failed:', e)),
  })
  registerAuxiliaryRefresh({
    label: 'focused-subagents',
    refresh: () => {
      const sid = focusedSessionId.value
      if (sid) void useSubagentStore().loadSubagents(sid)
    },
  })
  registerAuxiliaryRefresh({
    label: 'focused-workflows',
    refresh: () => {
      const sid = focusedSessionId.value
      if (sid) void useWorkflowStore().loadWorkflows(sid)
    },
  })
  registerAuxiliaryRefresh({
    label: 'focused-live-state',
    refresh: () => {
      const sid = focusedSessionId.value
      if (sid) void core.refreshLiveState(sid)
    },
  })
  registerAuxiliaryRefresh({
    label: 'focused-history',
    refresh: () => {
      const sid = focusedSessionId.value
      if (sid) void core.refreshHistory(sid)
    },
  })
  ensureConnectionEdgeSync()

  /**
   * WS 连接建立/重连入口：首连触发启动编排 initApp；重连边沿的数据刷新全部由域同步器
   * 承载（§6.4：首连与重连同一路径，本入口收敛为启动编排的触发壳——App.vue connected
   * watch 的消费点不变，重连时 initApp 幂等跳过）。
   */
  async function onConnected(): Promise<void> {
    await initApp()
  }

  // ── fork/handoff：保持 useForkActions/useHandoffActions 组合（C-W5-4，正交职责内聚）──
  const {
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
  } = useForkActions(focusedSessionId)
  const {
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  } = useHandoffActions(focusedSessionId)

  return {
    focusedSessionId,
    focusedSession,
    selectSession,
    restoreSession,
    refreshLiveState,
    newSession,
    retryHistory,
    loadSessions,
    initApp,
    onConnected,
    toggleCollapse,
    syncSessionToPanel,
    renameSession,
    deleteSession,
    archiveSession,
    deleteFolder,
    assignSessionToProject,
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  }
}

// ── 底部 import（循环 import 防避，保留原位勿上移）──
// useSideDrawer/useSessionStore/useProjectStore 按调用点时机惰性实例化（openPanel /
// ensureStreamSubscription / initApp 回调内直调），不在 useSidebar setup 顶层调用
//（避免测试时无 pinia 报错）。
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { useSessionStore } from '@/stores/session'
import { useProjectStore } from '@/stores/project'
