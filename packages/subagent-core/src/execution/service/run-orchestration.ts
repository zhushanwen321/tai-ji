// [H3/R4] RunOrchestration 聚合（域 #6/#7/#12/#14/#15：model 解析 + run 域执行入口 +
// await 入口 + 引擎编排（含 Continuation 协作面）+ pool/worktree 资源）——自
// SubagentService 上帝类 strangler 抽取的核心编排聚合（设计
// docs/design/subagent-service-decomposition.md §2.1 / §3.3 D2 抽取序末位；成员归属以
// r0-inventory.md 清单① + 域分区为准）。
//
// [G1 超限预授权拆分 / 偏差 D-R4-1] 主 agent 派发预授权：R4 域段体量大（派发估算
// 1200+ 物理行），按内聚边界拆两个文件——本文件（核心编排）+ workflow-dispatch.ts
//（workflow 族独立）。**实测与派发估算不符**：R0 重排后域段实测 1662 物理行 > 两文件
// 容量上限（2×700），本文件物理超限不可避免（偏差登记待主 agent 追认；备选 = 第三
// 文件再拆 Continuation 协作面，但拆三后仍余 ~850 物理段）。两文件零互调零 import
//（G2 / R1 打样模式 3）：workflow-dispatch 的跨文件协作（acquirePoolOrFinalize /
// settleOneShotOutcome / outcomeToAgentResult / releaseRoundResources /
// resolveChatEnginePort / assertIdleTimeoutMsSafe）经壳 deps 回调指回本聚合实例方法。
//
// 单一职责：run 域执行编排——execute/executeAndAwait 入口（路由 → identity → record
// 创建 → worktree → detached 引擎 run）、引擎死亡分诊（adopt）、终态收口
//（settleOneShotOutcome 含 D7 workflow origin 分支）、Continuation 协作面
//（continuations 队列 + chat 轮次主干 kickOffChatRound + 投递/升级 gate）、
// pool/worktree 资源装配与回收。
//
// [R1 打样模式——R4 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）——pi/会话基线运行时可变态
//   （execNesting/sessionRootId/streamSink/uiObservability）经壳 getter 现读；
//   #1 留壳共享依赖（store/manifestStore/modelService/notifyHost/pool/worktreeManager/
//   collectCoordinator）getter 现读同一实例——深绑测试的 FR 替换语义保持。
// 2. 转发壳写法：壳保留同名方法单行转发（execute/executeAndAwait/resolveModel/
//   canUpgradeToConversation/deliverChatMessage 对外面 + executeWorkflowAgent →
//   WorkflowDispatch）；聚合内部互调（executeViaEngine/kickOffEngineRun/runEngineTask/
//   settleOneShotOutcome 族/kickOffChatRound 等）不经壳。
// 3. 跨聚合边收敛（r0-inventory 清单① C-4/C-5 + B-6）：
//   - C-4（壳 dispose 直调 continuations.clear）：字段所有权随域迁入本聚合，壳经
//     clearContinuations() 显式接口（R4 兑现）。
//   - C-5（onRecordFinalizedCleanup 跨域汇聚点 + abortContinuationQueue 队列清空）：
//     本体迁入本聚合；RecordLifecycle deps 回调（R3 装配时指壳方法）改指本聚合
//     显式接口（R4 兑现）。
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
//   killStaleChildBeforeDispatch）留聚合本文件（单一消费主体）。

import { getLogger } from "../../core/logger.ts";
import { toErrorMessage } from "../../core/error-message.ts";
import { MAX_TIMER_DELAY_MS } from "../../shared/timer-delay.ts";

import type { AgentResult as WorkflowAgentResult, AgentCallOpts } from "../../orchestration/models/types.ts";
import { mapToWorkflowAgentResult } from "../agent-result-mapper.ts";
import { bestEffort } from "../best-effort.ts";
import type { CollectCoordinator } from "../collect-coordinator.ts";
import type { ConcurrencyPool } from "../concurrency-pool.ts";
import {
  ConversationContinuation,
  type ContinuationDispatchInput,
  type ContinuationRoundHandlers,
} from "../conversation-continuation.ts";
import { project, tryTransition, updateFromEvent } from "../execution-record.ts";
import { doFinalizeRoundToIdle, type RoundSettlementOutcome } from "../finalize-record.ts";
import { assertTaskShapeSupported } from "../engine/common/capability-gate.ts";
import { JOURNAL_INITIAL_POOL_KEY, wireEventJournal } from "../engine/common/journal-wiring.ts";
import type { ExecutionNestingContext } from "../engine/common/nesting-guard.ts";
import { PI_POOL_KEY, resolveHostPiEnginePort } from "../engine/host/pi-host-binding.ts";
import {
  killRecordChildWithEscalation,
  registerSpawnedChildForRecord,
} from "../engine/host/spawned-children.ts";
import type { EnginePort, RunContext } from "../engine/port.ts";
import { splitEngineModelRef } from "../engine/model-validation.ts";
import { executeOptionsToEngineTaskSpec } from "../engine/host-task-spec.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "../engine/registry.ts";
import { type EngineRouteResult, routeEngineForHost } from "../engine/routing.ts";
import type { AgentOutcome } from "../engine/types.ts";
import { hasLiveProcessHandle } from "../lifecycle-predicates.ts";
// [V2 决策 3] lifecycle-manager：[T4②] DEFAULT_IDLE_TIMEOUT_MS 是 assertIdleTimeoutMsSafe
// 错误文案的缺省时长基准（[R4] 唯一消费主体随域迁入本聚合）。
import { DEFAULT_IDLE_TIMEOUT_MS } from "../lifecycle-manager.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "../model-resolver.ts";
import type { NotifyHost, PiLike } from "../notify-host.ts";
// [H1 U2] notify 门（notifier.ts）——one-shot 轮末回注双闸消费。
import { notifyGateAllowsDelivery } from "../notifier.ts";
import type { RecordStore } from "../record-store.ts";
// [R3] ResolvedIdentity 接口本体在 record-access.ts（生产者 resolveIdentity 所属聚合），
// 本聚合单向 type import（D-R3-2 同款非环形态）。
import type { ResolvedIdentity } from "./record-access.ts";
import type { RoundSupervisor } from "../round-supervisor/index.ts";
import {
  armMidRoundNoProgress,
  disarmRoundFromProtocol,
  refreshFromProtocolEvent,
  type SettledWatchdogFireInfo,
} from "../settled-watchdog.ts";
import { MAX_FORK_DEPTH } from "../session-context-resolver.ts";
import { createBackgroundStream, type StreamSink, type SubagentStream } from "../stream-sink.ts";
import { writeRecordBinding } from "../state-marker.ts";
import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";
import type { ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";
import type { UiRequestObservability } from "../ui-request-observability.ts";
import type { WorktreeManager } from "../worktree-manager.ts";
import type {
  AgentEvent,
  AgentResult,
  ClosedReason,
  WorktreeHandle,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionRecord,
} from "../types.ts";
import { DEFAULT_AGENT_NAME, ForkDepthExceededError } from "../types.ts";
// [R6/D-R4-4] 跨两聚合消费的值语义纯量归一常量叶子文件（聚合→支撑文件方向合法）。
import { PRIORITY_BACKGROUND, MS_PER_SECOND, SECONDS_PER_MINUTE } from "./service-constants.ts";

const logger = getLogger("subagents");

/**
 * [H1 U2 / 红线②] stale-child 兜底的退出等待窗（ms）：镜像在途子进程活项时，协议
 * cancel（引擎侧 SIGTERM → pi trap flush → 退出）的有界收敛窗。pi 对裸 SIGTERM 做
 * graceful shutdown（窗口几十~几百 ms，见 disposedUiRequestStub 注释实测口径），
 * 300ms 覆盖常见退出路径；残余双写窗与宿主重启窗口同属红线③经验性登记（量级 =
 * 引擎存活期状态错配频次 × 窗内未退出概率，罕见）。
 * [R4] 随唯一消费主体（killStaleChildBeforeDispatch）自壳文件迁入。 */
const STALE_CHILD_EXIT_WAIT_MS = 300;

/** 有界 delay（stale-child 退出窗消费；fire-and-forget 场景不引入 timer 依赖）。
 *  [R4] 随唯一消费主体（killStaleChildBeforeDispatch）自壳文件迁入。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。四类成员：
 * - 断言面（assertReady）：execute/executeAndAwait/deliverChatMessage 入口就绪门
 *  （本体在 SessionBaselines，壳转发）。
 * - #1 留壳共享依赖 getter（getStore/getModelService/getNotifyHost/
 *   getPool/getWorktreeManager/getCwd/getPi/getRoundSupervisor/getCollectCoordinator）：
 *   getter 现读同一实例（B-6 roundSupervisor 留壳、C-6 装配闭包经壳 late-bound）。
 * - 会话基线 getter（getExecNesting/getSessionRootId/getStreamSink/getUiObservability）：
 *   initSession 注入的运行时可变态现读（SessionBaselines 经壳 getter 透传）。
 * - R3 聚合显式接口（resolveIdentity/resolveIdentityForEngine/createRecordForMode/
 *   buildEarlyFailedHandle/finalizeRecord/finalizeFailed/finalizeAborted/closeChatIdle）：
 *   身份解析/record 创建/终态迁移的跨聚合协作（壳装配指 RecordAccess/
 *   RecordLifecycle 实例方法，聚合间零私有互调——G2）。
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
  /** pi 句柄（FinalizeDeps manifest 写失败 appendEntry；initSession 晚绑定）。 */
  readonly getPi: () => PiLike | null;
  /** 根 session id（relay 归属键 SESSION_ID 权威源；runCtx 注入）。 */
  readonly getSessionRootId: () => string | null;
  /** UI streaming sink（createBackgroundStream 的 widget 通道）。 */
  readonly getStreamSink: () => StreamSink | null;
  /** UI observability（stream 通道形态判据 getMode）。 */
  readonly getUiObservability: () => UiRequestObservability;
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
  /** [R3 RecordLifecycle 显式接口] 排队中被 abort 的 cancelled 终态收尾。 */
  readonly finalizeAborted: (record: ExecutionRecord) => Promise<AgentResult>;
  /** [R3 RecordLifecycle 显式接口] 无在跑轮 record 的手动终态化（Continuation
   *  closeNow 回调面）。 */
  readonly closeChatIdle: (record: ExecutionRecord) => Promise<void>;
}

/**
 * 域 #6/#7/#12/#14/#15 聚合：run 域执行编排（R4 自 SubagentService 抽取）。
 *
 * 字段所有权（r0-inventory 清单①）：#31 continuations（Continuation 实例表）——
 * 本聚合唯一写者；壳 dispose 经 clearContinuations() 显式接口触达（C-4 兑现），
 * 字段壳零感知。
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
        if (record.status === "closed") {
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

  // [H1 U6] resumesInFlight（record 级在途 resume 守卫，[review MF1]）随 resumeColdRound
  // 退役删除——Continuation 的 activeRunId 同步占位单飞（dispatchRoundGuarded）构造性
  // 承接防双写者语义。chatRoundRoutes（recordId 键反向通道路由表）随 interact 面退役删除。

  /**
   * [H1 U2] ConversationContinuation 实例表（recordId 键）：chatMode record 的续聊
   * 编排承载（§3.4）。创建点 = chatMode 首轮派发前 / message 到达（SP-5 升级后）；
   * 清理点 = record 终态化路径（onRecordFinalizedCleanup）。跨重启冷查（cold-lookup）
   * 重建会创建新 record 对象——continuationFor 对缓存实例做绑定一致性检查，换新即重建。
   */
  private readonly continuations = new Map<string, ConversationContinuation>();

  // [H1 U6] 旧 chat 域投递/续轮链已整体退役：deliverToRunning 消费链（V2 决策 3）、
  // resumeColdRound（守卫链 + 执行态信号清除 + resume 锚点组装——迁 Continuation
  // dispatchRoundGuarded / dispatchRoundAsync）、onHotPathSettledWatchdogTimeout
  //（热路径 watchdog 载体——迁 Continuation.onWatchdogFire → onRunSettled 失败分支
  // 统一收口，D7）、EPIPE/steer 协议知识（随 interact 面消亡）。

  /**
   * [V2 决策 3 → H1 U2 改写 / U6 定形] chatMode 统一投递入口（message action 的
   * Service 面）——经 ConversationContinuation.onMessage（§3.4 / D4 状态迁移表 /
   * D2 打断语义）：
   *
   *   - running（轮间 idle）→ 新轮派发（新 run + resume 锚点，record.sessionFile 续写）；
   *   - running（有在途轮）→ D2 打断：abort 在途轮 signal + 消息入队，abort 收敛后
   *     drain（打断即杀，宽限语义随长驻消亡放弃）；
   *   - 终态 → guard 分流（closed 硬拒 / 可重连 revive + 非 chatMode 升级格 + D5 gate）。
   *
   * @param record 目标 record（messageHandler 已做归属校验 + 升级 gate）
   * @param text 消息正文
   */
  async deliverChatMessage(record: ExecutionRecord, text: string): Promise<void> {
    this.deps.assertReady();
    this.continuationFor(record).onMessage(text);
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

    // identity 按路由结果分支构造（[u-h2 D2-1] 路由先行）：
    //   - pi：pi 链三层解析在路由后执行（现状三层解析链行为零变化；含 resolveModel
    //     失败的跨引擎候选提示，D2-4）；
    //   - 非 pi：跳过 pi registry，model 按目标引擎校验（同步期 throw，record 创建前
    //     ——场景 2 错误；ctxModel 不透传，缺省语义归引擎，D2-1③）。
    const isPiRoute = route.engineId === DEFAULT_ENGINE_ID;
    // [u-h2 D2-1③] 非 pi 的 model 源 = 调用参数 > agent .md frontmatter（作者声明不
    // 忽略）——frontmatter 声明须真正透传给引擎（taskSpec.model 消费 opts.model），
    // 不能只进 record 留痕；无显式 model 时引擎落自身缺省（validateModel(undefined) 裁决）。
    const engineModel = isPiRoute ? undefined : (opts.model ?? preIdentity.agentConfig?.model);
    const identity = isPiRoute
      ? await this.deps.resolveIdentity(opts, preIdentity)
      : this.deps.resolveIdentityForEngine(engine, engineModel, preIdentity.agent, preIdentity.agentConfig, opts);

    // record 盖章路由结果（D5 字节级守护的执行侧落点）：
    //   - pi 纯缺省/显式 pi：不盖 engine 键（pi record entry 序列化产物不得新增 engine
    //     键，undefined 经 JSON 省略）——与旧 pi 主路径 piOpts 剥离语义逐字节一致；
    //   - pi 兜底：engine='pi' + engineFallback 留痕（engine = 实际执行引擎，from=请求
    //     引擎留痕）；
    //   - 非 pi：engine=route.engineId 显式留痕（+engineFallback 如有）+ model 覆写
    //     （frontmatter 声明透传，u-h2 D2-1③）。
    const recordOpts: ExecuteOptions = isPiRoute
      ? route.engineFallback !== undefined
        ? { ...opts, engine: DEFAULT_ENGINE_ID, engineFallback: route.engineFallback }
        : opts.engine === undefined
          ? opts
          : { ...opts, engine: undefined }
      : {
        ...opts,
        ...(engineModel !== undefined ? { model: engineModel } : {}),
        engine: route.engineId,
        ...(route.engineFallback !== undefined ? { engineFallback: route.engineFallback } : {}),
      };
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
        // [create-await 竞态守卫] create 的 await 窗口内 cancel/dispose 可 CAS 把 record
        // 转成 closed 终态——cancelBackground 当时读到的 worktreeHandle 可能仍是 undefined
        // （cleanup 被跳过）。赋值后同同步段检查终态：closed 则主动 cleanup（幂等，抢先的
        // fire-and-forget 清理无害）+ early-failed 返回，不进轮次 kick-off（避免子进程白跑）。
        // 实现约束：赋值 → 终态检查 → kick-off 必须在同一同步段，中间禁止插入 await。
        if (record.status === "closed") {
          await this.deps.getWorktreeManager().cleanup(worktreeHandle);
          return this.deps.buildEarlyFailedHandle(record);
        }
      } catch (err) {
        // create 失败→不进入 run，finalizeFailed 统一收尾（含 emitPendingUnregister failed）
        const _result = await this.deps.finalizeFailed(record, err);
        return this.deps.buildEarlyFailedHandle(record);
      }
    }

    if (isPiRoute) {
      if (record.chatMode) {
        // [H1 U2] chat 首轮经 ConversationContinuation（§3.5 终态数据流：轮末分流
        // chatMode → Continuation onRunSettled；one-shot → settleOneShotOutcome 照旧）。
        // 首轮 task = dispatchRound([task])（无 resume——新 session，锚点由 run 应答回填）。
        this.continuationFor(record).startFirstRound(recordOpts.task);
      } else {
        // one-shot background 派发主干（kickOffChatRound 共享部分，D6 保留泛化）。
        this.kickOffChatRound(
          record,
          { ...recordOpts, worktree: worktreeHandle },
          identity,
          record.controller!.signal,
          PRIORITY_BACKGROUND,
        );
      }
    } else {
      // 非 pi 引擎：engine.run 自足执行（handle+outcome），编排侧 journal 接线 + 终态迁移
      this.kickOffEngineRun(record, recordOpts, engine);
    }
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: project(record) };
  }

  /**
   * 非 pi 引擎的 detached 执行编排（与 pi 轮次 kick-off 同构的 background 语义）：
   * pool 并发槽（maxConcurrent 对非 pi 引擎同样生效）→ journal 接线（D6 第②级：
   * taskId=record.id，初始池 key 占位 'shared'，onPoolResolved retarget 到引擎实际
   * 池 key——路径与 paths.ts 同源推导）→ engine.run（signal 接 record controller，
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
   * 初始池 key 占位 'shared'，onPoolResolved retarget 到引擎实际池 key）→ engine.run
   * （signal 接 record controller，kill-chain 两级生效）→ engineHandle 回填（终态迁移
   * 落 entry 前）→ 终态迁移。bg notify 归编排侧（与 pi 轮次收尾通知归编排对称）。
   */
  async runEngineTask(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    engine: EnginePort,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    // [D3-③ journal 接线合一] writer + retarget + 路径权威收敛 common/journal-wiring
    //（与 SAR 同一实现）。chat 域无下游 onEvent 消费者——journal 是事件唯一出口，
    // 不传 forwardEvents。
    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id });
    // [R4 §3.4 不变量 3] 运行中句柄回填：create 应答后（远早于 run resolve）回填
    // record.engineHandle 并经 reportRecordTransition 落 entry——运行中的 GUI 经 entry
    // 重建 record 即拿到 ①②级读取钥匙（sessionRef/dbPath/poolKey/journalPath），
    // 不再等终态回填（详情页中途打开可见当时进度快照）。journalPath 此时已是
    // retarget 后的最终路径（onPoolResolved 在 prepare 期先行触发，writer 是路径权威）。
    // 仅 chat 域接线——workflow 域 SAR 无运行中 record 读取方，刻意不做同类回填（防误扩展）。
    // [F1 修复] 幂等语义 = 按字段补缺，不是整条丢弃：已有值一律不被迟到值覆盖，缺失
    // 字段照常补上。「sessionId 先落、迟到 handleReady 只补 sessionFile」是本 replay
    // 批次新打通且更有价值的形态（close 期 LC-4 后缀反查会在 sessionId 已知后补发
    // sessionFile）——旧守卫「有 sessionId 即整条 return」会把该
    // 回填永久吞掉，令冷续 resume 锚点（anchor.sessionRef.sessionFile）与引擎 interact
    // 定位拿不到 sessionFile（[H1 U6] chatHandleFor 已随 interact 面退役）。poolKey / journalPath 不参与补缺：
    // journalPath 权威归 journal writer（本闭包写入即定稿），poolKey 由 onPoolResolved
    // retarget 与首次回填定稿，迟到值不得重置。仅在确有字段落位时才落 entry——无新字段
    // 不写噪（迟到重复回调即零副作用，GUI 无额外投影）。
    const backfillEngineHandle = (partial: { sessionRef: Record<string, string>; poolKey: string }): void => {
      const current = record.engineHandle;
      if (current === undefined) {
        record.engineHandle = {
          sessionRef: { ...partial.sessionRef },
          poolKey: partial.poolKey,
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
    // 对齐点③：journal 路径权威 = 引擎声明的池 key（writer 初始用占位，retarget 后
    // 与 handle.poolKey 同源）。
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
      poolKey: JOURNAL_INITIAL_POOL_KEY,
      signal,
      ctxModel: opts.ctxModel,
      onEvent: observedEvent,
      onPoolResolved: journal.onPoolResolved,
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
      // 失败终态 sessionId 缺失时也回填已有部分（dbPath/poolKey），读侧①级降②级
      // 的防御形态；journalPath 取 retarget 后的实际落盘路径（writer 是路径权威）。
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: handle.data.poolKey,
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
        poolKey: JOURNAL_INITIAL_POOL_KEY,
        signal,
        ctxModel: identity.resolved.model,
        onEvent: journal.onEvent,
        onPoolResolved: journal.onPoolResolved,
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
        poolKey: handle.data.poolKey,
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
   * one-shot（非 chatMode）终态收口（原 settleOneShotOutcome 分支）：成功轮消费
   * closeAfterRound 挂起标志；失败/取消一次性销毁。CAS 抢锁失败（cancel/dispose 抢先
   * 终态化）静默跳过。runAndFinalize（workflow 域）与 kickOffChatRound 非 chatMode
   * 分支共用。
   */
  async settleOneShotOutcome(
    record: ExecutionRecord,
    result: AgentResult,
    aborted: boolean,
  ): Promise<void> {
    // [H2 W2 / D7] workflow origin 成功收口 = 立即终态化（closed/"gc"）——G1 显式例外：
    // SP-5 running-resumable 为「父 agent 可 message 续聊」设计，workflow agent 结果
    // 由脚本返回值承载、无 message 对端，保持 running-idle 会绑架 hasRunning / 恒挂
    // 30 天 idle-gc / 被误升级为对话容器 / goal defer 恒挂（设计 D7 四面连带）。
    // 分支置于现有 CAS 之前：防其先把 memory closedReason 写成 "user-close" 与
    // finalizeRecord 的 "gc" 参数分叉。条件含 !aborted：aborted+success 竞态边缘
    // 照旧落现有 cancelled 分支，不漂移为 gc。自带 tryTransition 抢锁（承接现状
    // 「cancel/dispose 抢先 → 静默跳过」守卫语义）；失败/取消分支照旧终态化
    // （下方既有四分支零改动）。
    if (record.origin === "workflow" && !aborted && result.success) {
      if (tryTransition(record, "closed", "gc")) {
        await this.deps.finalizeRecord(record, result, "closed", "gc");
      }
      return;
    }
    if (!tryTransition(record, "closed", aborted ? "cancelled" : result.success ? "user-close" : "gc")) return;
    if (!aborted && result.success && record.closeAfterRound === true) {
      // [M5] busy 时 close(force:false) 置的标志在本轮完成时消费终态化。
      await this.consumeCloseAfterRound(record, result, "user-close");
    } else if (!aborted && result.success) {
      // [SP-5] one-shot 成功完成 → 保持 running（旧 idle），等待 message 触发 upgrade。
      // [H1 U2 / D7] 共享调用点恒传 success（行为零变化 G3——成功空文本回退
      // markRoundIdle 的 one-shot 兜底 前值 ?? "(empty)"）。
      // [U2b] 轮终簿记①-⑨归口 store.markRoundIdle（SP-5 成功分支与 chat 轮末共享轮终
      // 语义；`.alive` 跨轮保留 [D3a/B5]——release 出口 = 终态原语/idle-GC 归档）。
      // [W4 发射点② / U5 收口项②] pending 注销已随 store 簿记⑧统一发射（SubagentService
      // 构造点 setPendingUnregister 接线），本分支不再双轨重复发射。
      this.deps.getStore().markRoundIdle(record.id, { kind: "success", content: result.text });
    } else if (!aborted && record.closeAfterRound === true) {
      // [M5] 优雅关闭挂起的失败轮：轮已完成即兑现 close 意图终态化（含本轮 result）。
      await this.consumeCloseAfterRound(record, result, "gc");
    } else {
      // 非 chatMode 失败/取消 或其他终态：一次性销毁（archive + worktree cleanup）。
      await this.deps.finalizeRecord(record, result, "closed", aborted ? "cancelled" : "gc");
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

  /** [U04 提取·终态收口] closeAfterRound 挂起标志消费（原三处分支的公共收尾序列）：
   *  清标志 + 终态化 closed。reason：成功轮恒 user-close；失败/取消轮用派生值。 */
  async consumeCloseAfterRound(
    record: ExecutionRecord,
    result: AgentResult,
    reason: ClosedReason,
  ): Promise<void> {
    record.closeAfterRound = undefined;
    await this.deps.finalizeRecord(record, result, "closed", reason);
  }

  /**
   * pi 会话形态轮次的 detached 编排（[W3 协议形态 → H1 U6 定形]）：轮次经协议 run
   *（会话形态 resume{recordId, resume?}）发往 pi-subagent-cli 引擎进程——
   *   - 应答时点 = agent_settled（D7 定案：pi 的 compact/收尾在 agent_end 后执行，
   *     agent_end 即 kill 会截断收尾；one-shot 的 agent_end 即终态语义不归本方法）；
   *   - 流式 delta 经 run 作用域反向通道回流（runId 键 ctx.stream）；[H1 U6] 轮次
   *     相位帧反向通道与 recordId 键路由已随 chat 域相位机退役，
   *     中段刷新 = run 事件通道既有事件、settle 交棒 = run 应答驱动；
   *   - chat 域不接 event journal（pi 子代理 session JSONL 即原生数据源——journal
   *     接线仅 workflow 域 SAR 与非 pi 引擎路径）。
   *
   * [H1 U2 / D6 泛化] 本方法是 pi 引擎 background 派发的共享主干（one-shot 与
   * Continuation 轮同路）。`continuation` 存在 = Continuation 轮（chat 域统一进
   * run 域的新编排）：
   *   - 应答/reject/acquire 打断三分回调回流 Continuation（轮末分流 D7 单点收口）；
   *   - 不终态化 acquire-abort（打断 ≠ cancel——record 保持 running）；
   *   - 轮末通知归属 Continuation 双闸（成功 gate→route / 失败独立载荷过门），
   *     主干尾部回注跳过（防双 route）。
   * `continuation` 缺省 = one-shot 主干（终态收口 settleOneShotOutcome + 尾部回注）。
   */
  kickOffChatRound(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    /** 续聊锚点（协议 ResumeAnchor）：run.params.resume.resume。undefined = 新 session。 */
    resume?: ResumeAnchor,
    /** [H1 U2] Continuation 轮回调面（存在 = 新编排；见方法头注释）。 */
    continuation?: ContinuationRoundHandlers,
  ): void {
    // 创建 streaming 生命周期对象。策略（含 widget 退役步骤 2：GUI + relay 激活时停发
    // 私货、TUI/未激活原样创建、sink 未注入降级 undefined）集中在 createBackgroundStream。
    const stream = createBackgroundStream(record.id, this.deps.getStreamSink(), this.deps.getUiObservability().getMode(), process.env);

    // [H1 U6] recordId 键反向通道路由注册段已随 interact 面退役删除——流式 delta
    // 恒经 run 作用域路由（runId 键 ctx.stream），中段守护刷新由 ctx.onEvent 承担。
    const engine = this.resolveChatEnginePort();

    // [W4] 会话形态轮的在途记账：死亡纳管 record 被主 agent resume = 决策收敛
    // （清指引标记与看门狗，回归「该等」）。conversation 形态本就豁免监督域（D8）。
    this.deps.getRoundSupervisor().noteRunStarted(record.id);
    void (async () => {
      try {
        await this.deps.getPool().acquire(priority, this.effectiveMaxConcurrentFor(record), signal);
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
        // [H1 U2] Continuation 轮例外：abort 来源可能是打断（D2——轮级 signal，
        // record 保持 running）而非 cancel（record 级，cancelBackground 已终态化）。
        // 不终态化（abort 不终态化），经 onAbandoned 回流 Continuation（cancel 场景
        // 该回调内终态守卫 early-return，行为等价）。
        if (continuation !== undefined) {
          continuation.onAbandoned();
          return;
        }
        if (signal?.aborted) {
          await this.deps.finalizeAborted(record);
        } else {
          await this.deps.finalizeFailed(record, new Error("aborted"));
        }
        return;
      }
      try {
        // [F-2 轮 arm] 轮开跑（pool 槽已到手、run 协议帧即将派发）挂**中段**无进展
        // 检测——引擎侧 spawn-runner 仅 turn 计数无墙钟，本 arm 是 wedged 轮的唯一熔断
        //（LC-1 场景①：pi 无事件行输出）。refresh 源：① run 事件通道协议事件行
        //（ctx.onEvent，含 text_delta，9 种既有事件）；② settle 交棒——run 应答驱动
        //（Continuation onRunSettled 内 noteRoundSettledFromProtocol；[H1 U6] 旧
        // settled 相位帧消费面已退役）。轮终 disarmRoundFromProtocol 两段一并清。
        // arm 置于 acquire 之后：排队窗口不计入 no-progress 静默（窗语义 = 轮开跑后）。
        // fire 处置按轮形态分流：Continuation 轮 → kill + abort 轮 signal，run 收敛后
        // 经失败分支统一收口（单写者单路）；one-shot 轮 → onOneShotSettledWatchdogTimeout
        //（[A1/G3 回归修复] H1 重构曾误删本形态 arm 点——one-shot 轮 run 无协议超时
        //（engine-client request 不传 timeoutMs = 任务级无超时），无 arm 则楔死 run 永
        // 卡 running + 池槽泄漏 + 无失败通知，违背 G3「one-shot 行为零变化」）。
        if (continuation !== undefined) {
          armMidRoundNoProgress(record.id, {
            onMidTimeout: (fire) => continuation.onWatchdogFire(fire),
            onSettleTimeout: (fire) => continuation.onWatchdogFire(fire),
          });
        } else {
          armMidRoundNoProgress(record.id, {
            onMidTimeout: (fire) => this.onOneShotSettledWatchdogTimeout(record, fire),
            onSettleTimeout: (fire) => this.onOneShotSettledWatchdogTimeout(record, fire),
          });
        }
        // 协议 run：record.chatMode = 会话形态（resume.recordId = 关联键；锚点存在 =
        // 续聊——[H1 U6] 键切换后恒构造 `resume` 键；应答时点 = agent_settled——轮末
        // 分流归属 Continuation onRunSettled）；非 chatMode = 一次性 run（协议面无
        // resume 键，终态语义对齐 settleOneShotOutcome）。
        // [H2 Gate B 修复] live reducer 喂入恢复（runWorkflowEngineTask observedEvent
        // 同款）：W3 删 inproc pi 引擎时，原 engines/pi/session-runner.ts agentEvent
        // 出口的 updateFromEvent(record, event) 一并消失——chat 轮（Continuation）与
        // tool one-shot 在 live 通路零喂入，record.turns/totalTokens 恒 0（journal-
        // replay / session-view-service 重放路径反而保真，live ≡ replay 契约被破坏）。
        // 此处恢复：reducer 与重放路径同源（C5 守护），事件序 = 引擎协议事件序，
        // message_end(usage) 携带 token 增量。Continuation 轮间共用同一 record 实例
        //（continuationFor 绑定），跨轮累积天然持续。喂入窗口 = run await 窗口——
        // cancel/watchdog 抢先终态化后 run 收敛前到达的残余事件仅写内存 record 不落盘
        //（终态 entry 已写，后续无 reportRecordTransition），且事件流随 kill 枯竭，
        // 与 workflow 域修法同一取舍（不加状态守卫，维持单一形态）。中段守护刷新源①
        // 照旧（refreshFromProtocolEvent 在已交棒/已 fire 时幂等 no-op；one-shot 分支
        // 此前不接 onEvent，本修复顺带补齐其刷新源①）。
        const observedEvent = (event: AgentEvent): void => {
          updateFromEvent(record, event);
          refreshFromProtocolEvent(record.id);
        };
        const { outcome } = await engine.run(
          // resume 锚点轮引擎侧覆盖 model 解析（taskSpec 装配单一来源见 taskSpecWithModel）。
          this.taskSpecWithModel(opts, record.model),
          {
            taskId: record.id,
            poolKey: PI_POOL_KEY,
            signal,
            ...(stream !== undefined ? { stream } : {}),
            ctxModel: identity.resolved.model,
            onEvent: observedEvent,
            // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）。
            // 本方法是 pi 引擎 background 派发的主路径（isPiRoute 恒路由至此，含 workflow
            // 域一次性 run——非 chatMode 不带 resume 键但同经此处），漏注 = pi child exit 13。
            ...(this.sessionRootId !== null && this.sessionRootId !== ""
              ? { sessionRootId: this.sessionRootId }
              : {}),
            // 会话形态参数（conversation 形态必传；续聊带锚点）；一次性 run 不携带。
            ...(record.chatMode
              ? {
                resume: {
                  recordId: record.id,
                  ...(resume !== undefined ? { resume } : {}),
                },
              }
              : {}),
          },
        );
        if (outcome.sessionFile !== undefined) {
          record.sessionFile = outcome.sessionFile;
          // [UF-1] 轮应答锚点落盘：跨重启后 coldLookupForAction 据此解析 id→file；
          // [D3a 时机①] 统一入口内 acquire 写权声明（fresh 首轮与 resume 续轮同经）。
          this.writeBindingForRecord(record);
        }
        if (record.chatMode && continuation !== undefined) {
          // [H1 U2] 轮末分流：run 应答（= agent_settled）回流 Continuation——round+1 /
          // 通知 / 交棒 / drain 全在 onRunSettled 单点（D7）。
          continuation.onSettled(outcome);
        } else {
          // 一次性 run 终态收口（对齐原 settleOneShotOutcome：成功轮 SP-5 回退
          // running-resumable 等待 upgrade；失败/取消一次性销毁）。
          const result = this.outcomeToAgentResult(record, outcome);
          await this.settleOneShotOutcome(record, result, signal?.aborted === true);
        }
        // background 回注：仅当本路径抢到 CAS 才 notify。cancel 抢先时 closedReason=
        // 'cancelled'（cancelBackground 自己 notify）；[T4①/PS-2] parent-new/parent-fork
        // 是 disposeAllRecords 的编排性关闭（record 已关、告知由 list 的 closedReason
        // 表达）——迟到的完成回注不注入（可能已切换的）新 session。
        // [H1 U2] Continuation 轮跳过——通知归属 Continuation 双闸（成功 gate→route /
        // 失败独立载荷过门），本段回注即双 route。
        if (continuation === undefined && notifyGateAllowsDelivery(record.closedReason)) {
          this.deps.getCollectCoordinator().route(record);
        }
      } catch (err) {
        // 轮次 run 失败（prepare 期 reject / 引擎进程死亡 / cancel 后未收敛合成终态）：
        // chatMode MF-6——不销毁对话，回退可恢复（session 文件在盘，续聊 run 接续）；
        // 非 chatMode 终态销毁（finalizeFailed）。cancel 抢先时 record 已终态化
        //（Continuation 内终态守卫 / tryTransition 失败跳过），此处仅吞错。
        if (record.chatMode && continuation !== undefined) {
          continuation.onRejected(err);
        } else {
          await this.deps.finalizeFailed(record, err);
        }
        if (err instanceof Error) {
          logger.debug(`[subagent] chat round run error (record=${record.id}): ${err.message}`);
        }
      } finally {
        this.deps.getPool().release();
        // streaming widget 清除（轮终，幂等——续轮 delta 落已 dispose 的 stream 为 no-op）。
        stream?.dispose();
        // [W4] 轮收口重评估（死亡纳管 record 的轮终 → 驱动可能又死 → 重新三态判定）。
        this.deps.getRoundSupervisor().noteRunEnded(record.id);
      }
    })();
  }

  /**
   * [A1 / G3 回归修复] one-shot（非 chatMode）pi background 轮的 settled-watchdog fire
   * 处置（语义对齐 987346fc5 的 onHotPathSettledWatchdogTimeout 非 chatMode 分支——
   * H1 重构误删 arm 点的整链恢复，one-shot 行为零变化）。
   *
   * 与 Continuation 轮（onWatchdogFire → run 收敛后失败分支统一收口）不同：one-shot
   * 轮在本回调内直接收口——kill 子进程 + abort 轮 signal（旧 terminateChatSession
   * cancel 的 H1 后等价杀链）→ CAS（tryTransition closed+gc，防与 cancel/dispose 双
   * 收尾，抢锁失败即跳过）→ finalizeRecord 终态化 → 失败通知。
   *
   * 失败通知按 H1 后失败单发机制接线（Continuation settleRoundFailed 同构）：独立构造
   * BgNotifyRecord 载荷过 notifyGate 门 → notifyHost.notify，不经 route(record)——
   * 失败正文直接取本回调的失败文案，不以 record.result 旧正文冒充（可达性
   * [T2-③/LC-1]：失败原因 + 恢复指引必须可达宿主）。
   *
   * 回调在 timer 触发的同步上下文执行：同步段只做 kill + abort + CAS（不抛），异步
   * 收尾 fire-and-forget 且 catch 归 bestEffort——错误逃出回调 = uncaughtException 崩宿主。
   */
  onOneShotSettledWatchdogTimeout(record: ExecutionRecord, fire: SettledWatchdogFireInfo): void {
    const windowDesc =
      fire.phase === "mid-round"
        ? `no valid protocol event for ${fire.waitedMs / MS_PER_SECOND / SECONDS_PER_MINUTE} min after prompt (mid-round no-progress)`
        : `no agent_settled within ${fire.waitedMs / MS_PER_SECOND}s after agent_end (settled phase)`;
    logger.warn(
      `[subagents] settled watchdog (${fire.phase}) fired for ${record.id}: ${windowDesc}, ` +
        `terminating (LC-1 wedge recovery)`,
    );
    killRecordChildWithEscalation(record.id, "settled watchdog (one-shot)");
    // abort 轮 signal（ctx.signal 接 record controller——引擎侧杀链驱动）；在途 run 收敛
    // 后走 kickOffChatRound 既有吞错面（CAS 已终态化，其 finalizeFailed 抢锁失败 no-op）。
    record.controller?.abort();
    // fire = 本轮等待窗口终结（timer 回调已自删 entry，此处幂等清防御收尾段残留）。
    disarmRoundFromProtocol(record.id);
    if (!tryTransition(record, "closed", "gc")) {
      return; // 已被 cancel/dispose 抢先终态化——不重复收尾（watchdog disarm 由对方承接）
    }
    const failedResult: AgentResult = {
      text: "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: false,
      error:
        `subagent did not reach agent_settled (${windowDesc}; settled watchdog); ` +
        `the process was terminated to bound the wait. ` +
        `Recovery: check state with subagents action:'list', then re-send your message to continue.`,
      sessionId: record.id,
      toolCalls: [],
    };
    void this.deps.finalizeRecord(record, failedResult, "closed", "gc")
      .then(() => {
        // 失败通知（独立载荷过 notifyGate 门——门拦 cancelled/编排性关闭竞态窗）。
        if (!notifyGateAllowsDelivery(record.closedReason)) return;
        // 载荷形态对齐 Continuation settleRoundFailed（closed+failed 文案载体）；
        // sessionFile 不透传（G4：one-shot 通知逐字节——指针行仅 chatMode 语义）。
        this.deps.getNotifyHost().notify({
          id: record.id,
          status: "closed",
          closedReason: "gc",
          outcome: "failed",
          agent: record.agent,
          ...(record.model !== undefined ? { model: record.model } : {}),
          error: failedResult.error,
          startedAt: record.startedAt,
          endedAt: record.endedAt ?? Date.now(),
        });
      })
      .catch((err: unknown) => bestEffort(err, "settled watchdog one-shot finalize", "error"));
  }

  // [H1 U6] chat 域相位机整族已随旧协议轮次相位通道退役删除（语义迁移归属）：
  //   - handleChatRoundPhase（settled/idle/failed/active 相位分诊）
  //     → settle 交棒 = run 应答驱动（Continuation onRunSettled 内
  //     noteRoundSettledFromProtocol，先于轮终簿记）；armMidRoundNoProgress 挂载 =
  //     kickOffChatRound 轮开跑 arm；中段刷新 = run 事件通道 9 种既有事件。
  //   - armChatIdleTimer（idle 相位帧 → idle timer 挂载）→ 随长驻消亡退役
  //    （每轮 = 新 run，轮末进程随 agent_settled 回收，「5min idle 关闭」无对象——
  //     设计 §2.2#5；30 天 idle-gc 只归档不终态化不变）。
  //   - backfillChatAnchor（idle 帧锚点回填）→ sessionFile 回填改由 run 应答
  //     outcome.sessionFile 承载（+ writeBindingForRecord 落盘，UF-1）。
  //   - onChatRoundFailed（failed 相位分诊）→ Continuation.onRunSettled 失败分支
  //     统一收口（doFinalizeRoundToIdle outcome=failed + 失败通知，D7）。
  //   - settleChatRoundFromResponse（首轮成功 settle 载体）→ 语义按 D7 迁移清单并入
  //     Continuation.settleRoundSuccess（round+1 / result=content / 门→route；
  //     closeAfterRound 消费 chat 域退役、base 推进退役不迁移）。
  //   - terminateChatSession / chatHandleFor（interact cancel/close 终止意图）→
  //     随 interact 面退役：真实杀链 = 轮级 abort signal → 协议 cancel 帧（引擎侧
  //     杀链）+ 镜像置死记账（killRecordChildWithEscalation）+ 引擎退出链收割
  //     （engine-client teardownProcess，红线①）。

  /** [W3] pi 引擎 port 解析（chat 域路由与终止面共用）：registry cli 形态 port，
   *  未注册 = 不可用 stub（engine_not_found，见 pi-host-binding）。 */
  resolveChatEnginePort(): EnginePort {
    return resolveHostPiEnginePort(() => null);
  }

  /**
   * Continuation 实例解析（ensure 语义）。跨重启 revive（cold-resurrect）会重建新
   * record 对象并 register——缓存实例的 record 绑定不一致时重建（Continuation 的
   * 状态写必须落 store 在册对象）。
   */
  continuationFor(record: ExecutionRecord): ConversationContinuation {
    const existing = this.continuations.get(record.id);
    if (existing !== undefined && existing.boundRecord === record) return existing;
    const created = new ConversationContinuation(record, {
      dispatchChatRound: (rec, input) => this.dispatchChatRoundForContinuation(rec, input),
      finalizeRoundOutcome: (rec, outcome) => this.finalizeRoundToIdle(rec, outcome),
      routeRecord: (rec) => this.deps.getCollectCoordinator().route(rec),
      notifyRecord: (n) => this.deps.getNotifyHost().notify(n),
      killStaleChild: (id) => this.killStaleChildBeforeDispatch(id),
      killRoundChild: (id, source) => this.killRoundChildForWatchdog(id, source),
      upgradeGateAllows: (rec) => this.canUpgradeToConversation(rec),
      reviveClosedRecord: (rec) => {
        // D4 revive 宿主面：register（跨重启重建后不在内存的形态）+ 迁移上报
        //（W16 类外状态写点同构——entry 落盘，live/reload 视图同步）。
        this.deps.getStore().register(rec);
        this.deps.getStore().reportRecordTransition(rec);
      },
      // [U2b 修复轮/D2] 轮始簿记（store.markRoundStarted）——Continuation 的唯一轮始写点。
      markRoundStarted: (rec) => {
        this.deps.getStore().markRoundStarted(rec.id);
      },
      closeNow: (rec) => this.deps.closeChatIdle(rec),
    });
    this.continuations.set(record.id, created);
    return created;
  }

  /**
   * 泛化派发主干的 Continuation 轮入口（§3.4 ②载荷组装——归自 resumeColdRound
   * 现有实现）：model 身份重建（splitEngineModelRef，防多轮模型漂移探针 P-10）、
   * ExecuteOptions 组装（worktree 句柄 / conversation:true）、detached 交棒
   * kickOffChatRound（priority = background，轮次在 background 跑）。
   */
  dispatchChatRoundForContinuation(record: ExecutionRecord, input: ContinuationDispatchInput): void {
    const model = splitEngineModelRef(record.model);
    const identity: ResolvedIdentity = {
      agent: record.agent,
      agentConfig: undefined,
      resolved: {
        model: { id: model.id, name: model.name, provider: model.provider, reasoning: false },
        thinkingLevel: record.thinkingLevel,
      },
    };
    const opts: ExecuteOptions = {
      task: input.task,
      slug: record.slug,
      worktree: record.worktreeHandle,
      conversation: true,
    };
    this.kickOffChatRound(record, opts, identity, input.signal, PRIORITY_BACKGROUND, input.resume, {
      onSettled: input.handlers.onSettled,
      onRejected: input.handlers.onRejected,
      onAbandoned: input.handlers.onAbandoned,
      onWatchdogFire: input.handlers.onWatchdogFire,
    });
  }

  /**
   * [红线②派发前兜底] stale-child：镜像在途子进程活着（引擎存活期的状态错配——
   * Continuation 无在途 run 但镜像有活项）→ 镜像置死记账 + 协议 cancel（引擎侧杀链）
   * + 有界退出窗（STALE_CHILD_EXIT_WAIT_MS，pi trap flush 量级）。引擎已死场景的
   * 孤儿由引擎退出链收割兜底（红线①——engine-client teardownProcess，镜像此刻已
   * 整体置死，本兜底查不到，两通道正交）。
   */
  async killStaleChildBeforeDispatch(recordId: string): Promise<void> {
    if (!hasLiveProcessHandle(recordId)) return;
    killRecordChildWithEscalation(recordId, "stale-child guard (dispatch)");
    await delay(STALE_CHILD_EXIT_WAIT_MS);
  }

  /** watchdog fire 的 kill 手段（kill + 协议 cancel）——run 收敛由杀链驱动，
   *  轮末收口统一回流 Continuation onRunSettled/onRoundRejected（单写者单路）。 */
  killRoundChildForWatchdog(recordId: string, source: string): void {
    killRecordChildWithEscalation(recordId, source);
  }

  /**
   * [D5 双写点 gate 判据] SP-5 升级（one-shot → chatMode）的 conversation 位检查：
   * record 所属引擎（engine 留痕 ?? 默认引擎）capabilities.conversation 非
   * 'unsupported' 才放行。引擎未注册 = 无法验证续聊能力，fail-closed 拒绝。
   * 消费双写点：①进程内热升级（subagent-actions-core messageHandler）②跨重启冷升级
   *（Continuation D4 revive 格）——zcode 等 unsupported 引擎的 one-shot 收到 message
   * 不升级（含 parent-shutdown 可重连终态经 message 的升级旁路面）。
   */
  canUpgradeToConversation(record: Pick<ExecutionRecord, "engine">): boolean {
    try {
      const engine = getEngine(record.engine ?? DEFAULT_ENGINE_ID);
      return engine.capabilities().conversation !== "unsupported";
    } catch {
      return false;
    }
  }

  /**
   * record 终态化路径的宿主侧收口汇聚点（[H1 U2] Continuation 实例清理——终态后
   * 容器不再接收 message，实例滞留即泄漏；[H1 U6] 路由注销面已随 interact 面退役）。
   */
  onRecordFinalizedCleanup(recordId: string): void {
    this.continuations.delete(recordId);
  }

  /**
   * 对话模式轮次完成收尾：委托 doFinalizeRoundToIdle（record 进 idle，保留内存 + worktree）。
   * 与 finalizeRecord 对称的委托方法，deps 同源注入。[H1 U2 / D7] 入参改轮终 outcome
   * 判别联合（成功 = content / 失败 = reason——result 写入规则归 finalize-record 单点）。
   * Continuation 轮末分流（success/failed 两分支）消费；one-shot SP-5 共享点已
   * [U2b] 改直连 store.markRoundIdle（settleOneShotOutcome 成功分支，不再经本方法）。
   */
  async finalizeRoundToIdle(
    record: ExecutionRecord,
    outcome: RoundSettlementOutcome,
  ): Promise<void> {
    await doFinalizeRoundToIdle(
      {
        worktreeManager: this.deps.getWorktreeManager(),
        store: this.deps.getStore(),
        modelService: this.deps.getModelService(),
        pi: this.deps.getPi(),
        emitUnregister: (id, st) => this.deps.getNotifyHost().emitPendingUnregister(id, st),
      },
      record,
      outcome,
    );
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


  /**
   * [R4 / C-4 兑现] Continuation 实例全量清理显式接口——原壳 dispose 直调
   * `this.continuations.clear()` 的跨聚合边（r0-inventory 清单① C-4）：字段所有权
   * 随域 #14 迁入本聚合，壳 dispose 编排改调本接口（聚合间零直写，G2）。
   */
  clearContinuations(): void {
    this.continuations.clear();
  }

  /**
   * [R4 / C-5 邻接兑现] Continuation 在途轮打断清队显式接口——原壳装配闭包
   * `this.continuations.get(id)?.abortAndClearQueue()`（RecordLifecycle deps 的
   * abortContinuationQueue 回调）：R4 抽取后回调改指本聚合接口。
   */
  abortContinuationQueue(recordId: string): void {
    this.continuations.get(recordId)?.abortAndClearQueue();
  }
}
