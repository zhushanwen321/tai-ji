import { attachLfOnlyLineReader, type PiMessage } from '../rpc-client.js';
import { _resetAttachAssertSkipStatsForTest, assertPiSessionFile, attachAssertSkipStats, setAttachAssertExemptionForTest, type SessionFileAssertClient } from '../session-attach-assert.js';
import { _resetSidecarWarnDedupForTest, readBindingSidecar } from '../session-binding-sidecar-io.js';
import { PiSessionStore } from '../session-store.js';
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared';
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


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


// ======================================================================
// ← session-store-oversize.test.ts
// ======================================================================

let tmpDir: string


let store: PiSessionStore


/** 稀疏大文件（size 超阈值；不写内容——预检只 statSync，不触发读取）。 */
function writeSparseOverSize(name: string, size: number): string {
  const filePath = join(tmpDir, name)
  const fd = openSync(filePath, 'w')
  try {
    ftruncateSync(fd, size)
  } finally {
    closeSync(fd)
  }
  return filePath
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rpc-client-lf-framing', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rpc-client-lf-framing', () => {
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-store-oversize', () => {
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-store-oversize-'))
  store = new PiSessionStore()
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('D5④ oversize 标记', () => {
  it('超阈值文件 → oversize 标记非 null，含实际字节数与阈值', () => {
    const overSize = READ_PRECHECK_MAX_BYTES + 1024
    const filePath = writeSparseOverSize('big.jsonl', overSize)

    const result = store.readSessionJsonlText(filePath)

    expect(result).not.toBeNull()
    expect(typeof result).not.toBe('string') // 明确不是文本（不与正常读取混淆）
    expect(result).toMatchObject({ oversize: true, bytes: overSize, maxBytes: READ_PRECHECK_MAX_BYTES })
  })

  it('文件缺失 → 仍返回 null（既有空态契约回归，规则 6）', () => {
    const result = store.readSessionJsonlText(join(tmpDir, 'not-persisted.jsonl'))
    expect(result).toBeNull()
  })

  it('阈值内文件 → 返回全文文本（行为不变）', () => {
    const filePath = join(tmpDir, 'small.jsonl')
    writeFileSync(filePath, '{"type":"session"}\n{"type":"assistant"}\n', 'utf-8')

    const result = store.readSessionJsonlText(filePath)

    expect(result).toBe('{"type":"session"}\n{"type":"assistant"}\n')
  })
})
});
});

// ======================================================================
// ← session-attach-assert.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← session-attach-assert.test.ts
// ======================================================================

let dir: string


let errorSpy: MockInstance<typeof console.error>


function stateClient(sessionFile: string | undefined): SessionFileAssertClient {
  return { getState: async () => (sessionFile === undefined ? {} : { sessionFile }) }
}


// ======================================================================
// ← session-binding-sidecar-io.test.ts
// ======================================================================

let dir_m2: string


let warnSpy: MockInstance<typeof console.warn>


const decode = (b: unknown): string | undefined => {
  const rec = b as Record<string, unknown> | undefined
  return rec && typeof rec.presetId === 'string' ? rec.presetId : undefined
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-attach-assert', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-attach-assert', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'attach-assert-rt3-7-'))
  _resetAttachAssertSkipStatsForTest()
  setAttachAssertExemptionForTest(false)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
  setAttachAssertExemptionForTest(false)
  _resetAttachAssertSkipStatsForTest()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('assertPiSessionFile · 跳过分支显形（RT-3#7）', () => {
  it('分支1 无 getState → 计数 noGetState + 首次 error，同类二次不重复输出', async () => {
    const noState = {} as SessionFileAssertClient

    await assertPiSessionFile(noState, join(dir, 'x.jsonl'), 'ctx-1')
    expect(attachAssertSkipStats.noGetState).toBe(1)
    const errs = errorSpy.mock.calls.map(c => String(c[0]))
    expect(errs.some(m => m.includes('client lacks getState') && m.includes('I1'))).toBe(true)

    await assertPiSessionFile(noState, join(dir, 'x.jsonl'), 'ctx-1b')
    expect(attachAssertSkipStats.noGetState).toBe(2)
    expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('client lacks getState'))).toHaveLength(1)
  })

  it('分支2 get_state 无 sessionFile → 计数 noSessionFile + error', async () => {
    await assertPiSessionFile(stateClient(undefined), join(dir, 'x.jsonl'), 'ctx-2')
    expect(attachAssertSkipStats.noSessionFile).toBe(1)
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('no comparable sessionFile'))).toBe(true)
  })

  it('分支3 回报路径不在磁盘 → 计数 fileMissing + error', async () => {
    await assertPiSessionFile(stateClient(join(dir, 'ghost.jsonl')), join(dir, 'x.jsonl'), 'ctx-3')
    expect(attachAssertSkipStats.fileMissing).toBe(1)
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('does not exist on disk'))).toBe(true)
  })

  it('显式测试豁免 → 跳过返回、计数仍走、零 error（豁免意图显式声明而非形状探测）', async () => {
    setAttachAssertExemptionForTest(true)
    const noState = {} as SessionFileAssertClient

    await assertPiSessionFile(noState, join(dir, 'x.jsonl'), 'ctx-4')
    expect(attachAssertSkipStats.noGetState).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('正向对照：路径一致 → 通过，零 error；mismatch → 仍 throw（主防线不变）', async () => {
    const real = join(dir, 'real.jsonl')
    writeFileSync(real, '{"type":"session"}\n', 'utf-8')
    const other = join(dir, 'other.jsonl')
    writeFileSync(other, '{"type":"session"}\n', 'utf-8')

    await assertPiSessionFile(stateClient(real), real, 'ctx-ok')
    expect(errorSpy).not.toHaveBeenCalled()

    await expect(assertPiSessionFile(stateClient(real), other, 'ctx-mismatch')).rejects.toThrow('[attach-mismatch]')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-binding-sidecar-io', () => {
beforeEach(() => {
  dir_m2 = mkdtempSync(join(tmpdir(), 'sidecar-io-rt3-3-'))
  _resetSidecarWarnDedupForTest()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('readBindingSidecar · RT-3#3 读侧分流', () => {
  it('ENOENT（不存在）→ undefined 且零 warn', () => {
    const p = join(dir_m2, 'nonexistent.jsonl.preset.json')
    expect(readBindingSidecar(p, decode)).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('JSON 损坏 → undefined + warn（路径+原因）+ 隔离为 .corrupt- 副本', () => {
    const p = join(dir_m2, 's1.jsonl.preset.json')
    writeFileSync(p, '{not-valid-json', 'utf-8')

    expect(readBindingSidecar(p, decode)).toBeUndefined()

    const warns = warnSpy.mock.calls.map(c => String(c[0]))
    expect(warns.some(m => m.includes('sidecar JSON corrupt') && m.includes(p))).toBe(true)

    // 原文件被 rename 隔离：原位消失，同目录出现 .corrupt-<ts> 取证副本
    expect(existsSync(p)).toBe(false)
    const quarantined = readdirSync(dir_m2).filter(n => n.startsWith('s1.jsonl.preset.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    // 隔离后再读 = ENOENT 路径，安静
    expect(readBindingSidecar(p, decode)).toBeUndefined()
  })

  it('检查不过（presetId 非字符串）→ undefined + warn 一次，不隔离', () => {
    const p = join(dir_m2, 's2.jsonl.preset.json')
    writeFileSync(p, JSON.stringify({ presetId: 123 }), 'utf-8')

    expect(readBindingSidecar(p, decode)).toBeUndefined()
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('shape rejected')).length).toBe(1)
    // 检查不过不隔离：原文件保留（旧形态可被未来版本解读）
    expect(existsSync(p)).toBe(true)

    // warn-once：第二次读同一路径不再重复出声
    expect(readBindingSidecar(p, decode)).toBeUndefined()
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('shape rejected')).length).toBe(1)
  })

  it('读失败（非 ENOENT：EACCES）→ undefined + warn（路径+原因）', () => {
    const p = join(dir_m2, 's3.jsonl.preset.json')
    writeFileSync(p, JSON.stringify({ presetId: 'builtin:full' }), 'utf-8')
    chmodSync(p, 0o000)

    try {
      expect(readBindingSidecar(p, decode)).toBeUndefined()
      const warns = warnSpy.mock.calls.map(c => String(c[0]))
      expect(warns.some(m => m.includes('sidecar read failed') && m.includes(p))).toBe(true)
    } finally {
      chmodSync(p, 0o644)
    }
  })

  it('正常 sidecar → 解码值，零 warn（正向对照）', () => {
    const p = join(dir_m2, 's4.jsonl.preset.json')
    writeFileSync(p, JSON.stringify({ presetId: 'builtin:full', version: 1 }), 'utf-8')
    expect(readBindingSidecar(p, decode)).toBe('builtin:full')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
});
});
