/**
 * RestartPolicy —— runtime 崩溃重启策略（纯逻辑，无 electron 依赖，可单测）。
 *
 * 职责（单一变化轴「重启编排决策」）：
 * - 判定是否应重启（stopping 标志 / 计数上限）
 * - 计算退避延迟（指数退避，1s/2s/4s/8s/16s）
 * - 崩溃计数只在用户显式重试（clearForManualRestart）时清零，无时间窗
 *
 * 从 supervisor 抽出是因为：supervisor 重度依赖 electron（app/BrowserWindow/child_process），
 * main 层 vitest 只测纯函数（vitest.config 注释）。把决策逻辑抽成纯类，
 * supervisor 组合它，策略部分可独立单测。
 *
 * [HISTORICAL] 不变量：
 * 1. shouldRestart 检查顺序：stopping（短路）→ 计数上限。主动退出绝不重启
 * 2. 崩溃计数不按时间窗清零（原 STABLE_MS=10s 稳定窗已删，ADR-0112：时间窗
 *    猜测属无效防御）——recordSuccess 只记录事实，计数清零唯一入口是
 *    clearForManualRestart（用户显式重启服务的事件）
 * 3. 退避序列：2^(n-1) * BASE，clamp MAX，n=1..MAX_RESTARTS → 1s/2s/4s/8s/16s
 */

/** 重启退避基数（ms），第 N 次重启延迟 = BASE * 2^(N-1) */
export const RESTART_BASE_DELAY_MS = 1_000
/** 退避指数（每次 ×2） */
export const RESTART_BACKOFF_EXPONENT = 2
/** 最大退避延迟（ms），第 5 次 = 16s < ws-client MAX_RECONNECT 30s，确保 supervisor 重启快于前端重连 */
export const MAX_RESTART_DELAY_MS = 16_000
/** 最大重启次数（持续性故障判定阈值，1+2+4+8+16=31s + 每次重启 ~2s ≈ 40s 给出结论） */
export const MAX_RESTARTS = 5
/**
 * planned 边的重启延迟 = 0（立即重启，零退避——crash-forensics D5 ④）。
 */
export const PLANNED_RESTART_DELAY_MS = 0

/**
 * 重启策略状态机（纯逻辑）。
 *
 * 生命周期：
 * ```
 * idle ──recordCrash──▶ counting ──recordCrash──▶ ... ──超过 MAX──▶ exhausted
 *   │                       │
 *   │                       └─recordSuccess（无操作，计数只在手动重试时清零）
 *   └─recordSuccess（无操作，计数本就 0）
 * exhausted ──clearForManualRestart──▶ idle（用户显式重试入口）
 *
 * recordPlanned（u7c）：planned 边 idle ──▶ idle——计划内滚动重启退出（码 86）不进
 * counting 状态机：不递增计数、不产生退避（返回 PLANNED_RESTART_DELAY_MS=0 立即重启）、
 * 不受 MAX/shouldRestart 门约束（设计 D5 ④「立即重启、跳过退避与崩溃计数」）。
 * ```
 */
export class RestartPolicy {
  private restartCount = 0
  private _stopping = false

  /** 主动停止标志（stop() 设 true，start() 重置 false） */
  get stopping(): boolean {
    return this._stopping
  }

  /** 标记主动停止（onExit 回调检查此标志，true 则不重启） */
  markStopping(): void {
    this._stopping = true
  }

  /**
   * 重置停止标志（start() 开头调，标志新生命周期的开始）。
   * 注意：不清零 restartCount——start() 可能在崩溃自动重启路径被调，
   * 清计数会导致崩溃计数永远不累计。手动重试清计数用 clearForManualRestart。
   */
  reset(): void {
    this._stopping = false
  }

  /**
   * 手动重试清零：重置停止标志 + 清计数（给新的 MAX 次配额）。
   * 仅 restartRuntime（用户点重试按钮）调，自动重启路径不调。
   * 这是崩溃计数清零的唯一入口（用户显式重启服务的事件驱动）。
   */
  clearForManualRestart(): void {
    this._stopping = false
    this.restartCount = 0
  }

  /**
   * 判定是否应该重启（onExit 回调调此方法）。
   * 检查顺序：stopping 短路 → 计数上限。
   * @returns true=应重启，false=放弃（主动退出或已耗尽）
   */
  shouldRestart(): boolean {
    if (this._stopping) return false
    return this.restartCount < MAX_RESTARTS
  }

  /**
   * 记录一次崩溃并返回下次重启的退避延迟（ms）。
   * 递增计数，计算 2^(count) * BASE（clamp MAX）。
   * 调用前应先 shouldRestart() 判定，否则抛错。
   */
  recordCrashAndGetDelay(): number {
    if (!this.shouldRestart()) {
      throw new Error('recordCrashAndGetDelay called after exhausting restarts')
    }
    this.restartCount++
    const raw = RESTART_BASE_DELAY_MS * Math.pow(RESTART_BACKOFF_EXPONENT, this.restartCount - 1)
    return Math.min(raw, MAX_RESTART_DELAY_MS)
  }

  /**
   * 与 recordCrashAndGetDelay 的差异（A4 验收语义）：不递增 restartCount（不进
   * counting 状态机）、不做 shouldRestart 门检查（planned 不受 MAX 配额约束——
   * exhausted 态下滚动重启仍须照常重启）、返回 PLANNED_RESTART_DELAY_MS=0（立即
   * 重启零退避）。不动 stopping。
   */
  recordPlanned(): number {
    return PLANNED_RESTART_DELAY_MS
  }

  /**
   * 记录重启成功（只记录事实，不改计数）。
   * 崩溃计数无时间窗清零（ADR-0112：时间窗猜测属无效防御）——清零唯一入口
   * 是 clearForManualRestart（用户显式重试）。
   */
  recordSuccess(): void {
    // 无操作：保留方法以维持 supervisor 调用面稳定（记录点的存在本身有日志价值时再扩展）
  }

  /** 当前重启计数（测试/日志用） */
  get count(): number {
    return this.restartCount
  }

  /** 是否已耗尽重启次数（测试/日志用） */
  get exhausted(): boolean {
    return this.restartCount >= MAX_RESTARTS
  }
}
