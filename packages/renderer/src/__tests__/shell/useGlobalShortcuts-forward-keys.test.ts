/**
 * shell composables 单文件合并（round5-d 分区 4 簇 4-19；round5-f S11 二级合并并入
 * useSidebar-reconnect-reconcile，describe/it 原样搬运，环境均默认）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——两文件共同装载 vue / pinia /
 * shared / @taiji/core 等重模块，单文件共享一份装载。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - useGlobalShortcuts-forward-keys.test.ts（view 转发键清单 renderer 半边 §7.4，主体）
 *  - use-narrow-window-collapse.test.ts（窄窗自动折叠 matchMedia 接线）
 *
 * 冲突处理（试点模式）：
 *  - 主体的三处 vi.mock（'@/lib/ipc' 与 '@taiji/core' 均 spread actual 只换转发/
 *    useSearchModal；useCommandStore 窄 mock）为文件级——已静态核实窄窗节
 *    （useNarrowWindowCollapse + sidebar store）不消费 ipc / commandStore / useSearchModal，零泄漏
 *  - 窄窗节顶层 beforeEach（pinia 重建 + unstubAllGlobals + localStorage 清理，
 *    均幂等）提升为文件级公共 hook——主体的 matchMedia stub 无（其 describe 内
 *    beforeEach 原样在节内），公共 unstub 对其零影响
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/useGlobalShortcuts-forward-keys.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { notifyConnectedEdge } from '@taiji/core'

/** ipc mock：转发三 API 可控（其余导出走真实实现——纯类型 + 无副作用模块） */
const ipcMock = vi.hoisted(() => ({
  setForwardKeys: vi.fn(() => Promise.resolve({ accepted: [], rejected: [] })),
  updateForwardKeys: vi.fn(() => Promise.resolve({ accepted: [], rejected: [] })),
  forwardKeyHandlers: [] as Array<(payload: { accelerator: string }) => void>,
}))
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return {
    ...actual,
    browserSetForwardKeys: (...args: Parameters<typeof actual.browserSetForwardKeys>) => ipcMock.setForwardKeys(...args),
    browserUpdateForwardKeys: (...args: Parameters<typeof actual.browserUpdateForwardKeys>) => ipcMock.updateForwardKeys(...args),
    onBrowserForwardKey: (cb: (payload: { accelerator: string }) => void) => {
      ipcMock.forwardKeyHandlers.push(cb)
      return () => {
        const idx = ipcMock.forwardKeyHandlers.indexOf(cb)
        if (idx >= 0) ipcMock.forwardKeyHandlers.splice(idx, 1)
      }
    },
  }
})

/** commandStore 壳 mock：shortcutOverrides 可控 ref（重录触发范围驱动点；真 ref 使 watch 可触发） */
const commandStoreMock = vi.hoisted(() => ({
  overrides: null as { value: Record<string, string> } | null,
}))
vi.mock('@/composables/features/command/useCommandStore', async () => {
  const { ref } = await import('vue')
  const overridesRef = ref<Record<string, string>>({})
  commandStoreMock.overrides = overridesRef
  return {
    useCommandStore: () => ({ shortcutOverrides: overridesRef }),
  }
})

const searchModalMock = vi.hoisted(() => ({
  toggle: vi.fn(),
}))
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    useSearchModal: () => ({ toggle: searchModalMock.toggle }),
  }
})

import {
  useGlobalShortcuts,
  deriveForwardAccelerators,
  effectiveAcceleratorOf,
  isForwardableAccelerator,
  matchKeymapEntry,
  type UseGlobalShortcutsOptions,
} from '@/composables/shell/useGlobalShortcuts'
import { useNavigationStore } from '@/stores/navigation'
import { useNarrowWindowCollapse } from '@/composables/shell/useNarrowWindowCollapse'
import { useSidebarStore } from '@/stores/sidebar'
import { resetAppBootstrap, useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useChatStore } from '@/stores/chat'
import { usePanelStore } from '@/stores/panel'

/** 键矩阵行：input × accelerator × 主进程期望判定（与 apps/electron/main/test/
 *  browser-forward-keys.test.ts 的 MATRIX 逐行同源——改任一侧必须同步另一侧） */
const MATRIX: Array<{
  name: string
  input: { key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean }
  accelerator: string
  expected: boolean
}> = [
  { name: 'mod+k × ⌘K', input: { key: 'k', meta: true }, accelerator: 'mod+k', expected: true },
  { name: 'mod+k × ⌃K', input: { key: 'k', control: true }, accelerator: 'mod+k', expected: true },
  { name: 'mod+k × ⌘⇧K（shift 严格双分）', input: { key: 'k', meta: true, shift: true }, accelerator: 'mod+k', expected: false },
  { name: 'mod+shift+k × ⌘⇧K', input: { key: 'k', meta: true, shift: true }, accelerator: 'mod+shift+k', expected: true },
  { name: 'mod+shift+k × ⌃⇧K', input: { key: 'k', control: true, shift: true }, accelerator: 'mod+shift+k', expected: true },
  { name: 'mod+shift+k × ⌘K（shift 严格双分）', input: { key: 'k', meta: true }, accelerator: 'mod+shift+k', expected: false },
  { name: 'mod+k × ⌥⌘K（alt 拒绝）', input: { key: 'k', meta: true, alt: true }, accelerator: 'mod+k', expected: false },
  { name: 'mod+shift+p × ⌥⌘⇧P（alt 拒绝）', input: { key: 'p', meta: true, shift: true, alt: true }, accelerator: 'mod+shift+p', expected: false },
  { name: 'mod+k × 裸 k', input: { key: 'k' }, accelerator: 'mod+k', expected: false },
  { name: "裸 'j' 清单项 × ⌘J（不入清单，永不匹配）", input: { key: 'j', meta: true }, accelerator: 'j', expected: false },
  { name: "shift-only 'shift+j' 清单项 × ⌘⇧J（不入清单）", input: { key: 'j', meta: true, shift: true }, accelerator: 'shift+j', expected: false },
  { name: 'mod+p × ⌘P（大小写归一）', input: { key: 'P', meta: true }, accelerator: 'mod+p', expected: true },
  { name: 'mod+, × ⌘,', input: { key: ',', meta: true }, accelerator: 'mod+,', expected: true },
  { name: 'mod+[ × ⌘[', input: { key: '[', control: true }, accelerator: 'mod+[', expected: true },
  { name: 'mod+escape 清单项 × ⌥⌘Esc（Esc 不入清单）', input: { key: 'escape', meta: true }, accelerator: 'mod+escape', expected: false },
]

/** 由矩阵行 accelerator 构造同义 keymap entry（无 override 默认路径） */
function entryFor(accelerator: string): { key: string; shift?: boolean } {
  const parts = accelerator.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  return { key, shift: parts.includes('shift') || undefined }
}

function toShortcutInput(input: { key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean }) {
  return { key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }
}


// 公共 hook（窄窗节顶层 beforeEach 提升为文件级：pinia 重建 + unstubAllGlobals +
// localStorage 清理，均幂等重置；主体节无 stubGlobal，unstub 零影响）
beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
  localStorage.removeItem('taiji:side-collapsed')
})

describe('键矩阵：renderer 判定与主进程同判定（§7.4 配对契约）', () => {
  for (const row of MATRIX) {
    it(`${row.name} → 主进程 ${row.expected ? 'match' : 'no match'}`, () => {
      const entry = entryFor(row.accelerator)
      const listMembership = deriveForwardAccelerators([entry], {}).includes(row.accelerator)
      if (!isForwardableAccelerator(row.accelerator)) {
        // 不入清单项（裸 'j' / shift-only / mod+escape）：两侧同判「永不生效」——
        // 主进程 parse 拒绝（expected=false ⇒ 永不转发），renderer 清单不含 ⇒ 无从派发
        expect(row.expected).toBe(false)
        expect(listMembership).toBe(false)
        return
      }
      expect(listMembership, '可转发项必须在派生清单内（注册契约）').toBe(true)
      const rendererHit = matchKeymapEntry(toShortcutInput(row.input), entry, {})
      if (row.input.alt) {
        // 已知不对称（F1-18 登记）：renderer 不拒绝未声明修饰键、主进程严格拒绝——
        // 方向安全断言：renderer 判定 ⊇ 主进程（主进程不转发 ⇒ renderer 侧不产生误转发）
        expect(row.expected).toBe(false)
        expect(rendererHit).toBe(true)
      } else {
        expect(rendererHit).toBe(row.expected)
      }
    })
  }
})

describe('入清单约束（deriveForwardAccelerators 镜像主进程 parseForwardAccelerator）', () => {
  it('mod 前缀组合入清单；裸键/shift-only/alt/Esc override 拒绝（页面聚焦态不生效，已知边界）', () => {
    expect(isForwardableAccelerator('mod+k')).toBe(true)
    expect(isForwardableAccelerator('mod+shift+p')).toBe(true)
    expect(isForwardableAccelerator('MOD+K')).toBe(true)
    for (const spec of ['j', 'shift+j', 'alt+x', 'mod+alt+x', 'escape', 'mod+escape', '', 'mod+', 'shift', 'mod+shift', 'ctrl+k']) {
      expect(isForwardableAccelerator(spec), spec).toBe(false)
    }
  })

  it('派生清单：默认 keymap 产生 mod 前缀全集；override 替换生效 accelerator；非法 override 不入', () => {
    const keymap = [
      { key: 'k', action: () => {} },
      { key: 'p', shift: true, commandId: 'open-preset-select', action: () => {} },
      { key: 'n', commandId: 'new-session', action: () => {} },
    ]
    expect(deriveForwardAccelerators(keymap, {})).toEqual(['mod+k', 'mod+shift+p', 'mod+n'])
    // 重录 new-session → mod+m（旧 accelerator 从清单消失，由 update 增量上报）
    expect(deriveForwardAccelerators(keymap, { 'new-session': 'mod+m' })).toEqual(['mod+k', 'mod+shift+p', 'mod+m'])
    // 重录为裸键/alt → 不入清单（该 override 页面聚焦态不生效）
    expect(deriveForwardAccelerators(keymap, { 'new-session': 'j' })).toEqual(['mod+k', 'mod+shift+p'])
    expect(deriveForwardAccelerators(keymap, { 'new-session': 'alt+n' })).toEqual(['mod+k', 'mod+shift+p'])
    expect(effectiveAcceleratorOf(keymap[1]!, {})).toBe('mod+shift+p')
  })
})

describe('上报与派发（useGlobalShortcuts 装配点）', () => {
  function mountShortcuts(options?: Partial<UseGlobalShortcutsOptions>): () => void {
    const scope = effectScope()
    scope.run(() =>
      useGlobalShortcuts({
        onNewSession: vi.fn(),
        forkFromLastAssistant: vi.fn(),
        enterForkModeFromLastAssistant: vi.fn(),
        handoffFromLastAssistant: vi.fn(),
        navigation: useNavigationStore(),
        openSettings: vi.fn(),
        ...options,
      }),
    )
    return () => scope.stop()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    commandStoreMock.overrides!.value = {}
    ipcMock.forwardKeyHandlers.length = 0
  })

  it('setup 即全量重报（初始化/renderer 重载/崩溃恢复同一入口）：清单含默认 mod 族，非法项不出现在上报', async () => {
    const stop = mountShortcuts()
    expect(ipcMock.setForwardKeys).toHaveBeenCalledTimes(1)
    const reported = ipcMock.setForwardKeys.mock.calls[0]![0] as string[]
    expect(reported).toContain('mod+k')
    expect(reported).toContain('mod+shift+p')
    expect(reported).toContain('mod+,')
    for (const acc of reported) expect(isForwardableAccelerator(acc), acc).toBe(true)
    stop()
  })

  it('settings 重录（overrides 变化）→ browserUpdateForwardKeys 注册/注销增量', async () => {
    const stop = mountShortcuts()
    ipcMock.setForwardKeys.mockClear()
    commandStoreMock.overrides!.value = { 'new-session': 'mod+m' }
    await vi.waitFor(() => expect(ipcMock.updateForwardKeys).toHaveBeenCalledTimes(1))
    expect(ipcMock.updateForwardKeys.mock.calls[0]![0]).toEqual({ add: ['mod+m'], remove: ['mod+n'] })
    expect(ipcMock.setForwardKeys).not.toHaveBeenCalled()
    stop()
  })

  it('转发派发：⌘K accelerator → search toggle；⌘, → openSettings；未登记 accelerator 不动作', () => {
    const openSettings = vi.fn()
    const stop = mountShortcuts({ openSettings })
    expect(ipcMock.forwardKeyHandlers.length).toBe(1)
    const dispatch = ipcMock.forwardKeyHandlers[0]!

    dispatch({ accelerator: 'mod+k' })
    expect(searchModalMock.toggle).toHaveBeenCalledTimes(1)

    dispatch({ accelerator: 'mod+,' })
    expect(openSettings).toHaveBeenCalledTimes(1)

    // 未登记/非法 accelerator（主进程不会转发，防御性断言）→ 无动作
    dispatch({ accelerator: 'mod+escape' })
    dispatch({ accelerator: 'j' })
    expect(searchModalMock.toggle).toHaveBeenCalledTimes(1)
    expect(openSettings).toHaveBeenCalledTimes(1)
    stop()
  })

  it('guardComposerFocus 不用于转发派发（焦点在 WebContentsView 时 composer 必非输入态）', () => {
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"><div contenteditable="true"></div></div>'
    try {
      const forkFromLastAssistant = vi.fn()
      const stop = mountShortcuts({ forkFromLastAssistant })
      const dispatch = ipcMock.forwardKeyHandlers[0]!
      const composer = document.querySelector('[data-testid="composer-box"]') as HTMLElement
      composer.querySelector('[contenteditable="true"]')!.focus()
      // 宿主 window keydown 路径会因 composer 聚焦禁用 fork 条目；转发路径不适用该检查
      dispatch({ accelerator: 'mod+g' })
      expect(forkFromLastAssistant).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      document.body.innerHTML = ''
    }
  })
})


// ══════════ 来源：use-narrow-window-collapse.test.ts（窄窗自动折叠；顶层 beforeEach
//             已提升为文件级公共 hook） ══════════

/** 可控假 MQL：matches 可写 + 手动派发 change（事件对象含 matches 字段） */
interface FakeMql { // oe-exempt:20261011:test:matchMedia 测试替身类型（jsdom 无 MQL 实装），单实现即终态非等待变体
  matches: boolean
  listeners: Array<(e: { matches: boolean }) => void>
  addEventListener(type: string, fn: (e: { matches: boolean }) => void): void
  removeEventListener(type: string, fn: (e: { matches: boolean }) => void): void
  dispatch(matches: boolean): void
}

function installFakeMatchMedia(initialMatches: boolean): FakeMql {
  const mql: FakeMql = {
    matches: initialMatches,
    listeners: [],
    addEventListener(_type, fn) {
      this.listeners.push(fn)
    },
    removeEventListener(_type, fn) {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    },
    dispatch(matches) {
      this.matches = matches
      this.listeners.forEach((fn) => fn({ matches }))
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue(mql as unknown as MediaQueryList),
  )
  return mql
}

/** 挂载宿主组件（composable 需组件实例上下文） */
function mountHost() {
  const Host = defineComponent({
    setup() {
      useNarrowWindowCollapse()
      return () => h('div')
    },
  })
  return mount(Host)
}

describe('useNarrowWindowCollapse（demo shell spec §3.6，两事实源合成）', () => {
  it('首屏即窄窗（matches=true）→ 挂载即折叠（视口强制位生效）', () => {
    installFakeMatchMedia(true)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.viewportNarrow).toBe(true)
    expect(sidebar.collapsed).toBe(true)
    expect(sidebar.userCollapsed).toBe(false)
    wrapper.unmount()
  })

  it('宽窗进入断点 → 折叠；放宽（无用户意图）→ 自动弹回', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.collapsed).toBe(false)

    mql.dispatch(true)
    expect(sidebar.viewportNarrow).toBe(true)
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(false)
    expect(sidebar.viewportNarrow).toBe(false)
    expect(sidebar.collapsed).toBe(false)
    wrapper.unmount()
  })

  it('宽窗手动收起（用户显式意图）→ 缩窗 → 放宽 → 保持收起', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()

    sidebar.toggleCollapsed()
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(true)
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(false)
    expect(sidebar.viewportNarrow).toBe(false)
    expect(sidebar.userCollapsed).toBe(true)
    expect(sidebar.collapsed).toBe(true)
    wrapper.unmount()
  })

  it('卸载摘除 matchMedia listener（重挂不残留双监听）', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    expect(mql.listeners.length).toBe(1)

    wrapper.unmount()
    expect(mql.listeners.length).toBe(0)

    // 卸载后派发 change 不再触达 store
    mql.dispatch(true)
    expect(useSidebarStore().collapsed).toBe(false)
  })

  it('matchMedia 缺失（老环境）→ 静默跳过，视口位保持 false', () => {
    vi.stubGlobal('matchMedia', undefined)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.viewportNarrow).toBe(false)
    expect(sidebar.collapsed).toBe(false)
    wrapper.unmount()
  })
})

// ═══ 来源：useSidebar-reconnect-reconcile.test.ts ═══
const mockGetHistory = vi.fn(() => Promise.resolve({
  messages: [],
  truncated: false,
  loadedTurns: 0,
  totalTurnsEstimate: 0,
}))

/** 排空重连对账链微任务（域同步器边沿 → 辅助刷新 refreshHistory 的 RPC 就绪等待）。 */
async function flushReconcile(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// api 域 mock：chat.getHistory 是断言目标（core refreshHistory 的 RPC 出口）；其余为
// onConnected 链路（workspace.load / extension.scan / subagent/workflow 列表 / initApp
// 编排）的 no-op 壳，防 unhandled rejection。
vi.mock('@/api', () => ({
  chat: { getHistory: (...args: unknown[]) => mockGetHistory(...(args as [])), streamSubscribe: vi.fn(() => () => {}) },
  session: {
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    switchSession: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    removeByCwd: vi.fn(() => Promise.resolve({ cwd: '/proj', deleted: [], failed: [] })),
    rename: vi.fn(() => Promise.resolve()),
    restoreSession: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    getCommands: vi.fn(() => Promise.resolve({ sessionId: 'mock', commands: [] })),
    getContext: vi.fn(() => Promise.resolve({ inputTokens: 0, contextLimit: 0, usagePercent: 0 })),
    getSubagents: vi.fn(() => Promise.resolve({ subagents: [], oversize: false, found: true })),
    getWorkflows: vi.fn(() => Promise.resolve({ workflows: [], oversize: false, found: true })),
    setProject: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    unsubscribe: vi.fn(() => Promise.resolve()),
  },
  extension: { scan: vi.fn(() => Promise.resolve({ extensions: [] })) },
  workspace: {
    listRecent: vi.fn(() => Promise.resolve([])),
    defaultSessionDir: vi.fn(() => Promise.resolve('')),
  },
  project: { load: vi.fn(() => Promise.resolve({ projects: [], activeProjectId: '' })) },
  file: { tree: vi.fn(() => Promise.resolve([])), expand: vi.fn(() => Promise.resolve([])) },
  git: { status: vi.fn(() => Promise.resolve({ sessionId: 'mock', isRepo: false, files: [] })) },
}))

// initApp 编排的 landing 入口（newSession → startFlow）：no-op 壳（本测试不消费 landing 态）
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    isActive: { value: false },
    currentSession: { value: null },
    currentCwd: { value: null },
    currentModel: { value: null },
    startFlow: vi.fn(() => Promise.resolve()),
    presetCwd: vi.fn(),
    cancelFlow: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

/** 最小 user 消息（hydrate 分区置位用） */
function userMsg(id: string): Parameters<ReturnType<typeof useChatStore>['hydrate']>[1][number] {
  return { id, role: 'user', content: '历史消息', status: 'complete', timestamp: 0 }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  resetAppBootstrap()
})

describe('useSidebar 重连对账接线（U8；connection-datasync-ssot §6.4 起对账刷新由域同步器边沿触发）', () => {
  it('重连边沿：已 hydrate 的聚焦 session 经 core refreshHistory 触发 chat.getHistory 对账', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // 首连：走 initApp 分支（启动编排；辅助对账刷新只挂连接边沿，此阶段不产生对账拉取）
    await sidebar.onConnected()
    expect(mockGetHistory).not.toHaveBeenCalled()

    // 准备已 hydrate 的聚焦 session（refreshHistory 的 no-op 保护对未 hydrate 会话短路）
    const chat = useChatStore()
    chat.hydrate('rc-sid', [userMsg('u1')])
    usePanelStore().loadSession(usePanelStore().activePanelId, 'rc-sid')

    // 重连边沿（connected 迁移）：辅助刷新接线生效（getHistory RPC 直读 = 对账执行的可观测锚点）
    notifyConnectedEdge()
    await flushReconcile()
    expect(mockGetHistory).toHaveBeenCalledTimes(1)
    expect(mockGetHistory).toHaveBeenCalledWith('rc-sid')
    scope.stop()
  })

  it('重连边沿 + 未 hydrate 聚焦 session：refreshHistory 内部 no-op，不产生拉取（射程保护）', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.onConnected()
    usePanelStore().loadSession(usePanelStore().activePanelId, 'fresh-sid')

    notifyConnectedEdge()
    await flushReconcile()
    expect(mockGetHistory).not.toHaveBeenCalled()
    scope.stop()
  })

  it('首连（启动编排 initApp）：不走边沿辅助刷新，不触发对账拉取', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    const chat = useChatStore()
    chat.hydrate('rc-sid', [userMsg('u1')])
    usePanelStore().loadSession(usePanelStore().activePanelId, 'rc-sid')

    await sidebar.onConnected()
    expect(mockGetHistory).not.toHaveBeenCalled()
    scope.stop()
  })
})
