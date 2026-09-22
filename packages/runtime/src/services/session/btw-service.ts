/**
 * BtwService —— btw 旁路提问线的会话生命周期服务（btw-question 设计 D1/D2/D3/D9⑤）。
 *
 * 职责边界（M1-b，SSOT = 实施计划 §2 单元表）：
 *   ✅ 线注册表（内存缓存 + 启动目录扫描重建 + hidden 复原）
 *   ✅ pi 原生 fork 创建（`--fork` + `--session-dir` 双旗标，**不复用 session-fork.ts**
 *      ——后者 root→leaf 单路径截断丢分支，与「完整上下文」裁决冲突）
 *   ✅ 源状态三分支（正常 fork / 源缺失空文件 → 回落无 fork 新建 / 半截 turn 截断快照）
 *   ✅ 线进程生命周期（惰性 spawn / 闲置 30min destroy / 有待处理交互豁免计闲置 /
 *      回收前提醒挂点 onWillReclaim）
 *   ✅ reattach spawn 形态（restore/getHistory 离线腿按 `sessions/` 解析不通用——
 *      findScannedSession 只扫 sessions/，btw 线不在其扫描面，故自建附着编排：
 *      spawn → switch_session → 附着断言 → registerSession）
 *   ✅ `hidden: true` 注册（经既有 registerSession 汇聚点；不写 parentSession 血缘）
 *   ✅ 行为契约注入挂点（D9⑤：线会话建立时注入一次，载体 = spawn
 *      `--append-system-prompt` 组合；**子通道归属随 V6 核实钉固**，oracle =
 *      traceContractInjection 挂点 + spawn options 断言）
 *   ❌ 消息通路（message.send / message.* 复用）归 M2-b；❌ 删除级联 / 孤儿补账 /
 *      派生抑制归 M4-a；❌ 重载回放归 M2-c。
 *
 * 设计前提核实结论（V2，2026-09-22，node_modules 实装 pi 0.84.4 dist 读源 + /tmp
 * fixture 实测探针，命令见实施计划偏差登记）：
 *   ① `--fork` + `--session-dir` 双旗标组合成立：forkFrom 落点吃 sessionDir 参数，
 *      实测 fork 文件落 --session-dir 目录、全树（含分支）逐字节等价、
 *      header.parentSession = 源绝对路径（P-fork-equivalence 实证，206ms）。
 *   ② 单旗标与 RPC new 组合成立：`PI_CODING_AGENT_SESSION_DIR` env（main.js 与
 *      --session-dir 同优先级的等价通道）启动 → get_state/new_session 落点均在该目录
 *      （agent-session-runtime newSession 继承 getSessionDir）。
 *   ③ 回落/重附着 spawn 的 --session-dir 继承成立：env 启动 + switch_session 后
 *      目录语义保持（switch 后 new_session 仍落线目录）；源缺失/空文件 → pi
 *      exit 1「Cannot fork: source session file is empty or invalid」，不产空文件
 *      （P-fork-source 分支② 依据，回落由此在宿主侧显式编排）。
 *
 * V5（附着语义）同步核实：restore 腿 resolveRestoreTarget → findScannedSession 只扫
 * `sessions/`，btw 线目录不在其扫描面 ⇒ restoreSession/getHistory 离线腿对 btw 线不通用，
 * 必须走本文件 attachProcess 自建编排（spawn → switch_session → assertPiSessionFile）。
 * 悬空 tool-call 判「中断 turn」的失效支接线归 M3-c/M4-a（V5 残留项）。
 *
 * 关键红线呼应（AGENTS.md 关键规则）：
 *   #6 pi session 延迟写入：宿主从不创建/触碰线会话文件（fork 文件由 pi fork 链路写、
 *      回落线由 pi 首 flush 自建；本服务只读 header / 轮询目录 / 删除走显式关线）。
 *   #19 超时默认原则：fork bootstrap 属「控制面单请求」量级 → 秒级有界（10s）；
 *      线任务执行（prompt）不经本服务，无墙钟超时。
 *   #12 打包约束：本文件只 spawn（经注入 piCommand），不拼 ESM 模块元数据 URL 类路径
 *      （该属性在 CJS bundle 下恒为 undefined——原文指回 AGENTS.md 关键规则 #12）；
 *      bootstrap 出站 env 经 buildOutboundChildEnv（C-proc-09）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { btwVirtualId } from '@taiji/shared'
import { buildOutboundChildEnv } from '../../infra/spawn-env.js'
import { assertPiSessionFile } from '../../infra/pi/session-attach-assert.js'
import { getBtwSessionsRoot, getBtwThreadDir, getPiAgentDir, isPiSessionId } from '../../infra/pi/pi-paths.js'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import { toErrorMessage } from '../../utils/errors.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量与行为契约
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000

/**
 * btw 线闲置回收阈值（D1：闲置 30min destroy 进程；线会话文件持久保留——裁决⑧）。
 * V3（设计 §5）：阈值是否合适待 S 系列验收后按实际使用调——经 deps.idleThresholdMs
 * 可注入，调档不改代码形态。
 */
const IDLE_RECLAIM_MINUTES = 30
export const BTW_IDLE_RECLAIM_MS = IDLE_RECLAIM_MINUTES * MINUTE_MS

/** 闲置扫描节拍（单定时器扫全表，不 per-line 定时器；unref 不阻塞进程退出）。 */
export const BTW_IDLE_TICK_MS = MINUTE_MS

/**
 * fork bootstrap 就绪上限（控制面单请求量级，规则 #19）：实测双旗标 fork 落盘 206ms
 *（V2 探针 A），10s 覆盖慢机/冷缓存；超时 → 回落无 fork 分支（不静默：pill 标 no-source）。
 */
export const BTW_FORK_TIMEOUT_MS = 10_000

/** fork bootstrap 目录轮询节拍（扫到新增 .jsonl 即收进程；控制面内部采样间隔，规则 #19 秒级量级）。 */
const FORK_POLL_INTERVAL_MS = 50

/** fork 失败诊断保留的 stderr 尾行数。 */
const STDERR_TAIL_LINES = 3

/**
 * D9⑤ 行为契约（model-only 单条注入，UI 不可见，借鉴 zcode system_reminder 一句话版）：
 * 每线会话建立时注入一次（含分支②回落线与重附着轮）。
 * 载体子通道（①pi 侧 system-prompt 通道 / ②请求携带通道）随 V6 核实钉固；
 * 当前实现落 ① 的 spawn `--append-system-prompt` 组合（prompt 期注入、每建立一轮一次、
 * 不产生落盘 entry、不进对话流渲染），oracle = traceContractInjection 挂点记录。
 * 失败三支（设计 D9⑤）：能力缺失 → 放弃 + 登记；实现缺陷 → 修复；oracle 错位 → 修订复测。
 */
export const BTW_BEHAVIOR_CONTRACT =
  '父任务快照仅供背景；只回答本线新问题、不自动续主任务；仅本线明确要求时才改工作区'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 线快照态（D3 源状态三分支 + 重建态）：
 * - `forked`    分支①：源已落盘 → 正常 fork，全树快照。
 * - `no-source` 分支②：源不存在/为空/不可解析（首 flush 前）或 fork bootstrap 失败
 *                 → 回落「无 fork 新建 spawn」（落点 = 线目录，pi 首 flush 自建文件，
 *                 宿主不写空文件），pill「无快照」不静默。
 * - `truncated` 分支③：源含进行中 turn 的已落盘部分（悬空 tool-call / 调用方标注
 *                 mainTurnActive）→ 快照为 entry 级截断，pill 注明，该 turn 不续跑。
 * - `unknown`   启动扫描重建态：快照元信息不持久化（pill 仅创建时显示一次，跨重启不回填）。
 */
export type BtwSnapshotKind = 'forked' | 'no-source' | 'truncated' | 'unknown'

/** 线注册表条目（内存缓存；持久载体 = 目录布局，D2/D5）。 */
export interface BtwLineRecord {
  /** btw 虚拟 id（`btw:<piSessionId>`，M1-a 工厂产出）；runtime/前端路由 key，不直传 pi。 */
  vid: string
  /** 线的真实 pi 会话 id（= vid 去前缀，映射即 extract）。 */
  piSessionId: string
  /** 归属主会话 id（关联 = 目录布局，本注册表是其内存投影）。 */
  mainSid: string
  /** 线进程 cwd（= 主会话 cwd；spawn 与 registerSession 用）。 */
  cwd: string
  /** 线注册 label（registerSession 透传；reattach 轮复用）。 */
  label: string
  /** `btw/<encodeCwd>/<mainSid>/` 线目录（--session-dir / env 落点值）。 */
  threadDir: string
  /** 线会话文件绝对路径（分支② 首 flush 前为 pi 推导路径，文件可能尚不存在——规则 #6）。 */
  sessionFilePath: string
  snapshotKind: BtwSnapshotKind
  /** hidden:true（active 腿防线：listAll 过滤 + 不记工作区历史；重建轮同样复原）。 */
  hidden: true
  createdAt: number
  /** 空闲钟参考（重建条目初值 0；运行期与 client.lastActivityAt 取 max）。 */
  lastActivityAt: number
  /** 有待处理交互（豁免计闲置；豁免随任一终态解除——终态机归 M3-c）。 */
  pendingInteraction: boolean
  /** 行为契约注入轮数（= 会话建立次数：create 1 轮 + 每次 reattach +1）。 */
  contractRounds: number
  /** 活跃线进程（undefined = 已被闲置回收/进程亡——文件在，续问走 reattach）。 */
  client?: IPiEngine
}

/** createLine 入参。 */
export interface BtwCreateRequest {
  mainSid: string
  cwd: string
  /** registerSession label；缺省 basename(cwd)（与主 create 同构）。 */
  label?: string
  /**
   * 调用方已知「主 turn 进行中」信号（分支③ pill 判定的可选增强——纯文本流式中
   * 文件级不可判，M2-b btw.create handler 可传入；缺省按文件级悬空 tool-call 判定）。
   */
  mainTurnActive?: boolean
}

/** createLine 结果（pill 口径：仅创建时返回一次，快照元信息不持久化）。 */
export interface BtwCreateResult {
  vid: string
  mainSid: string
  snapshotKind: Exclude<BtwSnapshotKind, 'unknown'>
  sessionFilePath: string
}

/** 行为契约注入 trace 记录（D9⑤ oracle 挂点；V6 钉固载体后与 system-prompt-trace 对账）。 */
export interface BtwContractInjectionTrace {
  vid: string
  /** 第几轮会话建立（create=1，每次 reattach +1）。 */
  round: number
  carrier: 'append-system-prompt'
  contract: string
}

/**
 * 线进程 spawn options 的最小结构面（runtime-layering C-comm-02 / check_pi_type_leak：
 * PiXxx 类型只许 infra/pi 内部——本服务只消费以下三键，故本地定义、不 import
 * ports 面 PiXxx 类型）。组合根 buildLineSpawnOptions 返回的 ports 面完整类型
 * 结构性满足本接口（多余字段协变放行），消费出口 = deps.processes.createSession
 *（Pick<IProcessManager> 契约面），pi 侧类型翻译归 ports/infra，不泄漏进本文件。
 */
export interface BtwLineSpawnOptions {
  /** 进程工作目录（= 线 cwd）。 */
  cwd?: string
  /** 组合根基础 env（launch-params 面）；本服务强制覆写 PI_CODING_AGENT_SESSION_DIR。 */
  env?: Record<string, string>
  /** 模式 append 段（系统提示词追加）；本服务在其上 ⊕ 行为契约（D9⑤）。 */
  appendSystemPrompt?: string
}

/** 组合根注入的依赖（全部窄接口；测试注入 fake）。 */
export interface BtwServiceDeps {
  /**
   * 线进程 spawn（组合根接 IProcessManager.createSession；key 见 attachProcess
   * 的 tempKey 编排——日志文件名避冒号，rekey 后 pm 键 ≡ 注册 id = vid）。
   */
  processes: Pick<IProcessManager, 'createSession' | 'destroySession' | 'rekey' | 'getClient'>
  /**
   * 基础 launch options（skills/extensions/preset/model 解析——组合根接 launch-params
   * 面）。本服务在其上**强制覆写**两键（不可协商不变量）：env.PI_CODING_AGENT_SESSION_DIR
   * = 线目录（V2②③ 落点保证）、appendSystemPrompt ⊕ 行为契约（D9⑤）。
   */
  buildLineSpawnOptions(ctx: BtwLineSpawnContext): Promise<BtwLineSpawnOptions>
  /** 既有 registerSession 汇聚点（hidden:true 经此透传；本服务不传 parentSession 血缘）。 */
  registerSession(id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean): Promise<unknown>
  /** 主会话文件解析（组合根接 scanner/findScannedSession；undefined = 源不可用）。 */
  resolveMainSessionFile(mainSid: string): string | undefined
  /** pi 可执行文件（fork bootstrap spawn 用；组合根接 findPiExecutable）。 */
  resolvePiCommand(): string
  /** fork bootstrap 覆写口（缺省 = forkViaCliPi；测试注入 fake）。 */
  forkSession?(req: { sourceFile: string; threadDir: string; cwd: string }): Promise<string>
  /** 行为契约注入 trace（D9⑤；缺省 no-op）。 */
  traceContractInjection?(trace: BtwContractInjectionTrace): void
  /** 回收前提醒挂点（D1：回收前线 badge 置「待处理」；回收发生/用户续问后清——badge 清除归 M3-c）。 */
  onWillReclaim?(vid: string): void
  /** 闲置阈值覆盖（V3 调档口；缺省 BTW_IDLE_RECLAIM_MS）。 */
  idleThresholdMs?: number
  /** 时钟注入（测试）。 */
  now?(): number
}

/** spawn 落点上下文（buildLineSpawnOptions 入参）。 */
export interface BtwLineSpawnContext {
  mainSid: string
  cwd: string
  threadDir: string
  snapshotKind: Exclude<BtwSnapshotKind, 'unknown'>
}

/** btw 域错误（M2-b 按 code 映射恢复指引）。 */
export type BtwErrorCode = 'fork_failed' | 'spawn_state_invalid' | 'state_mismatch' | 'line_not_found' | 'thread_file_missing'

export class BtwError extends Error {
  constructor(readonly code: BtwErrorCode, message: string) {
    super(message)
    this.name = 'BtwError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数 helper（fixture 可驱动，独立可测）
// ─────────────────────────────────────────────────────────────────────────────

/** session 文件 header（首行 type:"session"）。 */
export interface BtwSessionHeader {
  id: string
  cwd?: string
  timestamp?: string
}

/**
 * 读线/源会话文件 header（宿主只读——规则 #6 零直写；读侧容忍首 flush 前文件缺失）。
 * 非法/缺失 throw（调用方按分支处置：源 → 回落；线文件 → line_not_found 系错误）。
 */
export function readSessionHeader(sessionFile: string): BtwSessionHeader {
  let raw: string
  try {
    raw = readFileSync(sessionFile, 'utf8')
  } catch (e) {
    throw new BtwError('spawn_state_invalid', `[btw] session file unreadable (${sessionFile}): ${toErrorMessage(e)}`)
  }
  const firstLine = raw.split('\n', 1)[0] ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    throw new BtwError('spawn_state_invalid', `[btw] session header unparsable: ${sessionFile}`)
  }
  const header = parsed as { type?: string; id?: unknown; cwd?: unknown; timestamp?: unknown }
  if (header.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0) {
    throw new BtwError('spawn_state_invalid', `[btw] session header invalid (type/id): ${sessionFile}`)
  }
  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined,
    timestamp: typeof header.timestamp === 'string' ? header.timestamp : undefined,
  }
}

/** 源状态检查结果。 */
export type BtwSourceState =
  | { state: 'ok'; hasDanglingToolCall: boolean }
  | { state: 'unavailable'; reason: 'unresolved' | 'missing' | 'unparsable' | 'empty' | 'io' }

/**
 * 收集 entry 集中的悬空 tool-call（有 toolCall 无对应 toolResult）——分支③「源含
 * 进行中 turn 的已落盘部分」的文件级判定（P-fork-source）。形状容忍多代 pi 消息
 * 结构（content item `toolResult.toolCallId` / message role toolResult 的
 * `toolCallId` 字段），判定只影响 pill 标注不影响 fork 内容（fork 逐字节复制）。
 */
export function hasDanglingToolCall(entries: readonly unknown[]): boolean {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as { type?: string; message?: { role?: string; toolCallId?: unknown; content?: unknown } }
    if (entry.type !== 'message' || typeof entry.message !== 'object' || entry.message === null) continue
    const message = entry.message
    if (typeof message.toolCallId === 'string') resultIds.add(message.toolCallId)
    if (!Array.isArray(message.content)) continue
    for (const item of message.content) {
      if (typeof item !== 'object' || item === null) continue
      const part = item as { type?: string; id?: unknown; toolCallId?: unknown }
      if (part.type === 'toolCall' && typeof part.id === 'string') callIds.add(part.id)
      if (part.type === 'toolResult') {
        const tid = typeof part.toolCallId === 'string' ? part.toolCallId : part.id
        if (typeof tid === 'string') resultIds.add(tid)
      }
    }
  }
  for (const id of callIds) {
    if (!resultIds.has(id)) return true
  }
  return false
}

/**
 * 检查 fork 源状态（D3 分支② 判定；语义对齐 pi `forkFrom` 守卫——缺失/空/无 header
 * 即不可 fork——并**更严**一档：header-only（零非 header entry）也判不可用，构造性
 * 杜绝「空上下文线」击穿 G2；pi 对 header-only 会产出空快照文件，宿主前置拦截）。
 * 读侧容忍尾部半行（append 中读到未写完的行直接丢弃，不整文件判废）。
 */
export function inspectSourceState(sourceFile: string | undefined): BtwSourceState {
  if (!sourceFile) return { state: 'unavailable', reason: 'unresolved' }
  let raw: string
  try {
    raw = readFileSync(sourceFile, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'unavailable', reason: 'missing' }
    console.warn(`[btw] fork source read failed (${sourceFile}): ${toErrorMessage(e)}`)
    return { state: 'unavailable', reason: 'io' }
  }
  const entries: unknown[] = []
  let header: unknown
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if ((parsed as { type?: string }).type === 'session' && header === undefined) header = parsed
      else entries.push(parsed)
    } catch {
      // 尾部半行（并发 append 中）容忍丢弃；非尾部坏行不阻断（pi fork 自会整读复判）。
      const isLastNonEmpty = lines.slice(i + 1).every(l => !l || !l.trim())
      if (!isLastNonEmpty) console.warn(`[btw] fork source corrupt line ${i + 1} (${sourceFile}) — tolerated for inspection`)
    }
  }
  if (header === undefined) return { state: 'unavailable', reason: 'unparsable' }
  if (entries.length === 0) return { state: 'unavailable', reason: 'empty' }
  return { state: 'ok', hasDanglingToolCall: hasDanglingToolCall(entries) }
}

/**
 * 行为契约 ⊕ spawn append 段组合（D9⑤ 载体 ①：`--append-system-prompt`）。
 * 每次会话建立调用一次——base（模式 append 段）与契约同线拼接，互不覆盖。
 */
export function composeContractAppendPrompt(base: string | undefined): string {
  const trimmed = base?.trim() ? base : undefined
  return trimmed ? `${trimmed}\n${BTW_BEHAVIOR_CONTRACT}` : BTW_BEHAVIOR_CONTRACT
}

// ─────────────────────────────────────────────────────────────────────────────
// fork bootstrap（V2① 双旗标实测通道；导出供组合根/测试复用）
// ─────────────────────────────────────────────────────────────────────────────

export interface ForkViaCliRequest {
  piCommand: string
  sourceFile: string
  threadDir: string
  cwd: string
  timeoutMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 一次性 fork bootstrap：`pi --mode rpc --fork <源> --session-dir <线目录>` 起进程，
 * pi 在启动期同步完成 forkFrom 落盘（写 header + 逐条复制全树，V2 探针 A 实测 206ms），
 * 宿主轮询到**新增** .jsonl 即 SIGTERM 收掉 bootstrap（该进程不承载线——线进程由
 * attachProcess 另行惰性 spawn，避免污染进程表）。
 *
 * 失败语义（调用方按 D3 分支② 回落）：源缺失/空 → pi exit 1（不产空文件，V2 探针 D）；
 * 超时/异因退出 → throw（携带 stderr 尾，调用方 warn 后回落 no-source，pill 不静默）。
 * 出站 env 经 buildOutboundChildEnv（C-proc-09），PI_CODING_AGENT_DIR 与线进程同源隔离。
 */
export async function forkViaCliPi(req: ForkViaCliRequest): Promise<string> {
  const timeoutMs = req.timeoutMs ?? BTW_FORK_TIMEOUT_MS
  const existing = new Set(existsSync(req.threadDir) ? readdirSync(req.threadDir).filter(f => f.endsWith('.jsonl')) : [])
  const env = buildOutboundChildEnv({ parentEnv: process.env, extras: { PI_CODING_AGENT_DIR: getPiAgentDir() } })
  const args = ['--mode', 'rpc', '--fork', req.sourceFile, '--session-dir', req.threadDir]
  let spawnError: Error | undefined
  let child
  try {
    child = spawn(req.piCommand, args, { cwd: req.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // spawn 同步抛（参数面异常）：包成 fork_failed，调用方回落分支②。
    throw new BtwError('fork_failed', `[btw] pi fork bootstrap spawn failed: ${toErrorMessage(e)}`)
  }
  child.stdout.on('data', () => {}) // bootstrap 进程 stdout 不消费（fork 后即收）
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  // 'error' 必须监听并入 exited 汇合口：spawn 失败（ENOENT：pi 缺失 / cwd 死路径）只发
  // error 不发 exit——漏听会 uncaughtException 崩 runtime 且轮询空等到超时（M1-b 实测教训）。
  const exited = new Promise<number>(resolve => {
    child.on('exit', code => resolve(code ?? -1))
    child.on('error', (e: Error) => { spawnError = e; resolve(-1) })
  })

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const files = existsSync(req.threadDir) ? readdirSync(req.threadDir).filter(f => f.endsWith('.jsonl') && !existing.has(f)) : []
    if (files.length > 0) {
      const file = join(req.threadDir, files[0])
      child.kill('SIGTERM')
      return file
    }
    if (await Promise.race([exited.then(() => true), sleep(FORK_POLL_INTERVAL_MS).then(() => false)])) {
      const code = await exited
      if (spawnError) throw new BtwError('fork_failed', `[btw] pi fork bootstrap spawn failed: ${spawnError.message} — source=${req.sourceFile}`)
      const tail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join(' | ')
      throw new BtwError('fork_failed', `[btw] pi fork bootstrap exited (code ${code}) — source=${req.sourceFile} stderr=${tail}`)
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM')
      throw new BtwError('fork_failed', `[btw] pi fork bootstrap timed out after ${timeoutMs}ms — source=${req.sourceFile}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BtwService
// ─────────────────────────────────────────────────────────────────────────────

export class BtwService {
  /** mainSid → 条目仅经 registry 全表索引（消费方 listLines(mainSid) 过滤；注册表即 D4 关联投影）。 */
  private readonly registry = new Map<string, BtwLineRecord>()
  private timer: unknown = null
  private readonly idleThresholdMs: number

  constructor(private readonly deps: BtwServiceDeps) {
    this.idleThresholdMs = deps.idleThresholdMs ?? BTW_IDLE_RECLAIM_MS
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ── 注册表读 ──

  getLine(vid: string): BtwLineRecord | undefined {
    return this.registry.get(vid)
  }

  /** 线列表枚举（btw.list{mainSid} 后端；BtwPanel 消费，不属于禁止的关联展示面——D4）。 */
  listLines(mainSid: string): BtwLineRecord[] {
    const out: BtwLineRecord[] = []
    for (const rec of this.registry.values()) {
      if (rec.mainSid === mainSid) out.push(rec)
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  /** 全量快照（级联/对账用；返回副本不暴露可变引用——registry 写者唯一）。 */
  listAllLines(): BtwLineRecord[] {
    return [...this.registry.values()]
  }

  // ── 注册表重建（D5：启动目录扫描重建 + hidden 复原）──

  /**
   * 启动扫描 `btw/<encodeCwd>/<mainSid>/*.jsonl` 重建注册表（裁决⑧：持久化 + 重启可复原）。
   *
   * - hidden 复原：每条重建条目 `hidden: true`（active 腿防线随 reattach 轮
   *   经 registerSession 复原；磁盘扫描腿由目录隔离构造性不可见——SessionScanner 只扫 sessions/）。
   * - 不 spawn（惰性）：进程在 ensureProcess（续问/重开）时自建附着编排拉起。
   * - 幂等：已有活跃条目（by vid）不覆盖；无法解析的文件 warn 跳过（登记不静默，
   *   清理归 M4-a 孤儿补账）。
   */
  rebuildFromDisk(): BtwLineRecord[] {
    const root = getBtwSessionsRoot()
    const rebuilt: BtwLineRecord[] = []
    if (!existsSync(root)) return rebuilt
    let cwdDirs: string[]
    try {
      cwdDirs = readdirSync(root).filter(name => {
        try { return statSync(join(root, name)).isDirectory() } catch { return false }
      })
    } catch (e) {
      // best-effort 降级：btw 根不可读 = 无历史线可建（首启形态），警告后返回空表；
      // 不抛——启动链不应因 btw 重建失败挂掉（P2 降级隔离不拖垮核心）。
      console.warn(`[btw] rebuild: cannot read btw root (${root}): ${toErrorMessage(e)}`)
      return rebuilt
    }
    for (const enc of cwdDirs) {
      const encDir = join(root, enc)
      let sidDirs: string[]
      try {
        sidDirs = readdirSync(encDir).filter(name => {
          try { return statSync(join(encDir, name)).isDirectory() } catch { return false }
        })
      } catch { continue }
      for (const mainSid of sidDirs) {
        // 目录名来自 getBtwThreadDir 校验过的创建面，但扫描容忍外部 junk：非 pi sid 形态跳过。
        if (!isPiSessionId(mainSid)) {
          console.warn(`[btw] rebuild: skip non-session dir name "${mainSid}" under ${encDir}`)
          continue
        }
        const threadDir = join(encDir, mainSid)
        let files: string[]
        try {
          files = readdirSync(threadDir).filter(f => f.endsWith('.jsonl'))
        } catch { continue }
        for (const f of files) {
          const file = join(threadDir, f)
          let header: BtwSessionHeader
          try {
            header = readSessionHeader(file)
          } catch (e) {
            console.warn(`[btw] rebuild: skip unparsable session file: ${toErrorMessage(e)}`)
            continue
          }
          if (!header.cwd) {
            console.warn(`[btw] rebuild: skip session file without cwd header: ${file}`)
            continue
          }
          let vid: string
          try {
            vid = btwVirtualId(header.id)
          } catch {
            console.warn(`[btw] rebuild: skip file with invalid session id "${header.id}": ${file}`)
            continue
          }
          if (this.registry.has(vid)) continue // 活跃条目优先（live ≡ reload 不覆盖运行态）
          let createdAt: number
          try { createdAt = statSync(file).mtimeMs } catch { createdAt = this.now() }
          const rec: BtwLineRecord = {
            vid,
            piSessionId: header.id,
            mainSid,
            cwd: header.cwd,
            label: basename(header.cwd),
            threadDir,
            sessionFilePath: file,
            snapshotKind: 'unknown',
            hidden: true,
            createdAt,
            lastActivityAt: 0,
            pendingInteraction: false,
            contractRounds: 0,
          }
          this.registry.set(vid, rec)
          rebuilt.push(rec)
        }
      }
    }
    return rebuilt
  }

  // ── 创建（D3 三分支）──

  /**
   * 创建 btw 线：源检查 →（分支①）pi 原生 fork 或（分支②）回落无 fork 新建 →
   * 惰性 spawn 线进程 → 附着/读回 → registerSession(hidden:true) → 注册表登记。
   *
   * 全程零触碰主会话进程与主会话文件（P-no-abort 结构面：主 turn 不可能被本路径
   * 打断——真机断言归 S7 真实进程轨）；零直写线会话文件（fork 文件由 pi 写、
   * 回落文件由 pi 首 flush 自建）。
   */
  async createLine(req: BtwCreateRequest): Promise<BtwCreateResult> {
    const { mainSid, cwd } = req
    const threadDir = getBtwThreadDir(cwd, mainSid)
    const label = req.label ?? basename(cwd)
    const sourceFile = this.deps.resolveMainSessionFile(mainSid)
    const source = inspectSourceState(sourceFile)

    // 分支①：源可用 → pi 原生 fork（--fork + --session-dir，V2①）。
    let forkFile: string | undefined
    if (source.state === 'ok' && sourceFile) {
      try {
        const fork = this.deps.forkSession
          ? await this.deps.forkSession({ sourceFile, threadDir, cwd })
          : await forkViaCliPi({ piCommand: this.deps.resolvePiCommand(), sourceFile, threadDir, cwd })
        readSessionHeader(fork) // fail-fast：fork 文件不可解析 → 回落（不产半截态登记）
        forkFile = fork
      } catch (e) {
        // best-effort 降级：fork bootstrap 失败（源消失/超时/异因）→ 回落无 fork 分支，
        // 不静默——pill 标 no-source + 警告日志（D3 分支② 编排，原始错误已进日志）。
        console.warn(`[btw] fork bootstrap failed, falling back to no-snapshot line: ${toErrorMessage(e)}`)
      }
    } else {
      // 分支② 预期路径（首 flush 前源不存在）：警告含不可用原因，不构成 IO 故障伪装（规则 #11.2）。
      console.warn(`[btw] fork source unavailable (${source.state === 'unavailable' ? source.reason : 'n/a'}), creating no-snapshot line (source=${sourceFile ?? '<unresolved>'})`)
    }

    const snapshotKind: Exclude<BtwSnapshotKind, 'unknown'> = forkFile ? (source.state === 'ok' && (source.hasDanglingToolCall || req.mainTurnActive === true) ? 'truncated' : 'forked') : 'no-source'
    const ctx: BtwLineSpawnContext = { mainSid, cwd, threadDir, snapshotKind }
    const options = await this.buildEstablishOptions(ctx)
    const tempKey = `btw-create-${crypto.randomUUID()}`
    let client: IPiEngine | undefined
    let registeredKey = tempKey
    try {
      client = await this.deps.processes.createSession(tempKey, cwd, options)
      if (forkFile) {
        // 分支① 附着：switch_session → 附着断言（I1：登记路径 ≡ pi 写路径）。
        await client.switchSession(forkFile)
        await assertPiSessionFile(client, forkFile, `btw.createLine(${mainSid})`)
      }
      const state = await client.getState()
      const piSessionId = typeof state?.sessionId === 'string' ? state.sessionId : undefined
      const sessionFilePath = typeof state?.sessionFile === 'string' ? state.sessionFile : undefined
      if (!piSessionId || !sessionFilePath) {
        // 文案避开 `spawn (` 形态：守卫 check_spawn_env_boundary 的 spawn\s*\( 模式按行
        // 文本匹配（不剥模板字符串），原「after spawn (fork=" 会被误判为进程创建调用点
        //（本行是错误消息 prose，非 spawn；本文件真实 spawn = forkViaCliPi 已武装构建器）。
        throw new BtwError('spawn_state_invalid', `[btw] get_state missing sessionId/sessionFile after spawn; fork=${forkFile ?? 'none'}`)
      }
      if (forkFile && piSessionId !== readSessionHeader(forkFile).id) {
        // 附着一致性守卫：switch 后活跃会话必须是 fork 目标（进程绑错 = 实现 bug，fail-fast）。
        throw new BtwError('state_mismatch', `[btw] attached session id ${piSessionId} !== fork header id — refusing to register`)
      }
      const vid = btwVirtualId(piSessionId)
      if (vid !== tempKey) {
        this.deps.processes.rekey(tempKey, vid)
        registeredKey = vid
      }
      await this.deps.registerSession(vid, client, cwd, label, sessionFilePath, true)
      const rec: BtwLineRecord = {
        vid,
        piSessionId,
        mainSid,
        cwd,
        label,
        threadDir,
        sessionFilePath,
        snapshotKind,
        hidden: true,
        createdAt: this.now(),
        lastActivityAt: this.now(),
        pendingInteraction: false,
        contractRounds: 1,
        client,
      }
      this.registry.set(vid, rec)
      this.deps.traceContractInjection?.({ vid, round: 1, carrier: 'append-system-prompt', contract: BTW_BEHAVIOR_CONTRACT })
      this.armTimer()
      return { vid, mainSid, snapshotKind, sessionFilePath }
    } catch (e) {
      // 与 create/restore 的 init catch 同构：注册半途失败 → 收尸进程，不留半截条目。
      // 两处 destroy 均 best-effort：收尸失败不掩盖原始错误（进程表退出回调兑底）。
      await this.deps.processes.destroySession(registeredKey).catch(() => {})
      if (registeredKey !== tempKey) await this.deps.processes.destroySession(tempKey).catch(() => {})
      throw e
    }
  }

  // ── reattach（自建附着编排，V5：restore/getHistory 离线腿不通用）──

  /**
   * 确保线进程存活（惰性 spawn / 闲置回收后续问、drawer 重开走此口）。
   *
   * 编排 = spawn（env session-dir 线目录）→ switch_session（线文件）→ 附着断言 →
   * get_state 一致性守卫 → rekey → registerSession(hidden:true)。不走 restoreSession
   * （其 resolveRestoreTarget/findScannedSession 只扫 sessions/，btw 线目录不在其
   * 扫描面——V5 核实结论）。
   *
   * 行为契约每轮重注入（D9⑤「含重附着轮」）。
   * 线会话文件缺失（分支② 首 flush 前即被回收/删除）→ BtwError('thread_file_missing')：
   * 该线无任何持久化内容，策略（报错可见 / 引导新建）由调用方 M2-b 决定，宿主不代造文件。
   */
  async ensureProcess(vid: string): Promise<IPiEngine> {
    const rec = this.registry.get(vid)
    if (!rec) throw new BtwError('line_not_found', `[btw] no such line: ${vid}`)
    const alive = rec.client
    if (alive && !alive.exited) {
      this.markActivity(vid)
      return alive
    }
    if (!rec.sessionFilePath || !existsSync(rec.sessionFilePath)) {
      throw new BtwError('thread_file_missing', `[btw] thread session file missing (line had never flushed) — rebuild from scratch: ${rec.sessionFilePath ?? vid}`)
    }
    const ctx: BtwLineSpawnContext = { mainSid: rec.mainSid, cwd: rec.cwd, threadDir: rec.threadDir, snapshotKind: rec.snapshotKind === 'unknown' ? 'forked' : rec.snapshotKind }
    const options = await this.buildEstablishOptions(ctx)
    const tempKey = `btw-attach-${crypto.randomUUID()}`
    try {
      const client = await this.deps.processes.createSession(tempKey, rec.cwd, options)
      await client.switchSession(rec.sessionFilePath)
      await assertPiSessionFile(client, rec.sessionFilePath, `btw.ensureProcess(${vid})`)
      const state = await client.getState()
      const stateSid = typeof state?.sessionId === 'string' ? state.sessionId : undefined
      if (stateSid !== rec.piSessionId) {
        throw new BtwError('state_mismatch', `[btw] reattach landed on session ${stateSid ?? '<none>'}, expected ${rec.piSessionId}`)
      }
      this.deps.processes.rekey(tempKey, vid)
      await this.deps.registerSession(vid, client, rec.cwd, rec.label, rec.sessionFilePath, true)
      rec.client = client
      rec.contractRounds += 1
      this.deps.traceContractInjection?.({ vid, round: rec.contractRounds, carrier: 'append-system-prompt', contract: BTW_BEHAVIOR_CONTRACT })
      this.markActivity(vid)
      return client
    } catch (e) {
      // best-effort 收尸：两键都试（rekey 前后），失败不掩盖原始附着错误（退出回调兑底）。
      await this.deps.processes.destroySession(tempKey).catch(() => {})
      await this.deps.processes.destroySession(vid).catch(() => {})
      throw e
    }
  }

  // ── 生命周期信号（闲置回收 / 交互豁免 / 活跃）──

  /** 活跃信号（M2-b 消息入口 / UI 提交处调用；与 client.lastActivityAt 取 max 计闲置）。 */
  markActivity(vid: string): void {
    const rec = this.registry.get(vid)
    if (rec) rec.lastActivityAt = this.now()
  }

  /**
   * 有待处理交互登记（D1 豁免：不计闲置；豁免随任一终态解除——终态机触发点归 M3-c，
   * 本方法是其解除口）。登记本身即提醒态的一部分（badge 待处理 = M3-c 消费）。
   */
  setPendingInteraction(vid: string, pending: boolean): void {
    const rec = this.registry.get(vid)
    if (!rec) return
    rec.pendingInteraction = pending
    if (!pending) this.markActivity(vid) // 终态应答视为一次活跃（防解除即刻误回收）
  }

  /**
   * 关线（btw.remove 原语，单线销毁；主删级联的整目录删除归 M4-a）：
   * 杀进程 + 注册表移除 +（可选）删线会话文件（路径限定 btw 根内，防误删面）。
   */
  async closeLine(vid: string, opts?: { deleteSessionFile?: boolean }): Promise<boolean> {
    const rec = this.registry.get(vid)
    if (!rec) return false
    this.registry.delete(vid)
    if (rec.client) await this.deps.processes.destroySession(vid).catch((e: unknown) => console.warn(`[btw] closeLine destroy failed (${vid}): ${toErrorMessage(e)}`))
    if (opts?.deleteSessionFile && rec.sessionFilePath && this.isInsideBtwRoot(rec.sessionFilePath)) {
      try {
        rmSync(rec.sessionFilePath, { force: true })
      } catch (e) {
        // best-effort：删文件失败降级为警告——注册表条目已移除，残留由 M4-a 启动
        // 孤儿补账兑底（主会话已不存在的线目录清理），不阻断关线主链。
        console.warn(`[btw] closeLine file removal failed (${rec.sessionFilePath}): ${toErrorMessage(e)}`)
      }
    }
    return true
  }

  /** 停止闲置扫描定时器（shutdown / 测试收尾）。 */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer as Parameters<typeof clearInterval>[0])
      this.timer = null
    }
  }

  // ── 内部 ──

  /** 会话建立期 spawn options（不可协商不变量的唯一施加点）。 */
  private async buildEstablishOptions(ctx: BtwLineSpawnContext): Promise<BtwLineSpawnOptions> {
    const base = await this.deps.buildLineSpawnOptions(ctx)
    return {
      ...base,
      cwd: ctx.cwd,
      env: { ...base.env, PI_CODING_AGENT_SESSION_DIR: ctx.threadDir },
      appendSystemPrompt: composeContractAppendPrompt(base.appendSystemPrompt),
    }
  }

  private armTimer(): void {
    if (this.timer !== null) return
    const handle = setInterval(() => { this.idleTick() }, BTW_IDLE_TICK_MS) as unknown as { unref?: () => void }
    handle.unref?.() // 不阻塞进程退出（runtime shutdown 另有 destroyAll 兜底）
    this.timer = handle
  }

  /**
   * 闲置扫描（D1）：活着的线 + 无待处理交互 + 闲置 ≥ 阈值 → 回收提醒挂点 → destroy
   *（只杀进程，文件与注册表条目保留——裁决⑧，续问走 ensureProcess 重附着）。
   * 进程已亡条目顺手清 client 引用（失效支：挂起请求清理/派生随进程亡归 M3-c/M4-a）。
   */
  private idleTick(): void {
    const now = this.now()
    for (const rec of this.registry.values()) {
      const client = rec.client
      if (!client) continue
      if (client.exited) {
        rec.client = undefined
        continue
      }
      if (rec.pendingInteraction) continue // 豁免：有待处理交互不计闲置
      const last = Math.max(rec.lastActivityAt, client.lastActivityAt)
      if (now - last >= this.idleThresholdMs) {
        this.deps.onWillReclaim?.(rec.vid)
        rec.client = undefined
        void this.deps.processes.destroySession(rec.vid).catch((e: unknown) => {
          console.warn(`[btw] reclaim destroy failed (${rec.vid}): ${toErrorMessage(e)}`)
        })
      }
    }
  }

  /** 路径安全：删除面必须位于 btw 根内（closeLine 防误删；M4-a 级联同用此守卫形态）。 */
  private isInsideBtwRoot(target: string): boolean {
    const root = getBtwSessionsRoot()
    return target.startsWith(root + sep)
  }
}
