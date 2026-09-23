/**
 * useForkNoticeEffect —— fork 反馈行 transient feed + 后台分支通知编排（FR-12/19，RV1+RV2）。
 *
 * 职责：
 * 1. 订阅 session.forkNotice 全局广播（runtime fork 成功后推送），按 srcSessionId 路由到
 *    对应 session 的对话流，插入 transient ForkNotice 反馈行（RV1）。
 * 2. 追踪后台分支状态变化（running→done/error/stopped）：fork 成功时 registerFork 建立
 *    追踪基线；groups 变化经 syncForkBranches diff，状态变化时追加反馈行（RV2）。
 *
 * 数据流：
 * - session.forkNotice（global 广播，payload 含 srcSessionId/newSessionId/branchName/preview）
 *   → pushNotice(srcSessionId, { newSessionId, branchName, preview }) 入 feed
 *   → registerFork(srcSessionId, newSessionId, branchName ?? preview ?? '') 建立分支追踪基线
 * - config.sessions 广播更新 session.groups → syncForkBranches diff 检测分支 status 翻转
 *   → onChange(kind) → pushNotice(srcSessionId, { kind, branchName }) 追加状态行
 *
 * Transient 语义：feed 仅前端内存维护，不写 chat store messages（不持久化、不进 JSONL）。
 * session 删除时 clearSession 清 feed，避免悬挂（[G1 / 2026-09-14 内存审计 §3.4] 接线：
 * SessionCleanupHooks.clearForkNotices → useSidebar hooks 实现 → 本函数，销毁唯一编排点
 * cleanupSessionState 触发）。模块级单例 ref 让所有 MessageStream 实例共享同一份 feed
 * （同 useForkModeChannel 模式），无需 store 或 provide/inject。
 *
 * 生命周期：App.vue onMounted 调 bindForkNoticeEffect() 注册全局订阅（onScopeDispose 退订）；
 * MessageStream 各实例调 useForkNoticeFeed() 读自身 session 的通知渲染。
 */
import { onScopeDispose, readonly, shallowRef, watch, type DeepReadonly, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { ServerMessage, SessionGroup } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { useSessionStore } from '@/stores/session'
import {
  registerFork,
  resetForkBranchState,
  syncForkBranches,
  type BranchChangeKind,
} from '@/composables/features/fork-handoff/useForkBranchNotify'

/** ForkNotice 反馈行 entry（transient，前端内存） */
export interface ForkNoticeEntry {
  /** 唯一 id（dismiss/渲染 key 用），递增避免重复 */
  id: number
  /** 新分支 session id（查看跳转目标 + 状态变化对应用） */
  newSessionId: string
  /** 分支名（纯后台 fork）或提问预览（fork-ask）；状态行用分支 label */
  branchName?: string
  /** fork-ask 的提问预览（优先于 branchName 展示） */
  preview?: string
  /** 状态变化语义（done/error/stopped）：有值时反馈行展示分支跑完/出错的衍生文案 */
  kind?: BranchChangeKind
  /** 源分支是否已删除——true 时「查看」降级为纯文本（spec §4） */
  sessionDeleted?: boolean
}

/** 模块级自增 id（跨 session 全局唯一，dismiss/渲染 key 用） */
let noticeSeq = 0
/**
 * 模块级 transient feed：srcSessionId → entries（shallowRef + Map 重赋值触发响应式）。
 *
 * [ADR-0049 例外] 保持模块级 Map，不套 useSessionScopedState：本 composable 是「全局 sid
 * 协调器」（useForkNoticeFeed 各方法显式接收 sessionId，无 sidRef 绑定实例），与 core 的
 * useChat.streamSubscriptions / coordination/subscription-state.subscriptionStates 同模式。
 * useSessionScopedState 契约要求 sidRef + per-instance reactive 容器，此处无 sidRef 且
 * feedMap 是全局 feed SSOT（多 MessageStream 实例共读），强套破坏消费者签名 + 语义错位
 * （对齐 w4 retrospect 教训 #3：handoff 范式要求需结合代码所在层判断适用性）。
 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：fork 通知 feed 全局 SSOT（无 sidRef 的显式 sid 协调器，上方注释已述 ADR-0049 例外）
const feedMap = shallowRef<Map<string, ForkNoticeEntry[]>>(new Map())

/**
 * 读取指定 session 的 ForkNotice 反馈行列表（响应式）。
 * MessageStream 各实例调此函数读自身 session 的通知，在对话流末尾渲染。
 */
export function useForkNoticeFeed(): {
  /** entries（只读，派生自 feedMap，响应式） */
  notices: (sessionId: string) => DeepReadonly<ForkNoticeEntry[]>
  /** 移除单条通知（用户点关闭 ×） */
  dismissNotice: (sessionId: string, noticeId: number) => void
  /** 清空指定 session 全部通知（session 销毁编排调：SessionCleanupHooks.clearForkNotices，G1 接线） */
  clearSession: (sessionId: string) => void
  /** feed 原始 ref（测试/调试用） */
  feedRef: Ref<Map<string, ForkNoticeEntry[]>>
  } {
  /** 按 sessionId 取 entries（shallowRef 下每次重算，feedMap 变化即响应） */
  function notices(sessionId: string): DeepReadonly<ForkNoticeEntry[]> {
    return readonly(feedMap.value.get(sessionId) ?? [])
  }

  /** 移除单条通知 */
  function dismissNotice(sessionId: string, noticeId: number): void {
    const list = feedMap.value.get(sessionId)
    if (!list) return
    const next = list.filter((e) => e.id !== noticeId)
    const map = new Map(feedMap.value)
    if (next.length === 0) {
      map.delete(sessionId)
    } else {
      map.set(sessionId, next)
    }
    feedMap.value = map
  }

  /** 清空指定 session 全部通知 */
  function clearSession(sessionId: string): void {
    if (!feedMap.value.has(sessionId)) return
    const map = new Map(feedMap.value)
    map.delete(sessionId)
    feedMap.value = map
  }

  return { notices, dismissNotice, clearSession, feedRef: feedMap }
}

/** 测试隔离：重置模块级 feed + 分支追踪状态（beforeEach 调，防跨用例泄漏） */
export function resetForkNoticeFeed(): void {
  noticeSeq = 0
  feedMap.value = new Map()
  resetForkBranchState()
}

/**
 * 向 feed 推一条 ForkNotice entry（内部 helper）。
 * 不直接 export——bindForkNoticeEffect 闭包内调用。
 */
function pushNotice(
  srcSessionId: string,
  data: Omit<ForkNoticeEntry, 'id'>,
): void {
  noticeSeq += 1
  const entry: ForkNoticeEntry = { id: noticeSeq, ...data }
  const prev = feedMap.value.get(srcSessionId) ?? []
  const map = new Map(feedMap.value)
  map.set(srcSessionId, [...prev, entry])
  feedMap.value = map
}

/**
 * 判断指定 srcSessionId 的 feed 中是否已有指向 newSessionId 的 notice（去重用）。
 * fork-ask 本地推送与 runtime 广播可能竞速（runtime 对每次 session.fork 都广播 session.forkNotice，
 * 无 preview），用 newSessionId 作唯一键去重，保证 fork-ask 只留一条 askedPrefix notice。
 */
function hasNoticeForBranch(srcSessionId: string, newSessionId: string): boolean {
  const list = feedMap.value.get(srcSessionId)
  return !!list?.some((e) => e.newSessionId === newSessionId)
}

/**
 * 移除指定 srcSessionId 下指向 newSessionId 的 notice（替换语义）。
 * fork-ask 本地推送前调：若 runtime 广播先到（forkedPrefix，无 preview），替换为 askedPrefix。
 */
function removeNoticeForBranch(srcSessionId: string, newSessionId: string): void {
  const list = feedMap.value.get(srcSessionId)
  if (!list) return
  const next = list.filter((e) => e.newSessionId !== newSessionId)
  const map = new Map(feedMap.value)
  if (next.length === 0) {
    map.delete(srcSessionId)
  } else {
    map.set(srcSessionId, next)
  }
  feedMap.value = map
}

/**
 * fork-ask 本地推送 ForkNotice（FR-9/10 高频路径，P2 修复）。
 *
 * 与纯 fork（forkSession）不同：fork-ask 的提问内容由前端持有，runtime 的 session.fork
 * RPC 不携带 preview，故 session.forkNotice 广播 payload 只有 { srcSessionId, newSessionId,
 * branchName }（无 preview）→ ForkNotice 永远走 forkedPrefix（"已 fork 到后台"），分支标题也不
 * 用提问预览。此函数让 fork-ask 在 fork + send 成功后**本地直接**推送带 preview 的 notice，
 * 走 askedPrefix（"已在新分支提问"）+ 分支标题用提问预览。
 *
 * 仅 fork-ask 调本函数；纯 fork 仍走 runtime 广播（bindForkNoticeEffect 的 session.forkNotice
 * 订阅 → forkedPrefix）。RV2 分支追踪（registerFork）两边都建立——fork-ask 也需追踪后台状态变化。
 * registerFork 是模块级函数（useForkBranchNotify 单例），无需 bind 前置；状态由
 * resetForkNoticeFeed（→ resetForkBranchState）统一隔离。
 *
 * 去重（防 fork-ask 双 notice）：runtime 对每次 session.fork 都广播（含 fork-ask 的 fork），
 * 与本地推送存在竞速。双向去重——
 * - 本地推送先到：hasNoticeForBranch 让广播 handler 跳过 pushNotice（仍 registerFork）。
 * - 广播先到（forkedPrefix）：removeNoticeForBranch 清掉它，再 push askedPrefix，保证只留一条。
 *
 * @param srcSessionId 源（主线）session id（反馈行落点）
 * @param newSessionId 新分支 session id（查看跳转目标 + 追踪键）
 * @param preview 提问内容预览（branch 标题 + askedPrefix 展示）
 */
export function pushForkNoticeAsk(
  srcSessionId: string,
  newSessionId: string,
  preview: string,
): void {
  removeNoticeForBranch(srcSessionId, newSessionId)
  pushNotice(srcSessionId, { newSessionId, preview })
  registerFork(srcSessionId, newSessionId, preview)
}

/**
 * 注册全局 fork-notice 效果（RV1+RV2 接线点）。
 *
 * 在 App.vue setup 调用一次（单实例，App setup 是全局 effect 作用域）。内部：
 * - 订阅 session.forkNotice 全局广播 → pushNotice + registerFork
 * - watch session.groups → syncForkBranches diff，状态变化 onChange → pushNotice 追加状态行
 * - onScopeDispose 退订并重置分支态（App 卸载时清理）
 */
export function bindForkNoticeEffect(): void {
  const sessionStore = useSessionStore()
  // groupsRef 供分支状态 diff——storeToRefs 取响应式 ref（store 属性访问会被解包）。
  const { groups } = storeToRefs(sessionStore)
  const groupsRef: Ref<SessionGroup[]> = groups

  // RV1：订阅 session.forkNotice 全局广播（payload 无 sessionId，routeInbound 走 global 通道）。
  // 收到后按 srcSessionId 把 ForkNotice 插入对应 session 的对话流（transient feed）。
  const unsubForkNotice = events.onGlobalType('session.forkNotice', (msg) => {
    const payload = (msg as ServerMessage<'session.forkNotice'>).payload
    const { srcSessionId, newSessionId, branchName, preview } = payload
    // [P2 去重] fork-ask 在本地 pushForkNoticeAsk 已推 askedPrefix notice（带 preview）。
    // runtime 对每次 session.fork 都广播（含 fork-ask），此 newSessionId 已有 notice 时跳过
    // pushNotice（避免 forkedPrefix 重复）；registerFork 仍执行（RV2 分支追踪两边都需建立）。
    if (!hasNoticeForBranch(srcSessionId, newSessionId)) {
      pushNotice(srcSessionId, { newSessionId, branchName, preview })
    }
    // RV2：fork 成功 → registerFork 建立分支追踪基线（label 用 branchName/preview 兜底）。
    registerFork(srcSessionId, newSessionId, branchName ?? preview ?? '')
  })

  // RV2：后台分支状态变化（running→done/error/stopped）→ 追加反馈行通知。
  // kind 语义映射到反馈行：done → 分支已完成、error → 分支出错、stopped → 分支已停止。
  // groups 深度 watch 驱动 diff，onChange 是唯一路由（单消费方，无多播注册表）。
  watch(groupsRef, (next) => {
    syncForkBranches(next, (change) => {
      pushNotice(change.srcSessionId, {
        newSessionId: change.branchId,
        branchName: change.label,
        kind: change.kind,
      })
    })
  }, { deep: true })

  onScopeDispose(() => {
    unsubForkNotice()
    resetForkBranchState()
  })
}
