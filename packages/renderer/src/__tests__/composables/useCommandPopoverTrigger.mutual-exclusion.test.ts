/**
 * useCommandPopoverTrigger + find-in-surface 合并文件（簇 3-3 A 组，5 源合一，DOM 环境）：
 * - useCommandPopoverTrigger.mutual-exclusion.test.ts —— SM 互斥 + D2b 注入前清理（真实 DOM 组装）
 * - useCommandPopoverTrigger.slash-skill.test.ts —— slash/skill 触发分支（spy 脚手架）
 * - find/dom-locator.test.ts —— DOM 定位契约
 * - find/highlight-painter.test.ts —— CSS Custom Highlight API painter
 * - find/useFindInSurface.test.ts —— find 单例状态流转
 *
 * 五源零 vi.mock、全默认 DOM 环境；各节 beforeEach/afterEach 与 helper 下沉节内。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref, nextTick, type Ref } from 'vue'

import { useSearchModal, resetSearchModal } from '@taiji/core'
import {
  useContenteditableInput,
  useComposerChipCommands,
  getSegmentsFromEl,
} from '@taiji/dom-core/composer/input'
import { segmentsToText } from '@taiji/shared'

import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import {
  useCommandStore,
  __testing,
} from '@/composables/features/command/useCommandStore'
import { locateInDom } from '@/composables/features/find/dom-locator'
import { clearHits, paintHits } from '@/composables/features/find/highlight-painter'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'

// ═══ 来源节：useCommandPopoverTrigger.mutual-exclusion.test.ts —— SM 互斥 + D2b 注入前清理（真实 DOM 组装） ═══
describe('useCommandPopoverTrigger.mutual-exclusion', () => {
  /**
   * el 内全部非 chip 子树 text node 文本（残留明文断言用——chip label 的 /xx 是结构化段非明文）。
   * 过滤对齐 getSegmentsFromEl 的正文语义：ZWSP spacer（chip 后光标锚点，chip 子树外的
   * text node）删除、空 node（删除后残留的空文本节点）不计数——两者均非用户明文。
   */
  function plainTextOutsideChips(el: HTMLElement): string {
    const out: string[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        (node as Text).parentElement?.closest('.slash-chip, .mention-chip')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    })
    let n = walker.nextNode()
    while (n) {
      const text = (n.textContent ?? '').replace(/\u200B/g, '')
      if (text) out.push(text)
      n = walker.nextNode()
    }
    return out.join('\n')
  }

  /** 发送序列化（segmentsToText 归首语义——「恰为所选命令」断言的权威链） */
  function serialize(el: HTMLElement): string {
    return segmentsToText(getSegmentsFromEl(el as HTMLDivElement))
  }

  /** 在独立 effectScope 内运行 composable（watch 需 scope） */
  function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
    const scope = effectScope()
    let result!: T
    scope.run(() => {
      result = fn()
    })
    return { result, dispose: () => scope.stop() }
  }

  /**
   * 真实 DOM 组装的 ComposerInput 等价件：contenteditable el + dom-core 真实 composable。
   * inputInstance 暴露 useCommandPopoverTrigger 消费方（getInputElement/insertSlashChip/
   * insertSkillChip/focus）；draft ref 对齐 ComposerInput 的 emit('input', getText()) 链。
   */
  function setupRealComposer(html: string, sessionId = 'sid-1') {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    el.innerHTML = html
    document.body.appendChild(el)
    const elRef = ref<HTMLDivElement | null>(el)
    const draft = ref('')

    const content = useContenteditableInput(elRef, {
      onInput: (text) => {
        draft.value = text
      },
      onSlashTrigger: () => {},
      onFileTrigger: () => {},
      onEnterKeydown: () => {},
      onKeydown: () => {},
      handleBackspaceOnChip: () => false,
      insertImageBadge: () => {},
      getSessionId: () => sessionId,
      pasteImage: async () => ({ kind: 'text' as const, text: '' }),
    })
    const chips = useComposerChipCommands(elRef, {
      onChanged: content.onInput,
      restoreSelection: content.restoreSelection,
      renderIcon: () => false,
      t: (k: string) => k,
    })

    const inputInstance = {
      getInputElement: () => el,
      insertSlashChip: chips.insertSlashChip,
      insertSkillChip: chips.insertSkillChip,
      focus: () => el.focus(),
    }
    const sessionIdRef: Ref<string | null> = ref(sessionId)
    const { result, dispose } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputInstance) as never, sessionIdRef as never),
    )
    return { result, el, draft, sessionIdRef, dispose }
  }

  /** SM confirm 注入的等价驱动：requestSlashInjection + flush pendingSlash 消费 watch */
  async function confirmInject(command: string, sessionId: string | null): Promise<void> {
    useCommandStore().requestSlashInjection({ command, sessionId })
    await nextTick()
  }

  /** 每用例前置重置（两 describe 共用单点）：新 pinia + SM 重置 + command store 重置 */
  function resetTriggerTestState(): void {
    setActivePinia(createPinia())
    resetSearchModal()
    __testing.__resetCommandStoreForTesting()
  }

  /** 每用例收尾（ctx 生命周期 + 选区清理） */
  function cleanupComposerCtx(ctx: ReturnType<typeof setupRealComposer>): void {
    ctx.dispose()
    ctx.el.remove()
    window.getSelection()?.removeAllRanges()
  }

  describe('useCommandPopoverTrigger SM 互斥（D1 单向状态互斥）', () => {
    let ctx: ReturnType<typeof setupRealComposer>

    beforeEach(() => {
      resetTriggerTestState()
    })
    afterEach(() => {
      cleanupComposerCtx(ctx)
    })

    it('isOpen 转 true → cmdOpen 置 false（sync 同拍，无需 tick）', () => {
      ctx = setupRealComposer('/compact')
      ctx.result.onSlashTrigger({ query: 'compact' })
      expect(ctx.result.cmdOpen.value).toBe(true)

      useSearchModal().open()
      // flush:'sync'：open 赋值同一拍内完成互斥（⌘K 后下一次按键前 capture 门已失效）
      expect(ctx.result.cmdOpen.value).toBe(false)
    })

    it('isOpen 转 false → cmdOpen 不变（单向：SM 关闭后浮层不自动恢复）', () => {
      ctx = setupRealComposer('/compact')
      const sm = useSearchModal()

      // 对照：无 SM 时浮层正常开（既有触发语义不受互斥影响）
      ctx.result.onSlashTrigger({ query: 'compact' })
      expect(ctx.result.cmdOpen.value).toBe(true)

      sm.open() // 互斥：浮层关
      expect(ctx.result.cmdOpen.value).toBe(false)
      sm.close() // close 边沿不动 cmdOpen（D2：不替用户决定仍在命令语境）
      expect(ctx.result.cmdOpen.value).toBe(false)
    })

    it('互斥不动触发域标记（active/query 保留——冻结检查与 D2b 职责范围的锚）', () => {
      ctx = setupRealComposer('/compact')
      ctx.result.onSlashTrigger({ query: 'compact' })
      useSearchModal().open()
      expect(ctx.result.cmdOpen.value).toBe(false)
      // active/query 不被互斥清除：D2b 清理链依赖活跃域判定
      expect(ctx.result.slashQuery.value).toBe('compact')
    })
  })

  describe('useCommandPopoverTrigger D2b 注入前清理（pendingSlash 消费链五向）', () => {
    let ctx: ReturnType<typeof setupRealComposer>

    beforeEach(() => {
      resetTriggerTestState()
    })
    afterEach(() => {
      cleanupComposerCtx(ctx)
    })

    it('① 正向效果：活跃 slash 域 confirm 注入后无残留明文 + 序列化恰为所选命令 + draft 同步', async () => {
      ctx = setupRealComposer('/compact')
      ctx.result.onSlashTrigger({ query: 'compact' }) // 活跃 slash 域（浮层 open）
      useSearchModal().open() // ⌘K：互斥关浮层 + 冻结 sessionId

      await confirmInject('/commit', 'sid-1')

      // 无残留明文：非 chip 文本不含 /compact（不做则残留当 args → `/commit /compact` 垃圾参数）
      expect(plainTextOutsideChips(ctx.el)).toBe('')
      // 序列化恰为所选命令（chip 注入 + 归首；效果断言非 spy 调用序）
      expect(serialize(ctx.el)).toBe('/commit')
      // draft ref 同步（删除后 onChanged → emitInput(getText()) 已通知——DOM 与 draft 一致，防脱钩）
      expect(ctx.draft.value).toBe('/commit')
      // 消费完成：通道被清 + 浮层仍关
      expect(useCommandStore().pendingSlash.value).toBeNull()
      expect(ctx.result.cmdOpen.value).toBe(false)
    })

    it('② 失活边界：`/rev $f`（$ 域活跃、/rev 失活）confirm 后 `$f` 被清、`/rev` 保留', async () => {
      ctx = setupRealComposer('/rev $f')
      // slash 域开过又关（空格后触发终止）——失活历史 token 出 D2b 职责范围
      ctx.result.onSlashTrigger({ query: 'rev' })
      ctx.result.onSlashTrigger(null)
      ctx.result.onFileTrigger({ query: 'f' }) // $ 域活跃
      useSearchModal().open()

      await confirmInject('/commit', 'sid-1')

      // $f（活跃残渣）被清；/rev（失活 token = 草稿正文同族）保留
      expect(plainTextOutsideChips(ctx.el)).toBe('/rev ')
      const text = serialize(ctx.el)
      expect(text.startsWith('/commit')).toBe(true)
      expect(text).toContain('/rev')
      expect(text).not.toContain('$f')
    })

    it('③a 非唯一命中跳过：两行同文 `/compact` confirm 后两处均保留（no-op 规则锁）', async () => {
      ctx = setupRealComposer('/compact<div>/compact</div>')
      ctx.result.onSlashTrigger({ query: 'compact' })
      useSearchModal().open()

      await confirmInject('/commit', 'sid-1')

      // 两处同文无法消歧位置 → 不动 DOM（误删失活历史 token = 改写用户草稿，双输）
      expect(plainTextOutsideChips(ctx.el).split('\n')).toEqual(['/compact', '/compact'])
      // 注入本身仍发生（chip 已插，非唯一只跳过清理不阻断注入）
      expect(serialize(ctx.el).startsWith('/commit')).toBe(true)
      expect(useCommandStore().pendingSlash.value).toBeNull()
    })

    it('③b 元字符 query：`$config.x` 唯一命中正确删除（`.` 转义——漏转义是静默退化无红灯）', async () => {
      ctx = setupRealComposer('see $config.x')
      ctx.result.onFileTrigger({ query: 'config.x' })
      useSearchModal().open()

      await confirmInject('/commit', 'sid-1')

      // query 含 `.` 按字面精确匹配删除；未转义会正则漂移（如误吞 $config+x 或删不中）
      expect(plainTextOutsideChips(ctx.el)).toBe('see ')
      // 尾空格 = $ 前边界空白保留（删除助手对齐 clear 家族 boundaryLen 语义，属正确行为）
      expect(serialize(ctx.el)).toBe('/commit see ')
    })

    it('④ session 冻结：SM open 后切 session，消费注入但不清理他 session 文本', async () => {
      ctx = setupRealComposer('/rev $f')
      ctx.result.onFileTrigger({ query: 'f' })
      useSearchModal().open() // 冻结 sid-1

      ctx.sessionIdRef.value = 'sid-2' // ⌘N 切 session（冻结的 active/query 与新文本静默脱钩）
      await confirmInject('/commit', 'sid-2')

      // 注入发生（req.sessionId 匹配当前 session，chip 已插 + 通道被清）……
      expect(serialize(ctx.el).startsWith('/commit')).toBe(true)
      expect(useCommandStore().pendingSlash.value).toBeNull()
      // ……但清理被冻结检查跳过（不误删他 session 草稿的同形 token）
      expect(plainTextOutsideChips(ctx.el)).toBe('/rev $f')
    })

    it('⑤a 跨 text node 分裂：token 被 chip 分裂（`/co<chip>mmand`）按单 node 匹配 0 命中跳过', async () => {
      ctx = setupRealComposer(
        '/co<span class="slash-chip" contenteditable="false" data-chip-type="skill" data-chip-name="x"><span class="chip-label">x</span></span>mmand',
      )
      ctx.result.onSlashTrigger({ query: 'compact' })
      useSearchModal().open()

      await confirmInject('/commit', 'sid-1')

      // 分裂 token 不跨 node 拼合 → 0 命中 → 安全方向跳过（退归残留代价面）
      expect(plainTextOutsideChips(ctx.el).split('\n')).toEqual(['/co', 'mmand'])
      // 注入仍发生（新命令 chip 已插）
      expect(serialize(ctx.el).startsWith('/commit')).toBe(true)
    })

    it('⑤b 空 query 边界：只输 `/`（query 空串）confirm 注入后触发符被清（唯一命中即删）', async () => {
      ctx = setupRealComposer('/')
      ctx.result.onSlashTrigger({ query: '' })
      useSearchModal().open()

      await confirmInject('/commit', 'sid-1')

      // 纯触发符：正则退化为纯域约束形，唯一命中即删（token 就是触发符本身，chip 替代它）
      expect(plainTextOutsideChips(ctx.el)).toBe('')
      expect(serialize(ctx.el)).toBe('/commit')
      expect(ctx.draft.value).toBe('/commit')
    })
  })
})

// ═══ 来源节：useCommandPopoverTrigger.slash-skill.test.ts —— slash/skill 触发分支（spy 脚手架） ═══
describe('useCommandPopoverTrigger.slash-skill', () => {
  /** inputRef mock：spy 覆盖本测试触达的插入/清除/焦点方法 */
  function createInputMock() {
    return {
      focus: vi.fn(),
      saveSelection: vi.fn(),
      clearSlashQueryText: vi.fn(),
      insertSlashChip: vi.fn(),
      clearSkillQueryText: vi.fn(),
      insertSkillChip: vi.fn(),
    }
  }

  /** 在独立 effectScope 内运行 composable（watch 等需 scope） */
  function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
    const scope = effectScope()
    let result!: T
    scope.run(() => {
      result = fn()
    })
    return { result, dispose: () => scope.stop() }
  }

  describe('useCommandPopoverTrigger slash/skill 触发（/ 两触发域路径）', () => {
    let dispose: (() => void) | undefined

    beforeEach(() => {
      setActivePinia(createPinia())
    })
    afterEach(() => {
      dispose?.()
      dispose = undefined
    })

    function setup() {
      const inputMock = createInputMock()
      const { result, dispose: d } = runWithScope(() =>
        useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
      )
      dispose = d
      return { result, inputMock }
    }

    it('onSlashTrigger({query}) → cmdType=slash 开浮层记 query；trigger(null) → 关闭', () => {
      const { result } = setup()
      expect(result.cmdOpen.value).toBe(false)

      result.onSlashTrigger({ query: 'he' })
      expect(result.cmdOpen.value).toBe(true)
      expect(result.cmdType.value).toBe('slash')
      expect(result.slashQuery.value).toBe('he')

      // 触发路径打开的浮层：trigger(null) 关闭（符号后遇空格等终止场景）
      result.onSlashTrigger(null)
      expect(result.cmdOpen.value).toBe(false)
    })

    it('onSkillTrigger({query}) → cmdType=skill 开浮层记 query；trigger(null) → 关闭', () => {
      const { result } = setup()

      result.onSkillTrigger({ query: 're' })
      expect(result.cmdOpen.value).toBe(true)
      expect(result.cmdType.value).toBe('skill')
      expect(result.skillQuery.value).toBe('re')

      result.onSkillTrigger(null)
      expect(result.cmdOpen.value).toBe(false)
    })

    it('未触发路径：初始关闭态下 trigger(null) 无副作用（不开浮层、状态保持）', () => {
      const { result } = setup()

      result.onSlashTrigger(null)
      expect(result.cmdOpen.value).toBe(false)
      expect(result.cmdType.value).toBe('file') // 默认类型不变

      result.onSkillTrigger(null)
      expect(result.cmdOpen.value).toBe(false)
    })

    it('触发域互斥：slash 浮层开着再遇 skill 触发 → cmdType 切 skill、浮层保持开（同刻单浮层）', () => {
      const { result } = setup()

      result.onSlashTrigger({ query: 'he' })
      expect(result.cmdOpen.value).toBe(true)
      expect(result.cmdType.value).toBe('slash')

      result.onSkillTrigger({ query: 're' })
      expect(result.cmdOpen.value).toBe(true) // 浮层不闪关
      expect(result.cmdType.value).toBe('skill')
      expect(result.skillQuery.value).toBe('re')
      // slash 触发态被 skill 接管后，slash 路 null 不再关浮层（触发态各路独立）
      result.onSkillTrigger(null)
      expect(result.cmdOpen.value).toBe(false)
    })

    it('+ 菜单 slash 路径：开浮层但不设触发态 → 后续 onSlashTrigger(null) 不误关浮层', async () => {
      const { result, inputMock } = setup()

      await result.onAddSelect('slash')
      expect(inputMock.saveSelection).toHaveBeenCalledTimes(1)
      expect(inputMock.focus).toHaveBeenCalledTimes(1)
      expect(result.cmdOpen.value).toBe(true)
      expect(result.cmdType.value).toBe('slash')

      // + 菜单路径未设触发态：输入区 slash 触发终止信号（null）不得误关浮层
      result.onSlashTrigger(null)
      expect(result.cmdOpen.value).toBe(true)
    })
  })
})

// ═══ 来源节：find/dom-locator.test.ts —— DOM 定位契约 ═══
describe('find/dom-locator', () => {
  function mount(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('locateInDom', () => {
    it('空 query 返回 []', () => {
      const host = mount('<p>hello</p>')
      expect(locateInDom(host, '')).toEqual([])
    })

    it('无命中返回 []', () => {
      const host = mount('<p>hello world</p>')
      expect(locateInDom(host, 'xyz')).toEqual([])
    })

    it('单节点命中：大小写不敏感，range 覆盖命中区间', () => {
      const host = mount('<p>Hello World</p>')
      const ranges = locateInDom(host, 'WORLD')
      expect(ranges).toHaveLength(1)
      expect(ranges[0].toString()).toBe('World')
    })

    it('跨节点拼接命中：命中跨越相邻文本节点（inline 标签切开）', () => {
      const host = mount('<p>Hello <b>World</b></p>')
      // "o Wor"：前半在 "Hello " 文本节点，后半在 <b> 内文本节点——单节点扫描必漏
      const ranges = locateInDom(host, 'o Wor')
      expect(ranges).toHaveLength(1)
      expect(ranges[0].toString()).toBe('o Wor')
      expect(ranges[0].startContainer.nodeType).toBe(Node.TEXT_NODE)
      expect(ranges[0].startContainer.parentElement?.tagName).toBe('P')
      expect(ranges[0].endContainer.parentElement?.tagName).toBe('B')
    })

    it('多命中：返回全部出现位置', () => {
      const host = mount('<p>ab cd ab</p>')
      const ranges = locateInDom(host, 'ab')
      expect(ranges).toHaveLength(2)
      expect(ranges.map((r) => r.toString())).toEqual(['ab', 'ab'])
    })

    it('命中不重叠："aaa" 搜 "aa" 报 1 个（步进命中长度）', () => {
      const host = mount('<p>aaa</p>')
      expect(locateInDom(host, 'aa')).toHaveLength(1)
    })

    it('data-find-skip 子树整体排除（终端等第一期排除区）', () => {
      const host = mount(
        '<div><span>needle here</span><div data-find-skip><span>needle</span></div></div>',
      )
      const ranges = locateInDom(host, 'needle')
      expect(ranges).toHaveLength(1)
      expect(ranges[0].toString()).toBe('needle')
      // 剩下的那一个来自 skip 之外的 span
      expect(ranges[0].startContainer.parentElement?.closest('[data-find-skip]')).toBeNull()
    })

    it('script 内容排除', () => {
      const host = mount('<div><script>const needle = 1</script><span>needle</span></div>')
      const ranges = locateInDom(host, 'needle')
      expect(ranges).toHaveLength(1)
      expect(ranges[0].startContainer.parentElement?.tagName).toBe('SPAN')
    })

    it('块级边界不拼接命中：前块尾 + 后块头拼出的串零命中（浏览器 Ctrl+F 惯例）', () => {
      // 前段尾 "do" + 后段首 "ne" 在视觉上是两段文字，不构成连续的 "done"
      const host = mount('<p>do</p><p>ne</p>')
      expect(locateInDom(host, 'done')).toEqual([])
    })

    it('块级边界不破坏块内命中：相邻两块各自命中独立计数', () => {
      const host = mount('<p>done</p><p>done</p>')
      const ranges = locateInDom(host, 'done')
      expect(ranges).toHaveLength(2)
      expect(ranges.map((r) => r.toString())).toEqual(['done', 'done'])
    })

    it('表格单元格为独立块：跨单元格拼接零命中，单元格内命中正常', () => {
      const host = mount('<table><tr><td>do</td><td>ne</td></tr></table>')
      expect(locateInDom(host, 'done')).toEqual([])
      const ranges = locateInDom(host, 'do')
      expect(ranges).toHaveLength(1)
      expect(ranges[0].startContainer.parentElement?.tagName).toBe('TD')
    })
  })
})

// ═══ 来源节：find/highlight-painter.test.ts —— CSS Custom Highlight API painter ═══
describe('find/highlight-painter', () => {
  /** CSS.highlights 注册表的测试读点（painter 写入的最小 mock） */
  function registry(): Map<string, unknown> {
    const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS
    return css!.highlights as Map<string, unknown>
  }

  /** Highlight 构造参数记录（断言 painter 传入了哪些 range） */
  class FakeHighlight {
    static lastArgs: unknown[] = []
    constructor(...ranges: unknown[]) {
      FakeHighlight.lastArgs = ranges
    }
  }

  function installHighlightApi(): void {
    ;(globalThis as { CSS?: unknown }).CSS = { highlights: new Map() }
    ;(globalThis as { Highlight?: unknown }).Highlight = FakeHighlight
  }

  function makeRange(live: boolean): Range {
    const host = document.createElement('span')
    host.textContent = 'needle'
    document.body.appendChild(host)
    const range = document.createRange()
    range.selectNodeContents(host)
    if (!live) host.remove() // startContainer 离开文档 = 失效 range（重渲染替换后的快照残留）
    return range
  }

  afterEach(() => {
    delete (globalThis as { CSS?: unknown }).CSS
    delete (globalThis as { Highlight?: unknown }).Highlight
    document.body.innerHTML = ''
  })

  describe('paintHits', () => {
    it('正常绘制：find-hits 收非 active 命中，find-active 收 active 命中', () => {
      installHighlightApi()
      const r1 = makeRange(true)
      const r2 = makeRange(true)
      paintHits([r1, r2], 1)
      expect(registry().get('find-hits')).toBeInstanceOf(FakeHighlight)
      expect(registry().get('find-active')).toBeInstanceOf(FakeHighlight)
    })

    it('activeIndex -1：只画 find-hits，且清掉残留的 find-active', () => {
      installHighlightApi()
      const r1 = makeRange(true)
      registry().set('find-active', new FakeHighlight())
      paintHits([r1], -1)
      expect(registry().has('find-active')).toBe(false)
      expect(registry().has('find-hits')).toBe(true)
    })

    it('activeIndex 越界：等同无效，不画 find-active', () => {
      installHighlightApi()
      const r1 = makeRange(true)
      paintHits([r1], 5)
      expect(registry().has('find-active')).toBe(false)
    })

    it('失效 range 防御：startContainer 不在文档中的命中被跳过不画', () => {
      installHighlightApi()
      const live = makeRange(true)
      const dead = makeRange(false)
      paintHits([dead, live], -1)
      expect(registry().get('find-hits')).toBeInstanceOf(FakeHighlight)
      // find-hits 的 Highlight 只收到 1 个 live range
      expect(FakeHighlight.lastArgs).toEqual([live])
    })

    it('active 命中失效：不画 find-active，其余命中照画', () => {
      installHighlightApi()
      const live = makeRange(true)
      const dead = makeRange(false)
      paintHits([live, dead], 1)
      expect(registry().has('find-active')).toBe(false)
      expect(registry().has('find-hits')).toBe(true)
    })

    it('CSS.highlights API 不存在（旧环境）：静默 no-op 不抛错', () => {
      delete (globalThis as { CSS?: unknown }).CSS
      expect(() => paintHits([makeRange(true)], 0)).not.toThrow()
      expect(() => clearHits()).not.toThrow()
    })
  })

  describe('clearHits', () => {
    it('清除 find-hits 与 find-active 两个注册键', () => {
      installHighlightApi()
      registry().set('find-hits', new FakeHighlight())
      registry().set('find-active', new FakeHighlight())
      clearHits()
      expect(registry().size).toBe(0)
    })
  })
})

// ═══ 来源节：find/useFindInSurface.test.ts —— find 单例状态流转 ═══
describe('find/useFindInSurface', () => {
  const find = useFindInSurface()

  function mountSurface(kind: string): HTMLElement {
    const host = document.createElement('div')
    host.setAttribute('data-find-surface', kind)
    host.innerHTML = '<p>foo bar foo</p>'
    document.body.appendChild(host)
    return host
  }

  function mockElementFromPoint(el: Element | null): void {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(el as HTMLElement | null)
  }

  /** 模拟指针移动（悬停归属的数据源 = window pointermove 坐标） */
  function movePointer(x: number, y: number): void {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))
  }

  beforeEach(() => {
    find.close()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('open / close / search 状态流转', () => {
    it('open：置 isOpen + surfaceKind，重置旧现场（query/命中）', () => {
      mountSurface('right-drawer')
      find.open('right-drawer')
      find.query.value = 'foo'
      find.search()
      expect(find.hitCount.value).toBe(2)

      find.open('bottom-drawer')
      expect(find.isOpen.value).toBe(true)
      expect(find.surfaceKind.value).toBe('bottom-drawer')
      expect(find.query.value).toBe('')
      expect(find.hitCount.value).toBe(0)
    })

    it('同 kind 重复 open：保留现场（query 不清）', () => {
      mountSurface('right-drawer')
      find.open('right-drawer')
      find.query.value = 'foo'
      find.search()
      find.open('right-drawer')
      expect(find.query.value).toBe('foo')
      expect(find.hitCount.value).toBe(2)
    })

    it('search：命中计数 + activeIndex 落 0', () => {
      mountSurface('right-drawer')
      find.open('right-drawer')
      find.query.value = 'foo'
      find.search()
      expect(find.hitCount.value).toBe(2)
      expect(find.activeIndex.value).toBe(0)
    })

    it('search：空 query → 0 命中', () => {
      mountSurface('right-drawer')
      find.open('right-drawer')
      find.search()
      expect(find.hitCount.value).toBe(0)
      expect(find.activeIndex.value).toBe(-1)
    })

    it('search：表面根元素不在文档（表面已关）→ 清结果不报错', () => {
      find.open('right-drawer')
      find.query.value = 'foo'
      expect(() => find.search()).not.toThrow()
      expect(find.hitCount.value).toBe(0)
    })

    it('next/prev：循环导航（尾→首 / 首→尾）', () => {
      mountSurface('right-drawer')
      find.open('right-drawer')
      find.query.value = 'foo'
      find.search()
      expect(find.activeIndex.value).toBe(0)
      find.next()
      expect(find.activeIndex.value).toBe(1)
      find.next()
      expect(find.activeIndex.value, '尾部 next 回绕到首').toBe(0)
      find.prev()
      expect(find.activeIndex.value, '首部 prev 回绕到尾').toBe(1)
    })

    it('close：全清（isOpen/query/命中/高亮归属），且幂等', () => {
      mountSurface('right-drawer')
      find.open('right-drawer')
      find.query.value = 'foo'
      find.search()
      find.close()
      expect(find.isOpen.value).toBe(false)
      expect(find.surfaceKind.value).toBe('')
      expect(find.query.value).toBe('')
      expect(find.hitCount.value).toBe(0)
      expect(find.activeIndex.value).toBe(-1)
      expect(() => find.close()).not.toThrow()
    })
  })

  describe('openFindAtPointer 归属判定', () => {
    it('悬停优先：指针在 bottom-drawer 表面内 → 开 bottom-drawer（即使 overlay 也在文档）', () => {
      const overlayEl = mountSurface('overlay')
      const bottomEl = mountSurface('bottom-drawer')
      mockElementFromPoint(bottomEl.querySelector('p')!)
      movePointer(10, 10)
      find.openFindAtPointer()
      expect(find.surfaceKind.value).toBe('bottom-drawer')
      expect(overlayEl.isConnected).toBe(true)
    })

    it('回退栈序：悬停不在任何可搜表面 → overlay > bottom-drawer > right-drawer 取第一个在文档的', () => {
      mockElementFromPoint(document.createElement('div'))
      movePointer(10, 10)
      find.openFindAtPointer()
      expect(find.surfaceKind.value).toBe('') // 三个表面都不在文档 → 不动作

      mountSurface('right-drawer')
      find.close()
      find.openFindAtPointer()
      expect(find.surfaceKind.value, '只有 right-drawer → 回退开它').toBe('right-drawer')

      mountSurface('bottom-drawer')
      find.close()
      find.openFindAtPointer()
      expect(find.surfaceKind.value, 'bottom-drawer 优先于 right-drawer').toBe('bottom-drawer')

      mountSurface('overlay')
      find.close()
      find.openFindAtPointer()
      expect(find.surfaceKind.value, 'overlay 最高优先').toBe('overlay')
    })

    it('focusTick：每次触发自增（FindBar 据此聚焦输入框）', () => {
      mountSurface('right-drawer')
      mockElementFromPoint(null)
      movePointer(1, 2)
      const before = find.focusTick.value
      find.openFindAtPointer()
      expect(find.focusTick.value).toBe(before + 1)
      find.openFindAtPointer()
      expect(find.focusTick.value).toBe(before + 2)
    })
  })
})
