/**
 * RpcClient compact RPC 超时常量测试（timeout-slow-flow-wallclock D3，u-y3）。
 *
 * 锁定（runtime 第一刀收口机制，P4 探针的单元级缩样）：
 * - compact() 超时引用 shared COMPACT_RPC_TIMEOUT_MS（30min）——边界内 1ms 不误杀，
 *   边界到点以 RpcTimeoutError{commandType:"compact", timeoutMs:30min} reject（D3a 字段化）。
 * - 与 bash 常量（BASH_RPC_TIMEOUT_MS）无跨粒级共用：compact 收口早于 bash 第一刀。
 *
 * 策略：沿用 rpc-client-bash-timeout.test.ts 的 mock 骨架（node:child_process
 * + fake streams），fake timers 驱动超时墙钟（STARTUP_DELAY_MS / RPC timer 均走同一时钟）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-compact-timeout.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcClient } from '../rpc-client.js'
import { RpcTimeoutError } from '../../../utils/errors.js'
import { COMPACT_RPC_TIMEOUT_MS, RENDERER_RPC_MARGIN_MS, BASH_RPC_TIMEOUT_MS } from '@xyz-agent/shared'

// ── Mocks（对齐 rpc-client-bash-timeout.test.ts 骨架）────────────────

type DataHandler = (data: Buffer) => void

function makeFakeStream() {
  const dataHandlers: DataHandler[] = []
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandlers.push(handler as DataHandler)
    }),
    resume: vi.fn(),
    destroy: vi.fn(),
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

async function startClient(): Promise<RpcClient> {
  const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（fake timers 下同样省一步 timer）
const client = new RpcClient({ ...clientOpts })
  const startP = client.start()
  // STARTUP_DELAY_MS（500ms）：fake timers 下推进启动确认窗口让 start() settle
  await vi.advanceTimersByTimeAsync(500)
  await startP
  return client
}

describe('compact() 超时 —— shared COMPACT_RPC_TIMEOUT_MS 引用断言（D3）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('常量前提：COMPACT_RPC_TIMEOUT_MS = 30min，且 < BASH_RPC_TIMEOUT_MS（无跨粒级共用）', () => {
    expect(COMPACT_RPC_TIMEOUT_MS).toBe(1_800_000)
    expect(COMPACT_RPC_TIMEOUT_MS).toBeLessThan(BASH_RPC_TIMEOUT_MS)
  })

  it('边界内 1ms 不误杀；到点以 RpcTimeoutError{commandType:"compact", timeoutMs:1_800_000} reject', async () => {
    const client = await startClient()
    let rejected: unknown
    const p = client.compact().catch((e) => { rejected = e })
    await vi.advanceTimersByTimeAsync(COMPACT_RPC_TIMEOUT_MS - 1)
    expect(rejected).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(rejected).toBeInstanceOf(RpcTimeoutError)
    expect((rejected as RpcTimeoutError).commandType).toBe('compact')
    expect((rejected as RpcTimeoutError).timeoutMs).toBe(1_800_000)
  })

  it('校准链余量前提：renderer backstop（COMPACT + MARGIN）晚于 runtime 第一刀至少 MARGIN', () => {
    // 结构保证（D3）：renderer 恒不先于 runtime 判死——backstop 与第一刀共用 shared 常量，
    // 余量恒为正。此断言与 shared timeouts.test.ts 关系断言同源双保险。
    expect(COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS).toBeGreaterThan(COMPACT_RPC_TIMEOUT_MS)
  })
})
