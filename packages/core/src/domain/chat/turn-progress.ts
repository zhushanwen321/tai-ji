/**
 * turn 进展观测面（session-dead-structural-fixes §3.3 D6 C1 方案一 / 设计 §3.1 成功路径 C；
 * 收窄形态见 remove-turn-progress-bar 设计 §2.3）。
 *
 * 职责：从 chat store 既有事件流投影（occupancy 分区 + messages 分区）纯本地派生
 * 「本 turn 已进行时长 + 超阈值警示（warn）」。零协议改动——信号源 = 结构事件边界的
 * 既有落点：
 * - turn 边界：`session.occupancy` 帧 turn 维度（generating 由 message_start(assistant)
 *   驱动、idle 由 agent_settled 驱动——设计 D1 已裁定的 turn-start 物理来源），
 *   dispatching/settling 计入活跃（用户视角 turn 从发送起、到 settled 收口止）。
 * - 展示刷新用 setInterval 秒级 tick，事件边沿不重算快照。
 *
 * ask_user 豁免（D6 豁免态）：extension-ui pending 期间警示不参与——超阈值也不 warn
 * （漏判 = 措辞不准零伤害，与旧 watchdog 拿豁免做杀/不杀判据的本质区别）。豁免信号由
 * 消费方注入（core 不依赖 renderer extensionUIStore，结构反转：`getAwaitingUser` 回调）；
 * awaitingUser 不进 snapshot（分型文案已随 warn 化删除），降为 tick 内局部变量，仅作
 * warn 计算输入：`warn = !awaitingUser && !snoozed && elapsed ≥ 阈值`。
 *
 * 生命周期：turn 结束（occupancy → idle）快照归 null（消费方渲染自动消失）；纯本地
 * 派生无持久化——reload 后天然无残留。
 *
 * per-session 隔离：ADR-0049 Map 分区范式（useSessionScopedState），分区存跨帧记忆
 * （turnStartedAt / turn 锚 / lastAssistantId 快路径判据 / snooze 标记），切 session
 * 保留、切回延续计时。记忆消费以 turn 锚守门（锚 = 记忆 turn 的首条 assistant 消息
 * id，与 message-turns SSOT 分组的当前末组首条 assistant 比对）：锚匹配（同 turn 切回）
 * → 延续计时；turn 已在后台更替（锚失配）→ 重落基线（startTurn），elapsed 不从陈旧
 * 记忆虚高。lastAssistantId 由结构边沿回调逐边沿刷新（turnAnchorMatches 的 O(1) 快路径
 * 判据，不做任何长度差累计——字符观测已退役至 ui 层派生）。残余窗口：锚失配但新 turn
 * 尚无 assistant 消息（dispatching 空窗切入）——新 turn 真实起点不可观测，基线暂取末位
 * assistant（属上一 turn）timestamp 偏虚高，message_start 事件到达即重落自纠（快路径
 * 短路下同）。
 *
 * 收窄不变量（remove-turn-progress-bar 设计 §2.3）：snapshot 公共接口 ≡ 运行时消费面
 * ——快照字段若无消费方即应删除，防死代码漂移（全仓 rg 机械验真）。
 */
import { onScopeDispose, ref, watch, reactive } from 'vue'
import type { Ref } from 'vue'
import type { Message } from '@xyz-agent/shared'
import { groupTurns } from './message-turns'
import { useSessionScopedState } from '../../foundation/use-session-scoped-state'

/** 展示刷新间隔默认值：1s（任务原文「timer 用 setInterval 秒级刷新展示」）。 */
const DEFAULT_TICK_MS = 1000

/**
 * 停滞警示阈值：10 分钟初值。
 *
 * [P-3 实测后定值]（设计 §3.3 D7 / §3.5 P-3）：与 fix-subagent-no-notification 分支的
 * P3 门（三类会话事件间隔分布实测）共用一次实测定值，数据落地前严禁收窄。方案一阶段
 * 阈值仅用于警示色切换（展示恒在，无阈值判定逻辑），不受 P-3 实测阻塞（§3.5 P-3）。
 */
export const TURN_PROGRESS_WARN_THRESHOLD_MS = 600_000

/** 单个 turn 的进展快照（warn 告警条消费；null = 无活跃 turn，不渲染）。 */
export interface TurnProgressSnapshot {
  /** 本 turn 已进行时长（ms，墙钟差值，delta 不参与计时）。 */
  turnElapsedMs: number
  /** 超阈值警示（ask_user 豁免 / 用户点「继续等待」后为 false；阈值见 TURN_PROGRESS_WARN_THRESHOLD_MS）。 */
  warn: boolean
}

/**
 * 计时派生消费的 chat store 最小结构接口（derive-status.ts 的 DeriveStatusChat 同款
 * 结构性类型先例）：renderer pinia store（useChatStore）与 core factory 产物
 * （createChatStore）均天然满足。只读两个分区投影，不触碰任何写路径。
 */
export interface TurnProgressChatSource {
  getMessages(sessionId: string): Message[]
  getOccupancy(sessionId: string): { turn: 'idle' | 'dispatching' | 'generating' | 'settling' }
}

export interface UseTurnProgressOptions {
  /**
   * ask_user 豁免信号（D6 豁免态）注入点：每 tick 轮询读取（非响应式——展示刷新由
   * 秒级 tick 驱动，信号出现后 ≤1 tick 生效）。renderer 接线 =
   * `extensionUIStore.hasPendingAskUser`（既有非响应式 getter，与 deriveStatus 同模式）。
   */
  getAwaitingUser?: (sessionId: string) => boolean
  /** 时钟注入（测试 fake timers 用；默认 Date.now）。 */
  now?: () => number
  /** 展示刷新间隔 ms（默认 1000；测试可缩短）。 */
  tickMs?: number
}

/** per-session 跨帧记忆（reactive 容器，useSessionScopedState 响应式契约要求）。 */
interface TurnPartitionState {
  /** turn-start 边沿时刻（ms）。cold-start（挂载时已活跃）用末位 assistant timestamp 兜底。 */
  turnStartedAt: number | null
  /**
   * turn 锚：记忆 turn 的首条 assistant 消息 id（startTurn 落锚）。消费记忆前与
   * message-turns SSOT 分组的当前末组首条 assistant 比对——失配 = turn 已更替，
   * 记忆整体作废重落（防陈旧 elapsed 虚高）。
   */
  turnAnchorId: string | null
  /**
   * 最近观测的 assistant 消息 id（结构边沿回调逐边沿刷新）：turnAnchorMatches 的
   * O(1) 快路径判据——末位 assistant 未变即无新 assistant 落地，免 SSOT 分组慢路径。
   */
  lastAssistantId: string | null
  /** 用户点「继续等待」后本 turn 内抑制警示（turn 结束自动复位）。 */
  snoozed: boolean
}

function createEmptyPartition(): TurnPartitionState {
  return reactive({
    turnStartedAt: null,
    turnAnchorId: null,
    lastAssistantId: null,
    snoozed: false,
  })
}

/** 从尾向前找最后一条 assistant 消息（delta 只发生在末位 assistant 上，实际近 O(1)）。 */
function findLastAssistantMessage(messages: Message[] | undefined): Message | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') return messages[i]
  }
  return undefined
}

/**
 * 当前 turn 锚：message-turns SSOT 分组（v2 边界规则——user / 隐藏完成通知 / 可见 system
 * 开新组）末组的首条 assistant 消息 id；无 assistant 归组（dispatching 空窗 / 无消息）= null。
 * 分组纯函数 O(n)，仅在锚校验慢路径与 startTurn 落锚时调用（见 turnAnchorMatches 快路径）。
 */
function currentTurnAnchorId(messages: Message[] | undefined): string | null {
  if (!messages || messages.length === 0) return null
  const turns = groupTurns(messages)
  return turns[turns.length - 1]?.assistants[0]?.id ?? null
}

/**
 * 分区记忆是否仍指向当前 turn（F-U1：startTurn 重落判据——①后台 turn 更替锚失配 → 重落，
 * ②同 turn 切回锚相同 → 保留累计）。
 * 快路径：末位 assistant 自上次观测（lastAssistantId 由边沿回调逐边沿刷新）未变
 * → 无新 assistant 落地，末组首条不可能更替（无 assistant 填实的尾随边界不产出/不改末组
 * ——空 turn 折叠），O(1) 短路热路径；否则走 SSOT 分组精确比对。
 */
function turnAnchorMatches(messages: Message[] | undefined, part: TurnPartitionState): boolean {
  if (findLastAssistantMessage(messages)?.id === part.lastAssistantId) return true
  return currentTurnAnchorId(messages) === part.turnAnchorId
}

/**
 * turn 进展观测 composable（C1 方案一）。
 *
 * 响应式接线：watch（occupancy turn 维度 + messages 分区引用）驱动结构边沿检测（每
 * 事件 O(1)，仅维护分区记忆与快路径判据）；快照计算只在 setInterval 秒级 tick 里做
 * （事件边沿不触发快照重算）。事件回调统一用 source 快照内捕获的 sid 写分区
 * （updateFor），结构性消除切 session 竞态（ADR-0049 checklist）。
 *
 * @param sessionId 当前展示目标 session（Composer 的 props.sessionId 响应式引用）
 * @param chat chat store 最小结构接口（TurnProgressChatSource）
 * @param options 豁免信号 / 时钟 / tick 间隔注入
 * @returns snapshot：当前 session 快照（null = 无活跃 turn，展示消失）；snoozeWarn：
 *   用户点「继续等待」——本 turn 内抑制警示，turn 结束自动复位
 */
export function useTurnProgress(
  sessionId: Ref<string | null>,
  chat: TurnProgressChatSource,
  options?: UseTurnProgressOptions,
): {
  snapshot: Ref<TurnProgressSnapshot | null>
  snoozeWarn: () => void
} {
  const now = options?.now ?? Date.now
  const tickMs = options?.tickMs ?? DEFAULT_TICK_MS
  const snapshot = ref<TurnProgressSnapshot | null>(null)

  // ADR-0049 Map 分区宿主：跨帧记忆 per-session 隔离，切走保留、切回延续；
  // cleanup 由 sessionCleanupRegistry 统一编排（useSidebar.deleteSession）。
  const scoped = useSessionScopedState<TurnPartitionState>(sessionId, createEmptyPartition)
  const currentPartition = (): TurnPartitionState => scoped.current.value

  // ── interval：秒级展示刷新（活跃才跑；turn 收口/无 sid 即停）──
  let timer: ReturnType<typeof setInterval> | null = null
  function ensureTicking(): void {
    if (timer === null) timer = setInterval(tick, tickMs)
  }
  function stopTicking(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  onScopeDispose(stopTicking)

  function finishTurn(sid: string): void {
    // 分区字段整体复位（保留 Map 条目——下一 turn 边沿复用，避免增删扰动 version）。
    const part = currentPartition()
    part.turnStartedAt = null
    part.turnAnchorId = null
    part.lastAssistantId = null
    part.snoozed = false
    if (sessionId.value === sid) {
      snapshot.value = null
      stopTicking()
    }
  }

  /** turn-start 边沿 / cold-start（挂载时已活跃）/ 锚失配重落：落计时基线 + turn 锚。 */
  function startTurn(messages: Message[] | undefined): void {
    // 计时基线优先取末位 assistant timestamp（message_start effect 写入的墙钟——
    // 比 watch 触发时刻更贴近 message_start(assistant) 事件点）；无消息（dispatching
    // 空窗）退化为当前时刻（误差 ≤ 一个事件批，展示粒度分钟级可接受）。
    const last = findLastAssistantMessage(messages)
    const part = currentPartition()
    part.turnStartedAt = last?.timestamp ?? now()
    part.turnAnchorId = currentTurnAnchorId(messages)
    part.lastAssistantId = last?.id ?? null
    part.snoozed = false
  }

  // ── 秒级 tick：快照计算（唯一做 O(turn) 工作的地方）──
  function tick(): void {
    const sid = sessionId.value
    if (!sid) {
      stopTicking()
      snapshot.value = null
      return
    }
    const part = currentPartition()
    if (part.turnStartedAt === null) {
      stopTicking()
      snapshot.value = null
      return
    }
    if (chat.getOccupancy(sid).turn === 'idle') {
      // 边沿漏检兜底（watch 与 interval 之间无帧的形态理论不存在，防御性收口）。
      finishTurn(sid)
      return
    }
    const messages = chat.getMessages(sid)
    // 锚失配兜底（F-U1，防御性同款校验——常态走 turnAnchorMatches 快路径短路）：
    // 记忆 turn 与当前 turn 不一致时重落，tick 快照不从陈旧基线取值。
    if (!turnAnchorMatches(messages, part)) startTurn(messages)
    // awaitingUser 为 tick 内局部变量（D6 豁免，仅作 warn 计算输入，不进 snapshot
    // ——snapshot 公共接口 ≡ 运行时消费面，设计 §2.3 收窄）。
    const awaitingUser = options?.getAwaitingUser?.(sid) === true
    const turnElapsedMs = Math.max(0, now() - part.turnStartedAt)
    snapshot.value = {
      turnElapsedMs,
      // D6 豁免：ask_user pending 期间警示不参与（超阈值也不警示）。
      warn: !awaitingUser && !part.snoozed && turnElapsedMs >= TURN_PROGRESS_WARN_THRESHOLD_MS,
    }
  }

  // ── 结构边沿检测（watch 回调每事件 O(1)；快照不在本回调算）──
  interface TurnProgressSource {
    sid: string | null
    turn: 'idle' | 'dispatching' | 'generating' | 'settling' | undefined
    messages: Message[] | undefined
  }
  // source 快照派生自 sid.value 的实时分区（occupancy turn 维度 + messages 数组引用），
  // 任一 commit 都触发边沿回调——next.sid 与回调执行时的 sid.value 恒一致（同 flush
  // 同步求值），分区读写走 currentPartition() 无跨 session 竞态窗口。
  function turnProgressSource(): TurnProgressSource {
    const sid = sessionId.value
    return {
      sid,
      turn: sid ? chat.getOccupancy(sid).turn : undefined,
      messages: sid ? chat.getMessages(sid) : undefined,
    }
  }
  function onTurnProgressEdge(next: TurnProgressSource, prev: TurnProgressSource | undefined): void {
    if (!next.sid) {
      stopTicking()
      snapshot.value = null
      return
    }
    const wasActive = prev !== undefined && prev.turn !== undefined && prev.turn !== 'idle'
    const isActive = next.turn !== undefined && next.turn !== 'idle'
    if (!isActive) {
      // turn-end 边沿（agent_settled → idle）：展示消失 + 记忆复位。挂载于 idle
      // session（prev 为 undefined）时无残留在先，复位幂等。
      if (wasActive || currentPartition().turnStartedAt !== null) finishTurn(next.sid)
      return
    }
    const part = currentPartition()
    // 记忆消费守门（F-U1 turn 锚）：无记忆（新 turn / 首次观测）或锚失配（后台期间 turn
    // 已更替）→ 重落基线；锚匹配（含同 turn 切回——prev 是另一 session 的快照，wasActive
    // 无法判「同一 turn」）→ 保留计时基线与字符累计。
    if (part.turnStartedAt === null || !turnAnchorMatches(next.messages, part)) {
      startTurn(next.messages)
    }
    // 快路径判据逐边沿刷新（O(1) 尾查）；长度差累计已随字符观测退役（设计 §2.3）。
    part.lastAssistantId = findLastAssistantMessage(next.messages)?.id ?? null
    ensureTicking()
    tick()
  }
  watch(turnProgressSource, onTurnProgressEdge, { immediate: true })

  /** 用户点「继续等待」（中性操作项）：本 turn 内抑制警示（warn=false，不再告警）。 */
  function snoozeWarn(): void {
    const sid = sessionId.value
    if (!sid) return
    currentPartition().snoozed = true
    if (snapshot.value) snapshot.value = { ...snapshot.value, warn: false }
  }

  return {
    snapshot,
    snoozeWarn,
  }
}
