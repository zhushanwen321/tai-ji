import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Check } from 'typebox/value'

import { handleSessionRead } from '../tool-handler.js'
import {
  SQLITE_DRIVER_UNSUPPORTED_MARK,
  ZCODE_DB_MISSING_MARK,
  zcodeReadErrorMessage,
} from '../tool-format.js'
import { SqliteUnreadableError } from '@zhushanwen/zcode-session-source'
import sessionReaderExtension from '../index.js'
import { setPiHandle } from '@zhushanwen/pi-extension-logger'

// ============================================================
// U9 路由 + 白名单闸 + 错误面集成测试（design session-reader-shared-core
// §3.1 三层定位链 / §3.4 七码 + 检查顺序三段递进 / §4 场景 1a 变体 M/E +
// 场景 2 family + 场景 5 八类失败 + 场景 3 pi 零回归 + D4 schema 零变化）。
//
// fixture 骨架（mkdtemp 自建自删）：root/agent = agentDir（dirname = dataDir）、
// root/engines/zcode/session-db/db.sqlite = 隔离库（白名单精确命中）、
// root/live-sessions = liveSessionDir（entry 兜底候选根）、
// root/agent/sessions = main 默认根（family/rootSession 视图的 header 来源）。
//
// 行集非平凡性：sess_aaa（ZASENTINEL）与 sess_bbb（ZBSENTINEL + ZZQFIXTURE +
// toolCall 对 + compaction part）两个可区分行集——「取首条/合并/读错行集」的
// 实现会直接失败。manifest 锚与 entry 锚刻意指向不同 session（变体 M 的
// instrument：读到 manifest 的 sess_bbb 而非 entry 的 sess_aaa = 走对主路径）。
// ============================================================

const ISOLATED_DB_SEGMENTS = ['engines', 'zcode', 'session-db', 'db.sqlite']

const SA_M = 'sa-fix1' // 变体 M / 八类失败主 sa-id
const SA_E = 'sa-fix2' // 变体 E（manifest 缺位，entry 兜底）
const SESS_A = 'sess_aaa'
const SESS_B = 'sess_bbb'
const ROOT_SESSION = 'root-session-1'
const BASE_MS = 1758379200000

let root: string
let agentDir: string
let dbPath: string
let liveDir: string
let appendEntries: ReturnType<typeof vi.fn>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zcode-routing-test-'))
  agentDir = join(root, 'agent')
  liveDir = join(root, 'live-sessions')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(liveDir, { recursive: true })
  dbPath = join(root, ...ISOLATED_DB_SEGMENTS)
  // 结构化日志捕获：logger.warn 走 appendEntry 通道（不进 LLM 可见面——本文件同时
  // 是「降级留痕不进 LLM 可见面」契约的断言面）。测试后清注入防跨文件泄漏。
  appendEntries = vi.fn()
  setPiHandle({ appendEntry: appendEntries } as unknown as Parameters<typeof setPiHandle>[0])
})
afterEach(() => {
  setPiHandle(undefined)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

interface SessionRows {
  id: string
  title: string
  messages: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>
}

/** sess_aaa 行集：两轮对话，文本带 ZASENTINEL（entry 首条锚指向它）。 */
function sessARows(): SessionRows {
  return {
    id: SESS_A,
    title: 'sess A title',
    messages: [
      userMsg('m1', 0, '第一轮用户提问 ZASENTINEL 锚'),
      assistantMsg('m2', 1, ['第一轮助手回答 ZASENTINEL']),
      userMsg('m3', 2, '第二轮用户提问'),
      assistantMsg('m4', 3, ['第二轮助手回答 ZASENTINEL']),
    ],
  }
}

/** sess_bbb 行集：两轮 + toolCall 对 + ZZQFIXTURE + compaction（manifest 锚指向它）。 */
function sessBRows(): SessionRows {
  return {
    id: SESS_B,
    title: 'sess B title',
    messages: [
      userMsg('m1', 0, '派发任务 ZZQFIXTURE 检索锚点'),
      assistantMsg('m2', 1, [], {
        toolPart: {
          type: 'tool',
          callID: 'tc-1',
          tool: 'Bash',
          state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi' },
        },
        extraParts: [{ type: 'text', text: '工具执行完成', time: { start: BASE_MS + 20 } }],
      }),
      userMsg('m3', 2, '继续第二轮'),
      assistantMsg('m4', 3, ['第二轮 ZBSENTINEL 收尾'], {
        extraParts: [{ type: 'compaction', data: { trigger: 'auto' }, time: { start: BASE_MS + 40 } }],
      }),
    ],
  }
}

function userMsg(id: string, seq: number, text: string): SessionRows['messages'][number] {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text, time: { start: BASE_MS + seq * 10 } }],
  }
}

function assistantMsg(
  id: string,
  seq: number,
  texts: string[],
  opts: { toolPart?: Record<string, unknown>; extraParts?: Array<Record<string, unknown>> } = {},
): SessionRows['messages'][number] {
  const parts: Array<Record<string, unknown>> = []
  if (opts.toolPart) parts.push(opts.toolPart)
  texts.forEach((t, i) => parts.push({ type: 'text', text: t, time: { start: BASE_MS + seq * 10 + i } }))
  if (opts.extraParts) parts.push(...opts.extraParts)
  parts.push({ type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1, total: 2 }, cost: 0 })
  return { id, role: 'assistant', parts }
}

/**
 * 建真实 fixture 隔离库（WAL + session/message/part/schema_migration 四表，行形态 =
 * zcode-session-source helpers 同款宿主 schema 0.16.5 消费面子集）。
 * 测试进程跑 node（node:sqlite 可用）；生产读链的驱动选择在 source 包内。
 */
function createZcodeDb(path: string, schemaVersion = '0.16.5', sessions: SessionRows[] = []): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('BEGIN')
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, ' +
        "task_type TEXT NOT NULL DEFAULT 'interactive', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
    )
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)')
    db.exec('CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)')
    db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run('0001_seed', 'x', schemaVersion, 1)
    const insSession = db.prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    const insMessage = db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
    const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
    for (const [si, s] of sessions.entries()) {
      insSession.run(s.id, '/tmp/fix', s.title, 'interactive', BASE_MS, BASE_MS + si * 10)
      for (const [mi, m] of s.messages.entries()) {
        insMessage.run(`${s.id}_${m.id}`, s.id, mi, JSON.stringify({ role: m.role, time: { created: BASE_MS + mi * 10 } }))
        for (const [pi, p] of m.parts.entries()) {
          insPart.run(`${s.id}_${m.id}_p${pi}`, `${s.id}_${m.id}`, s.id, pi, JSON.stringify(p))
        }
      }
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** zcode manifest（F21 磁盘真实形态：无 sessionFile 键）。 */
function writeZcodeManifest(
  saId: string,
  opts: { sessionRef?: Record<string, string>; omitEngineHandle?: boolean; engine?: string | true } = {},
): void {
  const recordsDir = join(agentDir, 'subagents', 'proj-slug', 'records')
  mkdirSync(recordsDir, { recursive: true })
  const m: Record<string, unknown> = {
    id: saId,
    rootSessionId: ROOT_SESSION,
    agentName: 'worker',
    task: 'fixture task',
    status: 'running',
  }
  m.engine = opts.engine === undefined ? 'zcode' : opts.engine
  if (!opts.omitEngineHandle) {
    m.engineHandle = {
      sessionRef: opts.sessionRef ?? { sessionId: SESS_B, dbPath },
      poolKey: 'shared',
    }
  }
  writeFileSync(join(recordsDir, `${saId}.json`), JSON.stringify(m), 'utf8')
}

/** subagent-record custom entry 行（U7 entry-anchor.test 同款形状）。 */
function recordLine(entryId: string, saId: string, sessionRef: Record<string, string>): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    data: { v: 1, id: saId, engine: 'zcode', engineHandle: { sessionRef, poolKey: 'shared' } },
  })
}

/**
 * pi 形态的 subagent-record custom entry 行（回归 A1 instrument）：engine 键缺省 +
 * sessionRef 无 dbPath——subagent-core record-entry.ts 的 pi 投影形态（engineHandle
 * 可选、sessionRef 整体透传不枚举内部键；最小可信子集，跨包漂移由 entry-anchor.test 守卫）。
 */
function piRecordLine(entryId: string, saId: string): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    data: {
      v: 1,
      id: saId,
      agent: 'pi-agent',
      task: 'pi task',
      slug: 'pi-sub',
      status: 'running',
      mode: 'subagent',
      startedAt: BASE_MS,
      rootSessionId: ROOT_SESSION,
      parentRecordId: null,
      depth: 0,
      turns: 0,
      totalTokens: 0,
      eventLog: [],
      displayItems: [],
      engineHandle: { sessionRef: { sessionId: SESS_A }, poolKey: 'shared' },
    },
  })
}

const HEADER_LINE = JSON.stringify({ type: 'session', id: 'main-session-1', cwd: '/proj' })
const USER_LINE = JSON.stringify({
  type: 'message',
  id: 'u1',
  parentId: null,
  message: { role: 'user', content: [{ type: 'text', text: 'dispatch subagent' }] },
})

/** liveSessionDir 内的主 session 文件（entry 兜底候选）。 */
function writeLiveMainSession(lines: string[]): void {
  writeFileSync(join(liveDir, 'main-session.jsonl'), [HEADER_LINE, USER_LINE, ...lines].join('\n') + '\n', 'utf8')
}

/** main 默认根的 root session（family/rootSessionId 视图的 byId 素材）。 */
function writeRootSessionFile(): void {
  const sessionsDir = join(agentDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, `1700000000000_${ROOT_SESSION}.jsonl`),
    JSON.stringify({ type: 'session', id: ROOT_SESSION, cwd: '/proj' }) + '\n',
    'utf8',
  )
}

/** pi manifest + pi subagent session 文件（pi 穿插断言用；engine 缺省 = pi 存量形态）。 */
function writePiFixture(): void {
  const subDir = join(agentDir, 'subagents', 'pi-slug', 'sessions')
  mkdirSync(subDir, { recursive: true })
  const piSession = join(subDir, '019e6c96-pi-sub-agent-00000000004a4.jsonl')
  writeFileSync(
    piSession,
    [
      JSON.stringify({ type: 'session', id: '019e6c96-pi-sub-agent-00000000004a4', cwd: '/proj' }),
      JSON.stringify({ type: 'message', id: 'p1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'pi task' }] } }),
      JSON.stringify({ type: 'message', id: 'p2', parentId: 'p1', message: { role: 'assistant', content: [{ type: 'text', text: 'PI-SENTINEL 正文内容' }] } }),
    ].join('\n') + '\n',
    'utf8',
  )
  const recordsDir = join(agentDir, 'subagents', 'pi-slug', 'records')
  mkdirSync(recordsDir, { recursive: true })
  writeFileSync(
    join(recordsDir, 'sa-pi-1.json'),
    JSON.stringify({
      id: 'sa-pi-1',
      rootSessionId: ROOT_SESSION,
      agentName: 'pi-agent',
      sessionFile: piSession,
      slug: 'pi-sub',
      status: 'completed',
    }),
    'utf8',
  )
}

const signals = () => ({ agentDir, liveSessionDir: liveDir })

function logCallsWithReason(reason: string): number {
  return appendEntries.mock.calls.filter(
    ([ct, d]) => ct === 'session-reader:log' && (d as { data?: { reason?: string } })?.data?.reason === reason,
  ).length
}

// ---------------------------------------------------------------------------
// 变体 M（manifest 在场，主路径）+ 场景 2 动作覆盖
// ---------------------------------------------------------------------------

describe('变体 M：manifest 主路径（instrument：manifest 锚与 entry 锚不同 session）', () => {
  beforeEach(() => {
    createZcodeDb(dbPath, '0.16.5', [sessARows(), sessBRows()])
    // manifest 锚 → sess_bbb；liveSessionDir entry 锚 → sess_aaa：读到 ZBSENTINEL
    // 而非 ZASENTINEL = 走了 manifest 主路径（entry 兜底未被进入的输出级证据）
    writeZcodeManifest(SA_M)
    writeLiveMainSession([recordLine('e1', SA_M, { sessionId: SESS_A, dbPath })])
    writeRootSessionFile()
  })

  it('outline：读到 manifest 锚的 sess_bbb（ZBSENTINEL 在，ZASENTINEL 不在），两轮 T000/T001', async () => {
    const r = await handleSessionRead({ action: 'outline', session: SA_M }, signals())
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('ZBSENTINEL')
    expect(text).not.toContain('ZASENTINEL')
    expect(text).toContain('T000')
    expect(text).toContain('T001')
    // outline 的 isCompaction 恒 false 属已登记形态（§4 已接受代价）——无独立压缩 turn
    expect(text).not.toContain('compaction')
  })

  it('result：单 id 纯正文 = sess_bbb 最终 assistant 文本（末轮，非仅通知本轮）', async () => {
    const r = await handleSessionRead({ action: 'result', session: SA_M }, signals())
    expect(r.content[0]?.text).toBe('第二轮 ZBSENTINEL 收尾')
  })

  it('result 截断指针：zcode 路由抑制 read 半边（库路径二进制不可 read），只留 session_read detail 可执行半边', async () => {
    const r = await handleSessionRead({ action: 'result', session: SA_M, limit: 5 }, signals())
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('[truncated 5 of')
    // 可执行半边在场（错误 → 权威源 → 重试闭环）
    expect(text).toContain(`session_read { action:"detail", session:"${SA_M}" }`)
    // read 半边被抑制：不指库路径，也不出现 "full text: read" 形态
    expect(text).not.toContain(dbPath)
    expect(text).not.toContain('full text: read')
  })

  it('detail：toolCall 全配对（bash）+ compaction custom entry 形态（渲染现状锚定）', async () => {
    const r = await handleSessionRead({ action: 'detail', session: SA_M, turns: 'T000-T002' }, signals())
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('ZZQFIXTURE')
    expect(text).toContain('bash')
    expect(text).toContain('[custom:zcode-import:compaction]')
    // A6 断言强化①：compaction custom entry 计数等式（fixture 恰 1 个压缩点）——
    // 防「既不多」方向无防护（多插压缩点/重复渲染的实现在此失败）
    expect((text.match(/\[custom:zcode-import:compaction\]/g) ?? []).length).toBe(1)
    // A6 断言强化②：toolCall/toolResult 按 toolCallId 全配对（全文态 entries 直读——
    // 摘要态 ToolResultSummaryEntry 不携带 toolCallId，无法配对）。converter 契约
    // 「未完成 tool 整对丢弃防 dangling」在此以集合配对相等 + 双向 0 dangling 锚定。
    const full = await handleSessionRead(
      { action: 'detail', session: SA_M, turns: 'T000-T002', includeToolResult: true },
      signals(),
    )
    const entries = (full.details as { entries: Array<Record<string, unknown>> }).entries
    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const e of entries) {
      const msg = e.message as { role?: unknown; content?: unknown; toolCallId?: unknown } | undefined
      if (msg === undefined) continue
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'toolCall') {
            const id = (b as Record<string, unknown>).id
            if (typeof id === 'string') callIds.add(id)
          }
        }
      }
      if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
        resultIds.add(msg.toolCallId)
      }
    }
    expect(resultIds).toEqual(callIds) // 配对相等 = 无 toolCall 缺 result、无 result 悬空
    expect(callIds.size).toBe(1) // fixture 恰 1 对（tc-1）——非平凡性锚（空集恒配对不构成证明）
  })

  it('search：ZZQFIXTURE 命中（canonical entries 走既有检索管线）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SA_M, pattern: 'ZZQFIXTURE' }, signals())
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('ZZQFIXTURE')
    expect(text).toContain('1 hit')
  })
})

// ---------------------------------------------------------------------------
// 变体 E（manifest 缺位 → entry 兜底取末条）
// ---------------------------------------------------------------------------

describe('变体 E：manifest 缺位 → entry 兜底（liveSessionDir 内取文件顺序末条）', () => {
  beforeEach(() => {
    createZcodeDb(dbPath, '0.16.5', [sessARows(), sessBRows()])
    // ≥2 条同 sa-id entry：首条 sess_aaa、末条 sess_bbb（F16 每轮覆写）——
    // 取首条/合并的实现会输出 sess_aaa 行集，必失败
    writeLiveMainSession([
      recordLine('e1', SA_E, { sessionId: SESS_A, dbPath }),
      recordLine('e2', SA_E, { sessionId: SESS_B, dbPath }),
    ])
  })

  it('result：兜底命中末条 → sess_bbb 正文（ZBSENTINEL 在，ZASENTINEL 不在）', async () => {
    const r = await handleSessionRead({ action: 'result', session: SA_E }, signals())
    expect(r.content[0]?.text).toBe('第二轮 ZBSENTINEL 收尾')
    expect(r.content[0]?.text).not.toContain('ZASENTINEL')
  })

  it('兜底越界：liveSessionDir 内无该 sa-id 的任何 entry → zcode_record_not_found + 指引', async () => {
    await expect(
      handleSessionRead({ action: 'result', session: 'sa-nowhere-1' }, signals()),
    ).rejects.toThrow(/zcode_record_not_found[\s\S]*👉/)
  })
})

// ---------------------------------------------------------------------------
// 场景 5：八类失败逐一断言（错误码 + 👉 指引 + ④ 顺序断言两种构造）
// ---------------------------------------------------------------------------

describe('场景 5 八类失败（§3.4 表逐行 + 检查顺序三段递进）', () => {
  it('① manifest engine=zcode 但 engineHandle 整体缺席 → zcode_anchor_missing（导入对话框指引）', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeZcodeManifest(SA_M, { omitEngineHandle: true })
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_anchor_missing[\s\S]*导入/,
    )
  })

  it('② entry 的 sessionRef 只留 sessionId、删 dbPath → zcode_anchor_missing + 结构化日志记「缺 dbPath」', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeLiveMainSession([recordLine('e1', SA_M, { sessionId: SESS_B })])
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      'zcode_anchor_missing',
    )
    // 归因进结构化日志不进 LLM 可见面（§3.4）：缺失键名可区分（missing-dbPath）
    expect(logCallsWithReason('missing-dbPath')).toBeGreaterThanOrEqual(1)
  })

  it('③ manifest 删除 + liveSessionDir 内无该 sa-id entry → zcode_record_not_found（三动作指引）', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeLiveMainSession([recordLine('e1', 'sa-other-1', { sessionId: SESS_B, dbPath })])
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_record_not_found[\s\S]*派发的那个会话[\s\S]*family[\s\S]*换一个已完成/,
    )
  })

  it('③b pi 形态 entry（engine 缺省、sessionRef 无 dbPath）在场 + manifest 缺位 → zcode_record_not_found（engine 判别防误归因 anchor_missing）', async () => {
    // 回归 A1：pi record register() 先于 manifest settle 的窗口——manifest 缺位 +
    // entry 为 pi 形态。pi record 不是「旧版本 zcode 产物」（导入对话框指引不适用），
    // 必须落 zcode_record_not_found；误归因 missing-dbPath → zcode_anchor_missing 即红。
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeLiveMainSession([piRecordLine('e-pi-1', SA_M)])
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_record_not_found/,
    )
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.not.toThrow(
      /zcode_anchor_missing/,
    )
  })

  it('④a 顺序断言（构造一）：dbPath 集合外且文件真实存在 → zcode_db_path_forbidden', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    const evilPath = join(root, 'evil-whitelist-probe.sqlite')
    writeFileSync(evilPath, 'not a real db', 'utf8') // 存在性为真 → 走到路径段
    writeZcodeManifest(SA_M, { sessionRef: { sessionId: SESS_B, dbPath: evilPath } })
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_db_path_forbidden[\s\S]*👉/,
    )
    expect(existsSync(evilPath)).toBe(true)
  })

  it('④b 顺序断言（构造二）：同一集合外路径但文件不存在 → zcode_db_unreadable（存在性先于路径）', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    const missingEvil = join(root, 'evil-whitelist-probe-missing.sqlite')
    writeZcodeManifest(SA_M, { sessionRef: { sessionId: SESS_B, dbPath: missingEvil } })
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_db_unreadable[\s\S]*👉/,
    )
  })

  it('⑤ 白名单形态路径但库文件缺席 → zcode_db_unreadable（含 -wal 告诫指引）', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    const missingInLayout = join(root, ...ISOLATED_DB_SEGMENTS.slice(0, -1), 'missing.sqlite')
    writeZcodeManifest(SA_M, { sessionRef: { sessionId: SESS_B, dbPath: missingInLayout } })
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_db_unreadable[\s\S]*👉[\s\S]*-wal/,
    )
  })

  it('⑥ schema_migration 版本超出已知集 → zcode_schema_drift（升级 taiji 指引）', async () => {
    createZcodeDb(dbPath, '9.9.9', [sessBRows()])
    writeZcodeManifest(SA_M)
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_schema_drift[\s\S]*9\.9\.9[\s\S]*👉/,
    )
  })

  it('⑦ 传入 sess_ 形态 id → zcode_param_invalid（换完整 sa- id 指引）', async () => {
    await expect(
      handleSessionRead({ action: 'result', session: SESS_B }, signals()),
    ).rejects.toThrow(/zcode_param_invalid[\s\S]*👉[\s\S]*sa-/)
  })

  it('⑧ 锚可解析 + 库可开 + schema 兼容，但库内 session 行已删 → zcode_session_not_found', async () => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeZcodeManifest(SA_M)
    // 模拟 zcode 侧 GC：删 sess_bbb 的全部行（db 文件与 schema 保留）
    const db = new DatabaseSync(dbPath)
    try {
      db.exec("DELETE FROM part WHERE session_id = 'sess_bbb'")
      db.exec("DELETE FROM message WHERE session_id = 'sess_bbb'")
      db.exec("DELETE FROM session WHERE id = 'sess_bbb'")
    } finally {
      db.close()
    }
    await expect(handleSessionRead({ action: 'result', session: SA_M }, signals())).rejects.toThrow(
      /zcode_session_not_found[\s\S]*👉[\s\S]*原 sa-id[\s\S]*family/,
    )
  })
})

// ---------------------------------------------------------------------------
// 驱动探测失败的错误面契约（跨包漂移守卫 + L4 包装形态映射）
// ---------------------------------------------------------------------------

describe('驱动探测失败错误面：跨包契约 + L4 包装形态映射', () => {
  it('跨包契约：SQLITE_DRIVER_UNSUPPORTED_MARK 子串在 zcode-session-source sqlite-driver 源文内（漂移即红）', () => {
    // 驱动探测错误无专用错误类型（该包不导出子类），reader 按消息特征识别——mark 与
    // sqlite-driver 源内错误字面量的绑定由本测试机器锚定（entry-anchor.test.ts 协议
    // 字面量跨包漂移守卫同范式）：源文措辞变更不再含 mark → host_unsupported 面死亡，红。
    const source = readFileSync(
      new URL('../../../../../packages/zcode-session-source/src/sqlite-driver.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain(SQLITE_DRIVER_UNSUPPORTED_MARK)
  })

  it('L4 包装形态映射：SqliteUnreadableError（message 含 mark，last failure 并入）→ host_unsupported（R1 回归锚）', () => {
    // 生产路径上驱动探测错误恒经 recovery L4 包装（last failure 以字符串并入
    // SqliteUnreadableError.message，mark 随之存活）——直接构造该形态，锁定
    // instanceof 分支内的二次判别（分支顺序错误 → 误落 db_unreadable，本用例红）。
    const wrapped = new SqliteUnreadableError(
      ['L1-direct', 'L2-immutable'],
      'zcode session db unreadable (recovery ladder exhausted): /tmp/none.sqlite — ' +
        `last failure: 当前 node 运行时${SQLITE_DRIVER_UNSUPPORTED_MARK}（需 >=22.13），且宿主非 bun 运行时`,
    )
    const msg = zcodeReadErrorMessage(wrapped, agentDir)
    expect(msg).toContain('zcode_host_unsupported')
    expect(msg).not.toContain('zcode_db_unreadable')
  })

  it('无 mark 的 SqliteUnreadableError 维持 db_unreadable 面（对照：attempted 链进 detail）', () => {
    const plain = new SqliteUnreadableError(
      ['L1-direct'],
      'zcode session db unreadable (recovery ladder exhausted): /tmp/none.sqlite — last failure: file is not a database',
    )
    const msg = zcodeReadErrorMessage(plain, agentDir)
    expect(msg).toContain('zcode_db_unreadable')
    expect(msg).toContain('L1-direct')
    expect(msg).not.toContain('zcode_host_unsupported')
  })

  it('跨包契约：ZCODE_DB_MISSING_MARK 子串在 zcode-session-source sqlite-access 源文内（漂移即红）', () => {
    // 库文件缺失（openZcodeSessionDb 开头 existsSync 失败）无专用错误类型（抛普通
    // Error），reader 按消息特征识别（SQLITE_DRIVER_UNSUPPORTED_MARK 契约测试同范式）：
    // sqlite-access 源文措辞变更不再含 mark → db_unreadable 面死亡、TOCTOU 缺失误标
    // schema_drift，红。
    const source = readFileSync(
      new URL('../../../../../packages/zcode-session-source/src/sqlite-access.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain(ZCODE_DB_MISSING_MARK)
  })

  it('TOCTOU 窗口：开库期库文件缺失普通 Error → db_unreadable 面（不误标 schema_drift，§3.4 第 4 行）', () => {
    // 白名单闸 existsSync 通过后、openZcodeSessionDb 开库前文件被删的窗口：sqlite-access
    // 抛普通 Error「db 文件不存在：<dbPath>」——落 db_unreadable（环境恢复指引），编程
    // 错误兜底（schema_drift）只接真正的查询期 schema 漂移域。
    const msg = zcodeReadErrorMessage(new Error(`db 文件不存在：/tmp/fixture/db.sqlite`), agentDir)
    expect(msg).toContain('zcode_db_unreadable')
    expect(msg).toContain('db 文件不存在：/tmp/fixture/db.sqlite')
    expect(msg).toContain('👉')
    expect(msg).not.toContain('zcode_schema_drift')
  })

  it('对照：不含缺失 mark 的普通 Error 仍落 schema_drift 兜底（编程错误域语义不扩）', () => {
    const msg = zcodeReadErrorMessage(new Error('TypeError: cannot read properties of undefined'), agentDir)
    expect(msg).toContain('zcode_schema_drift')
    expect(msg).not.toContain('zcode_db_unreadable')
  })
})

// ---------------------------------------------------------------------------
// family 接线（buildFamilyFromFs zcode 分支 + sa-id family 路由）
// ---------------------------------------------------------------------------

describe('family：zcode 节点接线（D5-1 两态）与 sa-id family 路由', () => {
  beforeEach(() => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeZcodeManifest(SA_M)
    writeRootSessionFile()
  })

  it('sa-id family：zcode 路由 → rootSessionId 视图，subagents 含 zcode 节点且 cleanedUp=false', async () => {
    const r = await handleSessionRead({ action: 'family', session: SA_M }, signals())
    const text = r.content[0]?.text ?? ''
    expect(text).toContain(SA_M)
    const family = r.details as { subagents: Array<{ sessionId: string; cleanedUp?: boolean }> }
    const node = family.subagents.find((s) => s.sessionId === SA_M)
    expect(node?.cleanedUp).toBe(false) // 库可达态（D5-1：锚可解析 ∧ 库文件存在）
  })

  it('rootSessionId family：buildFamilyFromFs 接线后 zcode 节点进列表（真实 family action 输出）', async () => {
    const r = await handleSessionRead({ action: 'family', session: ROOT_SESSION }, signals())
    const family = r.details as { subagents: Array<{ sessionId: string; cleanedUp?: boolean }> }
    expect(family.subagents.map((s) => s.sessionId)).toContain(SA_M)
  })

  it('库不存在态：dbPath 改指白名单布局内缺席路径 → cleanedUp=true（GC 语义，不报错）', async () => {
    writeZcodeManifest(SA_M, {
      sessionRef: { sessionId: SESS_B, dbPath: join(root, ...ISOLATED_DB_SEGMENTS.slice(0, -1), 'gone.sqlite') },
    })
    const r = await handleSessionRead({ action: 'family', session: ROOT_SESSION }, signals())
    const family = r.details as { subagents: Array<{ sessionId: string; cleanedUp?: boolean }> }
    expect(family.subagents.find((s) => s.sessionId === SA_M)?.cleanedUp).toBe(true)
  })

  it('反向断言：库文件在但库内 session 行被删 → family 仍 cleanedUp=false（列表视图不开库的分工）', async () => {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec("DELETE FROM part WHERE session_id = 'sess_bbb'")
      db.exec("DELETE FROM message WHERE session_id = 'sess_bbb'")
      db.exec("DELETE FROM session WHERE id = 'sess_bbb'")
    } finally {
      db.close()
    }
    const r = await handleSessionRead({ action: 'family', session: ROOT_SESSION }, signals())
    const family = r.details as { subagents: Array<{ sessionId: string; cleanedUp?: boolean }> }
    expect(family.subagents.find((s) => s.sessionId === SA_M)?.cleanedUp).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pi 穿插不受影响（场景 3 抽样：zcode 失败调用穿插前后 pi 输出不变）
// ---------------------------------------------------------------------------

describe('pi 穿插不受影响：同 fixture 内 pi 会话读取与 zcode 调用互不干扰', () => {
  beforeEach(() => {
    createZcodeDb(dbPath, '0.16.5', [sessBRows()])
    writeZcodeManifest(SA_M)
    writePiFixture()
  })

  it('result：pi sa-id 正文穿插 zcode 失败调用前后一致（PI-SENTINEL 恒在）', async () => {
    // zcode 调用先失败（锚缺位形态）
    writeZcodeManifest('sa-broken-1', { omitEngineHandle: true })
    await expect(handleSessionRead({ action: 'result', session: 'sa-broken-1' }, signals())).rejects.toThrow(
      'zcode_anchor_missing',
    )
    const pi = await handleSessionRead({ action: 'result', session: 'sa-pi-1' }, signals())
    expect(pi.content[0]?.text).toContain('PI-SENTINEL 正文内容')
    // 再穿插一次 zcode 成功调用，pi 输出仍一致
    const piAgain = await handleSessionRead({ action: 'result', session: 'sa-pi-1' }, signals())
    expect(piAgain.content[0]?.text).toBe(pi.content[0]?.text)
  })

  it('uuid 形态（resolveSessionId 形态③）与 pi sa-id 现路径零变化', async () => {
    const pi = await handleSessionRead({ action: 'result', session: 'sa-pi-1' }, { agentDir })
    expect(pi.content[0]?.text).toContain('PI-SENTINEL')
  })
})

// ---------------------------------------------------------------------------
// D4 schema 零变化（快照逐字节对照 + 合法形态冒烟）
// ---------------------------------------------------------------------------

/** `session_read` 输入 schema 的 JSON 序列化快照（U9 改动前从基线实现抓取——D4「schema 零变化」的逐字节锚）。 */
const SCHEMA_SNAPSHOT =
  '{"type":"object","required":["action"],"properties":{"action":{"type":"string","enum":["find","f'
    + 'amily","outline","expand","detail","search","export","extract","workflow","result","doctor"],"de'
    + 'scription":"Action to perform: find (locate session), family (fork/subagent/workflow relations; '
    + 'recursive=true returns nested execution tree), outline (turn-level overview), expand (single-tur'
    + 'n entries), detail (full text of turns), search (full-text grep, single session or cross-session'
    + ' over a comma-separated id list), export (materialize to file), extract (pull user messages / co'
    + 'mmands / files / commits / tool results by type), workflow (workflow run overview: status/budget'
    + '/steps; requires session, optional runId focuses one run; step call sessionId jumps to outline/d'
    + 'etail), result (fetch a subagent session final result text — same content as its completion noti'
    + 'ce; session = single id or comma-separated batch of at most 10, optional limit caps chars per it'
    + 'em), doctor (show detected host environment and session-root diagnostics)."},"session":{"type":"'
    + 'string","description":"Session id, uuid fragment (e.g. e6c96), subagent record id (sa-xxx, preci'
    + 'se lookup), or absolute .jsonl path (~ or ~/ allowed). Required for family/outline/expand/detail'
    + '/search/export/extract/workflow/result. result also accepts a comma-separated list of up to 10 i'
    + 'ds. search also accepts a comma-separated list of up to 10 full ids (from find output) for cross'
    + '-session search. # prefix auto-stripped."},"query":{"type":"string","description":"find action: '
    + 'uuid fragment / filename / name keyword / \\"recent\\" (returns most recent N)."},"turns":{"type'
    + '":"string","description":"detail/extract action: turn range, \\"T013-T015\\" or \\"T013\\"."},"t'
    + 'urn":{"type":"string","description":"expand action: single turn, \\"T013\\"."},"pattern":{"type"'
    + ':"string","description":"search action: substring or regex."},"scope":{"type":"string","enum":["'
    + 'all","user","assistant","toolResult"],"description":"search action: scope filter. Default all."}'
    + ',"format":{"type":"string","enum":["outline","full","family"],"description":"export action: mate'
    + 'rialized form. Default outline."},"includeToolResult":{"type":"boolean","description":"detail/ex'
    + 'port: include toolResult full text. Default false (omitted as noise)."},"includeThinking":{"type'
    + '":"boolean","description":"detail: include thinking blocks. Default false (omitted as noise)."},'
    + '"allBranches":{"type":"boolean","description":"outline (and export\'s outline section): include '
    + 'abandoned side-branches. Not supported by family. Default false."},"granularity":{"type":"string'
    + '","enum":["turn","entry"],"description":"outline: turn-level or entry-flat. Default turn."},"cwd'
    + '":{"type":"string","description":"find: filter by cwd. Optional."},"source":{"type":"string","en'
    + 'um":["main","subagent"],"description":"find and session-resolving actions: filter by source. \\"'
    + 'main\\" = sessions/, \\"subagent\\" = subagents/. Default both (merged)."},"limit":{"type":"numb'
    + 'er","minimum":1,"description":"find/search: max results. Default 20. result: max chars per item,'
    + ' default 8000 (overlong text truncated with a pointer to the full file)."},"what":{"type":"strin'
    + 'g","enum":["user-messages","commands","files","commits","tool-results"],"description":"extract a'
    + 'ction: what to extract (required for extract)."},"tool":{"type":"string","description":"extract '
    + 'action: filter commands/tool-results by tool name (e.g. \\"bash\\")."},"runId":{"type":"string",'
    + '"description":"workflow action: focus a single run by runId (disambiguate multiple runs). Omit t'
    + 'o see all run overviews."},"recursive":{"type":"boolean","description":"family action: return ne'
    + 'sted execution tree (arbitrary-depth subagent↔workflow-call nesting, precise parentRecordId chai'
    + 'n with flat-fallback for legacy records). Default false (flat family)."},"includeSubagents":{"ty'
    + 'pe":"boolean","description":"doctor action: also scan the subagent session root (adds its file c'
    + 'ount). Default false (path and existence only)."}}}';

describe('session_read schema 快照（D4：不加任何工具参数，逐字节一致）', () => {
  it('TypeBox schema JSON 序列化与基线快照逐字节一致', () => {
    const registerTool = vi.fn()
    const pi = { registerTool, registerCommand: vi.fn(), addAutocompleteProvider: vi.fn(), on: vi.fn() }
    ;(sessionReaderExtension as unknown as (p: unknown) => void)(pi)
    const toolDef = registerTool.mock.calls[0][0] as { parameters: unknown }
    expect(JSON.stringify(toolDef.parameters)).toBe(SCHEMA_SNAPSHOT)
  })

  it('既有合法调用形态仍通过 schema 校验（无新增必填参数）', () => {
    const registerTool = vi.fn()
    const pi = { registerTool, registerCommand: vi.fn(), addAutocompleteProvider: vi.fn(), on: vi.fn() }
    ;(sessionReaderExtension as unknown as (p: unknown) => void)(pi)
    const schema = (registerTool.mock.calls[0][0] as { parameters: unknown }).parameters
    expect(Check(schema, { action: 'result', session: 'sa-xxx' })).toBe(true)
    expect(Check(schema, { action: 'outline', session: 'e6c96' })).toBe(true)
  })
})
