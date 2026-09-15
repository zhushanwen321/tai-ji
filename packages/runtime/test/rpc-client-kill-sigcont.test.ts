/**
 * RpcClient kill 链信号顺序测试（integrity-hardening D3a）。
 *
 * 覆盖：destroySession → client.kill() 的强杀链在 SIGTERM 前先发 SIGCONT——
 * 唤醒可能被 SIGSTOP 冻结的进程（事件循环卡死的一种形态），否则 SIGTERM 被冻结
 * 状态吞掉、只能等 2s 后 SIGKILL，丢失优雅退出路径（扩展落盘）的执行机会。
 *
 * 断言：
 * - kill() 立即按序发 SIGCONT → SIGTERM（SIGCONT 必须在前）
 * - 进程 2s 内未退 → SIGKILL 兜底（KILL_TIMEOUT_MS）
 * - 进程按 SIGTERM 退出后不再发 SIGKILL
 *
 * 测试策略与 rpc-client-timeout.test.ts 一致：mock node:child_process 的 spawn，
 * fakeTimer 驱动 KILL_TIMEOUT_MS，手动驱动 exit handlers。
 *
 * 运行：npx vitest run test/rpc-client-kill-sigcont.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../src/infra/pi/rpc-client.js'

// ── Mocks（骨架复制自 rpc-client-timeout.test.ts）─────────────────

let procExitHandlers: Array<(code: number | null) => void> = []
let RpcClientCtor: typeof import('../src/infra/pi/rpc-client.js').RpcClient

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: { write: vi.fn(() => true), once: vi.fn() },
  /** 信号调用记录：[['SIGCONT'], ['SIGTERM'], ...] */
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
}))

// importOriginal spread 而非完全替换：rpc-client.start 经 ../spawn-env.js re-export 消费
// shared 的 buildOutboundChildEnv（纯函数、env 全 DI），完全替换式 mock 会随 shared 新增
// 导出静默断联（b5d3e6329 事故根因）；此处仅覆盖测试需要隔离的常量。
vi.mock('@taiji/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/shared')>()),
  ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
}))

vi.mock('@taiji/shared/paths', () => ({
  getDataDir: () => '/mock/home/.taiji',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

/** fakeProc.kill 收到的信号序列。 */
function killSignals(): string[] {
  return (fakeProc.kill.mock.calls as unknown[][]).map((c) => String(c[0]))
}

/** 模拟进程退出（fakeProc.kill 不触发真实 exit 事件，手动驱动收集到的 handlers）。 */
function emitExit(code: number | null): void {
  procExitHandlers.forEach((h) => h(code))
  procExitHandlers = []
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RpcClient kill 链信号顺序（D3a：SIGCONT 先于 SIGTERM）', () => {
  let client: RpcClient

  beforeEach(async () => {
    procExitHandlers = []
    fakeProc.kill.mockClear()
    RpcClientCtor = (await import('../src/infra/pi/rpc-client.js')).RpcClient
    client = new RpcClientCtor({ cwd: '/project' })
    await client.start()
    // start 的 500ms startup 检查已结束，其注册的 exit handlers 已被 cleanup 移除
    procExitHandlers = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('kill() 立即按序发 SIGCONT → SIGTERM（SIGCONT 唤醒冻结进程，让 SIGTERM 优雅退出有机会执行）', async () => {
    vi.useFakeTimers()
    const killPromise = client.kill()
    await Promise.resolve()

    const signals = killSignals()
    expect(signals[0]).toBe('SIGCONT')
    expect(signals[1]).toBe('SIGTERM')
    // 此刻不应有 SIGKILL（killTimer 2s 未到）
    expect(signals).not.toContain('SIGKILL')

    emitExit(0)
    await killPromise
    // 进程已退，无 SIGKILL 兜底
    expect(killSignals()).toEqual(['SIGCONT', 'SIGTERM'])
  })

  it('进程不退 → 2s（KILL_TIMEOUT_MS）后 SIGKILL 兜底，kill() 保证 resolve', async () => {
    vi.useFakeTimers()
    const killPromise = client.kill()
    await Promise.resolve()

    // SIGTERM 被冻结/无视，推进 2s 触发 SIGKILL
    vi.advanceTimersByTime(2_000)
    expect(killSignals()).toEqual(['SIGCONT', 'SIGTERM', 'SIGKILL'])

    emitExit(null)
    await killPromise
  })
})
