/**
 * insertImageBadge + getSegmentsFromEl image 分支单测（TC6/TC7）。
 *
 * 覆盖：
 * - TC6: insertImageBadge(path, fileName, displayName) 创建 .image-chip span + dataset + chip-label + chip-x + ZWSP spacer + 光标定位
 * - TC7: getSegmentsFromEl 解析 image-chip → {type:image,path,fileName,displayName}，跳子树（label/x 文本不污染）
 *
 * [W4 迁移] 自 renderer __tests__/composables/useComposerChipCommands.image.test.ts 迁入 ui 包
 * features/composer/__tests__/——chip-commands 逻辑在 core input 模块，ui 包测试直接组合
 * core 模块（deps renderIcon/t 注入，零 renderer import）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerChipCommands, getSegmentsFromEl } from '@taiji/dom-core/composer/input'
import type { ChipCallbacks } from '@taiji/dom-core/composer/input'

/** 创建挂载在 document 上的 contenteditable div + chipCommands 实例（同 file-chip.test 范式） */
function setupChipCommands(): {
  el: HTMLDivElement
  chipCommands: ReturnType<typeof useComposerChipCommands>
} {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  const elRef = ref(el)
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

describe('TC6: insertImageBadge DOM 结构', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('创建 .image-chip span + dataset + label + x + ZWSP spacer', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertImageBadge('/tmp/x.png', 'x-uuid.png', 'x.png')

    const chip = el.querySelector('.image-chip') as HTMLElement
    expect(chip).toBeTruthy()
    // 复用 mention-chip 基础样式（TO2）+ image-chip 修饰
    expect(chip.classList.contains('mention-chip')).toBe(true)
    expect(chip.classList.contains('image-chip')).toBe(true)
    expect(chip.contentEditable).toBe('false')
    // C2 DOM schema：dataset 结构化标记（fileName 磁盘全名 + displayName 用户可读名）
    expect(chip.dataset.chipType).toBe('image')
    expect(chip.dataset.chipPath).toBe('/tmp/x.png')
    expect(chip.dataset.chipFileName).toBe('x-uuid.png')
    expect(chip.dataset.chipDisplayName).toBe('x.png')
    // M1：needsMigrate 默认 false（省略第 4 参数）→ dataset 'false'（+菜单选的磁盘文件不迁移）
    expect(chip.dataset.chipNeedsMigrate).toBe('false')
    // C3：chipId 是稳定唯一 uuid（crypto.randomUUID），同一文件附两次时 ContextChipsBar :key 用它区分
    expect(chip.dataset.chipId).toBeTruthy()
    expect(chip.dataset.chipId!.length).toBeGreaterThan(0)
    // 子元素：chip-label（显 displayName 用户可读名）+ chip-x
    const label = chip.querySelector('.chip-label') as HTMLElement
    expect(label).toBeTruthy()
    expect(label.textContent).toBe('x.png')
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 后跟 ZWSP spacer 文本节点
    const spacer = chip.nextSibling
    expect(spacer?.nodeType).toBe(Node.TEXT_NODE)
    expect(spacer?.textContent).toBe('\u200B')
  })

  it('M1: insertImageBadge 第 4 参数 needsMigrate=true → dataset.chipNeedsMigrate="true"', () => {
    const { el, chipCommands } = setupChipCommands()
    // landing 态粘贴落 tmpdir 的图需迁移 → needsMigrate=true
    chipCommands.insertImageBadge('/tmp/x.png', 'x-uuid.png', 'x.png', true)
    const chip = el.querySelector('.image-chip') as HTMLElement
    expect(chip.dataset.chipNeedsMigrate).toBe('true')
  })

  it('C3: 同一文件附两次 → 两个 chip 各有唯一 chipId（path 重复但 id 不冲突）', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertImageBadge('/tmp/dup.png', 'dup.png', 'dup.png')
    chipCommands.insertImageBadge('/tmp/dup.png', 'dup.png', 'dup.png')

    const chips = el.querySelectorAll<HTMLElement>('.image-chip')
    expect(chips.length).toBe(2)
    // path 相同（同一文件），id 必须不同（否则 ContextChipsBar :key 冲突）
    expect(chips[0].dataset.chipPath).toBe('/tmp/dup.png')
    expect(chips[1].dataset.chipPath).toBe('/tmp/dup.png')
    expect(chips[0].dataset.chipId).not.toBe(chips[1].dataset.chipId)
  })

  it('onChanged 被调用', () => {
    const onChanged = vi.fn()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const cc = useComposerChipCommands(ref(el) as never, {
      onChanged,
      restoreSelection: vi.fn(),
      renderIcon: () => false,
      t: (key: string) => key,
    } as ChipCallbacks)
    cc.insertImageBadge('/tmp/a.png', 'a.png', 'a.png')
    expect(onChanged).toHaveBeenCalled()
  })
})

describe('TC7: getSegmentsFromEl image 分支', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('解析 [text][image-chip][text] → 3 段，image chip 子树文本不污染', () => {
    const { el, chipCommands } = setupChipCommands()
    el.textContent = 'hello'
    chipCommands.insertImageBadge('/tmp/a.png', 'a-uuid.png', 'a.png')
    // chip 后追加文本
    el.querySelector('.image-chip')?.after(document.createTextNode('world'))

    const segments = getSegmentsFromEl(el)
    expect(segments).toEqual([
      { type: 'text', text: 'hello' },
      // C3：image segment 含稳定唯一 id（chip.dataset.chipId 的 uuid）+ fileName/displayName
      // M1：默认 needsMigrate=false（insertImageBadge 未传第 4 参数 → dataset 'false' → segment false）
      { type: 'image', id: expect.any(String), path: '/tmp/a.png', fileName: 'a-uuid.png', displayName: 'a.png', needsMigrate: false },
      { type: 'text', text: 'world' },
    ])
    // chip-label 'a.png' 与 chip-x '×' 不出现在任何 text segment（rejectChipSubtree 生效）
    const textContent = segments
      .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
      .map((s) => s.text)
      .join('')
    expect(textContent).not.toContain('×')
  })

  it('M1: getSegmentsFromEl 读 dataset.chipNeedsMigrate="true" → segment.needsMigrate=true', () => {
    const { el, chipCommands } = setupChipCommands()
    // landing 态 writeSessionImage 落 tmpdir 的图 → needsMigrate=true
    chipCommands.insertImageBadge('/tmp/landing.png', 'landing.png', '截图.png', true)
    const segments = getSegmentsFromEl(el)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ type: 'image', needsMigrate: true })
  })

  it('W2: getSegmentsFromEl 跳过 __paste_pending_ / __drag_pending_ 占位符（防占位进 pi prompt）', () => {
    // 场景：用户粘图/拖图时插了占位 badge（path=__paste_pending_<uuid>__），
    // 在 await handleImagePaste 完成前按 Enter 发送——占位符 path 无效，不应进 segments。
    // 这里同时构造 paste 与 drag 两种占位 + 1 个真实 image + text，断言占位被静默丢弃。
    const { el, chipCommands } = setupChipCommands()
    el.textContent = '前'
    // 占位 badge：path/fileName 用 __paste_pending_<uuid>__ / __drag_pending_<uuid>__
    chipCommands.insertImageBadge(
      '__paste_pending_11111111-1111-1111-1111-111111111111__',
      '__paste_pending_11111111-1111-1111-1111-111111111111__',
      '粘贴中...',
    )
    chipCommands.insertImageBadge(
      '__drag_pending_22222222-2222-2222-2222-222222222222__',
      '__drag_pending_22222222-2222-2222-2222-222222222222__',
      '拖入中…',
    )
    // 真实 image badge（已回填的真实 path）
    chipCommands.insertImageBadge('/tmp/real.png', 'real.png', 'real.png')
    // 末尾追加文本
    el.querySelector('.image-chip:nth-last-of-type(1)')?.after(document.createTextNode('后'))

    const segments = getSegmentsFromEl(el)
    // 占位符被丢弃：只剩「前」text + 真实 image + 「后」text，无任何 pending path
    expect(segments).toEqual([
      { type: 'text', text: '前' },
      expect.objectContaining({ type: 'image', path: '/tmp/real.png' }),
      { type: 'text', text: '后' },
    ])
    // 关键断言：没有任何 segment 的 path 形如 __paste_pending_ / __drag_pending_
    const allPaths = segments
      .filter((s): s is Extract<typeof s, { type: 'image'; path: string }> => s.type === 'image')
      .map((s) => s.path)
    expect(allPaths.some((p) => /__(?:paste|drag)_pending_/.test(p))).toBe(false)
  })
})
