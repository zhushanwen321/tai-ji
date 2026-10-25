/**
 * Sheet 原语测试（remote-use-mobile-v2 §6.9 / spec §6.3）。
 *
 * 覆盖：底部面板结构（拖拽区/标题/说明/滚动体/底栏）、reka Dialog 开合态挂载、
 * 拖拽关闭阈值（>96px 或快扫 >24px@>0.6px/ms 关闭；小位移回弹不关闭）、
 * 无底栏时滚动体自带安全区（--last 修饰类）。
 *
 * 测试模式：reka Dialog 经 Portal teleport 到 document.body（ConfirmDialog.test.ts
 * 同款），attachTo body + flushPromises 后 document.body.querySelector 查询；
 * 拖拽用 PointerEvent 序列驱动（happy-dom 支持 PointerEvent + setPointerCapture）。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/sheet.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Sheet from '../sheet/Sheet.vue'

async function mountSheet(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  const wrapper = mount(Sheet, {
    props: { open: true, title: '切换模型', ...props },
    slots,
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

function contentEl(): HTMLElement {
  const el = document.body.querySelector('[data-testid="sheet-content"]')
  if (!el) throw new Error('sheet-content 未挂载（Portal 内容缺失）')
  return el as HTMLElement
}

/**
 * 拖拽序列驱动：时钟全控（happy-dom 的 PointerEvent 构造函数自身消费一次
 * performance.now() 做 timeStamp，故用 mockImplementation + 可变时钟——
 * 事件构造与 handler 共享同一时钟源，速度 = dy/durationMs 确定性成立）。
 * now() 调用序：down 构造 → down handler(startAt) → move 构造 → up 构造 → up handler(elapsed)。
 */
function dragGrip(dy: number, durationMs: number): void {
  const grip = document.body.querySelector('[data-testid="sheet-grip"]') as HTMLElement
  let clock = 1000
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  grip.dispatchEvent(new PointerEvent('pointerdown', { clientY: 0, pointerId: 1, bubbles: true }))
  grip.dispatchEvent(new PointerEvent('pointermove', { clientY: dy, pointerId: 1, bubbles: true }))
  clock = 1000 + durationMs
  grip.dispatchEvent(new PointerEvent('pointerup', { clientY: dy, pointerId: 1, bubbles: true }))
  nowSpy.mockRestore()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Sheet（spec §6.3 底部浮层）', () => {
  it('open：面板经 Portal 挂 body，结构 = 拖拽区 + 标题 + 滚动体；顶部圆角类在', async () => {
    await mountSheet()
    expect(contentEl()).toBeTruthy()
    expect(document.body.querySelector('[data-testid="sheet-title"]')?.textContent).toBe('切换模型')
    expect(document.body.querySelector('[data-testid="sheet-grip"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="sheet-body"]')).toBeTruthy()
  })

  it('description：说明行渲染；缺省不渲染', async () => {
    await mountSheet({ description: '只影响本会话下一条消息' })
    expect(document.body.querySelector('[data-testid="sheet-description"]')?.textContent).toBe('只影响本会话下一条消息')
    document.body.innerHTML = ''
    await mountSheet()
    expect(document.body.querySelector('[data-testid="sheet-description"]')).toBeNull()
  })

  it('底栏插槽：footer 渲染且滚动体无底栏时吃安全区 padding（safe-area 档类切换）', async () => {
    await mountSheet({}, { default: '<p>内容</p>', footer: '<button type="button">完成</button>' })
    expect(document.body.querySelector('[data-testid="sheet-footer"]')?.textContent).toBe('完成')
    expect(document.body.querySelector('[data-testid="sheet-body"]')?.className).not.toContain('safe-area-inset-bottom')
    document.body.innerHTML = ''
    await mountSheet()
    expect(document.body.querySelector('[data-testid="sheet-body"]')?.className).toContain('safe-area-inset-bottom')
  })

  it('拖拽关闭三分支（spec 阈值：>96px 或速度 >0.6px/ms；松手回弹）', async () => {
    // 位移分支：120px @ 慢速（速度 0.12px/ms 不达）→ 仅凭 >96px 关闭
    const byDistance = await mountSheet()
    dragGrip(120, 1000)
    await flushPromises()
    expect(byDistance.emitted('update:open')).toBeTruthy()
    document.body.innerHTML = ''

    // 速度分支：48px @ 40ms（1.2px/ms > 0.6，位移 ≤96 距离分支不中）→ 快扫关闭
    const flick = await mountSheet()
    dragGrip(48, 40)
    await flushPromises()
    expect(flick.emitted('update:open')).toBeTruthy()
    document.body.innerHTML = ''

    // 回弹分支：48px @ 200ms（0.24px/ms ≤ 0.6 且 ≤96px）→ 不关闭
    const rebound = await mountSheet()
    dragGrip(48, 200)
    await flushPromises()
    expect(rebound.emitted('update:open')).toBeFalsy()
  })

  it('hideTitle：可见标题隐藏（sr-only），aria-label 兜底读屏', async () => {
    await mountSheet({ hideTitle: true })
    const title = document.body.querySelector('[data-testid="sheet-title"]') as HTMLElement
    expect(title.className).toContain('sr-only')
    expect(contentEl().getAttribute('aria-label')).toBe('切换模型')
  })

  it('open=false：面板不挂载', async () => {
    await mountSheet({ open: false })
    expect(document.body.querySelector('[data-testid="sheet-content"]')).toBeNull()
  })
})
