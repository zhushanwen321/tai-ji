// FormSheet dialog 四型作答组件级单测（remote-use-mobile-v2 §6.5 四型映射；验收条款 1）。
//
// 锁定（form 通道链路集成断言在 mobile-form.spec；本文件组件级补 dialog 分发面）：
// - confirm：确认回传 true / 取消上抛 cancel（App 编排转 respond null——回传 null 的
//   协议落点同源验证见 mobile-form.spec「取消 → respond null」用例，两通道同一编排函数）
// - select：未选确认禁用；选中回传 value 字符串
// - input：单行文本回传字符串
// - editor：多行 Textarea + prefill 预填 + 等宽字体（v1 CompanionBand editor 实装形态）
// - 未知 method：只读降级（ERR3——不白屏、无作答钮）
// - submitSuspended（§6.23）：作答钮全禁 + description 提示在场
//
// 呈现查询 = Sheet portal 到 body（sheet.test.ts 同款）；回传断言走 emitted 事件
// （App 编排路由两通道的集成面在 mobile-form.spec / mobile-companion-band.spec）。
import { describe, expect, it, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FormSheet from '../FormSheet.vue'
import { i18n } from '../../i18n'
import type { DialogRequest } from '@taiji/ui/extension-host'

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function expectBodyEl(testid: string): HTMLElement {
  const el = bodyEl(testid)
  if (!el) throw new Error(`[data-testid="${testid}"] 未挂载（Sheet portal 内容缺失）`)
  return el
}

function dialogReq(overrides: Partial<DialogRequest>): DialogRequest {
  return {
    source: 'pi',
    sessionId: 'sid-fs',
    requestId: 'req-fs-1',
    method: 'confirm',
    message: '确认执行？',
    receivedAt: 0,
    ...overrides,
  }
}

function mountSheet(props: Record<string, unknown>) {
  return mount(FormSheet, {
    global: { plugins: [i18n] },
    props: { open: true, dialog: dialogReq({}), ...props },
    attachTo: document.body,
  })
}

function click(testid: string): void {
  ;(expectBodyEl(testid) as HTMLElement).click()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FormSheet dialog 四型（§6.5 泛化承接）', () => {
  it('confirm：确认回传 true；取消上抛 cancel（App 编排转 respond null，协议断言同源 mobile-form.spec）', async () => {
    const wrapper = mountSheet({})
    await flushPromises()
    click('form-sheet-dialog-ok')
    await flushPromises()
    expect(wrapper.emitted('submit')).toEqual([[{ requestId: 'req-fs-1', result: true }]])

    click('form-sheet-dialog-cancel')
    await flushPromises()
    expect(wrapper.emitted('cancel')).toEqual([[{ requestId: 'req-fs-1', source: 'dialog' }]])
    wrapper.unmount()
  })

  it('select：未选确认禁用；选中回传 value 字符串（clarify Q3 流式形态）', async () => {
    const wrapper = mountSheet({
      dialog: dialogReq({
        method: 'select',
        message: undefined,
        options: [
          { label: '方案 A', value: 'a', description: '描述 A' },
          { label: '方案 B', value: 'b' },
        ],
      }),
    })
    await flushPromises()
    expect((expectBodyEl('form-sheet-dialog-ok') as HTMLButtonElement).disabled).toBe(true)

    ;(expectBodyEl('form-sheet-dialog-option-a') as HTMLElement).click()
    await flushPromises()
    expect((expectBodyEl('form-sheet-dialog-ok') as HTMLButtonElement).disabled).toBe(false)
    click('form-sheet-dialog-ok')
    await flushPromises()
    expect(wrapper.emitted('submit')).toEqual([[{ requestId: 'req-fs-1', result: 'a' }]])
    wrapper.unmount()
  })

  it('input：单行文本回传字符串', async () => {
    const wrapper = mountSheet({ dialog: dialogReq({ method: 'input', message: undefined, default: '' }) })
    await flushPromises()
    const input = expectBodyEl('form-sheet-dialog-input') as HTMLInputElement
    input.value = '我的回答'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    click('form-sheet-dialog-ok')
    await flushPromises()
    expect(wrapper.emitted('submit')).toEqual([[{ requestId: 'req-fs-1', result: '我的回答' }]])
    wrapper.unmount()
  })

  it('editor：多行 Textarea + prefill 预填 + 等宽字体（v1 editor 实装形态对账）', async () => {
    const wrapper = mountSheet({
      dialog: dialogReq({ method: 'editor', message: undefined, prefill: '预填的多行\n草稿' }),
    })
    await flushPromises()
    const editor = expectBodyEl('form-sheet-dialog-editor') as HTMLTextAreaElement
    // 多行 Textarea + 等宽（font-mono 类，v1 CompanionBand 同款）
    expect(editor.tagName).toBe('TEXTAREA')
    expect(editor.className).toContain('font-mono')
    // prefill 预填（v1 语义：default ?? prefill）
    expect(editor.value).toBe('预填的多行\n草稿')

    editor.value = '改后的内容'
    editor.dispatchEvent(new Event('input'))
    await flushPromises()
    click('form-sheet-dialog-ok')
    await flushPromises()
    expect(wrapper.emitted('submit')).toEqual([[{ requestId: 'req-fs-1', result: '改后的内容' }]])
    wrapper.unmount()
  })

  it('未知 method：只读降级（ERR3）——method 原文展示、无作答/取消钮', async () => {
    const wrapper = mountSheet({ dialog: dialogReq({ method: 'wizard' as never }) })
    await flushPromises()
    expect(bodyEl('form-sheet-dialog-unknown')?.textContent).toBe('wizard')
    expect(bodyEl('form-sheet-dialog-ok')).toBeNull()
    expect(bodyEl('form-sheet-dialog-cancel')).toBeNull()
    expect(wrapper.emitted('submit')).toBeUndefined()
    wrapper.unmount()
  })

  it('submitSuspended（§6.23）：作答/取消钮全禁 + description 提示在场（对账完成前不可作答）', async () => {
    const wrapper = mountSheet({ submitSuspended: true })
    await flushPromises()
    expect((expectBodyEl('form-sheet-dialog-ok') as HTMLButtonElement).disabled).toBe(true)
    expect((expectBodyEl('form-sheet-dialog-cancel') as HTMLButtonElement).disabled).toBe(true)
    const hint = bodyEl('sheet-description')?.textContent ?? ''
    expect(hint.length).toBeGreaterThan(0)
    expect(hint.includes('对账') || hint.toLowerCase().includes('reconcil')).toBe(true)
    // 禁用下点击不产生作答事件（假成功窗口封堵的用户可见面）
    click('form-sheet-dialog-ok')
    await flushPromises()
    expect(wrapper.emitted('submit')).toBeUndefined()
    wrapper.unmount()
  })

  it('allowCancel=false：取消钮隐藏（协议显式收窄，v1 band 同语义）', async () => {
    const wrapper = mountSheet({ dialog: dialogReq({ allowCancel: false }) })
    await flushPromises()
    expect(bodyEl('form-sheet-dialog-cancel')).toBeNull()
    wrapper.unmount()
  })
})
