// SessionsScreen 组件单测（remote-use-mobile-v2 u-sessions 三视角；验收条款 1/2/4 的
// 使用者可见面 + 首屏冒烟观察者面）：
// - 双源分组渲染（未订阅 active → 「进行中」组、done/dead → 「最近」组，dead 显「已退出」）；
// - 未读点亮（config.sessions diff 帧）→ 点入即清 + lastVisitedAt 落 storage（§6.3）；
// - 搜索过滤与搜索空态（EmptyState 三要素 + 清空搜索行动）；
// - 长按 480ms 打开动作 Sheet / 移动 >8px 取消（fake timers 确定性驱动）；
// - 删除二次确认态（文案含不可逆声明与影响范围）→ 确认执行级联（Sheet 关闭）。
//
// mock 策略（对齐 shell/__tests__/app-runtime.test.ts）：仅 transport 出口（session.list /
// switchSession / remove / chat.getHistory / streamSubscribe）模块级 vi.mock 隔离 WS，
// app-runtime 组装与 store/分组谓词保持全真实——列表播种走真实 loadSessions（list RPC 替身
// 返回 fixture），广播帧走 dispatchGlobal（core events 真实现）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { dispatchGlobal } from '@taiji/core/transport/api'
import { providePlatform, __resetPlatformForTesting } from '@taiji/core'
import type { KVStorage } from '@taiji/core'
import type { SessionGroup, SessionSummary, ServerMessage } from '@taiji/shared'
import SessionsScreen from '../SessionsScreen.vue'
import { i18n } from '../../i18n'
import { activeSessionId, sessionStore } from '../../shell/app-runtime'
import { isSessionUnread, resetSessionsRuntimeForTesting } from '../../shell/sessions-runtime'
import { activeSheet, resetSheetManagerForTesting } from '../../shell/sheet-manager'
import { resetRouteForTesting, shellRoute } from '../../shell/route'

const mocks = vi.hoisted(() => ({
  command: vi.fn(() => Promise.resolve({ sessionId: 'sessions-screen-sid' })),
  list: vi.fn(),
  switchSession: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  getHistory: vi.fn(() =>
    Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
  ),
  streamSubscribe: vi.fn(() => vi.fn()),
}))

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  // dispatchGlobal（本文件的广播帧驱动入口）保持真实现，仅 command 出口替换
  return { ...actual, command: mocks.command }
})
vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, list: mocks.list, switchSession: mocks.switchSession, remove: mocks.remove }
})
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, getHistory: mocks.getHistory, streamSubscribe: mocks.streamSubscribe }
})

/** 内存 KVStorage（PlatformPort.storage 注入替身；lastVisitedAt 断言走同一实例） */
function memoryStorage(): KVStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      map.set(key, value)
    },
    async remove(key: string) {
      map.delete(key)
    },
  }
}

let storage: ReturnType<typeof memoryStorage>

// 固定时刻基准（相对时间断言与 lastActiveAt 播种共用；fake timers 不用于相对时间——
// 直接以 Date.now() 前后偏移构造，断言词面而非具体数值）
const NOW = Date.now()

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'status' | 'lastActiveAt'>): SessionSummary {
  return { label: `会话-${overrides.id}`, cwd: '/tmp/project', ...overrides }
}

const FIXTURE_GROUPS: SessionGroup[] = [
  {
    cwd: '/tmp/billing',
    sessions: [summary({ id: 's-active', status: 'active', lastActiveAt: NOW - 30_000, label: '记账 API 重构', cwd: '/tmp/billing' })],
  },
  {
    cwd: '/tmp/report',
    sessions: [
      summary({ id: 's-done', status: 'done', lastActiveAt: NOW - 2 * 3_600_000, label: '写周报', cwd: '/tmp/report' }),
      summary({ id: 's-dead', status: 'dead', lastActiveAt: NOW - 26 * 3_600_000, label: '挂掉的进程', cwd: '/tmp/dead' }),
    ],
  },
]

function sessionsFrame(groups: SessionGroup[]): ServerMessage<'config.sessions'> {
  return { type: 'config.sessions', payload: { groups } } as ServerMessage<'config.sessions'>
}

async function mountScreen() {
  const wrapper = mount(SessionsScreen, { global: { plugins: [i18n] } })
  await flushPromises()
  await nextTick()
  return wrapper
}

function row(wrapper: ReturnType<typeof mount>, id: string) {
  return wrapper.find(`[data-testid="session-row-${id}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue(FIXTURE_GROUPS)
  __resetPlatformForTesting()
  storage = memoryStorage()
  providePlatform({
    kind: 'mobile',
    storage,
    webSocket: { create: () => {
      throw new Error('not used in sessions screen tests')
    } },
  })
  resetSessionsRuntimeForTesting()
  resetSheetManagerForTesting()
  resetRouteForTesting()
  // 屏的前置路由态（App 挂载形态下 SessionsScreen 仅在 sessions 态可见；行点击的
  // navigateRoute('chat') 转移表要求来源为目的域）
  shellRoute.value = 'sessions'
  activeSessionId.value = null
  // 列表播种走 store 快照（真实消费形态：App connected 边沿 watch 调 loadSessions 是
  // 列表拉取唯一入口——屏不重复拉取，connected-reconcile 契约锁定边沿恰一次）
  sessionStore.applySnapshot({ groups: FIXTURE_GROUPS })
  // 文案断言定死 zh-CN（默认跟随 navigator.language，测试环境不定——显式锁定断言面）
  i18n.global.locale.value = 'zh-CN'
})

afterEach(() => {
  __resetPlatformForTesting()
  resetRouteForTesting()
})

describe('SessionsScreen（使用者视角 DOM 断言）', () => {
  it('首屏冒烟：屏头/搜索/分组结构元素在场，未订阅 active 行归「进行中」组', async () => {
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="sessions-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-search"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-new-task"]').exists()).toBe(true)
    // 双源分组：未订阅 active（fixture 无 chat 分区）→ 「进行中」组（验收条款 1 前半）
    expect(wrapper.find('[data-testid="sessions-group-active"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-group-recent"]').exists()).toBe(true)
    const activeGroup = wrapper.find('[data-testid="sessions-group-active"]')
    expect(activeGroup.find('[data-testid="session-row-s-active"]').exists()).toBe(true)
    expect(activeGroup.find('[data-testid="session-row-s-done"]').exists()).toBe(false)
    // 状态词「进行中」（§6.19 摘要态状态词）
    expect(row(wrapper, 's-active').find('[data-testid="session-row-status"]').text()).toBe('进行中')
    wrapper.unmount()
  })

  it('done/dead 行归「最近」组；dead 行状态词「已退出」（§6.19 dead 优先最近）', async () => {
    const wrapper = await mountScreen()
    const recentGroup = wrapper.find('[data-testid="sessions-group-recent"]')
    expect(recentGroup.find('[data-testid="session-row-s-done"]').exists()).toBe(true)
    expect(recentGroup.find('[data-testid="session-row-s-dead"]').exists()).toBe(true)
    expect(recentGroup.find('[data-testid="session-row-s-active"]').exists()).toBe(false)
    expect(row(wrapper, 's-dead').find('[data-testid="session-row-status"]').text()).toBe('已退出')
    wrapper.unmount()
  })

  it('相对时间与摘要行呈现（未订阅行摘要 = cwd 尾段）', async () => {
    const wrapper = await mountScreen()
    // s-active lastActiveAt = NOW - 30s（< 1min）→ 「刚刚」；摘要 = /tmp/billing 尾段
    expect(row(wrapper, 's-active').find('[data-testid="session-row-time"]').text()).toBe('刚刚')
    expect(row(wrapper, 's-active').find('[data-testid="session-row-excerpt"]').text()).toBe('billing')
    wrapper.unmount()
  })

  it('空列表：三要素空态（图标/说明/新建行动）', async () => {
    sessionStore.applySnapshot({ groups: [] })
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="empty-state-title"]').text()).not.toBe('')
    expect(wrapper.find('[data-testid="sessions-empty-new-task"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('搜索过滤 + 搜索空态（清空搜索行动恢复全表）', async () => {
    const wrapper = await mountScreen()
    await wrapper.find('[data-testid="sessions-search"]').setValue('周报')
    expect(row(wrapper, 's-done').exists()).toBe(true)
    expect(row(wrapper, 's-active').exists()).toBe(false)
    expect(row(wrapper, 's-dead').exists()).toBe(false)

    await wrapper.find('[data-testid="sessions-search"]').setValue('不存在')
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-clear-search"]').exists()).toBe(true)
    await wrapper.find('[data-testid="sessions-clear-search"]').trigger('click')
    expect(row(wrapper, 's-active').exists()).toBe(true)
    wrapper.unmount()
  })

  it('新建入口上抛 new-task 事件（NewTaskSheet 挂载归 App）', async () => {
    const wrapper = await mountScreen()
    await wrapper.find('[data-testid="sessions-new-task"]').trigger('click')
    expect(wrapper.emitted('new-task')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('未读点亮与点入即清（§6.3，使用者可见）', () => {
  it('config.sessions diff 帧 → 行内未读点点亮；点入行 → 未读点消失 + lastVisitedAt 落盘', async () => {
    const wrapper = await mountScreen()
    // 首帧播种（不点亮）
    dispatchGlobal(sessionsFrame(FIXTURE_GROUPS))
    await nextTick()
    expect(row(wrapper, 's-active').find('[data-testid="session-row-unread"]').exists()).toBe(false)

    // 第二帧：s-active lastActiveAt 推进（桌面发了新指令）→ 未读点点亮
    const advanced: SessionGroup[] = [
      {
        cwd: '/tmp/billing',
        sessions: [summary({ id: 's-active', status: 'active', lastActiveAt: NOW + 1_000, label: '记账 API 重构' })],
      },
      FIXTURE_GROUPS[1]!,
    ]
    dispatchGlobal(sessionsFrame(advanced))
    await nextTick()
    expect(row(wrapper, 's-active').find('[data-testid="session-row-unread"]').exists()).toBe(true)

    // 点入即清：点击行 → 未读点消失 + lastVisitedAt 条目写入
    await row(wrapper, 's-active').trigger('click')
    await flushPromises()
    expect(isSessionUnread('s-active')).toBe(false)
    expect(row(wrapper, 's-active').find('[data-testid="session-row-unread"]').exists()).toBe(false)
    expect(storage.map.has('taiji.mobile.lastVisited.s-active')).toBe(true)
    wrapper.unmount()
  })
})

describe('长按手势与动作 Sheet（使用者可见；fake timers 确定性驱动）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountAndSeed() {
    const wrapper = await mountScreen()
    return wrapper
  }

  it('长按 480ms 打开动作 Sheet（验收条款 4 前半）', async () => {
    const wrapper = await mountAndSeed()
    await row(wrapper, 's-done').trigger('pointerdown', { clientX: 10, clientY: 10 })
    // 未达窗口：Sheet 未打开
    await vi.advanceTimersByTimeAsync(479)
    await nextTick()
    expect(document.querySelector('[data-testid="session-actions-list"]')).toBeNull()
    // 达 480ms：打开
    await vi.advanceTimersByTimeAsync(1)
    await nextTick()
    expect(document.querySelector('[data-testid="session-actions-list"]')).not.toBeNull()
    expect(activeSheet.value).toBe('sessionActions')
    wrapper.unmount()
  })

  it('移动 >8px 取消长按（验收条款 4 前半的取消分支）', async () => {
    const wrapper = await mountAndSeed()
    await row(wrapper, 's-done').trigger('pointerdown', { clientX: 10, clientY: 10 })
    await row(wrapper, 's-done').trigger('pointermove', { clientX: 10, clientY: 30 })
    await vi.advanceTimersByTimeAsync(600)
    await nextTick()
    expect(document.querySelector('[data-testid="session-actions-list"]')).toBeNull()
    expect(activeSheet.value).toBeNull()
    wrapper.unmount()
  })

  it('删除二次确认态：文案含不可逆声明与影响范围，确认前不删除（验收条款 4 后半 + A9/A10）', async () => {
    const wrapper = await mountAndSeed()
    await row(wrapper, 's-done').trigger('pointerdown', { clientX: 10, clientY: 10 })
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()

    await document.querySelector<HTMLElement>('[data-testid="session-action-delete"]')!.click()
    // click 触发的是原生事件不经 vue test-utils 的 nextTick 等待——手动等待渲染
    await nextTick()
    await nextTick()
    const confirmZone = document.querySelector('[data-testid="session-delete-confirm"]')
    expect(confirmZone).not.toBeNull()
    const text = document.body.textContent ?? ''
    // 不可逆声明 + 影响范围（对话记录与本地草稿）+ 目标标题
    expect(text).toContain('不可恢复')
    expect(text).toContain('草稿')
    expect(text).toContain('写周报')
    // 确认前不删除
    expect(mocks.remove).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('确认删除执行级联：remove RPC 命中 + 活动 Sheet 关闭（§7.1 关闭相关 Sheet）', async () => {
    const wrapper = await mountAndSeed()
    await row(wrapper, 's-done').trigger('pointerdown', { clientX: 10, clientY: 10 })
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()
    await document.querySelector<HTMLElement>('[data-testid="session-action-delete"]')!.click()
    await nextTick()
    await nextTick()

    await document.querySelector<HTMLElement>('[data-testid="session-delete-confirm"] [data-testid="session-delete-confirm-button"]')!.click()
    await flushPromises()
    await nextTick()

    expect(mocks.remove).toHaveBeenCalledWith('s-done')
    expect(activeSheet.value).toBeNull()
    expect(document.querySelector('[data-testid="session-actions-list"]')).toBeNull()
    wrapper.unmount()
  })
})
