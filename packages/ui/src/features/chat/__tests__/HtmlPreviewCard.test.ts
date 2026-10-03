/**
 * HtmlPreviewCard 组件测试（chat-html-support §6.3 D3 / §6.5? 卡片面；u4-card）。
 *
 * 覆盖三组语义：
 * - 预检三原因降级（not_found / is_dir / out_of_whitelist）+ 路径非法（空 / 多行）+
 *   路径无法解析：降级文案可见、按钮禁用
 * - 路径解析矩阵（与 MarkdownRenderer ④路同传值矩阵）：resourceBaseDir 覆盖优先 →
 *   sessionCwdOf 兜底 → 皆缺降级；servable 时按钮点击 → openDrawer('detail', 绝对路径)
 * - deps.probeArtifact 未 provide → 跳过预检且不挂死（中性态、按钮可点、不显示大小）；
 *   预检 pending 期间显中性加载态（无墙钟超时，never-resolving promise 不阻塞用例）
 *
 * t() 走 ui 全局 setup 的 mock（返回 key）——断言用 key 字面量（真文案由 locale 双侧承载）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/HtmlPreviewCard.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import HtmlPreviewCard from '../HtmlPreviewCard.vue'
import { mockChatProvide } from './helpers'
import type { ChatViewDeps } from '@taiji/ui'

/** flush 异步链（watch immediate → runProbe → await probe → 状态写回） */
async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

function mountCard(props: Record<string, unknown>, overrides: Partial<ChatViewDeps> = {}): VueWrapper {
  return mount(HtmlPreviewCard, {
    props: props as never,
    global: { provide: mockChatProvide(overrides) },
  })
}

const metaOf = (w: VueWrapper): string => w.find('[data-testid="html-preview-meta"]').text()
const nameOf = (w: VueWrapper): string => w.find('[data-testid="html-preview-name"]').text()
const openBtn = (w: VueWrapper) => w.find('[data-testid="html-preview-open"]')

describe('预检降级三原因（servable=false → 带原因、按钮禁用）', () => {
  it.each([
    ['not_found', 'panel.htmlPreview.notFound'],
    ['is_dir', 'panel.htmlPreview.isDir'],
    ['out_of_whitelist', 'panel.htmlPreview.outOfWhitelist'],
  ] as const)('reason=%s → 降级文案 + 按钮禁用', async (reason, key) => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: false, reason })
    const wrapper = mountCard({ path: '/abs/report.html' }, { probeArtifact })
    await flush()
    expect(metaOf(wrapper)).toBe(key)
    expect(nameOf(wrapper)).toBe('report.html')
    expect(openBtn(wrapper).attributes('disabled')).toBeDefined()
  })

  it('servable=true（带 size）→ 文件名 + HTML 预览 · 大小，按钮可点', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true, size: 2355 })
    const openDrawer = vi.fn()
    const wrapper = mountCard({ path: '/abs/report.html' }, { probeArtifact, openDrawer })
    await flush()
    expect(probeArtifact).toHaveBeenCalledWith('/abs/report.html')
    expect(nameOf(wrapper)).toBe('report.html')
    expect(metaOf(wrapper)).toContain('panel.htmlPreview.kind')
    expect(metaOf(wrapper)).toContain('2.3 KB')
    expect(openBtn(wrapper).attributes('disabled')).toBeUndefined()
    await openBtn(wrapper).trigger('click')
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/abs/report.html' })
  })

  it('servable=true 无 size → 仅 HTML 预览（不显示大小），按钮可点', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    const wrapper = mountCard({ path: '/abs/report.html' }, { probeArtifact })
    await flush()
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.kind')
    expect(openBtn(wrapper).attributes('disabled')).toBeUndefined()
  })
})

describe('路径非法（fence 内容 trim 后为空或含换行）', () => {
  it('空内容 → 「路径非法」+ 按钮禁用，且不调预检', async () => {
    const probeArtifact = vi.fn()
    const wrapper = mountCard({ path: '\n  \n' }, { probeArtifact })
    await flush()
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.invalidPath')
    expect(openBtn(wrapper).attributes('disabled')).toBeDefined()
    expect(probeArtifact).not.toHaveBeenCalled()
  })

  it('多行内容 → 「路径非法」+ 按钮禁用', async () => {
    const wrapper = mountCard({ path: '/a.html\n/b.html' })
    await flush()
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.invalidPath')
    expect(openBtn(wrapper).attributes('disabled')).toBeDefined()
  })
})

describe('路径解析矩阵（resourceBaseDir 覆盖优先 / sessionCwdOf 兜底 / 皆缺降级）', () => {
  it('绝对路径 → 直用（不查基准）', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    const sessionCwdOf = vi.fn(() => '/cwd')
    mountCard({ path: '/abs/x.html' }, { probeArtifact, sessionCwdOf })
    await flush()
    expect(probeArtifact).toHaveBeenCalledWith('/abs/x.html')
    expect(sessionCwdOf).not.toHaveBeenCalled()
  })

  it('相对路径 + resourceBaseDir 与 sessionCwdOf 皆在 → resourceBaseDir 优先', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    const sessionCwdOf = vi.fn(() => '/cwd')
    mountCard(
      { path: 'sub/x.html', resourceBaseDir: '/base', sessionId: 's1' },
      { probeArtifact, sessionCwdOf },
    )
    await flush()
    expect(probeArtifact).toHaveBeenCalledWith('/base/sub/x.html')
  })

  it('相对路径 + 无 resourceBaseDir → sessionCwdOf 兜底', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    const sessionCwdOf = vi.fn(() => '/cwd')
    const wrapper = mountCard({ path: 'sub/x.html', sessionId: 's1' }, { probeArtifact, sessionCwdOf })
    await flush()
    expect(probeArtifact).toHaveBeenCalledWith('/cwd/sub/x.html')
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.kind')
  })

  it('相对路径 + 基准与 session 语境皆缺 → 「无法解析路径」+ 按钮禁用（不静默猜基准）', async () => {
    const sessionCwdOf = vi.fn(() => undefined)
    const wrapper = mountCard({ path: 'sub/x.html' }, { sessionCwdOf })
    await flush()
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.unresolvedPath')
    expect(openBtn(wrapper).attributes('disabled')).toBeDefined()
  })
})

describe('预检通道缺失 / pending（不挂死）', () => {
  it('deps.probeArtifact 未 provide → 跳过预检（中性态、无大小、按钮可点，不挂起）', async () => {
    const wrapper = mountCard({ path: '/abs/report.html' })
    await flush()
    // 不在 pending（无墙钟超时也不会停留），中性态可操作
    expect(metaOf(wrapper)).not.toBe('panel.htmlPreview.checking')
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.kind')
    expect(openBtn(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('预检 pending（never-resolving）→ 中性加载态 + 按钮禁用（无墙钟超时，用例不阻塞）', async () => {
    const probeArtifact = vi.fn(() => new Promise<{ servable: boolean }>(() => {}))
    const wrapper = mountCard({ path: '/abs/report.html' }, { probeArtifact })
    await flush()
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.checking')
    expect(openBtn(wrapper).attributes('disabled')).toBeDefined()
    // 无墙钟超时：不等待定时器，直接结束用例
  })

  it('预检通道 reject（IPC 不可用）→ 退回中性态（按钮可点，失败面归抽屉兜底）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const probeArtifact = vi.fn().mockRejectedValue(new Error('localFileServable unavailable'))
      const wrapper = mountCard({ path: '/abs/report.html' }, { probeArtifact })
      await flush()
      expect(metaOf(wrapper)).toBe('panel.htmlPreview.kind')
      expect(openBtn(wrapper).attributes('disabled')).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})
