import { expectTextOnlyTabs } from '@/__tests__/helpers/sidebar-mount';
import Brand from '@/components/sidebar/Brand.vue';
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue';
import { registerFork, resetForkBranchState, syncForkBranches, unreadByBranch } from '@/composables/features/fork-handoff/useForkBranchNotify';
import { useSidebar, resetAppBootstrap } from '@/composables/features/sidebar/useSidebar';
import { isUnread, markUnread, __resetCacheForTest } from '@/composables/useSessionMarkers';
import { useSessionStore } from '@/stores/session';
import type { SidebarTab } from '@/stores/sidebar';
import { __resetDevModeForTesting, provideDevMode } from '@taiji/core';
import type { SessionGroup, SessionSummary } from '@taiji/shared';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/sidebar/fork-unread-clear-wiring.test.ts
 * - __tests__/sidebar/sidebar-micro-components.test.ts
 */

// ======================================================================
// ← __tests__/sidebar/fork-unread-clear-wiring.test.ts
// ======================================================================

const mocks = vi.hoisted(() => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
}))

// ── api 层 mock（selectSession 步 2 switchSession + 步 9 getHistory 需可控 stub）──
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  switchSession: mocks.switchSession,
  list: vi.fn().mockResolvedValue([]),
  remove: vi.fn(),
  // [remote-use D2] 桌面 evictLru 改接驱逐+退订复合入口，测试补该通道
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  create: vi.fn(),
  rename: vi.fn(),
  removeByCwd: vi.fn(),
  migrateImage: vi.fn(),
  writeSegments: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@taiji/core/transport/api/domains/chat', () => ({
  getHistory: vi
    .fn()
    .mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
  send: vi.fn(),
  streamSubscribe: vi.fn(),
}))
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  // [session-cold-switch-perf §3.3-3] historyCacheReady 订阅经 crossSession 通道
  // （session-api-port.onHistoryCacheReady 消费），mock 须提供
  onCrossSession: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@taiji/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  const chat = await import('@taiji/core/transport/api/domains/chat')
  return { ...actual, session, chat }
})
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: vi.fn(() => ({ disposeSession: vi.fn() })),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: vi.fn(() => ({ loadTree: vi.fn() })),
}))
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    clearCommands: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: vi.fn(() => ({
    isActive: { value: false },
    cancelFlow: vi.fn(),
    startFlow: vi.fn().mockResolvedValue(undefined),
    currentSession: { value: null },
    presetCwd: vi.fn(),
  })),
}))
// fork/handoff 编排与 select 链正交，stub 掉避免触真实 api/store 链
vi.mock('@/composables/features/fork-handoff/useForkActions', () => ({
  useForkActions: () => ({
    forkSession: vi.fn(),
    forkSessionAsk: vi.fn(),
    forkFromLastAssistant: vi.fn(),
    enterForkModeFromLastAssistant: vi.fn(),
  }),
}))
vi.mock('@/composables/features/fork-handoff/useHandoffActions', () => ({
  useHandoffActions: () => ({
    handoff: vi.fn(),
    abortHandoff: vi.fn(),
    handoffFromLastAssistant: vi.fn(),
    enterHandoffModeFromLastAssistant: vi.fn(),
  }),
}))

const CWD = '/p'
const PARENT_FILE = '/p/src.jsonl'

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-parent',
    label: '主分支会话',
    cwd: CWD,
    status: 'idle',
    lastActiveAt: Date.now(),
    ...overrides,
  }
}

function group(sessions: SessionSummary[]): SessionGroup {
  return { cwd: CWD, sessions }
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetAppBootstrap()
  localStorage.removeItem('taiji:session-markers')
  __resetCacheForTest()
  resetForkBranchState()
  vi.clearAllMocks()
})

describe('R5 接线：selectSession（点开）→ core 链 step 4 清两源未读', () => {
  it('后台完成 + 后台被停止两源都点亮后，selectSession(branchId) 一次清空两源（S9 ②）', async () => {
    const sid = 'b-select'
    // 两源均置位：① session 标记（后台完成 markUnread）② fork 分支角标（后台 stopped）
    markUnread(sid)
    registerFork('sess-parent', sid, '分支')
    syncForkBranches(
      [
        {
          cwd: CWD,
          sessions: [makeSession({ id: sid, parentSession: PARENT_FILE, status: 'stopped' })],
        } as SessionGroup,
      ],
      () => {},
    )
    // 前置：两源都点亮（未读点可见的充分条件）
    expect(isUnread(sid)).toBe(true)
    expect(unreadByBranch.value.get(sid)).toBe(true)

    const sidebar = useSidebar()
    useSessionStore().applySnapshot({ groups: [group([makeSession({ id: sid })])] })

    // 点开 = 真实走 core select 链（步 4 经 sessionEntry.clearUnread 端口）
    await sidebar.selectSession(sid)

    // 最后一跳完成：两源同点清空（清点若非 clearSessionUnread，至少一源残留 → 红）
    expect(isUnread(sid)).toBe(false)
    expect(unreadByBranch.value.has(sid)).toBe(false)
  })
})

// ======================================================================
// ← __tests__/sidebar/sidebar-micro-components.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← Brand.test.ts
// ======================================================================

describe('Brand', () => {
  it('versionLabel 正常态：渲染完整版本文案（v{version} · pi v{piVersion}）', () => {
    const wrapper = mount(Brand, {
      props: { versionLabel: 'v0.8.40 · pi v0.82.1' },
    })
    // Sidebar 侧 versionLabel 构成：`v${__APP_VERSION__} · pi v${piVersion}`
    expect(wrapper.text()).toContain('v0.8.40 · pi v0.82.1')
  })

  it('versionLabel fallback：未传（piVersion 未就绪）时不渲染版本行', () => {
    const wrapper = mount(Brand)
    // 默认 versionLabel='' → v-if 不渲染版本号行（只留 logo + 产品名）
    const versionLine = wrapper.find('.text-\\[length\\:var\\(--text-2xs\\)\\]')
    expect(versionLine.exists()).toBe(false)
    expect(wrapper.text()).not.toContain('v0.0.0-test')
  })

  it('产品名渲染 app.title i18n（zh-CN：太极）', () => {
    const wrapper = mount(Brand)
    const title = wrapper.find('span.text-\\[length\\:var\\(--text-md\\)\\]')
    expect(title.exists()).toBe(true)
    expect(title.text()).toBe('太极')
  })

  it('#trailing slot 内容渲染（Sidebar 注入 UpdateButton）', () => {
    const wrapper = mount(Brand, {
      slots: {
        trailing: '<button data-testid="trailing-stub">升级</button>',
      },
    })
    const trailing = wrapper.find('[data-testid="trailing-stub"]')
    expect(trailing.exists()).toBe(true)
    expect(trailing.text()).toBe('升级')
  })
})

describe('Brand DEV 徽标', () => {
  // provideDevMode 改的是模块级状态，重置保证不泄漏到其他用例（默认 isDevMode()=false）
  afterEach(() => __resetDevModeForTesting())

  it('dev 模式：渲染 DEV 徽标', () => {
    provideDevMode(true)
    const wrapper = mount(Brand)
    const badge = wrapper.find('[data-testid="brand-dev-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('DEV')
  })

  it('非 dev 模式（重置后）：不渲染 DEV 徽标', () => {
    __resetDevModeForTesting()
    const wrapper = mount(Brand)
    expect(wrapper.find('[data-testid="brand-dev-badge"]').exists()).toBe(false)
  })
})

// ======================================================================
// ← SegmentedTab.spec.ts
// ======================================================================

function mountTab(props: Partial<{ modelValue: SidebarTab; sessionCount: number; fileCount: number }> = {}) {
  return mount(SegmentedTab, {
    props: {
      modelValue: 'ui.sessions' as SidebarTab,
      sessionCount: 0,
      fileCount: 0,
      ...props,
    },
  })
}

describe('SegmentedTab', () => {
  it('渲染 3 个 tab（sessions/files/plugins），label 直出', () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)

    // tab title 含 label（i18n 中文：与组件 t('sidebar.segmentedTab.*') 输出对齐）
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('插件')
    // 文字 tab：label 直出（demo .vtab 形态）
    expect(buttons[0].text()).toContain('会话')
    expect(buttons[1].text()).toContain('文件')
    expect(buttons[2].text()).toContain('插件')
  })

  it('Agents / Flows 两枚 tab 不存在（任务观察入口已迁 composer 托盘）', () => {
    const wrapper = mountTab()

    const titles = wrapper.findAll('button').map((b) => b.attributes('title'))
    expect(titles).not.toContain('子代理')
    expect(titles).not.toContain('工作流')
    // 全渲染文本里不得出现两枚退役 tab 的中英标签
    expect(wrapper.text()).not.toContain('子代理')
    expect(wrapper.text()).not.toContain('工作流')
  })

  it('文字 tab 形态：不渲染 icon svg 与 count 数字（demo .vtab，count props 保留外部契约）', () => {
    const wrapper = mountTab({ sessionCount: 3, fileCount: 6, modelValue: 'ui.sessions' })

    const buttons = wrapper.findAll('button')
    expectTextOnlyTabs(buttons, ['3', '6'])
  })

  it('点击 tab 触发 update:modelValue', async () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    await buttons[1].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('ui.files')
  })

  it('tablist 范式（spec sidebar §3.1）：容器 role=tablist + 钮 role=tab + aria-selected', () => {
    const wrapper = mountTab({ modelValue: 'ui.files' })

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    const buttons = wrapper.findAll('button')
    expect(buttons.map((b) => b.attributes('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(buttons[1].attributes('aria-selected')).toBe('true')
    expect(buttons[0].attributes('aria-selected')).toBe('false')
  })

  it('方向键环形移动并立即激活（spec §3.1：→ 下一视图、← 上一视图、首尾环形）', async () => {
    const wrapper = mountTab({ modelValue: 'ui.sessions' })
    const tablist = wrapper.find('[role="tablist"]')

    // → 自会话到文件
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![0][0]).toBe('ui.files')
    await wrapper.setProps({ modelValue: 'ui.files' })

    // → 自文件到插件（立即激活随 modelValue 推进）
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![1][0]).toBe('ui.plugins')
    await wrapper.setProps({ modelValue: 'ui.plugins' })

    // → 自插件环形回会话（尾首相接）
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![2][0]).toBe('ui.sessions')
    await wrapper.setProps({ modelValue: 'ui.sessions' })

    // ← 自会话环形回插件（反向环绕）
    await tablist.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')![3][0]).toBe('ui.plugins')
  })
})
