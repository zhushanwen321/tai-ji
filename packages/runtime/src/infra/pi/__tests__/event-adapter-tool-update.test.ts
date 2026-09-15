/**
 * handleToolExecutionUpdate 流式输出归一测试（bash-running-stream-output U1）。
 *
 * 锁定设计 §6.1 判别式 + §6.4 D4 两分支截断：
 * - 三形态分发：content 数组 → output/outputRaw/detail；string → 仅 detail；
 *   无 content 数组对象 → detail = 整个对象、无 output。
 * - 尾窗截断不变式：截断后原文 ≤ cap 无例外；当 outputRaw 存在时
 *   output === stripAnsi(outputRaw)（截断在 stripAnsi 之前的原文上做，同源派生）。
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息。
 *
 * 运行：cd packages/runtime && pnpm test -- event-adapter-tool-update
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import { stripAnsi } from '../normalize-tool-result.js'
import type { PiEvent } from '../pi-protocol.js'

const CAP = 8 * 1024

/** 构造 tool_execution_update 事件。 */
function toolUpdate(partialResult: unknown): PiEvent {
  return { type: 'tool_execution_update', toolCallId: 'call-1', partialResult } as unknown as PiEvent
}

/** 从 translate 产出中取出唯一 message（payload 收窄为 Record，运行时 guard）。 */
function soleMessage(
  events: ReturnType<typeof translate>,
): { type: string; payload: Record<string, unknown> } {
  expect(events).toHaveLength(1)
  const [ev] = events
  if (!ev || ev.kind !== 'message') {
    throw new Error(`expected single message event, got: ${JSON.stringify(ev)}`)
  }
  if (typeof ev.message.payload !== 'object' || ev.message.payload === null) {
    throw new Error(`expected object payload, got: ${JSON.stringify(ev.message.payload)}`)
  }
  return ev.message as { type: string; payload: Record<string, unknown> }
}

describe('handleToolExecutionUpdate 三形态分发（判别式）', () => {
  it('content 数组形态 → detail=details + output + outputRaw（含 ANSI）', () => {
    const partialResult = {
      content: [{ type: 'text', text: '\x1b[32mstep-1\x1b[0m\nstep-2' }],
      details: { truncation: { originalLength: 100 } },
    }
    const msg = soleMessage(translate(toolUpdate(partialResult), 's1'))
    expect(msg.type).toBe('message.tool_call_update')
    expect(msg.payload.detail).toEqual({ truncation: { originalLength: 100 } })
    expect(msg.payload.output).toBe('step-1\nstep-2')
    expect(msg.payload.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\nstep-2')
  })

  it('string 形态 → 仅 detail 原样，无 output/outputRaw', () => {
    const msg = soleMessage(translate(toolUpdate('running 42%'), 's1'))
    expect(msg.payload).toEqual({ sessionId: 's1', toolCallId: 'call-1', detail: 'running 42%' })
  })

  it('无 content 数组对象形态 → detail = 整个对象，无 output', () => {
    const partialResult = { progress: 0.5, label: 'half' }
    const msg = soleMessage(translate(toolUpdate(partialResult), 's1'))
    expect(msg.payload).toEqual({ sessionId: 's1', toolCallId: 'call-1', detail: partialResult })
  })

  it('content 空数组（pi bash 首帧）→ output 为显式空串也下发', () => {
    const partialResult = { content: [] }
    const msg = soleMessage(translate(toolUpdate(partialResult), 's1'))
    expect(msg.payload.detail).toEqual({ content: [] }) // 无 details → fallback 整对象
    expect(msg.payload.output).toBe('')
    expect('outputRaw' in msg.payload).toBe(false)
  })
})

describe('D4 尾窗截断两分支', () => {
  it('换行锚分支：超 cap 且截断点后有换行 → 尾窗从首个换行起整行保留', () => {
    const line = 'x'.repeat(100) + '\n'
    const rawText = line.repeat(200) // 20200 chars > cap
    const msg = soleMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    const output = msg.payload.output as string
    expect(output.length).toBeLessThanOrEqual(CAP)
    expect(output.length).toBeGreaterThan(CAP - 300) // 丢掉的只是不足一行的头部
    expect(rawText.endsWith(output)).toBe(true) // 尾窗 = 原文后缀
    expect(output.startsWith('x')).toBe(true) // 不劈行
  })

  it('硬切分支：无换行单行 → 恰好 cap 尾窗', () => {
    const rawText = 'a'.repeat(2_000_000)
    const msg = soleMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    expect(msg.payload.output).toBe(rawText.slice(-CAP))
  })

  it('硬切分支：截断点劈开代理对 → 码点边界回退（尾窗首字符是完整码点）', () => {
    // 截断点 = len - cap。构造 emoji 区横跨截断点且截断点落在低代理上（奇数下标）：
    // len = 1000 + 8187 = 9187，cut = 995 < 1000（emoji 区内，奇数 → 孤儿低代理）
    const rawText = '😀'.repeat(500) + 'b'.repeat(8187)
    const msg = soleMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    const output = msg.payload.output as string
    expect(output.length).toBe(CAP - 1) // 孤儿低代理被跳过
    // 尾窗首码元不是孤儿低代理（不劈开代理对）
    const first = output.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    expect(rawText.endsWith(output)).toBe(true)
  })

  it('硬切分支：截断点落在 CSI 序列中段 → ANSI 残片推进到终止字节之后', () => {
    // 构造：无换行长文本，一个参数超长的 CSI 序列（中段全 ';' = 0x3B < 0x40 非终止字节）横跨截断点。
    // len = 100 + 502 + 8092 = 8694，cut = 502 ∈ CSI 区 [100, 602)
    const csi = '\x1b[' + ';'.repeat(500) + 'm'
    const rawText = 'c'.repeat(100) + csi + '\x1b[31mRED\x1b[0m' + 'q'.repeat(8080)
    const msg = soleMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    const output = msg.payload.output as string
    expect(output.length).toBeLessThanOrEqual(CAP)
    // 尾窗从残缺 CSI 终止字节 'm' 之后起步：不含半截序列，以 RED 开头
    expect(output.startsWith('RED')).toBe(true)
    // 同源派生不变式（outputRaw 存在时）
    const outputRaw = msg.payload.outputRaw as string
    expect(output).toBe(stripAnsi(outputRaw))
    expect(outputRaw.endsWith('RED\x1b[0m' + 'q'.repeat(8080))).toBe(true)
  })

  it('不变式：任意形态下 output 存在时截断后原文 ≤ cap，且 outputRaw 存在时 output === stripAnsi(outputRaw)', () => {
    const cases = [
      '\n'.repeat(50_000),
      'z'.repeat(50_000),
      '\x1b[32mg\x1b[0m'.repeat(10_000) + 'x'.repeat(9_000),
      '😀'.repeat(6_000),
    ]
    for (const rawText of cases) {
      const msg = soleMessage(
        translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
      )
      const output = msg.payload.output as string
      const outputRaw = msg.payload.outputRaw as string | undefined
      const rawSource = outputRaw ?? output
      expect(rawSource.length).toBeLessThanOrEqual(CAP)
      if (outputRaw !== undefined) {
        expect(output).toBe(stripAnsi(outputRaw))
      }
      expect(rawText.endsWith(rawSource)).toBe(true) // 尾部保留语义
    }
  })
})
