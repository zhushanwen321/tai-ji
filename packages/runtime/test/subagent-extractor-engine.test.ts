/**
 * P5 分协议历史读取链单测（设计 D6 三级降级；W8 协议化反转后 runtime ①级 = 协议 read）。
 *
 * 覆盖：
 * 1. record 路由段：engine 缺省 pi（存量零迁移）/ zcode / 畸形值防御
 * 2. zcode record ①→②→③ 三级降级（[W8] ①级 = 协议 read，不再直读 sqlite——
 *    三个原 tier1 sqlite 直读用例改写为反转语义：db fixture 存在也不被读，发现
 *    被阻断（nodeModuleRoots: [] + 空 env）时确定降②/③级；白名单与 shared reader
 *    守护随逻辑留 core（session-view-service-zcode-dbpath.test.ts））
 * 3. journal 前缀白名单：越界路径（dataDir 外 / ../ 逃逸形态）拒绝且不读文件、降③级
 * 4. pi record → 空数组（调用方走现有 JSONL 直读链的契约，A1 守护）
 *
 * engine/engineHandle 字段按并行任务契约防御式构造（shared SubagentRecord 字段由该
 * 任务写入，落地前类型上不存在——测试用交叉类型模拟写侧产物）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SUBAGENT_ENGINE,
  extractRecordEngine,
  readEngineSubagentHistory,
  resetRuntimeEngineWiringForTests,
  setRuntimeDiscoveryOptionsForTests,
} from '../src/services/session/subagent-engine-history.js'
import type { SubagentRecord } from '@xyz-agent/shared'
import { SUBAGENT_OUTCOME_PLACEHOLDER } from '@xyz-agent/shared'

// Mock node:os — keep all real exports, override homedir（宿主 db（存量兼容）用例的
// 受控宿主 HOME；缺省占位值不影响其余用例——它们不经绝对 dbPath 分支的白名单比对）
const osHome = vi.hoisted(() => ({ current: '/mock/home' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => osHome.current }
})

/** 写侧契约形状（record.engine / record.engineHandle——防御式消费的镜像构造）。 */
type EngineAwareRecord = SubagentRecord & { engine?: string; engineHandle?: unknown }

interface EngineHandleShape {
  sessionRef: Record<string, string>
  journalPath?: string
  poolKey: string
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sa-engine-reader-'))
})

afterEach(() => {
  setRuntimeDiscoveryOptionsForTests(undefined) // 恢复缺省发现推导（防 override 跨用例残留）
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function zcodeRecord(handle: EngineHandleShape | undefined, engine = 'zcode'): EngineAwareRecord {
  const base: SubagentRecord = {
    subagentId: 'bg-1-test',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'rev',
    task: 'review the code',
    status: 'closed',
    startedAt: 1756000000000,
    endedAt: 1756000005000,
    result: 'LGTM outcome text',
  }
  return { ...base, engine, ...(handle !== undefined ? { engineHandle: handle } : {}) }
}

const POOL_KEY = 'reviewer'
const DB_RELATIVE = '.zcode/cli/db/db.sqlite'
const SESSION_ID = 'sess-target'

/** 池目录布局与 extension 写侧同源（paths.ts SSOT 的消费镜像）。 */
function poolDir(): string {
  return join(dataDir, 'engines', 'zcode', POOL_KEY)
}

/** 建出与 zcode 0.16.5 同形的三表最小 schema（zcode reader ①级的真实读取面）。
 * dbFile 缺省落池目录；宿主 db（存量兼容）用例显式传入 <home>/.zcode/cli/db/db.sqlite，
 * 隔离库（现役）用例显式传入 <dataDir>/engines/zcode/session-db/db.sqlite。 */
async function createPoolDb(sessionId: string, dbFile = join(poolDir(), DB_RELATIVE)): Promise<void> {
  mkdirSync(join(dbFile, '..'), { recursive: true })
  const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => unknown }
  type Db = {
    exec: (s: string) => void
    prepare: (s: string) => { run: (...a: unknown[]) => void }
    close: () => void
  }
  const db = new DatabaseSync(dbFile) as unknown as Db
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);' +
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);' +
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);',
  )
  const insertSession = db.prepare('INSERT INTO session (id, time_created) VALUES (?, ?)')
  const insertMessage = db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
  const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')

  insertSession.run(sessionId, 2000)
  // user prompt（不进 turns——SessionView 是 assistant 视角）
  insertMessage.run('msg_user', sessionId, 0, JSON.stringify({ role: 'user' }))
  insertPart.run('p_u', 'msg_user', sessionId, 0, JSON.stringify({ type: 'text', text: 'the task' }))

  // assistant：turn1 = reasoning + tool + step-finish(usage)，turn2 = text + step-finish(usage)
  insertMessage.run('msg_asst', sessionId, 1, JSON.stringify({ role: 'assistant' }))
  insertPart.run('p0', 'msg_asst', sessionId, 0, JSON.stringify({ type: 'step-start' }))
  insertPart.run('p1', 'msg_asst', sessionId, 1, JSON.stringify({ type: 'reasoning', text: 'thinking hard' }))
  insertPart.run(
    'p2',
    'msg_asst',
    sessionId,
    2,
    JSON.stringify({
      type: 'tool',
      tool: 'Bash',
      state: JSON.stringify({ status: 'completed', input: { command: 'ls' }, output: 'file-a' }),
    }),
  )
  insertPart.run(
    'p3',
    'msg_asst',
    sessionId,
    3,
    JSON.stringify({ type: 'step-finish', tokens: { input: 10, output: 5, cache: { read: 1, write: 2 } } }),
  )
  insertPart.run('p4', 'msg_asst', sessionId, 4, JSON.stringify({ type: 'text', text: 'done text' }))
  insertPart.run(
    'p5',
    'msg_asst',
    sessionId,
    5,
    JSON.stringify({ type: 'step-finish', tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } }),
  )
  db.close()
}

/** journal 行（extension common/event-journal.ts JournalLine v1 的写侧镜像）。 */
function journalLine(seq: number, event: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ts: 1756000000000 + seq, taskId: 'bg-1-test', engineId: 'zcode', seq, event })
}

function writeJournal(lines: string[]): string {
  const file = join(poolDir(), 'journal-bg-1-test.jsonl')
  mkdirSync(poolDir(), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8')
  return file
}

describe('extractRecordEngine（record 路由段）', () => {
  it('routes records without engine field to pi (存量零迁移)', () => {
    const record = zcodeRecord(undefined, undefined)
    delete (record as { engine?: string }).engine
    expect(extractRecordEngine(record)).toBe('pi')
    expect(DEFAULT_SUBAGENT_ENGINE).toBe('pi')
  })

  it('routes zcode records by engine field', () => {
    expect(extractRecordEngine(zcodeRecord(undefined))).toBe('zcode')
  })

  it('treats malformed engine values as pi（防御式守卫）', () => {
    expect(extractRecordEngine(zcodeRecord(undefined, 42 as never))).toBe('pi')
    expect(extractRecordEngine(zcodeRecord(undefined, ''))).toBe('pi')
  })
})

describe('readEngineSubagentHistory（zcode 三级降级）', () => {
  it('W8 反转：runtime ①级走协议 read，隔离库 dbPath 在白名单内也不再直读——降②级 journal', async () => {
    // [W8 D9 反转] runtime 不再 import 引擎实现直读 sqlite：①级 = 协议 read（spawn
    // 引擎 CLI）。db fixture 存在且路径在白名单集合内也不被 runtime 消费——本用例
    // 以「发现确定性为零」（nodeModuleRoots: [] + 空 env）阻断协议 read，断言降②级
    // journal 投影（db 白名单/shared reader 的守护已随逻辑留在 core，由
    // session-view-service-zcode-dbpath.test.ts 承担）。
    setRuntimeDiscoveryOptionsForTests({ nodeModuleRoots: [], env: {} })
    const isolatedDb = join(dataDir, 'engines', 'zcode', 'session-db', 'db.sqlite')
    await createPoolDb(SESSION_ID, isolatedDb)
    const journalPath = writeJournal([
      journalLine(0, { type: 'text_delta', delta: 'partial ' }),
      journalLine(1, { type: 'text_delta', delta: 'answer' }),
      journalLine(2, { type: 'turn_end' }),
    ])
    const messages = await readEngineSubagentHistory(
      zcodeRecord({
        sessionRef: { dbPath: isolatedDb, sessionId: SESSION_ID },
        journalPath,
        poolKey: POOL_KEY,
      }),
      dataDir,
    )
    // ②级 journal 生效（非①级 db 直读）：assistant = journal 重放文本
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('partial answer')
  })

  it('W8 反转：宿主库存量 dbPath 同样不直读——无 journal 时降③级 outcome-only', async () => {
    setRuntimeDiscoveryOptionsForTests({ nodeModuleRoots: [], env: {} })
    // homedir mock 指向 tmp 构造的宿主 HOME，db 建在 <home>/.zcode/cli/db/db.sqlite
    // （存量 record 的绝对 dbPath 形态）——db 存在也未被读取：runtime 零 sqlite 通道
    const hostHome = mkdtempSync(join(tmpdir(), 'sa-host-home-'))
    osHome.current = hostHome
    try {
      const hostDb = join(hostHome, DB_RELATIVE)
      await createPoolDb(SESSION_ID, hostDb)
      const messages = await readEngineSubagentHistory(
        zcodeRecord({ sessionRef: { dbPath: hostDb, sessionId: SESSION_ID }, poolKey: POOL_KEY }),
        dataDir,
      )
      // ③级 outcome（db 不被读）
      expect(messages).toHaveLength(2)
      expect(messages[1]?.content).toBe('LGTM outcome text')
      expect(JSON.stringify(messages)).not.toContain('done text')
    } finally {
      osHome.current = '/mock/home'
      rmSync(hostHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('W8 反转：池内相对 dbPath 同理不直读——降③级 outcome-only', async () => {
    setRuntimeDiscoveryOptionsForTests({ nodeModuleRoots: [], env: {} })
    await createPoolDb(SESSION_ID)
    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, poolKey: POOL_KEY }),
      dataDir,
    )

    // db 存在但 runtime 不直读（①级已外移引擎协议面）→ ③级
    expect(messages).toHaveLength(2)
    expect(messages[1]?.content).toBe('LGTM outcome text')
    expect(JSON.stringify(messages)).not.toContain('thinking hard')
  })

  it('tier2: falls back to journal replay when db is missing', async () => {
    const journalPath = writeJournal([
      journalLine(0, { type: 'text_delta', delta: 'partial ' }),
      journalLine(1, { type: 'text_delta', delta: 'answer' }),
      journalLine(2, { type: 'tool_start', toolName: 'Read', args: { path: 'a.ts' } }),
      journalLine(3, { type: 'tool_end', toolName: 'Read', result: { content: ['x'] } }),
      journalLine(4, { type: 'message_end', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } }),
      journalLine(5, { type: 'turn_end' }),
    ])

    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, journalPath, poolKey: POOL_KEY }),
      dataDir,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('partial answer')
    expect(messages[1]?.toolCalls?.[0]?.toolName).toBe('Read')
    expect(messages[1]?.toolCalls?.[0]?.output).toBe('x')
    expect(messages[1]?.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  it('tier3: projects outcome-only when both db and journal are missing', async () => {
    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, poolKey: POOL_KEY }),
      dataDir,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('review the code')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('LGTM outcome text')
    expect(messages[1]?.status).toBe('complete')
  })

  it('tier3 error shape: error text without result', async () => {
    const base = zcodeRecord({ sessionRef: {}, poolKey: POOL_KEY })
    const record: EngineAwareRecord = { ...base, result: undefined, error: 'engine_run_failed: boom' }
    const messages = await readEngineSubagentHistory(record, dataDir)
    expect(messages[1]?.content).toBe('engine_run_failed: boom')
    expect(messages[1]?.status).toBe('error')
  })

  it('rejects journal path outside engines root without reading it (前缀白名单)', async () => {
    // 越界 journal 指向真实存在的文件且内容是可重放的②级事件——若被读取会产出
    // "from journal"内容；断言输出是③级 outcome 文本即证明未读该文件。
    //
    // [基线红修复] 本用例必须双重隔离（与 W8 反转用例同款 + 缓存清扫）：
    // ① 发现隔离——宿主 shell 若泄漏 XYZ_AGENT_ENGINE_ROOTS（如 TaiJi.app 打包会话
    // env——L1 发现根指向 /Applications/TaiJi.app/.../engines），缺省发现会装载真实
    // zcode 引擎，①级协议 read 生效后走引擎侧 read()；
    // ② protocolEntries 缓存清扫——本文件内未隔离的前序用例（tier2 journal 重放）
    // 在泄漏 env 下已 spawn 真实引擎并缓存（模块级 Map，idle 5min），仅隔离发现会被
    // 缓存命中旁路（ensureProtocolEntry 先查表）——必须 resetRuntimeEngineWiringForTests
    // 清掉跨用例残留实例。注意调用顺序：reset 会连带把 discoveryOverrides 置
    // undefined（恢复缺省发现），隔离必须后设，顺序颠倒则隔离失效（基线红修复期实测）。
    // 根因形态：引擎侧 journal 重放（zcode-subagent-cli journal-io）无 engines-root
    // 前缀白名单——①级协议 read 把不可信 journalPath 透传引擎进程直读，越界文件被
    // 读出（断言收到 'STOLEN CONTENT'），用例随宿主 env 非确定性翻红；隔离后本用例
    // 确定性验证本文件头部覆盖点 3：宿主侧②级白名单（core session-view-service
    // readJournalTier 的 isStrictlyUnder(resolveEnginesRoot(dataDir), journalPath)）
    // 拒绝越界路径且不读文件、降③级。引擎侧缺口是独立产品问题，登记在 u9 验收
    // 报告 blockers（领地 = zcode-subagent-cli，超出本单元）。
    // 清扫先行（reset 会把 discoveryOverrides 一并置 undefined——隔离必须后设，顺序不可倒）
    resetRuntimeEngineWiringForTests()
    setRuntimeDiscoveryOptionsForTests({ nodeModuleRoots: [], env: {} })
    const outsideDir = mkdtempSync(join(tmpdir(), 'sa-outside-'))
    const outsideJournal = join(outsideDir, 'journal-stolen.jsonl')
    writeFileSync(outsideJournal, `${journalLine(0, { type: 'text_delta', delta: 'STOLEN CONTENT' })}\n`, 'utf-8')

    try {
      const messages = await readEngineSubagentHistory(
        zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, journalPath: outsideJournal, poolKey: POOL_KEY }),
        dataDir,
      )
      expect(messages[1]?.content).toBe('LGTM outcome text')
      expect(JSON.stringify(messages)).not.toContain('STOLEN')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('rejects db path escaping the pool dir (①级白名单)', async () => {
    // 绝对路径形态落在池外（/tmp 下）——resolve 后不在 poolDir 内必须被拒绝
    const outsideDb = join(dataDir, 'outside.sqlite')
    const messages = await readEngineSubagentHistory(
      zcodeRecord({
        sessionRef: { dbPath: outsideDb, sessionId: SESSION_ID },
        poolKey: POOL_KEY,
      }),
      dataDir,
    )
    // ①级拒绝 + 无 journal → ③级
    expect(messages[1]?.content).toBe('LGTM outcome text')
  })

  it('degrades to outcome-only when engineHandle is missing (空值防御)', async () => {
    const messages = await readEngineSubagentHistory(zcodeRecord(undefined), dataDir)
    expect(messages[1]?.content).toBe('LGTM outcome text')
  })

  it('degrades to outcome-only for unknown engines (未来引擎保底)', async () => {
    const messages = await readEngineSubagentHistory(zcodeRecord(undefined, 'claude-code'), dataDir)
    expect(messages[1]?.content).toBe('LGTM outcome text')
  })

  it('tier1 defined-empty view → 非空壳投影，占位 content === shared 常量（D6 契约钉子）', async () => {
    // ①级 defined-empty：db 存在且 session 可读，但 send 后、首个 assistant content
    // 持久化前——collectTurns 只收 assistant 消息 → {turns: [], source: 'native'}。
    // db 建到池内相对路径（createPoolDb 同款 schema），仅插 user prompt。
    const dbFile = join(poolDir(), DB_RELATIVE)
    mkdirSync(join(dbFile, '..'), { recursive: true })
    const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => unknown }
    type Db = {
      exec: (s: string) => void
      prepare: (s: string) => { run: (...a: unknown[]) => void }
      close: () => void
    }
    const db = new DatabaseSync(dbFile) as unknown as Db
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);' +
        'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);' +
        'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);',
    )
    db.prepare('INSERT INTO session (id, time_created) VALUES (?, ?)').run(SESSION_ID, 2000)
    db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)').run(
      'msg_user',
      SESSION_ID,
      0,
      JSON.stringify({ role: 'user' }),
    )
    db.close()

    // fixture 约束（设计 D6）：result 与 error 必须双缺——:450 三选一
    // (result ?? error ?? 占位)，带任一则断言走不到占位分支、守护空转。
    // 无 journalPath → ①空降②、②不可达 → ③级占位投影。
    const base = zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, poolKey: POOL_KEY })
    const record: EngineAwareRecord = { ...base, result: undefined, error: undefined }

    const messages = await readEngineSubagentHistory(record, dataDir)
    // 非空壳：≥2 条（task + 占位 assistant），不再返回「仅 task」
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('review the code')
    const placeholder = messages.find((m) => m.role === 'assistant')
    expect(placeholder).toBeDefined()
    // 同值钉子：core ③级本地常量若与 shared 权威值漂移，此处翻红
    expect(placeholder?.content).toBe(SUBAGENT_OUTCOME_PLACEHOLDER)
  })
})

describe('readEngineSubagentHistory（pi 契约）', () => {
  it('returns empty array for pi records — caller keeps existing JSONL chain (A1)', async () => {
    const record = zcodeRecord(undefined, 'pi')
    delete (record as { engineHandle?: unknown }).engineHandle
    await expect(readEngineSubagentHistory(record, dataDir)).resolves.toEqual([])
  })
})
