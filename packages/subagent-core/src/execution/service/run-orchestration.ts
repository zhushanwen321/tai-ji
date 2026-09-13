// [H3/R4] RunOrchestration 聚合（域 #6/#7/#12/#14/#15：model 解析 + run 域执行入口 +
// await 入口 + 引擎编排 + pool/worktree 资源）——自
// SubagentService 上帝类 strangler 抽取的核心编排聚合（设计
// docs/architecture/subagent-service-decomposition.md §2.1 / §3.3 D2 抽取序末位；成员归属以
// r0-inventory.md 清单① + 域分区为准）。
//
// [G1 超限预授权拆分 / 偏差 D-R4-1] 主 agent 派发预授权：R4 域段体量大（派发估算
// 1200+ 物理行），按内聚边界拆两个文件——本文件（核心编排）+ workflow-dispatch.ts
//（workflow 族独立）。**实测与派发估算不符**：R0 重排后域段实测 1662 物理行 > 两文件
// 容量上限（2×700），本文件物理超限不可避免（偏差登记待主 agent 追认）。两文件零互调
// 零 import（G2 / R1 打样模式 3）：workflow-dispatch 的跨文件协作（acquirePoolOrFinalize /
// settleOneShotOutcome / outcomeToAgentResult / releaseRoundResources /
// resolveChatEnginePort / assertIdleTimeoutMsSafe）经壳 deps 回调指回本聚合实例方法。
//
// [2026-09-13 design-code-sync 兑现] [G1] 段预留的备选预案（第三文件再拆 Continuation
// 协作面）落地：本文件折算 845 破 800 零余量锁定线，拆出 chat-rounds.ts（chat 域轮次
// 编排——Continuation 实例表 + 统一投递入口 + kickOffChatRound 轮次主干 + one-shot
// settled-watchdog fire 处置 + 轮末收口协作 + SP-5 升级 gate + Continuation 生命周期
// 显式接口）。两文件零互调零 import（workflow-dispatch 同款形态）：
//   - 本聚合 → chat-rounds：executeViaEngine 的 chatMode 首轮派发与 one-shot 轮派发
//     调用点，经 deps 回调 startFirstChatRound / kickOffChatRound（壳装配闭包指
//     ChatRounds 实例方法）；
//   - chat-rounds → 本聚合：taskSpecWithModel / outcomeToAgentResult / settleOneShotOutcome
//     / writeBindingForRecord / effectiveMaxConcurrentFor / resolveChatEnginePort 六项
//     编排原语（壳装配闭包指本聚合实例方法）。
//
// 单一职责：run 域执行编排——execute/executeAndAwait 入口（路由 → identity → record
// 创建 → worktree → detached 引擎 run）、引擎死亡分诊（adopt）、终态收口
//（settleOneShotOutcome 含 D7 workflow origin 分支）、pool/worktree 资源装配与回收。
//
// [R1 打样模式——R4 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）——pi/会话基线运行时可变态
//   （execNesting/sessionRootId/streamSink/uiObservability）经壳 getter 现读；
//   #1 留壳共享依赖（store/manifestStore/modelService/notifyHost/pool/worktreeManager/
//   collectCoordinator）getter 现读同一实例——深绑测试的 FR 替换语义保持。
// 2. 转发壳写法：壳保留同名方法单行转发（execute/executeAndAwait/resolveModel 对外面 +
//   executeWorkflowAgent → WorkflowDispatch / canUpgradeToConversation + deliverChatMessage
//   → ChatRounds，2026-09-13 接线）；聚合内部互调（executeViaEngine/kickOffEngineRun/
//   runEngineTask/settleOneShotOutcome 族等）不经壳。
// 3. 跨聚合边收敛（r0-inventory 清单① C-4/C-5 + B-6）：
//   - C-4（壳 dispose 直调 continuations.clear）：字段所有权随 Continuation 协作面迁
//     chat-rounds.ts，壳经其 clearContinuations() 显式接口（R4 兑现，接线 2026-09-13）。
//   - C-5（onRecordFinalizedCleanup 跨域汇聚点 + abortContinuationQueue 队列清空）：
//     本体迁 chat-rounds.ts；RecordLifecycle deps 回调（R3 装配时指壳方法）改指聚合
//     显式接口（R4 兑现，接线 2026-09-13）。
//   - B-6（roundSupervisor 归属争议）：留壳——boot 分区（initSession）与 dispose 时序
//     消费在壳、装配闭包 finalizeClosed 经壳转发 late-bound（C-6 天然兼容）；本聚合
//     经 deps.getRoundSupervisor() 现读（noteRun*/adoptOnProcessDeath）。
// 4. 只搬不改：方法体除依赖通道替换（this.X → this.deps.getY()）外逐字节保留
//   （审计 /tmp/r4-move-audit.py）；r0-inventory 清单② A 通道直写 14 处（#12 域
//   executeAndAwait 1 处 + #14 域 13 处——任务口径 12 处按「#14 域 adopt 三行并 1」
//   计）原样随迁，H4 收口。
// 5. 模块常量 SSOT：PRIORITY_BACKGROUND / MS_PER_SECOND / SECONDS_PER_MINUTE 已
//   [R6/D-R4-4] 归一常量叶子文件 service-constants.ts（原两聚合重复声明消除，
//   改 import 消费）；STALE_CHILD_EXIT_WAIT_MS + delay（唯一消费
//   killStaleChildBeforeDispatch）随消费主体迁 chat-rounds.ts（2026-09-13 接线）。

import { SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";
import { toErrorMessage } from "../../core/error-message.ts";
import { MAX_TIMER_DELAY_MS } from "../../shared/timer-delay.ts";

import type { AgentResult as WorkflowAgentResult, AgentCallOpts } from "../../orchestration/models/types.ts";
import { mapToWorkflowAgentResult } from "../assembly/agent-result-mapper.ts";
import type { CollectCoordinator } from "../assembly/collect-coordinator.ts";
import type { ConcurrencyPool } from "../assembly/concurrency-pool.ts";
import { project, tryTransition, updateFromEvent } from "../persistence/execution-record.ts";
import { assertTaskShapeSupported } from "../engine/common/capability-gate.ts";
import { wireEventJournal } from "../engine/common/journal-wiring.ts";
import type { ExecutionNestingContext } from "../engine/common/nesting-guard.ts";
import { resolveHostPiEnginePort } from "../engine/host/pi-host-binding.ts";
import { registerSpawnedChildForRecord } from "../engine/host/spawned-children.ts";
import type { EnginePort, RunContext } from "../engine/port.ts";
import { executeOptionsToEngineTaskSpec } from "../engine/host-task-spec.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "../engine/registry.ts";
import { type EngineRouteResult, routeEngineForHost } from "../engine/routing.ts";
import type { AgentOutcome } from "../engine/types.ts";
// [V2 决策 3] lifecycle-manager：[T4②] DEFAULT_IDLE_TIMEOUT_MS 是 assertIdleTimeoutMsSafe
// 错误文案的缺省时长基准（[R4] 唯一消费主体随域迁入本聚合）。
import { DEFAULT_IDLE_TIMEOUT_MS } from "../lifecycle/lifecycle-manager.ts";
import type { ModelConfigService } from "../assembly/model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "../assembly/model-resolver.ts";
import type { NotifyHost } from "../notify/notify-host.ts";
import type { RecordStore } from "../persistence/record-store.ts";
// [R3] ResolvedIdentity 接口本体在 record-access.ts（生产者 resolveIdentity 所属聚合），
// 本聚合单向 type import（D-R3-2 同款非环形态）。
import type { ResolvedIdentity } from "./record-access.ts";
import type { RoundSupervisor } from "../round-supervisor/index.ts";
import { MAX_FORK_DEPTH } from "../assembly/session-context-resolver.ts";
import type { SubagentStream } from "../assembly/stream-sink.ts";
import { writeRecordBinding } from "../persistence/state-marker.ts";
import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";
import type { WorktreeManager } from "../worktree/worktree-manager.ts";
import type {
  AgentEvent,
  AgentResult,
  ClosedReason,
  WorktreeHandle,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionRecord,
} from "../assembly/types.ts";
import { DEFAULT_AGENT_NAME, ForkDepthExceededError } from "../assembly/types.ts";
// [R6/D-R4-4] 跨聚合消费的值语义纯量归一常量叶子文件（聚合→支撑文件方向合法）。
// [2026-09-13 design-code-sync] MS_PER_SECOND / SECONDS_PER_MINUTE 消费主体
//（onOneShotSettledWatchdogTimeout）已迁 chat-rounds.ts，本聚合余 PRIORITY_BACKGROUND。
import { PRIORITY_BACKGROUND } from "./service-constants.ts";

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。五类成员：
 * - 断言面（assertReady）：execute/executeAndAwait 入口就绪门
 *  （本体在 SessionBaselines，壳转发）。
 * - #1 留壳共享依赖 getter（getStore/getModelService/getNotifyHost/
 *   getPool/getWorktreeManager/getCwd/getRoundSupervisor/getCollectCoordinator）：
 *   getter 现读同一实例（B-6 roundSupervisor 留壳、C-6 装配闭包经壳 late-bound）。
 * - 会话基线 getter（getExecNesting/getSessionRootId）：
 *   initSession 注入的运行时可变态现读（SessionBaselines 经壳 getter 透传）。
 * - R3 聚合显式接口（resolveIdentity/resolveIdentityForEngine/createRecordForMode/
 *   buildEarlyFailedHandle/finalizeRecord/finalizeFailed/finalizeAborted）：
 *   身份解析/record 创建/意愿动作收口的跨聚合协作
 *  （壳装配指 RecordAccess/RecordLifecycle 实例方法，聚合间零私有互调——G2）。
 * - ChatRounds 协作回调（startFirstChatRound/kickOffChatRound，2026-09-13 design-code-sync
 *   接线）：executeViaEngine 的 chat 域轮次派发（本体在 ChatRounds，壳装配闭包指其
 *   实例方法——workflow-dispatch 同款「接口在消费方、实现在聚合」形态）。
 */
export interface RunOrchestrationDeps {
  /** [D4 下沉] assertReady 断言（本体在 SessionBaselines，壳转发）。 */
  readonly assertReady: () => void;
  /** RecordStore（#1 留壳共享依赖；运行中句柄回填 reportRecordTransition/Continuation
   *  revive register 面）。 */
  readonly getStore: () => RecordStore;
  /** ModelConfigService（resolveModel 代理 + 路由全局缺省 + FinalizeDeps）。 */
  readonly getModelService: () => ModelConfigService;
  /** 进程 cwd（worktree create 锚点）。 */
  readonly getCwd: () => string;
  /** WorktreeManager（worktree 创建/清理 + FinalizeDeps）。 */
  readonly getWorktreeManager: () => WorktreeManager;
  /** NotifyHost（pending emit + one-shot watchdog 失败通知 + FinalizeDeps 注销面）。 */
  readonly getNotifyHost: () => NotifyHost;
  /** ConcurrencyPool（DefaultConcurrencyPool 共享池——execute/executeAndAwait/
   *  chat 轮次/引擎任务的并发槽）。 */
  readonly getPool: () => ConcurrencyPool;
  /** 根 session id（relay 归属键 SESSION_ID 权威源；runCtx 注入）。 */
  readonly getSessionRootId: () => string | null;
  /** 嵌套身份基线（BC-12 嵌套护栏深度检查）。 */
  readonly getExecNesting: () => ExecutionNestingContext;
  /** [B-6 留壳] 轮次活性监督器（在途记账/死亡分诊 adoptOnProcessDeath）。 */
  readonly getRoundSupervisor: () => RoundSupervisor;
  /** [R2 SyncCollect 显式接口] collectCoordinator 公共投影（bg 完成回注 route 投递）。 */
  readonly getCollectCoordinator: () => CollectCoordinator;
  /** [R3 RecordAccess 显式接口] 步骤 1 身份解析（三层：override → agentConfig → 主
   *  agent model；含 pi 未命中跨引擎候选文案）。 */
  readonly resolveIdentity: (
    opts: ExecuteOptions,
    pre?: { agent: string; agentConfig: AgentConfig | undefined },
  ) => Promise<ResolvedIdentity>;
  /** [R3 RecordAccess 显式接口] 非 pi 引擎的 identity 解析。 */
  readonly resolveIdentityForEngine: (
    engine: EnginePort,
    engineModel: string | undefined,
    agent: string,
    agentConfig: AgentConfig | undefined,
    opts: ExecuteOptions,
  ) => ResolvedIdentity;
  /** [R3 RecordAccess 显式接口] 按 mode 生成 id + controller，创建 record 并注册。 */
  readonly createRecordForMode: (
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
    originFields?: { origin: "workflow"; parentRunId: string },
  ) => ExecutionRecord;
  /** [R3 RecordAccess 显式接口] worktree 前置失败的 early-return handle。 */
  readonly buildEarlyFailedHandle: (record: ExecutionRecord) => ExecutionHandle;
  /** [R3 RecordLifecycle 显式接口] D-017 时序收尾（doFinalizeRecord 委托）。 */
  readonly finalizeRecord: (
    record: ExecutionRecord,
    result: AgentResult,
    status: "closed",
    closedReason?: ClosedReason,
  ) => Promise<void>;
  /** [R3 RecordLifecycle 显式接口] run() 创建期异常的收尾。 */
  readonly finalizeFailed: (record: ExecutionRecord, err: unknown) => Promise<AgentResult>;
  /** [R3 RecordLifecycle 显式接口] 排队中被 abort 的收尾（[U5] cancel 语义 settle）。 */
  readonly finalizeAborted: (record: ExecutionRecord) => Promise<AgentResult>;
  /** [ChatRounds 协作回调 / 2026-09-13 design-code-sync 接线] chatMode 首轮派发
   *  （continuationFor ensure + startFirstRound——本体在 ChatRounds；executeViaEngine
   *  的 pi 与非 pi chatMode 两分支消费）。 */
  readonly startFirstChatRound: (record: ExecutionRecord, task: string) => void;
  /** [ChatRounds 协作回调] pi 引擎 background 轮次派发主干（one-shot 与 Continuation
   *  轮同路——本体在 ChatRounds；executeViaEngine 的 pi one-shot 分支消费。回调签名
   *  收窄为本聚合真实消费的五参形态，resume/continuation 缺省语义归聚合）。 */
  readonly kickOffChatRound: (
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
  ) => void;
}

/**
 * 域 #6/#7/#12/#14/#15 聚合：run 域执行编排（R4 自 SubagentService 抽取）。
 *
 * 字段所有权（r0-inventory 清单①）：#31 continuations（Continuation 实例表）已随
 * Continuation 协作面迁 chat-rounds.ts（2026-09-13 design-code-sync 接线）——该聚合
 * 唯一写者；壳 dispose 经其 clearContinuations() 显式接口触达（C-4 兑现），字段壳与
 * 本聚合零感知。
 */
export class RunOrchestration {
  private readonly deps: RunOrchestrationDeps;

  constructor(deps: RunOrchestrationDeps) {
    this.deps = deps;
  }

  // [R4 等价形态复刻] sessionRootId 经 getter 转发 deps（属性访问形态保留——TS 对
  // getter 可做 null 收窄，runCtx 条件 spread 的类型推导与壳内原形态一致；函数调用
  // 形态 this.deps.getSessionRootId() 不参与收窄）。
  private get sessionRootId(): string | null {
    return this.deps.getSessionRootId();
  }

  /**
   * 预解析 model（renderCall 标题行用，同步）。代理 modelService.resolveModel。
   * 仅解析 override/agentConfig 路径；ctxModel 缺失时拋错，调用方 catch 降级。
   */
  resolveModel(
    agent: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
    agentConfig?: AgentConfig,
  ): ResolvedModel {
    return this.deps.getModelService().resolveModel(agent, override, ctxModel, agentConfig);
  }

  /**
   * 统一执行入口。mode 固定 background（sync 已删除）。
   * 内部完成：模型解析 → 执行 → 收尾。
   *
   * @param opts.ctxModel  主 agent 当前模型（模型解析第三层兼底）。undefined 时仅依赖 override/agentConfig。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.deps.assertReady();
    // [T4② / PS-4] idleTimeoutMs 配置错误在首个副作用前同步 fail-fast（错误含合法范围）。
    this.assertIdleTimeoutMsSafe(opts);

    // 通用嵌套深度护栏（D-033）：嵌套上下文（[D3-⑤] 公共层 ExecutionNestingContext）
    // 记录所有 subagent 嵌套层级（fork + 非 fork），每层 +1。MAX_FORK_DEPTH 同时限
    // fork 链与通用嵌套——非 fork 递归虽不累积 session 体积，但耗资源且 LLM 易陷入
    // 「委派→再委派」死循环。在所有副作用之前拦截，错误直达调用方。
    // 计数基准：顶层 nestingDepth=0，nestingDepth>MAX 被拒。与 fork 体积护栏（parentForkDepth 检查）
    // 互补：本护栏更严（计所有嵌套），混合链下先生效；两者共享 MAX_FORK_DEPTH 上限不漂移。
    // [ALS 断裂修复] current() 内含基线兜底（pi 事件回调模型下 enterWith 不贯穿）。
    const parentNesting = this.deps.getExecNesting().current();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // mode 固定 background（sync 模式已删除）
    const mode: ExecutionMode = "background";

    // ── 1. IDENTITY 前置解析：agentConfig（agent .md 加载）保持在最前 ──
    // [u-h2 D2-1] 路由先行：model 解析从「路由之前」移到「路由之后、按目标引擎分支」
    // （修 F2-A/B 时序根因——曾 :850 先解析 model 再 :867 路由）。agentConfig 是路由
    // 第二层输入（frontmatter engine）必须先解析；显式 agent ref 校验语义不变。
    const agent = opts.agent ?? DEFAULT_AGENT_NAME;
    const agentConfig = opts.agent
      ? this.deps.getModelService().getRequiredAgentConfig(opts.agent)
      : undefined;

    // ── 1.5 引擎路由（D2 单轨 + D3-② 路由单点：统一经 routeEngineForHost）──
    // 唯一实现在 engine/routing.ts（pi 同步短路 + registry 注入 + 兜底回本地 pi 实例
    // 收敛于此）；本调用点只装配三层输入与注入件。时机：路由（含 probe）在 record
    // 创建前完成——兜底时 record 按 pi 语义创建 + engineFallback 留痕（D5 字节级守护
    // 只约束「无 fallback 的纯缺省路径」）；守卫命中/strict 时在此 throw，不产生孤儿
    // record。pi 请求路径同步短路（routed 非 Promise，零微任务——首个 await 前完成
    // 路由决策；执行经进程边界，「run 内首个 await 前已触达 executeAndAwait」的旧
    // 时序契约由引擎协议化设计 §3.5.3 作废放宽）。
    // [u-h2 D2-1] 路由先行于 pi 链 model 解析：agentConfig 是路由第二层输入（frontmatter
    // engine）已前置解析；pi 的 resolveModel 移到路由之后、按目标引擎分支执行——非 pi
    // 请求不被 pi registry 解析错误拦截（F2-A/B 时序根因），model 校验归目标引擎（D2-2）。
    const routingInput = {
      callEngine: opts.engine,
      agentEngine: agentConfig?.engine,
      globalDefaultEngine: this.deps.getModelService().getGlobalConfig().defaultEngine,
    };
    const routed = routeEngineForHost({
      routing: routingInput,
      // 守卫 c 判据只看调用方显式指定的 model（resolved model 含 ctxModel 兼底，
      // 恒非空会把一切兜底误判为 model 绑定命中）
      taskModel: opts.model,
      strict: this.deps.getModelService().getGlobalConfig().engineRouting?.strict === true,
      probe: (engineId) => getEngine(engineId).probe(),
      // [W3] chat 域 pi 路由 = registry cli 形态 port（协议客户端）——inproc DI 实例
      // 随 inproc pi 引擎目录 删除消亡，chat 与 run 域同路（G1 单一 CLI 形态）。
      piEngine: this.resolveChatEnginePort(),
    });
    const route: EngineRouteResult = routed instanceof Promise ? await routed : routed;
    return this.executeViaEngine(opts, { agent, agentConfig }, route, mode);
  }

  /**
   * workflow 编排层专用：sync-await 接口，内部走 background 管道但返回 Promise<AgentResult>。
   *
   * 与 execute() 的区别（D-A1）：
   *   1. 返回 workflow AgentResult（content 字段），非 ExecutionHandle
   *   2. 不经 chat 轮次 kick-off（detached 回注）→ 不注入 followUp 完成通知（BC-11，结果直接返回 workflow）
   *   3. T2 删 sync 时 executeAndAwait 不受牵连（独立方法）
   *
   * 共享：runSpawn + ConcurrencyPool + record + pending emit（D-A4）。
   */
  async executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    this.deps.assertReady();
    // [T4② / PS-4] 与 execute() 同款入口校验（两入口共享 runAndFinalize → armIdleTimer 链）。
    this.assertIdleTimeoutMsSafe(opts);

    // ── BC-12 嵌套护栏：复用 execute() 的嵌套上下文深度检查 ──
    // [ALS 断裂修复] current() 内含基线兜底（与 execute 同）。
    const parentNesting = this.deps.getExecNesting().current();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // ── 步骤 1: IDENTITY 解析 ──
    const identity = await this.deps.resolveIdentity(opts);

    // ── 步骤 2: RECORD 创建（mode="background" 进池）──
    const record = this.deps.createRecordForMode(identity, opts, "background");
    this.deps.getNotifyHost().emitPendingRegister(record.id, record.agent);

    // ── 步骤 2.5: worktree creation (only worktree===true; handle injection is execute()'s path) ──
    // Workflow path receives boolean only (AgentCallOpts.worktree: boolean) — WorktreeHandle is a
    // main-thread non-serializable object that cannot cross worker postMessage, so no object branch
    // here (unlike execute() :445-447 which serves the subagent-tool path).
    // On create failure, finalizeFailed cleans up the record, then
    // throw lets SAR.run() convert it to an AgentResult.error (not return-handle like execute()).
    let worktreeHandle: WorktreeHandle | undefined;
    if (opts.worktree === true) {
      // [create-await 竞态守卫] 与 execute 同款（见其 worktree 分支注释）——差异仅在
      // 失败语义：executeAndAwait 对齐「失败 throw」，SAR.run 的 catch 会转成 AgentResult.error
      // （cancelled 呈现对齐 cancel 抢先路径）。赋值→终态检查→runAndFinalize 同一同步段。
      // 检查结果经标志位带出 try（守卫 throw 不能落在 try 内——会被下方 catch 当作
      // create 失败再走 finalizeFailed，对已 closed 的 record 语义未定义）。
      let cancelledDuringCreate = false;
      try {
        worktreeHandle = await this.deps.getWorktreeManager().create(this.deps.getCwd(), record.id);
        record.worktreeHandle = worktreeHandle;
        // [S5 修复] 创建即置 hadWorktree：归档清句（markArchived）后 entry/binding 的
        // worktree 投影与 Continuation 重建守卫（hadWorktree && !worktreeHandle）靠本
        // 标志承载——缺置 = 归档后守卫第一条不满足、重建永不触发。
        record.hadWorktree = true;
        // [U5 判据] cancel/dispose 抢先 = record 已离 running（markSettled settle 为
        // idle——新语义不写 closedReason，status 单判据即收口判读；两态状态机下
        // running 才有在飞任务）。赋值后同同步段检查：已收口则主动 cleanup（幂等，
        // 抢先路径的收起回收覆盖）+ throw cancelled（不进轮次——避免子进程白跑）。
        if (record.status !== "running") {
          cancelledDuringCreate = true;
        }
      } catch (err) {
        // finalizeFailed: CAS→finalizeRecord→emitUnregister (record already registered above).
        // throw (not return-handle): executeAndAwait's caller SAR.run() catches and wraps into
        // AgentResult.error. Diverges from execute() which returns buildEarlyFailedHandle
        // because the two methods have different return types.
        await this.deps.finalizeFailed(record, err);
        throw err;
      }
      if (cancelledDuringCreate) {
        await this.deps.getWorktreeManager().cleanup(worktreeHandle);
        throw new Error(`subagent ${record.id} cancelled during worktree creation`);
      }
    }

    // ── 步骤 3/4 合并（W3）：signal 决议（SessionRunnerContext 已随 inproc 链路删除）──
    const effectiveSignal = signal ?? record.controller?.signal;

    // 步骤 5: runAndFinalize（await，不 detached）。onEvent 独立传，stream 透传。
    const result = await this.runAndFinalize(
      record,
      { ...opts, worktree: worktreeHandle },
      identity,
      effectiveSignal,
      PRIORITY_BACKGROUND,
      onEvent,
      stream,
    );

    // ── 步骤 6: D-A10 AgentResult 映射 ──
    // [MF-2] 不在此 emit pending:unregister——runAndFinalize 内部已覆盖所有路径：
    //   - CAS 成功（runAndFinalize L629）→ finalizeRecord 末尾 emit（L797）
    //   - CAS 失败（cancel/finalizeFailed/dispose 抢先转终态）→ 那些路径各自已 emit
    //     （cancelBackground L709 / finalizeFailed→finalizeRecord / dispose L240）
    // 旧实现无条件 emit 一次 → CAS 成功分支重复 emit（双注销）。
    const wfResult = mapToWorkflowAgentResult(result);
    // W2 改动 7：注入 worktreePath（worktree 隔离激活时来自 step 2.5 的 worktreeHandle）。
    // mapToWorkflowAgentResult 不感知 worktree（它只做 subagents AgentResult → workflow AgentResult
    // 的 DTO 映射），故在 caller 侧 mutate 刚新建的产物对象（无共享引用，安全）。
    //
    // ⚠️ worktreePath is diagnostic only, may not exist — see AgentResult.worktreePath JSDoc
    // （orchestration/models/types.ts）。下方诊断标识符语义（not cwd）说明同源。
    //
    // 诊断标识符语义（not cwd）：
    //   - runAndFinalize 内的 finalizeRecord 在 return 前已 cleanup（git worktree remove --force），
    //     worktreePath 指向的目录已被删除，不保证存在。
    //   - worktreePath 仅供日志/trace 关联（如定位某条 session jsonl 的 worktree 来源），无运行时语义。
    //   - **不可作为后续 agent 的 cwd**——目录已删，复用会 ENOENT。
    //   - wave 内 worktree 复用（spec-w §2 "wave 内 8 action 共享 worktree"）在 pi 当前架构下
    //     不可行：worktree 绑定单次 agent() record，每次 executeAndAwait 结束 finalizeRecord
    //     无条件 cleanup，worktree 无法跨 action 存活。wave 改用主 cwd。
    wfResult.worktreePath = record.worktreeHandle?.path;
    return wfResult;
  }

  /**
   * [UF-1] record 绑定 sidecar 写（sessionFile 回填点统一入口）。
   *
   * engine-CLI 化后子 session 文件不含身份 entry（旧 PI_SUBAGENT_SELF_RECORD_ID
   * 注入链消失），跨重启后 coldLookupForAction（findLightById + collectRecords）
   * 失去 id→file 映射，message 一律「not found or not owned」（U4 基线 S6 ❌）。
   * 本方法在 record.sessionFile 被回填的代码点落 `<sessionFile>.record-binding`
   * （id→file + rootSessionId 等身份域），record-store 扫描侧据它重建身份。
   *
   * [D3a v8 时机① / U2b] 本方法是 sessionFile 回填族（run 应答回填 ×3 站点）的
   * 单一收口点——锚点确立即 acquireWriteLease 声明跨进程写权（fresh spawn 全程
   * 声明，缺口 1 闭合；「宿主开始往 session 文件写即声明写权」）。acquire 失败
   * 原样上抛（双写风险敞口必须响亮，D3c——禁止 best-effort 吞错续跑），由各回填
   * 站点所在的 run 收敛 catch 按 run 失败收口；绑定写维持 best-effort（记账面）。
   * sessionFile 未回填（undefined）时静默跳过（绑定无从谈起、亦无写权可声明）。
   */
  writeBindingForRecord(record: ExecutionRecord): void {
    const sessionFile = record.sessionFile;
    if (!sessionFile) return;
    this.deps.getStore().acquireWriteLease(sessionFile, record.id);
    writeRecordBinding(sessionFile, {
      v: 1,
      recordId: record.id,
      rootSessionId: record.rootSessionId,
      parentRecordId: record.parentRecordId,
      depth: record.depth,
      agent: record.agent,
      task: record.task,
      slug: record.slug,
      mode: record.mode,
      startedAt: record.startedAt,
      chatMode: record.chatMode === true,
      round: record.round,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      worktree: record.worktreeHandle !== undefined || record.hadWorktree === true,
      // [H2 S3] 来源身份随绑定落盘：引擎子文件身份面（binding sidecar）是磁盘重建
      // origin 的唯一现行载体，漏写则归档/重启后 workflow record 逃过 D1 投影过滤。
      origin: record.origin,
      parentRunId: record.parentRunId,
    });
  }

  /**
   * chat 域统一执行入口（D2 单轨：全引擎——含 pi——经此进入 EnginePort）。路由
   *（routeEngineForHost：三层 + pi 同步短路 + probe/守卫）已由 execute 完成——这里
   * 只剩 unsupported 预检 → identity（pi 链解析 / 非 pi 按目标引擎校验，
   * [u-h2 D2-1/D2-2]）→ record 创建+盖章 → worktree → detached 引擎 run。
   * 全部同步拒绝发生在 record 创建前（不产生孤儿 record）。
   */
  async executeViaEngine(
    opts: ExecuteOptions,
    preIdentity: { agent: string; agentConfig: AgentConfig | undefined },
    route: EngineRouteResult,
    mode: ExecutionMode,
  ): Promise<ExecutionHandle> {
    const engine = route.engine;
    // [D3-④ 预检 capabilities 化] 唯一实现 = common/capability-gate（capabilities
    // 驱动，含 maxTurns 扩位）。检查点钉死：execute/executeViaEngine 同步段、record
    // 创建前（engine.capabilities() 同步可得）——承接「全部同步拒绝发生在 record
    // 创建前、不产生孤儿 record」不变量（其后的 kickOffEngineRun 是 fire-and-forget，
    // 检查若只落在 engine.run 内则拒绝异步化为「派发成功 + 静默失败 record」）。
    // [W3 契约变更③补注（协议化能力位方向判定）] 同步拒只覆盖「manifest 少声明」
    // 方向；**manifest 多声明**（声明支持而引擎实际不支持）由首个 run 的协议握手
    // `initialize` 发现 → engine_capability_mismatch 该 run 失败 + record 标 failed，
    // 并**清理 run 前已建的前置副作用**（worktree 经 finalizeFailed → finalizeRecord
    // Step 3b cleanupWorktreeIfBound 清理）。非 gate 位不一致（无论强弱）一律
    // warn 留痕不阻断（诊断面归 EngineClient，设计 §3.3 能力位段）。
    assertTaskShapeSupported(engine.id, engine.capabilities(), opts);

    // [metrics-gate cyclo 偿还·第二轮 / 行为保持] 沿既有拆解方向（见 eslint.config
    // [HISTORICAL] cyclo 偿还段）继续原地拆解：identity 分支构造 → resolveIdentityForRoute、
    // record 盖章 → stampEngineOnRecordOpts、派发分流 → kickOffBackgroundDispatch——
    // 判据 / 分支产物 / 次序逐字节等价。worktree 段保持内联：[create-await 竞态守卫]
    // 的「赋值 → 收口检查 → kick-off 同一同步段」实现约束禁止在检查与 kick-off 间
    // 插入 await，不宣 extract。
    const { isPiRoute, engineModel, identity } = await this.resolveIdentityForRoute(opts, preIdentity, route);
    const recordOpts: ExecuteOptions = this.stampEngineOnRecordOpts(opts, route, engineModel, isPiRoute);
    const record = this.deps.createRecordForMode(identity, recordOpts, mode);
    this.deps.getNotifyHost().emitPendingRegister(record.id, record.agent);

    // ── worktree 创建（仅 worktree===true 或已传入 handle 时）──
    // record 先创建，worktree 失败时可 finalizeFailed（record 已在 store 中）。
    // worktree 必须显式开启：worktree===true 创建新 worktree；worktree===undefined/false 不创建。
    // fork 不隐含 worktree（UC-1 fork 可独立使用，fork 仅继承上下文，在 parent cwd 跑）。
    // 非 pi 引擎带 worktree 已被上方预检同步拒绝（caps.sandbox='none'），此段实际仅
    // sandbox 能力引擎（pi：caps.sandbox='emulated'）可达。
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      // 传入的是已创建的 WorktreeHandle
      worktreeHandle = opts.worktree;
    } else if (opts.worktree === true) {
      // worktree===true（显式要求）——创建新 worktree。与 fork 正交（worktree 文件隔离不依赖 fork 上下文继承）。
      try {
        worktreeHandle = await this.deps.getWorktreeManager().create(this.deps.getCwd(), record.id);
        record.worktreeHandle = worktreeHandle;
        // [S5 修复] 创建即置 hadWorktree（与 executeAndAwait 步骤 2.5 同款）：归档清句
        //（markArchived）后 worktree 投影与 Continuation 重建守卫靠本标志承载。
        record.hadWorktree = true;
        // [create-await 竞态守卫] create 的 await 窗口内 cancel/dispose 可把 record
        // settle 成已收口态（[U5 判据] status 离 running 即已收口——cancel/dispose
        // 抢先 settle 时读到的 worktreeHandle 可能仍是 undefined（收起回收被跳过）。
        // 赋值后同同步段检查：已收口则主动 cleanup（幂等，抢先的 fire-and-forget
        // 清理无害）+ early-failed 返回，不进轮次 kick-off（避免子进程白跑）。
        // 实现约束：赋值 → 收口检查 → kick-off 必须在同一同步段，中间禁止插入 await。
        if (record.status !== "running") {
          await this.deps.getWorktreeManager().cleanup(worktreeHandle);
          return this.deps.buildEarlyFailedHandle(record);
        }
      } catch (err) {
        // create 失败→不进入 run，finalizeFailed 统一收尾（含 emitPendingUnregister failed）
        const _result = await this.deps.finalizeFailed(record, err);
        return this.deps.buildEarlyFailedHandle(record);
      }
    }

    this.kickOffBackgroundDispatch(record, recordOpts, identity, engine, isPiRoute, worktreeHandle);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: project(record) };
  }

  /**
   * [metrics-gate cyclo 偿还·第二轮 / 行为保持] executeViaEngine 的 identity 分支构造
   * 原样提取（判据与解析调用逐字节等价）：
   *   - pi：pi 链三层解析在路由后执行（现状三层解析链行为零变化；含 resolveModel
   *     失败的跨引擎候选提示，D2-4）；
   *   - 非 pi：跳过 pi registry，model 按目标引擎校验（同步期 throw，record 创建前
   *     ——场景 2 错误；ctxModel 不透传，缺省语义归引擎，D2-1③）。
   * [u-h2 D2-1③] 非 pi 的 model 源 = 调用参数 > agent .md frontmatter（作者声明不
   * 忽略）——frontmatter 声明须真正透传给引擎（taskSpec.model 消费 opts.model），
   * 不能只进 record 留痕；无显式 model 时引擎落自身缺省（validateModel(undefined) 裁决）。
   */
  private async resolveIdentityForRoute(
    opts: ExecuteOptions,
    preIdentity: { agent: string; agentConfig: AgentConfig | undefined },
    route: EngineRouteResult,
  ): Promise<{ isPiRoute: boolean; engineModel: string | undefined; identity: ResolvedIdentity }> {
    const isPiRoute = route.engineId === DEFAULT_ENGINE_ID;
    const engineModel = isPiRoute ? undefined : (opts.model ?? preIdentity.agentConfig?.model);
    const identity = isPiRoute
      ? await this.deps.resolveIdentity(opts, preIdentity)
      : this.deps.resolveIdentityForEngine(
        route.engine,
        engineModel,
        preIdentity.agent,
        preIdentity.agentConfig,
        opts,
      );
    return { isPiRoute, engineModel, identity };
  }

  /**
   * [metrics-gate cyclo 偿还·第二轮 / 行为保持] executeViaEngine 的 record 盖章路由
   * 结果提取（D5 字节级守护的执行侧落点；嵌套三元改早返回，判据与产物逐字节等价）：
   *   - pi 纯缺省/显式 pi：不盖 engine 键（pi record entry 序列化产物不得新增 engine
   *     键，undefined 经 JSON 省略）——与旧 pi 主路径 piOpts 剥离语义逐字节一致；
   *   - pi 兜底：engine='pi' + engineFallback 留痕（engine = 实际执行引擎，from=请求
   *     引擎留痕）；
   *   - 非 pi：engine=route.engineId 显式留痕（+engineFallback 如有）+ model 覆写
   *     （frontmatter 声明透传，u-h2 D2-1③）。
   */
  private stampEngineOnRecordOpts(
    opts: ExecuteOptions,
    route: EngineRouteResult,
    engineModel: string | undefined,
    isPiRoute: boolean,
  ): ExecuteOptions {
    if (!isPiRoute) {
      return {
        ...opts,
        ...(engineModel !== undefined ? { model: engineModel } : {}),
        engine: route.engineId,
        ...(route.engineFallback !== undefined ? { engineFallback: route.engineFallback } : {}),
      };
    }
    if (route.engineFallback !== undefined) {
      return { ...opts, engine: DEFAULT_ENGINE_ID, engineFallback: route.engineFallback };
    }
    return opts.engine === undefined ? opts : { ...opts, engine: undefined };
  }

  /**
   * [metrics-gate cyclo 偿还·第二轮 / 行为保持] executeViaEngine 的尾部分流提取
   * （同步调用面，零时序变化）——四象限（isPiRoute × chatMode）归并为 chatMode 优先
   * 两段判（分支映射逐字节等价）：
   *   - chatMode（pi 与非 pi 同形）：首轮经 ConversationContinuation（[H1 U2] §3.5
   *     终态数据流：轮末分流 chatMode → Continuation onRunSettled；one-shot →
   *     settleOneShotOutcome 照旧）；首轮 task = dispatchRound([task])（无 resume
   *     ——新 session，锚点由 run 应答回填）。[2026-09-13 design-code-sync]
   *     continuationFor/startFirstRound 本体已迁 ChatRounds——派发经 deps 回调；
   *     [U6b / B-firstround] 非 pi chatMode（zcode conversation:'cold'）首轮同经
   *     Continuation 编排对齐 pi 分支形态——若走 kickOffEngineRun 的 one-shot 编排
   *     （finalizeEngineOutcome tryTransition 终态化），chatMode record 首轮 settle
   *     即终态化，续聊链从第一轮就断；
   *   - pi one-shot：one-shot background 派发主干（kickOffChatRound 共享部分，D6
   *     保留泛化；[2026-09-13 design-code-sync] 本体已迁 ChatRounds——派发经 deps 回调）；
   *   - 非 pi one-shot：engine.run 自足执行（handle+outcome），编排侧 journal 接线
   *     + 终态迁移（kickOffEngineRun）。
   */
  private kickOffBackgroundDispatch(
    record: ExecutionRecord,
    recordOpts: ExecuteOptions,
    identity: ResolvedIdentity,
    engine: EnginePort,
    isPiRoute: boolean,
    worktreeHandle: WorktreeHandle | undefined,
  ): void {
    if (record.chatMode) {
      this.deps.startFirstChatRound(record, recordOpts.task);
      return;
    }
    if (isPiRoute) {
      this.deps.kickOffChatRound(
        record,
        { ...recordOpts, worktree: worktreeHandle },
        identity,
        record.controller!.signal,
        PRIORITY_BACKGROUND,
      );
      return;
    }
    this.kickOffEngineRun(record, recordOpts, engine);
  }

  /**
   * 非 pi 引擎的 detached 执行编排（与 pi 轮次 kick-off 同构的 background 语义）：
   * pool 并发槽（maxConcurrent 对非 pi 引擎同样生效）→ journal 接线（D6 第②级：
   * taskId=record.id，固定分组 key 'shared'）→ engine.run（signal 接 record controller，
   * kill-chain 两级生效）→ engineHandle 回填（终态迁移落 entry 前）→ 终态迁移 →
   * bg notify（chat 域宿主职责，与 pi 完成通知同语义）。
   */
  kickOffEngineRun(record: ExecutionRecord, opts: ExecuteOptions, engine: EnginePort): void {
    const signal = record.controller?.signal;
    // [W4] 在途记账（监督器「该等」判据源）：run 发起即记账，finally 收口重评估。
    this.deps.getRoundSupervisor().noteRunStarted(record.id);
    void (async () => {
      try {
        await this.deps.getPool().acquire(PRIORITY_BACKGROUND, this.effectiveMaxConcurrentFor(record), signal);
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致（runAndFinalize 同款）
        if (signal?.aborted) {
          await this.deps.finalizeAborted(record);
        } else {
          await this.deps.finalizeFailed(record, new Error("aborted"));
        }
        return;
      }
      // [review MF1] acquire 成功后必须 finally release：不 release 则
      // DefaultConcurrencyPool._active 永不递减——每次引擎任务泄漏一个并发槽，累计
      // maxConcurrent 次后全部 background subagent（pi 与引擎共用同一池）在 acquire 队列永久挂起
      try {
        // [W4] adopted = 走了表 3 行 1 接管分支（record 保持 resumable 交监督器）——
        // 跳过 bg 完成回注（合并单条通知由监督器 sendMergedFailureNotice 承担，
        // route 会再发一条 toNotifyRecord 投影通知 = 双通知，正是 R3 要消除的时序窗口）。
        const adopted = await this.runEngineTask(record, opts, engine, signal);
        // cancel 抢先（closedReason='cancelled'）时 cancelBackground 自己 notify，跳过
        if (!adopted && record.closedReason !== "cancelled") {
          this.deps.getCollectCoordinator().route(record);
        }
      } finally {
        this.deps.getPool().release();
        this.deps.getRoundSupervisor().noteRunEnded(record.id);
      }
    })();
  }

  /**
   * kickOffEngineRun 的 acquire 后主体：journal 接线（D6 第②级：taskId=record.id，
   * 固定分组 key 'shared'——[池抽象降级 2026-09-13] 无 retarget，路径构造即终值）
   * → engine.run（signal 接 record controller，kill-chain 两级生效）→ engineHandle
   * 回填（终态迁移落 entry 前）→ 终态迁移。bg notify 归编排侧（与 pi 轮次收尾通知归编排对称）。
   */
  async runEngineTask(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    engine: EnginePort,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    // [D3-③ journal 接线合一] writer + 路径权威收敛 common/journal-wiring
    //（与 SAR 同一实现）。chat 域无下游 onEvent 消费者——journal 是事件唯一出口，
    // 不传 forwardEvents。
    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id });
    // [R4 §3.4 不变量 3] 运行中句柄回填：create 应答后（远早于 run resolve）回填
    // record.engineHandle 并经 reportRecordTransition 落 entry——运行中的 GUI 经 entry
    // 重建 record 即拿到 ①②级读取钥匙（sessionRef/dbPath/journalPath），
    // 不再等终态回填（详情页中途打开可见当时进度快照）。journalPath 由 journal writer
    // 定稿（[池抽象降级] 无 retarget，路径构造即终值）。
    // 仅 chat 域接线——workflow 域 SAR 无运行中 record 读取方，刻意不做同类回填（防误扩展）。
    // [F1 修复] 幂等语义 = 按字段补缺，不是整条丢弃：已有值一律不被迟到值覆盖，缺失
    // 字段照常补上。「sessionId 先落、迟到 handleReady 只补 sessionFile」是本 replay
    // 批次新打通且更有价值的形态（close 期 LC-4 后缀反查会在 sessionId 已知后补发
    // sessionFile）——旧守卫「有 sessionId 即整条 return」会把该
    // 回填永久吞掉，令冷续 resume 锚点（anchor.sessionRef.sessionFile）与引擎 interact
    // 定位拿不到 sessionFile（[H1 U6] chatHandleFor 已随 interact 面退役）。journalPath 不参与补缺：
    // journalPath 权威归 journal writer（本闭包写入即定稿），迟到值不得重置。仅在确有
    // 字段落位时才落 entry——无新字段不写噪（迟到重复回调即零副作用，GUI 无额外投影）。
    // [池抽象降级] record.engineHandle.poolKey 恒 SHARED_POOL_KEY——持久化形状保留字段
    //（record-store 读侧守卫要求非空），协议面 poolKey 已删，无引擎侧实际值。
    const backfillEngineHandle = (partial: { sessionRef: Record<string, string> }): void => {
      const current = record.engineHandle;
      if (current === undefined) {
        record.engineHandle = {
          sessionRef: { ...partial.sessionRef },
          poolKey: SHARED_POOL_KEY,
          journalPath: journal.path,
        };
        this.deps.getStore().reportRecordTransition(record);
        return;
      }
      const merged: Record<string, string> = { ...current.sessionRef };
      let filled = false;
      for (const [key, value] of Object.entries(partial.sessionRef)) {
        if (value === undefined || value === "") continue; // 空值不是可落位的字段值
        const existing = merged[key];
        if (existing === undefined || existing === "") {
          merged[key] = value;
          filled = true;
        }
      }
      if (!filled) return;
      record.engineHandle = { ...current, sessionRef: merged };
      this.deps.getStore().reportRecordTransition(record);
    };
    // [H2 Gate B 修复] live reducer 喂入恢复（runWorkflowEngineTask observedEvent 同款）：
    // 非 pi 引擎派发此前 onEvent 直连 journal.onEvent——事件只落 ②级 journal，live record
    // 零喂入（turns/totalTokens 恒 0，chat 域 record 与 tool one-shot 经非 pi 引擎同病）。
    // 此处恢复 updateFromEvent 喂入：reducer 与 journal-replay / session-view-service
    // 重放路径同源（C5 守护），live ≡ replay 构造性成立。喂入窗口 = run await 窗口，
    // 终态后残余事件仅写内存 record 不落盘——与 workflow 域修法同一取舍。不接
    // refreshFromProtocolEvent：非 pi 派发无轮次 no-progress 守护（arm 点在轮次域），
    // 恒 no-op 不加。
    const journalOnEvent = journal.onEvent;
    const observedEvent = (event: AgentEvent): void => {
      updateFromEvent(record, event);
      journalOnEvent(event);
    };
    const runCtx: RunContext = {
      taskId: record.id,
      signal,
      ctxModel: opts.ctxModel,
      onEvent: observedEvent,
      // [R4 §3.4 不变量 3] 运行中句柄回填通道（engine/port.ts RunContext.onHandleReady）
      onHandleReady: backfillEngineHandle,
      // D9①：路由层 fallback 留痕投影进 outcome（zcode 无独立 record 通路）
      ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
      // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）
      ...(this.sessionRootId !== null && this.sessionRootId !== ""
        ? { sessionRootId: this.sessionRootId }
        : {}),
      // D10 终止链：engine spawn 的子进程注册进 spawnedChildren 记账
      //（cancelBackground SIGTERM / dispose killAll 收割对非 pi record 生效）
      onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
    };
    try {
      const { handle, outcome } = await engine.run(executeOptionsToEngineTaskSpec(opts), runCtx);
      // engineHandle 终态回填（U2：终态迁移落 entry 前；R4 起为兜底面——运行中回填
      // 已由 onHandleReady 提前落 entry，此处覆写终态权威值）。sessionRef 整体透传——
      // 失败终态 sessionId 缺失时也回填已有部分（dbPath），读侧①级降②级的防御形态；
      // journalPath 取实际落盘路径（writer 是路径权威）；poolKey 恒 SHARED_POOL_KEY
      //（持久化形状保留字段，[池抽象降级] 后无引擎侧实际值）。
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: SHARED_POOL_KEY,
        journalPath: journal.path,
      };
      await journal.close();
      return await this.finalizeEngineOutcome(record, outcome);
    } catch (err) {
      // engine.run prepare 期 reject（进程创建前）→ failed 终态（与 runAndFinalize catch 同语义）；
      // journal 尽力而为收口（②级数据源写失败已由 writer 内部 warn 收敛）
      await journal.close();
      // [W4 表 3 行 1] 引擎进程死亡（engine_crashed——run 帧已受理后进程死亡/stdin
      // 写失败）且宿主存活 → record 保持 resumable 交监督器接管（禁 completed 谎报、
      // 禁直接 closed 终局——resume 锚点在盘，逻辑任务可续）。prepare 期失败
      // （handshake/protocol/model 拒——进程创建前）维持现状 closed（确定性失败，
      // 保持 resumable 无意义）。
      // [H2 W2 / adopt 豁免点一] workflow origin 豁免 adopt 链：引擎死亡即 run 失败
      // 即 record 终态化（失败路径表），adopt 链「唤醒→guidance→2h 看门狗→giveUp」
      // 对无脚本可回的 record 全程无意义——豁免落空即落入下方 finalizeFailed 立即
      // 终态化（防「无监督、永不终态化、pending 永不注销」的 resumable 僵尸）。
      if (
        err instanceof EngineSdkError &&
        err.code === "engine_crashed" &&
        record.chatMode !== true &&
        record.origin !== "workflow" &&
        record.status === "running"
      ) {
        this.adoptResumableAfterEngineDeath(record, toErrorMessage(err));
        return true;
      }
      await this.deps.finalizeFailed(record, err);
      return false;
    }
  }

  /**
   * [W4 表 3 行 1] 引擎/子进程死亡、宿主存活的 record 处置：run 终态如实记 failed
   * 证据（record.error），record **保持 resumable**（session 文件在盘，逻辑任务可续
   * ——冷路径 resume 可直接续写），交监督器接管（合并单条通知 + 三态判定）。禁止
   * 两个事故方向：completed 谎报（G3）与 closed 直接终局（resume 可能性丢失，等待
   * 无主——2026-09-08 事故环 2/3 的 core 侧形态）。
   *
   * 判据状态源钉死 record 级：写点只动 record 字段（resumable/result/error），
   * 不清镜像不查引擎——引擎进程被动重建（ensureConnected 退避重填镜像）不翻转
   * 本处置（纳管模型：死亡事件纳管、重建不解管）。
   *
   * [U2b 修复轮/D2] 三写簿记（error/result/resumable + 迁移上报）归口
   * store.adoptEngineDeath（U1 原语簿记为直接三写的超集，多出 notifyChange 刷新）；
   * 监督器编排（adoptOnProcessDeath）留调用方。record 不在 store 内存的形态 =
   * false 旁路 debug 留痕（两调用点的 record 均为创建即注册的在册对象）。
   */
  adoptResumableAfterEngineDeath(record: ExecutionRecord, errMsg: string): void {
    this.deps.getStore().adoptEngineDeath(record.id, { error: errMsg });
    this.deps.getRoundSupervisor().adoptOnProcessDeath(record, errMsg);
  }

  /**
   * engine.run resolve 的终态迁移：outcome.error → failed（success=false + error 文案）；
   * 否则 done（result=content）。CAS 抢锁（tryTransition）防与 cancelBackground 双收尾。
   *
   * [W4 表 3 行 1] 进程死亡分诊：outcome.error 存在且 **exitCode === null**（引擎侧
   * 进程被信号终止/崩溃的合成 outcome 形态——RemoteEngine 运行中失败合成分支恒
   * exitCode:null，引擎如实上报的 turn 失败带数值 exitCode；engine-client 注释同源
   * 「exitCode null = 被信号杀死，杀链判据」）且宿主存活且非 conversation 形态 →
   * record 保持 resumable 交监督器接管（如实 failed 证据 + 合并通知 + 三态判定），
   * 不再 closed 终局。返回 true = 走了接管分支（调用方跳过 bg 完成回注）。
   */
  async finalizeEngineOutcome(record: ExecutionRecord, outcome: AgentOutcome): Promise<boolean> {
    if (outcome.sessionFile !== undefined) {
      record.sessionFile = outcome.sessionFile;
      // [D3a 时机①] 统一入口 writeBindingForRecord 内 acquire 写权声明（U2b）。
      this.writeBindingForRecord(record);
    }
    if (
      outcome.error !== undefined &&
      outcome.exitCode === null &&
      record.chatMode !== true &&
      // [H2 W2 / adopt 豁免点二] workflow origin 豁免（同 runEngineTask catch 分诊点一
      //——豁免落空走下方 tryTransition+finalizeRecord 立即终态化，不交监督器）。
      record.origin !== "workflow" &&
      record.status === "running"
    ) {
      this.adoptResumableAfterEngineDeath(record, outcome.error);
      return true;
    }
    const result = this.outcomeToAgentResult(record, outcome);
    if (tryTransition(record, "closed", "gc")) {
      await this.deps.finalizeRecord(record, result, "closed", "gc");
    }
    return false;
  }

  /**
   * workflow 域"干活 + 收尾"（sync await；[W3] 执行叶 = 协议 engine.run——原 inproc
   * runSpawn 链随 inproc pi 引擎目录 删除消亡，journal 接线 / record 终态迁移语义保持）。
   * 编排分段保持「装配（池槽/worktree）→ 执行 → 回收（finally）→ 错误收口 → 终态收口」。
   */
  async runAndFinalize(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<AgentResult> {
    const pooled = record.mode === "background";
    let acquired = false;
    if (pooled) {
      const acquireFailure = await this.acquirePoolOrFinalize(record, signal, priority);
      if (acquireFailure !== undefined) return acquireFailure;
      acquired = true;
    }

    // worktree 句柄经 executeOptionsToEngineTaskSpec(opts).worktree 直传引擎
    //（AgentCallOpts.worktree 接受 WorktreeHandle——原 runSpawn 显式传参的协议形态）。
    const engine = this.resolveChatEnginePort();
    // journal 接线（D6 第②级，与 kickOffEngineRun 同一实现）：forwardEvents = onEvent
    //（workflow liveRecord 桥接，D-A8）。
    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id, forwardEvents: onEvent });

    let result: AgentResult;
    try {
      const runCtx: RunContext = {
        taskId: record.id,
        signal,
        ctxModel: identity.resolved.model,
        onEvent: journal.onEvent,
        ...(stream !== undefined ? { stream } : {}),
        ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
        // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）
        ...(this.sessionRootId !== null && this.sessionRootId !== ""
          ? { sessionRootId: this.sessionRootId }
          : {}),
        // D10 终止链：引擎 spawn 的子进程注册进 spawnedChildren 镜像记账
        onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
      };
      const { handle, outcome } = await engine.run(this.taskSpecWithModel(opts, record.model), runCtx);
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: SHARED_POOL_KEY,
        journalPath: journal.path,
      };
      await journal.close();
      result = this.outcomeToAgentResult(record, outcome);
    } catch (err) {
      await journal.close();
      // engine.run prepare 期 reject（进程创建前）→ 合成 failed result + 收尾。
      // swallow（不 re-throw）：sync 调用方拿到合成 failed result，避免异常逃逸到
      // tool 层 + record 卡 running。（[H1 U6] 旧 chatMode 分支 finalizeChatSpawnFailure
      // 已随 resumeColdRound/旧 chat 载体退役——chatMode 轮不经 runAndFinalize，
      // Continuation 轮收口归 onRoundRejected/onRunSettled。）
      return this.deps.finalizeFailed(record, err);
    } finally {
      this.releaseRoundResources(record, pooled && acquired, stream);
    }

    // v4 B-1: status 恒为 closed。cancelled 折入 closed（closedReason='cancelled'）。
    await this.settleOneShotOutcome(record, result, signal?.aborted === true);
    return result;
  }

  /** engine.run taskSpec 装配单一来源（runAndFinalize 与 kickOffChatRound 共用）：
   *  executeOptions 协议映射 + model = record 留痕词形（resolved 解析产物，
   *  joinEngineModelRef 规范形）覆盖——原 identity.resolved 经 runSpawn --model
   *  兜底的协议等价承载。 */
  taskSpecWithModel(opts: ExecuteOptions, model: string | undefined): AgentCallOpts {
    return { ...executeOptionsToEngineTaskSpec(opts), ...(model !== undefined ? { model } : {}) };
  }

  /**
   * one-shot（非 chatMode）轮终收口（[U5 / §3.2.2 事件表 settle 行] 终态化退役）：
   * 成功/失败轮 settle（markRoundIdle——保持 running-resumable 等续聊/升级，万物可续
   * G1）；被 abort 的轮走 cancel 语义（interrupted + 放弃轮标记）。CAS 前置检查失败
   *（cancel/dispose 抢先 settle）静默跳过。runAndFinalize（workflow 域）与
   * kickOffChatRound 非 chatMode 分支共用。closeAfterRound 挂起标志不清——归档消费
   * 在主干尾部 route 之后（顺序约束 [写死]：收口轮 settle → 轮次通知送达 → 归档，
   * 见 kickOffChatRound 尾部 consumePendingArchive）。
   */
  async settleOneShotOutcome(
    record: ExecutionRecord,
    result: AgentResult,
    aborted: boolean,
  ): Promise<void> {
    // [H2 W2 / D7 例外族维持现状（§1.4 out-of-scope）] workflow origin 成功 = 立即
    // 终态化（closed/"gc"）；aborted/失败 = closed+cancelled/gc——workflow agent 结果
    // 由脚本返回值承载、无 message 对端，留内存 idle 会绑架 hasRunning / 恒挂
    // idle-gc / 被误升级为对话容器 / goal defer 恒挂（设计 D7 四面连带）。自带 CAS
    // 抢锁（承接现状「cancel/dispose 抢先 → 静默跳过」守卫语义）。
    if (record.origin === "workflow") {
      if (!aborted && result.success) {
        if (tryTransition(record, "closed", "gc")) {
          await this.deps.finalizeRecord(record, result, "closed", "gc");
        }
      } else {
        if (tryTransition(record, "closed", aborted ? "cancelled" : "gc")) {
          await this.deps.finalizeRecord(record, result, "closed", aborted ? "cancelled" : "gc");
        }
      }
      return;
    }
    // CAS 前置 + 簿记之间无 await（单线程同步段原子——cancel/dispose 抢先判定可靠）。
    if (record.status !== "running") return;
    if (aborted) {
      // [U5] cancel 语义（abort 到达本收口 = cancel/dispose 未及处理的竞态补位）：
      // settle interrupted + 放弃轮标记（与 cancelBackground 同构——经 store.markSettled
      // CAS，竞态抢先时静默跳过）。closeAfterRound 挂起作废（用户已 cancel）。
      record.closeAfterRound = undefined;
      record.lastAbandonedRound = { epoch: record.epoch ?? 0, round: record.round ?? 0 };
      this.deps.getStore().markSettled(record, "interrupted");
      return;
    }
    if (result.success) {
      // [SP-5] one-shot 成功完成 → 保持 running-resumable，等待 message 触发 upgrade。
      // [U2b] 轮终簿记①-⑪归口 store.markRoundIdle（`.alive` 跨轮保留；[W4 发射点②]
      // pending 注销已随 store 簿记⑧统一发射；⑩⑪ A-lite stopReason 展示位 +
      // `.state` 收条/binding 快照——正常轮终后宿主崩溃 revive 水合不归零）。
      this.deps.getStore().markRoundIdle(record.id, { kind: "success", content: result.text });
    } else {
      // [U5] 失败轮 settle（不终态化——旧一次性销毁退役，失败轮同样可续聊）。
      this.deps.getStore().markRoundIdle(record.id, { kind: "failed", reason: result.error ?? "round failed" });
    }
  }

  /** AgentOutcome → execution AgentResult 单一映射源（workflow run 域映射；
   *  finalizeEngineOutcome 终态 result 复用此处构造——exitCode null = 被信号杀死的
   *  合成终态，error 如实透传）。 */
  outcomeToAgentResult(record: ExecutionRecord, outcome: AgentOutcome): AgentResult {
    if (outcome.sessionFile !== undefined) {
      record.sessionFile = outcome.sessionFile;
      // [D3a 时机①] 统一入口 writeBindingForRecord 内 acquire 写权声明（U2b）。
      this.writeBindingForRecord(record);
    }
    return {
      text: outcome.content,
      turns: outcome.usage?.turns ?? 0,
      durationMs: outcome.durationMs ?? Date.now() - record.startedAt,
      success: outcome.error === undefined,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      sessionId: outcome.sessionId ?? record.id,
      toolCalls: [],
      ...(outcome.parsedOutput !== undefined ? { parsedOutput: outcome.parsedOutput } : {}),
    };
  }


  /** [W3] pi 引擎 port 解析（execute 路由 / runAndFinalize 派发 / ChatRounds 协作回调
   *  三面共用——chat 域经壳装配闭包消费）：registry cli 形态 port，
   *  未注册 = 不可用 stub（engine_not_found，见 pi-host-binding）。 */
  resolveChatEnginePort(): EnginePort {
    return resolveHostPiEnginePort(() => null);
  }

  /**
   * 分层并发配额：depth 越深可用配额越少（下限 1）。fork 深度护栏在池维度的投影，
   * 公式约定以 concurrency-pool.ts 注释为登记处、此处为唯一代码锚点。
   */
  effectiveMaxConcurrentFor(record: ExecutionRecord): number {
    return Math.max(1, this.deps.getPool().maxConcurrent - record.depth);
  }

  /** [U04 提取·装配] 池槽获取：pooled（background）record 排队 acquire。成功返回 undefined
   *  继续执行；失败返回终态 result 供调用方 early-return（该路径在 try/finally 之前，
   *  不触发轮次资源回收——与原控制流逐字节一致）。 */
  async acquirePoolOrFinalize(
    record: ExecutionRecord,
    signal: AbortSignal | undefined,
    priority: number,
  ): Promise<AgentResult | undefined> {
    try {
      await this.deps.getPool().acquire(priority, this.effectiveMaxConcurrentFor(record), signal);
    } catch {
      // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
      if (signal?.aborted) return this.deps.finalizeAborted(record);
      return this.deps.finalizeFailed(record, new Error("aborted"));
    }
    return undefined;
  }


  /** [U04 提取·回收] 轮次资源回收（finally 语义，幂等）：池槽归还（仅 pooled 且 acquire
   *  成功）、streaming widget 清除。 */
  releaseRoundResources(
    _record: ExecutionRecord,
    holdSlot: boolean,
    stream: SubagentStream | undefined,
  ): void {
    if (holdSlot) this.deps.getPool().release();
    // 清除 streaming widget（subagent 终态，幂等）
    stream?.dispose();
  }

  /**
   * [T4② / PS-4] idleTimeoutMs 合法域入口校验（>2^31-1 / 非有限值 fail-fast）。
   *
   * 旧链路：非法值穿透到 agent_settled 回调里的 armIdleTimer → assertSafeTimerDelay
   * throw 被异步 catch 降级——配置错误被吞成静默语义变更（每轮完成通知被 isIdle 放行门
   * 吞 + 进程无回收 timer）。对齐 shared/timer-delay「不静默 clamp」既有裁决：配置错误
   * 显式暴露，错误消息含合法范围（0/负数 = 显式禁用是合法语义，不在本校验域；env 非法值
   * 由 lifecycle-manager 的 warn 回落承接）。execute/executeAndAwait 两入口共用。
   */
  assertIdleTimeoutMsSafe(opts: ExecuteOptions): void {
    const v = opts.idleTimeoutMs;
    if (v === undefined) return;
    if (!Number.isFinite(v)) {
      throw new Error(
        `subagent idleTimeoutMs = ${v} is not a finite number (NaN/±Infinity). ` +
          `Valid range: a positive millisecond number up to ${MAX_TIMER_DELAY_MS} (2^31-1, Node setTimeout limit), or 0/negative to disable idle GC. ` +
          "Recovery: fix the idleTimeoutMs value and retry.",
      );
    }
    if (v > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `subagent idleTimeoutMs = ${v} exceeds the Node setTimeout limit ` +
          `(${MAX_TIMER_DELAY_MS} ms = 2^31-1); larger delays silently collapse to 1ms and would kill the subagent immediately. ` +
          `Recovery: pass idleTimeoutMs <= ${MAX_TIMER_DELAY_MS}, or omit it for the default (${DEFAULT_IDLE_TIMEOUT_MS}ms), or use 0/negative to disable idle GC.`,
      );
    }
  }
}


