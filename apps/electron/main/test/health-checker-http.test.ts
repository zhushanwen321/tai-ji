/**
 * W5 TDD 测试：health-checker 的 waitForHealth 改用 HTTP /health（而非纯 TCP createConnection）。
 *
 * 背景：旧的健康检查用 net.createConnection 探测端口是否监听，但这只能验证「端口有人占」，
 * 不能验证「runtime 已完成启动、HTTP 服务就绪」。runtime 启动分两步：listen 端口 → 初始化
 * 业务（注册 handler 等），TCP 探测会在业务就绪前就返回 true，导致前端过早连接丢消息。
 *
 * W5 改动：health-checker（supervisor/health-checker.ts）新增 checkHealthEndpoint：
 *   - checkHealthEndpoint(port): Promise<boolean> —— fetch http://127.0.0.1:{port}/health，
 *     2xx 视为健康，网络错误/非 2xx 视为未就绪（return false）。
 *   - waitForHealth(port, opts?): Promise<void> —— 轮询 checkHealthEndpoint 直到健康或超时。
 *   - isPortInUse(port): Promise<boolean> —— 保留纯 TCP（给 port-discoverer 探端口占用用，不变）。
 *
 * [红灯说明] 当前 health-checker.ts 只有 isPortInUse（TCP）+ waitForHealth（调 isPortInUse），
 *   checkHealthEndpoint 尚不存在 → import 失败（红灯根因）。实现后应转绿。
 *
 * 运行：npx vitest run test/health-checker-http.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// checkHealthEndpoint 尚不存在 → import 失败（红灯根因）
import {
  checkHealthEndpoint,
  waitForHealth,
  isPortInUse,
} from '../supervisor/health-checker.js'

describe('W5: health-checker 改用 HTTP /health 探活', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ── HC1：checkHealthEndpoint 存在且返回 Promise<boolean> ──────
  it('HC1: checkHealthEndpoint 是函数，返回 Promise<boolean>', async () => {
    expect(typeof checkHealthEndpoint).toBe('function')

    // mock fetch 返回 200 OK
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    ) as typeof globalThis.fetch

    const result = await checkHealthEndpoint(12345)
    expect(typeof result).toBe('boolean')
    expect(result).toBe(true)
  })

  // ── HC2：checkHealthEndpoint 走 HTTP /health（非 createConnection）─
  it('HC2: checkHealthEndpoint 调用 fetch http://127.0.0.1:{port}/health', async () => {
    const fetchSpy = vi.fn<(input: unknown) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    )
    globalThis.fetch = fetchSpy as typeof globalThis.fetch

    await checkHealthEndpoint(7799)

    // 关键断言：必须 fetch http://127.0.0.1:7799/health（W5：HTTP，非 TCP）
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const firstCall = fetchSpy.mock.calls[0]
    const calledUrl = firstCall ? String(firstCall[0]) : ''
    expect(calledUrl).toBe('http://127.0.0.1:7799/health')
  })

  // ── HC3：checkHealthEndpoint 非 2xx 返回 false ────────────────
  it('HC3: checkHealthEndpoint 收到 503 → 返回 false（不健康）', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Service Unavailable', { status: 503 }),
    ) as typeof globalThis.fetch

    const result = await checkHealthEndpoint(8080)
    expect(result).toBe(false)
  })

  // ── HC4：checkHealthEndpoint fetch 抛错（连接拒绝）返回 false ──
  it('HC4: checkHealthEndpoint fetch reject（ECONNREFUSED）→ 返回 false', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    }) as typeof globalThis.fetch

    const result = await checkHealthEndpoint(9999)
    expect(result).toBe(false)
  })

  // ── HC5：waitForHealth 轮询直到 checkHealthEndpoint 返回 true ──
  it('HC5: waitForHealth 轮询直到 /health 返回 200 后 resolve', async () => {
    // 前两次返回未就绪（503 + reject），第三次返回 200
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      if (calls < 3) return new Response('busy', { status: 503 })
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }) as typeof globalThis.fetch

    // W5 后 waitForHealth 改用 HTTP 探测，支持 opts 缩短轮询间隔避免用例过慢
    await expect(waitForHealth(7788, { intervalMs: 10, retryCount: 10 })).resolves.toBeUndefined()
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  // ── HC6：isPortInUse 保留纯 TCP（给 port-discoverer 用）──────
  it('HC6: isPortInUse 存在且为函数（TCP 探测语义不变，仅签名回归保护）', () => {
    // 不实际调用避免 CI 真实连网络；W5 改动不应删除/改语义 isPortInUse
    expect(typeof isPortInUse).toBe('function')
  })
})
