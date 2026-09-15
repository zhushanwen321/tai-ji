/**
 * RespawnOrchestrator —— pi 崩溃自动恢复编排（crash-resilience §3.3 D7，实施计划 u8-pi-respawn）。
 *
 * 挂点（D7-①）：SessionService 构造器的 pm.onSessionExit 链尾部（process-manager.ts 的
 * exit 回调只对「非 intentional destroy」通知——forceQuitSession 在 message-dispatcher
 * 手工编排、exit 事件被 _killing/processes.has 双层守卫拦截，不经本链，故用户手动强制
 * 退出构造性不触发自动恢复，A7 反向验收）。
 *
 * 生命周期边界（D7 全文）：
 * - ② 5s 延迟 + 取消语义：pending 恢复以 timer 挂本模块；runtime shutdown 序列先调
 *   cancelAll() 再 destroyAll（index.ts shutdown，对齐 u5b stopMemoryWatermarkTimer
 *   先例——否则 shutdown 中途 spawn 新孤儿 pi，收割器只在下次启动 5s 后跑一次，用户
 *   直接退出 app 则孤儿无限存活）；session 删除（removeSessionEntry 汇聚点）同样取消。
 *   timer 恒 unref：恢复编排是管理面动作，不得阻止进程自然退出（cancelAll 是第一道，
 *   unref 是兜底）。
 * - ③ 并发 join（双向构造性）：join 语义本体 = 本模块 ensureRestored（in-flight 注册表
 *   单一所有者）。自动恢复的执行也经 ensureRestored 走（attemptRespawn 不直呼
 *   deps.restore）——恢复期间登记 in-flight，timer 触发后 spawn+attach 秒级窗口内用户
 *   发消息（ensureActive→ensureRestored）join 同一 Promise，不报错不双跑；反方向，
 *   恢复启动前查 restoringSessions（in-flight 惰性恢复 → 跳过自动恢复）+ timer 触发时
 *   复查（5s 窗口内用户先发消息即走惰性恢复，自动恢复让位）。
 * - ④ 恢复承诺不跨 runtime 重启：本模块全部状态在进程内存，supervisor 重启后无 pending
 *   恢复，dead session 等用户交互惰性恢复（既有路径）。
 *
 * 熔断：连续失败 2 次（spawn/附着失败——含文件头损坏等极端形态的 MissingSessionCwdError，
 * cwd 死路径常态已由附着前最小规范化的首行 cwd fallback 修复，见 restore-seeding）
 * → 停止自动重试，session 保持 dead，推 willRetry=false 的 session.restoreFailed（前端
 * 切失败态提示条 + 手动重试按钮）；任一次自动恢复成功 → 计数清零（notifyRestored，
 * 挂在 facade.restoreSession 成功路径——手动恢复成功同样清零，保证未来崩溃获得全新
 * 自动恢复额度）。
 *
 * 消息推送（仓规规则 7）：session.restored / session.restoreFailed 必带 sessionId，
 * 经 messageBus session 级 publish（stream topic 入 ring，断连重连回放可见）。
 */
import type { ServerMessage } from '@taiji/shared'
// D1 台账（crash-forensics §3.3 D1）：auto-respawn 四态决策点与决策日志同点双写
//（决策日志给 grep，台账给结构化消费——设计 D1 写入点矩阵「pi crash / auto-respawn 四态」行）。
import { getCrashJournal } from '../../infra/crash-journal.js'

/** 台账 detailDigest 上限（设计 D1 防漏设计①：内嵌摘要 ≤2KB）。 */
const RESPAWN_DIGEST_MAX_CHARS = 2048

/** 截断时为同行其余字段（attempt/willRetry/前缀文案）预留的字符预算。 */
const RESPAWN_DIGEST_RESERVED_CHARS = 128

/** 崩溃 → 自动恢复的延迟（D7-②，设计定值 5s：避开崩溃现场的连坐终止窗口——relay kill /
 *  reapSessionBackgroundTasks 在崩溃时同步收割子任务，立即 respawn 会与之竞争）。 */
export const RESPAWN_DELAY_MS = 5_000

/** 自动恢复连续失败熔断阈值（D7：2 次——同参数再起再崩大概率是坏 extension 配置等
 *  持久性故障，无限重试 = 崩溃循环；第 2 次失败后停止，交用户手动决策）。 */
export const RESPAWN_MAX_CONSECUTIVE_FAILURES = 2

/** 恢复编排依赖（窄接口注入，SessionService 组装——与 traceSync/records 的 deps 形态一致）。 */
export interface RespawnDeps {
  /** session 是否有活进程（true = 已恢复/用户已惰性恢复，自动恢复无必要）。
   *  可选调用语义由组装方保证（port 缺失按 false 继续，守卫不得成为崩溃链新故障源）。 */
  isActive: (sessionId: string) => boolean
  /**
   * 恢复动作内核（复用惰性恢复内核 facade.restoreSession——附着自动走 u4c 预算化路径）。
   * 仅 ensureRestored 消费（恢复执行统一经注册表登记——attemptRespawn 不直呼本方法）。
   */
  restore: (sessionId: string) => Promise<unknown>
  /** session 级消息发布（sessionId 必带，规则 7；bus 未注入时由组装方 no-op）。 */
  publish: (sessionId: string, msg: ServerMessage) => void
}

export class RespawnOrchestrator {
  private readonly deps: RespawnDeps
  /** pending 恢复 timer（sessionId → handle）。取消语义的状态载体。 */
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>()
  /** 连续自动恢复失败计数（sessionId → 次数）。成功清零；≥ 阈值 = 熔断。 */
  private readonly consecutiveFailures = new Map<string, number>()
  /**
   * in-flight 恢复注册表（sessionId → Promise，D7-③ join 状态 SSOT）。
   * [HISTORICAL] 原 Set 形态挂 SessionService（并发 ensureActive 直接 throw）——本类接管后
   * 自动恢复与惰性恢复共享同一注册表：join（不报错不双跑）+ 自动恢复启动前/触发时双重
   * 让位检查，一处状态两方消费，不再可能漂移。
   */
  private readonly restoringSessions = new Map<string, Promise<void>>()

  constructor(deps: RespawnDeps) {
    this.deps = deps
  }

  /**
   * 崩溃挂点入口：调度一次 5s 延迟的自动恢复（onSessionExit 链尾部调用）。
   *
   * 启动前守卫（按 D7-③ 启动前检查）：
   * - 活跃（pm.hasClient）→ 无需恢复（防御：exit 链已清 processes，正常不可达）；
   * - in-flight 恢复（restoringSessions）→ 用户先发消息触发的惰性恢复在跑，让位（join
   *   语义保证其完成后 session 活跃，无需自动恢复）；
   * - 已熔断（连续失败 ≥ 2）→ 不再自动恢复（session 保持 dead）。
   *
   * 决策日志（D6-⑥ 同款「谁触发、对谁、为什么」）：每次调度落一行，崩溃恢复链路可归因。
   */
  schedule(sessionId: string): void {
    if (this.deps.isActive(sessionId)) return
    if (this.isRestoring(sessionId)) {
      console.log(`[pi-respawn] session ${sessionId} has in-flight restore — skip auto respawn (join semantics, D7-3)`)
      return
    }
    if (this.isTripped(sessionId)) {
      console.log(`[pi-respawn] session ${sessionId} respawn breaker tripped (${this.consecutiveFailures.get(sessionId)} consecutive failures) — skip auto respawn`)
      return
    }
    this.clearTimer(sessionId)
    const attempt = this.consecutiveFailures.get(sessionId) ?? 0
    console.log(`[pi-respawn] session ${sessionId} pi process died unexpectedly — auto restore scheduled in ${RESPAWN_DELAY_MS}ms (attempt ${attempt + 1})`)
    // D1 台账「scheduled」态：携带 attempt 序号与延迟 ms（schema 无专字段，摘要入
    // detailDigest ≤2KB）。守卫 early-return 路径（in-flight / 熔断）是「不调度」决策，
    // 不属四态，不产生事件。
    getCrashJournal().append({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'scheduled',
      sessionId,
      detailDigest: `attempt=${attempt + 1} delayMs=${RESPAWN_DELAY_MS}`,
    })
    this.armTimer(sessionId)
  }

  /**
   * 单次自动恢复尝试（timer 触发）。触发时复查守卫（5s 窗口内状态可能已变：
   * 用户惰性恢复已完成 / 用户已删除 session / 熔断已触发）。
   *
   * 成功 → 计数清零 + 推 session.restored；
   * 失败 → 计数 +1 + 推 session.restoreFailed{willRetry}；未达熔断阈值时续排下一次
   * 尝试（同 RESPAWN_DELAY_MS 间隔——兼作重试退避）。restore 本身抛错不外泄
   *（fire-and-forget 链，失败走 restoreFailed 推送 + error 日志）。
   */
  private async attemptRespawn(sessionId: string): Promise<void> {
    if (this.deps.isActive(sessionId) || this.isRestoring(sessionId)) {
      console.log(`[pi-respawn] session ${sessionId} already active/restoring at timer fire — skip auto respawn`)
      return
    }
    if (this.isTripped(sessionId)) return
    const attempt = (this.consecutiveFailures.get(sessionId) ?? 0) + 1
    console.log(`[pi-respawn] session ${sessionId} auto restore starting (attempt ${attempt}/${RESPAWN_MAX_CONSECUTIVE_FAILURES})`)
    // D1 台账「attempt」态：恢复动作实际发起时点。
    getCrashJournal().append({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'attempt',
      sessionId,
      detailDigest: `attempt=${attempt}/${RESPAWN_MAX_CONSECUTIVE_FAILURES}`,
    })
    try {
      // 经 ensureRestored 执行（不直呼 deps.restore）：恢复期间登记 in-flight 注册表，
      // spawn+attach 秒级窗口内用户发消息（ensureActive→ensureRestored）join 同一
      // Promise——join 双向构造性成立（D7-③：restore 内核全程只跑一次，P-respawn-join）。
      await this.ensureRestored(sessionId)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const willRetry = attempt < RESPAWN_MAX_CONSECUTIVE_FAILURES
      this.consecutiveFailures.set(sessionId, attempt)
      console.error(`[pi-respawn] session ${sessionId} auto restore failed (attempt ${attempt}/${RESPAWN_MAX_CONSECUTIVE_FAILURES}, willRetry=${willRetry}):`, message)
      // D1 台账「failed」终态：事件名 auto-respawn-failed 与成功态可区分；reason 二值区分
      // 后续走向（续排重试 / 熔断放弃）。错误消息截断内嵌（≤2KB 防线，取头部保留根因首现）。
      const errorDigest = message.length > RESPAWN_DIGEST_MAX_CHARS - RESPAWN_DIGEST_RESERVED_CHARS
        ? `${message.slice(0, RESPAWN_DIGEST_MAX_CHARS - RESPAWN_DIGEST_RESERVED_CHARS)}…`
        : message
      getCrashJournal().append({
        layer: 'pi',
        event: 'auto-respawn-failed',
        reason: willRetry ? 'retry-scheduled' : 'breaker-tripped',
        sessionId,
        detailDigest: `attempt=${attempt}/${RESPAWN_MAX_CONSECUTIVE_FAILURES} willRetry=${willRetry} error=${errorDigest}`,
      })
      this.deps.publish(sessionId, {
        type: 'session.restoreFailed',
        payload: { sessionId, attempts: attempt, willRetry, reason: message },
      })
      if (willRetry) {
        console.log(`[pi-respawn] session ${sessionId} retry scheduled in ${RESPAWN_DELAY_MS}ms (attempt ${attempt + 1})`)
        this.armTimer(sessionId)
      } else {
        console.warn(`[pi-respawn] session ${sessionId} respawn breaker tripped — session stays dead, waiting for user action (manual retry / lazy restore)`)
      }
      return
    }
    // 成功：计数清零（连续失败语义归零）+ 推 restored（前端插恢复提示条 + 复位 dead 态）。
    this.consecutiveFailures.delete(sessionId)
    console.log(`[pi-respawn] session ${sessionId} auto restore succeeded (attempt ${attempt})`)
    // D1 台账「success」态：reason=succeeded 与 failed 态事件（auto-respawn-failed）可区分。
    getCrashJournal().append({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'succeeded',
      sessionId,
      detailDigest: `attempt=${attempt}`,
    })
    this.deps.publish(sessionId, {
      type: 'session.restored',
      payload: { sessionId, attempts: attempt },
    })
  }

  /** 任一次自动恢复成功（含用户手动恢复，挂 facade.restoreSession 成功路径）→ 计数清零。 */
  notifyRestored(sessionId: string): void {
    if (this.consecutiveFailures.delete(sessionId)) {
      console.log(`[pi-respawn] session ${sessionId} restored — consecutive failure count reset`)
    }
  }

  /**
   * 惰性恢复内核（D7-③ join 改造，原 SessionService.ensureActive 的 restore 腿接管）：
   * 无 in-flight → 登记并执行 restore；已有 in-flight → join（返回并等待同一 Promise，
   * 不报错不双跑——T4：自动恢复进行中用户发消息，等恢复完成后继续）；原恢复失败则
   * join 方得到同一失败（不吞错）。
   *
   * 是否有活进程（exited client 纵深防御）仍归 SessionService.ensureActive 前置判定——
   * 本方法只负责「恢复执行 + in-flight 簿记」。
   */
  async ensureRestored(sessionId: string): Promise<void> {
    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) {
      console.log(`[pi-respawn] ensureRestored: joining in-flight restore for ${sessionId}`)
      return inFlight
    }
    const restorePromise: Promise<void> = (async () => {
      console.log(`[pi-respawn] ensureRestored: restoring ${sessionId}...`)
      await this.deps.restore(sessionId)
    })()
    this.restoringSessions.set(sessionId, restorePromise)
    try {
      await restorePromise
    } finally {
      // 身份守卫：只清自己登记的条目（防并发清理路径误删他人的 in-flight）。
      if (this.restoringSessions.get(sessionId) === restorePromise) {
        this.restoringSessions.delete(sessionId)
      }
    }
  }

  /** 是否有 in-flight 恢复（schedule/attempt 双重让位检查 + 组装方可查询）。 */
  isRestoring(sessionId: string): boolean {
    return this.restoringSessions.has(sessionId)
  }

  /**
   * 取消 pending 恢复 timer（session 删除 / shutdown 取消语义，D7-②）。
   * 只清 timer 不清失败计数：removeSessionEntry 汇聚点被 restoreSession 清场复用
   *（lifecycle.restoreSession 对 existing 的 detach+destroy+remove），在 attempt 中途
   * 清计数会破坏熔断（失败计数归零 → willRetry 恒真 → 无限重试）。计数清零唯一入口 =
   * notifyRestored（成功）；残留计数随 session 生命周期自然消亡（进程结束 / 恢复成功）。
   */
  cancel(sessionId: string): void {
    this.clearTimer(sessionId)
  }

  /** 取消全部 pending 恢复 timer（runtime shutdown 序列专用，先于 destroyAll 调用）。 */
  cancelAll(): void {
    for (const sessionId of Array.from(this.pendingTimers.keys())) {
      this.cancel(sessionId)
    }
  }

  /** pending 恢复中的 session id（诊断 / 测试断言面）。 */
  pendingSessionIds(): string[] {
    return Array.from(this.pendingTimers.keys())
  }

  /** 熔断是否已触发（连续失败 ≥ 阈值）。 */
  isTripped(sessionId: string): boolean {
    return (this.consecutiveFailures.get(sessionId) ?? 0) >= RESPAWN_MAX_CONSECUTIVE_FAILURES
  }

  private clearTimer(sessionId: string): void {
    const timer = this.pendingTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pendingTimers.delete(sessionId)
    }
  }

  /** 挂 5s 延迟 timer（schedule 首次调度与失败重试共用的裸挂载——不做守卫判定）。 */
  private armTimer(sessionId: string): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(sessionId)
      void this.attemptRespawn(sessionId)
    }, RESPAWN_DELAY_MS)
    // unref：管理面 timer 不阻塞进程退出（cancelAll 是第一道，shutdown 显式取消）。
    timer.unref?.()
    this.pendingTimers.set(sessionId, timer)
  }
}
