/**
 * 假引擎子进程桩（in-process engine stub）——把 control server 的 spawn 面换成进程内
 * 可控替身，使「control 通道协议 + 进程治理编排」用例摆脱真实子进程。
 *
 * 判据归属（docs/todo/test-single-layer-cleanup.md 判据三档）：真子进程属第 ③ 档
 * 「跨进程事实」——没有完成信号可等、负载下拉长无稳定上界。本桩把引擎侧行为搬回测试
 * 进程：启动输出、stdin 反应、退出与 error 全部由事件/promise 表达（第 ② 档，await 该
 * 信号等价同步语义），与负载无关。argv 语义与 fixtures/fake-engine-cli.mjs 逐条对齐
 * （fixture 仍是真进程组治理用例的引擎，见 control-server.test.ts 的门控 describe）。
 *
 * 覆盖范围与边界：
 * - 覆盖：control server 自身的协议与治理编排（帧形状/错误码/队列上限/树杀 fan-out/
 *   日志口径/pid 文件形状）——被测逻辑一件不 mock，只换掉「引擎进程」这个协作者。
 * - 不覆盖（仍属「代码 + OS 组合行为」，由 TAIJI_TEST_INTEGRATION 门控的真进程用例
 *   承担）：真进程组杀是否真收割孤儿、真管道背压的水位、真 kill 的时序确认。
 *
 * 用法（测试文件顶部，vi.mock 是文件级 hoisted）：
 *   const engineHarness = vi.hoisted(() => ({ real: false }))
 *   vi.mock('node:child_process', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('node:child_process')>()
 *     return { ...actual, spawn: (c, a, o) => (engineHarness.real ? actual.spawn(c, a, o) : fakeSpawn(c, a, o)) }
 *   })
 * 门控 describe 内置 beforeEach 把 engineHarness.real 置 true（真 spawn）、afterEach 复位。
 */
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

/**
 * 合成 pid 序列：远离真实 pid 区间——`isPidAlive` 恒 false（不误判真实进程），
 * `killProcessTree` 对不存在的 pid 是无害 no-op（内部已 catch ESRCH）。
 * 真实 pid 探活/真组杀由门控用例承担，不经本桩。
 */
const SYNTHETIC_PID_BASE = 900_000
let syntheticPidSeq = 0

/** 取下一个合成 pid（只要求不撞真实 pid，不要求跨文件唯一）。 */
export function nextSyntheticPid(): number {
  syntheticPidSeq += 1
  return SYNTHETIC_PID_BASE + syntheticPidSeq
}

/** 引擎 stdin 的最小契约（对齐 down-queue 的 DownStdin + control server 的 error 监听）。 */
export type FakeEngineStdin = EventEmitter & {
  destroyed: boolean
  /** 已受理的行（去掉换行）——背压「每帧恰好投递一次」断言的数据源。 */
  readonly written: string[]
  write(chunk: string): boolean
  /** 手动解除背压（把暂存行投给读取侧并发 drain）——测试确定性地结束背压期。 */
  release(): void
}

/** argv 取值（与 fixture 同款：`--name value` 形态）。 */
function argOf(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/** 位置参数（相对 flag 的偏移）：`--emit-lines-on <token> <count> <bytes>` 一类。 */
function at(args: readonly string[], name: string, offset: number): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + offset]
}

function countAt(args: readonly string[], name: string, offset: number): number {
  const raw = at(args, name, offset)
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name)
}

function numberArg(args: readonly string[], name: string): number {
  const raw = argOf(args, name)
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * `--stdin-pause [ms]` 解析：带数值 = 到点自动放开；不带数值 = 持续背压直到测试调用
 * `stdin.release()`（确定性解除，不依赖墙钟）。
 */
function pauseMsOf(args: readonly string[]): number {
  const index = args.indexOf('--stdin-pause')
  if (index === -1) return 0
  const raw = args[index + 1]
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

/**
 * 引擎 stdin：复现 fake-engine-cli.mjs 的消费/背压形态。
 *
 * - `--no-read-stdin`：无人消费 → write 恒 false 且永不 drain（真管道写满的同构形态）；
 * - `--stdin-pause [ms]`：暂停消费（write 恒 false、行暂存），到点或 `release()` 后放行并发 drain；
 * - 其余：write 恒 true，行延到下一个宏任务投给读取侧（与「引擎是另一个进程、server 先把
 *   帧写进管道」的时序同构）。
 */
function makeStdin(args: readonly string[]): FakeEngineStdin {
  const stdin = new EventEmitter() as FakeEngineStdin
  const written: string[] = []
  const buffered: string[] = []
  const noRead = has(args, '--no-read-stdin')
  const pauseMs = pauseMsOf(args)
  let paused = pauseMs > 0
  stdin.destroyed = false
  Object.defineProperty(stdin, 'written', { value: written, enumerable: true })

  const deliver = (line: string): void => {
    setImmediate(() => stdin.emit('data', Buffer.from(`${line}\n`, 'utf8')))
  }

  stdin.write = (chunk: string): boolean => {
    const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk
    if (line.trim().length > 0) written.push(line)
    if (noRead) return false
    if (paused) {
      buffered.push(line)
      return false
    }
    deliver(line)
    return true
  }

  stdin.release = (): void => {
    if (!paused) return
    paused = false
    for (const line of buffered.splice(0)) deliver(line)
    stdin.emit('drain')
  }

  if (Number.isFinite(pauseMs) && pauseMs > 0) {
    setTimeout(() => { stdin.release() }, pauseMs)
  }
  return stdin
}

/**
 * 假引擎子进程：`ChildProcess` 消费面（pid / stdin / stdout / stderr / stdio[3] /
 * once('exit') / once('error') / kill）逐项对齐，行为按 argv 驱动。
 */
export class FakeEngineChild extends EventEmitter {
  readonly pid: number
  readonly stdin: FakeEngineStdin
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
  /** stdio[3] = raw mirror 通道（真 spawn 恒开 4 个 pipe，与实装对齐）。 */
  readonly stdio: [FakeEngineStdin, EventEmitter, EventEmitter, EventEmitter]
  /** 收到的 kill 信号（诊断用；组杀走 killProcessTree(pid)，不经本方法）。 */
  readonly signals: string[] = []
  exited = false

  constructor(readonly args: readonly string[]) {
    super()
    this.pid = nextSyntheticPid()
    this.stdin = makeStdin(args)
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdio = [this.stdin, this.stdout, this.stderr, new EventEmitter()]
  }

  /** 引擎 stdout 出一行（server 侧按行切分后封装 engine_frame 下发）。 */
  emitLine(line: string): void {
    if (this.exited) return
    this.stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'))
  }

  /** 引擎 stdout 出原始字节块（UTF-8 跨 chunk 边界用例）。 */
  emitBytes(chunk: Buffer): void {
    if (this.exited) return
    this.stdout.emit('data', chunk)
  }

  /** 引擎 stderr 出一行（engine_closed.stderrTail 采集）。 */
  emitStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(`${text}\n`, 'utf8'))
  }

  /** fd3 出一帧镜像行（`{v, recordId, seq, b64}` NDJSON）。 */
  emitMirrorLine(frame: Record<string, unknown>): void {
    this.stdio[3].emit('data', Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8'))
  }

  /** 上报「引擎拉起的子进程 pid」（`--spawn-child` 的进程内等价；不真起进程）。 */
  reportChildPid(): number {
    const childPid = nextSyntheticPid()
    this.emitLine(JSON.stringify({ type: 'event', childPid }))
    if (has(this.args, '--emit-host-child-frames')) {
      this.emitLine(JSON.stringify({
        id: 'rev-child-1',
        method: 'host/childSpawned',
        params: { pid: childPid, recordId: 'rec-1' },
      }))
    }
    return childPid
  }

  /** 引擎退出（真实 exit 事件的进程内等价；code/signal 与实装同形状——信号杀时 code 为 null）。 */
  exitWith(code: number | null, signal: string | null = null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }

  /** spawn 异步失败（ENOENT 族）：server 按 127 口径收尾。 */
  failWith(message: string): void {
    if (this.exited) return
    this.exited = true
    this.emit('error', new Error(message))
  }

  kill(signal: string): boolean {
    this.signals.push(signal)
    return true
  }
}

/** 已创建的假引擎（测试按创建顺序取用）。 */
const created: FakeEngineChild[] = []

/** 最近创建的假引擎（`await agent.open(...)` 之后必然已创建）。 */
export function lastFakeEngine(): FakeEngineChild {
  const engine = created[created.length - 1]
  if (engine === undefined) throw new Error('no fake engine created yet')
  return engine
}

/** 清空已创建登记（afterEach 用；避免跨用例串味）。 */
export function resetFakeEngines(): void {
  created.length = 0
}

/** 按 pid 取引擎桩（组杀记录桩据此把「被杀的引擎」推入 exit，复现真实杀后链路）。 */
export function fakeEngineByPid(pid: number): FakeEngineChild | undefined {
  return created.find((engine) => engine.pid === pid)
}

/** SDK node-executor 的执行器探针替身：`--eval process.exit(0)` 进程内即退，零真 spawn。 */
function makeProbeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.defineProperty(child, 'pid', { value: nextSyntheticPid(), enumerable: true })
  child.kill = (): boolean => true
  setImmediate(() => child.emit('exit', 0, null))
  return child
}

/**
 * spawn 目标不存在（ENOENT 族）：复现 Node 的异步 error 事件 + 无 pid（真实 spawn 对
 * 不存在命令正是这个形态—— pipes 已建、进程从未起、error 异步到达）。
 */
function makeFailingChild(command: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.defineProperty(child, 'pid', { value: undefined, enumerable: true })
  const streams = [new EventEmitter(), new EventEmitter(), new EventEmitter(), new EventEmitter()]
  Object.defineProperty(child, 'stdio', { value: streams, enumerable: true })
  child.kill = (): boolean => true
  setImmediate(() => child.emit('error', new Error(`spawn ${command} ENOENT`)))
  return child
}

/**
 * spawn 替身入口（喂给 `vi.mock('node:child_process')` 的 factory）。
 *
 * 行为按 fixtures/fake-engine-cli.mjs 的 argv 语义在进程内复现：启动输出延到下一个宏任务
 * （server 在同一次同步块里挂好 stdout 监听后才消费），stdin 反应同理，退出/error 由事件
 * 表达——完成信号全部可 await，无墙钟窗口。
 */
export function fakeSpawn(command: string, args: readonly string[], _options?: unknown): ChildProcess {
  const argv = [...args]
  if (argv[0] === '--eval') return makeProbeChild()
  if (!existsSync(command)) return makeFailingChild(command)
  const engine = new FakeEngineChild(argv.slice(1))
  created.push(engine)
  setImmediate(() => driveFakeEngine(engine))
  return engine as unknown as ChildProcess
}

/** argv 驱动的引擎侧行为（启动输出 + stdin 反应），与 fixture 逐条对应。 */
function driveFakeEngine(engine: FakeEngineChild): void {
  const args = engine.args
  const stderrText = argOf(args, '--stderr')
  if (stderrText !== undefined) engine.emitStderr(stderrText)

  const emitRaw = argOf(args, '--emit')
  if (emitRaw !== undefined) engine.emitLine(emitRaw)
  const emitSize = numberArg(args, '--emit-size')
  if (emitSize > 0) engine.emitLine(`w${'w'.repeat(emitSize)}`)
  if (args.includes('--emit-lines')) {
    const count = countAt(args, '--emit-lines', 1)
    const size = countAt(args, '--emit-lines', 2)
    for (let i = 0; i < count; i++) engine.emitLine('w'.repeat(size))
  }
  if (has(args, '--emit-split-utf8')) {
    const bytes = Buffer.from('中\n', 'utf8')
    engine.emitBytes(bytes.subarray(0, 1))
    engine.emitBytes(bytes.subarray(1))
  }
  if (has(args, '--spawn-child')) engine.reportChildPid()

  // 不消费 stdin 的形态不挂读取侧（写侧仍记账，供背压上限判定）
  if (has(args, '--no-read-stdin')) return
  engine.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue
      handleEngineLine(engine, line)
    }
  })
}

/** JSON.parse 容错（非 JSON → null；调用方回落 raw 事件帧，与 fixture 同款）。 */
function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function handleEngineLine(engine: FakeEngineChild, line: string): void {
  const args = engine.args
  if (args.includes('--emit-lines-on') && line.includes(at(args, '--emit-lines-on', 1) ?? '')) {
    const count = countAt(args, '--emit-lines-on', 2)
    const size = countAt(args, '--emit-lines-on', 3)
    for (let i = 0; i < count; i++) engine.emitLine('w'.repeat(size))
    return
  }
  const exitToken = argOf(args, '--exit-on')
  if (exitToken !== undefined && line.includes(exitToken)) {
    engine.exitWith(numberArg(args, '--exit-code'))
    return
  }
  if (has(args, '--ack-stdin-bytes')) {
    engine.emitLine(JSON.stringify({ type: 'ack', bytes: Buffer.byteLength(line, 'utf8') }))
    return
  }
  if (has(args, '--echo-line')) {
    engine.emitLine(JSON.stringify({ type: 'echo', line }))
    return
  }
  // 请求/响应回显：任何带 id 的 JSON 行回一行 response（engine-protocol 形态近似）
  const parsed = parseJsonObject(line)
  if (parsed !== null && parsed.id !== undefined) {
    engine.emitLine(JSON.stringify({ type: 'response', id: parsed.id, ok: true }))
    return
  }
  engine.emitLine(JSON.stringify({ type: 'event', raw: line }))
}
