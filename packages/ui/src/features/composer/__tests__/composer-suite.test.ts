import type { ChipCallbacks } from '@taiji/dom-core/composer/input';
import type { ContenteditableCallbacks } from '@taiji/dom-core/composer/input';
import type { ComposerInputInstance } from '@taiji/core/domain/composer';
import { createComposerInjectionStore, useComposerInjection } from '@taiji/core/domain/composer/context';
import { getSegmentsFromEl, useComposerChipCommands, useContenteditableInput } from '@taiji/dom-core/composer/input';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← composer-injection-real-dom.test.ts
// ======================================================================

beforeEach(() => {
  document.body.innerHTML = ''
})

/**
 * 搭建真实 chip 操作链路：contenteditable div + useComposerChipCommands（真实 DOM）+
 * 一个模拟 ComposerInput 的 expose 对象（含真实 insertFileChip）。
 * useComposerInjection 通过 inputRef.value.insertFileChip 调用，与真实 ComposerInput 行为一致。
 * store 用 core factory 本地实例（每 setup 新建，隔离测试间状态）。
 */
function setupRealChipChain(variant: 'panel' | 'landing', sessionId: string | null, store?: ReturnType<typeof createComposerInjectionStore>) {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.setAttribute('data-testid', 'composer-input')
  document.body.appendChild(el)
  // 清掉前一个测试残留的 selection range（指向已移除节点会导致 insertNode 静默失败）
  window.getSelection()?.removeAllRanges()
  const elRef = ref(el) as Ref<HTMLDivElement | null>
  // 真实 restoreSelection 链路（设计 D1 / u2 改写点）：不 mock restoreSelection——
  // 活选区优先 + savedRange blur 回退的真实语义是 chip 落位正确性的被测对象，
  // mock 会掩盖插入位置回归（composer chip bug 存活根因）
  const inputCallbacks = {
    onInput: vi.fn(),
    onSlashTrigger: vi.fn(),
    onFileTrigger: vi.fn(),
    onEnterKeydown: vi.fn(),
    onKeydown: vi.fn(),
    handleBackspaceOnChip: vi.fn(() => false),
    insertImageBadge: vi.fn(),
    getSessionId: vi.fn(() => 's1'),
    pasteImage: vi.fn(),
  } as unknown as ContenteditableCallbacks
  const input = useContenteditableInput(elRef, inputCallbacks)
  const chipCommands = useComposerChipCommands(elRef, {
    onChanged: vi.fn(),
    restoreSelection: input.restoreSelection,
    renderIcon: () => false,
    t: (key: string) => key,
  } as ChipCallbacks)
  // 模拟 ComposerInput 的 defineExpose 对象（useComposerInjection 通过 inputRef.value 访问）。
  // W4：core 统一 ComposerInputInstance 契约（input/types.ts）——mock 只实现注入消费方，
  // 用断言补齐剩余方法（clear/setText 等壳层消费方法在真实组件上有，mock 不需要）。
  const fakeInputRef = ref({
    focus: vi.fn(),
    insertFileChip: chipCommands.insertFileChip,
  }) as unknown as Ref<ComposerInputInstance | null>
  const sessionIdRef = ref(sessionId)
  const variantRef = ref(variant)
  // 双挂载场景传入共享 store（模拟 pinia 单例语义），否则本地新建隔离实例
  const injectionStore = store ?? createComposerInjectionStore()
  useComposerInjection(fakeInputRef, sessionIdRef, variantRef, {
    injectionStore,
    startFlow: vi.fn(async () => {}),
    getSessionCwd: () => undefined,
    getActiveSessionId: () => sessionIdRef.value,
  })
  return { el, store: injectionStore, input }
}

/** 把光标 collapse 到指定文本节点的 offset 处 */
function setCursor(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('composer 注入真实 DOM chip（R1/R3）', () => {
  it('R1: target=current → watch → contenteditable 内真实 .mention-file chip', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'src/foo.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('src/foo.ts')
    expect(chip.querySelector('.chip-label')).toBeTruthy()
  })

  it('R1b: target=current 带 lineRange → 真实 chip dataset 含行范围', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({
      target: 'current',
      path: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
  })

  it('R3: target=new → landing composer 消费 → 真实 DOM chip', async () => {
    const { el, store } = setupRealChipChain('landing', null)
    store.requestInjection({ target: 'new', path: 'bar.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipPath).toBe('bar.ts')
  })

  it('R1c: 注入后 pendingInjection 清空（消费即清）', async () => {
    const { store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    await nextTick()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('R1d: 真实选区链路——savedRange=头部旧快照 + 活光标在草稿末尾 → 注入 chip 落活光标处（设计 D1）', async () => {
    const { el, store, input } = setupRealChipChain('panel', 's1')
    el.textContent = 'AAA BBB'
    const textNode = el.firstChild as Text
    // savedRange 旧快照 = 头部（模拟点击框后打字推进，savedRange 不随打字更新）
    setCursor(textNode, 0)
    input.saveSelection()
    // 活光标在草稿末尾（键盘路径焦点从未离开）
    setCursor(textNode, 7)
    store.requestInjection({ target: 'current', path: 'cursor.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipPath).toBe('cursor.ts')
    // chip 不在头部（失败模式 A 回归）：firstChild 仍是正文文本，chip 紧跟其后
    expect(el.firstChild).toBe(textNode)
    expect(chip.previousSibling).toBe(textNode)
  })
})

// ── W18: split / dual panel 多 Composer 实例守护测试 ─────────────────────────────
// 防的 bug：split（panel+landing 同时挂载）/ dual panel 场景下，target=current 且
// sessionId 匹配活跃 session 时，可能被多个 Composer 实例误消费（双重注入）。
// 锁定契约：variant=panel 按 sessionId 精确匹配，variant=landing 仅消费 sessionId=null 的请求。
describe('W18: split / dual panel 多 Composer 实例注入隔离', () => {
  /**
   * 双挂载 setup：panel + landing 两个 Composer 共享同一 composerInjectionStore
   * 与同一 contenteditable 池（用不同 el 模拟两个独立 Composer 实例）。
   */
  function setupDualMount(panelSessionId: string | null) {
    // 共享同一 store（模拟 pinia 单例语义：drawer 写入 + 双 Composer 消费同一通道）
    const sharedStore = createComposerInjectionStore()
    const panelChain = setupRealChipChain('panel', panelSessionId, sharedStore)
    const landingChain = setupRealChipChain('landing', null, sharedStore)
    return {
      panelEl: panelChain.el,
      landingEl: landingChain.el,
      store: sharedStore,
    }
  }

  it('W18-1: panel + landing 双挂载 + target=current + sessionId=活跃 session → 仅 panel 注入，landing 不误消费', async () => {
    // 场景：split 视图（panel 显示活跃 session 的对话流，landing 显示空起始页）。
    // 用户从 drawer 注入到「当前活跃 session」。
    // 期望：panel composer（variant=panel，sessionId 匹配活跃 session）消费；
    //      landing composer（variant=landing，sessionId=null 不匹配 current 的非 null sessionId）不消费。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'main.ts', sessionId: 's-active' })
    await nextTick()

    // panel 注入成功
    const panelChip = panelEl.querySelector('.mention-file') as HTMLElement
    expect(panelChip).toBeTruthy()
    expect(panelChip.dataset.chipPath).toBe('main.ts')

    // landing 未注入（variant=landing 只消费 sessionId=null 的请求）
    expect(landingEl.querySelector('.mention-file')).toBeNull()

    // pendingInjection 被消费后清空（一次注入只对应一个 Composer，无双重消费）
    expect(store.pendingInjection.value).toBeNull()
  })

  it('W18-2: panel + landing 双挂载 + target=current + sessionId=null（routeToLanding 改写后）→ 仅 landing 注入', async () => {
    // 场景：阶段二，routeToLanding 把 target=new 改为 current 且 sessionId=null。
    // 此时 panel composer 不匹配（sessionId=null ≠ panel 的活跃 session），landing 匹配。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'new-task.ts', sessionId: null })
    await nextTick()

    // landing 注入成功（variant=landing 消费 sessionId=null 的 current 请求）
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('new-task.ts')

    // panel 不匹配（sessionId=null ≠ 's-active'）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('W18-3: panel + landing 双挂载 + target=new → landing 直接消费（阶段一前置：landing 已挂载）', async () => {
    // 场景：用户停在 landing 态，从 drawer 发起新对话注入。
    // 期望：landing composer 已挂载时直接消费 target=new（不路由到自身），
    //      panel composer 不消费 target=new（仅 session composer 触发 startFlow，但此处 panel 不匹配）。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'new', path: 'fresh.ts', sessionId: 's-active' })
    await nextTick()

    // landing 直接消费 target=new
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('fresh.ts')

    // panel 不注入（target=new 仅 landing composer 或路由阶段二消费）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection.value).toBeNull()
  })
})

// ======================================================================
// ← file-chip.test.ts
// ======================================================================

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
    // 子元素：chip-pre($) + chip-label + chip-x
    expect(chip.querySelector('.chip-pre')?.textContent).toBe('$')
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
    // 拍平文本与旧纯 textContent 形态一致（结构化 pre(@) + label(user)，svg/× 无文本）
    expect(chip.textContent).toBe('@user')
    expect(chip.querySelector('.chip-pre')?.textContent).toBe('@')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('user')
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 不设 file 结构化 dataset（旧通路保持无 dataset）
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

// ======================================================================
// ← useComposerChipCommands.image.test.ts
// ======================================================================

/** 创建挂载在 document 上的 contenteditable div + chipCommands 实例（同 file-chip.test 范式） */
function setupChipCommands_m2(): {
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
    const { el, chipCommands } = setupChipCommands_m2()
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
    const { el, chipCommands } = setupChipCommands_m2()
    // landing 态粘贴落 tmpdir 的图需迁移 → needsMigrate=true
    chipCommands.insertImageBadge('/tmp/x.png', 'x-uuid.png', 'x.png', true)
    const chip = el.querySelector('.image-chip') as HTMLElement
    expect(chip.dataset.chipNeedsMigrate).toBe('true')
  })

  it('C3: 同一文件附两次 → 两个 chip 各有唯一 chipId（path 重复但 id 不冲突）', () => {
    const { el, chipCommands } = setupChipCommands_m2()
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

describe('image badge lead 缩略图（demo .ichip .thumb，demo 对齐）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('badge 内渲染 img.chip-thumb（src = local-file:// 编码路径 + alt 用户可读名），位次在 label 前', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    chipCommands.insertImageBadge('/tmp/我的 截图.png', 'x-uuid.png', '截图.png')

    const chip = el.querySelector('.image-chip') as HTMLElement
    const img = chip.querySelector('img.chip-thumb') as HTMLImageElement
    expect(img).toBeTruthy()
    // local-file:// 协议（main protocol.handle 白名单通道），路径段整体 encodeURIComponent
    expect(img.src).toBe('local-file:///' + encodeURIComponent('/tmp/我的 截图.png'))
    expect(img.alt).toBe('截图.png')
    // lead 位次：label 之前（demo chipHtml lead + nm + x 顺序）
    expect(img.nextElementSibling?.classList.contains('chip-label')).toBe(true)
  })

  it('img 加载失败（error 事件）→ 回退 ImageIcon 占位（span.chip-icon 内联 svg），不留破图', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    chipCommands.insertImageBadge('/tmp/missing.png', 'missing.png', 'missing.png')

    const img = el.querySelector('img.chip-thumb') as HTMLImageElement
    expect(img).toBeTruthy()
    img.dispatchEvent(new Event('error'))

    // img 被占位 svg 替换：span.chip-icon.chip-thumb-fallback 内 12px svg（lucide image 同款三段）
    const fallback = el.querySelector('.chip-thumb-fallback') as HTMLElement
    expect(fallback).toBeTruthy()
    expect(el.querySelector('img.chip-thumb')).toBeNull()
    const svg = fallback.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('width')).toBe('12')
    // 占位复用 chip-icon 容器（壳层既有 12px 规格样式）
    expect(fallback.classList.contains('chip-icon')).toBe(true)
  })
})

describe('TC7: getSegmentsFromEl image 分支', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('解析 [text][image-chip][text] → 3 段，image chip 子树文本不污染', () => {
    const { el, chipCommands } = setupChipCommands_m2()
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
    const { el, chipCommands } = setupChipCommands_m2()
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
    const { el, chipCommands } = setupChipCommands_m2()
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
