/**
 * BackgroundTaskDetailPanel 组件测试（u-drawer，background-task-sidebar-view D5/D7 + §3.1 失败路径）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：分区数据经 mock 的 useBackgroundTasks 注入（状态根归 u-renderer-store，
 *   本组件只读分区；跟随/kill 的启停条件直接驱动断言）
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——命令全文、元信息（pid/开始/时长/
 *   exit/reason）、输出尾部、不可用文案、两段式按钮文本与 armed 形态、toast 内容
 * - 观察者（形态）：终态无 kill 按钮、跟随 interval 的启停（fake timers 计次）
 *
 * mock 策略：
 * - useBackgroundTasks mock：分区内容由测试直接 mutate（广播/终态翻转的注入面）；组件零
 *   listener 的契约使 mock 形态与真实 store 分区同构（reactive { tasks, loaded }）
 * - api/domains/background-task mock：output/kill RPC 回执可控
 * - vue-i18n 文件内 override（ui vitest.setup 先例）：t(key, named) 返回 `key(k=v)` 形态——
 *   locale 未落地（u-i18n-docs 后置单元）时也能断言 key 引用 + named 参数正确性，且不随
 *   locale 文案落地而破
 * - 时间：vi.useFakeTimers({ now: FIXED_NOW })——running 时长 / 输出 interval 双确定性
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/background-task-detail-panel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { bindDrawerSessionId, getDrawerControlState, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import BackgroundTaskDetailPanel from '@/components/extension/BackgroundTaskDetailPanel.vue'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import { useToast } from '@/composables/useToast'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'

// ── mock：任务分区状态根（测试直接 mutate 模拟 list reply / 广播 / 终态翻转）──
let partitionState: { tasks: BackgroundTaskEntry[]; loaded: boolean }
vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => partitionState),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}))

// ── mock：output/kill RPC（domain 薄转发，回执形状 = shared protocol.ts SSOT）──
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({
  output: vi.fn(),
  kill: vi.fn(),
}))

// ── i18n 文件内 override：t(key, named) → `key(k=v)`（key 引用 + 参数双断言面）──
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, named?: Record<string, unknown>) => {
        if (!named) return key
        const params = Object.entries(named)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',')
        return `${key}(${params})`
      },
      locale: { value: 'zh-CN' },
    }),
  }
})

const SID = 's-bash-detail'
const TASK_ID = 'bt-20260906-a1b2c3'
// fake timers 固定「现在」：startedAt 14:32:05 → 已运行 37s → 00:37（时长断言确定性）
const FIXED_NOW = new Date(2026, 8, 6, 14, 32, 42).getTime()
const STARTED_AT = new Date(2026, 8, 6, 14, 32, 5).getTime()

function makeEntry(overrides: Partial<BackgroundTaskEntry> = {}): BackgroundTaskEntry {
  return {
    taskId: TASK_ID,
    pid: 53241,
    command: 'pnpm test --filter @taiji/frontend',
    outputFile: '/tmp/taiji/bg/bt.log',
    startedAt: STARTED_AT,
    state: 'running',
    ownerPiPid: 500,
    sessionId: SID,
    ...overrides,
  }
}

function outputReply(overrides: Partial<{ text: string; truncated: boolean; lost: boolean }> = {}) {
  return { sessionId: SID, taskId: TASK_ID, text: 'tail line', truncated: false, lost: false, ...overrides }
}

/** 选中任务（列表点击的写入动作，D5④；本组件读 selectedBackgroundTaskId） */
function selectTask(taskId: string | undefined): void {
  getDrawerControlState().selectedBackgroundTaskId = taskId
}

function mountDetail() {
  return mount(BackgroundTaskDetailPanel)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  _resetDrawerForTest()
  bindDrawerSessionId(ref(SID))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
  partitionState = reactive({ tasks: [], loaded: true })
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  // output 默认回执：非跟随用例（元信息/kill 组）挂载首拉不落 debug 噪音
  vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply())
  useToast().toasts.value = []
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundTaskDetailPanel 元信息渲染（G2）', () => {
  it('running：命令全文 + taskId + pid + 开始时间 + 已运行时长 DOM 可见，kill 按钮存在', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    const wrapper = mountDetail()
    await flushPromises()

    // 使用者黑盒：命令全文（可复制区）
    expect(wrapper.find('[data-testid="bash-task-command"]').text()).toBe(makeEntry().command)
    // 元信息：taskId / pid（纯值直渲染）
    expect(wrapper.find('[data-testid="bash-task-meta-taskid"]').text()).toBe(TASK_ID)
    expect(wrapper.find('[data-testid="bash-task-meta-pid"]').text()).toBe('pid 53241')
    // 开始时间（i18n key + named 参数经 t mock 形态断言：key 引用 + time=HH:MM:SS 正确）
    expect(wrapper.find('[data-testid="bash-task-meta-started"]').text()).toBe(
      'panel.sideDrawer.bashTaskStartedAt(time=14:32:05)',
    )
    // 已运行 37s → 00:37（fake timers 固定 now）
    expect(wrapper.find('[data-testid="bash-task-meta-duration"]').text()).toBe(
      'panel.sideDrawer.bashTaskRunningFor(duration=00:37)',
    )
    // running 无 exit/reason 行
    expect(wrapper.find('[data-testid="bash-task-meta-exit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bash-task-meta-reason"]').exists()).toBe(false)
    // running：两段式 kill 按钮存在
    expect(wrapper.find('[data-testid="bash-task-kill"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('exited（exitCode 0 / natural / durationMs）：exit + reason + 固定时长渲染，无 kill 按钮', async () => {
    partitionState.tasks = [
      makeEntry({ state: 'exited', exitCode: 0, reason: 'natural', endedAt: STARTED_AT + 61_000, durationMs: 61_000 }),
    ]
    selectTask(TASK_ID)
    const wrapper = mountDetail()
    await flushPromises()

    expect(wrapper.find('[data-testid="bash-task-meta-exit"]').text()).toBe(
      'panel.sideDrawer.bashTaskExitCode(code=0)',
    )
    expect(wrapper.find('[data-testid="bash-task-meta-reason"]').text()).toBe(
      'panel.sideDrawer.bashTaskReasonNatural',
    )
    expect(wrapper.find('[data-testid="bash-task-meta-duration"]').text()).toBe(
      'panel.sideDrawer.bashTaskDuration(duration=01:01)',
    )
    // 终态任务无 kill 按钮（S6）
    expect(wrapper.find('[data-testid="bash-task-kill"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('exited（exitCode null / killed）：exit — 占位 + killed reason（SIGKILL 无退出码，D10⑤ 同语义）', async () => {
    partitionState.tasks = [
      makeEntry({ state: 'exited', exitCode: null, reason: 'killed', endedAt: STARTED_AT + 5_000, durationMs: 5_000 }),
    ]
    selectTask(TASK_ID)
    const wrapper = mountDetail()
    await flushPromises()

    expect(wrapper.find('[data-testid="bash-task-meta-exit"]').text()).toBe(
      'panel.sideDrawer.bashTaskExitCode(code=—)',
    )
    expect(wrapper.find('[data-testid="bash-task-meta-reason"]').text()).toBe(
      'panel.sideDrawer.bashTaskReasonKilled',
    )
    wrapper.unmount()
  })

  it('orphaned（契约缺省 reason）：reason 行按 orphaned 状态单独承载', async () => {
    partitionState.tasks = [
      makeEntry({ state: 'orphaned', exitCode: null, endedAt: STARTED_AT + 3_000, durationMs: 3_000 }),
    ]
    selectTask(TASK_ID)
    const wrapper = mountDetail()
    await flushPromises()

    expect(wrapper.find('[data-testid="bash-task-meta-reason"]').text()).toBe(
      'panel.sideDrawer.bashTaskReasonOrphaned',
    )
    expect(wrapper.find('[data-testid="bash-task-kill"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('BackgroundTaskDetailPanel 输出跟随（D7：2s interval + 停止条件）', () => {
  it('running：挂载首拉一次，随后每 2s 重拉（fake timers 计次）', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply({ text: 'tail-1' }))
    const wrapper = mountDetail()
    await flushPromises()
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(1)
    expect(backgroundTaskApi.output).toHaveBeenCalledWith(SID, TASK_ID)
    expect(wrapper.find('[data-testid="bash-task-output"]').text()).toBe('tail-1')

    await vi.advanceTimersByTimeAsync(2000)
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('任务终态（分区条目 state 翻转）：跟随停止，advance 不再触发拉取', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply())
    const wrapper = mountDetail()
    await flushPromises()
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(1)

    // 广播送达 → 分区条目翻终态（store 终态感知驱动停止，D7）
    partitionState.tasks = [
      makeEntry({ state: 'exited', exitCode: 1, reason: 'natural', endedAt: FIXED_NOW, durationMs: 1000 }),
    ]
    await flushPromises()
    const calls = backgroundTaskApi.output.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(backgroundTaskApi.output.mock.calls.length).toBe(calls)
    wrapper.unmount()
  })

  it('组件卸载（drawer 关闭同机制）：interval 清理，advance 不再触发拉取', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply())
    const wrapper = mountDetail()
    await flushPromises()
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(1)
    wrapper.unmount()

    await vi.advanceTimersByTimeAsync(6000)
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(1)
  })

  it('lost=true（输出文件已清理/丢失）：不可用文案渲染（§3.1 失败路径）', async () => {
    partitionState.tasks = [makeEntry({ state: 'exited', exitCode: 0, reason: 'natural', durationMs: 1000 })]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply({ text: '', lost: true }))
    const wrapper = mountDetail()
    await flushPromises()

    const unavailable = wrapper.find('[data-testid="bash-task-output-unavailable"]')
    expect(unavailable.exists()).toBe(true)
    expect(unavailable.text()).toBe('panel.sideDrawer.bashTaskOutputUnavailable')
    expect(wrapper.find('[data-testid="bash-task-output"]').exists()).toBe(false)
    // 元信息不受输出丢失影响（§3.1：元信息正常展示）
    expect(wrapper.find('[data-testid="bash-task-meta-pid"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('truncated=true（D5 协议字段消费）：输出区顶部渲染「仅显示尾部」提示；false 不渲染', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply({ text: 'tail…', truncated: true }))
    const wrapper = mountDetail()
    await flushPromises()

    const hint = wrapper.find('[data-testid="bash-task-output-truncated"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('panel.sideDrawer.bashTaskOutputTruncated')
    expect(wrapper.find('[data-testid="bash-task-output"]').text()).toBe('tail…')

    // 回执翻回未截断（跟随下一拍）→ 提示消失
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply({ text: 'tail', truncated: false }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.find('[data-testid="bash-task-output-truncated"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('元信息区 outputFile 路径展示 + 复制（D5：截断时的全量输出口）', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    const wrapper = mountDetail()
    await flushPromises()

    const pathRow = wrapper.find('[data-testid="bash-task-output-file-row"]')
    expect(pathRow.exists()).toBe(true)
    expect(wrapper.find('[data-testid="bash-task-output-file"]').text()).toBe('/tmp/taiji/bg/bt.log')

    await wrapper.find('[data-testid="bash-task-copy-output-file"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/taiji/bg/bt.log')
    wrapper.unmount()
  })

  it('条目从分区消失（快照冻结态，D6 #13/BG-6）：元信息快照兜底渲染 + output 轮询停止', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply())
    const wrapper = mountDetail()
    await flushPromises()
    expect(backgroundTaskApi.output).toHaveBeenCalledTimes(1)

    // 广播更新一拍（新数组新对象）填充快照基线——生产时序：registry 变更广播驱动
    // partition.tasks 整体替换，entrySnapshot 在 truthy 边沿记录
    partitionState.tasks = [makeEntry({ pid: 53242 })]
    await flushPromises()

    // registry LRU 淘汰 / 损坏自愈清表：条目从分区消失 → 快照兜底渲染元信息（不空白）
    partitionState.tasks = []
    await flushPromises()
    expect(wrapper.find('[data-testid="bash-task-command"]').text()).toBe(makeEntry().command)
    expect(wrapper.find('[data-testid="bash-task-meta-taskid"]').text()).toBe(TASK_ID)

    // 轮询停止：对已消失条目继续发 output RPC 属无效空转（BG-6）
    const calls = backgroundTaskApi.output.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(backgroundTaskApi.output.mock.calls.length).toBe(calls)
    wrapper.unmount()
  })
})

describe('BackgroundTaskDetailPanel 两段式终止（G3/D10④）+ 分支④⑤ toast', () => {
  it('两段式：第一次点击仅进确认态（不发 RPC），第二次点击才发 kill（参数 sessionId+taskId）', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.kill).mockResolvedValue({ sessionId: SID, taskId: TASK_ID, killed: true, reason: 'killed' })
    const wrapper = mountDetail()
    await flushPromises()
    const btn = wrapper.find('[data-testid="bash-task-kill"]')

    // 第一击：确认态（armed 形态 + 确认文案），零 RPC
    await btn.trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()
    const armedBtn = wrapper.find('[data-testid="bash-task-kill"]')
    expect(armedBtn.attributes('data-armed')).toBe('true')
    expect(armedBtn.text()).toBe('panel.sideDrawer.bashTaskKillConfirm')

    // 第二击：真正发令
    await armedBtn.trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).toHaveBeenCalledTimes(1)
    expect(backgroundTaskApi.kill).toHaveBeenCalledWith(SID, TASK_ID)
    wrapper.unmount()
  })

  it('already-exited：info toast「任务已结束」（killResult reason → toast 文案 key）', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.kill).mockResolvedValue({ sessionId: SID, taskId: TASK_ID, killed: false, reason: 'already-exited' })
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-kill"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-kill"]').trigger('click')
    await flushPromises()

    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.type).toBe('info')
    expect(toasts.value[0]?.message).toBe('panel.sideDrawer.bashTaskAlreadyExited')
    wrapper.unmount()
  })

  it('identity-unverifiable（分支④）：warning toast 宁不杀勿误杀', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.kill).mockResolvedValue({ sessionId: SID, taskId: TASK_ID, killed: false, reason: 'identity-unverifiable' })
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-kill"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-kill"]').trigger('click')
    await flushPromises()

    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.type).toBe('warning')
    expect(toasts.value[0]?.message).toBe('panel.sideDrawer.bashTaskIdentityUnverifiable')
    wrapper.unmount()
  })

  it('registry-write-failed（分支⑤）：warning toast 操作未生效', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.kill).mockResolvedValue({ sessionId: SID, taskId: TASK_ID, killed: false, reason: 'registry-write-failed' })
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-kill"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-kill"]').trigger('click')
    await flushPromises()

    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.type).toBe('warning')
    expect(toasts.value[0]?.message).toBe('panel.sideDrawer.bashTaskWriteFailed')
    wrapper.unmount()
  })

  it('复制命令：点击复制按钮 → clipboard 写入命令全文', async () => {
    partitionState.tasks = [makeEntry()]
    selectTask(TASK_ID)
    vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply())
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('[data-testid="bash-task-copy"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(makeEntry().command)
    wrapper.unmount()
  })
})
