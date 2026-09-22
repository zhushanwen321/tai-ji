/**
 * useCommandPopoverTrigger SM 互斥 + D2b 注入前清理单测（第三族）。
 *
 * 覆盖（search-modal-popover-mutual-exclusion 设计 D1/D2/D2b，验收场景 6 + U2 五向断言）：
 *   - D1 互斥：SearchModal isOpen 转 true → cmdOpen 置 false（sync）；转 false → cmdOpen
 *     不变（单向：SM 关闭后浮层不自动恢复，D2）
 *   - D2b 五向（pendingSlash 消费链「confirm 注入」前的活跃域 token 清理——效果断言，
 *     非调用序 spy）：
 *     ① 正向效果：活跃 slash 域 confirm 注入后无残留明文 + 序列化恰为所选命令 + draft 同步
 *     ② 失活边界：`/rev $f` 形态（$ 域活跃、/rev 已失活）confirm 后 `$f` 被清、`/rev` 保留
 *     ③ 非唯一跳过：两行同文 `/compact` confirm 后两处均保留；元字符 query（`$config.x`）
 *        唯一命中正确删除
 *     ④ session 冻结：冻结 session ≠ 当前 session 时消费不清理文本（注入本身不受影响）
 *     ⑤ 跨 text node 分裂（token 被 chip 分裂）按单 node 匹配 0 命中跳过；空 query 边界
 *        （只输 `/`）触发符被清
 *
 * 组装策略（与同族两份的纯 spy mock 不同——D2b 断言的是 DOM 终态效果）：
 *   - 真实 contenteditable div（挂 document.body）+ dom-core 真实 composable 组装
 *     （useContenteditableInput 的 getText/restoreSelection/onInput + useComposerChipCommands
 *     的 insertSlashChip/insertSkillChip）——ComposerInput.vue 同款组合，insert 的落位/替换
 *     语义、序列化归首（segmentsToText）、draft 同步（onChanged → emitInput(getText())）全真实
 *   - pendingSlash 经真实 commandStore（requestSlashInjection 写 / clearPendingSlash 清）
 *   - core 单例隔离：beforeEach resetSearchModal()（SM 单例）+ __resetCommandStoreForTesting()
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useCommandPopoverTrigger.mutual-exclusion.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  __resetCommandStoreForTesting,
} from '@/composables/features/command/useCommandStore'

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
 * inputInstance 暴露 useCommandPopoverTrigger 消费面（getInputElement/insertSlashChip/
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

describe('useCommandPopoverTrigger SM 互斥（D1 单向状态互斥）', () => {
  let ctx: ReturnType<typeof setupRealComposer>

  beforeEach(() => {
    setActivePinia(createPinia())
    resetSearchModal()
    __resetCommandStoreForTesting()
  })
  afterEach(() => {
    ctx.dispose()
    ctx.el.remove()
    window.getSelection()?.removeAllRanges()
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

  it('互斥不动触发域标记（active/query 保留——冻结守卫与 D2b 责任面的锚）', () => {
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
    setActivePinia(createPinia())
    resetSearchModal()
    __resetCommandStoreForTesting()
  })
  afterEach(() => {
    ctx.dispose()
    ctx.el.remove()
    window.getSelection()?.removeAllRanges()
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
    // slash 域开过又关（空格后触发终止）——失活历史 token 出 D2b 责任面
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
    // ……但清理被冻结守卫跳过（不误删他 session 草稿的同形 token）
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
