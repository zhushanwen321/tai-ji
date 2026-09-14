/**
 * RpcClient 单元测试共享 mock 骨架（rpc-client*.test.ts 族）。
 *
 * 从 rpc-client-early-frame-buffer.test.ts 的 mock 段收敛为单源：mock node:child_process
 * 的 spawn，捕获 pi stdout data handler / stdin 写入 / exit handlers，供 emitPiLine 驱动
 * RpcClient 的 handleMessage 与 lastWrittenJson 断言 sendCommand。
 * 不依赖真实 pi 进程。
 *
 * [HISTORICAL] D10（LF-only stdout framing）后 RpcClient 不再消费 node:readline，改为
 * attachLfOnlyLineReader 在 proc.stdout 上挂 data handler。emitPiLine 桥接该 data handler，
 * 直投「整行 + \n」由生产读取器分帧——与 rpc-client.test.ts 内联 mock 同款（先例注释：
 * 「测试改为在 fake stdout 上桥接 'data' handler，emitPiLine 直投整行由读取器分帧」）。
 *
 * 使用模式（vi.mock 声明留测试文件——模块路径相对测试文件解析；工厂内 await import
 * 本文件转发，免疫 vitest hoist 时序；先例：subagent-core spawn-mock.ts）：
 *   vi.mock('node:child_process', async () =>
 *     (await import('./helpers/rpc-client-mock')).childProcessModule())
 *
 * spread 而非完全替换（shared / os / pi-paths / pi-provider-store）：rpc-client.start 经
 * ../spawn-env.js re-export 消费 shared 的 buildOutboundChildEnv（纯函数、env 全 DI），
 * 完全替换式 mock 会随 shared 新增导出静默断联（b5d3e6329 事故根因）；此处仅覆盖测试
 * 需要隔离的常量。
 */
import { vi } from 'vitest'

import type { PiMessage, RpcClient } from '../../src/infra/pi/rpc-client.js'

// ── 捕获状态（每测试经 resetRpcClientMock 重置）──────────────────────

let stdoutDataHandler: ((chunk: string | Buffer) => void) | null = null
let procExitHandlers: Array<(code: number | null) => void> = []

/** 捕获的 stdin 写入行（sendCommand 驱动用）。 */
const stdinWrites: string[] = []

const fakeProc = {
  /** 运行态 = null（isAlreadyExited 判别）；exit emit 后置 0，reset 复位。 */
  exitCode: null as number | null,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: {
    on: vi.fn((event: string, handler: (chunk: string | Buffer) => void) => {
      if (event === 'data') stdoutDataHandler = handler
    }),
    off: vi.fn(),
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
    // kill 即死（mock 语义）：微任务内 emit exit 让 killPiProcess 的 grace 立即短路。
    // [HISTORICAL] 2026-09-14 审计：此前 kill 是空 vi.fn() 永不发 exit → 每次收尾
    // 真等 DEFAULT_PI_KILL_GRACE_MS(2s) SIGKILL 兕底，27 个用例 × 2.5s ≈ 68s 纯等待，
    // 是 runtime 测试 top10 慢因的头号构成。微任务而非同步 emit：kill-chain 先注册
    // exit listener 再发信号（同步亦可），微任务对「kill 后断言信号序列」的用例更宽容；
    // 重复驱动（killAndDriveExit 手动 emitExit）由链内 settled 幂等守卫兑底。
    queueMicrotask(() => {
      if (procExitHandlers.length === 0) return
      const handlers = procExitHandlers
      procExitHandlers = []
      fakeProc.exitCode = 0
      handlers.forEach((h) => h(0))
    })
    return true
  }),
  pid: 12345,
}

// ── mock 模块工厂 ──────────────────────────────────────────────────

/** 'node:child_process' mock 工厂（spawn 返回 fakeProc）。 */
export function childProcessModule() {
  return { spawn: () => fakeProc }
}

/** '@xyz-agent/shared' mock 工厂（importActual spread，仅覆盖 ENV_WHITELIST_PREFIXES）。 */
export async function sharedModule() {
  const actual = await vi.importActual<typeof import('@xyz-agent/shared')>('@xyz-agent/shared')
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
}

/** '@xyz-agent/shared/paths' mock 工厂（getDataDir 固定 /mock/home）。 */
export function sharedPathsModule() {
  return { getDataDir: () => '/mock/home/.xyz-agent' }
}

/** 'node:os' mock 工厂（importActual spread，仅覆盖 homedir）。 */
export async function osModule() {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => '/mock/home' }
}

/** '../src/infra/pi/pi-paths.js' mock 工厂（importActual spread，目录固定）。 */
export async function piPathsModule() {
  const actual = await vi.importActual<typeof import('../../src/infra/pi/pi-paths.js')>('../../src/infra/pi/pi-paths.js')
  // tmpdir 工厂体内动态 import（本 helper 必须保持顶层零 mock 依赖：消费方测试可能 mock
  // node:os 且工厂定义在本文件——顶层静态 import node:os 会形成「helper 求值等 os mock
  // 工厂、os mock 工厂等 helper 求值」的死锁，实测挂死 vitest fork）
  const { tmpdir } = await import('node:os')
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
    // spawn-markers（rpc-client start 链）经 getConfigDir 真实落盘 <dataDir>/run/ 清单：
    // spread 保留的真实 getConfigDir 走被 mock 的 getDataDir（'/mock/home/...' 假路径），
    // fs-guard 白名单外 → 写入抛错 → recordSpawnMarkers 降级 console.error，污染用例的
    // errorSpy 计数（early-frame-buffer R1-4「error 恰好 1 次」红）。指向 fs-guard 白名单
    // 内的 tmp 数据目录（globalSetup 注入的 env），与生产实现同语义（读同一 env）
    getConfigDir: () => process.env.XYZ_AGENT_DATA_DIR ?? tmpdir(),
  }
}

/** '../src/infra/pi/pi-provider-store.js' mock 工厂（getDefaultModel → null）。 */
export async function piProviderStoreModule() {
  const actual = await vi.importActual<typeof import('../../src/infra/pi/pi-provider-store.js')>('../../src/infra/pi/pi-provider-store.js')
  return { ...actual, getDefaultModel: () => null }
}

/** '../src/infra/logger.js' mock 工厂（createPiSessionLog no-op + captureMemorySnapshot 固定快照）。 */
export function loggerModule() {
  return {
    createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
    // u5b D6-④：rpc-client crash 链（writePiCrashLog）读内存快照（rpc-client.ts:717）——
    // mock 面随源码 import 面同步，缺导出会在触发 crash 路径的用例（如 bash abortBash）炸 undefined
    captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  }
}

// ── 生命周期与驱动 helpers ─────────────────────────────────────────

/** 每测试前重置捕获状态与 fakeProc mock 记录（beforeEach 调用）。 */
export function resetRpcClientMock(): void {
  stdinWrites.length = 0
  stdoutDataHandler = null
  procExitHandlers = []
  fakeProc.on.mockClear()
  fakeProc.stdin.write.mockClear()
  fakeProc.kill.mockClear()
  fakeProc.exitCode = null
}

/** 清空已注册 exit handlers（RpcClient.start 后其 startup 检查的 handlers 已被自身 cleanup 移除，防御性清空）。 */
export function clearExitHandlers(): void {
  procExitHandlers = []
}

/** kill 后手动驱动 exit handlers 让 kill 立即 resolve（先例：kill-sigcont 测试 emitExit；afterEach 调用）。 */
export async function killAndDriveExit(client: RpcClient): Promise<void> {
  const killPromise = client.kill().catch(() => {})
  procExitHandlers.forEach((h) => h(0))
  procExitHandlers = []
  await killPromise
}

/** 把伪造的 pi stdout JSONL 行投递给 RpcClient 的 stdout data handler（LF-only 读取器分帧后驱动 handleMessage）。 */
export function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutDataHandler) throw new Error('stdout data handler not registered yet')
  stdoutDataHandler(JSON.stringify(obj) + '\n')
}

/** 从 stdin 写入里解析出最后一条 JSON 对象（取 sendCommand 注册的 pending id 用）。 */
export function lastWrittenJson(): Record<string, unknown> {
  return JSON.parse(stdinWrites[stdinWrites.length - 1])
}

/** 收集型 listener：把收到的帧推入数组（记录到达序）。 */
export function collector(received: PiMessage[]): (msg: PiMessage) => void {
  return (msg) => { received.push(msg) }
}

/** 反射读早期帧缓冲（仅测试观测用，先例：rpc-client.test.ts pendingSize；private 字段须经 unknown 中转——runtime/test 惯例）。
 *  U1 pi-rpc 收敛后缓冲是 createEarlyFrameBuffer 部件（只读快照经 frames getter 暴露）。 */
export function earlyFrameBufferOf(client: RpcClient): PiMessage[] {
  return (client as unknown as { earlyFrameBuffer: { frames: readonly PiMessage[] } }).earlyFrameBuffer.frames.slice()
}

/**
 * 构造贴近真实形态的非 response 帧：pi 原生事件帧 / 带 id 的 extension_ui_request。
 * 返回 Record（emitPiLine 入参类型）；JSONL 线上形态本就无类型，语义由 handleMessage 端标注。
 */
export function earlyFrame(i: number, withId = false): Record<string, unknown> {
  const frame: Record<string, unknown> = { type: `evt_${i}`, payload: { sessionId: 's1', seq: i } }
  // D2：非 pending 的带 id 帧（如 extension_ui_request / bash_execution_update）同属
  // listener 分支帧集，也应进缓冲——上限压测用带 id 形态顺带覆盖。
  if (withId) frame.id = `req_${i}`
  return frame
}
