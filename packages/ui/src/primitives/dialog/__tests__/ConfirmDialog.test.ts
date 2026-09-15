/**
 * ConfirmDialog 组件测试（W3 · review batch 1 · MF-4）。
 *
 * 覆盖关键未测逻辑：
 * 1. onCancel() 双 emit（cancel + update:open:false）—— 消费者只监听其一则语义丢失
 * 2. loading 态禁用取消+确认按钮（防重复提交，失效=双提交 bug）
 * 3. variant=danger 渲染 AlertTriangle icon（条件渲染）
 * 4. withDefaults（confirmText/cancelText/variant 默认值）
 *
 * 测试模式：reka Dialog 经 Portal teleport 到 document.body，mount attachTo body +
 * flushPromises 后用 document.body.querySelector 查询；点击用原生 HTMLElement.click()。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/dialog/__tests__/ConfirmDialog.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ConfirmDialog from '../ConfirmDialog.vue'

async function mountDialog(props: Record<string, unknown> = {}) {
  const wrapper = mount(ConfirmDialog, {
    props: { open: true, title: '确定删除？', ...props },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

/** body 内按钮（按文案定位） */
function findButton(text: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll('button'))
  const btn = buttons.find((b) => b.textContent?.trim() === text)
  if (!btn) throw new Error(`按钮未找到: "${text}"，现有: ${buttons.map((b) => b.textContent).join('|')}`)
  return btn
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ConfirmDialog', () => {
  it('withDefaults：未传文案/variant 时用默认值（取消/确认/danger）', async () => {
    await mountDialog({ title: 't' })
    expect(findButton('取消')).toBeTruthy()
    expect(findButton('确认')).toBeTruthy()
    // 默认 variant=danger → 标题区有 AlertTriangle svg（DialogTitle 渲染为 <h2>）
    expect(document.body.querySelector('h2 svg')).not.toBeNull()
  })

  it('自定义文案透传（confirmText/cancelText）', async () => {
    await mountDialog({ title: 't', confirmText: '删除', cancelText: '不了' })
    expect(findButton('删除')).toBeTruthy()
    expect(findButton('不了')).toBeTruthy()
  })

  it('variant=danger 渲染 AlertTriangle；variant=default 不渲染', async () => {
    await mountDialog({ title: 't', variant: 'danger' })
    // 内容经 Portal teleport 到 body；DialogTitle 渲染为 <h2>
    expect(document.body.querySelector('h2 svg')).not.toBeNull()
    document.body.innerHTML = ''

    await mountDialog({ title: 't', variant: 'default' })
    expect(document.body.querySelector('h2 svg')).toBeNull()
  })

  it('onCancel 双 emit：点取消先发 cancel 再发 update:open:false', async () => {
    const wrapper = await mountDialog({ title: 't' })
    findButton('取消').click()
    await flushPromises()
    const emitted = wrapper.emitted()
    expect(emitted['cancel']).toBeTruthy()
    expect(emitted['cancel'].length).toBe(1)
    expect(emitted['update:open']).toBeTruthy()
    const openEvents = emitted['update:open'] as unknown[][]
    // 最后一项 update:open 值为 false（关闭）
    expect(openEvents[openEvents.length - 1][0]).toBe(false)
  })

  it('点确认 emit confirm（不自动关闭——关闭由消费方按业务决定）', async () => {
    const wrapper = await mountDialog({ title: 't' })
    findButton('确认').click()
    await flushPromises()
    expect(wrapper.emitted('confirm')).toBeTruthy()
  })

  it('loading 态禁用取消+确认按钮（防重复提交）', async () => {
    await mountDialog({ title: 't', loading: true })
    expect(findButton('取消').disabled, '取消按钮应禁用').toBe(true)
    expect(findButton('确认').disabled, '确认按钮应禁用').toBe(true)
    // loading 时确认按钮渲染 Loader2 spinner svg
    const confirmBtn = findButton('确认')
    expect(confirmBtn.querySelector('svg.animate-spin')).not.toBeNull()
  })

  it('非 loading 态按钮可点击（对照）', async () => {
    await mountDialog({ title: 't', loading: false })
    expect(findButton('取消').disabled).toBe(false)
    expect(findButton('确认').disabled).toBe(false)
  })

  it('description 传入时渲染；不传时不渲染描述节点', async () => {
    await mountDialog({ title: 't', description: '此操作不可撤销' })
    expect(document.body.textContent).toContain('此操作不可撤销')
    document.body.innerHTML = ''

    await mountDialog({ title: 't' })
    expect(document.body.textContent).not.toContain('此操作不可撤销')
  })
})
