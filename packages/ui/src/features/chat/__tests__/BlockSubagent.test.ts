/**
 * BlockSubagent.vue 组件测试（v6 §10 collapsed-only 设计）。
 *
 * 设计对齐（spec v6 §10 / aca29110c「subagent/workflow details via drawer tabs」）：
 * - collapsed only：整个块单行精简摘要，无展开体、无 task 预览、无 bg 状态行（均已移除）
 * - 单行：Bot icon + subagent prefix + agent · slug + (model · thinking X)
 * - running 态双环 loader；failed 态整行降 neutral-mid（不切 icon）
 * - 点击整行 → openSubagent（drawer 开 subagent tab 看完整对话流）；缺 subagentId/sessionId 时 no-op
 *
 * 数据形态（@zhushanwen/pi-subagent-workflow，重写 fork）：
 * - input 顶层拍平：action / agent / slug / model / thinkingLevel / task 都在顶层（非 startParam 嵌套）
 * - output 是 JSON 字符串，subagentId 在顶层（toolResult.subagentId，start action 立即返回）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/BlockSubagent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { BlockSubagent } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'
import { subagentVirtualId } from '@taiji/shared'

// mock drawer 协同层：断言点击整行时 openSubagent 以 virtualId + enteredFrom 被调
const { openSubagentMock } = vi.hoisted(() => ({ openSubagentMock: vi.fn() }))
vi.mock('@taiji/core/domain/drawer', () => ({
  openSubagent: openSubagentMock,
}))

/** 构造真实形态的 subagent ToolCall（顶层拍平 input） */
function makeSubagent(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-sub-1',
    toolName: 'subagent',
    input: {
      action: 'start',
      agent: 'researcher',
      slug: 'research-trace-ui',
      task: '调研 trace UI 渲染方案',
    },
    status: 'completed',
    startTime: 1000,
    endTime: 2000,
    ...over,
  }
}

beforeEach(() => {
  openSubagentMock.mockReset()
})

describe('BlockSubagent: 标题行渲染（顶层 input 拍平字段）', () => {
  it('渲染 subagent prefix + agent（accent）+ · + slug（accent）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent(), sessionId: 's1' },
    })
    const text = wrapper.text()
    // subagent prefix 文案（大写 S，CSS uppercase 已移除改为首字母大写文字）
    expect(text).toContain('Subagent')
    // agent 名（顶层 input.agent，非默认值）
    expect(text).toContain('researcher')
    // slug（顶层 input.slug）
    expect(text).toContain('research-trace-ui')
    // agent / slug 走 accent 色
    expect(wrapper.find('.text-accent').exists()).toBe(true)
  })

  it('无 input.agent 时回退默认 general-purpose', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: 'do something' } }),
      },
    })
    expect(wrapper.text()).toContain('general-purpose')
  })

  it('有 model + thinkingLevel 时渲染括号（model accent，括号/· thinking dim）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            agent: 'researcher',
            slug: 'rs',
            model: 'anthropic/claude-sonnet-4',
            thinkingLevel: 'high',
            task: 'task',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('anthropic/claude-sonnet-4')
    expect(text).toContain('thinking high')
  })

  it('有 model 无 thinkingLevel 时只渲染括号 + model', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            agent: 'researcher',
            model: 'openai/gpt-4o',
            task: 'task',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('openai/gpt-4o')
    expect(text).not.toContain('thinking')
  })
})

describe('BlockSubagent: collapsed only（§10：task 预览 / 展开体 / bg 状态行已移除）', () => {
  it('task 不在对话流内展示（task 预览已移除，全文看 drawer subagent tab）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: '单行短任务' } }),
      },
    })
    expect(wrapper.text()).not.toContain('单行短任务')
  })

  it('无展开体：点击整行不出现 task 完整内容区', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: '完整 task 内容' } }),
      },
    })
    // 默认无展开体
    expect(wrapper.find('.subagent-task-full').exists()).toBe(false)
    // 点击后依然无展开体（collapsed only，点击行为是开 drawer 而非展开）
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(wrapper.find('.subagent-task-full').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('完整 task 内容')
  })

  it('output 有 bgResponse 也不渲染 bg 状态行（完成通知走 §10.5 BgNotifyCard）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: 'task' },
          output: JSON.stringify({
            action: 'start',
            subagentId: '1338dda5',
            sessionFile: null,
            slug: 'rs',
            bgResponse: {
              status: 'running',
              mode: 'background',
              message: 'detached, will notify on completion (auto-injected message, do not poll)',
            },
          }),
        }),
      },
    })
    const text = wrapper.text()
    expect(text).not.toContain('background ·')
    expect(text).not.toContain('detached, will notify on completion')
    // 无状态点 blink 动画
    expect(wrapper.find('.animate-blink').exists()).toBe(false)
  })
})

describe('BlockSubagent: 点击行为（开 drawer subagent tab）', () => {
  it('output 含 subagentId + sessionId → openSubagent(virtualId, enteredFrom:chat)', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          output: JSON.stringify({
            action: 'start',
            subagentId: '1338dda5',
            sessionFile: null,
            slug: 'rs',
          }),
        }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).toHaveBeenCalledTimes(1)
    expect(openSubagentMock).toHaveBeenCalledWith({
      virtualId: subagentVirtualId('s1', '1338dda5'),
      enteredFrom: 'chat',
    })
  })

  it('缺 sessionId 时 no-op（不抛错、不调 openSubagent）', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          output: JSON.stringify({ action: 'start', subagentId: '1338dda5' }),
        }),
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).not.toHaveBeenCalled()
  })

  it('output 非合法 JSON 时 no-op（running 早期 output 未就绪）', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ output: 'plain text not json' }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).not.toHaveBeenCalled()
  })

  it('output JSON 无 subagentId 字段时 no-op', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ output: JSON.stringify({ action: 'start', slug: 'rs' }) }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).not.toHaveBeenCalled()
  })
})

describe('BlockSubagent: running / failed / unfinished 态', () => {
  it('running 态渲染双环 loader（animate-loader-spin + text-accent）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'running' }) },
    })
    expect(wrapper.find('.animate-loader-spin.text-accent').exists()).toBe(true)
    // 不再有旧的脉冲点 / reasoning 紫
    expect(wrapper.find('.animate-working-pulse').exists()).toBe(false)
    expect(wrapper.find('.bg-reasoning').exists()).toBe(false)
  })

  it('running 态无 progress 快照字段（detail 永远 undefined，异步 background）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'running', detail: undefined }) },
    })
    const text = wrapper.text()
    // 不应渲染旧的进度字段
    expect(text).not.toContain('turn ')
    expect(text).not.toContain('tokens')
    // loader 仍在
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)
  })

  it('failed 态整行降 neutral-dim（不切 icon，颜色表达）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          status: 'error',
          input: { action: 'start', agent: 'researcher', task: 'failed task' },
        }),
      },
    })
    // 整行 header 中性灰（feat-chat-flow-dim：恒 dim 置灰）
    expect(wrapper.find('[data-testid="subagent-block"] > div').classes()).toContain('text-neutral-dim')
    // 仍展示 agent（不因 failed 隐藏）
    expect(wrapper.text()).toContain('researcher')
  })

  it('unfinished 态不渲染终态指示（终态 icon 已移除）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'end_not_received' }) },
    })
    // 终态指示（Check/CircleDashed/未收到结果文字）已移除，unfinished 态不再显示额外文案
    expect(wrapper.text()).not.toContain('未收到结果')
    expect(wrapper.find('.trace-subagent').exists()).toBe(true)
  })

  it('根 div 是 trace-subagent（纯缩进无边框）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent() },
    })
    const root = wrapper.find('.trace-subagent')
    expect(root.exists()).toBe(true)
    expect(root.classes()).not.toContain('border-b')
    expect(root.classes()).not.toContain('border-dashed')
    expect(root.classes()).not.toContain('border-danger')
    expect(root.classes()).not.toContain('bg-danger-soft')
  })
})
