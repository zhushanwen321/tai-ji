/**
 * ProcessManager onExit 死亡通知路径测试（pi-exit-notification Wave 1，设计文档 §6.4/§7.2）。
 *
 * 锁定：
 * - rekey(tempId → piSessionId) 后进程异常退出：onExit 回调以 clientToId 反查当前 id，
 *   清理 processes/clientToId 两个 Map，onSessionExit 收到 rekey 后的 id（非闭包捕获的
 *   tempId）——create 路径「僵尸 session」根因的回归测试。
 * - intentional destroy：destroySession 先删 Map 再 kill，后续 exit 事件不触发 onSessionExit。
 *
 * 策略：沿用 rpc-client-bash.test.ts 的 mock node:child_process 模式——
 * fakeProc 捕获 'exit' handler，测试手动 emit 模拟 kill -9（code null，信号致死形态）。
 * node:fs 的 existsSync/readdirSync mock 为 false/[]，让 findPiExecutable 确定性走 'pi'
 * fallback（不执行真实 which/nvm 扫描，保证 hermetic）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-exit.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProcessManager } from '../infra/pi/process-manager.js'

// ── Mocks（与 rpc-client-bash.test.ts 同构）──────────────────────

const procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn(() => true),
    once: vi.fn(),
  },
  // 模拟真实进程：收到 SIGTERM/SIGKILL 后异步死亡（信号致死 → exit code null）。
  // 让 destroySession 的 kill() 快速收口（不必等 2s SIGKILL 兜底超时）。
  kill: vi.fn((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      queueMicrotask(() => {
        for (const h of [...procExitHandlers]) h(null)
      })
    }
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
  // findPiExecutable 的 PATH 探测（execSync('which pi')）：抛错走 fallback，不执行真实命令
  execSync: () => {
    throw new Error('execSync mocked: not found')
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // findPiExecutable 所有探测点（dev resources / nvm / common locations）均未命中 → 走 'pi' fallback
  return { ...actual, existsSync: () => false, readdirSync: () => [] }
})

vi.mock('@taiji/shared', async (importOriginal) => {
  // U3 起 rpc-client/process-manager 链路经 infra/spawn-env 门面消费 shared 的
  // buildOutboundChildEnv；mock 需保留真实导出，仅收窄白名单前缀获得可控基座
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
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

/** 模拟 pi 进程异常死亡：OS 发出 exit 事件（kill -9 → code null） */
function emitProcExit(code: number | null = null): void {
  for (const h of [...procExitHandlers]) h(code)
}

// ── Tests ────────────────────────────────────────────────────────

describe('ProcessManager onExit 死亡通知', () => {
  let pm: ProcessManager

  beforeEach(async () => {
    // R3 隔离：本测试的 hermetic 前提是 findPiExecutable 走 'pi' fallback，但该函数
    // 先读 process.env.TAIJI_AGENT_PACKAGED 判打包分支（find-pi-executable.ts:26），
    // 打包版太极的 agent 会话内执行 vitest 时该变量泄入测试进程（P1 同款机制）→
    // findPackagedPi throw。显式压平为非打包态，维持设计意图。
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    const { ProcessManager } = await import('../infra/pi/process-manager.js')
    pm = new ProcessManager('/mock/project-root')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rekey 后进程异常退出：清理两个 Map，onSessionExit 收到 rekey 后的 id（非 tempId）', async () => {
    const exitEvents: Array<{ sessionId: string; code: number | null; stderr: string }> = []
    pm.onSessionExit((sessionId, code, stderr) => exitEvents.push({ sessionId, code, stderr }))

    // create 路径：tempId spawn → pi 返回真实 sessionId 后 rekey 改键
    await pm.createSession('temp-id-1', '/project')
    pm.rekey('temp-id-1', 'pi-session-id-real')
    expect(pm.hasClient('pi-session-id-real')).toBe(true)

    emitProcExit(null) // 模拟 kill -9

    // Map 清理：按当前 id（rekey 后）删除，无残留
    expect(pm.getClient('pi-session-id-real')).toBeUndefined()
    expect(pm.hasClient('pi-session-id-real')).toBe(false)
    expect(pm.getClient('temp-id-1')).toBeUndefined()
    expect(pm.size).toBe(0)

    // 死亡通知必须带真实 id——闭包捕获的 tempId 正是僵尸 session 根因
    expect(exitEvents).toEqual([{ sessionId: 'pi-session-id-real', code: null, stderr: '' }])
  })

  it('intentional destroy：destroySession 后的 exit 事件不触发 onSessionExit', async () => {
    const exitEvents: Array<{ sessionId: string; code: number | null; stderr: string }> = []
    pm.onSessionExit((sessionId, code, stderr) => exitEvents.push({ sessionId, code, stderr }))

    await pm.createSession('s1', '/project')
    expect(pm.hasClient('s1')).toBe(true)

    // destroySession：先删 Map 再 kill（kill mock 异步触发 exit，属主动清理路径）
    await pm.destroySession('s1')
    expect(pm.hasClient('s1')).toBe(false)

    // 主动 kill 的 exit（异步已触发）+ 迟到的重复 exit 均不得通知上层
    await Promise.resolve() // 排空 kill mock 的 queueMicrotask
    emitProcExit(null)
    emitProcExit(1)

    expect(exitEvents).toEqual([])
  })
})
