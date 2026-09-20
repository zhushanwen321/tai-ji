/**
 * DiffView 异步高亮守卫测试（RD-2#2 / code-harden RD-2）。
 *
 * 覆盖：
 * - 乱序守卫：patch 切换后，旧 patch 的迟到高亮结果不得写入新 diff 的渲染缓存
 *   （旧行为：行数相等即被 codeLines 采纳 → 新 patch 行号下显示旧文件正文）
 * - 高亮抛错显形降级：renderFailed 横幅出现 + 内容仍按原始行纯文本渲染
 *   （旧行为：watch async 回调无人 catch，静默丢高亮/炸渲染帧）
 *
 * highlightCode mock（区别化返回标记识别新旧结果）；parseDiff/extToLang 走真实纯函数。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/detail-renderers/__tests__/DiffView.seq-guard.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import DiffView from '@/components/panel/detail-renderers/DiffView.vue'

const mockHighlight = vi.hoisted(() => vi.fn())

vi.mock('@/composables/logic/markdown', () => ({
  highlightCode: mockHighlight,
}))

/** 最小 unified diff：1 hunk = hunk 头 + context + 未配对 add（未配对行才会走 shiki 高亮） */
function patchOf(contextLine: string, addLine: string): string {
  return `@@ -1,2 +1,3 @@\n ${contextLine}\n+${addLine}\n`
}

afterEach(() => {
  vi.restoreAllMocks()
  mockHighlight.mockReset()
  mockHighlight.mockImplementation(async (code: string) => `<b>${code}</b>`)
})

describe('DiffView — 异步高亮序号守卫（RD-2#2）', () => {
  it('patch 切换后旧循环迟到结果不写入（seq 守卫），新 patch 内容保持权威', async () => {
    let resolveOld!: (html: string) => void
    mockHighlight.mockImplementation((code: string) => {
      // 旧 patch 首行的高亮挂起（模拟慢 shiki 首调），其余立即返回
      if (code === 'const alpha = 1') {
        return new Promise<string>((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve(`<b>${code}</b>`)
    })
    const wrapper = mount(DiffView, {
      props: { patch: patchOf('const alpha = 1', 'const alpha2 = 2'), path: 'a.ts' },
    })
    await flushPromises()
    // 切到新 patch：新循环全部完成落位
    await wrapper.setProps({ patch: patchOf('const beta = 1', 'const beta2 = 2') })
    await flushPromises()
    expect(wrapper.text()).toContain('const beta = 1')
    // 旧 patch 首行此时才迟到完成 → 必须被序号守卫丢弃
    resolveOld('<b>STALE-ALPHA-CONTENT</b>')
    await flushPromises()
    await nextTick()
    expect(wrapper.html()).not.toContain('STALE-ALPHA-CONTENT')
    expect(wrapper.text()).toContain('const beta2 = 2')
    wrapper.unmount()
  })

  it('高亮抛错 → renderFailed 横幅显形 + 内容降级纯文本仍渲染（不静默、不炸渲染帧）', async () => {
    mockHighlight.mockRejectedValue(new Error('shiki down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(DiffView, {
      props: { patch: patchOf('const alpha = 1', 'const alpha2 = 2'), path: 'a.ts' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="diff-highlight-failed"]').exists()).toBe(true)
    // 降级分支：原始行内容仍以纯文本渲染（+/- 语义色分支不依赖高亮结果）
    expect(wrapper.text()).toContain('const alpha = 1')
    expect(wrapper.text()).toContain('const alpha2 = 2')
    expect(warnSpy).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('失败后新 patch 正常高亮：renderFailed 复位（错误态不跨 patch 残留）', async () => {
    mockHighlight.mockRejectedValueOnce(new Error('shiki down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(DiffView, {
      props: { patch: patchOf('const alpha = 1', 'const alpha2 = 2'), path: 'a.ts' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="diff-highlight-failed"]').exists()).toBe(true)
    await wrapper.setProps({ patch: patchOf('const beta = 1', 'const beta2 = 2') })
    await flushPromises()
    expect(wrapper.find('[data-testid="diff-highlight-failed"]').exists()).toBe(false)
    expect(wrapper.html()).toContain('<b>const beta = 1</b>')
    wrapper.unmount()
  })
})
