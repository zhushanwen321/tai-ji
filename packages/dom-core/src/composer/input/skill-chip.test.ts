/**
 * insertSkillChip / 多 skill chip 解析单测（多 skill 注入 u4，设计 D2 补充断言）。
 *
 * 覆盖：
 * - insertSkillChip：光标处插入（insertChipAtSelection 通用机制）、dataset 完整
 *   （chipType=skill / chipName / 可选 chipLocation）、× 删除、Backspace 整块删除
 * - 多个共存（不清已存在 chip，与 insertSlashChip「唯一/替换语义」命令 chip 通道区分）
 * - D2 混排解析锁定：getSegmentsFromEl 对多个 skill chip 与正文混排解析正确（既有能力补断言）
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/skill-chip.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerChipCommands } from './chip-commands'
import { getSegmentsFromEl } from './input-dom'
import type { ChipCallbacks } from './types'

/** mock ChipCallbacks 工厂（同 chip-commands.test.ts 形态） */
function makeCallbacks(overrides: Partial<ChipCallbacks> = {}): ChipCallbacks {
  return {
    onChanged: vi.fn(),
    restoreSelection: vi.fn(),
    renderIcon: vi.fn(() => true),
    t: vi.fn((key: string) => key),
    ...overrides,
  }
}

/** setup：创建 el 挂 body + elRef + composable */
function setup(initialHtml = '', overrides: Partial<ChipCallbacks> = {}) {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = initialHtml
  document.body.appendChild(el)
  const elRef = ref(el)
  const callbacks = makeCallbacks(overrides)
  const api = useComposerChipCommands(elRef, callbacks)
  return { el, elRef, callbacks, ...api, cleanup: () => document.body.removeChild(el) }
}

/** 把光标定位到指定节点的 offset 处（collapsed） */
function setCursor(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('useComposerChipCommands insertSkillChip（D2：光标处、多个共存）', () => {
  let cleanup: () => void = () => {}
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
    cleanup = () => {}
  })
  afterEach(() => {
    cleanup?.()
  })

  it('光标处插入：chip 落在光标位置（非最前），前后正文保留', () => {
    const c = setup('AB')
    setCursor(c.el.firstChild as Text, 1) // A|B 之间
    c.insertSkillChip('code-review')
    // DOM 顺序：'A' + chip + ZWSP spacer + 'B'（无选区 appendChild 分支未走）
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(c.el.childNodes[0].textContent).toBe('A')
    expect(c.el.childNodes[1]).toBe(chip)
    expect(c.el.childNodes[3].textContent).toBe('B')
    // segments：正文-chip-正文交错，光标在 spacer 后
    expect(getSegmentsFromEl(c.el)).toEqual([
      { type: 'text', text: 'A' },
      { type: 'skill', name: 'code-review' },
      { type: 'text', text: 'B' },
    ])
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('dataset 完整：chipType=skill + chipName + label=裸名 + 可选 chipLocation', () => {
    const c = setup()
    c.insertSkillChip('code-review', '/skills/code-review/SKILL.md', 'star')
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(chip.dataset.chipType).toBe('skill')
    expect(chip.dataset.chipName).toBe('code-review')
    expect(chip.dataset.chipLocation).toBe('/skills/code-review/SKILL.md')
    expect(chip.contentEditable).toBe('false')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('code-review')
    expect(chip.querySelector('.chip-icon')).not.toBeNull()
    // C5 tooltip：经 callbacks.t 注入（key 直传形态，壳层换 vue-i18n t 后出真文案）
    expect(chip.title).toBe('composable.skillChipTitle')
    cleanup = c.cleanup
  })

  it('无 location：segment 不带 location 字段（runtime 经 get_commands 权威映射解析）', () => {
    const c = setup()
    c.insertSkillChip('code-simplify')
    expect(getSegmentsFromEl(c.el)).toEqual([{ type: 'skill', name: 'code-simplify' }])
    cleanup = c.cleanup
  })

  it('D2 多共存：重复插入不清除已有 skill chip', () => {
    const c = setup()
    c.insertSkillChip('code-review')
    c.insertSkillChip('code-simplify')
    const chips = c.el.querySelectorAll('.slash-chip')
    expect(chips.length).toBe(2)
    expect(getSegmentsFromEl(c.el)).toEqual([
      { type: 'skill', name: 'code-review' },
      { type: 'skill', name: 'code-simplify' },
    ])
    cleanup = c.cleanup
  })

  it('与行首命令 slash-chip 共存：insertSkillChip 不清除命令 chip（通道正交）', () => {
    const c = setup()
    c.insertSlashChip('/commit')
    c.insertSkillChip('code-review')
    expect(c.el.querySelectorAll('.slash-chip').length).toBe(2)
    const segments = getSegmentsFromEl(c.el)
    // D4-b：命令 chip（chipType=slash）产 slash segment，skill chip 产 skill segment
    expect(segments).toEqual([
      { type: 'slash', name: 'commit' },
      { type: 'skill', name: 'code-review' },
    ])
    cleanup = c.cleanup
  })

  it('D2 × 删除：点 chip-x 移除 chip 与相邻 spacer，onChanged 同步', () => {
    const c = setup('正文 ')
    c.insertSkillChip('code-review')
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    ;(chip.querySelector('.chip-x') as HTMLElement).click()
    expect(c.el.querySelector('.slash-chip')).toBeNull()
    expect(getSegmentsFromEl(c.el)).toEqual([{ type: 'text', text: '正文 ' }])
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('D2 Backspace 整块删除：光标在 chip 后 spacer 末尾时一次删整块', () => {
    const c = setup('正文 ')
    c.insertSkillChip('code-review')
    // 显式把光标放进 chip 后 ZWSP spacer 文本节点末尾（同既有 chip-commands 测试的
    // 「spacer 末尾」形态；insertChipAtSelection 落位的元素级光标走浏览器默认删除路径）
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    const spacer = chip.nextSibling as Text
    setCursor(spacer, 1)
    expect(c.handleBackspaceOnChip()).toBe(true)
    expect(c.el.querySelector('.slash-chip')).toBeNull()
    expect(getSegmentsFromEl(c.el)).toEqual([{ type: 'text', text: '正文 ' }])
    cleanup = c.cleanup
  })
})

describe('D2 混排解析锁定：getSegmentsFromEl 多 skill chip 与正文混排（既有能力补断言）', () => {
  it('正文 + 两个 skill chip + 正文：segments 交错且顺序保持', () => {
    const el = document.createElement('div')
    // 手工构造（模拟 insertSkillChip × 2 + 正文混排后的 DOM；ZWSP 为 spacer，解析时被过滤）
    el.innerHTML =
      '帮我 review <span class="slash-chip" data-chip-type="skill" data-chip-name="code-review"></span>' +
      '\u200B 中段 <span class="slash-chip" data-chip-type="skill" data-chip-name="code-simplify" data-chip-location="/s/code-simplify/SKILL.md"></span>' +
      '\u200B 这段代码'
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'text', text: '帮我 review ' },
      { type: 'skill', name: 'code-review' },
      { type: 'text', text: ' 中段 ' },
      { type: 'skill', name: 'code-simplify', location: '/s/code-simplify/SKILL.md' },
      { type: 'text', text: ' 这段代码' },
    ])
  })
})
