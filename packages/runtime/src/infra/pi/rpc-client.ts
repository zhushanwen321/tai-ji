import { spawn, type ChildProcess } from 'node:child_process'
import { getPiAgentDir } from './pi-paths.js'
import { redactArgv } from './argv-redact.js'
import { recordSpawnMarkers } from './spawn-markers.js'
import { getDefaultModel } from './pi-provider-store.js'
import type { ProviderId } from '@taiji/shared'
// B3 出站契约唯一构建器（U3 收口点；实现本体在 @taiji/shared，此处走 runtime 门面）
import { buildOutboundChildEnv } from '../spawn-env.js'
import type { IPiEngine, PiSessionStats, PiCompactionResult, PiBashResult, PiCommandInfo } from '../../services/ports/pi-engine.js'
import { createPiSessionLog, writePiCrashLog, captureMemorySnapshot, type PiSessionLog, type PiCrashContext } from '../logger.js'
import { captureMachinePiSnapshotSection, collectUnifiedLogCorrelation } from '../crash-correlation.js'
// pi 进程 RPC 公共层（@zhushanwen/pi-rpc；设计 docs/architecture/subagent-permanent-session-model.md
// §3.3.2，G5 收敛）：argv 构造 / LF-only 行分帧 / pending 表（请求-响应配对）/
// 早期帧缓冲 / 命令帧组装 / 杀链 / 出站 env 组装全部 import 自公共包——本文件保留
// 进程生命周期编排与 runtime 专属语义（活动时钟 / 崩溃取证 / stderr 收集 / 日志落盘），
// 协议机制零独立副本（S7 grep 无双轨门）。行为逐字等价迁移（U1 先并存后切换）。
//
// 退役登记（ADR-0122 防御机制清查，2026-10-05）：RPC 墙钟超时（L6 分级 CMD/FAST/SLOW
// 与任务级 bash 1h / compact 30min，推翻 timeout-slow-flow-wallclock D2/D3 量级校准）
// 与 timedOutIds 迟到响应丢弃（S6）已整体删除——pi 对 RPC 永不响应时调用方 promise
// 悬挂，失败信号归 pi exit/error 事件链（rejectAll + notifyExitOnce）。
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
  type PiMessage,
  type PiEventListener,
} from '@zhushanwen/pi-rpc'
import { parseInputDisposition } from './pi-protocol.js'

// 协议类型与 LF-only 行分帧 re-export：既有消费方（event-adapter / 测试）的 import
// 路径 'rpc-client.js' 保持不变；实现本体在 @zhushanwen/pi-rpc（无独立副本）。
export type { PiMessage, PiEventListener } from '@zhushanwen/pi-rpc'
export { attachLfOnlyLineReader } from '@zhushanwen/pi-rpc'

/**
 * pi get_available_models 返回的模型元素（pi-ai Model 翻译为内部消费形状的子集：
 * id/provider/reasoning/thinkingLevelMap，对账所需字段）。
 *
 * 非 Pi 前缀命名：本类型会被 services/model-capability.ts 消费——PiXxx 命名只许
 * 留在 infra/pi 内部（check_pi_type_leak / runtime-layering 边界规则），
 * 对上导出的翻译类型用内部命名（pi-events 翻译范式）。
 */
export interface AvailableModelSnapshot {
  id: string
  /** pi Model.provider（provider id，如 'zai-coding-cn'）。 */
  provider: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

/**
 * pi 队列级原语 clear_queue 的响应形状（语义登记 PS-65，verifiedWith 以 pi-semantics.json
 * 为准：dist `agent-session.js clearQueue()` 返回 `{steering, followUp}` 两队列**全文数组**
 * ——`_steeringMessages` / `_followUpMessages` 的浅拷贝，元素是入队时的整段文本）。
 *
 * 这是「队列级」原语：pi 不提供条目级收回（出队判定本身就是按全文 indexOf 匹配，无 id，
 * PS-64），故投递所有权内核的收回路径 = 全收 → 上层按裸标记识别目标条目 → 其余文本重投
 * （设计 delivery-ownership-kernel.md §3.1 场景 D / D3）。
 */
export interface PiQueueSnapshot {
  /** steering 队列全文（入队序）。 */
  steering: string[]
  /** followUp 队列全文（入队序）。 */
  followUp: string[]
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
  /**
   * 替换 pi 核心系统提示词（走 --system-prompt CLI）。空白时不传。
   *
   * [HISTORICAL] 原注释称本 flag「仅新建会话生效」——不准确。实测 pi 在**每次进程启动**
   * 都读取该 flag（restore/resume/switch_session 路径每次附着都会重新 spawn 一个 pi 进程，
   * 故 CLI 值同样生效）。这正是 D1「提示词是活定义」语义的依据：restore/fork 不必重写
   * session 文件，靠 spawn argv 即可让当前生效的提示词落地。
   * 内联值由 spawn-args 加 \n 前缀（pi 二义陷阱，见 spawn-args.toInlinePromptValue）。
   */
  systemPrompt?: string
  /**
   * 追加在 pi 基础系统提示词之后（走 --append-system-prompt CLI；与 --system-prompt 同解析路径）。
   * 空白时不传；内联值同经 spawn-args 加 \n 前缀。
   */
  appendSystemPrompt?: string
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
  /** 禁用 context files（AGENTS.md 自动发现），映射 pi `--no-context-files`。 */
  noContextFiles?: boolean
  /** 覆盖思考级别，映射 pi `--thinking <level>`（注意：非 --thinking-level，附录 A.4）。 */
  /**
   * 档位字符串透传（非空即发）；合法性由上游入口层校验（runtime launch-params
   * resolveEffectiveThinking，词表 = shared PI_THINKING_LEVELS），本层不重复校验。
   * 不可把「pi 会拒绝非法档位」当兜底依赖——pi 对非法 --thinking 仅 push
   * warning diagnostic 并丢弃档位、进程照常以缺省档启动（pi 1.0.0 实装复核：
   * dist/cli/args.js `--thinking` 分支 isValidThinkingLevel 未命中仅 push warning；
   * 仅 diagnostics 存在 type==="error" 才 exit：dist/main.js）。
   */
  thinkingLevel?: string
}

// 超时分级常量（L6）已随 ADR-0122 防御机制清查退役（见文件头退役登记）；
// 早期帧缓冲上限（EARLY_FRAME_BUFFER_MAX）由 buffer 部件内部持有。
// 杀链走 killPiProcess（SIGKILL 直杀，grace 等待窗已退役）。
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

/** pi stdout 行分帧等场景的未知值 → 字符串数组归一（非数组 / 非字符串元素一律丢弃）。 */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

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
 * RPC 超时错误（integrity-hardening D3a）已随墙钟超时机制退役（ADR-0122）：
 * RpcTimeoutError 不再被本模块构造，类本体保留在 utils/errors.ts 供历史错误反序列化。
 */

export class RpcClient implements IPiEngine {
  private proc: ChildProcess | null = null
  /**
   * RPC pending 表（请求-响应配对）——@zhushanwen/pi-rpc frame 部件。
   * 无墙钟超时（ADR-0122 退役，见文件头）：失败信号归 pi exit/error 事件链 rejectAll。
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
   * exitCallbacks 多播是否已发（RT-2#6）：proc 'error' 与 'exit' 合并为单一 terminate
   * 出口后，运行中 error 先通知、exit 随后到场的形态需要幂等守卫防双发（spawn 失败
   * 形态只有 error 无 exit，本守卫不影响其必达）。
   */
  private _exitNotified = false
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

  // ── 崩溃取证上下文（crash-resilience §3.3 D6-④）：崩溃时刻 writeCrashLogIfNeeded
  // 采集进 pi-crash log 头部的 runtime 侧字段。未知保持 null（显式落盘「没采到」）。
  /** 最后一次发出的 RPC 命令类型（sendCommand 唯一写点；崩溃时即「死前最后动作」）。 */
  private lastCommandType: string | null = null
  /** spawn 完成（awaitStartupSettled 通过）时刻 ms；uptimeMs = 崩溃时刻 - 本值。 */
  private spawnedAt: number | null = null
  /**
   * 已知 pi 历史文件绝对路径：switch_session 参数（restore/fork 路径）或 get_state
   * 返回的 sessionFile（attach 序列恒调）任一发生过。新建 session 在 pi 首次 flush
   * （user/assistant 首消息后，pi 1.0.0 起 user 消息即建文件——仓规 #6）前文件可能
   * 不存在，runtime 不探测文件系统，未知即 null。
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
    // buildOutboundChildEnv（deny 兜底剥 TAIJI_AGENT_PACKAGED/TAIJI_RUNTIME_TOKEN 语义不变），
    // extras 过滤 + TAIJI_AGENT_EXT_LOG 恒注入 + PI_CODING_AGENT_DIR 隔离（<dataDir>/agent/）。
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
    // 这样 pi 的初始 session、system prompt、AGENTS.md 查找、bash 工具都基于正确的 cwd。
    // Re-verified 2026-08-20 (W6 A-11 探针) on upstream 0.84.1，双形态均不依赖 cwd：
    // - bun binary（打包产物 apps/electron/resources/pi/pi-darwin-arm64）：getPackageDir() =
    //   dirname(process.execPath)（pi 0.84.1 dist config.js isBunBinary 分支）；cwd=/tmp spawn
    //   --version 输出 0.84.1 正常，资源布局 binary 同目录 theme/package.json 与该分支一致。
    // - node dist（dev 形态）：从 __dirname 向上找 package.json（config.js getPackageDir Node 分支），
    //   实测 cwd=HOME//tmp//usr 三种 cwd 下 getPackageDir/getThemesDir 返回完全一致。
    const spawnCwd = this.options.cwd ?? process.cwd()

    // argv 回显脱敏（设计 `mode-system-composer-density` §7.2 argv 日志脱敏
    // / §7.6 写入面 / 探针 P15）：两个提示词 flag 的值只记 `<N chars>`，防 16k 正文落日志。
    console.log('[rpc] spawning pi:', piCmd, redactArgv(args), 'cwd:', spawnCwd)

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
      // respawn 边界行：同 session 的 pi 进程可能多次 spawn（runtime 重启后 restore /
      // 崩溃重拉），tee 是 append 模式，无边界行时无法从文件内区分代际——排障时
      // 「崩溃前最后输出」与「重启后首输出」会混读（2026-09-24 事故取证的实测痛点）。
      // 下划线前缀 type 与 pi 自身事件命名空间区分，消费方按未知类型忽略。
      this.piSessionLog.write(
        JSON.stringify({
          type: '_spawn_boundary',
          ts: new Date().toISOString(),
          runtimePid: process.pid,
          sessionId: this.options.sessionId,
        }) + '\n',
      )
    }

    const proc = this.proc
    this.wireProcessHandlers(proc)
    // 启动确认窗（awaitStartupSettled 500ms）已随 ADR-0122 防御机制清查退役：
    // spawn 后立即崩溃 / ENOENT 由 wireProcessHandlers 接线的 exit/error 事件链
    // 上报（rejectAll + notifyExitOnce → 上层 onSessionExit 收敛），不做「活了
    // 500ms 就不会立即崩」的时间窗猜测。
    // D6-④：spawn 后记 uptime 起点（立即崩溃的进程 uptimeMs 极小，仍为有效观测值）。
    this.spawnedAt = Date.now()
  }

  /**
   * start 的进程事件接线（error / exit / stdout JSONL 解析 / stdout+stdin+stderr stream error /
   * stderr 全量收集）。注册顺序：error → exit → readline line → stdout error
   * → stdin error → stderr data/error。
   */
  private wireProcessHandlers(proc: ChildProcess): void {
    proc.on('error', (err) => {
      console.error('[rpc] process error:', err)
      this.terminateFromError(err)
    })

    proc.on('exit', (code) => {
      this._exited = true
      console.log(`[rpc] process exited with code ${code}`)
      this.piSessionLog?.end()
      this.piSessionLog = null
      // Only reject pending requests on unexpected exits.
      // For normal kill flow (_killing=true), rejectAll is called in kill()
      // via a separate safety net so callers don't hang forever.
      if (!this._killing) {
        this.writeCrashLogIfNeeded(code)
        this.rejectAll(new Error(`pi process exited with code ${code}${this.formatStderrSuffix()}`))
        this.notifyExitOnce(code, this.getStderrTail())
      }
    })

    // Parse stdout JSONL（D10：LF-only 读取器，U+2028/U+2029 不拆帧——pi rpc/jsonl.js 帧协议的对端）
    // stdout error 防护由下方 stream error 统一接线承接（2026-09-04 事故审计：pi 崩溃/被杀时
    // 管道流错误无 listener 会升级成 uncaughtException → 整机 shutdown；attachLfOnlyLineReader
    // 只挂 data/end）；pi 退出处置归 exit/kill 链路，此处只堵转发逃逸。
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

    // W2：stdout/stdin/stderr 三个 stream 的 'error' 统一接线（handleStreamError 单实现）。
    // 为什么必须在源头接线：proc.on('error') 只覆盖 spawn 失败；stdout/stderr 是独立
    // Readable stream，pi 崩溃 / 管道断裂（EPIPE / ECONNRESET）时它们各自 emit 'error'，
    // 若无 listener 则升级为 uncaughtException → runtime 主进程崩溃（2026-09-04 stdout
    // 事故）。stdin 是 runtime → pi 的唯一写入面（sendCommand / sendRaw）；pi 半关闭
    // （写端已死）或崩溃后再写 stdin，流错误（EPIPE / ERR_STREAM_DESTROYED）异步 emit
    // 到 stdin——写调用本身不抛，try/catch 接不住；若无 listener 会被 uncaught-policy
    // log-continue 吞掉：_exited 不置位、pending 不 reject、自愈强杀不触发 → 后续每条
    // RPC 各挂满超时且误归因「pi 无响应」（RT-2#1）。故三个流都必须在源头接线，不得
    // 依赖 uncaught-policy 兜底。
    //
    // 管道断裂但进程可能仍存活（孤儿泄漏）：handleStreamError 内 SIGKILL 加速其死亡，
    // 让 proc.on('exit') 作为死亡通知的唯一出口（避免「stream error 通知 + exit 通知」
    // 双触发）。刻意调 ChildProcess 原生 kill 而非 this.kill()：后者置 _killing=true，
    // exit 处理器会跳过 exitCallbacks —— 死亡通知整条丢失。
    proc.stdout?.on('error', (err: NodeJS.ErrnoException) => this.handleStreamError('stdout', err))

    proc.stdin?.on('error', (err: NodeJS.ErrnoException) => this.handleStreamError('stdin', err))

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
      proc.stderr.on('error', (err: NodeJS.ErrnoException) => this.handleStreamError('stderr', err))
    }
  }

  /**
   * 三个 stream（stdout/stdin/stderr）'error' 的统一处置（W2，单实现收敛自三块近似复制）：
   * console.error 留痕 → 置 _exited → rejectAll pending → SIGKILL 加速进程死亡。
   * 注册点语义与降级理由见 wireProcessHandlers 内 stream error 接线段注释。
   */
  private handleStreamError(stream: 'stdout' | 'stdin' | 'stderr', err: NodeJS.ErrnoException): void {
    console.error(`[rpc] ${stream} stream error:`, err)
    this._exited = true
    this.rejectAll(new Error(`pi ${stream} stream error: ${err.message}`))
    this.killProcAfterStreamError(stream)
  }

  /**
   * stream error 后 SIGKILL 加速进程死亡（W2，死亡通知唯一出口语义）——
   * 细节与降级理由见 wireProcessHandlers 内 stream error 接线段注释。
   */
  private killProcAfterStreamError(stream: 'stdout' | 'stderr' | 'stdin'): void {
    try {
      this.proc?.kill('SIGKILL')
    } catch (e) {
      // best-effort 降级：kill 抛错说明进程已死，exit 事件已/将至并走唯一出口，无需传播
      console.error(`[rpc] SIGKILL after ${stream} stream error failed (process may already be dead):`, e)
    }
  }

  /**
   * 进程级 'error' 的终止处置（RT-2#6）——与 exit 合并为单一 terminate 出口。
   *
   * 此前 error handler 只 rejectAll：spawn 失败（ENOENT 等）不 emit 'exit'，piSessionLog
   * 的 fd 悬挂、exitCallbacks 永不触发（ProcessManager 会话表收不到死亡通知）。现补齐
   * exit 处置链的全部收口（对齐批次 3 stdin stream error 的完整处置链口径：_exited 置位
   * + rejectAll 必达）；运行中 error 后 exit 若仍到场，各步幂等（piSessionLog 已置 null /
   * rejectAll 空表 no-op），exitCallbacks 通知由 notifyExitOnce 幂等守卫防双发。
   * _killing 语义与 exit handler 对齐：主动 kill 流程不发死亡通知（kill() 的 onExit
   * rejectAll 统一收口）。
   */
  private terminateFromError(err: Error): void {
    this._exited = true
    this.piSessionLog?.end()
    this.piSessionLog = null
    if (!this._killing) {
      this.writeCrashLogIfNeeded(null)
      // 错误消息保留 err.message 原文（Node spawn ENOENT 的 message 自带 'spawn ... ENOENT'，
      // ProcessManager.createSession 的安装指引匹配（includes('spawn')/includes('ENOENT')）不依赖本前缀）
      this.rejectAll(new Error(`pi process error: ${err.message}${this.formatStderrSuffix()}`))
      this.notifyExitOnce(null, this.getStderrTail())
    }
  }

  /**
   * exitCallbacks 多播唯一出口（exit 与 process error 共用，RT-2#6）。幂等：第二次调用
   * no-op（先发的通知生效）。逐回调隔离（对齐 ProcessManager RT-4#1 范式）：单回调异常
   * 只降级日志，不阻断其余回调多播，也不让异常冒泡成 EventEmitter uncaughtException。
   */
  private notifyExitOnce(code: number | null, stderr: string): void {
    if (this._exitNotified) return
    this._exitNotified = true
    for (const cb of this.exitCallbacks) {
      try {
        cb(code, stderr)
      } catch (e) {
        // 降级策略：逐回调隔离（对齐 ProcessManager RT-4#1 范式）——单回调异常只留痕，
        // 其余回调多播必达（上层 onSessionExit 收敛链依赖通知），不向 EventEmitter 传播
        // （handler 内抛错会升级为 uncaughtException 炸掉 runtime 主进程）。
        console.error('[rpc] exit callback failed:', e)
      }
    }
  }

  private handleMessage(msg: PiMessage): void {
    // 入站 touch：任何 stdout 帧（response / 事件）都证明 pi 在产出——活动时钟
    // 供崩溃取证（pi 死前最后活动时刻）等观测面消费。
    this._lastActivityAt = Date.now()
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
    if (msg.type === 'response' && msg.id && this.pendingRegistry.resolveResponse(msg.id, msg)) {
      return
    } else if (this.listeners.size === 0 && !this.earlyFrameBuffer.closed) {
      // 早期帧缓冲（early-frame-buffer D1）：listener 空窗（spawn → EventAdapter attach）
      // 期间的非 response 帧不再无条件丢弃，入 FIFO 待首个 listener 注册时重放。
      // 缓冲已关闭后 listeners 再空集（detach 形态）落回本行 else 直通丢弃 = 现状语义。
      this.earlyFrameBuffer.push(msg)
    } else {
      // RT-2#3：per-listener 隔离——此前首个 listener（EventAdapter 翻译链）抛错会
      // 中断循环：本帧对后续 listener（handoff 的 agent_end 探测）整帧丢失。降级策略
      // 见循环内 catch 注释。
      for (const listener of this.listeners) {
        try {
          listener(msg)
        } catch (e) {
          // 降级策略：per-listener 隔离（对齐 replayEarlyFrameBuffer 的 D5 范式）——
          // 单 listener throw 只 console.error 留痕，循环继续投递其余 listener（多播必达），
          // 不向 readline line handler 传播（传播会被记「stdout parse error」且丢帧）。
          console.error('[rpc] listener threw on frame (isolated, continuing):', e)
        }
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
   * 向 pi stdin 写入一行原始 JSON，不注册 pending、不等 RPC reply。
   *
   * 用于 pi 不回复 `{type:'response'}` 的命令（目前仅 `extension_ui_response`——
   * pi 1.0.0 dist/modes/rpc/rpc-mode.js handleInputLine 的 extension_ui_response
   * 分支 resolve pendingExtensionRequests 后直接 return，不回 RPC 确认）。
   * 用 sendCommand 会导致 pending 永不 resolve → 60s CMD_TIMEOUT_MS 后才超时（timer
   * 泄漏 + 无用等待）。
   *
   * 注意：调用方自行保证 JSON 格式正确 + 换行符结尾。
   *
   * 返回 boolean（false = 未送达：pi 进程不在/已退出，或 stdin 写抛错——流已损坏）。
   * 该应答在 pi 侧没有对应 RPC pending（pi 不回确认），无法以 reject 收口，false 是
   * 唯一的失败信号——调用方必须消费它走可感知失败路径（终结请求 + 上行错误），
   * 不允许静默丢弃；错误日志已在函数内留痕（经 logger.patchConsole tee 落 runtime 日志）。
   */
  sendRaw(data: string): boolean {
    if (!this.proc || this._exited) {
      console.error('[rpc] sendRaw failed: pi process is not running')
      return false
    }
    const line = data.endsWith('\n') ? data : data + '\n'
    try {
      this.proc.stdin!.write(line)
    } catch (e) {
      // 同步 write 抛错 = 流已销毁/半关闭（EPIPE 族），重抛只会炸掉 handler 链且无处可
      // 恢复；false 返回值即失败传播通道，由调用方决定终结语义（no-silent-catch：非吞错）。
      console.error('[rpc] sendRaw write failed:', e)
      return false
    }
    return true
  }

  sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiMessage> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this._exited) {
        return reject(new Error('pi process is not running'))
      }

      const id = this.nextId()
      const msg = JSON.stringify({ id, type, ...params }) + '\n'

      // D6-④：崩溃取证「死前最后动作」。sendCommand 是全部 RPC 的唯一入口，
      // 记录点在 pending 注册前——即使进程在写 stdin 后立刻死亡，字段已就位。
      this.lastCommandType = type

      // 出站 touch：sendCommand 是全部出站 RPC 的唯一咽喉。touch 在状态检查后：
      // 进程已死时无活动可言。
      this._lastActivityAt = Date.now()

      // pending 注册（pi-rpc registry 部件）。无墙钟超时（ADR-0122 退役，见文件头）：
      // pi 对该命令永不响应时 promise 悬挂，失败信号归 pi exit/error 事件链 rejectAll。
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
              // disposition 出口统一解析并挂载（B3 传递）：仅 prompt/steer/follow_up 响应
              // 携带该字段；解析出值才挂键，其余命令响应保持无键（上层 undefined 即缺失语义）。
              const disposition = parseInputDisposition(res)
              if (disposition !== undefined) res.disposition = disposition
              resolve(res)
            }
          },
          reject,
        },
      )

      try {
        console.log('[rpc] send: type=' + type)
        this.proc.stdin!.write(msg)
      } catch (e) {
        this.pendingRegistry.cancel(id)
        reject(new Error(`Failed to write to pi stdin: ${e}`))
      }
    })
  }

  /**
   * Register a callback for when the pi process exits unexpectedly. stderr 为 pi 进程尾部输出。
   * 多播（可多订阅者，后注册者不再覆盖先注册者），返回 unsubscribe（与 onEvent 对称）。
   * 每个进程恰好通知一次：出口 = proc 'exit' 与 proc 'error'（RT-2#6 合并为单一 terminate
   * 出口，notifyExitOnce 幂等防双发；stream error 只 kill 不通知，死亡通知仍由 exit 承载）；
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
   * 触发条件：code≠0 且非主动 kill（调用点在 exit handler 与 terminateFromError 的
   * !this._killing 分支内；process error 路径传 code=null）。
   * code=null（信号死亡 / spawn 失败的 process error，如管道断裂后的 SIGKILL）同属异常退出，落盘。
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
      // D10：崩溃关联取证——①同步机器面 pi 快照（同秒连坐的幸存者视图）+ ②异步统一日志
      // 关联采样（±5s 窗内的 Electron 退出 / 兄弟 pi 死亡 / launchd 信号，fire-and-forget
      // 完成后补写进同一 pi-crash log，append 语义）。两者内部均以 isPiCrashLogEnabled
      // 为门（无 sink 不采样），且全捕获不向上抛——观测增强不得影响 exit 主流程。
      this.appendCrashCorrelationEvidence()
    } catch (crashErr) {
      // best-effort：崩溃日志落盘失败不掩盖/干扰原始崩溃路径（exit code 已由上层消费），仅控制台留痕
      console.error('[rpc] write pi crash log failed:', crashErr)
    }
  }

  /**
   * 崩溃关联取证补写（crash-forensics-and-watchdog §3.3 D10，crash-correlation.ts）。
   *
   * ①同步：机器面 pi 快照 section（~10ms，ps 枚举 taiji 家族幸存者 + ppid 归属）；
   * ②异步：统一日志关联采样（darwin-only，±5s 窗，log show 最多 10s）完成后追加写
   * 同一 pi-crash log——写点在本方法返回后数秒，靠 writePiCrashLog 的 append 语义与
   * createPiStreamWriter 惰性打开落盘（closeLogger 退出 flush 覆盖晚到的补写）。
   * 全路径 best-effort：任何失败仅 console 出声（tee 进 runtime 主日志），不抛。
   */
  private appendCrashCorrelationEvidence(): void {
    const sid = this.options.sessionId
    try {
      const snapshot = captureMachinePiSnapshotSection(process.pid)
      if (snapshot) writePiCrashLog(sid, snapshot)
    } catch (snapshotErr) {
      // best-effort 降级：快照失败不影响 exit 主流程（exit code 已由上层消费），
      // 仅 console 留痕（tee 进 runtime 主日志）——对齐 writePiCrashLog 失败处置先例
      console.error('[rpc] machine pi snapshot failed:', snapshotErr)
    }
    void collectUnifiedLogCorrelation(Date.now())
      .then((section) => {
        if (section) writePiCrashLog(sid, section)
      })
      .catch((correlationErr: unknown) => {
        // best-effort 降级策略：关联采样失败不影响 exit 主流程（exit code 已由上层消费），
        // 仅 console 留痕（tee 进 runtime 主日志）——对齐 writePiCrashLog 失败处置先例
        console.error('[rpc] unified log correlation failed:', correlationErr)
      })
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
  /**
   * 最近一次 pi 双向活动时刻（ms epoch）。
   * 只读暴露：消费方为观测面（crash 取证「死前最后活动时刻」等）。写点集中在
   * RpcClient 内部（出站 sendCommand / 入站 handleMessage），防止时钟被随意重置。
   * 原空闲回收判定（idle-pi-reclamation D1/D6-1 touchActivity + maintenance 豁免）
   * 已随 ADR-0122 防御机制清查退役。
   */
  get lastActivityAt(): number {
    return this._lastActivityAt
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
  prompt(content: string, images?: Array<{ data: string; mimeType: string }>, streamingBehavior?: 'steer' | 'followUp'): Promise<PiMessage> {
    // 帧组装（pi-rpc commands）：images 是 shared 层图片附件形状（无 type 字段），
    // shared→pi ImageContent 的唯一组装点在公共包（pi 私有 type:'image' 不出本层）；
    // 空 images 归一化不传键（避免 pi 收到空数组），与改动前路径完全一致。
    // RPC 墙钟超时档（timeoutMs/options 参数）已随 ADR-0122 退役（见文件头）。
    return this.sendCommand('prompt', buildPromptParams({ message: content, images, streamingBehavior }))
  }

  abort(): Promise<PiMessage> {
    return this.sendCommand('abort')
  }

  /**
   * 清空 pi 的两个内存待注入队列（steer / followUp）并取回全文（PS-65）。
   *
   * 投递所有权内核的收回原语：pi 只有队列级 clear_queue（无条目级收回——出队判定按
   * 全文 indexOf 匹配无 id，PS-64），上层（delivery registry 对账器）据此完成「全收 → 按裸标记
   * 识别 → 自有条目重投 / 外来文本收养」（§3.1 场景 D / D3）。
   *
   * 形状守卫：响应非对象或缺数组字段时归一为空数组（协议异常不炸对账主链——对账器把
   * 「空」解释为「无滞留」，最坏形态是滞留留到下一触发点，而非对账链路抛错）。
   */
  async clearQueue(): Promise<PiQueueSnapshot> {
    const msg = await this.sendCommand('clear_queue')
    const data = msg.data as Record<string, unknown> | undefined
    return {
      steering: toStringArray(data?.steering),
      followUp: toStringArray(data?.followUp),
    }
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
   * sessionManager.appendSessionInfo 落盘 + 广播 session_info_changed，取代旧版直写（taiji W11 前）
   * 直写 session JSONL（消除与 pi 进程内 rename-session 扩展的 last-write-wins 竞争）。
   * success:false 由 sendCommand 既有约定 reject（调用方决定失败语义）。
   */
  setSessionName(name: string): Promise<PiMessage> {
    return this.sendCommand('set_session_name', { name })
  }

  /**
   * 拉取 pi session 的完整 entry 树（get_entries RPC）。
   *
   * 返回全部 entry 类型（message/custom/label/compaction/branch_summary/...），含 parentId
   * 树结构。entry-tree-builder 用 message entry + "taiji.client-msg-id" custom entry 重建
   * 结构化 Message[]。
   *
   * since 可选：传 entry id 时返回该 entry 之后的 entry（增量拉取，pi 找不到 since id 会报错）。
   * 返回的 PiMessage.data 已由 sendCommand 归一（data ?? payload），调用方按 GetEntriesResponse 断言。
   */
  getEntries(since?: string): Promise<PiMessage> {
    return this.sendCommand('get_entries', since !== undefined ? { since } : {})
  }

  async compact(customInstructions?: string): Promise<PiCompactionResult> {
    // 压缩 RPC 墙钟（COMPACT_RPC_TIMEOUT_MS 30min，timeout-slow-flow-wallclock D3）
    // 已随 ADR-0122 退役（见文件头，推翻该量级校准裁决）。
    const msg = await this.sendCommand('compact', customInstructions ? { customInstructions } : {})
    // RT-2#4：形状守卫（bash 式，对照 getAvailableModels）——pi compact 成功响应恒带
    // CompactionResult 对象（rpc-mode.js case "compact" → success(id,"compact",result)），
    // 且三必填字段齐备（pi 1.0.0 dist/core/compaction/compaction.d.ts CompactionResult：
    // summary:string / firstKeptEntryId:string / tokensBefore:number），与 port 契约
    // （services/ports/pi-engine.ts
    // PiCompactionResult）一致。data 缺失/非对象/缺必填字段 = 协议异常。pi 手动 compact 失败
    // 另有 compaction_end{errorMessage} 事件编排（dispatcher 零广播注释），不走本返回值——
    // reject 让协议异常显形而非 undefined 字段渗入消费方。
    const data = msg.data as Record<string, unknown> | undefined
    if (
      typeof data !== 'object' || data === null ||
      typeof data.summary !== 'string' ||
      typeof data.firstKeptEntryId !== 'string' ||
      typeof data.tokensBefore !== 'number'
    ) {
      console.warn('[rpc] compact: malformed response from pi (data is not a CompactionResult with summary/firstKeptEntryId/tokensBefore). data=', msg.data)
      throw new Error('[rpc] compact: malformed response from pi (data is not a CompactionResult with summary/firstKeptEntryId/tokensBefore)')
    }
    return data as unknown as PiCompactionResult
  }

  /**
   * 直接执行 bash 命令（pi bash RPC）。
   *
   * excludeFromContext 透传规则：undefined 时不传该键（走 pi 默认），显式 true/false 时透传。
   * bash RPC 任务级墙钟（BASH_RPC_TIMEOUT_MS 1h + env 逃生门，timeout-slow-flow-wallclock D2）
   * 已随 ADR-0122 退役（见文件头，推翻该量级校准裁决）。
   * 返回值归一为 PiBashResult（sendCommand 已归一 data ?? payload，此处按结构断言）。
   */
  async bash(command: string, excludeFromContext?: boolean): Promise<PiBashResult> {
    const args = excludeFromContext !== undefined ? { command, excludeFromContext } : { command }
    const msg = await this.sendCommand('bash', args)
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

  async getCommands(): Promise<PiCommandInfo[]> {
    const msg = await this.sendCommand('get_commands', {})
    // RT-2#4：形状守卫（bash 式，对照 getAvailableModels）——pi get_commands 恒返回
    // commands 数组（可为空），缺失/非数组 = 协议异常。此前 `?? []` 把协议异常折成
    // 空数组：session-state-projection 的 publishCommandsSnapshot 只挡 undefined，
    // 空数组照发 session.commands → 命令面板静默清空，且「无命令」与「响应畸形」不可分。
    const commands = msg.data?.commands
    if (!Array.isArray(commands)) {
      console.warn('[rpc] getCommands: malformed response from pi (data.commands is not an array). data=', msg.data)
      throw new Error('[rpc] getCommands: malformed response from pi (data.commands is not an array)')
    }
    // 透传 pi RpcSlashCommand 的完整结构（含 sourceInfo），消费方按需取用
    return commands as PiCommandInfo[]
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const msg = await this.sendCommand('get_session_stats')
    // RT-2#4：形状守卫——pi get_session_stats 恒返回 stats 对象（tokens=null 是对象内
    // 字段表达的合法无值态），data 缺失/非对象 = 协议异常。此前 `?? {}` 折空对象，
    // 投影层读不到 contextUsage 被当「无值」处理，协议异常被永久掩盖。
    // 抛错承接：fetchSessionStatsSnapshot 的失败语义 = 实例快照失败退避重试 + 保留旧值。
    const data = msg.data as unknown
    if (typeof data !== 'object' || data === null) {
      console.warn('[rpc] getSessionStats: malformed response from pi (data is not an object). data=', msg.data)
      throw new Error('[rpc] getSessionStats: malformed response from pi (data is not an object)')
    }
    return data as PiSessionStats
  }

  /** 切换 pi 进程到指定 session 文件（restore / fork 用）。 */
  switchSession(sessionPath: string): Promise<void> {
    // D6-④：崩溃取证上下文——已知历史文件路径（restore/fork 附着目标）。
    this.attachedSessionFile = sessionPath
    // [pi 锚点] switch_session 是永久重绑读写目标——pi-mono coding-agent/src/core/
    // agent-session-runtime.ts switchSession（~:194-215，open 新 SessionManager →
    // teardownCurrent → createRuntime 重绑）+ core/session-manager.ts `sessionFile`
    // 字段（_setSessionFile :895-896 永久持有，_persist 每轮 appendFileSync 该路径）。
    // 故 switchSession 成功后紧随的 get_state（model/thinkingLevel 读回，restore-seeding
    // 播种依赖）返回的是新 session 的生效值（clone v0.84.2 核对，实装 0.84.4）。
    // switch_session 仅主 agent 消费（subagent 续聊走 spawn --session 直续，见 pi-rpc README）。
    return this.sendCommand('switch_session', buildSwitchSessionParams(sessionPath)).then(() => undefined)
  }

  /** 查询 pi session 状态（get_state），返回归一后的 state 对象（sendCommand 已归一 data ?? payload）。 */
  async getState(): Promise<Record<string, unknown> | undefined> {
    const data = (await this.sendCommand('get_state', {})).data
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
   * reasoning 不一致 / 大小写孪生）。
   * malformed 响应抛错由对账层降级捕获（避免误判为全量漂移）。
   */
  async getAvailableModels(): Promise<AvailableModelSnapshot[]> {
    const msg = await this.sendCommand('get_available_models', {})
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
   * response 是对象）已删除：唯一调用方（runtime 内部应答通道，随 plugin-bridge 退役
   * 删除）此前已全改 stringify+'select'，该形态无生产调用方。
   *
   * 返回 boolean（false = 未写进 pi stdin，透传 sendRaw 语义）：extension UI 应答
   * 承载用户决策，false 时调用方必须终结该请求并上行带码错误（M1/RT-2#8——此前 void
   * 吞掉写失败，用户点确认后应答静默丢失、pi 侧 Promise 永挂）。
   */
  sendExtensionUiResponse(id: string, response: unknown, method?: string): boolean {
    // 判别与 payload 构造（pi-rpc commands：null > confirm > value 优先级 + 鸭子类型
    // 字段映射）——序列化陷阱与历史背景见公共包 commands.ts 头注。
    return this.sendRaw(JSON.stringify(buildExtensionUiResponsePayload(id, response, method)))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async kill(): Promise<void> {
    if (!this.proc || this._exited) return

    this._killing = true

    // 杀链（pi-rpc kill-chain 部件）：SIGKILL 直杀 + 立即 resolve（不等收尸，exit
    // handler 由进程生命周期接手；grace 优雅退出等待窗已随 ADR-0122 退役）。
    // exit 安全网：_killing=true 使 exit handler 跳过 rejectAll，此处 onExit 回调统一
    // 清 pending——调用方不必悬挂等待。
    return killPiProcess(this.proc!, {
      onExit: () => this.rejectAll(new Error('pi process killed')),
    })
  }
}
