/**
 * 共享临时端口 + EADDRINUSE 感知启动 helper。
 *
 * [背景] 此前 6 个测试文件各自复制 `getFreePort()`（listen(0) 拿临时端口 → close →
 * 返回端口），close 到真实 server 重绑之间存在 TOCTOU 窗口——并行 vitest worker 下
 * 两个文件可拿到同一端口 → 第二个 listen 抛 EADDRINUSE → 同 worker 内等回包的用例
 * 超时失败（2026-08 AC-I1 verify 首跑 FAIL 的根因）。取号竞态无法根除，韧性加在
 * 启动重试：`startOnFreePort` 在 listen 撞端口时自动换新端口重建重试。
 *
 * [两种用法]
 * 1. RuntimeServer fixture（端口在构造函数绑定，重试必须重建整个 server）：
 *    ```ts
 *    const { instance: server, port } = await startOnFreePort((p) => {
 *      const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
 *      s.setServices(...)
 *      return s
 *    })
 *    ```
 * 2. 裸 ConnectionManager（ws-listen-hardening 的 startManager）：
 *    ```ts
 *    const { instance: conn, port } = await startOnFreePort(
 *      (p) => new ConnectionManager(p, callbacks, token),
 *    )
 *    ```
 */
import { createServer } from 'node:http'

/** listen(0) → close → 返回端口号。注意：close 后端口即释放，存在被抢占的 TOCTOU 窗口——韧性由 startOnFreePort 的启动重试提供。 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Failed to get free port: address() returned non-object'))
      }
    })
  })
}

/** startOnFreePort 要求实例满足的最小接口：可 start；可选 stop（重试失败实例的 best-effort 清理）。 */
export interface StartableInstance {
  start(): Promise<void>
  stop?(): Promise<void> | void
}

export interface StartOnFreePortResult<T> {
  instance: T
  port: number
}

export interface StartOnFreePortOptions {
  /** 最大尝试次数（含首次），默认 5。 */
  maxAttempts?: number
}

/** 从 unknown 错误中安全提取 errno 风格 code（无 code / 非 Error 返回 undefined）。 */
function getErrorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const code = (err as Error & { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/** 默认最大尝试次数（含首次）：TOCTOU 窗口内连续撞端口属小概率，5 次足够；任务规格亦定为 5。 */
const DEFAULT_MAX_ATTEMPTS = 5

/**
 * EADDRINUSE 感知启动：取临时端口 → createInstance(port) → instance.start()；
 * listen 撞端口（EADDRINUSE）时 best-effort stop 失败实例、换新端口重建重试。
 * 非 EADDRINUSE 错误不重试直接抛（换端口救不了配置/代码错误）。
 * 尝试耗尽抛含尝试次数与最后错误的 Error。
 */
export async function startOnFreePort<T extends StartableInstance>(
  createInstance: (port: number) => T,
  opts: StartOnFreePortOptions = {},
): Promise<StartOnFreePortResult<T>> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await getFreePort()
    const instance = createInstance(port)
    try {
      await instance.start()
      return { instance, port }
    } catch (err) {
      lastErr = err
      if (getErrorCode(err) !== 'EADDRINUSE') throw err
      // 撞端口：失败实例 best-effort 清理（stop 对未 listening 的 server 安全——
      // close 回调带 ERR_SERVER_NOT_RUNNING 但被忽略），换新端口重试。
      try {
        await instance.stop?.()
      // eslint-disable-next-line taste/no-silent-catch -- best-effort 清理失败不影响重试主体
      } catch { /* best-effort */ }
      console.warn(`[test:free-port] attempt ${attempt}/${maxAttempts} hit EADDRINUSE on port ${port}, retrying with a new port`)
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`startOnFreePort: ${maxAttempts} 次尝试全部 EADDRINUSE（端口持续被抢占），最后错误: ${detail}`)
}
