/**
 * RpcClient bash/abortBash 透传测试（composer-bash-execute W1）。
 *
 * 锁定：
 * - bash(command, excludeFromContext) → sendCommand('bash', {command[, excludeFromContext]})，
 *   excludeFromContext undefined 时不传该键（走 pi 默认），显式 true/false 时透传。
 * - 返回值归一为 PiBashResult（sendCommand 已归一 data ?? payload）。
 * - abortBash() → sendCommand('abort_bash')，无参数。
 *
 * 策略：RpcClient.sendCommand 是 protected，无法直接 spy。沿用 test/rpc-client.test.ts 的
 * mock node:child_process + readline 模式——捕获 stdin 写入的命令结构 + 投递伪造 pi response
 * 驱动 pending resolve。这样测的是真实 bash/abortBash 方法（不绕过实现）。
 *
 * 运行：npx vitest run src/__tests__/rpc-client-bash.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../infra/pi/rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks（与 test/rpc-client.test.ts 同构）──────────────────────

const stdinWrites: string[] = []
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

vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))

// D10 后 stdout 分帧走 rpc-client 自实现的 LF-only 读取器（同模块直调，无法从模块边界 mock）。
// 测试改为在 fake stdout 上桥接 'data' handler，emitPiLine 直投「整行 + \n」由读取器分帧——
// 投递时序与旧 readline 桥接一致（同步直调）；LF-only 分帧行为由 rpc-client-lf-framing.test.ts 专项覆盖。

vi.mock('@xyz-agent/shared', async (importOriginal) => {
  // U3 起 rpc-client 经 infra/spawn-env 门面消费 shared 的 buildOutboundChildEnv；
  // mock 需保留真实导出（否则构建器为 undefined），仅收窄白名单前缀获得可控基座
  const actual = await importOriginal<typeof import('@xyz-agent/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@xyz-agent/shared/paths', () => ({ getDataDir: () => '/mock/home/.xyz-agent' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
  }
})

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  // u5b D6-④：rpc-client 新增 import 的内存快照采集（mock 面随源码 import 面同步）
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

// ── Helpers ──────────────────────────────────────────────────────

function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutDataHandler) throw new Error('stdout data handler not registered yet')
  stdoutDataHandler(JSON.stringify(obj) + '\n')
}

function lastWrittenJson(): Record<string, unknown> {
  const last = stdinWrites[stdinWrites.length - 1]
  return JSON.parse(last)
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient bash/abortBash 透传', () => {
  let client: RpcClient

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutDataHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()

    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  // T1: bash(command, false) → sendCommand('bash', {command, excludeFromContext:false})
  it('T1: bash("git status", false) → 写入 {type:"bash", command, excludeFromContext:false} + 返回值归一为 PiBashResult', async () => {
    const resultPromise = client.bash('git status', false)
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')
    expect(sent.command).toBe('git status')
    expect(sent.excludeFromContext).toBe(false)

    // pi 回 success + data（PiBashResult 结构），归一后应原样返回
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: 'nothing to commit', exitCode: 0, cancelled: false, truncated: false },
    })

    const result = await resultPromise
    expect(result).toEqual({
      output: 'nothing to commit',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    })
  })

  // T2: bash(command) 不传第二参 → params 不含 excludeFromContext 键
  it('T2: bash("pwd") 不传 excludeFromContext → 写入的 params 不含 excludeFromContext 键', async () => {
    const resultPromise = client.bash('pwd')
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')
    expect(sent.command).toBe('pwd')
    // 关键：键不存在，走 pi 默认
    expect(sent).not.toHaveProperty('excludeFromContext')

    // 让 pending resolve
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: '/project', exitCode: 0, cancelled: false, truncated: false },
    })
    const result = await resultPromise
    expect(result.output).toBe('/project')
  })

  // T3: abortBash() → sendCommand('abort_bash')，无业务参数
  it('T3: abortBash() → 写入 {type:"abort_bash"}（无 command 等业务参数）', async () => {
    const resultPromise = client.abortBash()
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('abort_bash')
    // abort_bash 无业务参数（不传 command）
    expect(sent).not.toHaveProperty('command')

    // 让 pending resolve
    emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
    await resultPromise
  })

  // T3b: bash(command, true) → excludeFromContext 透传 true（覆盖显式 true 分支）
  it('T3b: bash("ls", true) → 写入 excludeFromContext:true（显式 true 透传）', async () => {
    const resultPromise = client.bash('ls', true)
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.excludeFromContext).toBe(true)

    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: 'a\n', exitCode: 0, cancelled: false, truncated: false },
    })
    await resultPromise
  })
})
