/**
 * BackgroundTaskDetailPanel + FileView 真实 virtua 单文件合并
 * （round5-d 分区 4 簇 4-10 相容子集）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——两文件共同装载 lucide-vue /
 * reka-ui-slim / vue / shared / zh-CN locale 等重模块，单文件共享一份装载。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - background-task-detail-panel.test.ts（u-drawer 元信息/输出跟随/两段式终止，主体）
 *  - FileView-virtua.test.ts（P-D7-1 真实 virtua 虚拟滚动）
 *
 * 冲突处理（试点模式）：
 *  - 主体的 fake timers hook（beforeEach useFakeTimers({now}) + afterEach
 *    useRealTimers）下沉到其三个 describe 节内——FileView 节的 flushVirtua 依赖
 *    真实 setTimeout(10ms) 链，fake timers 泄漏会让其永不触发；两节 timers 语义互不渗漏
 *  - 两节顶层 beforeEach 的幂等部分（pinia 重建 + clearAllMocks）与 afterEach
 *    （clearAllTimers + useRealTimers + wrapper 卸载语义归节内）取并集为文件级公共
 *  - FileView 节的 '@/api' 与 useSideDrawer mock、模块级 FakeResizeObserver
 *    stubGlobal + offsetParent patch 为文件级——已静态核实 BackgroundTaskDetailPanel
 *    不 import '@/api'/useSideDrawer、不消费 ResizeObserver，零泄漏
 *  - 主体的 vue-i18n mock（t(key,named) → key(k=v)）为文件级——FileView 节无任何
 *    文案断言（断言全部为 testid/类名/DOM 行数），无断言影响
 *
 * 簇注：同簇的 archive-summary-view / plan-comment-popover 不并入——两者有大量
 * 中文文案断言（「已归档」「用户摘要」「评论」「修订中」等），依赖真实 i18n setup，
 * 与主体的 vue-i18n mock 实质冲突。两文件保持原样。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=tray npx vitest run src/__tests__/components/background-task-detail-panel.test.ts（本文件登记在 domain-map.json tray 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { bindDrawerSessionId, setBackgroundTaskView, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import BackgroundTaskDetailPanel from '@/components/extension/BackgroundTaskDetailPanel.vue'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import { useToast } from '@/composables/useToast'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import FileView from '@/components/sidebar/FileView.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { nextTick } from 'vue'
import type { FileNode } from '@taiji/shared'

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

// ── i18n 文件内 override：t(key, named) → `key(k=v)`（key 引用 + 参数双断言范围）──
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

/** 选中任务（列表点击的写入动作，D5④；bashTask 内容域选中态 selection/bash-task.ts，
 *  display-containers §6.6① 迁出后落点；本组件读 useBashTaskSelection） */
function selectTask(taskId: string | undefined): void {
  setBackgroundTaskView(taskId)
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
  // output 默认回执：非跟随用例（元信息/kill 组）挂载首次拉取不落 debug 噪音
  vi.mocked(backgroundTaskApi.output).mockResolvedValue(outputReply())
  useToast().toasts.value = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundTaskDetailPanel 元信息渲染（G2）', () => {
  // 本节专用 fake timers（原文件顶层，下沉节内——不渗漏到 FileView 节的真实 setTimeout 链）
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW })
  })


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
  // 本节专用 fake timers（原文件顶层，下沉节内——不渗漏到 FileView 节的真实 setTimeout 链）
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW })
  })


  it('running：挂载首次拉取一次，随后每 2s 重新拉取（fake timers 计次）', async () => {
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
  // 本节专用 fake timers（原文件顶层，下沉节内——不渗漏到 FileView 节的真实 setTimeout 链）
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW })
  })


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


// ══════════ 来源：FileView-virtua.test.ts（真实 virtua 虚拟滚动；顶层 hook 已并入文件级
//             公共 hook，FakeResizeObserver/offsetParent patch 为模块级原样保留） ══════════

const mockFileTree = vi.fn()
const mockGitStatus = vi.fn()
vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
  },
  file: {
    tree: (...args: unknown[]) => mockFileTree(...args),
    expand: (...args: unknown[]) => vi.fn()(...args),
  },
  git: { status: (...args: unknown[]) => mockGitStatus(...args) },
}))

vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

/**
 * fake ResizeObserver：happy-dom 无布局引擎，virtua 依赖 RO 回调拿视口/条目尺寸。
 * 同步回填：滚动容器（scroll-stub，无 item 语义）报告 400px 视口，其余（条目）报告 24px。
 * 与真实浏览器行为等价的部分：窗口化计算（视口大小 / 条目尺寸）由真实 virtua 执行。
 * 两个 happy-dom 缺口需显式补齐（实测）：
 * - offsetParent 恒 undefined → virtua RO 回调 `if (i.offsetParent)` 全跳过（视口尺寸永远不更新）
 * - RO 本身存在但回调不触发 → 用同步回填的 fake RO
 */
const ITEM_H = 24
const VIEWPORT_H = 400
class FakeResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(el: Element): void {
    queueMicrotask(() => {
      const isContainer = el.hasAttribute('data-reka-scroll-area-viewport')
      this.cb(
        [
          {
            target: el,
            contentRect: {
              height: isContainer ? VIEWPORT_H : ITEM_H,
              width: 300,
            } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      )
    })
  }
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)
// happy-dom offsetParent 恒 undefined（实测）——virtua RO 回调要求 truthy 才处理
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  get(this: HTMLElement) {
    return this.parentElement ?? document.body
  },
  configurable: true,
})

/** 大文件目录 fixture：big/ 下 1000 个文件（万级缩量：1000 行下窗口化逻辑等价可证，
 *  TEST-STRATEGY「新写测试判据」类型码 d——fixture 缩量，断言强度不变） */
function buildBigTree(): FileNode[] {
  return [
    {
      path: 'big',
      name: 'big',
      type: 'dir',
      children: Array.from({ length: 1000 }, (_, i) => ({
        path: `big/f${i}.ts`,
        name: `f${i}.ts`,
        type: 'file' as const,
      })),
    },
  ]
}

async function mountView(nodes: FileNode[]): Promise<ReturnType<typeof mount>> {
  mockFileTree.mockResolvedValueOnce(nodes)
  mockGitStatus.mockResolvedValueOnce({
    sessionId: 's1',
    isRepo: false,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    stats: { add: 0, del: 0 },
    hasConflict: false,
  })
  const wrapper = mount(FileView, {
    props: { sessionId: 's1' },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

/**
 * 等 virtua 窗口化链稳定：onMounted rAF（容器 RO 注册）→ fake RO queueMicrotask 回填
 * 尺寸 → 窗口计算 → item 挂载 → item RO 回填。happy-dom 下 nextTick 不冲刷 rAF/
 * microtask 链，需真实 macrotask 延时（实测 3×nextTick + 2×setTimeout(10ms) 足够）。
 */
async function flushVirtua(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await nextTick()
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** big/ 千行目录 mount + 展开单源（loaded 置位 → addExpanded → flush virtua）。 */
async function mountExpandedBigTree() {
  const wrapper = await mountView(buildBigTree())
  const store = useFileTreeStore()
  store.setNodeState('s1', 'big', { status: 'loaded' })
  store.addExpanded('s1', 'big')
  await flushVirtua()
  return { wrapper, store }
}

describe('FileView 真实 virtua 虚拟滚动（P-D7-1：千级可见行 DOM 行数远小于总行数）', () => {
  it('展开 1000 文件目录 → DOM 只挂载视口 ± 缓冲的行（< 200），远小于 1001 总行', async () => {
    const wrapper = await mountView(buildBigTree())
    // 展开 big/（useFileTree.expandNode：loaded 早退 → addExpanded → 派生视图产出 1001 行）
    const store = useFileTreeStore()
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    await flushVirtua()

    // 真实 FileTreeRow 渲染（未 stub）——断言 DOM 中的实际行节点数。
    // 目录徽章（file-tree-dir-badge-*）2026-10-10 起目录恒渲染，前缀 ^="file-tree-dir-" 会同时
    // 命中徽章节点，行计数必须排除徽章。
    const dirRows = wrapper.findAll('[data-testid^="file-tree-dir-"]:not([data-testid*="-badge-"])')
    const fileRows = wrapper.findAll('[data-testid^="file-tree-file-"]')
    expect(dirRows.length).toBe(1) // big 目录行在 DOM
    expect(wrapper.findAll('[data-testid="file-tree-dir-badge-big"]').length).toBe(1) // 徽章恒渲染
    expect(fileRows.length).toBeGreaterThan(0) // 视口内至少渲染了若干文件行
    // P-D7-1 量化 bound：DOM 行数 < 200（总可见行 1001）
    expect(fileRows.length + dirRows.length).toBeLessThan(200)
    expect(fileRows.length + dirRows.length).toBeLessThan(1001)

    wrapper.unmount()
  })

  it('scrollRef 显式绑定生效：滚动 reka viewport → 窗口跟随移动（绑定错误时窗口不动，全量渲染形态）', async () => {
    const { wrapper, store } = await mountExpandedBigTree()

    // 绑定正确时 virtua 监听 reka viewport：滚动驱动窗口移动；曾因 parentElement 探测
    // 被 reka 内部 wrapper 隔断而监听落空——虚拟化静默失效（全量渲染）
    const viewport = wrapper.find('[data-reka-scroll-area-viewport]').element as HTMLElement
    const firstFileBefore = wrapper.find('[data-testid^="file-tree-file-"]').attributes('data-testid')

    viewport.scrollTop = 100 * ITEM_H
    viewport.dispatchEvent(new Event('scroll'))
    await flushVirtua()

    const firstFileAfter = wrapper.find('[data-testid^="file-tree-file-"]').attributes('data-testid')
    expect(firstFileAfter).toBeTruthy()
    expect(firstFileAfter).not.toBe(firstFileBefore) // 窗口已移过 ~100 行

    wrapper.unmount()
  })

  it('大数据量派生视图 + 虚拟滚动下过滤仍工作（命中后派生视图重算，DOM 行随派生视图收缩）', async () => {
    const { wrapper, store } = await mountExpandedBigTree()

    // 无匹配过滤 → 空态（派生视图 [] → file-empty）
    store.setFilter('zzz_no_match')
    await flushVirtua()
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid^="file-tree-file-"]').length).toBe(0)

    wrapper.unmount()
  })

  it('折叠后派生视图收缩（可见行 10001 → 1），DOM 行数跟随', async () => {
    const { wrapper, store } = await mountExpandedBigTree()
    expect(wrapper.findAll('[data-testid^="file-tree-file-"]').length).toBeGreaterThan(0)

    store.removeExpanded('s1', 'big')
    await flushVirtua()
    expect(wrapper.findAll('[data-testid^="file-tree-file-"]').length).toBe(0)
    expect(wrapper.find('[data-testid="file-tree-dir-big"]').exists()).toBe(true)

    wrapper.unmount()
  })
})
