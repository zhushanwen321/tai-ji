/**
 * RpcClient 活动时钟（lastActivityAt）测试（观测面）。
 *
 * 锁定：
 * - 初值 = spawn 时刻（start() 内重置；构造时刻仅未 start 形态兜底）
 * - 出站 sendCommand 是唯一出站咽喉：调用即同步刷新（不等 RPC 往返）
 * - 入站 handleMessage 是唯一入站咽喉：任何 stdout 帧（response / 事件）刷新
 * - sendRaw 是内部调试旁路，不刷新
 *
 * 退役登记（ADR-0112 防御机制清查）：空闲回收判定消费（idle-pi-reclamation D1/D6-1）、
 * maintenance 维护通道双腿排除、touchActivity 手动刷新已随空闲回收机制整体删除；
 * 活动时钟保留为观测面（crash 取证「死前最后活动时刻」等）。
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
    on: vi.fn(),
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

function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutDataHandler) throw new Error('stdout data handler not registered yet')
  stdoutDataHandler(JSON.stringify(obj) + '\n')
}

function lastWrittenJson(): Record<string, unknown> {
  const last = stdinWrites[stdinWrites.length - 1]
  return JSON.parse(last)
}

/** 用伪造 response settle 最后一条 sendCommand（无墙钟超时，不 settle 会真悬挂）。 */
async function settleLastCommand(p: Promise<unknown>): Promise<void> {
  const sent = lastWrittenJson()
  emitPiLine({ type: 'response', command: sent.type, id: sent.id, success: true, data: {} })
  await p
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient 活动时钟 lastActivityAt（观测面）', () => {
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
    await client.start()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初值 = spawn 时刻（start() 同步段重置，非构造时刻）', () => {
    // 区分力（审查修正）：构造兜底初值在 BASE_TIME-10_000（beforeEach 构造前时钟），
    // start() 内 spawn 后同步重置为 BASE_TIME——误删 start() 内重置行本断言红。
    expect(client.lastActivityAt).toBe(BASE_TIME)
  })

  it('出站 sendCommand 同步刷新（调用即刷新，不等 RPC 往返）', async () => {
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    const p = client.sendCommand('get_state', {})
    // 同步断言：sendCommand 返回 Promise 的 executor 同步执行，touch 不依赖微任务
    expect(client.lastActivityAt).toBe(T1)
    await settleLastCommand(p)
  })

  it('response 回程照常刷新（入站帧均为真实活动）', async () => {
    // 出站在 T1 touch；回程 response 在 T2 到达
    const T1 = BASE_TIME + 10_000
    vi.setSystemTime(T1)
    const p = client.sendCommand('get_state', {})
    expect(client.lastActivityAt).toBe(T1)
    const T2 = BASE_TIME + 20_000
    vi.setSystemTime(T2)
    await settleLastCommand(p)
    expect(client.lastActivityAt).toBe(T2)
  })

  it('入站 handleMessage 刷新（事件帧，listener 路径）', () => {
    const T3 = BASE_TIME + 30_000
    vi.setSystemTime(T3)
    // 无 pending id 的事件帧（listeners 空窗时进早期帧缓冲，同样先经 handleMessage 入口）
    emitPiLine({ type: 'session_info_changed', payload: { label: 'x' } })
    expect(client.lastActivityAt).toBe(T3)
  })

  it('sendRaw 不刷新（内部调试旁路）', () => {
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
})
