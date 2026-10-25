/**
 * BlockWorkflow 渲染测试（容器扩展点统一 §7.4 workflow 层 2 后形态）。
 *
 * workflow 工具组（WORKFLOW_TOOL_NAMES）已删专属行组件（WorkflowRow：collapsed-only
 * 单行 + phases chips + 点击开 overlay——随「宿主删专属行组件」裁决删除），落 ToolRow
 * 通用 tool 形态：
 * - header = 通用 tool 行（toolName + 状态图标 + 行尾时刻槽），无 workflow prefix 短名
 * - 展开（点击 header）区消费 details.__gui__ 插件树（扩展侧恢复产树后的通用渲染
 *   路径——GuiComponentRenderer stub 检测；无 __gui__ 走文本兜底）
 * - 点击不再触发 openWorkflow（专属入口随行组件退役；无 __gui__ 的历史块展开看文本）
 *
 * 数据形态：workflow 顶层 input 拍平 schema：action / name / slug / args / runId 都在顶层。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/BlockWorkflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Block } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'
import { makeToolCall, mountToolBlock } from './helpers'

// workflow 专属行的 core 依赖（openWorkflow/lookupWorkflowRun）已随行组件删除——
// mock 兜底防误接：若渲染链重新 import 该模块，本 mock 使其显式可见。
vi.mock('@taiji/core/domain/drawer', () => ({
  openWorkflow: vi.fn(),
  lookupWorkflowRun: vi.fn(),
}))

function makeWorkflow(over: Partial<ToolCall> = {}): ToolCall {
  return makeToolCall({
    id: 'tc-wf-1',
    toolName: 'workflow_run',
    input: {
      name: '/abs/email-validation-refactor.js',
      slug: 'email-refactor',
      args: { task: '扫描 validator 并替换 regex' },
    },
    ...over,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BlockWorkflow: 通用 tool 形态（§7.4 workflow 层 2 删专属行组件）', () => {
  it('workflow 工具不再渲染专属 workflow-block 容器（落通用 tool 行）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    // 专属行容器已删（WorkflowRow 的 testid 不再出现）
    expect(wrapper.find('[data-testid="workflow-block"]').exists()).toBe(false)
    // 通用 tool 行 header 在场
    expect(wrapper.find('[data-testid="tool-block-header"]').exists()).toBe(true)
    // header 显示工具名（workflow_run）
    expect(wrapper.text()).toContain('workflow_run')
  })

  it('脚本名/slug 不进 header（通用行无 basename 短名通道；信息在展开区插件树）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    expect(wrapper.text()).not.toContain('email-validation-refactor')
    expect(wrapper.text()).not.toContain('email-refactor')
    // args.task 不进 header
    expect(wrapper.text()).not.toContain('扫描 validator 并替换 regex')
  })

  it('running 态 header 含呼吸弧 loader（通用 tool running 形态）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'running' }))
    // 通用 tool 的 running 动效图标（workflow 专属 RunningBlockIcon kind 已随行删除）
    expect(wrapper.find('[data-running-icon="workflow"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('workflow_run')
  })
})

describe('BlockWorkflow: details.__gui__ 走通用渲染路径（扩展恢复产树的消费面）', () => {
  const GUI_DETAILS = {
    __gui__: {
      v: 1,
      component: {
        type: 'list-tree',
        props: {
          items: [
            { label: 'build ci abcdefgh', status: 'running', depth: 0 },
          ],
        },
      },
    },
  }

  it('有 __gui__：点击 header 展开后 GuiComponentRenderer 渲染插件树（用户可见 DOM 断言）', async () => {
    const wrapper = mountToolBlock(
      makeWorkflow({ status: 'completed', details: GUI_DETAILS, output: 'Started workflow' }),
    )
    // 默认收起（completed 非失败）：展开区未渲染
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    // 点击 header 展开 → 插件树经通用渲染路径可见
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const gui = wrapper.find('[data-testid="gui-renderer-stub"]')
    expect(gui.exists()).toBe(true)
  })

  it('无 __gui__（历史块）：展开后走文本兜底（output 文本可见），不渲染 GUI', async () => {
    const wrapper = mountToolBlock(
      makeWorkflow({ status: 'completed', output: 'Started workflow (run-1).' }),
    )
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    // output 无 outputRaw（ANSI 通道）→ 通用链的纯文本 span 兜底
    expect(wrapper.text()).toContain('Started workflow (run-1).')
  })

  it('点击 header = 展开切换，不再调用 openWorkflow（专属入口随行组件退役）', async () => {
    const { openWorkflow } = await import('@taiji/core/domain/drawer')
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed', details: GUI_DETAILS }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflow).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(true)
  })

  it('phases chips 已随专属行删除（反查通道不复存在）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'running' }), { sessionId: 's9' })
    expect(wrapper.find('[data-testid="workflow-block-chips"]').exists()).toBe(false)
  })
})
