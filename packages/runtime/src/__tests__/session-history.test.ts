/**
 * session-history 文件路径接入测试（converter M3）。
 *
 * 覆盖 design.json TC1-TC3：
 * - TC1：文件路径换 mapper 后历史含 compaction/branch/custom_message（与 RPC 路径一致，关键规则 9）
 * - TC2：port 签名 convertHistory(raw, entryIds?) 透传（MF5）
 * - TC3：删 __entryId 后 fork 定位（piEntryId 从平行 entryIds）
 *
 * 测试框架：vitest（从 vitest 导入），运行：npx vitest run，禁止 node:test。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getHistoryFromFilePath, tailReadHistory } from '../services/session-history.js'
import { PiSessionStore } from '../infra/pi/session-store.js'
import type { Message } from '@taiji/shared'
import type { ISessionStore } from '../services/ports/session.js'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCompactionEntry,
  PiSessionBranchSummaryEntry,
  PiSessionCustomMessageEntry,
  PiHistoryMessage,
} from '../infra/pi/pi-protocol.js'

// ── factories（复用 mapper 测试的 entry 构造风格）──────────────────

function msgEntry(id: string, role: 'user' | 'assistant' = 'user', text = `msg-${id}`): PiSessionMessageEntry {
  const historyMsg: PiHistoryMessage = {
    role,
    content: [{ type: 'text', text }],
    timestamp: 1000,
  }
  return { type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', message: historyMsg }
}

function compactionEntry(id: string, summary = `compact-${id}`, tokensBefore = 5000): PiSessionCompactionEntry {
  return { type: 'compaction', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', summary, firstKeptEntryId: 'k1', tokensBefore }
}

function branchSummaryEntry(id: string, fromId = 'f1', summary = `branch-${id}`): PiSessionBranchSummaryEntry {
  return { type: 'branch_summary', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', fromId, summary }
}

function customMessageEntry(
  id: string,
  customType: string,
  opts: { content?: string; display?: boolean; details?: Record<string, unknown> } = {},
): PiSessionCustomMessageEntry {
  return {
    type: 'custom_message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    customType,
    content: opts.content ?? `content-${id}`,
    ...(opts.display !== undefined && { display: opts.display }),
    ...(opts.details !== undefined && { details: opts.details }),
  }
}

// ── 临时 JSONL 文件管理 ────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-history-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 把 entries 序列化成 JSONL 文件，返回文件路径。 */
function writeJsonl(entries: PiSessionEntry[]): string {
  const filePath = join(tmpDir, 'test.jsonl')
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf-8')
  return filePath
}

// 真实 PiSessionStore（convertHistory → convertPiHistory，端到端验证 mapper + converter）
const realStore: ISessionStore = new PiSessionStore()

// ════════════════════════════════════════════════════════════════════
// TC1：文件路径换 mapper 后含 compaction/branch/custom_message
// ════════════════════════════════════════════════════════════════════
// 背景：M3 把 getHistoryFromFilePath/tailReadHistory 的「放行四类 + 伪消息映射」
// 整体替换为共享 mapSessionEntries。换 mapper 前后这三类记录都该还原（关键规则 9），
// 本组验证 mapper 接入后行为不回归，且与 RPC 路径（rebuildHistoryFromEntries）一致。

describe('TC1 文件路径换 mapper 后含 compaction/branch/custom_message', () => {
  it('getHistoryFromFilePath: 三类记录都还原为 system 消息（与 RPC 路径一致，关键规则 9）', async () => {
    const filePath = writeJsonl([
      msgEntry('e1', 'user', '问题'),
      compactionEntry('e2', '上下文已压缩', 8000),
      branchSummaryEntry('e3', 'msg-old', '分支摘要'),
      customMessageEntry('e4', 'subagent-bg-notify', { content: '完成' }),
      msgEntry('e5', 'assistant', '回答'),
    ])

    const { messages } = await getHistoryFromFilePath(filePath, realStore)

    // user + system(compaction) + system(branch) + system(custom) + assistant
    expect(messages).toHaveLength(5)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'system', 'system', 'assistant'])
    expect(messages[1].compactionSummary).toMatchObject({ summary: '上下文已压缩', tokensBefore: 8000 })
    expect(messages[2].branchSummary).toMatchObject({ summary: '分支摘要', fromId: 'msg-old' })
    expect(messages[3].customType).toBe('subagent-bg-notify')
    // 完成通知类 custom_message display 覆写 false（方案 Z，shared COMPLETE_NOTIFY_CUSTOM_TYPES SSOT）
    expect(messages[3].display).toBe(false)
  })

  it('tailReadHistory: 窗口内三类记录还原（窗口筛选在前，mapper 处理筛后 entry 集，CQ1）', async () => {
    const filePath = writeJsonl([
      msgEntry('t1-e1', 'user', 'turn1 问题'),
      compactionEntry('t1-e2', '压缩1', 1000),
      msgEntry('t2-e1', 'user', 'turn2 问题'),
      branchSummaryEntry('t2-e2', 'fromX', '分支2'),
      customMessageEntry('t2-e3', 'subagent-bg-notify', { content: '通知' }),
    ])

    const { messages, truncated } = await tailReadHistory(filePath, realStore, 20)

    // convertPiHistory: user + system(compaction) + user + system(branch) + system(custom)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'user', 'system', 'system'])
    expect(messages[1].compactionSummary).toBeDefined()
    expect(messages[3].branchSummary).toBeDefined()
    expect(messages[4].customType).toBe('subagent-bg-notify')
    // 文件小（全量读），turn 数 2 <= maxTurns 20 → truncated false
    expect(truncated).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// TC2：port 签名 convertHistory(raw, entryIds?) 透传（MF5）
// ════════════════════════════════════════════════════════════════════

describe('TC2 port convertHistory(raw, entryIds?) 透传', () => {
  it('getHistoryFromFilePath: convertHistory 收到平行 entryIds（第二参数，MF5）', async () => {
    // vi.fn 带参数类型签名，使 mock.calls[0] 解构能正确推断 [raw, entryIds]
    const convertHistory = vi.fn<(raw: unknown[], entryIds?: string[]) => Message[]>(() => [])
    const mockStore = { convertHistory } as unknown as ISessionStore

    const filePath = writeJsonl([
      msgEntry('e1', 'user', '问题'),
      compactionEntry('e2', '压缩', 100),
      msgEntry('e3', 'assistant', '回复'),
    ])

    await getHistoryFromFilePath(filePath, mockStore)

    expect(convertHistory).toHaveBeenCalledTimes(1)
    const [raw, entryIds] = convertHistory.mock.calls[0]!
    // raw 是伪消息数组（user + compactionSummary + assistant，mapSessionEntries 产出）
    expect(raw).toHaveLength(3)
    expect((raw[0] as { role: string }).role).toBe('user')
    expect((raw[1] as { role: string }).role).toBe('compactionSummary')
    expect((raw[2] as { role: string }).role).toBe('assistant')
    // ★ entryIds 与 raw 平行对齐（mapSessionEntries 产出，含伪消息位置的 entry id）
    expect(entryIds).toEqual(['e1', 'e2', 'e3'])
  })

  it('tailReadHistory: convertHistory 收到窗口内 entry 的平行 entryIds', async () => {
    const convertHistory = vi.fn<(raw: unknown[], entryIds?: string[]) => Message[]>(() => [])
    const mockStore = { convertHistory } as unknown as ISessionStore

    const filePath = writeJsonl([
      msgEntry('e1', 'user', '问题'),
      compactionEntry('e2', '压缩', 100),
    ])

    await tailReadHistory(filePath, mockStore, 20)

    expect(convertHistory).toHaveBeenCalledTimes(1)
    const [raw, entryIds] = convertHistory.mock.calls[0]!
    expect(raw).toHaveLength(2)
    expect(entryIds).toEqual(['e1', 'e2'])
  })
})

// ════════════════════════════════════════════════════════════════════
// TC3：删 __entryId 后 fork 定位（piEntryId 从平行 entryIds）
// ════════════════════════════════════════════════════════════════════

describe('TC3 删 __entryId 后 fork 定位', () => {
  it('user/assistant piEntryId 从平行 entryIds 填充（不依赖 __entryId，M3）', async () => {
    const filePath = writeJsonl([
      msgEntry('fork-e1', 'user', '第一句'),
      compactionEntry('fork-e2', '压缩', 100),
      msgEntry('fork-e3', 'assistant', '回复'),
    ])

    const { messages } = await getHistoryFromFilePath(filePath, realStore)

    // user + system(compaction) + assistant
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    // ★ user/assistant piEntryId 从平行 entryIds 取（fork 定位截断点用）
    expect(messages[0].piEntryId).toBe('fork-e1')
    expect(messages[2].piEntryId).toBe('fork-e3')
    // 伪消息（compaction system 消息）无 piEntryId（convertPiHistory 只给 user/assistant 填）
    expect(messages[1].piEntryId).toBeUndefined()
  })

  it('message 体不再含 __entryId 字段（M3 删注入，改平行 entryIds 通道）', async () => {
    const convertHistory = vi.fn<(raw: unknown[], entryIds?: string[]) => Message[]>(() => [])
    const mockStore = { convertHistory } as unknown as ISessionStore

    const filePath = writeJsonl([msgEntry('e1', 'user', '问题')])

    await getHistoryFromFilePath(filePath, mockStore)

    const [raw] = convertHistory.mock.calls[0]!
    const userMsg = raw[0] as Record<string, unknown>
    // ★ message 体透传，不含 __entryId（M3 删注入；message-converter __entryId 回退保留作防御但不产生）
    expect('__entryId' in userMsg).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// 边界用例：文件不存在 / 非 object entry 过滤（防回归）
// ════════════════════════════════════════════════════════════════════

describe('边界用例', () => {
  it('getHistoryFromFilePath: 文件不存在返回空数组（规则 #6 pi 延迟写入）', async () => {
    const { messages } = await getHistoryFromFilePath(join(tmpDir, 'nonexistent.jsonl'), realStore)
    expect(messages).toEqual([])
  })

  it('getHistoryFromFilePath: 非 object entry（裸数字/字符串）被过滤，不抛错', async () => {
    // 手写 JSONL：含非 object 行（裸数字、字符串）+ 正常 entry
    const filePath = join(tmpDir, 'mixed.jsonl')
    const lines = [
      JSON.stringify(msgEntry('e1', 'user', '正常')),
      '12345', // 裸数字（parseJsonl 成功，但非 object）
      '"a string"', // 裸字符串
      JSON.stringify(msgEntry('e2', 'assistant', '回复')),
    ]
    writeFileSync(filePath, lines.join('\n'), 'utf-8')

    const { messages } = await getHistoryFromFilePath(filePath, realStore)
    // 非 object 被 filterObjectEntries 过滤，只处理 2 个 message entry
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('tailReadHistory: 文件不存在返回空数组 + truncated false', async () => {
    const { messages, truncated } = await tailReadHistory(join(tmpDir, 'nonexistent.jsonl'), realStore)
    expect(messages).toEqual([])
    expect(truncated).toBe(false)
  })

  it('tailReadHistory: statSync 非 ENOENT 失败（EACCES）原样上抛，不压成空页（RT-5#4）', async () => {
    // EACCES 被压成 emptyPage 会把「读不了」伪装成「历史为空」假成功——与
    // getHistoryFromFilePath 的 statSync 预检分级对齐：仅 ENOENT 返空页。
    // 真实权限构造（chmod 000 去目录 search 权限 → statSync 抛 EACCES），非 mock
    const lockedDir = join(tmpDir, 'locked')
    mkdirSync(lockedDir)
    const target = join(lockedDir, 'session.jsonl')
    writeFileSync(target, `${JSON.stringify(msgEntry('e1', 'user', 'x'))}\n`, 'utf-8')
    chmodSync(lockedDir, 0o000)
    try {
      await expect(tailReadHistory(target, realStore)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(lockedDir, 0o700) // 恢复权限，afterEach 的 tmpDir 清理才可行
    }
  })

  it('tailReadHistory: 空文件返回空数组 + truncated false', async () => {
    const filePath = join(tmpDir, 'empty.jsonl')
    writeFileSync(filePath, '', 'utf-8')

    const { messages, truncated } = await tailReadHistory(filePath, realStore)
    expect(messages).toEqual([])
    expect(truncated).toBe(false)
  })
})
