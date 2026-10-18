/**
 * subagent control server（M3，设计 relay-spawn-transport §3.3 D4/D7/D8 + §3.4.3）。
 *
 * runtime 收归引擎进程 spawn 权的承接面：unix socket listen（供引擎 CLI 进程与嵌套
 * extension 连接）→ hello（无独立 token——socket 文件权限即边界，ADR-0122 #10）→
 * engine_open（runtime 侧 spawn 真实引擎 CLI，POSIX detached 进程组 + kill 链）→
 * engine_frame 双向转发（引擎帧是不透明字符串载荷，本层不理解引擎协议语义）→
 * engine_close / exit → engine_closed + 组杀；连接断 → 该连接全部引擎组杀
 * （kill-on-disconnect：通道生命线即引擎生命线）。
 *
 * 模块级单例——组合根（index.ts）唯一装配点，process-manager（control env 注入侧）经
 * isControlServerActive / getActiveControlSocketPath 联动（server 未激活则 env 不注入，
 * extension 侧 isControlEnvActive 判缺失回落 local transport）。测试直接实例化
 * SubagentControlServer（dataDir 隔离 + 时间窗/上限注入小值）。
 *
 * 状态机（每连接，§3.4.3）：connected → hello → ready；engine_open → opening（占位
 * 先于 spawn）→ open；engine_closed/engine_close → 注销；socket close → 全通道组杀。
 * 无心跳（进程死亡由 socket close / exit 事件表达，ADR-0122 生死二态）。
 */
import * as net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { getDataDir, getPiAgentDir } from '@taiji/shared/paths'
import {
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
  EngineSdkError,
  resolveEngineNodeLaunch,
  type EngineNodeLaunch,
  type EngineNodeLaunchOptions,
} from '@zhushanwen/subagent-engine-sdk'
import {
  getControlEnginesDir,
  getControlRunDir,
  getControlSocketPath,
  getEnginePidFilePath,
  assertSocketPathLength,
} from './paths.js'
import {
  CONTROL_MAX_FRAME_BYTES,
  CHANNEL_QUEUE_MAX_BYTES,
  CHANNEL_QUEUE_MAX_FRAMES,
  CONNECTION_QUEUE_MAX_BYTES,
  MAX_CHANNELS_PER_CONNECTION,
  CONTROL_HELLO_TIMEOUT_MS,
  ENGINE_OPEN_TIMEOUT_MS,
  ENGINE_CLOSE_GRACE_MS,
  STDERR_TAIL_CHARS,
  CONTROL_FRAME_ERROR_CODES,
  byteLengthOf,
  extractOversizeFrameHead,
  parseControlInboundFrame,
  type ControlEngineCloseFrame,
  type ControlEngineFrameFrame,
  type ControlEngineOpenFrame,
  type EngineLaunchSpecWire,
  type SubagentControlClosedReason,
} from './frames.js'
import { ControlChannelRegistry, type EngineChannelRecord } from './channel-registry.js'
import { buildEngineLaunchEnv } from './engine-launch-env.js'
import { SubagentMirrorHub, type MirrorPublish } from './mirror.js'
import type { SubagentTeeStreamState } from './subagent-tee.js'
import { killEngineGroup } from './process-kill.js'
import { sweepOrphanEnginePids, sweepStaleControlSockets } from './sweep.js'
import { findPiExecutable } from '../pi/find-pi-executable.js'
import { getEngineRootsSpawnEnv } from '../../services/session/engine-roots.js'
import { toErrorMessage } from '../../utils/errors.js'

// ── 依赖注入（测试隔离用；生产全部走缺省推导）─────────────────────────────────

export type ControlServerOptions = {
  /** 数据目录（socket/pid 文件根；测试隔离注入，缺省 getDataDir()）。 */
  dataDir?: string
  /** pi 二进制定位锚点（dev = apps/electron；缺省 process.cwd() 的同款 cwd 约定）。 */
  projectRoot?: string
  /**
   * 引擎发现/执行器 env（getEngineRootsSpawnEnv 产物：TAIJI_AGENT_ENGINE_ROOTS +
   * 打包态 TAIJI_AGENT_ENGINE_NODE/ELECTRON_RUN_AS_NODE）——引擎 env 基座与嵌套发现
   * 共用。缺省按 projectRoot 推导（组合根注入以维持 infra 不 import services 的方向）。
   */
  engineNodeEnv?: Record<string, string>
  /** spawn 命令覆盖（测试注入；生产缺省 findPiExecutable(projectRoot) 只取其目录）。 */
  piCommand?: string
  /** runtime env 快照（引擎 env 基座；缺省 process.env）。 */
  runtimeEnv?: NodeJS.ProcessEnv
  /** 引擎 launch 解析注入（测试挂起模拟 open 超时）。 */
  resolveLaunch?: (opts: EngineNodeLaunchOptions) => Promise<EngineNodeLaunch>
  /** 宿主 execPath 覆盖（测试；缺省 process.execPath，runtime sidecar 矩阵②）。 */
  execPath?: string
  /** 宿主 Electron 判定覆盖（测试；缺省按当前进程）。 */
  isElectronHost?: boolean
  /** taiji 托管 pi agent 目录（缺省 getPiAgentDir() 同源推导）。 */
  piAgentDir?: string
  /**
   * [M3 D6] raw mirror 的 WS 帧发布出口（组合根注入 messageBus.publish；缺省 no-op
   * ——单测形态：镜像仍可查询状态，不产帧副作用）。
   */
  publish?: MirrorPublish
  // ── 时间窗与上限（D8；测试注入小值）──
  helloTimeoutMs?: number
  openTimeoutMs?: number
  closeGraceMs?: number
  maxFrameBytes?: number
  maxChannelsPerConnection?: number
  channelQueueMaxBytes?: number
  channelQueueMaxFrames?: number
  connectionQueueMaxBytes?: number
  /** 启动 sweep 开关（缺省 true）。 */
  sweep?: boolean
}

/** 在途 engine_open 登记（数据形状，非可实现契约——oe-audit 口径用 type 别名）。 */
type PendingOpen = {
  key: string
  spec: EngineLaunchSpecWire
  timer: NodeJS.Timeout
  /** 超时已裁决（spawn 竞态回来的迟到结果按 open_timeout 杀组丢弃）。 */
  aborted: boolean
}

type ConnState = {
  id: string
  socket: net.Socket
  helloDone: boolean
  /** 连接归属根会话（第一个 engine_open 确定；后续不一致 → engine_open_failed session）。 */
  rootSessionId: string | null
  destroyed: boolean
  buffer: string
  bufferBytes: number
  /**
   * 超长帧丢弃态（partial-line 缓冲超限后帧界已失同步）：丢弃数据直到下一个换行，
   * 连接保持可用（D8 通道归因关通道、不升连连接的落地形态）。
   */
  discardingUntilNewline: boolean
  helloTimer: NodeJS.Timeout
  pendingOpens: Map<string, PendingOpen>
  /** 已受理过的 engine_open requestId（按 id 幂等：重复 id → duplicate）。 */
  seenOpenIds: Set<string>
  /** up 方向待写队列（socket 背压；{channelId, 行} FIFO 保 per-channel 顺序）。 */
  upQueue: Array<{ channelId: string; line: string; bytes: number }>
  upQueueBytes: number
  /**
   * down 方向待写队列的**连接级聚合**字节数（各通道 pendingDownBytes 之和；D8
   * 「每连接每方向 256MB」的 down 侧防线）。
   */
  downQueueBytes: number
  awaitingDrain: boolean
}

/** 通道运行期机制（台账本体在 ControlChannelRegistry；本结构只承载队列/定时器/终局标记）。 */
type ChannelCtx = {
  rec: EngineChannelRecord
  conn: ConnState
  pendingDown: Array<{ line: string; bytes: number }>
  pendingDownBytes: number
  pendingUpFrames: number
  pendingUpBytes: number
  stderrTail: string
  closeTimer: NodeJS.Timeout | null
  /** 控制面已裁决杀组（engine_close 超时 / 背压溢出 / 断连 fan-out / open 超时 / 递归树杀）。 */
  killRequested: boolean
  /**
   * engine_close（intentional）已受理：引擎在 grace 窗内自行退出属正常关闭路径，
   * exit 处理按正常口径记日志（D7 intentional/unexpected 两分），不走「意外退出」warn。
   */
  intentionalClose: boolean
  /** 杀组路径预设的终局归因（exit 事件到达时采用；缺省按 code/signal 推导）。 */
  closedReason: SubagentControlClosedReason | null
  closedNotified: boolean
  exitSeen: boolean
  cleanedUp: boolean
}

/** spawn 同步失败呈现为引擎非零退出（127 = command not found 惯例）。 */
const SPAWN_FAILURE_EXIT_CODE = 127

/**
 * 连接静默关闭（best-effort）：半关闭/destroyed 流上 `socket.end()` 会同步抛
 * EPIPE/ERR_STREAM_DESTROYED——在事件回调里逃逸即 uncaughtException → 整机 shutdown
 * （2026-09-04 事故形态）。参照既有 socket 服务端 endConn 先例。
 */
function endConnQuietly(conn: ConnState): void {
  try {
    conn.socket.end()
  // eslint-disable-next-line taste/no-silent-catch -- 竞态窗口内已 destroyed：无需再关，无信息可记
  } catch {
    // 已 destroyed（竞态）：无需再关
  }
}

export class SubagentControlServer {
  private readonly registry = new ControlChannelRegistry()
  private readonly ctxs = new Map<string, ChannelCtx>()
  private readonly conns = new Map<string, ConnState>()
  /** [M3 D6] raw mirror 读取侧（fd3 → SubagentTee/磁盘镜像/degraded；state 查询数据源）。 */
  private readonly mirror: SubagentMirrorHub
  private server: net.Server | null = null
  private socketPath = ''
  private isUnixSocket = false
  private connSeq = 0
  private channelSeq = 0
  private deinitialized = false

  private readonly helloTimeoutMs: number
  private readonly openTimeoutMs: number
  private readonly closeGraceMs: number
  private readonly maxFrameBytes: number
  private readonly maxChannelsPerConnection: number
  private readonly channelQueueMaxBytes: number
  private readonly channelQueueMaxFrames: number
  private readonly connectionQueueMaxBytes: number

  private readonly dataDir: string
  private readonly projectRoot: string
  private readonly engineNodeEnv: Record<string, string>
  private readonly runtimeEnv: NodeJS.ProcessEnv
  private readonly piDir: string | undefined
  private readonly piAgentDir: string
  private readonly resolveLaunch: (opts: EngineNodeLaunchOptions) => Promise<EngineNodeLaunch>
  private readonly execPath: string | undefined
  private readonly isElectronHost: boolean | undefined

  constructor(private readonly opts: ControlServerOptions) {
    this.dataDir = opts.dataDir ?? getDataDir()
    this.projectRoot = opts.projectRoot ?? process.cwd()
    this.engineNodeEnv = opts.engineNodeEnv ?? getEngineRootsSpawnEnv(this.projectRoot)
    this.runtimeEnv = opts.runtimeEnv ?? { ...process.env }
    this.helloTimeoutMs = opts.helloTimeoutMs ?? CONTROL_HELLO_TIMEOUT_MS
    this.openTimeoutMs = opts.openTimeoutMs ?? ENGINE_OPEN_TIMEOUT_MS
    this.closeGraceMs = opts.closeGraceMs ?? ENGINE_CLOSE_GRACE_MS
    this.maxFrameBytes = opts.maxFrameBytes ?? CONTROL_MAX_FRAME_BYTES
    this.maxChannelsPerConnection = opts.maxChannelsPerConnection ?? MAX_CHANNELS_PER_CONNECTION
    this.channelQueueMaxBytes = opts.channelQueueMaxBytes ?? CHANNEL_QUEUE_MAX_BYTES
    this.channelQueueMaxFrames = opts.channelQueueMaxFrames ?? CHANNEL_QUEUE_MAX_FRAMES
    this.connectionQueueMaxBytes = opts.connectionQueueMaxBytes ?? CONNECTION_QUEUE_MAX_BYTES
    this.resolveLaunch = opts.resolveLaunch ?? resolveEngineNodeLaunch
    this.execPath = opts.execPath
    this.isElectronHost = opts.isElectronHost
    const piCommand = opts.piCommand ?? safeFindPi(this.projectRoot)
    this.piDir = piCommand !== 'pi' ? dirname(piCommand) : undefined
    this.piAgentDir = opts.piAgentDir ?? getPiAgentDir()
    this.mirror = new SubagentMirrorHub(
      opts.publish !== undefined ? { publish: opts.publish } : {},
    )
  }

  /** 在册通道数（滚动重启在途面组合根消费）。 */
  get channelCount(): number {
    return this.registry.channelCount
  }

  get listeningSocketPath(): string {
    return this.socketPath
  }

  /** 测试钩子：通道台账只读（生产无调用方）。 */
  getChannelForTest(channelId: string): EngineChannelRecord | undefined {
    return this.registry.get(channelId)
  }

  /**
   * [M3 D6] 流状态查询（session.getSubagentStreamState 的 control 侧数据源）：按
   * `(rootSessionId, recordId)` 索引读 mirror tee 快照；未登记/跨 session → undefined
   * （组合根按缺省 found:false 处理）。
   */
  getStreamStateByRecord(sessionId: string, recordId: string): SubagentTeeStreamState | undefined {
    return this.mirror.getStreamStateByRecord(sessionId, recordId)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /**
   * 初始化：目录创建（run/ 0700）→ 跨代 socket 清理 → listen → socket 文件 0600 →
   * 孤儿引擎收割（fire-and-forget）。listen 失败/实例冲突抛错，由组合根决定进程命运
   * （fail-fast——「以为 runtime 在管、实际 local spawn」的静默分裂比启动失败更危险）。
   */
  async init(): Promise<void> {
    if (this.server !== null) throw new Error('[subagent-control] server already initialized')
    mkdirSync(getControlRunDir(this.dataDir), { recursive: true, mode: 0o700 })
    mkdirSync(getControlEnginesDir(this.dataDir), { recursive: true, mode: 0o700 })

    this.socketPath = getControlSocketPath(this.dataDir)
    assertSocketPathLength(this.socketPath)
    this.isUnixSocket = process.platform !== 'win32'

    // 跨代残留 socket 清理（D7：扫 subagent-*.sock 全族，非只探当前 pid 路径）。
    // win32 named pipe 是内核对象无文件残留；pipe 名含本 pid 不会撞活实例，跳过。
    if (this.opts.sweep !== false && this.isUnixSocket) {
      await sweepStaleControlSockets(this.dataDir, this.socketPath)
    }

    const server = net.createServer((conn) => {
      this.handleConnection(conn)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server

    // socket 文件权限即认证边界（D4：不引入 token）；win32 named pipe 用默认 ACL，不适用
    if (this.isUnixSocket) {
      try {
        // eslint-disable-next-line no-magic-numbers -- socket 权限 0600（fchmod 语义，D4）
        chmodSync(this.socketPath, 0o600)
      } catch (e) {
        // best-effort 降级：chmod 失败只降级告警（socket 仍可用；权限面由目录 0700 兜底）
        console.warn('[subagent-control] socket chmod 0600 failed:', e)
      }
    }
    console.log(`[subagent-control] server listening at ${this.socketPath}`)

    // 孤儿引擎收割（owner runtime 死 → 立即组杀；后台兜底不阻塞启动）
    if (this.opts.sweep !== false) {
      void sweepOrphanEnginePids(this.dataDir).catch((e) => {
        console.warn('[subagent-control] orphan engine sweep failed (non-fatal):', e)
      })
    }
  }

  /** 关停：全连接全通道组杀 + 关 server + 删 socket 文件。幂等（shutdown 与测试 afterEach 均可安全调用）。 */
  async destroy(): Promise<void> {
    if (this.deinitialized) return
    this.deinitialized = true
    for (const conn of [...this.conns.values()]) {
      this.destroyConnection(conn, 'runtime_shutdown')
    }
    // 兜底：异常顺序下可能残留未随连接释放的 record/行泵（disposeChannel/disposeAll 幂等）
    this.mirror.disposeAll()
    await new Promise<void>((resolve) => {
      if (this.server === null) {
        resolve()
        return
      }
      this.server.close(() => resolve())
    })
    this.server = null
    if (this.isUnixSocket && this.socketPath.length > 0) {
      try {
        if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
      } catch (e) {
        // best-effort 降级：残留 socket 文件由下次启动 sweep 清理，不阻断关停
        console.warn(`[subagent-control] failed to remove socket file ${this.socketPath}:`, e)
      }
    }
    console.log('[subagent-control] server deinitialized')
  }

  // ── 连接层 ──────────────────────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const conn: ConnState = {
      id: `conn-${++this.connSeq}`,
      socket,
      helloDone: false,
      rootSessionId: null,
      destroyed: false,
      buffer: '',
      bufferBytes: 0,
      discardingUntilNewline: false,
      helloTimer: setTimeout(() => {
        // hello 等待窗（D8 三窗之一）：连上不说 hello 的连接没有存在价值
        console.warn(`[subagent-control] hello timeout, destroying connection ${conn.id}`)
        this.destroyConnection(conn, 'hello_timeout')
      }, this.helloTimeoutMs),
      pendingOpens: new Map(),
      seenOpenIds: new Set(),
      upQueue: [],
      upQueueBytes: 0,
      downQueueBytes: 0,
      awaitingDrain: false,
    }
    this.conns.set(conn.id, conn)

    // 连接级 error 兜底（对端 RST → ECONNRESET）：socket 'error' 无 listener 直接 throw
    // 成 uncaughtException（2026-09-04 事故同族）。destroy 后由 close 走 fan-out。
    socket.on('error', (err) => {
      console.warn(`[subagent-control] connection error, destroying ${conn.id}:`, err.message)
      socket.destroy()
    })
    socket.on('data', (chunk: Buffer) => {
      this.ingestChunk(conn, chunk)
    })
    socket.on('drain', () => {
      this.flushUpQueue(conn)
    })
    socket.once('close', () => {
      // kill-on-disconnect（D4/D7）：主 pi/extension 死亡 → 该连接全部引擎组杀
      this.destroyConnection(conn, 'socket_closed')
    })
  }

  private ingestChunk(conn: ConnState, chunk: Buffer): void {
    if (conn.destroyed) return
    const text = chunk.toString('utf8')
    if (conn.discardingUntilNewline) {
      // 超长帧丢弃态（帧界未达即超限，流已失同步）：丢弃直到下一帧界，其后照常解析
      const nl = text.indexOf('\n')
      if (nl === -1) return
      conn.discardingUntilNewline = false
      this.ingestChunk(conn, Buffer.from(text.slice(nl + 1), 'utf8'))
      return
    }
    conn.buffer += text
    conn.bufferBytes += chunk.length
    // 帧界未达即超限（partial-line 无换行）：按超长帧归因处置（关通道），进丢弃态直到
    // 下一帧界——连接保持可用（流式信封解析读前 1KB 提取归属，D8）
    if (conn.bufferBytes > this.maxFrameBytes && conn.buffer.indexOf('\n') === -1) {
      this.handleOversize(conn, conn.buffer)
      conn.buffer = ''
      conn.bufferBytes = 0
      conn.discardingUntilNewline = true
      return
    }
    let nl = conn.buffer.indexOf('\n')
    while (nl !== -1 && !conn.destroyed) {
      const line = conn.buffer.slice(0, nl)
      conn.buffer = conn.buffer.slice(nl + 1)
      nl = conn.buffer.indexOf('\n')
      if (line.trim().length === 0) continue
      // 完整帧超限（帧界完好）：handleLine 内按行判超限归因关通道，余帧照常解析
      this.handleLine(conn, line)
    }
    conn.bufferBytes = byteLengthOf(conn.buffer)
  }

  private handleLine(conn: ConnState, line: string): void {
    if (conn.destroyed) return
    if (byteLengthOf(line) > this.maxFrameBytes) {
      // 完整行超限：帧界完好，归因关通道即可，连接不升连
      this.handleOversize(conn, line)
      return
    }
    if (!conn.helloDone) {
      this.handlePreHelloLine(conn, line)
      return
    }
    const frame = parseControlInboundFrame(line)
    if (frame === null) {
      // hello 后畸形帧：丢弃（连接保持——数据阶段同语义；超长/背压才有
      // 归因通道，见 handleOversize / writeErrorAndKill）
      console.warn(`[subagent-control] malformed frame dropped on ${conn.id} len=${line.length}`)
      return
    }
    switch (frame.kind) {
      case SUBAGENT_CONTROL_FRAME_KINDS.hello:
        return // 重复 hello：忽略（连接已就绪）
      case SUBAGENT_CONTROL_FRAME_KINDS.engineOpen:
        this.handleEngineOpen(conn, frame)
        return
      case SUBAGENT_CONTROL_FRAME_KINDS.engineFrame:
        this.handleEngineFrame(conn, frame)
        return
      case SUBAGENT_CONTROL_FRAME_KINDS.engineClose:
        this.handleEngineClose(conn, frame)
        return
      default:
        return
    }
  }

  /** hello 前的判别：版本不匹配的 hello → hello_reject version；其余 → hello_reject + 断连。 */
  private handlePreHelloLine(conn: ConnState, line: string): void {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = null
    }
    const raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    if (raw !== null && raw.kind === SUBAGENT_CONTROL_FRAME_KINDS.hello) {
      const frame = parseControlInboundFrame(line)
      if (frame === null || frame.kind !== SUBAGENT_CONTROL_FRAME_KINDS.hello) {
        // hello 形状对但版本不匹配（或 id 缺失）→ version 拒绝（D9 版本矩阵：未知 v
        // 显式失败，supported 通告；runtime 与 extension 同包分发，见 SDK control-env）
        const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : null
        this.writeFrame(conn, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: SUBAGENT_CONTROL_FRAME_KINDS.helloReject,
          id,
          reason: 'version',
          message: `protocol version mismatch or malformed hello: expected v=${SUBAGENT_CONTROL_PROTOCOL_VERSION}`,
          recovery: 'Upgrade the taiji app (runtime and extension ship together).',
          supported: [SUBAGENT_CONTROL_PROTOCOL_VERSION],
        })
        console.warn(`[subagent-control] hello rejected (version) on ${conn.id}`)
        endConnQuietly(conn)
        return
      }
      conn.helloDone = true
      clearTimeout(conn.helloTimer)
      this.writeFrame(conn, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.helloOk,
        id: frame.id,
        runtimePid: process.pid,
        protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      })
      return
    }
    // 首帧非 hello（或畸形 JSON）：协议状态机非法迁移，显式拒绝 + 断连
    this.writeFrame(conn, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: SUBAGENT_CONTROL_FRAME_KINDS.helloReject,
      id: null,
      reason: 'expected_hello',
      message: 'first frame must be hello',
      recovery: 'Send hello {v, id, hostPid, hostKind} immediately after connect.',
      supported: [SUBAGENT_CONTROL_PROTOCOL_VERSION],
    })
    console.warn(`[subagent-control] non-hello first frame on ${conn.id}, rejecting`)
    endConnQuietly(conn)
  }

  /**
   * 超长帧处置（D8）：读前 1KB 提取 v/kind/channelId——能归因到在册通道 → 该通道
   * error + 杀组关通道（不丢整条连接）；无法归因 → 关整条连接（唯一保守动作）。
   * 超限不截断（不把截断帧当有效帧转发）。
   */
  private handleOversize(conn: ConnState, line: string): void {
    const head = extractOversizeFrameHead(line)
    console.warn(
      `[subagent-control] oversized frame (${byteLengthOf(line)} bytes) on ${conn.id} `
      + `kind=${String(head.kind)} channelId=${String(head.channelId)}`,
    )
    const channelId = head.channelId
    if (typeof channelId === 'string') {
      const ctx = this.ctxs.get(channelId)
      if (ctx !== undefined && ctx.conn === conn) {
        this.writeFrame(conn, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
          channelId,
          code: CONTROL_FRAME_ERROR_CODES.frameTooLarge,
          message: `control frame exceeded ${String(this.maxFrameBytes)} bytes`,
          recovery: 'Split the payload; engine_frame.line carries one engine-protocol frame per line.',
        })
        this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, 'frame_too_large')
        return
      }
    }
    this.destroyConnection(conn, 'frame_too_large_unattributable')
  }

  // ── engine_open ─────────────────────────────────────────────────────────────

  private handleEngineOpen(conn: ConnState, frame: ControlEngineOpenFrame): void {
    const spec = frame.launch
    // 归属校验：第一个 open 确定连接根会话，后续不一致显式失败（D5）
    if (conn.rootSessionId === null) {
      conn.rootSessionId = spec.rootSessionId
    } else if (conn.rootSessionId !== spec.rootSessionId) {
      this.replyOpenFailed(conn, frame.id, CONTROL_FRAME_ERROR_CODES.sessionMismatch,
        `root session mismatch: connection bound to ${conn.rootSessionId}, open carried ${spec.rootSessionId}`,
        'One control connection serves one root session; open a new connection for another session.')
      return
    }
    // 按 id 幂等（重复 id 不重复 spawn）
    const key = String(frame.id)
    if (conn.seenOpenIds.has(key)) {
      this.replyOpenFailed(conn, frame.id, CONTROL_FRAME_ERROR_CODES.duplicate,
        `duplicate engine_open id ${key}`, 'Use a fresh request id.')
      return
    }
    conn.seenOpenIds.add(key)
    // 连接通道数上限（聚合防线；复用 engine_open_failed 帧，不新增帧类型）
    if (this.registry.listByConnection(conn.id).length >= this.maxChannelsPerConnection) {
      this.replyOpenFailed(conn, frame.id, CONTROL_FRAME_ERROR_CODES.channelLimit,
        `connection channel limit (${String(this.maxChannelsPerConnection)}) reached`,
        'Close idle engine channels before opening more.')
      return
    }
    // 基本形状校验（信任边界内不设防，但绝对路径 + 存在性要过硬）
    if (!isAbsolute(spec.entryPath) || !existsSync(spec.entryPath)) {
      this.replyOpenFailed(conn, frame.id, CONTROL_FRAME_ERROR_CODES.invalidLaunch,
        `entryPath is not an absolute existing path: ${spec.entryPath}`,
        'Resolve the engine entry from the engine descriptor (absolute path).')
      return
    }

    // opening 占位先于 spawn（连接关闭/超时能覆盖它）
    const opening: PendingOpen = {
      key,
      spec,
      timer: setTimeout(() => {
        this.abortOpening(conn, opening)
      }, this.openTimeoutMs),
      aborted: false,
    }
    conn.pendingOpens.set(key, opening)
    void this.spawnForOpening(conn, opening)
  }

  private async spawnForOpening(conn: ConnState, opening: PendingOpen): Promise<void> {
    const spec = opening.spec
    let launch: EngineNodeLaunch
    try {
      launch = await this.resolveLaunch({
        entryPath: spec.entryPath,
        args: spec.args,
        hostKind: 'runtime-sidecar',
        env: this.runtimeEnv,
        execPath: this.execPath,
        isElectronHost: this.isElectronHost,
      })
    } catch (e) {
      const code = e instanceof EngineSdkError ? e.code : CONTROL_FRAME_ERROR_CODES.spawnFailed
      const recovery = e instanceof EngineSdkError && e.recovery.length > 0
        ? e.recovery
        : 'Check the engine descriptor entryPath and the runtime executor availability.'
      this.failOpening(conn, opening, code, toErrorMessage(e), recovery)
      return
    }
    if (conn.destroyed || opening.aborted) return // 迟到解析结果：无进程可杀，占位已清

    const env = buildEngineLaunchEnv({
      runtimeEnv: this.runtimeEnv,
      dataDir: this.dataDir,
      engineNode: this.engineNodeEnv.TAIJI_AGENT_ENGINE_NODE,
      electronRunAsNode: launch.electronRunAsNode,
      envPrefixes: spec.envPrefixes,
      piAgentDir: this.piAgentDir,
      piDir: this.piDir,
      controlSocket: this.socketPath,
      rootSessionId: spec.rootSessionId,
      rawMirror: true,
    })

    let child: ChildProcess
    try {
      // POSIX detached:true（引擎 = 进程组长，组杀覆盖引擎 + 其 pi 子进程）；
      // Windows detached:false + windowsHide:true（树杀走 taskkill /T，D7）。
      // stdio[3] = raw mirror 通道（TAIJI_ENGINE_RAW_MIRROR=1 宣告；读取侧由
      // SubagentMirrorHub 接管——见 attachChildWiring 的 fd3 接线）。
      child = spawn(launch.command, launch.args, {
        cwd: spec.cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      this.failOpening(conn, opening, CONTROL_FRAME_ERROR_CODES.spawnFailed, toErrorMessage(e),
        'Check the engine executor availability; the runtime re-probes after restart.')
      return
    }
    if (opening.aborted || conn.destroyed) {
      // spawn 与超时/断连的竞态：刚拿到的进程立即组杀，不回 engine_opened（迟到结果丢弃）
      killEngineGroup(child.pid, `late-spawn ${spec.engineId}`)
      return
    }

    // 登记通道 + pid 文件（D7 形状：runtimePid/instanceId/hostKind 供 sweep owner 判定）
    const channelId = `ch-${++this.channelSeq}`
    const pidFile = getEnginePidFilePath(spec.rootSessionId, spec.engineId, channelId, this.dataDir)
    const rec = this.registry.register({
      channelId,
      connectionId: conn.id,
      engineId: spec.engineId,
      openKey: opening.key,
      rootSessionId: spec.rootSessionId,
      parentRecordId: spec.parentRecordId ?? null,
      depth: spec.depth ?? null,
      recordId: spec.recordId ?? null,
      pidFile,
    })
    rec.state = 'open'
    rec.pid = child.pid ?? null
    rec.child = child
    const ctx: ChannelCtx = {
      rec,
      conn,
      pendingDown: [],
      pendingDownBytes: 0,
      pendingUpFrames: 0,
      pendingUpBytes: 0,
      stderrTail: '',
      closeTimer: null,
      killRequested: false,
      intentionalClose: false,
      closedReason: null,
      closedNotified: false,
      exitSeen: false,
      cleanedUp: false,
    }
    this.ctxs.set(channelId, ctx)
    try {
      writeFileSync(pidFile, JSON.stringify({
        pid: child.pid ?? null,
        spawnedAt: Date.now(),
        engineId: spec.engineId,
        rootSessionId: spec.rootSessionId,
        parentRecordId: spec.parentRecordId ?? null,
        depth: spec.depth ?? null,
        runtimePid: process.pid,
        instanceId: String(process.pid),
        hostKind: 'runtime-sidecar',
      }))
    } catch (e) {
      // pid 文件是重启 sweep 依据，写失败不阻塞（当前 runtime 在管，退出走清理）
      console.warn(`[subagent-control] pid file write failed ${pidFile}:`, e)
    }

    clearTimeout(opening.timer)
    conn.pendingOpens.delete(opening.key)
    this.writeFrame(conn, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpened,
      id: frameIdOf(opening.key),
      channelId,
      pid: child.pid ?? null,
    })
    console.log(
      `[subagent-control] engine opened channelId=${channelId} engineId=${spec.engineId} `
      + `pid=${String(child.pid)} rootSessionId=${spec.rootSessionId} `
      + `parentRecordId=${spec.parentRecordId ?? '-'} depth=${String(spec.depth ?? '-')}`,
    )
    this.attachChildWiring(ctx)
  }

  /** open 超时（D8 三窗之一）：中止占位；spawn 已赢下竞态则连引擎一起组杀（open_timeout）。 */
  private abortOpening(conn: ConnState, opening: PendingOpen): void {
    opening.aborted = true
    conn.pendingOpens.delete(opening.key)
    // 占位期通道反查（spawn 成功但应答被超时抢先的竞态形态；openKey 精确归属）
    const rec = this.registry.listByConnection(conn.id).find((r) => r.openKey === opening.key)
    if (rec === undefined) {
      this.replyOpenFailed(conn, frameIdOf(opening.key), CONTROL_FRAME_ERROR_CODES.openTimeout,
        `engine_open timed out after ${String(this.openTimeoutMs)}ms`,
        'Check the engine executor and entryPath; retry with a fresh request id.')
      return
    }
    const ctx = this.ctxs.get(rec.channelId)
    if (ctx === undefined) return
    this.writeFrame(conn, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
      channelId: rec.channelId,
      code: CONTROL_FRAME_ERROR_CODES.openTimeout,
      message: `engine_open timed out after ${String(this.openTimeoutMs)}ms`,
      recovery: 'The engine process was aborted by the runtime.',
    })
    this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.openTimeout, 'open_timeout')
  }

  private failOpening(conn: ConnState, opening: PendingOpen, code: string, message: string, recovery: string): void {
    clearTimeout(opening.timer)
    conn.pendingOpens.delete(opening.key)
    this.replyOpenFailed(conn, frameIdOf(opening.key), code, message, recovery)
  }

  private replyOpenFailed(conn: ConnState, id: string | number | null, code: string, message: string, recovery: string): void {
    this.writeFrame(conn, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed,
      id,
      code,
      message,
      recovery,
    })
    console.warn(`[subagent-control] engine_open failed code=${code} on ${conn.id}: ${message}`)
  }

  // ── engine_frame / engine_close ─────────────────────────────────────────────

  /** C→R engine_frame：写引擎 stdin（runtime 是引擎 stdin 唯一写者；背压经队列，溢出显式失败）。 */
  private handleEngineFrame(conn: ConnState, frame: ControlEngineFrameFrame): void {
    const ctx = this.ctxs.get(frame.channelId)
    if (ctx === undefined || ctx.conn !== conn || ctx.rec.state !== 'open') {
      this.writeFrame(conn, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
        channelId: frame.channelId,
        code: CONTROL_FRAME_ERROR_CODES.unknownChannel,
        message: `unknown or closed channel ${frame.channelId}`,
        recovery: 'Open the engine channel again with engine_open.',
      })
      return
    }
    this.writeDown(ctx, frame.line)
  }

  private writeDown(ctx: ChannelCtx, line: string): void {
    const stdin = ctx.rec.child?.stdin
    if (stdin === undefined || stdin === null || stdin.destroyed) {
      console.debug(`[subagent-control] stdin unavailable, dropping frame channelId=${ctx.rec.channelId}`)
      return
    }
    const bytes = byteLengthOf(line) + 1
    // 先尝试写：只有返回 false（需入队，即真正产生驻留）时才判上限。健康通道的写入
    // （返回 true）不贡献 downQueueBytes，不能因其它通道的积压被连接级聚合上限误杀。
    let ok = false
    try {
      ok = stdin.write(`${line}\n`)
    } catch (e) {
      // 引擎已死（EPIPE 族）：exit 帧链路接管，丢帧降级
      console.debug(`[subagent-control] stdin write threw channelId=${ctx.rec.channelId}:`, toErrorMessage(e))
      return
    }
    if (!ok) {
      // 入队前上限检查（溢出 → error + 杀组 + engine_closed，D8 不丢帧不静默）：
      // per-channel 上限 + 每连接 down 方向聚合上限（各通道 pendingDownBytes 之和）
      // 两级同判——聚合越界只关本通道（其它通道不受影响），不升连整条连接。
      const channelOverflow = ctx.pendingDownBytes + bytes > this.channelQueueMaxBytes
        || ctx.pendingDown.length + 1 > this.channelQueueMaxFrames
      const connectionOverflow = ctx.conn.downQueueBytes + bytes > this.connectionQueueMaxBytes
      if (channelOverflow || connectionOverflow) {
        const detail = connectionOverflow
          ? `engine stdin queue overflow (connection aggregate ${String(ctx.conn.downQueueBytes + bytes)} bytes)`
          : `engine stdin queue overflow (${String(ctx.pendingDownBytes + bytes)} bytes / ${String(ctx.pendingDown.length + 1)} frames queued)`
        this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.backpressureOverflow, detail, 'engine_backpressure_overflow')
        return
      }
      ctx.pendingDown.push({ line, bytes })
      ctx.pendingDownBytes += bytes
      ctx.conn.downQueueBytes += bytes
      stdin.once('drain', () => {
        this.flushPendingDown(ctx)
      })
    }
  }

  private flushPendingDown(ctx: ChannelCtx): void {
    const stdin = ctx.rec.child?.stdin
    if (stdin === undefined || stdin === null || stdin.destroyed) return
    while (ctx.pendingDown.length > 0) {
      const next = ctx.pendingDown[0]
      let ok = false
      try {
        ok = stdin.write(`${next.line}\n`)
      } catch {
        return // 引擎已死，exit 链路接管
      }
      ctx.pendingDown.shift()
      ctx.pendingDownBytes -= next.bytes
      ctx.conn.downQueueBytes = Math.max(0, ctx.conn.downQueueBytes - next.bytes)
      if (!ok) {
        stdin.once('drain', () => {
          this.flushPendingDown(ctx)
        })
        return
      }
    }
  }

  /** engine_close（D4）：有界等待引擎退出（dispose 异步落盘窗），超时组杀；只影响本通道。 */
  private handleEngineClose(conn: ConnState, frame: ControlEngineCloseFrame): void {
    const ctx = this.ctxs.get(frame.channelId)
    if (ctx === undefined || ctx.conn !== conn) {
      this.writeFrame(conn, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
        channelId: frame.channelId,
        code: CONTROL_FRAME_ERROR_CODES.unknownChannel,
        message: `unknown channel ${frame.channelId}`,
        recovery: 'The channel may have already closed.',
      })
      return
    }
    if (ctx.rec.state !== 'open') return // 幂等：重复/已关闭通道的 engine_close 忽略
    ctx.rec.state = 'closing'
    ctx.intentionalClose = true // D7：intentional close 路径（exit 日志不走「意外退出」口径）
    ctx.closeTimer = setTimeout(() => {
      ctx.closeTimer = null
      console.warn(`[subagent-control] engine_close grace (${String(this.closeGraceMs)}ms) elapsed, killing group channelId=${frame.channelId}`)
      this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, 'engine_close_grace_elapsed')
    }, this.closeGraceMs)
    // exit 事件在窗口内到达 → finalizeClosed 走真实 code/signal（engine_exit/engine_signal），
    // pid 文件随 exit 确认删除（D7）；无 exit（kill 链失败）时文件保留给启动 sweep。
  }

  // ── 子进程事件挂载 ───────────────────────────────────────────────────────────

  private attachChildWiring(ctx: ChannelCtx): void {
    const { rec, conn } = ctx
    const child = rec.child
    if (child === null) return
    const channelId = rec.channelId

    child.stdin?.on('error', (err: Error) => {
      console.debug(`[subagent-control] engine stdin error channelId=${channelId}:`, err.message)
    })

    // stdout → engine_frame（行切分；引擎帧是不透明字符串载荷）。行超限（含无换行残片
    // 超限——引擎死循环无换行输出同判）→ error + 杀组关通道（与下行同上限）。
    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      let nl = stdoutBuffer.indexOf('\n')
      while (nl !== -1 && !conn.destroyed && this.ctxs.has(channelId)) {
        const line = stdoutBuffer.slice(0, nl)
        stdoutBuffer = stdoutBuffer.slice(nl + 1)
        nl = stdoutBuffer.indexOf('\n')
        if (line.trim().length === 0) continue
        if (byteLengthOf(line) > this.maxFrameBytes) {
          this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.frameTooLarge,
            `engine stdout line exceeded ${String(this.maxFrameBytes)} bytes`, 'engine_frame_too_large')
          return
        }
        this.writeUp(conn, ctx, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: SUBAGENT_CONTROL_FRAME_KINDS.engineFrame,
          channelId,
          line,
        })
      }
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > this.maxFrameBytes && this.ctxs.has(channelId)) {
        this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.frameTooLarge,
          `engine stdout partial line exceeded ${String(this.maxFrameBytes)} bytes`, 'engine_frame_too_large')
      }
    })
    child.stdout?.on('error', (err: Error) => {
      console.warn(`[subagent-control] engine stdout stream error channelId=${channelId}:`, err.message)
    })

    // stderr → 有界尾部环（engine_closed.stderrTail，排障用）
    child.stderr?.on('data', (chunk: Buffer) => {
      ctx.stderrTail = (ctx.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.stderr?.on('error', (err: Error) => {
      console.debug(`[subagent-control] engine stderr stream error channelId=${channelId}:`, err.message)
    })

    // fd3 = raw mirror 通道（TAIJI_ENGINE_RAW_MIRROR=1 宣告；stdio[3] 在 spawn 时开启）。
    // 字节流 → SubagentMirrorHub（NDJSON 行解析 + seq 空洞→degraded + SubagentTee +
    // 磁盘镜像 pi-subagent-*.jsonl）；data 监听即进入 flowing（无需 resume），流错误不逃逸。
    const mirrorStream = child.stdio[3]
    if (mirrorStream !== null && mirrorStream !== undefined
      && typeof (mirrorStream as NodeJS.ReadableStream).on === 'function') {
      const readable = mirrorStream as NodeJS.ReadableStream
      this.mirror.openChannel(channelId, rec.rootSessionId)
      readable.on('data', (chunk: Buffer) => {
        this.mirror.ingestBytes(channelId, chunk)
      })
      readable.on('error', (err: Error) => {
        console.warn(`[subagent-control] engine mirror stream error channelId=${channelId}:`, err.message)
      })
    } else {
      // 无 fd3（spawn 形态退化/测试注入）：镜像通道缺席 = 无 live 派生视图，
      // reload 腿不受影响（显式 warn 一次）。
      console.warn(`[subagent-control] fd3 mirror stream unavailable channelId=${channelId}; live subagent stream disabled`)
    }

    child.once('error', (err: Error) => {
      // spawn 异步失败（ENOENT 族）：表现为引擎非零退出（127，command not found 惯例）
      console.error(`[subagent-control] engine process error channelId=${channelId}:`, err)
      ctx.exitSeen = true
      this.finalizeClosed(ctx, SPAWN_FAILURE_EXIT_CODE, null, SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    })

    child.once('exit', (code, signal) => {
      ctx.exitSeen = true
      if (ctx.closeTimer !== null) {
        clearTimeout(ctx.closeTimer)
        ctx.closeTimer = null
      }
      // 日志分类与组杀判据解耦：
      // - unexpectedForLog：非控制面裁决且非 engine_close（intentional）窗内退出 → 「意外退出」
      //   warn 口径（D7 两分）；
      // - shouldKillGroup：只要 exit 且未经控制面裁决（killRequested）就组杀——组杀只收割
      //   残留子进程（负 pid 对已死组长仍有效），engine_close 窗内引擎自行退出同样要
      //   兜底其孤儿（不能因日志口径而失去兜底）。
      const unexpectedForLog = !ctx.killRequested && !ctx.intentionalClose
      const shouldKillGroup = !ctx.killRequested
      const reason: SubagentControlClosedReason = ctx.closedReason
        ?? (signal !== null ? SUBAGENT_CONTROL_CLOSED_REASONS.engineSignal : SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
      this.finalizeClosed(ctx, code, signal, reason)
      if (unexpectedForLog) {
        console.warn(`[subagent-control] engine exited unexpectedly channelId=${channelId} code=${String(code)} signal=${String(signal)}; killing group`)
      } else {
        console.log(`[subagent-control] engine closed channelId=${channelId} code=${String(code)} signal=${String(signal)} reason=${reason}`)
      }
      if (shouldKillGroup) {
        killEngineGroup(rec.pid, `${unexpectedForLog ? 'unexpected-exit' : 'intentional-close-exit'} channelId=${channelId}`)
      }
    })
  }

  // ── up 方向写出（socket 背压：per-channel + 连接聚合双上限）──────────────────

  private writeUp(conn: ConnState, ctx: ChannelCtx, frame: Record<string, unknown>): void {
    const line = `${JSON.stringify(frame)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (ctx.pendingUpBytes + bytes > this.channelQueueMaxBytes
      || ctx.pendingUpFrames + 1 > this.channelQueueMaxFrames) {
      this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.backpressureOverflow,
        `socket queue overflow for channel ${ctx.rec.channelId}`, 'engine_backpressure_overflow')
      return
    }
    if (conn.upQueueBytes + bytes > this.connectionQueueMaxBytes) {
      // 连接级聚合溢出：关整条连接 + 杀该连接全部引擎组，各通道显式失败（D8）
      this.overflowConnection(conn, 'connection queue overflow (aggregate)')
      return
    }
    if (conn.upQueue.length > 0 || conn.awaitingDrain) {
      conn.upQueue.push({ channelId: ctx.rec.channelId, line, bytes })
      conn.upQueueBytes += bytes
      ctx.pendingUpFrames++
      ctx.pendingUpBytes += bytes
      return
    }
    let ok = false
    try {
      ok = conn.socket.write(line)
    } catch (e) {
      console.debug('[subagent-control] frame write failed (connection half-closed or dead):', toErrorMessage(e))
      return
    }
    if (!ok) conn.awaitingDrain = true
  }

  private flushUpQueue(conn: ConnState): void {
    conn.awaitingDrain = false
    while (conn.upQueue.length > 0 && !conn.awaitingDrain && !conn.destroyed) {
      const next = conn.upQueue[0]
      let ok = false
      try {
        ok = conn.socket.write(next.line)
      } catch {
        return // 连接已死，close 链路接管
      }
      conn.upQueue.shift()
      conn.upQueueBytes -= next.bytes
      const ctx = this.ctxs.get(next.channelId)
      if (ctx !== undefined) {
        ctx.pendingUpFrames--
        ctx.pendingUpBytes -= next.bytes
      }
      if (!ok) conn.awaitingDrain = true
    }
  }

  /** 通道级溢出裁决（D8 顺序：先 error {code}，再 engine_closed {killed_by_control}）。 */
  private writeErrorAndKill(ctx: ChannelCtx, code: string, message: string, recoveryNote: string): void {
    this.writeFrame(ctx.conn, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
      channelId: ctx.rec.channelId,
      code,
      message,
      recovery: recoveryNote,
    })
    this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, code)
  }

  private overflowConnection(conn: ConnState, reason: string): void {
    console.warn(`[subagent-control] ${reason} on ${conn.id}; killing all channels under the connection`)
    for (const rec of this.registry.listByConnection(conn.id)) {
      const ctx = this.ctxs.get(rec.channelId)
      if (ctx === undefined) continue
      this.writeFrame(conn, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
        channelId: rec.channelId,
        code: CONTROL_FRAME_ERROR_CODES.backpressureOverflow,
        message: reason,
        recovery: 'engine_backpressure_overflow (connection-level)',
      })
      this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, 'connection_overflow')
    }
    conn.socket.destroy()
  }

  /**
   * 控制面裁决通道终止：预设终局归因 + 组杀。真实 exit 事件到达后 finalizeClosed 发
   * engine_closed + 清 pid 文件（D7：确认 exit/kill 成功才删）；exit 已见过的（组长
   * 先死、组员残留的树杀路径）立即 finalize。
   */
  private terminateChannel(ctx: ChannelCtx, reason: SubagentControlClosedReason, why: string): void {
    ctx.killRequested = true
    ctx.closedReason = reason
    if (ctx.rec.state === 'open') ctx.rec.state = 'closing'
    if (ctx.closeTimer !== null) {
      clearTimeout(ctx.closeTimer)
      ctx.closeTimer = null
    }
    console.warn(`[subagent-control] kill decision action=terminate_channel channelId=${ctx.rec.channelId} `
      + `engineId=${ctx.rec.engineId} pid=${String(ctx.rec.pid)} rootSessionId=${ctx.rec.rootSessionId} `
      + `parentRecordId=${ctx.rec.parentRecordId ?? '-'} reason=${why}`)
    killEngineGroup(ctx.rec.pid, `terminate channelId=${ctx.rec.channelId} (${why})`)
    if (ctx.exitSeen) {
      this.finalizeClosed(ctx, null, null, reason)
    }
  }

  /**
   * 通道终局单点：engine_closed 恰发一次 + 递归树杀 + 台账清理。pid 文件删除只发生在
   * exit 确认后（exitSeen）——杀链失败（进程未死）时文件保留给启动 sweep。
   */
  private finalizeClosed(ctx: ChannelCtx, code: number | null, signal: string | null, reason: SubagentControlClosedReason): void {
    if (ctx.cleanedUp) return
    ctx.cleanedUp = true
    const rec = ctx.rec
    if (ctx.closeTimer !== null) {
      clearTimeout(ctx.closeTimer)
      ctx.closeTimer = null
    }
    // down 队列随通道终结释放：连接级聚合计数同步扣减（迟到 drain 不再回调本通道）。
    ctx.conn.downQueueBytes = Math.max(0, ctx.conn.downQueueBytes - ctx.pendingDownBytes)
    ctx.pendingDown = []
    ctx.pendingDownBytes = 0
    // 递归树杀（D4：父通道关闭/被杀 → 递归杀子通道引擎组；登记面 = recordId→parentRecordId）
    for (const childId of this.registry.findDescendantIds(rec.channelId)) {
      const childCtx = this.ctxs.get(childId)
      if (childCtx === undefined) continue
      this.terminateChannel(childCtx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, `parent_closed:${rec.channelId}`)
    }
    this.registry.remove(rec.channelId)
    this.ctxs.delete(rec.channelId)
    // [M3 D6] 镜像读取侧释放：channel 行泵 + 该通道全部 record 的 tee/磁盘日志
    this.mirror.disposeChannel(rec.channelId)
    if (ctx.exitSeen) {
      try {
        if (existsSync(rec.pidFile)) unlinkSync(rec.pidFile)
      } catch (e) {
        // best-effort 降级：pid 文件残留由启动 sweep 的 owner 判活清理，不阻断通道释放
        console.warn(`[subagent-control] pid file cleanup failed ${rec.pidFile}:`, e)
      }
    }
    if (!ctx.closedNotified && !ctx.conn.destroyed) {
      ctx.closedNotified = true
      this.writeFrame(ctx.conn, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClosed,
        channelId: rec.channelId,
        code,
        signal,
        reason,
        stderrTail: ctx.stderrTail.length > 0 ? ctx.stderrTail : undefined,
      })
    }
  }

  // ── 连接级生命周期 ───────────────────────────────────────────────────────────

  private writeFrame(conn: ConnState, frame: Record<string, unknown>): void {
    if (conn.destroyed) return
    const line = `${JSON.stringify(frame)}\n`
    try {
      conn.socket.write(line)
    } catch (e) {
      // best-effort 降级：对端半关闭/destroyed 流的同步写失败只留痕，通道死亡由 close 事件收尾
      console.debug('[subagent-control] frame write failed (connection dead):', toErrorMessage(e))
    }
  }

  /** 连接销毁单点：fan-out 杀该连接全部引擎组 + 占位/定时器清理（kill-on-disconnect）。 */
  private destroyConnection(conn: ConnState, why: string): void {
    if (conn.destroyed) return
    conn.destroyed = true
    clearTimeout(conn.helloTimer)
    for (const opening of conn.pendingOpens.values()) {
      clearTimeout(opening.timer)
      opening.aborted = true
    }
    conn.pendingOpens.clear()
    conn.upQueue = []
    conn.upQueueBytes = 0
    for (const rec of this.registry.listByConnection(conn.id)) {
      const ctx = this.ctxs.get(rec.channelId)
      if (ctx === undefined) continue
      this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, `connection_closed:${why}`)
      // 镜像读取侧立即释放（record 仍在台账 = exit 未达，finalizeClosed 延后——本通道
      // 的 fd3 已随 socket 死亡失去消费方，不得残留；disposeChannel 幂等）。
      this.mirror.disposeChannel(rec.channelId)
    }
    this.conns.delete(conn.id)
    if (!conn.socket.destroyed) conn.socket.destroy()
  }
}

function frameIdOf(key: string): string | number {
  const num = Number(key)
  return key !== '' && Number.isFinite(num) && String(num) === key ? num : key
}

function safeFindPi(projectRoot: string): string {
  try {
    return findPiExecutable(projectRoot)
  } catch {
    return 'pi'
  }
}

// ── 模块级单例（组合根唯一装配点）──

type ControlServerState = {
  server: SubagentControlServer
  socketPath: string
}

let state: ControlServerState | null = null

/** control server 是否已初始化并监听（control env 注入的联动开关）。 */
export function isControlServerActive(): boolean {
  return state !== null
}

/** 当前 socket 监听路径（env 注入值；未激活时 undefined）。 */
export function getActiveControlSocketPath(): string | undefined {
  return state?.socketPath
}

/** 活跃 server 句柄（滚动重启在途面组合根消费 channelCount；未激活 undefined）。 */
export function getActiveControlServer(): SubagentControlServer | undefined {
  return state?.server
}

/**
 * 计算注入主 pi 进程的 control env（D4 env × spawn 点矩阵的 main pi 行）。
 *
 * 降级语义：server 未激活 → 空对象（spread 无副作用，extension 侧
 * isControlEnvActive 判缺失回落 local transport）。ROOT_SESSION_ID 是宿主侧初值/兜底：
 * 连接归属的权威 = engine_open 帧携带的 rootSessionId（spec 显式值优先，D5），本键
 * 只在 engine_open 未显式携带时被 transport 回落消费。create 路径的 sessionId 参数
 * 可能是 spawn 时刻的 temp id（pi 就绪后 rekey 不更新已 spawn 的进程 env），因此
 * 真实根会话须由调用方经 spec 显式传递。
 */
export function getControlSpawnEnv(sessionId?: string): Record<string, string> {
  const socketPath = getActiveControlSocketPath()
  if (!isControlServerActive() || socketPath === undefined) return {}
  const env: Record<string, string> = {
    TAIJI_SUBAGENT_CONTROL_SOCKET: socketPath,
  }
  if (sessionId !== undefined && sessionId.length > 0) {
    env.TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID = sessionId
  }
  return env
}

export type InitControlServerOptions = ControlServerOptions

/**
 * 初始化 control server（socket 目录/权限/跨代扫描见 SubagentControlServer.init）。
 * dataDir 缺省 getDataDir()。
 */
export async function initControlServer(opts: InitControlServerOptions = {}): Promise<void> {
  if (state !== null) throw new Error('[subagent-control] server already initialized')
  const server = new SubagentControlServer(opts)
  await server.init()
  state = { server, socketPath: server.listeningSocketPath }
}

/** 关停：全通道组杀 + server close + 删 socket 文件。未初始化时 no-op（幂等）。 */
export async function deinitControlServer(): Promise<void> {
  const s = state
  if (s === null) return
  state = null
  await s.server.destroy()
}
