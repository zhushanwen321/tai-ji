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
 * 未来替换挂载实现：P4 挂载实际以 core bootstrap.ts 的 registerMountPoints 五挂载点注册表
 * 落地（sidebar.tab / panel.header / composer.toolbar / statusbar / modal，无 'sessions' 挂载点）；

 * 如需替换挂载实现，走该注册表（packages/core/src/bootstrap.ts），勿另起壳侧入口。
 */
import type { ComputedRef } from 'vue'
import type { BatchDeleteResult, SessionSummary } from '@taiji/shared'
import {
  createSessionStore,
  createUseSession,
  resetSessionListSubForTest,
} from '@taiji/core'
import type {
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
// [M4-a / btw-question D4 消费面①] deleteSession 级联的前端腿：枚举/处置/清映射三函数
//（与 m7/agentcall 的 evictVirtualKeys 先例同构，登记结构在 useBtwTabData）。
import { getBtwVirtualIdsByMain, clearBtwVirtualKeyMapping, disposeBtwLinePartitions } from '@/composables/panel/useBtwTabData'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChat, ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { useTtsPlayer } from '@/composables/features/chat/useTtsPlayer'
import { invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { browserDestroy as browserDestroyIpc } from '@/lib/ipc'
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

// ── App 启动编排幂等守卫 ──
let appBootstrapped = false
let hasConnectedBefore = false

/** 测试隔离：重置启动编排守卫 + session.list 订阅计数（beforeEach 调）。 */
export function resetAppBootstrap(): void {
  appBootstrapped = false
  hasConnectedBefore = false
  resetSessionListSubForTest()
}

/**
 * 测试后门命名空间（生产代码禁止消费，对齐 useExtensionHostBridge / app-runtime __testing
 * 先例）：装配检查断言入口——sessionEntry 端口束原始注入面（composable 内构造，useSidebar()
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
      // [M4-a / btw-question D4 消费面① + D9④ 清派生键] deleteSession 级联的前端腿：
      // **枚举先于清映射**（顺序约束）——主会话名下全部 btw 线逐线处置（vid 分区 +
      // 派生 subagent/agentcall 键 + 两 store 记录分区，单入口幂等），随后清反查表
      //（主已删，映射无意义）。runtime 半边（杀线进程 + 删线目录）在 session-lifecycle
      // 的级联支线；失效腿（闲置回收/进程亡）不进本路径——分区保留待重载链回填（D9④）。
      for (const btwVid of getBtwVirtualIdsByMain(sid)) disposeBtwLinePartitions(btwVid)
      clearBtwVirtualKeyMapping(sid)
    },
    clearAgentCallMapping: (sid) => useWorkflowStore().clearAgentCallMapping(sid),
    // [投递所有权内核 u3c / ADR-0049 范围修订] 队列区 per-session 分区的销毁编排**收窄**：
    // 旧 defer 队列（useCompactQueue 经 useSessionScopedState 注册的 registerSessionCleanup）
    // 已随其退役从编排清单消失；现役队列状态 = 内核 session.delivery 投影，清理点在 core
    // useChat.disposeSession 内（clearDeliveryProjection），随本 hook 一并执行——「session
    // 销毁唯一编排点」仍是 deleteSession → triggerSessionCleanups → 本 hooks，renderer 侧
    // 不再多注册一个分区清理项。
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
  // 适配映射：cancelActiveFlow←useNewTaskFlow / clearUnread←clearSessionUnread（两源同点：
  // useSessionMarkers + useForkBranchNotify 分支角标，D9 合流） /
  // ensureStreamSubscription←useChat 壳包装（(sid, chat, sessionStore) 签名收窄为 (sid)）/
  // touchRecency+evictLru←chat store LRU / preloadFileTree←useFileTree。
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
    // panelSessionId 由 core 链在步 11 已完成 recency 刷新后透传；壳实现执行驱逐本体即可
    evictLru: () => chat.evictIfNeeded(),
  }
  // [remote-use D9/U21] 装配检查断言源填充（见模块级 __testing 注释；非消费，仅出口登记）
  __testing.sessionEntry = sessionEntry

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
    // [T4→D3] respawnPending 过渡态的收口权归 runtime：restore RPC 成功即走 facade 尾部
    // 三合一出口（msg-pipeline-debloat D3）——respawn 编排上下文命中（失败计数>0 含熔断
    // 态 / 抢占窗口 pending timer / attemptInFlight）时发布 session.restored，帧经恢复窗口
    // 订阅到达驱动收口（useMessageEffects.handleSessionRestored）。本地 clearRespawnPending
    // 清账已删（与根源同缺口的补偿，发布点补齐后为纯噪音）。runtime 重启后编排器状态全
    // 内存即清、三信号构造性 miss 无帧——该场景由下方 revive-on-RPC-reply 收口（保留件），
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
   * newSession——壳重编排（不代理 core.newSession：壳侧补 presetCwd ?? workspaceStore.defaultCwd
   * 兜底，core 版无此回退）。委托 useNewTaskFlow.startFlow 进 landing。
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
      const fallback = presetCwd ?? workspaceStore.defaultCwd
      await newTaskFlow.startFlow(fallback)
      // 延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
      navigationPort.push({ view: 'chat' })
      return null
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
  // [ai-voice-tts D11] 播放中删除 session 的停播编排：消息与朗读按钮随会话消失后继续播
  // 会失去可见停止入口——例外单例（useTtsPlayer 全局播放态）的 cleanup 走 deleteSession
  // 统一编排惯例（ADR-0049 例外清单登记项），不另设自清理路径。stop 无参（全局单例语义），
  // 与「点击停止」同源复用。
  const deleteSession = async (id: string): Promise<void> => {
    useTtsPlayer().stop()
    await core.deleteSession(id)
  }
  // [ai-voice-tts D11] 删除整个文件夹同理：内含正在播放的 session 时音频会失去可见停止入口
  //（D5 终态同步 F1-21 补齐）——stop 无参全局单例语义，播谁停谁，无需逐 session 枚举。
  const deleteFolder = async (id: string): Promise<BatchDeleteResult> => {
    useTtsPlayer().stop()
    return core.deleteFolder(id)
  }
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
      })
      // D14（2026-08-04）：project 列表迁 runtime 持久化。init 必须在 newSession 之前——
      // createSessionFlow 读 activeProjectId 做归属透传，未 init 时 active 是默认项目（归属丢失）。
      // init 内部 RPC 失败降级默认，不抛不阻断启动。
      await useProjectStore().init()
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
      // 复位 appBootstrapped 保留显式重试通道：重调 initApp（如启动失败重试入口）可重新编排；
      // 生产常规路径首连失败后走 onConnected 重连刷新支，不会自动回到 initApp。
      appBootstrapped = false
      // 失败必须用户可见：无提示时用户面对空 landing 无法区分「加载中」与「失败」。
      // 恢复动作 = 刷新页面重试（无运行时内自动重试，符合任务级默认无超时/无自动重试约定）。
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('app.bootstrapFailed', { msg }))
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
    // 重连扩展扫描是辅助刷新（A 类降级），失败降级为 stale 数据——必须留痕，与「扫描成功」可区分
    void extensionApi.scan().catch((e) => console.warn('[useSidebar] extension scan on reconnect failed:', e))
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
    newSession,
    retryHistory,
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

// ── 底部 import（循环 import 防避，保留原位勿上移）──
// useSideDrawer/useSessionStore/useProjectStore 按调用点时机惰性实例化（openPanel /
// ensureStreamSubscription / initApp 回调内直调），不在 useSidebar setup 顶层调用
//（避免测试时无 pinia 报错）。
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { useSessionStore } from '@/stores/session'
import { useProjectStore } from '@/stores/project'
