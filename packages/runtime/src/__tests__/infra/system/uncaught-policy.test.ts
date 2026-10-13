/**
 * uncaughtException 分级策略单测（2026-09-04 整机崩溃事故护栏）。
 *
 * 行为契约：
 * - SAFE_STREAM_ERROR_CODES 内的错误码（流/IO 唯一来源）→ isContainedStreamError true
 *   → index.ts handler log-continue，不整机 shutdown
 * - 逻辑级异常（TypeError / 无 code / 业务错误码）→ false → 维持 graceful shutdown 语义
 * - appendProcessEscapeLog（逃逸取证落盘）：零格式化（禁触 stack）、message 首行截断、
 *   appendFileSync 直写、任何输入不抛
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  appendProcessEscapeLog,
  isContainedStreamError,
  SAFE_STREAM_ERROR_CODES,
} from '../../../infra/system/uncaught-policy.js'

function codedError(code: string | undefined, message = 'boom'): Error {
  const err = new Error(message)
  if (code !== undefined) (err as NodeJS.ErrnoException).code = code
  return err
}

describe('uncaught-policy：uncaughtException 连接级噪声分级', () => {
  it('流级错误码全部判定为 contained（log-continue）', () => {
    for (const code of SAFE_STREAM_ERROR_CODES) {
      expect(isContainedStreamError(codedError(code))).toBe(true)
    }
  })

  it('真实事故形态：EPIPE + "This socket has been ended by the other party" 文案', () => {
    // 2026-09-04 事故堆栈原始形态（writeAfterFIN 包装出的 genericNodeError）。
    // 事故形态锚定用例：被测函数不读 message，断言与上一用例的 EPIPE 分支判然等价，
    // 无独立判别力——保留价值是锚定真实报文形态，防未来改判定时误删事故场景。
    const err = codedError('EPIPE', 'This socket has been ended by the other party')
    expect(isContainedStreamError(err)).toBe(true)
  })

  it('逻辑级异常不 contained（维持 shutdown 语义）', () => {
    expect(isContainedStreamError(new TypeError('Cannot read properties of undefined'))).toBe(false)
    expect(isContainedStreamError(codedError(undefined))).toBe(false)
    // 业务/未知错误码：不因「看着像系统码」而误豁免
    expect(isContainedStreamError(codedError('ERR_INVALID_ARG_TYPE'))).toBe(false)
    expect(isContainedStreamError(codedError('ENOENT'))).toBe(false)
  })

  it('非 Error 值（字符串/undefined/对象）不 contained，不抛', () => {
    expect(isContainedStreamError('EPIPE')).toBe(false)
    expect(isContainedStreamError(undefined)).toBe(false)
    expect(isContainedStreamError({ code: 'EPIPE' })).toBe(false)
  })
})

// ── 逃逸取证落盘（appendProcessEscapeLog）──────────────────────────────
//
// 写入目标全部 mkdtempSync 自建自删（测试红线：禁触碰真实数据目录）。
const escapeTmp = mkdtempSync(join(tmpdir(), 'uncaught-escape-log-test-'))
afterAll(() => rmSync(escapeTmp, { recursive: true, force: true, maxRetries: 10 }))

/** 固定时刻（文件名日期与时间戳的双重确定性来源）。 */
const FIXED_NOW = new Date('2026-10-11T08:09:10.123Z')
const escapeLogFile = (logsDir: string): string =>
  join(logsDir, 'runtime-uncaught-2026-10-11.log')

describe('uncaught-policy：appendProcessEscapeLog 逃逸取证落盘', () => {
  it('Error 落 name + message 首行，格式零余量（时间戳 + kind + name: message）', () => {
    const dir = join(escapeTmp, 'a')
    appendProcessEscapeLog(dir, 'uncaught-exception', new TypeError('boom'), FIXED_NOW)
    expect(readFileSync(escapeLogFile(dir), 'utf8')).toBe(
      '[2026-10-11T08:09:10.123Z] [uncaught-exception] TypeError: boom\n',
    )
  })

  it('logsDir 不存在时自建（递归 mkdir），取证不因目录缺失而丢', () => {
    const dir = join(escapeTmp, 'nested', 'b', 'logs')
    appendProcessEscapeLog(dir, 'unhandled-rejection', new Error('rejected'), FIXED_NOW)
    expect(readFileSync(escapeLogFile(dir), 'utf8')).toBe(
      '[2026-10-11T08:09:10.123Z] [unhandled-rejection] Error: rejected\n',
    )
  })

  it('message 超过 200 字符截断到首 200', () => {
    const dir = join(escapeTmp, 'c')
    appendProcessEscapeLog(dir, 'uncaught-exception', new Error('x'.repeat(500)), FIXED_NOW)
    const line = readFileSync(escapeLogFile(dir), 'utf8')
    expect(line).toBe(`[2026-10-11T08:09:10.123Z] [uncaught-exception] Error: ${'x'.repeat(200)}\n`)
  })

  it('多行 message 只取首行（CRLF 也拦在首行内）', () => {
    const dir = join(escapeTmp, 'd')
    appendProcessEscapeLog(dir, 'uncaught-exception', new Error('first\r\nsecond\nthird'), FIXED_NOW)
    expect(readFileSync(escapeLogFile(dir), 'utf8')).toBe(
      '[2026-10-11T08:09:10.123Z] [uncaught-exception] Error: first\n',
    )
  })

  it('零格式化铁律：stack getter 抛异常也不触发、不向上抛，取证行照常落盘', () => {
    const dir = join(escapeTmp, 'e')
    const err = new Error('hot message')
    let stackTouched = false
    Object.defineProperty(err, 'stack', {
      get() {
        stackTouched = true
        throw new Error('formatting the deep stack is the storm hotpoint')
      },
    })
    expect(() => appendProcessEscapeLog(dir, 'uncaught-exception', err, FIXED_NOW)).not.toThrow()
    expect(stackTouched).toBe(false)
    expect(readFileSync(escapeLogFile(dir), 'utf8')).toBe(
      '[2026-10-11T08:09:10.123Z] [uncaught-exception] Error: hot message\n',
    )
  })

  it('非 Error 逃逸值（string/undefined/对象）落 typeof 标注 + String 化内容，不抛', () => {
    const dir = join(escapeTmp, 'f')
    appendProcessEscapeLog(dir, 'unhandled-rejection', 'plain string reason', FIXED_NOW)
    appendProcessEscapeLog(dir, 'unhandled-rejection', undefined, FIXED_NOW)
    appendProcessEscapeLog(dir, 'unhandled-rejection', { custom: true }, FIXED_NOW)
    const lines = readFileSync(escapeLogFile(dir), 'utf8').split('\n').filter((l) => l !== '')
    expect(lines).toEqual([
      '[2026-10-11T08:09:10.123Z] [unhandled-rejection] <string>: plain string reason',
      '[2026-10-11T08:09:10.123Z] [unhandled-rejection] <undefined>: undefined',
      '[2026-10-11T08:09:10.123Z] [unhandled-rejection] <object>: [object Object]',
    ])
  })

  it('append 语义：风暴循环的每次进入各留一行（行数即风暴频率证据）', () => {
    const dir = join(escapeTmp, 'g')
    appendProcessEscapeLog(dir, 'uncaught-exception', new Error('storm 1'), FIXED_NOW)
    appendProcessEscapeLog(dir, 'uncaught-exception', new Error('storm 2'), FIXED_NOW)
    const content = readFileSync(escapeLogFile(dir), 'utf8')
    expect(content.split('\n').filter((l) => l !== '')).toHaveLength(2)
  })

  it('写入失败（logsDir 指向普通文件之下，ENOTDIR）静默吞，不上抛', () => {
    const fileAsDir = join(escapeTmp, 'h-file')
    writeFileSync(fileAsDir, '')
    expect(() =>
      appendProcessEscapeLog(join(fileAsDir, 'logs'), 'uncaught-exception', new Error('y'), FIXED_NOW),
    ).not.toThrow()
  })
})
