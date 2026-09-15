/**
 * RpcClient 空闲信号（lastActivityAt 双向 touch）测试（idle-pi-reclamation 设计 D1/D6-1）。
 *
 * 锁定：
 * - 初值 = spawn 时刻（start() 内重置；构造时刻仅未 start 形态兜底）
 * - 出站 sendCommand 是唯一出站咽喉：调用即同步刷新（不等 RPC 往返）
 * - 入站 handleMessage 是唯一入站咽喉：任何 stdout 帧（response / 事件）刷新；
 *   唯一例外 = maintenance pending 的 response 帧（见下）
 * - 维护通道双腿排除：sendCommand / prompt 带 maintenance 标记出站不刷新，其 response
 *   回程也不刷新（D1 双腿闭合，审查缺口修复）——promptReload 与其回程同频，单腿排除
 *   时 skill 变更风暴仍会周期性重置空闲时钟、回收饿死原样保留
 * - 非 maintenance response / 事件帧照常刷新（防双腿排除矫枉过正）
 * - sendRaw 是内部调试旁路，不 touch（D1 明确排除）
 * - touchActivity() 是 dispatcher 入口同步 touch 的公开写入口（D6-1）
 *
 * 红性：删掉任一 touch 点 / 删掉任一 maintenance 腿（出站标记或回程豁免），对应断言必红。
 *
 * 策略：与 rpc-client-response-guard.test.ts 同构——mock node:child_process + fake
 * stdout 'data' handler（emitPiLine 直投由 LF-only 读取器分帧进 handleMessage），fake
 * timers 控 Date.now 使各 touch 时刻的毫秒值可精确断言（真实时钟同毫秒分辨率不可分）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/infra/pi/rpc-client-activity.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../../../infra/pi/rpc-client.js'

// ── Mocks（与 rpc-client-response-guard.test.ts 同构，路径按本文件目录深度调整）──

const stdinWrites: string[] = []
let stdoutDataHandler: ((chunk: Buffer | string) => void) | null = null

const fakeProc = {
  on: vi.fn(() => fakeProc),
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
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../../../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

// ── Helpers ──────────────────────────────────────────────────────

/** fake 时钟锚点：任取固定值，各 touch 时刻的断言值全部由 setSystemTime 派生。 */
const BASE_TIME = 1_700_000_000_000
/** start() 的启动确认窗口（STARTUP_DELAY_MS，rpc-client 内部常量）。 */
const STARTUP_WINDOW_MS = 500

function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutDataHandler) throw new Error('stdout data handler not registered yet')
  stdoutDataHandler(JSON.stringify(obj) + '\n')
}

function lastWrittenJson(): Record<string, unknown> {
  const last = stdinWrites[stdinWrites.length - 1]
  return JSON.parse(last)
}

/** 用伪造 response settle 最后一条 sendCommand（避免 pending 挂 60s fake timer）。 */
async function settleLastCommand(p: Promise<unknown>): Promise<void> {
  const sent = lastWrittenJson()
  emitPiLine({ type: 'response', command: sent.type, id: sent.id, success: true, data: {} })
  await p
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient 空闲信号 lastActivityAt（idle-pi-reclamation D1）', () => {
  let client: RpcClient

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutDataHandler = null
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    vi.useFakeTimers()
    // 构造兜底初值时刻先于锚点 10s：与 start() 内重置值区分，初值用例才有区分力
    // （若误删 start() 内的重置行，初值断言会得到 BASE_TIME-10_000 而红）
    vi.setSystemTime(BASE_TIME - 10_000)

    const { RpcClient: RpcClientCtor } = await import('../../../infra/pi/rpc-client.js')
    client = new RpcClientCtor({ cwd: '/project' })
    // start() 的同步段（spawn + lastActivityAt 重置）在调用时立即执行，时钟须先推到锚点
    vi.setSystemTime(BASE_TIME)
    const startPromise = client.start()
    await vi.advanceTimersByTimeAsync(STARTUP_WINDOW_MS)
    await startPromise
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初值 = spawn 时刻（start() 同步段重置，非构造时刻）', () => {
    // 区分力（审查修正）：构造兜底初值在 BASE_TIME-10_000（beforeEach 构造前时钟），
    // start() 内 spawn 后同步重置为 BASE_TIME——误删 start() 内重置行本断言红。
    // 启动确认窗口推进的 500ms 不改写初值（若误用确认后时刻则为 BASE_TIME+500，也红）
    expect(client.lastActivityAt).toBe(BASE_TIME)
  })

  it('出站 sendCommand 同步刷新（调用即刷新，不等 RPC 往返）', async () => {
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    const p = client.sendCommand('get_state', {}, 60_000)
    // 同步断言：sendCommand 返回 Promise 的 executor 同步执行，touch 不依赖微任务
    expect(client.lastActivityAt).toBe(T1)
    await settleLastCommand(p)
  })

  it('非 maintenance 命令的 response 回程照常 touch（防双腿排除矫枉过正）', async () => {
    // 出站在 T1 touch；回程 response 在 T2 到达——普通命令链路双向都是真实活动，均 touch
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    const p = client.sendCommand('get_state', {}, 60_000)
    expect(client.lastActivityAt).toBe(T1)
    const T2 = BASE_TIME + 20_000
    vi.setSystemTime(T2)
    await settleLastCommand(p)
    expect(client.lastActivityAt).toBe(T2)
  })

  it('带 maintenance 标记的 sendCommand 出站与回程均不刷新（维护通道双腿排除）', async () => {
    // 先用普通调用把时钟推到 T1
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    await settleLastCommand(client.sendCommand('get_state', {}, 60_000))
    expect(client.lastActivityAt).toBe(T1)

    // T2 时刻的维护调用（promptReload 形态）：出站腿不刷新
    const T2 = BASE_TIME + 20_000
    vi.setSystemTime(T2)
    const maintenanceP = client.sendCommand('prompt', { message: '/__taiji_reload__' }, 60_000, { maintenance: true })
    expect(client.lastActivityAt).toBe(T1)
    // 回程 response（T3 到达）也不刷新（D1 双腿闭合）：回程回声与出站请求同频，若回程
    // touch，skill 变更风暴下空闲时钟仍被周期性重置、回收饿死原样保留（审查缺口 D1）
    const T3 = BASE_TIME + 30_000
    vi.setSystemTime(T3)
    await settleLastCommand(maintenanceP)
    expect(client.lastActivityAt).toBe(T1)
  })

  it('maintenance response 不 touch 不波及事件帧：事件帧照常 touch', async () => {
    // 维护调用挂 pending 后到达的事件帧在 T2 正常 touch（早期帧缓冲路径同样先经入口）；
    // 随后 maintenance response 在 T3 到达不改写——豁免精确限定在「maintenance pending
    // 的 response 帧」，事件帧 touch 语义零变化
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    const maintenanceP = client.sendCommand('prompt', { message: '/__taiji_reload__' }, 60_000, { maintenance: true })
    const T2 = BASE_TIME + 20_000
    vi.setSystemTime(T2)
    emitPiLine({ type: 'session_info_changed', payload: { label: 'x' } })
    expect(client.lastActivityAt).toBe(T2)
    const T3 = BASE_TIME + 30_000
    vi.setSystemTime(T3)
    await settleLastCommand(maintenanceP)
    expect(client.lastActivityAt).toBe(T2)
  })

  it('prompt 维护标记透传：maintenance 调用不刷新，普通调用刷新', async () => {
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    const maintenanceP = client.prompt('/__taiji_reload__', undefined, undefined, { maintenance: true })
    // 语义方法 prompt 的 options 透传 sendCommand：出站与回程双腿均不刷新
    expect(client.lastActivityAt).toBe(BASE_TIME)
    await settleLastCommand(maintenanceP)
    expect(client.lastActivityAt).toBe(BASE_TIME)

    const T2 = BASE_TIME + 20_000
    vi.setSystemTime(T2)
    const p = client.prompt('hello')
    expect(client.lastActivityAt).toBe(T2)
    // 透传不改 prompt 的 RPC 形态：仍是 type=prompt + message 字段
    expect(lastWrittenJson()).toMatchObject({ type: 'prompt', message: 'hello' })
    await settleLastCommand(p)
    // 普通 prompt 的回程 response 照常 touch（此刻时钟仍在 T2）
    expect(client.lastActivityAt).toBe(T2)
  })

  it('入站 handleMessage 刷新（事件帧，listener 路径）', () => {
    const T3 = BASE_TIME + 30_000
    vi.setSystemTime(T3)
    // 无 pending id 的事件帧（listeners 空窗时进早期帧缓冲，同样先经 handleMessage 入口）
    emitPiLine({ type: 'session_info_changed', payload: { label: 'x' } })
    expect(client.lastActivityAt).toBe(T3)
  })

  it('sendRaw 不刷新（内部调试旁路，D1 明确排除）', () => {
    const T3 = BASE_TIME + 30_000
    vi.setSystemTime(T3)
    emitPiLine({ type: 'session_info_changed', payload: { label: 'x' } })
    expect(client.lastActivityAt).toBe(T3)

    const T4 = BASE_TIME + 40_000
    vi.setSystemTime(T4)
    client.sendRaw(JSON.stringify({ type: 'extension_ui_response', id: 'ui_1', value: 'y' }) + '\n')
    expect(client.lastActivityAt).toBe(T3)
    // 旁路确实发出（排除「写入失败导致不刷新」的假绿）
    expect(lastWrittenJson()).toMatchObject({ type: 'extension_ui_response' })
  })

  it('touchActivity() 手动刷新（dispatcher 入口同步 touch 的公开写入口）', () => {
    const T5 = BASE_TIME + 50_000
    vi.setSystemTime(T5)
    client.touchActivity()
    expect(client.lastActivityAt).toBe(T5)
  })
})
