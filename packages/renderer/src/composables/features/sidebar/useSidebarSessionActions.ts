/**
 * useSidebarSessionActions —— Sidebar session 操作 handler 集合（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：session 选择/新建/重命名/删除 + folder 删除 + 软停止（abort） + 强制退出 + 列表重试
 * + SearchModal 接线（searchDeps/onOpenSearchDrawer，复用 selectSession/newSession
 * 注入）的事件处理。跨 store 编排（chat abort / 队列回收）在此层完成。
 *
 * [2026-09-16 侧栏任务 tab 退役] 原 subagent/workflow 列表 retry handler
 * （onRetrySubagents/onRetryWorkflows）与随之的 subagent/workflow store 依赖已删除——
 * 两列表的挂载面（Agents/Flows tab）退役后无调用方，列表重拉腿现归 composer 任务托盘
 * （useTrayCounts 的 retry + watch(sessionId) 首拉）。
 *
 * 依赖注入说明：useSidebar 的方法（selectSession/newSession/loadSessions/renameSession/
 * deleteSession/deleteFolder）由调用方注入——useSidebar 非单例（每次调用
 * createSessionStore + createUseSession 新建实例），不能在本 composable 内重复调用。
 * renameOpen/targetSessionId 是 RenameSessionDialog 的本地 UI ref，由 Sidebar.vue 创建并注入，
 * onRenameSession 设置这两个 ref 打开 dialog。useChat/useToast/useI18n/useSearchModalDeps/
 * useSideDrawer 为单例/无状态 composable，内部安全调用。
 */
import type { Ref } from 'vue'
import { useChat } from '@/composables/features/chat/useChat'
import { session as sessionApi } from '@/api'
import { delivery } from '@/api/domains/delivery'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { useSearchModalDeps } from '@/composables/features/search/useSearchModalDeps'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import { markForcedExit, consumeForcedExit } from '@/composables/effects/forced-exit-marks'
import { useI18n } from 'vue-i18n'

/** useSidebarSessionActions 所需的注入依赖（来自 useSidebar + Sidebar.vue 本地 UI ref） */
export interface UseSidebarSessionActionsOptions {
  selectSession: (id: string) => Promise<void>
  /** dead session 重开（显式 restore RPC），sidebar 点击 dead session 时分流到此 */
  restoreSession: (id: string) => Promise<void>
  newSession: (cwd?: string) => Promise<string | null>
  loadSessions: () => void
  renameSession: (id: string, label: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  deleteFolder: (cwd: string) => Promise<{ failed: Array<{ error?: string }> }>
  /** 归入项目（D14 语义修正，2026-08-04）：RPC + 乐观更新编排在 useSidebar。 */
  assignSessionToProject: (sessionId: string, projectId: string) => Promise<void>
  /** RenameSessionDialog 开关 ref（Sidebar.vue 本地 UI 状态） */
  renameOpen: Ref<boolean>
  /** RenameSessionDialog 目标 session ref（Sidebar.vue 本地 UI 状态） */
  targetSessionId: Ref<string>
}

export function useSidebarSessionActions(options: UseSidebarSessionActionsOptions) {
  const {
    selectSession,
    restoreSession,
    newSession,
    loadSessions,
    renameSession,
    deleteSession,
    deleteFolder,
    assignSessionToProject,
    renameOpen,
    targetSessionId,
  } = options
  const { t } = useI18n()
  const { error: toastError, info: toastInfo } = useToast()
  const { abort: abortSession } = useChat()

  async function onSelectSession(id: string): Promise<void> {
    try {
      // dead session → 显式 restore（重新 spawn pi + revive 统一在 useSidebar.restoreSession）；
      // 非 dead → 常规切换。useSessionStore 是 pinia store，可在非 setup 上下文调用。
      const isDead = useSessionStore().list.find((s) => s.id === id)?.status === 'dead'
      if (isDead) {
        await restoreSession(id)
      } else {
        await selectSession(id)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.switchSessionFailed', { msg }))
    }
  }

  async function onNewSession(): Promise<void> {
    try {
      await newSession()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.newTaskFailed', { msg }))
    }
  }

  async function onRenameSession(id: string): Promise<void> {
    targetSessionId.value = id
    renameOpen.value = true
  }

  async function onDeleteSession(id: string): Promise<void> {
    try {
      await deleteSession(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.deleteSessionFailed', { msg }))
    }
  }

  /** 目录行「+」：以该目录为预选 cwd 进 landing（延迟 create，session 由首发提交创建） */
  async function onNewSessionInFolder(cwd: string): Promise<void> {
    try {
      await newSession(cwd)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.newTaskFailed', { msg }))
    }
  }

  /** 删除指定 cwd 下所有 session（folder 批量删除）。部分失败 toast 带 error；全成功不提示。 */
  async function onDeleteFolder(cwd: string): Promise<void> {
    try {
      const res = await deleteFolder(cwd)
      if (res.failed.length > 0) {
        const firstError = res.failed[0]?.error ?? ''
        toastError(
          t('sidebar.deleteFolderPartialFailed', res.failed.length, {
            named: { count: res.failed.length, error: firstError },
          }),
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.deleteFolderFailed', { msg }))
    }
  }

  /** 停止运行中的 session（软停止）：SessionItem 右键菜单两段确认后 emit abort。
   *  与 onForceQuitSession（硬杀 pi → dead）区分：abort 只中止当前生成，会话转 stopped 可 restore。 */
  function onAbortSession(id: string): void {
    void abortSession(id)
  }

  /**
   * 强制退出卡死 session（SessionItem 右键两段确认后）：杀 pi 进程 + stopped 收敛。
   * 成功后的 UI 收敛不在此处：终态经 session.exited 广播由 useMessageEffects.handleSessionExited
   * 统一处理（markDead 置灰 + 错误消息入流 + toast），之后点击 dead session 走 restore 重开。
   * 失败（RPC error envelope）toast；session 不在活跃进程表时 runtime 幂等成功。
   *
   * [T4] RPC 前置强制退出意图标记：session.exited 帧对意外崩溃（runtime 自动 respawn →
   * renderer 过渡态）与本路径（runtime 构造性不 respawn → 终态 dead 页）不可区分，靠
   * renderer 本地标记分流（forced-exit-marks，读后即清）。RPC 失败撤销标记，防残留把
   * 该 session 下次意外崩溃误判为强制退出。
   * [投递所有权内核 u3c / D10] forceQuit = 全量回收（abort **不**取消队列——两条语义显式分离，
   * 见设计 D10）：成功后 delivery.drain 回收内核全部未送达条目（queued + 投递中），文本经
   * composer injection 一次性通道写回 Composer 草稿（insertTextAtCursor 追加语义，不覆盖用户
   * 正在输入的内容；多条按序 '\n\n' 拼接）。
   * 时序：RPC reply 前 session.exited 已按 WS FIFO 到达并 markDead → dead 占位接管、Composer
   * 已卸载 → 注入请求滞留槽位，用户点击 dead session 走 restore 重开后由 useComposerInjection
   * 的 onMounted 遗留请求补消费（草稿可见、可改、可一键重发）。
   * [F-U2] 槽位是单值覆盖通道（forceQuit 后、restore 前任何其他注入都会覆盖），回收侧写入前
   * 读槽位现状做 '\n\n' 累积追加，防止 toast 已宣称「已收回草稿」的文本被后续注入静默吞掉。
 * toast 一条「N 条排队消息已收回草稿」（N=实际收回的非空条目数，0 不提示）；drain RPC 失败
 * 必须出声（回收文本不可再生，静默失败 = 故事 A 的丢失形态）；条目内容为空的同样出声计入
 * 失败（写不回草稿且不可再生）。
   * [HISTORICAL] 前身：本地 defer 队列 drain + clearDeferFlushRetryTimer（1s 重投 timer + 熔断
   * 计数）——内核接管重投（backoff + settled 边沿 + watchdog），renderer 不再持队列/定时器
   * （设计 §3.1 删除面），编排收窄为「drain RPC → 文本回草稿」。
   */
  async function onForceQuitSession(id: string): Promise<void> {
    markForcedExit(id)
    try {
      await sessionApi.forceQuit(id)
    } catch (e) {
      consumeForcedExit(id)
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.forceQuitFailed', { msg }))
      return
    }
    // [u5a 退役] 前身此处调 clearQueueState 清 pi queue_update 快照（session-dead G1）——
    // queueStates 分区随投递所有权内核整体退役（本单元删除），无残留可清：队列区唯一数据源
    // = session.delivery 投影，其本体由下方 drain 回收、展示随 runtime 快照帧收敛。
    let drained: Array<{ content: string }> = []
    try {
      const reply = await delivery.drainDelivery(id)
      drained = reply.entries
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.forceQuitQueueRecoverFailed', { msg }))
      return
    }
    // 空内容条目计入失败出声：content ?? '' 防御（类型声明 string，runtime 帧字段缺失时可能
    // nullish）——空内容写不回草稿且内核条目已 drain（不可再生），静默 = 消息丢失形态；
    // 成功 toast 只按实际收回条数报，不按条目数虚报。
    const recoveredTexts = drained.map((entry) => entry.content ?? '').filter((text) => text.trim().length > 0)
    const emptyCount = drained.length - recoveredTexts.length
    if (emptyCount > 0) {
      toastError(t('sidebar.forceQuitQueueRecoverEmpty', emptyCount, { named: { count: emptyCount } }))
    }
    if (recoveredTexts.length > 0) {
      const draftText = recoveredTexts.join('\n\n')
      // [F-U2] 槽位为单值覆盖语义（幂等以最后一次为准）：回收文本是唯一副本（内核条目已
      // drain，不可再生），直接请求会在「forceQuit 后、restore 前」窗口被任何其他注入
      // （drawer 注入 / 另一 session 的 forceQuit 回收）覆盖丢失，且 toast 已宣称「已收回
      // 草稿」——违背「消息不丢」。故槽位已有 text 时累积 '\n\n' 追加而非覆盖（不动 store
      // 的单值通道语义，拼接留在唯一需要它的回收侧）。槽位为 path/refSessionId chip 注入时
      // 无 text 可拼，回收文本优先覆盖——chip 由用户操作产生可重发，唯一副本优先。
      const pendingText = composerInjectionStore.pendingInjection.value?.text
      composerInjectionStore.requestInjection({
        target: 'current',
        sessionId: id,
        text: pendingText ? `${pendingText}\n\n${draftText}` : draftText,
      })
      toastInfo(
        t('sidebar.forceQuitQueueRecovered', recoveredTexts.length, { named: { count: recoveredTexts.length } }),
      )
    }
  }

  async function onConfirmRename(payload: { sessionId: string; label: string }): Promise<void> {
    try {
      await renameSession(payload.sessionId, payload.label)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.renameFailed', { msg }))
    }
  }

  /** 归入项目（D14 语义修正）：SessionItem 菜单选择后 RPC + 乐观更新；失败 toast。 */
  async function onAssignProject(payload: { sessionId: string; projectId: string }): Promise<void> {
    try {
      await assignSessionToProject(payload.sessionId, payload.projectId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.assignProjectFailed', { msg }))
    }
  }

  /** S5：重试加载会话列表（loadSessions 失败后用户点击重试） */
  function onRetryLoadSessions(): void {
    void loadSessions()
  }

  /** [w5] SearchModal deps 组装（SearchDeps 壳适配）+ drawer/toast 接线（C-NT-3/C-W4-5）：file 跳转开 detail tab；confirm 失败 toast（复用顶部 toastError）。 */
  const searchDeps = useSearchModalDeps({
    selectSession,
    newSession: () => { void newSession() },
  })
  function onOpenSearchDrawer(tab: string): void {
    const { open } = useSideDrawer()
    // SearchModal drawerTab（'tasks'|'sideDrawer'|'detail'）→ RightDrawerTab；实际 file 跳转恒 'detail'，'sideDrawer' 历史抽象值映射 undefined。
    open(tab === 'sideDrawer' ? undefined : (tab as Parameters<typeof open>[0]))
  }

  return {
    onSelectSession,
    onNewSession,
    onNewSessionInFolder,
    onRenameSession,
    onDeleteSession,
    onDeleteFolder,
    onAbortSession,
    onForceQuitSession,
    onConfirmRename,
    onAssignProject,
    onRetryLoadSessions,
    searchDeps,
    onOpenSearchDrawer,
  }
}
