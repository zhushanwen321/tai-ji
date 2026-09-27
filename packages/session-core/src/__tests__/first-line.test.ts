import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readFirstJsonlLine, readFirstJsonlLineSync } from '../first-line.js'

// close 失败注入开关（vi.hoisted：vi.mock 工厂提升后仍可引用）。形态对齐
// runtime import-service.test.ts 的 copyFile 失败注入——单次翻转，其余透传 actual。
const closeFailureState = vi.hoisted(() => ({ failNext: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fh = await actual.open(...args)
      if (!closeFailureState.failNext) return fh
      closeFailureState.failNext = false
      // 包装句柄：read 委托真实句柄，close 先真实关闭（防 fd 泄漏）再抛错（EBADF 形态）
      const failingClose = {
        read: fh.read.bind(fh),
        close: async () => {
          await fh.close()
          throw new Error('EBADF: bad file descriptor, close')
        },
      } as unknown as FileHandle
      return failingClose
    },
  }
})

const dirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(osTmpdir(), 'session-core-first-line-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  closeFailureState.failNext = false
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

  it('async 形态 close 失败不掩成功读取（finally 吞 close 错误，对齐 sync best-effort 语义）', async () => {
    const dir = makeTmpDir()
    const file = join(dir, 'close-fail.jsonl')
    writeFileSync(file, '{"type":"session","id":"s1"}\n{"type":"message"}\n', 'utf8')

    closeFailureState.failNext = true
    await expect(readFirstJsonlLine(file)).resolves.toBe('{"type":"session","id":"s1"}')
  })
})
