/**
 * RpcClient W1 单元测试（U1-U5）+ W3 超时语义（U8/U8b/D3a，自 rpc-client-timeout.test.ts 并入）。
 *
 * 覆盖 plan.json：
 * - U1: sendCommand 归一 payload→data
 * - U2: sendCommand 归一正常路径（data 优先，无副作用）
 * - U3: switchSession 写入 switch_session + sessionPath
 * - U4: sendExtensionUiResponse 走 sendRaw，pending 不增长
 * - U5: sendExtensionUiResponse 三种 payload 格式（cancelled/confirmed/value）
 * - U8/U8b: 超时后迟到响应不广播（S6 幽灵事件修复）+ timedOutIds 5s TTL
 * - D3a: RpcTimeoutError 类型判别（instanceof / success:false 不误判）
 *
 * 测试策略：mock node:child_process 的 spawn，捕获 stdin 写入，并提供一个
 * emitLine 入口把伪造的 pi stdout JSONL 行投递给 RpcClient 的 line handler，
 * 从而驱动 pending resolve。这样不依赖真实 pi 进程。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcTimeoutError, type RpcClient } from '../src/infra/pi/rpc-client.js'
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

/** 读取 RpcClient 内部 pending 数（反射，仅测试用；U1 pi-rpc 收敛后经 registry 部件 pendingSize 只读面）。 */
function pendingSize(client: unknown): number {
  return (client as { pendingRegistry: { pendingSize: number } }).pendingRegistry.pendingSize
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RpcClient W1', () => {
  let client: RpcClient

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
    // kill 走 SIGTERM + 等待 exit；触发 exit handlers 清 pending
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  // ── U1: sendCommand 归一 payload→data ────────────────────────────
  it('U1: sendCommand resolves with data normalized from payload when data absent', async () => {
    // 通过 public getState 间接驱动 sendCommand('get_state')，捕获 nextId
    const statePromise = client.getState()
    // 等一拍让 sendCommand 写完 stdin 并注册 pending
    await Promise.resolve()

    // pi 回 {type:'response', id, success:true, payload:{foo:1}}（无 data）
    const sent = lastWrittenJson()
    emitPiLine({ type: 'response', id: sent.id, success: true, payload: { foo: 1 } })

    const state = await statePromise
    // 归一后 data === payload
    expect(state).toEqual({ foo: 1 })
  })

  // ── U2: sendCommand 归一正常路径（data 优先，无副作用）────────────
  it('U2: sendCommand resolves with data when both data present (data wins, no payload leak)', async () => {
    const statePromise = client.getState()
    await Promise.resolve()

    const sent = lastWrittenJson()
    // pi 回 data + payload 同时存在 → data 优先
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { bar: 2 },
      payload: { shouldNotWin: true },
    })

    const state = await statePromise
    expect(state).toEqual({ bar: 2 })
  })

  // ── U3: switchSession 写入 switch_session + sessionPath ───────────
  it('U3: switchSession writes {type:"switch_session", sessionPath} to stdin', async () => {
    const switchPromise = client.switchSession('/path/to/session')
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('switch_session')
    expect(sent.sessionPath).toBe('/path/to/session')

    // 让 pi 回一个 success 让 promise resolve（switch_session 在 W1 仍走 sendCommand）
    emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
    await switchPromise
  })

  // ── U4: sendExtensionUiResponse 走 sendRaw，pending 不增长 ─────────
  it('U4: sendExtensionUiResponse writes via sendRaw (no pending entry created)', () => {
    const sizeBefore = pendingSize(client)

    client.sendExtensionUiResponse('req-1', true, 'confirm')

    const sent = lastWrittenJson()
    expect(sent.type).toBe('extension_ui_response')
    expect(sent.id).toBe('req-1')
    expect(sent.confirmed).toBe(true)

    expect(pendingSize(client)).toBe(sizeBefore)
  })

  // ── U5: sendExtensionUiResponse 三种 payload 格式 ─────────────────
  it('U5a: sendExtensionUiResponse(result=null, method=select) → {cancelled:true}', () => {
    client.sendExtensionUiResponse('r1', null, 'select')
    const sent = lastWrittenJson()
    expect(sent.id).toBe('r1')
    expect(sent.cancelled).toBe(true)
    expect(sent.confirmed).toBeUndefined()
    expect(sent.value).toBeUndefined()
  })

  it('U5b: sendExtensionUiResponse(result=true, method=confirm) → {confirmed:true}', () => {
    client.sendExtensionUiResponse('r2', true, 'confirm')
    const sent = lastWrittenJson()
    expect(sent.id).toBe('r2')
    expect(sent.confirmed).toBe(true)
    expect(sent.cancelled).toBeUndefined()
    expect(sent.value).toBeUndefined()
  })

  it('U5c: sendExtensionUiResponse(result="hello", method=input) → {value:"hello"}', () => {
    client.sendExtensionUiResponse('r3', 'hello', 'input')
    const sent = lastWrittenJson()
    expect(sent.id).toBe('r3')
    expect(sent.value).toBe('hello')
    expect(sent.confirmed).toBeUndefined()
    expect(sent.cancelled).toBeUndefined()
  })

  // [HISTORICAL] U5d「bridge 场景 {id, response} 包裹格式」用例已删除：旧 bridge 通道的
  // `{id, response}` 死分支随 bridge 重写清理（设计 bridge-rewrite-pi-0.84 §3.3-D6），
  // 唯一调用方 bridge-handler 已全改 JSON.stringify + 'select'（value 通道），该形态无
  // 生产调用方。bridge 通道回包形状由 test/bridge-marker-channel.test.ts 覆盖。

  // ── U6: compact/getCommands/getSessionStats 用归一后的 data（删 readRpcData 后仍工作） ──
  it('U6a: compact returns normalized data (works without readRpcData)', async () => {
    const p = client.compact()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 100 },
    })
    const result = await p
    expect(result.summary).toBe('s')
    expect(result.firstKeptEntryId).toBe('e1')
    expect(result.tokensBefore).toBe(100)
  })

  it('U6b: compact returns data normalized from payload (data absent)', async () => {
    const p = client.compact()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      payload: { summary: 's2', firstKeptEntryId: 'e2', tokensBefore: 200 },
    })
    const result = await p
    expect(result.summary).toBe('s2')
  })

  it('U6c: getCommands returns normalized data.commands (含 sourceInfo 透传)', async () => {
    const p = client.getCommands()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      payload: {
        commands: [
          {
            name: 'cmd1',
            source: 'skill',
            sourceInfo: { path: '/proj/skills/cmd1/SKILL.md', source: 'skill', scope: 'project' },
          },
          { name: 'cmd2', source: 'builtin' },
        ],
      },
    })
    const result = await p
    expect(result).toEqual([
      {
        name: 'cmd1',
        source: 'skill',
        sourceInfo: { path: '/proj/skills/cmd1/SKILL.md', source: 'skill', scope: 'project' },
      },
      { name: 'cmd2', source: 'builtin' },
    ])
  })

  it('U6d: getSessionStats returns normalized data', async () => {
    const p = client.getSessionStats()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { contextUsage: { tokens: 50, contextWindow: 1000, percent: 5 } },
    })
    const result = await p
    expect(result.contextUsage?.tokens).toBe(50)
  })

  // ── U7: setSessionName 写 set_session_name + name（W1 数据源治理）────
  it('U7a: setSessionName writes {type:"set_session_name", name} to stdin and resolves on success', async () => {
    const p = client.setSessionName('重构计划')
    await Promise.resolve()

    // 命令名与参数是 W1 接口契约锁定项（字面量 'set_session_name'，参数 { name }）
    const sent = lastWrittenJson()
    expect(sent.type).toBe('set_session_name')
    expect(sent.name).toBe('重构计划')

    emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
    await p
  })

  it('U7b: setSessionName rejects when pi responds success:false（success 检查对齐 sendCommand 约定）', async () => {
    const p = client.setSessionName('x')
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({ type: 'response', id: sent.id, success: false, error: 'pi internal error' })

    await expect(p).rejects.toThrow('pi internal error')
  })
})

// ── W3 S6：超时后迟到响应被丢弃，不当 event 广播（自 rpc-client-timeout.test.ts 并入）──

describe('RpcClient W3 S6 (timedOutIds)', () => {
  let client: RpcClient

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutDataHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdout.on.mockClear()
    fakeProc.stdin.write.mockClear()

    const { RpcClient: Client } = await import('../src/infra/pi/rpc-client.js')
    client = new Client({ ...clientOpts, cwd: '/project' })
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
