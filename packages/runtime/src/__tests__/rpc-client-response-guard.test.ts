/**
 * RpcClient handleMessage resolve 守卫回归测试（data-source-governance review findings #7）。
 *
 * 锁定：
 * - pi 0.84.1 新增 bash_execution_update 流事件复用发起 bash RPC 的 id 且先于 response 到达
 *   （node_modules @earendil-works/pi-coding-agent dist/core/agent-session.js:2210 executeBash
 *   onChunk 回调 `this._emit({ type: "bash_execution_update", id: options?.id, delta })`；
 *   docs/rpc.md:26「bash_execution_update events also include the id of their originating
 *   bash command」）。handleMessage 仅凭 id 命中 pending 就 resolve 会把首条 delta 误当
 *   response（真 response 到达时 pending 已删 → 真实 output 丢失，bash() shape guard 落
 *   [protocol error: malformed] fallback——`!` bash live 输出丢失事故的根因）。
 * - 守卫：resolve 只认 type === 'response'（pi rpc-types.ts RpcResponse union 所有变体
 *   type:'response'）；非 response 的带 id 消息走 listener 路径（event-adapter NULL_EVENTS
 *   已登记 bash_execution_update 为 no-op）。
 *
 * 红性：删掉 handleMessage 的 type 守卫后 T1 三条断言（pending 未被流事件 settle /
 * resolve 到真 response 的 output / 流事件进 listener）必红。
 *
 * 策略：与 rpc-client-bash.test.ts 同构——mock node:child_process + readline，捕获 stdin
 * 写入的命令 + emitPiLine 投递伪造 pi stdout 行，测真实 bash 方法与 handleMessage 分派。
 *
 * 运行：npx vitest run src/__tests__/rpc-client-response-guard.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient, PiMessage } from '../infra/pi/rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks（与 rpc-client-bash.test.ts 同构）──────────────────────

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

/** 等一个 macrotask，让 promise 的 settle 状态可观测（不用 fake timers——无 timer 断言需求） */
async function nextMacrotask(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient handleMessage resolve 守卫（type === "response"）', () => {
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

  // T1（核心红性）：带同 id 的非 response 消息（bash_execution_update）先到 + response 后到
  it('T1: bash_execution_update 先到不误 resolve；真 response 后到才 resolve，流事件进 listener', async () => {
    const events: PiMessage[] = []
    client.onEvent((e) => events.push(e))

    let settled = false
    const resultPromise = client.bash('pwd')
    void resultPromise.then(() => { settled = true })
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')

    // 1) 流事件先到（复用同一 RPC id，对齐 pi 0.84.1 agent-session.js:2210 的 emit 形态）
    emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '/Users/x\n' })
    await nextMacrotask()
    // pending 未被流事件 settle（删守卫时此处红：首条 delta 已误 resolve）
    expect(settled).toBe(false)

    // 2) 真 response 后到 → resolve 到的是真 response（data.output 为真值而非 protocol error fallback）
    emitPiLine({
      type: 'response',
      command: 'bash',
      id: sent.id,
      success: true,
      data: { output: '/Users/x\n', exitCode: 0, cancelled: false, truncated: false },
    })
    const result = await resultPromise
    expect(result.output).toBe('/Users/x\n')
    expect(result.exitCode).toBe(0)

    // 3) 流事件走 listener 路径不吞（删守卫时此处红：bash_execution_update 被 pending resolve 吞掉）。
    //    delta 是 pi 0.84.1 流事件顶层字段（PiMessage 宽类型未声明，运行时守卫式断言）
    expect(
      events.some((e) => e.type === 'bash_execution_update' && e.id === sent.id
        && (e as { delta?: unknown }).delta === '/Users/x\n'),
    ).toBe(true)
  })

  // T2: 守卫反向对照——response 消息仍走 pending resolve，不泄漏进 listener
  it('T2: response（带 pending id）resolve 后不进 onEvent listener', async () => {
    const events: PiMessage[] = []
    client.onEvent((e) => events.push(e))

    const resultPromise = client.bash('echo ok')
    await Promise.resolve()
    const sent = lastWrittenJson()

    emitPiLine({
      type: 'response',
      command: 'bash',
      id: sent.id,
      success: true,
      data: { output: 'ok\n', exitCode: 0, cancelled: false, truncated: false },
    })
    const result = await resultPromise
    expect(result.output).toBe('ok\n')
    expect(events.filter((e) => e.type === 'response')).toHaveLength(0)
  })

  // T3: 多条流事件（多次 delta）全部进 listener，pending 只被最终 response resolve
  it('T3: 多条 bash_execution_update 全部进 listener，pending 等最终 response', async () => {
    const events: PiMessage[] = []
    client.onEvent((e) => events.push(e))

    const resultPromise = client.bash('seq 1 3')
    await Promise.resolve()
    const sent = lastWrittenJson()

    emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '1\n' })
    emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '2\n' })
    emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '3\n' })
    emitPiLine({
      type: 'response',
      command: 'bash',
      id: sent.id,
      success: true,
      data: { output: '1\n2\n3\n', exitCode: 0, cancelled: false, truncated: false },
    })

    const result = await resultPromise
    expect(result.output).toBe('1\n2\n3\n')
    expect(events.filter((e) => e.type === 'bash_execution_update')).toHaveLength(3)
  })
})
