/**
 * plugin 宿主（PluginHost / PluginHostProcess）in-process 注入桩。
 *
 * 背景（2026-10-22 单测层整治，判据与处置通道见 docs/TEST-STRATEGY.md「新写测试判据」节）：
 * plugin 宿主族的单测原形态 fork 真实子进程 / 起真实 Worker 线程（判据 b+f 类）——进程
 * 启动与退出事件传播没有「完成」信号可等，CPU 满载下窗口无稳定上界，不满足单测层
 * 「只测逻辑、高负载下也极快」的定位。本 helper 把进程/线程边界换成同进程注入桩：
 * 被测逻辑（宿主的分配/复用/IPC 往返/崩溃分流/清理/幂等/误报防护）全部留在
 * PluginHost / PluginHostProcess 实装内，真实进程/线程生命周期行为（terminate →
 * exit code=1、SIGKILL → exit code=null、SIGTERM 宽限链）属「代码 + OS 组合行为」，
 * 归集成轨（TAIJI_TEST_INTEGRATION 门控，见 test-guard/integration-gate.ts）覆盖。
 *
 * 消息协议逐条对齐 test/fixtures/ 下三个 mock bootstrap（本桩只移植这些单测实际驱动的分支）：
 * - plugin-bootstrap-process.mock.cjs：load → loaded；rpc → response(result:null)；
 *   crash → 自退 exit(1)；fatal → fatal_error 消息
 * - mock-bootstrap-exit0.cjs：exit0 → 自退 exit(0)；ipc-disconnect → 只断 IPC、进程存活
 * - mock-bootstrap.cjs / mock-bootstrap-alive.cjs（Worker 版）：load → loaded；
 *   terminate() → exit code=1（运行中被终止的 Node 语义；事件循环已排空的 Worker 自然退出
 *   code=0，复现不了「运行中被终止」形态，故桩恒按常驻句柄语义 exit 1）
 *
 * 使用模式（vi.mock 声明留测试文件——模块路径相对测试文件解析；工厂内 await import
 * 本文件转发，免疫 vitest hoist 时序；先例：test/helpers/rpc-client-mock.ts）：
 *   vi.mock('node:child_process', async () =>
 *     (await import('./helpers/plugin-host-inproc-stubs')).childProcessModule())
 *   vi.mock('node:worker_threads', async () =>
 *     (await import('./helpers/plugin-host-inproc-stubs')).workerThreadsModule())
 *
 * spread 而非完全替换（importActual 保留其余导出）：宿主依赖图内其他模块可能消费这两个
 * 内置模块的其他导出，完全替换式 mock 会随依赖图扩张静默断联（rpc-client-mock 头注登记的
 * b5d3e6329 事故根因同族）。
 */
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

/** 桩 pid 起点（远离真实 pid 区间，便于失败信息里区分桩与真进程）。 */
const FAKE_PID_BASE = 40_000
let nextFakePid = FAKE_PID_BASE

/** 桩线程 id 起点。 */
const FAKE_THREAD_ID_BASE = 1
let nextFakeThreadId = FAKE_THREAD_ID_BASE

/** 桩侧消息形态（生产 HostToWorkerMessage 的相关字段切片）。 */
type FakeHostMessage = {
  type?: string
  pluginId?: string
  /** invoke 经 rpcServer 发出的嵌套请求（{ type:'rpc', request }）。 */
  request?: { id?: number }
  /** 扁平 rpc 形态的 id（旧协议）。 */
  id?: number
}

function asHostMessage(message: unknown): FakeHostMessage | null {
  if (typeof message !== 'object' || message === null) return null
  return message as FakeHostMessage
}

/**
 * fork 桩子进程：EventEmitter + 与 mock bootstrap 同协议的消息响应。
 *
 * 生命周期事件序对齐 L-5 实测（子进程退出时父进程侧事件序 disconnect → exit）：
 * 自退（exit0 / crash）与被动 kill 都先 emit 'disconnect' 再 emit 'exit'。
 * 'ipc-disconnect' 只断 IPC 不退出（进程存活的真异常形态，宿主 disconnect grace
 * 兜底应报 crash）。
 */
export class FakePluginChildProcess extends EventEmitter {
  readonly pid: number
  /** Node ChildProcess 语义：退出后非 null（宿主 killChildGracefully 的既死判断读它）。 */
  exitCode: number | null = null
  signalCode: string | null = null
  connected = true
  private dead = false

  constructor() {
    super()
    this.pid = nextFakePid++
  }

  send(message: unknown): boolean {
    // 通道已断/进程已死后的 send：真实 Node 走 error 事件或回调报错，宿主 postMessage
    // 包装层 try/catch 兜底；桩侧直接视为无回路（返回 false），不生成事件。
    if (this.dead || !this.connected) return false
    this.react(asHostMessage(message))
    return true
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.dead) return false
    const signalName = typeof signal === 'string' ? signal : 'SIGTERM'
    this.die(null, signalName)
    return true
  }

  /** IPC 单方面断开（进程保持存活）。 */
  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.emit('disconnect')
  }

  /**
   * 测试驱动：旧 child 晚到的 exit（M6a-03 崩溃→重建竞态）。
   *
   * 原 fixture（mock fatalThenExit）用 setTimeout 300ms 延迟退出构造竞态窗口，但宿主
   * 崩溃路径的 SIGKILL 会抢先终结进程、该定时器从未真正到达——原用例的 600ms 采样窗
   * 只是「等一个大概率不来的事件」。此处改为测试显式驱动：在重建后向旧 child 补发
   * exit，确定性验证 removeAllListeners 摘除后迟到事件触碰不到新 handle。
   */
  emitLateExit(code: number): void {
    this.emit('exit', code, null)
  }

  private die(code: number | null, signal: string | null): void {
    if (this.dead) return
    this.dead = true
    this.exitCode = code
    this.signalCode = signal
    this.connected = false
    this.emit('disconnect')
    this.emit('exit', code, signal)
  }

  private react(m: FakeHostMessage | null): void {
    if (m === null) return
    switch (m.type) {
      case 'load':
        this.emit('message', { type: 'loaded', pluginId: m.pluginId })
        break
      case 'rpc': {
        const id = m.request && typeof m.request.id !== 'undefined' ? m.request.id : m.id
        this.emit('message', { type: 'rpc', response: { jsonrpc: '2.0', id, result: null } })
        break
      }
      case 'crash':
        this.die(1, null)
        break
      case 'fatal':
        this.emit('message', { type: 'fatal_error', error: 'mock fatal error' })
        break
      case 'exit0':
        this.die(0, null)
        break
      case 'ipc-disconnect':
        this.disconnect()
        break
      default:
        break
    }
  }
}

/**
 * Worker 线程桩：load → loaded；terminate() → exit code=1（运行中被终止的 Node 语义）。
 *
 * 不模拟「事件循环排空后自然退出 code=0」——单测驱动的场景只有 load 与 terminate 两条。
 */
export class FakePluginWorkerThread extends EventEmitter {
  readonly threadId: number
  private dead = false

  constructor() {
    super()
    this.threadId = nextFakeThreadId++
  }

  postMessage(message: unknown): void {
    if (this.dead) return
    const m = asHostMessage(message)
    if (m?.type === 'load') {
      this.emit('message', { type: 'loaded', pluginId: m.pluginId })
    }
  }

  async terminate(): Promise<number> {
    if (this.dead) return 1
    this.dead = true
    this.emit('exit', 1)
    return 1
  }
}

/** fork 桩（vi.fn：测试经 vi.mocked(fork).mock.calls 对齐实参，经 results 取桩实例）。 */
export const fakePluginFork = vi.fn(
  (_modulePath: string, _args?: readonly string[], _options?: Record<string, unknown>): FakePluginChildProcess =>
    new FakePluginChildProcess(),
)

/** 'node:child_process' mock 工厂（fork → 桩子进程，其余导出 importActual 原样保留）。 */
export async function childProcessModule(): Promise<typeof import('node:child_process')> {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, fork: fakePluginFork as unknown as typeof actual.fork }
}

/** 'node:worker_threads' mock 工厂（Worker → 桩线程，其余导出 importActual 原样保留）。 */
export async function workerThreadsModule(): Promise<typeof import('node:worker_threads')> {
  const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
  return { ...actual, Worker: FakePluginWorkerThread as unknown as typeof actual.Worker }
}

/** 已 fork 出的桩子进程（按创建顺序）。 */
export function fakePluginChildren(): FakePluginChildProcess[] {
  return fakePluginFork.mock.results.map((r) => r.value)
}

/** 每测试前清空 fork 调用记录（beforeEach 调用）。 */
export function resetPluginHostStubs(): void {
  fakePluginFork.mockClear()
}
