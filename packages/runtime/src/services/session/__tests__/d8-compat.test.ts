// D8 兼容公共面薄壳 + relay 透传测试（W8，设计 §3.6 D8 表 / H12，impl-plan §2.8）。
//
// 覆盖面：
// - createZcodeEngine 薄壳：deps → 协议客户端映射（返回 RemoteEngine('zcode')，
//   read 走协议；cliPath 覆盖 command；sources 忽略不抛）；
// - relay 透传正反例（H12）：宿主 env 三键经 baseEnv → L0 注入引擎子进程（原样
//   转发）；身份键 SESSION_ID/RECORD_ID 被 buildEngineChildEnv L1 deny 剥除
//   （引擎按 run.params.ctx 重写，不靠 env 继承）；
// - registerZcodeEngine 薄壳：确保 'zcode' descriptor 注册（vendored 相对定位成功，
//   workspace 布局 coreDir/../zcode-subagent-cli）；经 routeEngine 行为面断言；
// - readRelayForwardEnv 原语：三键全有才转发（isRelayActive 同判），缺一 → undefined。
//
// fake 引擎 CLI 复用 fixtures/fake-engine-cli.mjs（直接以 node 参数形态 spawn——
// 不走引擎包发现，cliPath 显式覆盖，manifest 走 CONSERVATIVE 保守值）。

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  createZcodeEngine,
  registerZcodeEngine,
  routeEngine,
} from '@zhushanwen/subagent-core'
// readRelayForwardEnv 的公共子入口（core barrel 不重复导出 relay 常量面——runtime
// 既有 import 形态 @zhushanwen/subagent-core/relay-env，禁手写字符串镜像）。
import { readRelayForwardEnv } from '@zhushanwen/subagent-core/relay-env'

const FIXTURE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-engine-cli.mjs')

let tmpDir: string
let dataDir: string
const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  setEnv('FAKE_READ_MODE', 'ok')
})

// cliPath 直接以文件形态被 EngineClient spawn——需要可执行位（运行时自愈，
// 不改 repo 内文件 mode；协议测试文件的拷贝路径已单独 chmod）。
beforeAll(() => {
  fs.chmodSync(FIXTURE_CLI, 0o755)
})

afterAll(async () => {
  for (const [key, value] of savedEnv) setEnv(key, value)
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** fake CLI 直跑（协议往返真实；envEcho 白名单回显供透传断言）。 */
function fakeCliEnvEcho(opts: {
  cliPath?: string
  processEnv?: Record<string, string | undefined>
  engineDataDir: string
}): Promise<Record<string, string | undefined>> {
  const cliPath = opts.cliPath ?? FIXTURE_CLI
  const engine = createZcodeEngine({
    engineDataDir: () => opts.engineDataDir,
    ...(opts.cliPath !== undefined ? { cliPath } : {}),
    ...(opts.processEnv !== undefined ? { processEnv: opts.processEnv } : {}),
  })
  // RemoteEngine.read 的应答是 SessionView 结构断言——fixture 在 read 应答里附
  // envEcho 白名单摘要（initialize 应答与 read 应答共享同一进程 env）。
  // read 前置 ensureConnected → initialize；此处直接取 view 上的 envEcho 附加字段。
  return engine
    .read({ data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-d8' }, adapterVersion: 'd8-test' } })
    .then((view) => (view as unknown as { envEcho?: Record<string, string | undefined> }).envEcho ?? {})
}

describe('W8 D8 兼容公共面薄壳', () => {
  it('createZcodeEngine 返回 RemoteEngine(zcode)：read 走协议（cliPath 指向 fake CLI）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('XYZ_AGENT_DATA_DIR', dataDir)
    const engine = createZcodeEngine({ engineDataDir: () => dataDir, cliPath: FIXTURE_CLI })
    expect(engine.id).toBe('zcode')
    const view = await engine.read({
      data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-1' }, adapterVersion: 'd8-test' },
    })
    expect(view.turns[0]?.text).toBe('fake turn') // 协议 read 生效（非 inproc / 非降级）
    expect(view.source).toBe('native')
  }, 20_000)

  it('registerZcodeEngine 薄壳：确保 zcode descriptor 注册（routeEngine 行为面断言）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('XYZ_AGENT_DATA_DIR', dataDir)
    registerZcodeEngine()
    // routeEngine 注入 probe stub（注册断言只看 has 校验与 get 装配，不 spawn）。
    const result = await routeEngine({
      routing: { callEngine: 'zcode' },
      strict: false,
      probe: async () => ({ ok: true, engineVersion: 'stub', checks: [] }),
    })
    expect(result.engineId).toBe('zcode')
  }, 20_000)

  it('deps.sources 不跨进程：传入被忽略不抛（协议不变量 5）', () => {
    const engine = createZcodeEngine({
      engineDataDir: () => '/tmp/w8-d8-sources',
      cliPath: FIXTURE_CLI,
      sources: { configPath: '/should/not/cross' } as unknown as never,
    })
    expect(engine.id).toBe('zcode')
  })
})

describe('W8 H12 relay 透传（正反例）', () => {
  it('正例：三键原样转发到引擎子进程 env（L0）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('XYZ_AGENT_DATA_DIR', dataDir)
    const envEcho = await fakeCliEnvEcho({
      engineDataDir: dataDir,
      cliPath: FIXTURE_CLI,
      processEnv: {
        XYZ_SUBAGENT_RELAY_SOCKET: '/tmp/relay.sock',
        XYZ_SUBAGENT_RELAY_NODE: '/usr/bin/node',
        XYZ_SUBAGENT_RELAY_SCRIPT: '/tmp/relay.mjs',
      },
    })
    expect(envEcho['XYZ_SUBAGENT_RELAY_SOCKET']).toBe('/tmp/relay.sock')
    expect(envEcho['XYZ_SUBAGENT_RELAY_NODE']).toBe('/usr/bin/node')
    expect(envEcho['XYZ_SUBAGENT_RELAY_SCRIPT']).toBe('/tmp/relay.mjs')
  }, 20_000)

  it('反例：身份键 SESSION_ID/RECORD_ID 被 L1 deny 剥除，不进引擎子进程 env', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('XYZ_AGENT_DATA_DIR', dataDir)
    const envEcho = await fakeCliEnvEcho({
      engineDataDir: dataDir,
      cliPath: FIXTURE_CLI,
      processEnv: {
        XYZ_SUBAGENT_RELAY_SOCKET: '/tmp/relay.sock',
        XYZ_SUBAGENT_RELAY_NODE: '/usr/bin/node',
        XYZ_SUBAGENT_RELAY_SCRIPT: '/tmp/relay.mjs',
        XYZ_SUBAGENT_RELAY_SESSION_ID: 'parent-session',
        XYZ_SUBAGENT_RELAY_RECORD_ID: 'parent-record',
      },
    })
    expect(envEcho['XYZ_SUBAGENT_RELAY_SESSION_ID']).toBeUndefined()
    expect(envEcho['XYZ_SUBAGENT_RELAY_RECORD_ID']).toBeUndefined()
    // 数据根经 L0 显式注入（deps.engineDataDir 映射）。
    expect(envEcho['XYZ_AGENT_DATA_DIR']).toBe(dataDir)
  }, 20_000)

  it('readRelayForwardEnv：三键全有才转发；缺一 undefined（isRelayActive 同判）', () => {
    const full = {
      XYZ_SUBAGENT_RELAY_SOCKET: '/tmp/s.sock',
      XYZ_SUBAGENT_RELAY_NODE: '/usr/bin/node',
      XYZ_SUBAGENT_RELAY_SCRIPT: '/tmp/r.mjs',
    }
    expect(readRelayForwardEnv(full)).toEqual({ socket: '/tmp/s.sock', node: '/usr/bin/node', script: '/tmp/r.mjs' })
    expect(readRelayForwardEnv({ ...full, XYZ_SUBAGENT_RELAY_SCRIPT: undefined })).toBeUndefined()
    expect(readRelayForwardEnv({})).toBeUndefined()
  })
})
