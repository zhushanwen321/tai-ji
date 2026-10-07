// subagent-engine-history 协议客户端接线测试（W8 宿主接线，impl-plan §2.8 验收）。
//
// 覆盖面（真实 spawn fake 引擎 CLI——协议 IO 全真，fake 只是引擎实现替身）：
// ① 三级发现消费（L1 TAIJI_AGENT_ENGINE_ROOTS → manifest 自注册 → 按需 spawn）；
// ② read 走协议（native reader 覆盖后 core 链①级 = 协议 read，投影复用）；
// ③ 协议失败降②级 journal / 引擎未发现降③级 outcome-only（GUI source 标注的
//    数据源契约 = SessionView.source，降级事实 warn 留痕）；
// [ADR-0122 退役登记] ④ idle 5min 复用窗口与 ⑤ dispose 聚合上界用例已随机制删除
// （引擎实例进程级自持，复用语义改为「同实例恒复用直至 shutdown dispose」）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { SubagentRecord } from '@taiji/shared'
import {
  disposeRuntimeEngineClients,
  readEngineSubagentHistory,
  resetRuntimeEngineWiringForTests,
} from '../subagent-engine-history.js'

const FIXTURE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-engine-cli.mjs')

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

describe('W8 runtime 协议客户端接线（subagent-engine-history）', () => {
  it('①+② 三级发现消费 + read 走协议：L1 env 根的 fake 引擎被 spawn，①级内容来自协议 read', async () => {
    const messages = await readEngineSubagentHistory(makeRecord(), dataDir)
    // 'fake turn' 只可能来自 fake CLI 的协议 read 应答——内建 reader 链对该 id 落
    // outcome-only（"(no outcome recorded)"），协议链生效即此断言成立。
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('fake turn')
    // user task 前置投影（core 投影链复用）。
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

  it('③ 协议 read 失败降②级 journal：eventsPath 白名单内事件重放投影', async () => {
    setEnv('FAKE_READ_MODE', 'error')
    const eventsPath = path.join(dataDir, 'engines', 'fake', 'shared', 'journal-j1.jsonl')
    // 行 schema = JournalLine（event-journal parseLine 守卫：v:1 + ts/seq + event.type）。
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