// [H3/R4] WorkflowDispatch 聚合（域 #14 的 H2 workflow 族：executeWorkflowAgent +
// runWorkflowEngineTask + 类外派发 helper 整段）——自 SubagentService 上帝类 strangler
// 抽取的第五个聚合文件（设计 docs/design/subagent-service-decomposition.md §2.1 域 #14
// 增项 / impl-plan §2 R4 行「H2 workflow 族整段随族迁入」）。
//
// [G1 超限预授权拆分 / 偏差 D-R4-1] 主 agent 派发预授权：R4 域段体量大（派发估算
// 1200+ 物理行），按内聚边界拆两个文件——本文件（workflow 族独立）+ run-orchestration.
// ts（核心编排）。**实测与派发估算不符**：R0 重排后域段实测 1662 物理行 > 两文件容量
// 上限（2×700），run-orchestration.ts 物理超限不可避免（偏差登记待主 agent 追认；
// 备选方案 = 第三文件再拆 Continuation 协作面）。两文件零互调零 import（G2 / R1 打样
// 模式 3）：跨文件协作经壳 deps 回调编排（acquirePoolOrFinalize / settleOneShotOutcome
// / outcomeToAgentResult / releaseRoundResources / resolveChatEnginePort /
// assertIdleTimeoutMsSafe——壳装配闭包指 run-orchestration 实例方法）。
//
// 单一职责：workflow 脚本 agent() 派发链（H2 W2 八步迁移的 service 侧承接）——
// AgentCallOpts 进站映射、引擎路由 + 预检、origin:"workflow" record 注册、journal /
// no-progress 守护 / signal 合流 / spawned-children 治理、D7 成功即终态化。与手动
// subagent 共享的编排原语（池槽 / 终态收口）经 deps 回调回流 RunOrchestration。
//
// [R1 打样模式——R4 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）——execNesting / streamSink /
//    sessionRootId 等会话基线运行时可变态经壳 getter 现读；modelService /
//    roundSupervisor 等 #1 留壳共享依赖 getter 现读同一实例。
// 2. 模块常量 SSOT：PRIORITY_BACKGROUND / MS_PER_SECOND / SECONDS_PER_MINUTE 已
//    [R6/D-R4-4] 归一常量叶子文件 service-constants.ts（原两聚合重复声明消除，
//    改 import 消费）。
// 3. 只搬不改：两方法 + 类外 5 helper 自壳文件迁移，方法体除依赖通道替换
//    （this.X → this.deps.getY()）外逐字节保留（审计 /tmp/r4-move-audit.py）。

import { getLogger } from "../../core/logger.ts";

import type { AgentResult as WorkflowAgentResult, AgentCallOpts } from "../../orchestration/models/types.ts";
import { SLUG_MAX_LENGTH } from "../../orchestration/models/types.ts";
import { mapToWorkflowAgentResult } from "../agent-result-mapper.ts";
import { updateFromEvent } from "../execution-record.ts";
import { assertTaskShapeSupported } from "../engine/common/capability-gate.ts";
import { JOURNAL_INITIAL_POOL_KEY, wireEventJournal } from "../engine/common/journal-wiring.ts";
import type { ExecutionNestingContext } from "../engine/common/nesting-guard.ts";
// [H2 W2 迁移步⑥] mergeRunSignals 提公共 helper（原 SAR 模块内直调）——workflow
// 派发的 timeout+watchdog+外部 signal 三源合流。
import { mergeRunSignals, type MergedRunSignalHandle } from "../engine/common/run-signals.ts";
import type { EnginePort, RunContext } from "../engine/port.ts";
import { registerSpawnedChildForRecord } from "../engine/host/spawned-children.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "../engine/registry.ts";
import { type EngineRouteResult, routeEngineForHost } from "../engine/routing.ts";
import type { AgentOutcome } from "../engine/types.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { AgentConfig } from "../model-resolver.ts";
import type { NotifyHost } from "../notify-host.ts";
// [R3] ResolvedIdentity 接口本体在 record-access.ts（生产者 resolveIdentity 所属聚合），
// 本聚合单向 type import（D-R3-2 同款非环形态）。
import type { ResolvedIdentity } from "./record-access.ts";
import type { RoundSupervisor } from "../round-supervisor/index.ts";
import {
  armMidRoundNoProgress,
  disarmSettledWatchdog,
  refreshFromProtocolEvent,
  type SettledWatchdogFireInfo,
} from "../settled-watchdog.ts";
import { createBackgroundStream, type StreamSink, type SubagentStream } from "../stream-sink.ts";
import { MAX_FORK_DEPTH } from "../session-context-resolver.ts";
import type { UiRequestObservability } from "../ui-request-observability.ts";
import {
  DEFAULT_AGENT_NAME,
  ForkDepthExceededError,
  type AgentEvent,
  type AgentResult,
  type ExecuteOptions,
  type ExecutionMode,
  type ExecutionRecord,
} from "../types.ts";
// [R6/D-R4-4] 跨两聚合消费的值语义纯量归一常量叶子文件（聚合→支撑文件方向合法）。
import { PRIORITY_BACKGROUND, MS_PER_SECOND, SECONDS_PER_MINUTE } from "./service-constants.ts";

const logger = getLogger("subagents");

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。四类成员：
 * - 断言/校验面（assertReady / assertIdleTimeoutMsSafe）：入口就绪门与 idleTimeoutMs
 *   合法域校验（本体在 SessionBaselines / RunOrchestration）。
 * - 会话基线 getter（getExecNesting / getStreamSink / getUiObservability /
 *   getSessionRootId / getPi 通道外的 NotifyHost 投影）：initSession 注入的运行时可变
 *   态现读。
 * - R3 聚合显式接口（resolveIdentity / resolveIdentityForEngine / createRecordForMode）
 *   与 #1 留壳共享依赖（getModelService / getNotifyHost / getRoundSupervisor）。
 * - 同域跨文件协作回调（经壳编排指 run-orchestration 实例方法，零 import）：
 *   resolveChatEnginePort / acquirePoolOrFinalize / outcomeToAgentResult /
 *   settleOneShotOutcome / releaseRoundResources；finalizeFailed 指 RecordLifecycle。
 */
export interface WorkflowDispatchDeps {
  /** [D4 下沉] assertReady 断言（本体在 SessionBaselines，壳转发）。 */
  readonly assertReady: () => void;
  /** [T4② / PS-4] idleTimeoutMs 入口校验（本体在 RunOrchestration，与 execute/
   *  executeAndAwait 两入口同款；经壳编排回调）。 */
  readonly assertIdleTimeoutMsSafe: (opts: ExecuteOptions) => void;
  /** 嵌套身份基线（BC-12 嵌套护栏深度检查；SessionBaselines 现读）。 */
  readonly getExecNesting: () => ExecutionNestingContext;
  /** ModelConfigService（agentConfig 宽松面读取 + 引擎路由全局缺省）。 */
  readonly getModelService: () => ModelConfigService;
  /** pi 引擎 port 解析（RunOrchestration 组内方法，经壳编排回调）。 */
  readonly resolveChatEnginePort: () => EnginePort;
  /** [R3 RecordAccess 显式接口] pi 链三层身份解析。 */
  readonly resolveIdentity: (opts: ExecuteOptions) => Promise<ResolvedIdentity>;
  /** [R3 RecordAccess 显式接口] 非 pi 引擎的 identity 解析（含 validateModelForEngine）。 */
  readonly resolveIdentityForEngine: (
    engine: EnginePort,
    engineModel: string | undefined,
    agent: string,
    agentConfig: AgentConfig | undefined,
    opts: ExecuteOptions,
  ) => ResolvedIdentity;
  /** [R3 RecordAccess 显式接口] 按 mode 创建 record 并注册（含 workflow originFields）。 */
  readonly createRecordForMode: (
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
    originFields?: { origin: "workflow"; parentRunId: string },
  ) => ExecutionRecord;
  /** NotifyHost（record 级 pending:register 注销面）。 */
  readonly getNotifyHost: () => NotifyHost;
  /** UI streaming sink（内构 background stream 的 widget 通道；SessionBaselines 现读）。 */
  readonly getStreamSink: () => StreamSink | null;
  /** UI observability（stream 通道形态判据 getMode；SessionBaselines 现读）。 */
  readonly getUiObservability: () => UiRequestObservability;
  /** 根 session id（relay 归属键 SESSION_ID 权威源；SessionBaselines 现读）。 */
  readonly getSessionRootId: () => string | null;
  /** [B-6 留壳] 轮次活性监督器（在途记账 noteRunStarted/noteRunEnded）。 */
  readonly getRoundSupervisor: () => RoundSupervisor;
  /** [RunOrchestration 协作回调] 池槽获取（失败路径含 S1 cancelled 终态收口）。 */
  readonly acquirePoolOrFinalize: (
    record: ExecutionRecord,
    signal: AbortSignal | undefined,
    priority: number,
  ) => Promise<AgentResult | undefined>;
  /** [RunOrchestration 协作回调] AgentOutcome → execution AgentResult 单一映射源。 */
  readonly outcomeToAgentResult: (record: ExecutionRecord, outcome: AgentOutcome) => AgentResult;
  /** [RunOrchestration 协作回调] one-shot 终态收口（顶部 D7 origin==="workflow"
   *  CAS 抢锁分支 = 成功即终态化 closed/gc）。 */
  readonly settleOneShotOutcome: (record: ExecutionRecord, result: AgentResult, aborted: boolean) => Promise<void>;
  /** [R3 RecordLifecycle 显式接口] run 创建期异常收尾（catch swallow 分支）。 */
  readonly finalizeFailed: (record: ExecutionRecord, err: unknown) => Promise<AgentResult>;
  /** [RunOrchestration 协作回调] 轮次资源回收（finally 语义，幂等）。 */
  readonly releaseRoundResources: (
    record: ExecutionRecord,
    holdSlot: boolean,
    stream: SubagentStream | undefined,
  ) => void;
}

/**
 * 域 #14 workflow 族聚合：workflow 脚本 agent() 派发链（R4 自 SubagentService 抽取）。
 * 壳（subagent-service.ts）经 executeWorkflowAgent 单行转发透传，对外签名零变化。
 */
export class WorkflowDispatch {
  private readonly deps: WorkflowDispatchDeps;

  constructor(deps: WorkflowDispatchDeps) {
    this.deps = deps;
  }

  // [R4 等价形态复刻] sessionRootId 经 getter 转发 deps（属性访问形态保留——TS 对
  // getter 可做 null 收窄，runCtx 条件 spread 的类型推导与壳内原形态一致；函数调用
  // 形态 this.deps.getSessionRootId() 不参与收窄）。
  private get sessionRootId(): string | null {
    return this.deps.getSessionRootId();
  }

  /**
   * [H2 W2] workflow 域统一派发入口（设计 subagent-workflow-record-unification
   * §3.5 / G1 等同语义）：workflow 脚本 agent() 经 pump 薄转调进此（W3 接线；本
   * 单元入口就位，测试直接调用），与手动 subagent 同一 service 编排——共享池
   * （DefaultConcurrencyPool）、record 注册进 store（origin:"workflow" +
   * parentRunId）、journal / no-progress 守护 / spawned-children 治理、终态收口
   * （D7 成功即终态化）。编排接管自 SAR.run 八步迁移（W4 已掏空 SAR.run 为纯转调
   * ffbe595c5，
   * ctxModel 孪生守卫按清单放弃——resolveIdentity 已有 model 解析，禁止双轨）。
   *
   * 顺序红线（D3）：路由/预检/model 校验**先于**池 acquire——失败零池占用；路由
   * 失败/预检命中/嵌套超限同步抛错回脚本且不产生孤儿 record（与 executeViaEngine
   * 「全部同步拒绝发生在 record 创建前」同一不变量）。
   *
   * 错误规格（§3.4）：池排队被 abort → run 域 cancelled 收口（acquirePoolOrFinalize
   * 同款 S1 分支）；record 创建失败 → 同步抛错；引擎死亡 → catch 合成 failed result
   * 回脚本（swallow 语义，脚本观察到失败结果非异常）+ record 由失败路径立即终态化
   * （adopt 豁免——workflow record 无脚本可回，resumable 等待无意义）。
   */
  async executeWorkflowAgent(
    opts: AgentCallOpts,
    parentRunId: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    this.deps.assertReady();
    // 入口校验与嵌套护栏（与 execute/executeAndAwait 同款 BC-12 / T4②）。
    const execOpts = workflowCallToExecuteOptions(opts);
    this.deps.assertIdleTimeoutMsSafe(execOpts);
    const parentNesting = this.deps.getExecNesting().current();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // ── 八步迁移 ①②③：路由 → 预检 → identity（含非 pi 引擎 model 校验）──
    // 全部先于 record 创建与池 acquire（D3 失败零池占用）。agentConfig 取宽松面
    //（getAgentConfig——路由输入只要 frontmatter engine；显式 ref 解析失败的报错归
    // identity 阶段的 getRequiredAgentConfig，不在路由层重复）。
    const agentConfig = opts.agent ? this.deps.getModelService().getAgentConfig(opts.agent) : undefined;
    const routed = routeEngineForHost({
      routing: {
        callEngine: opts.engine,
        agentEngine: agentConfig?.engine,
        globalDefaultEngine: this.deps.getModelService().getGlobalConfig().defaultEngine,
      },
      taskModel: opts.model,
      strict: this.deps.getModelService().getGlobalConfig().engineRouting?.strict === true,
      probe: (engineId) => getEngine(engineId).probe(),
      piEngine: this.deps.resolveChatEnginePort(),
    });
    const route: EngineRouteResult = routed instanceof Promise ? await routed : routed;
    // ② 预检（capability-gate 单点；AgentCallOpts 直传——TaskShapeForGate 是结构子集）
    assertTaskShapeSupported(route.engineId, route.engine.capabilities(), opts);
    // ③ 非 pi 引擎 model 校验：经 resolveIdentityForEngine 内的 validateModelForEngine
    //（与 chat 域 executeViaEngine 同一入口同一文案；model 源 = 显式 opts.model >
    // agent frontmatter——u-h2 D2-1③ 同款）。
    const isPiRoute = route.engineId === DEFAULT_ENGINE_ID;
    const engineModel = isPiRoute ? undefined : (opts.model ?? agentConfig?.model);
    const identity = isPiRoute
      ? await this.deps.resolveIdentity(execOpts)
      : this.deps.resolveIdentityForEngine(
        route.engine,
        engineModel,
        execOpts.agent ?? DEFAULT_AGENT_NAME,
        agentConfig,
        execOpts,
      );
    if (!isPiRoute && engineModel !== undefined) execOpts.model = engineModel;
    // record 引擎留痕（对齐 executeViaEngine 盖章规则：pi 纯缺省不盖键；pi 兜底盖
    // 'pi'+from；非 pi 盖 engineId）。
    if (!isPiRoute) {
      execOpts.engine = route.engineId;
    } else if (route.engineFallback !== undefined) {
      execOpts.engine = DEFAULT_ENGINE_ID;
    }
    if (route.engineFallback !== undefined) execOpts.engineFallback = route.engineFallback;

    // ── record 注册（origin:"workflow" + parentRunId；record 级 pending:register
    //    照旧——与既有派发路径同款）──
    const record = this.deps.createRecordForMode(identity, execOpts, "background", {
      origin: "workflow",
      parentRunId,
    });
    this.deps.getNotifyHost().emitPendingRegister(record.id, record.agent);

    const effectiveSignal = signal ?? record.controller?.signal;
    return this.runWorkflowEngineTask(record, opts, identity, route.engine, effectiveSignal, onEvent, stream);
  }

  /**
   * executeWorkflowAgent 的执行核（acquire 后主体 + finally 回收）。八步迁移 ④⑤⑥⑦
   * 的落点：
   *   ④ journal 接线（wireEventJournal 单点；taskId = record.id——真实 record 在
   *      store，不再用 SAR 的占位 id）；
   *   ⑤ no-progress 守护（arm/disarm 键 = record.id（D4）；双刷新源 = journal.onEvent
   *      包装 ∪ stream.onDelta 包装；fire 后失败结果追注恢复指引——M3 语义逐项复刻）；
   *   ⑥ mergeRunSignals（timeoutMs + 守护 abort + 外部 signal 合流）；
   *   ⑦ spawned-children 注册（dispose killAll 收割兜底，键 = record.id）。
   * 池 = DefaultConcurrencyPool 共享（acquirePoolOrFinalize 同链，D3）；成功收口 =
   * settleOneShotOutcome 顶部 D7 origin 分支（closed/gc 立即终态化）。stream 实参
   * 缺省时自构 createBackgroundStream（设计 D2「streaming 由 service 派发路径既有
   * 通道承载」——widget 通道收口点，kickOffChatRound 同款策略，见函数体注释）。
   */
  async runWorkflowEngineTask(
    record: ExecutionRecord,
    opts: AgentCallOpts,
    identity: ResolvedIdentity,
    engine: EnginePort,
    signal: AbortSignal | undefined,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    // [H2 W3 must-fix] stream 实参缺省时自构 background stream——设计 D2「streaming
    // 由 service 派发路径既有通道承载」的实体落点：W3 切换后 pump 不再构造
    // SubagentStream（旁路 record 族退役），workflow agent 的 text_delta widget 通道
    // 在 service 侧收口，与 kickOffChatRound 的 createBackgroundStream 完全同款
    //（含 H1 widget 退役策略：GUI+relay 激活停发私货 / TUI·未激活原样创建 / sink
    // 未注入降级 undefined——照单继承 chat 域现行策略，非行为变化）。显式传 stream
    // 时用传入值（测试注入面保留）。创建先于池 acquire（kickOffChatRound 同序：
    // acquire 失败早退时 stream 尚未 onDelta，无 widget/timer 副作用可泄漏）。
    const effectiveStream =
      stream ?? createBackgroundStream(record.id, this.deps.getStreamSink(), this.deps.getUiObservability().getMode(), process.env);
    const pooled = record.mode === "background";
    let acquired = false;
    if (pooled) {
      const acquireFailure = await this.deps.acquirePoolOrFinalize(record, signal, PRIORITY_BACKGROUND);
      if (acquireFailure !== undefined) return mapToWorkflowAgentResult(acquireFailure);
      acquired = true;
    }

    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id, forwardEvents: onEvent });
    let runSignal: MergedRunSignalHandle | undefined;
    let unbindStream: (() => void) | undefined;
    let noProgress: WorkflowNoProgressGuard | undefined;
    // [W4] 在途记账（监督器「该等」判据源；与 kickOffEngineRun/kickOffChatRound 同款
    //——运行期监督对 workflow record 照旧纳管，只豁免 adopt 接管）。
    this.deps.getRoundSupervisor().noteRunStarted(record.id);
    try {
      // ⑤ arm（池槽已到手、engine.run 派发前——排队窗口不计入 no-progress 静默，
      // kickOffChatRound 同款窗语义）。
      noProgress = armWorkflowNoProgressWatchdog(record.id);
      // ⑥ timeoutMs + 守护 abort 并入同一合流（第三信号源）
      runSignal = mergeRunSignals(
        signal ?? new AbortController().signal,
        opts.timeoutMs,
        noProgress.signal,
      );
      // ⑤ 双刷新源（两路缺一不可——只接 journal 会漏纯流式产出的活性信号）：
      // journal.onEvent 包装（协议事件）∪ stream.onDelta 包装（流式增量反向帧；
      // 内构 stream 同样经本包裹——refresh 与 widget flush 在同一 onDelta 调用点）。
      const journalOnEvent = journal.onEvent;
      const observedEvent = (event: AgentEvent): void => {
        // [H2 A3 修复] live reducer 喂入恢复：W3 删 inproc pi 引擎时，原
        // engines/pi/session-runner.ts agentEvent 出口的 updateFromEvent(record, event)
        // 一并消失，协议化 service 侧未重建——record.turns/totalTokens 在 live 通路
        // 零喂入，终态 entry 落盘同为 0（Gate B A3：workflow agent 实际消耗 LLM 而
        // record 恒 0）。此处恢复 workflow 域喂入：reducer 与 journal-replay /
        // session-view-service 重放路径同源（C5 守护），live ≡ replay 构造性成立；
        // 事件序 = 引擎协议事件序，message_end(usage) 携带 token 增量。
        updateFromEvent(record, event);
        refreshFromProtocolEvent(record.id);
        journalOnEvent(event);
      };
      unbindStream = effectiveStream === undefined ? undefined : bindWorkflowStreamRefresh(effectiveStream, record.id);

      const runCtx: RunContext = {
        taskId: record.id,
        poolKey: JOURNAL_INITIAL_POOL_KEY,
        signal: runSignal.signal,
        ctxModel: identity.resolved.model,
        onEvent: observedEvent,
        onPoolResolved: journal.onPoolResolved,
        ...(effectiveStream !== undefined ? { stream: effectiveStream } : {}),
        ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
        ...(this.sessionRootId !== null && this.sessionRootId !== ""
          ? { sessionRootId: this.sessionRootId }
          : {}),
        // ⑦ D10 终止链：引擎 spawn 的子进程注册进 spawnedChildren 记账（cancel
        // SIGTERM / dispose killAll 收割兜底，键 = record.id）
        onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
      };
      // 任务声明：opts 直传（D6 合流——AgentCallOpts 即 EnginePort 任务形状，SAR 同款
      // 零映射），model 覆写为 record 留痕词形（resolveIdentity 解析产物，与
      // runAndFinalize 的 taskSpecWithModel 同源权威）。
      const taskSpec: AgentCallOpts = {
        ...opts,
        ...(record.model !== undefined ? { model: record.model } : {}),
      };
      const { handle, outcome } = await engine.run(taskSpec, runCtx);
      journal.backfillHandle(handle);
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: handle.data.poolKey,
        journalPath: journal.path,
      };
      const result = this.deps.outcomeToAgentResult(record, outcome);
      // D7 收口（origin 分支在 settleOneShotOutcome 函数顶部；aborted 判外部 signal
      // ——timeout/watchdog 的 abort 走失败 result 语义，不映射 cancelled）。
      await this.deps.settleOneShotOutcome(record, result, signal?.aborted === true);
      return noteIfWorkflowNoProgressFired(outcomeToWorkflowResult(outcome), noProgress);
    } catch (err) {
      // swallow（不 re-throw）：脚本观察到合成 failed result 而非异常（引擎死亡
      // engine_crashed 同路）；record 由失败路径立即终态化（finalizeFailed CAS →
      // finalizeRecord；adopt 豁免——workflow record 不保持 resumable 交监督器）。
      const failed = await this.deps.finalizeFailed(record, err);
      return noteIfWorkflowNoProgressFired(mapToWorkflowAgentResult(failed), noProgress);
    } finally {
      // 先摘 stream 包裹与信号桥接（不残留 listener/覆写），再清守护，再归还池槽与
      // journal 收口（SAR 同序）。内构 stream 的 widget 清除（dispose）同经本回收。
      runSignal?.dispose();
      unbindStream?.();
      disarmSettledWatchdog(record.id);
      this.deps.releaseRoundResources(record, pooled && acquired, effectiveStream);
      await journal.close();
      this.deps.getRoundSupervisor().noteRunEnded(record.id);
    }
  }
}

// ── [H2 W2] workflow 域派发 helper（executeWorkflowAgent 专用，M3 语义逐项复刻）──

/**
 * [H2 W2 迁移步⑤] workflow 派发路径 no-progress 守护句柄：signal 供 mergeRunSignals
 * 合流（步⑥），fired 供 run 收敛后判定是否追注恢复指引（fire 是异步 timer 事件）。
 * 与 chat 域 armMidRoundNoProgress 同一原语（settled-watchdog）同一量级（30min
 * 连续静默 = 回收层有界兜底，非任务级墙钟）；差异仅 arm 键 = record.id（D4 守护
 * 单点——真实 record 在 store，原 SAR 模块内守护函数随 [H2 W4] 掏空退役）。
 */
interface WorkflowNoProgressGuard {
  signal: AbortSignal;
  fired(): boolean;
}

/**
 * arm workflow 派发路径 no-progress 守护（复用 settled-watchdog 原语，不新造第二套
 * 计时器）。fire 回调契约：timer 同步上下文内只做 warn + AbortController.abort()
 * （abort 幂等不抛）；真正终止由 abort 经 mergedSignal → RemoteEngine
 * wireAbortSignal 阶梯（cancel 帧 → 收敛窗 → killAll）承载。onSettleTimeout 与
 * onMidTimeout 同体（workflow 域无 agent_end 交棒点，同体保证未来接交棒语义不变）。
 */
function armWorkflowNoProgressWatchdog(recordId: string): WorkflowNoProgressGuard {
  const controller = new AbortController();
  let fired = false;
  const fire = (info: SettledWatchdogFireInfo): void => {
    fired = true;
    // 恢复指引闭环（错误 → 权威源 → 重试）：killAll 组杀连带面在此显式出声——
    // 引擎对 cancel 帧 >收敛窗无响应时组杀引擎 CLI，同引擎其余并发 run 会以
    // engine_crashed 失败终态化（失败结果照回脚本、executeAgentCall 重试通道仍在）。
    logger.warn(
      `[subagents] workflow no-progress watchdog (${info.phase}) fired for ${recordId}: ` +
        `no valid protocol event for ${info.waitedMs / MS_PER_SECOND / SECONDS_PER_MINUTE} min after run dispatched — ` +
        `aborting run (cancel frame → settle grace window → killAll if the engine does not settle). ` +
        `Note: a killAll group-kills the engine CLI process, so other concurrent runs on the same ` +
        `engine may end as engine_crashed (they still get a failure result and retry). ` +
        `Recovery: check state with subagents action:'list' includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents), then re-dispatch the workflow.`,
    );
    controller.abort();
  };
  armMidRoundNoProgress(recordId, { onMidTimeout: fire, onSettleTimeout: fire });
  return { signal: controller.signal, fired: () => fired };
}

/**
 * streamDelta 刷新接线（守护双刷新源之二）：在**原实例**上包裹 onDelta（先刷新再
 * 委托原实现），返回 unbind 函数由 finally 调用恢复。保持对象 identity（不建代理）
 * ——下游 stream 透传契约要求同一实例，而 host/streamDelta 反向帧只经
 * `ctx.stream.onDelta` 到达，原地包裹是唯一既保 identity 又能观测 delta 的接法。
 */
function bindWorkflowStreamRefresh(stream: SubagentStream, recordId: string): () => void {
  const originalOnDelta = stream.onDelta;
  const hadOwnOnDelta = Object.prototype.hasOwnProperty.call(stream, "onDelta");
  stream.onDelta = (delta: string): void => {
    refreshFromProtocolEvent(recordId);
    originalOnDelta.call(stream, delta);
  };
  return () => {
    if (hadOwnOnDelta) stream.onDelta = originalOnDelta;
    else Reflect.deleteProperty(stream, "onDelta");
  };
}

/**
 * fire 判定 + 追注的单一出口（正常收敛与 catch 两路共用同一判定，消除「两路文案
 * 分叉」）。只对已带 error 的结果追注——成功收敛或被外部 cancel 的形态保持原样，
 * 不伪造失败（M3 U-B2 语义复刻）。
 */
function noteIfWorkflowNoProgressFired(
  result: WorkflowAgentResult,
  guard: WorkflowNoProgressGuard | undefined,
): WorkflowAgentResult {
  return guard?.fired() === true && result.error !== undefined
    ? {
      ...result,
      error:
        `${result.error} | workflow no-progress watchdog fired: the run was aborted after a long ` +
        `silence window with no protocol event or stream delta. ` +
        `Recovery: check state with subagents action:'list' includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents), then re-dispatch the workflow.`,
    }
    : result;
}

/**
 * AgentOutcome → workflow AgentResult 直映射（SAR outcomeToRunnerResult 的 service
 * 侧等价物）：保留 usage/sessionFile/worktreePath/failureKind 等引擎层字段——
 * outcomeToAgentResult（execution AgentResult）不含这些字段，经它中转会丢 workflow
 * 消费面（usage 进预算、sessionFile/worktreePath 进 returnMeta、failureKind 进
 * 失败分诊）依赖的字段。
 */
function outcomeToWorkflowResult(outcome: AgentOutcome): WorkflowAgentResult {
  return {
    content: outcome.content,
    ...(outcome.failureKind !== undefined ? { failureKind: outcome.failureKind } : {}),
    parsedOutput: outcome.parsedOutput,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
    error: outcome.error,
    sessionId: outcome.sessionId,
    sessionFile: outcome.sessionFile,
    worktreePath: outcome.worktreePath,
    toolCalls: outcome.toolCalls,
  };
}

/**
 * AgentCallOpts → ExecuteOptions 的最小正向映射（record 创建 + identity 解析消费面；
 * host-task-spec.executeOptionsToEngineTaskSpec 的逆映射）。slug 推导 = 唯一规则
 * （description ?? agent ?? "unknown"，超长按 SLUG_MAX_LENGTH 截断；原 pump
 * dispatchAgentCall trace 命名同源规则随 [H2 W3] 删除）。returnMeta/scene 等
 * worker 层/引擎层独有字段不入 record
 * 消费面（taskSpec 装配走 opts 原样直传，不经本映射）。
 */
function workflowCallToExecuteOptions(opts: AgentCallOpts): ExecuteOptions {
  const agentName = opts.description ?? opts.agent ?? "unknown";
  const slug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  return {
    task: opts.prompt,
    slug,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.skillPath !== undefined ? { skillPath: opts.skillPath } : {}),
    ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.schemaEnv !== undefined ? { schemaEnv: opts.schemaEnv } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.graceTurns !== undefined ? { graceTurns: opts.graceTurns } : {}),
    ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
    ...(opts.forkSource !== undefined ? { forkFromSessionFile: opts.forkSource } : {}),
    ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.conversation !== undefined ? { conversation: opts.conversation } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  };
}
