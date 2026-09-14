/**
 * RpcClient onExit 多播 + stream error 单一出口测试（pi-exit-notification Wave 1，
 * 设计文档 §6.3/§6.5/§7.1）。
 *
 * 锁定：
 * - onExit 多播：多个订阅者都收到 exit 通知；unsubscribe 后该订阅者不再收
 *   （废除单槽覆盖语义——曾会静默覆盖 ProcessManager 的清理回调）。
 * - stdout/stderr stream error：handler 置 _exited + rejectAll 后调 ChildProcess 原生
 *   kill('SIGKILL')（非 this.kill()——后者置 _killing=true 会让 exit 通知被跳过）；
 *   stream error 本身不触发通知，死亡通知唯一出口是 proc 'exit' 事件，恰好一次（防双通知）。
 *
 * 策略：沿用 rpc-client-bash.test.ts 的 mock node:child_process 模式。
 * 差异：stdout/stderr 是可 emit 'error' 的 fake stream（捕获 handler）；proc.kill 只记录
 * 调用不自动 emit exit——exit 由测试手动 emit，才能断言「kill 已调但通知未发」的中间态
 * （mock 层验证调用，不依赖 OS 时序）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/rpc-client-exit-multicast.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcClient } from '../infra/pi/rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks（与 rpc-client-bash.test.ts 同构）──────────────────────

type StreamErrorHandler = (err: Error) => void

/** fake stdout/stderr stream：捕获 'error' handler，测试可 emitError 驱动 stream error 路径 */
function makeFakeStream() {
  const errorHandlers: StreamErrorHandler[] = []
  return {
    on: vi.fn((event: string, handler: StreamErrorHandler) => {
      if (event === 'error') errorHandlers.push(handler)
    }),
    resume: vi.fn(),
    destroy: vi.fn(),
    /** 丢弃旧 client 注册的 handler（stream 是模块级单例，跨用例复用须显式清） */
    reset(): void {
      errorHandlers.length = 0
    },
    emitError(err: Error): void {
      for (const h of [...errorHandlers]) h(err)
    },
  }
}

const stdoutStream = makeFakeStream()
const stderrStream = makeFakeStream()
const procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: stdoutStream,
  stderr: stderrStream,
  stdin: {
    write: vi.fn(() => true),
    once: vi.fn(),
  },
  // 只记录调用，不自动 emit exit：exit 由测试手动 emit（断言「kill ≠ 通知」的中间态）
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))

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

/** 模拟 OS 发出 proc 'exit' 事件 */
function emitProcExit(code: number | null = null): void {
  for (const h of [...procExitHandlers]) h(code)
}

/** 捕获 (code, stderr) 的 exit 订阅记录器 */
type ExitRecord = Array<[number | null, string]>

function recordExits(client: RpcClient): ExitRecord {
  const records: ExitRecord = []
  client.onExit((code, stderr) => records.push([code, stderr]))
  return records
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient onExit 多播（单槽覆盖语义已废除）', () => {
  let client: RpcClient

  beforeEach(async () => {
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    stdoutStream.reset()
    stderrStream.reset()
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project' })
    await client.start()
  })

  it('两个 onExit 订阅者都收到 exit 通知（含 code/stderr 载荷）', () => {
    const first: ExitRecord = []
    const second: ExitRecord = []
    client.onExit((code, stderr) => first.push([code, stderr]))
    client.onExit((code, stderr) => second.push([code, stderr]))

    emitProcExit(9)

    // stderr tail 为 ''（未收集到 stderr data）；两个订阅者载荷一致
    expect(first).toEqual([[9, '']])
    expect(second).toEqual([[9, '']])
  })

  it('unsubscribe 后该订阅者不再收，另一个仍收到', () => {
    const first: ExitRecord = []
    const second: ExitRecord = []
    const unsub = client.onExit((code, stderr) => first.push([code, stderr]))
    client.onExit((code, stderr) => second.push([code, stderr]))

    unsub()
    emitProcExit(9)

    expect(first).toEqual([])
    expect(second).toEqual([[9, '']])
  })
})

describe('RpcClient stream error → 原生 SIGKILL + exit 单一出口', () => {
  let client: RpcClient

  beforeEach(async () => {
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    stdoutStream.reset()
    stderrStream.reset()
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ cwd: '/project' })
    await client.start()
  })

  it('stdout error：调原生 kill("SIGKILL")（非 this.kill 的 SIGTERM），通知仅由 proc exit 恰好触发一次', () => {
    const exits = recordExits(client)

    stdoutStream.emitError(Object.assign(new Error('read EPIPE'), { code: 'EPIPE' }))

    // 加速回收：恰好一次、且是 SIGKILL（this.kill() 首个信号是 SIGTERM——若误用会被此断言证伪）
    expect(fakeProc.kill).toHaveBeenCalledTimes(1)
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(client.exited).toBe(true)

    // stream error 不是死亡通知出口：此刻尚未通知
    expect(exits).toEqual([])

    // 进程实际死亡（OS exit 事件）→ 恰好通知一次（防双通知）
    emitProcExit(null)
    expect(exits).toEqual([[null, '']])
  })

  it('stderr error：同样原生 kill("SIGKILL") + exit 单一出口', () => {
    const exits = recordExits(client)

    stderrStream.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

    expect(fakeProc.kill).toHaveBeenCalledTimes(1)
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(exits).toEqual([])

    emitProcExit(null)
    expect(exits).toEqual([[null, '']])
  })
})
