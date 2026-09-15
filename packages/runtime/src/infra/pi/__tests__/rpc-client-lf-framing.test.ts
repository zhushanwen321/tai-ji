/**
 * LF-only 读取器构造帧测试（composer-multi-skill-injection D10 / 验收场景 9）。
 *
 * 场景 9 例外声明（设计 §4 明文许可）：U+2028/U+2029 无法依赖真实模型输出可靠构造，
 * 协议层防御采用确定性构造帧验证（标准做法）；端到端大文本路径由真实会话场景覆盖。
 *
 * 三组断言：
 * ① 新读取器（attachLfOnlyLineReader）：含 U+2028/U+2029 的单行 JSON 不拆帧，
 *    JSON.parse 全部成功——多帧连续 / 尾部无换行 / 半行到达（含多字节字符跨 chunk）/ CRLF；
 * ② 对照组：同输入下 node readline 语义复现拆帧——证明隐患真实（readline 把 U+2028/U+2029
 *    当行分隔符，单条 JSON 被拆成多帧且各自 parse 失败）；若未来 node 改变 readline 行为
 *    使本组失守，说明隐患面消失，可复核后移除对照组；
 * ③ 普通多行 JSONL：逐行解析与旧行为（readline）等价。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-lf-framing.test.ts
 */
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { attachLfOnlyLineReader } from '../rpc-client.js'
import type { PiMessage } from '../rpc-client.js'

/** 收集流上的全部行（等待流 end 后断言，避免 async 断言竞态）。 */
function collectLinesViaLfReader(): { stream: PassThrough; lines: string[]; done: Promise<void> } {
  const stream = new PassThrough()
  const lines: string[] = []
  let finish: () => void
  const done = new Promise<void>((resolve) => { finish = resolve })
  const detach = attachLfOnlyLineReader(stream, (line) => lines.push(line))
  stream.on('end', () => { detach(); finish() })
  return { stream, lines, done }
}

/** readline 侧收集器（对照组与等价组用，语义 = 改造前的旧实现形态）。 */
function collectLinesViaReadline(stream: PassThrough): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = []
    const rl = createInterface({ input: stream })
    rl.on('line', (line: string) => lines.push(line))
    rl.on('close', () => resolve(lines))
  })
}

/** 构造含 U+2028/U+2029 的合法单行 JSON（JSON.stringify 不转义这两个字符，原样入串）。 */
function lineWithSeparators(id: number): string {
  return JSON.stringify({
    type: 'message_update',
    id: String(id),
    payload: { delta: `段落一\u2028行内分隔\u2029段落二 ${id}` },
  })
}

describe('attachLfOnlyLineReader（D10：LF-only 分帧）', () => {
  it('① 含 U+2028/U+2029 的单行 JSON 多帧连续：不拆帧，JSON.parse 全部成功', async () => {
    const { stream, lines, done } = collectLinesViaLfReader()
    const l1 = lineWithSeparators(1)
    const l2 = lineWithSeparators(2)
    const l3 = lineWithSeparators(3)
    stream.write(l1 + '\n')
    stream.write(l2 + '\n')
    stream.write(l3 + '\n')
    stream.end()
    await done

    expect(lines).toEqual([l1, l2, l3])
    for (const line of lines) {
      const msg = JSON.parse(line) as PiMessage
      expect(msg.type).toBe('message_update')
      // U+2028/U+2029 原样保留在字符串值内（未被当分隔符吞掉）
      expect(msg.payload?.delta).toContain('\u2028')
      expect(msg.payload?.delta).toContain('\u2029')
    }
  })

  it('① 尾部无换行：流 end 时 flush 半行残留（decoder.end() 兜底交付）', async () => {
    const { stream, lines, done } = collectLinesViaLfReader()
    const trailing = lineWithSeparators(9)
    stream.write(lineWithSeparators(8) + '\n')
    stream.write(trailing) // 无 \n，直接 end
    stream.end()
    await done

    expect(lines).toEqual([lineWithSeparators(8), trailing])
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow()
  })

  it('① 半行到达：帧被切成任意 chunk 边界（含多字节 UTF-8 字符跨 chunk）仍完整重组', async () => {
    const { stream, lines, done } = collectLinesViaLfReader()
    const l1 = lineWithSeparators(1)
    const l2 = lineWithSeparators(2)
    const whole = l1 + '\n' + l2 + '\n'
    // 按字节逐块写入：多字节字符（中文/U+2028 均为 3 字节 UTF-8）被刻意切在中间，
    // StringDecoder 负责半字节序列挂起，不产 replacement char
    const buf = Buffer.from(whole, 'utf8')
    for (let i = 0; i < buf.length; i += 3) {
      stream.write(buf.subarray(i, Math.min(i + 3, buf.length)))
    }
    stream.end()
    await done

    expect(lines).toEqual([l1, l2])
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow()
  })

  it('① 行尾 \\r 剥离（CRLF 输入对齐 pi 实装行为）', async () => {
    const { stream, lines, done } = collectLinesViaLfReader()
    stream.write(JSON.stringify({ type: 'response', success: true }) + '\r\n')
    stream.end()
    await done

    expect(lines).toEqual([JSON.stringify({ type: 'response', success: true })])
  })

  it('② 对照组：同输入下 node readline 复现拆帧（隐患真实性的证据，非新实现断言）', async () => {
    const stream = new PassThrough()
    const done = collectLinesViaReadline(stream)
    stream.write(lineWithSeparators(1) + '\n')
    stream.end()
    const lines = await done

    // readline 把 U+2028/U+2029 当行分隔符：单条 JSON 被拆成 >1 行，且没有任何一行
    // 能独立通过 JSON.parse——这正是旧实现的丢消息路径（parse error 静默 skip）。
    // 本组断言 node 行为漂移哨兵：若未来 readline 改为 LF-only 分帧，此断言失败，
    // 说明隐患面消失，对照组可复核后移除。
    expect(
      lines.length,
      `node readline 分帧行为已变化（期望拆帧 >1 行，实际 ${lines.length} 行）——U+2028 拆帧隐患不再复现，复核后可移除本对照组`,
    ).toBeGreaterThan(1)
    for (const line of lines) {
      expect(() => JSON.parse(line)).toThrow()
    }
  })

  it('③ 普通多行 JSONL：新读取器逐行解析与 readline（旧行为）等价', async () => {
    const payloads = [
      JSON.stringify({ type: 'response', id: 'r1', success: true, data: { a: 1 } }),
      JSON.stringify({ type: 'message_start', payload: { role: 'assistant' } }),
      JSON.stringify({ type: 'agent_end' }),
      '', // 空行：读取器会 emit 空串，空行跳过语义属消费方（rpc-client line handler），两侧一致
    ]
    const input = payloads.map((p) => p + '\n').join('')

    const viaLf = collectLinesViaLfReader()
    viaLf.stream.write(input)
    viaLf.stream.end()
    const stream2 = new PassThrough()
    const viaRl = collectLinesViaReadline(stream2)
    stream2.write(input)
    stream2.end()

    const [lfLines, rlLines] = await Promise.all([viaLf.done.then(() => viaLf.lines), viaRl])
    expect(lfLines).toEqual(rlLines)
    // 空行跳过属消费方语义（rpc-client line handler 的 if (!line.trim()) return），此处只断言非空行的解析序列
    expect(
      lfLines.filter((l) => l.trim() !== '').map((l) => (JSON.parse(l) as PiMessage).type),
    ).toEqual(['response', 'message_start', 'agent_end'])
  })
})
