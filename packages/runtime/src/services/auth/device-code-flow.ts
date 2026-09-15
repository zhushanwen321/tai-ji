/**
 * RFC 8628 设备码轮询器（OAuth 路径 B 自实现）。
 *
 * 参考 pi-ai dist/auth/oauth/device-code.js:62-118 语义，差异：
 * - 返回结构化结果 { ok, reason } 而非 throw（调用方统一处理错误分支）
 * - poll 接收 attempt 序号（业务方可用于日志/退避决策）
 *
 * slow_down 处理（RFC 8628 §3.5）：服务器返回 intervalSeconds 时直接采用
 * （服务器值优先，防 WSL/VM 时钟漂移下客户端自计数永远早轮询）；
 * 无 interval 时按规范 +5s。
 */

export type DevicePollResult =
  | { status: 'complete'; value: unknown }
  | { status: 'pending' }
  | { status: 'slow_down'; intervalSeconds?: number }
  | { status: 'failed'; message: string }

export interface DeviceCodeFlowOptions {
  /** 业务方提供的轮询函数（fetch 封装），attempt 从 0 递增 */
  poll: (attempt: number) => Promise<DevicePollResult>
  /** 初始轮询间隔秒（RFC 8628 §3.2：服务器省略 interval 时客户端默认 5s） */
  intervalSeconds?: number
  /** 绝对超时（秒），到期返回 reason timeout */
  expiresInSeconds: number
  /** true 时先等一个 interval 再首次轮询（xai/kimi/copilot 需要） */
  waitBeforeFirstPoll?: boolean
  signal: AbortSignal
  /** 轮询间隔下限 ms（RFC 8628 §3.2 禁止高频轮询） */
  minIntervalMs?: number
  /** slow_down 无服务器 interval 时的增量 ms（RFC 8628 §3.5 为 5s） */
  slowDownIncrementMs?: number
}

export type DeviceCodeFlowResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'timeout' | 'aborted' | 'failed'; message?: string }

const CANCEL_MESSAGE = 'Login cancelled'

/**
 * 可中断睡眠：signal abort 时立即 reject，由调用方统一转 aborted 结果。
 * 用 once 监听避免重复 abort 触发多次 reject。
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(CANCEL_MESSAGE))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error(CANCEL_MESSAGE))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 可中断睡眠并转结果：abort 中断返回 false（调用方据此返回 aborted 结果），
 * 正常睡满返回 true。sleep 只会因 abort reject，无需区分其他错误。
 */
async function sleepOrAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await abortableSleep(ms, signal)
    return true
  } catch {
    return false
  }
}

/** 轮询时序参数（由 opts 一次性解析，循环内只读）。 */
interface PollTimings {
  /** 轮询间隔下限 ms（RFC 8628 §3.2 禁止高频轮询，缺省 1s） */
  minIntervalMs: number
  /** slow_down 无服务器 interval 时的增量 ms（RFC 8628 §3.5 为 5s） */
  slowDownIncrementMs: number
  /** 绝对超时时刻 ms */
  deadline: number
  /** 初始轮询间隔 ms（RFC 8628 §3.2：服务器省略 interval 时客户端默认 5s） */
  intervalMs: number
}

/** opts → 轮询时序参数（与原内联初始化逐表达式等价，Date.now() 调用时机不变）。 */
function resolvePollTimings(opts: DeviceCodeFlowOptions): PollTimings {
  // eslint-disable-next-line no-magic-numbers -- RFC 8628 §3.2 轮询间隔下限 1s
  const minIntervalMs = opts.minIntervalMs ?? 1_000
  // eslint-disable-next-line no-magic-numbers -- RFC 8628 §3.5 slow_down 增量 5s
  const slowDownIncrementMs = opts.slowDownIncrementMs ?? 5_000
  // eslint-disable-next-line no-magic-numbers -- expiresInSeconds 秒转毫秒
  const deadline = Date.now() + opts.expiresInSeconds * 1_000
  // eslint-disable-next-line no-magic-numbers -- RFC 8628 §3.2 默认间隔 5s（秒转毫秒）
  const intervalMs = Math.max(minIntervalMs, Math.floor((opts.intervalSeconds ?? 5) * 1_000))
  return { minIntervalMs, slowDownIncrementMs, deadline, intervalMs }
}

/**
 * slow_down 间隔更新（RFC 8628 §3.5）：服务器返回有效正 intervalSeconds 时直接采用
 * （服务器值优先，防 WSL/VM 时钟漂移下客户端自计数永远早轮询）；否则按规范 +5s。
 */
function nextIntervalAfterSlowDown(
  serverInterval: number | undefined,
  currentIntervalMs: number,
  minIntervalMs: number,
  slowDownIncrementMs: number,
): number {
  return typeof serverInterval === 'number' && Number.isFinite(serverInterval) && serverInterval > 0
    ? // eslint-disable-next-line no-magic-numbers -- 秒转毫秒
    Math.max(minIntervalMs, Math.floor(serverInterval * 1_000))
    : Math.max(minIntervalMs, currentIntervalMs + slowDownIncrementMs)
}

export async function runDeviceCodeFlow(opts: DeviceCodeFlowOptions): Promise<DeviceCodeFlowResult> {
  const { minIntervalMs, slowDownIncrementMs, deadline, intervalMs: initialIntervalMs } = resolvePollTimings(opts)
  let intervalMs = initialIntervalMs
  let attempt = 0

  // waitBeforeFirstPoll：授权页打开需要时间，先等一轮再开始轮询，
  // 避免在用户还没完成授权时就打第一发请求
  if (opts.waitBeforeFirstPoll) {
    const remainingMs = deadline - Date.now()
    if (remainingMs > 0 && !(await sleepOrAborted(Math.min(intervalMs, remainingMs), opts.signal))) {
      return { ok: false, reason: 'aborted', message: CANCEL_MESSAGE }
    }
  }

  while (Date.now() < deadline) {
    if (opts.signal.aborted) {
      return { ok: false, reason: 'aborted', message: CANCEL_MESSAGE }
    }
    const result = await opts.poll(attempt++)
    if (result.status === 'complete') {
      return { ok: true, value: result.value }
    }
    if (result.status === 'failed') {
      return { ok: false, reason: 'failed', message: result.message }
    }
    if (result.status === 'slow_down') {
      intervalMs = nextIntervalAfterSlowDown(result.intervalSeconds, intervalMs, minIntervalMs, slowDownIncrementMs)
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      break
    }
    // sleep 取 min(interval, remaining)：超时边界处不睡过头；abort 中断转 aborted 结果
    if (!(await sleepOrAborted(Math.min(intervalMs, remainingMs), opts.signal))) {
      return { ok: false, reason: 'aborted', message: CANCEL_MESSAGE }
    }
  }

  // 循环因 abort 提前退出已在上方返回；走到这里只有超时一种可能。
  // 统一 timeout，不区分是否经历过 slow_down（时钟漂移提示简化为单一文案）
  return { ok: false, reason: 'timeout' }
}
