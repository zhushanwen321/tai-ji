/**
 * Composer skill 触发/chip/浮层 单测（多 skill 注入 u4，设计 D1/D2 + 验收场景 6）。
 *
 * 覆盖三组件的垂直切片：
 * - W 组 Composer wiring（挂 Composer + stub CommandPopover）：空格/全角空格/NBSP 后 `/`
 *   触发 skill-only 浮层（场景 6④）；`/usr` 输到第二个 `/` 浮层关闭（场景 6①）；
 *   行首 `/` 仍命令浮层（场景 6② 回归）；`#`/`$`/`@` 无变化（场景 6③ 回归）；
 *   select payload → insertSkillChip（光标标记 chip、多个共存）+ 已选集合回传（D2 已选禁选数据面）
 * - P 组 CommandPopover（真实组件）：panel 态从 commandStore 过滤 source:"skill" 且剥
 *   `skill:` 前缀；已选项「已选」禁选（onSelect 守卫）；landing 态 global+project 合并；
 *   select payload 携带 location（sourceInfo.path）
 * - W9/W10 组 SearchModal ⌘K 注入（第三条 skill 入口）：pendingSlash.isSkill → insertSkillChip
 *   （裸名 + location + 多共存）；isSkill 缺省 → 维持 insertSlashChip 命令通路（回归锁）
 *
 * mock 策略与 composer-slash-trigger.test.ts 同款（真实 ComposerInput 走 contenteditable 触发）。
 * happy-dom 光标：skill 触发无程序化兜底（必须有光标），用 typeWithCursor 定位光标末尾。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/composer-skill-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@taiji/core/transport/api'
import type { ServerMessage } from '@taiji/shared'
import type { SkillInfo } from '@taiji/shared'

// ── Composer 路径 mock —— vi.mock factory 必须早于 import ──
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

import CommandPopover from '@/components/panel/CommandPopover.vue'
import Composer from '@/components/panel/Composer.vue'
import { useCommandStore, __resetCommandStoreForTesting } from '@/composables/features/command/useCommandStore'

beforeEach(() => {
  setActivePinia(createPinia())
})

// ─────────────────────── W 组：Composer wiring（真实 ComposerInput + stub CommandPopover） ───────────────────────

/** stub 选中 payload（模块级可变：W6 在点击前设置，点击时 emit 给 Composer.onCmdSelect） */
let currentPick: Record<string, unknown> | null = null

/** CommandPopover stub：props 反映到 data-* 供 DOM 断言；cp-pick 按钮模拟选中项 emit select */
const CommandPopoverStub = defineComponent({
  name: 'CommandPopover',
  props: {
    open: { type: Boolean, default: false },
    type: { type: String, default: 'mention' },
    sessionId: { type: String, default: undefined },
    query: { type: String, default: '' },
    selectedSkillNames: { type: Array, default: () => [] },
  },
  emits: ['select'],
  methods: {
    handleKeydown() {
      return false
    },
    emitPick() {
      if (currentPick) this.$emit('select', currentPick)
    },
  },
  template:
    '<div data-testid="cp" :data-open="String(open)" :data-type="type" :data-query="query" :data-selected="(selectedSkillNames || []).join(\',\')"><button data-testid="cp-pick" @click="emitPick" /><slot /></div>',
})

const SIMPLE = { template: '<div />' }
const composerStubs = {
  CommandPopover: CommandPopoverStub,
  AddMenuPopover: SIMPLE,
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

/**
 * 在真实 ComposerInput 的 contenteditable div 内键入并把光标定位到文本末尾。
 * skill 触发无程序化兜底（必须有光标），与 slash 的 startsWith 兜底路径不同。
 */
async function typeWithCursor(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, text.length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
  await nextTick()
}

/**
 * 把光标移到输入框末尾（元素级 offset，不重写 DOM——保留已插入的 chip）。
 * 用于模拟「已有 chip 后继续键入再点选」的真实流。
 */
async function cursorToEnd(wrapper: ReturnType<typeof mount>): Promise<void> {
  const el = wrapper.find('[role="textbox"]').element as HTMLDivElement
  el.focus()
  const sel = window.getSelection()
  const last = el.lastChild
  if (sel && last) {
    const range = document.createRange()
    range.setStartAfter(last)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await nextTick()
}

function cp(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-testid="cp"]')
}

describe('Composer skill 触发 wiring（场景 6①②③④）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('W1 空格后键入 /rev → 浮层开、type=skill、query=rev', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '帮我 review /rev')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    expect(cp(wrapper).attributes('data-query')).toBe('rev')
    wrapper.unmount()
  })

  it('W2 场景 6①：/usr 短暂弹出，输到第二个 / 浮层立即关闭', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '帮我看看 /usr')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    await typeWithCursor(wrapper, '帮我看看 /usr/')
    expect(cp(wrapper).attributes('data-open')).toBe('false')
    wrapper.unmount()
  })

  it('W3 场景 6② 回归：行首 /co → 命令浮层（type=slash），skill 路不抢', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '/co')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('slash')
    expect(cp(wrapper).attributes('data-query')).toBe('co')
    wrapper.unmount()
  })

  it('W4 场景 6③ 回归：# / $ / @ 触发类型不变（session/file/subagent）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, 'see #job')
    expect(cp(wrapper).attributes('data-type')).toBe('session')
    await typeWithCursor(wrapper, 'echo $HOME')
    expect(cp(wrapper).attributes('data-type')).toBe('file')
    await typeWithCursor(wrapper, 'hey @build')
    expect(cp(wrapper).attributes('data-type')).toBe('subagent')
    wrapper.unmount()
  })

  it('W5 场景 6④：全角空格 / NBSP 后 / 唤起 skill 浮层', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '看看\u3000/re')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    await typeWithCursor(wrapper, '看看\u00A0/re')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    wrapper.unmount()
  })
})

describe('Composer skill chip 插入与已选回传（D2 已选禁选数据面）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('W6 选中两个 skill → insertSkillChip 两个共存（dataset/location 完整）+ 已选集合回传', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    const cpEl = wrapper.find('[data-testid="cp"]')
    // 真实流：先键入触发（selection 在输入框内），再点选浮层项——insertChipAtSelection
    // 走光标处插入分支（happy-dom 残留脱离文档 selection 会污染插入位置，须先键入定位）
    await typeWithCursor(wrapper, '帮我 /al')
    // 选中 skill alpha（payload 携带 icon/location，onCmdSelect → clearSkillQueryText + insertSkillChip）
    currentPick = { type: 'skill', name: 'alpha', icon: 'star', location: '/s/alpha/SKILL.md' }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    let chips = wrapper.findAll('.slash-chip')
    expect(chips.length).toBe(1)
    expect(chips[0].attributes('data-chip-type')).toBe('skill')
    expect(chips[0].attributes('data-chip-name')).toBe('alpha')
    expect(chips[0].attributes('data-chip-location')).toBe('/s/alpha/SKILL.md')
    // 已选集合回传（onInputChange → getSegments → CommandPopover.selectedSkillNames）
    expect(cpEl.attributes('data-selected')).toBe('alpha')
    // 再选一个：两个 skill chip 共存（D2），已选集合含两项（光标移末尾，不重写 DOM 保住 alpha chip）
    await cursorToEnd(wrapper)
    currentPick = { type: 'skill', name: 'beta', icon: 'star' }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    chips = wrapper.findAll('.slash-chip')
    expect(chips.length).toBe(2)
    expect(chips[1].attributes('data-chip-name')).toBe('beta')
    expect(chips[1].attributes('data-chip-location')).toBeUndefined()
    expect(cpEl.attributes('data-selected')).toBe('alpha,beta')
    currentPick = null
    wrapper.unmount()
  })
})

// ─────────────────────── W7/W8 组：行首命令浮层 skill 项按项类型分流（设计 D3） ───────────────────────

describe('行首命令浮层 skill 项分流（D3：isSkill → insertSkillChip 通路）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    currentPick = null
  })

  it('W7 行首浮层选 skill 项 → insertSkillChip 通路：已有 skill chip 不删、新 chip 带 location', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // 先经 skill-only 入口插一个 skill chip（行中 / 触发），模拟 multi-skill 已有态
    await typeWithCursor(wrapper, '帮我 /al')
    currentPick = { type: 'skill', name: 'alpha', icon: 'star', location: '/s/alpha/SKILL.md' }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    expect(wrapper.findAll('.slash-chip')).toHaveLength(1)
    // 行首 / 命令浮层选 skill 项：type='slash' + isSkill → 按项类型分流（D3）
    await cursorToEnd(wrapper)
    currentPick = {
      type: 'slash',
      name: '/skill:beta',
      isSkill: true,
      icon: 'star',
      location: '/s/beta/SKILL.md',
    }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    const chips = wrapper.findAll('.slash-chip')
    // 不误删已有 skill chip（失败模式 C 根修）+ 新 chip 是 skill 形态且带 location
    expect(chips).toHaveLength(2)
    expect(chips[0].attributes('data-chip-name')).toBe('alpha')
    expect(chips[1].attributes('data-chip-type')).toBe('skill')
    expect(chips[1].attributes('data-chip-name')).toBe('beta')
    expect(chips[1].attributes('data-chip-location')).toBe('/s/beta/SKILL.md')
    wrapper.unmount()
  })

  it('W8 回归（G3 红线）：行首浮层命令项（非 isSkill）仍走 insertSlashChip 命令通路', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '/com')
    currentPick = { type: 'slash', name: '/compact', icon: 'compact' }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    const chips = wrapper.findAll('.slash-chip')
    expect(chips).toHaveLength(1)
    // 命令 chip 形态：chipType='slash'（非 skill），chipName 剥 / 前缀
    expect(chips[0].attributes('data-chip-type')).toBe('slash')
    expect(chips[0].attributes('data-chip-name')).toBe('compact')
    expect(chips[0].attributes('data-chip-location')).toBeUndefined()
    wrapper.unmount()
  })
})

// ─────────────── W9/W10 组：SearchModal ⌘K 注入（pendingSlash → 按 isSkill 分流）───────────────
// 第三条 skill 入口（搜索浮层）与 ①② 合流：pi 的 skill 命令名是裸 `skill:<name>`（无前导 /），
// 命令通路的 insertSlashChip 内 `/skill:` 前缀判定为假 ⇒ 若不分流会落成命令 chip
// （无 chipLocation + 受单命令替换语义管辖）。本组锁两端：isSkill 真走 skill 通路、
// 缺省仍走命令通路。

describe('SearchModal ⌘K 注入分流（pendingSlash isSkill → skill 通路）', () => {
  beforeEach(() => {
    __resetCommandStoreForTesting() // pendingSlash 通道跨用例隔离
  })

  afterEach(() => {
    document.body.innerHTML = ''
    currentPick = null
  })

  it('W9 pendingSlash{isSkill:true, location, command:"skill:code-review"} → 落 skill chip（chipType/chipLocation/裸名）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // 真实流：先键入把光标定位在输入框内（chip 插在光标处），再写 pendingSlash 由 watch 消费
    await typeWithCursor(wrapper, '帮我看看 ')
    const commandStore = useCommandStore()
    commandStore.requestSlashInjection({
      command: 'skill:code-review',
      icon: 'star',
      sessionId: 's1',
      isSkill: true,
      location: '/skills/code-review/SKILL.md',
    })
    await nextTick()

    const chips = wrapper.findAll('.slash-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0].attributes('data-chip-type')).toBe('skill')
    expect(chips[0].attributes('data-chip-location')).toBe('/skills/code-review/SKILL.md')
    // 裸名：剥 `skill:` 前缀（bareSkillCommandName 单点）
    expect(chips[0].attributes('data-chip-name')).toBe('code-review')
    // chip 可见文本即裸名
    expect(chips[0].find('.chip-label').text()).toBe('code-review')
    // 通道被消费清空
    expect(commandStore.pendingSlash.value).toBeNull()
    wrapper.unmount()
  })

  it('W9b isSkill 项不清除已存在的命令 chip（skill 通路不与命令替换语义串扰）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    const commandStore = useCommandStore()
    // 先注入一条命令 chip（无 isSkill → 命令通路）
    await typeWithCursor(wrapper, '跑一下 ')
    commandStore.requestSlashInjection({ command: 'goal', icon: 'goal', sessionId: 's1' })
    await nextTick()
    expect(wrapper.findAll('.slash-chip')).toHaveLength(1)
    // 再注入 skill 项：skill 通路就地追加，不动已有命令 chip
    await cursorToEnd(wrapper)
    commandStore.requestSlashInjection({
      command: 'skill:code-review',
      icon: 'star',
      sessionId: 's1',
      isSkill: true,
      location: '/skills/code-review/SKILL.md',
    })
    await nextTick()

    const chips = wrapper.findAll('.slash-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].attributes('data-chip-type')).toBe('slash')
    expect(chips[1].attributes('data-chip-type')).toBe('skill')
    wrapper.unmount()
  })

  it('W10 回归锁：isSkill 缺省 → 仍走 insertSlashChip 命令 chip（chipType=slash、无 location）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '/go')
    const commandStore = useCommandStore()
    commandStore.requestSlashInjection({ command: 'goal', icon: 'goal', sessionId: 's1' })
    await nextTick()

    const chips = wrapper.findAll('.slash-chip')
    expect(chips).toHaveLength(1)
    // 命令 chip 形态（与 W8 同款）：chipType='slash'，无 location
    expect(chips[0].attributes('data-chip-type')).toBe('slash')
    expect(chips[0].attributes('data-chip-name')).toBe('goal')
    expect(chips[0].attributes('data-chip-location')).toBeUndefined()
    expect(commandStore.pendingSlash.value).toBeNull()
    wrapper.unmount()
  })
})

// ─────────────────────── P 组：CommandPopover skill-only 候选（真实组件） ───────────────────────

/** 推 session.commands 到 sessionId 订阅者（同 slash-trigger 测试机械） */
function pushCommands(sessionId: string, commands: Array<Record<string, unknown>>): void {
  const msg = {
    type: 'session.commands',
    payload: { sessionId, commands },
  } as ServerMessage<'session.commands'>
  events.dispatchSession(sessionId, msg)
}

/** reka-ui PopoverContent teleport 到 body：在列表容器内找 .cmd-row 行 */
function bodyRows(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('.cmd-row')) as HTMLElement[]
}

/** SkillInfo fixture（landing 候选源形状） */
function skillInfo(name: string, sourcePath?: string): SkillInfo {
  return { id: `pi-${name}`, name, description: `${name} desc`, enabled: true, source: 'global', triggers: [], sourcePath }
}

describe('CommandPopover skill-only 候选（D1 数据源 + D2 已选禁选）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('P1 panel 态：只列 source=skill 项、剥 skill: 前缀、__ 内部项过滤', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'skill', sessionId: 's1', query: '' },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', description: 'A', source: 'skill' },
      { name: 'commit', description: 'ext', source: 'extension' },
      { name: 'skill:beta', source: 'skill' },
      { name: 'skill:__taiji_reload', source: 'skill' },
    ])
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('alpha')
    expect(rows[1].textContent).toContain('beta')
    expect(bodyRows().some((r) => r.textContent?.includes('commit'))).toBe(false)
    expect(bodyRows().some((r) => r.textContent?.includes('__taiji_reload'))).toBe(false)
  })

  it('P2 D2 已选禁选：已选项显示「已选」且禁选（不 emit select），未选项正常选', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'skill', sessionId: 's1', query: '', selectedSkillNames: ['alpha'] },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', source: 'skill' },
      { name: 'skill:beta', source: 'skill' },
    ])
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    expect(rows[0].getAttribute('aria-disabled')).toBe('true')
    expect(rows[0].textContent).toContain('已选')
    rows[0].click()
    await nextTick()
    expect(wrapper.emitted('select')).toBeUndefined()
    rows[1].click()
    await nextTick()
    expect(wrapper.emitted('select')!.length).toBe(1)
    expect(wrapper.emitted('select')![0][0]).toMatchObject({ type: 'skill', name: 'beta' })
  })

  it('P3 panel 态 select payload 携带 location（sourceInfo.path）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'skill', sessionId: 's1', query: '' },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', source: 'skill', sourceInfo: { path: '/s/alpha/SKILL.md', source: 'skill' } },
    ])
    await flushPromises()
    await nextTick()
    bodyRows()[0].click()
    await nextTick()
    expect(wrapper.emitted('select')![0][0]).toMatchObject({
      type: 'skill',
      name: 'alpha',
      location: '/s/alpha/SKILL.md',
    })
  })

  it('P5 slash 浮层（行首命令浮层）skill 项 select payload 携带 isSkill + location（D3 透传链）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', sessionId: 's1', query: '' },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', source: 'skill', sourceInfo: { path: '/s/alpha/SKILL.md', source: 'skill' } },
      { name: 'commit', description: 'ext', source: 'extension' },
    ])
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    // skill 项（icon 星标紫）+ 命令项混列
    const skillRow = rows.find((r) => r.textContent?.includes('alpha'))
    const cmdRow = rows.find((r) => r.textContent?.includes('commit'))
    expect(skillRow).toBeTruthy()
    expect(cmdRow).toBeTruthy()
    skillRow!.click()
    await nextTick()
    expect(wrapper.emitted('select')![0][0]).toMatchObject({
      type: 'slash',
      name: '/skill:alpha',
      isSkill: true,
      location: '/s/alpha/SKILL.md',
    })
    // 命令项：isSkill false、无 location（G3 红线：命令通路零变化）
    cmdRow!.click()
    await nextTick()
    expect(wrapper.emitted('select')![1][0]).toMatchObject({
      type: 'slash',
      name: '/commit',
      isSkill: false,
    })
    expect((wrapper.emitted('select')![1][0] as Record<string, unknown>).location).toBeUndefined()
  })

  it('P4 landing 态：globalSkills + projectSkills 合并（global 优先、project 补独有、去重）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: {
        open: true,
        type: 'skill',
        variant: 'landing',
        query: '',
        globalSkills: [skillInfo('global-a', '/g/a/SKILL.md'), skillInfo('shared')],
        projectSkills: [skillInfo('shared'), skillInfo('proj-c')],
      },
    })
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('global-a')
    expect(rows[1].textContent).toContain('shared')
    expect(rows[2].textContent).toContain('proj-c')
    // landing 选中：location 取 SkillInfo.sourcePath
    rows[0].click()
    await nextTick()
    expect(wrapper.emitted('select')![0][0]).toMatchObject({ type: 'skill', name: 'global-a', location: '/g/a/SKILL.md' })
  })
})
