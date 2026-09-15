/**
 * normalizeQuotaWorkspaceUrl 单测（P1-1，timeout-audit-hygiene-batch D1-1）。
 *
 * 覆盖：完整 URL 与裸 wrk_ id 两形态归一化、尾路径收敛、非法输入（非 URL /
 * 非 opencode.ai 域 / 路径无 wrk_ id / 空输入）报错文案可操作。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-workspace.test.ts
 */
import { describe, it, expect } from 'vitest'
import { normalizeQuotaWorkspaceUrl } from '../quota-types'
import { QUOTA_PRESETS } from '../quota-presets'

describe('normalizeQuotaWorkspaceUrl · 两形态归一化（P1-1）', () => {
  it('裸 wrk_ id → 规范额度页 URL', () => {
    expect(normalizeQuotaWorkspaceUrl('wrk_userowned01')).toEqual({
      ok: true,
      url: 'https://opencode.ai/workspace/wrk_userowned01/go',
    })
  })

  it('完整 /go 额度页 URL → 规范 URL（原样收敛）', () => {
    expect(normalizeQuotaWorkspaceUrl('https://opencode.ai/workspace/wrk_abc123/go')).toEqual({
      ok: true,
      url: 'https://opencode.ai/workspace/wrk_abc123/go',
    })
  })

  it('完整 URL 尾路径差异（/usage 等其他页）→ 收敛为 /go 额度页', () => {
    const r = normalizeQuotaWorkspaceUrl('https://opencode.ai/workspace/wrk_abc123/usage')
    expect(r).toEqual({ ok: true, url: 'https://opencode.ai/workspace/wrk_abc123/go' })
  })

  it('完整 URL 无尾路径（以 id 结尾）→ 收敛为 /go 额度页', () => {
    expect(normalizeQuotaWorkspaceUrl('https://opencode.ai/workspace/wrk_abc123')).toEqual({
      ok: true,
      url: 'https://opencode.ai/workspace/wrk_abc123/go',
    })
  })

  it('输入含首尾空白 → trim 后归一化', () => {
    expect(normalizeQuotaWorkspaceUrl('  wrk_x9\n')).toEqual({
      ok: true,
      url: 'https://opencode.ai/workspace/wrk_x9/go',
    })
  })
})

describe('normalizeQuotaWorkspaceUrl · 非法输入报错（P1-1）', () => {
  it('空串 / 纯空白 → error', () => {
    expect(normalizeQuotaWorkspaceUrl('').ok).toBe(false)
    expect(normalizeQuotaWorkspaceUrl('   ').ok).toBe(false)
  })

  it('非 URL 非-id 文本 → error（文案含期望形态示例）', () => {
    const r = normalizeQuotaWorkspaceUrl('hello world')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('wrk_')
  })

  it('http 协议的 opencode URL → 归一化为 https 规范 URL（升级不降级）', () => {
    const r = normalizeQuotaWorkspaceUrl('http://opencode.ai/workspace/wrk_abc/go')
    expect(r).toEqual({ ok: true, url: 'https://opencode.ai/workspace/wrk_abc/go' })
  })

  it('他域 URL（钓鱼域）→ error，文案点名 cookie 仅发往 opencode.ai', () => {
    const r = normalizeQuotaWorkspaceUrl('https://evil.example.com/workspace/wrk_abc/go')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('opencode.ai')
      expect(r.error).toContain('evil.example.com')
    }
  })

  it('opencode.ai 域但路径无 wrk_ id → error', () => {
    const r = normalizeQuotaWorkspaceUrl('https://opencode.ai/other/page')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('wrk_')
  })

  it('路径中 id 形态非法（非 wrk_ 前缀）→ error', () => {
    expect(normalizeQuotaWorkspaceUrl('https://opencode.ai/workspace/abc123/go').ok).toBe(false)
  })
})

describe('QUOTA_PRESETS · requiresWorkspace 标记（D1-1）', () => {
  it('仅 opencode-go 声明 requiresWorkspace，其余账号维度 preset 不声明', () => {
    const requiring = QUOTA_PRESETS.filter((p) => p.requiresWorkspace)
    expect(requiring.map((p) => p.fetcher)).toEqual(['opencode-go'])
  })
})
