/**
 * SessionStateProjection — session 级状态投影域（S5 从 SessionService 迁出，
 * 设计 D2②：replicated states 快照投影族 + context/usage 副作用域同族合并——
 * 可观察输出同为「session 级状态向 renderer 发布」）。
 *
 * 上半（快照投影族，原 Facade 方法族逐字随迁）：per-session ReplicatedState 实例组
 * （四实例：thinkingLevel / modelId / usage / commands）的注册与播种、三条 fetch 窄访问器
 * （get_state / get_session_stats / get_commands，fetch 成功后挂钩发布
 * context.update / session.commands / session.state_changed——「投影一次」，W12/D7）。
 *
 * 下半（context/usage 副作用域，原 Facade 方法逐字随迁）：事件链路副作用
 * （applyContextUpdate 事件只失效 / handleTurnUsageSideEffects turn_end 兜底 /
 * handleTurnEndSideEffects agent_end 三副作用 / fetchAndBroadcastContext 恢复兜底）。
 * event-interpreter 经组合根（index.ts）回调消费前三个方法（Facade 一行委托到达，
 * D3 形态）；fetchAndBroadcastContext 经 ILifecycleSessionOps 由 restore/fork 路径
 * fire-and-forget 调用。
 *
 * 订阅接线（S5 核心，设计 D2②「换订阅者」）：onSessionRegistered 订阅者从 Facade
 * 换为本模块自身——组装根（Facade 构造器）先调 subscribe(lifecycle)，播种先于
 * record 注册与 reconciler 对账（lifecycle 按订阅顺序同步直发，扇出不设异常隔离）。
 * 销毁侧无事件——onSessionDisposed 由 Facade removeSessionEntry 第 ⑤ 步直调
 * （与 TraceSync.onSessionDisposed 并列）。
 *
 * 日志/错误消息前缀保留 `[session-service]`（G3 行为等价：错误诊断流也是可观察
 * 行为，迁出不改写日志归属，同 TraceSync 保留 `[session-trace]` 先例）。
 */
import type { ServerMessage } from '@taiji/shared'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { SessionOutcome } from '../ports/session.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { IManagedSessionView } from './types.js'
import { applySessionOccupancyTransition } from './event-interpreter.js'
import { ReplicatedState } from './replicated-state.js'
import {
  createThinkingLevelStateConfig,
  createModelIdStateConfig,
  createUsageStateConfig,
  createCommandsStateConfig,
  type ThinkingLevelSnapshot,
  type ModelIdSnapshot,
  type UsageSnapshot,
  type CommandsSnapshot,
} from './replicated-states.config.js'

/**
 * per-session ReplicatedState 实例组（W7 + W8 data-source-governance，四实例）。
 *
 * thinkingLevel / modelId（W7）：快照唯一来源 get_state，失效源分别是
 * thinking_level_changed / switchModel RPC 响应。
 * usage（W8 + W10 收编）：快照唯一来源 get_session_stats().contextUsage，失效源 = context
 * 相关事件 turn_end / agent_end / compaction（汇聚于 applyContextUpdate）+ restore 拉取
 * （fetchContext）+ switchModel RPC（contextWindow 随模型变化）。W10 起五写点全部收编：
 * inputTokens 的旧 session 缓存直写（applyContextUpdate / fetchContext 回写）已删，
 * usage 实例快照是唯一数据源（getInputTokens / tokenCount 派生 / switchModel
 * 重算全读快照），inputTokens 竞态从「时序约定」变「结构不可能」。
 * commands（W8）：快照唯一来源 get_commands，失效源 = getCommands 全部调用路径
 * （激活发布 + renderer 主动查询，查询即失效）。
 * 事件与 RPC 响应永不直接写实例数据（只 markDirty）。session.thinkingLevel /
 * modelId 会话字段缓存是登记的永久双写形态（PR #185 S2 裁决，2026-08-20，登记表
 * #4/#5 修订）：播种 refetch 三实例异步竞速 + get_state 失败退避（1s/5s/15s）窗口内
 * 快照未就绪，state_changed 组合投影 fallback 读该缓存；toSummary（session 列表）
 * 亦消费该字段。usage 双写已终结（W10）。
 *
 * [HISTORICAL] label / queue 深度两实例已撤销（PR #185 data-governance review MF1/MF2，
 * 2026-08-20）：两实例 .get() 生产零消费，markDirty 触发的防抖 get_state 拉取纯浪费 RPC，
 * 真值路径分别是 session_info_changed 事件直写 setLabelCache（label 唯一真值源）与
 * queue_update 帧内 pendingMessageCount（= pi 队列深度推送投影，renderer 对账直读帧值）。
 * 「完成 W7/W8 发布通道」属新功能开发，不在 review 修复范畴，按登记表 #1/#6 修订记录在案。
 */
export interface SessionReplicatedStates {
  thinkingLevel: ReplicatedState<ThinkingLevelSnapshot>
  modelId: ReplicatedState<ModelIdSnapshot>
  usage: ReplicatedState<UsageSnapshot>
  commands: ReplicatedState<CommandsSnapshot>
}

/**
 * onSessionRegistered 订阅目标的结构化窄面（组装根传入 lifecycle；测试可传 plain
 * object——G2：stub 面 = 消费面，单方法）。
 */
export interface SessionRegisteredSource {
  onSessionRegistered(handler: (sessionId: string) => void): void
}

/**
 * SessionStateProjection 装配依赖（窄注入，S5/D2 风格：deps 面构造期固定，
 * messageBus 经 getter 每次调用动态读——与 Facade setter 晚期注入语义逐字等价）。
 */
export interface SessionStateProjectionDeps {
  /** pi 进程管理（getClient：fetch 窄访问器的活跃判定 + RPC client）。 */
  pm: IProcessManager
  /** sessions Map 只读查询（lifecycle 所有者）：副作用域 session 定位 + 销毁守卫。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** sessions Map 存在性查询（publish 前销毁守卫：已销毁不 publish，防 bus 重建已 clearSession 的 entry）。 */
  hasSession(sessionId: string): boolean
  /** MessageBus 当前值（Facade setter 晚期注入，未注入时 null → 广播 no-op）。 */
  getMessageBus(): IMessageBus | null
  /** Facade 保留域方法（fetchContext：ISessionService 对外查询，usage 失效在 Facade 侧经 getReplicatedStates 改道）。 */
  fetchContext(sessionId: string): Promise<{ inputTokens: number; contextLimit: number; usagePercent: number } | null>
  /** Facade 保留域方法（session_end 终态写入，message-dispatcher 窄接口同款消费——单一实现留 Facade）。 */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void
  /** Facade 私有 helper（project sidecar 兜底补写，唯一消费方 = 本域 handleTurn* 两方法）。 */
  tryPersistProjectBinding(session: IManagedSessionView): void
}

/**
 * D1（context-consistency Phase 1）：get_session_stats 响应是否为「合法无值」投影。
 * 与 createUsageStateConfig.fetchSnapshot 的投影口径镜像对齐：
 * - stats / stats.contextUsage 非对象 = 协议异常（fetchSnapshot 会 throw WireSnapshotSchemaError，
 *   实例退避重试）——fetch 未成功，不发占位帧，返回 false；
 * - contextUsage.tokens 非 number（pi tokens=null，compact 后无新 turn）= 空快照 {}——
 *   合法无值，返回 true。
 */
function isUsageNoValueProjection(stats: Record<string, unknown> | undefined): boolean {
  if (typeof stats !== 'object' || stats === null) return false
  const cu = stats.contextUsage
  if (typeof cu !== 'object' || cu === null) return false
  return typeof (cu as Record<string, unknown>).tokens !== 'number'
}

/**
 * W12：state_changed 组合投影的 diff 基线形状（2 字段；sessionId 是 map key 恒同值，不参与 diff）。
 * buildStateChangedPayload 产出的 payload 含 sessionId 字段，结构上是本形状的超集，可直接入基线。
 * D1：usage 三字段已从基线删除（协议收敛，payload 不再携带 usage）。
 */
interface SessionStateChangedBaseline {
  modelId: string
  thinkingLevel: string | undefined
}

/**
 * W12：modelId / thinkingLevel 两实例快照 → session.state_changed 组合投影 payload。
 * 快照缺失字段 fallback 双写缓存（session.modelId / thinkingLevel）——登记的永久形态
 * （PR #185 S2 裁决，2026-08-20）：播种 refetch 异步竞速 + 失败退避窗口内 .get() 为
 * undefined，缓存兜底（写方 = switchModel / setThinkingLevel RPC 成功后直写）。
 * D1（context-consistency Phase 1）：usage 三字段不再投影（usage 只经 context.update 帧，
 * 旧「无快照 ?? 0 基线」编码随协议删除）。
 */
function buildStateChangedPayload(
  sessionId: string,
  session: IManagedSessionView,
  states: SessionReplicatedStates,
): SessionStateChangedBaseline & { sessionId: string } {
  return {
    sessionId,
    modelId: states.modelId.get()?.modelId ?? session.modelId,
    thinkingLevel: states.thinkingLevel.get()?.thinkingLevel ?? session.thinkingLevel,
  }
}

/**
 * W12：state_changed 组合投影的 diff 判定（2 字段全等 → 同值组合不重复发帧）。
 * thinkingLevel 的 30s 周期兜底重拉会高频触发发布挂钩，靠本判定抑制重复帧。
 */
function stateChangedPayloadEquals(a: SessionStateChangedBaseline, b: SessionStateChangedBaseline): boolean {
  return a.modelId === b.modelId
    && a.thinkingLevel === b.thinkingLevel
}

export class SessionStateProjection {
  /**
   * W7/W8：per-session ReplicatedState 实例组（四实例：thinkingLevel / modelId /
   * usage / commands）。Map 分区（ADR-0049）：注册点 onSessionRegistered（S5 起本模块
   * 订阅接线，create/restore/fork 三入口汇聚），销毁点 onSessionDisposed（主动删 +
   * 进程退出汇聚，dispose 停防抖/退避/周期兜底全部定时器）。
   */
  private readonly replicatedStates = new Map<string, SessionReplicatedStates>()
  /** W12：state_changed 组合投影的 diff 基线（per-session，onSessionDisposed 一并清除）。 */
  private readonly lastPublishedStateChanged = new Map<string, SessionStateChangedBaseline>()

  constructor(private readonly deps: SessionStateProjectionDeps) {}

  /**
   * 组装期订阅接线（S5/D2②「换订阅者」）：向 lifecycle 注册本模块的播种 handler。
   * 必须先于其余订阅者（record 注册 / reconciler）注册——lifecycle 按订阅顺序同步
   * 直发，播种先于对账 = 迁移前 Facade 订阅体内顺序逐一等价。
   */
  subscribe(source: SessionRegisteredSource): void {
    source.onSessionRegistered((sessionId) => {
      // W7：注册 per-session 标量实例并播种首份快照（create/restore/fork 三入口的汇聚点）。
      // 播种走 refetch 立即拉取——session 激活后 renderer 要消费的 session 级状态必须主动拉取
      //（Runtime broadcast 时序竞争 [HISTORICAL]，架构约定）。
      // W12：session.commands 的激活发布不再单独直连 RPC（旧 fetchAndBroadcastCommands 已删），
      // 播种 fetch 经 fetchCommandsSnapshot 的快照应用后挂钩发布（publishCommandsSnapshot）。
      this.registerReplicatedStates(sessionId)
    })
  }

  /**
   * W7/W8：per-session 实例组访问器。消费方：Facade 残余域读点（switchModel /
   * handleSessionReloaded / getInputTokens / getUsagePercent / toSummary / getCommands /
   * fetchContext 的 markDirty 与 .get，经 getScalarReplicatedStates 对外一行委托供
   * 组合根 thinkingLevelState 延迟解析与测试断言）。session 未注册（非活跃 / 已销毁）
   * 返回 undefined，调用方安全跳过。
   */
  getReplicatedStates(sessionId: string): SessionReplicatedStates | undefined {
    return this.replicatedStates.get(sessionId)
  }

  // ── context/usage 副作用域（原 Facade 方法逐字随迁；interpreter 经组合根消费）──

  /**
   * 处理 context.update（pi agent_end/turn_end 推送 inputTokens + totalTokens）。session 级状态单一 owner。
   * index.ts onContextUpdate 经 Facade 一行委托仅调本方法。
   *
   * W12（data-source-governance P1.5）：事件只做失效——usage markDirty 后防抖重拉
   * get_session_stats，快照应用后经 fetchSessionStatsSnapshot 的挂钩发布 context.update
   * （payload 全字段来自 usage 实例快照），旧「事件即时值 + resolver 窗口重算再转发」的
   * 事件直写中间层已删（plan W12 步骤 3）。事件参数不再进任何 payload；发布延迟 =
   * 防抖窗口 + 快照 RPC（毫秒级），防抖到点收敛的 pi 权威 percent 与事件即时值同源同值
   * （event-adapter 翻译层同源直出，W10 论证），last-value 不因切换漂移。
   *
   * W10 owner 结构（五写点全部只做 usage 实例 markDirty，实例 fetch get_session_stats 是
   * 唯一数据写路径；tokenCount 派生见 toSummary 注释）：与 switchModel 的乱序竞态从结构上
   * 不可能——单一数据源 + 单一写入路径，两处失效任意顺序到达，防抖到点后快照收敛 pi
   * 权威值（结构自愈，见 switchModel 注释的 W10 段）。
   */
  applyContextUpdate(sessionId: string, _inputTokens: number, _totalTokens?: number): void {
    // usage 失效（事件只做失效——markDirty 置 dirty + 防抖重拉 get_session_stats 快照，
    // usage 实例唯一数据写路径）。0 值事件同样失效（与 W10 行为一致：失效在旧 0 值门控之前）。
    this.replicatedStates.get(sessionId)?.usage.markDirty()
  }

  /**
   * turn_end 单 turn 副作用（W3 迁移自 attachUsageListener turn_end 分支）。
   *
   * 承载 turn_end 时机的 project sidecar 兜底补写——第一个 turn_end 时 pi 已完成该轮
   * flush（session 文件已存在），existsSync 守卫通过。label 持久化已不在此承载
   *（W1 数据源治理：活跃 label 唯一写入口 = renameSession/create/fork 的 set_session_name RPC）。
   */
  handleTurnUsageSideEffects(sessionId: string): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    // D14 语义修正：turn_end 时 pi 已完成 flush（文件存在）→ 兜底补写归属 project sidecar
    //（create 时文件未落盘被 existsSync 守卫跳过，内存态 projectId 在此落盘）。
    this.deps.tryPersistProjectBinding(session)
  }

  /**
   * agent_end 副作用（W3 迁移自 attachUsageListener agent_end 分支）。
   *
   * 承载三个副作用：
   *   1. occupancy #3 'settling' 转移（session-dead-structural-fixes D2 挂点迁移，u3b）——
   *      原直写 isGenerating=false 与 interpreter 侧 #3（turn-end → settling）是「agent_end
   *      两边各写一处且非原子」的漂移形态（设计 §2.3 根因 1），改调 'settling' 行后原语原子
   *      完成「isGenerating=false 派生 + turn='settling' 合并 + state 帧广播」，双写合一；
   *      interpreter #3 保留为幂等去重的防御性冗余。不迁移则正常生成完成后 session 永远
   *      isGenerating=true，下一条消息被 busy 拒绝（message-dispatcher preemptive reject）。
   *   2. project sidecar 兜底补写 —— turn_end 时仍未落盘则在此补写（label 持久化已不在此
   *      承载：W1 起活跃 label 唯一写入口 = set_session_name RPC）。
   *   3. session_end 终态写入（W4，ADR 0042）—— 让 scanner 读到终态，前端无需预加载历史。
   *
   * @param stopReason pi agent_end 的 stopReason。
   *   outcome 映射：'error'→error，'aborted'→stopped，其余→done。
   *   aborted 走 stopped 与 message-dispatcher.abort 路径一致（abort 写 stopped 后若 pi 仍发
   *   agent_end{stopReason:'aborted'}，此处也写 stopped，两条 session_end 一致不冲突）。
   */
  handleTurnEndSideEffects(sessionId: string, stopReason?: string): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    applySessionOccupancyTransition(session, this.deps.getMessageBus(), 'settling')
    // D14 语义修正：agent_end 兜底补写归属（turn_end 时仍未落盘则在此补写）。
    this.deps.tryPersistProjectBinding(session)
    // W4：写 session_end 终态。aborted→stopped（与 abort 路径一致），error→error，其余→done
    const outcome = stopReason === 'error' ? 'error'
      : stopReason === 'aborted' ? 'stopped'
        : 'done'
    this.deps.persistSessionOutcome(sessionId, outcome)
  }

  /**
   * agent_settled 副作用（session-dead 2026-09-10 补丁）：run 级联结束 → occupancy #4 'idle'
   * 转移（session-dead-structural-fixes D2 挂点迁移，u3b——原直写 isGenerating=false 改调
   * 'idle' 行，原语原子完成「isGenerating=false 派生 + turn='idle' 合并」；interpreter 侧 #4
   * 幂等去重，settled 边沿时投影即时归位）。
   *
   * 与上方 agent_end 副作用的分工（pi 实装依据）：`agent_end` 由 Agent 每次 attempt 发出，
   * retry / auto-compaction 续跑会**重发**，本身不是 run 终点；真正的终点是 `_runAgentPrompt`
   * 的 `finally` 中 `_emitAgentSettled()`（pi dist/core/agent-session.js:772-786），且存在
   * 「post-run 尾段返回 false 直接 settle」这条不含 agent_end 的收尾路径（同文件 :787+）。
   *
   * 缺本挂点的后果：message-dispatcher 的 processing 分支在 pi 拒绝「already processing」时
   * 置 isGenerating=true（'reject-processing' 行，见 handlePromptFailure 注释），其复位原先只
   * 依赖 agent_end。若 prompt 恰落在「post-run 尾段」（_flushPendingBashMessages 等 I/O，可达
   * 百毫秒级、**每次 run 结束都经过**）窗口，则 agent_end 已发而 settle 未完成 → isGenerating
   * 永久残留 true：occupancy 已被 #4 复位为 idle（前端照常 flush），但 busy 预检读 occupancy
   * → 后续每条消息被拒，只能等 abort / 进程退出（幽灵忙碌，与本次事故同类）。
   *
   * 语义依据：agent_settled = run 级联结束（pi finally），此刻必无 turn 在跑 → 'idle' 转移正确。
   * 反向竞态（本复位晚于「新 run 受理 prompt」的置位）存在但可自愈：pi 对活跃 run 的 prompt
   * 会拒绝 processing（锚点 pi@0.84.4 dist/core/agent-session.js:862 "Agent is already
   * processing" throw，run 活跃时 prompt 直拒），由 handlePromptFailure 的 processing 分支
   * （'reject-processing'）重新纠偏。
   */
  handleAgentSettledSideEffects(sessionId: string): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    applySessionOccupancyTransition(session, this.deps.getMessageBus(), 'idle')
  }

  /**
   * 拉取上下文用量并触发广播（restoreSession / forkSession 兜底用）。
   *
   * W12：广播职责归 usage fetch 挂钩（publishContextFromSnapshot）——本方法只做「查询即
   * 失效」（fetchContext 内 markDirty → 防抖重拉 → 快照应用后挂钩发布）。fetchContext 返回
   * null（compact 后无值）时不失效，快照保持旧值——对齐旧「null 不广播」语义。
   * 注意：挂钩发布的广播可能早于前端订阅新 sessionId 通道（时序竞争，见架构约定 #7），
   * 前端 useContextUsage composable 的恢复腿（每次切入视图拉 session.getContext）保证到达。
   * fire-and-forget 语义：失败不阻塞 session 恢复。
   */
  async fetchAndBroadcastContext(sessionId: string): Promise<void> {
    try {
      await this.deps.fetchContext(sessionId)
    // eslint-disable-next-line taste/no-silent-catch -- 兜底拉取失败无影响（前端主动拉是主路径）
    } catch (e) {
      console.warn('[session-service] fetchAndBroadcastContext failed:', e)
    }
  }

  // ── 快照投影族（原 Facade 私有方法族逐字随迁）──

  /**
   * W7/W8：注册 per-session 实例组（四实例）并 refetch 播种。
   * 配置即登记表条目（replicated-states.config.ts）；fetch 统一走窄访问器（fetchStateSnapshot /
   * fetchSessionStatsSnapshot / fetchCommandsSnapshot，复用 rpc-client 对应方法）。
   * 幂等注册（同 id 重复注册先 dispose 旧实例，防定时器泄漏）。
   */
  registerReplicatedStates(sessionId: string): SessionReplicatedStates {
    const existing = this.replicatedStates.get(sessionId)
    if (existing) {
      existing.thinkingLevel.dispose()
      existing.modelId.dispose()
      existing.usage.dispose()
      existing.commands.dispose()
    }
    // W12：modelId / thinkingLevel 的 fetch 走带 state_changed 发布挂钩的包装（快照应用后
    // 组合投影）；usage / commands 的 fetch 各自带发布挂钩（fetchSessionStatsSnapshot /
    // fetchCommandsSnapshot），无需裸 fetchState。
    const fetchStateForStateChanged = () => this.fetchStateSnapshotWithStatePublish(sessionId)
    const states: SessionReplicatedStates = {
      thinkingLevel: new ReplicatedState(createThinkingLevelStateConfig(fetchStateForStateChanged)),
      modelId: new ReplicatedState(createModelIdStateConfig(fetchStateForStateChanged)),
      usage: new ReplicatedState(createUsageStateConfig(() => this.fetchSessionStatsSnapshot(sessionId))),
      commands: new ReplicatedState(createCommandsStateConfig(() => this.fetchCommandsSnapshot(sessionId))),
    }
    this.replicatedStates.set(sessionId, states)
    states.thinkingLevel.refetch()
    states.modelId.refetch()
    states.usage.refetch()
    states.commands.refetch()
    return states
  }

  /**
   * W7：get_state 快照拉取——thinkingLevel / modelId 实例的唯一 fetch 入口
   * （复用 rpc-client getState）。无活跃 client 时抛错 → 实例按快照失败处理（退避重试 +
   * 保留旧值，W6 核心不变量 2）。
   */
  private async fetchStateSnapshot(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_state unavailable: no active pi client for session ${sessionId}`)
    }
    return client.getState()
  }

  /**
   * W8：get_session_stats 快照拉取——usage 实例的唯一 fetch 入口（复用 rpc-client
   * getSessionStats）。无活跃 client 抛错 → 实例按快照失败退避重试 + 保留旧值。
   *
   * W12：fetch 成功后排一次 context.update 发布（setTimeout 0 宏任务——fetch promise
   * resolve 后 doFetch 的 applySnapshot 在微任务链上先于宏任务执行，发布读到的必是已应用
   * 快照）。播种 refetch / context 事件失效（applyContextUpdate）/ fetchContext 查询失效 /
   * switchModel 失效的每次 fetch 都经本入口 ⇒ stateSnapshot 的 context last-value 恒 ==
   * owner 快照（「投影一次」，D7）。fetch 失败（throw）不发布——快照未变。
   *
   * D1（context-consistency Phase 1）：fetch 成功且投影为空快照（pi tokens=null 合法无值）
   * 时挂钩改发「无值占位帧」（仅含 sessionId，typeKey='context' last-value 显式登记无值态，
   * 切回的 stateSnapshot 回放可区分「该 session 无值」与「从未收到帧」）。空投影判定在
   * fetch 返回值上做而非实例 .get()——ownerSnapshotMerge 对空快照保持旧值，.get() 拿到的
   * 是旧值不是「空」；.get() 为 undefined（从未 fetch 成功 / 退避窗口）时值可能马上就来，
   * 不发占位帧防消费方误写 no-value。
   */
  private async fetchSessionStatsSnapshot(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_session_stats unavailable: no active pi client for session ${sessionId}`)
    }
    const stats = await client.getSessionStats() as Record<string, unknown> | undefined
    const noValue = isUsageNoValueProjection(stats)
    setTimeout(() => {
      if (noValue) {
        this.publishContextNoValuePlaceholder(sessionId)
      } else {
        this.publishContextFromSnapshot(sessionId)
      }
      this.publishStateChangedFromSnapshot(sessionId)
    }, 0)
    return stats
  }

  /**
   * W12：读 usage 实例快照发布 context.update（state topic，last-value == owner 快照）。
   * 三字段任一 undefined 不发布（快照未就绪——fetch 失败退避 / 播种竞速窗口；真无值走
   * publishContextNoValuePlaceholder 占位帧，见 fetchSessionStatsSnapshot D1 注释）。
   */
  private publishContextFromSnapshot(sessionId: string): void {
    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const snapshot = this.replicatedStates.get(sessionId)?.usage.get()
    if (
      snapshot?.inputTokens === undefined
      || snapshot?.usagePercent === undefined
      || snapshot?.contextLimit === undefined
    ) return
    const msg: ServerMessage = {
      type: 'context.update',
      id: `ctx_${Date.now()}`,
      payload: { sessionId, inputTokens: snapshot.inputTokens, contextLimit: snapshot.contextLimit, usagePercent: snapshot.usagePercent },
    }
    this.deps.getMessageBus()?.publish(sessionId, msg)
  }

  /**
   * D1（context-consistency Phase 1）：无值占位帧——仅含 sessionId 的 context.update。
   * 触发条件 = 本次 fetch 成功且投影为空快照（pi tokens=null；见 fetchSessionStatsSnapshot
   * 的判定注释）。写入 typeKey='context' 的 last-value 后，stateSnapshot 回放能区分「该
   * session 无值」与「从未收到帧」。协议层语义：字段缺失 = 无值（0 基线帧已随 D1 消失）。
   */
  private publishContextNoValuePlaceholder(sessionId: string): void {
    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const msg: ServerMessage = {
      type: 'context.update',
      id: `ctx_${Date.now()}`,
      payload: { sessionId },
    }
    this.deps.getMessageBus()?.publish(sessionId, msg)
  }

  /**
   * W8：get_commands 快照拉取——commands 实例的唯一 fetch 入口（复用 rpc-client getCommands）。
   * 无活跃 client 抛错 → 实例按快照失败退避重试 + 保留旧值。
   *
   * W12：fetch 成功后排一次 session.commands 发布（setTimeout 0 宏任务——fetch promise
   * resolve 后 doFetch 的 applySnapshot 在微任务链上先于宏任务执行，发布读到的必是已应用
   * 快照）。播种 refetch / 查询即失效（getCommands）/ 防抖重拉的每次 fetch 都经本入口 ⇒
   * stateSnapshot 的 commands last-value 恒 == owner 快照（「投影一次」，D7）。fetch 失败
   * （throw）不发布——快照未变，无需刷新 last-value。
   */
  private async fetchCommandsSnapshot(sessionId: string): Promise<unknown> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_commands unavailable: no active pi client for session ${sessionId}`)
    }
    const result = await client.getCommands()
    setTimeout(() => this.publishCommandsSnapshot(sessionId), 0)
    return result
  }

  /** W12：读 commands 实例快照发布 session.commands（state topic，last-value == owner 快照）。 */
  private publishCommandsSnapshot(sessionId: string): void {
    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const commands = this.replicatedStates.get(sessionId)?.commands.get()?.commands
    if (commands === undefined) return // 快照未就绪（首拉失败窗口）：不发（对齐旧路径失败不发）
    const msg: ServerMessage = { type: 'session.commands', payload: { sessionId, commands } }
    this.deps.getMessageBus()?.publish(sessionId, msg)
  }

  /**
   * W12：读 modelId / thinkingLevel 两实例快照组合发布 session.state_changed
   *（state topic，payload 全字段来自实例快照）。
   *
   * 触发点 = 各实例的 fetch 成功挂钩（fetchStateSnapshotWithStatePublish /
   * fetchSessionStatsSnapshot）——任一实例快照应用后刷新组合，全部收敛后 last-value 为
   * 终态组合（中间态帧由下方 diff 抑制去重，renderer 幂等覆盖）。
   * 快照缺失字段 fallback 双写缓存（session.modelId / thinkingLevel）——登记的永久形态
   * （PR #185 S2 裁决，2026-08-20）：播种 refetch 实例异步竞速，先落定者即触发本发布，
   * 未落定实例 .get() 为 undefined；get_state 失败退避（1s/5s/15s）窗口同理。缓存由
   * switchModel / setThinkingLevel RPC 成功后直写保持最新，兜底值即 pi 生效值。
   * D1（context-consistency Phase 1）：usage 三字段已从本帧删除——usage 只经 context.update
   * 一条帧贯穿，本方法不再投影 usage（旧「无快照 ?? 0 基线」随协议删除）。
   * diff 抑制：thinkingLevel 的 30s 周期兜底重拉会高频触发挂钩，同值组合不重复发帧。
   */
  private publishStateChangedFromSnapshot(sessionId: string): void {
    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const session = this.deps.getSession(sessionId)
    const states = this.replicatedStates.get(sessionId)
    if (!session || !states) return
    const payload = buildStateChangedPayload(sessionId, session, states)
    const last = this.lastPublishedStateChanged.get(sessionId)
    if (last && stateChangedPayloadEquals(last, payload)) return
    this.lastPublishedStateChanged.set(sessionId, payload)
    // wave:perf-w09（D1-2）：session.state_changed 单通道走 bus publish
    //（wave:perf-w06：state_changed 已入 bus 的 STATE_TYPE_KEY_MAP——publish 分配 seq 写
    // stateSnapshot、不入 streamRing，重连由 stateSnapshot 恢复。）
    const stateMsg: ServerMessage = {
      type: 'session.state_changed',
      id: `push_${Date.now()}`,
      payload,
    }
    this.deps.getMessageBus()?.publish(sessionId, stateMsg)
  }

  /**
   * W12：modelId / thinkingLevel 实例的 fetch 包装——get_state 快照应用后挂钩发布
   * session.state_changed（组合投影）。与 fetchStateSnapshot 的关系：多一层「fetch 落定
   * （成功或失败）→ setTimeout 0 宏任务发布」（宏任务晚于 doFetch 的 applySnapshot 微任务
   * 链，成功路径发布读到的必是已应用快照）。失败路径同样排发布：payload 走快照缺失的
   * fallback 双写缓存（永久形态，见 publishStateChangedFromSnapshot 注释）——对齐旧
   * broadcastSessionState「get_state 失败不阻塞、thinkingLevel 回退缓存值」语义；
   * rethrow 由 finally 透传，实例退避重试语义不变。
   */
  private async fetchStateSnapshotWithStatePublish(sessionId: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.fetchStateSnapshot(sessionId)
    } finally {
      setTimeout(() => this.publishStateChangedFromSnapshot(sessionId), 0)
    }
  }

  // ── 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调，与 TraceSync.onSessionDisposed 并列）──

  /**
   * W7/W8 + W12：销毁 per-session 实例组与 state_changed diff 基线（主动删 + 进程退出
   * 汇聚点）。dispose 停防抖/退避/周期兜底全部定时器；基线随 session 销毁清除（防同 id
   * 重建后误判同值）。幂等（无实例组时 no-op）。
   */
  onSessionDisposed(sessionId: string): void {
    const replicated = this.replicatedStates.get(sessionId)
    if (replicated) {
      replicated.thinkingLevel.dispose()
      replicated.modelId.dispose()
      replicated.usage.dispose()
      replicated.commands.dispose()
      this.replicatedStates.delete(sessionId)
    }
    this.lastPublishedStateChanged.delete(sessionId)
  }
}
