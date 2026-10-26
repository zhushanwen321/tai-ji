/**
 * session-history：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - session-history.test.ts
 *   - session-history-reverse-window.test.ts
 *   - tail-read-history.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/session-history.test.ts
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_BUDGET, OUTBOUND_FRAME_TRUNCATE_BYTES, READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import type { Message } from '@taiji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiHistoryMessage, PiSessionBranchSummaryEntry, PiSessionCompactionEntry, PiSessionCustomMessageEntry, PiSessionEntry, PiSessionMessageEntry } from '../infra/pi/pi-protocol.js'
import { PiSessionStore } from '../infra/pi/session-store.js'
import type { ISessionStore } from '../services/ports/session.js'
import { getHistoryFromFilePath, tailReadHistory } from '../services/session-history.js'


// ════════════════ 来源: session-history.test.ts ════════════════
describe('session-history', () => {
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
  function writeJsonl(entries: PiSessionEntry[], headerLine?: string): string {
    const filePath = join(tmpDir, 'test.jsonl')
    // header 以 raw 行前置（真实 pi 文件形态：首行恒为 session header，有 id 无 parentId——
    // 不剥会与真根 entry 一起把 computeActivePathEntries 单根检查顶成多根降级，U6d 发现的
    // U6a 缺陷）。header 形态不在 PiSessionEntry 联合内，故走 raw 行不进类型化数组。
    const lines = headerLine ? [headerLine, ...entries.map((e) => JSON.stringify(e))] : entries.map((e) => JSON.stringify(e))
    writeFileSync(filePath, lines.join('\n'), 'utf-8')
    return filePath
  }

  /** 真实 pi 文件首行 session header（0.84.4：type='session'，必有 id，无 parentId）。 */
  const HEADER_LINE = JSON.stringify({ type: 'session', id: 'sess-header', cwd: '/tmp', timestamp: '2026-01-01T00:00:00Z' })

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

  // ════════════════════════════════════════════════════════════════════
  // 活跃路径裁剪（message-revoke U6a）：文件源路径（全量文件读 / 离线尾读）
  // ════════════════════════════════════════════════════════════════════
  // 文件路径无 RPC leafId，convertWindowEntries 以窗口/文件末条 entry 为 leafId（pi 树重放
  // 规则：文件尾 = 活跃叶子）；被撤子树按文件序先于 label 锚，经 parentId 回溯滤除。

  describe('活跃路径裁剪（message-revoke U6a 文件源路径）', () => {
    /** 有分支链式 fixture（真实撤回形态）：root → a1 → [m(被撤) → am] / [label(锚) → n]。 */
    function branchedFile(opts: { withHeader?: boolean } = {}): string {
      const label = {
        type: 'label',
        id: 'lbl',
        parentId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        label: 'taiji:revoked',
        targetId: 'm',
      } as PiSessionEntry
      const entries: PiSessionEntry[] = [
        { ...msgEntry('q', 'user', '问题'), parentId: null },
        { ...msgEntry('a1', 'assistant', '回答'), parentId: 'q' },
        { ...msgEntry('m', 'user', '发错的消息'), parentId: 'a1' },
        { ...msgEntry('am', 'assistant', '对发错的回复'), parentId: 'm' },
        label,
        { ...msgEntry('n', 'user', '撤回后新消息'), parentId: 'lbl' },
      ]
      return writeJsonl(entries, opts.withHeader ? HEADER_LINE : undefined)
    }

    it('getHistoryFromFilePath: 有分支文件 → 旧分支（发错的消息及其回复）不渲染', async () => {
      const { messages } = await getHistoryFromFilePath(branchedFile(), realStore)
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
      expect(messages.map((m) => m.piEntryId)).toEqual(['q', 'a1', 'n'])
    })

    it('tailReadHistory: 有分支文件 → 离线尾读窗口同样滤除旧分支条目', async () => {
      const { messages } = await tailReadHistory(branchedFile(), realStore, 20)
      expect(messages.map((m) => m.piEntryId)).toEqual(['q', 'a1', 'n'])
      expect(messages.some((m) => m.piEntryId === 'm' || m.piEntryId === 'am')).toBe(false)
    })

    it('真实文件形态（首行 session header）→ 两条路径裁剪仍生效（header 不顶翻单根检查）', async () => {
      const filePath = branchedFile({ withHeader: true })
      const full = await getHistoryFromFilePath(filePath, realStore)
      expect(full.messages.map((m) => m.piEntryId)).toEqual(['q', 'a1', 'n'])
      const tail = await tailReadHistory(filePath, realStore, 20)
      expect(tail.messages.map((m) => m.piEntryId)).toEqual(['q', 'a1', 'n'])
      expect(tail.messages.some((m) => m.piEntryId === 'm' || m.piEntryId === 'am')).toBe(false)
    })

    it('撤回尾巴 + 未附着尾读：中断判定读活跃路径——被撤子树 user 尾不误标 interrupted', async () => {
      // 撤回最后一条 user 消息后未发新消息：文件尾 = label 锚，被撤子树（m）按文件序先于
      // label。判定喂数为活跃路径裁剪后 entries——从尾向前落在 a1（assistant 终稿）上，
      // 健康会话不被误标（若读裁剪前窗口，label 被跳过后落在被撤 user entry 上 → 误标 true）。
      const label = {
        type: 'label',
        id: 'lbl',
        parentId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        label: 'taiji:revoked',
        targetId: 'm',
      } as PiSessionEntry
      const entries: PiSessionEntry[] = [
        { ...msgEntry('q', 'user', '问题'), parentId: null },
        { ...msgEntry('a1', 'assistant', '回答'), parentId: 'q' },
        { ...msgEntry('m', 'user', '发错的消息'), parentId: 'a1' },
        label,
      ]
      const tail = await tailReadHistory(writeJsonl(entries), realStore, 20)
      expect(tail.messages.map((m) => m.piEntryId)).toEqual(['q', 'a1'])
      expect(tail.interrupted).toBe(false)
    })
  })
});

// ════════════════ 来源: session-history-reverse-window.test.ts ════════════════
describe('session-history-reverse-window', () => {
  /**
   * ①档预检逆序窗口 + ②档尾读分块扩窗测试（u4b-history-budget，crash-resilience §3.3 D5）。
   *
   * 必测断言（impl-plan u4b 验收）：
   * - ⑤ ①档大文件逆序窗口：>32MB fixture（tmpdir 自建自删、真实 JSONL 行形态）→
   *   statSync 预检超 READ_PRECHECK_MAX_BYTES → 逆序分块读返回最近预算窗口 + truncated
   *   标记（不拒绝）；消费方语义：[u6] 游标翻页文件读 / getSubagentHistory 同链路（①档底座）
   * - ⑥ ②档分块扩窗：尾部凑够 20 turns 不触全量（结果只有 20 turns 即为证据——全量读
   *   会返回全部 turns）；凑不够到 32MB 上限返回部分 + truncated
   * - ⑦ 行边界对齐由 history-reverse-read.test.ts 单元覆盖（此处端到端复验）
   *
   * fixture 构造对齐 A11 声明：首行 type:'session' header + 真实 entry 形态拼接 +
   * 尾部 turn 密度（保证「凑 20 turns」路径被真实触发而非 truncated 短路）。
   * 测试框架：vitest；大文件写入 tmpdir（fs-guard 白名单）自建自删。
   * 运行：cd packages/runtime && npx vitest run src/__tests__/session-history-reverse-window.test.ts
   */

  let tmpDir: string
  const realStore: ISessionStore = new PiSessionStore()

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-history-reverse-window-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── fixture 构造（真实 JSONL 行形态，A11 同型）────────────────────

  function headerLine(sessionId: string): string {
    return JSON.stringify({ type: 'session', id: sessionId, cwd: '/proj', timestamp: '2026-01-01T00:00:00Z' })
  }

  function msgLine(id: string, role: 'user' | 'assistant', text: string): string {
    return JSON.stringify({
      type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z',
      message: { role, content: [{ type: 'text', text }], timestamp: 1000 },
    })
  }

  function turnLines(startIdx: number, padBytes = 64): string[] {
    return [
      msgLine(`e${startIdx}`, 'user', `question-${startIdx}`),
      // assistant 行带 padding（真实 entry 的工具输出/回复体量形态）
      msgLine(`e${startIdx + 1}`, 'assistant', `answer-${startIdx}-` + 'x'.repeat(padBytes)),
    ]
  }

  /** 小 session（预算内）：首行 header + n 个 turn。 */
  function writeSmallSession(name: string, turns: number): string {
    const lines = [headerLine('sid-small')]
    for (let i = 0; i < turns; i++) lines.push(...turnLines(i * 2))
    const filePath = join(tmpDir, name)
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  /**
   * 大 session：header + preTurns 个大 turn（每 turn 约 bigPadBytes 字节）+ tailTurns 个
   * 小 turn（尾部密度）。返回 { filePath, fileSize, tailUserIds }。
   */
  function writeBigSession(opts: { sessionId: string; preTurns: number; bigPadBytes: number; tailTurns: number }): {
    filePath: string
    fileSize: number
  } {
    const lines = [headerLine(opts.sessionId)]
    for (let i = 0; i < opts.preTurns; i++) lines.push(...turnLines(i * 2, opts.bigPadBytes))
    const base = opts.preTurns * 2
    for (let i = 0; i < opts.tailTurns; i++) lines.push(...turnLines(base + i * 2, 64))
    const filePath = join(tmpDir, `${opts.sessionId}.jsonl`)
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return { filePath, fileSize: statSync(filePath).size }
  }

  // ════════════════════════════════════════════════════════════════════
  // ①档：getHistoryFromFilePath statSync 预检 + 逆序窗口（断言⑤）
  // ════════════════════════════════════════════════════════════════════

  describe('①档预检回归：<32MB 行为与现状一致', () => {
    it('小文件全量返回、truncated:false', async () => {
      const filePath = writeSmallSession('small-1.jsonl', 5)
      const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)
      expect(truncated).toBe(false)
      expect(messages).toHaveLength(10) // 5 turn × (user + assistant)
      expect(messages[0]).toMatchObject({ role: 'user' })
    })
  })

  describe('①档超预检阈值：逆序窗口（断言⑤）', () => {
    it('>32MB fixture：返回最近 20 turns 预算窗口 + truncated:true（不拒绝）', async () => {
      // 30 个大 turn（各 ~1.2MB，总 ≈ 36MB > 32MB）+ 尾部 25 个小 turn
      const { filePath, fileSize } = writeBigSession({ sessionId: 'big-1', preTurns: 30, bigPadBytes: 1150 * 1024, tailTurns: 25 })
      expect(fileSize).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

      const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)

      // 不拒绝：给出最近预算窗口（尾部 25 个小 turn 中的最近 20 个）
      expect(truncated).toBe(true)
      expect(messages).toHaveLength(20 * 2)
      expect(messages[0]).toMatchObject({ role: 'user' })
      // 窗口是尾部（最新）turn：包含最后一个小 turn，不含头部大 turn 内容
      expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('answer-') })
      for (const m of messages) {
        expect((m.content as string).length).toBeLessThan(2000) // 大 turn 未被读入
      }
    })

    it('>32MB fixture 凑不够 20 turns：读满 32MB 上限返回已凑部分 + truncated', async () => {
      // 6 个 turn 各 ~8MB（总 48MB > 32MB）：读满上限也只有 ~4 个 turn
      const { filePath } = writeBigSession({ sessionId: 'big-2', preTurns: 6, bigPadBytes: 7800 * 1024, tailTurns: 0 })

      const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)

      expect(truncated).toBe(true)
      // 已凑部分：至少 1 个完整 turn（>32MB/8MB），且窗口起点对齐 turn 边界（entry 原子性）
      expect(messages.length).toBeGreaterThanOrEqual(2)
      expect(messages[0]).toMatchObject({ role: 'user' })
      // 读取量受 32MB 上限：未返回全部 6 个 turn
      expect(messages.length).toBeLessThan(12)
    })

    it('>32MB 且尾部 turn 超 MAX_BYTES 字节帽：窗口在 turn 边界受帽截断（首 turn 豁免）+ truncated', async () => {
      // 17 个 turn 各 ~2MB（总 ~34MB > 32MB 触发①档），单 turn ~2MB > 640KB 字节帽：
      // 首 turn 豁免完整入窗，第 2 个 turn 边界处超帽 → 停止。无字节帽时读满 32MB
      // 可凑 ~4 turns（对齐上一用例 big-2 行为）——有帽时仅 1 turn 即为受帽截断的行为证据
      const { filePath, fileSize } = writeBigSession({ sessionId: 'big-cap', preTurns: 17, bigPadBytes: 2048 * 1024, tailTurns: 0 })
      expect(fileSize).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

      // ①档返回形状 HistoryFileReadResult（messages + truncated）
      const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)

      expect(messages).toHaveLength(2) // 首 turn 豁免入窗（1 turn = 2 条），后续超帽不入窗
      expect(messages[0]).toMatchObject({ role: 'user' })
      expect(messages[1]).toMatchObject({ role: 'assistant' })
      // 窗口是尾部（最新）turn，且内容完整未被帽切断（单行字节完整交付）
      expect(String(messages[1].content)).toContain('answer-32')
      expect(truncated).toBe(true)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // ②档：tailReadHistory 分块扩窗（断言⑥）
  // ════════════════════════════════════════════════════════════════════

  describe('②档分块扩窗（断言⑥）', () => {
    it('尾部凑不够 20 turns 触发扩窗：第二块凑够即停（不触全量——全量读会返回 64 条）', async () => {
      // 尾部 12 个小 turn（不足 20）+ 20 个大 turn（各 ~120KB，每 turn 2 行）：
      // 第一块 1MB 只能凑到 ~16 turns → 必须向前扩第二块才凑够（扩窗路径真实触发）
      const { filePath } = writeBigSession({ sessionId: 'expand-1', preTurns: 20, bigPadBytes: 120 * 1024, tailTurns: 12 })

      const { messages, truncated, loadedTurns, totalTurnsEstimate } = await tailReadHistory(filePath, realStore)

      // 「不触全量」的行为证据：全文件 32 turns × 2 = 64 条，窗口只有 20 turns × 2
      expect(messages).toHaveLength(20 * 2)
      expect(truncated).toBe(true)
      expect(loadedTurns).toBe(20)
      // 未读到文件头：totalTurnsEstimate 是诚实下界（= loadedTurns）
      expect(totalTurnsEstimate).toBe(20)
      // 窗口 = 尾部最近 turns（最新 turn 在尾部）
      expect(messages[0]).toMatchObject({ role: 'user' })
      expect(messages.at(-1)).toMatchObject({ role: 'assistant' })
    })

    it('小文件（≤一块）：读到文件头，turn ≤ 20 → truncated:false（现状回归）', async () => {
      const filePath = writeSmallSession('expand-2.jsonl', 5)
      const { messages, truncated, loadedTurns, totalTurnsEstimate } = await tailReadHistory(filePath, realStore)
      expect(truncated).toBe(false)
      expect(loadedTurns).toBe(5)
      expect(totalTurnsEstimate).toBe(5) // 读到头 = 精确总量
      expect(messages).toHaveLength(10)
    })

    it('凑不够 20 turns 到 32MB 上限：返回已凑部分 + truncated + 窗口起点对齐 turn 边界', async () => {
      // 6 个 turn 各 ~8MB（48MB）：32MB 上限内凑不满 20 turns
      const { filePath } = writeBigSession({ sessionId: 'expand-3', preTurns: 6, bigPadBytes: 7800 * 1024, tailTurns: 0 })

      const { messages, truncated } = await tailReadHistory(filePath, realStore)

      expect(truncated).toBe(true)
      expect(messages.length).toBeGreaterThanOrEqual(2)
      expect(messages[0]).toMatchObject({ role: 'user' }) // 残 turn 段被对齐丢弃（entry 原子性）
      expect(messages.length).toBeLessThan(12) // 未凑满 20 turns
    })
  })
});

// ════════════════ 来源: tail-read-history.test.ts ════════════════
describe('tail-read-history', () => {
  /**
   * W1 红灯测试：tailReadHistory 尾读 + turn 边界截断。
   *
   * 对应 FR-3（tailReadHistory）+ AC-5/6/12/13。
   *
   * turn 定义（D11）：user message 到下一个 user message 之前（含其间的 assistant + tool_call + toolResult）。
   * tailReadHistory 从文件尾部倒扫，收集最近 maxTurns=20 个完整 turn，保证 assistant↔toolResult 配对完整。
   *
   * 核心防的 bug：
   * - AC-5：尾读返回的消息里 toolResult 必须能配对到 assistant（不能有孤立 toolResult）
   * - AC-6：文件不存在返回空数组不抛（pi 延迟写入）
   * - AC-12：文件末行损坏（JSON 不完整）不抛（复用 INVAR-tail-3 残行丢弃）
   * - turn 边界：不能截断在 turn 中间（如取到 toolResult 但丢了对应 assistant tool_call）
   *
   * [红灯说明] tailReadHistory 尚未实现，import 会 fail（模块导出不存在）。
   *
   * 运行：cd packages/runtime && npx vitest run test/tail-read-history.test.ts
   */


  /**
   * mock sessionStore：convertHistory 透传 piMessages（不合并 toolResult），
   * 让测试能验证 tailReadHistory 的 turn 边界 + 配对完整性（转换前的原始数据）。
   */
  function makePassthroughStore(): ISessionStore {
    return {
      scanSessions: () => [],
      convertHistory: (piMessages: unknown[]) => piMessages as never,
    } as unknown as ISessionStore
  }

  describe('W1 tailReadHistory 尾读 + turn 边界截断', () => {
    let tmpDir: string
    let store: ISessionStore

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-'))
      store = makePassthroughStore()
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    /** 构造一个 pi JSONL session 文件 */
    function writeSessionFile(lines: string[]): string {
      const filePath = join(tmpDir, 'session.jsonl')
      writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
      return filePath
    }

    /** 造一个 user turn（user message + assistant with tool_call + toolResult） */
    function makeTurn(turnIdx: number): string[] {
      return [
        JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}` } }),
        JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}`, toolCalls: [{ id: `tc-${turnIdx}`, toolName: 'read', input: {} }] } }),
        JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
      ]
    }

    it('AC-5: 加载最近 turn，toolResult 都能配对到 assistant（无孤立 toolResult）', async () => {
      // 造 25 个 turn（超过 maxTurns=20）
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ]
      for (let i = 0; i < 25; i++) {
        lines.push(...makeTurn(i))
      }
      const filePath = writeSessionFile(lines)

      const { messages } = await tailReadHistory(filePath, store, 20)

      // 应加载最近 20 turn（每个 turn 3 条 message = 60 条）
      expect(messages.length).toBe(60)

      // AC-5 核心：每条 toolResult 都能配对到 assistant
      const assistantToolCallIds = new Set<string>()
      for (const msg of messages) {
        const m = msg as { role?: string; toolCalls?: { id: string }[] }
        if (m.role === 'assistant' && m.toolCalls) {
          for (const tc of m.toolCalls) assistantToolCallIds.add(tc.id)
        }
      }
      for (const msg of messages) {
        const m = msg as { role?: string; toolCallId?: string }
        if (m.role === 'toolResult') {
          expect(assistantToolCallIds.has(m.toolCallId!)).toBe(true)
        }
      }
    })

    it('AC-5 边界：加载的 turn 数不超过 maxTurns', async () => {
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ]
      for (let i = 0; i < 30; i++) {
        lines.push(...makeTurn(i))
      }
      const filePath = writeSessionFile(lines)

      const { messages: messages5 } = await tailReadHistory(filePath, store, 5)
      // 5 turn × 3 message = 15 条（不含 session header）
      expect(messages5.length).toBeLessThanOrEqual(15)
    })

    it('N1: truncated 标志——文件 turn 数 > maxTurns 时 truncated=true', async () => {
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ]
      for (let i = 0; i < 25; i++) {
        lines.push(...makeTurn(i))
      }
      const filePath = writeSessionFile(lines)

      // 25 turn 文件取 20 turn → truncated=true
      const result20 = await tailReadHistory(filePath, store, 20)
      expect(result20.truncated).toBe(true)

      // 25 turn 文件取 30 turn（> 文件总量）→ truncated=false
      const result30 = await tailReadHistory(filePath, store, 30)
      expect(result30.truncated).toBe(false)
    })

    it('AC-6: 文件不存在返回空数组不抛', async () => {
      const noExist = join(tmpDir, 'never-exists.jsonl')
      await expect(tailReadHistory(noExist, store, 20)).resolves.toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    })

    it('AC-12: 文件末行损坏（JSON 不完整）不抛异常', async () => {
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
        ...makeTurn(0),
      ]
      // 末行追加一个损坏的 JSON 片段（被切断）
      const filePath = join(tmpDir, 'session.jsonl')
      writeFileSync(filePath, lines.join('\n') + '\n' + '{"type":"message","id":"broken","message":{', 'utf-8')

      const { messages } = await tailReadHistory(filePath, store, 20)
      // 损坏行被跳过，正常 turn 的消息仍加载
      expect(messages.length).toBeGreaterThan(0)
    })

    it('turn 边界对齐：不截断在 turn 中间（取到 toolResult 不丢 assistant）', async () => {
      // 构造 22 个 turn，验证尾部第一个 turn 的 assistant 也被加载（不只有 toolResult）
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ]
      for (let i = 0; i < 22; i++) {
        lines.push(...makeTurn(i))
      }
      const filePath = writeSessionFile(lines)

      const { messages } = await tailReadHistory(filePath, store, 20)
      // 验证 turn 2（第 3 个 turn，索引从 0 计：0..21，取尾部 2..21）的 assistant 在结果里
      const hasTurn2Assistant = messages.some(
        (m) => (m as { role?: string; content?: string }).role === 'assistant' && (m as { content?: string }).content === 'assistant-2',
      )
      expect(hasTurn2Assistant).toBe(true)
      // turn 1（被截掉的）的 assistant 不应在结果里
      const hasTurn1Assistant = messages.some(
        (m) => (m as { role?: string; content?: string }).role === 'assistant' && (m as { content?: string }).content === 'assistant-1',
      )
      expect(hasTurn1Assistant).toBe(false)
    })

    it('小文件（< 20 turn）加载全部', async () => {
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
        ...makeTurn(0),
        ...makeTurn(1),
      ]
      const filePath = writeSessionFile(lines)

      const { messages } = await tailReadHistory(filePath, store, 20)
      // 2 turn × 3 message = 6 条
      expect(messages.length).toBe(6)
    })

    it('compaction/custom_message entry 也被保留（AGENTS.md 关键规则 9 可重开恢复）', async () => {
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'compaction', summary: '压缩摘要', tokensBefore: 10000, timestamp: '2025-01-01T00:00:01Z' }),
        JSON.stringify({ type: 'custom_message', customType: 'subagent-bg-notify', content: '通知内容', timestamp: '2025-01-01T00:00:02Z' }),
        ...makeTurn(0),
      ]
      const filePath = writeSessionFile(lines)

      const { messages } = await tailReadHistory(filePath, store, 20)
      // compaction + custom_message + 1 turn(3条) = 5 条
      expect(messages.length).toBe(5)
      const types = messages.map((m) => (m as { role?: string }).role)
      expect(types).toContain('compactionSummary')
      expect(types).toContain('custom')
    })

    it('W-Runtime2: 大文件（fileSize > TAIL_WINDOW）尾窗口含足够 turn 时 truncated=true（didFullRead=false 保守判定）', async () => {
      // maxTurns=20 → TAIL_WINDOW = max(256KB, 20*32KB) = 640KB。要触发尾读-only 路径（不走 fallback 全量读），
      // 需 fileSize > 640KB 且尾窗口（640KB）内 >= 20 个 turn（否则会 fallback 全量读 → didFullRead=true）。
      // 构造：25 个 turn，每个 turn 用大 payload 撑大文件（user content 塞 ~30KB 文本），
      // 总大小 ≈ 25 * 30KB = 750KB > 640KB。尾 640KB 窗口含尾部约 21 turn > 20 → 不 fallback。
      const padding = 'x'.repeat(30 * 1024) // 30KB padding per user message
      const lines: string[] = [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ]
      for (let i = 0; i < 25; i++) {
        // 自定义 turn：user message 带 padding（撑大文件），后跟 assistant + toolResult
        lines.push(
          JSON.stringify({ type: 'message', id: `u-${i}`, message: { role: 'user', content: `user-${i}-${padding}` } }),
          JSON.stringify({ type: 'message', id: `a-${i}`, message: { role: 'assistant', content: `assistant-${i}`, toolCalls: [{ id: `tc-${i}`, toolName: 'read', input: {} }] } }),
          JSON.stringify({ type: 'message', id: `tr-${i}`, message: { role: 'toolResult', toolCallId: `tc-${i}`, content: `result-${i}` } }),
        )
      }
      const filePath = writeSessionFile(lines)

      const result = await tailReadHistory(filePath, store, 20)
      // W-Runtime2 核心：尾窗口只读了文件尾部（didFullRead=false），窗口外 turn 数未知，
      // 即使尾窗口内 turn 数 >= maxTurns 也保守认定 truncated=true（宁可多显示「加载更多」也别漏）。
      expect(result.truncated).toBe(true)
      // 尾窗口含足够 turn，应加载 maxTurns 个 turn（每个 3 条 = 60 条）
      expect(result.messages.length).toBe(60)
    })
  })

  /**
   * 离线尾读字节预算 + truncated 精确判定（crash-resilience §3.3 D4 / A6 一致性审查修复）。
   *
   * 修复的两个缺陷：
   * 1. 离线尾读缺字节预算：doGetHistory 离线 fallback 原样透传 query（maxBytes=undefined）
   *    → 仅按 turn 数截取，20 个大 turn（合计 >32MB）的 session.history reply 被
   *    payload_too_large 拒绝且 truncated 未置位（「加载更早」入口不存在）——历史打不开。
   *    修复后离线路径传 maxBytes 缺省 HISTORY_BUDGET.MAX_BYTES（与游标分支同源），且
   *    collectRecentTurnEntriesFromTail 的预算语义与活跃路径 applyHistoryBudgetWindow
   *    对齐：首个 turn 豁免、后续 turn 超界不入窗（窗口总字节 ≤ 预算）。
   * 2. 恰好 maxTurns turns 的文件 truncated 误报：原实现凑够 turn 数即停 → stopped=true →
   *    truncated=true，而文件实无更早历史（A6 要求无截断提示）。修复后凑够 turn 数只停止
   *    收集，继续向前确认是否真有更早 turn 边界：扫到文件头仍无 → false；发现边界或
   *    32MB 上限截停无法确认 → true。
   */
  describe('D4 离线尾读字节预算 + A6 truncated 精确判定', () => {
    let tmpDir: string
    let store: ISessionStore

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-budget-'))
      store = makePassthroughStore()
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    function writeSessionFile(lines: string[]): string {
      const filePath = join(tmpDir, 'session-budget.jsonl')
      writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
      return filePath
    }

    /** 与上方 W1 describe 同款的小 turn（3 行：user + assistant(tool_call) + toolResult） */
    function makeTurn(turnIdx: number): string[] {
      return [
        JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}` } }),
        JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}`, toolCalls: [{ id: `tc-${turnIdx}`, toolName: 'read', input: {} }] } }),
        JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
      ]
    }

    /** 带 padding 的 turn（user message 塞大 payload 撑体积，assistant + toolResult 同 makeTurn 形态） */
    function makePaddedTurn(turnIdx: number, padding: string): string[] {
      return [
        JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}-${padding}` } }),
        JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}` } }),
        JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
      ]
    }

    function makeHeader(): string {
      return JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' })
    }

    function responseBytes(messages: unknown[]): number {
      return messages.reduce<number>((sum, m) => sum + Buffer.byteLength(JSON.stringify(m), 'utf-8'), 0)
    }

    it('D4: 20 个大 turn（fixture 合计 >32MB）→ truncated=true 且窗口字节 ≤ 预算+首 turn 豁免（远低于 32MB，非 payload_too_large）', async () => {
      // 每个 turn ≈ 1.7MB（user content padding 主导），20 turn 合计 ≈ 34MB > 32MB 出站帧截断档：
      // 无字节预算时整个文件会被收集进 reply → payload_too_large 拒绝且 truncated 未置位。
      const padding = 'x'.repeat(1700 * 1024)
      const lines: string[] = [makeHeader()]
      for (let i = 0; i < 20; i++) lines.push(...makePaddedTurn(i, padding))
      const filePath = writeSessionFile(lines)

      const result = await tailReadHistory(filePath, store, HISTORY_BUDGET.RECENT_TURNS, { maxBytes: HISTORY_BUDGET.MAX_BYTES })

      // 首 turn（最新）超预算仍完整放行（首 turn 豁免），预算在其后的 turn 边界处停止
      expect(result.truncated).toBe(true)
      expect(result.loadedTurns).toBe(1)
      // 窗口字节 ≤ 预算 + 首 turn 原始行体积（mapper 重建的 message 不新增大字段，同量级）
      const firstTurnRawBytes = lines.slice(1, 4).reduce((s, l) => s + Buffer.byteLength(l, 'utf-8') + 1, 0)
      const totalBytes = responseBytes(result.messages)
      expect(totalBytes).toBeLessThanOrEqual(HISTORY_BUDGET.MAX_BYTES + firstTurnRawBytes)
      // 非 payload_too_large：窗口 reply 远低于 32MB 出站帧截断档（未修复时 ≈34MB 必然越限）
      expect(totalBytes).toBeLessThan(OUTBOUND_FRAME_TRUNCATE_BYTES)
    })

    it('D4 语义对齐: 超界 turn 不入窗（与活跃路径 applyHistoryBudgetWindow 一致，窗口总字节 ≤ 预算）', async () => {
      // 6 turns × ~200KB，maxBytes=640KB：最近 3 turns（~600KB）入窗后，第 4 新的 turn
      // 会使累计超预算 → 不入窗（回退该 turn 行）。旧实现会把超界 turn 完整放行（窗口
      // ~800KB > 预算），与活跃路径「accBytes + turnBytes > maxBytes 即截取」不一致。
      const padding = 'x'.repeat(200 * 1024)
      const lines: string[] = [makeHeader()]
      for (let i = 0; i < 6; i++) lines.push(...makePaddedTurn(i, padding))
      const filePath = writeSessionFile(lines)

      const result = await tailReadHistory(filePath, store, HISTORY_BUDGET.RECENT_TURNS, { maxBytes: HISTORY_BUDGET.MAX_BYTES })

      expect(result.truncated).toBe(true)
      expect(result.loadedTurns).toBe(3)
      expect(responseBytes(result.messages)).toBeLessThanOrEqual(HISTORY_BUDGET.MAX_BYTES)
    })

    it('D4 回退后窗口完整性：窗口首消息为 user（turn 边界）且 entry parentId 链前驱在窗内可追溯', async () => {
      // 与「D4 语义对齐」同款预算场景（6 turns × ~200KB，640KB 预算在第 4 新 turn 边界
      // 超界 → 回退该 turn）：fixture 额外带真实 pi 文件形态的 id/parentId 线性链
      // （每条 entry 的 parentId = 前一条 entry 的 id），验证回退的 turn 原子性——
      // 窗口是链的连续段（无中途截断），链上断点只允许出现在窗口首 entry（其父在窗外）。
      const padding = 'x'.repeat(200 * 1024)
      const lines: string[] = [makeHeader()]
      const parentById = new Map<string, string | null>()
      let prevId: string | null = null
      for (let i = 0; i < 6; i++) {
        const turnDefs: Array<{ id: string; role: string; content: string }> = [
          { id: `u-${i}`, role: 'user', content: `user-${i}-${padding}` },
          { id: `a-${i}`, role: 'assistant', content: `assistant-${i}` },
          { id: `tr-${i}`, role: 'toolResult', content: `result-${i}` },
        ]
        for (const def of turnDefs) {
          parentById.set(def.id, prevId)
          prevId = def.id
          lines.push(
            JSON.stringify({
              type: 'message',
              id: def.id,
              parentId: parentById.get(def.id),
              timestamp: '2025-01-01T00:00:00Z',
              message: { role: def.role, content: def.content },
            }),
          )
        }
      }
      const filePath = writeSessionFile(lines)

      // store 桩捕获 mapper 产出的平行 entryIds（message 体不带 entry 身份，链断言经此透出）
      const seenEntryIds: string[][] = []
      const capturingStore: ISessionStore = {
        scanSessions: () => [],
        convertHistory: (piMessages: unknown[], entryIds?: string[]) => {
          seenEntryIds.push(entryIds ? [...entryIds] : [])
          return piMessages as never
        },
      } as unknown as ISessionStore

      const result = await tailReadHistory(filePath, capturingStore, HISTORY_BUDGET.RECENT_TURNS, {
        maxBytes: HISTORY_BUDGET.MAX_BYTES,
      })

      // budget 停止回退已发生（回退第 4 新 turn，窗口 = 最近 3 turns）
      expect(result.truncated).toBe(true)
      expect(result.loadedTurns).toBe(3)
      // 断言 1：窗口首消息为 user（turn 边界）——回退不切在 turn 中间
      expect((result.messages[0] as { role?: string }).role).toBe('user')
      // 断言 2：parentId 链前驱可追溯——除窗口首 entry（其父在窗外）外，每条 entry 的
      // parentId 恰为窗口内前一条 entry 的 id（链段连续，turn 原子性未被回退破坏）
      const windowIds = seenEntryIds[seenEntryIds.length - 1]!
      expect(windowIds).toHaveLength(result.messages.length)
      expect(windowIds[0]).toBe('u-3')
      for (let i = 1; i < windowIds.length; i++) {
        expect(parentById.get(windowIds[i]!)).toBe(windowIds[i - 1])
      }
    })

    it('A6: 恰好 20 turns 的小文件 → truncated=false（实无更早历史，不误报「加载更早」）', async () => {
      const lines: string[] = [makeHeader()]
      for (let i = 0; i < 20; i++) lines.push(...makeTurn(i))
      const filePath = writeSessionFile(lines)

      const result = await tailReadHistory(filePath, store, 20)

      // 修复前：凑够 20 turns 即停 → stopped=true → truncated=true（误报）
      // 修复后：停止收集后继续确认扫描，扫到文件头无更早 turn 边界 → false
      expect(result.truncated).toBe(false)
      expect(result.messages.length).toBe(60)
      expect(result.totalTurnsEstimate).toBe(20)
    })

    it('A6: 40 turns 文件取 20 → truncated=true（确认扫描发现更早 turn 边界）', async () => {
      const lines: string[] = [makeHeader()]
      for (let i = 0; i < 40; i++) lines.push(...makeTurn(i))
      const filePath = writeSessionFile(lines)

      const result = await tailReadHistory(filePath, store, 20)

      expect(result.truncated).toBe(true)
      expect(result.messages.length).toBe(60)
    })
  })
});
