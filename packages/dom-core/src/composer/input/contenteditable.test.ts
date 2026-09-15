/**
 * contenteditable.ts composable 单测 —— composer input 模块 contenteditable 组合逻辑（W2 TC2）。
 *
 * 覆盖：onInput（slash/hash 触发检测）、paste 通路（pasteImage badge 回填 / text 降级）、
 * setText（caret start/end）、clear、syncEmpty、saveSelection/restoreSelection（savedRange
 * 生命周期 + D1 分区「活选区优先，savedRange 仅 blur 回退」：含跨边界活选区不采信 + 应用失败
 * 落末尾兜底）、moveCaretVertical（单行 at-edge）、clear 族（boundaryLen）、
 * onKeydown IME 守卫（composition 中不转发 keydown，composer-chip-insertion-semantics D2）。
 *
 * jsdom 限制：document.execCommand('insertText') 部分支持（paste 纯文本降级 / insertTextAtCursor
 * 不强测）；caretRangeFromPoint 未实现（moveCaretVertical 多行分支不测）。moveCaretVertical 单行
 * at-edge 分支可测。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/contenteditable.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useContenteditableInput } from './contenteditable'
import type { ContenteditableCallbacks } from './types'

/** mock callbacks 工厂（含 pasteImage） */
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

/** setup：创建 el 挂 body + elRef + composable */
function setup(initialHtml = '', overrides: Partial<ContenteditableCallbacks> = {}) {
  // jsdom 未实现 document.execCommand（insertText/insertLineBreak），stub noop。
  // execCommand 的真实行为由 TC5 renderer 行为测试（happy-dom）覆盖，core 单测只验证编排逻辑。
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

describe('useContenteditableInput onInput 触发检测', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('slash 触发：/ 在最左且无 chip → onSlashTrigger({query})', () => {
    const c = setup('/goal')
    c.syncEmpty()
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'goal' })
    cleanup = c.cleanup
  })

  it('slash 不触发：不以 / 开头 → onSlashTrigger(null)', () => {
    const c = setup('hello')
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('slash 不触发：有 slash-chip → onSlashTrigger(null)（chip 文本不误触发）', () => {
    const c = setup('<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/commit</span></span>')
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('hash 触发：光标在 #foo 后 → onFileTrigger({query})', () => {
    const c = setup('#foo')
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 4)
    range.collapse(true)
    sel?.addRange(range)
    c.onInput()
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith({ query: 'foo' })
    cleanup = c.cleanup
  })

  it('hash 不触发：光标前无 # 序列 → onFileTrigger(null)', () => {
    const c = setup('plain')
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 3)
    range.collapse(true)
    sel?.addRange(range)
    c.onInput()
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })
})

// ── 四符号体系 U1：$ / @ 触发 + bash 短路 + slash 正则化 ──

/** 把光标 collapse 到指定文本节点的 offset 处 */
function cursorAt(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('useContenteditableInput $ / @ 触发检测（onDollarFileTrigger / onSubagentTrigger）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('$ 行首触发：光标在 $foo 后 → onDollarFileTrigger({query:"foo"})', () => {
    const c = setup('$foo', { onDollarFileTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 4)
    c.onInput()
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith({ query: 'foo' })
    cleanup = c.cleanup
  })

  it('$ 空格后触发：echo $HOME → {query:"HOME"}（登记取舍：非 bash 态照常触发）', () => {
    const c = setup('echo $HOME', { onDollarFileTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 10)
    c.onInput()
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith({ query: 'HOME' })
    cleanup = c.cleanup
  })

  it('$ 文字中间不触发：a$b → onDollarFileTrigger(null)', () => {
    const c = setup('a$b', { onDollarFileTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 3)
    c.onInput()
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('@ 空格后触发：hey @build → onSubagentTrigger({query:"build"})', () => {
    const c = setup('hey @build', { onSubagentTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 10)
    c.onInput()
    expect(c.callbacks.onSubagentTrigger).toHaveBeenCalledWith({ query: 'build' })
    cleanup = c.cleanup
  })

  it('@ 文字中间不触发：a@b → onSubagentTrigger(null)', () => {
    const c = setup('a@b', { onSubagentTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 3)
    c.onInput()
    expect(c.callbacks.onSubagentTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('壳层未注入新回调（可选）时不抛错（ui ComposerInput 接线前形态）', () => {
    const c = setup('$foo')
    cursorAt(c.el.firstChild as Text, 4)
    expect(() => c.onInput()).not.toThrow()
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput bash 豁免短路（shouldSuppressTriggers）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('suppress=true：所有 trigger 回调收 null（含可选两路），不做检测', () => {
    const c = setup('#foo', {
      shouldSuppressTriggers: () => true,
      onDollarFileTrigger: vi.fn(),
      onSubagentTrigger: vi.fn(),
    })
    cursorAt(c.el.firstChild as Text, 4) // #foo 光标末尾——非 bash 态本应触发 file
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onSubagentTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('suppress=true：draft 同步不受影响（onInput 照发文本）', () => {
    const c = setup('!echo $HOME', { shouldSuppressTriggers: () => true })
    c.onInput()
    expect(c.callbacks.onInput).toHaveBeenCalledWith('!echo $HOME')
    cleanup = c.cleanup
  })

  it('suppress=false：行为与未注入一致（# 触发照常）', () => {
    const c = setup('#foo', { shouldSuppressTriggers: () => false })
    cursorAt(c.el.firstChild as Text, 4)
    c.onInput()
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith({ query: 'foo' })
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput slash 正则化（D5：光标所在行行首）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('多行第二行行首 / 触发（行为放宽，对齐 TUI）', () => {
    // Shift+Enter 产 <br> 分行：line1<br>/compact，光标在第二文本节点末尾
    const c = setup('line1<br>/compact')
    const secondTextNode = c.el.childNodes[2] as Text
    cursorAt(secondTextNode, 8)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'compact' })
    cleanup = c.cleanup
  })

  it('光标在行首但 / 前有文字（帮我 /x）→ null（空格后不触发）', () => {
    const c = setup('帮我 /x')
    cursorAt(c.el.firstChild as Text, 5)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('多行第一行行首 /：光标在第二行 → null（不被第一行误触发）', () => {
    const c = setup('/cmd<br>正文')
    const secondTextNode = c.el.childNodes[2] as Text
    cursorAt(secondTextNode, 2)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('无光标兜底：程序化 input（无选区）回退旧 startsWith 行为', () => {
    // renderer 集成测试形态：设 innerHTML + trigger('input')，无光标选区
    const c = setup('/commit')
    window.getSelection()?.removeAllRanges()
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'commit' })
    cleanup = c.cleanup
  })

  it('有 chip 时不触发（hasChip 语义保留，旧回归）', () => {
    const c = setup('<span class="slash-chip"><span class="chip-label">/old</span></span>/new')
    cursorAt(c.el.lastChild as Text, 4)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })
})

/** 构造 mock ClipboardEvent（jsdom 无 DataTransfer 全局，用 mock 对象） */
function makePasteEvent(opts: { imageFile?: File; text?: string }): ClipboardEvent {
  const items = opts.imageFile ? [{ kind: 'file' as const, type: opts.imageFile.type, getAsFile: () => opts.imageFile! }] : []
  const clipboardData = {
    items,
    getData: (type: string) => (type === 'text/plain' ? opts.text ?? '' : ''),
  }
  return { preventDefault: () => {}, clipboardData } as unknown as ClipboardEvent
}

describe('useContenteditableInput paste 通路（pasteImage 注入）', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('paste image → badge：占位插入 + pasteImage resolve 后调用', async () => {
    const c = setup('', {
      pasteImage: vi.fn().mockResolvedValue({
        kind: 'badge',
        path: '/real/a.png',
        fileName: 'a-uuid.png',
        displayName: '截图-a.png',
        needsMigrate: true,
      }),
    })
    const file = new File(['img'], 'a.png', { type: 'image/png' })
    c.onPaste(makePasteEvent({ imageFile: file }))
    expect(c.callbacks.insertImageBadge).toHaveBeenCalledWith(
      expect.stringMatching(/^__paste_pending_[0-9a-f-]+__$/),
      expect.stringMatching(/^__paste_pending_[0-9a-f-]+__$/),
      '粘贴中...',
      false,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(c.callbacks.pasteImage).toHaveBeenCalledWith(file, 's1')
    cleanup = c.cleanup
  })

  it('paste image → text 降级：pasteImage resolve kind:text 触发', async () => {
    const c = setup('', {
      pasteImage: vi.fn().mockResolvedValue({ kind: 'text', text: '[降级文本]' }),
    })
    const file = new File(['img'], 'b.png', { type: 'image/png' })
    c.onPaste(makePasteEvent({ imageFile: file }))
    await new Promise((r) => setTimeout(r, 0))
    expect(c.callbacks.pasteImage).toHaveBeenCalledWith(file, 's1')
    cleanup = c.cleanup
  })

  it('paste 无 image item（纯文本）→ 不调 pasteImage，走纯文本通路', () => {
    const c = setup('初始')
    c.onPaste(makePasteEvent({ text: '纯文本内容' }))
    expect(c.callbacks.pasteImage).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput setText / clear / syncEmpty', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('setText 写入纯文本 + emitInput(text) + isEmpty=false', () => {
    const c = setup('')
    c.setText('hello')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('hello')
    expect(c.isEmpty.value).toBe(false)
    expect(c.el.textContent).toBe('hello')
    cleanup = c.cleanup
  })

  it('setText 含 \\n → 用 <br> 分隔文本节点', () => {
    const c = setup('')
    c.setText('line1\nline2')
    expect(c.el.innerHTML).toBe('line1<br>line2')
    cleanup = c.cleanup
  })

  it('clear 清空 + emitInput("") + isEmpty=true', () => {
    const c = setup('content')
    c.clear()
    expect(c.el.textContent).toBe('')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('')
    expect(c.isEmpty.value).toBe(true)
    cleanup = c.cleanup
  })

  it('syncEmpty：空内容 → isEmpty=true；非空 → false', () => {
    const c = setup('')
    c.syncEmpty()
    expect(c.isEmpty.value).toBe(true)
    c.el.textContent = 'x'
    c.syncEmpty()
    expect(c.isEmpty.value).toBe(false)
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput saveSelection / restoreSelection', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('saveSelection 记录选区，restoreSelection 恢复', () => {
    const c = setup('hello')
    document.body.appendChild(c.el) // setup 已挂，确保在 body
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(textNode, 3)
    sel?.addRange(range)
    c.saveSelection()
    // 改变选区（模拟夺焦）
    sel?.removeAllRanges()
    // restore
    c.restoreSelection()
    const after = window.getSelection()
    expect(after?.rangeCount).toBeGreaterThan(0)
    cleanup = c.cleanup
  })

  it('clear 后 restoreSelection 不恢复 stale range（savedRange=null，仅 focus）', () => {
    const c = setup('hello')
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.collapse(true)
    sel?.addRange(range)
    c.saveSelection()
    c.clear() // savedRange 置 null
    // restore 不抛错（focus 兜底，不 addRange stale）
    expect(() => c.restoreSelection()).not.toThrow()
    cleanup = c.cleanup
  })
})

// ── 插入位置权威源（设计 D1：活选区优先，savedRange 仅 blur 回退）──

describe('useContenteditableInput restoreSelection 活选区优先（设计 D1）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('键盘路径活选区命中 → savedRange 不覆盖（光标留在活位置，失败模式 A 根修）', () => {
    const c = setup('AAA BBB CCC')
    c.el.contentEditable = 'true'
    const textNode = c.el.firstChild as Text
    // savedRange = 头部（点击空框时的旧快照）
    cursorAt(textNode, 0)
    c.saveSelection()
    // 活光标随打字推进到末尾
    cursorAt(textNode, 11)
    c.restoreSelection()
    const after = window.getSelection()
    expect(after?.anchorNode).toBe(textNode)
    expect(after?.anchorOffset).toBe(11)
    cleanup = c.cleanup
  })

  it('blur 且选区被移出编辑器 → 应用 savedRange（blur 回退路径行为保留）', () => {
    const c = setup('AAA BBB CCC')
    c.el.contentEditable = 'true'
    const textNode = c.el.firstChild as Text
    cursorAt(textNode, 4)
    c.saveSelection()
    // 选区被移出编辑器（点击浮层文本场景）
    const external = document.createElement('div')
    external.textContent = 'popover item'
    document.body.appendChild(external)
    cursorAt(external.firstChild as Text, 0)
    c.restoreSelection()
    const after = window.getSelection()
    expect(after?.rangeCount).toBeGreaterThan(0)
    expect(c.el.contains(after?.anchorNode ?? null)).toBe(true)
    expect(after?.anchorNode).toBe(textNode)
    expect(after?.anchorOffset).toBe(4)
    external.remove()
    cleanup = c.cleanup
  })

  it('活选区跨边界（锚点在编辑器内、焦点在编辑器外）→ 不采信该 range，回落 savedRange（S-3）', () => {
    const c = setup('AAA BBB CCC')
    c.el.contentEditable = 'true'
    const textNode = c.el.firstChild as Text
    // savedRange = 编辑器内旧快照（起拖前的光标位置）
    cursorAt(textNode, 4)
    c.saveSelection()
    // 活选区跨边界：一端在编辑器内、另一端在编辑器外（鼠标从输入框拖到消息区）
    const external = document.createElement('div')
    external.textContent = 'message body'
    document.body.appendChild(external)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(external.firstChild as Text, 3)
    sel?.addRange(range)
    expect(sel?.focusNode).toBe(external.firstChild) // 前置：跨边界选区已成立

    c.restoreSelection()

    // 跨边界 range 未被采信（否则下游 insertChipAtSelection 的 deleteContents 会删到编辑器外）：
    // 两端点均在编辑器内且已 collapse = savedRange 生效
    const after = window.getSelection()
    expect(c.el.contains(after?.focusNode ?? null)).toBe(true)
    expect(after?.isCollapsed).toBe(true)
    expect(after?.anchorNode).toBe(textNode)
    expect(after?.anchorOffset).toBe(4)
    external.remove()
    cleanup = c.cleanup
  })

  it('savedRange 应用失败（addRange 静默丢弃）→ caret 落编辑器末尾（placeCaretAtEnd 兜底）', () => {
    const c = setup('AAA')
    c.el.contentEditable = 'true'
    const doomed = document.createTextNode('doomed')
    c.el.appendChild(doomed)
    cursorAt(doomed, 6)
    c.saveSelection()
    doomed.remove()
    // 背景：DOM 规范的 live range 更新会把删除节点上的 savedRange 自动重锚到父元素
    // （锚点=el 的 element 位置），合规 DOM 上无法构造「悬空 range」；真实 Chromium 对
    // 边界失效 range 的 addRange 是静默丢弃。本用例用 Selection 桩模拟该丢弃语义
    // （仅桩浏览器 Selection 对象，restoreSelection 本体走真实链路）：
    // 锚点被重锚到 element 容器的 range 视为无效丢弃，锚点为文本节点才接受
    // ⚠️ 本用例锁的是防御性分支，产线可达性未证：桩自行定义了「丢弃」语义，若真实引擎
    // 不按此语义处理，则 placeCaretAtEnd 在产线不触发——通过本用例不等于产线行为保证。
    const external = document.createElement('div')
    external.textContent = 'outside'
    document.body.appendChild(external)
    const ranges: Range[] = []
    const externalText = external.firstChild as Text
    const fakeSel = {
      get rangeCount() { return ranges.length },
      get anchorNode() { return ranges[0]?.startContainer ?? null },
      get anchorOffset() { return ranges[0]?.startOffset ?? 0 },
      removeAllRanges() { ranges.length = 0 },
      addRange(r: Range) {
        if (r.startContainer.nodeType === Node.TEXT_NODE) ranges[0] = r
      },
    } as unknown as Selection
    const r = document.createRange()
    r.setStart(externalText, 0)
    r.collapse(true)
    ranges[0] = r // 活选区在编辑器外（blur 场景）
    const getSelSpy = vi.spyOn(window, 'getSelection').mockReturnValue(fakeSel)
    c.restoreSelection()
    getSelSpy.mockRestore()
    expect(fakeSel.rangeCount).toBe(1)
    const lastText = c.el.lastChild as Text
    expect(fakeSel.anchorNode).toBe(lastText)
    expect(fakeSel.anchorOffset).toBe(lastText.length)
    external.remove()
    cleanup = c.cleanup
  })

  it('!savedRange 且活选区失效 → 仍回焦不应用任何 range（对齐现状回焦行为）', () => {
    const c = setup('hello')
    c.el.contentEditable = 'true'
    // 无 saveSelection（savedRange=null）+ 活选区移出编辑器
    const external = document.createElement('div')
    external.textContent = 'outside'
    document.body.appendChild(external)
    cursorAt(external.firstChild as Text, 0)
    expect(() => c.restoreSelection()).not.toThrow()
    // 断言成立的双形态（轮 3-5 复审 N-3b）：分支②加固后，编辑器外活选区在 el.focus() 后
    // 仍越界 ⇒ 被 removeAllRanges() 清掉（rangeCount 归零、anchorNode 为 null）；加固前
    // 选区原样停在编辑器外（anchorNode = 外部文本节点）。contains(null) 与 contains(外部节点)
    // **皆为 false** ⇒ 两种因都满足下方 contains 断言；故补一条显式断言把「清掉 ⇒ rangeCount
    // === 0」的因果锁住，防 contains 断言因 null 恒真而空转（回退加固行 ⇒ 本行红）。
    // jsdom 不支持 contenteditable div 的 activeElement 断言，回焦行为由不抛错 + 分支可达保证。
    // **环境前提（轮 3-6 复审 RC3-F3，实测）**：本行在本环境成立依赖「`el.focus()` 不迁移选区」
    // ——本节建元素用 `el.contentEditable = 'true'` **属性赋值**形态，jsdom 29 下该形态
    // `focus()` 只置 activeElement（实测停在 BODY）、选区仍停在编辑器外文本节点，故 rangeCount
    // 归零只能来自加固分支的 removeAllRanges()。同版本 jsdom 若用 `contenteditable="true"`
    // **属性**（`setAttribute` 或 HTML 解析）建元素，`focus()` 会把选区迁入该元素（实测
    // anchorNode 落回编辑器、activeElement = 该元素）⇒ 加固分支不触发、rangeCount 为 1，本行
    // 会因环境差异变红。即本锁的强度绑定「本环境 + 本节建元素方式」：换 DOM 引擎（happy-dom /
    // Chromium）或改建元素方式时需按引擎行为重写本行；断言的语义（回焦后清掉编辑器外选区）
    // 不受影响。
    expect(c.el.contains(window.getSelection()?.anchorNode ?? null)).toBe(false)
    expect(window.getSelection()?.rangeCount).toBe(0)
    external.remove()
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput moveCaretVertical（jsdom 单行 at-edge）', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('单行内容 at-edge：moveCaretVertical 返回 at-edge', () => {
    const c = setup('only line')
    const result = c.moveCaretVertical('up')
    expect(result).toBe('at-edge')
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput clear 族（boundaryLen 模式：只删「符号+query 到光标」段）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('clearSlashQueryText 新行为：只删行首 /query 段，不再全清输入框（D5 修正）', () => {
    const c = setup('/commit')
    cursorAt(c.el.firstChild as Text, 7)
    c.clearSlashQueryText()
    expect(c.getText()).toBe('')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('')
    cleanup = c.cleanup
  })

  it('clearSlashQueryText：多行草稿只删 /query 行内容，其他行保留', () => {
    const c = setup('line1<br>/compact')
    const secondTextNode = c.el.childNodes[2] as Text
    cursorAt(secondTextNode, 8)
    c.clearSlashQueryText()
    // 第一行与 <br> 分行保留，第二行 /compact 被删
    expect(c.getText()).toBe('line1\n')
    cleanup = c.cleanup
  })

  it('clearSlashQueryText：光标不在行首 /query 后（不匹配）→ 不动作', () => {
    const c = setup('hello')
    cursorAt(c.el.firstChild as Text, 5)
    c.clearSlashQueryText()
    expect(c.getText()).toBe('hello')
    // 不匹配时不 emitInput（无变更）
    expect(c.callbacks.onInput).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('clearHashQueryText 行为不变（回归）：只删 #query 段，边界空格保留', () => {
    const c = setup('see #quer')
    cursorAt(c.el.firstChild as Text, 9)
    c.clearHashQueryText()
    expect(c.getText()).toBe('see ')
    cleanup = c.cleanup
  })

  it('clearDollarFileQueryText：只删 $query 段，边界空格保留', () => {
    const c = setup('see $quer')
    cursorAt(c.el.firstChild as Text, 9)
    c.clearDollarFileQueryText()
    expect(c.getText()).toBe('see ')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('see ')
    cleanup = c.cleanup
  })

  it('clearSubagentQueryText：只删 @query 段，边界空格保留', () => {
    const c = setup('hey @build')
    cursorAt(c.el.firstChild as Text, 10)
    c.clearSubagentQueryText()
    expect(c.getText()).toBe('hey ')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('hey ')
    cleanup = c.cleanup
  })

  it('clearDollarFileQueryText：无光标时不动作（不抛错）', () => {
    const c = setup('see $quer')
    window.getSelection()?.removeAllRanges()
    expect(() => c.clearDollarFileQueryText()).not.toThrow()
    expect(c.getText()).toBe('see $quer')
    cleanup = c.cleanup
  })
})

// ── IME 守卫（composer-chip-insertion-semantics 设计 D2「IME 确认不被劫持」的元素级防线）──
// 浮层 Enter/Tab 分支的 composingRef/e.isComposing 双保险只覆盖浮层自身；产线上「组合态
// Enter 不发送」的第一道（也是唯一必然生效的）防线在本文件 onKeydown 开头（contenteditable.ts:242
// `if (composing.value || e.isComposing) return`）——组合中事件根本不转发到 composer 分发器
// （forwardKeydown → composer-keydown）。此前该守卫零测试覆盖，renderer 的浮层用例因 target
// 是纯 div 直挂分发器而绕过它。
describe('useContenteditableInput onKeydown IME 守卫（composition 中不转发 keydown）', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('compositionstart 置 composing 后 Enter（isComposing=false）→ 不转发 keydown、不触发 onEnterKeydown', () => {
    const c = setup('已组合')
    // 产线接线：ComposerInput.vue `@compositionstart="composing = true"`（对同一 ref 直写）
    c.composing.value = true

    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    c.onKeydown(e)

    expect(c.callbacks.onEnterKeydown).not.toHaveBeenCalled()
    expect(c.callbacks.onKeydown).not.toHaveBeenCalled() // 不转发给 composer 分发器
    expect(e.defaultPrevented).toBe(false) // 不拦截，放行给 IME 做候选词确认
    cleanup = c.cleanup
  })

  it('事件属性路径：e.isComposing=true → 同样不转发 keydown（双保险的另一半）', () => {
    const c = setup('组合中')
    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    Object.defineProperty(e, 'isComposing', { value: true })

    c.onKeydown(e)

    expect(c.callbacks.onEnterKeydown).not.toHaveBeenCalled()
    expect(c.callbacks.onKeydown).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    cleanup = c.cleanup
  })

  it('compositionend 复位后 Enter 正常转发（守卫非恒真：正控证明上面两用例能区分回归）', () => {
    const c = setup('done')
    c.composing.value = true
    c.onCompositionEnd() // 产线接线：`@compositionend`
    expect(c.composing.value).toBe(false)

    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    c.onKeydown(e)

    expect(c.callbacks.onEnterKeydown).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true) // Enter 被 contenteditable 拦截后交 composer 分发
    cleanup = c.cleanup
  })
})
