/**
 * 续跑判定（设计 delivery-ownership-kernel.md D4②，单元 u4）。
 *
 * 背景（谁是问题源）：smart-context 的 `compact_context` 工具经 `ctx.compact()` 触发 **manual**
 * 压缩，pi 的 manual 路径先 `abort()` 当前 run 再压缩，且明文 "never retries or continues the
 * interrupted agent turn"（pi 实装 F5）——被掐断的 turn 今天靠「压缩结果通知自起 run」兜底，
 * 而那正是故事 C 竞态的另一半。本模块把它换成 runtime 侧判定 + 经投递内核 FIFO 的门内投递。
 *
 * 判定三条件（设计 §3.1 / D4②，逐条落到事件面）：
 * 1. **manual**：`compaction_end.reason === 'manual'`（pi 手动路径恒 'manual'；自动压缩为
 *    'threshold' | 'overflow'——auto 路径不掐 turn，pi 内部 post-run 继续运行，无需续跑）；
 * 2. **非 runtime 发起**：runtime 自己的 `/compact` 入口（transport session.compact RPC →
 *    sessionService.compact → dispatcher.compact → pi compact RPC）在 RPC 生命周期内打标
 *    （beginRuntimeCompact），本模块在 compaction_start 消费该标记——用户显式要求压缩 =
 *    明确不要续跑；
 * 3. **compaction_start 前 turn 被掐断**：以事件流事实为准——被 abort 掐断的 run 以
 *    `turn-end{stopReason:'aborted'}` 收尾（pi-agent-core runLoop 在 abort 时产出 aborted
 *    assistant message → turn_end/agent_end；pi 侧 `await abort()` 保证 agent_end 必先于
 *    compaction_start 到达），本模块记 `lastTurnCutByAbort` 并在 compaction_start 快照。
 *    不读 occupancy：abort→压缩链在 pi 内同步推进，runtime 投影到 compaction_start 时 turn
 *    相位已回落 settling/idle（实测序见探针 P-reason），投影不是可靠判据。
 *
 * 投递口径（D4② 后半句）：
 * - **经内核 FIFO**：投递只经 `submitResumeDelivery`（组合根注入 = registry.submit）——
 *   与用户消息同通道排队，lane 判定归内核，无第二个 prompt 发起方（抢跑结构消除）；
 *   本模块不直连 pi。
 * - **队列里已有用户消息时跳过**：内核活跃条目（queued/in-flight）在场 = 它们自然会起 run，
 *   压缩结果通知随 nextTurn 附着到那次 run（D4①），续跑投递多余。failed 条目不计数（不会
 *   起 run，等用户处置）。
 * - 压缩成败无关：turn 已被掐断与压缩成败无关（设计 §3.4「smart-context 压缩失败」行），
 *   failed/aborted 的 compaction_end 同样触发判定。
 *
 * 时序契约（组合根接线）：`observe()` 在 interpreter.interpret 之前调用（事件批原文观察），
 * `settle()` 在之后调用（投递发生时压缩态已复位 → 内核 lane 判定看到的是压缩后状态）。
 */
import type { DeliveryEntryState } from '@zhushanwen/session-delivery'

/**
 * 观察面事件子集（结构匹配 infra 翻译结果 PiTranslatedEvent，只取本判定需要的字段）。
 * 刻意不 import 完整联合：services 层禁 Pi* 类型名（C-comm-02，check_pi_type_leak），
 * 结构子集让本模块对翻译层新增事件类型免疫。
 */
export interface ObservedEvent {
  kind: string
  /** turn-end（pi agent_end）：末条 assistant message 的 stopReason（'aborted' = run 被掐断）。 */
  stopReason?: string
  /** compaction-start / compaction-end：'manual' | 'threshold' | 'overflow'。 */
  reason?: string
}

/** 组合根注入的窄依赖（测试可 mock）。 */
export interface ResumeDecisionDeps {
  /**
   * 读投递内核该 session 的活跃条目（跳过判定用）。undefined = 该 session 未建内核运行时
   * （无待投内容，按空集处理）。
   */
  listDeliveryEntries(sessionId: string): readonly { state: DeliveryEntryState }[] | undefined
  /** 经投递内核 FIFO 追加一条续跑投递（唯一投递通道；组合根注入 = registry.submit）。 */
  submitResumeDelivery(sessionId: string, content: string): void
  /** 留痕（命中/跳过原因；组合根注入 logger，测试注入 spy）。 */
  log?(message: string): void
}

/**
 * 续跑投递文案（检查点 5 结论：**固定续跑指令**，不携带压缩结果摘要）。
 *
 * 真机各试一次（2026-09-16，pi real model `opencode-go/mimo-v2.5-pro`，独立 pi RPC 驱动：
 * 三步任务进行至第 2 步 bash 期间调 `compact` 掐断 turn → 压缩成功后分别以两形态发提示）：
 * - 形态 A（本常量，固定指令）：agent 直接续跑完成剩余步骤并报告 DONE（首轮即收敛）；
 * - 形态 B（携带压缩前后 tokens + 「读摘要」指引）：同样续跑成功，但终局复述更长、
 *   与摘要在上下文中的既有承载重复。
 * 裁决依据 = 设计「以 agent 能顺畅恢复推进为准」+ 摘要有独立承载：压缩摘要随 transcript
 * （compactionSummary 上下文）与 D4① 的 nextTurn 结果通知注入，续跑文案无需复述事实；
 * 不引入 tokens 数值占位即少一处与 compaction_end result 字段的耦合。
 */
export const RESUME_DELIVERY_TEXT =
  '[smart-context] 上下文压缩已完成，你上一个回合因压缩被中断。请从中断处继续推进未完成的工作；若已无未完成的后续工作，简短说明当前状态即可。'

export interface ResumeDecision {
  /** 事件批观察（interpreter.interpret 之前调用；同一批内按到达序 fold）。 */
  observe(sessionId: string, events: readonly ObservedEvent[]): void
  /** 解释后收口（interpreter.interpret 之后调用）：执行投递判定与投递。 */
  settle(sessionId: string): void
  /**
   * runtime 发起 compact 的标记入口（实现者 = 组合根的 sessionService.compact 装饰包装）。
   * 返回清除函数：调用方在 RPC 生命周期内持标（finally 清除），本模块在 compaction_start
   * 消费快照——RPC 在途期与 compaction_start/end 窗口重叠（pi compact RPC 的响应在
   * compaction_end 之后才回），故「在途即本次发起」成立，无需时间窗。
   */
  beginRuntimeCompact(sessionId: string): () => void
  /** session 销毁清理（幂等）。 */
  dispose(sessionId: string): void
}

interface SessionState {
  /** 最近一次 turn-end 是否被 abort 掐断（compaction_start 时快照）。 */
  lastTurnCutByAbort: boolean
  /** compaction_start 快照：本次压缩前 turn 是否被掐断。 */
  snapshotCutTurn: boolean
  /** compaction_start 快照：本次压缩是否 runtime 发起。 */
  snapshotRuntimeInitiated: boolean
  /** compaction_start 已到、compaction_end 未到（孤儿 end 场景按「无快照」处理）。 */
  compactionOpen: boolean
  /** compaction-end 已判定待 settle 投递。 */
  pendingResume: boolean
  /** runtime compact RPC 在途计数（>0 = 本次 compaction 由 runtime 发起）。 */
  runtimeCompactInflight: number
}

function createState(): SessionState {
  return {
    lastTurnCutByAbort: false,
    snapshotCutTurn: false,
    snapshotRuntimeInitiated: false,
    compactionOpen: false,
    pendingResume: false,
    runtimeCompactInflight: 0,
  }
}

/** 内核条目是否含「会自然起 run」的在途用户消息（queued/in-flight；failed 不计数）。 */
function hasPendingDelivery(entries: readonly { state: DeliveryEntryState }[] | undefined): boolean {
  if (!entries) return false
  return entries.some((e) => e.state === 'queued' || e.state === 'in-flight')
}

export function createResumeDecision(deps: ResumeDecisionDeps): ResumeDecision {
  const sessions = new Map<string, SessionState>()

  const log = (message: string): void => {
    deps.log?.(message)
  }

  function stateOf(sessionId: string): SessionState {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const created = createState()
    sessions.set(sessionId, created)
    return created
  }

  /** compaction-start 观察：快照三条件中与本次压缩绑定的两条（reason 在 end 侧读）。 */
  function onCompactionStart(sessionId: string, st: SessionState): void {
    st.compactionOpen = true
    st.snapshotCutTurn = st.lastTurnCutByAbort
    st.snapshotRuntimeInitiated = st.runtimeCompactInflight > 0
    if (st.snapshotCutTurn) {
      log(
        `compaction start after cut turn (runtimeInitiated=${st.snapshotRuntimeInitiated}), sid=${sessionId}`,
      )
    }
  }

  /**
   * compaction-end 观察：三条件判定（manual + 非 runtime 发起 + 前 turn 被掐断）→ 置待投递。
   * 孤儿 end（无前置 start 快照）不判定（overflow 早退路径，设计 §3.4 同款容错口径）。
   */
  function onCompactionEnd(sessionId: string, st: SessionState, reason: string | undefined): void {
    const open = st.compactionOpen
    const cutTurn = st.snapshotCutTurn
    const runtimeInitiated = st.snapshotRuntimeInitiated
    st.compactionOpen = false
    st.snapshotCutTurn = false
    st.snapshotRuntimeInitiated = false
    if (!open) return
    if (reason !== 'manual') return
    if (runtimeInitiated) {
      log(`resume skipped: runtime-initiated (user /compact), sid=${sessionId}`)
      return
    }
    if (!cutTurn) {
      log(`resume skipped: no cut turn before compaction, sid=${sessionId}`)
      return
    }
    st.pendingResume = true
  }

  return {
    observe(sessionId, events) {
      if (events.length === 0) return
      const st = stateOf(sessionId)
      for (const ev of events) {
        if (ev.kind === 'turn-end') {
          st.lastTurnCutByAbort = ev.stopReason === 'aborted'
        } else if (ev.kind === 'compaction-start') {
          onCompactionStart(sessionId, st)
        } else if (ev.kind === 'compaction-end') {
          onCompactionEnd(sessionId, st, ev.reason)
        }
      }
    },

    settle(sessionId) {
      const st = sessions.get(sessionId)
      if (!st || !st.pendingResume) return
      st.pendingResume = false
      const entries = deps.listDeliveryEntries(sessionId)
      if (hasPendingDelivery(entries)) {
        // D4②：队列里已有用户消息 → 它们自然会起 run，压缩结果通知随 nextTurn 附着，
        // 续跑投递多余（不抢占用户消息的 FIFO 序）。
        log(`resume skipped: pending user message(s) in kernel queue, sid=${sessionId}`)
        return
      }
      log(`resume delivery (compaction cut the turn), sid=${sessionId}`)
      deps.submitResumeDelivery(sessionId, RESUME_DELIVERY_TEXT)
    },

    beginRuntimeCompact(sessionId) {
      const st = stateOf(sessionId)
      st.runtimeCompactInflight += 1
      let released = false
      return () => {
        if (released) return
        released = true
        st.runtimeCompactInflight = Math.max(0, st.runtimeCompactInflight - 1)
      }
    },

    dispose(sessionId) {
      sessions.delete(sessionId)
    },
  }
}
