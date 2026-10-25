/**
 * opencode fetcher 行为测试（console/api/go/status JSON API）。
 *
 * 覆盖：
 * - D1-3：未配置 workspace / workspace id 不可提取 → not_configured，且**不发任何 HTTP
 *   请求**（不发数不查他人数据）
 * - D1-4：请求 URL = 固定端点常量（不含任何 id），org id 从 config 注入的
 *   quotaParams.workspaceUrl 提取进 `x-org-id` header
 * - 既有语义回归：401 → unauthorized；404 → no-subscription（实测 wire：workspace id
 *   不属于该账号）；三窗口解析成功路径；部分缺失降级；字段漂移 → parse；网络异常 → network
 *
 * wire 形态实测锚点（2026-10-19 真响应）：microCents 字符串数值、month 无 startsAt。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/quota-providers/__tests__/opencode.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// W3 迁移：被测对象换为「基线配置 ⊕ 声明式引擎」，fixture 断言不变 = 等价证明。
import { getQuotaFetcher } from '../index.js'

const opencodeFetcher = getQuotaFetcher('opencode-go')!

const WORKSPACE_URL = 'https://opencode.ai/workspace/wrk_user01abc/go'
const STATUS_URL = 'https://opencode.ai/console/api/go/status'
const NOW = new Date('2026-10-19T06:00:00.000Z')

/** 单窗口 meter fixture（实测 wire 形态：microCents 字符串数值）。 */
function meter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startsAt: '2026-10-19T05:05:48.000Z',
    resetsAt: '2026-10-19T10:05:48.000Z',
    limitMicroCents: '1200000000',
    usedMicroCents: '146225762',
    ...overrides,
  }
}

function statusJson(meters: Record<string, unknown>): string {
  return JSON.stringify({ subscriberUserId: 'acc_x', product: 'go', access: { meters } })
}

const FULL_METERS = {
  fiveHour: meter(),
  week: meter({
    resetsAt: '2026-10-26T00:00:00.000Z',
    limitMicroCents: '3000000000',
    usedMicroCents: '841663575',
  }),
  month: meter({
    resetsAt: '2026-11-10T04:04:18.000Z',
    limitMicroCents: '6000000000',
    usedMicroCents: '1688043608',
  }),
}

function setupFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opencodeFetcher · workspace 配置注入（D1-1/D1-3）', () => {
  it('未传 config → not_configured，且不发任何 HTTP 请求（D1-3：不发数不查他人数据）', async () => {
    const fetchMock = setupFetch(() => {
      throw new Error('must not fetch when workspace is not configured')
    })
    const out = await opencodeFetcher.fetchQuota('session=1', 'cookie')
    expect(out).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('config.quotaParams.workspaceUrl 为空串/undefined → not_configured 不发请求', async () => {
    const fetchMock = setupFetch(() => new Response(statusJson(FULL_METERS)))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', {})).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: '' } })).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('quotaParams.workspaceUrl 中提取不到 wrk id → not_configured 不发请求（读侧容错，指引重填配置）', async () => {
    const fetchMock = setupFetch(() => new Response(statusJson(FULL_METERS)))
    expect(
      await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: 'https://opencode.ai/console' } }),
    ).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('已配置 workspace → 请求固定端点，org id 进 x-org-id header（D1-4：URL 无 id）', async () => {
    const fetchMock = setupFetch(() => new Response(statusJson(FULL_METERS)))
    const out = await opencodeFetcher.fetchQuota('__Host-console_session=st_x; __stripe_mid=y', 'cookie', {
      quotaParams: { workspaceUrl: WORKSPACE_URL },
    })

    expect(out.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(STATUS_URL)
    // W3 迁移：引擎统一带 accept 头（跨家一致的 JSON 协商头，无害增量）——本用例锁点
    // 是「URL 无 id、org id 经 header 注入」（D1-4），accept 为引擎统一行为非本域语义。
    expect(init.headers).toEqual({
      accept: 'application/json, text/plain, */*',
      cookie: '__Host-console_session=st_x; __stripe_mid=y',
      'x-org-id': 'wrk_user01abc',
    })
  })
})

describe('opencodeFetcher · 既有语义回归', () => {
  it('空凭证 / 无 k=v 对 → cookie-invalid-format（不依赖 workspace 判定顺序，凭证检查在前；不发 HTTP）', async () => {
    const fetchMock = setupFetch(() => {
      throw new Error('must not fetch on invalid cookie format')
    })
    const out = await opencodeFetcher.fetchQuota('', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })
    expect(out).toEqual({ ok: false, reason: 'cookie-invalid-format' })
    // 典型错误粘贴：DevTools Application → Cookies 表格（制表符分隔，无任何 = ）
    expect(await opencodeFetcher.fetchQuota('auth\toc_123\nsession\txyz', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } }))
      .toEqual({ ok: false, reason: 'cookie-invalid-format' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401 → unauthorized（cookie 过期，实测 wire {"_tag":"Unauthorized"}）', async () => {
    setupFetch(() => new Response('{"_tag":"Unauthorized"}', { status: 401 }))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
  })

  it('404 → no-subscription（workspace id 不属于该账号/已删除，实测 wire {"_tag":"NotFound"}）', async () => {
    setupFetch(() => new Response('{"_tag":"NotFound"}', { status: 404 }))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: false,
      reason: 'no-subscription',
    })
  })

  it('500 → network', async () => {
    setupFetch(() => new Response('oops', { status: 500 }))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: false,
      reason: 'network',
    })
  })

  it('fetch 抛异常（网络/超时）→ network', async () => {
    setupFetch(() => {
      throw new Error('fetch failed')
    })
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: false,
      reason: 'network',
    })
  })

  it('三窗口全缺（access.meters 空）→ no-subscription', async () => {
    setupFetch(() => new Response(statusJson({}), { status: 200 }))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: false,
      reason: 'no-subscription',
    })
  })

  it('部分窗口缺失 → 缺失窗口 INFINITE_WIN 降级，不整体失败', async () => {
    setupFetch(() => new Response(statusJson({ fiveHour: meter() }), { status: 200 }))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: true,
      data: {
        label: 'OpenCode Go',
        wins: [
          { pct: 12, resetSec: 14748 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('字段类型漂移（limitMicroCents:"abc"）→ parse（RT-7#5：字符串数值合法，非数值串拒收）', async () => {
    setupFetch(() => new Response(statusJson({ fiveHour: meter({ limitMicroCents: 'abc' }) }), { status: 200 }))
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })).toEqual({
      ok: false,
      reason: 'parse',
    })
  })

  it('limit 为 0 → 该窗口 INFINITE_WIN（防除零，不产假 100%）', async () => {
    setupFetch(() => new Response(statusJson({ fiveHour: meter({ limitMicroCents: 0 }) }), { status: 200 }))
    const out = await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })
    expect(out.ok ? out.data.wins[0] : out).toEqual({ pct: null, resetSec: null })
  })

  it('成功路径：三窗口 pct/resetSec 组装（pct=used/limit 比值，resetSec=resetsAt-now）', async () => {
    setupFetch(() => new Response(statusJson(FULL_METERS), { status: 200 }))
    const out = await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WORKSPACE_URL } })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'OpenCode Go',
        wins: [
          { pct: 12, resetSec: 14748 },
          { pct: 28, resetSec: 583200 },
          { pct: 28, resetSec: 1893858 },
        ],
      },
    })
  })
})
