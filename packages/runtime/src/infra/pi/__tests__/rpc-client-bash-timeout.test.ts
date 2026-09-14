/**
 * RpcClient bash RPC 超时常量 / env 逃生门测试（timeout-slow-flow-wallclock D2，u-y2）。
 *
 * 锁定（env 通路三断言 + 不限时形态）：
 * - 读取：env `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS` 合法值覆盖 shared BASH_RPC_TIMEOUT_MS；
 *   env 未设/非法（非数字/负数）回退默认 3_600_000。
 * - 缓存：读一次缓存——首次读取后改 env 不再生效（进程生命周期内超时决策稳定）。
 * - 覆盖：env=0 → 不限时（不挂墙钟 timer，advance 10h 不 reject，迟到响应照常 resolve）。
 * - 默认路径：bash() 超时以 RpcTimeoutError reject 且 timeoutMs 等于生效值（D3a 字段化）。
 *
 * 策略：沿用 rpc-client-observability.test.ts 的 mock 骨架（node:child_process + fake
 * streams），fake timers 驱动超时墙钟（STARTUP_DELAY_MS / RPC timer 均走同一时钟）。
 * pi 帧注入走 data 分帧桥接（D10：RpcClient 不消费 node:readline，attachLfOnlyLineReader
 * 在 stdout 上挂 data handler 自行 LF 分帧——emitData 直投「整行 + \n」由生产读取器分帧，
 * 先例：test/helpers/rpc-client-mock.ts emitPiLine）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-bash-timeout.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcClient, resolveBashRpcTimeoutMs, resetBashRpcTimeoutForTest } from '../rpc-client.js'
import { RpcTimeoutError } from '../../../utils/errors.js'
import { BASH_RPC_TIMEOUT_MS } from '@xyz-agent/shared'

// ── Mocks（对齐 rpc-client-observability.test.ts 骨架）────────────────

type DataHandler = (data: Buffer) => void

function makeFakeStream() {
  const dataHandlers: DataHandler[] = []
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandlers.push(handler as DataHandler)
    }),
    resume: vi.fn(),
    destroy: vi.fn(),
    /** 丢弃旧 client 注册的 handler（stream 是模块级单例，跨用例复用须显式清） */
    reset(): void {
      dataHandlers.length = 0
    },
    emitData(text: string): void {
      for (const h of [...dataHandlers]) h(Buffer.from(text, 'utf8'))
    },
  }
}

const stdoutStream = makeFakeStream()
const stderrStream = makeFakeStream()

const fakeProc = {
  on: vi.fn(),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: stdoutStream,
  stderr: stderrStream,
  // write 显式 string 参数签名：0=不限时用例要从 calls 里取回请求 JSON 的 id
  stdin: { write: vi.fn((_data: string) => true), once: vi.fn() },
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => fakeProc),
}))

vi.mock('@xyz-agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyz-agent/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@xyz-agent/shared/paths', () => ({ getDataDir: () => '/mock/home/.xyz-agent' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
  }
})

vi.mock('../pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../../logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  // u5b D6-④：rpc-client 新增 import 的内存快照采集（mock 面随源码 import 面同步）
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  writePiCrashLog: vi.fn(),
}))

const ENV_KEY = 'XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS'

async function startClient(): Promise<RpcClient> {
  stdoutStream.reset()
  const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变）
  const client = new RpcClient({ ...clientOpts })
  const startP = client.start()
  // 窗口归零后仍推进一步 fake timers 让 setTimeout(0) 回调兑现
  await vi.advanceTimersByTimeAsync(0)
  await startP
  return client
}

describe('resolveBashRpcTimeoutMs —— env 读取 / 缓存 / 覆盖（D2 逃生门）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetBashRpcTimeoutForTest()
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    vi.useRealTimers()
    resetBashRpcTimeoutForTest()
    delete process.env[ENV_KEY]
    vi.clearAllMocks()
  })

  it('读取-默认：env 未设 → shared BASH_RPC_TIMEOUT_MS（3_600_000）', () => {
    expect(resolveBashRpcTimeoutMs()).toBe(BASH_RPC_TIMEOUT_MS)
    expect(BASH_RPC_TIMEOUT_MS).toBe(3_600_000)
  })

  it('读取-覆盖：env 合法值（毫秒）覆盖默认', () => {
    process.env[ENV_KEY] = '1500'
    expect(resolveBashRpcTimeoutMs()).toBe(1500)
  })

  it('读取-非法回退：非数字 / 负数 → 默认（0 是合法的「不限时」，不回退）', () => {
    process.env[ENV_KEY] = 'abc'
    expect(resolveBashRpcTimeoutMs()).toBe(BASH_RPC_TIMEOUT_MS)
    resetBashRpcTimeoutForTest()
    process.env[ENV_KEY] = '-5'
    expect(resolveBashRpcTimeoutMs()).toBe(BASH_RPC_TIMEOUT_MS)
    resetBashRpcTimeoutForTest()
    process.env[ENV_KEY] = '0'
    expect(resolveBashRpcTimeoutMs()).toBe(0)
  })

  it('缓存：首次读取后改 env 不再生效（读一次缓存，进程生命周期内决策稳定）', () => {
    process.env[ENV_KEY] = '1500'
    expect(resolveBashRpcTimeoutMs()).toBe(1500)
    process.env[ENV_KEY] = '9999'
    expect(resolveBashRpcTimeoutMs()).toBe(1500)
  })
})

describe('bash() 超时行为 —— 默认 / env 覆盖 / 0=不限时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetBashRpcTimeoutForTest()
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    vi.useRealTimers()
    resetBashRpcTimeoutForTest()
    delete process.env[ENV_KEY]
    vi.clearAllMocks()
  })

  it('默认：advance 至 3_600_000 才以 RpcTimeoutError{commandType:"bash", timeoutMs:3_600_000} reject', async () => {
    const client = await startClient()
    let rejected: unknown
    const p = client.bash('sleep 9999').catch((e) => { rejected = e })
    // 边界内 1ms 不误杀
    await vi.advanceTimersByTimeAsync(BASH_RPC_TIMEOUT_MS - 1)
    expect(rejected).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(rejected).toBeInstanceOf(RpcTimeoutError)
    expect((rejected as RpcTimeoutError).commandType).toBe('bash')
    expect((rejected as RpcTimeoutError).timeoutMs).toBe(3_600_000)
    // D3a：超时 id 进 timedOutIds，迟到响应丢弃（机制未被 D2 改动）
    // ——行为由 dispatcher/等价性测试覆盖，此处不断言内部 Set。
  })

  it('env 覆盖：env=1500 → bash() 1500ms 超时（读取生效）', async () => {
    process.env[ENV_KEY] = '1500'
    resetBashRpcTimeoutForTest()
    const client = await startClient()
    let rejected: unknown
    const p = client.bash('sleep 9999').catch((e) => { rejected = e })
    await vi.advanceTimersByTimeAsync(1499)
    expect(rejected).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(rejected).toBeInstanceOf(RpcTimeoutError)
    expect((rejected as RpcTimeoutError).timeoutMs).toBe(1500)
  })

  it('0=不限时：advance 10 小时不 reject，迟到 response 帧照常 resolve（不挂墙钟 timer）', async () => {
    process.env[ENV_KEY] = '0'
    resetBashRpcTimeoutForTest()
    const client = await startClient()
    let settled: 'resolved' | 'rejected' | 'pending' = 'pending'
    const p = client.bash('long-running').then(
      () => { settled = 'resolved' },
      () => { settled = 'rejected' },
    )
    // 远超任何墙钟档位（10h > 默认 1h）仍不判死——回收层兜底被用户显式解除
    await vi.advanceTimersByTimeAsync(10 * 3_600_000)
    expect(settled).toBe('pending')
    // 命令真实完成：response 帧到达（id 与请求配对）→ resolve 真实结果。
    // data 分帧桥接：直投「整行 JSONL + \n」（= pi stdout 输出）由生产 attachLfOnlyLineReader 分帧。
    const call = fakeProc.stdin.write.mock.calls.find((c) => String(c[0]).includes('"type":"bash"'))
    expect(call).toBeDefined()
    const { id } = JSON.parse(String(call![0])) as { id: string }
    stdoutStream.emitData(JSON.stringify({
      type: 'response', id, success: true,
      data: { output: 'done', exitCode: 0, cancelled: false, truncated: false },
    }) + '\n')
    await p
    expect(settled).toBe('resolved')
  })
})
