/**
 * ComposerInput 徽章 mousedown 防光标 + × 原生按钮 单测（demo 方案 C 行为修复 2/3 组件层验证）。
 *
 * 契约：
 * - mousedown target 落在徽章（.slash-chip / .mention-chip；image-chip 挂在 mention-chip 上
 *   被同一选择器覆盖）内 → preventDefault（浏览器不把光标放进徽章边界，徽章行为原子化）
 * - mousedown 落在纯文本区 → 不拦截（正常光标放置）
 * - × 删除路径不受影响：preventDefault 只阻止光标放置，click 事件照常派发——真实
 *   insertSlashChip 插入的 chip 对 .chip-x 先 mousedown 后 click，chip 被删除且 input
 *   emit（removeChipNode → onChanged → onInput 链路）触发
 * - × 是原生 button[type=button]（demo chipHtml 同款，键盘可达），不另设 role 属性
 *
 * mock 策略：happy-dom 下经 dispatchEvent 派发冒泡 MouseEvent（vue-test-utils 的 trigger
 * 只能在被 find 的元素上派发，无法把 e.target 指到 chip 子元素）。deps 经 ComposerInputDeps
 * provide 注入（W4 契约）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer/__tests__/composer-input-chip-mousedown.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import ComposerInput from '../ComposerInput.vue'
import { ComposerInputDepsKey } from '../composer-input-deps'
import type { ComposerInputDeps } from '../composer-input-deps'

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  // 清掉前一个用例残留的 selection range（指向已卸载节点会污染链路判定）
  window.getSelection()?.removeAllRanges()
})

function mountInput(): ReturnType<typeof mount> {
  return mount(ComposerInput, {
    global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
  })
}

/** 在指定元素上派发冒泡 mousedown，返回该事件（断言 defaultPrevented 用） */
function dispatchMousedown(target: Element): MouseEvent {
  const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('ComposerInput 徽章 mousedown 防光标（demo onEdMouseDown 同款）', () => {
  /** mount 后经 innerHTML 构造静态 chip（无事件监听——本组只测 mousedown 拦截，不测删除） */
  function mountWithChipHtml(html: string): { editor: HTMLDivElement } {
    const wrapper = mountInput()
    const editor = wrapper.find('[role="textbox"]').element as HTMLDivElement
    editor.innerHTML = html
    return { editor }
  }

  it('mousedown 落在 slash-chip 内（chip-label 子树）→ preventDefault（不落光标）', () => {
    const { editor } = mountWithChipHtml(
      '<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/commit</span></span>',
    )
    const chipLabel = editor.querySelector('.chip-label') as Element
    expect(dispatchMousedown(chipLabel).defaultPrevented).toBe(true)
  })

  it('mousedown 落在 mention-chip 本体 → preventDefault（image-chip 挂 mention-chip 同覆盖）', () => {
    const { editor } = mountWithChipHtml(
      '<span class="mention-chip mention-file image-chip" data-chip-type="image"><span class="chip-label">a.png</span></span>',
    )
    const chip = editor.querySelector('.image-chip') as Element
    expect(dispatchMousedown(chip).defaultPrevented).toBe(true)
  })

  it('mousedown 落在纯文本区（编辑器本体）→ 不拦截（正常光标放置）', () => {
    const { editor } = mountWithChipHtml('正文文本')
    expect(dispatchMousedown(editor).defaultPrevented).toBe(false)
  })
})

describe('ComposerInput × 删除路径与 mousedown 拦截共存（修复 2/3 联动）', () => {
  it('真实 insertSlashChip → × 为 button[type=button] 无 role → mousedown 被拦后 click 照常删除并 emit input', () => {
    const wrapper = mountInput()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string) => void }
    vm.insertSlashChip('/commit')

    const editor = wrapper.find('[role="textbox"]').element as HTMLDivElement
    const chip = editor.querySelector('.slash-chip') as HTMLElement
    expect(chip).not.toBeNull()
    const x = chip.querySelector('.chip-x') as HTMLElement
    // 修复 3：原生 button 键盘可达（type=button 防表单提交语义），原生语义自带故不设 role
    expect(x.tagName).toBe('BUTTON')
    expect((x as HTMLButtonElement).type).toBe('button')
    expect(x.getAttribute('role')).toBeNull()

    // 修复 2 与删除路径共存：mousedown 被 handler 拦截（不落光标），随后 click 照常派发——
    // 真实浏览器序列中 preventDefault 只阻止光标放置，删除监听（dom-core makeXButton）独立生效
    expect(dispatchMousedown(x).defaultPrevented).toBe(true)
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(editor.querySelector('.slash-chip')).toBeNull()
    // removeChipNode → onChanged → onInput → emit('input')：draft 同步链路未断
    expect(wrapper.emitted('input')).toBeTruthy()
  })
})
