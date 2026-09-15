/**
 * input-dom.ts DOM 函数单测 —— composer input 模块 DOM 直连收敛层（W2 TC1）。
 *
 * 覆盖：getSegmentsFromEl（segment 状态机）/ getTextFromEl（br→\n）/ detectHashTriggerFromEl
 * （# 触发检测）/ findImageChipEl（dataset 遍历，CSS 特殊字符安全）。
 *
 * jsdom 支持 TreeWalker/Range/Selection；caretRangeFromPoint 与 Selection.modify 未实现
 * （moveCaretVerticalOf 经 stub Range rect/Selection.modify 覆盖 jsdom 可达分支，
 * caretRangeFromPoint 多行中间行通路仍由 renderer 行为测试兜底，见 design review
 * boundaryConditionNote）。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/input-dom.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  detectFileDollarTriggerFromEl,
  detectSubagentTriggerFromEl,
  detectSlashTriggerFromEl,
  findImageChipEl,
  findImageChipElById,
  isSpacerNode,
  moveCaretVerticalOf,
  applyImagePersistResult,
  CHIP_SPACER_ZWSP,
} from './input-dom'
import type { HandleImagePasteResult } from './types'

/** 构造 contenteditable div + 设 innerHTML */
function setupEl(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

/** 构造 div 并挂到 document.body（jsdom Selection API 仅对 document 树内元素生效） */
function setupElInBody(html: string): HTMLDivElement {
  const el = setupEl(html)
  document.body.appendChild(el)
  return el
}

/** 设光标到指定文本节点的 offset 处（detectHashTrigger 测试用） */
function setCursor(targetNode: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(targetNode, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('getSegmentsFromEl', () => {
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })

  it('纯文本：产出单个 text segment', () => {
    const el = setupEl('hello world')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('<br> 产出 text segment 含 \\n（Shift+Enter 软换行保留）', () => {
    const el = setupEl('line1<br>line2')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  it('块级 div 分行产出 \\n（粘贴 insertText 的 Chromium 形态，换行不丢）', () => {
    // execCommand('insertText') 含 \n 文本在 Chromium 的实际产出形态（实测 innerHTML）
    const el = setupEl('line1<div>line2</div><div>line3</div>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'line1\nline2\nline3' }])
  })

  it('首行即块级 div：首块前不产出多余换行', () => {
    const el = setupEl('<div>a</div><div>b</div>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'a\nb' }])
  })

  it('块级 div 内 <br> 空行：与块级边界换行去重（一个空行一个 \\n）', () => {
    const el = setupEl('a<div><br></div>b')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'a\n\nb' }])
  })

  it('块级 div 后跟顶层文本：块结束也补 \\n（视觉在下一行）', () => {
    const el = setupEl('abcx<div>y</div>def')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'abcx\ny\ndef' }])
  })

  it('块级 p 分行同样产出 \\n', () => {
    const el = setupEl('<p>one</p><p>two</p>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'one\ntwo' }])
  })

  it('slash-chip（skill 类型）产出 skill segment（带 name + location）', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="skill" data-chip-name="cw-cli" data-chip-location="/path"><span class="chip-label">cw-cli</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'skill', name: 'cw-cli', location: '/path' },
    ])
  })

  it('slash-chip（skill 无 location）产出 skill segment 无 location 字段', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="skill" data-chip-name="myskill"><span class="chip-label">myskill</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'skill', name: 'myskill' }])
  })

  it('slash-chip（普通命令）产出 slash segment（D4-b：name 取 dataset.chipName 不含 / 前缀，不并入文本）', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="slash" data-chip-name="commit"><span class="chip-label">/commit</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'slash', name: 'commit' }])
  })

  it('命令 chip 与文本混合：前后文本正确分段，chip-label 不混入文本（D4-b）', () => {
    const el = setupEl(
      '任务描述<br><span class="slash-chip" data-chip-type="slash" data-chip-name="compact"><span class="chip-label">/compact</span></span> 清理一下',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'text', text: '任务描述\n' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: ' 清理一下' },
    ])
    // 序列化归位（D4-c）：slash 段提首，产物以 /compact 开头（pi 行首协议）
    expect(getTextFromEl(el)).toBe('/compact 任务描述\n 清理一下')
  })

  it('image-chip 产出 image segment（含 id/path/fileName/displayName/needsMigrate）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-file image-chip" data-chip-type="image" data-chip-id="abc-123" data-chip-path="/tmp/x.png" data-chip-file-name="x.png" data-chip-display-name="截图.png" data-chip-needs-migrate="true"><span class="chip-label">截图.png</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      {
        type: 'image',
        id: 'abc-123',
        path: '/tmp/x.png',
        fileName: 'x.png',
        displayName: '截图.png',
        needsMigrate: true,
      },
    ])
  })

  it('image-chip 占位符（__paste_pending___）跳过不进 segments', () => {
    const el = setupEl(
      '<span class="image-chip" data-chip-type="image" data-chip-path="__paste_pending_550e8400-e29b-41d4-a716-446655440000__"><span class="chip-label">粘贴中...</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([])
  })

  it('mention-file chip 产出 file segment（带 lineRange）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-file" data-chip-type="file" data-chip-path="/a.ts" data-chip-line-start="10" data-chip-line-end="20"><span class="chip-label">/a.ts:L10-L20</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'file', path: '/a.ts', lineRange: [10, 20] },
    ])
  })

  it('mention-file chip 无 lineRange 产出 file segment 无 lineRange 字段', () => {
    const el = setupEl(
      '<span class="mention-chip mention-file" data-chip-type="file" data-chip-path="/b.ts"><span class="chip-label">/b.ts</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'file', path: '/b.ts' }])
  })

  it('session chip（dataset.chipType=session）产出 session segment（sessionId + label）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-session" data-chip-type="session" data-chip-session-id="019e-abc" data-chip-label="设计讨论"><span class="chip-label">设计讨论</span><span class="chip-x">×</span></span>',
    )
    // × 按钮文本不进 segment（rejectChips 跳过子树）
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'session', sessionId: '019e-abc', label: '设计讨论' },
    ])
  })

  it('subagent chip（dataset.chipType=subagent）产出 subagent segment（subagentId + slug）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-at" data-chip-type="subagent" data-chip-subagent-id="sub-1" data-chip-slug="build-api"><span class="chip-label">@build-api</span><span class="chip-x">×</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'subagent', subagentId: 'sub-1', slug: 'build-api' },
    ])
  })

  it('旧 mention-at chip（无 dataset）保持文本拍平（历史消息编辑兼容，F3）', () => {
    const el = setupEl('<span class="mention-chip mention-at">@alice</span>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: '@alice' }])
  })

  it('session chip 与文本混合：前后文本正确分段', () => {
    const el = setupEl(
      '看看 <span class="mention-chip mention-session" data-chip-type="session" data-chip-session-id="s1" data-chip-label="会话 A"><span class="chip-label">会话 A</span></span> 的内容',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'text', text: '看看 ' },
      { type: 'session', sessionId: 's1', label: '会话 A' },
      { type: 'text', text: ' 的内容' },
    ])
  })

  it('mixed：text + slash-chip + image-chip + br 组合正确分段', () => {
    const el = setupEl(
      '前缀 <span class="slash-chip" data-chip-type="skill" data-chip-name="s"><span class="chip-label">s</span></span> 中间<br>' +
        '<span class="image-chip" data-chip-type="image" data-chip-id="i1" data-chip-path="/p.png" data-chip-file-name="p.png" data-chip-display-name="p.png" data-chip-needs-migrate="false"><span class="chip-label">p.png</span></span> 后缀',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'text', text: '前缀 ' },
      { type: 'skill', name: 's' },
      { type: 'text', text: ' 中间\n' },
      {
        type: 'image',
        id: 'i1',
        path: '/p.png',
        fileName: 'p.png',
        displayName: 'p.png',
        needsMigrate: false,
      },
      { type: 'text', text: ' 后缀' },
    ])
  })

  it('chip-x（× 删除按钮）文本被过滤（TreeWalker 跳过 .chip-x 子树）', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="slash" data-chip-name="c"><span class="chip-label">/c</span><span class="chip-x">×</span></span>',
    )
    // D4-b：命令 chip 产 slash segment（name 走 dataset），× 按钮文本不混入
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'slash', name: 'c' }])
  })

  it('null el 返回空数组', () => {
    expect(getSegmentsFromEl(null)).toEqual([])
  })

  it('ZWSP (\\u200B) 从文本中删除，NBSP (\\u00A0) 转空格', () => {
    const el = setupEl('a\u200Bb\u00A0c')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'ab c' }])
  })
})

describe('getTextFromEl', () => {
  it('segmentsToText 便捷封装：br → \\n + chip 拍平', () => {
    const el = setupEl('hello<br>world')
    expect(getTextFromEl(el)).toBe('hello\nworld')
  })

  it('null el 返回空串', () => {
    expect(getTextFromEl(null)).toBe('')
  })
})

describe('detectHashTriggerFromEl', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  it('光标在 #foo 后（行首）触发，返回 query=foo', () => {
    el = setupElInBody('#foo')
    const textNode = el.firstChild as Text
    setCursor(textNode, 4) // 光标在 "#foo" 末尾
    expect(detectHashTriggerFromEl(el)).toEqual({ query: 'foo' })
  })

  it('光标在 text #bar 后（空格后）触发，返回 query=bar', () => {
    el = setupElInBody('code #bar')
    const textNode = el.firstChild as Text
    setCursor(textNode, 9) // 光标在 "code #bar" 末尾
    expect(detectHashTriggerFromEl(el)).toEqual({ query: 'bar' })
  })

  it('光标前无 # 序列返回 null', () => {
    el = setupElInBody('plain text')
    const textNode = el.firstChild as Text
    setCursor(textNode, 5)
    expect(detectHashTriggerFromEl(el)).toBeNull()
  })

  it('选区非折叠（isCollapsed=false）返回 null', () => {
    el = setupElInBody('#foo')
    const textNode = el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 4) // 非折叠选区
    sel?.addRange(range)
    expect(detectHashTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectHashTriggerFromEl(null)).toBeNull()
  })
})

describe('detectFileDollarTriggerFromEl（$ 文件触发）', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  /** 便捷：设 innerHTML + 光标定位到第 idx 个文本节点末尾（默认 0） */
  function setupWithCursor(html: string): HTMLDivElement {
    el = setupElInBody(html)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode() as Text
    setCursor(textNode, textNode.length)
    return el
  }

  it('行首 $foo 触发，query=foo', () => {
    setupWithCursor('$foo')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'foo' })
  })

  it('空格后 $foo 触发（look at $foo）', () => {
    setupWithCursor('look at $foo')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'foo' })
  })

  it('$HOME 在普通文本触发（登记取舍：非 bash 态 $ 变量文本会弹层，设计 D6）', () => {
    // 用户输入 ` $HOME` 时光标在 HOME 后——非 bash 态照常触发（无豁免机制的固有噪声）
    setupWithCursor('看看 $HOME')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'HOME' })
  })

  it('裸 $ 触发（query 空串，浮层刚弹出态）', () => {
    setupWithCursor('see $')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: '' })
  })

  it('文字中间 a$b 不触发（$ 前非空格/行首）', () => {
    setupWithCursor('a$b')
    expect(detectFileDollarTriggerFromEl(el)).toBeNull()
  })

  it('$ 后遇空格终止（$foo bar → null）', () => {
    setupWithCursor('$foo bar')
    expect(detectFileDollarTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectFileDollarTriggerFromEl(null)).toBeNull()
  })
})

describe('detectSubagentTriggerFromEl（@ subagent 触发）', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  it('行首 @build 触发，query=build', () => {
    el = setupElInBody('@build')
    const textNode = el.firstChild as Text
    setCursor(textNode, 6)
    expect(detectSubagentTriggerFromEl(el)).toEqual({ query: 'build' })
  })

  it('空格后 @build 触发（hey @build-api）', () => {
    el = setupElInBody('hey @build-api')
    const textNode = el.firstChild as Text
    setCursor(textNode, 14)
    expect(detectSubagentTriggerFromEl(el)).toEqual({ query: 'build-api' })
  })

  it('文字中间 a@b 不触发', () => {
    el = setupElInBody('a@b')
    const textNode = el.firstChild as Text
    setCursor(textNode, 3)
    expect(detectSubagentTriggerFromEl(el)).toBeNull()
  })

  it('@ 后遇空格终止（@x y → null）', () => {
    el = setupElInBody('@x y')
    const textNode = el.firstChild as Text
    setCursor(textNode, 4)
    expect(detectSubagentTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectSubagentTriggerFromEl(null)).toBeNull()
  })
})

describe('detectSlashTriggerFromEl（行首 slash 触发，D5 正则化）', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  it('行首 /compact 触发，query=compact', () => {
    el = setupElInBody('/compact')
    const textNode = el.firstChild as Text
    setCursor(textNode, 8)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })

  it('裸 / 触发（query 空串）', () => {
    el = setupElInBody('/')
    const textNode = el.firstChild as Text
    setCursor(textNode, 1)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: '' })
  })

  it('多行第二行行首 / 触发（<br> 分行形态，行为放宽对齐 TUI）', () => {
    el = setupElInBody('line1<br>/compact')
    // 第二个文本节点（/compact），光标置其末尾
    const textNode = el.childNodes[2] as Text
    setCursor(textNode, 8)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })

  it('文本节点内 \\n 后行首 / 触发（防御：粘贴还原的罕见单节点形态）', () => {
    el = setupElInBody('line1\n/compact')
    const textNode = el.firstChild as Text
    setCursor(textNode, 14)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })

  it('空格后 / 不触发（帮我看看 /usr/local——路径文本高频，D5 否决空格触发）', () => {
    el = setupElInBody('帮我看看 /usr/local')
    const textNode = el.firstChild as Text
    setCursor(textNode, textNode.length)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('行中段 foo/ 不触发', () => {
    el = setupElInBody('foo/')
    const textNode = el.firstChild as Text
    setCursor(textNode, 4)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('query 后输入空格终止（/compact 详细 → null）', () => {
    el = setupElInBody('/compact 详细')
    const textNode = el.firstChild as Text
    setCursor(textNode, 11)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectSlashTriggerFromEl(null)).toBeNull()
  })

  // ── 检查点 1（设计 §5/§7）：chip 后 ZWSP spacer 处光标再打 / 的行为 ──
  // insertSlashChip/insertChipAtSelection 落位后光标锚定在 chip 后的 ZWSP spacer（文本节点）。
  // 行首正则 (?:^|\n)\/ 的 ^ 匹配「光标所在文本节点开头」，spacer 节点开头是 ZWSP 而非 /，
  // 故 spacer 后打 / 不触发行首命令浮层（与 hasChip 抑制一致；skill 域正则同理由天然不命中）。
  it('检查点 1：命令 chip 后 spacer 处光标（ZWSP 末尾）→ null（不触发行首命令浮层）', () => {
    el = setupElInBody('')
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.dataset.chipType = 'slash'
    chip.dataset.chipName = 'compact'
    el.appendChild(chip)
    const spacer = document.createTextNode('\u200B')
    el.appendChild(spacer)
    setCursor(spacer, 1) // 光标在 spacer 末尾（chip 插入后的落位点）
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('检查点 1：spacer 后打 /（节点内容 \\u200B/）→ 仍 null（^ 后是 ZWSP 非行首）', () => {
    el = setupElInBody('')
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.dataset.chipType = 'slash'
    chip.dataset.chipName = 'compact'
    el.appendChild(chip)
    const spacer = document.createTextNode('\u200B/')
    el.appendChild(spacer)
    setCursor(spacer, 2) // 打完 / 后光标
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('检查点 1 对照：chip 后 Enter 新行（新文本节点）行首 / 照常触发', () => {
    el = setupElInBody('')
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.dataset.chipType = 'slash'
    chip.dataset.chipName = 'compact'
    el.appendChild(chip)
    el.appendChild(document.createTextNode('\u200B'))
    el.appendChild(document.createElement('br'))
    const newLine = document.createTextNode('/compact')
    el.appendChild(newLine)
    setCursor(newLine, 8)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })
})

describe('findImageChipEl / findImageChipElById', () => {
  it('按 chipPath 遍历定位（dataset 比对，含 CSS 特殊字符 path 安全）', () => {
    // 真实场景 path 含 " / ] 是经 JS dataset 赋值（不走 HTML 解析），模拟该路径
    const el = setupEl(
      '<span class="image-chip" data-chip-path="/normal.png"></span>' +
      '<span class="image-chip"></span>',
    )
    const chips = el.querySelectorAll<HTMLElement>('.image-chip')
    chips[1].dataset.chipPath = '/a"b]c.png'  // JS 赋值，特殊字符安全
    const found = findImageChipEl(el, '/a"b]c.png')
    expect(found).not.toBeNull()
    expect(found?.dataset.chipPath).toBe('/a"b]c.png')
  })

  it('path 不存在返回 null', () => {
    const el = setupEl('<span class="image-chip" data-chip-path="/x.png"></span>')
    expect(findImageChipEl(el, '/not-exist.png')).toBeNull()
  })

  it('按 chipId 遍历定位', () => {
    const el = setupEl(
      '<span class="image-chip" data-chip-id="id-1"></span><span class="image-chip" data-chip-id="id-2"></span>',
    )
    expect(findImageChipElById(el, 'id-2')?.dataset.chipId).toBe('id-2')
  })
})

describe('isSpacerNode', () => {
  it('NBSP 文本节点判为 spacer', () => {
    const n = document.createTextNode('\u00A0')
    expect(isSpacerNode(n)).toBe(true)
  })

  it('ZWSP 文本节点判为 spacer', () => {
    expect(isSpacerNode(document.createTextNode('\u200B'))).toBe(true)
  })

  it('普通文本节点非 spacer', () => {
    expect(isSpacerNode(document.createTextNode('hello'))).toBe(false)
  })

  it('null / element 节点非 spacer', () => {
    expect(isSpacerNode(null)).toBe(false)
    expect(isSpacerNode(document.createElement('span'))).toBe(false)
  })
})

describe('applyImagePersistResult', () => {
  let execSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // jsdom 未实现 document.execCommand，手动挂 spy（applyImagePersistResult 的 text 分支会调）
    execSpy = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', {
      value: execSpy,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    // 清理测试注入的 execCommand，避免污染其他测试
    delete (document as { execCommand?: unknown }).execCommand
  })

  /** 构造一个带 .chip-label 子元素的占位 badge 元素 */
  function makePlaceholder(labelText = '粘贴中...'): HTMLElement {
    const placeholder = document.createElement('div')
    placeholder.classList.add('image-chip')
    const label = document.createElement('span')
    label.classList.add('chip-label')
    label.textContent = labelText
    placeholder.appendChild(label)
    return placeholder
  }

  it('kind=badge + placeholderEl 存在：回填 dataset + 更新 label，不调 insertImageBadge', () => {
    const placeholder = makePlaceholder('粘贴中...')
    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = {
      kind: 'badge',
      path: '/tmp/abc.png',
      fileName: 'abc.png',
      displayName: '图片.png',
      needsMigrate: true,
    }

    applyImagePersistResult({ placeholderEl: placeholder, result, insertImageBadge })

    expect(placeholder.dataset.chipPath).toBe('/tmp/abc.png')
    expect(placeholder.dataset.chipFileName).toBe('abc.png')
    expect(placeholder.dataset.chipDisplayName).toBe('图片.png')
    expect(placeholder.dataset.chipNeedsMigrate).toBe('true')
    expect(placeholder.querySelector('.chip-label')?.textContent).toBe('图片.png')
    expect(insertImageBadge).not.toHaveBeenCalled()
  })

  it('kind=badge + placeholderEl 为 null：调 insertImageBadge 一次，参数 = result 各字段', () => {
    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = {
      kind: 'badge',
      path: '/p/x.png',
      fileName: 'x.png',
      displayName: 'x.png',
      needsMigrate: false,
    }

    applyImagePersistResult({ placeholderEl: null, result, insertImageBadge })

    expect(insertImageBadge).toHaveBeenCalledTimes(1)
    expect(insertImageBadge).toHaveBeenCalledWith('/p/x.png', 'x.png', 'x.png', false)
  })

  it('kind=text + placeholderEl 存在 + nextSibling 是 ZWSP 文本节点：移除 nextSibling + placeholder + 调 execCommand', () => {
    const placeholder = makePlaceholder()
    const zwsp = document.createTextNode(CHIP_SPACER_ZWSP)
    const parent = document.createElement('div')
    parent.appendChild(placeholder)
    parent.appendChild(zwsp)

    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = { kind: 'text', text: 'fallback text' }

    applyImagePersistResult({ placeholderEl: placeholder, result, insertImageBadge })

    expect(parent.contains(placeholder)).toBe(false)
    expect(parent.contains(zwsp)).toBe(false)
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'fallback text')
    expect(insertImageBadge).not.toHaveBeenCalled()
  })

  it('kind=text + placeholderEl 存在 + nextSibling 非 ZWSP：只移除 placeholder，nextSibling 不动 + 调 execCommand', () => {
    const placeholder = makePlaceholder()
    const other = document.createTextNode('普通文本')
    const parent = document.createElement('div')
    parent.appendChild(placeholder)
    parent.appendChild(other)

    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = { kind: 'text', text: 't' }

    applyImagePersistResult({ placeholderEl: placeholder, result, insertImageBadge })

    expect(parent.contains(placeholder)).toBe(false)
    expect(parent.contains(other)).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 't')
    expect(insertImageBadge).not.toHaveBeenCalled()
  })
})

describe('getSegmentsFromEl 分支补充（W6 特征锚定）', () => {
  it('chip-x 过滤独立生效：旧 mention-at（无 dataset）走元素递归，× 按钮文本不入 segment', () => {
    // slash-chip 用例里 × 被芯片分支整体短路，此形态才真正走到 chip-x 元素的 self-closest 过滤
    const el = setupEl('<span class="mention-chip mention-at">@alice<span class="chip-x">×</span></span>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: '@alice' }])
  })

  it('根 el 自带 chip-x class：直接子节点按 chip-x 子树过滤（parentElement closest 命中）', () => {
    const el = setupEl('hello')
    el.classList.add('chip-x')
    expect(getSegmentsFromEl(el)).toEqual([])
  })

  it('嵌套块级 div：进入/离开幂等挂起，相邻块级边界不重复补 \\n', () => {
    const el = setupEl('<div>a<div>b</div>c</div>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'a\nb\nc' }])
  })

  it('image chip 仅凭 dataset.chipType=image（无 image-chip class）也产出 image segment', () => {
    const el = setupEl(
      '<span data-chip-type="image" data-chip-id="i9" data-chip-path="/p9.png" data-chip-file-name="p9.png" data-chip-display-name="p9.png" data-chip-needs-migrate="false"></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      {
        type: 'image',
        id: 'i9',
        path: '/p9.png',
        fileName: 'p9.png',
        displayName: 'p9.png',
        needsMigrate: false,
      },
    ])
  })

  it('image-chip 占位符 __drag_pending___ 与 paste 形态同样跳过', () => {
    const el = setupEl(
      '<span class="image-chip" data-chip-type="image" data-chip-path="__drag_pending_550e8400-e29b-41d4-a716-446655440000__"><span class="chip-label">拖入中...</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([])
  })

  it('空文本节点不产出空 text segment（flushText 跳过空串）', () => {
    const el = setupEl('')
    el.appendChild(document.createTextNode(''))
    expect(getSegmentsFromEl(el)).toEqual([])
  })
})

describe('moveCaretVerticalOf（jsdom 可达分支，W6 特征锚定）', () => {
  /**
   * jsdom 无布局引擎：Range rect API 缺失/全零，caretRangeFromPoint 未实现，
   * Selection.modify 未实现。注入假几何（stub Range rect 方法）驱动各分支；
   * caretRangeFromPoint 通路（多行中间行移动）不在 jsdom 覆盖面，由 renderer 行为测试兜底。
   */
  interface FakeRect {
    top: number
    bottom: number
    left: number
    right: number
    width: number
    height: number
  }

  function fakeRect(top: number, bottom: number, left = 0, right = 100): FakeRect {
    return { top, bottom, left, right, width: right - left, height: bottom - top }
  }

  const selProto = Object.getPrototypeOf(window.getSelection()) as object
  const originalGetClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
  const originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  const originalModify = Object.getOwnPropertyDescriptor(selProto, 'modify')

  let rectsImpl: () => FakeRect[]
  let boundingRectImpl: () => FakeRect
  let el: HTMLDivElement

  function installRangeStubs(): void {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: () => rectsImpl() as unknown as DOMRectList,
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: () => boundingRectImpl() as unknown as DOMRect,
    })
  }

  function restoreDescriptor(target: object, key: string, desc: PropertyDescriptor | undefined): void {
    if (desc) Object.defineProperty(target, key, desc)
    else Reflect.deleteProperty(target, key)
  }

  function setModify(impl: (...args: unknown[]) => void): void {
    Object.defineProperty(selProto, 'modify', { configurable: true, writable: true, value: impl })
  }

  /** 挂到 body（jsdom Selection 仅对文档树内元素生效）+ 光标设到文本节点 offset 处 */
  function setupCaret(html: string, offset: number): Text {
    el = setupElInBody(html)
    const textNode = el.firstChild as Text
    setCursor(textNode, offset)
    return textNode
  }

  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
    rectsImpl = () => []
    boundingRectImpl = () => fakeRect(0, 0)
    installRangeStubs()
  })

  afterEach(() => {
    restoreDescriptor(Range.prototype, 'getClientRects', originalGetClientRects)
    restoreDescriptor(Range.prototype, 'getBoundingClientRect', originalGetBoundingClientRect)
    restoreDescriptor(selProto, 'modify', originalModify)
    window.getSelection()?.removeAllRanges()
    if (el && document.body.contains(el)) document.body.removeChild(el)
  })

  it('无选区（rangeCount 0）→ at-edge 且回传原 preferredX', () => {
    el = setupElInBody('hello')
    expect(moveCaretVerticalOf(el, 'up', 7)).toEqual({ result: 'at-edge', preferredX: 7 })
  })

  it('光标不在 el 内 → at-edge', () => {
    el = setupElInBody('hello')
    const other = document.createElement('div')
    other.textContent = 'other'
    document.body.appendChild(other)
    setCursor(other.firstChild as Text, 1)
    expect(moveCaretVerticalOf(el, 'up', null)).toEqual({ result: 'at-edge', preferredX: null })
    document.body.removeChild(other)
  })

  it('视觉行 ≤1（rects 空）→ at-edge', () => {
    setupCaret('hello', 2)
    expect(moveCaretVerticalOf(el, 'down', null)).toEqual({ result: 'at-edge', preferredX: null })
  })

  it('首行再按 ↑（targetLine<0）：移到首个文本节点起点，preferredX 记录 caretRect.left', () => {
    const textNode = setupCaret('hello', 3)
    rectsImpl = () => [fakeRect(5, 15), fakeRect(15, 25)]
    boundingRectImpl = () => fakeRect(5, 15, 42, 50)
    expect(moveCaretVerticalOf(el, 'up', null)).toEqual({ result: 'moved', preferredX: 42 })
    const sel = window.getSelection()
    expect(sel?.rangeCount).toBe(1)
    expect(sel?.getRangeAt(0).startContainer).toBe(textNode)
    expect(sel?.getRangeAt(0).startOffset).toBe(0)
  })

  it('同分支但 preferredX 已有值：保持不变（?? 左侧命中）', () => {
    setupCaret('hello', 3)
    rectsImpl = () => [fakeRect(5, 15), fakeRect(15, 25)]
    boundingRectImpl = () => fakeRect(5, 15, 42, 50)
    expect(moveCaretVerticalOf(el, 'up', 100)).toEqual({ result: 'moved', preferredX: 100 })
  })

  it('已在文本起点再按 ↑ → at-edge（noop 回传参数 preferredX 而非 caretRect.left）', () => {
    setupCaret('hello', 0)
    rectsImpl = () => [fakeRect(5, 15), fakeRect(15, 25)]
    boundingRectImpl = () => fakeRect(5, 15, 42, 50)
    expect(moveCaretVerticalOf(el, 'up', null)).toEqual({ result: 'at-edge', preferredX: null })
  })

  it('末行再按 ↓（targetLine 越界）→ at-edge', () => {
    setupCaret('hello', 2)
    rectsImpl = () => [fakeRect(5, 15), fakeRect(15, 25)]
    boundingRectImpl = () => fakeRect(15, 25, 42, 50)
    expect(moveCaretVerticalOf(el, 'down', null)).toEqual({ result: 'at-edge', preferredX: null })
  })

  it('caret top 不命中任何行 ±1 → 退化取行中心最近行（midpoint fallback）', () => {
    setupCaret('hello', 3)
    rectsImpl = () => [fakeRect(5, 15), fakeRect(15, 25)]
    // top=12：top±1 无命中；中心 10/20 距离 2/8 → currentLine=0 → ↑ 回首行文本起点
    boundingRectImpl = () => fakeRect(12, 13, 30, 40)
    expect(moveCaretVerticalOf(el, 'up', null)).toEqual({ result: 'moved', preferredX: 30 })
  })

  describe('零 rect 探测失败 → sel.modify 行移动兜底（stub Selection.modify）', () => {
    it('modify 后位置未变 → at-edge', () => {
      setupCaret('hello', 1)
      rectsImpl = () => [fakeRect(0, 10), fakeRect(10, 20)]
      boundingRectImpl = () => fakeRect(0, 0)
      const modify = vi.fn()
      setModify(modify)
      expect(moveCaretVerticalOf(el, 'up', null)).toEqual({ result: 'at-edge', preferredX: null })
      expect(modify).toHaveBeenCalledTimes(1)
      expect(modify).toHaveBeenCalledWith('move', 'up', 'line')
      // ZWSP 探针已自清理（insert → remove → normalize），DOM 无残留
      expect(el.textContent).toBe('hello')
    })

    it('modify 后位置变化 → moved（回传参数 preferredX）', () => {
      setupCaret('hello', 1)
      rectsImpl = () => [fakeRect(0, 10), fakeRect(10, 20)]
      boundingRectImpl = () => fakeRect(0, 0)
      setModify(() => {
        const s = window.getSelection()
        const t = el.firstChild as Text
        s?.removeAllRanges()
        const r = document.createRange()
        r.setStart(t, 0)
        r.collapse(true)
        s?.addRange(r)
      })
      expect(moveCaretVerticalOf(el, 'up', 7)).toEqual({ result: 'moved', preferredX: 7 })
      expect(el.textContent).toBe('hello')
    })
  })
})
