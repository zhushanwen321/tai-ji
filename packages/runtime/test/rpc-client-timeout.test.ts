/**
 * RpcClient W3 单元测试（U8）。
 *
 * 覆盖 S6：rpc-client 超时后迟到响应被误当事件广播。
 *
 * 场景：
 * - sendCommand('getState', timeout=100) 因超时 reject
 * - pi 随后发回带同一 id 的迟到响应
 * - 修复前：迟到响应的 id 已不在 pending，handleMessage 走 else 分支当 event 广播 → 幽灵 UI 副作用
 * - 修复后：timedOutIds 命中，迟到响应被丢弃，listener 不收到
 *
 * 测试策略与 rpc-client.test.ts 一致：mock node:child_process 的 spawn + readline，
 * 用 fakeTimer 驱动超时，用 emitPiLine 投递迟到响应。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcTimeoutError } from '../src/infra/pi/rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks ──────────────────────────────────────────────────────────

/** 捕获的 stdin 写入行（每条 JSON 字符串）。 */
const stdinWrites: string[] = []

/** stdout data handler——start() 内 attachLfOnlyLineReader 注册（D10 后不再有 readline）。 */
let stdoutDataHandler: ((chunk: Buffer | string) => void) | null = null

/** proc.exit handler，start() startup check 用。 */
let procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: {
    on: vi.fn((event: string, handler: (chunk: Buffer | string) => void) => {
      if (event === 'data') stdoutDataHandler = handler
      return fakeProc.stdout
    }),
    off: vi.fn(),
    removeListener: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn((chunk: string) => {
      stdinWrites.push(chunk)
      return true
    }),
    once: vi.fn(),
  },
  kill: vi.fn((_signal?: NodeJS.Signals | number) => {
    // kill 即死（mock 语义）：微任务内 emit exit 短路 killPiProcess 的 grace 真实等待。
    // [HISTORICAL] 2026-09-14 审计：空 vi.fn() 永不发 exit → 每次 afterEach kill 真睡
    // DEFAULT_PI_KILL_GRACE_MS(2s)，27 用例 ≈ 68s 纯等待（runtime 测试 top10 慢因头号构成）。
    // 重复驱动由 kill-chain settled 幂等守卫兜底；收敛目标 = test/helpers/rpc-client-mock.ts。
    queueMicrotask(() => {
      if (procExitHandlers.length === 0) return
      const handlers = procExitHandlers
      procExitHandlers = []
      handlers.forEach((h) => h(0))
    })
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
}))

// D10 后 stdout 分帧走 rpc-client 自实现的 LF-only 读取器（同模块直调，无法从模块边界 mock）。
// 测试改为在 fake stdout 上桥接 'data' handler，emitPiLine 直投「整行 + \n」由读取器分帧——
// 投递时序与旧 readline 桥接一致（同步直调）；LF-only 分帧行为由 rpc-client-lf-framing.test.ts 专项覆盖。

// importOriginal spread 而非完全替换：rpc-client.start 经 ../spawn-env.js re-export 消费
// shared 的 buildOutboundChildEnv（纯函数、env 全 DI），完全替换式 mock 会随 shared 新增
// 导出静默断联（b5d3e6329 事故根因）；此处仅覆盖测试需要隔离的常量。
vi.mock('@xyz-agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyz-agent/shared')>()),
  ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
}))

vi.mock('@xyz-agent/shared/paths', () => ({
  getDataDir: () => '/mock/home/.xyz-agent',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

// pi-paths 被 rpc-client import，mock 掉避免触碰真实 fs
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
  }
})

// pi-provider-store.getDefaultModel——避免读真实配置
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

// logger.createPiSessionLog——避免真实文件 IO
vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

// ── Helpers ────────────────────────────────────────────────────────

/** 把伪造的 pi 响应行投递给 RpcClient 的 stdout（LF-only 读取器的 data 入口，同步直调）。 */
function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutDataHandler) throw new Error('stdout data handler not registered yet')
  stdoutDataHandler(JSON.stringify(obj) + '\n')
}

/** 从 stdin 写入里解析出最后一条 JSON 对象。 */
function lastWrittenJson(): Record<string, unknown> {
  const last = stdinWrites[stdinWrites.length - 1]
  return JSON.parse(last)
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RpcClient W3 S6 (timedOutIds)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutDataHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdout.on.mockClear()
    fakeProc.stdin.write.mockClear()

    const { RpcClient } = await import('../src/infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    // 恢复真实 timer，避免影响后续测试
    vi.useRealTimers()
    // kill 走 SIGTERM + 等待 exit；触发 exit handlers 清 pending
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  // ── U8: 超时后迟到响应被丢弃，不当 event 广播 ─────────────────────
  it('U8: late reply with same id after timeout is discarded (not broadcast as event)', async () => {
    // 注册一个 event listener，捕获所有 event 广播
    const events: Array<Record<string, unknown>> = []
    client.onEvent((msg: { id?: string; type: string }) => {
      events.push({ id: msg.id, type: msg.type })
    })

    vi.useFakeTimers()
    // 发起命令，短超时 100ms
    const commandPromise = client.sendCommand('get_state', {}, 100)
    await Promise.resolve()
    const sent = lastWrittenJson()
    const cmdId = sent.id as string

    // 推进时间超过超时 → sendCommand 应 reject
    vi.advanceTimersByTime(200)
    await expect(commandPromise).rejects.toThrow(/timed out/)

    // 此时 pending 已清空，id 不再匹配 pending（U1 pi-rpc 收敛后经 registry 部件 hasPending 只读面）
    expect((client as unknown as { pendingRegistry: { hasPending(id: string): boolean } }).pendingRegistry.hasPending(cmdId)).toBe(false)

    // 模拟 pi 发回带同一 id 的迟到响应
    emitPiLine({ type: 'response', id: cmdId, success: true, data: { late: true } })

    // 修复后：迟到响应被 timedOutIds 命中丢弃，listener 不应收到
    expect(events).toEqual([])
  })

  // ── U8b: timedOutIds 在 5s TTL 后自动清理（避免 Set 无限增长） ──────
  it('U8b: timedOutIds entry expires after 5s TTL', async () => {
    vi.useFakeTimers()
    const commandPromise = client.sendCommand('get_state', {}, 100)
    await Promise.resolve()
    const sent = lastWrittenJson()
    const cmdId = sent.id as string

    // 触发超时
    vi.advanceTimersByTime(200)
    await expect(commandPromise).rejects.toThrow(/timed out/)

    // 超时后 id 在 timedOutIds 中（U1 pi-rpc 收敛后经 registry 部件 isTimedOut 只读面）
    const registry = (client as unknown as { pendingRegistry: { isTimedOut(id: string | undefined): boolean } }).pendingRegistry
    expect(registry.isTimedOut(cmdId)).toBe(true)

    // 5s TTL 后自动清理
    vi.advanceTimersByTime(5_000)
    expect(registry.isTimedOut(cmdId)).toBe(false)
  })
})

describe('RpcTimeoutError 类型（D3a pi 半死自愈：超时判别收口为类型）', () => {
  /** kill 并模拟进程退出（fakeProc.kill 不会真触发 exit，手动驱动 exit handlers 让 kill() 立即 resolve）。 */
  async function killClient(client: { kill(): Promise<void> }): Promise<void> {
    const killPromise = client.kill()
    procExitHandlers.forEach((h) => h(0))
    await killPromise
    procExitHandlers = []
  }

  it('字段与 message：name/commandType/timeoutMs', () => {
    const err = new RpcTimeoutError('abort', 60_000)
    expect(err).toBeInstanceOf(RpcTimeoutError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RpcTimeoutError')
    expect(err.commandType).toBe('abort')
    expect(err.timeoutMs).toBe(60_000)
    // message 保持旧文案格式（依赖 /timed out/ 正则的既有测试不破）
    expect(err.message).toBe('RPC command "abort" timed out after 60000ms')
  })

  it('sendCommand 超时 reject 的是 RpcTimeoutError 实例（instanceof 可判别）', async () => {
    const client = new (await import('../src/infra/pi/rpc-client.js')).RpcClient({ cwd: '/project' })
    await client.start()

    vi.useFakeTimers()
    const commandPromise = client.sendCommand('abort', {}, 100)
    await Promise.resolve()
    vi.advanceTimersByTime(200)

    // 捕获 reject 值做 instanceof + 字段断言（rejects.toThrow 只验 message，判别不了类型）
    const thrown = await commandPromise.then(
      () => { throw new Error('expected rejection') },
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(RpcTimeoutError)
    expect((thrown as RpcTimeoutError).commandType).toBe('abort')
    expect((thrown as RpcTimeoutError).timeoutMs).toBe(100)

    vi.useRealTimers()
    await killClient(client)
  })

  it('普通 RPC 失败（success:false）reject 普通 Error，不误判为超时', async () => {
    const client = new (await import('../src/infra/pi/rpc-client.js')).RpcClient({ cwd: '/project' })
    await client.start()

    const commandPromise = client.sendCommand('abort')
    await Promise.resolve()
    // pi 回 success:false
    emitPiLine({ type: 'response', id: lastWrittenJson().id, success: false, error: 'boom' })

    const thrown = await commandPromise.then(
      () => { throw new Error('expected rejection') },
      (e: unknown) => e,
    )
    expect(thrown).not.toBeInstanceOf(RpcTimeoutError)
    expect((thrown as Error).message).toContain('boom')

    await killClient(client)
  })
})
