// subagent-engine-history 协议客户端接线测试（W8 宿主接线，impl-plan §2.8 验收）。
//
// 覆盖面（真实 spawn fake 引擎 CLI——协议 IO 全真，fake 只是引擎实现替身）：
// ① 三级发现消费（L1 XYZ_AGENT_ENGINE_ROOTS → manifest 自注册 → 按需 spawn）；
// ② read 走协议（native reader 覆盖后 core 链①级 = 协议 read，投影复用）；
// ③ 协议失败降②级 journal / 引擎未发现降③级 outcome-only（GUI source 标注的
//    数据源契约 = SessionView.source，降级事实 warn 留痕）；
// ④ idle 5min 复用：复用窗口内同实例（spawn 计数不增），过期 dispose 后重建
//    （spawn 计数 +1）。窗口状态确定性控制——生产窗口 5min 保证「窗口内」与真实
//    read 耗时无关；「过期」由 expireIdleEngineClientsForTests 显式驱动 idle 回收
//    路径（真实定时器回调同函数），不靠真实等待，全载下零时序敏感；
// ⑤ 退出钩子聚合上界：挂死引擎下 disposeRuntimeEngineClients 在上界返回不被拖死。
//    真实短窗口替代 fake timers——协议 IO 与杀链是真实 OS 异步，fake timers 推不动
//    子进程退出，真实 150ms 窗口是上界语义的直接证据（index.ts 内「dispose 与 relay
//    关停并行」为编排面，代码级断言 + 手工演示见单元汇报）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { SubagentRecord } from '@xyz-agent/shared'
import {
  disposeRuntimeEngineClients,
  expireIdleEngineClientsForTests,
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
    'xyz-agent': {
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
  setEnv('XYZ_AGENT_ENGINE_ROOTS', rootsDir)
  setEnv('XYZ_AGENT_DATA_DIR', dataDir)
  setEnv('FAKE_SPAWN_LOG', spawnLog)
  setEnv('XYZ_AGENT_ENGINE_NODE', undefined)
})

afterEach(() => {
  resetRuntimeEngineWiringForTests()
  // env 泄漏防护：每个用例结束时恢复发现根与 CLI 模式（用例内只允许短暂改写）。
  setEnv('XYZ_AGENT_ENGINE_ROOTS', rootsDir)
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

  it('④ idle 复用：窗口内二次 read 零新 spawn；窗口过期 dispose 后重建 +1', async () => {
    truncateSpawnLog()
    // 窗口内：生产窗口 5min ≫ 任何真实 read 耗时 → 复用判定与负载无关。
    await readEngineSubagentHistory(makeRecord(), dataDir)
    await readEngineSubagentHistory(makeRecord(), dataDir)
    expect(spawnLogPids()).toHaveLength(1) // idle 窗口内复用同一引擎实例

    // 窗口过期：显式驱动 idle 回收（同一到期路径）→ dispose + 出表。
    expireIdleEngineClientsForTests()
    await readEngineSubagentHistory(makeRecord(), dataDir)
    expect(spawnLogPids()).toHaveLength(2) // 过期 dispose 后新实例
  }, 20_000)

  it('③ 协议 read 失败降②级 journal：journalPath 白名单内事件重放投影', async () => {
    setEnv('FAKE_READ_MODE', 'error')
    const journalPath = path.join(dataDir, 'engines', 'fake', 'shared', 'journal-j1.jsonl')
    // 行 schema = JournalLine（event-journal parseLine 守卫：v:1 + ts/seq + event.type）。
    fs.writeFileSync(
      journalPath,
      [
        JSON.stringify({ v: 1, ts: Date.now(), taskId: 'j1', engineId: 'fake', seq: 1, event: { type: 'text_delta', delta: 'journal tier text' } }),
        JSON.stringify({ v: 1, ts: Date.now(), taskId: 'j1', engineId: 'fake', seq: 2, event: { type: 'turn_end' } }),
        '',
      ].join('\n'),
    )
    const messages = await readEngineSubagentHistory(
      makeRecord({ engineHandle: { sessionRef: { sessionId: 's-1' }, poolKey: 'shared', journalPath } }),
      dataDir,
    )
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('journal tier text')
    setEnv('FAKE_READ_MODE', 'ok')
  }, 20_000)

  it('③ 引擎未发现降③级 outcome-only：零发现根时返回摘要卡内容', async () => {
    setEnv('XYZ_AGENT_ENGINE_ROOTS', path.join(tmpDir, 'empty-roots'))
    const messages = await readEngineSubagentHistory(makeRecord({ engine: 'missing' }), dataDir)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('(no outcome recorded)')
  })

  it('⑤ 退出钩子聚合上界：dispose 挂死引擎时在上界（150ms 注入值）返回不被拖死', async () => {
    setEnv('FAKE_DISPOSE_MODE', 'hang')
    await readEngineSubagentHistory(makeRecord(), dataDir) // 造一个挂死 dispose 的实例
    const startedAt = Date.now()
    await disposeRuntimeEngineClients(150)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(2_000) // 不等 3s dispose 帧超时（上界生效）
    // 收尾：挂死引擎不自动退出——SIGKILL 防 worker 孤儿（pid 来自 spawn 计数）。
    for (const pid of spawnLogPids()) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // 已退出 = 预期
      }
    }
    setEnv('FAKE_DISPOSE_MODE', 'ok')
  }, 20_000)
})
