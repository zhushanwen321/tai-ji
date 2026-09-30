// [H3/R4] WorkflowDispatch 聚合（域 #14 的 H2 workflow 族：executeWorkflowAgent +
// runWorkflowEngineTask + 类外派发 helper 整段）——自 SubagentService 上帝类 strangler
// 抽取的第五个聚合文件（设计 docs/architecture/subagent-service-decomposition.md §2.1 域 #14
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
//    sessionRootId 等会话基线运行时可变态经壳 getter 现读；modelService 等 #1 留壳
//    共享依赖 getter 现读同一实例。
// 2. 模块常量 SSOT：PRIORITY_BACKGROUND 已 [R6/D-R4-4] 归一常量叶子文件
//    service-constants.ts（原两聚合重复声明消除，改 import 消费）。
// 3. 只搬不改：两方法 + 类外 5 helper 自壳文件迁移，方法体除依赖通道替换
//    （this.X → this.deps.getY()）外逐字节保留（审计 /tmp/r4-move-audit.py）。

import { getLogger } from "../../core/logger.ts";

import { SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";

import type { AgentResult as WorkflowAgentResult, AgentCallOpts } from "../../orchestration/models/types.ts";
import { SLUG_MAX_LENGTH } from "../../orchestration/models/types.ts";
// [D8 派发期对称校验] pi 引擎模型目录分类裁决（创建期同源消费 model-catalog；
// orchestration → shared 叶子方向，无环）。
import { assertModelInCatalog } from "../../orchestration/model-catalog.ts";
// [D3 协议版 P6] armed 回执落账投递（runId 键入口；observedEvent 消费点）。value
// import 方向 execution/service → orchestration/pump：pump 的传递闭包（persistence/
// assembly/orchestration 内部）不 import execution/service，无循环。
// [U4 → D15/D6] scanRunEvents 迁 terminal-actions（投递域单写者链），供成员复用
// 绑定的 record 读注入面（MemberReusePoolIo 生产装配）。
import { scanRunEvents } from "../../orchestration/terminal-actions.ts";
// [U4] 成员复用池（决策 4/9/10 的机制本体；orchestration → execution 零反向依赖，
// 池的 journal 读写经 io 注入，无环）。
import {
  lookupMemberRecordId,
  registerMemberRecord,
  type MemberReusePoolIo,
} from "../../orchestration/member-reuse-pool.ts";
// [U4] 续写轮 resume 锚点构造单点（chat Continuation 与 workflow 成员续写共用；
// assembly 叶子方向，既有 import 先例）。
import { resumeAnchorOf } from "../assembly/conversation-continuation.ts";
import { mapToWorkflowAgentResult } from "../assembly/agent-result-mapper.ts";
import { updateFromEvent } from "../persistence/execution-record.ts";
import { EngineError } from "../engine/common/errors.ts";
import { assertTaskShapeSupported } from "../engine/common/capability-gate.ts";
import { wireEventJournal } from "../engine/common/journal-wiring.ts";
import type { ExecutionNestingContext } from "../engine/common/nesting-guard.ts";
// [H2 W2 迁移步⑥] mergeRunSignals 提公共 helper（原 SAR 模块内直调）——workflow
// 派发的 timeout+外部 signal 两源合流。
import { mergeRunSignals, type MergedRunSignalHandle } from "../engine/common/run-signals.ts";
import { identityEnvelopeOf } from "../engine/port.ts";
import type { EnginePort, RunContext } from "../engine/port.ts";
import { DEFAULT_ENGINE_ID } from "../engine/registry.ts";
import {
  type EngineRouteResult,
  resolveWorkflowWindowEnginePort,
  routeEngineForHost,
} from "../engine/routing.ts";
import type { AgentOutcome } from "../engine/types.ts";
import type { ModelConfigService } from "../assembly/model-config-service.ts";
import type { AgentConfig } from "../assembly/model-resolver.ts";
import type { NotifyHost } from "../notify/notify-host.ts";
// [R3] ResolvedIdentity 接口本体在 record-access.ts（生产者 resolveIdentity 所属聚合），
// 本聚合单向 type import（D-R3-2 同款非环形态）。
import type { ResolvedIdentity } from "./record-access.ts";
import { createBackgroundStream, type StreamSink, type SubagentStream } from "../assembly/stream-sink.ts";
// 嵌套深度护栏单点（与 run-orchestration 同源；聚合间零互调不受影响——共同 import
// 叶子 helper 文件是既有形态，G2 禁的是两聚合互相 import）。
import { assertNestingDepthWithinLimit } from "../assembly/session-context-resolver.ts";
import type { UiRequestObservability } from "../ui/ui-request-observability.ts";
import {
  DEFAULT_AGENT_NAME,
  type AgentEvent,
  type AgentResult,
  type ExecuteOptions,
  type ExecutionMode,
  type ExecutionRecord,
} from "../assembly/types.ts";
// [R6/D-R4-4] 跨两聚合消费的值语义纯量归一常量叶子文件（聚合→支撑文件方向合法）。
import { PRIORITY_BACKGROUND } from "./service-constants.ts";
import type { AgentStreamSink } from "../../shared/agent-stream.ts";

const logger = getLogger("subagents");

/**
 * [U4 pi-workflow-run-resource-model 决策 7] 成员 revive 通道的三分结果（命中路径
 * 的「按 recordId 取 record + revive 持久化」通道产物，WorkflowDispatchDeps.
 * reviveMemberRecord 的返回判别联合）：
 * - revived：已结束（idle）成员翻回 running 完成并持久化（register + transition
 *   entry 上报；冷重建链内部含翻边与持久化）——调用方直入续写轮；
 * - inFlight：成员原生 running（同名并行派发）——续写轮拒绝（run 内名唯一是 zcode
 *   对齐语义，同 record 并发第二写者 = session 文件双写，fail-fast）；
 * - missing：内存与磁盘均不可达（池命中但 record 消失）——调用方按未命中降级新建。
 */
export type MemberReviveOutcome =
  | { readonly kind: "revived"; readonly record: ExecutionRecord }
  | { readonly kind: "inFlight"; readonly record: ExecutionRecord }
  | { readonly kind: "missing" };

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
 *   与 #1 留壳共享依赖（getModelService / getNotifyHost）。
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
  /** pi 引擎 port 解析（RunOrchestration 组内方法，经壳编排回调）。windowKey =
   *  派发窗口键（workflow 域 = parentRunId）——per-window 引擎经窗口实例解析单点
   *  取用（probe 与 run 同实例），无键 = registry 直取（仅同步只读消费）。 */
  readonly resolveChatEnginePort: (windowKey?: string) => EnginePort;
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
  /** [R3 RecordAccess 显式接口] 按 mode 创建 record 并注册（含 workflow originFields
   *  ——[W0 / D1] originFields 可携带 stepIndex，record 写点的唯一通道）。 */
  readonly createRecordForMode: (
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
    originFields?: { origin: "workflow"; parentRunId: string; stepIndex?: number },
  ) => ExecutionRecord;
  /** NotifyHost（record 级 pending:register 注销面）。 */
  readonly getNotifyHost: () => NotifyHost;
  /** UI streaming sink（内构 background stream 的 widget 通道；SessionBaselines 现读）。 */
  readonly getStreamSink: () => StreamSink | null;
  /** UI observability（stream 通道形态判据 getMode；SessionBaselines 现读）。 */
  readonly getUiObservability: () => UiRequestObservability;
  /** 根 session id（relay 归属键 SESSION_ID 权威源；SessionBaselines 现读）。 */
  readonly getSessionRootId: () => string | null;
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
    stream: AgentStreamSink | undefined,
  ) => void;
  /**
   * [U4 pi-workflow-run-resource-model 决策 7/10] 成员 revive 通道（命中路径的
   * 「按 recordId 取 record + revive 持久化」；壳 subagent-service 装配本体
   * reviveWorkflowMemberRecord）：内存 getMutable → 冷查重建链（chat message 冷
   * 复活同源），idle → running 翻边 + 终态遗留位清除 + register/entry 上报持久化。
   * 三分结果见 {@link MemberReviveOutcome}。
   */
  readonly reviveMemberRecord: (recordId: string) => MemberReviveOutcome;
}

/**
 * 域 #14 workflow 族聚合：workflow 脚本 agent() 派发链（R4 自 SubagentService 抽取）。
 * 壳（subagent-service.ts）经 executeWorkflowAgent 单行转发透传，对外签名零变化。
 */
export class WorkflowDispatch {
  private readonly deps: WorkflowDispatchDeps;

  /**
   * [U4 → D6] 成员复用绑定的 record 读注入面（本聚合单点装配；scan 经
   * terminal-actions 的 scanRunEvents 同源防线，不自建 journal 实例）。append
   * 通道随 [D6] 绑定消解删除——绑定随 agent-started 帧落账（pump dispatchAgentCall
   * 链），登记收尾只改内存（member-reuse-pool.registerMemberRecord）。
   */
  private readonly memberReusePoolIo: MemberReusePoolIo = {
    scanEvents: (runId) => scanRunEvents(runId),
  };

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
   * （adopt 豁免——workflow record 无脚本可回，纳管等待无意义）。
   */
  async executeWorkflowAgent(
    opts: AgentCallOpts,
    parentRunId: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: AgentStreamSink,
    stepIndex?: number,
  ): Promise<WorkflowAgentResult> {
    this.deps.assertReady();
    // 入口校验与嵌套护栏（与 execute/executeAndAwait 同款 BC-12 / T4②；护栏单源
    // session-context-resolver）。
    const execOpts = workflowCallToExecuteOptions(opts);
    this.deps.assertIdleTimeoutMsSafe(execOpts);
    assertNestingDepthWithinLimit(this.deps.getExecNesting().current());

    // ── 八步迁移 ①②③：路由 → 预检 → identity（含非 pi 引擎 model 校验）──
    // 全部先于 record 创建与池 acquire（D3 失败零池占用）。agentConfig 取宽松面
    //（getAgentConfig——路由输入只要 frontmatter engine；显式 ref 解析失败的报错归
    // identity 阶段的 getRequiredAgentConfig，不在路由层重复）。
    const agentConfig = opts.agent ? this.deps.getModelService().getAgentConfig(opts.agent) : undefined;
    const route = await this.routeWorkflowEngine(opts, agentConfig, parentRunId);
    // ② 预检（capability-gate 单点；AgentCallOpts 直传——TaskShapeForGate 是结构子集）
    assertTaskShapeSupported(route.engineId, route.engine.capabilities(), opts);
    // ③ 引擎感知 model 校验（非 pi = validateModelForEngine；pi = D8 派发期对称
    // 校验，详见 resolveWorkflowIdentity）+ identity 解析 +
    // record 引擎留痕盖章（详见 stampWorkflowEngineTrace）。
    const identity = await this.resolveWorkflowIdentity(route, opts, execOpts, agentConfig);
    this.stampWorkflowEngineTrace(route, execOpts);

    // ── [U4 pi-workflow-run-resource-model 决策 10] 成员复用入口分岔（record 创建
    //    前——上方路由/预检/identity 的同步拒绝序列原样先行，D3 顺序红线保持）。
    //    复用键 name = opts.description ?? opts.agent（与 pump dispatchAgentCall 的
    //    agentName 同口径，决策 4）；双缺省 = 无身份键，不进复用（每次调用各建成员，
    //    防无名调用塌缩共享同一身份）。命中 → 既有成员 revive 拉起 + Continuation
    //    续写轮（编排层内部直调，不经外部 message 通道——域边界约束 C-ext-28）；
    //    未命中 → 现状新建路径 + 登记。
    const memberName = opts.description ?? opts.agent;
    if (memberName !== undefined) {
      const memberRecordId = await lookupMemberRecordId(parentRunId, memberName, this.memberReusePoolIo);
      if (memberRecordId !== undefined) {
        const revived = this.deps.reviveMemberRecord(memberRecordId);
        if (revived.kind === "revived") {
          const effectiveSignal = signal ?? revived.record.controller?.signal;
          return this.runWorkflowEngineTask(
            revived.record,
            opts,
            identity,
            route.engine,
            effectiveSignal,
            onEvent,
            stream,
            { recordId: revived.record.id, resume: resumeAnchorOf(revived.record) },
          );
        }
        if (revived.kind === "inFlight") {
          // run 内名唯一（zcode 对齐语义）——同名并行第二写者 = 同一 session 文件
          // 双写，fail-fast 拒绝（脚本观察到本 call 失败，已飞成员不受影响）。
          throw new Error(
            `workflow member "${memberName}" (record ${memberRecordId}) is still running — ` +
            `a run must not have two agent() calls with the same name in flight (zcode-aligned ` +
            `name uniqueness). Recovery: await the in-flight call, or use a distinct name ` +
            `(e.g. \`${memberName}-2\`) for the concurrent call.`,
          );
        }
        // missing：池命中但 record 不可达（磁盘被清等实施外损耗）——按未命中降级
        // 新建 + warn 留痕（决策 9「fold 后仍缺项 → 未命中新建 + warn」的落点；
        // 下方登记的换绑 warn 与本 warn 共同留痕）。
        logger.warn(
          `[subagents] member reuse pool hit for run ${parentRunId} (name "${memberName}" → ` +
          `record ${memberRecordId}) but the record is not recoverable — dispatching a new ` +
          `member instead (conversation history of the old record is lost).`,
        );
      }
    }

    // ── record 注册（origin:"workflow" + parentRunId + stepIndex；record 级
    //    pending:register 照旧——与既有派发路径同款）──
    const record = this.deps.createRecordForMode(identity, execOpts, "background", {
      origin: "workflow",
      parentRunId,
      stepIndex,
    });
    this.deps.getNotifyHost().emitPendingRegister(record.id, record.agent);
    // [U4 决策 9] 登记（每个 name 仅首次派发时一次；续聊 revive 复用同一映射不发新
    // 事件）。写入序红线在池内：先 append 登记事件、后改内存池；append 失败 fail-fast
    //（不留无 journal 证据的内存孤项）。
    if (memberName !== undefined) {
      await registerMemberRecord(parentRunId, memberName, record.id, this.memberReusePoolIo);
    }

    const effectiveSignal = signal ?? record.controller?.signal;
    return this.runWorkflowEngineTask(record, opts, identity, route.engine, effectiveSignal, onEvent, stream);
  }

  /** [executeWorkflowAgent 阶段拆分] 八步迁移①：引擎路由（D2 单轨——统一经
   *  routeEngineForHost：三层输入 + probe 守卫 + pi 同步短路）+ Promise 决议。
   *
   *  [U2 pi-workflow-run-resource-model] probe 通道窗口实例改道：probe 与
   *  getEngineFn 注入同一来源（resolveWorkflowWindowEnginePort，parentRunId = 本 run
   *  的派发窗口键）——per-window 引擎窗口内首触创建登记、后续复用，probe 调用对
   *  其零 registry 触达（getEngine 惰性单例是薄壳跨窗口常驻的根源）；shared-service
   *  引擎透传 registry（现状保形）。probe 与取用必须同实例（probeCache 在实例上，
   *  分叉 = probe 探窗口实例、run 走 registry 单例——窗口收尾 dispose 掉探过的
   *  实例而真正服务 run 的单例反而常驻）。 */
  private async routeWorkflowEngine(
    opts: AgentCallOpts,
    agentConfig: AgentConfig | undefined,
    parentRunId: string,
  ): Promise<EngineRouteResult> {
    const modelService = this.deps.getModelService();
    modelService.assertGlobalConfigReadable();
    const routed = routeEngineForHost({
      routing: {
        callEngine: opts.engine,
        agentEngine: agentConfig?.engine,
        globalDefaultEngine: modelService.getGlobalConfig().defaultEngine,
      },
      probe: (engineId) => resolveWorkflowWindowEnginePort(parentRunId, engineId).probe(),
      // [U2 pi-workflow-run-resource-model] pi 同步短路位的 piEngine 注入同样携带
      // parentRunId 窗口键：pi 请求经 routeEngineForHost 短路返回本 port，是成员任务
      // engine.run 的实际执行体——无窗口键会拿到 registry 只读代理，per-window 引擎
      // 首 run 即 WindowScopeEngineError 拒答（2026-09-27 batch-s4 真机首跑实锤）。
      // 携带后与 probe/getEngineFn 同一窗口实例（probe 与 run 同实例，收尾 dispose
      // 同窗），shared-service 引擎透传 registry 保形。
      piEngine: this.deps.resolveChatEnginePort(parentRunId),
      // [U2] probe 通过后的取用与 fallback 兜底取用（routing.ts:451 注入位）同口径
      // 改道——两通道解析同一窗口实例。
      getEngineFn: (engineId) => resolveWorkflowWindowEnginePort(parentRunId, engineId),
    });
    return routed instanceof Promise ? await routed : routed;
  }

  /** [executeWorkflowAgent 阶段拆分] 八步迁移③：引擎感知的 model 校验 + identity 解析。
   *
   * 非 pi 引擎：经 resolveIdentityForEngine 内的 validateModelForEngine（与 chat 域
   * executeViaEngine 同一入口同一文案；model 源 = 显式 opts.model > agent frontmatter
   * ——u-h2 D2-1③ 同款）。model 源非空时同步覆写 execOpts.model（record 留痕 +
   * taskSpec 直传一致）。
   *
   * [D8 派发期对称校验] pi 引擎：对称补齐目录校验——脚本内 agent({model}) 字面量与
   * agent ref 的 frontmatter model 创建期不可静态可得（JS 动态求值），在此 identity
   * 解析处（路由后、record 创建/池 acquire 前）经模型目录分类裁决：查无 → 同步抛错
   * 附可用清单与漂移分类修复指引，该 ask 派发前失败（烧 token 上限 = run 创建开销 +
   * 已完成 ask）。引擎感知在该点天然成立（isPiRoute 分流）；zcode 引擎 run 走
   * validateModelForEngine 域（builtin:* 套餐族模型空间单独立设计），跳过目录校验
   * 不误拒。identity 解析内部 resolveModel → assertCanonicalModelRef 仍是解析权威
   * （孪生守卫等全量裁决在彼执行，本层只补分类化前置拒单）。
   * 范围限定（用户裁决 2026-09-21）：仅 pi 引擎。 */
  private async resolveWorkflowIdentity(
    route: EngineRouteResult,
    opts: AgentCallOpts,
    execOpts: ExecuteOptions,
    agentConfig: AgentConfig | undefined,
  ): Promise<ResolvedIdentity> {
    const isPiRoute = route.engineId === DEFAULT_ENGINE_ID;
    const engineModel = isPiRoute ? undefined : (opts.model ?? agentConfig?.model);
    if (isPiRoute) {
      const declaredModel = opts.model ?? agentConfig?.model;
      if (declaredModel !== undefined) {
        assertModelInCatalog(declaredModel, this.deps.getModelService().getModelRegistry(), {
          source: "workflow agent call",
        });
      }
    }
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
    return identity;
  }

  /** [executeWorkflowAgent 阶段拆分] record 引擎留痕（盖章规则：pi 纯缺省不盖键，
   *  非 pi 盖 engineId）。原位 mutate execOpts。 */
  private stampWorkflowEngineTrace(route: EngineRouteResult, execOpts: ExecuteOptions): void {
    if (route.engineId !== DEFAULT_ENGINE_ID) {
      execOpts.engine = route.engineId;
    }
  }

  /**
   * executeWorkflowAgent 的执行核（acquire 后主体 + finally 回收）。八步迁移 ④⑤⑥⑦
   * 的落点：
   *   ④ journal 接线（wireEventJournal 单点；taskId = record.id——真实 record 在
   *      store，不再用 SAR 的占位 id）；
   *   ⑤ mergeRunSignals（timeoutMs + 外部 signal 合流）；
   *   ⑥ spawned-children 注册（dispose killAll 收割兜底，键 = record.id——dispose
   *      通道按进程组终止整组的语义保留，宿主停机/引擎退役场景触发）。
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
    stream?: AgentStreamSink,
    /**
     * [U4 pi-workflow-run-resource-model] 会话形态 resume 键（RunContext.resume 契约
     * 位——recordId 关联键 + 续聊锚点）。现状路径（首次派发）不传，wire 上不出现该键
     * （「一次性轮不传」的既有契约保形）；成员复用命中路径经 resumeAnchorOf 携带锚点
     * （pi 续写原 session 文件 / zcode 新 session 注入历史），无锚（首轮从未回填即
     * 不可达的降级形态）时锚点缺省 = 引擎开新 session。
     */
    resume?: RunContext["resume"],
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
    try {
      // timeoutMs + 外部 signal 并入同一合流。
      runSignal = mergeRunSignals(
        signal ?? new AbortController().signal,
        opts.timeoutMs,
      );
      const journalOnEvent = journal.onEvent;
      const observedEvent = (event: AgentEvent): void => {
        // [D5] armed 回执的落账消费点已随占位事件删除（占位形态协议版落地前无
        // 生产写入方——词表无死成员裁决；宿主等待门 remote-engine 的消费面不受
        // 影响，journal 取证通道不再接收回执）。
        // [H2 A3 修复] live reducer 喂入恢复：W3 删 inproc pi 引擎时，原
        // engines/pi/session-runner.ts agentEvent 出口的 updateFromEvent(record, event)
        // 一并消失，协议化 service 侧未重建——record.turns/totalTokens 在 live 通路
        // 零喂入，终态 entry 落盘同为 0（Gate B A3：workflow agent 实际消耗 LLM 而
        // record 恒 0）。此处恢复 workflow 域喂入：reducer 与 journal-replay /
        // session-view-service 重放路径同源（C5 守护），live ≡ replay 构造性成立；
        // 事件序 = 引擎协议事件序，message_end(usage) 携带 token 增量。
        updateFromEvent(record, event);
        journalOnEvent(event);
      };

      const runCtx: RunContext = {
        taskId: record.id,
        // [D4] record 身份信封（引擎写进任务子进程身份 env；构造单点 = identityEnvelopeOf）
        identity: identityEnvelopeOf(record),
        signal: runSignal.signal,
        ctxModel: identity.resolved.model,
        onEvent: observedEvent,
        ...(effectiveStream !== undefined ? { stream: effectiveStream } : {}),
        ...(this.sessionRootId !== null && this.sessionRootId !== ""
          ? { sessionRootId: this.sessionRootId }
          : {}),
        // [U4 成员复用] 会话形态 resume 键（命中路径携带锚点续写原 session；现状
        // 路径 undefined 不上 wire——一次性轮契约保形）。
        ...(resume !== undefined ? { resume } : {}),
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
        // 持久化形状保留字段（record-store 读侧守卫要求非空）；恒 'shared'——
        // [池抽象降级 2026-09-13] 协议面 poolKey 已删，无引擎侧实际值。
        poolKey: SHARED_POOL_KEY,
        journalPath: journal.path,
      };
      const result = this.deps.outcomeToAgentResult(record, outcome);
      // D7 收口（origin 分支在 settleOneShotOutcome 函数顶部；aborted 判外部 signal
      // ——timeout 的 abort 走失败 result 语义，不映射 cancelled）。
      await this.deps.settleOneShotOutcome(record, result, signal?.aborted === true);
      return outcomeToWorkflowResult(outcome);
    } catch (err) {
      // swallow（不 re-throw）：脚本观察到合成 failed result 而非异常（引擎死亡
      // engine_crashed 同路）；record 由失败路径立即终态化（finalizeFailed CAS →
      // finalizeRecord），不保持 running 态。
      // [P1b-1] 静默吞失败路径的终态写入已经 transition 体系收口：deps.finalizeFailed
      // 内部改调 worker-message-pump 的 settleWorkflowRecord 单点（原直写对删除），
      // agent-settled 事件面由 pump call 完成链投递——失败不再绕过状态机体系无痕。
      const failed = await this.deps.finalizeFailed(record, err);
      return mapToWorkflowAgentResult(failed);
    } finally {
      // 先摘信号桥接，再归还池槽与 journal 收口（SAR 同序）。内构 stream 的 widget
      // 清除（dispose）同经 releaseRoundResources 回收。
      runSignal?.dispose();
      this.deps.releaseRoundResources(record, pooled && acquired, effectiveStream);
      await journal.close();
    }
  }
}

// ── [H2 W2] workflow 域派发 helper（executeWorkflowAgent 专用，M3 语义逐项复刻）──

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
    // [D5 诊断引用落账] 失败伴随的 stderr tee 路径透传（引擎终态应答 → call.result
    // → dispatchAgentSettled 载荷；上报判据见 AgentOutcome.stderrTeePath 注释）。
    ...(outcome.stderrTeePath !== undefined ? { stderrTeePath: outcome.stderrTeePath } : {}),
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
/**
 * 字段存在性投影（条件 spread 的查表化承载）：value 非 undefined 时经 project 产出
 * 键值片段，否则空对象——语义等价 `...(x !== undefined ? { key: x } : {})`（仅查
 * undefined，falsy 值照常透传），把逐字段条件分支的复杂度堆叠收敛到单点。
 */
function present<T>(
  value: T | undefined,
  project: (value: T) => Partial<ExecuteOptions>,
): Partial<ExecuteOptions> {
  return value === undefined ? {} : project(value);
}

function workflowCallToExecuteOptions(opts: AgentCallOpts): ExecuteOptions {
  const agentName = opts.description ?? opts.agent ?? "unknown";
  const slug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  return {
    task: opts.prompt,
    slug,
    ...present(opts.agent, (agent) => ({ agent })),
    ...present(opts.model, (model) => ({ model })),
    ...present(opts.thinkingLevel, (thinkingLevel) => ({ thinkingLevel })),
    ...present(opts.skillPath, (skillPath) => ({ skillPath })),
    ...present(opts.appendSystemPrompt, (appendSystemPrompt) => ({ appendSystemPrompt })),
    ...present(opts.schema, (schema) => ({ schema })),
    ...present(opts.maxTurns, (maxTurns) => ({ maxTurns })),
    ...present(opts.graceTurns, (graceTurns) => ({ graceTurns })),
    ...present(opts.fork, (fork) => ({ fork })),
    // forkSource → forkFromSessionFile：两 DTO 键名不同源的显式映射。
    ...present(opts.forkSource, (forkSource) => ({ forkFromSessionFile: forkSource })),
    ...present(opts.worktree, (worktree) => ({ worktree })),
    ...present(opts.cwd, (cwd) => ({ cwd })),
    ...present(opts.idleTimeoutMs, (idleTimeoutMs) => ({ idleTimeoutMs })),
  };
}
