/**
 * useSidebar —— sidebar 业务编排（R2 features 层，session-sidebar 域 P3 绞杀终态）。
 *
 * 这是「唯一跨 api + stores 的层」（R2 铁律 1）：包装 core createUseSession（w3）+ 注入
 * 端口适配（SessionApiPort/PanelOrchestrationPort/NavigationPort/ChatHydratePort/
 * SessionCleanupHooks/NewTaskFlowPort + selectSessionFallback 回退端口）+ renderer 专属编排。
 * 2026-08-31 双轨收尾：旧 useSidebar（自持全量编排版）删除，本文件由 useSidebar.ts
 * 重命名接管原名（C-W5-4 消费方切换完成），返回签名与旧版对齐 + 超集（restoreSession/
 * assignSessionToProject）。
 *
 * 关键裁决：
 * - C-W5-1 → [HISTORICAL]（renderer-deepening D3/D4 推翻，u5.2）：selectSession 曾壳重编排
 *   （理由「core.selectSession 是闭合函数，renderer 步骤无法插入」）——u5.1 起 core 持完整
 *   12 步切入链 + sessionEntry 端口束，renderer 专属步骤（取消 flow/清未读/流订阅/LRU/文件树）
 *   经端口注入。壳 selectSession 现为一行代理 core.selectSession，链唯一载体在
 *   core domain/session/use-session.ts（改时序只改那一处，12 步顺序有接口级断言）。
 *   deleteSession/deleteFolder 的 wasActive 回退原「缺 ensureStreamSubscription」接缝债随之闭合
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
 * 未来替换挂载实现：P4 挂载实际以 core bootstrap.ts 的 registerMountPoints 四挂载点注册表
 * 落地（sidebar.tab / panel.header / composer.toolbar / statusbar，无 'sessions' 挂载点）；
 * 如需替换挂载实现，走该注册表（packages/core/src/bootstrap.ts），勿另起壳侧入口。
 */
import type { ComputedRef } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import {
  createSessionStore,
  createUseSession,
  resetSessionListSubForTest,
} from '@xyz-agent/core'
import type {
  SessionApiPort,
  PanelOrchestrationPort,
  ChatHydratePort,
  NavigationPort,
  SessionCleanupHooks,
  NewTaskFlowPort,
  SessionEntryPort,
} from '@xyz-agent/core'
import { chat as chatApi, session as sessionApi, extension as extensionApi } from '@/api'
import { buildSessionApiPort } from '@/api/session-api-port'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChat, ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { browserDestroy as browserDestroyIpc } from '@/lib/ipc'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useForkNoticeFeed } from '@/composables/effects/useForkNoticeEffect'
import { clearUnread } from '@/composables/useSessionMarkers'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { registerAppCommands } from '@/composables/features/command/useAppCommands'
import { useForkActions } from '@/composables/features/fork-handoff/useForkActions'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import type { NavEntry } from '@/types'

// ── App 启动编排幂等守卫 ──
let appBootstrapped = false
let hasConnectedBefore = false

/** 测试隔离：重置启动编排守卫 + session.list 订阅计数（beforeEach 调）。 */
export function resetAppBootstrap(): void {
  appBootstrapped = false
  hasConnectedBefore = false
  resetSessionListSubForTest()
}

export function useSidebar() {
  const navigation = useNavigationStore()
  const chat = useChatStore()
  const sidebar = useSidebarStore()
  const panel = usePanelStore()
  const workspaceStore = useWorkspaceStore()

  // ── 端口适配层（core 定义接口、壳注入 renderer 实现）──
  const api: SessionApiPort = buildSessionApiPort()

  const panelPort: PanelOrchestrationPort = {
    focusedSessionId: () => panel.focusedSessionId,
    activePanelId: () => panel.activePanelId,
    findPanelBySession: (sid) => panel.findPanelBySession(sid),
    loadSession: (panelId, sid) => panel.loadSession(panelId, sid),
    // [P4 s5 drawer-widget-removal] tasks drawer 分支已删（tasks tab 移除），统一 open sideDrawer
    openPanel: (sid) => {
      const { open } = useSideDrawerSafe()
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
    reconcileHistory: (sid, messages, window) => chat.reconcileHistory(sid, messages, window),
    clearHistoryError: (sid) => chat.clearHistoryError(sid),
    markHistoryFailed: (sid) => chat.markHistoryFailed(sid),
  }

  const hooks: SessionCleanupHooks = {
    // [U7] clearBoundPanelOverlays 已随 overlay 移除从 SessionCleanupHooks 接口删除。
    clearFileTree: (sid) => useFileTreeStore().clearSession(sid),
    clearSubagent: (sid) => useSubagentStore().clearSession(sid),
    clearWorkflow: (sid) => useWorkflowStore().clearSession(sid),
    clearExtensionUI: (sid) => useExtensionUIStore().clearSession(sid),
    // M1-03：extension-host 三处 scoped map 分区（ViewHostStore/StatusBarController/OverlayLifecycle）
    // 只订阅 session-destroyed bus 事件（该事件无生产者），经 bus 显式 emit 触发分区 cleanup
    clearExtensionHost: (sid) => getExtensionBus().emit({ kind: 'session-destroyed', sessionId: sid }),
    evictChat: (sid) => chat.evictSessionWithVirtual(sid),
    // [U7] clearSubagentTombstones 已随 overlay tombstone 移除从接口删除。
    evictVirtualKeys: (sid) => {
      const workflowStore = useWorkflowStore()
      for (const acsVirtualId of workflowStore.getAgentCallVirtualIdsByMain(sid)) {
        chat.evictVirtualKey(acsVirtualId)
      }
    },
    clearAgentCallMapping: (sid) => useWorkflowStore().clearAgentCallMapping(sid),
    disposeChat: (sid) => useChat().disposeSession(sid),
    invalidateStatus: (sid) => invalidateStatusCache(sid),
    // [B4 / 2026-09-14 内存审计 §2.1] main 侧 WebContentsView 销毁接线：browserDestroy IPC
    // fire-and-forget——preload invoke 透传 rejection，显式 .catch(console.warn 级) 消化，
    // 防 unhandledrejection 上报 error-reporter；失败仅降级为 view 驻留至 LRU 挤出（best-effort）。
    browserDestroy: (sid) => {
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
    clearForkNotices: (sid) => useForkNoticeFeed().clearSession(sid),
  }

  const flow: NewTaskFlowPort = {
    startFlow: (presetCwd) => useNewTaskFlow().startFlow(presetCwd),
    currentSession: () => useNewTaskFlow().currentSession.value,
  }

  // ── sessionEntry 端口束接线（D3，u5.2）：切入链跨域步骤注入 core 12 步链 ──
  // 时序不变量（含 C-W3-4「订阅先于 panel 载入」）由 core 链本体保证，实现侧无需关心顺序；
  // 适配映射：cancelActiveFlow←useNewTaskFlow / clearUnread←useSessionMarkers /
  // ensureStreamSubscription←useChat 壳包装（(sid, chat, sessionStore) 签名收窄为 (sid)）/
  // touchRecency+evictLru←chat store LRU / preloadFileTree←useFileTree。
  const sessionEntry: SessionEntryPort = {
    cancelActiveFlow: () => {
      const newTaskFlow = useNewTaskFlow()
      if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()
    },
    clearUnread: (sid) => clearUnread(sid),
    ensureStreamSubscription: (sid) =>
      ensureStreamSubscription(sid, chat, useSessionStoreSafe()),
    touchRecency: (sid) => chat.touchLru(sid),
    preloadFileTree: (sid) => {
      void useFileTree().loadTree(sid)
    },
    // panelSessionId 由 core 链在步 11 已完成 recency 刷新后透传；壳实现执行驱逐本体即可
    evictLru: () => chat.evictIfNeeded(),
  }

  // ── sessionStore：pinia useSessionStore cast 成 core factory 类型（ADR-0059 cast 接缝）──
  // pinia setup store unwrap ref（外部拿值非 ref），与 core createSessionStore 返回的 ref 类型不兼容。
  // cast 是 pinia + core factory 结合的固有类型鸿沟（ADR-0059 决策 3）。createUseSession 内部经方法
  // 访问（getActiveId/setActiveId/getList），方法闭包持原始 ref，pinia/raw 双模式下都正常工作。
  const sessionStore = useSessionStore() as unknown as ReturnType<typeof createSessionStore>

  // ── core createUseSession（12 步切入链唯一载体；sessionEntry 接线后全链生效）──
  const core = createUseSession({
    store: sessionStore,
    api,
    panel: panelPort,
    navigation: navigationPort,
    chat: chatPort,
    hooks,
    flow,
    sessionEntry,
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
   * 完整 12 步切入链在 core domain/session/use-session.ts 单点编排（唯一载体）：
   * cancelActiveFlow → switchSession → setActiveId → clearUnread → ensureStreamSubscription →
   * touchRecency → syncSessionToPanel → navigation.push → hydrate/reconcile → preloadFileTree →
   * touchRecency(panel 绑定 session) → evictLru。renderer 专属步骤经上方 sessionEntry 端口注入；
   * C-W3-4 时序前提（订阅先于 panel 载入，防 snapshot 回放丢失）由 core 链步 5→7 顺序保证。
   */
  const selectSession = core.selectSession

  /**
   * restoreSession —— 显式重开 dead session（重新 spawn pi）。
   * 编排对齐 selectSession，但切入 RPC 用 sessionApi.restoreSession（显式重新 spawn，区别于
   * switchSession 的「内存已有则纯切换」语义）替代。壳侧职责收缩为：restore RPC 前置取消 flow
   * （保持取消先于 RPC 的原时序）+ 成功后经 core 12 步链切入 + revive（dead→idle 统一收口）。
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
    // [T4] restore RPC 成功 = 恢复事实已发生（runtime 侧 spawn+attach 完成），即收口
    // respawnPending 过渡态（恢复窗口内用户点了「重新打开」走手动 restore——手动路径
    // runtime 不再 publish session.restored，此清理是过渡态在该路径的唯一出口；清在
    // selectSession 之前，UI 切入失败也不留过渡条干等超时）。超时 timer 到期查
    // isRespawnPending no-op 自清，无需跨模块卸载。
    useChatStore().clearRespawnPending(id)
    await core.selectSession(id)
    sessionStore.revive(id)
  }

  /**
   * newSession——壳重编排（不代理 core.newSession：壳侧补 presetCwd ?? workspaceStore.defaultCwd
   * 兜底，core 版无此回退）。委托 useNewTaskFlow.startFlow + selectSession（core 12 步链）载入。
   * 返回新 id；延迟 create 返回 null。
   */
  let newTaskInFlight = false
  async function newSession(presetCwd?: string): Promise<string | null> {
    if (newTaskInFlight) return null
    newTaskInFlight = true
    try {
      const newTaskFlow = useNewTaskFlow()
      const fallback = presetCwd ?? workspaceStore.defaultCwd
      await newTaskFlow.startFlow(fallback)
      const created = newTaskFlow.currentSession.value
      if (!created) {
        // 首次启动延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
        navigationPort.push({ view: 'chat' })
        return null
      }
      // startFlow 已 appendSession + activeId=created.id；此处补 panel 载入 + history hydrate
      await selectSession(created.id)
      return created.id
    } finally {
      newTaskInFlight = false
    }
  }

  // ── 代理 core 方法（deleteSession/deleteFolder/retryHistory/renameSession/loadSessions）──
  // [D3 接缝债已闭合] deleteSession/deleteFolder 的 wasActive 回退走 core.selectSession——
  // sessionEntry 端口接线后回退路径执行完整 12 步链（含 ensureStreamSubscription），
  // 原「回退后新 session 无流订阅」债务消除。
  const retryHistory = core.retryHistory
  const renameSession = core.renameSession
  const deleteSession = core.deleteSession
  const deleteFolder = core.deleteFolder
  const loadSessions = core.loadSessions

  /**
   * 归入项目（D14 语义修正 2026-08-04）：RPC 写归属 sidecar + 乐观更新 pinia store。
   * projectId 空串 = 归回默认项目（runtime 删除绑定）。广播 config.sessions 全量覆盖，幂等。
   * 乐观更新写 pinia store（SessionList 数据源）；raw sessionStore 由广播统一刷新。
   */
  async function assignSessionToProject(sessionId: string, projectId: string): Promise<void> {
    await sessionApi.setProject(sessionId, projectId)
    sessionStore.updateProjectId(sessionId, projectId)
  }

  /** 进入 Overview：push view:'overview'（ADR-0023，sidebar 持久，main 被覆盖） */
  function goOverview(): void {
    navigation.push({ view: 'overview' })
  }

  /** 切换折叠态（C）。展开/折叠 toggle，spec §收起态。 */
  function toggleCollapse(): void {
    sidebar.collapsed = !sidebar.collapsed
  }

  /**
   * 应用启动编排（#1/#3 启动钩子）：永远进入新建任务落地页。
   * 时序：registerAppCommands → projectStore.init（D14：create 归属读 activeProjectId，必须最前）
   * → newSession（同步进 landing）→ loadSessions → workspaceStore.load → presetCwd。
   */
  async function initApp(): Promise<void> {
    if (appBootstrapped) return
    appBootstrapped = true
    const newTaskFlow = useNewTaskFlow()
    try {
      registerAppCommands({
        newSession: () => { void newSession() },
        goOverview,
      })
      // D14（2026-08-04）：project 列表迁 runtime 持久化。init 必须在 newSession 之前——
      // createSessionFlow 读 activeProjectId 做归属透传，未 init 时 active 是默认项目（归属丢失）。
      // init 内部 RPC 失败降级默认，不抛不阻断启动。
      await useProjectStoreSafe().init()
      // 同步进 landing（空 chip 态），必须先于 await loadSessions（消除 state=idle 启动窗口）
      await newSession()
      await loadSessions()
      await workspaceStore.load()
      // 预填 cwd（G1.1「沿用最近 session 目录」）：取 sessionStore.list 中 lastActiveAt 最大者
      const sessions = sessionStore.getList()
      let recentCwd: string | undefined
      if (sessions.length > 0) {
        const latest = sessions.reduce((a, b) => (a.lastActiveAt >= b.lastActiveAt ? a : b))
        recentCwd = latest.cwd
      }
      if (!recentCwd) recentCwd = workspaceStore.defaultCwd
      if (recentCwd) newTaskFlow.presetCwd(recentCwd)
    } catch (e) {
      console.error('[useSidebar.initApp] bootstrap failed:', e)
      appBootstrapped = false
    }
  }

  /**
   * WS 连接建立/重连入口：首次 initApp；重连 fire-and-forget 刷新 workspace/extension +
   * 聚焦 session 的 subagent/workflow 列表。
   */
  async function onConnected(): Promise<void> {
    if (!hasConnectedBefore) {
      hasConnectedBefore = true
      await initApp()
      return
    }
    void workspaceStore.load()
    void extensionApi.scan().catch(() => {})
    // 重连对账（residual-fixes 附录 A-3 闭环）：runtime 侧派生缓存的刷新以 entry_appended
    // 事件为触发，重连后若无新 entry 写入（如断连前 subagent 已全部终态），侧栏将停留
    // 断连前 stale 数据直到用户切 tab。对聚焦 session 显式重拉（getSubagents/getWorkflows
    // RPC 直读磁盘，不依赖缓存事件）。load 内部 catch 降级（失败保留旧分区），
    // fire-and-forget 与上面两条刷新一致。
    const sid = focusedSessionId.value
    if (sid) {
      void useSubagentStore().loadSubagents(sid)
      void useWorkflowStore().loadWorkflows(sid)
    }
  }

  // ── fork/handoff：保持 useForkActions/useHandoffActions 组合（C-W5-4，正交职责内聚）──
  const {
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
  } = useForkActions(focusedSessionId as ComputedRef<string | null>)
  const {
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  } = useHandoffActions(focusedSessionId as ComputedRef<string | null>)

  return {
    focusedSessionId,
    focusedSession,
    selectSession,
    restoreSession,
    newSession,
    retryHistory,
    goOverview,
    loadSessions,
    initApp,
    onConnected,
    toggleCollapse,
    syncSessionToPanel,
    renameSession,
    deleteSession,
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

// ── 延迟 store 获取 helper（避免循环 import + 仅在需要时实例化）──
// useSideDrawer/useSessionStore 在 selectSession/openPanel 路径按需获取，不在 setup 顶层
//（避免测试时无 pinia 报错）。
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { useSessionStore } from '@/stores/session'
import { useProjectStore } from '@/stores/project'

function useSideDrawerSafe(): ReturnType<typeof useSideDrawer> {
  return useSideDrawer()
}
function useSessionStoreSafe(): ReturnType<typeof useSessionStore> {
  return useSessionStore()
}
function useProjectStoreSafe(): ReturnType<typeof useProjectStore> {
  return useProjectStore()
}
