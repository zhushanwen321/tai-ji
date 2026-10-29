/**
 * tray 域 native 侧合并产物（round 6 renderer 测试压缩）：两文件同产物
 * （useTrayCounts 真实 composable 测试与 composer-tray 的 partial mock 互斥，故
 * 与 tray-native-panel 同产物——后者消费真实 useTrayCounts/TRAY_COUNTS_KEY）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——行渲染（命令/耗时/pid/exit）、
 *   tab 切换、空态按钮、两段式首击确认态
 *   [容器扩展点统一 §6.6/U9+U10] subagent / workflow 面板用例已随件迁移删（插件推
 *   widget 树，渲染面归宿主 widget 区 tray-widget.test.ts 与扩展侧单测
 *   workflow-tray-widget.test.ts；workflow abort / 错误态 retry / oversize 降级态 /
 *   D13 首拉不重发守卫随宿主自建面一并退役）
 * - 观察者（形态）：pin 门控（hover 态无行内按钮）、断连提示条、加载态
 * - 构建者（白盒）：行点击归宿矩阵（drawer bashTask tab）与 RPC 参数（计数口径在
 *   useTrayCounts.test.ts 覆盖）
 *
 * mock 策略：
 * - 数据范围经 `TRAY_COUNTS_KEY` **provide 替身**（非模块 mock）：面板已改 inject 消费外壳单例
 *   （U1），替身是 `UseTrayCountsReturn` 类型标注的固定数据范围——契约漂移即编译报错；口径测试
 *   在同目录 useTrayCounts.test.ts，本文件只验渲染与交互
 * - `@taiji/core/transport/api/domains/background-task` mock：kill RPC 可控
 * - `useBackgroundTasks` mock：bash 分区状态根替身（真实状态根另有专项测试）
 * - vue-i18n 走全局 setup（从 zh-CN locale 取值）：断言真实中文文案 + 插值形态
 * - 时间：vi.useFakeTimers({ now: FIXED_NOW })——bash running 行耗时确定性
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=tray TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/tray/tray-native-bundle.test.ts（本文件登记在 domain-map.json tray 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { computed, reactive, ref, nextTick, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchCrossSession } from '@taiji/core/transport/api'
import { useSessionStore } from '@/stores/session'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useToast } from '@/composables/useToast'
import { clearToasts } from '../../helpers/toast-queue'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { bindDrawerSessionId, getDrawerControlState, useBashTaskSelection, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import TrayNativePanel from '@/components/panel/tray/TrayNativePanel.vue'
import { TRAY_COUNTS_KEY, useTrayCounts } from '@/components/panel/tray/useTrayCounts'
import type { TrayTaskKind as TrayKind, UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import {
  __resetBtwLineMembershipForTest,
  isKnownBtwLine,
  noteBtwLinesPulled,
} from '@/composables/panel/btw-line-membership'
import { makeTrayCountsStub } from './tray-counts-stub'
import zhTray from '@/i18n/locales/zh-CN/tray'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'
import type { SessionGroup, SessionSummary, ServerMessage } from '@taiji/shared'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'

// ── 数据范围替身（inject 消费点：panel 已不自建实例）──
interface TrayState {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  bashLoaded: boolean
  bashFetchFailed: boolean
  bashCorrupted: boolean
}

function createTrayState(): TrayState {
  return {
    bashRunning: [],
    bashEnded: [],
    bashLoaded: true,
    bashFetchFailed: false,
    bashCorrupted: false,
  }
}

/** reactive 容器（字段变更驱动下游 computed；对象本身恒不替换，防 computed 依赖失联） */
const trayState = reactive<TrayState>(createTrayState())

/**
 * 固定数据范围替身（`UseTrayCountsReturn` 类型标注 = 契约漂移门：成员增删改名即编译报错）。
 * 经 TRAY_COUNTS_KEY provide 给被测面板——面板不再 import useTrayCounts（U1），替身即其唯一数据源。
 * 模块级构造：所有计算属性都从 trayState 惰性派生，用例之间无需重建。
 */
const trayFixture: UseTrayCountsReturn = {
  ...makeTrayCountsStub(trayState),
  bashPartition: computed(() => ({
    tasks: [],
    loaded: trayState.bashLoaded,
    corrupted: trayState.bashCorrupted,
    fetchFailed: trayState.bashFetchFailed,
  })),
}

// ── mock：bash 分区状态根（直接 mutate 模拟 list reply / 广播；panel 节 beforeEach 置空载形态，
//    useTrayCounts 节 beforeEach 置 reactive 形态——字段变更驱动下游 computed 重算）──
let partitionState: { tasks: BackgroundTaskEntry[]; loaded: boolean; corrupted: boolean; fetchFailed: boolean }
vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => partitionState),
    refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }),
}))

// ── mock：canvas.list RPC（第 5 件 canvas 的数据链真实经过 useCanvasSync 订阅 → canvas store；
//    替身 reply 可控，广播路径用 core dispatchCrossSession 真实现喂——链路行为级验证）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

// ── mock：btw 线成员判别拉取入口（session.list {surface:'btw'}，W4b 收编）──
const apiMocks = vi.hoisted(() => ({
  listSessions: vi.fn<(query: { surface?: string; mainSessionId?: string }) => Promise<SessionGroup[]>>(),
}))
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      listSessions: apiMocks.listSessions,
    },
  }
})

// ── mock：bash kill RPC ──
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({
  kill: vi.fn(),
}))

// ── mock：ws 连接态（断连提示条驱动）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref: makeRef } = await import('vue')
  const stateRef = makeRef<string>('connected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

// ═══════════ 来源节：tray-native-panel ═══════════

describe('tray-native-panel', () => {
const SID = 's-tray-panel'
const FIXED_NOW = new Date(2026, 8, 16, 10, 30, 0).getTime()
const T = (offsetMs: number) => FIXED_NOW - offsetMs

/** i18n 模板插值（全局 setup 的 t mock 按 named 参数替换 {k}） */
function msg(template: string, params: Record<string, string | number> = {}): string {
  return Object.entries(params).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    template,
  )
}

function makeTask(overrides: Partial<BackgroundTaskEntry> & { taskId: string }): BackgroundTaskEntry {
  return {
    pid: 101,
    command: 'pnpm test',
    outputFile: '/tmp/taiji/bg.log',
    startedAt: T(37_000),
    state: 'running',
    ownerPiPid: 500,
    sessionId: SID,
    ...overrides,
  }
}

function mountPanel(extra: { pinned?: boolean } = {}) {
  return mount(TrayNativePanel, {
    props: { kind: 'bash', sessionId: SID, pinned: false, ...extra },
    global: { provide: { [TRAY_COUNTS_KEY as symbol]: trayFixture } },
  })
}

/**
 * 模块级挂载点：用例只赋值（不各自收尾卸载），卸载统一由 afterEach 收尾。
 * 失败安全：断言抛错不再跳过卸载（泄漏的组件/interval 会污染后续用例——本文件有用例断言
 * vi.getTimerCount()），卸载收尾不依赖用例走完。范式对齐同目录 tray-widget / composer-tray。
 * getTimerCount 与 unmount 成对的用例仍保留显式 unmount（卸载即断言的一部分，幂等安全）。
 */
let wrapper: VueWrapper

type PanelWrapper = ReturnType<typeof mountPanel>
function rowTexts(wrapper: PanelWrapper, testid: string): string[] {
  return wrapper.findAll(`[data-testid="${testid}"]`).map((row) => row.text())
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 合并产物增补：useBackgroundTasks 统一 partitionState 形态的空载重播（原空 tasks 形态等价）
  partitionState = { tasks: [], loaded: true, corrupted: false, fetchFailed: false }
  Object.assign(trayState, createTrayState())
  _resetDrawerForTest()
  bindDrawerSessionId(ref(SID))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
  clearToasts()
  vi.mocked(backgroundTaskApi.kill).mockResolvedValue({
    sessionId: SID,
    taskId: 'bt-1',
    killed: true,
    reason: 'killed',
  })
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  // 先卸载（fake timers 仍在位，组件 interval 回收走 fake clock），再切回真实计时器
  wrapper?.unmount()
  vi.useRealTimers()
  clearToasts()
  __clearSessionCleanupRegistryForTest()
  if (wsMock.ref) wsMock.ref.value = 'connected'
})

describe('TrayNativePanel 分桶 tab 与行渲染（使用者黑盒）', () => {
  it('bash：默认「运行中」tab 亮 + 两 tab 计数 + 行渲染命令/实时耗时/pid', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', startedAt: T(53_000), endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-native-panel"]').attributes('data-kind')).toBe('bash')
    // 进程域用「运行中」（域差异见 locale 文件头词表裁决）
    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').text()).toContain(zhTray.tray.bucket.runningProcess)
    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="tray-panel-tab-count-running"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="tray-panel-tab-count-ended"]').text()).toBe('1')
    // 行渲染：命令 + 实时耗时（fake now - startedAt = 37s）+ pid（running 无 exit 段）
    const row = wrapper.find('[data-testid="tray-bash-row"]')
    expect(row.text()).toContain('pnpm test')
    expect(row.text()).toContain('00:37')
    expect(row.find('[data-testid="tray-bash-meta"]').text()).toContain(
      `${zhTray.tray.pidLabel} 101`,
    )
    expect(row.find('[data-testid="tray-bash-meta"]').text()).not.toContain(zhTray.tray.exitLabel)

    // 实时 tick：advance 1s → 00:38
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:38')
  })

  it('bash：切「已结束」→ 终态行显示 exit 码（null 显 —）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    // 行序由数据范围给定（排序是 background-task-bucket SSOT 的职责，口径在其单测覆盖；
    // 本文件只验渲染：killed（exitCode null）在前，正常终态在后）
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e2', state: 'exited', exitCode: null, reason: 'killed', endedAt: T(1_000), durationMs: 59_000 }),
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel()
    await flushPromises()
    // 切桶前不渲染终态行（默认「运行中」）
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(1)

    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-tab-ended"]').attributes('data-active')).toBe('true')
    const rows = rowTexts(wrapper, 'tray-bash-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain(`${zhTray.tray.exitLabel} —`)
    expect(rows[1]).toContain(`${zhTray.tray.exitLabel} 0`)
  })
})

describe('TrayNativePanel 空态可行动（D9）', () => {
  it('默认「运行中」桶为空 + 已结束有内容：一行提示 + 「查看已结束 (N)」，不自动跳转', async () => {
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000) }),
      makeTask({ taskId: 'bt-e2', state: 'exited', exitCode: 1, reason: 'natural', endedAt: T(2_000) }),
    ]
    wrapper = mountPanel()
    await flushPromises()

    // 空态可见 + 仍是「运行中」tab（不自动跳）
    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').attributes('data-active')).toBe('true')
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(0)
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.runningProcess, { name: zhTray.tray.title.bash }),
    )
    const jump = wrapper.find('[data-testid="tray-panel-empty-jump-ended"]')
    expect(jump.text()).toBe(msg(zhTray.tray.viewEnded, { count: 2 }))

    // 显式点击才切桶
    await jump.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-tab-ended"]').attributes('data-active')).toBe('true')
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(2)
  })

  it('已结束桶为空（有进行中）：仅提示，无切桶按钮', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.ended, { name: zhTray.tray.title.bash }),
    )
    expect(wrapper.find('[data-testid="tray-panel-empty-jump-ended"]').exists()).toBe(false)
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(0)
  })
})

describe('TrayNativePanel 行内操作（pin 门控 + 两段式）', () => {
  it('hover 态（pinned=false）不渲染行内按钮；pin 态渲染（D8 防误触）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]

    const hovered = mountPanel()
    await flushPromises()
    expect(hovered.find('[data-testid="tray-bash-kill"]').exists()).toBe(false)
    hovered.unmount()

    const pinned = mountPanel({ pinned: true })
    await flushPromises()
    expect(pinned.find('[data-testid="tray-bash-kill"]').exists()).toBe(true)
    pinned.unmount()
  })

  it('bash kill 两段式：首击进确认态（不发 RPC）、mouseleave 复位、再击才发 kill', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel({ pinned: true })
    await flushPromises()

    // 首击：确认态（✓ + data-confirming），不发 RPC
    await wrapper.find('[data-testid="tray-bash-kill"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-kill-confirm"]').attributes('data-confirming')).toBe('true')
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()

    // mouseleave 复位（防误触残留）
    await wrapper.find('[data-testid="tray-bash-row"]').trigger('mouseleave')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-kill-confirm"]').exists()).toBe(false)
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()

    // 再击：发 kill RPC（sessionId + taskId）+ 确认态复位
    await wrapper.find('[data-testid="tray-bash-kill"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="tray-bash-kill-confirm"]').trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).toHaveBeenCalledTimes(1)
    expect(backgroundTaskApi.kill).toHaveBeenCalledWith(SID, 'bt-1')
    expect(wrapper.find('[data-testid="tray-bash-kill"]').attributes('data-confirming')).toBe('false')
  })
})

describe('TrayNativePanel 行点击归宿矩阵（D2）', () => {
  it('bash 行 → drawer bashTask tab（写 selectedBackgroundTaskId）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="tray-bash-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(useBashTaskSelection().selectedBackgroundTaskId.value).toBe('bt-1')
    expect(control.activeTab).toBe('bashTask')
    expect(control.isOpen).toBe(true)
  })
})

describe('TrayNativePanel 观察者形态（断连 / 加载态）', () => {
  it('加载态：在途且无数据显示加载文案（bash = 从未拉到过一次）', async () => {
    trayState.bashLoaded = false
    wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
  })

  it('bash 断连提示条：断连 + 拉取失败时出现，重连后消失；损坏条独立显示', async () => {
    trayState.bashFetchFailed = true
    wsMock.ref!.value = 'disconnected'
    wrapper = mountPanel()
    await flushPromises()

    const banner = wrapper.find('[data-testid="tray-bash-disconnect-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain(zhTray.tray.disconnectBanner)

    // 重连（数据拍恢复由 useBackgroundTasks 重连路径负责）→ 提示条消失
    wsMock.ref!.value = 'connected'
    trayState.bashFetchFailed = false
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-disconnect-banner"]').exists()).toBe(false)

    // 损坏条（sticky 位）独立于连接态显示
    trayState.bashCorrupted = true
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-corrupt-banner"]').text()).toContain(zhTray.tray.corruptBanner)
  })
})

/**
 * U2 判据矩阵：`isKindLoading = 在途 && 该类 total === 0`（TrayNativePanel.vue 的 isKindLoading）。
 * 两个合取项都要有用例约束——「在途」项（bash 的 !loaded）被删掉即退化为
 * `total === 0`，下列否定用例转红（本组用例即该项的变异红区）。
 */
describe('TrayNativePanel 加载态判据（U2：在途且该类无数据才占位）', () => {
  it('bash：从未拉到过一次（在途）且无任务 → 加载占位 + 不渲染分桶 tab', async () => {
    trayState.bashLoaded = false
    wrapper = mountPanel()
    await flushPromises()

    const loading = wrapper.find('[data-testid="tray-panel-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty"]').exists()).toBe(false)
  })

  it('bash：已拉到过一次（非在途）且无任务 → 空态，不占位', async () => {
    wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.runningProcess, { name: zhTray.tray.title.bash }),
    )
  })
})

describe('TrayNativePanel 数据范围单例（U1：缺 provide 响亮失败）', () => {
  it('缺 TRAY_COUNTS_KEY 时响亮失败（不得静默自建第二数据实例）', () => {
    // 面板只能在 ComposerTray 内渲染：无 provide 即抛错（错误信息含恢复动作）；若后人改回
    // 「自建实例」回退，本用例转红（U1 的双实例路径不得复活）
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => mount(TrayNativePanel, { props: { kind: 'bash', sessionId: SID } }))
        .toThrowError(/TRAY_COUNTS_KEY/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('TrayNativePanel 首帧即列表（U2：有数据不闪加载态）', () => {
  it('bash：从未拉到过一次但分区已有任务 → 直出列表（提示条语义不受影响）', async () => {
    trayState.bashLoaded = false
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tray-bash-row"]')).toHaveLength(1)
  })
})

/**
 * tick 空转治理：1s interval 仅随「可见 live bash 行」建撤（elapsedLabel 的 now 分支是 tick
 * 唯一消费者——bash 终态行走 durationMs，不需 tick）。
 * 断言手段 = vi.getTimerCount()（fake timers 挂起 timer 数；beforeEach 重设 fake clock 后基线为 0）。
 */
describe('TrayNativePanel tick 空转治理（interval 仅随可见 running bash 行建撤）', () => {
  it('bash 无 running 行（空态 / 仅已结束）零 interval；running 行出现即建、收尾即撤、卸载无泄漏', async () => {
    // 仅已结束行：可见行耗时静态（durationMs），无 tick 消费者
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()

    // 空面板（可行动空态）同样零 interval
    Object.assign(trayState, createTrayState())
    wrapper = mountPanel()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)

    // running 行出现（数据范围推送）：interval 建立，耗时开始实时走
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:37')
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:38')

    // 行收尾（移出 running 行集）：interval 撤销
    trayState.bashRunning = []
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bash 切「已结束」桶停 tick，切回「运行中」桶即恢复且首帧耗时准确（now 先同步再渲染）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:37')

    // tick 走 5s（00:42）后切到已结束桶：无 live 行 → interval 撤销，now 冻结
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:42')
    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)

    // 停留期间再走 10s（无 interval，now 不动）；切回运行桶：interval 恢复 + 首帧即 00:52
    // （watch pre 先于渲染刷新 now；若依赖后续 tick 则首帧仍是 stale 00:42，用例转红）
    await vi.advanceTimersByTimeAsync(10_000)
    await wrapper.find('[data-testid="tray-panel-tab-running"]').trigger('click')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:52')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('多实例并存（split mode）各自独立 gate：每实例恰一个 interval，卸载即回收', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    const first = mountPanel()
    const second = mountPanel()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(2)

    first.unmount()
    expect(vi.getTimerCount()).toBe(1)
    second.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('TrayNativePanel bash kill 失败用户反馈（错误 toast，不再只 console.debug）', () => {
  it('kill RPC reject → 第二击后 error toast 可见（终止后台命令失败 + 原因）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-kill-fail' })]
    vi.mocked(backgroundTaskApi.kill).mockRejectedValueOnce(new Error('rpc down'))
    // 行内按钮仅 pin 态渲染（hover 态无行内按钮，与既有两段式用例同前提）
    wrapper = mountPanel({ pinned: true })
    await flushPromises()

    // 两段式：首击进确认态（不发 RPC），确认按钮第二击发令
    await wrapper.find('[data-testid="tray-bash-kill"]').trigger('click')
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()
    await wrapper.find('[data-testid="tray-bash-kill-confirm"]').trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).toHaveBeenCalledWith(SID, 'bt-kill-fail')

    const { toasts } = useToast()
    const errorToast = toasts.value.find((toast) => toast.type === 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toBe(msg(zhTray.tray.killFailed, { msg: 'rpc down' }))
  })
})
})


// ═══════════ 来源节：useTrayCounts ═══════════
// [容器扩展点统一 §6.6/U9+U10] subagent / workflow 两件已迁插件推 widget 树，原
// subagent/workflow 计数/分桶/首拉/错误态/retry 用例随宿主自建面退役（合并产物同批收窄）——
// 托盘两件的判定单测落扩展侧 interface/gui/（tray-widget.ts / workflow-tray-widget.ts；
// subagent 件判据本体在 extension-protocol subagent-projection 单点）。

describe('useTrayCounts', () => {
const SID = 's-tray'
const SID2 = 's-tray-2'
/** fake timers 固定「现在」：bash running 行耗时派生确定性 */
const FIXED_NOW = new Date(2026, 8, 16, 10, 30, 0).getTime()

function makeTask(overrides: Partial<BackgroundTaskEntry> & { taskId: string }): BackgroundTaskEntry {
  return {
    pid: 1,
    command: 'echo',
    outputFile: '/tmp/taiji/bg.log',
    startedAt: FIXED_NOW - 1000,
    state: 'running',
    ownerPiPid: 500,
    sessionId: SID,
    ...overrides,
  }
}

// ── 测试宿主：useTrayCounts 需组件 setup 上下文（内部 watch 依赖实例 scope）──
let tray: UseTrayCountsReturn | undefined
/** 宿主实例登记（afterEach 统一卸载）：canvas 订阅（use-canvas-sync）是模块级单例，
 * 不卸载会跨用例残留并钉死旧 pinia 的 store（新用例的 reply 注入对旧 store 无效）。 */
let harnessWrapper: ReturnType<typeof mount> | null = null
const Harness = defineComponent({
  props: { sessionId: { type: String, required: true } },
  setup(props) {
    tray = useTrayCounts(computed(() => props.sessionId))
    return () => h('div')
  },
})

function mountHarness(sessionId = SID) {
  harnessWrapper = mount(Harness, { props: { sessionId } })
  return harnessWrapper
}

/** 当前数据范围（防守：宿主 setup 必已赋值） */
function data(): UseTrayCountsReturn {
  if (!tray) throw new Error('useTrayCounts 未挂载')
  return tray
}

beforeEach(() => {
  // W4b 收编：btw 线成员判别缓存逐用例清零（拉取缓存 = session.list {surface:'btw'}）
  __resetBtwLineMembershipForTest()
  apiMocks.listSessions.mockResolvedValue([])
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // canvas.list 替身：缺省空清单（canvas 用例按需覆写返回值）
  commandMock.mockReset()
  commandMock.mockResolvedValue({ canvases: [] })
  // reactive 容器：bash 分区的字段变更需驱动下游 computed 重算（mock 契约同真实分区）
  partitionState = reactive({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })
  tray = undefined
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  harnessWrapper?.unmount()
  harnessWrapper = null
  vi.useRealTimers()
})

describe('useTrayCounts 计数口径与谓词边界（D2）', () => {
  it('bash：两视图由 background-task-bucket SSOT 谓词派生（killing 属运行中桶，含排序）', async () => {
    partitionState.tasks = [
      makeTask({ taskId: 'bt-ended-old', state: 'exited', exitCode: 0, reason: 'natural', startedAt: FIXED_NOW - 60_000, endedAt: FIXED_NOW - 30_000 }),
      makeTask({ taskId: 'bt-killing', state: 'killing', startedAt: FIXED_NOW - 5_000 }),
      makeTask({ taskId: 'bt-ended-new', state: 'exited', exitCode: 1, reason: 'natural', startedAt: FIXED_NOW - 50_000, endedAt: FIXED_NOW - 10_000 }),
      makeTask({ taskId: 'bt-running', state: 'running', startedAt: FIXED_NOW - 20_000 }),
      makeTask({ taskId: 'bt-orphaned', state: 'orphaned', startedAt: FIXED_NOW - 70_000, endedAt: FIXED_NOW - 40_000 }),
    ]
    mountHarness()

    expect(data().counts.value.bash).toEqual({ running: 2, ended: 3, total: 5 })
    // 运行中桶：startedAt 升序（SSOT 排序内置，本层不二次加工）
    expect(data().lists.bash.running.value.map((t) => t.taskId)).toEqual(['bt-running', 'bt-killing'])
    // 已结束桶：endedAt 倒序
    expect(data().lists.bash.ended.value.map((t) => t.taskId)).toEqual([
      'bt-ended-new',
      'bt-ended-old',
      'bt-orphaned',
    ])
  })
})

/** 子会话 fixture（u7：session kind 数据源 = renderer session store 的 SessionSummary） */
function makeChild(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: '子会话',
    cwd: '/Users/dev/Code/work-project',
    status: 'idle',
    lastActiveAt: FIXED_NOW,
    spawnSource: 'agent',
    parentAgentSessionId: SID,
    ...overrides,
  }
}

describe('useTrayCounts session kind（第 4 件子会话，u7 / 设计 mode-system-composer-density §6.7 D7）', () => {
  it('仅计 parentAgentSessionId === 当前 sessionId：父为 null 的根会话 / 别人（SID2）的子会话都不计入', () => {
    useSessionStore().applySnapshot({
      groups: [
        {
          cwd: '/w',
          sessions: [
            makeChild({ id: 'c-mine', parentAgentSessionId: SID, status: 'active' }),
            makeChild({ id: 'c-other', parentAgentSessionId: SID2, status: 'active' }),
            makeChild({ id: 'c-root', parentAgentSessionId: undefined, status: 'active' }),
          ],
        },
      ],
    })
    mountHarness(SID)

    expect(data().counts.value.session).toEqual({ running: 1, ended: 0, total: 1 })
    expect(data().lists.session.children.value.map((c) => c.id)).toEqual(['c-mine'])
  })

  it('运行中计数口径 = SessionSummary.status === \'active\'；状态翻转后计数跟随（运行中 → 完成）', async () => {
    const sessionStore = useSessionStore()
    sessionStore.applySnapshot({
      groups: [
        {
          cwd: '/w',
          sessions: [
            makeChild({ id: 'c-run', status: 'active' }),
            makeChild({ id: 'c-done', status: 'done' }),
            makeChild({ id: 'c-err', status: 'error' }),
          ],
        },
      ],
    })
    mountHarness(SID)
    expect(data().counts.value.session).toEqual({ running: 1, ended: 2, total: 3 })

    // 子会话结束（active → done）：运行中归零，已结束 +1（同一 store，响应式重算）
    sessionStore.applySnapshot('c-run', { status: 'done' })
    await nextTick()
    expect(data().counts.value.session).toEqual({ running: 0, ended: 3, total: 3 })
  })

  it('行集按 lastActiveAt 倒序（最近在前；面板行序 = 数据范围行序）', () => {
    useSessionStore().applySnapshot({
      groups: [
        {
          cwd: '/w',
          sessions: [
            makeChild({ id: 'c-old', lastActiveAt: FIXED_NOW - 60_000 }),
            makeChild({ id: 'c-new', lastActiveAt: FIXED_NOW - 1_000 }),
          ],
        },
      ],
    })
    mountHarness(SID)
    expect(data().lists.session.children.value.map((c) => c.id)).toEqual(['c-new', 'c-old'])
  })

  it('无 session（null sid）→ session 计数归零（不读全表）', () => {
    useSessionStore().applySnapshot({
      groups: [{ cwd: '/w', sessions: [makeChild({ id: 'c-mine', status: 'active' })] }],
    })
    const wrapper = mountHarness('')
    expect(data().counts.value.session).toEqual({ running: 0, ended: 0, total: 0 })
    wrapper.unmount()
  })
})

describe('useTrayCounts bash 分区暴露面（提示条判定）', () => {
  it('bash 分区（loaded/corrupted/fetchFailed）原样透出供提示条判定', () => {
    partitionState.corrupted = true
    partitionState.fetchFailed = true
    partitionState.loaded = false
    mountHarness()
    expect(data().bashPartition.value.corrupted).toBe(true)
    expect(data().bashPartition.value.fetchFailed).toBe(true)
    expect(data().bashPartition.value.loaded).toBe(false)
  })
})

describe('P-invisible·任务托盘：D9③ 派生视图抑制（btw 线不映射派生任务；[U10] 抑制面只剩 canvas）', () => {
  it('btw 线挂托盘：线 owner 分区有画布仍构造性归零；bash（线自身任务）照常；非线会话画布照常', async () => {
    const lineId = 'line-tray-1'
    // W4b 收编判别器 = session.list {surface:'btw'} 拉取缓存成员判别（登记于
    // constraints.json C-data-28 抑制类清单；旧 isBtwSession 派生表随收编删除）——线
    // session id 经缓存预热（= 抽屉打开时拉取产物喂入，同步命中路径）。
    noteBtwLinesPulled([lineId])
    // canvas = 线 owner 分区读的派生件（抑制面覆盖）；canvas.list 返回本线画布
    commandMock.mockResolvedValue({ canvases: [makeCanvasEntry({ canvasId: 'cvs-line' })] })
    // bash = 线自身后台命令（非派生虚拟键，抑制面不覆盖）
    partitionState = reactive({
      tasks: [makeTask({ taskId: 't-line' })], loaded: true, corrupted: false, fetchFailed: false,
    })

    mountHarness(lineId)
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalled())

    // 抑制归零：canvas 行集被 derivedSuppressed 构造性清空（即使 store 有数据）
    expect(data().counts.value.canvas).toEqual({ running: 0, ended: 0, total: 0 })
    expect(data().lists.canvas.entries.value).toHaveLength(0)
    // 边界：bash 不在派生抑制面
    expect(data().counts.value.bash.total).toBe(1)
  })

  it('在途竞态：补拉未回时切回已缓存线会话，旧 sid 的迟到回写不得解除抑制（时效守卫回归）', async () => {
    const lineId = 'line-tray-race'
    // 首次判别拉取挂起（在途补拉窗口）
    let resolveListSessions!: (groups: SessionGroup[]) => void
    apiMocks.listSessions.mockImplementation(
      () =>
        new Promise<SessionGroup[]>((resolve) => {
          resolveListSessions = resolve
        }),
    )
    // canvas.list 对两 sid 均返回数据（抑制判别的判别力只剩 derivedSuppressed）
    commandMock.mockResolvedValue({ canvases: [makeCanvasEntry({ canvasId: 'cvs-race' })] })

    // 挂载 sid = SID（未缓存主会话）→ watch 内 ensure 触发 session.list 全量拉取并挂起
    // （在途补拉）；此时把焦点切到已缓存线会话（同步命中路径），旧 sid 的 Promise 续写
    // 随后才到达——回写前无 sid 时效守卫会把 derivedSuppressed 覆写为 false，线的派生
    // 任务漏进托盘计数（knownLines 写入不触发 watch 重算，错误状态无自纠触发点）。
    const wrapper = mountHarness(SID)
    await vi.waitFor(() => expect(apiMocks.listSessions).toHaveBeenCalledTimes(1))
    expect(apiMocks.listSessions).toHaveBeenCalledWith({ surface: 'btw' })

    // 缓存预热（= 抽屉打开时拉取产物喂入）后切焦点：同步命中，抑制立即生效
    noteBtwLinesPulled([lineId])
    await wrapper.setProps({ sessionId: lineId })
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalled())
    expect(data().counts.value.canvas.total).toBe(0)

    // 旧 sid（SID，非线）的在途补拉此时才落表（快照替换：lineId 出缓存）——续写到达时
    // 焦点已不是 SID，时效守卫跳过回写，derivedSuppressed 保持 true
    resolveListSessions([])
    await vi.waitFor(() => expect(isKnownBtwLine(lineId)).toBe(false))
    await nextTick()
    expect(data().counts.value.canvas.total).toBe(0)
    expect(data().lists.canvas.entries.value).toHaveLength(0)
  })
})

// ── 第 5 件 canvas（u-tray-entry，problem-solve-canvas §3.1(3)）──

/** canvas.list 条目 fixture（形状 = canvas.list 投影，含阶段徽标派生输入；ownerSessionId = D4 归属字段） */
function makeCanvasEntry(overrides: Partial<CanvasListEntry> & { canvasId: string }): CanvasListEntry {
  return {
    ownerSessionId: SID,
    name: `画布 ${overrides.canvasId}`,
    statement: '示例陈述',
    converged: false,
    openMustFix: 0,
    reviewStatus: null,
    ...overrides,
  }
}

/** 构造 canvas.updated 全局广播帧并分发（core 全局通道真实现，use-canvas-sync.test 同款；
 * payload.sessionId = 画布归属会话——D4 隔离后消费方按归属分流） */
function broadcastCanvasUpdated(canvasId: string, sessionId: string = SID): void {
  // canvas.updated 消费端在 crossSession 通道（use-canvas-sync 模块级单订阅）——
  // dispatchGlobal 不喂该通道，发帧必须走 dispatchCrossSession（对齐 use-canvas-sync.test）
  dispatchCrossSession({
    type: 'canvas.updated',
    payload: { canvasId, sessionId, evType: 'NodeCreated', eventId: 'ev-1', summary: '' },
  } as ServerMessage<'canvas.updated'>)
}

describe('useTrayCounts canvas kind（第 5 件画布，u-tray-entry）', () => {
  it('计数口径：running = 未收敛数、ended = 已收敛数、total = 全部；行集 = canvas.list 投影', async () => {
    commandMock.mockResolvedValue({
      canvases: [
        makeCanvasEntry({ canvasId: 'cvs-open' }),
        makeCanvasEntry({ canvasId: 'cvs-done', converged: true }),
        makeCanvasEntry({ canvasId: 'cvs-fix', openMustFix: 2, reviewStatus: 'in-progress' }),
      ],
    })
    mountHarness()
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(3), { interval: 1 })

    expect(data().counts.value.canvas).toEqual({ running: 2, ended: 1, total: 3 })
    expect(data().lists.canvas.entries.value.map((c) => c.canvasId)).toEqual([
      'cvs-open',
      'cvs-done',
      'cvs-fix',
    ])
  })

  it('canvas.updated 广播失效 → 重新 canvas.list 拉取，清单与计数跟随（推为提示、拉为真理）', async () => {
    // 按 type 分流（广播处理器会同时发 canvas.get + canvas.list，Once 队列会被 get 消费）
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') return { canvases: [makeCanvasEntry({ canvasId: 'cvs-1' })] }
      return null
    })
    mountHarness()
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(1), { interval: 1 })

    // 广播后重拉：清单换新（旧画布收敛 + 新画布加入）
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') {
        return {
          canvases: [
            makeCanvasEntry({ canvasId: 'cvs-1', converged: true }),
            makeCanvasEntry({ canvasId: 'cvs-2' }),
          ],
        }
      }
      return null
    })
    broadcastCanvasUpdated('cvs-1')
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(2), { interval: 1 })
    expect(data().counts.value.canvas).toEqual({ running: 1, ended: 1, total: 2 })
  })

  it('画布按归属会话隔离：空 sid 下 canvas 计数归零（per-session 分区——无会话即无画布）', async () => {
    commandMock.mockResolvedValue({
      canvases: [makeCanvasEntry({ canvasId: 'cvs-global' })],
    })
    const wrapper = mountHarness('')
    await vi.waitFor(() => expect(data().counts.value.session.total).toBe(0), { interval: 1 })
    // 空 sid → 归一 null → 不发 canvas.list RPC、计数恒零（与 session 件同款归零语义）
    expect(commandMock).not.toHaveBeenCalledWith('canvas.list', expect.anything(), expect.anything())
    expect(data().counts.value.canvas).toEqual({ running: 0, ended: 0, total: 0 })
    wrapper.unmount()
  })

  it('跨会话广播不刷新本会话计数：B 会话画布的 canvas.updated 只重拉 B 分区（A 计数不变）', async () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') return { canvases: [makeCanvasEntry({ canvasId: 'cvs-a' })] }
      return null
    })
    mountHarness()
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(1), { interval: 1 })

    // B 会话的画布变更广播（payload.sessionId = SID2）→ 只重拉 B 分区清单，
    // A 的计数与清单不变（D4 隔离：托盘计数 = 本会话画布）
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') {
        return {
          canvases: [
            makeCanvasEntry({ canvasId: 'cvs-a' }),
            makeCanvasEntry({ canvasId: 'cvs-b', ownerSessionId: SID2 }),
          ],
        }
      }
      return null
    })
    broadcastCanvasUpdated('cvs-b', SID2)
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID2 }, expect.anything()), { interval: 1 })
    // A 的清单未被动过（B 的广播只写 B 分区）
    expect(data().lists.canvas.entries.value.map((c) => c.canvasId)).toEqual(['cvs-a'])
    expect(data().counts.value.canvas.total).toBe(1)
  })
})
})

