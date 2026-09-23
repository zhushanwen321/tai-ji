/**
 * RpcClient.lastEventAt 记录语义测试（chat-domain-v1x-liveness-governance W7 桥事件窗信号）。
 *
 * 锁定（abort 超时阶梯三信号之一「bridge 事件窗产出」的采集侧）：
 * - E1a: 事件帧（type !== 'response'）到达 stdout → lastEventAt 更新为到达时刻
 * - E1b: RPC response 帧（含迟到被丢弃形态之外的正常 resolve）不更新活跃戳（RPC 活性
 *        归快超时探测信号专责，两信号职责正交——见 rpc-client._lastEventAt 字段注释）
 * - E1c: 从未收到事件帧 → undefined（消费方 readClientLastEventAt 归 0 = 冻结方向证据）
 *
 * 文件位置说明：RpcClient 常规测试目录（src/__tests__ / infra/pi/__tests__）不在 W7 领地
 * （services/session/__tests__/**），本文件按领地约束落位；mock 模式照搬
 * src/__tests__/rpc-client-response-guard.test.ts（mock node:child_process + emitPiLine
 * 投伪造 pi stdout 行，测真实 handleMessage 分派）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/rpc-client-last-event-at.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../../../infra/pi/rpc-client.js'

// ── Mocks（与 rpc-client-response-guard.test.ts 同构）──────────────────────

let stdoutDataHandler: ((chunk: Buffer | string) => void) | null = null
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
    write: vi.fn(() => true),
    on: vi.fn(),
    once: vi.fn(),
  },
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))

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
}))

function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutDataHandler) throw new Error('stdout data handler not registered yet')
  stdoutDataHandler(JSON.stringify(obj) + '\n')
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient.lastEventAt —— W7 桥事件窗信号采集', () => {
  let client: RpcClient

  beforeEach(async () => {
    stdoutDataHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()

    const { RpcClient: Ctor } = await import('../../../infra/pi/rpc-client.js')
    client = new Ctor({ cwd: '/project' })
    // fake timers 后置到 start 之前：start 的启动确认窗（awaitStartupSettled 的
    // setTimeout(STARTUP_DELAY_MS)）被冻结，须 advanceTimersByTimeAsync 推过窗口才 resolve。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    const startP = client.start()
    await vi.advanceTimersByTimeAsync(600)
    await startP
  })

  afterEach(async () => {
    // kill 的兜底 timer（KILL_TIMEOUT_MS）同样被冻结：fakeProc.kill 不真杀进程、exit
    // handler 无人触发——先注册 kill 的 exit 监听再手动触发，让 kill 立即 resolve。
    try {
      const killP = client.kill()
      for (const h of procExitHandlers) h(0)
      await killP
    } catch { /* noop */ }
    procExitHandlers = []
    vi.useRealTimers()
  })

  it('E1a: 事件帧到达更新活跃戳（时间随到达时刻推进）', async () => {
    expect(client.lastEventAt).toBeUndefined()

    const t1 = Date.now()
    emitPiLine({ type: 'message_start', id: 'rpc_1_x' })
    expect(client.lastEventAt).toBe(t1)

    vi.setSystemTime(t1 + 5_000)
    emitPiLine({ type: 'turn_end' })
    expect(client.lastEventAt).toBe(t1 + 5_000)
  })

  it('E1b: RPC response 帧不更新活跃戳（RPC 活性归探测信号专责）', async () => {
    // 先经事件帧建立基线，再投 response 帧——活跃戳不动
    emitPiLine({ type: 'message_start' })
    const baseline = client.lastEventAt
    expect(baseline).toBeDefined()
    if (baseline === undefined) return

    vi.setSystemTime(baseline + 10_000)
    // response 帧带未注册 pending 的 id（不进 resolve 分支也不进事件分支）
    emitPiLine({ type: 'response', id: 'rpc_999_unknown', success: true })
    expect(client.lastEventAt).toBe(baseline)
  })

  it('E1c: 从未收到事件帧 → undefined（消费方归 0 = 冻结方向证据）', async () => {
    emitPiLine({ type: 'response', id: 'rpc_1_unknown', success: true })
    expect(client.lastEventAt).toBeUndefined()
  })
})
