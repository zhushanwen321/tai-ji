/**
 * onInput 单次全文遍历复用测试 —— 性能 A 档（同帧无 DOM 写，syncEmpty 判空与 emitInput
 * 消费同一 getText 快照）。
 *
 * 背景：改造前每次击键 onInput 内 syncEmpty() 与 getText() 各做一次 getSegmentsFromEl
 * 全树递归解析（短草稿微秒级，长草稿 2×O(节点数) 可感知）。改造后 onInput 单次 getText，
 * 同一 text 同时供 isEmpty 判定与 emitInput（syncEmpty 参数化，无参形态不变）。
 *
 * 覆盖：
 * - 计数锁：slash-chip 场景（hasChip 门使 detectSlashTrigger 提前返回，不进 getText 兜底；
 *   其余触发检测走 matchTriggerBeforeCursor 不经过 getSegmentsFromEl）onInput 一次
 *   → getSegmentsFromEl 恰好 1 次（改造前 2 次）
 * - 行为等价：emitInput 的 text 与 getText() 恒等、isEmpty 判定与 text 互相一致
 *   （多行 + 空内容两形态）
 * - syncEmpty 传参形态：传参不触发 DOM 解析（计数 0），无参形态照常读取（原行为回归）
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/contenteditable-oninput-reuse.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { segmentsToText } from '@taiji/shared'
import { getSegmentsFromEl } from './input-dom'
import { useContenteditableInput } from './contenteditable'
import type { ContenteditableCallbacks } from './types'

// mock segment-parse（解析本体所在模块）而非 input-dom（纯 re-export 层）：
// input-dom 的 getTextFromEl 只是转发绑定，其内部对 getSegmentsFromEl 的引用是
// segment-parse 模块内词法绑定，mock re-export 层拦不到。这里同时重定义 getTextFromEl
// （与原实现同式：segmentsToText(getSegmentsFromEl(el))，segment-parse.ts 末尾），
// 使 getText 链路的解析计数也进同一 spy。
vi.mock('./segment-parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segment-parse')>()
  const getSegmentsFromElSpy = vi.fn(actual.getSegmentsFromEl)
  return {
    ...actual,
    getSegmentsFromEl: getSegmentsFromElSpy,
    getTextFromEl: (el: HTMLDivElement | null) => segmentsToText(getSegmentsFromElSpy(el)),
  }
})

/** mock callbacks 工厂（同 contenteditable.test.ts 形态） */
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
    ...overrides,
  }
}

function setup(initialHtml = '', overrides: Partial<ContenteditableCallbacks> = {}) {
  const el = document.createElement('div')
  el.innerHTML = initialHtml
  document.body.appendChild(el)
  const elRef = ref(el)
  const callbacks = makeCallbacks(overrides)
  const api = useContenteditableInput(elRef, callbacks)
  return { el, callbacks, ...api, cleanup: () => document.body.removeChild(el) }
}

describe('onInput 单次全文遍历复用（性能 A 档）', () => {
  let cleanup: (() => void) | undefined
  beforeEach(() => {
    vi.mocked(getSegmentsFromEl).mockClear()
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('计数锁：slash-chip 场景 onInput 一次 → getSegmentsFromEl 恰好 1 次（改造前 2 次）', () => {
    // hasChip 门使 detectSlashTrigger 提前返回 null（不进 getText 兜底）；其余触发检测
    // 走 matchTriggerBeforeCursor（读光标前文本，不经过 getSegmentsFromEl）。
    // 无光标（程序化 input）排除选区相关分支，计数只反映 syncEmpty + emitInput 的解析。
    const c = setup('<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/commit</span></span>正文')
    c.onInput()
    expect(vi.mocked(getSegmentsFromEl)).toHaveBeenCalledTimes(1)
    cleanup = c.cleanup
  })

  it('行为等价（多行）：emitInput 的 text 与 getText() 恒等，isEmpty=false', () => {
    const c = setup('line1<br>line2')
    c.onInput()
    expect(c.callbacks.onInput).toHaveBeenCalledTimes(1)
    expect(c.callbacks.onInput).toHaveBeenCalledWith('line1\nline2')
    expect(c.getText()).toBe('line1\nline2')
    expect(c.isEmpty.value).toBe(false)
    cleanup = c.cleanup
  })

  it('行为等价（空内容）：emitInput("") + isEmpty=true', () => {
    const c = setup('')
    c.onInput()
    expect(c.callbacks.onInput).toHaveBeenCalledWith('')
    expect(c.isEmpty.value).toBe(true)
    cleanup = c.cleanup
  })

  it('isEmpty 判定与 emitInput 的 text 互相一致（同一快照派生）', () => {
    const c = setup('非空草稿')
    c.onInput()
    const emitted = vi.mocked(c.callbacks.onInput).mock.calls[0]?.[0] ?? ''
    expect(c.isEmpty.value).toBe(emitted.trim() === '')
    cleanup = c.cleanup
  })
})

describe('syncEmpty 参数化（text?: string）', () => {
  let cleanup: (() => void) | undefined
  beforeEach(() => {
    vi.mocked(getSegmentsFromEl).mockClear()
  })
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('传参形态：不触发 DOM 解析（计数 0），判定值与传入快照一致', () => {
    const c = setup('hello')
    c.syncEmpty('hello')
    expect(c.isEmpty.value).toBe(false)
    expect(vi.mocked(getSegmentsFromEl)).not.toHaveBeenCalled()
    c.syncEmpty('')
    expect(c.isEmpty.value).toBe(true)
    expect(vi.mocked(getSegmentsFromEl)).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('无参形态（原行为回归）：照常读取 DOM 判定', () => {
    const c = setup('hello')
    c.syncEmpty()
    expect(c.isEmpty.value).toBe(false)
    c.el.textContent = ''
    c.syncEmpty()
    expect(c.isEmpty.value).toBe(true)
    expect(vi.mocked(getSegmentsFromEl)).toHaveBeenCalledTimes(2)
    cleanup = c.cleanup
  })
})
