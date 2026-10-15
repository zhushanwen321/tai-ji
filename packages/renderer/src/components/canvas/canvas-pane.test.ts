/**
 * CanvasPane / CanvasBindingBadge 组件测试（problem-solve-canvas §3.1(3) U7 验收：
 * 节点渲染 / 选定交互走 mutate（无乐观回显）/ 绑定徽标状态）。
 *
 * 三视角：使用者黑盒为主——断言用户可见 DOM（节点卡、角标、对话框、提交后回显时序）。
 *
 * mock 策略：command 以 vi.mock 注入替身（renderer 测试无真实 WS），按 type 分流
 * canvas.list / canvas.get / canvas.mutate；i18n 走全局 setup（zh-CN 取值）；
 * 无文件写（纯内存 + mock RPC）。运行：
 * cd packages/renderer && npx vitest run src/components/canvas/canvas-pane.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { CanvasState } from '@zhushanwen/extension-protocol'
import CanvasPane from './CanvasPane.vue'
import CanvasBindingBadge from './CanvasBindingBadge.vue'

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

/** 当前 canvas.get 应答（用例内可换——模拟广播失效重拉收敛）。 */
let currentState: CanvasState

/** 最小合法画布：根 → 子问题 → 两候选（o2 预置待重审 + 待响应评论）。 */
function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    canvasId: 'cvs-1',
    name: '画布规划',
    root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: ['不做多画布'] },
    direction: null,
    nodes: [
      { id: 'root', type: 'question', content: '根问题怎么解', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'q2', type: 'question', content: '子问题拆解', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o2', type: 'option', content: '方案二', lifecycle: 'under-review', createdAt: 'T0' },
      { id: 'a1', type: 'argument', content: '支持论据', lifecycle: 'draft', polarity: 'support', materiality: 'fact', factVerified: true, createdAt: 'T0' },
    ],
    edges: [
      { id: 'ed-1', type: 'decompose', from: 'root', to: 'q2' },
      { id: 'er-1', type: 'resolve', from: 'q2', to: 'o1' },
      { id: 'er-2', type: 'resolve', from: 'q2', to: 'o2' },
      { id: 'ea-1', type: 'argue', from: 'a1', to: 'o1', polarity: 'support' },
    ],
    comments: [{ id: 'cm-1', anchorId: 'o2', text: '会挤占独立窗口吗', status: 'pending', createdAt: 'T0' }],
    dirtyPaths: ['q2'],
    review: null,
    converged: false,
    createdAt: 'T0',
    updatedAt: 'T0',
    ...overrides,
  }
}

/** command 按 type 分流：list 空清单 / get 当前态 / mutate 成功回执（失败形态用例内覆盖）。 */
function stubCommand(): void {
  commandMock.mockImplementation(async (type: never) => {
    if (type === 'canvas.list') return { canvases: [] }
    if (type === 'canvas.get') return currentState
    if (type === 'canvas.mutate') {
      return { ok: true as const, eventId: 'ev-1', evType: 'OptionSelected' as const, summary: '已选定方案一' }
    }
    throw new Error(`unexpected command: ${String(type)}`)
  })
}

/** 在挂实例登记（对话框 teleport 到 body——跨用例残留会互相污染查询，afterEach 统一卸载）。 */
const mounted: VueWrapper[] = []

async function mountPane(canvasId = 'cvs-1'): Promise<VueWrapper> {
  const wrapper = mount(CanvasPane, { props: { canvasId } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

function cardEl(wrapper: VueWrapper, nodeId: string): Element | null {
  return wrapper.find(`[data-node-id="${nodeId}"]`).element ?? null
}

/** 对话框经 reka DialogPortal teleport 到 body：统一从 body 查（RenameSessionDialog.test.ts 先例）。 */
function bodyEl(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`)
}

/** 对话框内字段注入值（v-model 走真实 input 事件链）。 */
async function setDialogField(testId: string, value: string): Promise<void> {
  const el = bodyEl(testId) as HTMLTextAreaElement | HTMLInputElement | null
  expect(el, `对话框字段 ${testId} 应存在`).not.toBeNull()
  el!.value = value
  el!.dispatchEvent(new Event('input'))
  await nextTick()
}

/** 点对话框提交按钮（Portal 内容不在 wrapper 子树，走 body）。 */
async function submitDialog(): Promise<void> {
  const btn = bodyEl('canvas-op-submit') as HTMLButtonElement | null
  expect(btn, '提交按钮应存在').not.toBeNull()
  btn!.click()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  commandMock.mockReset()
  currentState = makeState()
  stubCommand()
})

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  document.body.innerHTML = ''
})

describe('CanvasPane 节点渲染（使用者可见 DOM）', () => {
  it('主干节点卡渲染：标题 / 类型 / 生命周期可见；根与子问题、两候选齐全', async () => {
    const wrapper = await mountPane()
    expect(wrapper.find('[data-testid="canvas-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="canvas-pane-title"]').text()).toBe('画布规划')
    expect(cardEl(wrapper, 'root')?.textContent).toContain('根问题怎么解')
    expect(cardEl(wrapper, 'q2')).not.toBeNull()
    expect(cardEl(wrapper, 'o1')?.textContent).toContain('方案一')
    expect(cardEl(wrapper, 'o2')?.getAttribute('data-lifecycle')).toBe('under-review')
    // 主干边 SVG 在场（decompose + resolve）
    expect(wrapper.find('[data-testid="canvas-edge-decompose"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="canvas-edge-resolve"]').exists()).toBe(true)
  })

  it('选定方案高亮与待重审角标（契约字段的直接投影）', async () => {
    currentState = makeState({
      nodes: makeState().nodes.map((n) => (n.id === 'o1' ? { ...n, selected: true } : n)),
    })
    const wrapper = await mountPane()
    expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('true')
    expect(cardEl(wrapper, 'o2')?.getAttribute('data-selected')).toBe('false')
    // 待重审专属角标：q2 在 dirtyPaths → 角标可见（门禁③的可感知通道）
    const q2 = wrapper.find('[data-node-id="q2"]')
    expect(q2.find('[data-testid="canvas-node-recheck-badge"]').exists()).toBe(true)
    expect(q2.find('[data-testid="canvas-node-recheck-badge"]').text()).toBe('待重审')
    expect(wrapper.find('[data-node-id="root"] [data-testid="canvas-node-recheck-badge"]').exists()).toBe(false)
  })

  it('论据条收于宿主卡内：支持条 + fact 核实角标；评论计数气泡带待响应态', async () => {
    const wrapper = await mountPane()
    const o1 = wrapper.find('[data-node-id="o1"]')
    expect(o1.find('[data-testid="canvas-arg-strip-support"]').exists()).toBe(true)
    expect(o1.find('[data-testid="canvas-arg-row"]').text()).toContain('支持论据')
    expect(o1.find('[data-testid="canvas-arg-verified-ok"]').exists()).toBe(true)
    // o2 有待响应评论：气泡计数 + warn 态
    const o2 = wrapper.find('[data-node-id="o2"]')
    expect(o2.find('[data-testid="canvas-node-comments-badge"]').text()).toBe('1')
  })

  it('未选中时详情面板空态引导可见；点击节点卡出详情', async () => {
    const wrapper = await mountPane()
    expect(wrapper.find('[data-testid="canvas-detail-empty"]').exists()).toBe(true)
    await wrapper.find('[data-node-id="o1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="canvas-detail-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="canvas-detail-title"]').text()).toBe('方案一')
  })
})

describe('CanvasPane 选定交互走 mutate（无乐观回显）', () => {
  it('选定提交：canvas.mutate actor=user + select params 契约形状；成功回显仅在重新拉取后出现', async () => {
    const wrapper = await mountPane()
    // 点开方案一 → 详情 → 选定按钮 → 对话框
    await wrapper.find('[data-node-id="o1"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="canvas-action-select"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(bodyEl('canvas-op-dialog'), '操作对话框应打开').not.toBeNull()

    // 必填拦截：理由为空不提交
    await submitDialog()
    expect(commandMock).not.toHaveBeenCalledWith('canvas.mutate', expect.anything(), expect.anything())

    // 填理由提交
    await setDialogField('canvas-op-field-reason', '成本与可控性更优')
    await submitDialog()

    expect(commandMock).toHaveBeenCalledWith(
      'canvas.mutate',
      {
        actor: 'user',
        action: 'select',
        params: { canvasId: 'cvs-1', questionId: 'q2', optionId: 'o1', reason: '成本与可控性更优' },
      },
      expect.any(Number),
    )

    // 无乐观回显：mutate 成功后、广播刷新前，卡片仍是未选定（store 未被本地改写）
    expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('false')

    // 广播回返 → store 重新拉取 → 成功才呈现
    currentState = makeState({
      nodes: makeState().nodes.map((n) => (n.id === 'o1' ? { ...n, selected: true, selectionReason: '成本与可控性更优' } : n)),
    })
    const store = (await import('@/stores/canvas')).useCanvasStore()
    await store.loadCanvas('cvs-1')
    await flushPromises()
    expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('true')
  })

  it('换选形态：对话框呈现旧选定告知，提交携带 replace 迁移语义', async () => {
    currentState = makeState({
      nodes: makeState().nodes.map((n) => (n.id === 'o2' ? { ...n, selected: true } : n)),
    })
    const wrapper = await mountPane()
    await wrapper.find('[data-node-id="o1"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="canvas-action-select"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(bodyEl('canvas-op-replace-hint')?.textContent).toContain('方案二')

    await setDialogField('canvas-op-field-reason', '换选理由')
    await submitDialog()

    expect(commandMock).toHaveBeenCalledWith(
      'canvas.mutate',
      expect.objectContaining({
        actor: 'user',
        action: 'select',
        params: expect.objectContaining({ optionId: 'o1', replace: { fromOptionId: 'o2' } }),
      }),
      expect.any(Number),
    )
  })

  it('mutate 失败：结构化错误呈现（错误 + 恢复动作 toast 入列），无本地回显', async () => {
    commandMock.mockImplementation(async (type: never) => {
      if (type === 'canvas.list') return { canvases: [] }
      if (type === 'canvas.get') return currentState
      if (type === 'canvas.mutate') {
        return { ok: false as const, error: { code: 'selection_conflict', message: '该问题已有选定方案', recover: '换选走 replace 参数' } }
      }
      throw new Error(`unexpected command: ${String(type)}`)
    })
    const { useToast } = await import('@/composables/useToast')
    const { toasts } = useToast()
    const wrapper = await mountPane()
    await wrapper.find('[data-node-id="o1"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="canvas-action-select"]').trigger('click')
    await flushPromises()
    await nextTick()
    await setDialogField('canvas-op-field-reason', '理由')
    await submitDialog()

    // 失败 toast 含原因与恢复动作（无乐观回显——卡片选中态不变）
    const last = toasts.value[toasts.value.length - 1]
    expect(last?.type).toBe('error')
    expect(last?.message).toContain('该问题已有选定方案')
    expect(last?.message).toContain('换选走 replace 参数')
    expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('false')
  })
})

describe('CanvasBindingBadge（绑定徽标状态）', () => {
  it('count=null（reply 缺字段兼容）不渲染徽标——未知不呈现', () => {
    const wrapper = mount(CanvasBindingBadge, { props: { count: null } })
    expect(wrapper.find('[data-testid="canvas-binding-badge"]').exists()).toBe(false)
  })

  it('空集合明示「当前无 agent 在响应」（重启后重绑入口的感知锚）', () => {
    const wrapper = mount(CanvasBindingBadge, { props: { count: 0 } })
    const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('data-binding')).toBe('none')
    expect(badge.text()).toBe('当前无 agent 在响应')
  })

  it('非空集合显示在响应会话数', () => {
    const wrapper = mount(CanvasBindingBadge, { props: { count: 2 } })
    const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
    expect(badge.attributes('data-binding')).toBe('active')
    expect(badge.text()).toBe('2 个会话在响应')
  })

  it('画布头部接线：activeBindings 随 canvas.get reply 到达——空集合明示「当前无 agent 在响应」', async () => {
    currentState = makeState({ activeBindings: 0 })
    const wrapper = await mountPane()
    const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('data-binding')).toBe('none')
    expect(badge.text()).toBe('当前无 agent 在响应')
  })

  it('画布头部接线：非空集合徽标显示在响应会话数', async () => {
    currentState = makeState({ activeBindings: 2 })
    const wrapper = await mountPane()
    const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
    expect(badge.attributes('data-binding')).toBe('active')
    expect(badge.text()).toBe('2 个会话在响应')
  })

  it('画布头部：reply 缺 activeBindings 字段（marker 通道形态 / 旧 runtime）徽标不出现——未知不呈现', async () => {
    // makeState 默认不带 activeBindings（optional 字段缺失）
    const wrapper = await mountPane()
    expect(wrapper.find('[data-testid="canvas-binding-badge"]').exists()).toBe(false)
  })
})

describe('审查报告 tab 头部结构化计数', () => {
  it('计数行 = 条目总数 + 未处置 must-fix 数（摘要条裁决落地：头部只留计数，散文总结只在条目正文）', async () => {
    currentState = makeState({
      review: {
        status: 'in-progress',
        round: 2,
        maxRounds: 5,
        entries: [
          { id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'q2', note: '缺一条分支', resolution: { disposition: 'accepted', by: 'agent', note: '已补' } },
          { id: 'rv-2', round: 2, dimension: 'support', severity: 'must-fix', targetId: 'er-1', note: '支撑缺口未附论据链' },
          { id: 'rv-3', round: 2, dimension: 'depth', severity: 'suggestion', targetId: 'o2', note: '分支过浅' },
        ],
      },
    })
    stubCommand()
    const wrapper = await mountPane()
    const counts = wrapper.find('[data-testid="canvas-review-entry-counts"]')
    expect(counts.exists()).toBe(true)
    // 3 条目中 1 条已处置 → 未处置 must-fix = 1（rv-2；rv-1 已处置不计、rv-3 是 suggestion）
    expect(counts.text()).toBe('条目 3 · 未处置 must-fix 1')
  })

  it('已处置 must-fix 与 suggestion 都不计入未处置计数', async () => {
    currentState = makeState({
      review: {
        status: 'in-progress',
        round: 1,
        maxRounds: 5,
        entries: [
          { id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'q2', note: '缺分支', resolution: { disposition: 'accepted', by: 'user', note: '已补' } },
          { id: 'rv-2', round: 1, dimension: 'depth', severity: 'suggestion', targetId: 'o2', note: '过浅' },
        ],
      },
    })
    stubCommand()
    const wrapper = await mountPane()
    expect(wrapper.find('[data-testid="canvas-review-entry-counts"]').text()).toBe('条目 2 · 未处置 must-fix 0')
  })
})
