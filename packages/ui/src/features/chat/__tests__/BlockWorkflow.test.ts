/**
 * BlockWorkflow 渲染测试（v6 §11 collapsed-only 设计）。
 *
 * 设计对齐（spec v6 §11 / aca29110c「subagent/workflow details via drawer tabs」）：
 * - collapsed only：整个块单行精简摘要，无详情展开区
 * - 单行：Workflow icon + workflow prefix + name · slug
 * - action / runId / args.task 预览均不展示（非 header 字段）
 * - GUI 渲染（list-tree/progress-bar/...）不再内联展开——迁至 drawer workflow tab / extension 自呈现
 * - running 态双环 loader；failed 降 neutral-mid
 * - 点击整行 → openWorkflow(name)（drawer 开 workflow tab）
 *
 * 数据形态：workflow 顶层 input 拍平 schema：action / name / slug / args / runId 都在顶层。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/BlockWorkflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Block } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'
import { makeToolCall, mountToolBlock } from './helpers'

// mock drawer 协同层：断言点击 workflow 块时 openWorkflow(name, { slug, sessionId }) 被调
//（workflow-visualization U6/D1 入口改向后 = 开 overlay；chips 反查经 lookupWorkflowRun）
const { openWorkflowMock, lookupWorkflowRunMock } = vi.hoisted(() => ({
  openWorkflowMock: vi.fn(),
  lookupWorkflowRunMock: vi.fn(),
}))
vi.mock('@taiji/core/domain/drawer', () => ({
  openWorkflow: openWorkflowMock,
  lookupWorkflowRun: lookupWorkflowRunMock,
}))

function makeWorkflow(over: Partial<ToolCall> = {}): ToolCall {
  return makeToolCall({
    id: 'tc-wf-1',
    toolName: 'workflow',
    input: {
      action: 'run',
      name: 'email-validation-refactor',
      slug: 'email-refactor',
      args: { task: '扫描 validator 并替换 regex' },
    },
    ...over,
  })
}

beforeEach(() => {
  openWorkflowMock.mockReset()
  // chips 反查缺省无数据（不渲染；chips 用例内按需覆写返回值）
  lookupWorkflowRunMock.mockReset().mockReturnValue(undefined)
})

describe('BlockWorkflow: 标题行字段（v6 §11：prefix + name · slug）', () => {
  it('run action：header 含 workflow prefix + name + · + slug', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    const wfBlock = wrapper.find('[data-testid="workflow-block"]')
    expect(wfBlock.exists()).toBe(true)
    // workflow prefix tag
    expect(wrapper.text()).toContain('workflow')
    // name（--name 暖驼，用户裁决 2026-10-06）
    expect(wrapper.text()).toContain('email-validation-refactor')
    // slug（层级灰 --neutral-mid，用户裁决 2026-10-06；· 分隔）
    expect(wrapper.text()).toContain('email-refactor')
    // action 不展示（非 header 字段）
    expect(wrapper.text()).not.toContain('run')
    // args.task 预览不展示（v6 移除）
    expect(wrapper.text()).not.toContain('扫描 validator 并替换 regex')
  })

  it('status action：只渲染 prefix + name（无 action 动词）', () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'status', name: 'wf-check' },
      }),
    )
    expect(wrapper.text()).toContain('wf-check')
    // action 动词不展示
    expect(wrapper.text()).not.toContain('status')
  })

  it('无 name 时只渲染 prefix（slug 也没有时不显示分隔符）', () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'pause', runId: 'wf-abcd1234-efgh-5678' },
      }),
    )
    expect(wrapper.find('[data-testid="workflow-block"]').exists()).toBe(true)
    // 无 name / 无 slug → header 只剩 prefix
    expect(wrapper.text()).not.toContain('email-validation-refactor')
    // runId 不展示（非 header 字段，完整与截断都不出现）
    expect(wrapper.text()).not.toContain('wf-abcd1')
    expect(wrapper.text()).not.toContain('wf-abcd1234-efgh-5678')
  })

  it('args.task 不展示（长 task 也无截断 …）', () => {
    const longTask = '扫描'.repeat(40) // 80 字符
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'run', name: 'wf-x', args: { task: longTask } },
      }),
    )
    // 无截断标记（task 根本不进对话流）
    expect(wrapper.text()).not.toContain('…')
    // 完整长 task 不显示
    expect(wrapper.text()).not.toContain(longTask)
  })

  it('running 态 header 含双环 loader（animate-loader-spin + accent）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'running' }))
    // running 态双环 loader
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)
    // 字段仍可见（name）
    expect(wrapper.text()).toContain('email-validation-refactor')
  })

  it('不再渲染旧的状态动词（已完成/运行中/失败）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    // 旧 workflowStatusText 已删除，不再出现状态动词
    expect(wrapper.text()).not.toContain('已完成')
    expect(wrapper.text()).not.toContain('运行中')
  })
})

describe('BlockWorkflow: collapsed only（§11：无内联详情展开，GUI 迁至 drawer）', () => {
  it('details.__gui__ 存在也不渲染 GuiComponentRenderer（GUI 渲染迁出 workflow 块）', async () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        output: 'workflow running',
        details: {
          __gui__: {
            v: 1,
            component: {
              type: 'list-tree',
              props: {
                items: [
                  { label: '扫描 validator', status: 'done' },
                  { label: '替换 regex', status: 'done' },
                  { label: '补充 unit test', status: 'current' },
                ],
              },
            },
          },
        },
      }),
    )
    // workflow 块挂载
    expect(wrapper.find('[data-testid="workflow-block"]').exists()).toBe(true)
    // 点击 header 后也无详情区（collapsed only，点击行为是开 drawer）
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ansi-text-stub"]').exists()).toBe(false)
    // output 文本不内联展示
    expect(wrapper.text()).not.toContain('workflow running')
  })

  it('点击整行 → openWorkflow(name, { slug, sessionId })（U6/D1：开 overlay，反查在 renderer opener）', async () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflowMock).toHaveBeenCalledTimes(1)
    // mountToolBlock 不传 sessionId prop → 透传 undefined（opener 回落焦点 pane）
    expect(openWorkflowMock).toHaveBeenCalledWith('email-validation-refactor', {
      slug: 'email-refactor',
      sessionId: undefined,
    })
  })

  it('全路径 name：标题行显示 basename 去 .js 短名，title 保留全路径，点击 openWorkflow 仍传全路径', async () => {
    const fullPath = '/Users/x/project/.pi/workflows/email-validation-refactor.js'
    const wrapper = mountToolBlock(
      makeWorkflow({ status: 'completed', input: { action: 'run', name: fullPath, slug: 'email-refactor' } }),
    )
    const wfBlock = wrapper.find('[data-testid="workflow-block"]')
    expect(wfBlock.exists()).toBe(true)
    // 标题行短名（无目录、无 .js 后缀）
    expect(wfBlock.text()).toContain('email-validation-refactor')
    expect(wfBlock.text()).not.toContain(fullPath)
    expect(wfBlock.text()).not.toContain('.js')
    // title 保留全路径（hover 可见完整 ref）
    const nameSpan = wfBlock.findAll('span').find((s) => s.attributes('title') === fullPath)
    expect(nameSpan).toBeDefined()
    // drawer 选中仍用全路径（行为不变；openWorkflow 两参形态随 main 侧 opener 演化）
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflowMock).toHaveBeenCalledWith(fullPath, { slug: 'email-refactor', sessionId: undefined })
  })

  it('无 name 时点击 → openWorkflow(空串, { slug: undefined, ... })（opener 兜底归宿）', async () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'status' },
      }),
    )
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflowMock).toHaveBeenCalledTimes(1)
    expect(openWorkflowMock).toHaveBeenCalledWith('', { slug: undefined, sessionId: undefined })
  })
})

describe('BlockWorkflow: 多阶段 chips（workflow-visualization U6/P5，phases 折叠快照）', () => {
  const PHASES = [
    { phase: 'gate', startedAt: 1000, settledAt: 2000 },
    { phase: 'review', startedAt: 3000 },
  ]

  function mockLookup(phases: typeof PHASES | undefined): void {
    lookupWorkflowRunMock.mockReturnValue(
      phases === undefined
        ? undefined
        : {
            runId: 'wf-run-1',
            scriptName: 'email-validation-refactor',
            status: 'running',
            startedAt: '2026-10-02T00:00:00Z',
            agentCalls: [],
            stateFilePath: '',
            ...(phases.length > 0 ? { phases } : {}),
          },
    )
  }

  it('反查命中且有 phases → 渲染 mini 管道 chips（phase 名 + 状态点两态）', () => {
    mockLookup(PHASES)
    const wrapper = mountToolBlock(makeWorkflow({ status: 'running' }), { sessionId: 's9' })
    const chips = wrapper.find('[data-testid="workflow-block-chips"]')
    expect(chips.exists()).toBe(true)
    // phase 名可见
    expect(wrapper.text()).toContain('gate')
    expect(wrapper.text()).toContain('review')
    // 两态：settledAt 有值 = settled（success 点）、缺省 = running（accent 点）
    const gate = wrapper.find('[data-testid="workflow-chip-gate"]')
    expect(gate.attributes('data-state')).toBe('settled')
    const review = wrapper.find('[data-testid="workflow-chip-review"]')
    expect(review.attributes('data-state')).toBe('running')
  })

  it('反查未命中 / 旧 run 无 phases → chips 不渲染（collapsed only 形态不变）', () => {
    mockLookup(undefined)
    const miss = mountToolBlock(makeWorkflow({ status: 'completed' }), { sessionId: 's9' })
    expect(miss.find('[data-testid="workflow-block-chips"]').exists()).toBe(false)

    mockLookup([])
    const noPhases = mountToolBlock(makeWorkflow({ status: 'completed' }), { sessionId: 's9' })
    expect(noPhases.find('[data-testid="workflow-block-chips"]').exists()).toBe(false)
  })

  it('反查请求参数 = (sessionId, name, slug)——按块归属 session 分区反查', () => {
    mockLookup(PHASES)
    mountToolBlock(makeWorkflow({ status: 'completed' }), { sessionId: 's9' })
    expect(lookupWorkflowRunMock).toHaveBeenCalledWith(
      's9',
      'email-validation-refactor',
      'email-refactor',
    )
  })
})
