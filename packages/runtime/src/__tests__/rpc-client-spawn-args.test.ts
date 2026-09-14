/**
 * RpcClient spawn args 的 --model 拼接锁定（P1，pi-assumption final gate V1⑤）。
 *
 * 锁定：
 * - inheritSessionModel: true → 不拼 --model（options.model 显式值与全局默认兜底都被
 *   抑制）——restoreSession 附着恢复路径：pi CLI model 恒优先于 session entry 恢复，
 *   拼了就把用户切换过的模型静默压回默认。
 * - 不设开关 → 既有 launch 语义不变：options.model 显式优先，缺省回落全局默认兜底。
 *
 * 策略：mock node:child_process 捕获 spawn args（rpc-client-bash.test.ts 同构骨架，
 * 差异仅 spawn mock 记录第二参数）；getDefaultModel 以可控变量 mock（bash 测试固定
 * null，本测试用例间切换）。行为级「无 CLI model 附着 → entry 恢复」的真实验证在
 * equivalence/attach-lifecycle.test.ts 的 P1 用例（fixture model: null）。
 *
 * 运行：npx vitest run src/__tests__/rpc-client-spawn-args.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../infra/pi/rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks（骨架与 rpc-client-bash.test.ts 同构）──────────────────────

let capturedSpawnArgs: string[] = []
const stdinWrites: string[] = []
let procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
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
  spawn: (_cmd: string, args: string[]) => {
    capturedSpawnArgs = args
    return fakeProc
  },
}))

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
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
  }
})

/** 可控默认模型（用例间切换；null = 未配置全局默认） */
let defaultModelMock: { provider: string; modelId: string } | null = null

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => defaultModelMock }
})

vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  // u5b D6-④：rpc-client 新增 import 的内存快照采集（mock 面随源码 import 面同步）
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient spawn args --model 拼接（P1 inheritSessionModel）', () => {
  let client: RpcClient

  /** 取 args 中 --model 后面的值；无 --model 返回 null */
  function modelFlagValue(): string | null {
    const idx = capturedSpawnArgs.indexOf('--model')
    if (idx === -1) return null
    return capturedSpawnArgs[idx + 1] ?? null
  }

  async function startWith(options: { model?: string; inheritSessionModel?: boolean }): Promise<void> {
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project', ...options })
    await client.start()
  }

  beforeEach(() => {
    capturedSpawnArgs = []
    stdinWrites.length = 0
    procExitHandlers = []
    defaultModelMock = { provider: 'prov', modelId: 'global-default' }
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  it('T1: inheritSessionModel + 显式 options.model + 全局默认存在 → 不拼 --model', async () => {
    await startWith({ model: 'explicit/model', inheritSessionModel: true })
    expect(modelFlagValue()).toBeNull()
    // 其余基础 args 不受影响（--mode rpc 等仍在）
    expect(capturedSpawnArgs).toContain('--mode')
    expect(capturedSpawnArgs).toContain('rpc')
  })

  it('T2: inheritSessionModel + 无 options.model + 全局默认存在 → 不拼 --model（兜底同样被抑制）', async () => {
    await startWith({ inheritSessionModel: true })
    expect(modelFlagValue()).toBeNull()
  })

  it('T3: 不设开关 + options.model 显式 → --model 显式值（launch 语义不变）', async () => {
    await startWith({ model: 'explicit/model' })
    expect(modelFlagValue()).toBe('explicit/model')
  })

  it('T4: 不设开关 + 无 options.model → --model 全局默认兜底（既有行为锁定）', async () => {
    await startWith({})
    expect(modelFlagValue()).toBe('prov/global-default')
  })

  it('T5: 不设开关 + 无 options.model + 无全局默认 → 不拼 --model（pi 自行解析默认，既有行为）', async () => {
    defaultModelMock = null
    await startWith({})
    expect(modelFlagValue()).toBeNull()
  })
})
