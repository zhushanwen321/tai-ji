/**
 * relay 子进程注册表（E 方案，subagent-realtime-channel.md §3.1/§4.2/§3.3）。
 *
 * 职责：socket 连接 → 握手帧校验（版本协商 + 归属校验）→ spawn 真实 pi（argv/env/cwd
 * 全从握手帧，env 剥离 XYZ_SUBAGENT_RELAY_* 防孙进程嵌套误导）→ 双向字节泵（down 帧 →
 * child stdin；child stdout → up 帧 + 磁盘镜像 pi-relay-<date>-<recordId>.jsonl + tee 分支
 * 同一次读取顺序分发；stderr → up-stderr 帧；exit → exit 帧 → 关连接）→ 断连即杀
 * （pi-rpc kill-chain 单源消费，见 killRelayChild 头注——依赖方向纪律：runtime 不
 * import extension 的 kill-chain，pi-rpc 是 workspace 公共包非 extension）→ pid 文件 +
 * 重启残留扫描兜底。
 *
 * 与 ProcessManager 的关系（设计 §4.4）：relay 子进程的发起方是 extension（经代理转交），
 * runtime 只是受托执行人——不进 RpcClient 体系（无 RPC 会话语义、无 attach 需求），
 * 两套进程表并列。复用面仅 findPiExecutable。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Socket } from 'node:net'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { ServerMessage } from '@xyz-agent/shared'
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
} from '@zhushanwen/subagent-core/relay-env'
import { killPiProcess } from '@zhushanwen/pi-rpc'
import { findPiExecutable } from '../pi/find-pi-executable.js'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { createPiRelayLog, type PiSessionLog } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'
import { RelayTee } from './relay-tee.js'
import { getRelayChildrenDir, getRelayPidFilePath } from './relay-paths.js'

/** 断连即杀的优雅退出窗口（SIGTERM 后等这么久再 SIGKILL，设计 §4.2）。 */
export const RELAY_KILL_GRACE_MS = 3_000
/** 握手超时：连接建立后等第一帧的上限（防半开连接占资源）。 */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** spawn 失败时代理看到的退出码（127 = command not found 惯例，走子进程非零退出语义）。 */
const SPAWN_FAILURE_EXIT_CODE = 127
/** pid 复用判定的时钟容差（ps lstart 秒级精度 + 调度延迟）。 */
const PID_REUSE_TOLERANCE_MS = 2_000

// ── 协议帧（runtime 侧视角；握手/数据帧 schema 见设计 §3.1）─────────────

interface RelayHandshakeFrame {
  v: number
  kind: 'handshake'
  mainSessionId: string
  recordId: string
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
}

interface RelayDataFrame {
  v: number
  kind: 'data'
  dir: 'down'
  b64: string
}

type InboundFrame = RelayHandshakeFrame | RelayDataFrame

/** runtime → 代理的 reject 帧理由。E-1 代理对 reason='version' 以退出码 10 退出。 */
export type RelayRejectReason = 'version' | 'identity' | 'duplicate' | 'malformed'

interface RegisteredEntry {
  conn: Socket
  mainSessionId: string
  recordId: string
  child: ChildProcess
  pidFile: string
  tee: RelayTee
  /** up 方向 stdout 字节镜像（pi-relay-<date>-<recordId>.jsonl，架构约定「pi 卡死唯一证据」）。 */
  log: PiSessionLog
}

export interface RelayRegistryOptions {
  /** pi 二进制定位锚点（dev = apps/electron），透传 findPiExecutable。 */
  projectRoot: string
  /** 数据目录（socket/pid 文件父目录的根）。 */
  dataDir: string
  /** tee 产出的 WS 帧发布（组合根注入 messageBus.publish）。 */
  publish: (sessionId: string, msg: ServerMessage) => void
  /** spawn 命令覆盖（测试注入假 pi；缺省 findPiExecutable(projectRoot)）。 */
  piCommand?: string
}

/**
 * 单帧写出（JSONL 协议，base64 封装字节保精确）。
 *
 * 连接级容错（2026-09-04 runtime 整机崩溃事故）：对端半关闭（FIN 已达、本端
 * writable 仍在）时 `destroyed` 为 false 但 `conn.write()` 走 writeAfterFIN 同步抛
 * EPIPE——异常发生在 child stdout 'data' 回调等事件链中，无捕获即进程级
 * uncaughtException → 整机 graceful shutdown（全部 session 中断）。流写失败只影响
 * 本连接（清理由 close/error 路径的 kill-on-disconnect 兜底），吞掉降级为 debug
 * 日志，禁止把连接级故障升级为进程级故障。`writableEnded` 覆盖本端已 end 的对称场景。
 */
function writeFrame(conn: Socket, frame: Record<string, unknown>): void {
  if (conn.destroyed || conn.writableEnded) return
  try {
    conn.write(`${JSON.stringify(frame)}\n`)
  // eslint-disable-next-line taste/no-silent-catch -- 连接已死时丢帧是正确降级（丢的只是本连接转发帧，清理由 close/error 路径兜底）；事件回调内无调用方可传播，降级 debug 防日志噪声
  } catch (e) {
    console.debug('[relay] frame write failed (connection half-closed or dead):', toErrorMessage(e))
  }
}

/**
 * 连接关闭的同步安全包装：destroyed socket 上 `end()` 同步抛 ERR_STREAM_DESTROYED
 * （child error/exit 回调与 conn close 的竞态窗口可达），best-effort 关闭即可。
 */
function endConn(conn: Socket): void {
  if (conn.destroyed) return
  try {
    conn.end()
  // eslint-disable-next-line taste/no-silent-catch -- 竞态窗口内已 destroyed：无需再关，无信息可记
  } catch {
    // 已 destroyed（竞态）：无需再关
  }
}

/** kill(pid, 0) 探活。EPERM 视为活（存在但不可杀——不是本进程组的孤儿）。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 杀链（S7 收敛：pi-rpc kill-chain 单源消费，与 rpc-client.kill / pi-subagent-cli
 * killChild 同源）：SIGCONT（唤醒可能被 SIGSTOP 冻结的进程，否则 SIGTERM 被吞）→
 * SIGTERM → grace → SIGKILL。幂等：已退出的 child 直接 resolve（killPiProcess 前置
 * exitCode/signalCode 短路，与迁移前本函数守卫等价——去重不重复实现）。
 *
 * 消费参数与外层兜底裁决（独立实现 → 单源消费的行为保真点）：
 * - graceMs 缺省维持 RELAY_KILL_GRACE_MS（3s，设计 §4.2 断连即杀窗口，不随
 *   killPiProcess 缺省 2s 漂移）；
 * - unrefTimers: true 维持迁移前双 timer unref 形态——kill-on-disconnect / 尾扫 /
 *   destroyAll 都是关停路径，ref'd timer 会拖住 runtime 进程退出；
 * - .catch 兜底维持「杀链必 resolve、永不 reject」契约：close 路径
 *   `void killRelayChild().then(...)` 无 catch，kill 同步抛错（进程已死竞态——
 *   killPiProcess 内 kill 无 try-catch）经 executor 变 rejection，不兜底即
 *   unhandled rejection → 整机崩溃（与 2026-09-04 连接级故障升级教训同族）。
 *
 * 迁移删除的防御与理由：迁移前 settleTimer（graceMs+2s 强制 resolve）守护的是
 * 「SIGKILL 后等真实 exit」形态的挂起面；killPiProcess 的 killTimer 在 grace 超时
 * 点无条件 SIGKILL + resolve（信号发出即承诺兑现），promise 结构性不可能超过 graceMs
 * 悬挂，外层 Promise.race 兜底恒为死代码，故去兜底而非保留。escalation 路径的
 * resolve 时机从「真实 exit」提前为「SIGKILL 发出」——消费方全部容忍：cleanupEntry
 * 幂等且由 attachRelayChildWiring 的 exit handler 独立复跑，尾扫 kill 是
 * fire-and-forget（session-lifecycle `void target.kill().catch(...)`）。
 */
export function killRelayChild(child: ChildProcess, graceMs = RELAY_KILL_GRACE_MS): Promise<void> {
  return killPiProcess(child, { graceMs, unrefTimers: true }).catch(() => {
    // kill 抛错说明进程已死（exit 事件已/将至）；杀链契约是必 resolve（见头注），
    // 吞错防 close 路径 unhandled rejection
    void 0
  })
}

/**
 * 归属校验第一段（§4.1）：握手帧字段形状守卫——mainSessionId/recordId/cwd 非空
 * string、argv 全 string、env 是对象。
 */
function hasValidHandshakeFrameShape(frame: RelayHandshakeFrame): boolean {
  return typeof frame.mainSessionId === 'string' && frame.mainSessionId.length > 0
    && typeof frame.recordId === 'string' && frame.recordId.length > 0
    && typeof frame.cwd === 'string' && frame.cwd.length > 0
    && Array.isArray(frame.argv) && !frame.argv.some((a) => typeof a !== 'string')
    && typeof frame.env === 'object' && frame.env !== null
}

/**
 * 归属校验第二段（§4.1）：env 必含 XYZ_SUBAGENT_RELAY_*（缺失拒绝，防任意本地进程
 * 挂载借道 spawn；归属 env 与帧字段一致排除拼装帧）。需先过形状段（env 非 null）。
 */
function isHandshakeEnvOwnershipValid(frame: RelayHandshakeFrame): boolean {
  const socketEnv = frame.env[RELAY_ENV_SOCKET]
  return frame.env[RELAY_ENV_SESSION_ID] === frame.mainSessionId
    && frame.env[RELAY_ENV_RECORD_ID] === frame.recordId
    && socketEnv !== undefined
    && socketEnv.length > 0
}

/**
 * env 原样使用（身份贯穿/schemaEnv/worktree 标志全在握手帧），剥离 relay env——
 * 孙进程经 pi-invocation 判定三 env 缺失回落直连，防嵌套 relay 时旧值误导。
 *
 * B8 出站接线（docs/design/env-propagation-boundary.md §5-U4 / D4）：基座维持帧 env
 * 全量拷贝拓扑（pass-all 前缀 '' 不做白名单过滤——schemaEnv/worktree 标志未在入站
 * 白名单内，过滤即丢语义），五键剥离迁为 extras undefined=显式删除语义；deny 清单由
 * 构建器末步兜底，「叠加 deny 过滤后不多不少」。导出仅供单测直验（handleConnection
 * 全链路已在 relay-registry.test.ts 覆盖）。
 */
export function buildChildEnv(frame: RelayHandshakeFrame): Record<string, string> {
  return buildOutboundChildEnv({
    parentEnv: frame.env,
    prefixes: [''],
    extras: {
      [RELAY_ENV_SOCKET]: undefined,
      [RELAY_ENV_NODE]: undefined,
      [RELAY_ENV_SCRIPT]: undefined,
      [RELAY_ENV_SESSION_ID]: undefined,
      [RELAY_ENV_RECORD_ID]: undefined,
    },
  })
}

export class RelayRegistry {
  private readonly entries = new Map<Socket, RegisteredEntry>()
  private readonly recordIdToConn = new Map<string, Socket>()
  private readonly piCommand: string

  constructor(private readonly opts: RelayRegistryOptions) {
    this.piCommand = opts.piCommand ?? findPiExecutable(opts.projectRoot)
    mkdirSync(getRelayChildrenDir(opts.dataDir), { recursive: true })
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * 按 mainSessionId 的只读存在性查询（idle pi reclamation 设计 D2 #3，u1b）。
   *
   * 注册表内存在以该 mainSessionId 关联且仍在册（未 cleanupEntry）的 relay 条目即真。
   * 消费方 = 空闲 reaper 的「有在途 relay 子进程」豁免判定（u2）——主 pi 被杀后 relay
   * 代理不会可靠连坐死亡（relay.mjs 显式忽略 stdin EOF），故豁免语义锚定注册表在册
   * 条目而非进程探活。纯只读，不改变任何注册/清理行为；条目数 = 在途 subagent 数
   * （量级小），线性扫描即可，不为低频豁免查询建反向索引。
   */
  hasByMainSessionId(mainSessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.mainSessionId === mainSessionId) return true
    }
    return false
  }

  /**
   * 按 mainSessionId 枚举在册 relay 子进程目标（idle pi reclamation D3 第 5 步尾扫，u3a）。
   *
   * 返回元素结构对齐 session-lifecycle.ts 的 ReclaimRelayTarget（{ kill }）——刻意不
   * import 该类型（infra → services 反向依赖禁向），结构类型天然兼容，u3 装配接线
   * listRelayChildrenByMainSession 时可直接赋值。kill 实现绑本文件导出的 killRelayChild
   * （SIGCONT→SIGTERM→grace→SIGKILL，幂等：已退出 child 直接 resolve）。
   *
   * 「杀完走注册表清理」由既有事件链结构性保证：attachRelayChildWiring 挂载的 child
   * 'exit' handler 收到 exit 即调 cleanupEntry（tee 销毁 + pid 文件删除 + 双 Map 注销，
   * 幂等）——调用方 kill 后无需（也不应）手工注销注册表。
   *
   * 线性扫描（对齐 hasByMainSessionId 取态）：条目数 = 在途 subagent 数，量级小，
   * 不为低频尾扫建反向索引。纯只读枚举，不改变任何注册/清理行为。
   */
  listTargetsByMainSessionId(mainSessionId: string): Array<{ kill(): Promise<void> }> {
    const targets: Array<{ kill(): Promise<void> }> = []
    for (const entry of this.entries.values()) {
      if (entry.mainSessionId !== mainSessionId) continue
      targets.push({ kill: () => killRelayChild(entry.child) })
    }
    return targets
  }

  /** socket server 的 connection 入口：等待握手 → 校验 → 注册 + spawn + 字节泵。 */
  handleConnection(conn: Socket): void {
    // 连接级 error 兜底（对端 RST → ECONNRESET 等）：socket 'error' 无 listener 时
    // EventEmitter emit 直接 throw → uncaughtException → 整机崩溃（与 writeFrame 的
    // EPIPE 同族，2026-09-04 事故审计补齐）。错误只归本连接——destroy 后由 'close'
    // 走既有 kill-on-disconnect / 注册清理路径，不升级故障域。
    conn.on('error', (err) => {
      console.warn('[relay] connection error, destroying:', err.message)
      conn.destroy()
    })
    const handshakeTimer = setTimeout(() => {
      console.warn('[relay] handshake timeout, closing connection')
      conn.destroy()
    }, HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref()

    const rl = createInterface({ input: conn })
    // readline 会把 input 流的 'error' 转发到 interface 实例上 re-emit（Node 文档
    // Interface 'error' 事件）——rl 无 listener 时同样 throw 成 uncaughtException，
    // 是 conn 层 listener 之外的独立逃逸路径（事故审计发现的第二颗地雷）。转发只是
    // 通知机制，真实处置已在 conn 层 listener（destroy + 清理路径），此处 no-op 吞掉。
    rl.on('error', () => {})
    rl.once('close', () => clearTimeout(handshakeTimer))

    let handshaked = false
    rl.on('line', (line) => {
      if (line.trim().length === 0) return
      if (!handshaked) {
        handshaked = true
        clearTimeout(handshakeTimer)
        const frame = this.tryParseFrame(line)
        if (frame === null || frame.kind !== 'handshake') {
          writeFrame(conn, { kind: 'reject', reason: 'malformed', supported: [RELAY_PROTOCOL_VERSION] })
          endConn(conn)
          return
        }
        this.registerHandshake(conn, frame)
        return
      }
      // 握手后：仅消费 down 方向数据帧，其余忽略（代理不发其他 kind）。
      // dir==='down' / b64:string 的运行时不变量由 tryParseFrame 的 data 帧形状守卫
      // 单点定义——畸形帧在解析层已按 null 丢弃，此处不再重复编码该判据
      const frame = this.tryParseFrame(line)
      if (frame !== null && frame.kind === 'data') {
        const entry = this.entries.get(conn)
        if (!entry) return
        const bytes = Buffer.from(frame.b64, 'base64')
        // 同步抛防护（对齐 writeFrame 事故修复）：Writable.write 在 destroyed 流上
        // 同步抛 ERR_STREAM_DESTROYED，readline 回调中无捕获即 uncaughtException；
        // 异步错误（EPIPE）走既有 callback 分支。
        try {
          entry.child.stdin?.write(bytes, (err) => {
            // EPIPE = 子进程已死（exit 帧链路接管），忽略避免未处理流错误
            if (err) console.debug(`[relay] stdin write failed (child may be dead) recordId=${entry.recordId}:`, err.message)
          })
        } catch (e) {
          // child stdin 已 destroyed：丢帧降级（子进程生命周期由 exit 帧链路接管），事件回调内无调用方可传播
          console.debug(`[relay] stdin write threw (child stream destroyed) recordId=${entry.recordId}:`, toErrorMessage(e))
        }
      }
    })
  }

  private tryParseFrame(line: string): InboundFrame | null {
    try {
      const parsed = JSON.parse(line) as InboundFrame
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.kind !== 'string') return null
      // data 帧形状守卫：b64 缺失/非 string 时 Buffer.from 抛 TypeError，且本调用点在
      // readline 回调内无捕获——畸形帧按 malformed 丢弃（数据阶段仅丢帧不断连，同连接
      // 后续帧仍有效；与握手首帧 malformed 的 reject+断连语义按阶段区分）
      if (parsed.kind === 'data' && (parsed.dir !== 'down' || typeof parsed.b64 !== 'string')) return null
      return parsed
    } catch {
      return null
    }
  }

  /** 握手校验（§3.1 版本协商 + §4.1 归属校验）+ 注册 + spawn + 子进程事件挂载。 */
  private registerHandshake(conn: Socket, frame: RelayHandshakeFrame): void {
    // 版本协商：v > runtime 支持版本 → reject(reason:'version') + 断连（代理退出码 10）
    if (typeof frame.v !== 'number' || frame.v > RELAY_PROTOCOL_VERSION) {
      writeFrame(conn, { kind: 'reject', reason: 'version', supported: [RELAY_PROTOCOL_VERSION] })
      endConn(conn)
      console.warn(`[relay] handshake rejected: version v=${String(frame.v)} > supported ${RELAY_PROTOCOL_VERSION}`)
      return
    }
    // 归属校验：字段形状 + env 归属键（防任意本地进程挂载借道 spawn，见两谓词注释）
    if (!hasValidHandshakeFrameShape(frame) || !isHandshakeEnvOwnershipValid(frame)) {
      writeFrame(conn, { kind: 'reject', reason: 'identity', supported: [RELAY_PROTOCOL_VERSION] })
      endConn(conn)
      console.warn('[relay] handshake rejected: identity/env validation failed')
      return
    }
    // 同 recordId 重复注册：旧条目可能还活着（异常重连），拒绝新连接防双代理同 id
    if (this.recordIdToConn.has(frame.recordId)) {
      writeFrame(conn, { kind: 'reject', reason: 'duplicate', supported: [RELAY_PROTOCOL_VERSION] })
      endConn(conn)
      console.warn(`[relay] handshake rejected: duplicate recordId=${frame.recordId}`)
      return
    }

    const child = this.trySpawnRelayChild(conn, frame)
    if (child === undefined) return

    const pidFile = getRelayPidFilePath(frame.recordId, this.opts.dataDir)
    const tee = new RelayTee({
      mainSessionId: frame.mainSessionId,
      recordId: frame.recordId,
      publish: this.opts.publish,
    })
    // stdout 磁盘镜像（架构约定：pi stdout 落盘是卡死时唯一证据，relay 子进程同款覆盖）。
    // logger 未初始化（如单测）时是 no-op 写入器，与 rpc-client 的 pi session log 同契约。
    const log = createPiRelayLog(frame.recordId)
    const entry: RegisteredEntry = { conn, mainSessionId: frame.mainSessionId, recordId: frame.recordId, child, pidFile, tee, log }
    this.entries.set(conn, entry)
    this.recordIdToConn.set(frame.recordId, conn)
    try {
      writeFileSync(pidFile, JSON.stringify({ pid: child.pid, spawnedAt: Date.now() }))
    } catch (e) {
      // pid 文件是重启兜底扫描依据，写失败不阻塞（当前 runtime 在管，退出时还会走清理）
      console.warn(`[relay] pid file write failed recordId=${frame.recordId}:`, e)
    }
    console.log(`[relay] registered recordId=${frame.recordId} mainSessionId=${frame.mainSessionId} pid=${String(child.pid)} cwd=${frame.cwd}`)

    // accept 确认帧：E-1 代理是严格状态机（accept 前不启动字节泵）——必须在 spawn 成功、
    // 条目注册完成后发出，此时 down 帧到来时 entries 已有条目可写入 child.stdin
    writeFrame(conn, { v: RELAY_PROTOCOL_VERSION, kind: 'accept' })

    this.attachRelayChildWiring(entry)
  }

  /**
   * spawn 真实 pi（argv/env/cwd 全从握手帧；env 经 buildChildEnv 剥离 relay 定位键）。
   * 返回 undefined = spawn 同步失败已处理（exit 帧 127 + 断连，调用方直接返回）。
   */
  private trySpawnRelayChild(conn: Socket, frame: RelayHandshakeFrame): ChildProcess | undefined {
    try {
      return spawn(this.piCommand, frame.argv, {
        cwd: frame.cwd,
        env: buildChildEnv(frame),
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不 detached：与 runtime 同进程组，runtime 崩溃时整组收割是双保险的主腿（§3.3-②）
        detached: false,
        windowsHide: true,
      })
    } catch (e) {
      // spawn 同步失败（异常 spawn 形态）表现为「子进程非零退出」——exit 帧 127 + 断连，
      // extension 走既有失败路径（§7 错误表：代理层失败不设独立错误面）
      console.error(`[relay] spawn failed recordId=${frame.recordId}:`, e)
      writeFrame(conn, { kind: 'exit', code: SPAWN_FAILURE_EXIT_CODE, signal: null })
      endConn(conn)
      return undefined
    }
  }

  /**
   * 子进程事件挂载（§4.3 字节泵 + §4.2 断连即杀）。
   * 编排通路优先 + 磁盘镜像 + tee 分支同一次读取顺序分发（转发是字节级保真主链，
   * tee / 镜像落盘失败绝不连坐转发——PiSessionLog.write 内部 best-effort 容错不抛，
   * 流级写错误降级为 runtime 主日志的 warn）
   */
  private attachRelayChildWiring(entry: RegisteredEntry): void {
    const { conn, child, tee } = entry

    child.stdin?.on('error', (err) => {
      console.debug(`[relay] child stdin error recordId=${entry.recordId}:`, err.message)
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      writeFrame(conn, { v: RELAY_PROTOCOL_VERSION, kind: 'data', dir: 'up', b64: chunk.toString('base64') })
      entry.log.write(chunk)
      if (!tee.abandoned) tee.feed(chunk)
    })
    child.stdout?.on('error', (err) => {
      console.warn(`[relay] child stdout stream error recordId=${entry.recordId}:`, err.message)
    })
    // stderr 只转发不进 tee（extension 的 stderrBuffer 累积语义不变）
    child.stderr?.on('data', (chunk: Buffer) => {
      writeFrame(conn, { v: RELAY_PROTOCOL_VERSION, kind: 'data', dir: 'up-stderr', b64: chunk.toString('base64') })
    })
    child.stderr?.on('error', (err) => {
      console.debug(`[relay] child stderr stream error recordId=${entry.recordId}:`, err.message)
    })

    child.once('error', (err) => {
      // spawn 异步失败（ENOENT 等）：表现为子进程非零退出（exit 帧 127）
      console.error(`[relay] child error recordId=${entry.recordId}:`, err)
      this.cleanupEntry(entry)
      writeFrame(conn, { kind: 'exit', code: SPAWN_FAILURE_EXIT_CODE, signal: null })
      endConn(conn)
    })

    child.once('exit', (code, signal) => {
      // 正常/被杀退出：exit 帧传播 → 关连接 → 清理（tee 销毁、pid 文件删除、注销）
      this.cleanupEntry(entry)
      writeFrame(conn, { kind: 'exit', code, signal: signal ?? null })
      endConn(conn)
      console.log(`[relay] child exited recordId=${entry.recordId} code=${String(code)} signal=${String(signal)}`)
    })

    // 断连即杀（§4.2）：socket close 的任何原因（代理死/主 pi 崩溃/extension kill）
    conn.once('close', () => {
      if (!this.entries.has(conn)) return // 已因 child exit 清理，no-op
      console.warn(`[relay] connection lost, killing child (kill-on-disconnect) recordId=${entry.recordId}`)
      // 杀链决策日志（crash-resilience §3.3 D6-⑥，E2 归因缺口的直接修复）：主 session
      // 断连（main pi 崩溃 / 代理丢失 / extension kill）连带杀受托 relay 子进程——
      // 动作/目标（主 session、recordId、子进程 pid）/原因 字段化单行落盘，E2 型
      // 「同秒连坐」事件可从此行反查连带关系。
      console.warn('[relay] kill decision', {
        action: 'kill_on_disconnect',
        mainSessionId: entry.mainSessionId,
        recordId: entry.recordId,
        childPid: entry.child.pid ?? null,
        reason: 'relay socket closed while child still alive (main pi died / proxy lost / extension kill)',
      })
      void killRelayChild(entry.child).then(() => this.cleanupEntry(entry))
    })
  }

  /** 清理条目（tee 销毁 + 镜像日志 end + pid 文件删除 + 双 Map 注销）。幂等。 */
  private cleanupEntry(entry: RegisteredEntry): void {
    if (!this.entries.has(entry.conn)) return
    this.entries.delete(entry.conn)
    this.recordIdToConn.delete(entry.recordId)
    entry.tee.dispose()
    entry.log.end() // 缓冲异步 flush；closeLogger 退出 flush 仍会兜底等待落盘
    try {
      if (existsSync(entry.pidFile)) unlinkSync(entry.pidFile)
    // eslint-disable-next-line taste/no-silent-catch -- 清理 best-effort：pid 文件残留由下次启动 sweepOrphanChildren 兜底删除
    } catch (e) {
      console.warn(`[relay] pid file cleanup failed recordId=${entry.recordId}:`, e)
    }
  }

  /** 关停序列：全部注册子进程杀链 + 关连接（deinitRelayServer 调用）。 */
  async destroyAll(): Promise<void> {
    const list = [...this.entries.values()]
    await Promise.allSettled(list.map(async (entry) => {
      entry.conn.destroy()
      await killRelayChild(entry.child)
      this.cleanupEntry(entry)
    }))
  }

  /**
   * 重启残留扫描兜底（§3.3-② / §4.2）：runtime 崩溃后 relay-children/ 下的 pid 文件
   * 是孤儿收割依据。判定链：kill -0 死 → 删 stale 文件；活 → ps lstart 比对 pid 文件
   * spawnedAt（进程启动晚于 spawn 记录 + 容差 = pid 复用，无辜进程不杀不删，防误杀）；
   * 启动时间不晚于记录 → 活孤儿收割（kill 链）；ps 不可用时保守跳过（保留文件下次再扫）
   * ——误杀无辜进程的代价高于留孤儿。
   */
  async sweepOrphanChildren(): Promise<void> {
    const dir = getRelayChildrenDir(this.opts.dataDir)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.pid')) continue
      const pidFile = `${dir}/${file}`
      const recordId = basename(file, '.pid')
      let pid: number
      let spawnedAt: number
      try {
        const parsed = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid?: unknown; spawnedAt?: unknown }
        if (typeof parsed.pid !== 'number' || typeof parsed.spawnedAt !== 'number') throw new Error('malformed pid file')
        pid = parsed.pid
        spawnedAt = parsed.spawnedAt
      } catch (e) {
        console.warn(`[relay] stale pid file removed (unreadable) recordId=${recordId}:`, e)
        this.removePidFile(pidFile)
        continue
      }
      if (!isPidAlive(pid)) {
        this.removePidFile(pidFile)
        continue
      }
      const procStart = await this.readProcessStartTime(pid)
      if (procStart === null) {
        // ps 不可用/解析失败：无法排除 pid 复用，保守跳过（保留文件，下次启动再扫）
        console.warn(`[relay] orphan sweep skipped (no process start time) recordId=${recordId} pid=${String(pid)}`)
        continue
      }
      if (procStart > spawnedAt + PID_REUSE_TOLERANCE_MS) {
        // 进程比 spawn 记录新 → pid 已被复用，现在持有者是无关进程：不杀，仅删过期记录
        console.warn(`[relay] pid ${String(pid)} reused (procStart ${procStart} > spawnedAt ${spawnedAt}), not killing — recordId=${recordId}`)
        this.removePidFile(pidFile)
        continue
      }
      console.warn(`[relay] reaping orphan relay child recordId=${recordId} pid=${String(pid)}`)
      try {
        process.kill(pid, 'SIGCONT')
        process.kill(pid, 'SIGTERM')
      } catch (e) {
        // EPERM = 非本进程组（pid 复用的另一形态）：不追杀，保留文件
        console.warn(`[relay] orphan SIGTERM failed (not reaping) recordId=${recordId}:`, e)
        continue
      }
      setTimeout(() => {
        try {
          if (isPidAlive(pid)) process.kill(pid, 'SIGKILL')
        } catch {
          // kill 抛错 = 进程已死（ESRCH），正是收割目标状态
          void 0
        }
        this.removePidFile(pidFile)
      }, RELAY_KILL_GRACE_MS).unref()
    }
  }

  /** 读进程启动时间（epoch ms）；失败/平台不支持返回 null。 */
  private readProcessStartTime(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
      execFile('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5_000 }, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const parsed = Date.parse(String(stdout).trim())
        resolve(Number.isNaN(parsed) ? null : parsed)
      })
    })
  }

  private removePidFile(pidFile: string): void {
    try {
      if (existsSync(pidFile)) unlinkSync(pidFile)
    // eslint-disable-next-line taste/no-silent-catch -- 清理 best-effort：残留 pid 文件下次启动扫描会按 stale 再删
    } catch (e) {
      console.warn('[relay] pid file remove failed:', e)
    }
  }
}
