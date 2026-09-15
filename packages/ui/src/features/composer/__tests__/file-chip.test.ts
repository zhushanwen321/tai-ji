/**
 * file chip 测试（W1）—— 结构化 file segment 的 DOM 写入 + 解析。
 *
 * 覆盖：
 * - U1: insertFileChip(path) 创建结构化 .mention-file chip DOM
 * - U2: insertFileChip(path, [10,20]) 设行范围 dataset + label 格式
 * - U3: getSegmentsFromEl 解析 .mention-file 产出 file segment 无文本污染
 * - U4: @mention 仍走 insertMentionChip 行为不变
 * - R2: 真实 DOM file chip 经 getSegments 产出 file segment（real 层端到端）
 *
 * [W4 迁移] 自 renderer __tests__/panel/file-chip.test.ts 迁入 ui 包 features/composer/
 * __tests__/——chip-commands 逻辑在 core input 模块，ui 包测试直接组合 core 模块
 * （deps renderIcon/t 注入，零 renderer import）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerChipCommands, getSegmentsFromEl } from '@taiji/dom-core/composer/input'
import type { ChipCallbacks } from '@taiji/dom-core/composer/input'

/** 创建挂载在 document 上的 contenteditable div + chipCommands 实例 */
function setupChipCommands(): {
  el: HTMLDivElement
  chipCommands: ReturnType<typeof useComposerChipCommands>
} {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  const elRef = ref(el)
  // insertFileChip 内部调 restoreSelection + window.getSelection，jsdom 下需清掉旧 selection
  // 否则前一个 test 残留的 range 指向已移除节点，range.insertNode 静默失败导致 chip 没进 DOM
  window.getSelection()?.removeAllRanges()
  const onChanged = vi.fn()
  const restoreSelection = vi.fn()
  const chipCommands = useComposerChipCommands(elRef as never, {
    onChanged,
    restoreSelection,
    renderIcon: () => false,
    t: (key: string) => key,
  } as ChipCallbacks)
  return { el, chipCommands }
}

describe('W1: insertFileChip 结构化 file chip DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('U1: insertFileChip(path) 创建 .mention-file chip 含 dataset + label + x + spacer', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts')

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.classList.contains('mention-chip')).toBe(true)
    expect(chip.classList.contains('mention-file')).toBe(true)
    expect(chip.contentEditable).toBe('false')
    // dataset 结构化标记
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('src/foo.ts')
    // 子元素：chip-label + chip-x
    expect(chip.querySelector('.chip-label')).toBeTruthy()
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 后跟 ZWSP spacer 文本节点
    const spacer = chip.nextSibling
    expect(spacer?.nodeType).toBe(Node.TEXT_NODE)
    expect(spacer?.textContent).toBe('\u200B')
  })

  it('U2: insertFileChip(path, [10,20]) 设行范围 dataset + label 显示 path:L10-L20', () => {
    const { chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 20])

    const chip = document.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
    const label = chip.querySelector('.chip-label') as HTMLElement
    expect(label.textContent).toContain('src/foo.ts')
    expect(label.textContent).toContain('L10-L20')
  })

  it('U2b: insertFileChip(path, [10,10]) 单行 label 显示 path:L10', () => {
    const { chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 10])

    const label = document.querySelector('.mention-file .chip-label') as HTMLElement
    expect(label.textContent).toContain('L10')
    // 单行不显示 L10-L10，只显示 L10
    expect(label.textContent).not.toContain('L10-L10')
  })

  it('U4: @mention 仍走 insertMentionChip 行为不变（非 mention-file，无 file dataset）', () => {
    const { chipCommands } = setupChipCommands()
    chipCommands.insertMentionChip('@', 'user')

    const chip = document.querySelector('.mention-chip') as HTMLElement
    expect(chip.classList.contains('mention-at')).toBe(true)
    expect(chip.classList.contains('mention-file')).toBe(false)
    expect(chip.textContent).toBe('@user')
    // 不设 file 结构化 dataset
    expect(chip.dataset.chipType).toBeUndefined()
    expect(chip.dataset.chipPath).toBeUndefined()
  })
})

describe('W1: getSegmentsFromEl 解析 file segment', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('U3: 解析 .mention-file 产出 file segment 无文本污染', () => {
    const { el, chipCommands } = setupChipCommands()
    // 先插入文本再插入 file chip 再插入文本
    el.textContent = 'before '
    chipCommands.insertFileChip('foo.ts')
    // chip 后追加文本
    const after = document.createTextNode(' after')
    el.querySelector('.mention-file')?.after(after)

    const segments = getSegmentsFromEl(el)
    // 应产出 text(file) + file segment + text(after)，无 chip-label/x 文本污染
    expect(segments).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'file', path: 'foo.ts' },
      { type: 'text', text: ' after' },
    ])
  })

  it('U3b: 解析带行范围的 file segment', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 20])
    const segments = getSegmentsFromEl(el)
    expect(segments).toEqual([{ type: 'file', path: 'src/foo.ts', lineRange: [10, 20] }])
  })

  it('R2: 真实 DOM file chip 经 getSegments 产出 file segment（含 lineRange）', () => {
    // R2 验证 DOM→segment 真实链路（非 mock getSegmentsFromEl）
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 20])
    const segments = getSegmentsFromEl(el)
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('file')
    if (segments[0].type === 'file') {
      expect(segments[0].path).toBe('src/foo.ts')
      expect(segments[0].lineRange).toEqual([10, 20])
    }
  })
})
