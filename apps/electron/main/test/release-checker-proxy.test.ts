/**
 * W5 验收测试：release-checker 代理优先 + 失败降级直连（D6）。
 *
 * 覆盖验收场景：
 *   A6: 代理优先 + 失败降级直连
 *   A7: mode=disabled 时不尝试代理连接
 *   A9: ProxyAgent 构造容错
 *   A10: 降级逻辑即时性（无额外延迟）
 *
 * 多源改造联动维护（update-multi-source §7.2 存量测试迁移）：
 * - resolveSourceOrder 经构造注入固定为 [github, atomgit]（消除 auto 探测请求混入）
 * - 逐源降级语义：主源失败继续试次源——A6c/A9 的调用次数断言按新语义更新
 *   （通道维度「404 不降级直连」语义不变，仅新增次源尝试）
 * - error-log 模块 mock（checker 每轮检查结束登记 source-selection，不落盘）
 *
 * Mock 策略：mock readProxyConfig/resolveProxyUrl + 替换 globalThis.fetch。
 *
 * 运行：cd apps/electron/main && npx vitest run test/release-checker-proxy.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReleaseChecker } from '../release-checker.js'
import * as proxyConfig from '../update/proxy-config.js'
import type { UpdateSource } from '@taiji/shared'

// error-log mock（模块级）：隔离 source-selection 降频快照 + 测试不落盘
const errorLogMocks = vi.hoisted(() => ({
  logSourceSelection: vi.fn(),
  logSourceFailover: vi.fn(),
}))
vi.mock('../update/error-log.js', () => ({
  logSourceSelection: errorLogMocks.logSourceSelection,
  logSourceFailover: errorLogMocks.logSourceFailover,
  logDownloadSuccess: vi.fn(),
  appendUpdateError: vi.fn(() => true),
}))

/** 构造注入固定源顺序的 checker（消除 auto 探测请求混入） */
function makeChecker(order: UpdateSource[] = ['github', 'atomgit']): ReleaseChecker {
  return new ReleaseChecker({ resolveSourceOrder: async () => order })
}

/** 构造一个完整的 GitHubRelease JSON */
function makeReleaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.9.0',
    prerelease: false,
    draft: false,
    body: '## What changed\n- new feature',
    published_at: '2025-12-01T00:00:00Z',
    html_url: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    assets: [
      {
        name: 'TaiJi-mac-arm64.dmg',
        browser_download_url: 'https://example.com/mac-arm64.dmg',
        size: 1000,
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    ...overrides,
  }
}

/** 用给定 JSON 构造一个 200 Response */
function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('W5: release-checker 代理优先 + 失败降级直连', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ── A6-proxy-priority-vitest: 代理优先 + 失败降级直连 ─────────────────
  describe('A6-proxy-priority-vitest: 代理优先 + 失败降级直连', () => {
    it('A6a: 代理可用时走代理（fetch 带 dispatcher）', async () => {
      const readSpy = vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      const resolveSpy = vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const fetchCalls: RequestInit[] = []
      globalThis.fetch = vi.fn(async (_url, init) => {
        fetchCalls.push(init as RequestInit)
        return jsonResponse(makeReleaseJson())
      }) as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      expect(result!.version).toBe('0.9.0')
      // 关键断言：实现必须调用 readProxyConfig 和 resolveProxyUrl
      expect(readSpy).toHaveBeenCalled()
      expect(resolveSpy).toHaveBeenCalled()
      // 只调用一次 fetch（代理成功，不降级）
      expect(fetchCalls).toHaveLength(1)
      // dispatcher 应存在（ProxyAgent 实例）——这是实现的具体特征
      const options = fetchCalls[0] as { dispatcher?: { constructor: { name: string } } }
      expect(options.dispatcher).toBeDefined()
      // dispatcher 必须是 ProxyAgent 实例（不是普通对象）
      expect(options.dispatcher?.constructor.name).toBe('ProxyAgent')
    })

    it('A6b: 代理失败 → 降级直连重试一次', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const fetchCalls: RequestInit[] = []
      let callCount = 0
      globalThis.fetch = vi.fn(async (_url, init) => {
        fetchCalls.push(init as RequestInit)
        callCount++
        if (callCount === 1) {
          throw new Error('EHOSTUNREACH')
        }
        return jsonResponse(makeReleaseJson())
      }) as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      expect(result!.version).toBe('0.9.0')
      // 调用两次 fetch：代理失败 + 直连重试
      expect(fetchCalls).toHaveLength(2)
      // 第一次有 dispatcher（代理）
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher).toBeDefined()
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher?.constructor.name).toBe('ProxyAgent')
      // 第二次无 dispatcher（直连降级）——这是降级的具体特征
      expect((fetchCalls[1] as Record<string, unknown>).dispatcher).toBeUndefined()
    })

    it('A6c: 代理 + 直连都失败 → 该源失败 → 次源同形态失败 → 返回 null', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      let callCount = 0
      globalThis.fetch = vi.fn(async () => {
        callCount++
        throw new Error('EHOSTUNREACH')
      }) as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).toBeNull()
      // 逐源降级语义（多源联动维护）：每源两试（代理 + 直连降级）× 两源 = 4 次
      expect(callCount).toBe(4)
    })
  })

  // ── A7-proxy-disabled-vitest: mode=disabled 时不尝试代理连接 ────────────
  describe('A7-proxy-disabled-vitest: mode=disabled 时不尝试代理连接', () => {
    it('A7: disabled 模式 → 纯直连，无 dispatcher', async () => {
      const readSpy = vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
      const resolveSpy = vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)

      const fetchCalls: RequestInit[] = []
      globalThis.fetch = vi.fn(async (_url, init) => {
        fetchCalls.push(init as RequestInit)
        return jsonResponse(makeReleaseJson())
      }) as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      // 关键断言：实现必须调用 readProxyConfig 和 resolveProxyUrl
      expect(readSpy).toHaveBeenCalled()
      expect(resolveSpy).toHaveBeenCalled()
      // 只调用一次（无代理，不降级）
      expect(fetchCalls).toHaveLength(1)
      // 无 dispatcher——disabled 模式的具体特征
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher).toBeUndefined()
    })
  })

  // ── A9-proxy-agent-construction-vitest: ProxyAgent 构造容错 ──────────────
  describe('A9-proxy-agent-construction-vitest: ProxyAgent 构造容错', () => {
    it('A9: HTTP 错误（404）→ 不降级（只网络错误才降级）+ 逐源降级试次源', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const fetchCalls: RequestInit[] = []
      let callCount = 0
      globalThis.fetch = vi.fn(async (_url, init) => {
        fetchCalls.push(init as RequestInit)
        callCount++
        return new Response('not found', { status: 404 })
      }) as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).toBeNull()
      // 通道语义不变：404 是服务器响应，github 恰 1 次（不触发直连重试）；
      // 逐源降级语义（多源联动维护）：随后试 atomgit 1 次
      expect(callCount).toBe(2)
      // 关键断言：即使 HTTP 失败，两源首次调用仍带 dispatcher（代理）
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher).toBeDefined()
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher?.constructor.name).toBe('ProxyAgent')
      expect((fetchCalls[1] as Record<string, unknown>).dispatcher).toBeDefined()
    })
  })

  // ── A10-fallback-logic-vitest: 降级逻辑即时性 ─────────────────────────
  describe('A10-fallback-logic-vitest: 降级逻辑即时性', () => {
    it('A10: 代理失败后立即重试直连，无额外延迟', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const fetchCalls: RequestInit[] = []
      const timestamps: number[] = []
      let callCount = 0
      globalThis.fetch = vi.fn(async (_url, init) => {
        fetchCalls.push(init as RequestInit)
        timestamps.push(Date.now())
        callCount++
        if (callCount === 1) {
          throw new Error('EHOSTUNREACH')
        }
        return jsonResponse(makeReleaseJson())
      }) as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      expect(callCount).toBe(2)
      // 关键断言：第一次有 dispatcher，第二次无 dispatcher
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher).toBeDefined()
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher?.constructor.name).toBe('ProxyAgent')
      expect((fetchCalls[1] as Record<string, unknown>).dispatcher).toBeUndefined()
      // 两次调用之间无明显延迟（<100ms，排除正常执行时间）
      if (timestamps.length >= 2) {
        const gap = timestamps[1] - timestamps[0]
        expect(gap).toBeLessThan(100)
      }
    })
  })
})
