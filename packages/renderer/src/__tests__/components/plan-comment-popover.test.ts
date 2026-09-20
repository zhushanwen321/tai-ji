/**
 * PlanCommentPopover 组件单测 —— plan 模式重设计 u1-docs-panel（划选评论浮条，设计
 * §3.1 步骤 5 / D6 / G3；revising 禁用 = §3.1 失败路径）。
 *
 * 覆盖（impl-plan u1-docs-panel 验收条款「划选评论」）：
 * - target 容器内划选文字（mouseup）→ 浮条出现（quote 捕获 + demo 钳制定位）
 * - 浮条「评论」→ 编辑态（引文展示 + 评语输入）→ 添加 → emit submit { quote, comment }
 * - 空评语不提交不关闭（demo save 语义）
 * - 取消 → 关闭不 emit
 * - revising 态（disabled）→ 浮条出现但「评论」按钮禁用 + title 提示
 * - 选区不在 target 容器内 / 无效选区 → 浮条不出现（面板外划选不误触）
 * - 浮条态外部 mousedown → 关闭；编辑态外部 mousedown 不关（防误触丢评语）
 *
 * jsdom selection 限制：window.getSelection 功能有限，照 detail-selection-bubble.test.ts
 * 先例 mock getSelection（fakeRange + toString），anchorNode 指向 target 容器内元素。
 * 断言通道：组件浮层经 Teleport 渲染到 body（脱离组件根子树），wrapper.find 搜不到——
 * 统一走 document.querySelector + DOMWrapper（Teleport 断言的标准形态）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-comment-popover.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

import PlanCommentPopover from '@/components/panel/plan/PlanCommentPopover.vue'

const TARGET_HTML = '<p>token 在过期前自动刷新，业务零感知</p>'

/** 浮层查询（Teleport to body → document 通道） */
function q(selector: string): DOMWrapper<Element> | null {
  const el = document.querySelector(selector)
  return el ? new DOMWrapper(el) : null
}

/** 构造 target 容器 + mock 划选（anchorNode 指向容器内段落，quote 为划选文本） */
function mockSelection(target: HTMLElement, text: string): void {
  const para = target.querySelector('p')!
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: para,
    anchorOffset: 0,
    focusNode: para,
    focusOffset: text.length,
    toString: () => text,
    removeAllRanges: vi.fn(),
    getRangeAt: () => ({
      startContainer: para,
      endContainer: para,
      commonAncestorContainer: para,
      getBoundingClientRect: () => ({ left: 100, top: 200, width: 120, height: 20 }),
    }),
  } as unknown as Selection)
}

function mountPopover(props: Partial<{ target: HTMLElement | null; disabled: boolean }> = {}): {
  wrapper: VueWrapper
  target: HTMLElement
} {
  const target = document.createElement('div')
  target.innerHTML = TARGET_HTML
  document.body.appendChild(target)
  const wrapper = mount(PlanCommentPopover, {
    props: { target, disabled: false, ...props },
    attachTo: document.body,
  })
  return { wrapper, target }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('PlanCommentPopover 划选捕获', () => {
  it('target 内划选文字 → mouseup 弹浮条（quote 捕获，定位样式钳制在视口内）', async () => {
    const { wrapper, target } = mountPopover()
    mockSelection(target, 'token 在过期前自动刷新')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()

    const pop = q('[data-testid="plan-comment-popover"]')
    expect(pop).not.toBeNull()
    const style = pop!.attributes('style')
    expect(style).toContain('left:')
    expect(style).toContain('top:')
    expect(q('[data-testid="plan-comment-trigger"]')!.text()).toContain('评论')
    wrapper.unmount()
  })

  it('选区锚点不在 target 内 → 浮条不出现（面板外划选不误触）', async () => {
    const { wrapper } = mountPopover()
    const outside = document.createElement('div')
    outside.innerHTML = '<p>外面的话</p>'
    document.body.appendChild(outside)
    // anchorNode 指向 target 外元素（contains 判定失败路径）
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: outside.querySelector('p'),
      toString: () => '外面的话',
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
      }),
    } as unknown as Selection)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(q('[data-testid="plan-comment-popover"]')).toBeNull()
    wrapper.unmount()
  })

  it('无效选区（collapsed）→ 浮条不出现', async () => {
    const { wrapper } = mountPopover()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(q('[data-testid="plan-comment-popover"]')).toBeNull()
    wrapper.unmount()
  })
})

/** 划选 → 打开编辑态的公共前缀（断言打开过程不误发 submit） */
async function openEditor(wrapper: VueWrapper, target: HTMLElement, quote: string): Promise<void> {
  mockSelection(target, quote)
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await nextTick()
  await q('[data-testid="plan-comment-trigger"]')!.trigger('click')
  await nextTick()
  expect(wrapper.findComponent(PlanCommentPopover).emitted('submit')).toBeUndefined()
}

describe('PlanCommentPopover 编辑与提交（quote 捕获 → 草稿 payload）', () => {
  it('点「评论」→ 编辑态：引文展示 + 评语输入 + 取消/添加', async () => {
    const { wrapper, target } = mountPopover()
    await openEditor(wrapper, target, 'token 在过期前自动刷新')

    expect(q('[data-testid="plan-comment-editor"]')).not.toBeNull()
    expect(q('[data-testid="plan-comment-quote"]')!.text()).toContain('token 在过期前自动刷新')
    expect(q('[data-testid="plan-comment-input"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('输入评语点「添加评论」→ emit submit { quote, comment }，浮层关闭', async () => {
    const { wrapper, target } = mountPopover()
    await openEditor(wrapper, target, 'quote-selected')

    await q('[data-testid="plan-comment-input"]')!.setValue('双 token 方案的攻击面没说清')
    await q('[data-testid="plan-comment-save"]')!.trigger('click')
    await nextTick()

    const emitted = wrapper.findComponent(PlanCommentPopover).emitted('submit')
    expect(emitted).toHaveLength(1)
    expect(emitted![0]![0]).toEqual({ quote: 'quote-selected', comment: '双 token 方案的攻击面没说清' })
    expect(q('[data-testid="plan-comment-popover"]')).toBeNull()
    wrapper.unmount()
  })

  it('空评语点添加 → 不 emit、浮层不关（demo save 语义）', async () => {
    const { wrapper, target } = mountPopover()
    await openEditor(wrapper, target, 'quote-keep')

    await q('[data-testid="plan-comment-input"]')!.setValue('   ')
    await q('[data-testid="plan-comment-save"]')!.trigger('click')
    await nextTick()

    expect(wrapper.findComponent(PlanCommentPopover).emitted('submit')).toBeUndefined()
    expect(q('[data-testid="plan-comment-editor"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('取消 → 关闭且不 emit', async () => {
    const { wrapper, target } = mountPopover()
    await openEditor(wrapper, target, 'quote-cancel')

    await q('[data-testid="plan-comment-cancel"]')!.trigger('click')
    await nextTick()

    expect(wrapper.findComponent(PlanCommentPopover).emitted('submit')).toBeUndefined()
    expect(q('[data-testid="plan-comment-popover"]')).toBeNull()
    wrapper.unmount()
  })
})

describe('PlanCommentPopover revising 禁用（设计 §3.1 失败路径）', () => {
  it('disabled=true → 浮条出现、「评论」按钮禁用、title 提示修订中', async () => {
    const { wrapper, target } = mountPopover({ disabled: true })
    mockSelection(target, 'quote-revising')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()

    const trigger = q('[data-testid="plan-comment-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger!.attributes('disabled')).toBeDefined()
    expect(trigger!.attributes('title')).toContain('修订中')
    // 禁用按钮点击不进编辑态（原生 button disabled 吞 click）
    await trigger!.trigger('click')
    expect(q('[data-testid="plan-comment-editor"]')).toBeNull()
    wrapper.unmount()
  })
})

describe('PlanCommentPopover 关闭时机', () => {
  it('浮条态外部 mousedown → 关闭', async () => {
    const { wrapper, target } = mountPopover()
    mockSelection(target, 'quote-close')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(q('[data-testid="plan-comment-popover"]')).not.toBeNull()

    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(q('[data-testid="plan-comment-popover"]')).toBeNull()
    wrapper.unmount()
  })

  it('编辑态外部 mousedown 不关（浮层化适配：防误触丢评语）', async () => {
    const { wrapper, target } = mountPopover()
    await openEditor(wrapper, target, 'quote-editing')
    expect(q('[data-testid="plan-comment-editor"]')).not.toBeNull()

    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(q('[data-testid="plan-comment-editor"]')).not.toBeNull()
    wrapper.unmount()
  })
})
