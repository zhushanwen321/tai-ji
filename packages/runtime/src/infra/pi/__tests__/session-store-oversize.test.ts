/**
 * D5④ readSessionJsonlText oversize 标记测试（u4c-read-paths，crash-resilience §3.3 D5④）。
 *
 * 必测断言（impl-plan u4c 验收）：
 * - 超阈值文件返回 oversize 标记（**非 null**，含实际字节数与阈值——「文件过大」不与
 *   「文件缺失」混淆）
 * - 文件缺失仍返回 null（既有契约回归——pi 延迟写入窗口的空态判定依据）
 * - 阈值内文件返回全文文本（行为不变）
 *
 * fixture：mkdtempSync 自建自删；oversize 用 ftruncateSync 稀疏文件（预检只 statSync
 * 不读内容，size 即语义，瞬时完成）。
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-store-oversize.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import { PiSessionStore } from '../session-store.js'

let tmpDir: string
let store: PiSessionStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-store-oversize-'))
  store = new PiSessionStore()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

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
