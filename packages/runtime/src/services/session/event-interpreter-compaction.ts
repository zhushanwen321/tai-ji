/**
 * CompactionNotifier — compaction 生命周期事件编排（M4 事件驱动：interpreter 唯一源）。
 *
 * [协作对象，T4 拆分] 从 event-interpreter.ts 按变化轴抽出：compaction_start/end 到 WS 帧
 * 广播（session.compacting / session.compacted / message.compactionSummary / message.error）
 * 与副作用回调（isCompacting 置复位 / occupancy 转移 / context 用量刷新 / trace 补拉）的
 * 纯同步编排自成一体，无内部状态、与 interpreter 主循环无时序耦合（case 直调、无 await）。
 * 本对象不持有 interpreter 主引用（send 与四个回调经窄依赖注入）。
 */
import type { ServerMessage } from '@taiji/shared'
import type { SessionOccupancyTransition } from './types.js'

/** CompactionNotifier 窄依赖（EventInterpreterOptions 的结构化投影）。 */
export interface CompactionNotifierDeps {
  sessionId: string
  /** WS 帧发送。 */
  send: (msg: ServerMessage) => void
  /** compaction 生命周期态切换（M4 事件驱动，sendPrompt/sendBash 预检互斥依据）。 */
  onCompactingStateChange?: (sessionId: string, isCompacting: boolean) => void
  /** occupancy 挂点回调（'compacting-start' / 'compacting-end' 转移，经原语合并派生广播）。 */
  onOccupancyTransition?: (transition: SessionOccupancyTransition) => void
  /** context 事件失效（成功 compaction 后以 estimatedTokensAfter 刷新用量）。 */
  onContextUpdate?: (sessionId: string, data: { inputTokens: number; totalTokens: number }) => void
  /** session-trace 增量腿补拉回调（compaction_end 触发信号的第四类挂点）。 */
  onTraceSync?: (sessionId: string, trigger: string) => void
  /**
   * **成功** compaction 后的上下文重写通知（归因降噪 2026-09-19）：命中率归因链路用
   * （GenStatsService.markContextRewritten）——其后首条缓存样本若显示 0% 属预期重建。
   * 只在 `ev.result` 真值（成功）分支调用：failed（errorMessage 真值）与 aborted（无 result
   * 无 error）上下文未变，误标会把真 miss 洗成「压缩重建」。
   */
  onContextRewritten?: () => void
}

/** compaction_end 事件参与编排的字段子集（infra/pi 翻译后事件 compaction-end 分支的结构化投影）。 */
export interface CompactionEndFields {
  result?: unknown
  aborted: boolean
  errorMessage?: string
}

export class CompactionNotifier {
  constructor(private readonly deps: CompactionNotifierDeps) {}

  /**
   * compaction_start → 广播 session.compacting{reason} + 置 runtime active.isCompacting=true。
   *
   * reason 透传给前端，驱动 compacting 浮层文案区分手动（'manual'）/自动（'threshold'|'overflow'）。
   * runtime active.isCompacting 经 onCompactingStateChange 回调置位，sendPrompt/sendBash 预检据此互斥。
   */
  onCompactionStart(reason: string): void {
    const { sessionId, send } = this.deps
    send({
      type: 'session.compacting',
      payload: { sessionId, status: 'compacting', reason },
    })
    this.deps.onCompactingStateChange?.(sessionId, true)
    // occupancy #5（D2 迁移）：compaction_start → 'compacting-start'。原语派生 isCompacting=true
    // + 合并 compacting=true（与 turn 维度正交：threshold 模式 turn 内压缩 = generating+compacting
    // 并存，overflow/manual 多为 idle/settling+compacting）。上方 onCompactingStateChange 通道
    // 由组合根接线到同一原语行，幂等去重。
    this.deps.onOccupancyTransition?.('compacting-start')
  }

  /**
   * compaction_end → 唯一驱动 compaction 终态（成功/aborted/failed 三路）。
   *
   * 失败判据：errorMessage 真值为 failed（非 aborted 字段、非 key 存在性）—— pi 三种 aborted:true
   * 形态在 errorMessage 真值层面一致（extension cancel/signal abort 无 key；手动 catch 取消类
   * errorMessage 为 undefined）。分叉干净。
   *
   * 三路均复位 isCompacting（与 compaction_start 置位对称，SUG-新2）—— 否则 auto compact 结束后
   * active.isCompacting 永远 true，sendPrompt 预检永远拒，session 卡死。
   *
   * 孤儿 end 容错（SUG-新3）：overflow「已 retry 过一次」早退路径无 preceding start，end handler
   * 复位对「本来就 false 的 isCompacting」幂等无害；不维护 start/end 配对状态机。
   */
  onCompactionEnd(ev: CompactionEndFields): void {
    const { sessionId, send } = this.deps
    const hasError = !!ev.errorMessage
    if (hasError) {
      // failed：广播 session.compacted{error}（前端 compacted handler error 非空 → 不 flush，队列保留）
      // + message.error 进对话流（错误作为 assistant 消息插入，AGENTS.md 规则 #3）。
      send({
        type: 'session.compacted',
        payload: { sessionId, status: 'compacted', error: ev.errorMessage },
      })
      send({
        type: 'message.error',
        payload: { sessionId, message: `上下文压缩失败：${ev.errorMessage}（可重试 /compact，上下文未压缩、agent 记忆未变）` },
      })
    } else {
      // 成功（result 真值）或 aborted（无 errorMessage 真值）—— 都不带 error，前端 compacted handler flush queue。
      // 成功额外发 compactionSummary 进对话流 + applyContextUpdate 刷新 context 用量。
      if (ev.result) {
        // 归因降噪（2026-09-19）：成功 compaction 即上下文前缀被重写——先标记后发帧（同
        // 同步临界段内无时序窗口；标记只影响后续样本的归因注解，不阻断本帧发送）。
        this.deps.onContextRewritten?.()
        const r = ev.result as { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number }
        // [D2 closure] 恒发帧（原 `if (r.summary)` 真值门删除，conversation-turn-attribution-
        // closure D2）：pi appendCompaction 无条件落盘（手动 :1432 / auto :1670），summary 缺失的
        // 成功 compaction 旧逻辑 live 无消息、重开有 reducer fallback「上下文已压缩」行（登记
        // 例外④）。下游已全就绪——shared CompactionSummary.summary 可选、registry
        // readCompactionSummary 空串透传门（`s !== undefined`，实施审查 MF-1：truthiness 门会把
        // '' 丢成 undefined 制造两侧内容分叉）+ 条件窄化、reducer `summary ?? fallback`——
        // undefined 与 '' 两种形态各自两侧同值同路径（E4b/E4c 锁定）。
        send({
          type: 'message.compactionSummary',
          payload: {
            sessionId,
            summary: r.summary,
            tokensBefore: r.tokensBefore,
            timestamp: Date.now(),
          },
        })
        if (typeof r.estimatedTokensAfter === 'number' && r.estimatedTokensAfter > 0) {
          // compact 后无 turn_end，context 用量不会自动刷新。用 pi 返回的估算值触发 applyContextUpdate。
          this.deps.onContextUpdate?.(sessionId, {
            inputTokens: r.estimatedTokensAfter,
            totalTokens: r.estimatedTokensAfter,
          })
        }
      }
      send({
        type: 'session.compacted',
        payload: { sessionId, status: 'compacted' },
      })
    }
    // 三路复位对称（SUG-新2）
    this.deps.onCompactingStateChange?.(sessionId, false)
    // occupancy #6（D2 迁移）：compaction_end（成功/失败/aborted 三路均复位）→ 'compacting-end'。
    // 原语派生 isCompacting=false + 合并 compacting=false；上方通道同原语行，幂等去重。
    this.deps.onOccupancyTransition?.('compacting-end')
    // session-trace 增量腿（A33）：compaction entry 的 append 先于 compaction_end emit
    //（时序已核实，design D4），成功/aborted 路径都补拉（aborted 无新 entry 时 sync 内部
    // 空 delta 不广播）；failed 路径也补——追赶式拉取以 pi 侧实际状态为准。
    this.deps.onTraceSync?.(sessionId, 'compaction_end')
  }
}
