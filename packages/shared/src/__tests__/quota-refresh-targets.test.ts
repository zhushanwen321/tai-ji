/**
 * quota 刷新目标注册表单测（cookie 类 provider 登录态刷新导航信息 SSOT）。
 *
 * 守护 main 隐藏窗口刷新器与 renderer 续期目标解析共读的注册表契约：
 * - getQuotaRefreshTarget：在册返回配置，未知 fetcher 返回 undefined（IPC 层按此拒绝）
 * - 在册条目形状不变式：pageUrl/apiUrl 可达形态 + loginUrlPatterns 非空（登录页
 *   检测与导航白名单的共同输入，空表 = 登录态失效永不判定）
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-refresh-targets.test.ts
 */
import { describe, it, expect } from 'vitest'
import { QUOTA_REFRESH_TARGETS, getQuotaRefreshTarget } from '../quota-refresh-targets.js'

describe('getQuotaRefreshTarget', () => {
  it('在册 fetcher → 返回注册表条目（与 QUOTA_REFRESH_TARGETS 同一对象）', () => {
    expect(getQuotaRefreshTarget('mimo')).toBe(QUOTA_REFRESH_TARGETS['mimo'])
    expect(getQuotaRefreshTarget('mimo')?.pageUrl).toContain('platform.xiaomimimo.com')
  })

  it('不在册（api-key 类 / 未知 id）→ undefined，调用方按输入校验拒绝', () => {
    expect(getQuotaRefreshTarget('zhipu-api-key')).toBeUndefined()
    expect(getQuotaRefreshTarget('')).toBeUndefined()
  })
})

describe('QUOTA_REFRESH_TARGETS 注册表不变式', () => {
  const entries = Object.entries(QUOTA_REFRESH_TARGETS)

  it('cookie 类在册集合稳定：mimo / opencode-go / stepfun 三条', () => {
    expect(Object.keys(QUOTA_REFRESH_TARGETS).sort()).toEqual(['mimo', 'opencode-go', 'stepfun'])
  })

  it('每条 pageUrl/apiUrl 均为 https 绝对 URL 且同域（同源页面上下文内 fetch）', () => {
    for (const [id, t] of entries) {
      expect(new URL(t.pageUrl).protocol, id).toBe('https:')
      expect(new URL(t.apiUrl).protocol, id).toBe('https:')
      expect(new URL(t.apiUrl).host, id).toBe(new URL(t.pageUrl).host)
    }
  })

  it('每条 loginUrlPatterns 非空（登录页检测与导航白名单的共同输入）', () => {
    for (const [id, t] of entries) {
      expect(t.loginUrlPatterns.length, id).toBeGreaterThan(0)
    }
  })

  it('POST 形态条目（stepfun connect RPC）带 apiMethod+apiBody；GET 形态不带', () => {
    expect(QUOTA_REFRESH_TARGETS['stepfun']?.apiMethod).toBe('POST')
    expect(QUOTA_REFRESH_TARGETS['stepfun']?.apiBody).toBe('{}')
    expect(QUOTA_REFRESH_TARGETS['mimo']?.apiMethod).toBeUndefined()
    expect(QUOTA_REFRESH_TARGETS['opencode-go']?.apiMethod).toBeUndefined()
  })
})
