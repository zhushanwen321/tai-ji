/**
 * 4 个 JSON 额度 fetcher（kimi/mimo/minimax/zhipu）行为锁定测试。
 *
 * 覆盖错误通道（unauthorized / statusToReason / parse / network）与
 * 成功路径（wins 组装数值断言）。opencode.ts 为 HTML 解析路径，不在此覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import type { ProviderQuotaFetcher, QuotaAuthKind } from '../types.js'
import { normalizeCookieHeader } from '../types.js'
import { kimiFetcher } from '../kimi.js'
import { mimoFetcher } from '../mimo.js'
import { minimaxFetcher } from '../minimax.js'
import { zhipuFetcher } from '../zhipu.js'

const NOW_ISO = '2026-08-23T10:00:00.000Z'
const NOW_MS = new Date(NOW_ISO).getTime()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function setupFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

async function fetchOk(fetcher: ProviderQuotaFetcher, body: unknown) {
  setupFetch(() => jsonResponse(body))
  // 凭证用带 = 的真实形态：mimo fetcher 会对粘贴 cookie 归一化，无 = 的裸串被判空 → unauthorized
  return fetcher.fetchQuota('sid=1', 'api-key' as QuotaAuthKind)
}

describe('kimiFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('无凭证 → unauthorized', async () => {
    const out = await kimiFetcher.fetchQuota('', 'api-key')
    expect(out).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('401/403 → unauthorized，404/500 → network', async () => {
    setupFetch(() => jsonResponse({}, 401))
    expect(await kimiFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'unauthorized' })
    setupFetch(() => jsonResponse({}, 403))
    expect(await kimiFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'unauthorized' })
    setupFetch(() => jsonResponse({}, 404))
    expect(await kimiFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'network' })
    setupFetch(() => jsonResponse({}, 500))
    expect(await kimiFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'network' })
  })

  it('非法 JSON body → parse', async () => {
    setupFetch(() => new Response('<html>', { status: 200 }))
    expect(await kimiFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'parse' })
  })

  it('fetch 抛异常（网络/超时）→ network', async () => {
    setupFetch(() => {
      throw new Error('fetch failed')
    })
    expect(await kimiFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'network' })
  })

  it('shape guard 失败（limits 类型漂移）→ parse', async () => {
    expect(await fetchOk(kimiFetcher, { limits: 'abc' })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(kimiFetcher, { usage: 'abc' })).toEqual({ ok: false, reason: 'parse' })
  })

  it('limits 与 usage 均缺失 → no-subscription', async () => {
    expect(await fetchOk(kimiFetcher, {})).toEqual({ ok: false, reason: 'no-subscription' })
    expect(await fetchOk(kimiFetcher, { limits: [] })).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('成功路径：5h + week 绝对量 + month 无限', async () => {
    const out = await fetchOk(kimiFetcher, {
      limits: [
        { detail: { limit: 100, remaining: 60, resetTime: '2026-08-23T12:00:00.000Z' } },
      ],
      usage: { limit: 2000, used: 500, resetTime: '2026-08-24T12:00:00.000Z' },
    })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'Kimi Coding',
        wins: [
          { pct: 40, used: 40, limit: 100, unit: 'requests', resetSec: 7200 },
          { pct: 25, used: 500, limit: 2000, unit: 'requests', resetSec: 93600 },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('limit≤0 窗口 → INFINITE_WIN', async () => {
    const out = await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: 0, remaining: 0 } }],
      usage: { limit: 0, used: 0 },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.wins).toEqual([
        { pct: null, resetSec: null },
        { pct: null, resetSec: null },
        { pct: null, resetSec: null },
      ])
    }
  })
})

describe('mimoFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('无凭证 → unauthorized', async () => {
    expect(await mimoFetcher.fetchQuota('', 'cookie')).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('401 → unauthorized，500 → network', async () => {
    setupFetch(() => jsonResponse({}, 401))
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({ ok: false, reason: 'unauthorized' })
    setupFetch(() => jsonResponse({}, 500))
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({ ok: false, reason: 'network' })
  })

  it('会话过期 3xx（redirect manual 不跟随）→ unauthorized', async () => {
    setupFetch(() => new Response(null, { status: 302 }))
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('在体 401/403（HTTP 200 + body code）→ unauthorized', async () => {
    expect(await fetchOk(mimoFetcher, { code: 401, message: 'login required' })).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    expect(await fetchOk(mimoFetcher, { code: 403 })).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('非法 JSON → parse；code 类型漂移 → parse', async () => {
    setupFetch(() => new Response('not json'))
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(mimoFetcher, { code: '401' })).toEqual({ ok: false, reason: 'parse' })
  })

  it('code 非 0（非过期码）→ no-subscription', async () => {
    expect(await fetchOk(mimoFetcher, { code: 1, message: 'no plan' })).toEqual({
      ok: false,
      reason: 'no-subscription',
    })
  })

  it('成功路径：仅 month 窗口，percent ×100，5h/week 恒无限', async () => {
    const out = await fetchOk(mimoFetcher, {
      code: 0,
      message: 'ok',
      data: {
        monthUsage: { percent: 0.25, items: [] },
        usage: { percent: 0.1, items: [] },
      },
    })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'MiMo Coding',
        wins: [
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
          { pct: 25, resetSec: null },
        ],
      },
    })
  })

  it('month 窗口补 token 绝对量 + detail.currentPeriodEnd → resetSec', async () => {
    setupFetch((input) => {
      const url = String(input)
      if (url.includes('/detail')) {
        return jsonResponse({ code: 0, message: 'ok', data: { planCode: 'standard', currentPeriodEnd: '2026-08-24 00:00:00' } })
      }
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          monthUsage: {
            percent: 0.25,
            items: [{ used: 2_600_000_000, limit: 11_000_000_000 }],
          },
          usage: { percent: 0.1, items: [] },
        },
      })
    })
    const out = await mimoFetcher.fetchQuota('sid=1', 'cookie')
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'MiMo Coding',
        wins: [
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
          // currentPeriodEnd 无时区标记按 UTC 解析：2026-08-23T10:00Z → 2026-08-24T00:00Z = 14h
          { pct: 25, used: 2_600_000_000, limit: 11_000_000_000, unit: 'tokens', resetSec: 50_400 },
        ],
      },
    })
  })

  it('detail 失败 → 降级 resetSec=null，不影响用量主数据', async () => {
    setupFetch((input) => {
      const url = String(input)
      if (url.includes('/detail')) return jsonResponse({}, 500)
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: {
          monthUsage: { percent: 0.34, items: [{ used: 3, limit: 0 }] },
          usage: { percent: 0.1, items: [] },
        },
      })
    })
    const out = await mimoFetcher.fetchQuota('sid=1', 'cookie')
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'MiMo Coding',
        wins: [
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
          // limit=0 不采信绝对量，只输出 pct
          { pct: 34, resetSec: null },
        ],
      },
    })
  })
})

describe('normalizeCookieHeader', () => {
  it.each([
    ['a=1; b=2', 'a=1; b=2'],
    ['a = 1 ; b = 2', 'a=1; b=2'],
    ['k="v w"; b=2', 'k="v w"; b=2'],
    ['; a=1; ; b=2;', 'a=1; b=2'],
    ['   ', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalizeCookieHeader(input)).toBe(expected)
  })
})

describe('minimaxFetcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const generalModel = {
    model_name: 'general',
    current_interval_remaining_percent: 70,
    current_interval_status: 1,
    remains_time: 1800000,
    current_weekly_remaining_percent: 10,
    current_weekly_status: 1,
    weekly_remains_time: 0,
  }

  it('无凭证 → unauthorized', async () => {
    expect(await minimaxFetcher.fetchQuota('', 'api-key')).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('403 → unauthorized，404 → network', async () => {
    setupFetch(() => jsonResponse({}, 403))
    expect(await minimaxFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'unauthorized' })
    setupFetch(() => jsonResponse({}, 404))
    expect(await minimaxFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'network' })
  })

  it('非法 JSON → parse；base_resp 类型漂移 → parse', async () => {
    setupFetch(() => new Response('oops'))
    expect(await minimaxFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(minimaxFetcher, { base_resp: 'err' })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(minimaxFetcher, { model_remains: 'x' })).toEqual({ ok: false, reason: 'parse' })
  })

  it('status_code 非 0 / 无模型 / 无 general → no-subscription', async () => {
    expect(await fetchOk(minimaxFetcher, { base_resp: { status_code: 1 } })).toEqual({
      ok: false,
      reason: 'no-subscription',
    })
    expect(
      await fetchOk(minimaxFetcher, { base_resp: { status_code: 0 }, model_remains: [] }),
    ).toEqual({ ok: false, reason: 'no-subscription' })
    expect(
      await fetchOk(minimaxFetcher, {
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: 'other' }],
      }),
    ).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('成功路径：剩余百分比反转为已用，status≠1 窗口无限', async () => {
    const out = await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [generalModel],
    })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'MiniMax Coding',
        wins: [
          { pct: 30, resetSec: 1800 },
          { pct: 90, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('status≠1 → 该窗口 INFINITE_WIN', async () => {
    const out = await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          ...generalModel,
          current_interval_status: 0,
          current_weekly_status: 0,
        },
      ],
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.wins[0]).toEqual({ pct: null, resetSec: null })
      expect(out.data.wins[1]).toEqual({ pct: null, resetSec: null })
    }
  })
})

describe('zhipuFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('无凭证 → unauthorized', async () => {
    expect(await zhipuFetcher.fetchQuota('', 'api-key')).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('401 → unauthorized，500 → network', async () => {
    setupFetch(() => jsonResponse({}, 401))
    expect(await zhipuFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'unauthorized' })
    setupFetch(() => jsonResponse({}, 500))
    expect(await zhipuFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'network' })
  })

  it('非法 JSON → parse；data 类型漂移 → parse', async () => {
    setupFetch(() => new Response('bad'))
    expect(await zhipuFetcher.fetchQuota('c', 'api-key')).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(zhipuFetcher, { success: true, data: 'abc' })).toEqual({
      ok: false,
      reason: 'parse',
    })
    expect(await fetchOk(zhipuFetcher, { success: 'yes' })).toEqual({ ok: false, reason: 'parse' })
  })

  it('success falsy / data 缺失 → no-subscription', async () => {
    expect(await fetchOk(zhipuFetcher, { success: false })).toEqual({
      ok: false,
      reason: 'no-subscription',
    })
    expect(await fetchOk(zhipuFetcher, {})).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('成功路径：level 进 label，epoch resetTime 转 resetSec', async () => {
    const out = await fetchOk(zhipuFetcher, {
      success: true,
      data: {
        level: 'Max',
        limits: [
          { type: 'OTHER', percentage: 99 },
          { type: 'TOKENS_LIMIT', percentage: 42, nextResetTime: String(NOW_MS + 3600_000) },
        ],
      },
    })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'Z.ai-Max',
        wins: [
          { pct: 42, resetSec: 3600 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('无 level → label 兜底 Z.ai；resetTime "4h11m" 相对格式兜底', async () => {
    const out = await fetchOk(zhipuFetcher, {
      success: true,
      data: {
        limits: [{ type: 'TOKENS_LIMIT', percentage: 5, nextResetTime: '4h11m' }],
      },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.label).toBe('Z.ai')
      expect(out.data.wins[0]).toEqual({ pct: 5, resetSec: 4 * 3600 + 11 * 60 })
    }
  })
})
