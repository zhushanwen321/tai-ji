/**
 * remove-active-token.ts 单测 —— 活跃域 token 文本定位删除助手（设计 D2b 终态机制 2 的行为锁）。
 *
 * 六断言面（任务 U1 验收 + U2 前置行为锁）：
 *   1. 带域约束定位：slash（行首）与 skill（行中空白后）同符号异约束互不串扰
 *   2. escapeRegExp 元字符：query 含 `.` 时按字面精确匹配（未转义会正则语义漂移误匹配）
 *   3. 单 text node 匹配域：token 被 chip 分裂（跨 node）不匹配（0 命中跳过）
 *   4. 非唯一命中 no-op：两处同文不动 DOM、不调 onChanged
 *   5. 空 query 边界：纯触发符（`/`）正则退化为纯域约束形，唯一命中即删
 *   6. onChanged 同步：删除成功被调用恰好一次（DOM 删除必须通知 draft），no-op 不调用
 *   补充：chip 子树文本（chip-label 的 /xx）不在匹配域——防「正文 token + 已插 chip 同文」
 *   被误判非唯一命中而永远清不掉（SM 注入链既有 chip 场景的回归锁）
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/remove-active-token.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  removeActiveTokenText,
  ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES,
} from './remove-active-token'

/** 构造 contenteditable div + innerHTML 并挂 document.body（jsdom Selection API 仅对 document 树内元素生效） */
function setupElInBody(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

/** 取 el 内全部非 chip 子树 text node 文本（拼接断言用） */
function textNodesOutsideChips(el: HTMLElement): string[] {
  const out: string[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node as Text).parentElement?.closest('.slash-chip, .mention-chip')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  let n = walker.nextNode()
  while (n) {
    out.push(n.textContent ?? '')
    n = walker.nextNode()
  }
  return out
}

describe('removeActiveTokenText（D2b 文本定位删除）', () => {
  let el: HTMLDivElement | null = null
  const onChanged = vi.fn()

  beforeEach(() => {
    onChanged.mockClear()
  })
  afterEach(() => {
    el?.remove()
    el = null
    window.getSelection()?.removeAllRanges()
  })

  it('断言 1（带域约束定位）：slash 行首域命中删除；行中同文不被 slash 域误匹配（skill 域才命中）', () => {
    // 行首 `/compact`（slash 域触发形态）：唯一命中 → 删除「/ + query」，返回 true
    el = setupElInBody('/compact')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(true)
    expect(textNodesOutsideChips(el)).toEqual([''])
    expect(onChanged).toHaveBeenCalledTimes(1)

    // 行中 `first /compact`：slash 域（行首约束）不命中 → no-op（0 命中跳过）
    onChanged.mockClear() // 段间清零：本段断言 no-op 零通知
    el = setupElInBody('first /compact')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(false)
    expect(textNodesOutsideChips(el)).toEqual(['first /compact'])
    expect(onChanged).not.toHaveBeenCalled()

    // 同文本换成 skill 域（行中空白后约束）：命中，删除 `/compact`、边界空格保留
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.skill,
        query: 'compact',
        onChanged,
      }),
    ).toBe(true)
    expect(textNodesOutsideChips(el)).toEqual(['first '])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('断言 2（escapeRegExp 元字符）：query 含 `.` 按字面精确匹配，不误匹配 `+` 等任意字符', () => {
    // 字面 `$config.x` 存在：`.` 转义后精确命中（file 域），删除 `$config.x` 留尾部
    el = setupElInBody('see $config.x tail')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.file,
        query: 'config.x',
        onChanged,
      }),
    ).toBe(true)
    expect(textNodesOutsideChips(el)).toEqual(['see  tail'])
    expect(onChanged).toHaveBeenCalledTimes(1)

    // 只有 `$config+x`（无字面 `.`）：未转义的 `.` 会匹配 `+` 误删；转义正确则 0 命中 no-op
    onChanged.mockClear() // 段间清零：本段断言 no-op 零通知
    el = setupElInBody('see $config+x tail')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.file,
        query: 'config.x',
        onChanged,
      }),
    ).toBe(false)
    expect(textNodesOutsideChips(el)).toEqual(['see $config+x tail'])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('断言 3（单 text node 匹配域）：token 被 chip 分裂跨 node → 0 命中 no-op；完整落在单 node 内 → 命中', () => {
    // `/co` + chip + `mmand`：query='compact' 跨 node 不拼合 → 0 命中（安全方向：跳过退归残留代价面）
    el = setupElInBody(
      '/co<span class="slash-chip" contenteditable="false"><span class="chip-label">x</span></span>mmand',
    )
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(false)
    expect(textNodesOutsideChips(el)).toEqual(['/co', 'mmand'])
    expect(onChanged).not.toHaveBeenCalled()

    // 对照：query 完整落在单 node（`/co`，node 尾即右边界）→ 命中删除，另一 node 不动
    onChanged.mockClear() // 段间清零：本段断言命中通知一次
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'co',
        onChanged,
      }),
    ).toBe(true)
    expect(textNodesOutsideChips(el)).toEqual(['', 'mmand'])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('断言 4（非唯一命中 no-op）：两 node 各一处同文 → 不动 DOM、不调 onChanged', () => {
    // 两行 `/compact`（块级 div 分行 = 两个 text node）：无法消歧位置 → no-op
    el = setupElInBody('/compact<div>/compact</div>')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(false)
    expect(textNodesOutsideChips(el)).toEqual(['/compact', '/compact'])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('断言 5（空 query 边界）：纯触发符 `/` 正则退化为纯域约束形，唯一命中即删', () => {
    // 只输触发符（query=''）：命中行首 `/`（后跟串尾）→ 删除触发符本身，注入 chip 替代它
    el = setupElInBody('/')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: '',
        onChanged,
      }),
    ).toBe(true)
    expect(textNodesOutsideChips(el)).toEqual([''])
    expect(onChanged).toHaveBeenCalledTimes(1)

    // 空 query 非唯一（两处行首 `/`）同样 no-op（非唯一规则先于删除生效）
    onChanged.mockClear() // 段间清零：本段断言 no-op 零通知
    el = setupElInBody('/<div>/</div>')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: '',
        onChanged,
      }),
    ).toBe(false)
    expect(textNodesOutsideChips(el)).toEqual(['/', '/'])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('断言 6（onChanged 同步）：删除成功后恰好调用一次（DOM 删除必须通知 draft ref）', () => {
    // 独立场景（session 域 # token）重复锁通知契约：onChanged 在 DOM 删除完成后、返回前被调
    el = setupElInBody('note #design tail')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.session,
        query: 'design',
        onChanged,
      }),
    ).toBe(true)
    // DOM 已删（通知时读取到的应是删除后状态）
    expect(textNodesOutsideChips(el)).toEqual(['note  tail'])
    expect(onChanged).toHaveBeenCalledTimes(1)
    // 光标落删除点（删除后的选区产出；定位不依赖进入时的光标）
    const sel = window.getSelection()
    expect(sel?.isCollapsed).toBe(true)
    expect(el.contains(sel?.anchorNode ?? null)).toBe(true)
  })

  it('补充（chip 子树不在匹配域）：chip-label 同文 `/compact` 不计入命中——正文 token 仍唯一可删', () => {
    // SM 注入链既有场景：chip（`/commit` 类）已插 + 正文残留活跃 token——chip label 的
    // `/compact` 文本不得参与计数，否则永远非唯一、活跃残留永远清不掉
    el = setupElInBody(
      '<span class="slash-chip" contenteditable="false"><span class="chip-label">/compact</span></span>/compact',
    )
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(true)
    // chip label 完好，正文 token 已删
    expect(el.querySelector('.slash-chip .chip-label')?.textContent).toBe('/compact')
    expect(textNodesOutsideChips(el)).toEqual([''])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('边界（el null）：直接 no-op 返回 false，不调 onChanged', () => {
    expect(
      removeActiveTokenText({
        el: null,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('边界（右边界拒绝前缀匹配）：`/compact` 不命中 `/compact2`（query 后须空白或串尾）', () => {
    el = setupElInBody('/compact2')
    expect(
      removeActiveTokenText({
        el,
        domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES.slash,
        query: 'compact',
        onChanged,
      }),
    ).toBe(false)
    expect(textNodesOutsideChips(el)).toEqual(['/compact2'])
    expect(onChanged).not.toHaveBeenCalled()
  })
})
