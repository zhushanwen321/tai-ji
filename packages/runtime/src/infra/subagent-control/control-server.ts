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
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { getDataDir, getPiAgentDir } from '@taiji/shared/paths'
import {
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
  ENGINE_TRANSPORT_ERROR_RECOVERY,
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
import { ChannelDownQueue } from './down-queue.js'
import { buildEngineLaunchEnv } from './engine-launch-env.js'
import { collectWindowsTreeKillTargets, trackEngineChildPid } from './engine-child-pids.js'
import { SubagentMirrorHub, type MirrorPublish } from './mirror.js'
import { ConnectionOutboundQueue } from './outbound-queue.js'
import { ensurePrivateControlDir, writeEnginePidFileAtomically } from './pid-file.js'
import type { SubagentTeeStreamState } from './subagent-tee.js'
import { killEngineGroup } from './process-kill.js'
import { sweepOrphanEnginePids, sweepStaleControlSockets } from './sweep.js'
import { findPiExecutable } from '../pi/find-pi-executable.js'
import { isPidAlive } from '../../utils/protocol-background-task.js'
import { toErrorMessage } from '../../utils/errors.js'

// ── 依赖注入（测试隔离用；生产全部走缺省推导）─────────────────────────────────

export type ControlServerOptions = {
  /** 数据目录（socket/pid 文件根；测试隔离注入，缺省 getDataDir()）。 */
  dataDir?: string
  /** pi 二进制定位锚点（dev = apps/electron；缺省 process.cwd() 的同款 cwd 约定）。 */
  projectRoot?: string
  /**
   * 引擎发现/执行器 env（组合根注入 getEngineRootsSpawnEnv 产物：TAIJI_AGENT_ENGINE_ROOTS
   * + 打包态 TAIJI_AGENT_ENGINE_NODE/ELECTRON_RUN_AS_NODE）——引擎 env 基座与嵌套发现
   * 共用。**组合根必注入**（infra 不 value import services 的方向约束，m-rt-9）；缺省
   * 空对象仅用于不消费该矩阵的隔离测试。
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
  /**
   * 树杀平台判定覆盖（测试 Windows 树杀分支；缺省 process.platform）。仅影响
   * 「引擎已死 → 逐 child pid 树杀」的分支选择，不改变 socket/spawn 平台语义。
   */
  killPlatform?: NodeJS.Platform
  /** 树杀原语注入（测试观察 Windows 分支调用；缺省 killEngineGroup）。 */
  killGroup?: (pid: number | null | undefined, context: string) => void
}

/** 构造期解析出的时间窗/上限（ControlServerOptions 缺省注入的集中落点）。 */
type ResolvedControlLimits = {
  helloTimeoutMs: number
  openTimeoutMs: number
  closeGraceMs: number
  maxFrameBytes: number
  maxChannelsPerConnection: number
  channelQueueMaxBytes: number
  channelQueueMaxFrames: number
  connectionQueueMaxBytes: number
}

/** 构造期解析出的路径锚点（dataDir / pi 定位）。 */
type ResolvedControlPaths = {
  dataDir: string
  projectRoot: string
  piDir: string | undefined
  piAgentDir: string
}

function resolveControlLimits(opts: ControlServerOptions): ResolvedControlLimits {
  return {
    helloTimeoutMs: opts.helloTimeoutMs ?? CONTROL_HELLO_TIMEOUT_MS,
    openTimeoutMs: opts.openTimeoutMs ?? ENGINE_OPEN_TIMEOUT_MS,
    closeGraceMs: opts.closeGraceMs ?? ENGINE_CLOSE_GRACE_MS,
    maxFrameBytes: opts.maxFrameBytes ?? CONTROL_MAX_FRAME_BYTES,
    maxChannelsPerConnection: opts.maxChannelsPerConnection ?? MAX_CHANNELS_PER_CONNECTION,
    channelQueueMaxBytes: opts.channelQueueMaxBytes ?? CHANNEL_QUEUE_MAX_BYTES,
    channelQueueMaxFrames: opts.channelQueueMaxFrames ?? CHANNEL_QUEUE_MAX_FRAMES,
    connectionQueueMaxBytes: opts.connectionQueueMaxBytes ?? CONNECTION_QUEUE_MAX_BYTES,
  }
}

function resolveControlPaths(opts: ControlServerOptions): ResolvedControlPaths {
  const dataDir = opts.dataDir ?? getDataDir()
  const projectRoot = opts.projectRoot ?? process.cwd()
  const piCommand = opts.piCommand ?? safeFindPi(projectRoot)
  return {
    dataDir,
    projectRoot,
    piDir: piCommand !== 'pi' ? dirname(piCommand) : undefined,
    piAgentDir: opts.piAgentDir ?? getPiAgentDir(),
  }
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
  /** 流式 UTF-8 解码器（m-rt-1：多字节字符跨 chunk 边界不得被逐段 toString 撕裂）。 */
  decoder: StringDecoder
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
  /**
   * up 方向待写队列（socket 背压）：engine_frame 与控制帧共用同一 FIFO（m-rt-2）——
   * 控制帧不再绕过排队，背压期 engine_closed 不会越过已入队的 engine_frame。
   */
  out: ConnectionOutboundQueue
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
  /** down 方向（C→R engine_frame → 引擎 stdin）待写队列与背压状态。 */
  down: ChannelDownQueue
  pendingUpFrames: number
  pendingUpBytes: number
  stderrTail: string
  /**
   * [D7 Windows 死亡链] 引擎反向通道上报的子进程 pid 集合（host/childSpawned /
   * host/childStateChanged 信封解析；仅 Windows 树杀兜底消费，其余帧保持不透明）。
   */
  pidSet: Set<number>
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
 * 连接级溢出的排空上界（m-rt-2）：先 flush error 再 end；对端持续不读时只能显式关闭。
 * 这是失败动作的回收层有界兜底（ADR-0122 回收层允许默认有界），不是对账补偿——
 * 正常路径由 drain 事件驱动，定时器只在「客户端不消费」这一故障形态下兜底。
 */
const OVERFLOW_FLUSH_TIMEOUT_MS = 1_000

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
  private readonly killPlatform: NodeJS.Platform
  private readonly killGroup: (pid: number | null | undefined, context: string) => void

  constructor(private readonly opts: ControlServerOptions) {
    const paths = resolveControlPaths(opts)
    const limits = resolveControlLimits(opts)
    this.dataDir = paths.dataDir
    this.projectRoot = paths.projectRoot
    this.engineNodeEnv = opts.engineNodeEnv ?? {}
    this.runtimeEnv = opts.runtimeEnv ?? { ...process.env }
    this.helloTimeoutMs = limits.helloTimeoutMs
    this.openTimeoutMs = limits.openTimeoutMs
    this.closeGraceMs = limits.closeGraceMs
    this.maxFrameBytes = limits.maxFrameBytes
    this.maxChannelsPerConnection = limits.maxChannelsPerConnection
    this.channelQueueMaxBytes = limits.channelQueueMaxBytes
    this.channelQueueMaxFrames = limits.channelQueueMaxFrames
    this.connectionQueueMaxBytes = limits.connectionQueueMaxBytes
    this.resolveLaunch = opts.resolveLaunch ?? resolveEngineNodeLaunch
    this.execPath = opts.execPath
    this.isElectronHost = opts.isElectronHost
    this.killPlatform = opts.killPlatform ?? process.platform
    this.killGroup = opts.killGroup ?? killEngineGroup
    this.piDir = paths.piDir
    this.piAgentDir = paths.piAgentDir
    this.mirror = new SubagentMirrorHub(
      opts.publish !== undefined ? { publish: opts.publish } : {},
    )
  }

  /** 在册通道数 + opening 占位（滚动重启在途面组合根消费；口径与 D8 上限一致）。 */
  get channelCount(): number {
    let openings = 0
    for (const conn of this.conns.values()) openings += conn.pendingOpens.size
    return this.registry.channelCount + openings
  }

  get listeningSocketPath(): string {
    return this.socketPath
  }

  /** 测试钩子：通道台账只读（生产无调用方）。 */
  getChannelForTest(channelId: string): EngineChannelRecord | undefined {
    return this.registry.get(channelId)
  }

  /** 测试钩子：活动连接数（溢出 flush 窗口 = 连接尚未销毁，生产无调用方）。 */
  getConnectionCountForTest(): number {
    return this.conns.size
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
    // 0700 是 socket 权限边界的前提：mkdirSync 的 mode 只对新建目录生效，存量 run/
    // （旧 relay 时代默认 0755）必须显式收敛（planner③）。权限收敛失败按 fail-fast
    // 处理——目录权限不满足时不应继续监听（D4 安全边界，早发现优于降级）。
    this.ensurePrivateControlDirs()

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

  /**
   * 创建目录并强制收敛为 0700（含已存在目录）。win32 无 POSIX 权限位（named pipe 用
   * 默认 ACL，设计允许显式登记），跳过 chmod。失败 fail-fast（权限面是认证边界）。
   */
  private ensurePrivateControlDirs(): void {
    ensurePrivateControlDir(getControlRunDir(this.dataDir))
    ensurePrivateControlDir(getControlEnginesDir(this.dataDir))
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
      decoder: new StringDecoder('utf8'),
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
      out: new ConnectionOutboundQueue(socket, OVERFLOW_FLUSH_TIMEOUT_MS),
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
      conn.out.flush()
    })
    socket.once('close', () => {
      // kill-on-disconnect（D4/D7）：主 pi/extension 死亡 → 该连接全部引擎组杀
      this.destroyConnection(conn, 'socket_closed')
    })
  }

  private ingestChunk(conn: ConnState, chunk: Buffer): void {
    if (conn.destroyed) return
    // 流式解码（m-rt-1）：StringDecoder 缓存被 chunk 边界截断的多字节序列，下个 chunk
    // 补齐后才吐出完整字符——逐 chunk `toString('utf8')` 会把汉字/emoji 静默替换为 U+FFFD。
    this.ingestText(conn, conn.decoder.write(chunk))
  }

  private ingestText(conn: ConnState, text: string): void {
    if (conn.destroyed) return
    if (conn.discardingUntilNewline) {
      // 超长帧丢弃态（帧界未达即超限，流已失同步）：丢弃直到下一帧界，其后照常解析
      const nl = text.indexOf('\n')
      if (nl === -1) return
      conn.discardingUntilNewline = false
      this.ingestText(conn, text.slice(nl + 1))
      return
    }
    conn.buffer += text
    conn.bufferBytes += byteLengthOf(text)
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
    // 连接通道数上限（聚合防线；复用 engine_open_failed 帧，不新增帧类型）。计数必须
    // 含 opening 占位（planner②）：并发 engine_open 在首批 spawn 完成前都只占
    // pendingOpens、registry 尚为空——只数在册通道会让并发 open 绕过上限。
    if (this.connectionChannelCount(conn) >= this.maxChannelsPerConnection) {
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

  private connectionChannelCount(conn: ConnState): number {
    return this.registry.listByConnection(conn.id).length + conn.pendingOpens.size
  }

  private async spawnForOpening(conn: ConnState, opening: PendingOpen): Promise<void> {
    const spec = opening.spec
    const launch = await this.resolveLaunchOrFail(conn, opening)
    if (launch === null || conn.destroyed || opening.aborted) return // 迟到解析结果：无进程可杀，占位已清

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

    const child = this.spawnChildOrFail(conn, opening, launch, env)
    if (child === null) return
    if (opening.aborted || conn.destroyed) {
      // spawn 与超时/断连的竞态：刚拿到的进程立即组杀，不回 engine_opened（迟到结果丢弃）
      this.killGroup(child.pid, `late-spawn ${spec.engineId}`)
      return
    }

    // spawn 完成前不变量复检（planner②）：并发 open 的占位可能在 resolve/spawn
    // 期间继续增长；超限则杀掉刚拿到的进程，不登记、不回 engine_opened。
    if (this.connectionChannelCount(conn) > this.maxChannelsPerConnection) {
      this.rejectOverLimitOpening(conn, opening, child)
      return
    }

    this.openChannel(conn, opening, child)
  }

  /** resolveLaunch 失败面：spawn 语义错误码透传 + 占位失败回包（迟到结果按 failOpening 静默）。 */
  private async resolveLaunchOrFail(conn: ConnState, opening: PendingOpen): Promise<EngineNodeLaunch | null> {
    const spec = opening.spec
    try {
      return await this.resolveLaunch({
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
      return null
    }
  }

  /** spawn 同步失败 → engine_open_failed（异步 spawn error 由 attachChildWiring 的 127 口径承接）。 */
  private spawnChildOrFail(
    conn: ConnState,
    opening: PendingOpen,
    launch: EngineNodeLaunch,
    env: Record<string, string>,
  ): ChildProcess | null {
    const spec = opening.spec
    try {
      // POSIX detached:true（引擎 = 进程组长，组杀覆盖引擎 + 其 pi 子进程）；
      // Windows detached:false + windowsHide:true（树杀走 taskkill /T，D7）。
      // stdio[3] = raw mirror 通道（TAIJI_ENGINE_RAW_MIRROR=1 宣告；读取侧由
      // SubagentMirrorHub 接管——见 attachChildWiring 的 fd3 接线）。
      return spawn(launch.command, launch.args, {
        cwd: spec.cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      this.failOpening(conn, opening, CONTROL_FRAME_ERROR_CODES.spawnFailed, toErrorMessage(e),
        'Check the engine executor availability; the runtime re-probes after restart.')
      return null
    }
  }

  /** spawn 后并发复检超限：杀刚拿到的进程 + 回 engine_open_failed（与 handleEngineOpen 同文案）。 */
  private rejectOverLimitOpening(conn: ConnState, opening: PendingOpen, child: ChildProcess): void {
    clearTimeout(opening.timer)
    conn.pendingOpens.delete(opening.key)
    this.killGroup(child.pid, `channel-limit ${opening.spec.engineId}`)
    this.replyOpenFailed(conn, frameIdOf(opening.key), CONTROL_FRAME_ERROR_CODES.channelLimit,
      `connection channel limit (${String(this.maxChannelsPerConnection)}) reached`,
      'Close idle engine channels before opening more.')
  }

  /** 登记通道 + pid 文件（D7 形状：runtimePid/instanceId/hostKind 供 sweep owner 判定），
   * 回 engine_opened 并挂子进程事件（spawn 已赢下竞态）。 */
  private openChannel(conn: ConnState, opening: PendingOpen, child: ChildProcess): void {
    const spec = opening.spec
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
    const ctx = this.createChannelCtx(conn, rec, channelId)
    this.ctxs.set(channelId, ctx)
    this.writePidFileQuietly(pidFile, spec, child)

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

  /** 通道运行期结构装配（down 队列的溢出回调闭包引用构造中的 ctx，队列溢出只会异步发生）。 */
  private createChannelCtx(conn: ConnState, rec: EngineChannelRecord, channelId: string): ChannelCtx {
    const ctx: ChannelCtx = {
      rec,
      conn,
      down: new ChannelDownQueue({
        channelId,
        getStdin: () => rec.child?.stdin,
        channelMaxBytes: this.channelQueueMaxBytes,
        channelMaxFrames: this.channelQueueMaxFrames,
        getConnectionBytes: () => conn.downQueueBytes,
        setConnectionBytes: (bytes) => { conn.downQueueBytes = bytes },
        connectionMaxBytes: this.connectionQueueMaxBytes,
        onOverflow: (detail, connectionLevel) => {
          this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.backpressureOverflow,
            connectionLevel ? `${detail} (connection-level)` : detail,
            ENGINE_TRANSPORT_ERROR_RECOVERY.engine_backpressure_overflow)
        },
      }),
      pendingUpFrames: 0,
      pendingUpBytes: 0,
      stderrTail: '',
      pidSet: new Set(),
      closeTimer: null,
      killRequested: false,
      intentionalClose: false,
      closedReason: null,
      closedNotified: false,
      exitSeen: false,
      cleanedUp: false,
    }
    return ctx
  }

  /** pid 文件是重启 sweep 依据，写失败不阻塞（当前 runtime 在管，退出走清理）。 */
  private writePidFileQuietly(pidFile: string, spec: EngineLaunchSpecWire, child: ChildProcess): void {
    try {
      writeEnginePidFileAtomically(pidFile, {
        pid: child.pid ?? null,
        spawnedAt: Date.now(),
        engineId: spec.engineId,
        rootSessionId: spec.rootSessionId,
        parentRecordId: spec.parentRecordId ?? null,
        depth: spec.depth ?? null,
        runtimePid: process.pid,
        instanceId: String(process.pid),
        hostKind: 'runtime-sidecar',
      })
    } catch (e) {
      // pid 文件是重启 sweep 依据，写失败不阻塞（当前 runtime 在管，退出走清理）
      console.warn(`[subagent-control] pid file write failed ${pidFile}:`, e)
    }
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
    // 迟到失败不二次回包（m-rt-8）：超时/断连已裁决并删除占位后，resolveLaunch 才
    // reject 的路径不得再发一帧 engine_open_failed（客户端 pending 已清，重复帧只会
    // 污染协议面与后续「单应答」断言）。
    if (opening.aborted || !conn.pendingOpens.has(opening.key)) return
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
    ctx.down.push(frame.line)
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

    // stdout → engine_frame（行切分；引擎帧是不透明字符串载荷）。流式解码（m-rt-1）
    // 保证跨 chunk 的中文/emoji 不被逐段 toString 撕成 U+FFFD。
    let stdoutBuffer = ''
    const stdoutDecoder = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(chunk)
      let nl = stdoutBuffer.indexOf('\n')
      while (nl !== -1 && !conn.destroyed && this.ctxs.has(channelId)) {
        const line = stdoutBuffer.slice(0, nl)
        stdoutBuffer = stdoutBuffer.slice(nl + 1)
        nl = stdoutBuffer.indexOf('\n')
        if (line.trim().length === 0) continue
        // [D7 Windows] 只读解析两个反向通道信封（其余帧保持不透明）：维护 child pid
        // 集合供「引擎已死 → 逐 pid 树杀」兜底使用（m-rt-2/planner①）。
        this.trackEngineChildPid(ctx, line)
        if (byteLengthOf(line) > this.maxFrameBytes) {
          this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.frameTooLarge,
            `engine stdout line exceeded ${String(this.maxFrameBytes)} bytes`,
            ENGINE_TRANSPORT_ERROR_RECOVERY.engine_frame_too_large)
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
          `engine stdout partial line exceeded ${String(this.maxFrameBytes)} bytes`,
          ENGINE_TRANSPORT_ERROR_RECOVERY.engine_frame_too_large)
      }
    })
    child.stdout?.on('error', (err: Error) => {
      console.warn(`[subagent-control] engine stdout stream error channelId=${channelId}:`, err.message)
    })

    // stderr → 有界尾部环（engine_closed.stderrTail，排障用）。流式解码同 stdout。
    const stderrDecoder = new StringDecoder('utf8')
    child.stderr?.on('data', (chunk: Buffer) => {
      ctx.stderrTail = (ctx.stderrTail + stderrDecoder.write(chunk)).slice(-STDERR_TAIL_CHARS)
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
        this.killChannelGroup(ctx, `${unexpectedForLog ? 'unexpected-exit' : 'intentional-close-exit'} channelId=${channelId}`)
      }
    })
  }

  /**
   * 引擎反向通道的两个 pid 信封解析（设计 D7）：实现见 engine-child-pids（本类只负责
   * 在 stdout 行泵中调用）。
   */
  private trackEngineChildPid(ctx: ChannelCtx, line: string): void {
    trackEngineChildPid(ctx.pidSet, line)
  }

  /**
   * 通道组杀（D7）：POSIX 走负 pid 组杀（对已死组长仍有效）；Windows 引擎存活时按
   * 引擎 pid 树杀，引擎已死（无树可枚举）时回退到反向通道登记的 child pid 集合逐个
   * 树杀——否则存活 pi 子进程成为孤儿（m-rt-2/planner①）。
   */
  private killChannelGroup(ctx: ChannelCtx, context: string): void {
    if (this.killPlatform !== 'win32') {
      this.killGroup(ctx.rec.pid, context)
      return
    }
    for (const pid of collectWindowsTreeKillTargets(ctx.rec.pid, ctx.pidSet, isPidAlive)) {
      this.killGroup(pid, `${context} tree pid=${String(pid)}`)
    }
  }

  // ── up 方向写出（socket 背压：per-channel + 连接聚合双上限）──────────────────

  private writeUp(conn: ConnState, ctx: ChannelCtx, frame: Record<string, unknown>): void {
    if (conn.out.hasOverflowed) return // 连接级溢出已裁决：数据面帧不再入队（控制帧仍按 FIFO 收尾）
    const line = `${JSON.stringify(frame)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (ctx.pendingUpBytes + bytes > this.channelQueueMaxBytes
      || ctx.pendingUpFrames + 1 > this.channelQueueMaxFrames) {
      this.writeErrorAndKill(ctx, CONTROL_FRAME_ERROR_CODES.backpressureOverflow,
        `socket queue overflow for channel ${ctx.rec.channelId}`,
        ENGINE_TRANSPORT_ERROR_RECOVERY.engine_backpressure_overflow)
      return
    }
    if (conn.out.pendingBytes + bytes > this.connectionQueueMaxBytes) {
      // 连接级聚合溢出：关整条连接 + 杀该连接全部引擎组，各通道显式失败（D8）
      this.overflowConnection(conn, 'connection queue overflow (aggregate)')
      return
    }
    this.enqueueOutbound(conn, ctx, line, bytes)
  }

  /**
   * 统一出站入队（m-rt-2）：数据帧与控制帧共用同一 per-connection FIFO。per-channel
   * 计数只在真正入队时增加（直接写出的帧已被 Node 受理，不得重写——R3-N1）。
   */
  private enqueueOutbound(conn: ConnState, ctx: ChannelCtx | null, line: string, bytes: number): void {
    if (conn.destroyed) return
    const onDequeued = ctx === null
      ? undefined
      : (): void => {
        ctx.pendingUpFrames -= 1
        ctx.pendingUpBytes -= bytes
      }
    const result = conn.out.write(onDequeued === undefined ? { line, bytes } : { line, bytes, onDequeued })
    if (result === 'queued' && ctx !== null) {
      ctx.pendingUpFrames += 1
      ctx.pendingUpBytes += bytes
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
    if (conn.out.hasOverflowed) return
    conn.out.markOverflowed()
    console.warn(`[subagent-control] ${reason} on ${conn.id}; killing all channels under the connection`)
    const recovery = `${ENGINE_TRANSPORT_ERROR_RECOVERY.engine_backpressure_overflow} `
      + 'Connection-level overflow: all engine channels on this connection were terminated.'
    for (const rec of this.registry.listByConnection(conn.id)) {
      const ctx = this.ctxs.get(rec.channelId)
      if (ctx === undefined) continue
      this.writeFrame(conn, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
        channelId: rec.channelId,
        code: CONTROL_FRAME_ERROR_CODES.backpressureOverflow,
        message: reason,
        recovery,
      })
      this.terminateChannel(ctx, SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl, 'connection_overflow')
    }
    // 先 flush error 再 end（m-rt-2）：不再写完即 destroy（排队中的控制帧会丢失）。
    conn.out.beginCloseAfterFlush()
  }

  /**
   * 控制面裁决通道终止：预设终局归因 + 组杀。真实 exit 事件到达后 finalizeClosed 发
   * engine_closed + 清 pid 文件（D7：确认 exit/kill 成功才删）；exit 已见过的（组长
   * 先死、组员残留的树杀路径）立即 finalize。
   */
  private terminateChannel(ctx: ChannelCtx, reason: SubagentControlClosedReason, why: string): void {
    if (ctx.killRequested || ctx.cleanedUp) return // 幂等：连接级 fan-out 与通道级溢出可能重叠裁决
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
    this.killChannelGroup(ctx, `terminate channelId=${ctx.rec.channelId} (${why})`)
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
    ctx.down.dispose()
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
    const bytes = Buffer.byteLength(line, 'utf8')
    const channelId = typeof frame.channelId === 'string' ? frame.channelId : null
    const ctx = channelId !== null ? this.ctxs.get(channelId) ?? null : null
    // 控制帧同样计入连接级聚合上限（防「客户端不读 → 错误帧无界增长」）；溢出后
    // 不再复检（overflowConnection 自身的 error 帧必须能入队收尾）。
    if (!conn.out.hasOverflowed && conn.out.pendingBytes + bytes > this.connectionQueueMaxBytes) {
      this.overflowConnection(conn, 'connection queue overflow (control frames)')
      if (conn.destroyed) return
    }
    this.enqueueOutbound(conn, ctx, line, bytes)
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
    conn.out.dispose()
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
