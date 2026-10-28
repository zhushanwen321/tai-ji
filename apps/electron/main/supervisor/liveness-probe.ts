/**
 * 存活探针（liveness probe）—— 检测 runtime「半活」状态。
 *
 * 对应 spec §4.2 M2 子职责「存活探针」（W5 新增）。
 *
 * [HISTORICAL] 为什么需要它：
 * supervisor 原本只监听 child_process 的 'exit' 事件判定 runtime 是否存活。
 * 但 runtime 可能「进程活着（exitCode===null）但 HTTP 服务卡死」——
 * 例如 pi 死锁、event loop 阻塞、端口被防火墙静默 drop。
 * 此时 child 不会 exit，supervisor 误判存活，应用假死（前端 WS 永连不上但不触发重启）。
 *
 * 解决：周期性调 /health 端点，连续失败达阈值则判定「半活」，
 * 触发回调让 supervisor 强制重启（forceRestartForLiveness）。
 *
 * 设计为纯函数 + 独立 class（无 electron 依赖）：
 * - checkHealthEndpoint 可被单测（fetch 用 vi.stubGlobal 替换）
 * - LivenessMonitor 管理定时器，supervisor 组合它
 *
 * 注意：本模块的 checkHealthEndpoint 与 health-checker.ts 的同名函数语义不同——
 *   health-checker 版本返回 boolean（给 waitForHealth 启动期轮询用，越简单越好）；
 *   本版本返回 { ok, ms }（给存活探针用，ms 用于日志/监控响应耗时）。
 *   两者独立维护，避免启动期轮询逻辑被存活探针的字段需求污染。
 *
 * 依赖方向：liveness-probe → 全局 fetch（Electron/Node 18+ 内置）
 */

/** 连续失败达此阈值则判定「半活」，触发强制重启（逐请求 2s 超时 × 3 次 × 5s 间隔 = 最迟 ~12s 发现卡死） */
export const LIVENESS_FAIL_THRESHOLD = 3

/**
 * 存活探针轮询间隔（ms）：本地回环 GET 轮询（0.2 QPS）对 runtime 压力可忽略，
 * 间隔只服务「发现速度」——紧事实采样，不留宽间隔慢判死。
 */
export const LIVENESS_INTERVAL_MS = 5_000

/**
 * 单次探针请求超时（ms）：/health 为本地回环轻端点（正常响应毫秒级，2s = 20 倍裕度），
 * fetch 逐请求硬超时（AbortSignal.timeout）保证 SIGSTOP 冻结等无响应形态快速判死，
 * 不会挂到 undici 默认 headersTimeout（300s）——判死窗口按上式 ~12s 兑现。
 * 健康期 event loop 短暂抖动至多误计一次失败（成功即清零），连续 3 次失败 = 持续 ~12s
 * 无响应，本身即半活判定，无误杀面。
 */
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

/** 健康端点 URL（仅本地回环） */
const HEALTH_ENDPOINT = (port: number) => `http://127.0.0.1:${port}/health`

/** 探针结果：ok=是否健康，ms=响应耗时（仅健康时带，用于日志） */
export interface HealthProbeResult {
  ok: boolean
  ms?: number
}

/**
 * 调 HTTP /health 验证 runtime 存活状态（带响应耗时）。
 *
 * [HISTORICAL] 不变量：
 * - 永不向调用方抛错（探针失败由调用方累计计数处理，而非崩溃）
 * - 仅 2xx 视为健康（response.ok）；非 2xx / fetch reject（含逐请求超时 AbortError）均返回 ok=false
 * - 健康时附带 ms（响应耗时，用于日志诊断慢响应）；不健康时不带（无意义）
 *
 * @param port runtime 监听端口
 * @returns { ok, ms? } —— ok=false 表示未就绪或连不上
 */
export async function checkHealthEndpoint(port: number): Promise<HealthProbeResult> {
  const startedAt = Date.now()
  try {
    const response = await fetch(HEALTH_ENDPOINT(port), {
      signal: AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
    })
    if (response.ok) {
      return { ok: true, ms: Date.now() - startedAt }
    }
    return { ok: false }
  } catch {
    // fetch reject（ECONNREFUSED / 超时 / DNS 失败）：视为「不健康」，不抛错
    return { ok: false }
  }
}

/** LivenessMonitor 构造参数 */
export interface LivenessMonitorOptions {
  /** 要探测的 runtime 端口 */
  port: number
  /** 连续失败达阈值时调（触发 supervisor.forceRestartForLiveness） */
  onUnhealthy: () => void
  /** 轮询间隔 ms（默认 LIVENESS_INTERVAL_MS） */
  intervalMs?: number
  /** 连续失败阈值（默认 LIVENESS_FAIL_THRESHOLD） */
  failThreshold?: number
}

/**
 * 存活探针定时器管理器。
 *
 * supervisor 在 start() 成功后创建并 start()，在 stop() 时 stop()。
 * 内部维护连续失败计数：
 * - 探测成功 → 清零计数
 * - 探测失败 → 计数 +1，达阈值时触发 onUnhealthy 回调并清零（避免一次卡死多次触发）
 *
 * [HISTORICAL] 用 setInterval 而非递归 setTimeout：
 *   间隔固定（30s），不受上次探测耗时影响（探测快则下次仍等满 30s）。
 *   单次探测不会重入（fetch 不会卡到下一次 tick——即便卡住，onUnhealthy 也只触发一次）。
 */
export class LivenessMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  private readonly port: number
  private readonly onUnhealthy: () => void
  private readonly intervalMs: number
  private readonly failThreshold: number

  constructor(opts: LivenessMonitorOptions) {
    this.port = opts.port
    this.onUnhealthy = opts.onUnhealthy
    this.intervalMs = opts.intervalMs ?? LIVENESS_INTERVAL_MS
    this.failThreshold = opts.failThreshold ?? LIVENESS_FAIL_THRESHOLD
  }

  /** 启动周期探针（幂等：已启动则无操作） */
  start(): void {
    if (this.timer) return
    this.consecutiveFailures = 0
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    // unref：探针定时器不应阻止进程退出（Electron 主进程正常退出时无需等它）
    this.timer.unref()
  }

  /** 停止探针并清零计数（幂等：未启动则无操作） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.consecutiveFailures = 0
  }

  /** 单次探测：成功清零，失败累计，达阈值触发回调 */
  private async tick(): Promise<void> {
    const result = await checkHealthEndpoint(this.port)
    if (result.ok) {
      this.consecutiveFailures = 0
      return
    }
    this.consecutiveFailures++
    if (this.consecutiveFailures >= this.failThreshold) {
      // 达阈值：清零（避免一次卡死反复触发）后通知 supervisor
      this.consecutiveFailures = 0
      this.onUnhealthy()
    }
  }
}
