/**
 * Composer 四符号触发 单测（composer-symbol-system U2a 改写）。
 *
 * 符号语义换绑：# → session 浮层（对齐 TUI）、$ → file 浮层（原 # 的文件行为完整迁移）、
 * @ → subagent 浮层（新增）、/ → slash（不变）；bash 态（! 前缀）四符号全不触发（D6 豁免）。
 *
 * 覆盖：
 * - U1-U6 ComposerInput 触发检测 emit 层：# → session-trigger / $ → file-trigger /
 *   @ → subagent-trigger（空格/行首 + 符号 + 非空白 → 触发；遇空格 → null 终止）
 * - U7-U9 CommandPopover file 分支 query 过滤 + 路径展示（$ 迁移后行为不变）
 * - S 组 session 浮层：sessionStore 候选/排序/两行展示/过滤；landing 有候选（S4 翻转：D1 删
 *   hasSessionId 门，session 候选与目录/sessionId 无关，landing-composer-session-file-symbols G2）
 * - A 组 subagent 浮层：store 候选/新建项/选中插 chip/打开主动拉
 * - SL 组 slash 打开主动拉：open 边沿触发 session.getCommands + 节流
 * - B 组 bash 短路：suppressTriggers 下四路全 null；Composer wiring 下浮层不开
 * - U10 Composer wiring：# → type=session、$ → type=file
 * - C 组选中插 chip 集成：session chip / subagent chip / 新建占位 chip（真实 DOM 断言）
 *
 * happy-dom 光标支持：el.focus() + Range.setStart/setEnd + Selection.addRange 可定位光标。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/composer-hash-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Mock } from 'vitest'

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
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))

// session 域 mock：getCommands（slash 打开主动拉断言）/ getSubagents（subagent 候选 load）
const getCommandsMock = vi.hoisted(() => vi.fn())
const getSubagentsMock = vi.hoisted(() => vi.fn())
// useFileSearch mock：返回可控 FileNode[]（U7-U9 file 路；C 组默认空候选）
const mockLoad = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: (...args: unknown[]) => mockLoad(...args) }),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: {
    setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })),
    getCommands: getCommandsMock,
    getSubagents: getSubagentsMock,
  },
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
import { useSessionStore } from '@/stores/session'
import { useSubagentStore } from '@/stores/subagent'
import { session as sessionApi } from '@/api'
import type { FileNode, SessionGroup, SubagentRecord } from '@taiji/shared'

/** ui ComposerInput deps 注入（W4：ComposerInput 迁 ui 包，deps 经 inject token 提供） */
const composerInputDeps = {
  pasteImage: async () => ({ kind: 'text' as const, text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  setActivePinia(createPinia())
  getCommandsMock.mockReset()
  getCommandsMock.mockResolvedValue({ sessionId: 's1', commands: [] })
  getSubagentsMock.mockReset()
  getSubagentsMock.mockResolvedValue([])
  // useFileSearch mock 默认空候选（C 组真实 CommandPopover onMounted 会拉；用例内可 Once 覆盖）
  mockLoad.mockReset()
  mockLoad.mockResolvedValue([])
})

// ─────────────────────── U1-U6 ComposerInput 四符号触发检测（emit 层） ───────────────────────

/**
 * 在 contenteditable div 内键入文本，并把光标定位到指定位置（触发检测依赖光标位置）。
 * 策略：设 textContent → focus → 用 Range 把光标 collapse 到 offset → trigger('input')。
 */
async function typeWithCursor(
  wrapper: ReturnType<typeof mount>,
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, Math.min(cursorOffset, text.length))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
}

function mountInput(extraProps: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ComposerInput, {
    props: extraProps,
    global: { provide: { [ComposerInputDepsKey as symbol]: composerInputDeps } },
  })
}

describe('ComposerInput 四符号触发检测（U1-U6，# → session / $ → file / @ → subagent）', () => {
  it('U1 行首敲 #（光标紧随 #）→ emit session-trigger {query:""}，file-trigger 未命中（null）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '#', 1)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toEqual({ query: '' })
    // $ 检测（file-trigger）同轮发 null（不命中 # 文本）
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U2 #auth（光标在末尾）→ emit session-trigger {query:"auth"}', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '#auth', 5)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toEqual({ query: 'auth' })
  })

  it('U3 #auth 后跟空格（光标在空格后）→ emit session-trigger null（终止）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '#auth ', 6)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U4 问题#1（# 前非空格）→ emit session-trigger null', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '问题#1', 4)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U5 code #a（# 前空格）→ emit session-trigger {query:"a"}', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, 'code #a', 7)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toEqual({ query: 'a' })
  })

  it('U6 触发后清空 → emit session-trigger null（关闭浮层）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '#auth', 5)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toEqual({ query: 'auth' })
    await typeWithCursor(wrapper, '', 0)
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toBeNull()
  })

  it('F1 行首 $ + query → emit file-trigger（原 # 的文件触发行为迁移到 $）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '$auth', 5)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: 'auth' })
    // # 检测（session-trigger）同轮发 null（不命中 $ 文本）
    expect(wrapper.emitted('session-trigger')!.at(-1)![0]).toBeNull()
  })

  it('F2 code $a（$ 前空格）→ emit file-trigger {query:"a"}；$ 后空格 → null', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, 'code $a', 7)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: 'a' })
    await typeWithCursor(wrapper, 'code $a ', 8)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toBeNull()
  })

  it('A1 行首 @build → emit subagent-trigger {query:"build"}；@ 后空格 → null', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '@build', 6)
    expect(wrapper.emitted('subagent-trigger')!.at(-1)![0]).toEqual({ query: 'build' })
    await typeWithCursor(wrapper, '@build ', 7)
    expect(wrapper.emitted('subagent-trigger')!.at(-1)![0]).toBeNull()
  })
})

// ─────────────────────── B 组 bash 短路（emit 层 + wiring 层） ───────────────────────

describe('bash 短路（D6：suppressTriggers 下四符号全不触发）', () => {
  it('B1 suppressTriggers=true → 输入 !echo $HOME 过程四路 trigger 全 null（emit 层）', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    // 「!echo $HOME」：$ 前有空格（若未短路会命中 file-trigger）
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    const session = wrapper.emitted('session-trigger')
    const file = wrapper.emitted('file-trigger')
    const subagent = wrapper.emitted('subagent-trigger')
    const slash = wrapper.emitted('slash-trigger')
    // bash 短路：检测回调统一发 null（关闭浮层语义），绝不出现非 null payload
    expect(session?.every((args) => args[0] === null) ?? true).toBe(true)
    expect(file?.every((args) => args[0] === null) ?? true).toBe(true)
    expect(subagent?.every((args) => args[0] === null) ?? true).toBe(true)
    expect(slash?.every((args) => args[0] === null) ?? true).toBe(true)
    // 输入区 DOM 不受影响（draft 正常）
    expect((wrapper.find('[role="textbox"]').element as HTMLDivElement).textContent).toBe('!echo $HOME')
  })

  it('B2 suppressTriggers=false（默认）→ $ 照常触发 file-trigger（对照：短路仅 bash 态生效）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: 'HOME' })
  })
})

// ─────────────────────── U7-U9 CommandPopover file 过滤 + 路径（$ 迁移后行为不变） ───────────────────────

// 两条同源不同路径的 auth 文件 + 一条 tools 目录（验证 query 命中 path 与 name）
const MOCK_FILES: FileNode[] = [
  { path: 'src/auth/token.ts', name: 'token.ts', type: 'file' },
  { path: 'src/auth/AuthService.ts', name: 'AuthService.ts', type: 'file' },
  { path: 'tools/auth.ts', name: 'auth.ts', type: 'file' },
  { path: 'utils/format.ts', name: 'format.ts', type: 'file' },
  { path: 'src/utils', name: 'utils', type: 'dir' },
]

describe('CommandPopover file query 过滤 + 路径展示（U7-U9）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountFilePopover(query: string): Promise<void> {
    mockLoad.mockResolvedValueOnce(MOCK_FILES)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's1', query },
    })
    await flushPromises()
    await nextTick()
  }

  /** body 内的 file 候选行（含文件名/路径文本）。 */
  function bodyButtons(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('.cmd-row')).filter((b) => {
      const t = b.textContent ?? ''
      return t.includes('.ts') || t.includes('/') || t.includes('utils')
    })
  }

  it('U7 query="auth" → 命中 name+path 含 auth 的 3 条（src/auth/* + tools/auth.ts）', async () => {
    await mountFilePopover('auth')
    const btns = bodyButtons()
    expect(btns).toHaveLength(3)
    const texts = btns.map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('token.ts'))).toBe(true)
    expect(texts.some((t) => t.includes('AuthService.ts'))).toBe(true)
    expect(texts.some((t) => t.includes('auth.ts'))).toBe(true)
    expect(texts.some((t) => t.includes('format.ts'))).toBe(false)
  })

  it('U8 query="zzz" → 0 项，PopoverContent 不渲染', async () => {
    await mountFilePopover('zzz')
    expect(bodyButtons()).toHaveLength(0)
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  it('U9 两行展示：文件名主行 + 父目录路径副行（区分同名文件）', async () => {
    await mountFilePopover('')
    const btns = bodyButtons()
    const tokenBtn = btns.find((b) => (b.textContent ?? '').includes('token.ts'))
    expect(tokenBtn).toBeDefined()
    expect(tokenBtn?.textContent ?? '').toContain('src/auth/')
    const utilsBtn = btns.find((b) => {
      const t = b.textContent ?? ''
      return t.includes('utils/') && t.includes('src/')
    })
    expect(utilsBtn).toBeDefined()
  })
})

// ─────────────────────── S 组 CommandPopover session 候选（# 新语义） ───────────────────────

const NOW = Date.now()
/** 跨 cwd 两组 session：alpha（1m 前，proj-a）/ beta（3h 前，proj-b）——验证全局降序 + 两行副行 */
const SESSION_GROUPS: SessionGroup[] = [
  { cwd: '/Users/x/proj-a', sessions: [
    { id: 'sess-alpha', label: 'alpha 设计讨论', cwd: '/Users/x/proj-a', status: 'idle', lastActiveAt: NOW - 90_000, modelId: 'm', tokenCount: 0 },
  ] },
  { cwd: '/Users/x/proj-b', sessions: [
    { id: 'sess-beta', label: 'beta review', cwd: '/Users/x/proj-b', status: 'idle', lastActiveAt: NOW - 3 * 3_600_000, modelId: 'm', tokenCount: 0 },
  ] },
]

describe('CommandPopover session 候选（S 组，# session 语义）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function seedSessions(): void {
    useSessionStore().applySnapshot({ groups: SESSION_GROUPS })
  }

  function bodyRows(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('.cmd-row'))
  }

  it('S1 跨 cwd 候选按 lastActiveAt 降序 + 两行展示（label 主行 + cwd·age 副行）', async () => {
    seedSessions()
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'session', sessionId: 's1', query: '' },
    })
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(2)
    // 全局降序：较新的 alpha 在前（跨 cwd 分组数据源）
    expect(rows[0]?.textContent ?? '').toContain('alpha 设计讨论')
    expect(rows[0]?.textContent ?? '').toContain('/Users/x/proj-a')
    expect(rows[0]?.textContent ?? '').toContain('1m')
    expect(rows[1]?.textContent ?? '').toContain('beta review')
    expect(rows[1]?.textContent ?? '').toContain('3h')
  })

  it('S2 query 按 label 子串过滤（sess-b 输入到 beta）', async () => {
    seedSessions()
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'session', sessionId: 's1', query: 'beta' },
    })
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent ?? '').toContain('beta review')
  })

  it('S3 query 按 id 子串过滤（uuid 片段命中）', async () => {
    seedSessions()
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'session', sessionId: 's1', query: 'sess-alpha' },
    })
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent ?? '').toContain('alpha 设计讨论')
  })

  it('S4 landing 态（无 sessionId）+ sessionStore 有数据 → # 浮层渲染候选行（D1 删门：session 候选与目录/sessionId 无关）', async () => {
    seedSessions()
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'session' },
    })
    await nextTick()
    // landing（无 sessionId）与 panel 同源同列（G2/S4a：常驻 sessionStore 直接列，无拉取无门）
    const rows = bodyRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent ?? '').toContain('alpha 设计讨论')
    // PopoverContent 真实挂载（本仓 reka-ui 版本 wrapper 属性为 data-reka-*）
    expect(document.body.querySelector('[data-reka-popper-content-wrapper]')).not.toBeNull()
  })
})

// ─────────────────────── A 组 CommandPopover subagent 候选（@ 新语义） ───────────────────────

const SUBAGENT_FIXTURE: SubagentRecord[] = [
  { subagentId: 'bg-build-1', sessionFile: null, agent: 'worker', slug: 'build-api', task: 't', status: 'running' },
  { subagentId: 'bg-test-2', sessionFile: null, agent: 'verifier', slug: 'test-auth', task: 't', status: 'closed' },
]

describe('CommandPopover subagent 候选（A 组，@ subagent 语义）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function bodyRows(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('.cmd-row'))
  }

  it('A1 列表项两行（slug 主行 + agent·status 副行）+ 固定尾部「＋ 新建 subagent」项', async () => {
    useSubagentStore().applyRecords('s1', SUBAGENT_FIXTURE)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'subagent', sessionId: 's1', query: '' },
    })
    await nextTick()
    const rows = bodyRows()
    // 2 条 record + 1 条固定「新建」尾部项
    expect(rows).toHaveLength(3)
    const buildRow = rows.find((r) => (r.textContent ?? '').includes('build-api'))
    expect(buildRow?.textContent ?? '').toContain('worker')
    expect(buildRow?.textContent ?? '').toContain('running')
    const last = rows[rows.length - 1]?.textContent ?? ''
    expect(last).toContain('新建 subagent')
  })

  it('A2 选中 record 项 → select payload 带 subagentId/slug（经 data 属性可追溯）', async () => {
    useSubagentStore().applyRecords('s1', SUBAGENT_FIXTURE)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'subagent', sessionId: 's1', query: 'test' },
    })
    await nextTick()
    const rows = bodyRows()
    // query 过滤后仅 test-auth + 新建项
    expect(rows).toHaveLength(2)
    await (rows[0] as HTMLElement).click()
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeDefined()
    const payload = emitted!.at(-1)![0] as { type: string; subagentId: string; slug: string }
    expect(payload.type).toBe('subagent')
    expect(payload.subagentId).toBe('bg-test-2')
    expect(payload.slug).toBe('test-auth')
  })

  it('A3 选中「新建」项 → select payload subagentId/slug 均空串（语义由上层定）', async () => {
    useSubagentStore().applyRecords('s1', SUBAGENT_FIXTURE)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'subagent', sessionId: 's1', query: '' },
    })
    await nextTick()
    const rows = bodyRows()
    const newBtn = rows.find((r) => (r.textContent ?? '').includes('新建 subagent'))
    expect(newBtn).toBeDefined()
    await (newBtn as HTMLElement).click()
    const payload = wrapper.emitted('select')!.at(-1)![0] as { subagentId: string; slug: string }
    expect(payload.subagentId).toBe('')
    expect(payload.slug).toBe('')
  })

  it('A4 浮层打开（false→true）触发 loadSubagents（getSubagents RPC 被调）', async () => {
    getSubagentsMock.mockResolvedValueOnce(SUBAGENT_FIXTURE)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'subagent', sessionId: 's1', query: '' },
    })
    await nextTick()
    expect(getSubagentsMock).not.toHaveBeenCalled()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getSubagentsMock).toHaveBeenCalledWith('s1')
    // load 完成后 store 分区有 records → DOM 出现候选行（用户可见）
    const rows = bodyRows()
    expect(rows.some((r) => (r.textContent ?? '').includes('build-api'))).toBe(true)
  })

  it('A5 landing 态（无 sessionId）候选为空（含新建项也不渲染）→ 浮层不弹', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'subagent' },
    })
    await nextTick()
    expect(bodyRows()).toHaveLength(0)
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })
})

// ─────────────────────── SL 组 slash 打开主动拉（U3 renderer 部分） ───────────────────────

describe('slash 浮层打开主动拉（SL 组）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function bodyRows(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('.cmd-row'))
  }

  it('SL1 open false→true 且 type=slash 且有 sessionId → getCommands 被调 + 回填后 DOM 出现命令', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'slash', sessionId: 's1', query: '' },
    })
    await nextTick()
    // 合并语义：useCommandSync 挂载即拉（dev-0.9.9 帧丢失兜底），先让它完成并清计数
    await flushPromises()
    getCommandsMock.mockReset()
    getCommandsMock.mockResolvedValueOnce({ sessionId: 's1', commands: [{ name: '/demo-skill', source: 'skill', description: '演示' }] })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getCommandsMock).toHaveBeenCalledTimes(1)
    expect(getCommandsMock).toHaveBeenCalledWith('s1')
    // 回填 commandStore 后浮层渲染新命令（用户可见 DOM）
    const rows = bodyRows()
    expect(rows.some((r) => (r.textContent ?? '').includes('demo-skill'))).toBe(true)
  })

  it('SL2 landing 态（无 sessionId）打开不拉 getCommands', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'slash', query: '' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getCommandsMock).not.toHaveBeenCalled()
  })

  it('SL3 1s 节流：浮层反复开关（窗口内）不重复拉', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'slash', sessionId: 's1', query: '' },
    })
    await nextTick()
    // 挂载即拉（useCommandSync）完成并清计数，聚焦验证 open-fetch 节流
    await flushPromises()
    getCommandsMock.mockReset()
    getCommandsMock.mockResolvedValue({ sessionId: 's1', commands: [] })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getCommandsMock).toHaveBeenCalledTimes(1)
    // 关→开（1s 窗口内）：节流命中，不重拉
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getCommandsMock).toHaveBeenCalledTimes(1)
  })

  it('SL4 getCommands 失败 → 静默保留旧快照（不 throw、浮层不空转报错）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'slash', sessionId: 's1', query: '' },
    })
    await nextTick()
    // 挂载即拉（useCommandSync）完成并清计数，让 open 拉取消耗 rejected 值
    await flushPromises()
    getCommandsMock.mockReset()
    getCommandsMock.mockRejectedValueOnce(new Error('ws down'))
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getCommandsMock).toHaveBeenCalledTimes(1)
    // unhandled rejection 不冒泡为测试失败即通过（浮层照常渲染 compact 内置命令）
    const rows = bodyRows()
    expect(rows.some((r) => (r.textContent ?? '').includes('compact'))).toBe(true)
  })
})

// ─────────────────────── U10 + B 组 wiring：Composer 路由 ───────────────────────

/** CommandPopover stub：把 props 反映到 data-* 属性供 DOM 断言 */
const CommandPopoverStub = defineComponent({
  name: 'CommandPopover',
  props: {
    open: { type: Boolean, default: false },
    type: { type: String, default: 'file' },
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

const AddMenuPopoverStub = defineComponent({
  name: 'AddMenuPopover',
  emits: ['select'],
  template: '<button data-testid="add-cmd" @click="$emit(\'select\', \'slash\')" />',
})

const SIMPLE = { template: '<div />' }
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

/** 真实 ComposerInput：设文本 + 定位光标 + trigger input（复用 typeWithCursor 的定位逻辑） */
async function typeInComposer(
  wrapper: ReturnType<typeof mount>,
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  const input = wrapper.find('[role="textbox"]')
  const el = input.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, Math.min(cursorOffset, text.length))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await input.trigger('input')
  await nextTick()
}

describe('Composer 四符号 wiring（U10）', () => {
  it('U10a ComposerInput emit session-trigger {query:"auth"}（# 输入）→ CommandPopover 收到 open/type=session/query', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeInComposer(wrapper, '#auth', 5)
    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('true')
    expect(cp.attributes('data-type')).toBe('session')
    expect(cp.attributes('data-query')).toBe('auth')
  })

  it('U10b ComposerInput emit file-trigger {query:"auth"}（$ 输入）→ CommandPopover 收到 open/type=file/query', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeInComposer(wrapper, '$auth', 5)
    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('true')
    expect(cp.attributes('data-type')).toBe('file')
    expect(cp.attributes('data-query')).toBe('auth')
  })

  it('U10c ComposerInput emit subagent-trigger {query:"build"}（@ 输入）→ CommandPopover 收到 open/type=subagent/query', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeInComposer(wrapper, '@build', 6)
    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('true')
    expect(cp.attributes('data-type')).toBe('subagent')
    expect(cp.attributes('data-query')).toBe('build')
  })

  it('W1 bash wiring：输入 ! 后继续输入 !echo $HOME → 浮层不开（isBashMode → suppressTriggers）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // 第一步：输入 '!' 建立 bash 态 draft（等 suppressTriggers prop 传递）
    await typeInComposer(wrapper, '!', 1)
    // 第二步：继续输入（真实用户逐字符路径，$ 前空格若未短路会开 file 浮层）
    await typeInComposer(wrapper, '!echo $HOME', 11)
    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('false')
  })
})

// ─────────────────────── C 组 选中插 chip 集成（真实 ComposerInput + 真实 CommandPopover） ───────────────────────

describe('选中插 chip 集成（C 组，真实浮层 + 真实输入区）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function mountRealComposer(): ReturnType<typeof mount> {
    return mount(Composer, {
      attachTo: document.body,
      props: { sessionId: 's1', variant: 'panel' },
      global: {
        stubs: {
          AddMenuPopover: AddMenuPopoverStub,
          ContextChipsBar: SIMPLE,
          ContextCapacityPopover: SIMPLE,
          ModelSelectPopover: SIMPLE,
          ThinkingLevelPopover: SIMPLE,
          RetryIndicator: SIMPLE,
          QueueBubble: SIMPLE,
        },
      },
    })
  }

  function chipEls(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll('.mention-chip'))
  }

  it('C1 # 选 session → 插 .mention-session chip（显示 label 非 uuid，dataset 带 sessionId）', async () => {
    useSessionStore().applySnapshot({ groups: SESSION_GROUPS })
    wrapper = mountRealComposer()
    await flushPromises()
    await typeInComposer(wrapper, '#alpha', 6)
    await nextTick()
    const row = Array.from(document.body.querySelectorAll('.cmd-row')).find((r) => (r.textContent ?? '').includes('alpha 设计讨论'))
    expect(row).toBeDefined()
    await (row as HTMLElement).click()
    await nextTick()
    const chips = chipEls(wrapper.find('[role="textbox"]').element as HTMLDivElement)
    expect(chips).toHaveLength(1)
    expect(chips[0]?.classList.contains('mention-session')).toBe(true)
    // chip 显示 label（人可读标题）而非 uuid；dataset 携带 sessionId 供 segment 解析
    expect(chips[0]?.textContent ?? '').toContain('alpha 设计讨论')
    expect(chips[0]?.dataset.chipSessionId).toBe('sess-alpha')
    // #query 过滤文本被清除（boundaryLen 模式只删 #alpha 段）
    expect((wrapper!.find('[role="textbox"]').element as HTMLDivElement).textContent ?? '').not.toContain('#alpha')
  })

  it('C2 @ 选 subagent → 插 .mention-at chip（@slug + dataset.chipSubagentId）', async () => {
    getSubagentsMock.mockResolvedValueOnce(SUBAGENT_FIXTURE)
    wrapper = mountRealComposer()
    await flushPromises()
    await typeInComposer(wrapper, '@build', 6)
    await flushPromises()
    await nextTick()
    const row = Array.from(document.body.querySelectorAll('.cmd-row')).find((r) => (r.textContent ?? '').includes('build-api'))
    expect(row).toBeDefined()
    await (row as HTMLElement).click()
    await nextTick()
    const chips = chipEls(wrapper.find('[role="textbox"]').element as HTMLDivElement)
    expect(chips).toHaveLength(1)
    expect(chips[0]?.classList.contains('mention-at')).toBe(true)
    expect(chips[0]?.textContent ?? '').toContain('@build-api')
    expect(chips[0]?.dataset.chipSubagentId).toBe('bg-build-1')
    expect(chips[0]?.dataset.chipSlug).toBe('build-api')
  })

  it('C3 @ 选「＋ 新建 subagent」→ 插占位 slug chip（@新任务，subagentId 空串）', async () => {
    getSubagentsMock.mockResolvedValueOnce(SUBAGENT_FIXTURE)
    wrapper = mountRealComposer()
    await flushPromises()
    await typeInComposer(wrapper, '@', 1)
    await flushPromises()
    await nextTick()
    const row = Array.from(document.body.querySelectorAll('.cmd-row')).find((r) => (r.textContent ?? '').includes('新建 subagent'))
    expect(row).toBeDefined()
    await (row as HTMLElement).click()
    await nextTick()
    const chips = chipEls(wrapper.find('[role="textbox"]').element as HTMLDivElement)
    expect(chips).toHaveLength(1)
    // 新建项两字段空串 → 上层插 i18n 占位 slug chip（设计 3.1.3 场景 2「@新任务」）
    expect(chips[0]?.textContent ?? '').toContain('@新任务')
    expect(chips[0]?.dataset.chipSubagentId).toBe('')
    expect(chips[0]?.dataset.chipSlug).toBe('新任务')
  })
})
