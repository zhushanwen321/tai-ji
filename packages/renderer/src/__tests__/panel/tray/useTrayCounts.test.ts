/**
 * useTrayCounts 数据范围测试（u-tray-native，设计 docs/design/composer-task-tray.md §3.3 D2/D13，已删除 git 可追溯）。
 *
 * [容器扩展点统一 §6.6/U9+U10] subagent / workflow 两件已迁插件推 widget 树，本文件的
 * workflow 计数/分桶/首拉/错误态/retry 用例随宿主自建面退役——托盘两件的判定镜像单测
 * 落扩展侧 interface/gui/（tray-widget.ts / workflow-tray-widget.ts）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：件计数口径与谓词边界——bash 两视图由 background-task-bucket SSOT
 *   谓词派生；btw 线抑制面（canvas 构造性归零）与时效守卫
 * - 使用者（黑盒）：本文件是纯逻辑面（无 DOM）；用户可见断言在 tray-native-panel.test.ts
 * - 观察者（形态）：同上（面板渲染形态由组件测试承载）
 *
 * mock 策略：
 * - `@/composables/features/sidebar/useBackgroundTasks` mock：bash 分区直接 mutate
 *   （状态根自身行为另有专项测试，本文件只验托盘消费口径）
 * - `@/api` mock：btw 线成员判别拉取入口（session.list {surface:'btw'}）可控
 * - 真实 pinia + 真实 store：session/canvas 计数跑真实分区（不 mock store 派生链）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/useTrayCounts.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchCrossSession } from '@taiji/core/transport/api'
import { useSessionStore } from '@/stores/session'
import { useTrayCounts } from '@/components/panel/tray/useTrayCounts'
import {
  __resetBtwLineMembershipForTest,
  isKnownBtwLine,
  noteBtwLinesPulled,
} from '@/composables/panel/btw-line-membership'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'
import type { SessionGroup, SessionSummary, ServerMessage } from '@taiji/shared'

// ── mock：bash 分区状态根（直接 mutate 模拟 list reply / 广播）──
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
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(3))

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
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(1))

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
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(2))
    expect(data().counts.value.canvas).toEqual({ running: 1, ended: 1, total: 2 })
  })

  it('画布按归属会话隔离：空 sid 下 canvas 计数归零（per-session 分区——无会话即无画布）', async () => {
    commandMock.mockResolvedValue({
      canvases: [makeCanvasEntry({ canvasId: 'cvs-global' })],
    })
    const wrapper = mountHarness('')
    await vi.waitFor(() => expect(data().counts.value.session.total).toBe(0))
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
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(1))

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
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID2 }, expect.anything()))
    // A 的清单未被动过（B 的广播只写 B 分区）
    expect(data().lists.canvas.entries.value.map((c) => c.canvasId)).toEqual(['cvs-a'])
    expect(data().counts.value.canvas.total).toBe(1)
  })
})
