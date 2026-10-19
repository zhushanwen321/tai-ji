/**
 * Quota fetcher 接口契约测试（A2-1 错误通道 + A2-3 绝对量输出）。
 *
 * 覆盖：
 * - HTTP 状态码 → reason 映射（unauthorized / network / no-subscription / parse 至少三分支）
 * - fetch 网络异常 → network
 * - kimi 绝对量输出（used/limit/unit）；zhipu/minimax 维持现状输出（无新字段，向后兼容）
 * - fetcher.auth 能力声明与 QUOTA_PRESETS.auth 对齐（SSOT 一致性）
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run test/services/quota-providers-contract.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import type { QuotaFetchOutcome } from '@taiji/shared'
// W3 迁移：被测对象从硬编码 TS fetcher 换为「基线配置 ⊕ 声明式引擎」注册表——
// 同一批契约断言不变 = 等价证明（A2-1 错误通道 + A2-3 绝对量输出语义保持）。
import { getQuotaFetcher, listQuotaPresets } from '../../src/services/quota-providers/index.js'

const zhipuFetcher = getQuotaFetcher('zhipu')!
const kimiFetcher = getQuotaFetcher('kimi-coding')!
const minimaxFetcher = getQuotaFetcher('minimax')!
const mimoFetcher = getQuotaFetcher('mimo')!
const opencodeFetcher = getQuotaFetcher('opencode-go')!

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 构造 JSON Response（Node 18+ 全局 Response，headers 供 fetcher 侧 resp.json() 使用）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// ── zhipu：状态码 → reason 映射 + 现状输出（无绝对量）──

describe('zhipuFetcher — A2-1 错误通道', () => {
  it('HTTP 401 → reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('HTTP 403 → reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 403))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('HTTP 500（非 401/403 的非 2xx）→ reason=network', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('fetch 网络异常（reject）→ reason=network', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('200 但响应体非法 JSON → reason=parse', async () => {
    mockFetch.mockResolvedValue(new Response('not-json{', { status: 200 }))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应可解析但决策字段形态漂移（data 非 object）→ reason=parse（shape guard）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: 'oops' }))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应 limits 形态漂移（string 而非数组）→ reason=parse（shape guard）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { limits: 'abc' } }))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应可解析但无订阅数据（success=false）→ reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false }))
    const outcome = await zhipuFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('成功：输出维持现状（pct + resetSec，无 used/limit/unit——平台 API 总量字段未实测不编造）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        level: 'Pro',
        limits: [{ type: 'TOKENS_LIMIT', percentage: 25, nextResetTime: String(Date.now() + 3_600_000) }],
      },
    }))

    const outcome: QuotaFetchOutcome = await zhipuFetcher.fetchQuota('cred', 'api-key')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.label).toBe('Z.ai-Pro')
    // toEqual 精确键集：窗口对象不含 used/limit/unit（A2-3 向后兼容——旧输出仍合法）
    expect(outcome.data.wins[0]).toEqual({ pct: 25, resetSec: expect.any(Number) })
  })

  it('auth 能力声明 = [\'api-key\']（裸 authorization 头，无 oauth 通道）', () => {
    expect(zhipuFetcher.auth).toEqual(['api-key'])
  })
})

// ── kimi：双形态声明 + 绝对量输出 ──

describe('kimiFetcher — A2-1 错误通道 + A2-3 绝对量', () => {
  const kimiBody = {
    limits: [{ detail: { limit: 500, remaining: 375, resetTime: new Date(Date.now() + 3_600_000).toISOString() } }],
    usage: { limit: 2000, used: 500, resetTime: new Date(Date.now() + 86_400_000).toISOString() },
  }

  it('HTTP 401 → reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401))
    const outcome = await kimiFetcher.fetchQuota('cred', 'oauth')
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('fetch 网络异常 → reason=network', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const outcome = await kimiFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('200 但响应体非法 JSON → reason=parse', async () => {
    mockFetch.mockResolvedValue(new Response('<html>oops', { status: 200 }))
    const outcome = await kimiFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应 limits 形态漂移（string 而非数组，string.length truthy）→ reason=parse（shape guard）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ limits: 'abc' }))
    const outcome = await kimiFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应可解析但无订阅数据（limits/usage 均缺）→ reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    const outcome = await kimiFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('成功：5h/周窗口均输出绝对量 used/limit/unit=requests（数据不再折算 pct 后丢弃）', async () => {
    mockFetch.mockResolvedValue(jsonResponse(kimiBody))

    const outcome = await kimiFetcher.fetchQuota('cred', 'api-key')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const [win5h, winWk] = outcome.data.wins
    // 5h：limit=500 remaining=375 → used=125 pct=25
    expect(win5h.pct).toBe(25)
    expect(win5h.used).toBe(125)
    expect(win5h.limit).toBe(500)
    expect(win5h.unit).toBe('requests')
    // 周：used=500 limit=2000 → pct=25
    expect(winWk.pct).toBe(25)
    expect(winWk.used).toBe(500)
    expect(winWk.limit).toBe(2000)
    expect(winWk.unit).toBe('requests')
  })

  it('limit=0 的窗口维持 INFINITE（pct=null，无绝对量字段）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ limits: [{}], usage: { limit: 0, used: 0 } }))

    const outcome = await kimiFetcher.fetchQuota('cred', 'api-key')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.wins[0]).toEqual({ pct: null, resetSec: null })
    expect(outcome.data.wins[1]).toEqual({ pct: null, resetSec: null })
  })

  it('kind=oauth 与 api-key 同为 Bearer 头（同域同构，不因 kind 改请求头）', async () => {
    mockFetch.mockResolvedValue(jsonResponse(kimiBody))

    await kimiFetcher.fetchQuota('oauth-access', 'oauth')

    const headers = new Headers(mockFetch.mock.calls[0][1].headers)
    expect(headers.get('authorization')).toBe('Bearer oauth-access')
  })

  it('auth 能力声明 = [\'api-key\', \'oauth\']（数组序即凭证解析优先级）', () => {
    expect(kimiFetcher.auth).toEqual(['api-key', 'oauth'])
  })
})

// ── minimax：状态映射 + 现状输出 ──

describe('minimaxFetcher — A2-1 错误通道', () => {
  const minimaxBody = {
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: 75,
      current_interval_status: 1,
      remains_time: 600_000,
      current_weekly_remaining_percent: 60,
      current_weekly_status: 1,
      weekly_remains_time: 3_600_000,
    }],
  }

  it('HTTP 401 → reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401))
    const outcome = await minimaxFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('fetch 网络异常（reject）→ reason=network', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const outcome = await minimaxFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('200 但响应体非法 JSON → reason=parse', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 200 }))
    const outcome = await minimaxFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应 base_resp 形态漂移（string 而非 object）→ reason=parse（shape guard）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ base_resp: 'err' }))
    const outcome = await minimaxFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('status_code 非 0（响应可解析但无订阅数据）→ reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ base_resp: { status_code: 1004 } }))
    const outcome = await minimaxFetcher.fetchQuota('cred', 'api-key')
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('成功：输出维持现状（剩余百分比反转为已用百分比，无 used/limit/unit）', async () => {
    mockFetch.mockResolvedValue(jsonResponse(minimaxBody))

    const outcome = await minimaxFetcher.fetchQuota('cred', 'api-key')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 5h：剩余 75% → 已用 25%
    expect(outcome.data.wins[0]).toEqual({ pct: 25, resetSec: 600 })
  })

  it('auth 能力声明 = [\'api-key\']', () => {
    expect(minimaxFetcher.auth).toEqual(['api-key'])
  })
})

// ── mimo：cookie 类状态映射 ──

describe('mimoFetcher — A2-1 错误通道', () => {
  const mimoBody = { code: 0, message: 'ok', data: { monthUsage: { percent: 0.2, items: [] }, usage: { percent: 0.1, items: [] } } }

  it('HTTP 401 → reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401))
    const outcome = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('fetch 网络异常（reject）→ reason=network', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const outcome = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('200 但响应体非法 JSON → reason=parse', async () => {
    mockFetch.mockResolvedValue(new Response('gateway', { status: 200 }))
    const outcome = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('200 响应决策字段形态漂移（code 为 string 而非 number）→ reason=parse（shape guard）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ code: '401', message: 'unauthorized' }))
    const outcome = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('code 非 0（响应可解析但无订阅数据）→ reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ code: 1, message: 'no subscription' }))
    const outcome = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('code 401/403（在体凭证过期）→ reason=unauthorized，不被归为 no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ code: 401, message: 'unauthorized' }))
    const outcome401 = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome401).toEqual({ ok: false, reason: 'unauthorized' })

    mockFetch.mockResolvedValue(jsonResponse({ code: 403, message: 'forbidden' }))
    const outcome403 = await mimoFetcher.fetchQuota('session=abc', 'cookie')
    expect(outcome403).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('成功：percent 0~1 → 0~100，请求带 cookie 头', async () => {
    mockFetch.mockResolvedValue(jsonResponse(mimoBody))

    const outcome = await mimoFetcher.fetchQuota('session=abc', 'cookie')

    const headers = new Headers(mockFetch.mock.calls[0][1].headers)
    expect(headers.get('cookie')).toBe('session=abc')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.wins[2]).toEqual({ pct: 20, resetSec: null })
  })

  it('auth 能力声明 = [\'cookie\']', () => {
    expect(mimoFetcher.auth).toEqual(['cookie'])
  })
})

// ── opencode：console/api/go/status JSON API（cookie + x-org-id header）──
// [D1-1 timeout-audit-hygiene-batch] workspace 配置注入不变（fetchQuota 第三参数）；
// 错误通道为 JSON API 实测语义：401 → unauthorized（cookie 过期）、404 → no-subscription
// （workspace id 不属于该账号/已删除）。
describe('opencodeFetcher — A2-1 错误通道', () => {
  const OPENCODE_WS_URL = 'https://opencode.ai/workspace/wrk_test/go'

  // resetSec 由 resetsAt - now 推算，fake timers 定死时钟保证断言确定性（仅本 describe）。
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T06:00:00.000Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  const goMeter = (overrides: Record<string, unknown> = {}) => ({
    resetsAt: '2026-10-19T10:05:48.000Z',
    limitMicroCents: '1200000000',
    usedMicroCents: '146225762',
    ...overrides,
  })
  const fullMeters = { fiveHour: goMeter(), week: goMeter(), month: goMeter() }

  // [凭证拦截先于配置检查] normalizeCookieHeader 归一化为空 → 直接 unauthorized
  // （fetch 不发出），故 credential 必须用合法形态 'k=v'，否则本 describe 用例不可达。
  it('未配置 workspace → not_configured，不发任何 HTTP 请求（D1-3）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access: { meters: fullMeters } }, 200))
    const noConfig = await opencodeFetcher.fetchQuota('session=abc', 'cookie')
    expect(noConfig).toEqual({ ok: false, reason: 'not_configured' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('HTTP 401（cookie 过期）→ reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ _tag: 'Unauthorized' }, 401))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('HTTP 404（workspace id 不属于该账号）→ reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ _tag: 'NotFound' }, 404))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('HTTP 500 → reason=network', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 500))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('fetch 网络异常 → reason=network', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('200 但无三窗口数据 → reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access: { meters: {} } }, 200))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('字段类型漂移 → reason=parse', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ access: { meters: { fiveHour: goMeter({ usedMicroCents: 'abc' }) } } }, 200),
    )
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('成功：三窗口解析，请求 = 固定端点 + org id 进 x-org-id header（D1-4：URL 不含 id）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access: { meters: fullMeters } }, 200))

    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { workspaceUrl: OPENCODE_WS_URL })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://opencode.ai/console/api/go/status')
    // W3 迁移：引擎统一带 accept 头（跨家一致的 JSON 协商头，无害增量）；本断言锁点
    // 仍是「URL 不含 id、org id 经 header 注入」（D1-4）。
    expect(init.headers).toEqual({
      accept: 'application/json, text/plain, */*',
      cookie: 'session=abc',
      'x-org-id': 'wrk_test',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.wins).toEqual([
      { pct: 12, resetSec: 14748 },
      { pct: 12, resetSec: 14748 },
      { pct: 12, resetSec: 14748 },
    ])
  })

  it('auth 能力声明 = [\'cookie\']', () => {
    expect(opencodeFetcher.auth).toEqual(['cookie'])
  })
})

// ── SSOT 一致性：preset.auth 与注册表 fetcher.auth 对齐 ──

describe('QUOTA_PRESETS.auth 与 fetcher.auth 对齐（A2-1 数组化；presets = 基线 ⊕ 远程合并视图）', () => {
  it('每个 preset 的 auth 声明与对应 fetcher 完全一致（含数组序）', () => {
    for (const preset of listQuotaPresets()) {
      const fetcher = getQuotaFetcher(preset.fetcher)
      expect(fetcher, `fetcher ${preset.fetcher} 未注册`).toBeDefined()
      expect(fetcher?.auth, `preset ${preset.fetcher} auth 与 fetcher 声明不一致`).toEqual(preset.auth)
    }
  })

  it('kimi-coding 声明双形态、zhipu/minimax 仅 api-key、mimo/opencode-go 仅 cookie', () => {
    const byId = new Map(listQuotaPresets().map(p => [p.fetcher, p.auth]))
    expect(byId.get('kimi-coding')).toEqual(['api-key', 'oauth'])
    expect(byId.get('zhipu')).toEqual(['api-key'])
    expect(byId.get('minimax')).toEqual(['api-key'])
    expect(byId.get('mimo')).toEqual(['cookie'])
    expect(byId.get('opencode-go')).toEqual(['cookie'])
  })
})
