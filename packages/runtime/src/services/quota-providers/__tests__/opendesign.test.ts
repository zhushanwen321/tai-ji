/**
 * opendesign fetcher 行为测试。
 *
 * 覆盖（对齐 opencode.test.ts 的资源维度范式）：
 * - 未配置 workspace → not_configured，且不发任何 HTTP 请求
 * - 配置注入的 workspaceUrl 原样作为请求目标（QuotaService 负责归一化，fetcher 不再改写）
 * - 成功路径：5h/7d 窗口按 durationSeconds 映射到 wins 槽位（month 槽恒 INFINITE_WIN）
 * - credits 字符串数值下发（实测 wire 形态）→ numericField 归一
 * - 非法窗口项丢弃（不整单拒绝）；两窗口全缺 → no-subscription
 * - 401 → unauthorized；网络异常 → network
 *
 * 运行：cd packages/runtime && npx vitest run src/services/quota-providers/__tests__/opendesign.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { opendesignFetcher } from '../opendesign.js'

const WORKSPACE_URL =
  'https://amr-api.open-design.ai/api/v1/workspaces/userownws01/billing/coding-plan-usage'

/** 成功响应 fixture：credits 以字符串数值下发（2026-10-18 实测 wire 形态）。 */
function usagePayload(): string {
  return JSON.stringify({
    workspaceId: 'userownws01',
    generatedAt: '2026-10-18T10:10:43.432Z',
    eligible: true,
    tier: 'go',
    windows: [
      {
        policyId: 'policy_5h',
        durationSeconds: 18000,
        resetMode: 'anchored_recurring',
        usedCredits: '1402',
        limitCredits: '50000',
        remainingCredits: '48598',
        windowStart: '2026-10-18T08:59:02.000Z',
        resetsAt: '2026-10-18T13:59:02.000Z',
      },
      {
        policyId: 'policy_week',
        durationSeconds: 604800,
        resetMode: 'anchored_recurring',
        usedCredits: '1402',
        limitCredits: '150000',
        remainingCredits: '148598',
        resetsAt: '2026-10-25T08:59:02.000Z',
      },
    ],
  })
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function setupFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  // resetsAt → resetSec 换算锚定固定时刻，断言可复现
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opendesignFetcher · workspace 配置注入', () => {
  it('未传 config / workspaceUrl 为空 → not_configured，且不发任何 HTTP 请求', async () => {
    const fetchMock = setupFetch(() => {
      throw new Error('must not fetch when workspace is not configured')
    })
    expect(await opendesignFetcher.fetchQuota('k=v', 'cookie')).toEqual({ ok: false, reason: 'not_configured' })
    expect(await opendesignFetcher.fetchQuota('k=v', 'cookie', {})).toEqual({ ok: false, reason: 'not_configured' })
    expect(await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: '' })).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('以注入的 workspaceUrl 发请求，携带 cookie 与 accept json', async () => {
    const fetchMock = setupFetch(() => jsonResponse(usagePayload()))
    const out = await opendesignFetcher.fetchQuota('a=1; b=2', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(out.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(WORKSPACE_URL)
    expect((init.headers as Record<string, string>).cookie).toBe('a=1; b=2')
    expect((init.headers as Record<string, string>).accept).toBe('application/json')
  })
})

describe('opendesignFetcher · 窗口映射', () => {
  it('5h → wins[0]，7d → wins[1]，month 槽恒 INFINITE_WIN；credits 字符串数值归一', async () => {
    setupFetch(() => jsonResponse(usagePayload()))
    const out = await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [fiveHour, week, month] = out.data.wins
    // pct = 1402/50000 = 2.804；resetSec = 13:59:02Z - 12:00:00Z = 7142
    expect(fiveHour).toEqual({ pct: 2.804, used: 1402, limit: 50000, unit: 'credits', resetSec: 7142 })
    // pct = 1402/150000 ≈ 0.93466…；resetSec = 2026-10-25T08:59:02Z - 2026-10-18T12:00:00Z
    expect(week?.pct).toBeCloseTo(1402 / 150000 * 100, 6)
    expect(week?.resetSec).toBe(6 * 86400 + 20 * 3600 + 59 * 60 + 2)
    expect(month).toEqual({ pct: null, resetSec: null })
    expect(out.data.label).toBe('OpenDesign Coding Plan')
  })

  it('仅 5h 窗口 → 7d/month 槽 INFINITE_WIN（部分缺失容忍）', async () => {
    setupFetch(() =>
      jsonResponse(
        JSON.stringify({
          windows: [{ durationSeconds: 18000, usedCredits: 1, limitCredits: 10, remainingCredits: 9 }],
        }),
      ),
    )
    const out = await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.wins[0].pct).toBe(10)
    expect(out.data.wins[1]).toEqual({ pct: null, resetSec: null })
    expect(out.data.wins[2]).toEqual({ pct: null, resetSec: null })
  })

  it('非法窗口项（缺 durationSeconds/credits）被丢弃，不整单拒绝', async () => {
    setupFetch(() =>
      jsonResponse(
        JSON.stringify({
          windows: [
            { durationSeconds: 'abc', usedCredits: 1, limitCredits: 10 },
            { durationSeconds: 18000, usedCredits: 1, limitCredits: 10, remainingCredits: 9 },
          ],
        }),
      ),
    )
    const out = await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.wins[0].pct).toBe(10)
    expect(out.data.wins[1]).toEqual({ pct: null, resetSec: null })
  })

  it('windows 非法形态 / 两窗口全缺 → parse / no-subscription', async () => {
    setupFetch(() => jsonResponse(JSON.stringify({ eligible: true })))
    expect(
      await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL }),
    ).toEqual({ ok: false, reason: 'parse' })

    setupFetch(() => jsonResponse(JSON.stringify({ eligible: false, windows: [] })))
    expect(
      await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL }),
    ).toEqual({ ok: false, reason: 'no-subscription' })
  })
})

describe('opendesignFetcher · 失败归类', () => {
  it('空 cookie → unauthorized（不发请求）', async () => {
    const fetchMock = setupFetch(() => jsonResponse('{}'))
    expect(await opendesignFetcher.fetchQuota('   ', 'cookie', { workspaceUrl: WORKSPACE_URL })).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401 → unauthorized；500 → network；响应非 JSON → parse', async () => {
    setupFetch(() => jsonResponse('{"error":"unauthenticated"}', 401))
    expect(
      await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL }),
    ).toEqual({ ok: false, reason: 'unauthorized' })

    setupFetch(() => jsonResponse('boom', 500))
    expect(
      await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL }),
    ).toEqual({ ok: false, reason: 'network' })

    setupFetch(() => new Response('<html>not json</html>', { status: 200 }))
    expect(
      await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL }),
    ).toEqual({ ok: false, reason: 'parse' })
  })

  it('fetch 抛异常（网络故障/超时）→ network', async () => {
    setupFetch(() => {
      throw new Error('connection reset')
    })
    expect(
      await opendesignFetcher.fetchQuota('k=v', 'cookie', { workspaceUrl: WORKSPACE_URL }),
    ).toEqual({ ok: false, reason: 'network' })
  })
})
