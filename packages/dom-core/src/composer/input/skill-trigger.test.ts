/**
 * skill 触发检测单测（多 skill 注入 u4，设计 D1/D2 + 验收场景 6）。
 *
 * 覆盖：
 * - detectSkillTriggerFromEl 正则语义：非换行空白（半角空格/tab/全角空格 U+3000/NBSP）后
 *   `/` 触发；行首与换行后行首不触发（让位命令浮层，两触发域互斥）
 * - query 合法性过滤（D5 误弹缓解）：`/usr` 输到第二个 `/` 即 null（场景 6①）、大写/
 *   下划线/超长非法即 null、空 query（刚敲 `/`）合法
 * - contenteditable 分路编排：与命令触发互斥派发、chip 抑制解除（限 skill 浮层）、
 *   bash 短路、clearSkillQueryText（boundaryLen 模式，边界空白保留）
 * - 命令通道回归：行首 `/` 与 `#`/`$`/`@` 检测行为不变（场景 6②③ 的检测层锁定）
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/skill-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import {
  detectSkillTriggerFromEl,
  detectSlashTriggerFromEl,
  detectHashTriggerFromEl,
  detectFileDollarTriggerFromEl,
  detectSubagentTriggerFromEl,
} from './input-dom'
import { useContenteditableInput } from './contenteditable'
import type { ContenteditableCallbacks } from './types'

/** mock callbacks 工厂（onSkillTrigger 默认注入——本文件全部用例都在接线后形态下跑） */
function makeCallbacks(overrides: Partial<ContenteditableCallbacks> = {}): ContenteditableCallbacks {
  return {
    onInput: vi.fn(),
    onSlashTrigger: vi.fn(),
    onFileTrigger: vi.fn(),
    onEnterKeydown: vi.fn(),
    onKeydown: vi.fn(),
    handleBackspaceOnChip: vi.fn(() => false),
    insertImageBadge: vi.fn(),
    getSessionId: vi.fn(() => 's1'),
    pasteImage: vi.fn(),
    onSkillTrigger: vi.fn(),
    ...overrides,
  }
}

/** setup：创建 el 挂 body + elRef + composable（同 contenteditable.test.ts 形态） */
function setup(initialHtml = '', overrides: Partial<ContenteditableCallbacks> = {}) {
  if (typeof document.execCommand !== 'function') {
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    })
  }
  const el = document.createElement('div')
  el.innerHTML = initialHtml
  document.body.appendChild(el)
  const elRef = ref(el)
  const callbacks = makeCallbacks(overrides)
  const api = useContenteditableInput(elRef, callbacks)
  return { el, elRef, callbacks, ...api, cleanup: () => document.body.removeChild(el) }
}

/** 把光标 collapse 到指定文本节点的 offset 处 */
function cursorAt(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('detectSkillTriggerFromEl 触发域（D1：非换行空白后 /）', () => {
  let cleanup: () => void = () => {}
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('半角空格后 /：帮我 review /rev → {query:"rev"}', () => {
    const el = document.createElement('div')
    el.textContent = '帮我 review /rev'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 14)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: 'rev' })
    el.remove()
  })

  it('tab 后 /：code\t/rev → 触发（[^\S\n] 覆盖 tab）', () => {
    const el = document.createElement('div')
    el.textContent = 'code\t/rev'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 9)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: 'rev' })
    el.remove()
  })

  it('场景 6④：全角空格 U+3000 后 / 触发（中文输入法空白语义对齐 # 符号）', () => {
    const el = document.createElement('div')
    el.textContent = '看看\u3000/rev'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 7)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: 'rev' })
    el.remove()
  })

  it('场景 6④：NBSP U+00A0 后 / 触发（\\s 空白语义）', () => {
    const el = document.createElement('div')
    el.textContent = '看看\u00A0/rev'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 7)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: 'rev' })
    el.remove()
  })

  it('场景 6② 互斥：行首 / 不触发 skill（让位命令浮层）', () => {
    const el = document.createElement('div')
    el.textContent = '/rev'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 4)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'rev' })
    el.remove()
  })

  it('互斥：换行后新行行首 / 不触发 skill（命令域）', () => {
    const el = document.createElement('div')
    el.innerHTML = 'line1<br>/rev'
    document.body.appendChild(el)
    cursorAt(el.childNodes[2] as Text, 4)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'rev' })
    el.remove()
  })

  it('互斥：文字中间 /（a/b）不触发 skill 也不触发命令', () => {
    const el = document.createElement('div')
    el.textContent = 'a/b'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 3)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    expect(detectSlashTriggerFromEl(el)).toBeNull()
    el.remove()
  })

  it('无光标（无选区）→ null（skill 无程序化兜底，安全侧关闭）', () => {
    const el = document.createElement('div')
    el.textContent = '看看 /rev'
    document.body.appendChild(el)
    window.getSelection()?.removeAllRanges()
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    el.remove()
  })
})

describe('detectSkillTriggerFromEl query 合法性过滤（D5 误弹缓解）', () => {
  let cleanup: () => void = () => {}
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('场景 6①：/usr 输到第二个 / 即 null（query 含 / 非法，立即关闭）', () => {
    const el = document.createElement('div')
    el.textContent = '帮我看看 /usr/'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 10)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    el.remove()
  })

  it('第二个 / 之前（/usr）仍触发（短暂弹出符合设计：输入即收）', () => {
    const el = document.createElement('div')
    el.textContent = '帮我看看 /usr'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 9)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: 'usr' })
    el.remove()
  })

  it('query 含大写 → null', () => {
    const el = document.createElement('div')
    el.textContent = 'see /Usr'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 8)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    el.remove()
  })

  it('query 含下划线 → null', () => {
    const el = document.createElement('div')
    el.textContent = 'see /my_skill'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 13)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    el.remove()
  })

  it('query 65 字符 → null；64 字符 → 触发（pi MAX_NAME_LENGTH 上界）', () => {
    const long64 = 'a'.repeat(64)
    const el = document.createElement('div')
    el.textContent = `see /${long64}`
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 5 + 64)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: long64 })
    el.textContent = `see /${'a'.repeat(65)}`
    cursorAt(el.firstChild as Text, 5 + 65)
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    el.remove()
  })

  it('空 query（刚敲完 /）合法 → {query:""}', () => {
    const el = document.createElement('div')
    el.textContent = 'see /'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 5)
    expect(detectSkillTriggerFromEl(el)).toEqual({ query: '' })
    el.remove()
  })
})

describe('useContenteditableInput skill 分路编排（D1/D2）', () => {
  let cleanup: () => void = () => {}
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('onInput 派发 skill 触发：互斥（空格后 / 只亮 skill 路）', () => {
    const c = setup('帮我 review /rev')
    cursorAt(c.el.firstChild as Text, 14)
    c.onInput()
    expect(c.callbacks.onSkillTrigger).toHaveBeenCalledWith({ query: 'rev' })
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('onInput 派发 skill 触发：行首 / 只亮命令路（skill 收 null）', () => {
    const c = setup('/commit')
    cursorAt(c.el.firstChild as Text, 7)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'commit' })
    expect(c.callbacks.onSkillTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('D2 chip 抑制解除：存在 slash-chip 时 skill 仍触发（命令路保持抑制）', () => {
    const c = setup('<span class="slash-chip"><span class="chip-label">/commit</span></span> /rev')
    // 光标在 chip 后文本节点「 /rev」末尾（前置空格命中触发域；slash-chip 无 ZWSP 时同理）
    cursorAt(c.el.childNodes[1] as Text, 5)
    c.onInput()
    expect(c.callbacks.onSkillTrigger).toHaveBeenCalledWith({ query: 'rev' })
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('bash 豁免短路：suppress=true 时 skill 路收 null（不检测）', () => {
    const c = setup('看看 /rev', {
      shouldSuppressTriggers: () => true,
    })
    cursorAt(c.el.firstChild as Text, 7)
    c.onInput()
    expect(c.callbacks.onSkillTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onInput).toHaveBeenCalledWith('看看 /rev')
    cleanup = c.cleanup
  })

  it('clearSkillQueryText：只删「空格+/query」段，边界空格保留（boundaryLen 模式）', () => {
    const c = setup('see /rev')
    cursorAt(c.el.firstChild as Text, 8)
    c.clearSkillQueryText()
    expect(c.getText()).toBe('see ')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('see ')
    cleanup = c.cleanup
  })

  it('clearSkillQueryText：无光标/不匹配时不动作、不 emitInput', () => {
    const c = setup('see /rev')
    window.getSelection()?.removeAllRanges()
    c.clearSkillQueryText()
    expect(c.getText()).toBe('see /rev')
    expect(c.callbacks.onInput).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })
})

describe('四符号检测回归（场景 6②③ 检测层锁定，行为不变）', () => {
  let cleanup: () => void = () => {}
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('行首 / 命令检测不变（空格后 / 不触发命令）', () => {
    const el = document.createElement('div')
    el.textContent = '帮我看看 /usr'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 9)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
    el.textContent = '/commit'
    cursorAt(el.firstChild as Text, 7)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'commit' })
    el.remove()
  })

  it('# / $ / @ 检测不变（空格后照常触发，不skill化）', () => {
    const el = document.createElement('div')
    el.textContent = 'see #job'
    document.body.appendChild(el)
    cursorAt(el.firstChild as Text, 8)
    expect(detectHashTriggerFromEl(el)).toEqual({ query: 'job' })
    expect(detectSkillTriggerFromEl(el)).toBeNull()
    el.textContent = 'echo $HOME'
    cursorAt(el.firstChild as Text, 10)
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'HOME' })
    el.textContent = 'hey @build'
    cursorAt(el.firstChild as Text, 10)
    expect(detectSubagentTriggerFromEl(el)).toEqual({ query: 'build' })
    el.remove()
  })
})
