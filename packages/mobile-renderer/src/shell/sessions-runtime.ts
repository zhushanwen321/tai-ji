// sessions-runtime.ts —— [u-sessions] 会话屏运行时接线（remote-use-mobile-v2 §6.3 客户端半
// / §6.19 双源谓词 + hasBlockingOverlay / §7.1 删除级联；W3 契约锚段落位单元）。
//
// 独立模块（非 app-runtime.ts 内联段）的原因有二：① app-runtime.ts 是壳级组装单文件，
// W3 三个并行单元各写各段，521 行已触 eslint max-lines 预算——会话域接线拆出后组装文件
// 回到预算内；② 收窄并行写面（u-sheets 同时在 app-runtime 落自己的段）。
//
// 依赖方向：本模块 → app-runtime（既有导出 activeSessionId / deleteSession）/ sheet-manager
// / core transport events——app-runtime 不反向 import 本模块（消费方 SessionsScreen /
// SessionActionsSheet / u-activity 直接 import 本模块）。
import { ref } from 'vue'
import { deriveSessionStatus, getPlatform } from '@taiji/core'
import type { DeriveStatusChat, DerivedStatus } from '@taiji/core'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import { onGlobalType } from '@taiji/core/transport/api'
import type { SessionSummary } from '@taiji/shared'
import { normalizeContent } from '@taiji/shared'
import { activeSessionId, deleteSession } from './app-runtime'
import { closeSheet } from './sheet-manager'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：未读 diff 基线（上一帧
// config.sessions 快照的 lastActiveAt/status，diff 的比较源；基线无条目的首见会话另走
// 落盘 lastVisitedAt 播种，见 seedUnreadFromLastVisited）
const unreadBaseline = new Map<string, { lastActiveAt: number; status: SessionSummary['status'] }>()

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：未读会话 id 集合（§6.3 权威源 =
// 客户端本地——落盘 lastVisitedAt 持久对照（首见播种）+ 帧间 diff；不可变替换触发响应式）。
// 置位语义 = 新投递（lastActiveAt 推进）或新终态（status 翻转）且非当前活跃会话；流式中间态/
// 等待输入不点亮（未订阅会话在客户端无信号源，§6.3 收窄口径）；点入即清（markSessionVisited）。
const unreadSessionIds = ref<ReadonlySet<string>>(new Set<string>())

/** lastVisitedAt 持久键前缀（每会话一条目，§6.3/§7.1；删除级联按条目摘除防单调累积） */
export const LAST_VISITED_KEY_PREFIX = 'taiji.mobile.lastVisited.'

function lastVisitedKey(sid: string): string {
  return LAST_VISITED_KEY_PREFIX + sid
}

/** 点入即清（§6.3）：摘未读点 + 落 lastVisitedAt（刷新后未读恢复的对照源，读方 =
 * seedUnreadFromLastVisited；best-effort——存储失败不阻断切入）。 */
export function markSessionVisited(sid: string): void {
  if (unreadSessionIds.value.has(sid)) {
    const next = new Set(unreadSessionIds.value)
    next.delete(sid)
    unreadSessionIds.value = next
  }
  void getPlatform()
    .storage.set(lastVisitedKey(sid), String(Date.now()))
    .catch((e: unknown) => {
      console.warn('[sessions-runtime] persist lastVisitedAt failed:', sid, e)
    })
}

/** 未读读口（SessionsScreen/ActivityScreen 行渲染消费） */
export function isSessionUnread(sid: string): boolean {
  return unreadSessionIds.value.has(sid)
}

// 首见播种（§6.3 权威源的持久对照半——落盘 lastVisitedAt 的唯一读方）：基线无条目的会话
// （刷新/重连后的第一帧，或快照中新出现）按「lastActiveAt > lastVisitedAt（上次访问后有
// 过新投递）且非当前活跃会话」点亮，刷新后未读由此恢复。无落盘条目或条目损坏 → 不点亮
// （从未在本机访问过的会话无「已读」事实可对照，点亮即全表误标——该分支保持原「首帧只建
// 基线」保守语义）。边界：status 翻转无落盘快照，播种只对照时间戳——访问后仅终态翻转而
// lastActiveAt 未推进的会话刷新后不恢复（§6.3 权威源仅含 lastVisitedAt 时间戳）。异步读回
// 护栏：会话已从最新快照消失（基线被后续帧摘除）不点亮；存储失败降级不点亮（best-effort，
// 与写口同策略）。
function seedUnreadFromLastVisited(s: SessionSummary): void {
  void getPlatform()
    .storage.get(lastVisitedKey(s.id))
    .then((raw) => {
      if (raw === null) return
      const visitedAt = Number(raw)
      if (!Number.isFinite(visitedAt)) return
      if (s.lastActiveAt <= visitedAt) return
      if (s.id === activeSessionId.value) return
      if (!unreadBaseline.has(s.id)) return
      if (unreadSessionIds.value.has(s.id)) return
      const next = new Set(unreadSessionIds.value)
      next.add(s.id)
      unreadSessionIds.value = next
    })
    .catch((e: unknown) => {
      console.warn('[sessions-runtime] read lastVisitedAt failed:', s.id, e)
    })
}

// 未读 diff 订阅（模块级单次注册；events 全局通道 Set 允许多订阅者，与 store 整表快照
// 的既有订阅互不干扰——core events M4 隔离语义）。基线播种：首见会话（无基线条目）走
// seedUnreadFromLastVisited 落盘对照；此后每帧 diff：lastActiveAt 推进 ∨ status 翻转，
// 且非当前活跃会话 → 置未读。
void onGlobalType('config.sessions', (msg) => {
  const flat = msg.payload.groups.flatMap((g) => g.sessions)
  const seen = new Set<string>(flat.map((s) => s.id))
  const active = activeSessionId.value
  let changed = false
  const next = new Set(unreadSessionIds.value)
  for (const s of flat) {
    const prev = unreadBaseline.get(s.id)
    if (prev !== undefined && s.id !== active && (s.lastActiveAt > prev.lastActiveAt || s.status !== prev.status)) {
      if (!next.has(s.id)) {
        next.add(s.id)
        changed = true
      }
    }
    if (prev === undefined) seedUnreadFromLastVisited(s)
    unreadBaseline.set(s.id, { lastActiveAt: s.lastActiveAt, status: s.status })
  }
  // 已消失会话（删除/deleteByCwd/归档出列表）同步摘除基线与未读（注册表级联外的兜底收敛）
  for (const sid of unreadBaseline.keys()) {
    if (!seen.has(sid)) unreadBaseline.delete(sid)
  }
  for (const sid of next) {
    if (!seen.has(sid)) {
      next.delete(sid)
      changed = true
    }
  }
  if (changed) unreadSessionIds.value = next
})

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：会话草稿分区（§7.1 草稿生命
// 周期表的壳层载体：Composer 写、删除级联清；空串 = 摘除条目，不存空值）。
// @data-owner #54 —— mobile 壳会话草稿分区（纯本地 UI 输入态，无 runtime 权威）
const draftsBySid = new Map<string, string>()

/** 会话草稿读口（Composer 消费；无草稿返回空串） */
export function draftOf(sid: string): string {
  return draftsBySid.get(sid) ?? ''
}

/** 会话草稿写口（Composer 输入即写；空串摘除条目） */
export function setDraft(sid: string, text: string): void {
  if (text === '') draftsBySid.delete(sid)
  else draftsBySid.set(sid, text)
}

// hasBlockingOverlay 输入源注册口（§6.19）：「该会话待回答请求非空（form/planReview/dialog）」
// 的分区数据居 companion-bridge（呈现出口改造单元 territory，本单元禁触），经本注册口注入——
// 未注册时谓词恒 false（= v1 形态 D9②，无回归；呈现出口接线后 9 态达完整）。
let overlayPendingReader: ((sid: string) => boolean) | null = null

export function registerOverlayPendingReader(reader: (sid: string) => boolean): void {
  overlayPendingReader = reader
}

/** 待回答覆盖读口（分组谓词 hasBlockingOverlay 输入；未注册时恒 false） */
export function overlayPendingOf(sid: string): boolean {
  return overlayPendingReader?.(sid) ?? false
}

// ── 分组谓词（§6.19 双源）────────────────────────────────────────────────────────

/**
 * 列表行状态词表：9 态派生（已订阅）∪ 'active' 摘要态（未订阅且 summary.status=active，
 * accent 脉冲 + 状态词「进行中」）∪ 'dead' 进程态特判（优先归「最近」组）。
 */
export type MobileRowStatus = DerivedStatus | 'active' | 'dead'

export interface MobileSessionRowModel {  // oe-exempt:20261026:framework:壳层屏↔组件数据契约（SessionRow 行模型边界）
  summary: SessionSummary
  status: MobileRowStatus
  unread: boolean
}

/** 分组谓词输入束（纯函数注入形态，测试以合成 store 驱动；壳层调用点喂单例分区读口） */
export interface MobileGroupingDeps {  // oe-exempt:20261026:framework:壳层屏↔组件数据契约（分组谓词依赖注入边界）
  chat: DeriveStatusChat
  /** 会话是否已订阅（chat 分区有数据——hydrate 或在途提交任一即视为已订阅） */
  isSubscribed(sid: string): boolean
  isActive(sid: string): boolean
  isCompacting(sid: string): boolean
  hasBackgroundWork(sid: string): boolean
  hasBlockingOverlay(sid: string): boolean
  isUnread(sid: string): boolean
}

/** 进行中组收编的派生态（瞬态全集；终态 done/error/stopped 与摘要态外的归「最近」组） */
const IN_PROGRESS_DERIVED: ReadonlySet<DerivedStatus> = new Set([
  'streaming',
  'pending',
  'compacting',
  'waiting',
  'retrying',
  'working',
])

/**
 * 单行状态判定（§6.19 双源谓词本体）：
 * - dead 恒特判（进程态权威于对话派生，v1 SessionListItem 同语义，归「最近」组）；
 * - 未订阅（无消息历史，9 态判定输入不完备——v1 把 active 摘要误派生为 done 的缺陷
 *   core#1 的修复面）：按 SessionSummary.status 二分，active → 'active'（进行中组）、
 *   error/stopped 原样、idle/done → 'done'（历史会话缺省显示，与 deriveStatus 未 hydrate
 *   兜底分支同映射）；
 * - 已订阅：core deriveSessionStatus 完整 9 态（hasBlockingOverlay 本模块经注册口喂入，
 *   waiting 态在移动侧可达——D9② 消除的接线点）。
 */
export function mobileRowStatusOf(s: SessionSummary, deps: MobileGroupingDeps): MobileRowStatus {
  if (s.status === 'dead') return 'dead'
  if (!deps.isSubscribed(s.id)) {
    switch (s.status) {
      case 'active':
        return 'active'
      case 'error':
        return 'error'
      case 'stopped':
        return 'stopped'
      case 'idle':
      case 'done':
      default:
        return 'done'
    }
  }
  return deriveSessionStatus(s.id, deps.chat, {
    isActive: deps.isActive(s.id),
    isCompacting: deps.isCompacting(s.id),
    hasBackgroundWork: deps.hasBackgroundWork(s.id),
    hasBlockingOverlay: deps.hasBlockingOverlay(s.id),
    metaStatus: s.status,
  })
}

/**
 * 列表分组（§6.19）：进行中（瞬态 + 未订阅 active 摘要态）/ 最近（终态 + dead 优先）两组。
 * 组内保持 runtime 组序（A13 客户端不重排——过滤不重排）。
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  deps: MobileGroupingDeps,
): { inProgress: MobileSessionRowModel[]; recent: MobileSessionRowModel[] } {
  const inProgress: MobileSessionRowModel[] = []
  const recent: MobileSessionRowModel[] = []
  for (const summary of sessions) {
    const status = mobileRowStatusOf(summary, deps)
    const model: MobileSessionRowModel = { summary, status, unread: deps.isUnread(summary.id) }
    const belongsInProgress = status !== 'dead' && (status === 'active' || IN_PROGRESS_DERIVED.has(status))
    ;(belongsInProgress ? inProgress : recent).push(model)
  }
  return { inProgress, recent }
}

/** 已订阅会话的摘要行文本截断上限（超出截断；display-only 预算） */
const EXCERPT_MAX_LENGTH = 64

/** 已订阅会话的摘要行文本：末条消息纯文本摘录（normalizeContent 归一 + 截断；无文本空串） */
export function sessionExcerptOf(sid: string, chat: DeriveStatusChat): string {
  const msgs = chat.getMessages(sid)
  const last = msgs[msgs.length - 1]
  if (!last) return ''
  const text = normalizeContent(last.content).replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_MAX_LENGTH ? text.slice(0, EXCERPT_MAX_LENGTH) : text
}

/**
 * 删除级联编排（§7.1 删除级联补全的壳层入口，SessionActionsSheet 消费）：
 * core deleteSession（销毁唯一编排点）内部 triggerSessionCleanups 已跑本模块注册的级联
 * （lastVisitedAt 条目摘除 + 草稿条目丢弃 + 未读点摘除，见下方 registerSessionCleanup）；
 * 收尾关闭活动 Sheet（§7.1「当前会话删除，sheet-manager 一律关闭」——消费方事件点职责）。
 */
export async function deleteSessionWithCascade(id: string): Promise<void> {
  await deleteSession(id)
  closeSheet()
}

// 删除级联注册（销毁语义，与 turnExpansionMap/queueEditAnchorMap 同款注册形态）：
// ① localStorage lastVisitedAt 条目摘除（§7.1 防随创建/删除循环单调累积）；
// ② 草稿条目丢弃（§7.1 草稿生命周期表）；
// ③ 未读点摘除（已删会话不残留未读点）。
registerSessionCleanup((sid) => {
  void getPlatform()
    .storage.remove(lastVisitedKey(sid))
    .catch((e: unknown) => {
      console.warn('[sessions-runtime] remove lastVisitedAt failed:', sid, e)
    })
  draftsBySid.delete(sid)
  if (unreadSessionIds.value.has(sid)) {
    const next = new Set(unreadSessionIds.value)
    next.delete(sid)
    unreadSessionIds.value = next
  }
})

/** 测试复位（生产代码禁止消费）：未读基线/未读集/草稿分区归零 + overlay 注册口摘除。 */
export function resetSessionsRuntimeForTesting(): void {
  unreadBaseline.clear()
  unreadSessionIds.value = new Set<string>()
  draftsBySid.clear()
  overlayPendingReader = null
}
