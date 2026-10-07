/**
 * RespawnOrchestrator —— pi 崩溃上报 + 惰性恢复 join 编排。
 *
 * [ADR-0122 防御机制清查退役登记（2026-10-05 用户裁决）] 原「崩溃 → 5s 延迟自动恢复 +
 * 连续失败熔断」编排（crash-resilience §3.3 D7 的 A 重试机制，含 RESPAWN_DELAY_MS /
 * RESPAWN_MAX_CONSECUTIVE_FAILURES / attemptRespawn 重试链）已整体删除——崩溃处置改为
 * 显式上报（RespawnFate 'terminal' → 死亡发声），恢复决策归用户（手动重试 / 惰性恢复）。
 * 本模块保留的结构组件（非防御，删除会断裂恢复链）：
 * - ensureRestored：in-flight 恢复注册表 + join 语义（u8 D7-③ 从 SessionService.ensureActive
 *   迁入的恢复执行单源——自动与惰性恢复曾共享，现仅惰性/手动恢复消费）；
 * - onRestoreSuccess：恢复成功出口（session.restored 发布判别 + crashed 登记核销）；
 * - cancel / cancelAll：session 删除 / shutdown 的登记清理。
 *
 * 挂点（D7-① 沿用）：SessionService 构造器的 pm.onSessionExit 链尾部（exit 回调只对
 * 「非 intentional destroy」通知——forceQuitSession 在 message-dispatcher 手工编排、exit
 * 事件被 _killing/processes.has 双层守卫拦截，不经本链）。
 *
 * 消息推送（仓规规则 7）：session.restored 必带 sessionId，经 messageBus session 级 publish
 * （stream topic 入 ring，断连重连回放可见）。
 */
import type { ServerMessage } from '@taiji/shared'

/** 恢复编排依赖（窄接口注入，SessionService 组装——与 traceSync/records 的 deps 形态一致）。 */
export interface RespawnDeps {
  /** session 是否有活进程（true = 已恢复/用户已惰性恢复）。
   *  可选调用语义由组装方保证（port 缺失按 false 继续，守卫不得成为崩溃链新故障源）。 */
  isActive: (sessionId: string) => boolean
  /**
   * 恢复动作内核（复用惰性恢复内核 facade.restoreSession——附着自动走 u4c 预算化路径）。
   * 仅 ensureRestored 消费。
   */
  restore: (sessionId: string) => Promise<unknown>
  /** session 级消息发布（sessionId 必带，规则 7；bus 未注入时由组装方 no-op）。 */
  publish: (sessionId: string, msg: ServerMessage) => void
}

/**
 * 崩溃终态命运事件（notify-once D5 death 收口挂点）：组合根 index.ts 据以判定子会话
 * 进程死亡是否发声——
 * - 'recovered'：session 活跃/恢复中（惰性恢复在跑将复活）——静默，丢弃退出现场 stash；
 * - 'terminal'：崩溃上报——按不可恢复 crash 发声（携原 crash 的 exitCode/stderrTail
 *   stash，同 deathSeq 递增）。恢复决策归用户（ADR-0122：自动重试退役）。
 * 模块级订阅（组合根单消费方）；无订阅者时零开销，测试构造的 orchestrator 实例不受扰。
 */
export type RespawnFate = 'recovered' | 'terminal'
export interface RespawnFateEvent {
  sessionId: string
  fate: RespawnFate
}
const respawnFateListeners = new Set<(e: RespawnFateEvent) => void>()

/** 订阅 respawn 终态命运（返回退订函数；组合根 notify-once 接线）。 */
export function onRespawnFate(cb: (e: RespawnFateEvent) => void): () => void {
  respawnFateListeners.add(cb)
  return () => { respawnFateListeners.delete(cb) }
}

function emitRespawnFate(sessionId: string, fate: RespawnFate): void {
  for (const cb of [...respawnFateListeners]) {
    try {
      cb({ sessionId, fate })
    } catch (e: unknown) {
      // 订阅者异常不得阻断崩溃上报（best-effort 留痕，可回溯）
      console.error(`[pi-respawn] respawn-fate listener error (sessionId=${sessionId}, fate=${fate}):`, e)
    }
  }
}

export class RespawnOrchestrator {
  private readonly deps: RespawnDeps
  /**
   * 崩溃未恢复登记（sessionId 集合）：crashExit 上报时登记，onRestoreSuccess（手动/惰性
   * 恢复成功）或 cancel（session 删除）核销。onRestoreSuccess 的 session.restored 发布
   * 判别信号——命中 = 本次恢复是「崩溃后的恢复」，发布「崩溃恢复完成」提示。
   */
  private readonly crashedSessions = new Set<string>()
  /**
   * in-flight 恢复注册表（sessionId → Promise，u8 D7-③ join 状态 SSOT）。
   * [HISTORICAL] 原 Set 形态挂 SessionService（并发 ensureActive 直接 throw）——本类接管后
   * 恢复执行全程只跑一次（P-respawn-join），join 方不报错不双跑。
   */
  private readonly restoringSessions = new Map<string, Promise<void>>()

  constructor(deps: RespawnDeps) {
    this.deps = deps
  }

  /**
   * 崩溃挂点入口（onSessionExit 链尾部调用）：显式上报崩溃（ADR-0122——原 5s 延迟自动
   * 恢复调度已退役），恢复决策归用户。
   *
   * 上报前守卫：
   * - 活跃（pm.hasClient）→ 无需上报（防御位：exit 链已清 processes，正常不可达）；
   * - in-flight 恢复（restoringSessions）→ 用户先发消息触发的惰性恢复在跑，session 将
   *   复活——静默不发声（stash 丢弃）。
   */
  crashExit(sessionId: string): void {
    if (this.deps.isActive(sessionId)) {
      // 进程仍活（防御位）：非死亡终态，丢弃退出现场 stash（notify-once D5）
      emitRespawnFate(sessionId, 'recovered')
      return
    }
    if (this.isRestoring(sessionId)) {
      console.log(`[pi-respawn] session ${sessionId} has in-flight restore — silent (join semantics, D7-3)`)
      emitRespawnFate(sessionId, 'recovered')
      return
    }
    this.crashedSessions.add(sessionId)
    console.warn(`[pi-respawn] session ${sessionId} pi process died unexpectedly — report only, recovery waits for user action (manual retry / lazy restore)`)
    emitRespawnFate(sessionId, 'terminal')
  }

  /**
   * 恢复成功出口：判别 → 发布 session.restored → 核销崩溃登记，一顺完成。
   * 生产唯一调用点 = facade.restoreSession 成功尾部（四入口真实汇合点：惰性 ensureActive /
   * 手动 RPC / startup-reattach 的 restore 内核都是该 facade）。
   *
   * 发布判别：crashedSessions 命中 = 崩溃后的恢复，session.restored 帧语义「崩溃恢复完成」
   * （renderer 提示条）；未命中 = 普通懒 spawn / startup-reattach，静默恢复不发布。
   */
  onRestoreSuccess(sessionId: string): void {
    if (this.crashedSessions.delete(sessionId)) {
      this.deps.publish(sessionId, {
        type: 'session.restored',
        payload: { sessionId, attempts: 1 },
      })
    }
  }

  /**
   * 惰性恢复内核（u8 D7-③ join，原 SessionService.ensureActive 的 restore 腿接管）：
   * 无 in-flight → 登记并执行 restore；已有 in-flight → join（返回并等待同一 Promise，
   * 不报错不双跑——恢复进行中用户发消息，等恢复完成后继续）；原恢复失败则 join 方得到
   * 同一失败（不吞错）。
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

  /** 是否有 in-flight 恢复（crashExit 守卫 + 组装方可查询）。 */
  isRestoring(sessionId: string): boolean {
    return this.restoringSessions.has(sessionId)
  }

  /** 核销崩溃登记（session 删除 / restore 清场路径）。 */
  cancel(sessionId: string): void {
    this.crashedSessions.delete(sessionId)
  }

  /** 核销全部崩溃登记（runtime shutdown 序列专用）。 */
  cancelAll(): void {
    this.crashedSessions.clear()
  }
}
