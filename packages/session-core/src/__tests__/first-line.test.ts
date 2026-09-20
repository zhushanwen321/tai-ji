import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readFirstJsonlLine, readFirstJsonlLineSync } from '../first-line.js'

const dirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-core-first-line-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** 双形态同步断言：同一 fixture 下 sync 与 async 结果必须一致。 */
async function expectBothForms(file: string, expected: string | undefined): Promise<void> {
  expect(readFirstJsonlLineSync(file)).toBe(expected)
  await expect(readFirstJsonlLine(file)).resolves.toBe(expected)
}

describe('readFirstJsonlLine（sync + async 双形态）', () => {
  it('LF 结尾首行：只返回第一行原文', async () => {
    const dir = makeTmpDir()
    const file = join(dir, 'a.jsonl')
    writeFileSync(file, '{"type":"session","id":"s1"}\n{"type":"message"}\n', 'utf8')

    await expectBothForms(file, '{"type":"session","id":"s1"}')
  })

  it('CRLF 结尾首行：剥行尾 \\r', async () => {
    const dir = makeTmpDir()
    const file = join(dir, 'crlf.jsonl')
    writeFileSync(file, '{"type":"session","id":"s1"}\r\n{"type":"message"}\n', 'utf8')

    await expectBothForms(file, '{"type":"session","id":"s1"}')
  })

  it('空文件返回 undefined；纯空白首行（空格/CR/LF）返回 undefined', async () => {
    const dir = makeTmpDir()
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '', 'utf8')
    const blank = join(dir, 'blank.jsonl')
    writeFileSync(blank, '   \r\n', 'utf8')

    await expectBothForms(empty, undefined)
    await expectBothForms(blank, undefined)
  })

  it('无换行单行文件：整文件即首行', async () => {
    const dir = makeTmpDir()
    const file = join(dir, 'single.jsonl')
    writeFileSync(file, '{"type":"session","id":"only"}', 'utf8')

    await expectBothForms(file, '{"type":"session","id":"only"}')
  })

  it('超长首行（>8KB 跨块续读）完整返回，首行后内容不混入', async () => {
    const dir = makeTmpDir()
    const file = join(dir, 'long.jsonl')
    // 首行 ~20KB（跨 3 个 8KB 块），内嵌 CJK 保证跨块多字节字符不解码拆字
    const longHeader = JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp/中文路径-' + 'x'.repeat(20480) })
    writeFileSync(file, `${longHeader}\n{"type":"message","id":"second"}\n`, 'utf8')

    await expectBothForms(file, longHeader)
  })

  it('文件不存在：sync 抛原生错误、async rejects（ENOENT 分类不伪装）', async () => {
    const dir = makeTmpDir()
    const missing = join(dir, 'missing.jsonl')

    expect(() => readFirstJsonlLineSync(missing)).toThrowError()
    await expect(readFirstJsonlLine(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
