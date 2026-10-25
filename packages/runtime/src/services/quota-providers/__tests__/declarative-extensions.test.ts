/**
 * 声明式引擎传输层扩展 + stepfun 配置行为测试（2026-10 quota-params 泛化波次）。
 *
 * 覆盖（引擎新原语，全部经真实注册表 getQuotaFetcher 走 baseline 配置）：
 * - requests[].method/body：POST + 静态 body（stepfun 实测只接受 POST）
 * - headerFroms cookie 源：从粘贴 cookie 派生 per-user 头（oasis-webid）；缺失 = 不置头
 * - headerFroms params 源：用户维度参数注入 + failReason（opencode x-org-id 回归）
 * - 路径双形态（camelCase / snake_case 首命中）
 * - pct.via=fractionRemainingToUsed（0..1 剩余比例 → 已用%）
 * - resetSec.mode=epochSecOrMs（秒/毫秒量级消歧）
 * - bodyCode.success 数组 + protojson 枚举名（'CODE_OK' / 数值 1 双形态放行）
 * - 窗口映射：fiveHour ← fiveHourUsageLeftRate；week ← weeklyUsageLeftRate；
 *   month ← subscriptionCreditLeftRate + creditBuckets[type=SUBSCRIPTION] 绝对量
 *
 * 运行：cd packages/runtime && npx vitest run src/services/quota-providers/__tests__/declarative-extensions.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { getQuotaFetcher } from '../index.js'

const stepfunFetcher = getQuotaFetcher('stepfun')!
const opencodeFetcher = getQuotaFetcher('opencode-go')!

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** 固定时刻 2026-10-25T12:00:00Z（epoch 秒）——resetSec 断言可复现。 */
const NOW_SEC = 1792939200
const HOUR = 3600
const DAY = 86400

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setupFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

/** CODING/TOKEN_V3 家族成功响应（camelCase——前端 protobuf-es 客户端解构实证的 wire 形态）。 */
function rateLimitPayload(): string {
  return JSON.stringify({
    status: 'CODE_OK',
    desc: 'ok',
    fiveHourUsageLeftRate: 0.8,
    fiveHourUsageResetTime: String(NOW_SEC + HOUR),
    weeklyUsageLeftRate: 0.5,
    weeklyUsageResetTime: String(NOW_SEC + 6 * DAY),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_SEC * 1000)
})

describe('stepfun · 请求形态（POST + body + cookie 派生头）', () => {
  it('POST + body {} + cookie/oasis 头；oasis-webid 从粘贴 cookie 派生', async () => {
    const fetchMock = setupFetch(() => jsonResponse(JSON.parse(rateLimitPayload())))
    const out = await stepfunFetcher.fetchQuota('Oasis-Webid=webid-abc; Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBe('Oasis-Webid=webid-abc; Oasis-Token=tok')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['oasis-appid']).toBe('10300')
    expect(headers['oasis-platform']).toBe('web')
    expect(headers['oasis-webid']).toBe('webid-abc')
  })

  it('cookie 无 Oasis-Webid → 不置 oasis-webid 头（best-effort，其余头照发）', async () => {
    const fetchMock = setupFetch(() => jsonResponse(JSON.parse(rateLimitPayload())))
    await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect('oasis-webid' in headers).toBe(false)
    expect(headers['oasis-appid']).toBe('10300')
  })
})

describe('stepfun · 窗口映射', () => {
  it('fiveHour/week 槽：pct = (1 - leftRate) × 100；resetTime 秒级 epoch → resetSec', async () => {
    setupFetch(() => jsonResponse(JSON.parse(rateLimitPayload())))
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [fiveHour, week, month] = out.data.wins
    // leftRate 0.8 → 已用 20%；0.5 → 已用 50%；无 plan_family 字段时 5h/周放行、month 隐藏
    expect(fiveHour).toEqual({ pct: 20, resetSec: HOUR })
    expect(week).toEqual({ pct: 50, resetSec: 6 * DAY })
    expect(month).toEqual({ pct: null, resetSec: null })
    expect(out.data.label).toBe('StepFun Step Plan')
  })

  it('线上真实响应（2026-10-25 live 200 原文）：TOKEN 家族只展示 month 槽，绝对量=总量−剩余', async () => {
    // 探针原文（platform.stepfun.com QueryStepPlanRateLimit，用户 prod Chrome cookie 解密取得）：
    // snake_case + 数值枚举（plan_family:2 / type:1 / status:1）+ 秒级 epoch 字符串。
    // 该套餐 = Pro 档（credit_total 8e9），剩余 99.2%，月重置时间戳 1795069998。
    setupFetch(() =>
      jsonResponse({
        status: 1,
        desc: '',
        five_hour_usage_left_rate: 0,
        five_hour_usage_reset_time: '0',
        weekly_usage_left_rate: 0,
        weekly_usage_reset_time: '0',
        plan_family: 2,
        plan_credit_rate_limit: {
          subscription_credit_left_rate: 0.99216026,
          subscription_credit_reset_time: '1795069998',
          topup_credit_left_rate: 0,
          credit_buckets: [
            { type: 1, credit_total: '8000000000', credit_residual: '7937281865', expire_at: '1797661998', next_reset_at: '1795069998' },
          ],
        },
      }),
    )
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [fiveHour, week, month] = out.data.wins
    // TOKEN 家族（plan_family=2）：5h/周窗口按平台前端判据不展示（其 left_rate=0 非真实耗尽）
    expect(fiveHour).toEqual({ pct: null, resetSec: null })
    expect(week).toEqual({ pct: null, resetSec: null })
    // month 槽：pct = (1-0.99216026)*100 ≈ 0.78；used = 8e9 - 7937281865 = 62718135（残值是剩余非已用）
    expect(month.pct).toBe(0.78)
    expect(month.used).toBe(62718135)
    expect(month.limit).toBe(8000000000)
    expect(month.unit).toBe('credits')
    expect(month.resetSec).toBe(1795069998 - NOW_SEC)
  })

  it('CODING 家族（plan_family≠2）：5h/周窗口展示，month 槽隐藏（平台前端同判据）', async () => {
    setupFetch(() =>
      jsonResponse({
        status: 1,
        five_hour_usage_left_rate: 0.6,
        five_hour_usage_reset_time: String(NOW_SEC + HOUR),
        weekly_usage_left_rate: 0.9,
        weekly_usage_reset_time: String(NOW_SEC + 3 * DAY),
        plan_family: 1,
      }),
    )
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [fiveHour, week, month] = out.data.wins
    expect(fiveHour).toEqual({ pct: 40, resetSec: HOUR })
    expect(week).toEqual({ pct: 10, resetSec: 3 * DAY })
    expect(month).toEqual({ pct: null, resetSec: null })
  })

  it('resetTime 毫秒级 epoch → resetSec；过去时刻 → null', async () => {
    setupFetch(() =>
      jsonResponse({
        status: 'CODE_OK',
        fiveHourUsageLeftRate: 0.1,
        fiveHourUsageResetTime: (NOW_SEC + 2 * HOUR) * 1000,
        weeklyUsageLeftRate: 0.2,
        weeklyUsageResetTime: NOW_SEC - 60,
      }),
    )
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.wins[0]).toEqual({ pct: 90, resetSec: 2 * HOUR })
    expect(out.data.wins[1]).toEqual({ pct: 80, resetSec: null })
  })

  it('protojson 零值省略：leftRate=0（配额耗尽）字段缺席 → 该槽 INFINITE_WIN（隐藏，不产假 100%）', async () => {
    setupFetch(() =>
      jsonResponse({
        status: 'CODE_OK',
        weeklyUsageLeftRate: 0.4,
        weeklyUsageResetTime: String(NOW_SEC + 3 * DAY),
      }),
    )
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.wins[0]).toEqual({ pct: null, resetSec: null })
    expect(out.data.wins[1]).toEqual({ pct: 60, resetSec: 3 * DAY })
  })

  it('三槽全缺（无任何窗口字段）→ ok + 全 INFINITE_WIN（行隐藏）；刻意不用 requires：全部字段缺席的常见成因是配额耗尽被 protojson 零值省略，用 requires 会把它误判为无订阅', async () => {
    setupFetch(() => jsonResponse({ status: 'CODE_OK', desc: 'ok' }))
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.wins).toEqual([
      { pct: null, resetSec: null },
      { pct: null, resetSec: null },
      { pct: null, resetSec: null },
    ])
  })
})

describe('stepfun · 业务码与失败归口', () => {
  it('status 数值 1（protojson 枚举数值形态）放行', async () => {
    setupFetch(() => jsonResponse({ status: 1, fiveHourUsageLeftRate: 0.5 }))
    const out = await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.wins[0].pct).toBe(50)
  })

  it('缺 status（决策字段缺席）= 形态漂移 → parse', async () => {
    setupFetch(() => jsonResponse({ fiveHourUsageLeftRate: 0.5 }))
    expect(await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')).toEqual({ ok: false, reason: 'parse' })
  })

  it('CODE_PERMISSION_DENIED → unauthorized', async () => {
    setupFetch(() => jsonResponse({ status: 'CODE_PERMISSION_DENIED', desc: 'denied' }))
    expect(await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('CODE_STEP_PLAN_NOT_SUBSCRIBED → no-subscription', async () => {
    setupFetch(() => jsonResponse({ status: 'CODE_STEP_PLAN_NOT_SUBSCRIBED', desc: 'no plan' }))
    expect(await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')).toEqual({ ok: false, reason: 'no-subscription' })
  })

  it('HTTP 401 → unauthorized（cookie 失效）；网络异常 → network；非 JSON → parse', async () => {
    setupFetch(() => jsonResponse({ code: 'unauthenticated' }, 401))
    expect(await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')).toEqual({ ok: false, reason: 'unauthorized' })
    setupFetch(() => {
      throw new Error('boom')
    })
    expect(await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')).toEqual({ ok: false, reason: 'network' })
    setupFetch(() => new Response('<html>login</html>', { status: 200 }))
    expect(await stepfunFetcher.fetchQuota('Oasis-Token=tok', 'cookie')).toEqual({ ok: false, reason: 'parse' })
  })

  it('cookie 归一化后为空（粘贴伪影）→ cookie-invalid-format，不发请求', async () => {
    const fetchMock = setupFetch(() => {
      throw new Error('must not fetch')
    })
    expect(await stepfunFetcher.fetchQuota(' ; ', 'cookie')).toEqual({ ok: false, reason: 'cookie-invalid-format' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('opencode-go · headerFroms params 源回归（泛化后语义不变）', () => {
  const WS = 'https://opencode.ai/workspace/wrk_reg01/go'

  it('quotaParams.workspaceUrl 提取 wrk_ id 注入 x-org-id；URL 固定端点不含 id', async () => {
    const fetchMock = setupFetch(() => jsonResponse({
      access: { meters: { fiveHour: { usedMicroCents: 1, limitMicroCents: 10, resetsAt: new Date(NOW_SEC * 1000 + HOUR * 1000).toISOString() } } },
    }))
    const out = await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: WS } })
    expect(out.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://opencode.ai/console/api/go/status')
    expect((init.headers as Record<string, string>)['x-org-id']).toBe('wrk_reg01')
  })

  it('params 缺失 → not_configured 不发请求（failReason 语义保持）', async () => {
    const fetchMock = setupFetch(() => {
      throw new Error('must not fetch when param missing')
    })
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: {} })).toEqual({ ok: false, reason: 'not_configured' })
    expect(await opencodeFetcher.fetchQuota('session=1', 'cookie', { quotaParams: { workspaceUrl: 'https://opencode.ai/console' } })).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
