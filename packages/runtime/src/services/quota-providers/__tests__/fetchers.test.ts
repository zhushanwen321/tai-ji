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

  // ── RT-7#5：缺窗口字段不产假值（100% 假耗尽 / 0% 假未用）──

  it('5h 窗口 remaining 缺失（limit 在）→ INFINITE_WIN（不产 used=limit 的 100% 假耗尽）', async () => {
    const out = await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: 100, resetTime: '2026-08-23T12:00:00.000Z' } }],
      usage: { limit: 2000, used: 500 },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.wins[0]).toEqual({ pct: null, resetSec: null })
      // 未受影响的窗口照常
      expect(out.data.wins[1]).toMatchObject({ pct: 25 })
    }
  })

  it('week 窗口 used 缺失（limit 在）→ INFINITE_WIN（不产 pct=0 假未用）', async () => {
    const out = await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: 100, remaining: 60 } }],
      usage: { limit: 2000, resetTime: '2026-08-24T12:00:00.000Z' },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.wins[0]).toMatchObject({ pct: 40 })
      expect(out.data.wins[1]).toEqual({ pct: null, resetSec: null })
    }
  })

  it('窗口字段类型漂移（字符串数值）→ parse（guard 收到字段级）', async () => {
    expect(await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: '100', remaining: 60 } }],
      usage: { limit: 2000, used: 500 },
    })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: 100, remaining: 60 } }],
      usage: { limit: 2000, used: '500' },
    })).toEqual({ ok: false, reason: 'parse' })
    // limits 元素非对象（原 Array.isArray 只校容器不校元素）
    expect(await fetchOk(kimiFetcher, { limits: ['x'], usage: { limit: 1, used: 0 } })).toEqual({ ok: false, reason: 'parse' })
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

  // ── RT-7#5：monthUsage.percent 缺失不产 pct=0 假未用 ──

  it('monthUsage.percent 缺失 → pct:null（不可知），不产 0% 假未用', async () => {
    const out = await fetchOk(mimoFetcher, {
      code: 0,
      message: 'ok',
      data: { monthUsage: { items: [] }, usage: { percent: 0.1, items: [] } },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.wins[2]).toEqual({ pct: null, resetSec: null })
  })

  it('monthUsage 整体缺失（code=0）→ pct:null，不产 0% 假未用', async () => {
    const out = await fetchOk(mimoFetcher, {
      code: 0,
      message: 'ok',
      data: { usage: { percent: 0.1, items: [] } },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.wins[2]).toEqual({ pct: null, resetSec: null })
  })

  it('percent 类型漂移（字符串）→ parse（guard 字段级）', async () => {
    expect(await fetchOk(mimoFetcher, {
      code: 0,
      message: 'ok',
      data: { monthUsage: { percent: '0.25' as unknown as number, items: [] }, usage: { percent: 0.1, items: [] } },
    })).toEqual({ ok: false, reason: 'parse' })
  })

  // ── RT-7#6：code=0 时 data 缺失不再放行（原放行 → buildMonthWindow 读 undefined
  // 抛 TypeError → quota-service 误归 network）──

  it('code=0 且 data 缺失 → parse（原误归 network）', async () => {
    expect(await fetchOk(mimoFetcher, { code: 0, message: 'ok' })).toEqual({ ok: false, reason: 'parse' })
  })

  it('code=0 且 data 非对象 → parse', async () => {
    expect(await fetchOk(mimoFetcher, { code: 0, message: 'ok', data: 'oops' })).toEqual({ ok: false, reason: 'parse' })
  })

  it('对照：code 非 0 的在体错误响应 data 可缺席（no-subscription 语义保持，上方 401/403 用例同理）', async () => {
    expect(await fetchOk(mimoFetcher, { code: 2, message: 'no plan' })).toEqual({
      ok: false,
      reason: 'no-subscription',
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

  // ── RT-7#5：remaining_percent 缺失不产 pct=100 假耗尽 ──

  it('5h 窗口 remaining_percent 缺失（status=1）→ pct:null（不可知，resetSec 保留）', async () => {
    const { current_interval_remaining_percent: _drop, ...partial } = generalModel
    const out = await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [{ ...partial, current_weekly_remaining_percent: undefined }],
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.wins[0]).toEqual({ pct: null, resetSec: 1800 })
      expect(out.data.wins[1]).toEqual({ pct: null, resetSec: null })
    }
  })

  it('数值字段类型漂移（字符串百分比 / 字符串 status）→ parse', async () => {
    expect(await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [{ ...generalModel, current_interval_remaining_percent: '70' as unknown as number }],
    })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [{ ...generalModel, current_interval_status: '1' as unknown as number }],
    })).toEqual({ ok: false, reason: 'parse' })
    // model_remains 元素非对象
    expect(await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: ['x'],
    })).toEqual({ ok: false, reason: 'parse' })
  })

  // ── shape guard 分支补齐（isMinimaxResponse 余下判定单元）──

  it('顶层非对象（null / 字符串 / 数字）→ parse；顶层数组（两字段均缺）放行 → no-subscription', async () => {
    expect(await fetchOk(minimaxFetcher, null)).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(minimaxFetcher, 'oops')).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(minimaxFetcher, 42)).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(minimaxFetcher, [])).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('base_resp.status_code / model_name 类型漂移 → parse（guard 收到字段级）', async () => {
    expect(await fetchOk(minimaxFetcher, { base_resp: { status_code: '0' } })).toEqual({
      ok: false,
      reason: 'parse',
    })
    expect(await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [{ ...generalModel, model_name: 123 }],
    })).toEqual({ ok: false, reason: 'parse' })
  })

  it('余下数值字段逐字段漂移（remains_time / weekly 三字段）→ parse', async () => {
    for (const field of [
      'remains_time',
      'current_weekly_remaining_percent',
      'current_weekly_status',
      'weekly_remains_time',
    ] as const) {
      expect(await fetchOk(minimaxFetcher, {
        base_resp: { status_code: 0 },
        model_remains: [{ ...generalModel, [field]: 'drift' }],
      })).toEqual({ ok: false, reason: 'parse' })
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

  // ── RT-7#5：TOKENS_LIMIT 无 percentage / 无该条目 → 不产 pct=0 假未用 ──

  it('TOKENS_LIMIT 条目 percentage 缺失 → INFINITE_WIN（pct:null 整行隐藏）', async () => {
    const out = await fetchOk(zhipuFetcher, {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', nextResetTime: '4h' }] },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.wins[0]).toEqual({ pct: null, resetSec: null })
  })

  it('无 TOKENS_LIMIT 条目（仅 OTHER）→ INFINITE_WIN（原 pct=0 假未用）', async () => {
    const out = await fetchOk(zhipuFetcher, {
      success: true,
      data: { level: 'Max', limits: [{ type: 'OTHER', percentage: 99 }] },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.label).toBe('Z.ai-Max')
      expect(out.data.wins[0]).toEqual({ pct: null, resetSec: null })
    }
  })

  it('limits 元素类型漂移（非对象 / type 缺失 / 字符串 percentage）→ parse', async () => {
    expect(await fetchOk(zhipuFetcher, { success: true, data: { limits: ['x'] } })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(zhipuFetcher, { success: true, data: { limits: [{ percentage: 5 }] } })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(zhipuFetcher, {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: '5' as unknown as number }] },
    })).toEqual({ ok: false, reason: 'parse' })
  })
})

describe('fetchQuotaJson 共享骨架（[u10/G4] 非 2xx body 释放）', () => {
  it('非 2xx：resp.body 被 cancel——连接不被未消费 body 钉住（无法回池复用 + 缓冲驻留）', async () => {
    const { fetchQuotaJson, isRecord } = await import('../types.js')
    const resp = jsonResponse({ error: 'boom' }, 500)
    const cancelSpy = vi.spyOn(resp.body!, 'cancel')

    const out = await fetchQuotaJson('test', async () => resp, isRecord)

    expect(out).toEqual({ ok: false, reason: 'network' })
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('2xx 正常路径：不 cancel body（json() 消费，cancel 会破坏正常读取）', async () => {
    const { fetchQuotaJson, isRecord } = await import('../types.js')
    const resp = jsonResponse({ success: true })
    const cancelSpy = vi.spyOn(resp.body!, 'cancel')

    const out = await fetchQuotaJson('test', async () => resp, isRecord)

    expect(out).toEqual({ ok: true, data: { success: true } })
    expect(cancelSpy).not.toHaveBeenCalled()
  })
})
