/**
 * TrayCanvasPanel 组件测试（u-tray-entry，problem-solve-canvas §3.1(3)：托盘第 5 件「画布」）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：行渲染（名称 / 阶段徽标文案 / must-fix 计数 / 段头摘要）、点击行打开
 *   画布 overlay、「＋ 新建画布」→ 三要素 modal 出现、空态提示；缺一拒绝文案用户可见（role=alert）
 * - 观察者（形态）：阶段徽标三态（生长中 / 审查中 / 已收敛）派生呈现；must-fix 归零不渲染
 *   计数（不虚亮）；modal 内错误行只在校验失败时出现
 * - 构建者（白盒）：行点击携该画布 id 调 openCanvasTab；提交 = canvas.mutate（actor=user,
 *   action=create）且 params 为三要素行集形状；缺一拒绝不发 mutate
 *
 * mock 策略：
 * - 数据面经 `TRAY_COUNTS_KEY` **provide 替身**（面板 inject 消费外壳单例，不自建实例）；
 *   口径测试在 useTrayCounts.test.ts，本文件只验渲染与交互
 * - `@/components/panel/workflow-viz/overlay/workflow-viz-overlay` mock：只验「点击 → openCanvasTab」，
 *   不拉真实 overlay 模块（其 import 链含 workflow store / DAG 拉取）
 * - `@taiji/core/transport/api` mock：canvas.mutate reply 两态信封可控
 * - `@/composables/useToast` mock：失败 toast 断言
 * - vue-i18n 走全局 setup（zh-CN 文案）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/tray/（u-tray-entry 任务书 testCommand）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { computed, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TrayCanvasPanel from '@/components/panel/tray/TrayCanvasPanel.vue'
import { TRAY_COUNTS_KEY } from '@/components/panel/tray/useTrayCounts'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import { makeTrayCountsStub } from '@/__tests__/panel/tray/tray-counts-stub'
import zhTray from '@/i18n/locales/zh-CN/tray'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'

// ── mock：overlay 直达入口（行点击链；真实模块 import 链重，替身即可）──
const openCanvasTabMock = vi.hoisted(() => vi.fn<(canvasId: string, sessionId: string) => void>())
vi.mock('@/components/panel/workflow-viz/overlay/workflow-viz-overlay', () => ({
  openCanvasTab: openCanvasTabMock,
}))

// ── mock：mutate RPC 通道（canvas.mutate；两态信封 reply 可控）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

// ── mock：toast（创建失败呈报断言）──
const toastErrorMock = vi.hoisted(() => vi.fn<(msg: string) => void>())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, success: vi.fn(), info: vi.fn() }),
}))

const SID = 's-canvas-panel'

/** 数据面替身（inject 消费点）：reactive 容器供 canvasEntries 变更驱动重算 */
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
  canvasEntries: [] as CanvasListEntry[],
})

const trayFixture: UseTrayCountsReturn = {
  ...makeTrayCountsStub(trayState),
  bashPartition: computed(() => ({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })),
  errors: { subagent: computed(() => null), workflow: computed(() => null) },
  retry: vi.fn().mockResolvedValue(undefined),
}

function makeCanvas(overrides: Partial<CanvasListEntry> & { canvasId: string }): CanvasListEntry {
  return {
    ownerSessionId: SID,
    name: `画布 ${overrides.canvasId}`,
    statement: '示例问题陈述',
    converged: false,
    openMustFix: 0,
    reviewStatus: null,
    ...overrides,
  }
}

let wrapper: VueWrapper | null = null

function mountPanel(pinned = false): VueWrapper {
  wrapper = mount(TrayCanvasPanel, {
    props: { sessionId: SID, pinned },
    global: { provide: { [TRAY_COUNTS_KEY as symbol]: trayFixture } },
  })
  return wrapper
}

/** modal 渲染在 reka portal（document.body）——跨 wrapper 统一从 body 查 */
function bodyQuery(testid: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
}

/**
 * 提交三要素表单：对 form 派发 submit（组件 @submit.prevent 承接）。不用按钮 click——
 * jsdom 不实现「type=submit 按钮 click → form submit」的浏览器派生行为，点按钮只会
 * 消费事件不提交。
 */
function submitForm(): void {
  const form = bodyQuery('tray-canvas-form')
  if (!form) throw new Error('modal form not mounted')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  trayState.canvasEntries = []
  commandMock.mockReset()
  commandMock.mockResolvedValue({ ok: true, eventId: 'ev-1', evType: 'CanvasCreated', summary: '' })
  toastErrorMock.mockClear()
  openCanvasTabMock.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TrayCanvasPanel 列表渲染与阶段徽标（使用者黑盒 / 观察者）', () => {
  it('渲染画布行：名称 + 阶段徽标 + must-fix 计数 + 段头摘要（计数与行集同源）', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-grow', name: '多引擎拆分规划', statement: '多引擎支持怎么落地' }),
      makeCanvas({ canvasId: 'cvs-review', openMustFix: 2, reviewStatus: 'in-progress', statement: '另一个问题' }),
      makeCanvas({ canvasId: 'cvs-done', converged: true, statement: '已收敛的问题' }),
    ]
    const panel = mountPanel()
    await flushPromises()

    expect(panel.find('[data-testid="tray-canvas-panel"]').exists()).toBe(true)
    const rows = panel.findAll('[data-testid="tray-canvas-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].attributes('data-canvas-id')).toBe('cvs-grow')
    expect(rows[0].text()).toContain('多引擎拆分规划')
    // 阶段徽标（派生展示值）与 must-fix 计数
    expect(rows[0].text()).toContain(zhTray.tray.canvas.phase.growing)
    expect(rows[1].text()).toContain(zhTray.tray.canvas.phase.reviewing)
    expect(rows[1].find('[data-testid="tray-canvas-mustfix"]').text()).toContain('2')
    expect(rows[2].text()).toContain(zhTray.tray.canvas.phase.converged)
    // 段头摘要（3 张 · 2 进行中——进行中 = 未收敛）
    const header = panel.find('[data-testid="tray-canvas-header"]').text()
    expect(header).toContain('3 张画布')
    expect(header).toContain('2 进行中')
  })

  it('阶段点色语言：生长中 accent、审查中 warn、已收敛 success', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-grow' }),
      makeCanvas({ canvasId: 'cvs-review', openMustFix: 1 }),
      makeCanvas({ canvasId: 'cvs-done', converged: true }),
    ]
    const panel = mountPanel()
    await flushPromises()

    const dots = panel.findAll('[data-testid="tray-canvas-dot"]')
    expect(dots[0].classes()).toContain('bg-accent')
    expect(dots[1].classes()).toContain('bg-warn')
    expect(dots[2].classes()).toContain('bg-success')
  })

  it('must-fix 归零 → 计数不渲染（归零不虚亮）；审查终态（max-rounds）非 in-progress 不判审查中', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-clean' }),
      makeCanvas({ canvasId: 'cvs-stuck', reviewStatus: 'max-rounds' }),
    ]
    const panel = mountPanel()
    await flushPromises()

    expect(panel.findAll('[data-testid="tray-canvas-mustfix"]')).toHaveLength(0)
    const rows = panel.findAll('[data-testid="tray-canvas-row"]')
    // max-rounds 有停回说明待用户裁决，但无开放 must-fix 且非 in-progress → 按设计词表落生长中
    expect(rows[1].text()).toContain(zhTray.tray.canvas.phase.growing)
  })

  it('无画布 → 空态提示；「＋ 新建画布」按钮在场（防御性空态不破版）', async () => {
    const panel = mountPanel()
    await flushPromises()

    expect(panel.find('[data-testid="tray-canvas-row"]').exists()).toBe(false)
    expect(panel.find('[data-testid="tray-canvas-empty"]').text()).toContain(zhTray.tray.canvas.empty)
    expect(panel.find('[data-testid="tray-canvas-create"]').exists()).toBe(true)
  })
})

describe('TrayCanvasPanel 行点击打开 overlay（构建者白盒）', () => {
  it('点击行 → openCanvasTab 携该画布 id（renderer 直达入口）', async () => {
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-open-me' })]
    const panel = mountPanel()
    await flushPromises()

    await panel.find('[data-testid="tray-canvas-row"]').trigger('click')
    expect(openCanvasTabMock).toHaveBeenCalledTimes(1)
    // 载荷带归属 sessionId（D4：overlay 级联判定 + CanvasPane per-session 分区的键）
    expect(openCanvasTabMock).toHaveBeenCalledWith('cvs-open-me', SID)
  })
})

describe('TrayCanvasPanel 三要素 modal（缺一拒绝 = 不变量 1 前置校验）', () => {
  async function openModal(): Promise<void> {
    const panel = mountPanel()
    await flushPromises()
    await panel.find('[data-testid="tray-canvas-create"]').trigger('click')
    await flushPromises()
  }

  it('「＋ 新建画布」→ modal 出现（标题 + 三字段 + 提交按钮）', async () => {
    await openModal()

    expect(bodyQuery('tray-canvas-statement')).not.toBeNull()
    expect(bodyQuery('tray-canvas-criterias')).not.toBeNull()
    expect(bodyQuery('tray-canvas-scope')).not.toBeNull()
    expect(bodyQuery('tray-canvas-submit')).not.toBeNull()
  })

  it('全空提交 → 拒绝文案逐项指明三处缺失，不发 mutate，modal 保持', async () => {
    await openModal()

    submitForm()
    await flushPromises()

    const err = bodyQuery('tray-canvas-form-error')
    expect(err).not.toBeNull()
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.statement)
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.criterias)
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.scopeExclusions)
    expect(commandMock).not.toHaveBeenCalled()
    // modal 保持（用户可就地补全）
    expect(bodyQuery('tray-canvas-submit')).not.toBeNull()
  })

  it('缺一拒绝（逐项）：只缺完成判据 → 文案只指明判据，statement / scope 已填不发 mutate', async () => {
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '多引擎支持怎么落地'
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '不改 provider 抽象层'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    const err = bodyQuery('tray-canvas-form-error')
    expect(err).not.toBeNull()
    expect(err!.textContent).not.toContain(zhTray.tray.canvas.form.statement)
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.criterias)
    expect(err!.textContent).not.toContain(zhTray.tray.canvas.form.scopeExclusions)
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('判据/排除项全空行视为缺失（每行一条口径：trim 后空行不计）', async () => {
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '多引擎支持怎么落地'
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const criterias = bodyQuery('tray-canvas-criterias') as HTMLTextAreaElement
    criterias.value = '  \n  '
    criterias.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '不改 provider 抽象层'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    expect(bodyQuery('tray-canvas-form-error')).not.toBeNull()
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('三要素齐全 → mutate(actor=user, action=create) 携三要素行集；成功后 modal 关闭', async () => {
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '  多引擎支持怎么落地  '
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const criterias = bodyQuery('tray-canvas-criterias') as HTMLTextAreaElement
    criterias.value = '两条 provider 并存可切\n切换零消息丢失'
    criterias.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '不改 provider 抽象层\n不动 pi 上游'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('canvas.mutate', {
      actor: 'user',
      sessionId: SID,
      action: 'create',
      params: {
        statement: '多引擎支持怎么落地',
        criterias: ['两条 provider 并存可切', '切换零消息丢失'],
        scopeExclusions: ['不改 provider 抽象层', '不动 pi 上游'],
      },
    }, expect.any(Number))
    // 成功 → modal 关（画布唤起由 use-canvas-sync 的 CanvasCreated 广播链承接，本面板零接线）
    expect(bodyQuery('tray-canvas-submit')).toBeNull()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('mutate 结构化失败（ok=false）→ toast 呈现 message + recover，modal 保持可改', async () => {
    commandMock.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_params', message: '根问题陈述（statement）为空', recover: '修正字段后重试' },
    })
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '多引擎支持怎么落地'
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const criterias = bodyQuery('tray-canvas-criterias') as HTMLTextAreaElement
    criterias.value = '判据一'
    criterias.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '排除项一'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock.mock.calls[0][0]).toContain('根问题陈述（statement）为空')
    expect(toastErrorMock.mock.calls[0][0]).toContain('修正字段后重试')
    // 失败 → modal 保持（用户可改后重试）
    expect(bodyQuery('tray-canvas-submit')).not.toBeNull()
  })
})
