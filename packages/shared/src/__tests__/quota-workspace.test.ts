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
  it('仅资源维度 fetcher 声明 requiresWorkspace（opencode-go / opendesign），账号维度不声明', () => {
    const requiring = QUOTA_PRESETS.filter((p) => p.requiresWorkspace)
    expect(requiring.map((p) => p.fetcher)).toEqual(['opencode-go', 'opendesign'])
  })
})

describe('normalizeQuotaWorkspaceUrl · opendesign 分流', () => {
  const USAGE = (id: string) => `https://amr-api.open-design.ai/api/v1/workspaces/${id}/billing/coding-plan-usage`

  it('裸 workspace id（fetcherId=opendesign）→ 规范额度查询 URL', () => {
    expect(normalizeQuotaWorkspaceUrl('b8jtqydx4xmfogrkjokgonsp', 'opendesign')).toEqual({
      ok: true,
      url: USAGE('b8jtqydx4xmfogrkjokgonsp'),
    })
  })

  it('完整 API URL（fetcherId=opendesign）→ 收敛为规范 URL', () => {
    expect(normalizeQuotaWorkspaceUrl(USAGE('wsabc123'), 'opendesign')).toEqual({
      ok: true,
      url: USAGE('wsabc123'),
    })
  })

  it('不带 fetcherId 时同样的 id 输入走 opencode 规则 → error（分流生效证据）', () => {
    expect(normalizeQuotaWorkspaceUrl('b8jtqydx4xmfogrkjokgonsp').ok).toBe(false)
  })

  it('他域 URL（fetcherId=opendesign）→ error，文案点名 cookie 仅发往 amr-api.open-design.ai', () => {
    const r = normalizeQuotaWorkspaceUrl('https://evil.example.com/api/v1/workspaces/wsabc123/billing/coding-plan-usage', 'opendesign')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('amr-api.open-design.ai')
      expect(r.error).toContain('evil.example.com')
    }
  })

  it('域正确但路径无 workspace id（fetcherId=opendesign）→ error', () => {
    expect(normalizeQuotaWorkspaceUrl('https://amr-api.open-design.ai/other/page', 'opendesign').ok).toBe(false)
  })

  it('id 含非法字符（大写/连字符，fetcherId=opendesign）→ error', () => {
    expect(normalizeQuotaWorkspaceUrl('WS-abc123', 'opendesign').ok).toBe(false)
  })

  it('过短输入（fetcherId=opendesign）→ error（不满足 id 最短形态）', () => {
    expect(normalizeQuotaWorkspaceUrl('abc', 'opendesign').ok).toBe(false)
  })
})
