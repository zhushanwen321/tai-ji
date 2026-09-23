/**
 * usage-stats-service 容错分支回归（U2b，设计 §3.3 D3 / §2.3）：
 *
 * 1. 单文件级失败（input 流 error / 读取中断）→ 空分片降级、聚合不抛、
 *    (mtimeMs, size) 键保留（下次同 mtime/size 不重读）；
 * 2. rl 层 input 流 error 不逃逸（rl.on('error') 吞转发 + iterator rejection
 *    双保险，对应 R4 路径在 usage 场景的回归锁）；
 * 3. 行级内容损坏（JSON.parse 失败）→ 该行计入 skippedLines，其余行正常聚合。
 *
 * 测试目标全部 mkdtempSync 自建自删（fs-guard 红线，不触碰真实数据目录）。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 createReadStream 先留底：部分 mock 只需替换单次调用，其余保持真实实现
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const realCreateReadStream = actualFs.createReadStream

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

import { createReadStream } from 'node:fs'
import { UsageStatsService } from '../../../services/usage/usage-stats-service.js'

const mockedCreateReadStream = vi.mocked(createReadStream)

let tmpDir: string | null = null

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'usage-stats-fault-tol-'))
  return tmpDir
}

afterEach(() => {
  mockedCreateReadStream.mockReset()
  mockedCreateReadStream.mockImplementation(realCreateReadStream)
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpDir = null
  }
})

/** 一行有效的 assistant-with-usage entry（命中分类①）。 */
function assistantLine(input = 10): string {
  return JSON.stringify({
    type: 'message',
    timestamp: '2026-09-04T10:00:00.000Z',
    message: {
      role: 'assistant',
      provider: 'test-provider',
      responseModel: 'test-model',
      usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
  })
}

/** 故障 input 流工厂：可注入"读取中途"数据 + error 的 Readable。 */
function makeFaultyInputStream(): Readable {
  const stream = new Readable({ read() {} })
  stream.setEncoding('utf-8')
  return stream
}

describe('UsageStatsService 流级容错（设计 §3.3 D3）', () => {
  it('input 流中途 error：聚合不抛、该文件降级空分片、(mtimeMs,size) 键保留且下次不重读', async () => {
    const dir = makeTmpDir()
    const filePath = join(dir, 'session-a.jsonl')
    // 文件内容本身有效（含一条命中行）——失败由注入的故障流制造，而非内容
    writeFileSync(filePath, assistantLine(100) + '\n', 'utf-8')

    const faultyInput = makeFaultyInputStream()
    mockedCreateReadStream.mockImplementationOnce(() => faultyInput as ReturnType<typeof createReadStream>)

    const service = new UsageStatsService(dir)
    const promise = service.getStats()

    // 等 createInterface 已挂上 input 流后再注入数据与 error（保证走"读取中途"路径）
    await vi.waitFor(() => expect(mockedCreateReadStream).toHaveBeenCalledTimes(1))
    faultyInput.push(assistantLine(100) + '\n')
    faultyInput.emit('error', new Error('injected mid-read stream failure'))

    // 断言①：error 不逃逸，聚合正常收尾（R4 路径回归锁）
    const first = await promise

    // 断言②：该文件降级为空分片——已吐出的有效行也被丢弃，skippedLines 归零
    // （空分片语义：rows=[] / skippedLines=0，见 scanFile catch 分支）
    expect(first.rows).toEqual([])
    expect(first.skippedLines).toBe(0)
    expect(first.sessionCount).toBe(1)
    // RT-8#12：读流失败的文件计入 failedFiles——聚合偏低显形（「不含 N 个会话文件」），
    // 与「该 session 无用量」区分
    expect(first.failedFiles).toBe(1)

    // 断言③：分片键保留——文件未变更（mtime/size 不变）时第二次 getStats 直接复用
    // 空分片，不再触发 createReadStream（不重读语义，按实现注释断言）
    const second = await service.getStats()
    expect(mockedCreateReadStream).toHaveBeenCalledTimes(1)
    expect(second.rows).toEqual([])
    expect(second.skippedLines).toBe(0)
    expect(second.sessionCount).toBe(1)
    // 失败分片被 (mtime,size) 缓存：文件未变更期间重扫仍计入 failedFiles
    expect(second.failedFiles).toBe(1)
  })

  it('多文件场景：单个文件流失败不打断聚合，其余文件正常计入', async () => {
    const dir = makeTmpDir()
    writeFileSync(join(dir, 'good.jsonl'), assistantLine(30) + '\n', 'utf-8')
    writeFileSync(join(dir, 'bad.jsonl'), assistantLine(999) + '\n', 'utf-8')

    // 仅 bad.jsonl 的流注入故障；good.jsonl 走真实 createReadStream。
    // readdir 顺序不定，坏文件可能先读——error 注入用 setImmediate 延迟到
    // createInterface 已同步挂好监听之后，避免依赖读取顺序
    const faultyInput = makeFaultyInputStream()
    mockedCreateReadStream.mockImplementationOnce((path, options?: Parameters<typeof realCreateReadStream>[1]) => {
      if (!String(path).endsWith('bad.jsonl')) {
        return realCreateReadStream(path, options) as ReturnType<typeof createReadStream>
      }
      setImmediate(() => {
        faultyInput.push(assistantLine(999) + '\n')
        faultyInput.emit('error', new Error('injected bad-file failure'))
      })
      return faultyInput as ReturnType<typeof createReadStream>
    })

    const service = new UsageStatsService(dir)
    const result = await service.getStats()
    // 聚合不抛：两个 session 都计入，坏文件行丢失、好文件行保留
    expect(result.sessionCount).toBe(2)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ provider: 'test-provider', input: 30 })
    expect(result.skippedLines).toBe(0)
    // RT-8#12：仅坏文件进 failedFiles（好文件不误计）
    expect(result.failedFiles).toBe(1)
  })

  it('行级内容损坏：JSON 解析失败行计入 skippedLines，不降级整文件', async () => {
    const dir = makeTmpDir()
    writeFileSync(
      join(dir, 'corrupt.jsonl'),
      [assistantLine(7), '{not valid json', '', 'also not json'].join('\n') + '\n',
      'utf-8',
    )

    const service = new UsageStatsService(dir)
    const result = await service.getStats()

    // 损坏行行级降级（skippedLines），有效行正常聚合，文件不整体降级
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ input: 7 })
    expect(result.skippedLines).toBe(2)
    expect(result.sessionCount).toBe(1)
  })
})
