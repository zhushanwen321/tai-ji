import { spawn, type ChildProcess } from 'node:child_process'
import { getPiAgentDir } from './pi-paths.js'
import { recordSpawnMarkers } from './spawn-markers.js'
import { getDefaultModel } from './pi-provider-store.js'
import { RpcTimeoutError } from '../../utils/errors.js'
import type { ThinkingLevel, ProviderId } from '@xyz-agent/shared'
import { BASH_RPC_TIMEOUT_MS, COMPACT_RPC_TIMEOUT_MS } from '@xyz-agent/shared'
// B3 出站契约唯一构建器（U3 收口点；实现本体在 @xyz-agent/shared，此处走 runtime 门面）
import { buildOutboundChildEnv } from '../spawn-env.js'
import type { IPiEngine, PiSessionStats, PiCompactionResult, PiBashResult, PiCommandInfo, SendCommandOptions } from '../../services/ports/pi-engine.js'
import { createPiSessionLog, writePiCrashLog, captureMemorySnapshot, type PiSessionLog, type PiCrashContext } from '../logger.js'
// pi 进程 RPC 公共层（@zhushanwen/pi-rpc；设计 docs/design/subagent-permanent-session-model.md
// §3.3.2，G5 收敛）：argv 构造 / LF-only 行分帧 / pending 表（超时分级 + 迟到响应丢弃）/
// 早期帧缓冲 / 命令帧组装 / 杀链 / 出站 env 组装全部 import 自公共包——本文件保留
// 进程生命周期编排与 runtime 专属语义（touch 时钟 / 崩溃取证 / stderr 收集 / 日志落盘），
// 协议机制零独立副本（S7 grep 无双轨门）。行为逐字等价迁移（U1 先并存后切换）。
import {
  attachLfOnlyLineReader,
  buildPiMainAgentArgs,
  buildPiOutboundEnv,
  buildPromptParams,
  buildSteerParams,
  buildFollowUpParams,
  buildSwitchSessionParams,
  buildExtensionUiResponsePayload,
  killPiProcess,
  createPendingRegistry,
  createEarlyFrameBuffer,
  CMD_TIMEOUT_MS,
  FAST_TIMEOUT_MS,
  SLOW_TIMEOUT_MS,
  type PiMessage,
  type PiEventListener,
} from '@zhushanwen/pi-rpc'

// 协议类型与 LF-only 行分帧 re-export：既有消费方（event-adapter / 测试）的 import
// 路径 'rpc-client.js' 保持不变；实现本体在 @zhushanwen/pi-rpc（无独立副本）。
export type { PiMessage, PiEventListener } from '@zhushanwen/pi-rpc'
export { attachLfOnlyLineReader } from '@zhushanwen/pi-rpc'

/**
 * pi get_available_models 返回的模型元素（pi-ai Model 翻译为内部消费形状的子集：
 * id/provider/reasoning/thinkingLevelMap，对账所需字段）。
 *
 * 非 Pi 前缀命名：本类型会被 services/model-capability.ts 消费——PiXxx 命名只许
 * 留在 infra/pi 内部（check_pi_type_leak / runtime-three-layer-design 边界规则），
 * 对上导出的翻译类型用内部命名（pi-events 翻译范式）。
 */
export interface AvailableModelSnapshot {
  id: string
  /** pi Model.provider（provider id，如 'zai-coding-cn'）。 */
  provider: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

export interface RpcClientOptions {
  cwd?: string
  model?: string
  /**
   * 附着恢复模式（restoreSession 专用）：true 时 start() 不拼 --model——options.model
   * 与全局默认兜底都被抑制。pi 的 CLI model 恒优先于 session entry 恢复（main.js
   * buildSessionOptions 的 `if (parsed.model)` 分支），拼了就会把用户在会话内切换过的
   * 模型在重启重开时静默压回默认（final gate V1⑤ 实证）；模型终态由 pi 从
   * model_change entry 恢复。create/fork 保持 launch 语义（不设此开关）。
   */
  inheritSessionModel?: boolean
  env?: Record<string, string>
  skillPaths?: string[]
  /** pi 可执行文件路径（默认 'pi'，从 PATH 查找） */
  piCommand?: string
  /** pi 扩展路径列表，每个路径通过 --extension 参数传递 */
  extensionPaths?: string[]
  /** session id（用于命名 pi stdout 日志文件，架构约定 #4） */
  sessionId?: string
  /** 替换 pi 核心系统提示词（走 --system-prompt CLI，仅新建会话生效）。空白时不传。 */
  systemPrompt?: string
  /**
   * 工具白名单（替换语义，映射 pi `--tools <comma-joined>`，附录 A.1）。
   * 非空时以逗号连接 push，只启用列出的工具。与 excludeTools/noTools 互斥；
   * 同时出现多个时 rpc-client 按 noTools > tools > excludeTools 优先级取一个并 warn（W-RT-6）。
   */
  tools?: string[]
  /**
   * 工具黑名单（叠加语义，映射 pi `--exclude-tools <comma-joined>`，附录 A.1）。
   * 在 pi 默认启用集合之上排除列出的工具。与 tools/noTools 互斥（见 tools 注释的优先级）。
   */
  excludeTools?: string[]
  /** 禁用所有工具（built-in + extension + custom），映射 pi `--no-tools`。与 tools/excludeTools 互斥。 */
  noTools?: boolean
  /** 禁用所有 skill，映射 pi `--no-skills`。调用方同时需清空 skillPaths。 */
  noSkills?: boolean
  /** 禁用 context files（AGENTS.md/CLAUDE.md 自动发现），映射 pi `--no-context-files`。 */
  noContextFiles?: boolean
  /** 覆盖思考级别，映射 pi `--thinking <level>`（注意：非 --thinking-level，附录 A.4）。 */
  thinkingLevel?: ThinkingLevel
}

// 超时分级常量（L6）与迟到响应 TTL / 早期帧缓冲上限已上移 @zhushanwen/pi-rpc
// （frame 模块单源）：CMD_TIMEOUT_MS / FAST_TIMEOUT_MS / SLOW_TIMEOUT_MS 经顶部
// import 消费；TIMED_OUT_ID_TTL_MS / EARLY_FRAME_BUFFER_MAX 由 registry / buffer
// 部件内部持有。杀链 grace 走 killPiProcess 缺省（DEFAULT_PI_KILL_GRACE_MS = 2s，
// 与迁移前 KILL_TIMEOUT_MS 等值）。
const STARTUP_DELAY_MS = 500
/**
 * stderr 崩溃取证缓冲的字节上限（D4/G4：异常退出全量落盘的内存防御边界）。
 *
 * 常态累计全量（替代旧 50 行 ring buffer——崩溃现场曾被截到只剩 2 行）；真实事故
 * stderr 仅几十行 KB 级，常态内存增量可忽略；上限仅防御异常洪泛（崩溃循环打印等），
 * 超限丢最旧并在 crash log 头部标注 truncated。
 */
const STDERR_CRASH_MAX_BYTES = 1_000_000
/** 错误消息 / exitCallback 载荷里的 stderr 尾部行数（展示路径，D4 后语义不变） */
const STDERR_TAIL_LINES = 10

// ── start 提取 helper（复杂度债务偿还，行为保持提取：按处理阶段下沉，主函数只留编排）──

/**
 * start 的 model 参数解析（P1，pi-assumption final gate）：附着恢复路径不拼 --model——
 * pi CLI model 恒优先于 session entry 恢复，全局默认兜底一旦拼进 args，用户切换过的
 * 模型就被静默压回默认。modelRef 读取保持无条件（与提取前求值顺序一致）。
 */
function resolveStartModel(options: RpcClientOptions): string | undefined {
  const modelRef = getDefaultModel()
  return options.inheritSessionModel
    ? undefined
    : options.model ?? (modelRef ? `${modelRef.provider}/${modelRef.modelId}` : '')
}

// 出站 env 构建（B3 出站契约收口）与 pi CLI argv 构造已上移 @zhushanwen/pi-rpc
// （env / spawn-args 模块单源，行为逐字等价提取）：start() 经 buildPiOutboundEnv
// （底层白名单构建器注入 shared buildOutboundChildEnv——C-proc-09 唯一构建点语义
// 不变）与 buildPiMainAgentArgs 消费。flag 语义全文（--approve 信任边界 /
// --no-extensions 与 --extension 交互 / W-RT-6 tools 互斥）见 pi-rpc spawn-args.ts。

/**
 * bash RPC 超时解析（timeout-slow-flow-wallclock D2 env 逃生门）。
 *
 * 优先级：env `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS`（0=不限时，非法/负值回退默认）>
 * shared `BASH_RPC_TIMEOUT_MS`（1h）。env 覆盖读取刻意留在 runtime 侧（renderer 不可达
 * 进程 env），renderer 侧 backstop 由 D5 的 shared 常量 + margin 独立取值。
 *
 * 读一次缓存：pi 是长驻子进程，超时决策在进程生命周期内稳定——若每次 bash() 重读 env，
 * 运行中途改 env 会让「已等 59 分钟」与「刚改的 1 秒」并存于同一次等待，语义不可预测；
 * 缓存后语义 = 「本次 runtime 进程启动后首个 bash 请求时的配置」（测试可经
 * resetBashRpcTimeoutForTest 重置）。
 */
let cachedBashRpcTimeoutMs: number | null = null

export function resolveBashRpcTimeoutMs(): number {
  if (cachedBashRpcTimeoutMs === null) {
    const raw = process.env.XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS
    const parsed = raw !== undefined ? Number(raw) : Number.NaN
    cachedBashRpcTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : BASH_RPC_TIMEOUT_MS
  }
  return cachedBashRpcTimeoutMs
}

/** 测试隔离：清空 env 逃生门缓存（对齐 core resetChatModuleStateForTest 先例）。生产勿调。 */
export function resetBashRpcTimeoutForTest(): void {
  cachedBashRpcTimeoutMs = null
}

/**
 * RPC 超时错误（integrity-hardening D3a：pi 半死自愈）。
 *
 * pi 事件循环卡死（native 模块 / 同步 IO 冻结）时一切 RPC 都以超时失败——这类失败
 * 意味着进程「半死」（活着但不响应），处置是强杀重建而非重试。调用方
 * （message-dispatcher 的 abort 强杀分支）经 instanceof 判别，因此必须是独立类型：
 * 字符串 message 匹配无编译期防护，改文案即断链。
 *
 * [arch] 类本体定义在 utils/errors.ts（中立层——services 层 instanceof 判别需要运行时
 * 值 import，定义在 infra 会让 services→infra 违反三层规则），此处 re-export 保持
 * 既有 import 路径（rpc-client.js）兼容。
 */
export { RpcTimeoutError } from '../../utils/errors.js'

export class RpcClient implements IPiEngine {
  private proc: ChildProcess | null = null
  /**
   * RPC pending 表（请求-响应配对 + 超时分级 L6 + 迟到响应丢弃 S6）——
   * @zhushanwen/pi-rpc frame 部件。超时错误构造经回调注入 RpcTimeoutError
   * （类型本体在 utils/errors.ts，公共包不感知宿主错误面）。maintenance 标记
   * （idle-pi-reclamation D1 双腿闭合）随注册写入：出站腿在 sendCommand 不 touch，
   * 回程腿在 handleMessage 依据标记对其 response 帧跳过 touch——回程回声与出站
   * 请求同频，只排除出站腿时空闲时钟仍被周期性重置。
   */
  private pendingRegistry = createPendingRegistry<PiMessage>()
  private listeners = new Set<PiEventListener>()
  /**
   * 早期帧缓冲（early-frame-buffer 设计 D1-D3）——pi-rpc frame 部件：pi spawn 到首个
   * listener attach 之间的空窗里，非 response 帧进 FIFO 而非丢弃；首个 listener 注册
   * （onEvent）时同步按序重放，随后缓冲一次性关闭（D1/D3）。
   *
   * 一次性语义：关闭后不再复位——listeners 再次空集（adapter detach 形态）恢复直通
   * 丢弃语义，绝不重新武装、不重放陈旧帧（r2 复审 S3）。生命周期随 client 对象 GC
   * 释放（kill 后无新帧，无显式 destroy，r1 审查 SG-4）。
   */
  private earlyFrameBuffer = createEarlyFrameBuffer<PiMessage>({
    onOverflowWarn: (dropped, max) => {
      console.warn(
        `[rpc] early frame buffer overflow: >${max} frames without a listener, `
        + `dropping oldest (dropped=${dropped}, further drops silent). `
        + 'Listener not attached — check the session initialization chain if this persists.',
      )
    },
  })
  private msgCounter = 0
  private _exited = false
  private _killing = false
  /**
   * 进程退出回调集合（多播）。
   *
   * 曾是单槽字段（exitCallback = cb）：第二个注册者会静默覆盖第一个——若覆盖
   * ProcessManager 的清理回调即复刻「僵尸 session」根因（handoff-service.ts:63-70
   * 曾因此被迫轮询 exited 绕开）。改 Set + onExit 返回 unsubscribe，与 onEvent 对称。
   */
  private exitCallbacks = new Set<(code: number | null, stderr: string) => void>()
  /**
   * 收集 pi 进程的 stderr 输出：展示路径取尾部（getStderrTail），崩溃路径取全量。
   *
   * D4/G4 改造：旧实现 50 行 ring buffer（shift 截断）在崩溃时只留尾部——本次事故
   * 现场只剩 2 行，TypeError 之上的输出全部丢失。现为全量累计 + STDERR_CRASH_MAX_BYTES
   * 字节硬上限（超限丢最旧并置 stderrTruncated，crash log 头部标注）。策略取舍：
   * 「崩溃前已累计全量」而非「常态 tee 磁盘」——tee 与「正常退出不写 crash 文件」
   * 冲突（临时文件生命周期/句柄常驻/残留清理是新失败面），内存上限制常态增量可忽略。
   */
  private stderrChunks: string[] = []
  /** stderrChunks 当前累计字节数（上限判定用，避免每次重算） */
  private stderrTotalBytes = 0
  /** 是否发生过超限丢弃（crash log 头部标注「非全量」用） */
  private stderrTruncated = false
  /** pi stdout JSONL 原始流落盘（架构约定 #4，诊断 pi 卡死的决定性证据） */
  private piSessionLog: PiSessionLog | null = null
  /**
   * 最近一次「事件帧」到达 stdout 的时刻（chat-domain-v1x-liveness-governance W7 桥事件窗信号）。
   *
   * 为什么记在 handleMessage 顶部而非 listener 广播分支：该戳度量的是「pi 是否还在发事件」
   * （pi 侧产出证据），不是「runtime 是否消费」——bash_execution_update 等被 timedOutIds
   * 丢弃 / 进早期帧缓冲的流事件同样是 pi 事件循环存活的证据。只记非 response 帧：RPC
   * response 的活性由快超时探测（getState）专责，两信号职责正交（设计 §3.2 D3 三信号判据）。
   * 消费方 = message-dispatcher abort 超时阶梯的「事件窗静默」判定（区分 RPC 饿死 vs 真冻结）。
   */
  private _lastEventAt: number | undefined

  // ── 崩溃取证上下文（crash-resilience §3.3 D6-④）：崩溃时刻 writeCrashLogIfNeeded
  // 采集进 pi-crash log 头部的 runtime 侧字段。未知保持 null（显式落盘「没采到」）。
  /** 最后一次发出的 RPC 命令类型（sendCommand 唯一写点；崩溃时即「死前最后动作」）。 */
  private lastCommandType: string | null = null
  /** spawn 完成（awaitStartupSettled 通过）时刻 ms；uptimeMs = 崩溃时刻 - 本值。 */
  private spawnedAt: number | null = null
  /**
   * 已知 pi 历史文件绝对路径：switch_session 参数（restore/fork 路径）或 get_state
   * 返回的 sessionFile（attach 序列恒调）任一发生过。新建 session 在 pi 首条 assistant
   * 前文件可能不存在（仓规 #6），runtime 不探测文件系统，未知即 null。
   */
  private attachedSessionFile: string | null = null

  /**
   * 最近一次 pi 双向活动时刻（ms epoch，idle-pi-reclamation 设计 D1 空闲信号）。
   *
   * 三个写点：出站 sendCommand（maintenance 标记的维护通道除外）/ 入站 handleMessage
   * 全帧 / touchActivity()（dispatcher 入口同步 touch，D6-1）。初值 = spawn 时刻
   * （start() 内重置——构造到 spawn 之间的间隔不冒充空闲也不冒充活跃）。pi 空闲期
   * 无周期 stdout（ADR-0047 ping 只在 turn 内），该值在用户态空闲下单调静止——空闲
   * 回收判定（reaper）以 now - lastActivityAt 计空闲时长。
   */
  private _lastActivityAt = Date.now()

  constructor(private options: RpcClientOptions = {}) {}

  async start(): Promise<void> {
    // P1（pi-assumption final gate）：附着恢复路径不拼 --model——见 resolveStartModel。
    const model = resolveStartModel(this.options)
    // B3 出站契约收口（§5-U3）：pi-rpc env 模块组装——底层白名单构建器注入 shared
    // buildOutboundChildEnv（deny 兜底剥 XYZ_AGENT_PACKAGED/XYZ_RUNTIME_TOKEN 语义不变），
    // extras 过滤 + XYZ_AGENT_EXT_LOG 恒注入 + PI_CODING_AGENT_DIR 隔离（<dataDir>/agent/）。
    const env = buildPiOutboundEnv({
      parentEnv: process.env,
      extras: this.options.env,
      buildChildEnv: buildOutboundChildEnv,
      piAgentDir: getPiAgentDir(),
    })
    // argv 构造（pi-rpc spawn-args 主 agent 模板；基座 flag 语义与顺序与迁移前逐字节一致）。
    const args = buildPiMainAgentArgs(this.options, model)
    // U16（方案 B §6.12）：把本次 spawn 实际传入的 staged 专属 --extension/--skill 值
    // 全量覆盖写进 <dataDir>/run/pi-spawn-markers.json（u17 reap 四条合取的数据源）。
    // 写入失败不阻断 spawn（宁漏不崩——reap 侧对清单缺失本就跳过收殓，见 spawn-markers.ts）。
    recordSpawnMarkers(this.options)

    const piCmd = this.options.piCommand ?? 'pi'

    // Bun 编译的 bundled pi 用 process.execPath 定位资源（package.json、themes 等），
    // 不依赖 process.cwd() 查找 package.json。因此 spawn cwd 可以安全地设为用户项目目录。
    // 这样 pi 的初始 session、system prompt、CLAUDE.md 查找、bash 工具都基于正确的 cwd。
    // Verified: xyz-pi 0.75.5-xyz-0.1 uses process.execPath for resource resolution.
    // Re-verified 2026-08-20 (W6 A-11 探针) on upstream 0.84.1，双形态均不依赖 cwd：
    // - bun binary（打包产物 apps/electron/resources/pi/pi-darwin-arm64）：getPackageDir() =
    //   dirname(process.execPath)（pi 0.84.1 dist config.js isBunBinary 分支）；cwd=/tmp spawn
    //   --version 输出 0.84.1 正常，资源布局 binary 同目录 theme/package.json 与该分支一致。
    // - node dist（dev 形态）：从 __dirname 向上找 package.json（config.js getPackageDir Node 分支），
    //   实测 cwd=HOME//tmp//usr 三种 cwd 下 getPackageDir/getThemesDir 返回完全一致。
    const spawnCwd = this.options.cwd ?? process.cwd()

    console.log('[rpc] spawning pi:', piCmd, args.join(' '), 'cwd:', spawnCwd)

    this.proc = spawn(piCmd, args, {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 空闲信号初值 = spawn 时刻（idle-pi-reclamation D1）：client 构造（进进程表前）
    // 到真实 spawn 之间可能隔了 ensureActive 编排耗时，以进程诞生时刻起算空闲，
    // 构造时刻仅作未 start 形态的兜底初值。
    this._lastActivityAt = Date.now()

    // pi stdout JSONL 原始流落盘（架构约定 #4）。pi 卡死时（prompt 后零事件），
    // 这个文件是判断「pi 没发事件」vs「runtime 没转发」的决定性证据。
    // logger 未初始化时（如单元测试）返回 no-op 写入器，无副作用。
    if (this.options.sessionId) {
      this.piSessionLog = createPiSessionLog(this.options.sessionId)
    }

    const proc = this.proc
    this.wireProcessHandlers(proc)
    // Wait briefly to confirm process didn't exit immediately
    await this.awaitStartupSettled(proc)
    // D6-④：spawn 确认存活后再记 uptime 起点（立即崩溃的进程 uptimeMs 由 null 表达
    // 「未过存活确认」，与「存活 N ms 后崩溃」区分）。
    this.spawnedAt = Date.now()
  }

  /**
   * start 的进程事件接线（error / exit / stdout JSONL 解析 / stdout+stderr stream error /
   * stderr 全量收集）。与提取前注册顺序一致：error → exit → readline line → stdout error
   * → stderr data/error。
   */
  private wireProcessHandlers(proc: ChildProcess): void {
    proc.on('error', (err) => {
      console.error('[rpc] spawn error:', err)
      this.rejectAll(new Error(`Failed to spawn pi: ${err.message}`))
    })

    proc.on('exit', (code) => {
      this._exited = true
      console.log(`[rpc] process exited with code ${code}`)
      this.piSessionLog?.end()
      this.piSessionLog = null
      // Only reject pending requests on unexpected exits.
      // For normal kill flow (_killing=true), rejectAll is called in kill()
      // via a separate safety net to avoid leaving callers hanging until CMD_TIMEOUT_MS.
      if (!this._killing) {
        this.writeCrashLogIfNeeded(code)
        this.rejectAll(new Error(`pi process exited with code ${code}${this.formatStderrSuffix()}`))
        for (const cb of this.exitCallbacks) {
          cb(code, this.getStderrTail())
        }
      }
    })

    // Parse stdout JSONL（D10：LF-only 读取器，U+2028/U+2029 不拆帧——pi rpc/jsonl.js 帧协议的对端）
    // stdout error 吞转发（2026-09-04 事故审计，原 readline 防护语义在 LF-only 读取器上保留）：
    // pi 崩溃/被杀时 stdout 管道流错误无 listener 直接 throw 成 uncaughtException →
    // 整机 shutdown（stderr 已有同款防护，见下方 stderr 段注释）；attachLfOnlyLineReader
    // 只挂 data/end，error 防护在此补齐；pi 退出处置归 exit/kill 链路，此处只堵转发逃逸。
    proc.stdout!.on('error', () => {})
    attachLfOnlyLineReader(proc.stdout!, (line) => {
      if (!line.trim()) return
      // tee 原始 JSONL 到 pi session 日志（架构约定 #4，卡死诊断证据）
      this.piSessionLog?.write(line)
      try {
        const msg: PiMessage = JSON.parse(line)
        this.handleMessage(msg)
      // eslint-disable-next-line taste/no-silent-catch -- malformed line from pi process, skip and continue
      } catch (e) {
        console.error('[rpc] stdout parse error:', line, e)
      }
    })

    // W2：监听 stdout stream 的 'error' 事件。
    // proc.on('error') 只覆盖 spawn 失败；stdout 是独立的 Readable stream，pi 崩溃 /
    // 管道断裂（EPIPE / ECONNRESET）时 stdout 会 emit 'error'，若无 listener 则升级为
    // uncaughtException → runtime 主进程崩溃。此处捕获后 rejectAll pending 并标记 _exited，
    // 把 stream error 纳入与进程退出相同的清理路径。
    //
    // 管道断裂但进程可能仍存活（孤儿泄漏）：SIGKILL 加速其死亡，让下方 proc.on('exit')
    // 作为死亡通知的唯一出口（避免「stream error 通知 + exit 通知」双触发）。
    // 刻意调 ChildProcess 原生 kill 而非 this.kill()：后者置 _killing=true，
    // exit 处理器会跳过 exitCallbacks —— 死亡通知整条丢失。
    proc.stdout?.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[rpc] stdout stream error:', err)
      this._exited = true
      this.rejectAll(new Error(`pi stdout stream error: ${err.message}`))
      this.killProcAfterStreamError('stdout')
    })

    // 收集 stderr 用于错误诊断，同时转发到日志
    this.stderrChunks = []
    this.stderrTotalBytes = 0
    this.stderrTruncated = false
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trimEnd()
        console.error('[rpc:stderr]', text)
        // 全量累计（D4/G4 崩溃取证），超字节上限丢最旧（防异常洪泛无界内存）
        this.stderrChunks.push(text)
        this.stderrTotalBytes += Buffer.byteLength(text, 'utf8')
        while (this.stderrTotalBytes > STDERR_CRASH_MAX_BYTES && this.stderrChunks.length > 1) {
          const dropped = this.stderrChunks.shift()!
          this.stderrTotalBytes -= Buffer.byteLength(dropped, 'utf8')
          this.stderrTruncated = true
        }
      })
      // W2：同 stdout，stderr stream 的 'error' 独立于 proc.on('error')。
      // pi 崩溃时 stderr 管道可能先断，未捕获会变 uncaughtException。捕获后 rejectAll + 标记 _exited。
      proc.stderr.on('error', (err: NodeJS.ErrnoException) => {
        console.error('[rpc] stderr stream error:', err)
        this._exited = true
        this.rejectAll(new Error(`pi stderr stream error: ${err.message}`))
        this.killProcAfterStreamError('stderr')
      })
    }
  }

  /**
   * stream error 后 SIGKILL 加速进程死亡（W2，死亡通知唯一出口语义）——
   * 细节与降级理由见 wireProcessHandlers 内 stdout 段注释。
   */
  private killProcAfterStreamError(stream: 'stdout' | 'stderr'): void {
    try {
      this.proc?.kill('SIGKILL')
    } catch (e) {
      // best-effort 降级：kill 抛错说明进程已死，exit 事件已/将至并走唯一出口，无需传播
      console.error(`[rpc] SIGKILL after ${stream} stream error failed (process may already be dead):`, e)
    }
  }

  /**
   * start 的启动确认窗口：等 STARTUP_DELAY_MS 确认进程没有立即退出；
   * 窗口内 exit / error 即 reject（消息含 stderr 尾部）。
   */
  private awaitStartupSettled(proc: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const onExit = (code: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`pi process exited immediately with code ${code}${this.formatStderrSuffix()}`))
      }
      const onError = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`pi spawn error: ${err.message}`))
      }
      const cleanup = () => {
        proc.removeListener('exit', onExit)
        proc.removeListener('error', onError)
      }
      proc.on('exit', onExit)
      proc.on('error', onError)
      setTimeout(() => {
        if (settled) return
        cleanup()
        if (!this._exited) resolve()
        else reject(new Error(`pi process exited during startup${this.formatStderrSuffix()}`))
      }, STARTUP_DELAY_MS)
    })
  }

  private handleMessage(msg: PiMessage): void {
    // 入站 touch（idle-pi-reclamation D1）：任何 stdout 帧（response / 事件 / 迟到丢弃帧）
    // 都证明 pi 在产出，进程非空闲。放在分派前——分支结构变化不影响 touch 语义。
    // 唯一例外（D1 双腿闭合）：解析为「maintenance pending 的 response」的帧不 touch。
    // promptReload（{ maintenance: true }）的出站腿已在 sendCommand 排除，但其 response
    // 回程经本入口无条件 touch 会把空闲时钟重置回去——回程回声与出站请求同频（skill
    // 变更风暴下与 promptReload 一一配对到达），只排除出站腿时回收饿死原样保留，
    // 故双腿同豁免。事件帧 / 非 maintenance response 的 touch 语义零变化。
    // 边角（可接受）：迟到 maintenance response——pending 已被超时清理（60s）后到达，
    // id 命不中 pending → 照旧 touch。超时 60s 后才回的 reload 极罕见，且该边角方向 =
    // 多豁免不误杀（多 touch 一次只推迟回收，不会误杀活跃进程），与「宁漏不误杀」同向。
    const maintenanceResponse = this.pendingRegistry.isMaintenanceResponse(msg)
    if (!maintenanceResponse) {
      this._lastActivityAt = Date.now()
    }
    // W7 桥事件窗信号：事件帧到达即更新活跃戳（语义与放置理由见 _lastEventAt 字段注释）。
    if (msg.type !== 'response') this._lastEventAt = Date.now()
    // If id matches a pending request, resolve it; otherwise emit as event.
    // resolve 只认 RPC response：pi 的 RpcResponse union 所有变体 type === 'response'
    // （pi-mono coding-agent/src/modes/rpc/rpc-types.ts:114-223），事件各有独立 type 字符串。
    // pi 0.84.1 新增 bash_execution_update 流事件复用发起 RPC 的 id
    // （node_modules @earendil-works/pi-coding-agent dist/core/agent-session.d.ts:103-106
    // {type:"bash_execution_update", id?, delta}；docs/rpc.md:26「bash_execution_update
    // events also include the id of their originating bash command」）——仅凭 id 命中
    // pending 就 resolve 会把首条 delta 误当 response（真 response 到达时 pending 已删，
    // 真实 output 丢失，bash() shape guard 落 [protocol error: malformed] fallback）。
    // 非 response 的带 id 消息走下方 listener 路径（event-adapter NULL_EVENTS 已登记）。
    // pending 配对 / 迟到丢弃判定在 pi-rpc registry 部件内（超时序列与迁移前逐字一致）。
    if (msg.type === 'response' && msg.id && this.pendingRegistry.resolveResponse(msg.id, msg)) {
      return
    } else if (this.pendingRegistry.isTimedOut(msg.id)) {
      // S6: 该 id 的请求已超时 reject，pi 迟到的响应丢弃（不当 event 广播给 listeners，
      // 避免幽灵 UI 副作用）。timedOutIds 在 registry 内由超时回调写入，5s TTL 后自动清理。
      // D2：此分支帧与 pending 命中的 response 帧同样不进早期帧缓冲（有独立的
      // 请求-响应配对 / 迟到丢弃语义，与 listener 无关）。
      return
    } else if (this.listeners.size === 0 && !this.earlyFrameBuffer.closed) {
      // 早期帧缓冲（early-frame-buffer D1）：listener 空窗（spawn → EventAdapter attach）
      // 期间的非 response 帧不再无条件丢弃，入 FIFO 待首个 listener 注册时重放。
      // 缓冲已关闭后 listeners 再空集（detach 形态）落回本行 else 直通丢弃 = 现状语义。
      this.earlyFrameBuffer.push(msg)
    } else {
      for (const listener of this.listeners) {
        listener(msg)
      }
    }
  }

  /**
   * 首个 listener 注册时同步按序重放早期帧缓冲，随后一次性关闭缓冲（D1/D3）。
   *
   * 顺序性：重放发生在 onEvent 调用栈内的同步普通循环——Node 单线程事件循环保证重放与
   * handleMessage 不会交错（stdout 'data' 回调排队在后），因此「重放帧（旧）→ 直通帧（新）」
   * 的全序与 pi 输出序一致（G3 构造性成立）。异步重放（setImmediate/微任务）因引入交错
   * 窗口被设计否决。
   *
   * 关闭先于重放循环（takeAndClose 原子取走 + 置位），即使重放中出现再入（防御性——
   * listener 回调内同步触达 handleMessage 的路径不存在），帧也走直通而非重新入队。
   *
   * per-帧 try-catch（D5）：一帧 throw 不中断后续帧重放，也不炸到 onEvent 调用方——重放
   * 发生在 attach 调用栈内，无隔离会中断 session 创建链。与直通路径（listener throw 被
   * readline line handler 的 catch 吞为 parse error）的既有不对称是先例对齐，非本设计引入。
   */
  private replayEarlyFrameBuffer(listener: PiEventListener): void {
    const buffered = this.earlyFrameBuffer.takeAndClose()
    for (const msg of buffered) {
      try {
        listener(msg)
      } catch (e) {
        // 降级策略：重放的 per-帧隔离（D5）——单帧 listener throw 只 console.error 留痕，
        // 重放循环继续处理剩余帧，不向 onEvent 调用方传播（重放发生在 attach 调用栈内，
        // 传播会炸掉 session 创建链）。与直通路径吞为 parse error 的行为差异是设计定案。
        console.error('[rpc] early frame replay: listener threw on a buffered frame (isolated, continuing):', e)
      }
    }
  }

  private rejectAll(error: Error): void {
    // pending 全量 reject + timedOutIds 清空（一致性见 pi-rpc registry.rejectAll）。
    this.pendingRegistry.rejectAll(error)
  }

  private nextId(): string {
    return `rpc_${++this.msgCounter}_${Date.now()}`
  }

  /**
   * timeout ≤ 0 = 不限时：不挂墙钟 timer，pending 等到响应/进程退出才 settle。
   * 唯一合法入口是 bash RPC 的 env 逃生门 `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS=0`
   * （timeout-slow-flow-wallclock D2：0=不限时）——其余命令不得传 ≤0（控制面单请求
   * 秒级是有界兜底档，规则 19）。clearTimeout(undefined) 是 no-op，resolve/reject
   * 路径对无 timer 形态天然安全。
   */
  /**
   * 向 pi stdin 写入一行原始 JSON，不注册 pending、不等 RPC reply。
   *
   * 用于 pi 不回复 `{type:'response'}` 的命令（目前仅 `extension_ui_response`——
   * pi rpc-mode.ts 处理后直接 return，不回 RPC 确认）。用 sendCommand 会导致 pending
   * 永不 resolve → 60s CMD_TIMEOUT_MS 后才超时（timer 泄漏 + 无用等待）。
   *
   * 注意：调用方自行保证 JSON 格式正确 + 换行符结尾。
   */
  sendRaw(data: string): void {
    if (!this.proc || this._exited) {
      console.error('[rpc] sendRaw failed: pi process is not running')
      return
    }
    const line = data.endsWith('\n') ? data : data + '\n'
    try {
      this.proc.stdin!.write(line)
    // eslint-disable-next-line taste/no-silent-catch -- sendRaw 是 void fire-and-forget（pi 不回复 extension_ui_response），无调用方可传播错误；console.error 经 logger.patchConsole tee 到 runtime 日志文件（架构约定 #4）
    } catch (e) {
      console.error('[rpc] sendRaw write failed:', e)
    }
  }

  sendCommand(type: string, params: Record<string, unknown> = {}, timeout = CMD_TIMEOUT_MS, options?: SendCommandOptions): Promise<PiMessage> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this._exited) {
        return reject(new Error('pi process is not running'))
      }

      const id = this.nextId()
      const msg = JSON.stringify({ id, type, ...params }) + '\n'

      // D6-④：崩溃取证「死前最后动作」。sendCommand 是全部 RPC 的唯一入口，
      // 记录点在 pending 注册前——即使进程在写 stdin 后立刻死亡，字段已就位。
      this.lastCommandType = type

      // 出站 touch（idle-pi-reclamation D1）：sendCommand 是全部出站 RPC 的唯一咽喉。
      // 唯一例外 = 维护通道（options.maintenance，如 promptReload 的 /__xyz_reload__——
      // skill 目录变更会对全部活跃 session 触发，计入会让空闲时钟被周期性重置、回收
      // 饿死且不体现为豁免命中）。touch 在状态检查后：进程已死时无空闲可言。
      if (!options?.maintenance) {
        this._lastActivityAt = Date.now()
      }

      // pending 注册（pi-rpc registry 部件）：timeout ≤ 0 = 不限时（D2 env 逃生门
      // 0=不限时，唯一合法入口是 bash RPC）；超时时序（delete → timedOutIds 记入
      // 5s TTL → reject）在部件内与迁移前逐字一致。
      this.pendingRegistry.register(
        id,
        {
          resolve: (res) => {
            // Check if the response indicates failure (PiMessage.success / .error 已声明类型)
            if (res.success === false) {
              reject(new Error(res.error ?? `RPC command "${type}" failed`))
            } else {
              // 归一：pi 响应兼容 data/payload 两位置（historically readRpcData 在调用方做
              // data ?? payload），现下沉到 sendCommand，统一后调用方直接读 msg.data。
              if (res.data === undefined && res.payload !== undefined) {
                res.data = res.payload
              }
              resolve(res)
            }
          },
          reject,
          // D1 双腿闭合：标记随 pending 注册写入，handleMessage 据此对回程 response 跳过 touch
          maintenance: !!options?.maintenance,
        },
        timeout,
        // D3a：超时以 RpcTimeoutError 类型 reject（字段化 commandType/timeoutMs），调用方
        // instanceof 判别后走强杀自愈路径，不再靠 message 字符串匹配。错误构造注入
        // （类型本体在 utils/errors.ts，公共包不感知宿主错误面）。
        () => new RpcTimeoutError(type, timeout),
      )

      try {
        console.log('[rpc] send: type=' + type)
        const ok = this.proc.stdin!.write(msg)
        if (!ok) {
          this.proc.stdin!.once('drain', () => {})
        }
      } catch (e) {
        this.pendingRegistry.cancel(id)
        reject(new Error(`Failed to write to pi stdin: ${e}`))
      }
    })
  }

  /**
   * Register a callback for when the pi process exits unexpectedly. stderr 为 pi 进程尾部输出。
   * 多播（可多订阅者，后注册者不再覆盖先注册者），返回 unsubscribe（与 onEvent 对称）。
   * 每个进程 exit 恰好通知一次：proc.on('exit') 是唯一出口（stream error 只 kill 不通知）；
   * _killing=true 的主动 kill 流程不通知，语义不变。
   */
  onExit(callback: (code: number | null, stderr: string) => void): () => void {
    this.exitCallbacks.add(callback)
    return () => { this.exitCallbacks.delete(callback) }
  }

  /**
   * Register an event listener for non-response messages from pi.
   * Returns an unsubscribe function.
   *
   * 早期帧缓冲（early-frame-buffer D1/D3）：首个 listener 注册时在返回前同步按序重放
   * listener 空窗期间缓冲的帧（见 replayEarlyFrameBuffer）；之后缓冲一次性关闭。后续
   * listener（含关闭后 listeners 再空集的再注册）不触发重放——现状 Set 语义，只收直通帧。
   * 真实调用形态恒定：event-adapter attach 恒为首 listener，handoff-service（ensureActive）
   * 恒为后续 listener，无行为回归。
   */
  onEvent(listener: PiEventListener): () => void {
    // 首注册判定必须在 add 之前（add 后 size 恒 ≥1）；缓冲已关闭时即使当前 listeners 空
    // 也属「后续注册」——一次性语义，不重放陈旧帧（r2 复审 S3）。
    const isFirstListener = this.listeners.size === 0 && !this.earlyFrameBuffer.closed
    this.listeners.add(listener)
    if (isFirstListener) {
      this.replayEarlyFrameBuffer(listener)
    }
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 异常退出时把累计 stderr 全量落盘（D4/G4，file-lock-unification-and-reaper-sink
   * §3.2-D4 / U3-4）。
   *
   * 触发条件：code≠0 且非主动 kill（调用点在 exit handler 的 !this._killing 分支内）。
   * code=null（信号死亡，如管道断裂后的 SIGKILL）同属异常退出，落盘。
   * 正常退出（code=0）与主动 kill 流程不写。
   * 文件：<logsDir>/pi-crash-<date>-<sid>.log（logger.ts writePiCrashLog，复用 pi-*
   * 命名惯例，保留期清理自动覆盖）。
   *
   * best-effort 观测路径：任何失败（logger 未初始化 / 宿主环境未接线该能力，如
   * 单元测试部分 mock logger 模块）都不得影响 exit 主流程（rejectAll / exitCallbacks
   * 通知链）——与 logger 模块自身的容错契约同档。失败经 console.error 出声（console
   * 已被 logger patch，tee 进 runtime 主日志），不静默。
   */
  private writeCrashLogIfNeeded(code: number | null): void {
    if (code === 0) return
    try {
      // D6-④：runtime 侧上下文头（A8 交叉归因的 runtime 半边）。全字段 best-effort：
      // 未采集到的保持 null（writePiCrashLog 内 formatPiCrashContextHeader 显式落盘），
      // 采集本身不抛。渲染归 writePiCrashLog 单点（第三参），此处只组装数据。
      const context: PiCrashContext = {
        sessionId: this.options.sessionId ?? null,
        sessionFile: this.attachedSessionFile,
        lastRpcCommand: this.lastCommandType,
        uptimeMs: this.spawnedAt !== null ? Date.now() - this.spawnedAt : null,
        memory: captureMemorySnapshot(),
      }
      const header = [
        `pi crashed with code ${code} at ${new Date().toISOString()}`,
        this.stderrTruncated ? '(stderr truncated: earliest lines dropped, crash buffer exceeded 1MB)' : '',
        '',
      ].filter(Boolean).join('\n')
      writePiCrashLog(this.options.sessionId, `${header}${this.stderrChunks.join('\n')}`, context)
    } catch (crashErr) {
      // best-effort：崩溃日志落盘失败不掩盖/干扰原始崩溃路径（exit code 已由上层消费），仅控制台留痕
      console.error('[rpc] write pi crash log failed:', crashErr)
    }
  }

  /** 将收集到的 pi stderr 格式化为可读后缀，附到错误消息末尾 */
  private formatStderrSuffix(): string {
    if (this.stderrChunks.length === 0) return ''
    const last = this.stderrChunks.slice(-STDERR_TAIL_LINES)
    return `\n\npi stderr (last ${last.length} lines):\n${last.join('\n')}`
  }

  /** 返回 pi stderr 尾部内容（不含前缀），供 exitCallback 透传到上层展示给用户 */
  private getStderrTail(): string {
    if (this.stderrChunks.length === 0) return ''
    return this.stderrChunks.slice(-STDERR_TAIL_LINES).join('\n')
  }

  get exited(): boolean {
    return this._exited
  }

  /**
   * 最近一次 pi 双向活动时刻（ms epoch，idle-pi-reclamation D1 空闲信号）。
   * 只读暴露：消费方（reaper 判定）只读，刷新统一走 RpcClient 内部 touch 点与
   * touchActivity()——写点集中可审计，防止空闲时钟被随意重置。
   */
  get lastActivityAt(): number {
    return this._lastActivityAt
  }

  /**
   * 手动刷新空闲时钟（idle-pi-reclamation D6-1）。调用方语义 = MessageDispatcher
   * .sendPrompt 入口同步 touch：「prompt 已发出、插件 hook / restore 执行中」窗口内
   * occupancy 尚未置 dispatching（markSessionActive 在两个 await 之后），靠此处刚
   * touch 过的时间戳让回收判定不满足空闲阈值，by construction 关闭误回收窗口。
   */
  touchActivity(): void {
    this._lastActivityAt = Date.now()
  }

  /**
   * 最近一次事件帧到达时刻（W7 abort 超时阶梯的桥事件窗信号读点）。
   * undefined = 本进程生命周期内从未观测到事件帧（对 abort 超时场景，配合探测无响应
   * 即构成冻结证据——运行中的 session 几乎不可能从未有过事件，pi spawn 即发初始化事件）。
   */
  get lastEventAt(): number | undefined {
    return this._lastEventAt
  }

  // ── High-level API ────────────────────────────────────────────────

  /**
   * Send a user message to pi. The returned promise resolves when
   * pi acknowledges receipt (not when generation completes).
   * Actual content arrives via onEvent() listeners as text_delta etc.
   *
   * Note: pi RPC protocol uses "message" field, not "content".
   *
   * images 是 shared 层图片附件形状（{data;base64;mimeType}，无 type 字段）。
   * 此方法是 shared→pi ImageContent 的唯一组装点（AGENTS.md 规则 #5）：
   * map 时补 `type:'image' as const`，pi 私有 type 字段不出 infra 层。
   * images 为 undefined 或空数组时归一化为不传 images 键（避免 pi 收到空数组），
   * 走与改动前完全一致的路径，零回归。
   */
  prompt(content: string, images?: Array<{ data: string; mimeType: string }>, streamingBehavior?: 'steer' | 'followUp', options?: SendCommandOptions): Promise<PiMessage> {
    // 帧组装（pi-rpc commands）：images 是 shared 层图片附件形状（无 type 字段），
    // shared→pi ImageContent 的唯一组装点在公共包（pi 私有 type:'image' 不出本层）；
    // 空 images 归一化不传键（避免 pi 收到空数组），与改动前路径完全一致。
    // options 透传（idle-pi-reclamation D1）：维护通道（promptReload 的 /__xyz_reload__）
    // 经 prompt 的语义方法形态发起，maintenance 标记直达 sendCommand touch 排除。
    return this.sendCommand('prompt', buildPromptParams({ message: content, images, streamingBehavior }), CMD_TIMEOUT_MS, options)
  }

  abort(): Promise<PiMessage> {
    return this.sendCommand('abort')
  }

  steer(content: string): Promise<PiMessage> {
    return this.sendCommand('steer', buildSteerParams(content))
  }

  followUp(content: string): Promise<PiMessage> {
    return this.sendCommand('follow_up', buildFollowUpParams(content))
  }

  setModel(provider: ProviderId, modelId: string): Promise<PiMessage> {
    return this.sendCommand('set_model', { provider, modelId })
  }

  setThinkingLevel(level: string): Promise<PiMessage> {
    return this.sendCommand('set_thinking_level', { level })
  }

  /**
   * 设置 pi session 名（set_session_name）。
   *
   * W1（数据源治理）：活跃 session 的 label 持久化唯一写入口——pi 内部经
   * sessionManager.appendSessionInfo 落盘 + 广播 session_info_changed，取代 xyz
   * 直写 session JSONL（消除与 pi 进程内 rename-session 扩展的 last-write-wins 竞争）。
   * success:false / 超时由 sendCommand 既有约定 reject（调用方决定失败语义）。
   */
  setSessionName(name: string): Promise<PiMessage> {
    // L6：set_session_name 是毫秒级 RPC（pi 内存缓冲 append），用 FAST_TIMEOUT_MS 快速失败
    return this.sendCommand('set_session_name', { name }, FAST_TIMEOUT_MS)
  }

  /** [DEAD] pi get_messages 死路径——生产零调用（session-service.getHistory 走 client.getEntries entry 树重建）。
   *  保留供未来扁平 message 列表场景；删除前确认无 mock/测试依赖。 */
  getHistory(): Promise<PiMessage> {
    return this.sendCommand('get_messages')
  }

  /**
   * 拉取 pi session 的完整 entry 树（get_entries RPC）。
   *
   * 与 getHistory（get_messages，只返回扁平 message 列表）不同：get_entries 返回全部 entry 类型
   * （message/custom/label/compaction/branch_summary/...），含 parentId 树结构。
   * entry-tree-builder 用 message entry + "xyz.client-msg-id" custom entry 重建结构化 Message[]。
   *
   * since 可选：传 entry id 时返回该 entry 之后的 entry（增量拉取，pi 找不到 since id 会报错）。
   * 返回的 PiMessage.data 已由 sendCommand 归一（data ?? payload），调用方按 GetEntriesResponse 断言。
   */
  getEntries(since?: string): Promise<PiMessage> {
    return this.sendCommand('get_entries', since !== undefined ? { since } : {})
  }

  async compact(customInstructions?: string): Promise<PiCompactionResult> {
    // timeout-slow-flow-wallclock D3：压缩是 LLM 调用链（分钟级），超时回归自有常量
    // COMPACT_RPC_TIMEOUT_MS（30min，shared SSOT）——不再与 bash 共用（300s 前科已由 D2 拆除），
    // renderer backstop 引同一常量 + RENDERER_RPC_MARGIN_MS（编译期对齐，恒不先于本层判死）。
    const msg = await this.sendCommand('compact', customInstructions ? { customInstructions } : {}, COMPACT_RPC_TIMEOUT_MS)
    return msg.data as unknown as PiCompactionResult
  }

  /**
   * 直接执行 bash 命令（pi bash RPC）。
   *
   * excludeFromContext 透传规则：undefined 时不传该键（走 pi 默认），显式 true/false 时透传。
   * bash 是任务级慢速流（合法耗时可达小时级），超时用独立常量 BASH_RPC_TIMEOUT_MS（1h，
   * env `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS` 可覆盖、0=不限时——resolveBashRpcTimeoutMs），
   * 不再复用 compact 的 300s 常量（timeout-slow-flow-wallclock D2：跨粒级挪用是 `!sleep 320`
   * 误杀的根因）。超时语义是「停止等待」非「处决」：不自动 abort_bash，pi 侧照常执行落盘。
   * 返回值归一为 PiBashResult（sendCommand 已归一 data ?? payload，此处按结构断言）。
   */
  async bash(command: string, excludeFromContext?: boolean): Promise<PiBashResult> {
    const args = excludeFromContext !== undefined ? { command, excludeFromContext } : { command }
    const msg = await this.sendCommand('bash', args, resolveBashRpcTimeoutMs())
    // [W6] shape guard：pi 返回 malformed 数据时 fallback，避免下游因 undefined 字段崩溃。
    // [S1] fallback 不用 exitCode:1（会被前端误读为「命令失败」，实为 pi 协议异常），
    // 改用 exitCode:undefined（PiBashResult.exitCode 类型 number|undefined，dispatcher 广播时
    // `?? null` 归一为 null，前端 BashOutputBlock 渲染为「无 exit code」而非「失败」），
    // 并在 output 写诊断提示让用户可见协议异常（而非空 output 静默吞错）。
    const data = msg.data as Record<string, unknown> | undefined
    if (typeof data !== 'object' || data === null || !('output' in data)) {
      console.warn('[rpc] bash: malformed PiBashResult from pi, using fallback. data=', msg.data)
      return { output: '[protocol error: malformed bash response from pi]', exitCode: undefined, cancelled: false, truncated: false }
    }
    return data as unknown as PiBashResult
  }

  /** 取消进行中的 bash 执行（pi abort_bash 命令）。 */
  abortBash(): Promise<PiMessage> {
    return this.sendCommand('abort_bash')
  }

  /**
   * Clear is not directly supported by pi RPC. Use new_session instead.
   * Kept for API compatibility — creates a new session.
   */
  clear(): Promise<PiMessage> {
    return this.sendCommand('new_session')
  }

  async getCommands(): Promise<PiCommandInfo[]> {
    // L6：getCommands 是毫秒级操作，用 FAST_TIMEOUT_MS（10s）替代默认 60s，失败更快报错
    const msg = await this.sendCommand('get_commands', {}, FAST_TIMEOUT_MS)
    // 透传 pi RpcSlashCommand 的完整结构（含 sourceInfo），消费方按需取用
    return (msg.data?.commands as PiCommandInfo[]) ?? []
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const msg = await this.sendCommand('get_session_stats')
    return (msg.data ?? {}) as PiSessionStats
  }

  /** 切换 pi 进程到指定 session 文件（restore / fork 用）。 */
  switchSession(sessionPath: string): Promise<void> {
    // D6-④：崩溃取证上下文——已知历史文件路径（restore/fork 附着目标）。
    this.attachedSessionFile = sessionPath
    // L6：switchSession 加载大 session 文件可能耗时，用 SLOW_TIMEOUT_MS（120s）避免误超时。
    // [pi 锚点] switch_session 是永久重绑读写目标——pi-mono coding-agent/src/core/
    // agent-session-runtime.ts switchSession（~:194-215，open 新 SessionManager →
    // teardownCurrent → createRuntime 重绑）+ core/session-manager.ts `sessionFile`
    // 字段（_setSessionFile :895-896 永久持有，_persist 每轮 appendFileSync 该路径）。
    // 故 switchSession 成功后紧随的 get_state（model/thinkingLevel 读回，restore-seeding
    // 播种依赖）返回的是新 session 的生效值（clone v0.84.2 核对，实装 0.84.4）。
    // switch_session 仅主 agent 消费（subagent 续聊走 spawn --session 直续，见 pi-rpc README）。
    return this.sendCommand('switch_session', buildSwitchSessionParams(sessionPath), SLOW_TIMEOUT_MS).then(() => undefined)
  }

  /** 查询 pi session 状态（get_state），返回归一后的 state 对象（sendCommand 已归一 data ?? payload）。 */
  async getState(): Promise<Record<string, unknown> | undefined> {
    // L6：getState 是毫秒级操作，用 FAST_TIMEOUT_MS（10s）替代默认 60s
    const data = (await this.sendCommand('get_state', {}, FAST_TIMEOUT_MS)).data
    // D6-④：崩溃取证上下文——get_state 是 attach 序列恒经 RPC，响应携带生效中的
    // sessionFile（绝对路径）。字符串形态才记录（异常响应不覆盖已有值）。
    if (typeof data?.sessionFile === 'string' && data.sessionFile.length > 0) {
      this.attachedSessionFile = data.sessionFile
    }
    return data
  }

  /**
   * 取 pi 合并模型清单快照（get_available_models RPC，U5 能力注册表在线对账数据源）。
   *
   * 返回 pi 进程内视角的可用模型全集（内置 catalog ∪ models.json 自定义 ∪
   * models-store 远端目录刷新合并），元素是 pi-ai Model 经本层翻译的内部类型
   * AvailableModelSnapshot（含 reasoning/thinkingLevelMap）——services/model-capability.ts
   * 的 runCapabilityReconcile 用它检测配置聚合与 pi 运行态的漂移（配置有而 pi 无 /
   * reasoning 不一致 / 大小写孪生）。毫秒级内存快照，FAST_TIMEOUT_MS 即可；
   * malformed 响应抛错由对账层降级捕获（避免误判为全量漂移）。
   */
  async getAvailableModels(): Promise<AvailableModelSnapshot[]> {
    const msg = await this.sendCommand('get_available_models', {}, FAST_TIMEOUT_MS)
    const models = msg.data?.models
    if (!Array.isArray(models)) {
      throw new Error('[rpc] getAvailableModels: malformed response from pi (data.models is not an array)')
    }
    return models as AvailableModelSnapshot[]
  }

  /**
   * 向 pi 发送 extension_ui_response（extension UI 请求 / bridge 请求的响应）。
   *
   * pi 对 extension_ui_response 不回 RPC reply（rpc-mode.ts 直接 resolve pending 后 return），
   * 故用 sendRaw 写入（不等 reply，不注册 pending，避免 60s timer 泄漏）。
   *
   * payload 格式（吸收 extension-message-handler 的 buildExtensionUiResponse 映射）——
   * pi 鸭子类型字段检测（rpc-mode.ts:136-149）：
   *    - response === null → {id, cancelled:true}（取消 / 超时）
   *    - method === 'confirm' → {id, confirmed:boolean}
   *    - 其余（select/input/editor）→ {id, value:string}（对象经 String 会变
   *      '[object Object]'，调用方传对象前必须自行 JSON.stringify——设计
   *      bridge-rewrite-pi-0.84 §3.3-D1 序列化陷阱）
   *
   * 判定优先级：null（取消）> confirm > value。
   * [HISTORICAL] 旧 bridge 场景的 `{id, response}` 包裹分支（method===undefined 且
   * response 是对象）已删除：唯一调用方 bridge-handler 已全改 stringify+'select'，
   * 该形态无生产调用方。
   */
  sendExtensionUiResponse(id: string, response: unknown, method?: string): void {
    // 判别与 payload 构造（pi-rpc commands：null > confirm > value 优先级 + 鸭子类型
    // 字段映射）——序列化陷阱与历史背景见公共包 commands.ts 头注。
    this.sendRaw(JSON.stringify(buildExtensionUiResponsePayload(id, response, method)))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async kill(): Promise<void> {
    if (!this.proc || this._exited) return

    this._killing = true

    // 杀链（pi-rpc kill-chain 部件）：SIGCONT（唤醒 SIGSTOP 冻结形态，对运行中进程
    // 无副作用）→ SIGTERM → grace（缺省 2s，与迁移前 KILL_TIMEOUT_MS 等值）→ SIGKILL
    // + resolve（不等收尸，exit handler 由进程生命周期接手）。
    // exit 安全网：_killing=true 使 exit handler 跳过 rejectAll，此处 onExit 回调统一
    // 清 pending——调用方不必等各自的 60s 超时。
    return killPiProcess(this.proc!, {
      onExit: () => this.rejectAll(new Error('pi process killed')),
      onEscalate: () => console.warn('[rpc] SIGKILL after timeout'),
    })
  }
}
