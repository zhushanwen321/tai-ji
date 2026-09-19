/**
 * TraySessionPanel 组件测试（u7：第 4 件「子会话」面板，设计
 * `.tmp/tech-design/mode-system-composer-density.md` §6.7 D7 + §7.4「底栏」行）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：行渲染（label / cwd 末段 / 状态文案 / 段头摘要）、error 行显 danger 色、
 *   点击行打开子会话、pin 态「停止」两段确认
 * - 观察者（形态）：hover（非 pin）态不渲染行内操作（D8 防误触契约复用）；空态提示
 * - 构建者（白盒）：打开走 `useSidebar().selectSession`（携该子会话 id）；停止走 `chat.abort`
 *   软停止 RPC（携该子会话 id）；两段确认首击不发 RPC
 *
 * mock 策略：
 * - 数据面经 `TRAY_COUNTS_KEY` **provide 替身**（面板 inject 消费外壳单例，不自建实例）；
 *   口径测试在 useTrayCounts.test.ts，本文件只验渲染与交互
 * - `@/composables/features/sidebar/useSidebar` mock：避免拉真实 12 步链，只验「点击 → selectSession」
 * - `@/api` mock：chat.abort 可控
 * - vue-i18n 走全局 setup（zh-CN 文案）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/tray-session-panel.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { computed, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TraySessionPanel from '@/components/panel/tray/TraySessionPanel.vue'
import { TRAY_COUNTS_KEY } from '@/components/panel/tray/useTrayCounts'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import { makeTrayCountsStub } from './tray-counts-stub'
import zhTray from '@/i18n/locales/zh-CN/tray'
import type { SessionSummary } from '@taiji/shared'

// ── mock：打开链（行点击 → selectSession；真实 useSidebar 依赖重，替身即可）──
const selectSessionMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>())
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionMock }),
}))

// ── mock：软停止 RPC（chat.abort）──
const abortMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>())
vi.mock('@/api', () => ({ chat: { abort: abortMock } }))

const SID = 's-session-panel'
const FIXED_NOW = new Date(2026, 8, 16, 10, 30, 0).getTime()

/** 数据面替身（inject 消费点）：reactive 容器供 sessionChildren 变更驱动重算 */
const trayState = reactive({
  bashRunning: [],
  bashEnded: [],
  bashLoaded: true,
  subagentRunning: [],
  subagentEnded: [],
  subagentLoading: false,
  workflowRunning: [],
  workflowEnded: [],
  workflowLoading: false,
  sessionChildren: [] as SessionSummary[],
})

const trayFixture: UseTrayCountsReturn = {
  ...makeTrayCountsStub(trayState),
  bashPartition: computed(() => ({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })),
  errors: { subagent: computed(() => null), workflow: computed(() => null) },
  retry: vi.fn().mockResolvedValue(undefined),
}

function makeChild(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: '子会话',
    cwd: '/Users/dev/Code/work-project',
    status: 'idle',
    lastActiveAt: FIXED_NOW - 5 * 60_000,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 0,
    spawnSource: 'agent',
    parentAgentSessionId: SID,
    ...overrides,
  }
}

let wrapper: VueWrapper | null = null

function mountPanel(pinned = false): VueWrapper {
  wrapper = mount(TraySessionPanel, {
    props: { sessionId: SID, pinned },
    global: { provide: { [TRAY_COUNTS_KEY as symbol]: trayFixture } },
  })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  trayState.sessionChildren = []
  selectSessionMock.mockResolvedValue(undefined)
  abortMock.mockResolvedValue(undefined)
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('TraySessionPanel 行渲染与形态（使用者黑盒 / 观察者）', () => {
  it('渲染子会话行：label + cwd 末段 + 状态文案 + 段头摘要（计数与行集同源）', async () => {
    trayState.sessionChildren = [
      makeChild({ id: 'c-run', label: '解析查询计划', status: 'active' }),
      makeChild({ id: 'c-done', label: '压测连接池', status: 'done' }),
    ]
    const panel = mountPanel()
    await flushPromises()

    expect(panel.find('[data-testid="tray-session-panel"]').attributes('data-session-id')).toBe(SID)
    const rows = panel.findAll('[data-testid="tray-session-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes('data-child-session-id')).toBe('c-run')
    expect(rows[0].text()).toContain('解析查询计划')
    expect(rows[0].find('[data-testid="tray-session-meta"]').text()).toContain('work-project')
    expect(rows[0].find('[data-testid="tray-session-meta"]').text()).toContain(
      zhTray.tray.session.status.running,
    )
    expect(rows[1].find('[data-testid="tray-session-meta"]').text()).toContain(
      zhTray.tray.session.status.done,
    )
    // 段头摘要（2 个 · 1 运行中）
    const header = panel.find('[data-testid="tray-session-header"]').text()
    expect(header).toContain('2 个')
    expect(header).toContain('1 运行中')
  })

  it('状态点色语言：运行中 accent、error danger、已停止 dim（DOT_CLASS 单点）', async () => {
    trayState.sessionChildren = [
      makeChild({ id: 'c-run', status: 'active' }),
      makeChild({ id: 'c-err', status: 'error' }),
      makeChild({ id: 'c-stop', status: 'stopped' }),
    ]
    const panel = mountPanel()
    await flushPromises()

    const dots = panel.findAll('[data-testid="tray-session-dot"]')
    expect(dots[0].classes()).toContain('bg-accent')
    expect(dots[1].classes()).toContain('bg-danger')
    expect(dots[2].classes()).toContain('opacity-50')
  })

  it('hover（非 pin）态不渲染行内操作（D8 防误触契约复用）；仅运行中行才可能有停止', async () => {
    trayState.sessionChildren = [
      makeChild({ id: 'c-run', status: 'active' }),
      makeChild({ id: 'c-done', status: 'done' }),
    ]
    const panel = mountPanel(false)
    await flushPromises()
    expect(panel.find('[data-testid="tray-session-stop"]').exists()).toBe(false)

    // pin 态：运行中行出现停止，完成行仍无
    wrapper?.unmount()
    const pinned = mountPanel(true)
    await flushPromises()
    expect(pinned.findAll('[data-testid="tray-session-stop"]')).toHaveLength(1)
  })

  it('无子会话 → 空态提示（外壳三态「全无 → 不渲染」的防御兜底）', async () => {
    const panel = mountPanel()
    await flushPromises()
    expect(panel.find('[data-testid="tray-session-row"]').exists()).toBe(false)
    expect(panel.find('[data-testid="tray-session-empty"]').text()).toContain(
      zhTray.tray.session.empty,
    )
  })
})

describe('TraySessionPanel 行动作（构建者白盒）', () => {
  it('点击行 → 打开该子会话（selectSession 携该子会话 id）', async () => {
    trayState.sessionChildren = [makeChild({ id: 'c-open' })]
    const panel = mountPanel()
    await panel.find('[data-testid="tray-session-row"]').trigger('click')
    await flushPromises()
    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith('c-open')
  })

  it('pin 态「停止」两段确认：首击仅进确认态（不发 RPC），再击调 chat.abort 携该子会话 id', async () => {
    trayState.sessionChildren = [makeChild({ id: 'c-stop', status: 'active' })]
    const panel = mountPanel(true)
    await flushPromises()

    await panel.find('[data-testid="tray-session-stop"]').trigger('click')
    await flushPromises()
    // 首击 = 确认态（按钮 testid 切换），未发 RPC
    expect(panel.find('[data-testid="tray-session-stop-confirm"]').exists()).toBe(true)
    expect(abortMock).not.toHaveBeenCalled()

    await panel.find('[data-testid="tray-session-stop-confirm"]').trigger('click')
    await flushPromises()
    expect(abortMock).toHaveBeenCalledTimes(1)
    expect(abortMock).toHaveBeenCalledWith('c-stop')
  })

  it('点停止不冒泡触发行打开（@click.stop：两段确认期间不跳转）', async () => {
    trayState.sessionChildren = [makeChild({ id: 'c-stop', status: 'active' })]
    const panel = mountPanel(true)
    await flushPromises()

    await panel.find('[data-testid="tray-session-stop"]').trigger('click')
    await flushPromises()
    expect(selectSessionMock).not.toHaveBeenCalled()
  })
})
