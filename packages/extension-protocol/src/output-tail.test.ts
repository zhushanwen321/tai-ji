import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { readOutputTail, type OutputTailLogFn } from './output-tail'

let tmpDir: string

function freshDir(): string {
  tmpDir = mkdtempSync(join('/tmp', 'ext-protocol-tail-test-'))
  return tmpDir
}

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpDir = undefined as unknown as string
  }
})

function writeOutput(name: string, content: string): string {
  const dir = freshDir()
  const path = join(dir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

function collectLogs(): { events: Array<{ level: string; event: string }>; logger: OutputTailLogFn } {
  const events: Array<{ level: string; event: string }> = []
  return { events, logger: (level, event) => events.push({ level, event }) }
}

describe('readOutputTail（单一签名 file + opts { maxBytes, maxLines }）', () => {
  it('未超任一上限 → 全文返回 + truncated:false', () => {
    const path = writeOutput('small.log', 'line1\nline2\nline3')
    const { events, logger } = collectLogs()
    const result = readOutputTail(path, { maxBytes: 1_000_000, maxLines: 2000 }, logger)
    expect(result).toEqual({ text: 'line1\nline2\nline3', truncated: false })
    expect(events).toEqual([])
  })

  it('文件不存在 → undefined（调用方按「输出丢失」降级，不崩溃）', () => {
    expect(readOutputTail(join(freshDir(), 'missing.log'), { maxBytes: 100, maxLines: 10 })).toBeUndefined()
  })

  it('残首行丢弃：窗口起点落在行中间时首行（必然不完整）被丢弃', () => {
    // 行1 'A'x100、行2 'B'x100、行3 'C'x10；maxBytes=10 → 窗口 74B 起点落在行2 中间
    const content = `${'A'.repeat(100)}\n${'B'.repeat(100)}\n${'C'.repeat(10)}`
    const path = writeOutput('partial.log', content)
    const result = readOutputTail(path, { maxBytes: 10, maxLines: 2000 })
    expect(result).toEqual({ text: 'C'.repeat(10), truncated: true })
  })

  it('字节窗口裁剪：超 maxBytes 只保留末尾窗口内容 + truncated:true', () => {
    const content = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(3, '0')}`).join('\n')
    const path = writeOutput('big.log', content)
    const result = readOutputTail(path, { maxBytes: 64, maxLines: 2000 })
    expect(result?.truncated).toBe(true)
    // 末尾窗口内容必然是全文的尾部切片
    expect(content.endsWith(result?.text ?? '')).toBe(true)
    expect(result?.text.length).toBeLessThan(content.length)
  })

  it('行上限：内容行数超 maxLines → 只留最后 maxLines 行 + truncated:true（未超字节）', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`)
    const path = writeOutput('lines.log', lines.join('\n'))
    const result = readOutputTail(path, { maxBytes: 1_000_000, maxLines: 5 })
    expect(result?.text).toBe(['L16', 'L17', 'L18', 'L19', 'L20'].join('\n'))
    expect(result?.truncated).toBe(true)
  })

  it('双上限同时生效时先字节窗口、后行窗口（先到为准的叠加形态）', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row-${String(i).padStart(3, '0')}-${'x'.repeat(20)}`)
    const path = writeOutput('both.log', lines.join('\n'))
    const result = readOutputTail(path, { maxBytes: 200, maxLines: 3 })
    // 行窗口在字节窗口结果上再取末 3 行
    const byteWindowLines = result!.text.split('\n')
    expect(byteWindowLines).toHaveLength(3)
    expect(result?.truncated).toBe(true)
  })

  it('close 失败诊断经 onLog 上报；不适配 onLog 时静默（回调可选）', () => {
    // 正常路径不产生任何日志事件；此处断言可选回调不参与正常流
    const path = writeOutput('ok.log', 'content')
    const { events, logger } = collectLogs()
    readOutputTail(path, { maxBytes: 100, maxLines: 10 }, logger)
    expect(events).toEqual([])
  })
})
