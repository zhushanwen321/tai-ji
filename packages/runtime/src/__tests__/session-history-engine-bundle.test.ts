import { encodeCwd } from '../infra/pi/pi-paths.js';
import { PiSessionBranchSummaryEntry, PiSessionCompactionEntry, PiSessionCustomMessageEntry, PiSessionEntry, PiSessionMessageEntry, type PiHistoryMessage } from '../infra/pi/pi-protocol.js';
import { BINDING_FIELDS } from '../infra/pi/session-binding-fields.js';
import { _resetSessionMetaCacheForTest, _resetSidecarWarnDedupForTest, agentSidecarPath, extractHandedOff, extractHandedOff as extractHandedOffInfra, extractSessionOutcome, invalidateScanDirCache, parseSessionHeader, persistAgentBinding, persistHandoffSidecar as persistHandoffInfra, readAgentBinding, readSessionEndMeta, scanPiSessions, type ScannedSessionMeta as ScannedSessionMetaInfra } from '../infra/pi/session-file-utils.js';
import { PiSessionStore } from '../infra/pi/session-store.js';
import type { IMessageBroker } from '../interfaces.js';
import { MessageBus } from '../services/message-bus/message-bus.js';
import type { IConfigStore } from '../services/ports/config.js';
import type { IGitInfoReader } from '../services/ports/git-info.js';
import type { IProcessManager, IPiEngine } from '../services/ports/pi-engine.js';
import { ScannedSessionMeta as ScannedSessionMetaPort, type ISessionStore } from '../services/ports/session.js';
import { getHistoryFromFilePath, tailReadHistory } from '../services/session-history.js';
import { BtwError } from '../services/session/btw-service.js';
import { EventInterpreter } from '../services/session/event-interpreter.js';
import { createForkedSessionFile } from '../services/session/session-fork.js';
import { ISessionRegisterDeps, type ILifecycleSessionOps, type IScannerSessionOps } from '../services/session/session-internal.js';
import type { SessionLifecycle } from '../services/session/session-lifecycle.js';
import { SessionRecords, setSessionConfigLockTimingForTest } from '../services/session/session-records.js';
import { createSessionRenamedHandler } from '../services/session/session-rename-fanout.js';
import { SessionScanner } from '../services/session/session-scanner.js';
import { SessionService } from '../services/session/session-service.js';
import type { WorkspaceService } from '../services/workspace/workspace-service.js';
import { SessionMessageHandler } from '../transport/session-message-handler.js';
import { HISTORY_BUDGET, OUTBOUND_FRAME_TRUNCATE_BYTES, READ_PRECHECK_MAX_BYTES, type SessionSummary, type ClientMessage, type Message, type ServerMessage } from '@taiji/shared';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← session-history-bundle.test.ts
// ======================================================================

// ======================================================================
// ← src/__tests__/session-file-utils-sidecar.test.ts
// ======================================================================

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}


// ======================================================================
// ← src/__tests__/session-rename-fanout.test.ts
// ======================================================================

/** 组合根注入形态的 deps 桩（sessionService.setLabelCache / getSessionCwd / server.broadcastSessionList）。 */
function makeDeps(cwd = '/tmp/proj-x') {
  return {
    setLabelCache: vi.fn(),
    getSessionCwd: vi.fn((): string | undefined => cwd),
    broadcastSessionList: vi.fn(),
  }
}


// ======================================================================
// ← src/__tests__/session-scanner-sidebar-set.test.ts
// ======================================================================

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeSessionFile(sessionsDir: string, sub: string, id: string, cwd: string): string {
  const subDir = join(sessionsDir, sub)
  mkdirSync(subDir, { recursive: true })
  const filePath = join(subDir, `${id}.jsonl`)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}


// ======================================================================
// ← src/__tests__/session-scanner-source.test.ts
// ======================================================================

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeSessionFile_m2(sessionsDir: string, sub: string, id: string, cwd: string): string {
  const subDir = join(sessionsDir, sub)
  mkdirSync(subDir, { recursive: true })
  const filePath = join(subDir, `${id}.jsonl`)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-19T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}


// ======================================================================
// ← src/__tests__/session-message-handler-subscribe.test.ts
// ======================================================================

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string }[]
}


interface MakeHandlerOpts {  // oe-exempt:20261027:test:
  messageBus?: MessageBus | undefined
}


function makeHandler(opts: MakeHandlerOpts = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      cap.errors.push({ id, code, message })
    }),
    sessionService: { ensureActive: vi.fn().mockResolvedValue(undefined) },
    messageBus: opts.messageBus,
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { cap, handler }
}


function msg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


function pushMsg(type: string, payload: Record<string, unknown>): ServerMessage {
  return { type, payload } as ServerMessage
}


// ws 需满足 BusClient 契约（subscribe 会把 handler 收到的 ws 注册为订阅者）。
const WS = { readyState: 1, send: vi.fn() } as never

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-history-bundle', () => {
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/session-history.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-history', () => {
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
  // [round6 慢用例治理] 删除推迟 afterAll：每例 mkdtempSync 独占目录（隔离不变；
  // 用例内 chmod 0o700 恢复权限的约定同样满足——afterAll 删除晚于用例体）。
  const histTestDirs: string[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-history-test-'))
    histTestDirs.push(tmpDir)
  })

  afterAll(() => {
    for (const d of histTestDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
  // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
  const revWindowDirs: string[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-history-reverse-window-'))
    revWindowDirs.push(tmpDir)
  })

  afterAll(() => {
    for (const d of revWindowDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const tailReadDirs: string[] = []

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-'))
      tailReadDirs.push(tmpDir)
      store = makePassthroughStore()
    })

    afterAll(() => {
      for (const d of tailReadDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const tailBudgetDirs: string[] = []

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-budget-'))
      tailBudgetDirs.push(tmpDir)
      store = makePassthroughStore()
    })

    afterAll(() => {
      for (const d of tailBudgetDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-file-utils-sidecar', () => {
describe('persistAgentBinding', () => {
  it('A3: 规则 #6 检查——session JSONL 不存在时不创建 sidecar', () => {
    const dir = makeTmpDir('u7-a3-')
    try {
      const nonExistentFile = join(dir, 'nonexistent.jsonl')
      // 确保文件确实不存在
      expect(existsSync(nonExistentFile)).toBe(false)

      // 记录 sidecar 目录下的文件数量（应为 0）
      const sidecarPath = agentSidecarPath(nonExistentFile)
      const sidecarDir = join(dir, 'sidecar-check')
      mkdirSync(sidecarDir, { recursive: true })
      const filesBefore = existsSync(sidecarPath) ? 1 : 0

      // 调用 persistAgentBinding，文件不存在应静默跳过
      persistAgentBinding(nonExistentFile, 'agent', 'parent-123')

      // 验证 sidecar 未被创建
      const filesAfter = existsSync(sidecarPath) ? 1 : 0
      expect(filesAfter).toBe(filesBefore)
      expect(existsSync(sidecarPath)).toBe(false)

      // 验证 sidecar 目录下没有新增文件（确保没有创建其他文件）
      const { readdirSync } = require('node:fs')
      const sidecarFiles = readdirSync(dir).filter((f: string) => f.includes('.agent.json'))
      expect(sidecarFiles.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A1-positive: 文件存在时 sidecar 被正确创建且 readAgentBinding 回读一致（正向对照）', () => {
    const dir = makeTmpDir('u7-a1-pos-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 确保 sidecar 不存在
      const sidecarPath = agentSidecarPath(fp)
      expect(existsSync(sidecarPath)).toBe(false)

      // 调用 persistAgentBinding，文件存在应创建 sidecar
      persistAgentBinding(fp, 'agent', 'parent-123')

      // 验证 sidecar 被创建
      expect(existsSync(sidecarPath)).toBe(true)

      // 验证 sidecar 内容
      const { readFileSync } = require('node:fs')
      const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
      expect(data.spawnSource).toBe('agent')
      expect(data.parentAgentSessionId).toBe('parent-123')
      expect(data.version).toBe(1)

      // readAgentBinding 回读验证
      const result = readAgentBinding(fp)
      expect(result).toBeDefined()
      expect(result!.spawnSource).toBe('agent')
      expect(result!.parentAgentSessionId).toBe('parent-123')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('A3b: 缓存失效集成', () => {
  it('A2: scanSessionMeta 合并 agent binding——persistAgentBinding 写入后 sessionMetaCache 失效，scanPiSessions({ force: false }) 能立即读到 binding', () => {
    const dir = makeTmpDir('u7-a3b-')
    try {
      // 设置临时数据目录
      const origDataDir = process.env.TAIJI_AGENT_DATA_DIR
      process.env.TAIJI_AGENT_DATA_DIR = dir

      // 重置缓存
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()

      // 创建 session 文件
      const sessionsDir = join(dir, 'agent', 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 先扫描一次，填充缓存
      let sessions = scanPiSessions({ force: true })
      expect(sessions.length).toBe(1)
      expect(sessions[0].spawnSource).toBeUndefined()

      // 写入 agent binding
      persistAgentBinding(fp, 'agent', 'parent-123')

      // 再次扫描（force:false 走正常缓存路径），应该能读到 binding（缓存已失效）
      sessions = scanPiSessions({ force: false })
      expect(sessions.length).toBe(1)
      expect(sessions[0].spawnSource).toBe('agent')
      expect(sessions[0].parentAgentSessionId).toBe('parent-123')

      // 恢复环境变量
      if (origDataDir !== undefined) {
        process.env.TAIJI_AGENT_DATA_DIR = origDataDir
      } else {
        delete process.env.TAIJI_AGENT_DATA_DIR
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('readAgentBinding', () => {
  it('A4 case1: sidecar 不存在返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-1-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 无 sidecar 文件
      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A4 case2: JSON 损坏返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-2-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入损坏的 JSON
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, 'not valid json {{{')

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A4 case3: spawnSource 非法返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-3-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入 spawnSource 非字符串的 sidecar
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, JSON.stringify({ spawnSource: 123, parentAgentSessionId: 'parent-123', version: 1 }))

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A4 case4: parentAgentSessionId 非法 → 仅该字段 undefined，spawnSource 保留（#15 语义）', () => {
    const dir = makeTmpDir('u7-a4-4-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入 parentAgentSessionId 非字符串的 sidecar
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, JSON.stringify({ spawnSource: 'agent', parentAgentSessionId: null, version: 1 }))

      const result = readAgentBinding(fp)
      expect(result?.spawnSource).toBe('agent')
      expect(result?.parentAgentSessionId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
// ── RT-3#3 读侧显形：sidecar 存在但内容非法 JSON → warn 一次 + 降级兜底 ──

describe('sidecar 损坏 warn 分支（RT-3#3 非 ENOENT 出声）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let dir: string

  beforeEach(() => {
    _resetSidecarWarnDedupForTest()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeTmpDir('rt3-warn-')
  })
  afterEach(() => {
    warnSpy.mockRestore()
    _resetSidecarWarnDedupForTest()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function writeSessionWithMalformedSidecar(fp: string, sidecarPath: string): void {
    writeFileSync(fp, [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp', timestamp: '2026-01-01' }),
      JSON.stringify({ type: 'session_end', outcome: 'stopped', timestamp: '2026-01-02' }),
      JSON.stringify({ type: 'handoff_marker', handedOffTo: 'legacy-target', timestamp: '2026-01-03' }),
    ].join('\n') + '\n')
    writeFileSync(sidecarPath, 'not valid json {{{')
  }

  it('readSessionEndMeta：meta sidecar 非法 JSON → warn 一次（reason 含 sidecar 路径），返回 null', () => {
    const fp = join(dir, 's1.jsonl')
    const sidecarPath = fp + '.meta.json'
    writeSessionWithMalformedSidecar(fp, sidecarPath)

    expect(readSessionEndMeta(fp)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('meta sidecar read/parse failed')
    expect(msg).toContain(sidecarPath)
  })

  it('extractSessionOutcome：meta sidecar 非法 JSON → warn 一次 + 走 JSONL 兜底取回终态', () => {
    const fp = join(dir, 's2.jsonl')
    const sidecarPath = fp + '.meta.json'
    writeSessionWithMalformedSidecar(fp, sidecarPath)

    expect(extractSessionOutcome(fp)).toBe('stopped')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('meta sidecar read failed, falling back to JSONL')
    expect(msg).toContain(sidecarPath)
  })

  it('extractHandedOff：handoff sidecar 非法 JSON → warn 一次 + 走 JSONL 尾读兜底取回交接目标', () => {
    const fp = join(dir, 's3.jsonl')
    const sidecarPath = fp + '.handoff.json'
    writeSessionWithMalformedSidecar(fp, sidecarPath)

    expect(extractHandedOff(fp)).toBe('legacy-target')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('handoff sidecar read failed, falling back to tail read')
    expect(msg).toContain(sidecarPath)
  })

  it('ENOENT（sidecar 从未写入）→ 保持安静不 warn（正常态不出声）', () => {
    const fp = join(dir, 's4.jsonl')
    writeFileSync(fp, JSON.stringify({ type: 'session', id: 's4', cwd: '/tmp', timestamp: '2026-01-01' }) + '\n')

    expect(extractSessionOutcome(fp)).toBeNull()
    expect(extractHandedOff(fp)).toBeUndefined()
    expect(readSessionEndMeta(fp)).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
// ── Model binding sidecar 测试 ─────────────────────────────────

describe('M1: BINDING_FIELDS 矩阵检查', () => {
  it('modelId 四列 = create:options / handoff:options / restore:none / fork:options', () => {
    expect(BINDING_FIELDS.modelId.entries.create).toBe('options')
    expect(BINDING_FIELDS.modelId.entries.handoff).toBe('options')
    expect(BINDING_FIELDS.modelId.entries.restore).toBe('none')
    expect(BINDING_FIELDS.modelId.entries.fork).toBe('options')
  })

  it('thinkingLevel 四列 = create:options / handoff:options / restore:none / fork:options', () => {
    expect(BINDING_FIELDS.thinkingLevel.entries.create).toBe('options')
    expect(BINDING_FIELDS.thinkingLevel.entries.handoff).toBe('options')
    expect(BINDING_FIELDS.thinkingLevel.entries.restore).toBe('none')
    expect(BINDING_FIELDS.thinkingLevel.entries.fork).toBe('options')
  })
})
describe('M2d: [U7 反向读] JSONL append model entry 后 scanPiSessions 重扫可见', () => {
  it('外部 pi append 无显式失效，(mtimeMs,size) 变化致 meta 重扫', () => {
    const dir = makeTmpDir('model-cache-')
    try {
      const origDataDir = process.env.TAIJI_AGENT_DATA_DIR
      process.env.TAIJI_AGENT_DATA_DIR = dir
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()

      const sessionsDir = join(dir, 'agent', 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      let sessions = scanPiSessions({ force: true })
      expect(sessions.length).toBe(1)
      expect(sessions[0].modelId).toBeUndefined()

      // [U8a] 持久层唯一写方 = pi：模型信息经 JSONL append 落盘（真实 pi setModel 行为）。
      // pi 是外部进程不调 taiji 的显式失效——可见性 = 下次真实重扫（force 绕过 1s dir
      // TTL；(mtimeMs,size) 因 append 变化致 meta 缓存 miss 重扫，反向读命中新值）。
      // 原「persistModelBinding 后 force:false 立即可见」随写点退役消失（sidecar 写的
      // 双层失效对 model 字段不再有可观察消费方）。
      appendFileSync(fp, JSON.stringify({ type: 'model_change', provider: 'provider', modelId: 'model1' }) + '\n', 'utf8')
      appendFileSync(fp, JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'medium' }) + '\n', 'utf8')

      sessions = scanPiSessions({ force: true })
      expect(sessions.length).toBe(1)
      expect(sessions[0].modelId).toBe('provider/model1')
      expect(sessions[0].thinkingLevel).toBe('medium')

      if (origDataDir !== undefined) {
        process.env.TAIJI_AGENT_DATA_DIR = origDataDir
      } else {
        delete process.env.TAIJI_AGENT_DATA_DIR
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
// [缓存治理 U7] 原 readModelBinding describe（M3a-M3d：sidecar 缺失/损坏/非法字段容错）
// 随读侧切 JSONL 反向读整块退役——断言对象（sidecar 内容驱动返回值）已不存在，等价语义
// （损坏行跳过 / 非法字段跳过 / 无模型信息 → undefined / sidecar 不再是读取来源）由
// src/infra/pi/__tests__/session-model-reverse-read.test.ts 权威覆盖。

describe('M4: purge 清单含 .model.json', () => {
  it('delete（scanned 分支）驱动 purgeSessionSidecars，.model.json 与其他 sidecar 后缀一并清理', async () => {
    const dir = makeTmpDir('model-purge-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      const suffixes = ['.meta.json', '.preset.json', '.project.json', '.handoff.json', '.agent.json', '.model.json']
      for (const suffix of suffixes) {
        writeFileSync(fp + suffix, '{}')
        expect(existsSync(fp + suffix)).toBe(true)
      }

      // 真实驱动 SessionLifecycle.delete（scanned 分支 → purgeSessionSidecars）：
      // trash 用 mock（主文件留原地，只验 sidecar unlink），其余 store 方法 mock。
      const { SessionLifecycle: LC } = await import('../services/session/session-lifecycle.js') as {
        SessionLifecycle: typeof SessionLifecycle
      }
      const svc = {
        findScannedSession: vi.fn(() => ({
          id: 's1', filePath: fp, cwd: dir, timestamp: new Date().toISOString(),
          name: 'test', outcome: null, lastModified: Date.now(), size: 100,
        })),
      } as unknown as ILifecycleSessionOps
      const sessionStore = {
        trash: vi.fn(async () => {}),
        // D5 整树软删通道（ISessionStore.trashDirectory）：本文件断言面 = sidecar 清理
        // 家族，树删 no-op 即可（落盘效果由 cascade 测试族真跑覆盖）。
        trashDirectory: vi.fn(async () => {}),
        invalidateMetaCache: vi.fn(),
        invalidateScanCache: vi.fn(),
        refreshAll: vi.fn(),
      } as unknown as ISessionStore
      const lifecycle = new LC(
        svc, {} as unknown as IProcessManager, {} as unknown as IConfigStore,
        sessionStore, {} as unknown as WorkspaceService,
        { adapterFactory: vi.fn(), getMessageBus: vi.fn(() => null), broadcastGlobal: vi.fn(), notifySessionComplete: vi.fn() } as unknown as ISessionRegisterDeps,
      )
      await lifecycle.delete('s1')

      // trash 被 mock → 主文件仍在原地；全部 sidecar 必须被真实 unlink。
      // 若 purgeSessionSidecars 清单漏掉 .model.json，此处 existsSync 断言变红。
      expect(existsSync(fp)).toBe(true)
      for (const suffix of suffixes) {
        expect(existsSync(fp + suffix)).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});
// ======================================================================
// ← src/__tests__/session-fork-fields.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-fork-fields', () => {
describe('W1 fork 字段透传', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'w1-fork-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

  // ── U1：SessionSummary 含 4 个新可选字段 ─────────────────────────

  // [2026-09 测试舰队审查 r2-20] U1 运行时空绿占位断言已裁（类型契约由 tsc 承担）。

  // ── U2：parseSessionHeader 解析 parentSession + forkEntryId ──────────

  it('U2: parseSessionHeader 返回 header 中的 parentSession + forkEntryId', () => {
    const filePath = join(dir, 'forked.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'session',
        id: 'forked-1',
        cwd: '/test',
        timestamp: '2026-07-07T01:00:00.000Z',
        parentSession: '/path/to/parent.jsonl',
        forkEntryId: 'entry-123',
      }) + '\n',
    )
    const header = parseSessionHeader(filePath)
    expect(header).not.toBeNull()
    expect(header?.parentSession).toBe('/path/to/parent.jsonl')
    expect(header?.forkEntryId).toBe('entry-123')
  })

  // ── U3：persistHandoffSidecar 写 sidecar + extractHandedOff 读取（W11 迁移）──

  it('U3: persistHandoffSidecar 写 .handoff.json sidecar（JSONL 零写），extractHandedOff 读回目标 sessionId', () => {
    const filePath = join(dir, 'session.jsonl')
    const original = JSON.stringify({ type: 'session', id: 'src-1', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n'
    writeFileSync(filePath, original)

    persistHandoffInfra(filePath, 'new-session-id')

    // sidecar 出现且内容正确（taiji 自有文件，不触碰 pi 的 JSONL）
    const sidecarPath = filePath + '.handoff.json'
    expect(existsSync(sidecarPath)).toBe(true)
    const marker = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    expect(marker.handedOffTo).toBe('new-session-id')
    expect(marker.type).toBe('handoff_marker')

    // JSONL 本体字节不变（绝对写规则：session JSONL 唯一写方是 pi）
    expect(readFileSync(filePath, 'utf-8')).toBe(original)

    // extractHandedOff 优先读 sidecar，返回被交接的目标 sessionId
    expect(extractHandedOffInfra(filePath)).toBe('new-session-id')
  })

  it('U3b: JSONL 不存在时跳过（规则 #6——绝不创建 sidecar，pi openSync("wx") 竞态防护）', () => {
    const filePath = join(dir, 'never-flushed.jsonl')
    expect(() => persistHandoffInfra(filePath, 'target-id')).not.toThrow()
    expect(existsSync(filePath + '.handoff.json')).toBe(false)
  })

  it('U3c: 存量旧 session 兼容——无 sidecar、JSONL 尾部含旧 handoff_marker entry 时 fallback 尾读', () => {
    const filePath = join(dir, 'legacy.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-2', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'legacy-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    // 无 sidecar → fallback 尾读旧 marker（W11 前写入的存量形态）
    expect(extractHandedOffInfra(filePath)).toBe('legacy-target')
  })

  it('U3d: sidecar 优先于旧 JSONL marker（两者并存时新值胜出）', () => {
    const filePath = join(dir, 'both.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-3', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'old-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    persistHandoffInfra(filePath, 'new-target')
    expect(extractHandedOffInfra(filePath)).toBe('new-target')
  })

  it('U3e: 无 sidecar 且无 marker → undefined（未交接）', () => {
    const filePath = join(dir, 'clean.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({ type: 'session', id: 'src-4', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n',
    )
    expect(extractHandedOffInfra(filePath)).toBeUndefined()
  })

  it('U3f: 损坏 sidecar（handedOffTo 非字符串）→ fallthrough 尾读 JSONL 兜底', () => {
    const filePath = join(dir, 'corrupt.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-5', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'jsonl-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    writeFileSync(filePath + '.handoff.json', JSON.stringify({ handedOffTo: 123 }))
    expect(extractHandedOffInfra(filePath)).toBe('jsonl-target')
  })

  // ── U4：createForkedSessionFile 写入 forkEntryId 到 newHeader ───────

  it('U4: createForkedSessionFile 写入 forkEntryId 到新 session 的 header', async () => {
    const sourceFile = join(dir, 'source.jsonl')
    writeFileSync(
      sourceFile,
      [
        { type: 'session', version: 3, id: 'src-session-id', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    // 传入 forkEntryId（fork 点的 pi entryId），期望新文件 header 记录该字段
    const { filePath } = await createForkedSessionFile(
      sourceFile,
      'a1',          // forkEntryId（截断点）
      true,          // includeFrom
      dir,           // targetDir
      'a1',          // forkEntryId 字段（写入新 header，供后续 merge 定位 fork 点）
    )

    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    expect(header.forkEntryId).toBe('a1')
  })

  // ── U15：fork 产物写入 encodeCwd 子目录（方案 B 布局对齐 pi）───────

  it('U15: createForkedSessionFile 产物写入 <targetDir>/<encodeCwd(header.cwd)>/ 子目录（与 import-service 写入形态对齐）', async () => {
    const sourceFile = join(dir, 'source-subdir.jsonl')
    writeFileSync(
      sourceFile,
      [
        { type: 'session', version: 3, id: 'src-subdir', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    const { filePath } = await createForkedSessionFile(sourceFile, 'a1', true, dir)

    // 产物落在 encodeCwd 子目录内——写平铺根会被 pi 原生 listAll（只枚举子目录）漏掉
    expect(dirname(filePath)).toBe(join(dir, encodeCwd('/test')))
    // 子目录由 mkdir(recursive) 自动创建（首个该 cwd 的 fork 产物不 ENOENT）
    expect(existsSync(filePath)).toBe(true)
    // 产物 header 完整可读（用户可见后果：fork session 合法落盘）
    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0])
    expect(header.type).toBe('session')
    expect(header.id).not.toBe('src-subdir')
  })

  // ── U5：parentSession fallback（源 session 未落盘时用源 sessionId）──

  it('U5: 源 session sessionFilePath 缺失时，parentSession fallback 到源 sessionId', async () => {
    // createForkedSessionFile 在源 header 已有 parentSession 时透传；
    // 若源 sessionFile 尚未落盘（sessionFilePath=undefined），forkSession/
    // initializeManagedSession 应把 parentSession 写成源 sessionId 而非 undefined。
    //
    // 本用例通过 createForkedSessionFile 的 parentSession fallback 参数覆盖：
    // 传入 fallbackParentId，期望新 header.parentSession 在源 header 无 parentSession 时
    // 取 fallbackParentId（源 sessionId），形成可追溯的父子链。
    const sourceFile = join(dir, 'source-noparent.jsonl')
    writeFileSync(
      sourceFile,
      [
        // 源 session header 无 parentSession（顶层 session，非 fork 产物）
        { type: 'session', version: 3, id: 'top-level-session', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    const { filePath } = await createForkedSessionFile(
      sourceFile,
      'u1',
      true,
      dir,
      undefined,        // forkEntryId 字段（本用例不关心）
      'top-level-session', // fallbackParentId：源 session 尚未落盘时用源 sessionId
    )

    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    // fallback 生效：parentSession 不是源文件路径（源未落盘），而是源 sessionId
    expect(header.parentSession).toBe('top-level-session')
  })

  // ── U6：ScannedSessionMeta 两处定义字段对齐 ────────────────────────

  // [2026-09 测试舰队审查 r2-20] U6 运行时空绿占位断言已裁（类型契约由 tsc 承担）。
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-rename-fanout', () => {
describe('createSessionRenamedHandler（D4 扇出）', () => {
  it('TC1: 得名事件 → setLabelCache(sid, name) + broadcastSessionList 各一次，先写后广播', () => {
    const deps = makeDeps()
    const handler = createSessionRenamedHandler(deps)

    handler('s1', '重构配置加载')

    expect(deps.setLabelCache).toHaveBeenCalledTimes(1)
    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', '重构配置加载')
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
    // 顺序契约：label 先落内存，广播后现算（buildSessionListMsg 直读 session.label）
    expect(deps.setLabelCache.mock.invocationCallOrder[0])
      .toBeLessThan(deps.broadcastSessionList.mock.invocationCallOrder[0])
  })

  it('TC2: 清名事件（name undefined）→ label 回落 basename(cwd) 派生而非空串', () => {
    const deps = makeDeps('/tmp/feat-rename-session-mode')
    const handler = createSessionRenamedHandler(deps)

    handler('s1', undefined)

    expect(deps.getSessionCwd).toHaveBeenCalledWith('s1')
    expect(deps.setLabelCache).toHaveBeenCalledTimes(1)
    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', 'feat-rename-session-mode')
    // 显式负断言（V9 回归钉）：不写空串
    expect(deps.setLabelCache.mock.calls[0][1]).not.toBe('')
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('TC2b: 空串 name（≠ undefined）原样透传——回落只针对清名事件形态，不静默改写', () => {
    const deps = makeDeps()
    const handler = createSessionRenamedHandler(deps)

    handler('s1', '')

    // '' ?? basename(...) === ''：pi trim 归一后本不该出现，但若出现不做译码改写
    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', '')
  })

  it('TC2c: cwd 缺失（session 已不在内存 Map）→ 不抛错（setLabelCache 侧自身 no-op）', () => {
    const deps = makeDeps()
    deps.getSessionCwd = vi.fn(() => undefined)
    const handler = createSessionRenamedHandler(deps)

    expect(() => handler('s-gone', undefined)).not.toThrow()
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
  })
})
describe('session-renamed 接线（interpreter + handler，组合根 index.ts 同形态）', () => {
  it('TC3: session-renamed 事件 → onSessionRenamed 回调触发整表广播', () => {
    const deps = makeDeps()
    const handler = createSessionRenamedHandler(deps)
    const sent: ServerMessage[] = []
    const interp = new EventInterpreter('s1', { send: (m) => { sent.push(m) }, onSessionRenamed: handler })

    interp.interpret([{ kind: 'session-renamed', name: 'agent 起的名字' }])

    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', 'agent 起的名字')
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('TC4 (P3 单测级): broadcastSessionList 抛错 → interpret 批次继续，后续事件照常处理', () => {
    const deps = makeDeps()
    deps.broadcastSessionList = vi.fn(() => { throw new Error('ws send exploded') })
    const handler = createSessionRenamedHandler(deps)
    const sent: ServerMessage[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const interp = new EventInterpreter('s1', { send: (m) => { sent.push(m) }, onSessionRenamed: handler })

      expect(() => interp.interpret([
        { kind: 'session-renamed', name: 'n' },
        { kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: 's1', delta: 'x' } } },
      ])).not.toThrow()

      // 后续事件未被广播失败吞掉（W1 per-event 隔离：隔离日志留痕，批次继续）
      expect(sent.some((m) => m.type === 'message.text_delta')).toBe(true)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-scanner-sidebar-set', () => {
describe('W3 侧栏条目集合等价（验收项 10①：btw 不得出现且非 btw 会话必须在集合内）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w3-sidebar-set-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeScanner(active: SessionSummary[], activeFilePaths: Set<string>): SessionScanner {
    const svc: IScannerSessionOps = {
      getActiveSummaries: () => active,
      getActiveFilePaths: () => activeFilePaths,
    }
    const gitInfoReader = {
      readGitInfo: () => undefined,
      pruneStaleCache: () => {},
    } as unknown as IGitInfoReader
    return new SessionScanner(svc, new PiSessionStore(), gitInfoReader)
  }

  it('活跃 btw 线 + 磁盘主会话：集合 = 全部非 btw 会话（负面 + 正向合取）', () => {
    // 磁盘：两个主会话（冷会话）
    writeSessionFile(sessionsDir, 'proj-a', 'cold-1', '/work/a')
    writeSessionFile(sessionsDir, 'proj-b', 'cold-2', '/work/b')
    // 活跃：一条 btw 线（surface:'btw'）+ 一个主会话
    const btwLine: SessionSummary = {
      id: 'line-live', label: '线', cwd: '/work/a', status: 'active', lastActiveAt: 3,
      surface: 'btw',
    }
    const liveMain: SessionSummary = {
      id: 'live-main', label: '主', cwd: '/work/a', status: 'active', lastActiveAt: 2,
      surface: 'sidebar',
    }

    const groups = makeScanner([btwLine, liveMain], new Set()).listPersistedSessions()
    const ids = groups.flatMap((g) => g.sessions).map((s) => s.id).sort()

    // 集合等价：btw 线不得出现 **且** 全部非 btw 会话必须在集合内
    expect(ids).toEqual(['cold-1', 'cold-2', 'live-main'])
    expect(ids).not.toContain('line-live')
  })

  it('磁盘条目 surface 显式缺省 sidebar（漏缺省 = 冷会话整批从侧栏消失的失效形态）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'cold-only', '/work/a')

    const groups = makeScanner([], new Set()).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)

    // 正向断言：冷会话必须在集合内（surface 缺省值正确才进得了 W5 的正向谓词）
    expect(all.map((s) => s.id)).toEqual(['cold-only'])
    expect(all[0].surface).toBe('sidebar')
  })

  it('btw 线独占列表（无其他会话）→ 集合为空但不 vacuously 通过（磁盘正向锚点兜底）', () => {
    // 无磁盘条目、活跃只有 btw 线 → 列表为空；同文件用磁盘锚点证明「空」是过滤结果
    // 而非集合口径失效（锚点在上一用例；此处断言空集合 + btw 侧 surface 透传）。
    const btwLine: SessionSummary = {
      id: 'only-line', label: '线', cwd: '/work/a', status: 'active', lastActiveAt: 3,
      surface: 'btw',
    }

    const groups = makeScanner([btwLine], new Set()).listPersistedSessions()

    expect(groups.flatMap((g) => g.sessions)).toHaveLength(0)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-scanner-source', () => {
describe('SessionScanner W15 磁盘占位值来源标记', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w15-scanner-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    // 目录列举 TTL 缓存跨测试隔离（缓存键含 dir，但显式重置防同 dir 内旧窗口泄漏）
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 窄 mock：结构性满足 scanner 窄接口（2 方法 = 消费方实际用到的全部，S2 ISP 化无强转）。 */
  function makeScanner(active: SessionSummary[], activeFilePaths: Set<string>): SessionScanner {
    const svc: IScannerSessionOps = {
      getActiveSummaries: () => active,
      getActiveFilePaths: () => activeFilePaths,
    }
    const gitInfoReader = {
      readGitInfo: () => undefined,
      pruneStaleCache: () => {},
    } as unknown as IGitInfoReader
    return new SessionScanner(svc, new PiSessionStore(), gitInfoReader)
  }

  it('扫描条目带 source:"scan" 标记 + surface 显式缺省 "sidebar"（W3 磁盘条目缺省）', () => {
    writeSessionFile_m2(sessionsDir, 'proj-a', 'sess-1', '/work/a')

    const groups = makeScanner([], new Set()).listPersistedSessions()

    expect(groups).toHaveLength(1)
    const scanned = groups[0].sessions[0]
    expect(scanned.id).toBe('sess-1')
    // 来源标记：'scan' = 磁盘扫描条目（owner 来源不标）
    expect(scanned.source).toBe('scan')
    // W3 surface 落地：磁盘条目显式缺省 'sidebar'（W5 正向谓词 surface === 'sidebar' 的
    // 取数来源；undefined 会让全部冷会话从侧栏消失）
    expect(scanned.surface).toBe('sidebar')
    // W3 三状态字段删除：扫描条目不再携带 modelId/thinkingLevel/tokenCount
    expect(scanned).not.toHaveProperty('modelId')
    expect(scanned).not.toHaveProperty('thinkingLevel')
    expect(scanned).not.toHaveProperty('tokenCount')
  })

  it('活跃实例条目不标 source（缺省 = owner 权威，D1b 正常覆盖路径）', () => {
    writeSessionFile_m2(sessionsDir, 'proj-a', 'sess-1', '/work/a')
    const active: SessionSummary = {
      id: 'sess-live',
      label: '活跃',
      cwd: '/work/a',
      status: 'idle',
      lastActiveAt: 1,
      // W3：活跃条目透传注册表 surface（buildSessionSummary 透传；registerSession 缺省 'sidebar'）
      surface: 'sidebar',
    }

    const groups = makeScanner([active], new Set()).listPersistedSessions()

    const all = groups.flatMap((g) => g.sessions)
    const live = all.find((s) => s.id === 'sess-live')
    expect(live?.source).toBeUndefined()
    expect(live?.surface).toBe('sidebar')
    const scanned = all.find((s) => s.id === 'sess-1')
    expect(scanned?.source).toBe('scan')
    expect(scanned?.surface).toBe('sidebar')
  })

  it('回归：扫描全量条目数与 sessions 目录 .jsonl 文件数一致（不丢条目；活跃 filePath 去重）', () => {
    writeSessionFile_m2(sessionsDir, 'proj-a', 'f1', '/work/a')
    writeSessionFile_m2(sessionsDir, 'proj-a', 'f2', '/work/a')
    writeSessionFile_m2(sessionsDir, 'proj-b', 'f3', '/work/b')
    writeSessionFile_m2(sessionsDir, 'proj-b', 'f4', '/work/b')
    writeSessionFile_m2(sessionsDir, 'proj-b', 'f5', '/work/b')
    // f5 同文件被活跃实例持有 → 持久化副本去重，活跃真值版本进列表
    const livePath = writeSessionFile_m2(sessionsDir, 'proj-c', 'f6', '/work/c')
    const active: SessionSummary = {
      id: 'f6',
      label: '活跃 f6',
      cwd: '/work/c',
      status: 'active',
      lastActiveAt: 2,
      surface: 'sidebar',
      sessionFile: livePath,
    }

    const groups = makeScanner([active], new Set([livePath])).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)

    // 目录 6 个文件；f6 活跃去重后总条目数 = 5 个扫描 + 1 个活跃（不重复计入）
    expect(all).toHaveLength(6)
    expect(all.filter((s) => s.source === 'scan')).toHaveLength(5)
    // 活跃去重的 f6 走实例版本（owner 来源不标 source；surface 透传注册表值）
    const f6 = all.find((s) => s.id === 'f6')
    expect(f6?.surface).toBe('sidebar')
    expect(f6?.source).toBeUndefined()
  })

  // ── W1 F1 修复：.tmp-migrate- 崩溃残留按文件名排除 ─────────────────
  // restore-time 归一化（normalizeSessionFileInPlace）在写临时名与 rename 之间崩溃时，
  // sessions 目录残留 <原名>.tmp-migrate-<ts>.jsonl。scanner 按内容（首行 header）识别
  // session 不按文件名——残留内容是合法 session（同 sessionId），不过滤会产生同 id
  // 双条目且残留 mtime 更新排序在前，findScannedSession 命中残留 → restore 附着错位
  // 文件（verifier F1 实锤探针场景）。isScannableSessionFile 把排除变成机制保证。
  it('W1 F1: .tmp-migrate- 崩溃残留不进扫描列表，findScannedSession 数据源不命中（同 sessionId 唯一指向原文件）', () => {
    // 原文件（cwd 子目录形态）
    const origPath = writeSessionFile_m2(sessionsDir, 'proj-a', 'sess-dup', '/work/a')
    // 残留 1（子目录内）：内容为合法 session 且同 sessionId——模拟 write 完成、rename 前崩溃
    //（残留写入晚于原文件 → mtime 更新，未过滤时排序在前，正是 verifier 探针命中的形态）
    const leftoverSub = join(sessionsDir, 'proj-a', 'sess-dup.jsonl.tmp-migrate-1755561600000.jsonl')
    writeFileSync(
      leftoverSub,
      JSON.stringify({ type: 'session', id: 'sess-dup', cwd: '/work/a', timestamp: '2026-08-19T00:00:01Z' }) + '\n',
      'utf-8',
    )
    // 残留 2（sessions 目录顶层）：覆盖顶层 .jsonl 枚举分支
    const leftoverTop = join(sessionsDir, 'top.jsonl.tmp-migrate-1755561600999.jsonl')
    writeFileSync(
      leftoverTop,
      JSON.stringify({ type: 'session', id: 'sess-top-leftover', cwd: '/work/a', timestamp: '2026-08-19T00:00:02Z' }) + '\n',
      'utf-8',
    )

    // 列表侧：残留不进扫描列表，sess-dup 唯一且指向原文件
    const groups = makeScanner([], new Set()).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)
    expect(all.find((s) => s.sessionFile === leftoverSub)).toBeUndefined()
    expect(all.find((s) => s.sessionFile === leftoverTop)).toBeUndefined()
    expect(all.find((s) => s.sessionFile === origPath)).toBeDefined()
    const dupEntries = all.filter((s) => s.id === 'sess-dup')
    expect(dupEntries).toHaveLength(1)
    expect(dupEntries[0].sessionFile).toBe(origPath)

    // findScannedSession 数据源侧（其实现 = sessionStore.scanSessions({force}).find，
    // session-service.ts:1189）：数组不含残留路径 → 按 id 查找只命中原文件
    const scanned = new PiSessionStore().scanSessions({ force: true })
    expect(scanned.find(s => s.filePath === leftoverSub)).toBeUndefined()
    expect(scanned.find(s => s.filePath === leftoverTop)).toBeUndefined()
    const found = scanned.find(s => s.id === 'sess-dup')
    expect(found?.filePath).toBe(origPath)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-subscribe', () => {
describe('SessionMessageHandler —— session.subscribe gap 判定（D5-3/R-03）', () => {
  // TC1: R-03 探针——state+stream 混合 session 正常订阅不误报 gap
  it('TC1: mixed session (5 state + 3 stream) — gap=false, stream-only snapshot, complete stateSnapshot', async () => {
    const bus = new MessageBus()
    const sid = 's1'
    bus.publish(sid, pushMsg('session.commands', { sessionId: sid, commands: [] })) // seq 1 state
    bus.publish(sid, pushMsg('message.message_start', { sessionId: sid, n: 1 })) // seq 2 stream
    bus.publish(sid, pushMsg('context.update', { sessionId: sid, usagePercent: 50 })) // seq 3 state
    bus.publish(sid, pushMsg('message.tool_call_start', { sessionId: sid, n: 2 })) // seq 4 stream
    bus.publish(sid, pushMsg('session.subagents', { sessionId: sid, subagents: [] })) // seq 5 state
    bus.publish(sid, pushMsg('message.complete', { sessionId: sid, n: 3 })) // seq 6 stream
    bus.publish(sid, pushMsg('session.workflowUpdate', { sessionId: sid, runId: 'w1' })) // seq 7 state
    bus.publish(sid, pushMsg('session.state_changed', { sessionId: sid, modelId: 'm1' })) // seq 8 state

    const { cap, handler } = makeHandler({ messageBus: bus })
    await handler.handleSessionMessage(msg('session.subscribe', { sessionId: sid }), WS)

    expect(cap.errors).toHaveLength(0)
    expect(cap.replies).toHaveLength(1)
    const reply = cap.replies[0]
    expect(reply.type).toBe('session.subscribe')
    const { snapshot, stateSnapshot, lastSeq, gap } = reply.payload as {
      snapshot: ServerMessage[]
      stateSnapshot: ServerMessage[]
      lastSeq: number
      gap: boolean
    }
    // 旧死 gauge（seqCounter > ring.length = 8 > 3 恒真）会误报；R-03 后 gap 只在
    // fromSeq 早于 ring 最旧 seq 时为 true——本用例无 fromSeq，恒 false。
    expect(gap).toBe(false)
    // snapshot 只含 stream 类（state 不入 ring），按 seq 顺序
    expect(snapshot.map((m) => m.seq)).toEqual([2, 4, 6])
    // stateSnapshot 是 5 个 state topic 的 last-value
    expect(stateSnapshot).toHaveLength(5)
    expect(stateSnapshot.map((m) => m.type).sort()).toEqual([
      'context.update',
      'session.commands',
      'session.state_changed',
      'session.subagents',
      'session.workflowUpdate',
    ])
    expect(lastSeq).toBe(8)
  })

  // TC2: ring 溢出 + fromSeq 早于最旧 seq → gap=true，snapshot 全量不过滤
  it('TC2: ring overflow (cap 3, 4 stream) + fromSeq=1 → gap=true with full snapshot (no incremental filter)', async () => {
    const bus = new MessageBus(3)
    const sid = 's1'
    for (let i = 1; i <= 4; i++) {
      bus.publish(sid, pushMsg('message.status', { sessionId: sid, n: i })) // seq 1..4，seq1 被覆盖淘汰
    }

    const { cap, handler } = makeHandler({ messageBus: bus })
    await handler.handleSessionMessage(
      msg('session.subscribe', { sessionId: sid, fromSeq: 1 }),
      WS,
    )

    expect(cap.errors).toHaveLength(0)
    const reply = cap.replies[0].payload as {
      snapshot: ServerMessage[]
      lastSeq: number
      gap: boolean
    }
    // fromSeq=1 < ring 最旧 seq=2 → 溢出缺口，gap=true
    expect(reply.gap).toBe(true)
    // 全量回放路径：snapshot 未被 fromSeq 过滤（renderer 拿全量后自行全量重新拉取）
    expect(reply.snapshot.map((m) => m.seq)).toEqual([2, 3, 4])
    expect(reply.lastSeq).toBe(4)
  })

  // TC3: fromSeq 落在 ring 覆盖范围内 → gap=false，增量过滤
  it('TC3: fromSeq within ring coverage → gap=false with incremental snapshot (seq > fromSeq)', async () => {
    const bus = new MessageBus(3)
    const sid = 's1'
    for (let i = 1; i <= 4; i++) {
      bus.publish(sid, pushMsg('message.status', { sessionId: sid, n: i }))
    }

    const { cap, handler } = makeHandler({ messageBus: bus })
    await handler.handleSessionMessage(
      msg('session.subscribe', { sessionId: sid, fromSeq: 2 }),
      WS,
    )

    expect(cap.errors).toHaveLength(0)
    const reply = cap.replies[0].payload as {
      snapshot: ServerMessage[]
      gap: boolean
    }
    // fromSeq=2 等于 ring 最旧 seq → 无缺口，增量模式
    expect(reply.gap).toBe(false)
    expect(reply.snapshot.map((m) => m.seq)).toEqual([3, 4])
  })

  // TC4: messageBus 未注入 → sendError('subscribe_unsupported')
  it('TC4: messageBus not injected → sendError(subscribe_unsupported)', async () => {
    const { cap, handler } = makeHandler({ messageBus: undefined })
    await handler.handleSessionMessage(
      msg('session.subscribe', { sessionId: 's1' }),
      WS,
    )
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0].code).toBe('subscribe_unsupported')
  })
})
});
});

// ======================================================================
// ← session-service-engine-bundle.test.ts
// ======================================================================

const PREV_DATA_DIR = process.env['TAIJI_AGENT_DATA_DIR']


let tmpDataRoot: string


let zcodeRealPath: string


let zcodeCopyPath: string


interface RecordsExtOverride {  // oe-exempt:20261027:test:
  discoverEngines?: () => string[]
  zcodeModelListPaths?: { realProviderConfigPath: string; syncedCopyPath: string; builtinCatalogPath?: string }
}


function makeRecords(extOverride?: RecordsExtOverride): SessionRecords {
  return new SessionRecords({
    pm: {} as never,
    sessionStore: { scanSessions: vi.fn(() => []) } as never,
    hasSession: () => false,
    getMessageBus: () => null,
    // [W8] getExtensionPaths 死键已随 deps 面删除（W4 登记的保留期结束）
    // D5：zcode 模型清单派生源指向 tmp（隔离真实 ~/.zcode/v2/provider_config.json 与
    // 内建目录 account 直通枚举——[engine-ref-translation D3] 副本注入缺省项）
    zcodeModelListPaths: {
      realProviderConfigPath: zcodeRealPath,
      syncedCopyPath: zcodeCopyPath,
      builtinCatalogPath: path.join(tmpDataRoot, 'absent-builtin-catalog.json'),
    },
    ...extOverride,
  })
}


function writeJson(rel: string, v: unknown): void {
  const p = path.join(tmpDataRoot, 'agent/subagents', rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}


function readConfigJson(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDataRoot, 'agent/subagents/config.json'), 'utf8'),
  ) as Record<string, unknown>
}


function configPath(): string {
  return path.join(tmpDataRoot, 'agent/subagents/config.json')
}


/** provider_config.json 个人条目 fixture（对齐 u1 测试的写盘形态）。 */
function writeProviderConfig(
  absPath: string,
  rules: ReadonlyArray<{ providerId: string; models: string[]; apiKey?: string; providerName?: string }>,
): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(
    absPath,
    JSON.stringify(
      {
        config: {
          providerConfigRules: {
            providerRules: rules.map((r) => ({
              providerId: r.providerId,
              ...(r.providerName !== undefined ? { providerName: r.providerName } : {}),
              config: {
                access: { apiKey: r.apiKey ?? 'sk-test' },
                modelOrder: r.models,
              },
            })),
          },
        },
      },
      null,
      2,
    ),
  )
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-engine-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-engine-config', () => {
beforeEach(() => {
  tmpDataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engine-config-'))
  zcodeRealPath = path.join(tmpDataRoot, 'zcode-home', 'v2', 'provider_config.json')
  zcodeCopyPath = path.join(tmpDataRoot, 'agent', 'engines', 'zcode', 'pi-synced-provider-config.json')
  process.env['TAIJI_AGENT_DATA_DIR'] = tmpDataRoot
})
afterEach(() => {
  // 锁预算注入只服务 ELOCKED 用例：逐例复位，避免压缩预算泄漏到后续用例
  setSessionConfigLockTimingForTest({})
  if (PREV_DATA_DIR === undefined) delete process.env['TAIJI_AGENT_DATA_DIR']
  else process.env['TAIJI_AGENT_DATA_DIR'] = PREV_DATA_DIR
  fs.rmSync(tmpDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('getSubagentEngineConfig', () => {
  it('engines.json + config.json 合成视图', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 6, defaultEngine: 'zcode' })
    const view = await makeRecords().getSubagentEngineConfig()
    // D5 扩展键恒带：无派生源时 zcode 清单空表、无偏好时空对象
    expect(view).toEqual({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('[W4] engines.json 缺失/损坏 → runtime 自身发现回退（deps.discoverEngines 注入点）', async () => {
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    // 回退源 = runtime 自身发现结果（§3.4 派生视图表「冷启动回退源单源化」）
    const discovered = await makeRecords({ discoverEngines: () => ['zcode', 'foo'] }).getSubagentEngineConfig()
    expect(discovered).toEqual({ engines: ['zcode', 'foo'], defaultEngine: 'pi', engineModels: { zcode: [] }, engineDefaults: {} })
    // engines.json 损坏同走发现回退
    writeJson('engines.json', '{ torn')
    const torn = await makeRecords({ discoverEngines: () => ['zcode'] }).getSubagentEngineConfig()
    expect(torn).toEqual({ engines: ['zcode'], defaultEngine: 'pi', engineModels: { zcode: [] }, engineDefaults: {} })
  })

  it('[W4] 零命中 → 空清单（无静态 JSON 兜底）', async () => {
    // 静态声明兜底已删：零命中返回空清单（静态声明列出的 id 无 bin 可执行，
    // 「能选不能跑」与「不可用引擎不进清单」派生视图规则冲突，§3.4 派生视图表）
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    const svc = makeRecords({ discoverEngines: () => [] })
    await expect(svc.getSubagentEngineConfig()).resolves.toEqual({
      engines: [],
      defaultEngine: 'pi',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('[W4] 发现回退失败 → 空清单（不阻塞配置视图）；defaultEngine 仍独立读 config.json', async () => {
    const svc = makeRecords({
      discoverEngines: () => {
        throw new Error('discovery exploded')
      },
    })
    writeJson('config.json', { version: 1, defaultEngine: 'zcode' })
    await expect(svc.getSubagentEngineConfig()).resolves.toEqual({
      engines: [],
      defaultEngine: 'zcode',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('[D5] engineModels：真实 ∪ 副本 id 级聚合（真实优先）+ name 派生', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    // 真实源同名条目（stepfun）必须胜出——副本 stepfun 的 step-stale 不进清单
    writeProviderConfig(zcodeRealPath, [
      { providerId: 'stepfun', models: ['step-1v'], providerName: 'StepFun' },
      { providerId: 'nokey', models: ['dead'], apiKey: '' },
    ])
    writeProviderConfig(zcodeCopyPath, [
      { providerId: 'stepfun', models: ['step-stale'] },
      { providerId: 'openrouter', models: ['m1', 'm2'] },
    ])
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view.engineModels).toEqual({
      zcode: [
        { id: 'stepfun/step-1v', name: 'StepFun · step-1v' },
        { id: 'openrouter/m1' },
        { id: 'openrouter/m2' },
      ],
    })
  })

  it('[D5] engineModels：双源回落——真实源缺失时副本派生照常（纯 pi provider 用户形态）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeProviderConfig(zcodeCopyPath, [{ providerId: 'openrouter', models: ['m1'] }])
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view.engineModels).toEqual({ zcode: [{ id: 'openrouter/m1' }] })
  })

  it('[D5] engineDefaults：读取经 u5 sanitize——手编脏条目剔除不连坐合法偏好', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', {
      version: 1,
      engineDefaults: { zcode: 'stepfun/step-1v', pi: '', bad: 42, '  ': 'x/y' },
    })
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view.engineDefaults).toEqual({ zcode: 'stepfun/step-1v' })
  })

  it('[D5] config.json 缺失 → defaultEngine pi + engineDefaults 空表（absent 态）', async () => {
    const view = await makeRecords({ discoverEngines: () => ['pi'] }).getSubagentEngineConfig()
    expect(view).toEqual({ engines: ['pi'], defaultEngine: 'pi', engineModels: { zcode: [] }, engineDefaults: {} })
  })
})
describe('setSubagentDefaultEngine', () => {
  it('合法引擎：读改写 config.json（保留其他字段）+ 原子写', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 3, futureKey: { keep: true } })
    const svc = makeRecords()
    await svc.setSubagentDefaultEngine('zcode')
    const conf = readConfigJson()
    expect(conf['defaultEngine']).toBe('zcode')
    expect(conf['maxConcurrent']).toBe(3)
    expect(conf['futureKey']).toEqual({ keep: true }) // 未知键原样保留（向前兼容）
    // 读回视图一致
    expect(await svc.getSubagentEngineConfig()).toEqual({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('未知引擎 → throw（防写坏配置）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi'], updatedAt: 1 })
    await expect(makeRecords().setSubagentDefaultEngine('ghost')).rejects.toThrow(/unknown subagent engine/)
  })

  it('值未变 → 幂等零写（mtime 不动）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 6, defaultEngine: 'zcode' })
    const p = configPath()
    const statBefore = fs.statSync(p)
    await makeRecords().setSubagentDefaultEngine('zcode')
    expect(fs.statSync(p).mtimeMs).toBe(statBefore.mtimeMs)
  })

  it('RMW 持跨进程锁：他方持同锁期间写入 fail-fast（ELOCKED），锁释放后重试成功且其他字段不被覆盖回滚', async () => {
    // review round1 MUST_FIX：config.json 是多写方共享文件（runtime RMW / agent bash /
    // 用户手编），RMW 必须持 withFileLockSync（lockfile = <config.json>.lock）。
    // 压缩重试预算（10ms/次 × 60ms）：断言语义 = 预算耗尽 → ELOCKED 且零写入，
    // 预算数值不是被测契约（默认 1s 由 test/file-lock-parity.test.ts 常量断言保护）。
    setSessionConfigLockTimingForTest({ retryDelayMs: 10, retryBudgetMs: 60 })
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5, futureKey: { keep: true } })
    const p = configPath()
    // 他方（遵守锁协议的另一写方）持同一把锁
    const release = lockfile.lockSync(p, { realpath: false })
    const pending = makeRecords().setSubagentDefaultEngine('zcode')
    await expect(pending).rejects.toThrow(/ELOCKED/)
    // 锁竞争失败零写入（不是降级无锁写）：defaultEngine 未落盘，其他字段原样
    const confDuring = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confDuring['defaultEngine']).toBeUndefined()
    expect(confDuring['maxConcurrent']).toBe(5)
    release()
    // 锁释放后重试成功：defaultEngine 写入，未知键 / maxConcurrent 不被 RMW 覆盖回滚
    await makeRecords().setSubagentDefaultEngine('zcode')
    const confAfter = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confAfter['defaultEngine']).toBe('zcode')
    expect(confAfter['maxConcurrent']).toBe(5)
    expect(confAfter['futureKey']).toEqual({ keep: true })
  })
})
describe('[D5] setSubagentEngineDefaultModel', () => {
  it('合法 ref（真实源派生）：写入 engineDefaults，保留其他字段（defaultEngine/未知键）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 3, defaultEngine: 'zcode', futureKey: { keep: true } })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v', 'step-2'] }])
    const svc = makeRecords()
    await svc.setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    const conf = readConfigJson()
    expect(conf['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
    expect(conf['maxConcurrent']).toBe(3)
    expect(conf['defaultEngine']).toBe('zcode')
    expect(conf['futureKey']).toEqual({ keep: true })
    // 读回视图一致（reply engineDefaults 反映写入值）
    expect((await svc.getSubagentEngineConfig()).engineDefaults).toEqual({ zcode: 'stepfun/step-1v' })
  })

  it('合法 ref（副本派生）：双源回落下副本条目可写入（纯 pi provider 用户形态）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1 })
    writeProviderConfig(zcodeCopyPath, [{ providerId: 'openrouter', models: ['m1'] }])
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'openrouter/m1')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'openrouter/m1' })
  })

  it('非法 ref → throw（带 taiji settings 恢复指引），config.json 不落脏值', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    await expect(
      makeRecords().setSubagentEngineDefaultModel('zcode', 'ghost/model'),
    ).rejects.toThrow(/unknown model 'ghost\/model' for engine 'zcode'.*taiji settings/)
    // 拒绝后 config.json 原样（无 engineDefaults 键，其他字段不被动）
    const conf = readConfigJson()
    expect(conf['engineDefaults']).toBeUndefined()
    expect(conf['maxConcurrent']).toBe(5)
  })

  it('无清单引擎（pi）→ throw（per-engine 默认模型仅覆盖有清单的引擎）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    await expect(
      makeRecords().setSubagentEngineDefaultModel('pi', 'stepfun/step-1v'),
    ).rejects.toThrow(/no selectable model list/)
    expect(readConfigJson()['engineDefaults']).toBeUndefined()
  })

  it('既有偏好脏条目经 sanitize 剔除（不连坐合法偏好），合法既有条目保留', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', {
      version: 1,
      engineDefaults: { pi: '', bad: 42 },
    })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
  })

  it('值未变 → 幂等零写（mtime 不动）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, engineDefaults: { zcode: 'stepfun/step-1v' } })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    const p = configPath()
    const statBefore = fs.statSync(p)
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(fs.statSync(p).mtimeMs).toBe(statBefore.mtimeMs)
  })

  it('RMW 持跨进程锁（与 setSubagentDefaultEngine 同锁）：他方持锁期间 fail-fast（ELOCKED）零写入，释放后重试成功', async () => {
    // 同上一锁用例：压缩重试预算（10ms/次 × 60ms），断言对象仍是「预算耗尽 → ELOCKED 零写入」
    setSessionConfigLockTimingForTest({ retryDelayMs: 10, retryBudgetMs: 60 })
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    const p = configPath()
    const release = lockfile.lockSync(p, { realpath: false })
    const pending = makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    await expect(pending).rejects.toThrow(/ELOCKED/)
    // 锁竞争失败零写入：engineDefaults 未落盘，其他字段原样
    const confDuring = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confDuring['engineDefaults']).toBeUndefined()
    expect(confDuring['maxConcurrent']).toBe(5)
    release()
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    const confAfter = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confAfter['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
    expect(confAfter['maxConcurrent']).toBe(5)
  })

  it('坏 JSON config.json（parse 抛错 / 非对象形态）→ 新建最小配置（与 setSubagentDefaultEngine 同款取舍）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    // 形态一：真坏 JSON 文本（JSON.parse 抛错）
    const p = configPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{ torn')
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
    // 形态二：合法 JSON 但非对象（parse 成功、属性赋值会炸的形态）——归 {} 新建基底
    fs.writeFileSync(p, '"a scalar string"')
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
  })
})
});
// ======================================================================
// ← src/__tests__/session-service-ensure-active.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-ensure-active', () => {
describe('session-service-ensure-active', () => {
/**
 * ensureActive exited 防御 + 恢复窗口注册态测试（fix-respawn-pi Wave 2 + switch-race-window）。
 *
 * 锁定语义：
 * - 快路径前提 = 完整注册态（client 存活 + sessions Map 条目在）[switch-race-window]：
 *   恢复窗口内（spawn 已登记 client、registerSession 未落 Map）直返半成品 client 会让
 *   调用方随后的 getSummary 等派生读点落空（「切换失败但实际能进」竞态根因）——条目缺失
 *   一律经 ensureRestored join 在途恢复或走内核自愈，不直返；
 * - 死 client（exited=true，processes Map 竞态残留）视同无 client 走 restore 内核，
 *   返回 restore 后的新活 client（纵深防御——上游清理竞态时消费端不把死 client 交给 prompt）；
 * - 并发 restore join（crash-resilience D7-③，u8 改造）：同 sessionId 的并发 ensureActive
 *   等待同一 in-flight restore Promise（不报错不双跑，只 restore 一次）——[HISTORICAL]
 *   原为第二个调用被 already being restored 拒绝（throw），随 D7-③ 改造同步更新；
 * - restoreSession 找不到持久化 session 时错误文案含恢复指引「请新建会话」（§6.9/§7.3，
 *   白盒表「SESSION_NOT_FOUND 恢复指引文案」断言项）。
 *
 * restore 内核 mock 策略 [switch-race-window]：恢复执行内核 = RespawnDeps.restore 直连
 * lifecycle.restoreSession（facade.restoreSession 只是 join 包装）——门控恢复执行须 spy
 * lifecycle（spyRestoreKernel helper，private 字段经类型收窄访问）；spy facade 只能拦截
 * 手动 restore 入口自身，拦不到 ensureActive 的恢复链。快路径用例经 initializeManagedSession
 * （registerSession 汇聚点的公开测试通道）播种注册态，不触碰 spawn 链 / 真实文件系统。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-ensure-active.test.ts
 */
/** 最小假 client：ensureActive 只消费身份 + exited 标志。 */
function makeClient_m2_m2(exited: boolean): IPiEngine {
  return { exited } as unknown as IPiEngine
}

/** restore 执行内核 spy 挂点（lifecycle 为 private，类型收窄访问；理由见文件头 mock 策略）。 */
function spyRestoreKernel(svc: SessionService) {
  const lc = svc as unknown as { lifecycle: { restoreSession: (sessionId: string) => Promise<SessionSummary> } }
  return vi.spyOn(lc.lifecycle, 'restoreSession')
}

/**
 * 构造真实 SessionService + 可编程 pm.getClient（session-service-w07-bus.test.ts makeEnv_m3_m3
 * 同款轻量模式：mock pm/broker/adapterFactory，构造参数中未被测路径消费的依赖给最小桩）。
 */
function makeEnv_m3_m3(getClientImpl: (sessionId: string) => IPiEngine | undefined) {
  const broker = { broadcast: vi.fn((_: ServerMessage) => {}) } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(() => () => {}),
    getClient: vi.fn(getClientImpl),
  } as unknown as IProcessManager
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService：SessionLifecycle 构造存引用，被测路径未触发
  )
  return { svc, pm }
}

describe('SessionService.ensureActive（exited 防御 + 恢复窗口注册态）', () => {
  it('完整注册态（client 存活 + Map 条目在）快路径直返，不触发 restore 内核', async () => {
    const live = makeClient_m2_m2(false)
    const { svc } = makeEnv_m3_m3(() => live)
    await svc.initializeManagedSession('sid-live', live, '/test/cwd', 'label')
    const kernelSpy = spyRestoreKernel(svc)

    const got = await svc.ensureActive('sid-live')

    expect(got).toBe(live)
    expect(kernelSpy).not.toHaveBeenCalled()
    kernelSpy.mockRestore()
  })

  it('恢复窗口半成品（client 存活但 Map 条目缺失）不直返：经恢复内核补全注册态（switch-race-window）', async () => {
    const orphan = makeClient_m2_m2(false)
    const { svc } = makeEnv_m3_m3(() => orphan)
    // 不注册播种 → 活 client 也必须走恢复内核（join 在途或自愈），不得快路径直返半成品
    const kernelSpy = spyRestoreKernel(svc).mockResolvedValue({ id: 'sid-orphan' } as SessionSummary)

    const got = await svc.ensureActive('sid-orphan')

    expect(kernelSpy).toHaveBeenCalledTimes(1)
    // 内核替身未重开进程：恢复完成后 getClient 仍返回原 client
    expect(got).toBe(orphan)
    kernelSpy.mockRestore()
  })

  it('死 client（exited=true）视同无 client 走 restore 内核，返回 restore 后的新活 client', async () => {
    const dead = makeClient_m2_m2(true)
    const fresh = makeClient_m2_m2(false)
    // 第一次 getClient：processes Map 竞态残留的死 client；restore 完成后的第二次：新活 client
    let getCalls = 0
    const { svc } = makeEnv_m3_m3(() => {
      getCalls++
      return getCalls === 1 ? dead : fresh
    })
    const kernelSpy = spyRestoreKernel(svc).mockResolvedValue({ id: 'sid-dead' } as SessionSummary)

    const got = await svc.ensureActive('sid-dead')

    // 关键断言：死 client 不直通 prompt，restore 后拿到的是新活 client
    expect(got).not.toBe(dead)
    expect(got).toBe(fresh)
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    expect(kernelSpy).toHaveBeenCalledWith('sid-dead')
    kernelSpy.mockRestore()
  })

  it('并发 ensureActive 同一 sessionId：join 语义——等待同一 in-flight restore，不报错不双跑（crash-resilience D7-③）', async () => {
    // [HISTORICAL] 本用例原断言第二个并发调用被 already being restored 拒绝（throw 语义）；
    // u8（crash-resilience D7-③）把 throw 改为 join：自动恢复落地后恢复窗口内用户发消息
    // 是常态路径，第二个调用必须等待同一 in-flight Promise 完成后继续。
    const { svc } = makeEnv_m3_m3(() => undefined)
    // 让 restore 内核挂起，模拟并发 restore 窗口
    let resolveRestore!: (v: SessionSummary) => void
    const pending = new Promise<SessionSummary>((r) => { resolveRestore = r })
    const kernelSpy = spyRestoreKernel(svc).mockReturnValueOnce(pending)

    const first = svc.ensureActive('sid-dedup')
    const second = svc.ensureActive('sid-dedup')
    // join：restore 内核只进入一次（没有第二路并发 restore）
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    resolveRestore({} as SessionSummary)
    // 双方都等恢复完成后继续；随后都因 getClient 无 client 而 reject（符合无进程的真实场景，
    // 同一失败 = join 透传）
    await expect(first).rejects.toThrow('client not available')
    await expect(second).rejects.toThrow('client not available')
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    kernelSpy.mockRestore()
  })

  it('seat 缺省（未注入）时 restore 内核同步进入：ensureActive() 调用零微任务让步（idle-pi-reclamation u2 回归锁定）', async () => {
    // u2（idle-pi-reclamation D6-2）曾把 seat 等待写成无条件 `await awaitReclaimSeatRelease`：
    // async 函数即使 seat 缺省同步 return，await 也让 restore 入口晚一个微任务，破坏
    // 「seat 缺省 = 行为不变」契约（同步断言 spy 次数得 0；respawn ③b 的 deferred 注册
    // 窗口失效 → 5s 超时）。现实现为同步短路检查：seat 未命中不产生任何微任务——
    // 本用例在首个 await 之前同步断言 restore 已进入，锁定零让步属性。
    const { svc } = makeEnv_m3_m3(() => undefined)
    const kernelSpy = spyRestoreKernel(svc).mockResolvedValue({} as SessionSummary)

    const active = svc.ensureActive('sid-sync-entry')

    // 同步断言（位于任何 await 之前）：restore 内核在 ensureActive() 调用的同步执行段内已进入
    expect(kernelSpy).toHaveBeenCalledTimes(1)

    // 收尾消费 rejection（restore 完成后 getClient 无 client，符合无进程场景），防 unhandled
    await expect(active).rejects.toThrow('client not available')
    kernelSpy.mockRestore()
  })

  it('restoreSession 找不到持久化 session 时错误文案含恢复指引（§6.9/§7.3）', async () => {
    // 真 restoreSession 的 not-found 分支：scanSessions 恒 [] → findScannedSession 落空，
    // 在任何磁盘读/spawn 之前 throw，无 IO。错误经 ensureRestored join 注册表原样透传 facade。
    const { svc } = makeEnv_m3_m3(() => undefined)

    await expect(svc.restoreSession('nope-session')).rejects.toThrow(
      'Persisted session nope-session not found — 该会话无已保存内容（进程在首次保存前退出），请新建会话',
    )
    await expect(svc.restoreSession('nope-session')).rejects.toThrow('请新建会话')
  })
})
})
describe('btw-ensure-branch', () => {
/**
 * ensureActive 的 btw 分支（btw-question B3 裁决，M2-b）——回收后续问的附着入口。
 *
 * 锁定语义：
 * - btw 线 session id + 已注入 BtwService → 转 ensureProcess（自建附着编排：alive → markActivity
 *   直返 / 回收死亡 → spawn→switch→附着断言 reattach，D1⑥/V5），分支先于既有
 *   pm.getClient / restore 链（restore 路径 findScannedSession 只扫 sessions/，对 btw 线
 *   构造性失败——V5 核实结论）；
 * - 非 btw sid + 已注入 → 分支不命中，既有链零变更；
 * - btw 线 session id + 未注入 BtwService（存量测试构造）→ fall through 零变更；
 * - 附着失败 BtwError 原样上抛（code 保留）——message.send 路径由
 *   dispatcher.ensureActiveOrBroadcast 统一处理 message.error（错误文案带恢复指引）。
 *
 * 构造模式：session-service-ensure-active.test.ts 的 makeEnv_m3_m3 轻量桩（mock pm/broker/
 * adapterFactory，未被测路径的依赖给最小桩）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/btw-ensure-branch.test.ts
 */
/** btw 线 session id（W4a 键统一后 = pi 真实会话 id，与生产同形态）。 */
const LINE_ID = 'thread-para'

/** 最小假 client：ensureActive 分支只消费身份。 */
function makeClient_m2_m2(exited: boolean): IPiEngine {
  return { exited } as unknown as IPiEngine
}

function makeEnv_m3_m3(getClientImpl: (sessionId: string) => IPiEngine | undefined) {
  const broker = { broadcast: vi.fn((_: ServerMessage) => {}) } as unknown as IMessageBroker
  const getClient = vi.fn(getClientImpl)
  const pm = {
    onSessionExit: vi.fn(() => () => {}),
    getClient,
  } as unknown as IProcessManager
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
  return { svc, pm, getClient }
}

describe('SessionService.ensureActive · btw 分支（B3 裁决，M2-b）', () => {
  it('btw 线 session id + 已注入 BtwService → 转 ensureProcess，不进 pm.getClient / restore 链', async () => {
    const attached = makeClient_m2_m2(false)
    const ensureProcess = vi.fn(async () => attached)
    const { svc, getClient } = makeEnv_m3_m3(() => {
      throw new Error('pm.getClient 不应被调用（btw 分支先于既有链）')
    })
    // W4a 判别器 = registry 成员查询（getLine 注入；旧 isBtwVirtualId 前缀判别已删）
    svc.setBtwService({ ensureProcess, getLine: ((id: string) => (id === LINE_ID ? { mainSid: 'main-x' } : undefined)) as never })
    const restoreSpy = vi.spyOn(svc, 'restoreSession')

    const got = await svc.ensureActive(LINE_ID)

    expect(got).toBe(attached)
    expect(ensureProcess).toHaveBeenCalledTimes(1)
    expect(ensureProcess).toHaveBeenCalledWith(LINE_ID)
    expect(getClient).not.toHaveBeenCalled()
    expect(restoreSpy).not.toHaveBeenCalled()
    restoreSpy.mockRestore()
  })

  it('非 btw sid + 已注入 BtwService → 分支不命中，既有链零变更', async () => {
    const live = makeClient_m2_m2(false)
    const ensureProcess = vi.fn()
    const { svc, getClient } = makeEnv_m3_m3(() => live)
    svc.setBtwService({ ensureProcess })
    // 快路径前提 = 完整注册态 [switch-race-window]：活 client + Map 缺条目 = 恢复窗口
    // 半成品，会走恢复内核而非快路径——initializeManagedSession 播种注册态
    await svc.initializeManagedSession('plain-session', live, '/test/cwd', 'label')

    const got = await svc.ensureActive('plain-session')

    expect(got).toBe(live)
    expect(ensureProcess).not.toHaveBeenCalled()
    expect(getClient).toHaveBeenCalledWith('plain-session')
  })

  it('btw 线 session id + 未注入 BtwService → fall through 既有链（存量构造零变更）', async () => {
    const live = makeClient_m2_m2(false)
    const { svc, getClient } = makeEnv_m3_m3(() => live)
    // 快路径前提 = 完整注册态 [switch-race-window]（同上）
    await svc.initializeManagedSession(LINE_ID, live, '/test/cwd', 'label')

    const got = await svc.ensureActive(LINE_ID)

    expect(got).toBe(live)
    expect(getClient).toHaveBeenCalledWith(LINE_ID)
  })

  it('附着失败：BtwError 原样上抛且 code 保留（message.error 收尾链的输入契约）', async () => {
    const ensureProcess = vi.fn(async () => {
      throw new BtwError('thread_file_missing', `[btw] thread session file missing (line had never flushed): /x/${LINE_ID}`)
    })
    const { svc } = makeEnv_m3_m3(() => undefined)
    // getLine 注入命中 = btw 线分支（W4a 判别器）
    svc.setBtwService({ ensureProcess, getLine: ((id: string) => (id === LINE_ID ? { mainSid: 'main-x' } : undefined)) as never })

    await expect(svc.ensureActive(LINE_ID)).rejects.toMatchObject({
      name: 'BtwError',
      code: 'thread_file_missing',
      message: expect.stringContaining('line had never flushed'),
    })
  })
})
})
describe('w09-single-channel-v1', () => {
/**
 * W09 单通道确定性验收（02 文档 §4 V1 的脚本化断言，wave:perf-w09 D1-2）。
 *
 * V1 原文：「同一 session 级消息在 send/bus 层只被 JSON.stringify 一次（ws 层打点计数 = 1）、
 * 只推给订阅该 sid 的连接」。本文件把两条都做成确定性断言（不依赖真实 ws / 真实 pi）：
 *
 * - TC-V1a（bus 层）：publish 一条 stream 消息 → JSON.stringify 恰好 1 次；
 *   订阅该 sid 的 ws 收到 1 条、订阅其它 sid 的 ws / 未订阅 ws 均 0 条。
 * - TC-V1b（send 层集成）：SessionService 的 send 回调（EventAdapter 透传路径）转发
 *   session 级消息 → 全程 JSON.stringify 恰好 1 次（只有 bus 的定向推送一次），
 *   broker.broadcast 0 次（盲广播路径已删）。
 * - TC-V1c（transient）：delta 类不占 seq，同一窗口 stringify 仍恰好 1 次。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/w09-single-channel-v1.test.ts
 */
/** mock ws（BusClient 契约：readyState + send），收集收到的原始 payload 字符串。 */
function createMockWs() {
  const sent: string[] = []
  return {
    readyState: 1 as const,
    sent,
    send: (payload: string) => { sent.push(payload) },
  }
}

/**
 * 构造真实 SessionService + 真实 MessageBus（对齐 session-service-w07-bus.test.ts 的 makeEnv_m3_m3），
 * sendCb 捕获 initializeManagedSession 注入 adapterFactory 的 send 回调。
 */
function makeEnv_m3_m3() {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  const client = { getCommands: vi.fn(async () => []) } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  let sendCb: ((msg: ServerMessage) => void) | null = null
  const captureAdapterFactory = (_sid: string, send: (msg: ServerMessage) => void) => {
    sendCb = send
    return { attach: vi.fn(), detach: vi.fn() }
  }

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    captureAdapterFactory,
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
    { pruneStaleCache: vi.fn() } as never,
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, broker, broadcasts, getSendCb: () => sendCb! }
}

describe('W09 单通道确定性验收（02 §4 V1）', () => {
  let stringifySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stringifySpy = vi.spyOn(JSON, 'stringify')
  })
  afterEach(() => {
    stringifySpy.mockRestore()
  })

  it('TC-V1a: bus.publish 一条 stream 消息 → JSON.stringify 恰好 1 次 + 只推订阅该 sid 的连接', () => {
    const bus = new MessageBus()
    const wsA = createMockWs() // 订阅 sid-1（目标 session）
    const wsB = createMockWs() // 订阅 sid-2（其它 session）
    const wsC = createMockWs() // 未订阅任何 session
    bus.subscribe('sid-1', wsA)
    bus.subscribe('sid-2', wsB)

    stringifySpy.mockClear()
    bus.publish('sid-1', { type: 'message.status', payload: { sessionId: 'sid-1', status: 'thinking' } })

    // 只序列化一次（三个连接总共一次 stringify——序列化与订阅者数解耦）
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    // 只有订阅 sid-1 的连接收到，恰好 1 条
    expect(wsA.sent).toHaveLength(1)
    expect(JSON.parse(wsA.sent[0]!)).toMatchObject({ type: 'message.status', seq: 1 })
    // 订阅其它 sid 的连接、未订阅连接均未收到（V1：每个 panel 只收到自己 session 的消息）
    expect(wsB.sent).toHaveLength(0)
    expect(wsC.sent).toHaveLength(0)
  })

  it('TC-V1b: send 层（SessionService send 回调）转发 session 级消息 → 全程 stringify 恰好 1 次、broadcast 0 次', async () => {
    const { svc, bus, broker, broadcasts, getSendCb } = makeEnv_m3_m3()
    await svc.initializeManagedSession('s-v1', {} as unknown as IPiEngine, '/tmp', 'test')
    const send = getSendCb()

    const online = createMockWs()
    bus.subscribe('s-v1', online)

    stringifySpy.mockClear()
    send({ type: 'message.status', payload: { sessionId: 's-v1', status: 'thinking' } })

    // 单次序列化：send 回调 → bus.publish（seq + ring + 定向推送）是唯一出口，
    // broker.broadcast 路径已删（D1-2），全程 stringify 计数 = 1。
    // 注：registerSession 汇聚点原 session.surfaces 全局广播（W4a 判别器通道）已随 W4b
    // 收编按协议收缩删除——本断言的对象是 send 层转发路径，全局注册事实帧不在单通道管辖范围。
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(broadcasts).toHaveLength(0)
    // 订阅者收到 1 条带 seq 的消息
    expect(online.sent).toHaveLength(1)
    const parsed = JSON.parse(online.sent[0]!) as ServerMessage & { seq?: number }
    expect(parsed.type).toBe('message.status')
    expect(typeof parsed.seq).toBe('number')
  })

  it('TC-V1c: transient delta 不占 seq，同窗口 stringify 仍恰好 1 次', async () => {
    const { svc, bus, getSendCb } = makeEnv_m3_m3()
    await svc.initializeManagedSession('s-v1', {} as unknown as IPiEngine, '/tmp', 'test')
    const send = getSendCb()

    const online = createMockWs()
    bus.subscribe('s-v1', online)

    stringifySpy.mockClear()
    send({ type: 'message.text_delta', payload: { sessionId: 's-v1', delta: 'hi' } })

    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(online.sent).toHaveLength(1)
    // transient 类不分配 seq（D5-1）
    const parsed = JSON.parse(online.sent[0]!) as { type: string; seq?: number }
    expect(parsed.type).toBe('message.text_delta')
    expect(parsed.seq).toBeUndefined()
  })
})
})
});
});
