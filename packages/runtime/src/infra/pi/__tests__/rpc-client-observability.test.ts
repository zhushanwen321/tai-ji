/**
 * RpcClient 观测补齐测试（u-observability，设计 file-lock-unification-and-reaper-sink
 * §3.2-D4：D4 表两行——XYZ_AGENT_EXT_LOG 注入 + pi 崩溃 stderr 全量落盘）。
 *
 * 锁定：
 * - B（U3-3）：spawn env 经 buildOutboundChildEnv extras 通道恒注入 XYZ_AGENT_EXT_LOG=1
 *   （xyz 托管环境 extension 日志 INFO 档的开关；deny 剥除语义不受影响）。
 * - C（U3-4）：exit handler 异常退出（code≠0 且非主动 kill）→ writePiCrashLog 收到
 *   累计 stderr 全量（旧 50 行 ring buffer 截断消灭）+ 头部元信息；code=0 正常退出与
 *   _killing 主动 kill 不写；code=null（信号死亡）属异常退出照写；超 1MB 字节上限丢
 *   最旧并标注 truncated；exitCallback 的 stderr 载荷仍为尾部（展示路径不变）。
 *
 * 策略：沿用 rpc-client-exit-multicast.test.ts 的 mock 骨架（node:child_process），
 * 差异：stderr fake stream 捕获 'data' handler 可注入行；logger 模块 mock
 * 提供 writePiCrashLog spy 记录调用（生产 rpc-client 对该符号 optional-call，此处提供
 * spy 验证真实接线）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-observability.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcClient } from '../rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks ────────────────────────────────────────────────────────

/** writePiCrashLog 调用记录（vi.hoisted：vi.mock 工厂引用的外部状态须同提升） */
interface CrashLogCall {
  sessionId: string | undefined
  content: string
}
const crashLogCalls = vi.hoisted((): CrashLogCall[] => [])

type DataHandler = (data: Buffer) => void

/** fake stdout/stderr stream：捕获 'data' / 'error' handler，测试可 emitData 驱动 */
function makeFakeStream() {
  const dataHandlers: DataHandler[] = []
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandlers.push(handler as DataHandler)
    }),
    resume: vi.fn(),
    destroy: vi.fn(),
    /** 丢弃旧 client 注册的 handler（模块级单例，跨用例复用须显式清） */
    reset(): void {
      dataHandlers.length = 0
    },
    emitData(text: string): void {
      for (const h of [...dataHandlers]) h(Buffer.from(text, 'utf8'))
    },
  }
}

const stdoutStream = makeFakeStream()
const stderrStream = makeFakeStream()
let procExitHandlers: Array<(code: number | null) => void> = []

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

let capturedEnv: Record<string, string> | null = null

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
    capturedEnv = opts?.env ?? null
    return fakeProc
  },
}))

vi.mock('@xyz-agent/shared', async (importOriginal) => {
  // 保留真实导出（rpc-client 经 infra/spawn-env 门面消费构建器本体），仅收窄白名单前缀
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
  writePiCrashLog: (sessionId: string | undefined, content: string) => {
    crashLogCalls.push({ sessionId, content })
  },
}))

// ── Helpers ──────────────────────────────────────────────────────

/** 模拟 OS 发出 proc 'exit' 事件 */
function emitProcExit(code: number | null = null): void {
  for (const h of [...procExitHandlers]) h(code)
}

async function startClient(options: Record<string, unknown> = {}): Promise<RpcClient> {
  const { RpcClient } = await import('../rpc-client.js')
  const client = new RpcClient({ ...clientOpts, cwd: '/project', sessionId: 'sid-obs-1', ...options })
  await client.start()
  return client
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient spawn env：XYZ_AGENT_EXT_LOG 注入（U3-3）', () => {
  beforeEach(() => {
    capturedEnv = null
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    stdoutStream.reset()
    stderrStream.reset()
    crashLogCalls.length = 0
  })

  it('spawn env 恒含 XYZ_AGENT_EXT_LOG=1（extras 通道出站）', async () => {
    await startClient()
    expect(capturedEnv).not.toBeNull()
    expect(capturedEnv!.XYZ_AGENT_EXT_LOG).toBe('1')
  })

  it('必备注入键不受影响：PI_CODING_AGENT_DIR 在场，deny 键仍被剥除', async () => {
    vi.stubEnv('XYZ_RUNTIME_TOKEN', 'leaked-token')
    try {
      await startClient()
      expect(capturedEnv!.PI_CODING_AGENT_DIR).toBe('/mock/home/.xyz-agent/agent')
      expect(capturedEnv!.XYZ_AGENT_EXT_LOG).toBe('1')
      expect(capturedEnv).not.toHaveProperty('XYZ_RUNTIME_TOKEN')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('RpcClient exit handler：崩溃 stderr 全量落盘（U3-4）', () => {
  beforeEach(() => {
    capturedEnv = null
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    stdoutStream.reset()
    stderrStream.reset()
    crashLogCalls.length = 0
  })

  it('异常退出（code=1）：writePiCrashLog 收到 sessionId + 全量 stderr + 头部元信息', async () => {
    const client = await startClient()
    stderrStream.emitData('line-1: boot ok\n')
    stderrStream.emitData('line-2: TypeError: boom\n')
    stderrStream.emitData('line-3: at factory\n')

    emitProcExit(1)

    expect(crashLogCalls).toHaveLength(1)
    const { sessionId, content } = crashLogCalls[0]!
    expect(sessionId).toBe('sid-obs-1')
    // 全量：三行全在场（旧 50 行 ring buffer 语义下同样在场，此处锁定不回归）
    expect(content).toContain('line-1: boot ok')
    expect(content).toContain('line-2: TypeError: boom')
    expect(content).toContain('line-3: at factory')
    // 头部元信息：exit code 可归因（自包含诊断，无需交叉查主日志）
    expect(content).toContain('pi crashed with code 1')
    expect(content).not.toContain('truncated')
    void client
  })

  it('正常退出（code=0）不写 crash log', async () => {
    await startClient()
    stderrStream.emitData('some noise\n')
    emitProcExit(0)
    expect(crashLogCalls).toHaveLength(0)
  })

  it('主动 kill 流程（_killing=true）不写 crash log', async () => {
    const client = await startClient()
    stderrStream.emitData('before kill\n')
    const killPromise = client.kill()
    // kill() 置 _killing 后发信号；此处模拟进程以非零码死亡（kill 流程常态）
    emitProcExit(143)
    await killPromise
    expect(crashLogCalls).toHaveLength(0)
  })

  it('code=null（信号死亡，非主动 kill）属异常退出：照写 crash log', async () => {
    await startClient()
    stderrStream.emitData('died by signal\n')
    emitProcExit(null)
    expect(crashLogCalls).toHaveLength(1)
    expect(crashLogCalls[0]!.content).toContain('pi crashed with code null')
    expect(crashLogCalls[0]!.content).toContain('died by signal')
  })

  it('超过旧 50 行 ring buffer 容量的 stderr 全量保留（首行在场 = 截断消灭）', async () => {
    await startClient()
    for (let i = 1; i <= 60; i++) {
      stderrStream.emitData(`overflow-line-${i}\n`)
    }
    emitProcExit(1)
    expect(crashLogCalls).toHaveLength(1)
    const content = crashLogCalls[0]!.content
    expect(content).toContain('overflow-line-1')
    expect(content).toContain('overflow-line-60')
  })

  it('超 1MB 字节上限：丢最旧 + crash log 头部标注 truncated（内存防御边界）', async () => {
    await startClient()
    // 600 行 × 2KB ≈ 1.2MB > 1MB 上限：首部行被丢，truncated 标注在场
    const chunk = 'x'.repeat(2048)
    for (let i = 1; i <= 600; i++) {
      stderrStream.emitData(`${chunk}-${i}\n`)
    }
    emitProcExit(1)
    expect(crashLogCalls).toHaveLength(1)
    const { content } = crashLogCalls[0]!
    expect(content).toContain('stderr truncated')
    // 最早 50 行（~100KB）已被丢弃
    expect(content).not.toContain(`${chunk}-1\n`)
    // 尾部行仍在
    expect(content).toContain(`${chunk}-600`)
  })

  it('exitCallback 的 stderr 载荷仍为尾部（展示路径语义不变）', async () => {
    const client = await startClient()
    const exits: Array<[number | null, string]> = []
    client.onExit((code, stderr) => exits.push([code, stderr]))
    for (let i = 1; i <= 15; i++) {
      stderrStream.emitData(`tail-line-${i}\n`)
    }
    emitProcExit(1)
    expect(exits).toHaveLength(1)
    expect(exits[0]![0]).toBe(1)
    // 载荷 = 尾部 10 行（STDERR_TAIL_LINES），不含头部行
    expect(exits[0]![1]).toContain('tail-line-15')
    expect(exits[0]![1]).not.toContain('tail-line-1\n')
    expect(exits[0]![1].split('\n')).toHaveLength(10)
  })
})
