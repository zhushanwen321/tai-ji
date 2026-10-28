/**
 * AgentStreamDrawer 组件测试（[2026-10-19] workflow agent 抽屉——三视角，TEST-STRATEGY §3）：
 *
 * - 使用者（黑盒 DOM）：抽屉收起/展开（inert + translate）、tab 条渲染与状态点、
 *   关闭回落（激活左邻/全关收起）、对话流（MessageStream stub 挂 subagent 三段式 vid）、
 *   快照失败错误态 + 重试按钮
 * - 构建者（白盒）：openAgent expose 驱动（宿主 ref 模式）、pending no-op 守卫、
 *   memberRecordId 未达等待态 → run 投影更新后 watch(virtualId) 加载自愈（AgentTabContent
 *   三段式管线——agent tab 快照通道已由 subagent 实时流取代）
 * - 观察者（形态）：data-testid 树（wf-viz-agent-drawer-*）与 data-active/data-call-id
 *
 * mock 策略同 workflow-live-panel.test.ts（session RPC / vue-i18n / MessageStream /
 * useSubagentTabData）——AgentTabContent 为真实组件挂载，其拉取编排与信号链走 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/agent-stream-drawer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AgentStreamDrawer from '../panel/AgentStreamDrawer.vue'
import { openShieldingSurfaces, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry/registry'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

// ── mock：RPC 域 + @/api 门面回指（AgentTabContent 挂载链需要 store + api）────────

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getWorkflowRunEvents: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

// ── mock：i18n（t(key, named) → `key(k=v)`）───────────────────────────────────

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

// ── mock：subagent 三段式拉取编排（同 live-panel.test——错误态与自愈用例的可控注入点）──

const loadSubagentDataMock = vi.fn().mockResolvedValue(undefined)
const loadErrorRef = ref<string | null>(null)
vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: loadErrorRef,
    loadSubagentData: loadSubagentDataMock,
    stopSubagentStream: vi.fn(),
    recordEngine: vi.fn(() => 'pi'),
  }),
}))
vi.mock('@/components/panel/MessageStream.vue', () => ({
  default: {
    name: 'MessageStreamStub',
    props: ['sessionId', 'mainSessionId'],
    setup(props: { sessionId: string; mainSessionId?: string }) {
      return () =>
        h(
          'div',
          { 'data-testid': 'message-stream-stub', 'data-main-sid': props.mainSessionId ?? '' },
          props.sessionId,
        )
    },
  },
}))

// ── 测试数据 ──────────────────────────────────────────────────────────────────

const SID = 's-drawer'
const RUN_ID = 'wf-drawer-1'
// 三段式 vid（AgentTabContent.virtualId = subagentVirtualId(SID, call.memberRecordId)）
const VID0 = 'subagent:s-drawer:rec-0'

function makeCall(overrides: Partial<WorkflowAgentCall> & { id: number }): WorkflowAgentCall {
  return {
    agent: `worker-${overrides.id}`,
    phase: 'alpha',
    status: 'done',
    startedAt: '2026-10-19T02:00:00Z',
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 200,
    sessionId: `acs-${overrides.id}`,
    memberRecordId: `rec-${overrides.id}`,
    ...overrides,
  }
}

function makeRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: RUN_ID,
    scriptName: 'drawer-flow',
    status: 'running',
    reason: undefined,
    outcome: undefined,
    startedAt: '2026-10-19T02:00:00Z',
    completedAt: undefined,
    argsSummary: '{"task":"demo"}',
    stateFilePath: '/tmp/record.jsonl',
    agentCalls: [
      makeCall({ id: 0, status: 'done' }),
      makeCall({ id: 1, status: 'running', phase: 'beta' }),
      makeCall({ id: 2, status: 'pending', sessionId: undefined }),
    ],
    ...overrides,
  }
}

type DrawerVM = { openAgent: (call: WorkflowAgentCall) => void }

async function mountDrawer(run = makeRun()) {
  const wrapper = mount(AgentStreamDrawer, {
    props: { sessionId: SID, run },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  loadSubagentDataMock.mockClear()
  loadErrorRef.value = null
})

describe('AgentStreamDrawer · 开合（黑盒 DOM）', () => {
  it('初始收起：inert + aria-hidden（tab 集为空也无空态 UI——抽屉未开启即不可见不可达）', async () => {
    const wrapper = await mountDrawer()
    const drawer = wrapper.find('[data-testid="wf-viz-agent-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('inert')).toBeDefined()
    expect(drawer.attributes('aria-hidden')).toBe('true')
    expect(drawer.classes()).toContain('translate-x-full')
  })

  it('openAgent(call) → 展开 + 对话流挂载 subagent 三段式 vid + 拉取编排被调 + meta 条（构建者 + 黑盒）', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    const drawer = wrapper.find('[data-testid="wf-viz-agent-drawer"]')
    expect(drawer.attributes('inert')).toBeUndefined()
    expect(drawer.classes()).toContain('translate-x-0')
    // 对话流：MessageStream stub 挂 subagent 三段式 vid；mainSessionId = 发起 session（D11⑤）
    const stream = wrapper.find('[data-testid="message-stream-stub"]')
    expect(stream.exists()).toBe(true)
    expect(stream.text()).toBe(VID0)
    expect(stream.attributes('data-main-sid')).toBe(SID)
    // 快照编排接线（useSubagentTabData.loadSubagentData 复用，零新拉取链）
    expect(loadSubagentDataMock).toHaveBeenCalledWith(VID0)
    // trace 详情元信息条（AgentTabContent 复用）
    expect(wrapper.find('[data-testid="wf-viz-agent-meta"]').text()).toContain('worker-0')
    // 单 tab 也渲染 tab 条（demo 确认形态：chip 常显，「全关 = 收起」语义可达）
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer-tab-strip"]').exists()).toBe(true)
  })

  it('收起钮：只收起不清 tab（重开恢复既有 tab 集）；卸载归宿在宿主 v-if', async () => {
    const wrapper = await mountDrawer()
    const vm = wrapper.vm as unknown as DrawerVM
    vm.openAgent(makeCall({ id: 0 }))
    await flushPromises()
    await wrapper.find('[data-testid="wf-viz-agent-drawer-collapse"]').trigger('click')
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeDefined()
    // 重开（宿主再次 openAgent）→ 原 tab 恢复激活，快照不重拉（同 vid 分区复用）
    loadSubagentDataMock.mockClear()
    vm.openAgent(makeCall({ id: 0 }))
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeUndefined()
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })
})

describe('AgentStreamDrawer · 守卫与多 tab（黑盒 + 构建者）', () => {
  it('pending / sessionId 缺失 call：openAgent no-op（零对话可看，对齐 trace 行守卫现状）', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 2, status: 'pending', sessionId: undefined }))
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeDefined()
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
  })

  it('两个 call → tab 条双 chip（状态点 + 名称 + 关闭钮）；点击切换激活', async () => {
    const wrapper = await mountDrawer()
    const vm = wrapper.vm as unknown as DrawerVM
    vm.openAgent(makeCall({ id: 0 }))
    vm.openAgent(makeCall({ id: 1, status: 'running' }))
    await flushPromises()
    const strip = wrapper.find('[data-testid="wf-viz-agent-drawer-tab-strip"]')
    expect(strip.exists()).toBe(true)
    const tabs = strip.findAll('[data-testid="wf-viz-agent-drawer-tab-item"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].attributes('data-active')).toBe('true') // 后开者激活
    expect(tabs[0].attributes('data-active')).toBe('false')
    // running 状态点 + 名称
    expect(tabs[1].text()).toContain('worker-1')
    // 切换：点第一个 chip → 激活切走 + 对话流换 vid
    await tabs[0].trigger('click')
    await flushPromises()
    expect(strip.findAll('[data-testid="wf-viz-agent-drawer-tab-item"]')[0].attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="message-stream-stub"]').text()).toBe(VID0)
  })

  it('关闭激活 tab → 激活左邻；全关 → 抽屉收起（demo 语义：无剩余收起）', async () => {
    const wrapper = await mountDrawer()
    const vm = wrapper.vm as unknown as DrawerVM
    vm.openAgent(makeCall({ id: 0 }))
    vm.openAgent(makeCall({ id: 1, status: 'running' }))
    await flushPromises()
    // 关激活者（#1）→ 激活左邻 #0，对话流切走
    await wrapper.find('[data-testid="wf-viz-agent-drawer-tab-item"][data-call-id="1"] [data-testid="wf-viz-agent-drawer-tab-close"]').trigger('click')
    await flushPromises()
    const tabs = () => wrapper.findAll('[data-testid="wf-viz-agent-drawer-tab-item"]')
    expect(tabs()).toHaveLength(1)
    expect(tabs()[0].attributes('data-call-id')).toBe('0')
    expect(tabs()[0].attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="message-stream-stub"]').text()).toBe(VID0)
    // 关最后一个 → 抽屉收起 + 对话流卸载
    await tabs()[0].find('[data-testid="wf-viz-agent-drawer-tab-close"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeDefined()
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
  })
})

describe('AgentStreamDrawer · 快照刷新与错误态（AgentTabContent 链保持）', () => {
  it('memberRecordId 未达 → 等待态零拉取；run 投影更新后就绪 → watch(virtualId) 加载自愈（§3.1-2 刷新链现行形态）', async () => {
    const wrapper = await mountDrawer(makeRun({ agentCalls: [makeCall({ id: 0, memberRecordId: undefined })] }))
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0, memberRecordId: undefined }))
    await flushPromises()
    // memberRecordId 未达（run 推送窗口）：等待态，零对话可看，快照编排不发起
    expect(wrapper.find('[data-testid="wf-viz-agent-waiting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
    expect(loadSubagentDataMock).not.toHaveBeenCalled()
    loadSubagentDataMock.mockClear()
    // run 投影更新（recordId 就绪）→ activeCall 反查最新投影 → watch(virtualId) 触发加载自愈
    wrapper.setProps({ run: makeRun() })
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-waiting"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
    expect(loadSubagentDataMock).toHaveBeenCalledWith(VID0)
  })

  it('快照拉取失败：错误态 + 重试按钮；点重试重调快照编排（§3.1-2 同一错误态语言）', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    loadErrorRef.value = 'rpc down'
    await flushPromises()
    const err = wrapper.find('[data-testid="wf-viz-agent-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('rpc down')
    const retryBtn = err.find('[data-testid="wf-viz-agent-retry"]')
    expect(retryBtn.exists()).toBe(true)
    loadSubagentDataMock.mockClear()
    await retryBtn.trigger('click')
    expect(loadSubagentDataMock).toHaveBeenCalledWith(VID0)
    loadErrorRef.value = null
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })
})

describe('AgentStreamDrawer · 模态表面聚合注册（§6.7 agent-stream-drawer 族）', () => {
  beforeEach(() => {
    // 注册表是模块级单例：本 describe 用例自持挂载实例，先复位防跨用例条目残留
    resetModalSurfaceRegistry()
  })

  it('挂载即注册 view 遮蔽族（intersecting）：开合态直读 open 本体，rect 读抽屉根元素实测', async () => {
    const wrapper = await mountDrawer()
    // 收起（open=false）：不在遮蔽报告内
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(false)
    // 展开：intersecting 档 + rect 读点直读 DOM（jsdom 下 getBoundingClientRect 全 0，非 null 即读点接通）
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    const entry = openShieldingSurfaces().find((s) => s.id === 'agent-stream-drawer')
    expect(entry).toBeDefined()
    expect(entry?.mode).toBe('intersecting')
    expect(entry?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    // 收起后恢复「不在报告内」（开合态与 open 本体绑定）
    await wrapper.find('[data-testid="wf-viz-agent-drawer-collapse"]').trigger('click')
    await flushPromises()
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(false)
  })

  it('卸载即注销（onBeforeUnmount dispose）：条目从注册表摘除', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(true)
    wrapper.unmount()
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(false)
  })
})
