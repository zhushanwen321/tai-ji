/**
 * PingProbe — pi 进程健康探测循环（ADR-0047，替代事件静默检测）。
 *
 * [协作对象，T4 拆分] 从 event-interpreter.ts 按变化轴抽出：ping 定时器、连续失败计数、
 * stream_warn 去重标志三个可变态及 tick 状态机自成封闭单元，与 interpreter 主编排无共享
 * 状态（解释见 event-interpreter.ts 头注「协作对象」节）。interpreter 经三个挂点委托：
 * turn-start → start()、turn-end → stop()、dispose → stop()。本对象不持有 interpreter
 * 主引用（send / pingPi / onSilentAbort 经窄依赖注入）。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * [ADR-0047] ping 间隔：turn 进行中每 60s 发一次 get_state 进程健康探测。
 *
 * 阈值依据见 ADR-0047「阈值依据」。平衡 RPC 流量（轻量）与响应速度。
 *
 * export 供测试 import（SR6 SSOT：测试跟随源码常量，不漂移）。
 */
export const PING_INTERVAL_MS = 60_000
/** [ADR-0047] 连续失败阈值：3 次（180s）→ 判定 pi 进程真死 → onSilentAbort。export 供测试（SR6）。 */
export const PING_FAIL_THRESHOLD = 3
/** [AC-8] 连续 2 次失败（120s）→ 广播 message.stream_warn 一次（提示性，不中断）。export 供测试（SR6）。 */
export const PING_WARN_FAIL_COUNT = 2

/** PingProbe 窄依赖（EventInterpreterOptions 的结构化投影，test mock 友好）。 */
export interface PingProbeDeps {
  sessionId: string
  /** WS 帧发送（stream_warn 广播腿）。 */
  send: (msg: ServerMessage) => void
  /**
   * [ADR-0047] ping get_state 探测回调（组合根注入）。
   *
   * 延迟解析 client：interpreter 在 session 创建时构造，那时 client 可能尚未 spawn。
   * 回调内部按当前 sessionId 取 pm.getClient(sessionId)?.getState()，client 未就绪时
   * 返回 undefined（计为一次失败但不抛错——AC-9：client 偶发未就绪不应让 interpret 批次崩溃）。
   *
   * 返回值语义：
   *   - resolve(非 undefined) → pi 健康（事件循环活，能响应 get_state）→ 清零失败计数
   *   - resolve(undefined)   → client 未就绪或拿不到 state → 计失败但不抛错（AC-9）
   *   - reject               → pi 真卡死（get_state 超时）→ 计失败
   *
   * 设计权衡：ping 能穿透所有「pi 合理等待」场景（ask_user / 网络 / 文件锁）——
   * pi 阻塞在 await 时事件循环仍活，get_state 必响应。只有进程真死才连续 3 次失败。
   * 详见 ADR-0047「ping 可行性验证」。
   */
  pingPi?: () => Promise<Record<string, unknown> | undefined> | undefined
  /** pi 卡死 abort 回调（连续 3 次失败触发；组合根调 sessionService.abort 复用兜底广播路径）。 */
  onSilentAbort?: (payload: { sessionId: string }) => void
}

export class PingProbe {
  /** ping 定时器句柄（null = 未在探测） */
  private timer: ReturnType<typeof setInterval> | null = null
  /** 当前连续失败计数（成功即清零） */
  private failCount = 0
  /** 本 turn 是否已广播过 message.stream_warn（避免重复） */
  private warned = false

  constructor(private readonly deps: PingProbeDeps) {}

  /**
   * 启动 ping 探测循环（turn-start 挂点）。
   *
   * 幂等：若已有循环在跑（如上一 turn 未正常 stop），先清。每次 turn-start 重置
   * 失败计数与 warned，确保跨 turn 独立计数（本 turn 第 1 次失败 = 新一轮，不继承上 turn）。
   */
  start(): void {
    this.stop()
    this.failCount = 0
    this.warned = false
    // [vitest 时序] setInterval 回调同步调度 tick；tick 内 await pingPi() 是微任务，
    // vi.advanceTimersByTimeAsync 能同时推进宏任务（setInterval tick）与被 flush 的微任务。
    this.timer = setInterval(() => { void this.tick() }, PING_INTERVAL_MS)
  }

  /** 停止 ping 探测循环（turn-end / dispose 挂点）。幂等。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 单次 ping tick：调 pingPi() 探测 pi 进程是否响应 get_state。
   *
   * 成功（resolve 非 undefined）→ 清零失败计数 + warned 标志（AC-8b：中途成功重置累积）。
   * 失败（reject 或 resolve undefined）→ failCount++；达 2 次且 !warned 广播 WARN；达 3 次触发 onSilentAbort + stop()（AC-7）。
   */
  private async tick(): Promise<void> {
    const cb = this.deps.pingPi
    if (!cb) return // 未注入 pingPi（如组合根尚未接入）→ 不探测，不误 abort
    let ok = false
    try {
      const state = await cb()
      // resolve(undefined) 计为失败但不抛错（AC-9：client 未就绪不算崩溃信号，累积到 3 次仍 abort）
      ok = state !== undefined
    } catch (e) {
      // SR5：记日志（经 logger patchConsole 落盘，架构约定 #4），不静默吞错——pi 卡死的真实诊断依赖此处
      console.warn('[event-interpreter] ping get_state failed:', e)
      ok = false
    }
    // SR1（M1 并发 bug）：await cb() 窗口最长 PING_INTERVAL_MS，期间 turn-end 可能已到来
    // 触发 stop()（清 timer）。此时已 in-flight 的 tick 绝不能继续更新 failCount——
    // 否则 turn 已正常结束却因累积达阈值误触发 onSilentAbort，广播 aborted。
    // timer === null 即被 stop，直接 return（不增计数、不广播、不 abort）。
    if (this.timer === null) return
    if (ok) {
      // 健康响应 → 清零（AC-8b：中途成功后需重新累积 2 次才 WARN）
      this.failCount = 0
      this.warned = false
      return
    }
    this.failCount += 1
    // AC-8：连续 2 次失败广播 message.stream_warn 一次（提示性，不中断流）
    if (this.failCount === PING_WARN_FAIL_COUNT && !this.warned) {
      this.warned = true
      this.deps.send({
        type: 'message.stream_warn',
        payload: {
          sessionId: this.deps.sessionId,
          // SR3：间隔由 PING_INTERVAL_MS 决定，不硬编码 60（常量 SSOT）
          // 1000 = ms→s 换算常数，无语义歧义
          // eslint-disable-next-line no-magic-numbers -- ms→s 单位换算常数，同 OUTBOUND_FRAME_* 豁免范式
          content: `pi 进程连续 ${this.failCount * (PING_INTERVAL_MS / 1000)}s 未响应健康探测，可能卡死`,
        },
      })
    }
    // ADR-0047：连续 3 次失败 → 判定 pi 进程真死 → onSilentAbort + 停止 ping（AC-7）
    if (this.failCount >= PING_FAIL_THRESHOLD) {
      this.stop()
      this.deps.onSilentAbort?.({ sessionId: this.deps.sessionId })
    }
  }
}
