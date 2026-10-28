/**
 * QuotaProviders（kimi/mimo/minimax/zhipu fetcher / fetchQuotaJson 骨架 / opencode / index guard 与合并视图 / 契约错误通道）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - fetchers.test.ts
 * - opencode.test.ts
 * - index.test.ts
 * - quota-providers-contract.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/quota-providers/__tests__/fetchers.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import type { QuotaPreset, QuotaFetchOutcome } from '@taiji/shared'
import { normalizeCookieHeader, isQuotaPreset, QUOTA_PRESETS } from '@taiji/shared'
import { getQuotaFetcher, isQuotaFetchersRemoteConfig, listQuotaPresets } from '../index.js'
import type { ProviderQuotaFetcher, QuotaAuthKind } from '../types.js'

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const remoteState = vi.hoisted(() => ({ payload: undefined as unknown }))

vi.mock('../../remote-config/remote-config-fetch.js', () => ({
  loadRemoteConfig: vi.fn((_domain: string, guard: (v: unknown) => boolean) =>
    remoteState.payload !== undefined && guard(remoteState.payload) ? remoteState.payload : undefined),
}))


describe('fetchers', () => {
/**
 * 4 个 JSON 额度 fetcher（kimi/mimo/minimax/zhipu）行为锁定测试。
 *
 * 覆盖错误通道（unauthorized / statusToReason / parse / network）与
 * 成功路径（wins 组装数值断言）。opencode.ts 为 HTML 解析路径，不在此覆盖。
 */


// W3 迁移：被测对象从硬编码 TS fetcher 换为「基线配置 ⊕ 声明式引擎」——同一批 wire
// fixture 断言不变 = 等价证明（迁移红线）。id 为持久化契约（providers.json extras）。
const kimiFetcher = getQuotaFetcher('kimi-coding')!
const mimoFetcher = getQuotaFetcher('mimo')!
const minimaxFetcher = getQuotaFetcher('minimax')!
const zhipuFetcher = getQuotaFetcher('zhipu')!

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
  // 凭证用带 = 的真实形态：mimo fetcher 会对粘贴 cookie 归一化，无 = 的裸串被判空 →
  // cookie-invalid-format（2026-10-18 与 unauthorized 分流）
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

  // ── wire 形态实测锚点（2026-09-24，api.kimi.com/coding/v1/usages 真响应）──
  // 真响应的数值字段以**字符串数值**下发（`"100"`）、detail 提供 `used` 而非 `remaining`，
  // 顶层还有 booster_wallet / usages 等未知字段。曾按「纯 number + remaining 形态」收紧
  // guard（假想 wire），拒真响应归 parse → 额度查询恒「获取失败」。本组锁定真实形态。

  it('真响应形态：字符串数值 + detail.used（无 remaining）→ 正确窗口，未知字段放行', async () => {
    const out = await fetchOk(kimiFetcher, {
      usage: { limit: '100', used: '71', remaining: '29', resetTime: '2026-08-24T12:00:00.001143Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', used: '100', resetTime: '2026-08-23T12:00:00.001143Z' },
        },
      ],
      booster_wallet: { id: 'opaque', balance: { amount: '20000000000' } },
    })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'Kimi Coding',
        wins: [
          { pct: 100, used: 100, limit: 100, unit: 'requests', resetSec: 7200 },
          { pct: 71, used: 71, limit: 100, unit: 'requests', resetSec: 93600 },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('used 显式提供时优先于 remaining 折算（两者并存）', async () => {
    const out = await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: 100, used: 25, remaining: 60 } }],
      usage: { limit: 100, used: 25, remaining: 75 },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.wins[0]).toMatchObject({ pct: 25, used: 25, limit: 100 })
      expect(out.data.wins[1]).toMatchObject({ pct: 25, used: 25, limit: 100 })
    }
  })

  it('数值字段无法解析为数值（非数值串/空串/空白串/布尔/嵌套对象）→ parse；limits 元素非对象 → parse', async () => {
    expect(await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: 'abc' } }],
      usage: {},
    })).toEqual({ ok: false, reason: 'parse' })
    // 空串/空白串：numericField trim 后为空 → undefined（空串非合法 wire 数值，等同漂移）
    expect(await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: '' } }],
      usage: {},
    })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(kimiFetcher, {
      limits: [{ detail: { limit: '   ' } }],
      usage: {},
    })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(kimiFetcher, {
      usage: { limit: 100, used: true },
    })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(kimiFetcher, {
      limits: [{ detail: { remaining: { value: 1 } } }],
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

  it('无凭证 / 无 k=v 对 → cookie-invalid-format（与 unauthorized 分流：不发 HTTP）', async () => {
    expect(await mimoFetcher.fetchQuota('', 'cookie')).toEqual({ ok: false, reason: 'cookie-invalid-format' })
    // 典型错误粘贴：DevTools Application → Cookies 表格（制表符分隔，无任何 = ）
    const fetchMock = setupFetch(() => jsonResponse({}))
    expect(await mimoFetcher.fetchQuota('sid\t1\nother\t2', 'cookie')).toEqual({ ok: false, reason: 'cookie-invalid-format' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── cookie 空判据判归一后的值（types.ts normalizeCookieHeader 契约）──
  // `';'` / `' ; '` 等无任何 k=v 对的粘贴伪影原文非空、归一后为空串——判原文会带着空
  // cookie 头真发一次请求（对齐迁移前 mimo fetcher 先归一再判空）

  it('cookie 归一后为空（";" / " ; " / 纯空白）→ cookie-invalid-format 且不发请求', async () => {
    const mock = setupFetch(() => jsonResponse({ code: 0, message: 'ok', data: {} }))
    for (const raw of [';', ' ; ', '   ', '; ;']) {
      expect(await mimoFetcher.fetchQuota(raw, 'cookie')).toEqual({ ok: false, reason: 'cookie-invalid-format' })
    }
    expect(mock).not.toHaveBeenCalled()
  })

  it('cookie 空白伪影归一后照常发送（header 拿归一值，非原文）', async () => {
    const mock = setupFetch(() => jsonResponse({
      code: 0,
      message: 'ok',
      data: { usage: { percent: 0.1, items: [] } },
    }))
    const out = await mimoFetcher.fetchQuota(' sid = 1 ; x = 2 ', 'cookie')
    expect(out.ok).toBe(true)
    const init = mock.mock.calls[0]?.[1] as RequestInit | undefined
    expect((init?.headers as Record<string, string>)['cookie']).toBe('sid=1; x=2')
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

  it('code 字段消失（决策字段缺失）→ parse（漂移可见，不引导查订阅）', async () => {
    expect(await fetchOk(mimoFetcher, { message: 'no code field' })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(mimoFetcher, { code: null })).toEqual({ ok: false, reason: 'parse' })
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

  it('detail resetSec 字段级漂移（currentPeriodEnd 非字符串 / data 非对象）→ resetSec=null，主数据保留', async () => {
    // 字段级漂移与请求级失败（上方用例）同语义：仅 reset 信息缺失，pct/绝对量陪葬不发生
    const monthBody = {
      code: 0,
      message: 'ok',
      data: { monthUsage: { percent: 0.25, items: [{ used: 100, limit: 400 }] }, usage: { percent: 0.1, items: [] } },
    }
    const expected = {
      ok: true,
      data: {
        label: 'MiMo Coding',
        wins: [
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
          { pct: 25, used: 100, limit: 400, unit: 'tokens', resetSec: null },
        ],
      },
    }
    setupFetch((input) => {
      const url = String(input)
      if (url.includes('/detail')) return jsonResponse({ code: 0, message: 'ok', data: { currentPeriodEnd: 12345 } })
      return jsonResponse(monthBody)
    })
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual(expected)
    // 路径容器形态漂移（detail data 非对象）同只降级 resetSec
    setupFetch((input) => {
      const url = String(input)
      if (url.includes('/detail')) return jsonResponse({ code: 0, message: 'ok', data: 123 })
      return jsonResponse(monthBody)
    })
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual(expected)
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

// ── Set-Cookie 续期透传（cookie 滑动续期，方案①）：引擎只捕获透传，回写归
// quota-service（按凭证形态裁决）——此处锁定「捕获到的原始行原样出现在 outcome.setCookies」。──

describe('mimoFetcher — Set-Cookie 透传', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** 构造带多个 Set-Cookie 行的 JSON Response（append 逐条添加，getSetCookie 逐条返回）。 */
  function responseWithCookies(body: unknown, setCookieLines: string[], status = 200): Response {
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const line of setCookieLines) headers.append('set-cookie', line)
    return new Response(body === null ? null : JSON.stringify(body), { status, headers })
  }

  it('成功响应带多行 Set-Cookie → outcome.setCookies 透传原始行（含属性段）', async () => {
    setupFetch((input) => {
      // mimo 的 /detail 辅助请求分流到无 Set-Cookie 响应——本用例锁主请求的透传形态
      if (String(input).includes('/detail')) {
        return responseWithCookies({ code: 0, message: 'ok', data: { planCode: 'standard' } }, [])
      }
      return responseWithCookies(
        { code: 0, message: 'ok', data: { monthUsage: { percent: 0.25, items: [] }, usage: { percent: 0.1, items: [] } } },
        ['sid=new; Path=/; HttpOnly', 'csrf=tok'],
      )
    })
    const out = await mimoFetcher.fetchQuota('sid=1', 'cookie')
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
      setCookies: ['sid=new; Path=/; HttpOnly', 'csrf=tok'],
    })
  })

  it('3xx redirect（redirect:manual 不跟随 → unauthorized）带 Set-Cookie 同样透传（滑动续期常伴随会话刷新出现）', async () => {
    setupFetch(() => responseWithCookies(null, ['sid=refreshed; Path=/'], 302))
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({
      ok: false,
      reason: 'unauthorized',
      setCookies: ['sid=refreshed; Path=/'],
    })
  })

  it('401 带 Set-Cookie → unauthorized + setCookies 透传', async () => {
    setupFetch(() => responseWithCookies({}, ['sid=rotated'], 401))
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({
      ok: false,
      reason: 'unauthorized',
      setCookies: ['sid=rotated'],
    })
  })

  it('辅助请求（/detail）的 Set-Cookie 合并进同一数组（主请求在前）', async () => {
    setupFetch((input) => {
      if (String(input).includes('/detail')) {
        return responseWithCookies(
          { code: 0, message: 'ok', data: { planCode: 'standard', currentPeriodEnd: '2026-08-24 00:00:00' } },
          ['d=aux'],
        )
      }
      return responseWithCookies(
        { code: 0, message: 'ok', data: { monthUsage: { percent: 0.25, items: [] }, usage: { percent: 0.1, items: [] } } },
        ['m=main'],
      )
    })
    const out = await mimoFetcher.fetchQuota('sid=1', 'cookie')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.setCookies).toEqual(['m=main', 'd=aux'])
  })

  it('在体业务码失败（code=401 → unauthorized）的 Set-Cookie 同样透传', async () => {
    setupFetch((input) => {
      if (String(input).includes('/detail')) return responseWithCookies({ code: 0, message: 'ok', data: {} }, [])
      return responseWithCookies({ code: 401, message: 'login required' }, ['sid=x'])
    })
    expect(await mimoFetcher.fetchQuota('sid=1', 'cookie')).toEqual({
      ok: false,
      reason: 'unauthorized',
      setCookies: ['sid=x'],
    })
  })

  it('响应无 Set-Cookie → outcome 不带 setCookies 键（非 cookie 类请求路径零扰动）', async () => {
    setupFetch(() => jsonResponse({ code: 0, message: 'ok', data: { usage: { percent: 0.1, items: [] } } }))
    const out = await mimoFetcher.fetchQuota('sid=1', 'cookie')
    expect(out.ok).toBe(true)
    if (out.ok) expect('setCookies' in out).toBe(false)
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

  it('status 字段缺失（状态不可知）→ 该窗口 INFINITE_WIN，不放行求 pct', async () => {
    const out = await fetchOk(minimaxFetcher, {
      base_resp: { status_code: 0 },
      model_remains: [{ ...generalModel, current_interval_status: undefined, current_weekly_status: undefined }],
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      // 缺失若被放行，5h 会产 pct=30、week 会产 pct=90 的假可用态
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

  // ── label 插值源形态漂移（迁移前 zhipu guard isOptionalField(d.level, 'string') 等价）──
  // 插值字段存在但非 string 不得被静默 stringify 成 `Z.ai-123`——整查询归 parse（漂移可见）

  it('data.level 类型漂移（number / boolean / 对象）→ parse，不产 Z.ai-123', async () => {
    for (const level of [3, true, { name: 'Max' }]) {
      expect(await fetchOk(zhipuFetcher, {
        success: true,
        data: { level, limits: [{ type: 'TOKENS_LIMIT', percentage: 42 }] },
      })).toEqual({ ok: false, reason: 'parse' })
    }
  })

  it('data.level 为 null → 按缺失走 label 兜底 Z.ai（不产尾部分隔符 Z.ai-）', async () => {
    const out = await fetchOk(zhipuFetcher, {
      success: true,
      data: { level: null, limits: [{ type: 'TOKENS_LIMIT', percentage: 42 }] },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.label).toBe('Z.ai')
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

  // ── wire 形态实测锚点（2026-09-24，bigmodel.cn/api/monitor/usage/quota/limit 真响应）──
  // 真响应的 nextResetTime 以 **number epoch-ms** 下发（非字符串），limits 还含 TIME_LIMIT
  // 条目（带 usage/remaining/usageDetails 等未校字段）。曾按「纯 string」收紧该字段（假想
  // wire），拒真响应归 parse → 额度查询恒「获取失败」。本组锁定真实形态。

  it('真响应形态：number epoch-ms nextResetTime + TIME_LIMIT 条目（未知字段放行）→ TOKENS_LIMIT 窗口', async () => {
    const out = await fetchOk(zhipuFetcher, {
      code: 200,
      msg: '操作成功',
      success: true,
      data: {
        limits: [
          {
            type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 155, remaining: 845,
            percentage: 15, nextResetTime: NOW_MS + 3600_000,
            usageDetails: [{ modelCode: 'search-prime', usage: 139 }],
          },
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: NOW_MS + 7200_000 },
        ],
        level: 'pro',
      },
    })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'Z.ai-pro',
        wins: [
          { pct: 42, resetSec: 7200 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('nextResetTime 非法类型（布尔/对象）→ parse（仅 number|string 放行）', async () => {
    expect(await fetchOk(zhipuFetcher, {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 5, nextResetTime: true }] },
    })).toEqual({ ok: false, reason: 'parse' })
    expect(await fetchOk(zhipuFetcher, {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 5, nextResetTime: { ms: 1 } }] },
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
})

describe('opencode', () => {
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

// W3 迁移：被测对象换为「基线配置 ⊕ 声明式引擎」，fixture 断言不变 = 等价证明。
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
})

describe('index', () => {
/**
 * quota-providers 注册表层单测（index.ts）：
 *
 * 1. isQuotaFetchersRemoteConfig —— 远程 quota-fetchers 域 guard。fetchers 段逐元素全字段
 *    校验（isDeclarativeFetcherConfig）；presets 段逐元素 QuotaPreset 形状校验（isQuotaPreset）。
 *    畸形 preset 元素（如缺 match）若放行，会经 listQuotaPresets 下发前端 / 进入匹配链，
 *    matchQuotaPreset 对缺 match 元素解构即 TypeError（额度 label / 自动开启判定渲染期抛错）。
 * 2. listQuotaPresets 合并视图链路：guard 拒绝 → 整体拒用回退基线 QUOTA_PRESETS（不部分
 *    采纳，remote-config fail-safe 链语义）；guard 通过 → 远程 presets 整体替换基线。
 *
 * loadRemoteConfig 以 vi.mock 注入远程 payload（纯缓存读侧无网络；cacheSnapshots 模块级
 * 状态不参与——本文件只经 guard/payload 通道驱动）。
 */

// 相对测试文件（src/services/quota-providers/__tests__/）解析到 src/services/remote-config/，
// 与 index.ts 的 import spec（'../remote-config/remote-config-fetch.js'）同一模块实例。

/** 合法 fetcher 配置 fixture（基线 zhipu 条目等价形态，过 isDeclarativeFetcherConfig）。 */
const VALID_FETCHER = {
  label: 'Z.ai',
  auth: ['api-key'],
  credential: 'raw',
  requests: [{ name: 'main', url: 'https://bigmodel.cn/api/monitor/usage/quota/limit' }],
  bodyCode: { path: 'success', success: true, else: 'no-subscription' },
  requires: ['data'],
  windows: [{ slot: 'fiveHour', pct: { path: 'data.limits[type=TOKENS_LIMIT].percentage', via: 'direct' } }],
}

/** 合法 preset 元素 fixture（QUOTA_PRESETS[0] 等价最小形态）。 */
function validPreset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fetcher: 'zhipu',
    label: 'Zhipu Coding Plan',
    auth: ['api-key'],
    match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu' },
    ...overrides,
  }
}

function remoteConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, presets: [validPreset()], ...overrides }
}

/** 合法 QuotaPreset（validPreset 的类型化视图，供远程 payload 构造）。 */
const VALID_PRESET = validPreset() as unknown as QuotaPreset

beforeEach(() => {
  remoteState.payload = undefined
})

// 合并产物卫生修正：末例设置的 payload 原独立文件中无后续消费者，合并后须还原，
// 否则残留远程表替换后续 contract 节的基线合并视图
afterEach(() => {
  remoteState.payload = undefined
})

describe('isQuotaPreset（QuotaPreset wire 形状守卫）', () => {
  it('合法 preset（含未知扩展字段）放行', () => {
    expect(isQuotaPreset(validPreset({ futureField: { nested: true } }))).toBe(true)
  })

  it.each([
    ['非对象', 'x'],
    ['数组', [validPreset()]],
    ['null', null],
    ['fetcher 缺失', { label: 'L', auth: ['api-key'], match: {} }],
    ['fetcher 空串', validPreset({ fetcher: '' })],
    ['fetcher 非字符串', validPreset({ fetcher: 42 })],
    ['label 缺失', { fetcher: 'f', auth: ['api-key'], match: {} }],
    ['label 非字符串', validPreset({ label: 42 })],
    ['auth 缺失', { fetcher: 'f', label: 'L', match: {} }],
    ['auth 非数组', validPreset({ auth: 'api-key' })],
    ['auth 元素非字符串', validPreset({ auth: ['api-key', 42] })],
    ['match 缺失（matchQuotaPreset 解构即 TypeError 的形态）', { fetcher: 'f', label: 'L', auth: ['api-key'] }],
    ['match 非对象', validPreset({ match: 'bigmodel.cn' })],
    ['match 为数组', validPreset({ match: ['bigmodel.cn'] })],
    ['baseUrlPattern 非字符串', validPreset({ match: { baseUrlPattern: 42 } })],
    ['namePattern 非字符串', validPreset({ match: { namePattern: 42 } })],
    ['helpUrl 类型漂移', validPreset({ helpUrl: 42 })],
    ['helpText 类型漂移', validPreset({ helpText: 42 })],
    ['params 类型漂移（非数组）', validPreset({ params: 'workspaceUrl' })],
    ['params 元素畸形（缺 key）', validPreset({ params: [{ label: 'L' }] })],
    ['params 元素 key 空串', validPreset({ params: [{ key: '' }] })],
    ['params normalize 非法值', validPreset({ params: [{ key: 'x', normalize: 'bogus' }] })],
    ['params key 重复', validPreset({ params: [{ key: 'x' }, { key: 'x' }] })],
  ])('%s → false', (_name, v) => {
    expect(isQuotaPreset(v)).toBe(false)
  })

  it('match 仅含 namePattern（baseUrlPattern 合法缺省）放行', () => {
    expect(isQuotaPreset(validPreset({ match: { namePattern: '\\bopencode\\b' } }))).toBe(true)
  })
})

describe('isQuotaFetchersRemoteConfig（远程域 guard）', () => {
  it('version 1 + 合法 presets → true', () => {
    expect(isQuotaFetchersRemoteConfig(remoteConfig())).toBe(true)
  })

  it('presets 缺省（undefined）→ true（fetchers 单段覆盖合法）', () => {
    expect(isQuotaFetchersRemoteConfig({ version: 1, fetchers: { zhipu: VALID_FETCHER } })).toBe(true)
  })

  it('presets 非数组 → false', () => {
    expect(isQuotaFetchersRemoteConfig(remoteConfig({ presets: validPreset() }))).toBe(false)
  })

  it('presets 元素畸形（缺 match）→ false（整体拒用，不部分采纳）', () => {
    expect(
      isQuotaFetchersRemoteConfig(remoteConfig({ presets: [VALID_PRESET, { fetcher: 'f', label: 'L', auth: ['api-key'] }] })),
    ).toBe(false)
  })

  it('fetchers 段元素畸形 → false（既有强度保持，与 presets 同强度）', () => {
    expect(isQuotaFetchersRemoteConfig(remoteConfig({ fetchers: { bad: { label: 'x' } } }))).toBe(false)
  })

  it('version 非 1 / 非对象 → false', () => {
    expect(isQuotaFetchersRemoteConfig({ version: 2 })).toBe(false)
    expect(isQuotaFetchersRemoteConfig('x')).toBe(false)
    expect(isQuotaFetchersRemoteConfig(null)).toBe(false)
  })
})

describe('listQuotaPresets 合并视图（guard 拒绝 → 基线兜底链路）', () => {
  it('无远程覆盖（payload undefined）→ 基线 QUOTA_PRESETS', () => {
    expect(listQuotaPresets()).toBe(QUOTA_PRESETS)
  })

  it('远程 payload 被 guard 拒绝（preset 元素缺 match）→ 整体拒用回退基线 QUOTA_PRESETS', () => {
    // 混入一条畸形元素（缺 match）：若 guard 放行，前端/匹配链解构该元素即 TypeError
    remoteState.payload = remoteConfig({ presets: [{ fetcher: 'f', label: 'L', auth: ['api-key'] }] })
    expect(listQuotaPresets()).toBe(QUOTA_PRESETS)
  })

  it('远程 presets 合法 → 整体替换基线（远程表权威）', () => {
    const remotePresets = [
      validPreset({ fetcher: 'remote-only-fetcher', label: 'Remote Plan', match: { namePattern: '\\bremoteplan\\b' } }),
    ] as unknown as QuotaPreset[]
    remoteState.payload = remoteConfig({ presets: remotePresets })

    const presets = listQuotaPresets()
    expect(presets).toEqual(remotePresets)
    expect(presets).not.toBe(QUOTA_PRESETS)
  })
})
})

describe('quota-providers-contract', () => {
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
// W3 迁移：被测对象从硬编码 TS fetcher 换为「基线配置 ⊕ 声明式引擎」注册表——
// 同一批契约断言不变 = 等价证明（A2-1 错误通道 + A2-3 绝对量输出语义保持）。
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

  // [凭证拦截先于配置检查] normalizeCookieHeader 归一化为空 → cookie-invalid-format
  // （fetch 不发出），故 credential 必须用合法形态 'k=v'，否则本 describe 用例不可达。
  it('未配置 workspace → not_configured，不发任何 HTTP 请求（D1-3）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access: { meters: fullMeters } }, 200))
    const noConfig = await opencodeFetcher.fetchQuota('session=abc', 'cookie')
    expect(noConfig).toEqual({ ok: false, reason: 'not_configured' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('HTTP 401（cookie 过期）→ reason=unauthorized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ _tag: 'Unauthorized' }, 401))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('HTTP 404（workspace id 不属于该账号）→ reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ _tag: 'NotFound' }, 404))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('HTTP 500 → reason=network', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 500))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('fetch 网络异常 → reason=network', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('200 但无三窗口数据 → reason=no-subscription', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access: { meters: {} } }, 200))
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })
    expect(outcome).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('字段类型漂移 → reason=parse', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ access: { meters: { fiveHour: goMeter({ usedMicroCents: 'abc' }) } } }, 200),
    )
    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })
    expect(outcome).toEqual({ ok: false, reason: 'parse' })
  })

  it('成功：三窗口解析，请求 = 固定端点 + org id 进 x-org-id header（D1-4：URL 不含 id）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access: { meters: fullMeters } }, 200))

    const outcome = await opencodeFetcher.fetchQuota('session=abc', 'cookie', { quotaParams: { workspaceUrl: OPENCODE_WS_URL } })

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
})
