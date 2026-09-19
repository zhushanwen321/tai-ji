/**
 * EventInterpreter — 消费 PiTranslatedEvent[]，执行业务编排（R1 重构）。
 *
 * [定位] service 层。承接 EventAdapter（infra 纯翻译器）产出的中间事件，做副作用：
 *   1. plugin hook 触发（onBeforeToolCall 阻断/改写、onAfterToolResult 改写、onPiEvent 观测）
 *   2. file_changes diff（turn 内写操作实时 + agent_end 最终对账）—— 经 IFileChangeDiff port
 *      （W18 采集异步化：diffChain 串行链 + turnGen 代际 + turnFinalizing 压制，03 D3-3）
 *   3. context 事件失效（sessionService.applyContextUpdate——W12 起只做 usage 实例失效，
 *      context.update 广播由快照应用后的挂钩发布）
 *   4. status/bridge/extension-ui 路由到 server（注册超时 / 处理 bridge 请求）
 *   5. subagent/workflow record 失效信号（W18 D4：entry_appended 主信号 + bg-notify/
 *      workflow-result/tool-call-end 兜底信号 → onRecordEntriesInvalidated——事件直写
 *      退役，数据由 sessionService 的 entry 扫描派生缓存承载）
 *
 * 持有的可变态（从 event-adapter 迁来）：
 *   - currentMessageId（message_start 设置，file_changes 挂载目标）
 *   - writeContents（本 turn write 工具写入的 content，untracked 行数回退用）
 *   - diffChain / turnGen / turnFinalizing（W18 帧序三件套）
 *
 * [T4 协作对象拆分] 五个特性域中状态面独立、与主循环无时序耦合的四域抽为同目录协作对象
 *（本类构造时装配、方法委托；协作对象不持本类引用，只收窄接口回调）：
 *   - event-interpreter-gen-stats.ts：LlmWindowSampler——composer-gen-stats LLM 请求窗口
 *     状态机（turnStartedAt / llmWindowDurationMs 配对消费，登记方向 ①）
 *   - event-interpreter-settled-delay.ts：AgentSettledDelayer——agent_settled V7 延迟注入
 *     + disposed 销毁短路（登记方向 ②）；收敛窗常量随迁避免反向 import 成环
 *   - event-interpreter-ping.ts：PingProbe——ADR-0047 进程健康探测循环（登记五域之外，
 *     同为独立状态面、挂点仅 turn-start/turn-end/dispose 三处）
 *   - event-interpreter-compaction.ts：CompactionNotifier——compaction 双事件到 WS 帧 +
 *     副作用回调的纯同步编排（无内部状态，不牵动主循环时序，评估为低风险）
 * 保留在本类：file_changes 帧序三件套（diffChain/turnGen/turnFinalizing 与 turn-start/end、
 * tool-call hook 链交织，抽取牵动主循环时序）、session-manager 路由（单 case 5 行透传，
 * 不构成独立变化轴量）、occupancy 原语与 UserStoppedGate（多模块共享原语/门面，非本类私有域）。
 *
 * [ADR-0024 D5] git 作为唯一真值源：写操作后 diff 当前 git status，agent_end 推 ready 全集。
 * 非 git 仓库 / cwd 缺省 → 跳过 diff（不推 file_changes）。
 * [R-09] turn-start 不再采 baseline——diffSnapshots 输出只依赖 current（死参数已删）。
 *
 * 依赖经构造注入：send（WS 帧）、fileChangeDiff（port，git 纯函数经组合根注入）、
 * 各业务回调（executeHooks / contextUpdate / thinkingLevel / status/bridge/extension-ui 路由）。
 */
import type { ServerMessage, ServerMessageType } from '@taiji/shared'
import type { FileChange } from '@taiji/shared'
import { SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '@taiji/shared'
import { CompactionNotifier } from './event-interpreter-compaction.js'
import { LlmWindowSampler } from './event-interpreter-gen-stats.js'
import { PingProbe } from './event-interpreter-ping.js'
import { AgentSettledDelayer, ABORT_STALL_CONVERGENCE_WINDOW_MS } from './event-interpreter-settled-delay.js'

// [T4 协作对象拆分] 常量本体随域迁至协作对象文件（ping 三常量 → event-interpreter-ping.ts、
// 收敛窗常量 → event-interpreter-settled-delay.ts），此处 re-export 保住既有导出面
//（event-interpreter-ping-dispose.test.ts 等直接 import 本文件；SR6 SSOT）。
export { ABORT_STALL_CONVERGENCE_WINDOW_MS } from './event-interpreter-settled-delay.js'
export { PING_INTERVAL_MS, PING_FAIL_THRESHOLD, PING_WARN_FAIL_COUNT } from './event-interpreter-ping.js'
import { toErrorMessage } from '../../utils/errors.js'
import type { SessionManagerAction } from '@zhushanwen/extension-protocol'
import type { IFileChangeDiff } from '../ports/file-change-diff.js'
import type {
  ForceQuitSource,
  GenStatsSample,
  IManagedSessionView,
  PiTranslatedEvent,
  SessionOccupancy,
  SessionOccupancyStateStore,
  SessionOccupancyTransition,
  UserStoppedMarkStore,
} from './types.js'

/**
 * occupancy 的 idle 初值（session-occupancy-send-closure D3）：registerSession 初始化与
 * updateSessionOccupancy 对「记录尚无 occupancy 字段」的兜底合并共用。
 */
export const IDLE_SESSION_OCCUPANCY: SessionOccupancy = { turn: 'idle', compacting: false, bash: false }

/**
 * occupancy 幂等写（session-occupancy-send-closure D3 十一挂点的统一写原语）：
 * patch 合并 → 三维全等比较 → **值变化才**写回 session 记录 + 广播 session.occupancy 帧。
 *
 * - 幂等：每个挂点直写目标值（非增量状态机），乱序/重复事件不产生错误状态——settling 中
 *   再收 turn-end 仍写 settling，retry/followUp 续跑（settling→generating）天然覆盖。
 * - 去重：全等比较挡住无变化帧刷屏（abort 兜底与 agent-settled 撞出双 idle 等场景）。
 * - publish 为 null/undefined 时（bus 未注入 / 测试）静默跳过广播，状态照常写——与
 *   dispatcher 其他 publish 点的 null-safe 惯例一致。
 *
 * 唯一写入口：全部挂点（interpreter #2-#6 经 onOccupancyTransition 回调、dispatcher
 * #1/#7-#9/#11 与 forceQuit/compact 兜底、deliverText 置位、agent_end/agent_settled 副作用、
 * onSessionExit 全复位）均已改调 applySessionOccupancyTransition（u3b 迁移完成）；
 * 本函数降级为原语的内部机制（合并 + 去重 + state-topic 广播腿），不再被挂点直调。
 * OccupancyPublisher 取 IMessageBus 的结构化窄投影（只依赖 publish，test mock 友好）。
 *
 * [session-dead-structural-fixes D2] 本函数自 u2 起降级为 applySessionOccupancyTransition
 * 原语的内部机制（u3b 挂点迁移完成后原语是唯一写入口，u3c readonly 收紧后绕开原语的
 * 直写在编译期红）。
 */
export function updateSessionOccupancy(
  session: Pick<IManagedSessionView, 'id' | 'occupancy'>,
  publish: { publish(sessionId: string, msg: ServerMessage): void } | null | undefined,
  patch: Partial<SessionOccupancy>,
): void {
  const prev = session.occupancy ?? IDLE_SESSION_OCCUPANCY
  const next: SessionOccupancy = { ...prev, ...patch }
  if (prev.turn === next.turn && prev.compacting === next.compacting && prev.bash === next.bash) return
  session.occupancy = next
  publish?.publish(session.id, {
    type: 'session.occupancy',
    payload: { sessionId: session.id, turn: next.turn, compacting: next.compacting, bash: next.bash },
  })
}

/**
 * 转移表（session-dead-structural-fixes D2，「转移表即文档」）：封闭枚举每行的
 * occupancy 三维 patch + 三布尔派生。派生布尔是既有挂点「同点双写」的转正——迁移后
 * 原语一次调用原子完成「合并 occupancy → 派生三布尔 → 幂等比较 → 广播」，结构上
 * 消灭「只写一边」的漂移写点（deliverText 只写布尔 / message_start 只写 occupancy 类）。
 *
 * 派生语义对齐现状（读侧零回归）：
 * - dispatching/generating → isGenerating=true（#1 markSessionActive / turn-start 语义）；
 * - settling/idle → isGenerating=false（#3 onTurnFinalize 先复位再写 settling 的既有顺序，
 *   派生后二者合一）；
 * - reject-processing → isGenerating=true（A1 止血转正：pi 拒绝「已有一个 turn 在跑」是
 *   权威信号，反转幽灵空闲）；
 * - reject-other → isGenerating=false（compacting 拒绝与非 busy 真失败：turn 没跑起来）；
 * - full-reset / abort-stall-force-kill → 三布尔全复位（进程死亡腿，agent_settled 永不到达）；
 * - abort-stall-converged → idle（预留行：兄弟分支 abort 阶梯「重试收敛」收口，挂点接线
 *   由 fix-subagent-no-notification 合并方完成，本单元只登记派生定义）。
 */
const SESSION_OCCUPANCY_TRANSITIONS: Record<
  SessionOccupancyTransition,
  | {
      patch: Partial<SessionOccupancy>
      flags: Partial<Pick<IManagedSessionView, 'isGenerating' | 'isCompacting' | 'isBashRunning'>>
    }
  | 'announce'
> = {
  'dispatching': { patch: { turn: 'dispatching' }, flags: { isGenerating: true } },
  'generating': { patch: { turn: 'generating' }, flags: { isGenerating: true } },
  'settling': { patch: { turn: 'settling' }, flags: { isGenerating: false } },
  'idle': { patch: { turn: 'idle' }, flags: { isGenerating: false } },
  'compacting-start': { patch: { compacting: true }, flags: { isCompacting: true } },
  'compacting-end': { patch: { compacting: false }, flags: { isCompacting: false } },
  'bash-start': { patch: { bash: true }, flags: { isBashRunning: true } },
  'bash-end': { patch: { bash: false }, flags: { isBashRunning: false } },
  'full-reset': {
    patch: { turn: 'idle', compacting: false, bash: false },
    flags: { isGenerating: false, isCompacting: false, isBashRunning: false },
  },
  'reject-processing': { patch: { turn: 'generating' }, flags: { isGenerating: true } },
  'reject-other': { patch: { turn: 'idle' }, flags: { isGenerating: false } },
  'announce-idle': 'announce',
  'abort-stall-converged': { patch: { turn: 'idle' }, flags: { isGenerating: false } },
  'abort-stall-force-kill': {
    patch: { turn: 'idle', compacting: false, bash: false },
    flags: { isGenerating: false, isCompacting: false, isBashRunning: false },
  },
}

/**
 * 单一转移写原语（session-dead-structural-fixes D2）：封闭转移枚举的唯一入口，内部原子完成
 * 「合并 occupancy 三维 → 按转移类型派生三布尔 → 幂等比较 → 广播」。
 *
 * - 通路归属：广播走既有 state-topic 通路（bus.publish = 实时广播 + 快照写入/重订阅回放
 *   双腿，见 MessageBus topicOf 分流），禁止绕过 state topic 裸 publish。
 * - announce-idle 特例（registerSession 宣告帧收编行，Gate B V6b④）：合并/派生均为 no-op，
 *   跳过全等去重强制广播当前投影——对象初值即 idle 时全等去重会短路广播，而宣告帧职责
 *   恰恰是「宣告」（重订阅回放必达），不是「转移」。
 * - 三布尔直写在 session 记录（派生存储，幂等无广播语义）；occupancy 合并与去重复用
 *   updateSessionOccupancy 既有机制。
 *
 * u3b 挂点迁移完成后本原语是唯一写入口；u3c readonly 收紧已落地——三布尔在 IManagedSessionView
 * 为 readonly 派生存储，原语经 SessionOccupancyStateStore 写视图（types.ts）完成内部派生写，
 * 绕开原语的直写在编译期红（约束 C-data-19）。
 */
export function applySessionOccupancyTransition(
  session: SessionOccupancyStateStore,
  publish: { publish(sessionId: string, msg: ServerMessage): void } | null | undefined,
  transition: SessionOccupancyTransition,
): void {
  const row = SESSION_OCCUPANCY_TRANSITIONS[transition]
  if (row === 'announce') {
    const current = session.occupancy ?? IDLE_SESSION_OCCUPANCY
    publish?.publish(session.id, {
      type: 'session.occupancy',
      payload: { sessionId: session.id, turn: current.turn, compacting: current.compacting, bash: current.bash },
    })
    return
  }
  for (const [flag, value] of Object.entries(row.flags) as Array<
    [keyof Pick<IManagedSessionView, 'isGenerating' | 'isCompacting' | 'isBashRunning'>, boolean]
  >) {
    session[flag] = value
  }
  updateSessionOccupancy(session, publish, row.patch)
}

// ── userStopped 标记门面 + restore-abort 收敛环（session-dead-structural-fixes D4）──

// [T4 协作对象拆分] 收敛窗常量（ABORT_STALL_CONVERGENCE_WINDOW_MS）与 dev settling 延迟读取
//（readDevSettlingDelayMs）迁至 event-interpreter-settled-delay.ts——后者上界约束引用前者，
// 同文件避免 settled-delay → event-interpreter 反向 import 成环；常量经顶部 re-export 转发。

/**
 * userStopped 门面 + 收敛环控制器（D4）。
 *
 * 为什么放本文件：标记宿主 Map 按规格必须在 session-service.ts（模块级、独立于
 * ManagedSession 生命周期），而 session-service 值导入本文件——子模块反向 import 会成环。
 * 本门面是子模块（dispatcher/lifecycle/interpreter 挂点）与宿主 Map 之间唯一的无环通路：
 * SessionService 构造时经 configure 注入宿主存取 + abort 能力，挂点/调用方用模块级单例。
 *
 * 收敛环状态机（D4 规格，v4 修订③前置）：
 * - begin(sid)：restoreSession 返回前的 abort 成功完成后调用——静默观察窗自此刻起算
 *   （「restore 无 replay turn 的 idle 场景同样有明确起点」）。
 * - noteAgentStart(sid)（interpreter hook agent_start 挂点）：环活跃且标记存活 → 非显式
 *   投递引发的 turn → 一律再 abort（掐补发腿开的 turn），置 pendingSettled。
 * - noteAgentSettled(sid)（interpreter agent-settled 挂点）：被掐 turn 收尾的 settled 边沿
 *   → 清 pendingSettled + 重置观察窗（重起算）。
 * - 窗到期：pendingSettled=false → 判收敛 → 清标记停环；true（掐而 settled 未到——pi 收尾
 *   卡顿超窗）→ 窗满不清，待 settled 到达重置窗后重起算（v4 边界缝前置）。
 * - consumeForExplicitDelivery(sid)：runtime 经手的投递（sendPrompt 等显式路径）= 新意图，
 *   投递前清标记放行 + 停环（补发腿不经 runtime 所以不适用——区分点 = 投递路径本身）。
 *
 * 有界性（D4）：notify-ledger 受理即 sent、回执判定秒级 ack、重投上限 abandoned 终态——
 * 待补投条目有限，收敛环至多 N+1 轮。已知登记例外（异步重投残余链、重启窗口）见设计 D4
 * 代价登记，此处不重复机制。
 */
export class UserStoppedGate {
  /** 宿主存取 + abort 能力（SessionService 构造时注入；未注入时全部 no-op——测试友好）。 */
  private deps: {
    marks: UserStoppedMarkStore
    abortSession: (sessionId: string) => Promise<void>
  } | null = null
  /** per-session 收敛环状态（环活跃 = 条目存在）。非 GUI 数据技术簿记（timer 句柄 +
   *  pendingSettled 布尔），豁免登记 = taste:allow-no-data-owner W24-EX-C（§4 ⑧ ⑤，
   *  2026-09-10 u3b 补登）；数据本体「用户停止意图标记」在主表 #30。 */
  private readonly converging = new Map<string, {
    timer: ReturnType<typeof setTimeout>
    /** 有被环内 abort 掐掉的 turn 其 settled 未到达。 */
    pendingSettled: boolean
  }>()

  /** 组合根接线（SessionService 构造时调用；重复调用覆盖——测试多实例幂等）。 */
  configure(deps: {
    marks: UserStoppedMarkStore
    abortSession: (sessionId: string) => Promise<void>
  }): void {
    this.deps = deps
  }

  /**
   * 置标记（K1/K2 置位分型唯一入口，经 forceQuitSession 调用）。
   * 未 configure（测试直构 dispatcher/lifecycle，不经 SessionService 构造器接线）时降级
   * no-op——生产路径 SessionService 构造器恒 configure，不可能到达此分支。
   */
  markUserStopped(sessionId: string, source: ForceQuitSource): void {
    if (!this.deps) {
      console.warn(`[event-interpreter] userStoppedGate not configured, mark dropped (sessionId=${sessionId}, source=${source})`)
      return
    }
    this.deps.marks.markUserStopped(sessionId, source)
  }

  /** 标记是否存活（restoreSession 返回前检测）。 */
  hasUserStoppedMark(sessionId: string): boolean {
    return this.deps !== null && this.deps.marks.hasUserStoppedMark(sessionId)
  }

  /**
   * restore-abort 完成：启动收敛环（静默窗自 abort 完成起算）。幂等——重复 begin（二次
   * restore）先停旧窗重起新窗。调用前提 = restore-abort 已成功（abort 失败路径不起环，
   * 标记不视为已消费，错误规格 §3.4）。
   */
  beginRestoreConvergence(sessionId: string): void {
    this.stopTimer(sessionId)
    const timer = setTimeout(() => { this.onWindowElapsed(sessionId) }, ABORT_STALL_CONVERGENCE_WINDOW_MS)
    this.converging.set(sessionId, { timer, pendingSettled: false })
  }

  /**
   * interpreter hook agent_start 挂点：环活跃期间的非显式投递 agent_start 一律再 abort。
   *
   * 「非显式投递」由时序构造性保证：显式投递（sendPrompt 等）先经 consumeForExplicitDelivery
   * 清标记停环，其 turn 的 agent_start 事件回流必然晚于清标记（清在 prompt RPC 发出之前），
   * 到达时环已停 → 不拦截。环活跃期间到达的 agent_start 只能来自不经 runtime 的触发源
   * （notify replay / scheduler / auto-retry）。
   */
  noteAgentStart(sessionId: string): void {
    const st = this.converging.get(sessionId)
    if (!st) return
    if (!this.hasUserStoppedMark(sessionId)) {
      // 防御：环在标记不在（显式投递清标记与事件回流的窄竞态）→ 放行不拦。
      this.stopTimer(sessionId)
      this.converging.delete(sessionId)
      return
    }
    st.pendingSettled = true
    console.warn(`[event-interpreter] userStopped convergence: intercepting unattributed agent_start, re-aborting (sessionId=${sessionId})`)
    // fire-and-forget：abort 内部已含失败链（超时 → forceQuitSession 强杀收敛）。失败时
    // pendingSettled 保持 true → 窗满不清（标记不视为已消费，错误规格 §3.4）。
    this.deps?.abortSession(sessionId).catch((e: unknown) => {
      console.warn(`[event-interpreter] userStopped convergence: re-abort failed, mark kept (sessionId=${sessionId}):`, e)
    })
  }

  /**
   * interpreter agent-settled 挂点：被掐 turn 收尾的 settled 边沿 → 清 pendingSettled +
   * 重置观察窗（无论 pendingSettled 与否都重置——restore-abort 掐掉的 replay turn 不经过
   * noteAgentStart，其 settled 是「有被掐 turn」的唯一事后信号，重置窗给补发腿的
   * agent_start 留满窗拦截时间）。
   */
  noteAgentSettled(sessionId: string): void {
    const st = this.converging.get(sessionId)
    if (!st) return
    st.pendingSettled = false
    this.resetWindow(sessionId, st)
  }

  /**
   * 显式投递放行（sendPrompt 等经 runtime 的投递调用）：清标记 + 停环。投递前调用——
   * 新意图不受任何闸门拦截（D4）。
   */
  consumeForExplicitDelivery(sessionId: string): void {
    if (!this.hasUserStoppedMark(sessionId) && !this.converging.has(sessionId)) return
    this.stopTimer(sessionId)
    this.converging.delete(sessionId)
    this.marks().clearUserStoppedMark(sessionId)
  }

  /** delete 等彻底清理路径：清标记 + 停环。 */
  disposeForDelete(sessionId: string): void {
    this.stopTimer(sessionId)
    this.converging.delete(sessionId)
    if (this.hasUserStoppedMark(sessionId)) this.marks().clearUserStoppedMark(sessionId)
  }

  /**
   * session 条目删除汇聚点（removeSessionEntry）的环清理：只停环不清标记——forceQuit
   * （K1/K2）尾步经过本挂点，标记必须存活到 restore（D4 标记宿主独立于 ManagedSession
   * 生命周期的原因）。
   */
  disposeForEntryRemoval(sessionId: string): void {
    this.stopTimer(sessionId)
    this.converging.delete(sessionId)
  }

  /** destroyAll：全量清理（停全部环 + 清全部标记，shutdown 路径）。 */
  disposeAll(): void {
    for (const sessionId of this.converging.keys()) this.stopTimer(sessionId)
    this.converging.clear()
    this.deps?.marks.clearAllUserStoppedMarks()
  }

  /** 测试辅助：重置全部内部状态与依赖注入（跨用例隔离；生产不调用）。 */
  resetForTest(): void {
    for (const sessionId of this.converging.keys()) this.stopTimer(sessionId)
    this.converging.clear()
    this.deps = null
  }

  private marks(): UserStoppedMarkStore {
    if (!this.deps) {
      throw new Error('[event-interpreter] UserStoppedGate not configured (SessionService constructor wires it)')
    }
    return this.deps.marks
  }

  private resetWindow(sessionId: string, st: { timer: ReturnType<typeof setTimeout>; pendingSettled: boolean }): void {
    clearTimeout(st.timer)
    st.timer = setTimeout(() => { this.onWindowElapsed(sessionId) }, ABORT_STALL_CONVERGENCE_WINDOW_MS)
  }

  private stopTimer(sessionId: string): void {
    const st = this.converging.get(sessionId)
    if (st) clearTimeout(st.timer)
  }

  private onWindowElapsed(sessionId: string): void {
    const st = this.converging.get(sessionId)
    if (!st) return
    if (st.pendingSettled) return // 掐而 settled 未到：窗满不清，待 settled 边沿重置窗
    this.stopTimer(sessionId)
    this.converging.delete(sessionId)
    if (this.hasUserStoppedMark(sessionId)) {
      this.marks().clearUserStoppedMark(sessionId)
      console.warn(`[event-interpreter] userStopped convergence: quiet window elapsed, mark cleared (sessionId=${sessionId})`)
    }
  }
}

/** 模块级单例（生产挂点与调用方共用；SessionService 构造时 configure）。 */
export const userStoppedGate = new UserStoppedGate()


/** plain object 判定（type-safety review：plugin hook 返回值是不可信边界——Worker/
 * sandbox 里的第三方代码可返回任意值，改写前必须 shape 守卫，畸形值丢弃改写保原值）。 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** plugin hook 执行回调（组合根注入，封装 pluginService.executeHooks + sessionId 注入）。 */
export type ExecuteHookFn = (
  hookType: string,
  context: Record<string, unknown>,
) => Promise<{ blocked: boolean; transformedData?: unknown }>

/**
 * EventInterpreter 构造依赖（全部由组合根注入）。
 *
 * 设计权衡：callbacks 用单独函数而非注入整个 pluginService/sessionService/server——
 * 保持 interpreter 单一职责（只见它需要的窄接口），便于测试 mock。
 */
export interface EventInterpreterOptions {
  /** pi session 工作目录（git baseline diff 用）。缺省 → 跳过 file_changes。 */
  cwd?: string
  /** WS 帧发送。 */
  send: (msg: ServerMessage) => void
  /** file_changes diff 引擎（port，组合根注入 infra 实现，采集经 GitStateService 异步）。 */
  fileChangeDiff?: IFileChangeDiff
  /** plugin hook 执行（onBeforeToolCall/onAfterToolResult/onPiEvent）。组合根注入 pluginService.executeHooks。 */
  executeHooks?: ExecuteHookFn
  /** context 事件失效（组合根注入 sessionService.applyContextUpdate——W12 起只做 usage 实例 markDirty）。 */
  onContextUpdate?: (sessionId: string, data: { inputTokens: number; totalTokens: number }) => void
  /**
   * pi turn_end 单 turn 用量到达后触发（组合根注入 sessionService.handleTurnUsageSideEffects，
   * 承载 project sidecar 兜底等 turn 级副作用；label 持久化 W1 起移交 pi set_session_name RPC）。
   */
  onTurnUsage?: (sessionId: string) => void
  /**
   * composer-gen-stats（D1/D2）：turn-usage 组装 GenStatsSample 后采样回调（组合根注入
   * GenStatsService.recordSample）。durationMs = llmWindowDurationMs——assistant
   * message_start → assistant message_end 的 LLM 请求窗口本地时钟差（不含工具执行时间，
   * genstats-speed-llm-window D1 口径）；真缺闭/缺起（pi 崩溃断连 / runtime 中途启动
   * 丢 message_start）→ durationMs=null，service 侧速度样本跳过、命中率样本照常（§3.5）。
   * 同步 fire-and-forget（service 内部完成落盘与扩展广播，不阻塞事件流）。
   */
  onGenStats?: (sessionId: string, sample: GenStatsSample) => void
  /**
   * pi agent_end 整循环结束时触发（组合根注入 sessionService.handleTurnEndSideEffects）。
   *
   * 承载副作用：复位 isGenerating=false（不迁移则正常生成完成后 session 永远 busy，下条消息被拒）
   * + project sidecar 兜底 + session_end 终态写入。
   */
  onTurnFinalize?: (sessionId: string, stopReason?: string) => void
  /**
   * session_info_changed 的内存态回写（组合根注入 sessionService.setLabelCache——
   * session.label 事件路径的唯一写方，toSummary/config.sessions 读它；session.renamed
   * 广播帧由 event-adapter 从事件 payload 直接转发，pi 是权威源）。
   * [HISTORICAL] label 的 ReplicatedState 实例及其 markDirty 失效接线已撤销（PR #185
   * MF1：实例 .get() 生产零消费，防抖重拉 get_state 属无效 RPC，事件直写即终态形态）。
   */
  onSessionRenamed?: (sessionId: string, name: string | undefined) => void
  /**
   * W7 data-source-governance：thinkingLevel ReplicatedState 实例的延迟解析器。
   *
   * thinking_level_changed 到达时调 thinkingLevelState()?.markDirty()——事件只做失效；
   * pi 同档位切换不发射事件，由 setThinkingLevel RPC 成功响应驱动的 markDirty 覆盖
   *（U6 删除了实例的 30s 周期兜底轮询，D9 附录 C.4）。延迟解析
   * （与 pingPi 同款模式）：interpreter 在 session 创建时构造，那时实例可能尚未
   * 注册（initializeManagedSession 先建 adapter 后注册实例）；session 已销毁时解析为
   * undefined（实例已 dispose，markDirty 本也是 no-op），安全跳过。
   */
  thinkingLevelState?: () => { markDirty: () => void } | undefined
  /** extension 交互式 UI 请求（注册前端超时 + 缓存 pending 请求）。组合根注入 server.registerExtensionTimeout。 */
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string, payload: Record<string, unknown>) => void
  /**
   * session-manager 请求（agent-managed session）。select 通道 + SESSION_MANAGER_MARKER。
   * fire-and-forget（不 await），由 SessionManagerHandler 异步处理并回写 response。
   * 组合根注入 server.handleSessionManagerRequest。
   */
  onSessionManagerRequest?: (requestId: string, sessionId: string, action: SessionManagerAction | '__malformed__', params: Record<string, unknown>) => void
  /** bridge:* 前缀请求（直接路由不经前端超时）。组合根注入 server.handleBridgeRequest。 */
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  /** extension setStatus（路由到 statusline builtin 插件，status-bar-registry 广播）。组合根注入 server.handleStatusSetUpdate。 */
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string; textRaw?: string }) => void
  /**
   * pi 卡死 abort 回调（ADR-0047 ping 探测机制）。
   *
   * turn 进行中每 60s ping get_state，连续 3 次（180s）失败时判定 pi 进程真死，
   * 触发本回调由组合根调 sessionService.abort（复用现有 abort 兜底广播路径）。
   * payload 携带 sessionId，供上层定位要 abort 的 session。
   */
  onSilentAbort?: (payload: { sessionId: string }) => void
  /**
   * compaction 生命周期态切换（M4 事件驱动）—— interpreter 从 compaction_start/end 唯一置位/复位
   * runtime active.isCompacting（sendPrompt/sendBash 预检互斥依据）。
   *
   * 组合根注入：(sid, v) => 写 sessionService.getSession(sid).isCompacting（与原 dispatcher 手动
   * 路径置位对称）。事件驱动后 dispatcher 不再置位，复位责任转移到 interpreter（三路对称复位）。
   */
  onCompactingStateChange?: (sessionId: string, isCompacting: boolean) => void
  /**
   * occupancy 挂点回调（session-dead-structural-fixes D2 挂点迁移，u3b）—— interpreter 侧
   * 挂点（turn-start→'generating' / turn-end→'settling' / agent-settled→'idle' /
   * compaction-start→'compacting-start' / compaction-end→'compacting-end' / turn-end 处理
   * 异常兜底→'settling'）经本回调由组合根接线到 applySessionOccupancyTransition（封闭转移
   * 枚举唯一入口：合并 occupancy 三维 + 派生三布尔 + 幂等比较 + 广播 state 帧）。
   *
   * 回调只传转移类型（封闭枚举值），合并/派生/去重在原语内——interpreter 是 per-session
   * 实例但不持有全量 occupancy（bash/dispatching 维度由 dispatcher 侧挂点写入），必须经
   * session 记录（权威聚合点）合并，否则会以 stale 维度广播错误三维。
   * 未注入时（存量单测）no-op，不广播。
   */
  onOccupancyTransition?: (transition: SessionOccupancyTransition) => void
  /**
   * session-trace 增量腿补拉回调（design D4 / A33，组合根注入 sessionService.syncTraceEntries）。
   *
   * 触发源四类：trace-trigger（message_end / agent_settled / entry_appended 三类现存事件
   * 作触发信号——pi 无 append 级广播）+ compaction-end（compaction entry append 先于
   * compaction_end emit，时序已核实）。回调内部自查 traceLeafCache 基线（无则 no-op），
   * 同步失败不影响主事件流。异步执行（追赶式拉取不阻塞 interpret 批次）。
   */
  onTraceSync?: (sessionId: string, trigger: string) => void
  /**
   * [reload-closeout D2] 送达水位对账腿回调（agent_settled 触发，组合根注入
   * sessionService.reconcileRecordEntries——重跑 fetch→merge→publish 管线，发布门 =
   * 已发布快照水位，守卫/发布门处曾丢的帧补发）。fire-and-forget（回调内部自带
   * inflight 合并与扫描域门），不阻塞 interpret 批次。
   */
  onRecordReconcile?: (sessionId: string) => void
  /**
   * 成功 compaction 后触发（归因降噪 2026-09-19；组合根注入 GenStatsService.markContextRewritten）。
   *
   * 语义：上下文被重写过（前缀整体变化）——命中率归因链路首个 0% 样本归为 context-rewrite。
   * 只在 compaction-end 且 `result` 真值（成功）时调用；failed / aborted 不调（上下文未变）。
   */
  onCompactionContextRewritten?: (sessionId: string) => void
  /**
   * [ADR-0047] ping get_state 进程健康探测回调（组合根注入）。
   *
   * 延迟解析 client：interpreter 在 session 创建时构造，那时 client 可能尚未 spawn。
   * 回调内部按当前 sessionId 取 pm.getClient(sessionId)?.getState()，client 未就绪时
   * 返回 undefined（计为一次失败但不抛错——AC-9：client 偶发未就绪不应让 interpret 批次崩溃）。
   *
   * 返回值语义：
   *   - resolve(非 undefined) → pi 健康（事件循环活，能响应 get_state）→ 清零失败计数
   *   - resolve(undefined)   → client 未就绪或拿不到 state → 计失败但不抛错（AC-9）
   *   - reject               → pi 真卡死（get_state 超时）→ 计失败
   *
   * 设计权衡：ping 能穿透所有「pi 合理等待」场景（ask_user / 网络 / 文件锁）——
   * pi 阻塞在 await 时事件循环仍活，get_state 必响应。只有进程真死才连续 3 次失败。
   * 详见 ADR-0047「ping 可行性验证」。
   */
  pingPi?: () => Promise<Record<string, unknown> | undefined> | undefined
  /**
   * W18（data-source-governance P3.1）：自描述 record entry 到达 → subagent/workflow/plan
   * 派生缓存失效。组合根注入 sessionService.invalidateRecordEntries——markDirty + 防抖
   * get_entries(since) 增量重拉，entry 扫描（scanSubagentEntries / scanWorkflowEntries /
   * scanPlanStateEntries）是派生缓存唯一数据写路径，事件 payload 永不直写缓存
   * （ReplicatedState「事件只做失效」不变量；W12-W18 过渡态例外至此撤销）。
   *
   * 触发源（全部降级为失效信号，W18 起事件直写退役）：
   * - entry_appended{customType: subagent-record | workflow-record | plan-state}
   *   （主信号，adapter 过滤；plan-state 第三员为 plan 模式重设计 D1② 扩容）
   * - subagent-bg-notify / subagent tool-call-end / workflow-result / workflow tool-call-end
   *   （兜底信号：extension 在同一状态迁移点既 append 自描述 entry 又发上述事件——主信号
   *   丢失（W22 混沌）时兜底触发重拉收敛）
   */
  onRecordEntriesInvalidated?: (sessionId: string, customType: 'subagent-record' | 'workflow-record' | 'plan-state') => void
  /**
   * W1（fix-chat-flow-order 探针 ②）：pi agent_settled（run 级联结束）到达时触发。
   * 组合根注入 sessionService.flushPendingBashResults——dispatcher 把 streaming 期间
   * 压入的 per-session bash 待落列按序转 message.bashResult 帧发布。时序保证：pi 在
   * _runAgentPrompt finally 先 _flushPendingBashMessages（bash entry 落盘）再 emit
   * agent_settled（agent-session.js:744-756），故本回调触发时 pi 文件内 bash entry 已就位，
   * taiji flush 的 live 入流位置与落盘位置一致（级联末）。
   */
  onAgentSettled?: (sessionId: string) => void
}

/** 可能改文件的工具（baseline diff 触发判定，与原 event-adapter 一致）。 */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'bash'])

export class EventInterpreter {
  /** 当前 assistant message 的 id（message_start 设置，file_changes 挂载目标，跨事件保持） */
  private currentMessageId: string | undefined
  /** 本 turn write 工具写入的 content（untracked 行数回退用，message_start 重置换新）。 */
  private writeContents: Map<string, string> = new Map()
  /**
   * [W18 帧序三件套，03 D3-3] per-session 串行 diff 链：file_changes 的 diff 计算按触发序
   * 串行执行，turn-end 的 ready 排链尾 → ready 恒为该回合最后一帧（by-construction）。
   * 链上每段 catch 兜底，diffChain 永不 reject（单帧失败不断链）。
   */
  private diffChain: Promise<void> = Promise.resolve()
  /** 回合代际守卫：turn-start 自增；链上执行时 gen 不匹配 → 丢弃 accumulating（ready 绕过恒推，见 sendDiffFileChanges） */
  private turnGen = 0
  // ── 协作对象（T4 拆分：构造时装配，状态与逻辑见各自文件；本类只持委托挂点）──
  /** composer-gen-stats LLM 请求窗口状态机（genstats-speed-llm-window D1/D3，登记方向 ①）。 */
  private readonly llmWindows: LlmWindowSampler
  /** agent_settled V7 延迟注入 + disposed 销毁短路（登记方向 ②，缺陷 2 短路随迁）。 */
  private readonly settledDelayer: AgentSettledDelayer
  /** pi 进程健康探测循环（ADR-0047，登记五域外独立状态面）。 */
  private readonly pingProbe: PingProbe
  /** compaction 双事件编排（M4，纯同步无内部状态，评估低风险）。 */
  private readonly compaction: CompactionNotifier
  /** turn-end 压制标记：true 后到达的 accumulating 直接 no-op（同回合迟到 tool-call-end 不产生新帧） */
  private turnFinalizing = false
  /**
   * toolCall 产出顺序锚点缓存（toolCallId → contentIndex，pi toolcall_start 提供）。
   * tool-call-start（tool_execution_start）到达时取出附到 tool_call_start WS 帧，
   * 前端按 contentIndex 有序插入 contentBlocks（§11 检查点 3 两条路径顺序语义统一）。
   */
  private toolCallContentIndex: Map<string, number> = new Map()

  /**
   * 会话销毁清理（组合根经 EventAdapter.detach 转调）：清在途 settling 延迟 timer + 置
   * disposed 短路标志 + 停 ping 探测循环。幂等。仅 V7 开关生效时存在真实 settling timer；
   * 未设开关时该 timer 恒 null（零开销）。
   *
   * B1（memory-leak-remediation §3.2-B1，2026-09-14）：pi turn 中崩溃 → onSessionExit →
   * adapter.detach → 本 dispose 后事件源已退订，turn-end 永不再达，ping 循环失去唯一停止点；
   * 5s 后 respawn 为同 sessionId 生成新 client，pingPi 的 pm.getClient(sessionId) 延迟解析
   * 打到新 client 必然成功 → 失败计数恒清零，3 次失败自停条件永不成立 → interval 永续
   *（且 ping 双向 touch lastActivityAt 钉死 idle-pi-reaper 回收）。pingProbe.stop 幂等且已
   * in-flight 的 tick 被 `timer === null` 守卫拦截（SR1）。settling 延迟 timer 与 disposed
   * 短路标志同迁 settledDelayer（T4），本方法只做两腿委托。
   */
  dispose(): void {
    this.settledDelayer.dispose()
    this.pingProbe.stop()
  }

  constructor(
    private readonly sessionId: string,
    private readonly opts: EventInterpreterOptions,
  ) {
    this.llmWindows = new LlmWindowSampler(opts.onGenStats)
    this.settledDelayer = new AgentSettledDelayer(() => this.applyAgentSettledEffects())
    this.pingProbe = new PingProbe({
      sessionId,
      send: opts.send,
      pingPi: opts.pingPi,
      onSilentAbort: opts.onSilentAbort,
    })
    this.compaction = new CompactionNotifier({
      sessionId,
      send: opts.send,
      onCompactingStateChange: opts.onCompactingStateChange,
      onOccupancyTransition: opts.onOccupancyTransition,
      onContextUpdate: opts.onContextUpdate,
      onTraceSync: opts.onTraceSync,
      onContextRewritten: () => opts.onCompactionContextRewritten?.(sessionId),
    })
  }

  /**
   * 消费一批翻译事件，逐个编排。
   *
   * 同步执行（不 await 单个 handle）：message/status/turn-* 等纯转发/回写事件同步送出，
   * 使 WS 帧在事件循环同一微任务内可见（前端/测试无需等 flush）。
   * 仅 tool-call-start/end 的 hook 改写是异步的 —— 由各自 handler 内部 await hook 后再 send，
   * 不阻塞本循环（同一 pi-event 不会同时产出 tool-call 与其他需保序的事件）。
   */
  interpret(events: PiTranslatedEvent[]): void {
    for (const ev of events) {
      // W1：per-event try-catch —— 对每个事件的编排（hook/diff/WS 转发）单独隔离。
      // 若第 N 个事件触发 handler 抛错（如 send 回调抛、某 details 形状异常），
      // 裸 for 循环会被中断，后续事件（含关键的 turn-end / agent_end）被吞掉，导致：
      //   - isGenerating 永不复位（onTurnFinalize 未触发）
      //   - message.complete 不送达前端（streaming 永远不停）
      // 故单事件失败仅记日志不中断批次（复用 event-adapter.logInterpretFailure 的隔离思路）。
      try {
        // 微项 4（wave:perf-w09）：高频 delta 帧快速路径——kind 路由（handle 的大 switch）
        // 与 subagent-bg-notify / workflow-result 的 payload 检查全部跳过，纯转发。
        // text_delta / thinking_delta 占 streaming 期事件量绝对大头，等价性依据：
        // 两者的 payload 是 { sessionId, delta, contentIndex? }（event-adapter :99-106），
        // 永不带 customType，跳过的两个检查函数（handleSubagentBgNotify / handleWorkflowResult
        // 首行 customType 守卫）对它们恒 early-return，行为与走 handle 完全一致。
        // 运行时护栏（W09 review 补）：快速路径条件额外要求 payload 无 customType——
        // 未来若新增带 customType 的 delta 产出点，缺此护栏会静默绕过两个检查函数，
        // 此处强制其回落完整 handle 路径。
        // 仍在 W1 try 内：send 抛错不中断批次。
        if (ev.kind === 'message') {
          const t = ev.message.type
          if ((t === 'message.text_delta' || t === 'message.thinking_delta')
            && !('customType' in (ev.message.payload ?? {}))) {
            this.opts.send(ev.message)
            continue
          }
        }
        this.handle(ev)
      } catch (err: unknown) {
        // B2（PR#86 review）：终态事件（turn-end）自身 handler 抛错时，onTurnFinalize 未执行 →
        // isGenerating 永不复位（session 永久 busy，违反 AGENTS.md 规则 #3）。
        // 兜底强制执行。onTurnFinalize 幂等（finalizeSession 幂等，见 chat.ts），重复调用无副作用。
        if (ev.kind === 'turn-end') {
          try {
            // S4：传 ev.stopReason 而非 undefined——对齐正常路径（handleTurnEnd L352）。
            // handleTurnEndSideEffects 在 stopReason undefined 时 outcome 走 'done' 分支，
            // 对「handler 抛错」场景写 'done' 是错的；turn-end 事件本身携带 stopReason（types.ts L120）。
            this.opts.onTurnFinalize?.(this.sessionId, ev.stopReason)
          } catch (finalizeErr) {
            // best-effort: onTurnFinalize 本身就是 handle(ev) 抛错后的兜底，此处失败无更上层可传播，静默降级
            console.debug('[event-interpreter] onTurnFinalize fallback failed:', finalizeErr)
          }
          // occupancy #3 兜底：handleTurnEnd 早段（send 帧 / onContextUpdate）抛错时
          // settling 写入未达——与 onTurnFinalize 兜底同构，防 turn 卡 generating
          // （session 永久占用投影，renderer 永走 steer/defer 路由）。
          try {
            this.opts.onOccupancyTransition?.('settling')
          } catch (occErr) {
            // best-effort：同上方 onTurnFinalize 兜底语义——已是 handle(ev) 抛错后的兜底，
            // 失败无更上层可传播，落 debug 供诊断
            console.debug('[event-interpreter] occupancy settling fallback failed:', occErr)
          }
        }
        console.error(
          `[event-interpreter] handle event error (isolated; batch continues) sid=${this.sessionId} kind=${ev.kind}:`,
          err,
        )
      }
    }
  }

  /**
   * 单事件编排入口。复杂度债务偿还时按处理阶段拆为五段 switch（行为保持提取）：
   * - 本函数：结构编排 case（tool-call 异步 handler / compaction 终态）+ 余量分流；
   * - handleConversationEvent：对话内容流帧（message / subagent-stream / record 失效）；
   * - handleTurnLifecycleEvent：turn 生命周期（turn-start/end/usage + settled + trace）；
   * - handleRoutingEvent：server 路由回调（status/bridge/extension/session-manager）；
   * - handleMetaEvent：元数据与观测 hook 回调（thinking/renamed/hook）。
   * 五段合计覆盖与原单一 switch 的 case 集合逐一对应，命中语义与分发顺序不变。
   */
  private handle(ev: PiTranslatedEvent): void {
    switch (ev.kind) {
      case 'tool-call-start':
        // hook 改写是异步的：handler 内部 await 后 send（不阻塞本循环）
        void this.handleToolCallStart(ev)
        return
      case 'tool-call-index':
        // 缓存 toolCall 产出顺序锚点（pi toolcall_start），tool-call-start 到达时附到 WS 帧
        this.toolCallContentIndex.set(ev.toolCallId, ev.contentIndex)
        return
      case 'tool-call-end':
        void this.handleToolCallEnd(ev)
        return
      case 'compaction-start':
        this.compaction.onCompactionStart(ev.reason)
        return
      case 'compaction-end':
        this.compaction.onCompactionEnd(ev)
        return
    }
    if (this.handleConversationEvent(ev)) return
    if (this.handleTurnLifecycleEvent(ev)) return
    if (this.handleRoutingEvent(ev)) return
    this.handleMetaEvent(ev)
  }

  /** 对话内容流事件的编排（原 handle 同名 case 逐字迁移）。命中返回 true。 */
  private handleConversationEvent(ev: PiTranslatedEvent): boolean {
    switch (ev.kind) {
      case 'noop':
        return true
      case 'message':
        this.opts.send(ev.message)
        // composer-gen-stats（genstats-speed-llm-window D1/D2）：assistant message_end 帧 =
        // LLM 请求窗口闭合点（先于工具执行到达，pi 语义 P1）→ 结算窗口时长（role 守卫与
        // payload 防御提取在协作对象内）。委托原样保留转发后的调用位置——闭合时点语义不变。
        this.llmWindows.settleOnMessageEnd(ev.message)
        // subagent bg-notify：更新内存态终态 → 广播 session.subagents
        this.handleSubagentBgNotify(ev.message)
        // workflow-result（run 完成）：广播 session.workflows 增量信号
        this.handleWorkflowResult(ev.message)
        return true
      case 'subagent-stream':
        // 路径 A-1：subagent 逐字 streaming → subagent.stream_delta WS 帧
        this.opts.send({
          type: 'subagent.stream_delta' as ServerMessageType,
          payload: { sessionId: ev.sessionId, recordId: ev.recordId, lines: ev.lines },
        })
        return true
      case 'record-entry-appended':
        // W18：自描述 record entry 到达 → 派生缓存失效（sessionService 防抖增量重拉）。
        // 事件 payload 不进数据缓存——entry 扫描是唯一数据写路径。
        this.opts.onRecordEntriesInvalidated?.(this.sessionId, ev.customType)
        return true
      default:
        return false
    }
  }

  /** turn 生命周期事件的编排（原 handle 同名 case 逐字迁移）。命中返回 true。 */
  private handleTurnLifecycleEvent(ev: PiTranslatedEvent): boolean {
    switch (ev.kind) {
      case 'turn-start':
        // 记 messageId（file_changes 挂载目标）+ 推进回合代际（W18 帧序三件套）。
        // [R-09 简化] 原 turn-start 同步采 baseline 快照已删除——diffSnapshots 的 baseline
        // 参数是死参数（[HISTORICAL] dirty 漏报修复后输出只依赖 current），turn-start 采集
        // 是每 turn 一次的纯浪费（W18 前为 execSync 同步阻塞）。
        this.currentMessageId = ev.messageId
        this.turnGen += 1
        this.turnFinalizing = false
        // composer-gen-stats：LLM 请求窗口重锚起算 + 重锚清除不变量（注释详见 LlmWindowSampler.onTurnStart）。
        this.llmWindows.onTurnStart()
        // occupancy #2（D2 迁移）：turn-start → 'generating'。dispatching（prompt 已发）到本
        // 事件的边界；幂等写直写目标值，retry/followUp 续跑（settling 中再收 turn-start）同样
        // 落 generating。三布尔派生（isGenerating=true）在原语内原子完成。
        this.opts.onOccupancyTransition?.('generating')
        // 替换新 Map（非原地 clear）：上一 turn 排在 diff 链上的 ready 计算闭包仍持有旧引用，
        // 原地清空会让 untracked 行数回退拿不到 content。
        this.writeContents = new Map()
        // [ADR-0047] turn 开始启动 ping 探测（每 60s get_state）。
        // ping 在 turn 进行中持续，turn-end / agent_end / onSilentAbort 停止（见各分支）。
        // turn 间不探测（AC-3）：start 在 turn-start 挂点调用，确保只在 turn 内跑。
        this.pingProbe.start()
        return true
      case 'turn-end':
        this.handleTurnEnd(ev)
        return true
      case 'turn-usage':
        // pi turn_end 的单 turn 用量：回写 context.update（用量在前），再触发 onTurnUsage
        //（turn 级副作用：project sidecar 兜底等）。
        // 不转发 message.complete（避免每 turn 触发 setStreaming 闪烁；
        // message.complete 仍由 turn-end/agent_end 独占）。
        this.opts.onContextUpdate?.(ev.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens })
        this.opts.onTurnUsage?.(ev.sessionId)
        // composer-gen-stats（D1/D2）：组装生成指标样本采样（fire-and-forget 同步，不阻塞事件流）。
        // durationMs 取 llmWindowDurationMs（assistant message_start → message_end 的 LLM 请求
        // 窗口，不含工具执行时间）；真缺闭/缺起 → null；一次性消费语义、未注入 onGenStats 时
        // 整块跳过——组装与状态清理由 LlmWindowSampler.consume 承载（注释详见该处）。
        this.llmWindows.consume(ev.sessionId, ev)
        return true
      case 'agent-settled':
        // [V7] 延迟编排入口：dev-only 开关生效时整体延迟处理（注入点在 settling→idle 转移
        // 处理之前）；未设开关 = 直通零开销。延迟 timer 与 disposed 短路在 AgentSettledDelayer。
        this.settledDelayer.handleSettled()
        return true
      case 'trace-trigger':
        // session-trace 增量腿（A33）：触发事件到达 → 追赶式 since 补拉（fire-and-forget，
        // 不阻塞本批次；拉到 delta 后由 syncTraceEntries 广播 session.traceEntryAppended）。
        this.opts.onTraceSync?.(this.sessionId, ev.trigger)
        return true
      case 'record-reconcile-trigger':
        // [reload-closeout D2] 送达水位对账腿（agent_settled，fire-and-forget——回调内部
        // 重跑 record 派生管线并按已发布快照水位补发，不阻塞本批次）
        this.opts.onRecordReconcile?.(this.sessionId)
        return true
      default:
        return false
    }
  }

  /**
   * agent_settled 的三件副作用（原 applyAgentSettled 迁移，经 settledDelayer 的 apply 回调
   * 进入——V7 延迟编排与 disposed 销毁短路在 AgentSettledDelayer.handleSettled/run 承担）。
   */
  private applyAgentSettledEffects(): void {
    // W1（fix-chat-flow-order）：run 级联结束（晚于 pi finally 的 bash 落盘 flush）→
    // dispatcher 按序发布 per-session bash 待落列（见 opts.onAgentSettled 注释）。
    this.opts.onAgentSettled?.(this.sessionId)
    // occupancy #4（D2 迁移）：agent_settled → 'idle'（settling 终点，pi post-run 收尾完成）。
    // pi 卡死/异常退出时本事件不会发出——失败路径复位由 #9 abort 兜底与 #10 session.exited 承担。
    // onTurnFinalize 侧（handleTurnEndSideEffects）已先以 'settling' 原子写，此处幂等去重。
    this.opts.onOccupancyTransition?.('idle')
    // D4 收敛环挂点：被掐 turn 收尾的 settled 边沿 → 清 pendingSettled + 重置静默窗。
    // 环未活跃（无 forceQuit/restore 场景）时 no-op。
    userStoppedGate.noteAgentSettled(this.sessionId)
  }

  /** server 路由回调事件的编排（原 handle 同名 case 逐字迁移）。命中返回 true。 */
  private handleRoutingEvent(ev: PiTranslatedEvent): boolean {
    switch (ev.kind) {
      case 'status-set':
        this.opts.onStatusSetUpdate?.({ sessionId: this.sessionId, key: ev.key, text: ev.text, textRaw: ev.textRaw })
        return true
      case 'status-broadcast':
        this.opts.send(ev.message)
        return true
      case 'bridge-ui':
        this.opts.onBridgeUIRequest?.(ev.requestId, ev.sessionId, ev.method, ev.data)
        return true
      case 'session-manager-ui':
        // fire-and-forget（不 await），由 SessionManagerHandler 异步处理并回写 response，
        // 不走前端 UI 超时流程。
        this.opts.onSessionManagerRequest?.(ev.requestId, ev.sessionId, ev.action, ev.params)
        return true
      case 'extension-ui':
        this.opts.onExtensionUIRequest?.(ev.requestId, ev.sessionId, ev.method, ev.payload)
        return true
      default:
        return false
    }
  }

  /** 元数据与观测 hook 回调事件的编排（原 handle 同名 case 逐字迁移）。 */
  private handleMetaEvent(ev: PiTranslatedEvent): void {
    switch (ev.kind) {
      case 'thinking-level':
        // W7/W9 数据源治理：thinking_level_changed 只做失效——markDirty 置 dirty + 防抖重拉
        // get_state（唯一写路径），事件 payload 不再是 thinkingLevel 的数据源（session.thinkingLevelSet
        // WS 帧由 event-adapter 翻译直发，前端即时更新不依赖任何缓存回写）。
        this.opts.thinkingLevelState?.()?.markDirty()
        return
      case 'session-renamed':
        // PR #185 MF1：session_info_changed 的唯一编排动作 = onSessionRenamed 内存态回写
        //（组合根接 sessionService.setLabelCache，session.label 事件路径唯一写方）。
        // session.renamed 广播帧由 event-adapter 从事件 payload 直接转发（pi 权威源），
        // label 的 ReplicatedState 实例及 markDirty 失效接线已撤销（终态 = 事件直写）。
        this.opts.onSessionRenamed?.(this.sessionId, ev.name)
        return
      case 'hook':
        // D4 收敛环挂点：标记存活期内（收敛环活跃），非显式投递引发的 agent_start 一律
        // 再 abort（掐 notify replay 补发腿 / scheduler / auto-retry 开的 turn）。环未活跃
        // 时 no-op——正常会话（含显式投递开 turn）零额外开销（Map get 即返）。
        if (ev.eventType === 'agent_start') {
          userStoppedGate.noteAgentStart(this.sessionId)
        }
        // agent_start 等纯观测事件（无 WS 帧产出）
        this.opts.executeHooks?.('onPiEvent', { event: ev.eventType, ...ev.data }).catch(() => {})
        return
    }
  }

  /** tool-call-start：跑 onBeforeToolCall hook（可阻断/改写 input）后产出 tool_call_start WS 帧 + onPiEvent hook。 */
  private async handleToolCallStart(ev: PiTranslatedEvent & { kind: 'tool-call-start' }): Promise<void> {
    const { toolCallId, toolName } = ev
    let input = ev.input

    let blocked = false
    if (this.opts.executeHooks) {
      try {
        const hookResult = await this.opts.executeHooks('onBeforeToolCall', { toolName, input })
        if (hookResult.blocked === true) {
          blocked = true
        } else if (hookResult.transformedData !== undefined) {
          if (isPlainRecord(hookResult.transformedData)) {
            input = hookResult.transformedData
          } else {
            // hook 返回畸形改写值（非 plain object）→ 丢弃改写保原始 input（type-safety：
            // entry.arguments 契约是 Record，畸形值不得以谎报类型进 wire 帧）
            console.warn(
              `[event-interpreter] onBeforeToolCall hook returned non-object transformedData for ${toolName} (${toolCallId}), discarding rewrite`,
            )
          }
        }
      } catch (e) {
        // 插件 hook 失败不影响主流程（best-effort 数据改写），降级到 debug 日志
        console.debug(`[event-interpreter] hook tool_execution_start error: ${toErrorMessage(e)}`)
      }
    }
    if (blocked) {
      // 阻断：不产出 tool_call_start，但仍触发 onPiEvent hook（带 blocked 标记，供观测插件）。
      // 移到 try-catch 外：与 tool_execution_end 的 fire-and-forget 模式一致——
      // onBeforeToolCall hook 失败（catch 分支）时仍触发 onPiEvent（不因 hook 失败丢观测事件）。
      // contentIndex 锚点不再被消费，同步清理（防 Map 残留）。
      this.toolCallContentIndex.delete(toolCallId)
      this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_start', toolCallId, toolName, input, blocked: true }).catch(() => {})
      return
    }

    // 观测 hook（tool_execution_start）
    this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_start', toolCallId, toolName, input }).catch(() => {})

    // [W21] hook 改写同步回 entry（WS 帧只发 entry——实时 feed 权威载体与 hook 语义一致）；
    // contentIndex 锚点（§11 检查点 3：pi toolcall_start 提供，模型输出 tool_use 时——无此锚点
    // 时同 turn 内 text 在 tool 之后 contentBlocks 顺序会错位）与 messageId 挂载目标从
    // interpreter 缓存补进 entry。锚点缺失（旧 pi/异常）时字段缺省，前端退化为 append 尾部。
    // arguments 经 isPlainRecord 守卫（hook 改写已守卫；未改写路径的 ev.input 若为 pi 契约外
    // 畸形值同样归一为 {}，不进 wire 帧）
    ev.entry.arguments = isPlainRecord(input) ? input : {}
    const contentIndex = this.toolCallContentIndex.get(toolCallId)
    if (contentIndex !== undefined) ev.entry.contentIndex = contentIndex
    if (this.currentMessageId !== undefined) ev.entry.messageId = this.currentMessageId

    this.opts.send({
      type: 'message.tool_call_start',
      payload: {
        sessionId: this.sessionId,
        entry: ev.entry,
      },
    })
    // 锚点已消费，清除缓存（防 Map 无限增长；同 id 重复 start 无意义）
    this.toolCallContentIndex.delete(toolCallId)
  }

  /** tool-call-end：跑 onAfterToolResult hook（改写 output）+ 触发 file_changes diff + 产出 tool_call_end WS 帧 + onPiEvent hook。 */
  private async handleToolCallEnd(ev: PiTranslatedEvent & { kind: 'tool-call-end' }): Promise<void> {
    const { toolCallId, toolName, isError } = ev
    let output = ev.output
    const { details, images } = ev

    if (this.opts.executeHooks) {
      try {
        const hookResult = await this.opts.executeHooks('onAfterToolResult', { toolCallId, output })
        if (typeof hookResult.transformedData === 'string') {
          output = hookResult.transformedData
          // [W21] 仅 hook 实际改写时同步回 entry.message.content（WS 帧只发 entry）——
          // 包成 text block 数组保持 pi 持久化形态（live≡reload 同构）；无改写时保持
          // adapter 归一后的原数组。
          ev.entry.message.content = [{ type: 'text', text: output }]
        } else if (hookResult.transformedData !== undefined) {
          // hook 返回畸形改写值（非 string）→ 丢弃改写保原始 output（type-safety：content
          // text block 契约是 string，畸形值不得以谎报类型进 wire 帧 / 持久化 entry）
          console.warn(
            `[event-interpreter] onAfterToolResult hook returned non-string transformedData for ${toolName} (${toolCallId}), discarding rewrite`,
          )
        }
      } catch (e) {
        // 插件 hook 失败不影响主流程（best-effort 数据改写），降级到 debug 日志
        console.debug(`[event-interpreter] hook tool_execution_end error: ${toErrorMessage(e)}`)
      }
    }

    // 观测 hook（tool_execution_end）
    this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_end', toolCallId, output, details, images }).catch(() => {})

    // ADR-0024 D5：失败的调用不触发 diff（避免噪声）；实时 diff
    if (!isError) {
      // [已知限制] ev.writeContent 恒为 undefined（pi tool_execution_end 从不发 args，见
      // event-adapter handleToolExecutionEnd 注释），writeContents 累积逻辑保护的是当前无数据
      // 流经的路径——后续 pi 若透出 writeContent 则自动激活（untracked 行数回退）。
      if (FILE_MUTATING_TOOLS.has(toolName)) {
        // await 保持「file_changes(accumulating) 先于 tool_call_end」帧序（W18 前为同步实现
        // 天然满足；异步化后显式 await——本 handler 本就是 fire-and-forget 异步路径，
        // await 不阻塞 interpret 循环）。等待的是整个 diff 链尾 = 前序链段 + 自身（每段最坏
        // = status + numstat 两个采集超时之和，各 5000ms）；fire-and-forget 语义下不阻塞
        // 事件循环，仅延迟 tool_call_end 相对时序。
        await this.sendDiffFileChanges('accumulating')
      }
    }

    this.opts.send({
      type: 'message.tool_call_end',
      payload: {
        sessionId: this.sessionId,
        // [W21] entry：toolResult message entry 形态（hook 改写时 content 已同步，
        // 见上方 hook 分支注释），前端直接喂 applyEntry 回填。
        entry: ev.entry,
      },
    })

    // W18：subagent/workflow tool-call-end 事件直写退役为兜底失效信号——extension 在
    // record 状态迁移点（register / run flush）已 append 自描述 entry（entry_appended
    // 主信号先于本事件到达），此处失效用于主信号丢失时的双保险收敛。
    if (SUBAGENT_TOOL_NAMES.has(toolName)) {
      this.opts.onRecordEntriesInvalidated?.(this.sessionId, 'subagent-record')
    }
    if (WORKFLOW_TOOL_NAMES.has(toolName)) {
      this.opts.onRecordEntriesInvalidated?.(this.sessionId, 'workflow-record')
    }
  }

  /** turn-end（agent_end）：转发 message.complete + context.update 回写 + onTurnFinalize（副作用）+ 观测 hook + file_changes ready diff + 清空态。 */
  private handleTurnEnd(ev: PiTranslatedEvent & { kind: 'turn-end' }): void {
    // 转发 message.complete WS 帧
    this.opts.send(ev.message)

    // context.update 回写（inputTokens > 0 时）
    if (ev.inputTokens) {
      this.opts.onContextUpdate?.(this.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens ?? 0 })
    }

    // 副作用：复位 isGenerating=false + project sidecar 兜底 + session_end 终态写入（W4）
    this.opts.onTurnFinalize?.(this.sessionId, ev.stopReason)

    // occupancy #3（D2 迁移）：turn-end（agent_end）→ 'settling'。pi post-run 收尾期从「空闲」中
    // 显式分离。onTurnFinalize（handleTurnEndSideEffects）已先以 'settling' 原子完成
    // 「isGenerating=false + turn=settling」双写（D2：同点双写合一），此处幂等去重——保留
    // 调用作防御性冗余（onTurnFinalize 未注入的存量测试形态）。
    this.opts.onOccupancyTransition?.('settling')

    // 观测 hook（agent_end）
    this.opts.executeHooks?.('onPiEvent', { event: 'agent_end', stopReason: ev.stopReason, usage: ev.usage }).catch(() => {})

    // ADR-0024 D5：agent_end 推 ready 全集（diff 最终结果）。
    // W18 帧序三件套：turn-end 置 turnFinalizing（其后迟到的 accumulating no-op）；
    // ready 排 diff 链尾（fire-and-forget，禁止 await——await 会阻塞 turn-end 处理链），
    // 天然晚于所有在途 accumulating → ready 恒为链尾；message.complete 已在上方同步先发。
    this.turnFinalizing = true
    void this.sendDiffFileChanges('ready')
    // 替换新 Map（非原地 clear）：ready 排链后本 handler 立即返回，链上计算闭包持有旧引用
    // 做 untracked 行数回退，原地清空会拿不到 content。
    this.writeContents = new Map()

    // [ADR-0047] turn 结束停止 ping 探测（AC-3：turn 间不探测）。
    this.pingProbe.stop()
  }

  /**
   * 推送 diff 结果的 file_changes 帧（W18 异步化 + 帧序三件套，03 D3-3）。
   *
   * 机制：采集当前 git status（异步，经 GitStateService 单飞）→ diff → 行数填充 → 推帧。
   * isFullSet=true（每次全量结果，前端全集替换）。非 git 仓库 / cwd 缺省 → 跳过。
   *
   * 帧序不变量（by-construction）：
   * 1. 单飞串行链——diff 计算入 per-session promise 链按触发序串行，turn-end 的 ready
   *    排链尾 → 恒晚于所有在途 accumulating；
   * 2. 回合代际守卫（仅 accumulating）——捕获排链时的 turnGen，链上执行时（含 await 窗口后
   *    send 前）不匹配即丢弃，上回合迟到 accumulating 不落新回合。ready 绕过守卫恒推
   *    （03 §3.1「ready 恒推」；W18 review）：pi followUp 续跑（triggerTurn）会立即开新 turn
   *    （turnGen++），若 ready 也按代际丢弃，本回合变更集卡永久停在 accumulating——前端无
   *    恢复路径（markChangeSetsSuperseded 仅 git.commit 触发、hydrate 不写 changeSetStatus）。
   *    迟到的 ready 挂排链时捕获的旧 messageId，前端按 messageId 分区 + 单向守卫幂等；
   * 3. turnFinalizing 压制——turn-end 后到达的 accumulating 直接 no-op。
   *
   * 返回链尾 promise：handleToolCallEnd await 它以保持「accumulating 先于 tool_call_end」；
   * handleTurnEnd 不 await（禁止阻塞 turn-end 处理链）。
   */
  private sendDiffFileChanges(changeSetStatus: 'accumulating' | 'ready'): Promise<void> {
    if (this.turnFinalizing && changeSetStatus === 'accumulating') {
      console.debug(`[event-interpreter] file_changes accumulating suppressed by turnFinalizing sid=${this.sessionId}`)
      return Promise.resolve()
    }
    const messageId = this.currentMessageId
    if (!messageId) return Promise.resolve()
    const { cwd, fileChangeDiff } = this.opts
    if (!cwd || !fileChangeDiff) return Promise.resolve()
    const gen = this.turnGen
    // writeContents 捕获引用快照：turn-end / turn-start 排链后替换新 Map，链上计算仍持旧引用
    const writeContents = this.writeContents
    const run = async (): Promise<void> => {
      // 回合代际守卫（仅 accumulating，见上方 JSDoc 第 2 条）：排链到执行之间可能已跨 turn
      if (changeSetStatus === 'accumulating' && gen !== this.turnGen) {
        console.debug(`[event-interpreter] file_changes accumulating dropped by turn-generation guard sid=${this.sessionId}`)
        return
      }
      const current = await fileChangeDiff.snapshotGitStatus(cwd)
      if (!current) return
      const changes: FileChange[] = fileChangeDiff.diffSnapshots(current)
      if (changes.length === 0) return
      const numstatMap = await fileChangeDiff.numstat(cwd)
      // 二次 gen 校验（仅 accumulating）：采集 await 窗口内跨 turn 的迟到帧不发出（守卫覆盖整个链上生命周期）
      if (changeSetStatus === 'accumulating' && gen !== this.turnGen) {
        console.debug(`[event-interpreter] file_changes accumulating dropped by turn-generation guard (post-await) sid=${this.sessionId}`)
        return
      }
      // 行数：numstat（已跟踪）+ writeContents 回退（untracked）
      fileChangeDiff.computeLineCounts(changes, numstatMap, writeContents)
      this.opts.send({
        type: 'message.file_changes',
        payload: {
          sessionId: this.sessionId,
          messageId,
          fileChanges: changes,
          changeSetStatus,
          isFullSet: true,
        },
      })
    }
    // 单段失败不断链：catch 后 diffChain 保持 resolved，后续帧照常排队。
    // warn（非 debug）：链段失败 = 一帧 file_changes 静默丢失，prod info 级日志下应可见
    const next = this.diffChain.then(run).catch((e: unknown) => {
      console.warn(`[event-interpreter] file_changes diff failed (frame dropped): ${toErrorMessage(e)}`)
    })
    this.diffChain = next
    return next
  }

  // ── composer-gen-stats 窗口结算已迁 LlmWindowSampler（event-interpreter-gen-stats.ts，T4）──

  // ── subagent / workflow record 失效信号（W18：事件直写退役）──

  /**
   * subagent bg-notify（custom_message）→ 派生缓存失效（W18）。
   *
   * W12-W18 过渡期本方法曾直写 SubagentsState 包装实例（applyNotify 合并终态 + 广播），
   * W18 起事件直写退役：extension 在 record 状态迁移点已 append 自描述 subagent-record
   * entry（entry_appended 主信号），本事件降级为兜底失效信号——主信号丢失（广播被拦截 /
   * 事件流损坏）时仍触发 get_entries 重拉收敛（equivalence 混沌用例场景 5）。
   *
   * details 不再解析（customType 判定即失效条件）；customStart WS 帧由上方 'message'
   * 分支照常转发前端（BgNotifyCard 渲染不受影响）。
   */
  private handleSubagentBgNotify(msg: ServerMessage): void {
    const payload = msg.payload as { customType?: string } | undefined
    if (payload?.customType !== 'subagent-bg-notify') return
    this.opts.onRecordEntriesInvalidated?.(this.sessionId, 'subagent-record')
  }

  /**
   * workflow-result customStart（run 完成通知）→ 派生缓存失效（W18，同 handleSubagentBgNotify
   * 的退役语义）。customStart WS 帧照常转发前端（完成 turn 注入渲染不受影响）。
   */
  private handleWorkflowResult(msg: ServerMessage): void {
    const payload = msg.payload as { customType?: string } | undefined
    if (payload?.customType !== 'workflow-result') return
    this.opts.onRecordEntriesInvalidated?.(this.sessionId, 'workflow-record')
  }

  // ── compaction 生命周期编排已迁 CompactionNotifier（event-interpreter-compaction.ts，T4）──

  // handle() 的 compaction-start/end case 直调协作对象（纯同步、无内部状态，不牵动主循环时序）。
}
