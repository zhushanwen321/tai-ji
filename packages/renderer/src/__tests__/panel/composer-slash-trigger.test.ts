/**
 * Composer slash 命令触发补全 单测（W1）。
 *
 * 覆盖三组件的垂直切片：
 * - U1-U5 ComposerInput.onInput 触发检测（DOM 查询 + startsWith，不靠 getText 判 chip）
 * - U6-U8 CommandPopover.items query 过滤（slash 路径）
 * - U9-U10 Composer wiring（slash-trigger 事件路由 + +菜单不回归守卫）
 *
 * mock 策略：
 * - U1-U5 直挂载 ComposerInput（根元素即 contenteditable div），setTextContent + trigger('input')，
 *   断言 emitted('slash-trigger')。happy-dom 支持 TreeWalker/querySelector。
 * - U6-U8 直挂载 CommandPopover（attachTo:body，reka-ui PopoverContent  teleport 到 body），
 *   经 events.dispatchSession 推 session.commands，setProps({query})，断言 body 内 item 按钮数。
 * - U9-U10 mount Composer（stub 子组件 + 真 pinia + mock useChat/useNewTaskFlow/@/api），
 *   从 stub emit slash-trigger/select，断言 CommandPopover stub 收到的 props。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/composer-slash-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@taiji/core/transport/api'
import type { ServerMessage } from '@taiji/shared'

// ── Composer 路径 mock（U9-U10）—— vi.mock factory 必须早于 import ──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, currentCwd: ref(null), setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })), getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }) },
  // CommandPopover.loadCandidates onMounted 调 composer.getMentionCandidates/getFileCandidates，
  // mock 遗漏会导致 unhandled rejection（test 期间的 4 个 unhandled errors 根因）
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
  config: {
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    onSkillCacheInvalidated: () => () => {},
  },
}))

import { ComposerInput, ComposerInputDepsKey } from '@taiji/ui/features/composer'
import CommandPopover from '@/components/panel/CommandPopover.vue'
import Composer from '@/components/panel/Composer.vue'

/** ui ComposerInput deps 注入（W4：ComposerInput 迁 ui 包，deps 经 inject token 提供） */
const composerInputDeps = {
  pasteImage: async () => ({ kind: 'text' as const, text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ─────────────────────── U1-U5 ComposerInput 触发检测 ───────────────────────

describe('ComposerInput slash-trigger（U1-U5）', () => {
  // ComposerInput template 含注释+div 两个根节点（fragment），wrapper.element 是注释节点。
  // 用 role="textbox" 选择器定位真实 contenteditable div 再触发 input。
  async function type(wrapper: ReturnType<typeof mount>, html: string): Promise<void> {
    const div = wrapper.find('[role="textbox"]')
    ;(div.element as HTMLDivElement).innerHTML = html
    await div.trigger('input')
  }

  it('U1 输入 / → emit slash-trigger {query:""}', async () => {
    const wrapper = mount(ComposerInput, { global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await type(wrapper, '/')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toEqual({ query: '' })
  })

  it('U2 输入 /commit → emit slash-trigger {query:"commit"}', async () => {
    const wrapper = mount(ComposerInput, { global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await type(wrapper, '/commit')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toEqual({ query: 'commit' })
  })

  it('U3 已有 slash-chip → emit slash-trigger null（不重触发，DOM 查询判定）', async () => {
    const wrapper = mount(ComposerInput, { global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    // chip 本体文本 /commit 会被 getText 读入，但 querySelector 查到 chip → 不触发
    await type(wrapper, '<span class="slash-chip">/commit</span>')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U4 非 / 开头（foo/）→ emit slash-trigger null', async () => {
    const wrapper = mount(ComposerInput, { global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await type(wrapper, 'foo/')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U5 触发后清空 → emit slash-trigger null（关闭浮层）', async () => {
    const wrapper = mount(ComposerInput, { global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await type(wrapper, '/commit')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toEqual({ query: 'commit' })
    await type(wrapper, '')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toBeNull()
  })
})

// ─────────────────────── U6-U8 CommandPopover query 过滤 ───────────────────────

/**
 * 3 条 mock slash 命令（pi get_commands 真实返回的 extension 动态命令）。
 * pi getCommands 返回的 name 不带 / 前缀（真实行为，已由 runtime 日志确认：
 * 'goal' / 'todos' / 'skill:xxx'），CommandPopover.items 会归一化补 / 前缀显示。
 * mock 用无前缀形式覆盖归一化逻辑，避免像旧 fixture 全带 / 掩盖 bug。
 *
 * compact 不在此列——pi get_commands 不返回 builtin（builtin 仅服务 pi TUI
 * autocomplete，不通过 RPC 暴露），由 CommandPopover slashCommands computed 在
 * 前端注入。U7 断言 4 项 = 3 pi 命令 + 1 前端注入 compact。
 *
 * [ADR-0050 二次修订] 本组 fixture 不含 skill 项且未传 registry skill props：panel slash 段
 * 的 skill 项已换源保留（pi 快照项剔除 + registry 项补入），无 registry 源传入时列表形态
 * 与命令等价；本组用例的测试对象是键盘导航/越界收敛（与 skill 语义无关），凑数第三条用
 * extension source 保持 4 项列表形态不变。panel slash 段的 skill 换源断言由
 * command-popover-landing.test.ts L5 / composer-skill-trigger.test.ts P5 覆盖。
 */
const MOCK_CMDS = [
  { name: 'commit', source: 'extension' },
  { name: 'review', source: 'extension' },
  { name: 'fix', source: 'extension' },
]

/** 推 session.commands 到 sessionId 订阅者（CommandPopover 用 events.on(sessionId) 订阅）。
 *  commands 可覆盖——用于模拟浮层打开期间候选源缩短（N-2 越界路径）。 */
function pushCommands(sessionId: string, commands: typeof MOCK_CMDS = MOCK_CMDS): void {
  const msg = {
    type: 'session.commands',
    payload: { sessionId, commands },
  } as ServerMessage<'session.commands'>
  events.dispatchSession(sessionId, msg)
}

/** reka-ui PopoverContent teleport 到 body：在 body 内找 item 行（v-for 渲染为 .cmd-row div）。
 *  按 item 列表容器（.max-h-[180px]）定位——不依赖行文本含 /（skill 项显示去掉了 / 前缀）。
 *  [B3] 行从 <Button> 改为纯 div（对齐 demo .cmd-row），选择器同步从 'button' 改为 '.cmd-row'。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('.cmd-row'))
}

/** 高亮行下标（模板选中态 = bg-surface 实色 token）。
 *  必须用 classList.contains 逐 token 判定：未选中态含 hover:bg-surface-hover，
 *  用 className.includes('bg-surface') 会把每一行都判成高亮（假绿）。 */
function highlightedRowIndex(): number {
  return bodyItemButtons().findIndex((r) => r.classList.contains('bg-surface'))
}

describe('CommandPopover slash query 过滤（U6-U8）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountPopover(query: string): Promise<void> {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', sessionId: 's1', query },
    })
    await flushPromises()
    pushCommands('s1')
    await flushPromises()
    await nextTick()
  }

  it('U6 query="comm" → 仅渲染 /commit（1 项）', async () => {
    await mountPopover('comm')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toContain('/commit')
  })

  it('U7 query="" → 渲染全部 4 项（3 pi 命令 + 1 前端注入 compact）', async () => {
    await mountPopover('')
    expect(bodyItemButtons()).toHaveLength(4)
    // 确认 compact 确实由前端注入（不在 MOCK_CMDS 里）
    expect(bodyItemButtons().some((b) => b.textContent?.includes('/compact'))).toBe(true)
  })

  it('U8 query="zzz" → 0 候选 + 渲染「无匹配项」反馈行（open 即渲染：缺陷 B）', async () => {
    await mountPopover('zzz')
    expect(bodyItemButtons()).toHaveLength(0)
    // 每条 open 态都有可见行：无候选渲染通用空态（修复前 PopoverContent 整体不挂载 ⇒ 无反馈）
    const row = document.body.querySelector('[data-testid="cmd-popover-empty"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('无匹配项')
  })

  // ── U8b 键盘导航幂等（回归：window capture + 事件冒泡双入口曾导致 ↑↓ 跳两项）──
  // handleKeydown 对同一个 KeyboardEvent 第二次调用必须 no-op（defaultPrevented 守卫），
  // 否则 activeIndex 被增减两次 → 方向键跳两项。
  it('U8b ArrowDown 同一事件二次调用 handleKeydown → activeIndex 只进 1（幂等守卫）', async () => {
    await mountPopover('')
    const vm = wrapper!.vm as unknown as { handleKeydown: (e: KeyboardEvent) => boolean }
    // 第一次（模拟 window capture 入口）：消费成功，preventDefault
    const e1 = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    expect(vm.handleKeydown(e1)).toBe(true)
    expect(e1.defaultPrevented).toBe(true)
    // 第二次（模拟事件冒泡到 Composer 入口）：同一事件已 defaultPrevented → no-op，返回 false
    const before = (vm as unknown as { activeIndex: number }).activeIndex
    const ret2 = vm.handleKeydown(e1)
    expect(ret2).toBe(false)
    expect((vm as unknown as { activeIndex: number }).activeIndex).toBe(before) // 未二次跳动
  })

  // ── 缺陷 A：候选源缩短导致 activeIndex 越界（高亮/选中/↑↓ 起点三处必须同时正确）──
  // 候选源可在浮层打开期间**缩短**（session.commands 新快照条目更少 / sessionStore.list
  // 广播删除）。旧实现在 Enter 读点用 Math.min 兜底：只救了 Enter，模板高亮（i === activeIndex）
  // 与 ↑↓ 起点（(idx ± 1 + len) % len）对越界值仍旧错。现在收敛点单点化在
  // command-popover-keyboard.ts 的 sync watch（列表变化同一拍夹到 [0, len-1]），三处天然一致。
  it('N-2 候选在浮层打开期间缩短 → Enter 不抛错且选中末项（收敛点单一化替代读点兜底）', async () => {
    await mountPopover('')
    const vm = wrapper!.vm as unknown as { handleKeydown: (e: KeyboardEvent) => boolean }
    // 4 项（compact + 3 pi 命令）时方向键下移到末项（activeIndex=3）
    for (let i = 0; i < 3; i++) {
      vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    }
    await nextTick()
    expect(highlightedRowIndex()).toBe(3) // 前置：索引确已到末项
    // 源缩短：新 session.commands 快照只剩 1 条 pi 命令（+ 前端注入 compact = 2 项）
    pushCommands('s1', [{ name: 'commit', source: 'extension' }])
    await flushPromises()
    await nextTick()
    expect(bodyItemButtons()).toHaveLength(2)
    // 越界索引在收敛点夹到末项（回退收敛 ⇒ Enter 读 list[3] 为 undefined，抛 TypeError）
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    expect(() => vm.handleKeydown(enter)).not.toThrow()
    // 收敛到末项（而非归零到首项——保住缩短前的相对位置）
    expect(wrapper!.emitted('select')?.at(-1)?.[0]).toMatchObject({ type: 'slash', name: '/commit' })
  })

  it('N-2a 候选缩短 → 模板高亮行 == Enter 实际选中行（高亮与选中同源，非读点兜底）', async () => {
    await mountPopover('')
    const vm = wrapper!.vm as unknown as { handleKeydown: (e: KeyboardEvent) => boolean }
    for (let i = 0; i < 3; i++) {
      vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    }
    await nextTick()
    expect(highlightedRowIndex()).toBe(3)

    // 缩短到 2 项 ⇒ 收敛值 = 末项（index 1）
    pushCommands('s1', [{ name: 'commit', source: 'extension' }])
    await flushPromises()
    await nextTick()
    const rows = bodyItemButtons()
    expect(rows).toHaveLength(2)
    // ① 收缩后确有行高亮，且 = 收敛值处那一行（旧实现：无任何行高亮）
    const highlighted = highlightedRowIndex()
    expect(highlighted).toBe(1)

    // Enter 选中的正是高亮行（同一 activeIndex 读点，不是「读点兜底出的末项」）
    vm.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    const selected = wrapper!.emitted('select')?.at(-1)?.[0] as { name: string }
    expect(selected.name).toBe('/commit')
    expect(rows[highlighted].textContent).toContain('/commit')
  })

  it('N-2b 候选缩短 → 首次 ↑ 从收敛值出发（不是归 0）', async () => {
    await mountPopover('')
    const vm = wrapper!.vm as unknown as { handleKeydown: (e: KeyboardEvent) => boolean }
    // 4 项（compact + commit/review/fix）时下移到末项（index 3）
    for (let i = 0; i < 3; i++) {
      vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    }
    await nextTick()
    expect(highlightedRowIndex()).toBe(3)

    // 缩短到 3 项（compact + commit + review）⇒ 收敛值 2
    pushCommands('s1', [
      { name: 'commit', source: 'extension' },
      { name: 'review', source: 'extension' },
    ])
    await flushPromises()
    await nextTick()
    expect(bodyItemButtons()).toHaveLength(3)
    await nextTick()
    expect(highlightedRowIndex()).toBe(2)

    // ↑ 从收敛值 2 出发 → (2 - 1 + 3) % 3 = 1；若按旧实现「越界 ⇒ 起点归 0」→ (0 - 1 + 3) % 3 = 2
    vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await nextTick()
    expect(highlightedRowIndex()).toBe(1)
  })
})

// ─────────────────────── U9-U10 Composer wiring ───────────────────────
// global.stubs 的 stub 不留组件实例（findComponent 不可见），改用 DOM 验证：
// - ComposerInput 真实渲染（不 stub），通过 contenteditable div 操作触发 slash-trigger
// - CommandPopover stub 把 open/type/query 反映到 data-* 属性供 DOM 断言
// - AddMenuPopover stub 渲染可点击按钮 emit select

/** CommandPopover stub：把 props 反映到 data-* 属性供 DOM 断言 */
const CommandPopoverStub = defineComponent({
  name: 'CommandPopover',
  props: {
    open: { type: Boolean, default: false },
    type: { type: String, default: 'mention' },
    sessionId: { type: String, default: undefined },
    query: { type: String, default: '' },
  },
  methods: {
    handleKeydown() {
      return false
    },
  },
  template:
    '<div data-testid="cp" :data-open="String(open)" :data-type="type" :data-query="query"><slot /></div>',
})

/** AddMenuPopover stub：点击 emit select('slash')，模拟 +菜单选命令 */
const AddMenuPopoverStub = defineComponent({
  name: 'AddMenuPopover',
  emits: ['select'],
  template: '<button data-testid="add-slash" @click="$emit(\'select\', \'slash\')" />',
})

const SIMPLE = { template: '<div />' }
/** ComposerInput 保持真实（需通过 contenteditable 触发 slash-trigger） */
const composerStubs = {
  CommandPopover: CommandPopoverStub,
  AddMenuPopover: AddMenuPopoverStub,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

function mountComposer() {
  return mount(Composer, {
    props: { sessionId: 's1', variant: 'panel' },
    global: { stubs: composerStubs },
  })
}

/** 在真实 ComposerInput 的 contenteditable div 内键入并触发 slash-trigger */
async function typeIntoComposerInput(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  const input = wrapper.find('[role="textbox"]')
  ;(input.element as HTMLDivElement).textContent = text
  await input.trigger('input')
  await nextTick()
}

describe('Composer slash-trigger wiring（U9-U10）', () => {
  it('U9 ComposerInput emit slash-trigger {query:"co"} → CommandPopover 收到 open/type/query', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // 真实 ComposerInput：键入 /co 触发 slash-trigger → Composer 路由到 CommandPopover
    await typeIntoComposerInput(wrapper, '/co')
    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('true')
    expect(cp.attributes('data-type')).toBe('slash')
    expect(cp.attributes('data-query')).toBe('co')
  })

  it('U10 +菜单打开浮层后 emit slash-trigger null → 浮层不误关（slashTriggerActive=false 守卫）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // ① +菜单选 slash → 打开浮层（onAddSelect，slashTriggerActive 仍 false）
    await wrapper.find('[data-testid="add-slash"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="cp"]').attributes('data-open')).toBe('true')
    // ② ComposerInput 键入普通文本 x（非 / 开头）→ emit slash-trigger null
    //    → slashTriggerActive=false（+菜单路径）→ 不误关浮层
    await typeIntoComposerInput(wrapper, 'x')
    expect(wrapper.find('[data-testid="cp"]').attributes('data-open')).toBe('true')
  })
})

// ─────────────────────── U11 insertSlashChip / 前缀归一化 ───────────────────────

describe('insertSlashChip / 前缀归一化（U11）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /**
   * pi getCommands 返回的命令名不带 / 前缀（如 'goal'），但发送给 pi 必须以 / 开头，
   * 否则 pi 按普通文本处理而非 slash 命令。insertSlashChip 必须归一化补 /。
   * 回归场景：用户选 /goal 命令 → chip 显示 'goal' → 发送 'goal' → pi 不识别。
   */
  it('U11a insertSlashChip("goal") → chip label 显示 "/goal"（补 / 前缀）', async () => {
    wrapper = mount(ComposerInput, { attachTo: document.body, global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await flushPromises()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string, icon?: string) => void }
    // 确定性选区前置：清掉上一用例残留 selection（指向已卸载 DOM 时 range.insertNode
    // 会把 chip 插进游离树），rangeCount=0 走 insertChipAtSelection 的 appendChild 通路
    document.getSelection()?.removeAllRanges()
    vm.insertSlashChip('goal', 'terminal')
    await nextTick()
    const chip = wrapper.find('.slash-chip .chip-label')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('/goal')
  })

  it('U11b insertSlashChip("/commit") 已带 / 前缀 → 不重复补', async () => {
    wrapper = mount(ComposerInput, { attachTo: document.body, global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await flushPromises()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string, icon?: string) => void }
    // 同 U11a：清残留 selection，走 appendChild 通路
    document.getSelection()?.removeAllRanges()
    vm.insertSlashChip('/commit', 'terminal')
    await nextTick()
    const chip = wrapper.find('.slash-chip .chip-label')
    expect(chip.text()).toBe('/commit')
  })

  // U11c（设计 D4-a）：命令 chip 视觉就地——光标在草稿中部时 chip 落光标处，
  // 不再强制跳到全文最前（旧断言语义「chip 必须是 firstChild」已随 D4-a 失效，改写为就地断言）
  it('U11c 命令 chip 就地插入：草稿中部光标 → chip 在光标处不强制最前', async () => {
    wrapper = mount(ComposerInput, { attachTo: document.body, global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } } })
    await flushPromises()
    const div = wrapper.find('[role="textbox"]').element as HTMLDivElement
    div.textContent = '任务描述'
    const textNode = div.firstChild as Text
    // 活光标在文本末尾（键盘呼出浮层时的焦点从未离开形态）
    const sel = document.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 4)
    range.collapse(true)
    sel?.addRange(range)
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string, icon?: string) => void }
    vm.insertSlashChip('/compact', 'terminal')
    await nextTick()
    const chip = div.querySelector('.slash-chip') as HTMLElement
    expect(chip).not.toBeNull()
    // 就地：文本仍在最前，chip 前邻是原文本节点
    expect(div.firstChild).toBe(textNode)
    expect(chip.previousSibling).toBe(textNode)
    // chip 后跟 ZWSP spacer
    expect(chip.nextSibling?.textContent).toBe('\u200B')
  })
})
