/**
 * SubagentEngineHistory（extractRecordEngine 路由 / readEngineSubagentHistory 薄调用 / runtime 协议接线 / zcode 三级降级 / pi 契约）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - subagent-engine-history.test.ts
 * - subagent-engine-history-protocol.test.ts
 * - subagent-extractor-engine.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/subagent-engine-history.test.ts
 */

import { describe, expect, it, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../test-guard/integration-gate.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubagentRecord } from '@taiji/shared'
import { SUBAGENT_OUTCOME_PLACEHOLDER } from '@taiji/shared'
import { DEFAULT_SUBAGENT_ENGINE, extractRecordEngine, readEngineSubagentHistory, disposeRuntimeEngineClients, resetRuntimeEngineWiringForTests, setRuntimeDiscoveryOptionsForTests } from '../services/session/subagent-engine-history.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const osHome = vi.hoisted(() => ({ current: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  // ref.current 空串 = 未挂装置（其余来源节），透传真实 homedir；装置节 beforeEach 必设 ref
  return { ...actual, homedir: () => osHome.current || actual.homedir() }
})


describe('subagent-engine-history', () => {
/**
 * subagent-engine-history 薄调用冒烟测试（dual-track-convergence D1）。
 *
 * 读取链本体（三级降级编排 + journal 重放 + 派生视图 + registry 分发）的守护测试在
 * core 侧 session-view-service.test.ts（降级链三分支 / 派生视图 parity / registry 分发 /
 * message_end error 记账）。本文件只断言 runtime 薄层的路由段契约：
 * - pi record → []（A1 守护：pi 历史走调用方 JSONL 直读链）
 * - 非 pi record 缺 handle → core 编排层防御式降级③级（结构兼容 shared Message）
 * - extractRecordEngine 路由判定（缺省 pi / 非空透传）
 */

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'sub-1',
    sessionFile: null,
    agent: 'general-purpose',
    slug: '',
    task: 'do the thing',
    status: 'running',
    startedAt: 1_000,
    ...overrides,
  } as SubagentRecord
}

describe('extractRecordEngine（record 路由段）', () => {
  it('engine 缺失 / 非 string / 空串 → 缺省 pi（存量 record 零迁移）', () => {
    expect(extractRecordEngine(makeRecord())).toBe(DEFAULT_SUBAGENT_ENGINE)
    expect(extractRecordEngine(makeRecord({ engine: '' } as Partial<SubagentRecord>))).toBe('pi')
    expect(
      extractRecordEngine(makeRecord({ engine: 1 } as unknown as Partial<SubagentRecord>)),
    ).toBe('pi')
  })

  it('非空 string 透传', () => {
    expect(extractRecordEngine(makeRecord({ engine: 'zcode' } as Partial<SubagentRecord>))).toBe(
      'zcode',
    )
  })

  it('有原生引擎锚却缺 engine → 抛身份域错误（不按 pi 走直读链）', () => {
    const damaged = makeRecord({
      engine: undefined,
      engineHandle: {
        sessionRef: { sessionId: 'z-1', dbPath: '/tmp/zcode.sqlite' },
        poolKey: 'shared',
      },
    } as unknown as Partial<SubagentRecord>)
    let thrown: unknown
    try {
      extractRecordEngine(damaged)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as { code?: string }).code).toBe('record_engine_identity_missing')
    expect((thrown as Error).message).toContain('sub-1')
  })
})

describe('readEngineSubagentHistory（薄调用 core 单一实现）', () => {
  it('pi record → []（pi 历史不走本链，调用方走 JSONL 直读）', async () => {
    expect(await readEngineSubagentHistory(makeRecord(), '/tmp')).toEqual([])
  })

  it('zcode record 缺 engineHandle → ③级 outcome-only（永不空数组，结构兼容 Message）', async () => {
    const messages = await readEngineSubagentHistory(
      makeRecord({
        engine: 'zcode',
        result: 'final answer',
        endedAt: 2_000,
      } as Partial<SubagentRecord>),
      '/tmp',
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'do the thing',
      status: 'complete',
      timestamp: 1_000,
    })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'final answer',
      status: 'complete',
      timestamp: 2_000,
    })
  })

  it('未来引擎（无 reader 注册）→ ③级保底，不抛崩溃', async () => {
    const messages = await readEngineSubagentHistory(
      makeRecord({ engine: 'kimi', error: 'boom' } as Partial<SubagentRecord>),
      '/tmp',
    )
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ content: 'boom', status: 'error', error: 'boom' })
  })
})
})

describe('subagent-engine-history-protocol', () => {
// subagent-engine-history 协议客户端接线测试（W8 宿主接线，impl-plan §2.8 验收）。
//
// 覆盖范围（真实 spawn fake 引擎 CLI——协议 IO 全真，fake 只是引擎实现替身）：
// ① 三级发现消费（L1 TAIJI_AGENT_ENGINE_ROOTS → manifest 自注册 → 按需 spawn）；
// ② read 走协议（native reader 覆盖后 core 链①级 = 协议 read，派生视图复用）；
// ③ 协议失败降②级 journal / 引擎未发现降③级 outcome-only（GUI source 标注的
//    数据源契约 = SessionView.source，降级事实 warn 留痕）；
// [ADR-0122 退役登记] ④ idle 5min 复用窗口与 ⑤ dispose 聚合上界用例已随机制删除
// （引擎实例进程级自持，复用语义改为「同实例恒复用直至 shutdown dispose」）。

// 产物挪目录修正：fixtures 资源锚点按产物位置重写（原节位于 session/__tests__）
const FIXTURE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../services/session/__tests__/fixtures/fake-engine-cli.mjs')

const FAKE_CAPABILITIES = {
  schemaEnforcement: 'emulated',
  steer: 'unsupported',
  conversation: 'unsupported',
  personaInjection: 'prompt',
  eventGranularity: 'coarse',
  sandbox: 'none',
  sessionRead: 'full',
  resume: 'cold',
  interrupt: 'kill-only',
  permissionMode: 'ignored',
  maxTurns: false,
}

let tmpDir: string
let rootsDir: string
let dataDir: string
let spawnLog: string
const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** 在发现根写一个 fake 引擎包（manifest + 可执行 bin），返回包目录。 */
function makeFakeEnginePkg(engineId: string, modeArgs: string[] = []): string {
  const pkgDir = path.join(rootsDir, `${engineId}-subagent-cli`)
  const binDir = path.join(pkgDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const pkg = {
    name: `@zhushanwen/${engineId}-subagent-cli`,
    version: '0.0.0',
    bin: { [`${engineId}-subagent-cli`]: 'bin/cli.mjs' },
    'taiji': {
      subagentEngine: {
        id: engineId,
        bin: `${engineId}-subagent-cli`,
        protocol: 1,
        capabilities: FAKE_CAPABILITIES,
        envPrefixes: ['FAKE_'],
        displayName: engineId,
      },
    },
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2))
  // fixture 自带 shebang（直接执行形态与 cliPath 形态共用同一份）。
  const body = fs.readFileSync(FIXTURE_CLI, 'utf8')
  fs.writeFileSync(path.join(binDir, 'cli.mjs'), body)
  fs.chmodSync(path.join(binDir, 'cli.mjs'), 0o755)
  void modeArgs
  return pkgDir
}

function makeRecord(overrides: Partial<Record<string, unknown>> = {}): SubagentRecord {
  return {
    subagentId: 'sub-1',
    task: 'demo task',
    agent: 'worker',
    model: 'test-model',
    mode: 'background',
    slug: 'demo',
    startedAt: Date.now(),
    engine: 'fake',
    engineHandle: { sessionRef: { sessionId: 's-1' }, poolKey: 'shared' },
    ...overrides,
  } as unknown as SubagentRecord
}

function spawnLogPids(): string[] {
  try {
    return fs.readFileSync(spawnLog, 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}

function truncateSpawnLog(): void {
  fs.writeFileSync(spawnLog, '')
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-engine-history-'))
  rootsDir = path.join(tmpDir, 'roots')
  dataDir = path.join(tmpDir, 'data')
  fs.mkdirSync(path.join(dataDir, 'engines', 'fake', 'shared'), { recursive: true })
  spawnLog = path.join(tmpDir, 'spawn.log')
  makeFakeEnginePkg('fake')
  setEnv('TAIJI_AGENT_ENGINE_ROOTS', rootsDir)
  setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
  setEnv('FAKE_SPAWN_LOG', spawnLog)
  setEnv('TAIJI_AGENT_ENGINE_NODE', undefined)
})

afterEach(() => {
  resetRuntimeEngineWiringForTests()
  // env 泄漏防护：每个用例结束时恢复发现根与 CLI 模式（用例内只允许短暂改写）。
  setEnv('TAIJI_AGENT_ENGINE_ROOTS', rootsDir)
  setEnv('FAKE_READ_MODE', 'ok')
  setEnv('FAKE_DISPOSE_MODE', 'ok')
})

afterAll(async () => {
  await disposeRuntimeEngineClients()
  for (const [key, value] of savedEnv) setEnv(key, value)
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `W8 runtime 协议客户端接线（subagent-engine-history）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
  it('①+② 三级发现消费 + read 走协议：L1 env 根的 fake 引擎被 spawn，①级内容来自协议 read', async () => {
    const messages = await readEngineSubagentHistory(makeRecord(), dataDir)
    // 'fake turn' 只可能来自 fake CLI 的协议 read 应答——内建 reader 链对该 id 落
    // outcome-only（"(no outcome recorded)"），协议链生效即此断言成立。
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('fake turn')
    // user task 前置派生视图（core 派生视图链复用）。
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('demo task')
    expect(spawnLogPids()).toHaveLength(1)
  })

  it('④ 实例复用：多次 read 零新 spawn（引擎实例自持直至 shutdown dispose）', async () => {
    truncateSpawnLog()
    await readEngineSubagentHistory(makeRecord(), dataDir)
    await readEngineSubagentHistory(makeRecord(), dataDir)
    await readEngineSubagentHistory(makeRecord(), dataDir)
    expect(spawnLogPids()).toHaveLength(1) // 同引擎实例恒复用
  }, 20_000)

  it('③ 协议 read 失败降②级 journal：eventsPath 白名单内事件重放派生视图', async () => {
    setEnv('FAKE_READ_MODE', 'error')
    const eventsPath = path.join(dataDir, 'engines', 'fake', 'shared', 'journal-j1.jsonl')
    // 行 schema = JournalLine（event-journal parseLine 检查：v:1 + ts/seq + event.type）。
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ v: 1, ts: Date.now(), taskId: 'j1', engineId: 'fake', seq: 1, event: { type: 'text_delta', delta: 'journal tier text' } }),
        JSON.stringify({ v: 1, ts: Date.now(), taskId: 'j1', engineId: 'fake', seq: 2, event: { type: 'turn_end' } }),
        '',
      ].join('\n'),
    )
    const messages = await readEngineSubagentHistory(
      makeRecord({ engineHandle: { sessionRef: { sessionId: 's-1' }, poolKey: 'shared', eventsPath } }),
      dataDir,
    )
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('journal tier text')
    setEnv('FAKE_READ_MODE', 'ok')
  }, 20_000)

  it('③ 引擎未发现降③级 outcome-only：零发现根时返回摘要卡内容', async () => {
    setEnv('TAIJI_AGENT_ENGINE_ROOTS', path.join(tmpDir, 'empty-roots'))
    const messages = await readEngineSubagentHistory(makeRecord({ engine: 'missing' }), dataDir)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('(no outcome recorded)')
  })

})
})

describe('subagent-extractor-engine', () => {
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
// Mock node:os — keep all real exports, override homedir（宿主 db（存量兼容）用例的
// 受控宿主 HOME；缺省占位值不影响其余用例——它们不经绝对 dbPath 分支的白名单比对）

/** 写侧契约形状（record.engine / record.engineHandle——防御式消费的镜像构造）。 */
type EngineAwareRecord = SubagentRecord & { engine?: string; engineHandle?: unknown }

interface EngineHandleShape {
  sessionRef: Record<string, string>
  eventsPath?: string
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
    status: 'idle', // [U6] closed legacy 值已收窄出类型——终态 fixture 用归一后的两态词
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

/** 建出与 zcode 0.16.5 同形的三表最小 schema（zcode reader ①级的真实读侧）。
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

  it('treats malformed engine values as pi（防御式检查）', () => {
    expect(extractRecordEngine(zcodeRecord(undefined, 42 as never))).toBe('pi')
    expect(extractRecordEngine(zcodeRecord(undefined, ''))).toBe('pi')
  })
})

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `readEngineSubagentHistory（zcode 三级降级）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
  it('W8 反转：runtime ①级走协议 read，隔离库 dbPath 在白名单内也不再直读——降②级 journal', async () => {
    // [W8 D9 反转] runtime 不再 import 引擎实现直读 sqlite：①级 = 协议 read（spawn
    // 引擎 CLI）。db fixture 存在且路径在白名单集合内也不被 runtime 消费——本用例
    // 以「发现确定性为零」（nodeModuleRoots: [] + 空 env）阻断协议 read，断言降②级
    // journal 派生视图（db 白名单/shared reader 的守护已随逻辑留在 core，由
    // session-view-service-zcode-dbpath.test.ts 承担）。
    setRuntimeDiscoveryOptionsForTests({ nodeModuleRoots: [], env: {} })
    const isolatedDb = join(dataDir, 'engines', 'zcode', 'session-db', 'db.sqlite')
    await createPoolDb(SESSION_ID, isolatedDb)
    const eventsPath = writeJournal([
      journalLine(0, { type: 'text_delta', delta: 'partial ' }),
      journalLine(1, { type: 'text_delta', delta: 'answer' }),
      journalLine(2, { type: 'turn_end' }),
    ])
    const messages = await readEngineSubagentHistory(
      zcodeRecord({
        sessionRef: { dbPath: isolatedDb, sessionId: SESSION_ID },
        eventsPath,
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
      osHome.current = ''
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

    // db 存在但 runtime 不直读（①级已外移引擎协议范围）→ ③级
    expect(messages).toHaveLength(2)
    expect(messages[1]?.content).toBe('LGTM outcome text')
    expect(JSON.stringify(messages)).not.toContain('thinking hard')
  })

  it('tier2: falls back to journal replay when db is missing', async () => {
    const eventsPath = writeJournal([
      journalLine(0, { type: 'text_delta', delta: 'partial ' }),
      journalLine(1, { type: 'text_delta', delta: 'answer' }),
      journalLine(2, { type: 'tool_start', toolName: 'Read', args: { path: 'a.ts' } }),
      journalLine(3, { type: 'tool_end', toolName: 'Read', result: { content: ['x'] } }),
      journalLine(4, { type: 'message_end', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } }),
      journalLine(5, { type: 'turn_end' }),
    ])

    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, eventsPath, poolKey: POOL_KEY }),
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
    // ① 发现隔离——宿主 shell 若泄漏 TAIJI_AGENT_ENGINE_ROOTS（如 TaiJi.app 打包会话
    // env——L1 发现根指向 /Applications/TaiJi.app/.../engines），缺省发现会装载真实
    // zcode 引擎，①级协议 read 生效后走引擎侧 read()；
    // ② protocolEntries 缓存清扫——本文件内未隔离的前序用例（tier2 journal 重放）
    // 在泄漏 env 下已 spawn 真实引擎并缓存（模块级 Map，idle 5min），仅隔离发现会被
    // 缓存命中旁路（ensureProtocolEntry 先查表）——必须 resetRuntimeEngineWiringForTests
    // 清掉跨用例残留实例。注意调用顺序：reset 会连带把 discoveryOverrides 置
    // undefined（恢复缺省发现），隔离必须后设，顺序颠倒则隔离失效（基线红修复期实测）。
    // 根因形态：引擎侧 journal 重放（zcode-subagent-cli journal-io）无 engines-root
    // 前缀白名单——①级协议 read 把不可信 eventsPath 透传引擎进程直读，越界文件被
    // 读出（断言收到 'STOLEN CONTENT'），用例随宿主 env 非确定性翻红；隔离后本用例
    // 确定性验证本文件头部覆盖点 3：宿主侧②级白名单（core session-view-service
    // readJournalTier 的 isStrictlyUnder(resolveEnginesRoot(dataDir), eventsPath)）
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
        zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, eventsPath: outsideJournal, poolKey: POOL_KEY }),
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

  it('tier1 defined-empty view → 非空壳派生视图，占位 content === shared 常量（D6 契约钉子）', async () => {
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
    // 无 eventsPath → ①空降②、②不可达 → ③级占位派生视图。
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
})
