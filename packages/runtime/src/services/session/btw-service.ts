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
 * 必须走本文件 ensureProcess（附着编排实装）自建编排（spawn → switch_session → assertPiSessionFile）。
 * 悬空 tool-call 判「中断 turn」的失效支接线归 M3-c/M4-a（V5 残留项）。
 *
 * 关键红线呼应（AGENTS.md 关键规则）：
 *   #6 pi session 延迟写入：宿主从不创建/触碰线会话文件（fork 文件由 pi fork 链路写、
 *      回落线由 pi 首 flush 自建；本服务只读 header / 轮询目录 / 删除走显式关线）。
 *   #19 超时默认原则：fork bootstrap 属「控制面单请求」量级 → 秒级有界（10s）；
 *      线任务执行（prompt）不经本服务，无墙钟超时。
 *   #12 打包约束：fork bootstrap spawn 段已随拆分迁 btw-fork-exec.ts（约束同迁保持：
 *      只 spawn（经注入 piCommand）、不拼 ESM 模块元数据 URL 类路径——该属性在 CJS bundle
 *      下恒为 undefined，原文指回 AGENTS.md 关键规则 #12；出站 env 经 buildOutboundChildEnv）。
 *
 * sibling 模块拆分（max-lines 同目录内聚拆分，2026-09-22；导出面 / 行为 / 既有测试零变更）：
 *   · btw-error.ts —— BtwError / BtwErrorCode 词汇表（fork 腿与本体共抛，防反向依赖成环）
 *   · btw-contract-inject.ts —— D9⑤ 契约文本 + trace 类型 + append 段组合器
 *   · btw-fork-exec.ts —— session 文件 header 只读解析 + 源状态三分支判定 + fork bootstrap
 *   · btw-orphan-reconcile.ts —— 启动孤儿补账（D5 / BU5 扫描降级闸）+ isInsideBtwRoot 谓词
 *   迁出符号在下方「导出面保持」块原样 re-export，外部 import 路径零改动。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { btwVirtualId } from '@taiji/shared'
import { assertPiSessionFile } from '../../infra/pi/session-attach-assert.js'
import { getBtwSessionsRoot, getBtwThreadDir, isPiSessionId } from '../../infra/pi/pi-paths.js'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import { toErrorMessage } from '../../utils/errors.js'
import { BtwError } from './btw-error.js'
import { BTW_BEHAVIOR_CONTRACT, composeContractAppendPrompt } from './btw-contract-inject.js'
import type { BtwContractInjectionTrace } from './btw-contract-inject.js'
import { forkViaCliPi, inspectSourceState, readSessionHeader } from './btw-fork-exec.js'
import type { BtwSessionHeader, BtwSourceState } from './btw-fork-exec.js'
import { isInsideBtwRoot, reconcileOrphanThreadDirs as reconcileOrphanDirs } from './btw-orphan-reconcile.js'

// ─ 导出面保持（sibling 拆分前由本模块导出的符号原样 re-export；消费方 import 路径零改动）──
export { BTW_BEHAVIOR_CONTRACT, BtwError, composeContractAppendPrompt, forkViaCliPi, inspectSourceState, readSessionHeader }
export type { BtwContractInjectionTrace, BtwSessionHeader }
export { BTW_FORK_TIMEOUT_MS, hasDanglingToolCall } from './btw-fork-exec.js'
export type { BtwSourceState, ForkViaCliRequest } from './btw-fork-exec.js'
export type { BtwErrorCode } from './btw-error.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量（闲置回收节拍；D9⑤ 行为契约文本已迁 btw-contract-inject.ts、fork 常量迁 btw-fork-exec.ts）
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
  /** 有待处理交互（豁免计闲置；豁免随任一终态解除——派生通道见 deps.hasPendingUiRequests / setPendingInteraction）。 */
  pendingInteraction: boolean
  /** 回收提醒态（D1「回收前」提醒窗口，提前 1 拍置位；回收发生/用户续问后清——协议面 = BtwThreadInfo.reclaimImminent）。 */
  reclaimImminent: boolean
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
   * 线进程 spawn（组合根接 IProcessManager.createSession；key 见 ensureProcess
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
  /**
   * 回收前提醒挂点（D1「回收前」，实装 = 提前 1 拍窗口进入即触发，badge 置「待处理」；
   * 回收发生/用户续问后清——badge 清除归 M3-c，本侧负责 reclaimImminent 翻转的广播驱动）。
   * 每回收周期至多触发一次（含时钟跳拍跨窗直达回收时的兜底补发——「提醒恒在回收前」不变量）。
   */
  onWillReclaim?(vid: string): void
  /**
   * 回收提醒态**清除**侧广播驱动（D1 回收提醒清除支：回收发生 / 用户续问 / 进程亡 /
   * 挂起交互置位）。组合根接「线列表 state 广播」（typeKey 'btw'）。缺省 no-op（测试零广播）。
   */
  onThreadStateChanged?(vid: string): void
  /**
   * 交互中转 pending 快照（BU2/D1 闲置豁免的派生**解除**通道）：respond / expired / 失效
   * 三终态的共同落点 = ExtensionTimeoutManager 的 per-session pending 表（respond →
   * removePendingRequest、失效 → invalidatePendingForSession），组合根经
   * server.getPendingUiRequests 薄委托注入（主 idle reaper 豁免 #8 同款先例）。idleTick 见
   * 「已置位但中转已空」即派生解除——三终态统一覆盖，无须逐终态推挽接线（置位推送通道见
   * index.ts onExtensionUIRequest）。缺省缺席 = 纯推送形态（解除走结构腿/显式调用）。
   */
  hasPendingUiRequests?(vid: string): boolean
  /**
   * 本轮 sessions 扫描是否降级不可信（BU5 数据不可逆面闸）：扫描腿 readdir EACCES/IO 降级
   * 显式返回空列表，冷主会话解析落空**不可**当「主已删」——补账遇闸跳过整轮，改下次启动
   * 重试（宁漏删不误删：rm -rf 不可逆）。组合根接 session-file-utils 的 degraded 旗标；
   * 缺省 = 恒可信（维持原判据，存量测试缺省行为不变）。
   */
  isSessionScanDegraded?(): boolean
  /**
   * [M4-a / D9④ 单入口终结扇出] 线终结（三路：deleteSession 级联 / deleteByCwd 批内直删 /
   * btw.remove）后的 lifecycle 收尾：摘 sessions Map 条目 + detach adapter + 插件 sessionData
   * 真删清理（组合根注入，镜像主会话 delete 的收尾序）。必要性：planned kill（destroySession
   * 先删进程表）抑制 exit 回调——条目/总线分区/插件数据不自清；**失效腿（闲置回收/进程亡）
   * 不经本回调**（线可重开，条目保留，D9④）。回调自身幂等（无条目零动作）；closeLine 对
   * 已出册线也补发一次（防注册表先摘、条目后存在的残留形态）。
   */
  onLineTerminated?(vid: string): void
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

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数 helper（createLine 分解件，fixture 可驱动）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 快照 kind 判定（D3 三分支投影，metrics-gate 复杂度偿还分解件）：无 fork 文件 =
 * no-source（分支②）；有 fork 文件时源含进行中 turn（悬空 tool-call 或调用方标注
 * mainTurnActive）= truncated（分支③），否则 forked（分支①）。纯映射零副作用。
 */
function resolveSnapshotKind(
  forkFile: string | undefined,
  source: BtwSourceState,
  mainTurnActive: boolean | undefined,
): Exclude<BtwSnapshotKind, 'unknown'> {
  if (!forkFile) return 'no-source'
  if (source.state !== 'ok') return 'forked'
  return source.hasDanglingToolCall || mainTurnActive === true ? 'truncated' : 'forked'
}

/**
 * spawn 后 get_state 提取 + 完备性守卫（fail-fast）：缺 sessionId/sessionFile 即
 * spawn_state_invalid（不注册半截条目）。
 */
async function requireSpawnState(
  client: IPiEngine,
  forkFile: string | undefined,
): Promise<{ piSessionId: string; sessionFilePath: string }> {
  const state = await client.getState()
  const piSessionId = typeof state?.sessionId === 'string' ? state.sessionId : undefined
  const sessionFilePath = typeof state?.sessionFile === 'string' ? state.sessionFile : undefined
  if (!piSessionId || !sessionFilePath) {
    // 文案避开 `spawn (` 形态：守卫 check_spawn_env_boundary 的 spawn\s*\( 模式按行
    // 文本匹配（不剥模板字符串），原「after spawn (fork=" 会被误判为进程创建调用点
    //（本行是错误消息 prose，非 spawn；本文件真实 spawn = forkViaCliPi 已武装构建器）。
    throw new BtwError('spawn_state_invalid', `[btw] get_state missing sessionId/sessionFile after spawn; fork=${forkFile ?? 'none'}`)
  }
  return { piSessionId, sessionFilePath }
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
   * 启动孤儿补账——实装已抽 btw-orphan-reconcile.ts（同目录 sibling 拆分：判据 / BU5 扫描
   * 降级闸 / 幂等语义随 doc 整段迁入，导出面与行为零变更）；本方法保留为组合根调用面
   *（一行委托）。调用序不变：先本方法、后 rebuildFromDisk。
   */
  reconcileOrphanThreadDirs(): number {
    return reconcileOrphanDirs(this.deps)
  }

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
            reclaimImminent: false,
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
   *
   * 分解件（metrics-gate 复杂度偿还，编排序不变）：fork 编排归 forkSnapshotForLine、
   * 快照 kind 纯判定归 resolveSnapshotKind、spawn/附着/登记归 spawnAndRegisterLine。
   */
  async createLine(req: BtwCreateRequest): Promise<BtwCreateResult> {
    const { mainSid, cwd } = req
    const threadDir = getBtwThreadDir(cwd, mainSid)
    const label = req.label ?? basename(cwd)
    const sourceFile = this.deps.resolveMainSessionFile(mainSid)
    const source = inspectSourceState(sourceFile)
    const forkFile = await this.forkSnapshotForLine(source, sourceFile, threadDir, cwd)
    const snapshotKind = resolveSnapshotKind(forkFile, source, req.mainTurnActive)
    const ctx: BtwLineSpawnContext = { mainSid, cwd, threadDir, snapshotKind }
    const options = await this.buildEstablishOptions(ctx)
    return await this.spawnAndRegisterLine(ctx, label, forkFile, options)
  }

  /**
   * createLine 的 fork 编排（D3 分支①/②）：源可用 → 执行 fork（deps.forkSession
   * 覆写口优先，缺省 forkViaCliPi）+ fail-fast 验收 fork 文件；源不可用或 bootstrap
   * 失败 → warn 后回落（返回 undefined = 分支② 无快照新建，pill 不静默）。
   */
  private async forkSnapshotForLine(
    source: BtwSourceState,
    sourceFile: string | undefined,
    threadDir: string,
    cwd: string,
  ): Promise<string | undefined> {
    if (source.state !== 'ok' || !sourceFile) {
      // 分支② 预期路径（首 flush 前源不存在）：警告含不可用原因，不构成 IO 故障伪装（规则 #11.2）。
      console.warn(`[btw] fork source unavailable (${source.state === 'unavailable' ? source.reason : 'n/a'}), creating no-snapshot line (source=${sourceFile ?? '<unresolved>'})`)
      return undefined
    }
    // 分支①：源可用 → pi 原生 fork（--fork + --session-dir，V2①）。
    try {
      const fork = this.deps.forkSession
        ? await this.deps.forkSession({ sourceFile, threadDir, cwd })
        : await forkViaCliPi({ piCommand: this.deps.resolvePiCommand(), sourceFile, threadDir, cwd })
      readSessionHeader(fork) // fail-fast：fork 文件不可解析 → 回落（不产半截态登记）
      return fork
    } catch (e) {
      // best-effort 降级：fork bootstrap 失败（源消失/超时/异因）→ 回落无 fork 分支，
      // 不静默——pill 标 no-source + 警告日志（D3 分支② 编排，原始错误已进日志）。
      console.warn(`[btw] fork bootstrap failed, falling back to no-snapshot line: ${toErrorMessage(e)}`)
      return undefined
    }
  }

  /**
   * createLine 的 spawn/附着/登记编排：临时 key spawn →（fork 时）switch_session +
   * 附着断言（I1：登记路径 ≡ pi 写路径）→ get_state 守卫 → rekey →
   * registerSession(hidden:true) → 注册表登记 + 契约注入留痕 + 闲置武装。
   * 任一步失败 → 双键收尸（不留半截条目）。
   */
  private async spawnAndRegisterLine(
    ctx: BtwLineSpawnContext,
    label: string,
    forkFile: string | undefined,
    options: BtwLineSpawnOptions,
  ): Promise<BtwCreateResult> {
    const { mainSid, cwd, snapshotKind } = ctx
    const tempKey = `btw-create-${crypto.randomUUID()}`
    let registeredKey = tempKey
    try {
      const client = await this.deps.processes.createSession(tempKey, cwd, options)
      if (forkFile) {
        await client.switchSession(forkFile)
        await assertPiSessionFile(client, forkFile, `btw.createLine(${mainSid})`)
      }
      const { piSessionId, sessionFilePath } = await requireSpawnState(client, forkFile)
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
        threadDir: ctx.threadDir,
        sessionFilePath,
        snapshotKind,
        hidden: true,
        createdAt: this.now(),
        lastActivityAt: this.now(),
        pendingInteraction: false,
        reclaimImminent: false,
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
      this.armTimer() // 幂等兜底（BU1）：活线在场 ⇒ 闲置扫描必须在跑
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
      // [BU1] 重附着成功必须武装闲置定时器：rebuildFromDisk → ensureProcess 链此前从不 arm
      //（armTimer 仅 createLine 成功路径调用），回收后续问/重启重开的线进程永不回收
      //（~138MB/线常驻，D1 代价 #3 回收前提落空）。armTimer 幂等（已有非空守卫）。
      this.armTimer()
      // [D1 豁免随请求失效] 重附着 = 旧轮挂起请求的失效终态（中断 turn / 进程亡同一切面）
      // → 结构解除；markActivity 随后顺带清回收提醒。
      rec.pendingInteraction = false
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

  /**
   * 活跃信号（实装触发 = 本服务内部调用：ensureProcess 活跃/重附着路径与
   * setPendingInteraction(false) 的终态应答支；闲置计时 = 本时间戳与
   * client.lastActivityAt 取 max 兜底）。
   */
  markActivity(vid: string): void {
    const rec = this.registry.get(vid)
    if (!rec) return
    rec.lastActivityAt = this.now()
    this.clearReclaimImminent(rec) // D1 回收提醒清除支：用户续问 → 提醒清（驱动广播）
  }

  /**
   * 有待处理交互登记（D1 豁免：不计闲置；豁免随任一终态解除——终态机触发点归 M3-c，
   * 本方法是其解除口）。登记本身即提醒态的一部分（badge 待处理 = M3-c 消费）。
   */
  setPendingInteraction(vid: string, pending: boolean): void {
    const rec = this.registry.get(vid)
    if (!rec) return
    rec.pendingInteraction = pending
    if (pending) {
      this.clearReclaimImminent(rec) // 挂起交互 → 线不计闲置，回收提醒同步失效
    } else {
      this.markActivity(vid) // 终态应答视为一次活跃（防解除即刻误回收）+ 顺带清回收提醒
    }
  }

  /**
   * 关线（btw.remove 原语，单线销毁；**三路并发收敛的单入口**——btw.remove 直调、
   * delete 对 btw vid 直删、主删级联 closeAllForMain 逐线转调，均落本方法）：
   * 杀进程（派生 subagent/workflow 任务随 pi 进程亡——abort 幂等由 pm.destroySession
   * 「Map 无条目静默跳过」保证）+ 注册表移除 +（可选）删线会话文件（路径限定 btw 根内，
   * 防误删面）。未知线/并发双删返 false（调用方映射 line_not_found，幂等语义：
   * 线已不在即视为删成）。**失效腿（闲置回收/进程亡）不走本方法**——不清注册表、
   * 不删文件、不清派生键（线可重开，D9④）。
   */
  async closeLine(vid: string, opts?: { deleteSessionFile?: boolean }): Promise<boolean> {
    const rec = this.registry.get(vid)
    if (!rec) {
      // 幂等完成面（M4-a）：注册表已无此线（并发双删 / 级联先行）仍补发一次终结扇出——
      // lifecycle 条目可能残留（planned kill 不走 exit 链），回调自身幂等（无条目零动作）。
      this.fireLineTerminated(vid)
      return false
    }
    this.registry.delete(vid)
    if (rec.client) await this.deps.processes.destroySession(vid).catch((e: unknown) => console.warn(`[btw] closeLine destroy failed (${vid}): ${toErrorMessage(e)}`))
    // 终结扇出（M4-a 单入口）：lifecycle 条目 / 总线分区 / 插件数据收尾——三路终结合一挂点。
    this.fireLineTerminated(vid)
    if (opts?.deleteSessionFile && rec.sessionFilePath && isInsideBtwRoot(rec.sessionFilePath)) {
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

  /**
   * 主删 / deleteByCwd 级联（D4 消费面① + D9④ 线终结）：关闭主会话名下全部线并删线目录。
   *
   * 三步序即并发收敛语义（D9④）：①**枚举先于注册表移除**（listLines 快照在循环前——
   * 快照后并发关线只会让后续 closeLine 幂等返 false，不漏杀不重杀）→ ②逐线转调 closeLine
   *（单入口；abort 幂等）→ ③按 cwd+mainSid 推导整目录删除（**不依赖注册表完备**——
   * 不可解析文件的残留目录同样清；路径限定 btw 根内）。
   * best-effort：逐段失败 warn 不上抛（调用方是删除主链，P2 降级隔离；漏删由启动孤儿补账兑底）。
   */
  async closeAllForMain(mainSid: string, cwd: string): Promise<void> {
    for (const rec of this.listLines(mainSid)) {
      try {
        await this.closeLine(rec.vid)
      } catch (e) {
        // best-effort：删线失败不上抛（主删链 P2 降级隔离），漏删由启动孤儿补账兑底
        console.warn(`[btw] closeAllForMain line close failed (${rec.vid}): ${toErrorMessage(e)}`)
      }
    }
    try {
      const threadDir = getBtwThreadDir(cwd, mainSid)
      if (isInsideBtwRoot(threadDir)) {
        rmSync(threadDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    } catch (e) {
      // best-effort：删线目录失败不上抛（主删链 P2 降级隔离），漏删由启动孤儿补账兑底
      console.warn(`[btw] closeAllForMain dir removal failed (mainSid=${mainSid}): ${toErrorMessage(e)}`)
    }
  }

  /** 停止闲置扫描定时器（shutdown / 测试收尾）。 */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer as Parameters<typeof clearInterval>[0])
      this.timer = null
    }
  }

  // ── 内部 ──

  /** 终结扇出（best-effort：扇出失败不阻断关线主链；回调内部各步自身隔离/幂等）。 */
  private fireLineTerminated(vid: string): void {
    try {
      this.deps.onLineTerminated?.(vid)
    } catch (e) {
      // best-effort：终结扇出异常不阻断关线主链（回调内各步自身隔离/幂等），留痕可归因
      console.warn(`[btw] onLineTerminated hook failed (${vid}): ${toErrorMessage(e)}`)
    }
  }

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

  /** 回收前提醒（onWillReclaim）触发口：hook 异常不打断回收主链（best-effort 留痕）。 */
  private fireWillReclaim(vid: string): void {
    try {
      this.deps.onWillReclaim?.(vid)
    } catch (e) {
      // best-effort：提醒挂点异常不打断回收主链（提醒兑底 = 回收分支 catch-up 补发），留痕可归因
      console.warn(`[btw] onWillReclaim hook failed (${vid}): ${toErrorMessage(e)}`)
    }
  }

  /** 回收提醒态清除（D1 清除支统一口：回收发生/续问/进程亡/交互置位）：翻转 + 驱动广播。 */
  private clearReclaimImminent(rec: BtwLineRecord): void {
    if (!rec.reclaimImminent) return
    rec.reclaimImminent = false
    try {
      this.deps.onThreadStateChanged?.(rec.vid)
    } catch (e) {
      // best-effort：清除广播异常不打断回收/活跃主链（状态已翻转，恢复通道 = btw.list RPC 拉取兜底）
      console.warn(`[btw] onThreadStateChanged hook failed (${rec.vid}): ${toErrorMessage(e)}`)
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
        // 失效腿结构解除（D1）：进程亡 = 挂起请求失效终态 + 回收提醒失去意义，双双清。
        rec.client = undefined
        rec.pendingInteraction = false
        this.clearReclaimImminent(rec)
        continue
      }
      if (rec.pendingInteraction) {
        // [BU2 派生解除] 已置位但交互中转（respond/expired/失效共同落点）已空 → 派生解除
        //（三终态统一覆盖；解除即 re-age，防解除即刻误回收）。中转仍 pending → 继续豁免。
        if (this.deps.hasPendingUiRequests && !this.deps.hasPendingUiRequests(rec.vid)) {
          this.setPendingInteraction(rec.vid, false)
        } else {
          continue // 豁免：有待处理交互不计闲置（D1）
        }
      }
      const last = Math.max(rec.lastActivityAt, client.lastActivityAt)
      const idle = now - last
      if (idle >= this.idleThresholdMs) {
        // 回收前提醒（D1）：正常窗已在前一拍置位；时钟跳拍（休眠唤醒跨窗直达回收）时兜底
        // 补发——保证 onWillReclaim 恒在 destroy 前触发（提醒挂点可达不变量）。
        if (!rec.reclaimImminent) {
          rec.reclaimImminent = true
          this.fireWillReclaim(rec.vid)
        }
        rec.client = undefined
        this.clearReclaimImminent(rec) // D1：回收发生 → 提醒清（清除支广播）
        void this.deps.processes.destroySession(rec.vid).catch((e: unknown) => {
          console.warn(`[btw] reclaim destroy failed (${rec.vid}): ${toErrorMessage(e)}`)
        })
        continue
      }
      // 提前 1 拍提醒窗（D1「回收前」，实装窗口 = 阈值 − 扫描节拍）：置提醒态 + 驱动广播；
      // 下一拍满阈值才真回收（badge 待处理呈现已接线：renderer useBtwTabData
      // setBtwReclaimReminder，数据源 = reclaimImminent）。
      if (!rec.reclaimImminent && idle >= this.idleThresholdMs - BTW_IDLE_TICK_MS) {
        rec.reclaimImminent = true
        this.fireWillReclaim(rec.vid)
      }
    }
  }
}
