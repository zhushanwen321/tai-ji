/**
 * opencode fetcher 行为测试（timeout-audit-hygiene-batch D1-1/D1-3/D1-4）。
 *
 * 覆盖：
 * - D1-3：未配置 workspace → not_configured，且**不发任何 HTTP 请求**（不发数不查他人数据）
 * - D1-1：配置注入的 workspaceUrl 原样作为请求目标（QuotaService 负责归一化）
 * - D1-4：硬编码 URL 清零——请求 URL 只能来自 config 注入
 * - 既有语义回归：302 → unauthorized；SSR HTML 三窗口解析成功路径；网络异常 → network
 *
 * 运行：cd packages/runtime && npx vitest run src/services/quota-providers/__tests__/opencode.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { opencodeFetcher } from '../opencode.js'

const WORKSPACE_URL = 'https://opencode.ai/workspace/wrk_user_own_id/go'

/** SSR HTML fixture：三窗口数据嵌入（与 extractWindow 正则形态一致）。 */
function ssrHtml(): string {
  const win = (name: string, pct: number, reset: number) =>
    `${name}:$R[1]={status:"active",usagePercent:${pct},resetInSec:${reset}}`
  return `<html><script>${win('rollingUsage', 42, 3600)};${win('weeklyUsage', 10, 86400)};${win('monthlyUsage', 5, 0)}</script></html>`
}

function setupFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opencodeFetcher · workspace 配置注入（D1-1/D1-3）', () => {
  it('未传 config → not_configured，且不发任何 HTTP 请求（D1-3：不发数不查他人数据）', async () => {
    const fetchMock = setupFetch(() => {
      throw new Error('must not fetch when workspace is not configured')
    })
    const out = await opencodeFetcher.fetchQuota('cookie=1', 'cookie')
    expect(out).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('config.workspaceUrl 为空串/undefined → not_configured 不发请求', async () => {
    const fetchMock = setupFetch(() => new Response('<html>'))
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', {})).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: '' })).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('已配置 workspace → 以注入的 workspaceUrl 发请求（D1-4：URL 只来自 config）', async () => {
    const fetchMock = setupFetch(() => new Response(ssrHtml(), { status: 200 }))
    const out = await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })

    expect(out.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      WORKSPACE_URL,
      expect.objectContaining({ redirect: 'manual' }),
    )
  })
})

describe('opencodeFetcher · 既有语义回归', () => {
  it('无凭证 → unauthorized（不依赖 workspace 判定顺序，凭证检查在前）', async () => {
    const out = await opencodeFetcher.fetchQuota('', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(out).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('302 → unauthorized（cookie 过期，V1-4 可区分失败）', async () => {
    setupFetch(() => new Response(null, { status: 302 }))
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
  })

  it('404/500 → network', async () => {
    setupFetch(() => new Response('gone', { status: 404 }))
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })).toEqual({
      ok: false,
      reason: 'network',
    })
  })

  it('已删除的 workspace（302 到登录页同判）与有效页可区分（V1-4）', async () => {
    // 失效 workspace：服务器 302 → unauthorized（指引检查 cookie/workspace 地址）
    setupFetch(() => new Response(null, { status: 302 }))
    const invalid = await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(invalid).toEqual({ ok: false, reason: 'unauthorized' })

    // 有效 workspace：200 + 三窗口数据 → 成功
    setupFetch(() => new Response(ssrHtml(), { status: 200 }))
    const ok = await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(ok.ok).toBe(true)
  })

  it('SSR HTML 三窗口全缺 → no-subscription（部分缺失容忍，全缺才失败）', async () => {
    setupFetch(() => new Response('<html>no data</html>', { status: 200 }))
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })).toEqual({
      ok: false,
      reason: 'no-subscription',
    })
  })

  it('部分窗口缺失（上游字段漂移）→ 缺失窗口 INFINITE_WIN 降级，不整体失败', async () => {
    setupFetch(() => {
      const win = (name: string, pct: number, reset: number) =>
        `${name}:$R[1]={status:"active",usagePercent:${pct},resetInSec:${reset}}`
      return new Response(`<html><script>${win('rollingUsage', 42, 3600)}</script></html>`, { status: 200 })
    })
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })).toEqual({
      ok: true,
      data: {
        label: 'opencode.go',
        wins: [
          { pct: 42, resetSec: 3600 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
  })

  it('fetch 抛异常（网络/超时）→ network', async () => {
    setupFetch(() => {
      throw new Error('fetch failed')
    })
    expect(await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })).toEqual({
      ok: false,
      reason: 'network',
    })
  })

  it('成功路径：三窗口 pct/resetSec 组装', async () => {
    setupFetch(() => new Response(ssrHtml(), { status: 200 }))
    const out = await opencodeFetcher.fetchQuota('cookie=1', 'cookie', { workspaceUrl: WORKSPACE_URL })
    expect(out).toEqual({
      ok: true,
      data: {
        label: 'opencode.go',
        wins: [
          { pct: 42, resetSec: 3600 },
          { pct: 10, resetSec: 86400 },
          { pct: 5, resetSec: null },
        ],
      },
    })
  })
})
