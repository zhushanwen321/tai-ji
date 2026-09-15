/**
 * BackgroundTaskListView 组件测试（u-renderer-list，background-task-sidebar-view
 * §3.1 终态 + D10 + S6 筛选边界）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：分区数据经 mock 的 useBackgroundTasks 注入（状态根归 u-renderer-store）；
 *   筛选分区跑真实 useBackgroundTaskBucketFilter（reactive 容器契约的行为锁在
 *   use-background-task-bucket-filter.test.ts）
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——三桶计数、列表行命令/pid/exit、
 *   空态文案与「查看全部」跳转、两段式终止按钮形态
 * - 观察者（形态）：全量空态不渲染筛选条、running 行才有终止钮、「全部」桶分组分隔线、
 *   running 实时计时 tick（fake timers）
 *
 * mock 策略（对齐 background-task-detail-panel.test.ts 先例）：
 * - useBackgroundTasks mock：分区内容测试直接 mutate
 * - api/domains/background-task mock：kill RPC 回执可控
 * - vue-i18n 文件内 override：t(key, named) → `key(k=v)`——locale 未落地
 *  （u-i18n-docs 后置单元）时断言 key 引用 + named 参数，且不随文案落地而破
 * - 时间：vi.useFakeTimers({ now: FIXED_NOW })——running 耗时确定性
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/background-task-list-view.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { bindDrawerSessionId, getDrawerControlState, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import BackgroundTaskListView from '@/components/extension/BackgroundTaskListView.vue'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'

// ── mock：任务分区状态根（测试直接 mutate 模拟 list reply / 广播）──
let partitionState: { tasks: BackgroundTaskEntry[]; loaded: boolean; corrupted: boolean; fetchFailed: boolean }
vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => partitionState),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}))

// ── mock：kill RPC（domain 薄转发，回执形状 = shared protocol.ts SSOT）──
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({
  kill: vi.fn(),
}))

// ── mock：ws 连接态受控 ref（断连提示条驱动；默认 connected，既有用例零影响）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref } = await import('vue')
  const stateRef = ref<string>('connected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

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

const SID = 's-bash-list'
// fake timers 固定「现在」：R1 startedAt = now-37s → 耗时 00:37（确定性断言）
const FIXED_NOW = new Date(2026, 8, 6, 14, 32, 42).getTime()
const T = (offsetMs: number) => FIXED_NOW - offsetMs

function makeEntry(overrides: Partial<BackgroundTaskEntry> & { taskId: string }): BackgroundTaskEntry {
  return {
    pid: 1,
    command: 'echo',
    outputFile: '/tmp/taiji/bg/log',
    startedAt: T(1000),
    state: 'running',
    ownerPiPid: 500,
    sessionId: SID,
    ...overrides,
  }
}

// 乱序输入（验证排序全部来自 filterBackgroundTasks SSOT，偏差登记 #12）：
// active 桶期望序 = startedAt 升序 [R1(37s), R2(10s), K1(5s)]；
// ended 桶期望序 = endedAt 倒序 [E3(1s), E2(2s), E1(3s), O1(4s)]。
const R1 = makeEntry({ taskId: 'bt-r1', pid: 101, command: 'pnpm test', startedAt: T(37_000) })
const R2 = makeEntry({ taskId: 'bt-r2', pid: 102, command: 'pnpm dev', startedAt: T(10_000) })
const K1 = makeEntry({ taskId: 'bt-k1', pid: 301, command: 'sleep 300', startedAt: T(5_000), state: 'killing' })
const E1 = makeEntry({
  taskId: 'bt-e1', pid: 201, command: 'echo ok', state: 'exited', exitCode: 0, reason: 'natural',
  startedAt: T(53_000), endedAt: T(3_000), durationMs: 50_000,
})
const E2 = makeEntry({
  taskId: 'bt-e2', pid: 202, command: 'eslint .', state: 'exited', exitCode: 1, reason: 'natural',
  startedAt: T(32_000), endedAt: T(2_000), durationMs: 30_000,
})
const E3 = makeEntry({
  taskId: 'bt-e3', pid: 203, command: 'sleep 100', state: 'exited', exitCode: null, reason: 'killed',
  startedAt: T(60_000), endedAt: T(1_000), durationMs: 59_000,
})
const O1 = makeEntry({
  taskId: 'bt-o1', pid: 401, command: 'tail -f x.log', state: 'orphaned',
  startedAt: T(64_000), endedAt: T(4_000), durationMs: 60_000,
})

function mountList() {
  return mount(BackgroundTaskListView, { props: { sessionId: SID } })
}

function itemTexts(wrapper: ReturnType<typeof mountList>): string[] {
  return wrapper.findAll('[data-testid="bg-task-item"]').map((w) => w.text())
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  _resetDrawerForTest()
  bindDrawerSessionId(ref(SID))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
  partitionState = reactive({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })
  vi.mocked(backgroundTaskApi.kill).mockResolvedValue({ sessionId: SID, taskId: 'bt-r1', killed: true, reason: 'killed' })
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  vi.useRealTimers()
  __clearSessionCleanupRegistryForTest()
  if (wsMock.ref) wsMock.ref.value = 'connected'
})

describe('BackgroundTaskListView 三桶筛选（D10②③ / S1 / S6）', () => {
  it('默认「运行中」桶：FilterBar 三桶计数（3/3/6）+ 只渲染运行中行 + active 态 DOM', async () => {
    partitionState.tasks = [R2, E1, R1, E2, E3, K1]
    const wrapper = mountList()
    await flushPromises()

    // 三桶计数预告（用户可见 DOM：数字直渲染在桶按钮内）
    expect(wrapper.find('[data-testid="bg-task-filter-active"]').text()).toContain('sidebar.backgroundTaskList.filter.active')
    expect(wrapper.find('[data-testid="bg-task-filter-active"]').text()).toContain('3')
    expect(wrapper.find('[data-testid="bg-task-filter-ended"]').text()).toContain('3')
    expect(wrapper.find('[data-testid="bg-task-filter-all"]').text()).toContain('6')
    // 默认桶 = active（data-active DOM 断言）
    expect(wrapper.find('[data-testid="bg-task-filter-active"]').attributes('data-active')).toBe('true')
    // 只渲染运行中行（killing 是活跃瞬态，同属运行中桶——D10①）
    expect(itemTexts(wrapper)).toEqual([
      expect.stringContaining('pnpm test'), // startedAt 升序：R1 在前
      expect.stringContaining('pnpm dev'),
      expect.stringContaining('sleep 300'),
    ])
    wrapper.unmount()
  })

  it('切「已结束」：只渲染终态行（endedAt 倒序）+ data-active 跟随', async () => {
    partitionState.tasks = [R2, E1, R1, E2, E3]
    const wrapper = mountList()
    await flushPromises()

    await wrapper.find('[data-testid="bg-task-filter-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-filter-ended"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="bg-task-filter-active"]').attributes('data-active')).toBe('false')
    expect(itemTexts(wrapper)).toEqual([
      expect.stringContaining('sleep 100'), // endedAt 倒序：E3(1s) 最新在前
      expect.stringContaining('eslint .'),
      expect.stringContaining('echo ok'),
    ])
    wrapper.unmount()
  })

  it('切「全部」：运行中置顶 + 分隔线 + 历史倒序（D10③ 分组可读性）', async () => {
    partitionState.tasks = [R2, E1, R1, E2, E3]
    const wrapper = mountList()
    await flushPromises()

    await wrapper.find('[data-testid="bg-task-filter-all"]').trigger('click')
    await flushPromises()
    expect(itemTexts(wrapper)).toEqual([
      expect.stringContaining('pnpm test'),
      expect.stringContaining('pnpm dev'),
      expect.stringContaining('sleep 100'),
      expect.stringContaining('eslint .'),
      expect.stringContaining('echo ok'),
    ])
    // active/ended 段边界恰一条分隔线（R2→E3 之间）
    expect(wrapper.findAll('[data-testid="bg-task-group-divider"]')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('BackgroundTaskListView 空态三分（D10③ / S6）', () => {
  it('全量空态：不渲染筛选条，渲染空态文案（i18n key 引用 DOM 断言）', async () => {
    partitionState.tasks = []
    const wrapper = mountList()
    await flushPromises()

    expect(wrapper.find('[data-testid="bg-task-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bg-task-filterbar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bg-task-empty"]').text()).toContain('sidebar.backgroundTaskList.emptyAllTitle')
    expect(wrapper.find('[data-testid="bg-task-empty"]').text()).toContain('sidebar.backgroundTaskList.emptyAllHint')
    wrapper.unmount()
  })

  it('运行中空桶（有历史）：空态文案 + 查看全部 (N) 一键跳转「全部」桶', async () => {
    partitionState.tasks = [E1, E2]
    const wrapper = mountList()
    await flushPromises()

    // 默认 active 桶空：自适应空态（筛选条仍渲染——有任务）
    const bucketEmpty = wrapper.find('[data-testid="bg-task-bucket-empty"]')
    expect(bucketEmpty.exists()).toBe(true)
    expect(bucketEmpty.text()).toContain('sidebar.backgroundTaskList.emptyActive')
    // 查看全部 (N)：N = 全部计数 2（named 参数经 t mock 形态断言）
    const viewAll = wrapper.find('[data-testid="bg-task-view-all"]')
    expect(viewAll.text()).toBe('sidebar.backgroundTaskList.viewAll(count=2)')
    // 点击跳转 → 全部桶渲染 2 条 + data-active 切换
    await viewAll.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-filter-all"]').attributes('data-active')).toBe('true')
    expect(wrapper.findAll('[data-testid="bg-task-item"]')).toHaveLength(2)
    wrapper.unmount()
  })

  it('已结束空桶（有运行中）：仅文案，无查看全部链接', async () => {
    partitionState.tasks = [R1, R2]
    const wrapper = mountList()
    await flushPromises()

    await wrapper.find('[data-testid="bg-task-filter-ended"]').trigger('click')
    await flushPromises()
    const emptyEnded = wrapper.find('[data-testid="bg-task-bucket-empty-ended"]')
    expect(emptyEnded.exists()).toBe(true)
    expect(emptyEnded.text()).toContain('sidebar.backgroundTaskList.emptyEnded')
    expect(wrapper.find('[data-testid="bg-task-view-all"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="bg-task-item"]')).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('BackgroundTaskListView 两行式 item（D10⑤）', () => {
  it('running 行：spinner icon + 命令 + 实时耗时（fake now 37s → 00:37，tick 1s → 00:38）+ 第二行 pid 无 exit', async () => {
    partitionState.tasks = [R1]
    const wrapper = mountList()
    await flushPromises()

    const item = wrapper.find('[data-testid="bg-task-item"]')
    // 第一行：命令 truncate + 耗时（fake timers 固定 now）
    expect(item.find('[data-testid="bg-task-icon"] .animate-spin').exists()).toBe(true)
    expect(item.text()).toContain('pnpm test')
    expect(item.text()).toContain('00:37')
    // 第二行（mono 元信息）：pid 有、exit 无（running 未终态）
    const meta = item.find('[data-testid="bg-task-meta"]')
    expect(meta.text()).toContain('sidebar.backgroundTaskList.pidLabel')
    expect(meta.text()).toContain('101')
    expect(meta.text()).not.toContain('sidebar.backgroundTaskList.exitLabel')
    // 文字后备双轨：根 aria-label + icon title（D10⑤）
    expect(item.attributes('aria-label')).toBe('sidebar.backgroundTaskList.status.running: pnpm test')
    expect(item.find('[data-testid="bg-task-icon"]').attributes('title')).toBe('sidebar.backgroundTaskList.status.running')
    // 实时计时：advance 1s → 00:38
    await vi.advanceTimersByTimeAsync(1000)
    expect(item.text()).toContain('00:38')
    wrapper.unmount()
  })

  it('终态行：exit 码 / exit null 显 —；icon 色档由 SSOT 派生（success/danger/dim/info）', async () => {
    partitionState.tasks = [E1, E2, E3, O1]
    const wrapper = mountList()
    await flushPromises()
    await wrapper.find('[data-testid="bg-task-filter-ended"]').trigger('click')
    await flushPromises()

    const items = wrapper.findAll('[data-testid="bg-task-item"]')
    // E3（killed，exitCode null）：第二行显「exit —」（D10⑤ 对齐 notify unknown 先例）
    expect(items[0].find('[data-testid="bg-task-meta"]').text()).toContain(
      'sidebar.backgroundTaskList.exitLabel —',
    )
    // killed icon = dim 点（bg-neutral-dim，D10⑤ 判定顺序：reason killed 优先于 exitCode）
    expect(items[0].find('[data-testid="bg-task-icon"] .bg-neutral-dim').exists()).toBe(true)
    // E2（exitCode 1）第二行显 exit 1 + danger 点；E1（exitCode 0）success 点
    expect(items[1].find('[data-testid="bg-task-meta"]').text()).toContain('202')
    expect(items[1].find('[data-testid="bg-task-icon"] .bg-danger').exists()).toBe(true)
    expect(items[2].find('[data-testid="bg-task-icon"] .bg-success').exists()).toBe(true)
    // O1（orphaned）info 点
    expect(items[3].find('[data-testid="bg-task-icon"] .bg-info').exists()).toBe(true)
    // 终态行第二行都有 exit 段
    expect(items[2].find('[data-testid="bg-task-meta"]').text()).toContain(
      'sidebar.backgroundTaskList.exitLabel 0',
    )
    wrapper.unmount()
  })

  it('killing 行：warn 点（活跃瞬态），icon 文字后备 status.killing', async () => {
    partitionState.tasks = [K1]
    const wrapper = mountList()
    await flushPromises()

    const item = wrapper.find('[data-testid="bg-task-item"]')
    expect(item.find('[data-testid="bg-task-icon"] .bg-warn').exists()).toBe(true)
    expect(item.attributes('aria-label')).toContain('sidebar.backgroundTaskList.status.killing')
    wrapper.unmount()
  })
})

describe('BackgroundTaskListView 行内两段式终止（D10④）', () => {
  it('仅 running 行有终止钮（killing/终态行无）；✕→✓ 两段式后发 kill RPC', async () => {
    partitionState.tasks = [R1, K1, E1]
    const wrapper = mountList()
    await flushPromises()
    // 切「全部」桶：三种形态同屏（R1 running / K1 killing / E1 终态）
    await wrapper.find('[data-testid="bg-task-filter-all"]').trigger('click')
    await flushPromises()

    const items = wrapper.findAll('[data-testid="bg-task-item"]')
    expect(items).toHaveLength(3)
    // 仅 running（R1）渲染终止钮；killing（K1，已发令不重复发）与终态（E1）无
    expect(items[0].find('[data-testid="bg-task-kill"]').exists()).toBe(true)
    expect(items[1].find('[data-testid="bg-task-kill"]').exists()).toBe(false)
    expect(items[2].find('[data-testid="bg-task-kill"]').exists()).toBe(false)

    // 第一击：进入确认态（✓ 红底，data-confirming=true，不发 RPC）
    await items[0].find('[data-testid="bg-task-kill"]').trigger('click')
    await flushPromises()
    const confirmBtn = wrapper.find('[data-testid="bg-task-kill-confirm"]')
    expect(confirmBtn.exists()).toBe(true)
    expect(confirmBtn.attributes('data-confirming')).toBe('true')
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()

    // 第二击：发 kill RPC（sessionId + taskId）
    await confirmBtn.trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).toHaveBeenCalledTimes(1)
    expect(backgroundTaskApi.kill).toHaveBeenCalledWith(SID, 'bt-r1')
    // 发令后确认态复位（按钮回 ✕ 形态）
    expect(wrapper.find('[data-testid="bg-task-kill"]').attributes('data-confirming')).toBe('false')
    wrapper.unmount()
  })

  it('mouseleave / 点击行外重置确认态：确认态下 mouseleave → 回 ✕ 且不发 RPC', async () => {
    partitionState.tasks = [R1]
    const wrapper = mountList()
    await flushPromises()

    await wrapper.find('[data-testid="bg-task-kill"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-kill-confirm"]').exists()).toBe(true)
    // mouseleave（SessionItem 同款 reset 面）
    await wrapper.find('[data-testid="bg-task-item"]').trigger('mouseleave')
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-kill-confirm"]').exists()).toBe(false)
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('BackgroundTaskListView 点击行开 drawer（D5④）', () => {
  it('点击行：写 selectedBackgroundTaskId + 开 bashTask tab（isOpen）', async () => {
    partitionState.tasks = [R1, E1]
    const wrapper = mountList()
    await flushPromises()
    // 切「全部」桶使终态行（E1）可见，点击第二行
    await wrapper.find('[data-testid="bg-task-filter-all"]').trigger('click')
    await flushPromises()

    await wrapper.findAll('[data-testid="bg-task-item"]')[1].trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedBackgroundTaskId).toBe('bt-e1')
    expect(control.activeTab).toBe('bashTask')
    expect(control.isOpen).toBe(true)
    wrapper.unmount()
  })
})

// ── 损坏错误条与断连提示条（S7/S6，一致性审查修复批次）──

describe('BackgroundTaskListView 损坏错误条（S7）', () => {
  it('损坏拍（corrupted + 空表）：错误条与全量空态并存；自愈拍（corrupted=false）错误条消失', async () => {
    partitionState.tasks = []
    partitionState.corrupted = true
    const wrapper = mountList()
    await flushPromises()

    // 错误条出现（用户可见 DOM 断言，i18n key 引用形态）+ 与空态并存（设计 §3.1）
    const banner = wrapper.find('[data-testid="bg-task-corrupt-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('sidebar.backgroundTaskList.corruptBanner')
    expect(wrapper.find('[data-testid="bg-task-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bg-task-filterbar"]').exists()).toBe(false)

    // 自愈拍（extension 自愈空表重建 / corrupted 翻回 false）→ 错误条消失
    partitionState.corrupted = false
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-corrupt-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('防御形态：corrupted 且仍有条目时错误条照常显示', async () => {
    partitionState.tasks = [R1]
    partitionState.corrupted = true
    const wrapper = mountList()
    await flushPromises()

    expect(wrapper.find('[data-testid="bg-task-corrupt-banner"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="bg-task-item"]').length).toBeGreaterThan(0)
    wrapper.unmount()
  })
})

describe('BackgroundTaskListView 断连提示条（S6）', () => {
  function setWs(state: string): void {
    if (!wsMock.ref) throw new Error('ws mock 未初始化')
    wsMock.ref.value = state
  }

  it('断连 && 未拉到过数据：提示条出现；loaded 且无失败（旧缓存可用）不提示', async () => {
    partitionState.tasks = []
    partitionState.loaded = false
    setWs('disconnected')
    const wrapper = mountList()
    await flushPromises()

    // 断连 && 未 loaded → 提示条（i18n key 引用 DOM 断言）
    const banner = wrapper.find('[data-testid="bg-task-disconnect-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('sidebar.backgroundTaskList.disconnectBanner')

    // 已 loaded 且无拉取失败：断连期显示旧缓存，不提示（任务条件：拉取失败/未 loaded 才提示）
    partitionState.loaded = true
    partitionState.fetchFailed = false
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-disconnect-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('断连 && 拉取失败：提示条出现；重连（connected）后消失', async () => {
    partitionState.tasks = [R1]
    partitionState.loaded = true
    partitionState.fetchFailed = true
    setWs('disconnected')
    const wrapper = mountList()
    await flushPromises()

    expect(wrapper.find('[data-testid="bg-task-disconnect-banner"]').exists()).toBe(true)

    // 重连恢复：数据拍与连接态恢复 → 提示条消失
    setWs('connected')
    partitionState.fetchFailed = false
    await flushPromises()
    expect(wrapper.find('[data-testid="bg-task-disconnect-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
