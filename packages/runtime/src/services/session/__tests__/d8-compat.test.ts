// D8 兼容公共部分薄壳测试（W8，设计 §3.6 D8 表 / H12，impl-plan §2.8）。
//
// 覆盖范围：
// - createZcodeEngine 薄壳：deps → 协议客户端映射（返回 RemoteEngine('zcode')，
//   read 走协议；cliPath 覆盖 command；sources 忽略不抛）；
// - 引擎子进程 L0 env：deps.engineDataDir → TAIJI_AGENT_DATA_DIR 显式注入；
// - registerZcodeEngine 薄壳：确保 'zcode' descriptor 注册（vendored 相对定位成功，
//   workspace 布局 coreDir/../zcode-subagent-cli）；经 routeEngine 行为范围断言。
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

// [密闭化] 宿主注入的引擎执行器/发现根（打包态 TaiJi 会话 env：TAIJI_AGENT_ENGINE_NODE
// 指向 Electron 主二进制）会把 hostKindOf 嗅探到 pi-extension 分支——用主二进制当
// node 执行器 spawn fake CLI，进程立即 exit 0 → engine_crashed。测试恒用 standalone
// 语义（PATH node），剥这两个 env（afterAll 经 savedEnv 恢复）。
beforeAll(() => {
  setEnv('TAIJI_AGENT_ENGINE_NODE', undefined)
  setEnv('TAIJI_AGENT_ENGINE_ROOTS', undefined)
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

describe('W8 D8 兼容公共部分薄壳', () => {
  it('createZcodeEngine 返回 RemoteEngine(zcode)：read 走协议（cliPath 指向 fake CLI）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    const engine = createZcodeEngine({ engineDataDir: () => dataDir, cliPath: FIXTURE_CLI })
    expect(engine.id).toBe('zcode')
    const view = await engine.read({
      data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-1' }, adapterVersion: 'd8-test' },
    })
    expect(view.turns[0]?.text).toBe('fake turn') // 协议 read 生效（非 inproc / 非降级）
    expect(view.source).toBe('native')
  }, 20_000)

  it('registerZcodeEngine 薄壳：确保 zcode descriptor 注册（routeEngine 行为范围断言）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    registerZcodeEngine()
    // routeEngine 注入 probe stub（注册断言只看 has 校验与 get 装配，不 spawn）。
    const result = await routeEngine({
      routing: { callEngine: 'zcode' },
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

  it('createZcodeEngine 携带部署形态翻译面：vendored manifest modelTranslation → translateModelRef 查表改写', () => {
    // 不传 cliPath：走 vendored 相对定位读 packages/zcode-subagent-cli/package.json
    // （manifest 声明 modelTranslation）；构造同步不 spawn，翻译面为纯查表。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-translation-'))
    try {
      const engine = createZcodeEngine({ engineDataDir: () => dir })
      expect(typeof engine.translateModelRef).toBe('function')
      // vendored 包声明的目标段（ADR-0142 D1 已发布形态）
      expect(engine.translateModelRef!('zai-coding-cn/glm-5.3-flash')).toBe(
        'account:bigmodel-individual-coding-plan/glm-5.3-flash',
      )
      // 表外 provider / 无 provider 段 → 恒等透传（幂等）
      expect(engine.translateModelRef!('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat')
      expect(engine.translateModelRef!('glm-5.3-flash')).toBe('glm-5.3-flash')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('W8 D8 引擎子进程 L0 env 注入', () => {
  it('数据根经 L0 显式注入（deps.engineDataDir → TAIJI_AGENT_DATA_DIR）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    const envEcho = await fakeCliEnvEcho({ engineDataDir: dataDir, cliPath: FIXTURE_CLI })
    expect(envEcho['TAIJI_AGENT_DATA_DIR']).toBe(dataDir)
  }, 20_000)
})
