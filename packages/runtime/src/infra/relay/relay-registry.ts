/**
 * relay 子进程注册表。
 *
 * 职责：socket 连接 → 握手帧校验（版本协商 + 归属校验）→ spawn 真实 pi（argv/env/cwd
 * 全从握手帧，env 剥离 TAIJI_SUBAGENT_RELAY_* 防孙进程嵌套误导）→ 双向字节泵（down 帧 →
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
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ServerMessage } from '@taiji/shared'
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
} from '@zhushanwen/subagent-core/relay-env'
import {
  RELAY_FRAME_DIRS,
  RELAY_FRAME_KINDS,
  RELAY_REJECT_REASONS,
  type RelayRejectReason,
} from '@zhushanwen/subagent-engine-sdk'
import { killPiProcess } from '@zhushanwen/pi-rpc'
import { findPiExecutable } from '../pi/find-pi-executable.js'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { createPiRelayLog, type PiSessionLog } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'
import { isPidAlive } from '../../utils/protocol-background-task.js'
import { RelayTee } from './relay-tee.js'
import { getRelayChildrenDir, getRelayPidFilePath } from './relay-paths.js'

/** 断连即杀的优雅退出窗口（SIGTERM 后等这么久再 SIGKILL，设计 §4.2）。 */
export const RELAY_KILL_GRACE_MS = 3_000

/**
 * 孤儿分级收割（2026-09-24 事故修复）：孤儿判定语义保持（无管理者），处置按活跃度
 * 分级——tee 镜像最近写入超过 {@link ORPHAN_IDLE_REAP_MS}（静默，纯资源占用）立即
 * 收割（现状行为）；仍在产出的孤儿登记 pending 延迟收割（重启风暴期「sweep 杀 →
 * crash-recovery 重派 → 再 sweep 杀」的振荡止血；ADR-0047：静默 ≠ 卡死，活跃产出
 * 不得判死），延迟有硬上限防无限活。量级为任务级（分钟），与控制面秒级 grace 不可
 * 互相挪用（超时默认按对象粒度校准）。
 */
/** 量级换算基准：1 秒 / 1 分钟的毫秒数（孤儿处置族的阈值定义与日志换算共用）。 */
const SECOND_MS = 1_000
const MINUTE_MS = 60_000
/** 孤儿静默判定阈值（分钟）：tee 镜像最近写入超过该时长视为纯资源占用，立即收割。 */
const ORPHAN_IDLE_REAP_MINUTES = 5
const ORPHAN_IDLE_REAP_MS = ORPHAN_IDLE_REAP_MINUTES * MINUTE_MS
/** pending 孤儿复查间隔。 */
const ORPHAN_PENDING_RECHECK_MS = 60_000
/** pending 硬上限（分钟）：活跃孤儿最多延迟这么多再收割（防 tee 持续产出但恢复链已死透）。 */
const ORPHAN_PENDING_MAX_MINUTES = 30
const ORPHAN_PENDING_MAX_MS = ORPHAN_PENDING_MAX_MINUTES * MINUTE_MS
/** 握手超时：连接建立后等第一帧的上限（防半开连接占资源）。 */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** spawn 失败时代理看到的退出码（127 = command not found 惯例，走子进程非零退出语义）。 */
const SPAWN_FAILURE_EXIT_CODE = 127
/** pid 复用判定的时钟容差（ps lstart 秒级精度 + 调度延迟）。 */
const PID_REUSE_TOLERANCE_MS = 2_000
/** 畸形帧日志预览的头部截取长度（足以辨识帧形态，不整行落日志防垃圾刷屏）。 */
const MALFORMED_FRAME_HEAD_PREVIEW_CHARS = 120
/** record id 清洗后参与 tee 文件名匹配的长度上限（防异常长 id 撑爆文件名比对）。 */
const RECORD_ID_MAX_CHARS = 64

// ── 协议帧（runtime 侧视角；握手/数据帧 schema 见设计 §3.1）─────────────

interface RelayHandshakeFrame {
  v: number
  kind: typeof RELAY_FRAME_KINDS.handshake
  mainSessionId: string
  recordId: string
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
}

interface RelayDataFrame {
  v: number
  kind: typeof RELAY_FRAME_KINDS.data
  dir: typeof RELAY_FRAME_DIRS.down
  b64: string
}

/** goodbye 预告帧（代理被宿主终止前发出，见 RELAY_FRAME_KINDS.goodbye 注释）。 */
interface RelayGoodbyeFrame {
  v: number
  kind: typeof RELAY_FRAME_KINDS.goodbye
}

type InboundFrame = RelayHandshakeFrame | RelayDataFrame | RelayGoodbyeFrame

// reject 帧理由词表已收编 SDK relay-frames（RELAY_REJECT_REASONS 单源）；re-export
// 维持本文件既有导出面。E-1 代理对 reason='version' 以退出码 10 退出。
export type { RelayRejectReason }

interface RegisteredEntry {
  conn: Socket
  mainSessionId: string
  recordId: string
  child: ChildProcess
  pidFile: string
  tee: RelayTee
  /** up 方向 stdout 字节镜像（pi-relay-<date>-<recordId>.jsonl，架构约定「pi 卡死唯一证据」）。 */
  log: PiSessionLog
  /** 数据阶段畸形帧丢弃计数（显形面：child exited 日志追加；首帧 warn 后静默累计）。 */
  droppedDataFrames: number
  /** 数据阶段畸形帧的连接级首帧告警标记（去重防刷屏）。 */
  warnedMalformedFrame: boolean
  /**
   * goodbye 帧已收到（代理被宿主终止前的预告）：后续 socket close 判定为正常收割
   * （info 级日志），而非异常断连（warn 级 kill-on-disconnect）。kill 行为不变。
   */
  goodbyeReceived: boolean
  /**
   * destroyAll 已接管本条目的杀链：close 事件异步于 destroyAll 的 conn.destroy()
   * （kill await 让出事件循环刻度，close 触发时条目仍在册），无此标记时 close
   * handler 会对同一 child 重复跑杀链（重复 kill decision 日志 + inflightKills 双登记）。
   */
  teardownStarted: boolean
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
 *   `void killRelayChild(...)` fire-and-forget 无 catch。注：killPiProcess 内三处 kill
 *   现已收口 safeKill 吞错（kill 尽力而为语义），promise 结构性必 resolve，本
 *   .catch 从「必要兜底」降级为纵深防御（防未来 kill-chain 新增异步抛出路径），
 *   reject 内容降级 debug 留痕。
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
  return killPiProcess(child, { graceMs, unrefTimers: true }).catch((e) => {
    // kill 抛错说明进程已死（exit 事件已/将至）；杀链契约是必 resolve（见头注），
    // 吞错防 close 路径 unhandled rejection，debug 留痕使该纵深兜底可观测
    console.debug('[relay] kill chain rejected (must-resolve contract, safe to ignore):', toErrorMessage(e))
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
 * 归属校验第二段（§4.1）：env 必含 TAIJI_SUBAGENT_RELAY_*（缺失拒绝，防任意本地进程
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
 * env 原样使用（身份归属键与引擎 extras 注入键全在握手帧），剥离 relay env——
 * 孙进程经 pi-invocation 判定三 env 缺失回落直连，防嵌套 relay 时旧值误导。
 *
 * B8 出站接线（docs/architecture/env-propagation-boundary.md §5-U4 / D4）：基座维持帧 env
 * 全量拷贝拓扑（pass-all 前缀 '' 不做白名单过滤——帧内的非白名单键如 PI_WORKFLOW_SCHEMA
 * （引擎自 wire task.schema 就地派生注入）按入站白名单过滤即丢语义），五键剥离迁为
 * extras undefined=显式删除语义；deny 清单由构建器末步兜底，「叠加 deny 过滤后不多
 * 不少」。导出仅供单测直验（handleConnection 全链路已在 relay-registry.test.ts 覆盖）。
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
  /**
   * 在途杀链登记（kill-on-disconnect 的 fire-and-forget 修正面）：close 路径的
   * `void killRelayChild(...)` 不等结果——runtime 若在杀链 grace 期内退出，unref
   * timer 随进程消亡，SIGTERM 已发但未死透的 child（pi 优雅退出实测可达 15s）无人
   * 补 SIGKILL，成为下一轮 runtime orphan sweep 的收割对象（2026-09-24 事故 r6 双杀
   * 形态）。destroyAll 在清完在册条目后等待此集合清空，把关停窗口内的全部杀链
   * 都收到 SIGKILL 发出承诺再放行 runtime 退出。
   */
  private readonly inflightKills = new Set<Promise<void>>()
  /** pending 孤儿复查 timer（armOrphanRecheck 武装；destroyAll 清除）。 */
  private orphanRecheckTimer: NodeJS.Timeout | null = null
  /** 复查 timer 的 sweep 重入守卫。 */
  private orphanSweepInFlight = false
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
        if (frame === null || frame.kind !== RELAY_FRAME_KINDS.handshake) {
          writeFrame(conn, { kind: RELAY_FRAME_KINDS.reject, reason: RELAY_REJECT_REASONS.malformed, supported: [RELAY_PROTOCOL_VERSION] })
          endConn(conn)
          return
        }
        this.registerHandshake(conn, frame)
        return
      }
      // 握手后：消费 down 方向数据帧与 goodbye 预告帧，其余忽略。
      // dir==='down' / b64:string 的运行时不变量由 tryParseFrame 的 data 帧形状守卫
      // 单点定义——畸形帧在解析层已按 null 丢弃，此处不再重复编码该判据；
      // null（畸形帧）按连接显形（首帧 warn + 计数，见 noteDroppedDataFrame）
      const frame = this.tryParseFrame(line)
      if (frame !== null && frame.kind === RELAY_FRAME_KINDS.goodbye) {
        const entry = this.entries.get(conn)
        if (entry !== undefined && !entry.goodbyeReceived) {
          entry.goodbyeReceived = true
          console.log(`[relay] goodbye received recordId=${entry.recordId} (host-side normal teardown; subsequent close reaps, not a failure)`)
        }
        return
      }
      if (frame !== null && frame.kind === RELAY_FRAME_KINDS.data) {
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
      } else if (frame === null) {
        this.noteDroppedDataFrame(conn, line)
      }
    })
  }

  /**
   * 数据阶段畸形帧的显形入口（握手阶段的 malformed 走 reject 帧显形，与此分阶段）：
   * 首帧 warn（连接级去重防刷屏，含对端信息与「连接可能假活」提示），后续同连接
   * 畸形帧只累计 droppedDataFrames（child exited 日志追加减帧计数）。计数与告警
   * 依赖注册表条目在册——child exit 清理后的残帧丢弃无诊断价值，不计数。
   */
  private noteDroppedDataFrame(conn: Socket, line: string): void {
    const entry = this.entries.get(conn)
    if (!entry) return
    entry.droppedDataFrames++
    if (entry.warnedMalformedFrame) return
    entry.warnedMalformedFrame = true
    console.warn(
      `[relay] malformed data frame dropped recordId=${entry.recordId} ` +
      `peer=${String(conn.remoteAddress ?? 'unknown')}:${String(conn.remotePort ?? 'unknown')} ` +
      `len=${line.length} head=${JSON.stringify(line.slice(0, MALFORMED_FRAME_HEAD_PREVIEW_CHARS))} ` +
      '(data-channel frame loss; connection may look alive while broken — further drops counted in droppedDataFrames)',
    )
  }

  private tryParseFrame(line: string): InboundFrame | null {
    try {
      const parsed = JSON.parse(line) as InboundFrame
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.kind !== 'string') return null
      // data 帧形状守卫：b64 缺失/非 string 时 Buffer.from 抛 TypeError，且本调用点在
      // readline 回调内无捕获——畸形帧按 malformed 丢弃（数据阶段仅丢帧不断连，同连接
      // 后续帧仍有效；与握手首帧 malformed 的 reject+断连语义按阶段区分）
      if (parsed.kind === RELAY_FRAME_KINDS.data && (parsed.dir !== RELAY_FRAME_DIRS.down || typeof parsed.b64 !== 'string')) return null
      return parsed
    } catch {
      return null
    }
  }

  /** 握手校验（§3.1 版本协商 + §4.1 归属校验）+ 注册 + spawn + 子进程事件挂载。 */
  private registerHandshake(conn: Socket, frame: RelayHandshakeFrame): void {
    // 版本锁定（严等而非只拒更新版）：协议两侧（relay.mjs 与 registry）同仓同发、
    // verifiedWith 版本门禁钉死同源——跨版本静默容忍只会把方言漂移推迟到数据阶段
    // 解析爆炸；严等让漂移在握手即显式失败（代理退出码 10）。
    if (typeof frame.v !== 'number' || frame.v !== RELAY_PROTOCOL_VERSION) {
      writeFrame(conn, { kind: RELAY_FRAME_KINDS.reject, reason: RELAY_REJECT_REASONS.version, supported: [RELAY_PROTOCOL_VERSION] })
      endConn(conn)
      console.warn(`[relay] handshake rejected: version v=${String(frame.v)} != supported ${RELAY_PROTOCOL_VERSION}`)
      return
    }
    // 归属校验：字段形状 + env 归属键（防任意本地进程挂载借道 spawn，见两谓词注释）
    if (!hasValidHandshakeFrameShape(frame) || !isHandshakeEnvOwnershipValid(frame)) {
      writeFrame(conn, { kind: RELAY_FRAME_KINDS.reject, reason: RELAY_REJECT_REASONS.identity, supported: [RELAY_PROTOCOL_VERSION] })
      endConn(conn)
      console.warn('[relay] handshake rejected: identity/env validation failed')
      return
    }
    // 同 recordId 重复注册：旧条目可能还活着（异常重连），拒绝新连接防双代理同 id
    if (this.recordIdToConn.has(frame.recordId)) {
      writeFrame(conn, { kind: RELAY_FRAME_KINDS.reject, reason: RELAY_REJECT_REASONS.duplicate, supported: [RELAY_PROTOCOL_VERSION] })
      endConn(conn)
      console.warn(`[relay] handshake rejected: duplicate recordId=${frame.recordId}`)
      return
    }

    const child = this.trySpawnRelayChild(conn, frame)
    if (child === undefined) return

    const pidFile = getRelayPidFilePath(frame.recordId, this.opts.dataDir)
    // 接管清理（pid 覆盖泄漏归置）：同 recordId 重派（crash-recovery 等）会覆盖旧 pid
    // 文件，旧进程自此失去台账登记——无人会再杀它，成为无主泄漏。覆盖前读旧登记，
    // 旧 pid 活且异于新 pid → 先收割旧进程（与 orphan sweep 同款信号链）。
    this.reapSupersededPidIfAlive(pidFile, frame.recordId, child.pid ?? null)
    const tee = new RelayTee({
      mainSessionId: frame.mainSessionId,
      recordId: frame.recordId,
      publish: this.opts.publish,
    })
    // stdout 磁盘镜像（架构约定：pi stdout 落盘是卡死时唯一证据，relay 子进程同款覆盖）。
    // logger 未初始化（如单测）时是 no-op 写入器，与 rpc-client 的 pi session log 同契约。
    const log = createPiRelayLog(frame.recordId)
    const entry: RegisteredEntry = { conn, mainSessionId: frame.mainSessionId, recordId: frame.recordId, child, pidFile, tee, log, droppedDataFrames: 0, warnedMalformedFrame: false, goodbyeReceived: false, teardownStarted: false }
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
    writeFrame(conn, { v: RELAY_PROTOCOL_VERSION, kind: RELAY_FRAME_KINDS.accept })

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
        // 不 detached：与 runtime 同进程组。注意：这只在「信号发给整个进程组」时才构成
        // 收割——当前无组信号发送方（supervisor/端口清杀路径均只 SIGTERM runtime 单进程），
        // Unix 父死子不亡，child 会 reparent 给 launchd 残活。实际兜底链 = deinit
        // destroyAll + supervisor stop 的预记录后代清理 + 启动 orphan sweep。
        detached: false,
        windowsHide: true,
      })
    } catch (e) {
      // spawn 同步失败（异常 spawn 形态）表现为「子进程非零退出」——exit 帧 127 + 断连，
      // extension 走既有失败路径（§7 错误表：代理层失败不设独立错误面）
      console.error(`[relay] spawn failed recordId=${frame.recordId}:`, e)
      writeFrame(conn, { kind: RELAY_FRAME_KINDS.exit, code: SPAWN_FAILURE_EXIT_CODE, signal: null })
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
      writeFrame(conn, { v: RELAY_PROTOCOL_VERSION, kind: RELAY_FRAME_KINDS.data, dir: RELAY_FRAME_DIRS.up, b64: chunk.toString('base64') })
      entry.log.write(chunk)
      if (!tee.abandoned) tee.feed(chunk)
    })
    child.stdout?.on('error', (err) => {
      console.warn(`[relay] child stdout stream error recordId=${entry.recordId}:`, err.message)
    })
    // stderr 只转发不进 tee（extension 的 stderrBuffer 累积语义不变）
    child.stderr?.on('data', (chunk: Buffer) => {
      writeFrame(conn, { v: RELAY_PROTOCOL_VERSION, kind: RELAY_FRAME_KINDS.data, dir: RELAY_FRAME_DIRS.upStderr, b64: chunk.toString('base64') })
    })
    child.stderr?.on('error', (err) => {
      console.debug(`[relay] child stderr stream error recordId=${entry.recordId}:`, err.message)
    })

    child.once('error', (err) => {
      // spawn 异步失败（ENOENT 等）：表现为子进程非零退出（exit 帧 127）
      console.error(`[relay] child error recordId=${entry.recordId}:`, err)
      this.cleanupEntry(entry)
      writeFrame(conn, { kind: RELAY_FRAME_KINDS.exit, code: SPAWN_FAILURE_EXIT_CODE, signal: null })
      endConn(conn)
    })

    child.once('exit', (code, signal) => {
      // 正常/被杀退出：exit 帧传播 → 关连接 → 清理（tee 销毁、pid 文件删除、注销）
      this.cleanupEntry(entry)
      writeFrame(conn, { kind: RELAY_FRAME_KINDS.exit, code, signal: signal ?? null })
      endConn(conn)
      // droppedDataFrames：数据阶段畸形帧丢弃计数（首帧已单独 warn）——非 0 说明
      // 该连接的数据通道有丢帧，配合「连接可能假活」排障归因
      console.log(`[relay] child exited recordId=${entry.recordId} code=${String(code)} signal=${String(signal)} droppedDataFrames=${entry.droppedDataFrames}`)
    })

    // 断连即杀（§4.2）：socket close 的任何原因（代理死/主 pi 崩溃/extension kill）。
    // goodbye 预告已收到的 close = 宿主侧正常收割（agent_settled 后杀代理），child
    // 照常收割但日志降级为 info——正常路径不产生 warn 噪声（2026-09-24 事故取证：
    // 64 条 kill-on-disconnect 中 41 条是正常收割，warn 级污染故障统计与 E2 连坐判定）。
    conn.once('close', () => {
      if (!this.entries.has(conn)) return // 已因 child exit 清理，no-op
      // destroyAll 已接管杀链（conn.destroy 的 close 异步落在 kill await 的事件循环
      // 刻度里，条目此刻仍在册）：杀链/日志全部归 destroyAll，此处 no-op 防重复登记
      if (entry.teardownStarted) return
      if (entry.goodbyeReceived) {
        console.log(`[relay] connection closed after goodbye, reaping child (normal teardown) recordId=${entry.recordId}`)
      } else {
        console.warn(`[relay] connection lost, killing child (kill-on-disconnect) recordId=${entry.recordId}`)
        // 杀链决策日志（crash-resilience §3.3 D6-⑥，E2 归因缺口的直接修复）：主 session
        // 断连（main pi 崩溃 / 代理丢失 / extension kill）连带杀受托 relay 子进程——
        // 动作/目标（主 session、recordId、子进程 pid）/原因 字段化单行落盘，E2 型
        // 「同秒连坐」事件可从此行反查连带关系。
        console.warn('[relay] kill decision', {
          action: 'kill_on_disconnect',
          trigger: 'socket_closed',
          mainSessionId: entry.mainSessionId,
          recordId: entry.recordId,
          childPid: entry.child.pid ?? null,
          reason: 'relay socket closed while child still alive (main pi died / proxy lost / extension kill)',
        })
      }
      // 清理交还 exit handler（cleanupEntry 幂等且被其无条件复跑）：kill 链 resolve 只代表
      // SIGKILL 已发出（进程可能仍在 D 状态收尾），此刻注销会把活孤儿提前销账——账面
      // 与真实进程态一致（真实 exit 才销账），杀链失败时条目留册由尾扫再杀。
      // 杀链登记 inflightKills：关停窗口内 runtime 退出前由 destroyAll 等待其收尾
      // （grace 内 SIGKILL 发出承诺），防 unref timer 随进程消亡漏补刀。
      const killP = killRelayChild(entry.child)
      this.inflightKills.add(killP)
      void killP.finally(() => this.inflightKills.delete(killP))
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
    if (this.orphanRecheckTimer !== null) {
      clearInterval(this.orphanRecheckTimer)
      this.orphanRecheckTimer = null
    }
    const list = [...this.entries.values()]
    await Promise.allSettled(list.map(async (entry) => {
      // 先标记再 destroy：close handler 异步触发时据此让路（杀链由本函数唯一负责）
      entry.teardownStarted = true
      entry.conn.destroy()
      await killRelayChild(entry.child)
      this.cleanupEntry(entry)
    }))
    // 在册条目已清，但 close 路径触发的在途杀链（kill-on-disconnect fire-and-forget）
    // 可能仍在 grace 窗口内等 SIGTERM 收敛/补 SIGKILL——等待它们全部收尾再放行，
    // 防 runtime 退出使 unref timer 消亡而漏补刀（残活 child 成为下轮 sweep 的孤儿）。
    while (this.inflightKills.size > 0) {
      await Promise.allSettled([...this.inflightKills])
    }
  }

  /**
   * 重启残留扫描兜底（§3.3-② / §4.2）：runtime 崩溃后 relay-children/ 下的 pid 文件
   * 是孤儿收割依据。判定链：kill -0 死 → 删 stale 文件；活 → ps lstart 比对 pid 文件
   * spawnedAt（进程启动晚于 spawn 记录 + 容差 = pid 复用，无辜进程不杀不删，防误杀）；
   * 启动时间不晚于记录 → 活孤儿，**处置按活跃度分级**（见 ORPHAN_IDLE_REAP_MS 注释：
   * 静默立即收割，活跃登记 pending 延迟收割）；ps 不可用时保守跳过（保留文件下次再扫）
   * ——误杀无辜进程的代价高于留孤儿。幂等可重入：deferred 发生时由复查 timer 周期
   * 重扫（在册 recordId 跳过——本 runtime 在管的不是孤儿）。
   */
  async sweepOrphanChildren(): Promise<void> {
    const dir = getRelayChildrenDir(this.opts.dataDir)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch (e) {
      // 目录读不到（权限/异常挂载等）：本轮兜底整体失效必须出声，否则重启残留
      // 孤儿的 pid 文件永久滞留且无任何日志线索
      console.warn(`[relay] orphan sweep skipped (readdir failed) dir=${dir}:`, toErrorMessage(e))
      return
    }
    let deferredAny = false
    for (const file of files) {
      if (!file.endsWith('.pid')) continue
      const pidFile = `${dir}/${file}`
      const recordId = basename(file, '.pid')
      // 本 runtime 在册（正常在管）不是孤儿——复查 timer 重入时排除在册条目
      if (this.recordIdToConn.has(recordId)) continue
      let pid: number
      let spawnedAt: number
      let pendingSince: number | undefined
      try {
        const parsed = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid?: unknown; spawnedAt?: unknown; pendingSince?: unknown }
        if (typeof parsed.pid !== 'number' || typeof parsed.spawnedAt !== 'number') throw new Error('malformed pid file')
        pid = parsed.pid
        spawnedAt = parsed.spawnedAt
        if (typeof parsed.pendingSince === 'number') pendingSince = parsed.pendingSince
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
      // —— 活跃度分级处置（2026-09-24 事故修复）——
      const teeMtime = this.latestRelayTeeMtimeMs(recordId)
      const idleMs = teeMtime === null ? Number.POSITIVE_INFINITY : Date.now() - teeMtime
      if (idleMs > ORPHAN_IDLE_REAP_MS) {
        // 静默孤儿（或无 tee 证据）：立即收割——纯资源回收，无任务上下文损失
        this.reapOrphanPid(pidFile, recordId, pid, pendingSince !== undefined ? 'deferred orphan went idle' : 'tee idle (no recent output)')
        continue
      }
      // 活跃孤儿：任务仍在推进，立即杀 = 反复中断重派（重启风暴振荡形态）。
      // 登记 pending 延迟收割；已有 pending 且到硬上限 → 强制收割。
      deferredAny = true
      if (pendingSince === undefined) {
        this.markOrphanPending(pidFile, recordId, pid, idleMs)
      } else if (Date.now() - pendingSince > ORPHAN_PENDING_MAX_MS) {
        this.reapOrphanPid(pidFile, recordId, pid, `pending max age exceeded (${Math.round(ORPHAN_PENDING_MAX_MS / MINUTE_MS)}min hard cap)`)
      }
      // 仍在产出且未到硬上限：留待下次复查（timer 驱动或下次 runtime 重启的 sweep）
    }
    if (deferredAny) this.armOrphanRecheck()
  }

  /**
   * 孤儿的 tee 镜像最近写入时间（epoch ms；无任何镜像文件返回 null）。
   * 活跃度判据 = `pi-relay-<date>-<recordId>.jsonl` 的 mtime（createPiRelayLog 同款
   * 命名；取全部日期代中最新）。无 tee 证据（跨天清理/测试环境）按「静默」处理，
   * 维持原 sweep 的立即收割语义——孤儿无产出证据时留着只是资源占用。
   */
  private latestRelayTeeMtimeMs(recordId: number | string): number | null {
    const safeRecordId = String(recordId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, RECORD_ID_MAX_CHARS)
    if (safeRecordId.length === 0) return null
    let best: number | null = null
    try {
      const logsDir = join(this.opts.dataDir, 'logs')
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith('pi-relay-') || !f.endsWith(`-${safeRecordId}.jsonl`)) continue
        const mtime = statSync(join(logsDir, f)).mtimeMs
        if (best === null || mtime > best) best = mtime
      }
    } catch {
      return null
    }
    return best
  }

  /**
   * 接管前收割旧登记进程（注册路径调用）：同 recordId 的新 spawn 覆盖 pid 文件前，
   * 旧登记里活着的旧 pid 是将被台账遗忘的泄漏进程——按 orphan 同款信号链收割。
   * 新 pid 为 null（spawn 异常形态）或旧登记缺失/已死时 no-op。
   */
  private reapSupersededPidIfAlive(pidFile: string, recordId: string, newPid: number | null): void {
    let oldPid: number
    let oldSpawnedAt: number
    try {
      const parsed = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid?: unknown; spawnedAt?: unknown }
      if (typeof parsed.pid !== 'number' || typeof parsed.spawnedAt !== 'number') return
      oldPid = parsed.pid
      oldSpawnedAt = parsed.spawnedAt
    } catch {
      return // 无旧登记（首注册/已清理）
    }
    if (newPid === null || oldPid === newPid || !isPidAlive(oldPid)) return
    // pid 复用防护（与 sweep 同款判据）：进程比旧登记新 = pid 已被无关进程复用，不杀
    void this.readProcessStartTime(oldPid).then((procStart) => {
      if (procStart !== null && procStart > oldSpawnedAt + PID_REUSE_TOLERANCE_MS) return
      if (!isPidAlive(oldPid)) return
      console.warn(`[relay] superseded registration: reaping stale pid ${String(oldPid)} before overwriting pid file recordId=${recordId}`)
      try {
        process.kill(oldPid, 'SIGCONT')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        return // 杀不动（EPERM 等）：不阻塞新注册，残留交 orphan sweep
      }
      setTimeout(() => {
        try {
          if (isPidAlive(oldPid)) process.kill(oldPid, 'SIGKILL')
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== 'ESRCH') {
            // 非 ESRCH（EPERM 等）：没杀掉也不阻塞新注册，残留交 orphan sweep 兜底
            console.warn(`[relay] superseded pid SIGKILL failed, deferring to orphan sweep pid=${String(oldPid)}:`, toErrorMessage(e))
          }
          // ESRCH = 已死（探活到 SIGKILL 之间退出，正是收割目标状态），静默
        }
      }, RELAY_KILL_GRACE_MS).unref()
    })
  }

  /** 活跃孤儿登记 pending（pid 文件写回 pendingSince + 响亮日志；幂等重写无 pending 语义不变）。 */
  private markOrphanPending(pidFile: string, recordId: string, pid: number, idleMs: number): void {
    try {
      const parsed = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid?: unknown; spawnedAt?: unknown }
      if (typeof parsed.pid !== 'number' || typeof parsed.spawnedAt !== 'number') return
      writeFileSync(pidFile, JSON.stringify({ pid: parsed.pid, spawnedAt: parsed.spawnedAt, pendingSince: Date.now() }))
    } catch {
      // 写失败（并发覆盖/权限）：保持无 pending 登记，下次 sweep 重新判定
      return
    }
    console.warn(
      `[relay] orphan still active (tee wrote ${Math.round(idleMs / SECOND_MS)}s ago), deferred reap — waiting for recovery chain or idleness recordId=${recordId} pid=${String(pid)} ` +
      `(idle threshold ${Math.round(ORPHAN_IDLE_REAP_MS / MINUTE_MS)}min, recheck every ${Math.round(ORPHAN_PENDING_RECHECK_MS / SECOND_MS)}s, hard cap ${Math.round(ORPHAN_PENDING_MAX_MS / MINUTE_MS)}min)`,
    )
  }

  /** 孤儿收割执行：SIGCONT → SIGTERM → grace 后 SIGKILL + 删 pid 文件（信号链与原 sweep 逐字一致）。 */
  private reapOrphanPid(pidFile: string, recordId: string, pid: number, reason: string): void {
    console.warn(`[relay] reaping orphan relay child recordId=${recordId} pid=${String(pid)} (${reason})`)
    try {
      process.kill(pid, 'SIGCONT')
      process.kill(pid, 'SIGTERM')
    } catch (e) {
      // EPERM = 非本进程组（pid 复用的另一形态）：不追杀，保留文件
      console.warn(`[relay] orphan SIGTERM failed (not reaping) recordId=${recordId}:`, e)
      return
    }
    setTimeout(() => {
      try {
        if (isPidAlive(pid)) process.kill(pid, 'SIGKILL')
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ESRCH') {
          // kill 抛 ESRCH = 进程已死（探活到 SIGKILL 之间退出），正是收割目标状态
        } else {
          // 其他 errno（EPERM 等）：进程没杀掉，台账不销账——保留 pid 文件供下次
          // sweep 再扫（删文件会把杀不掉的活孤儿从兜底视野里永久销账）
          console.warn(`[relay] orphan SIGKILL failed, keeping pid file for next sweep recordId=${recordId} pid=${String(pid)}:`, toErrorMessage(e))
          return
        }
      }
      this.removePidFile(pidFile)
    }, RELAY_KILL_GRACE_MS).unref()
  }

  /**
   * pending 孤儿复查 timer：deferred 存在时武装，周期重扫（幂等 sweep）。unref——
   * 常驻进程内 timer 不阻止 runtime 退出（退出后 pending 状态在 pid 文件里，下一轮
   * runtime 启动的 sweep 自然接续）。destroyAll 清除。
   */
  private armOrphanRecheck(): void {
    if (this.orphanRecheckTimer !== null) return
    this.orphanRecheckTimer = setInterval(() => {
      if (this.orphanSweepInFlight) return
      this.orphanSweepInFlight = true
      void this.sweepOrphanChildren().finally(() => {
        this.orphanSweepInFlight = false
      })
    }, ORPHAN_PENDING_RECHECK_MS)
    this.orphanRecheckTimer.unref()
  }

  /** 读进程启动时间（epoch ms）；失败/平台不支持返回 null。 */
  private readProcessStartTime(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
      // C-proc-09 出站契约：不传 env = 隐式全量继承父环境（含 TAIJI_RUNTIME_TOKEN），
      // 泄漏给 ps 后代进程；只读探测仅需 PATH/HOME，白名单基座 + deny 兜底（RT-8#9）。
      execFile('ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 5_000,
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      }, (err, stdout) => {
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
