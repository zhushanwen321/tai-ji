/**
 * D5③ findLastEntryField 逆序分块读测试（u4c-read-paths，crash-resilience §3.3 D5③）。
 *
 * 必测断言（impl-plan u4c 验收）：
 * - 大文件（>READ_PRECHECK_MAX_BYTES）目标在尾部附近：命中即止，读取字节数远小于文件大小
 *   （不触全量——经 vi.mock 包装 forEachReversedLineChunk 统计 summary.totalBytesRead）
 * - 大文件目标在逆序窗口（阈值上限）之外：返回 null（全量 fallback 已删除——设计接受的
 *   读取量降级，消费方 outcome=null 的既有降级语义承接）
 * - 小文件（>32KB 尾窗但 ≤ 阈值）行为不变：仍走全量 fallback 命中，且不触发逆序扫
 * - 文件不存在：返回 null 不抛（INVAR-tail-7 回归）
 *
 * fixture：mkdtempSync 自建自删（fs-guard 白名单 tmpdir）；大文件用 1MB 级合法 JSON 行拼接。
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-file-utils-find-last-entry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
// vi.hoisted 承载 mock 记录（vi.mock factory 被 hoist，不能引用未初始化的外部 let）
const { reverseReads } = vi.hoisted(() => ({ reverseReads: [] as { totalBytesRead: number }[] }))

// 包装真实现（行为不变）+ 记录每次逆序扫的读取字节数——「不触全量」的机械断言锚点。
// 历史注释：之所以不 spy node:fs.readSync（ESM 内置模块 spy 不可靠），改在共享工具模块
// 边界包装：findLastEntryField 是逆序扫在 session-file-utils 的唯一入口。
vi.mock('../../../utils/history-reverse-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/history-reverse-read.js')>()
  return {
    ...actual,
    forEachReversedLineChunk: (
      filePath: string,
      options: Parameters<typeof actual.forEachReversedLineChunk>[1],
      visit: Parameters<typeof actual.forEachReversedLineChunk>[2],
    ) => {
      const summary = actual.forEachReversedLineChunk(filePath, options, visit)
      reverseReads.push({ totalBytesRead: summary.totalBytesRead })
      return summary
    },
  }
})

import { extractSessionOutcome } from '../session-file-utils.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'find-last-entry-'))
  reverseReads.length = 0
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function write(name: string, content: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, Buffer.from(content, 'utf-8'))
  return filePath
}

/** ~1MB 的合法 assistant entry 行（padding：撑体积 + 保证 JSONL 形态真实）。 */
function bigPaddingLine(id: number): string {
  return JSON.stringify({ type: 'assistant', id: `pad-${id}`, parentId: `pad-${id - 1}`, message: { content: 'x'.repeat(1024 * 1024) } })
}

function sessionEndLine(outcome = 'done'): string {
  return JSON.stringify({ type: 'session_end', outcome })
}

function headerLine(): string {
  return JSON.stringify({ type: 'session', id: 's-fix', cwd: '/tmp', timestamp: '2026-09-09T00:00:00.000Z' })
}

describe('D5③ 大文件：逆序分块扫命中即止（全量读 fallback 已删除）', () => {
  it('36MB 文件 session_end 在尾部附近（>32KB 尾窗外）→ 命中 done，读取量 ≪ 文件大小', () => {
    // 布局：header + 34 条 1MB padding（撑过 32MB 阈值）+ session_end + 100KB tail-pad
    // + 尾行——session_end 距文件尾 >32KB，readTailEntries 尾读不命中，必须走预检+逆序扫
    const lines = [headerLine()]
    for (let i = 0; i < 34; i++) lines.push(bigPaddingLine(i))
    lines.push(sessionEndLine('done'))
    lines.push(JSON.stringify({ type: 'assistant', id: 'tail-pad', parentId: 'pad-33', message: { content: 'y'.repeat(100 * 1024) } }))
    lines.push(JSON.stringify({ type: 'assistant', id: 'tail-last', parentId: 'tail-pad', message: { content: 'end' } }))
    const filePath = write('big-tail-hit.jsonl', lines.join('\n') + '\n')

    const size = statSync(filePath).size
    expect(size).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

    const outcome = extractSessionOutcome(filePath)

    expect(outcome).toBe('done')
    // 命中即止：恰好一次逆序扫，读取量 ~首块（1MB）量级，远小于 36MB 文件
    expect(reverseReads).toHaveLength(1)
    expect(reverseReads[0].totalBytesRead).toBeLessThan(2 * 1024 * 1024)
    expect(reverseReads[0].totalBytesRead).toBeLessThan(size / 10)
  })

  it('大文件 session_end 在文件头（逆序窗口 32MB 之外）→ 返回 null（读取量被阈值截停，无全量读）', () => {
    // 原实现此场景 fallback 全量读会命中——D5③ 刻意删除：读取量降级由消费方
    // outcome=null（idle）承接，换取退出收尾路径的内存安全（设计已接受代价）
    const lines = [headerLine(), sessionEndLine('error')]
    for (let i = 0; i < 35; i++) lines.push(bigPaddingLine(i))
    const filePath = write('big-head-only.jsonl', lines.join('\n') + '\n')

    const outcome = extractSessionOutcome(filePath)

    expect(outcome).toBeNull()
    expect(reverseReads).toHaveLength(1)
    // 逆序扫被 maxTotalBytes=READ_PRECHECK_MAX_BYTES 硬帽截停
    expect(reverseReads[0].totalBytesRead).toBeLessThanOrEqual(READ_PRECHECK_MAX_BYTES)
  })
})

describe('D5③ 小文件路径行为不变', () => {
  it('≤阈值且 >32KB 尾窗：session_end 在头部 → 仍走全量 fallback 命中（不触发逆序扫）', () => {
    // session_end 距尾 >32KB（尾读未命中）但文件 ≤32MB（预检放行）——原 fallback 路径
    // 必须原样保留（INVAR-tail-2 SR1：目标可能在文件头部）
    const lines = [headerLine(), sessionEndLine('stopped')]
    lines.push(JSON.stringify({ type: 'assistant', id: 'pad', parentId: 's-fix', message: { content: 'z'.repeat(100 * 1024) } }))
    const filePath = write('small-head-hit.jsonl', lines.join('\n') + '\n')

    const outcome = extractSessionOutcome(filePath)

    expect(outcome).toBe('stopped')
    expect(reverseReads).toHaveLength(0) // 未走逆序扫（小文件走原全量 fallback）
  })

  it('文件不存在 → null 不抛（INVAR-tail-7 回归）', () => {
    const outcome = extractSessionOutcome(join(tmpDir, 'nope.jsonl'))
    expect(outcome).toBeNull()
    expect(reverseReads).toHaveLength(0) // statSync 失败即短路，不进逆序扫
  })
})
