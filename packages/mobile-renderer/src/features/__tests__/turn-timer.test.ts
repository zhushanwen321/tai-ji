// turn-timer 纯函数测试（remote-use-mobile-v2 §6.21 回合计时与步数的客户端派生）。
//
// 锁定三件事（验收条款 3 的派生口径半；组件呈现半在 chat-screen.test.ts）：
//   ① MM:SS 计时格式（分钟不封顶；负差钳 0——时钟回拨不出负文案）
//   ② 步数 = 本回合工具调用完成计数（status ≠ 'running'；起点索引前不计——上一回合
//     工具计数不并入本回合）
//   ③ 回合起点锚点 = 分区尾部回看一条（空分区钳 0）
import { describe, expect, it } from 'vitest'
import type { Message } from '@taiji/shared'
import { countCompletedToolCalls, formatObservedDuration, turnStartIndexAt } from '../turn-timer'

function msgWithTools(id: string, statuses: Array<'running' | 'completed'>, offsetMs = 0): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp: 1_000_000 + offsetMs,
    toolCalls: statuses.map((status, i) => ({
      id: `${id}-t${i}`,
      toolName: 'Bash',
      input: {},
      status,
    })),
  } as Message
}

describe('formatObservedDuration（§6.21 已观察计时）', () => {
  it('MM:SS 格式：秒与分各补两位', () => {
    expect(formatObservedDuration(0, 65_000)).toBe('01:05')
    expect(formatObservedDuration(0, 4_000)).toBe('00:04')
    expect(formatObservedDuration(0, 600_000)).toBe('10:00')
  })

  it('分钟不封顶：超 60min 不进小时位换挡（75:30 形态）', () => {
    expect(formatObservedDuration(0, 4_530_000)).toBe('75:30')
  })

  it('now 早于起点（时钟回拨）→ 钳 00:00，不出负文案', () => {
    expect(formatObservedDuration(10_000, 5_000)).toBe('00:00')
  })
})

describe('countCompletedToolCalls（§6.21 步数 = 本回合工具完成计数）', () => {
  it('running 不计、completed 计入（overlay 语义：原地翻转后计数递增）', () => {
    const messages = [msgWithTools('m1', ['completed', 'running', 'completed'])]
    expect(countCompletedToolCalls(messages, 0)).toBe(2)
  })

  it('起点索引之前的消息不计（上一回合工具计数不并入本回合）', () => {
    const messages = [
      msgWithTools('prev-turn', ['completed', 'completed']),
      msgWithTools('current-turn', ['completed', 'completed', 'running']),
    ]
    expect(countCompletedToolCalls(messages, 0)).toBe(4)
    expect(countCompletedToolCalls(messages, 1)).toBe(2)
  })

  it('无 toolCalls 的消息跳过；起点越界钳 0；空分区返回 0', () => {
    const textOnly = [{ id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 } as Message]
    expect(countCompletedToolCalls(textOnly, 0)).toBe(0)
    expect(countCompletedToolCalls([], 3)).toBe(0)
    expect(countCompletedToolCalls([msgWithTools('m1', ['completed'])], 99)).toBe(0)
  })
})

describe('turnStartIndexAt（回合起点锚点）', () => {
  it('尾部回看一条；空分区钳 0', () => {
    expect(turnStartIndexAt([])).toBe(0)
    const one = [{ id: 'a', role: 'user' } as Message]
    expect(turnStartIndexAt(one)).toBe(0)
    const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }].map((m) => ({ ...m, role: 'assistant', content: '', status: 'complete', timestamp: 1 }) as Message)
    expect(turnStartIndexAt(three)).toBe(2)
  })
})
