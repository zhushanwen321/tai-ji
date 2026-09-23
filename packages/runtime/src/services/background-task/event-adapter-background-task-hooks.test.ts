/**
 * EventAdapter 后台任务事件旁路钩子单测（u-runtime-svc，D2 触发面②）。
 *
 * 覆盖：customType background-bash 消息（exit 边沿）与 bash 工具调用结束（spawn 路径）
 * 触发旁路回调；其他事件不触发；未注入回调零影响；翻译输出不受旁路影响（纯旁路，
 * 消费端与轮询共享 last-seen——单广播源由 BackgroundTaskService 侧单测覆盖）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/background-task
 */
import { describe, it, expect, vi } from 'vitest'

import { EventAdapter } from '../../infra/pi/event-adapter.js'

function attachAdapter(onBackgroundTaskActivity?: (sessionId: string) => void) {
  const interpret = vi.fn()
  const adapter = new EventAdapter('sid-1', interpret, onBackgroundTaskActivity)
  let listener: (event: unknown) => void = () => {}
  const unsub = vi.fn()
  adapter.attach({ onEvent: (l) => { listener = l as typeof listener; return unsub } })
  return { adapter, interpret, listener, unsub }
}

const BASH_EXIT_NOTICE = {
  type: 'message_start',
  message: { role: 'custom', content: '[background-bash] bt-x finished (exit 0)', customType: 'background-bash' },
}
const BASH_TOOL_END = {
  type: 'tool_execution_end',
  toolCallId: 'tc-1',
  toolName: 'bash',
  result: { content: [{ type: 'text', text: 'ok' }] },
  isError: false,
}

describe('EventAdapter 后台任务旁路钩子（D2 触发面②）', () => {
  it('customType background-bash 消息触发旁路，翻译输出不受影响（message.customStart 照常产出）', () => {
    const activity = vi.fn()
    const { interpret, listener } = attachAdapter(activity)
    listener(BASH_EXIT_NOTICE)
    expect(activity).toHaveBeenCalledTimes(1)
    expect(activity).toHaveBeenCalledWith('sid-1')
    // 纯旁路：既有翻译（customStart 帧）原样产出
    const kinds = interpret.mock.calls[0][0].map((e: { kind: string }) => e.kind)
    expect(kinds).toContain('message')
  })

  it('bash 工具调用结束触发旁路；非 bash 工具不触发', () => {
    const activity = vi.fn()
    const { listener } = attachAdapter(activity)
    listener(BASH_TOOL_END)
    expect(activity).toHaveBeenCalledTimes(1)
    listener({ ...BASH_TOOL_END, toolName: 'read' })
    listener({ type: 'message_start', message: { role: 'custom', content: '', customType: 'other-type' } })
    listener({ type: 'agent_start' })
    expect(activity).toHaveBeenCalledTimes(1)
  })

  it('未注入回调：零影响不炸（既有两参构造兼容）', () => {
    const { interpret, listener } = attachAdapter(undefined)
    expect(() => listener(BASH_EXIT_NOTICE)).not.toThrow()
    expect(() => listener(BASH_TOOL_END)).not.toThrow()
    expect(interpret).toHaveBeenCalledTimes(2)
  })

  it('畸形事件形态：旁路静默跳过，不干扰翻译/事件流', () => {
    const activity = vi.fn()
    const { interpret, listener } = attachAdapter(activity)
    // 畸形但非 null（PiEventListener 契约事件流无 null；null 违约不在此测）
    expect(() => listener({ type: 'message_start', message: null })).not.toThrow()
    expect(() => listener({ type: 42 })).not.toThrow()
    expect(activity).not.toHaveBeenCalled()
    // 正常翻译仍工作：message:null 走 assistant-turn 兑底分支产出 2 事件，type:42 未知类型 0 事件（不进 interpret）
    listener(BASH_EXIT_NOTICE)
    expect(activity).toHaveBeenCalledTimes(1)
    expect(interpret).toHaveBeenCalledTimes(2)
  })
})
