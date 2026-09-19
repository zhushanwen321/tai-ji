// [H3/D-R4-1 兑现] ChatRounds 聚合（Continuation 协作面 + kickOffChatRound 族）——
// 自 run-orchestration.ts 拆出的第三文件（设计
// docs/architecture/subagent-service-decomposition.md §3.1「ConversationContinuation 归
// RunOrchestration 协作面」；拆分预案 = run-orchestration 头部 [G1 超限预授权拆分] 段
// 登记的「备选 = 第三文件再拆 Continuation 协作面」，2026-09-13 design-code-sync 兑现：
// run-orchestration 折算 845 破 800 零余量锁定线，按预案拆出本文件并完成壳装配接线）。
//
// 单一职责：chat 域轮次编排——ConversationContinuation 实例表（continuations，本聚合
// 唯一写者）+ 统一投递入口（deliverChatMessage）+ pi 会话形态轮次 detached 派发主干
//（kickOffChatRound，one-shot 与 Continuation 轮同路）+ one-shot 轮 settled-watchdog
// fire 处置 + 轮末收口协作（finalizeRoundToIdle / consumePendingArchive）+ message
// 资格引擎轴 gate（engineSupportsConversation——[modeless 波1] SP-5 记录级升级门
// canUpgradeToConversation 消亡后的唯一资格判据）+ Continuation 生命周期显式接口（清理/清队/在飞轮
// 查询）。run 域执行入口（execute/executeAndAwait/executeViaEngine）、引擎死亡
// 分诊（adoptOnProcessDeath）、终态收口（settleOneShotOutcome）与
// pool/worktree 资源装配留 run-orchestration。
//
// [G2 / R1 打样模式 3] 与 run-orchestration 零互调零 import：跨文件协作经壳 deps
// 回调编排（workflow-dispatch.ts 同款形态）——
//   - 本聚合 → RunOrchestration：taskSpecWithModel / outcomeToAgentResult /
//     settleOneShotOutcome / writeBindingForRecord / effectiveMaxConcurrentFor /
//     resolveChatEnginePort（壳装配闭包指 runOrchestration 实例方法）；
//   - RunOrchestration → 本聚合：startFirstChatRound（executeViaEngine 的派发调用
//    点，经其 deps 回调；[modeless 波1] 四象限坍缩后唯一派发路径）。
// 两方向均为窄函数接口注入，聚合文件间静态 import 仅 ResolvedIdentity type-only
//（record-access.ts，边界守卫台账登记边）。
// [接线完成 2026-09-13 design-code-sync] 壳（subagent-service.ts）组装 ChatRounds 实例
// 并注入上述双向协作闭包（RecordLifecycle 的 C-4/C-5 回调同步改指本聚合显式接口）；
// run-orchestration 折算行回落至 800 锁定线内，头部自述已按接线后现实校准。
//
// [R1 打样模式——R4 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）——#1 留壳共享依赖
//   （store/modelService/notifyHost/pool/worktreeManager/roundSupervisor）
//   getter 现读同一实例；会话基线运行时可变态
//   （sessionRootId/streamSink/uiObservability/pi/cwd）经壳 getter 现读；R3 聚合显式
//    接口（finalizeFailed/finalizeAborted/idleTimeoutRecycle/archiveRecord）壳装配指
//    RecordLifecycle 实例方法。
// 2. 只搬不改：方法体除依赖通道替换（this.X → this.deps.Y()）外逐字节保留——
//    通道替换清单 = 上方「本聚合 → RunOrchestration」六项协作回调；Continuation
//    协作面内部互调（continuationFor/kickOffChatRound 等）随族同迁，保持 this 直调。
// 3. 模块常量：STALE_CHILD_EXIT_WAIT_MS + delay 随唯一消费主体
//   （killStaleChildBeforeDispatch）自 run-orchestration 迁入；PRIORITY_BACKGROUND /
//    MS_PER_SECOND / SECONDS_PER_MINUTE 消费常量叶子文件 service-constants.ts。

import { getLogger } from "../../core/logger.ts";

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { ConcurrencyPool } from "../assembly/concurrency-pool.ts";
import {
  ConversationContinuation,
  type ContinuationDispatchInput,
  type ContinuationRoundHandlers,
} from "../assembly/conversation-continuation.ts";
import { updateFromEvent } from "../persistence/execution-record.ts";
import { doFinalizeRoundToIdle, type RoundSettlementOutcome } from "../persistence/finalize-record.ts";
// [W1/R1 方案 A] 锚派生单点（reopenRecord 闭包分派）+ zcode 新锚 binding 补写原语
//（D1b 边界③根治——回填点补写对齐 pi 链 writeBindingForRecord）。
import { transcriptAnchorOf } from "../assembly/cold-lookup.ts";
import { persistSettleSnapshot } from "../persistence/record-store-terminal.ts";
import { zcodeAnchorBasePath } from "../persistence/state-marker.ts";
import { SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";
import { killRecordChildWithEscalation, registerSpawnedChildForRecord } from "../engine/host/spawned-children.ts";
import { RemoteEngine } from "../engine/client/remote-engine.ts";
import type { EnginePort, EngineRunResult } from "../engine/port.ts";
import { splitEngineModelRef } from "../engine/model-validation.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "../engine/registry.ts";
import type { AgentOutcome } from "../engine/types.ts";
import { hasLiveProcessHandle } from "../lifecycle/lifecycle-predicates.ts";
import type { ModelConfigService } from "../assembly/model-config-service.ts";
import type { NotifyHost, PiLike } from "../notify/notify-host.ts";
import type { RecordStore } from "../persistence/record-store.ts";
// [R3] ResolvedIdentity 接口本体在 record-access.ts（生产者 resolveIdentity 所属聚合），
// 本聚合单向 type import（D-R3-2 同款非环形态，边界守卫台账登记边）。
import type { ResolvedIdentity } from "./record-access.ts";
import type { RoundSupervisor } from "../round-supervisor/index.ts";
import {
  armMidRoundNoProgress,
  refreshFromProtocolEvent,
} from "../lifecycle/settled-watchdog.ts";
import { createBackgroundStream, type StreamSink, type SubagentStream } from "../assembly/stream-sink.ts";
import type { UiRequestObservability } from "../ui/ui-request-observability.ts";
import { bestEffort } from "../assembly/best-effort.ts";
import type { WorktreeManager } from "../worktree/worktree-manager.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionRecord,
} from "../assembly/types.ts";
import type { ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";
// [R6/D-R4-4] 值语义纯量消费常量叶子文件（聚合→支撑文件方向合法）。
import { PRIORITY_BACKGROUND } from "./service-constants.ts";

const logger = getLogger("subagents");

/**
 * [H1 U2 / 红线②] stale-child 兜底的退出等待窗（ms）：镜像在途子进程活项时，协议
 * cancel（引擎侧 SIGTERM → pi trap flush → 退出）的有界收敛窗。pi 对裸 SIGTERM 做
 * graceful shutdown（窗口几十~几百 ms，见 disposedUiRequestStub 注释实测口径），
 * 300ms 覆盖常见退出路径；残余双写窗与宿主重启窗口同属红线③经验性登记（量级 =
 * 引擎存活期状态错配频次 × 窗内未退出概率，罕见）。
 * [D-R4-1 兑现] 随唯一消费主体（killStaleChildBeforeDispatch）自 run-orchestration 迁入。 */
const STALE_CHILD_EXIT_WAIT_MS = 300;

/** 有界 delay（stale-child 退出窗消费；fire-and-forget 场景不引入 timer 依赖）。
 *  [D-R4-1 兑现] 随唯一消费主体（killStaleChildBeforeDispatch）自 run-orchestration 迁入。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。四类成员：
 * - 断言面（assertReady）：deliverChatMessage 入口就绪门（本体在 SessionBaselines，
 *   壳转发）。
 * - #1 留壳共享依赖 getter（getStore/getModelService/getNotifyHost/getPool/
 *   getWorktreeManager/getCwd/getPi/getRoundSupervisor）：
 *   getter 现读同一实例。
 * - 会话基线 getter（getSessionRootId/getStreamSink/getUiObservability）：initSession
 *   注入的运行时可变态现读（SessionBaselines 经壳 getter 透传）。
 * - R3 聚合显式接口（finalizeFailed/finalizeAborted/idleTimeoutRecycle/
 *   archiveRecord）：意愿动作收口的跨聚合协作（壳装配指 RecordLifecycle 实例方法）。
 * - RunOrchestration 协作回调（taskSpecWithModel/outcomeToAgentResult/
 *   settleOneShotOutcome/writeBindingForRecord/effectiveMaxConcurrentFor/
 *   resolveChatEnginePort）：与 run 域编排共享的编排原语，经壳编排指
 *   runOrchestration 实例方法（G2「经壳编排」形态，workflow-dispatch 同款）。
 */
export interface ChatRoundsDeps {
  /** [D4 下沉] assertReady 断言（本体在 SessionBaselines，壳转发）。 */
  readonly assertReady: () => void;
  /** RecordStore（#1 留壳共享依赖；运行中句柄回填 reportRecordTransition / Continuation
   *  revive register 面 / 轮次簿记原语 markRoundIdle·markRoundStarted·markReopened）。 */
  readonly getStore: () => RecordStore;
  /** ModelConfigService（finalizeRoundToIdle 的 FinalizeDeps）。 */
  readonly getModelService: () => ModelConfigService;
  /** 进程 cwd（Continuation worktree 重建锚点）。 */
  readonly getCwd: () => string;
  /** WorktreeManager（Continuation worktree 重建 + finalizeRoundToIdle 的 FinalizeDeps）。 */
  readonly getWorktreeManager: () => WorktreeManager;
  /** NotifyHost（Continuation 通知面 + one-shot watchdog 失败通知 + FinalizeDeps 注销面）。 */
  readonly getNotifyHost: () => NotifyHost;
  /** ConcurrencyPool（chat 轮次的并发槽）。 */
  readonly getPool: () => ConcurrencyPool;
  /** pi 句柄（worktree 冲突 appendEntry + FinalizeDeps manifest 写失败 appendEntry；
   *  initSession 晚绑定）。 */
  readonly getPi: () => PiLike | null;
  /** 根 session id（relay 归属键 SESSION_ID 权威源；runCtx 注入）。 */
  readonly getSessionRootId: () => string | null;
  /** UI streaming sink（createBackgroundStream 的 widget 通道）。 */
  readonly getStreamSink: () => StreamSink | null;
  /** UI observability（stream 通道形态判据 getMode）。 */
  readonly getUiObservability: () => UiRequestObservability;
  /** [B-6 留壳] 轮次活性监督器（轮次在途记账 noteRunStarted/noteRunEnded）。 */
  readonly getRoundSupervisor: () => RoundSupervisor;
  /** [R3 RecordLifecycle 显式接口] 轮次 run 失败的收尾（kickOffChatRound catch 面）。 */
  readonly finalizeFailed: (record: ExecutionRecord, err: unknown) => Promise<AgentResult>;
  /** [R3 RecordLifecycle 显式接口] one-shot 轮排队中被 abort 的收尾（[U5] cancel 语义
   *  settle）。 */
  readonly finalizeAborted: (record: ExecutionRecord) => Promise<AgentResult>;
  /** [R3 RecordLifecycle 显式接口 / U5] idle 超时进程回收（Continuation closeNow
   *  回调面——收口是用户动作，超时回收不动占用位）。 */
  readonly idleTimeoutRecycle: (record: ExecutionRecord) => Promise<void>;
  /** [R3 RecordLifecycle 显式接口 / U5] close 收口资源编排（consumePendingArchive 挂起消费
   *  点——source 供留痕，调用方保证在收口轮通知送达之后）。 */
  readonly archiveRecord: (record: ExecutionRecord, source: string) => Promise<void>;
  /** [RunOrchestration 协作回调] engine.run taskSpec 装配单一来源（executeOptions
   *  协议映射 + model = record 留痕词形覆盖）。 */
  readonly taskSpecWithModel: (opts: ExecuteOptions, model: string | undefined) => AgentCallOpts;
  /** [RunOrchestration 协作回调] AgentOutcome → execution AgentResult 单一映射源
   * （含 sessionFile 回填 + binding 落盘）。 */
  readonly outcomeToAgentResult: (record: ExecutionRecord, outcome: AgentOutcome) => AgentResult;
  /** [RunOrchestration 协作回调] one-shot 轮终收口（成功/失败 settle + abort cancel
   *  语义 + D7 workflow origin 分支）。[modeless 波1] 消费方只剩 workflow 域
   *  runAndFinalize（chat 域全 record 改经 Continuation 轮终簿记）。 */
  readonly settleOneShotOutcome: (
    record: ExecutionRecord,
    result: AgentResult,
    aborted: boolean,
  ) => Promise<void>;
  /** [RunOrchestration 协作回调] record 绑定 sidecar 写（sessionFile 回填点统一入口，
   *  含 acquireWriteLease 写权声明）。 */
  readonly writeBindingForRecord: (record: ExecutionRecord) => void;
  /** [RunOrchestration 协作回调] 分层并发配额（depth 越深可用配额越少，下限 1）。 */
  readonly effectiveMaxConcurrentFor: (record: ExecutionRecord) => number;
  /** [RunOrchestration 协作回调] pi 引擎 port 解析（resolveRoundEnginePort 的 pi 分支
   *  ——未注册 = 不可用 stub）。 */
  readonly resolveChatEnginePort: () => EnginePort;
}

/**
 * Continuation 协作面聚合：chat 域轮次编排（[D-R4-1 兑现] 自 run-orchestration 拆出）。
 *
 * 字段所有权（r0-inventory 清单①）：#31 continuations（Continuation 实例表）——
 * 本聚合唯一写者；壳 dispose 经 clearContinuations() 显式接口触达（C-4 兑现），
 * 字段壳零感知。
 */
export class ChatRounds {
  private readonly deps: ChatRoundsDeps;

  constructor(deps: ChatRoundsDeps) {
    this.deps = deps;
  }

  // [R4 等价形态复刻] sessionRootId 经 getter 转发 deps（属性访问形态保留——TS 对
  // getter 可做 null 收窄，runCtx 条件 spread 的类型推导与壳内原形态一致；函数调用
  // 形态 this.deps.getSessionRootId() 不参与收窄）。
  private get sessionRootId(): string | null {
    return this.deps.getSessionRootId();
  }

  // [H1 U6] resumesInFlight（record 级在途 resume 守卫，[review MF1]）随 resumeColdRound
  // 退役删除——Continuation 的 activeRunId 同步占位单飞（dispatchRoundGuarded）构造性
  // 承接防双写者语义。chatRoundRoutes（recordId 键反向通道路由表）随 interact 面退役删除。

  /**
   * [H1 U2] ConversationContinuation 实例表（recordId 键）：record 的续聊编排承载
   * （§3.4）。[modeless 波1] 创建点 = 全 record 首轮派发前（四象限坍缩）/ message
   * 到达；清理点 = record 终态化路径（onRecordFinalizedCleanup）。跨重启冷查
   * （cold-lookup）重建会创建新 record 对象——continuationFor 对缓存实例做绑定
   * 一致性检查，换新即重建。
   */
  private readonly continuations = new Map<string, ConversationContinuation>();

  // [H1 U6] 旧 chat 域投递/续轮链已整体退役：deliverToRunning 消费链（V2 决策 3）、
  // resumeColdRound（守卫链 + 执行态信号清除 + resume 锚点组装——迁 Continuation
  // dispatchRoundGuarded / dispatchRoundAsync）、onHotPathSettledWatchdogTimeout
  //（热路径 watchdog 载体——迁 Continuation.onWatchdogFire → onRunSettled 失败分支
  // 统一收口，D7）、EPIPE/steer 协议知识（随 interact 面消亡）。

  /**
   * message 统一投递入口（modeless：全 record）——经 ConversationContinuation.onMessage
   *（§3.4 / D4 状态迁移表 /
   * D2 打断语义）：
   *
   *   - running（轮间 idle）→ 新轮派发（新 run + resume 锚点，record.sessionFile 续写）；
   *   - running（有在途轮）→ D2 打断：abort 在途轮 signal + 消息入队，abort 收敛后
   *     drain（打断即杀，宽限语义随长驻消亡放弃）；
   *   - idle → revive 翻边（引擎 conversation 能力轴 message 资格 + tryEnterRunning）。
   *
   * @param record 目标 record（messageHandler 已做归属校验 + 升级 gate）
   * @param text 消息正文
   */
  async deliverChatMessage(record: ExecutionRecord, text: string): Promise<void> {
    this.deps.assertReady();
    this.continuationFor(record).onMessage(text);
  }

  /**
   * [U5 / §3.2.5 close 顺序约束] closeAfterRound 挂起标志的收口落账消费（原「清标志 +
   * 终态化」退役——终态化改收口落账）。**调用时序 [写死]**：本方法必须在收口轮的轮次
   * 通知送达之后执行（Continuation settle 分支 / kickOffChatRound 主干尾部——
   * route 已过 gate 并写账；收口落账只作用于其后新产生的回注）。
   */
  private async consumePendingArchive(record: ExecutionRecord, source: string): Promise<void> {
    record.closeAfterRound = undefined;
    await this.deps.archiveRecord(record, source);
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
   * [modeless 波1] continuation 必填化：one-shot 主干分支（settleOneShotOutcome 终态
   * 收口 + 尾部回注）随四象限坍缩消亡——全 record 的轮次都是 Continuation 轮
   * （万物可续：轮终 markRoundIdle 留守、失败 MF-6 落 idle 可恢复）。one-shot 语义
   * 终态收口只剩 workflow 域（runAndFinalize → settleOneShotOutcome D7 分支）。
   */
  kickOffChatRound(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    /** 续聊锚点（协议 ResumeAnchor）：run.params.resume.resume。undefined = 新 session。 */
    resume: ResumeAnchor | undefined,
    /** Continuation 轮回调面（[modeless 波1] 必填——见方法头注释）。 */
    continuation: ContinuationRoundHandlers,
  ): void {
    // 创建 streaming 生命周期对象。策略（含 widget 退役步骤 2：GUI + relay 激活时停发
    // 私货、TUI/未激活原样创建、sink 未注入降级 undefined）集中在 createBackgroundStream。
    const stream = createBackgroundStream(record.id, this.deps.getStreamSink(), this.deps.getUiObservability().getMode(), process.env);

    // [H1 U6] recordId 键反向通道路由注册段已随 interact 面退役删除——流式 delta
    // 恒经 run 作用域路由（runId 键 ctx.stream），中段守护刷新由 ctx.onEvent 承担。
    // [U6b / B-routing] 轮次引擎按 record.engine 分派（非 pi 会话轮——zcode cold 续聊
    // 经 dispatchChatRoundForContinuation 进入本主干，钉死 pi 会把 zcode 轮
    // 派给 pi 引擎进程）：pi（缺省）保持 pi 专属解析（未注册 stub 语义零变化）；非 pi
    // 经 registry 直解析（未注册同步 throw——Continuation dispatchRoundAsync 的 catch
    // 承接为失败轮末分流，失败通知可达）。
    const engine = this.resolveRoundEnginePort(record);

    // [W4] 会话形态轮的在途记账：死亡纳管 record 被主 agent resume = 决策收敛
    // （清指引标记与看门狗，回归「该等」）。conversation 形态本就豁免监督域（D8）。
    this.deps.getRoundSupervisor().noteRunStarted(record.id);
    void (async () => {
      try {
        await this.deps.getPool().acquire(priority, this.deps.effectiveMaxConcurrentFor(record), signal);
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
        // [H1 U2] Continuation 轮例外：abort 来源可能是打断（D2——轮级 signal，
        // record 保持 running）而非 cancel（record 级，cancelBackground 已终态化）。
        // 不终态化（abort 不终态化），经 onAbandoned 回流 Continuation（cancel 场景
        // 该回调内终态守卫 early-return，行为等价）。
        continuation.onAbandoned();
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
        // fire 处置：kill + abort 轮 signal（+ stdout-wedge 自愈诊断），run 收敛后
        // 经 Continuation 失败分支统一收口（单写者单路）。
        this.armRoundWatchdog(record, continuation);
        // 协议 run + [H2 Gate B 修复] live reducer 喂入 + [U6b / B-routing] 运行中句柄
        // 回填：闭包装配（observedEvent / backfillRoundHandle）与 RunContext 条件
        // spread [metrics-gate cyclo 偿还 / 行为保持] 原样提取至 runChatRoundViaEngine
        //（判据 / 载荷 / 闭包时序逐字节等价——详细锚点注释随迁该方法）。
        const { outcome } = await this.runChatRoundViaEngine(
          record,
          opts,
          identity,
          signal,
          stream,
          engine,
          resume,
        );
        if (outcome.sessionFile !== undefined) {
          record.sessionFile = outcome.sessionFile;
          // [W1/R1 D1b] 新轮锚确立点清空 transcriptRef：它是「重开已发生、新轮未
          // 确立」窗口内的过渡锚（markReopened 写入的重开时刻旧锚），新锚
          //（sessionFile 派生键）一经确立即过期——残留会让 transcriptAnchorOf 的
          // transcriptRef 优先分支持续读到死锚，下一条消息再次触发 reopen（永久
          // 循环，U1b 专防）。清空后锚派生回落 sessionFile 派生键（与写入值同源）。
          record.transcriptRef = undefined;
          // [UF-1] 轮应答锚点落盘：跨重启后 coldLookupForAction 据此解析 id→file；
          // [D3a 时机①] 统一入口内 acquire 写权声明（fresh 首轮与 resume 续轮同经）。
          this.deps.writeBindingForRecord(record);
        }
        // [H1 U2 / modeless 波1] 轮末分流：run 应答（= agent_settled）回流
        // Continuation——round+1 / 通知 / 交棒 / drain 全在 onRunSettled 单点（D7）。
        continuation.onSettled(outcome);
      } catch (err) {
        // 轮次 run 失败（prepare 期 reject / 引擎进程死亡 / cancel 后未收敛合成终态）：
        // [modeless 波1 / MF-6] 不销毁对话，回退可恢复（session 文件在盘，续聊 run
        // 接续）。cancel 抢先时 record 已终态化（Continuation 内终态守卫），仅吞错。
        continuation.onRejected(err);
      } finally {
        this.deps.getPool().release();
        // streaming widget 清除（轮终，幂等——续轮 delta 落已 dispose 的 stream 为 no-op）。
        stream?.dispose();
        // [W4] 轮收口重评估（死亡纳管 record 的轮终 → 驱动可能又死 → 重新三态判定）。
        this.deps.getRoundSupervisor().noteRunEnded(record.id);
      }
    })();
  }

  // ── kickOffChatRound 派发主干的分段 helper（[metrics-gate cyclo 偿还] IIFE 原地拆解）──
  // 行为保持总依据：各自片段自 kickOffChatRound 的 IIFE 逐字节搬移（判据 / 调用次序 /
  // 回调闭包时序零变化）；分流判据在调用点保留，分段体内的 await 链与原内联形态同构。

  /** [F-2 轮 arm / modeless 波1] fire 处置：kill + abort 轮 signal（Continuation
   *  onWatchdogFire——run 收敛后经失败分支统一收口，单写者单路）+ stdout-wedge
   *  自愈诊断（原 one-shot 专属 arm 分支随四象限坍缩并入——全轮次形态统一承接口）。 */
  private armRoundWatchdog(record: ExecutionRecord, continuation: ContinuationRoundHandlers): void {
    armMidRoundNoProgress(record.id, {
      onMidTimeout: (fire) => {
        continuation.onWatchdogFire(fire);
        this.healEngineStdoutWedge(record);
      },
      onSettleTimeout: (fire) => {
        continuation.onWatchdogFire(fire);
        this.healEngineStdoutWedge(record);
      },
    });
  }

  /**
   * 协议 run 的载荷装配与发起（自 IIFE 原样提取）。协议 run 恒为会话形态
   * （[modeless 波1] resume 键恒构造——recordId = 关联键；锚点存在 = 续聊；
   * 应答时点 = agent_settled——轮末分流归属 Continuation onRunSettled）。
   *
   * [H2 Gate B 修复] live reducer 喂入（runWorkflowEngineTask observedEvent 同款）：
   * W3 删 inproc pi 引擎时，原 engines/pi/session-runner.ts agentEvent 出口的
   * updateFromEvent(record, event) 一并消失——chat 轮（Continuation）与 tool
   * one-shot 在 live 通路零喂入，record.turns/totalTokens 恒 0（journal-replay /
   * session-view-service 重放路径反而保真，live ≡ replay 契约被破坏）。此处恢复：
   * reducer 与重放路径同源（C5 守护），事件序 = 引擎协议事件序，message_end(usage)
   * 携带 token 增量。Continuation 轮间共用同一 record 实例（continuationFor 绑定），
   * 跨轮累积天然持续。喂入窗口 = run await 窗口——cancel/watchdog 抢先终态化后 run
   * 收敛前到达的残余事件仅写内存 record 不落盘（终态 entry 已写，后续无
   * reportRecordTransition），且事件流随 kill 枯竭，与 workflow 域修法同一取舍（不
   * 加状态守卫，维持单一形态）。中段守护刷新源①照旧（refreshFromProtocolEvent 在
   * 已交棒/已 fire 时幂等 no-op；one-shot 分支此前不接 onEvent，本修复顺带补齐其
   * 刷新源①）。
   *
   * [U6b / B-routing] 非 pi 会话轮（zcode cold 续聊）的运行中句柄回填通道：每轮
   * session/create 新会话，新 sessionRef 经 onHandleReady 回传——**覆写**语义，
   * 刻意区别于 one-shot 回填的按字段补缺语义（one-shot 单轮 + LC-4 迟到补发
   * 用补缺；cold 续聊每轮换锚，旧 sessionId 必须被替换——否则
   * transcriptAnchorOf 派生的 resume 锚停在旧 session，引擎侧注入的历史每轮缺最新
   * 一轮）。落 entry 经 store.reportRecordTransition（appendEvent 既有 engineHandle
   * 投影通道——GUI 经 entry 重建 record 即拿到新锚）。pi 不挂本回调：pi 会话锚是
   * outcome.sessionFile 回填面（调用方 writeBindingForRecord），pi 行为零变化。
   */
  private async runChatRoundViaEngine(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    stream: SubagentStream | undefined,
    engine: EnginePort,
    resume: ResumeAnchor | undefined,
  ): Promise<EngineRunResult> {
    const observedEvent = (event: AgentEvent): void => {
      updateFromEvent(record, event);
      refreshFromProtocolEvent(record.id);
    };
    // [modeless 波1] 运行中句柄回填的两段语义（每 run 局部状态——承接 one-shot
    // 单轮按字段补缺 + 每轮换锚两形态的并集）：
    //   - 本 run 首回调 = 权威整替（zcode 每轮 session/create 的新 sessionRef 必须
    //     覆盖旧轮锚点——旧 sessionId 残留会把 resume 锚停在旧 session）；
    //   - 后续回调 = 按字段补缺（LC-4 迟到只补 sessionFile 的 partial 不丢
    //     dbPath/sessionId；冲突值不覆盖已落位值——幂等）。
    let roundHandleEstablished = false;
    const backfillRoundHandle = (partial: { sessionRef: Record<string, string> }): void => {
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(partial.sessionRef)) {
        if (value !== undefined && value !== "") filtered[key] = value;
      }
      if (!roundHandleEstablished) {
        roundHandleEstablished = true;
        record.engineHandle = {
          ...(record.engineHandle ?? {}),
          sessionRef: filtered,
          // 持久化形状保留字段（record-store 读侧守卫要求非空）；恒 'shared'——
          // [池抽象降级 2026-09-13] 协议面 poolKey 已删，无引擎侧实际值。
          poolKey: SHARED_POOL_KEY,
        };
        // [W1/R1 D1b] 新轮锚确立点（zcode 侧）：① 清空 transcriptRef 过渡锚——
        // 语义与 pi sessionFile 回填点同构（死锚残留会让下一条消息经
        // transcriptAnchorOf 的 transcriptRef 优先分支再次触发 reopen，U1b 专防）；
        // 先清再派生，锚回落刚覆写的 engineHandle.sessionRef 派生键。
        // ② 补写新锚 binding（persistSettleSnapshot merge-or-create，best-effort
        // 同 pi 链 writeBindingForRecord 记账面）——消 D1b 边界③双引擎不对称：
        // 此前本回填点只落 entry 不写 binding，重开窗口内崩溃重启后新锚下
        // epoch/统计基线从零开始（违反「epoch 随 binding 持久化是硬要求」）。
        record.transcriptRef = undefined;
        const freshAnchor = transcriptAnchorOf(record);
        if (freshAnchor !== undefined && freshAnchor.engine === "zcode") {
          persistSettleSnapshot(zcodeAnchorBasePath(freshAnchor), record, freshAnchor);
        }
        this.deps.getStore().reportRecordTransition(record);
        return;
      }
      const current = record.engineHandle;
      if (current === undefined) return;
      const merged: Record<string, string> = { ...current.sessionRef };
      let filled = false;
      for (const [key, value] of Object.entries(filtered)) {
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
    return engine.run(
      // resume 锚点轮引擎侧覆盖 model 解析（taskSpec 装配单一来源见 taskSpecWithModel）。
      this.deps.taskSpecWithModel(opts, record.model),
      {
        taskId: record.id,
        signal,
        ...(stream !== undefined ? { stream } : {}),
        ctxModel: identity.resolved.model,
        onEvent: observedEvent,
        // [U6b / B-routing] 非 pi 会话轮挂 onHandleReady（见 backfillRoundHandle）。
        ...(engine.id !== DEFAULT_ENGINE_ID
          ? { onHandleReady: backfillRoundHandle }
          : {}),
        // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）。
        // 本方法是 pi 引擎 background 轮次派发的主路径（含一次性任务——modeless
        // 下同走会话形态 resume 键），漏注 = pi child exit 13。
        ...(this.sessionRootId !== null && this.sessionRootId !== ""
          ? { sessionRootId: this.sessionRootId }
          : {}),
        // [modeless 波1] D10 终止链接线（原 runEngineTask 专属——已删，随四象限坍缩并入统一
        // 轮次面）：engine spawn 的子进程注册进 spawnedChildren 记账（cancelBackground
        // SIGTERM / dispose killAll 收割对引擎 per-run 子进程生效）。
        onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
        // [modeless 波1→波2·core→cli 接缝] 会话形态由 resume 键携带（唯一形态键）：
        // pi-cli 引擎内建唯一轮终语义 = agent_end 收敛不 kill + agent_settled resolve
        // 并收割（[modeless 波2] SpawnRunParams.chatMode 过渡桥已删）——万物可续 =
        // 所有 run 都走轮次语义。续聊轮带锚点（resume.resume），
        // 首轮 / fresh session 无锚点（引擎开新 session，锚由 run 应答回填）。
        resume: {
          recordId: record.id,
          ...(resume !== undefined ? { resume } : {}),
        },
      },
    );
  }

  /**
   * [stdout-wedge self-heal / modeless 波1] settled-watchdog fire 的引擎 stdout 腿
   * 楔死自愈段（原 one-shot 轮专属，随四象限坍缩并入 Continuation 轮 watchdog fire
   * 处置）：零事件判据（eventsReceivedForRun === 0）→ warn 点名诊断；零事件且仅
   * 本 run 在册（activeRunCount() === 1，无并发 run 连坐）→ 杀引擎（
   * killEngineForStdoutWedge → killAll 组杀），下次派发 respawn 新引擎。
   *
   * 设计依据（2026-09-15 实证事故）：单一引擎进程（TaiJi-as-node 子进程，stdio
   * socketpair）前 3 个 run 的引擎→宿主事件通知全部静默丢失（宿主零 journal、run()
   * 永不 resolve、settled-watchdog 30 分钟后 fire 误报失败），同一引擎后续 run 又全部
   * 正常——传输层物理完好，事件在引擎侧写出后丢失（疑似 Bun×Electron-as-node×
   * socketpair 冷启动楔死，fire 时段的 kill 操作疑似「踢活」了流）。本段把静默楔死
   * 变成 fire 时的自愈 + 可诊断。
   *
   * 访问路径：record.engine → resolveRoundEnginePort（pi = deps.resolveChatEnginePort，
   * 非 pi = registry getEngine）→ cli 形态 port 即 RemoteEngine → protocolClient
   * （EngineClient 诊断/自愈面）。非 cli 形态（pi 未注册 stub）无协议客户端可判——
   * 零动作；引擎解析失败（未注册非 pi id）debug 留痕零动作（fire 主处置已收口，不因
   * 自愈段报错冒泡）。
   *
   * 分级：零事件但有其他活跃 run → 只诊断不杀（组杀会连坐并发 run 的在途事件流；
   * workflow 域挂载点为后续工作——本期范围 = one-shot chat 域）；事件计数 >0 =
   * 正常超时类 fire，零动作（行为零变化）。
   */
  healEngineStdoutWedge(record: ExecutionRecord): void {
    let engine: EnginePort;
    try {
      engine = this.resolveRoundEnginePort(record);
    } catch (err) {
      logger.debug(
        `[subagents] stdout-wedge self-heal skipped: engine port resolution failed for ${record.id} (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return;
    }
    if (!(engine instanceof RemoteEngine)) return;
    const client = engine.protocolClient;
    if (client.eventsReceivedForRun(record.id) > 0) return; // 正常超时类 fire——零动作
    logger.warn(
      `[subagents] engine stdout leg wedge suspected (zero events received for this run; ` +
        `relay log at ~/.taiji/logs/pi-relay-<date>-${record.id}.jsonl is the evidence source) — ` +
        `2026-09-15 incident shape: engine→host notifications were silently dropped for the first runs ` +
        `of a fresh engine process while later runs on the same engine were fine (cold-start stdout wedge). ` +
        `Verify in the relay log whether the engine wrote frames the host never received.`,
    );
    if (client.activeRunCount() !== 1) {
      // 其他活跃 run 在册——组杀会连坐其事件流（本期范围：one-shot chat 域只诊断
      // 不杀；workflow 域挂载点为后续工作）。
      return;
    }
    void client
      .killEngineForStdoutWedge(
        `settled watchdog fired with zero engine events for run ${record.id}`,
      )
      .catch((err: unknown) => bestEffort(err, "stdout-wedge self-heal engine kill"));
  }

  // [H1 U6] chat 域相位机整族已随旧协议轮次相位通道退役删除（语义迁移归属）：
  //   - handleChatRoundPhase（settled/idle/failed/active 相位分诊）
  //     → settle 交棒 = run 应答驱动（Continuation onRunSettled 内
  //     noteRoundSettledFromProtocol，先于轮终簿记）；armMidRoundNoProgress 挂载 =
  //     kickOffChatRound 轮开跑 arm；中段刷新 = run 事件通道 9 种既有事件。
  //   - armChatIdleTimer（idle 相位帧 → idle timer 挂载）→ 相位帧消费面退役；
  //     [u7a 重接] arm 语义由 Continuation.settleRoundSuccess 轮终簿记后的
  //     armIdleKeepalive 承载（活句柄保活 + D5 在途推送，见 conversation-continuation.ts）
  //     ——30 天 idle-gc 只回收内存不终态化不变。
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

  /**
   * [U6b / B-routing] 会话轮引擎解析按 record.engine 分派（kickOffChatRound 主干）：
   *   - pi（engine 未盖章 / 显式 'pi' / pi 兜底盖章）：pi 专属解析（resolveChatEnginePort
   *     ——未注册返回不可用 stub，拒绝点延迟到首次 run，pi 既有行为零变化）；
   *   - 非 pi（zcode 等，Continuation dispatchChatRoundForContinuation 唯一
   *     可达）：registry 直解析（getEngine）——未注册同步 throw EngineNotFoundError，
   *     kickOffChatRound 的 Continuation 调用点在 dispatchRoundAsync 的 try 内，同步
   *     throw 被 catch 转失败轮末分流（失败通知可达，record 保持可续聊）。
   */
  private resolveRoundEnginePort(record: Pick<ExecutionRecord, "engine">): EnginePort {
    const engineId = record.engine ?? DEFAULT_ENGINE_ID;
    if (engineId === DEFAULT_ENGINE_ID) return this.deps.resolveChatEnginePort();
    return getEngine(engineId);
  }

  /**
   * 首轮派发入口（[D-R4-1 兑现] RunOrchestration.executeViaEngine 的 Continuation
   * 协作回调面；[modeless 波1] 四象限坍缩后的唯一派发路径）：continuationFor
   * ensure + startFirstRound（首轮 task = dispatchRound([opts.task])，无 resume——
   * 新 session，锚点由 run 应答回填）。opts 全量透传（保 schema/maxTurns 等首轮
   * 声明——Continuation 续轮按 record 最小重建；identity 从 record.model 重建等价）。
   */
  startFirstChatRound(record: ExecutionRecord, opts: ExecuteOptions): void {
    this.continuationFor(record).startFirstRound(opts);
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
      notifyComplete: (rec) => this.deps.getNotifyHost().notifyComplete(rec),
      notifyRecord: (n) => this.deps.getNotifyHost().notify(n),
      killStaleChild: (id) => this.killStaleChildBeforeDispatch(id),
      killRoundChild: (id, source) => this.killRoundChildForWatchdog(id, source),
      engineSupportsConversation: (rec) => this.engineSupportsConversation(rec),
      reviveClosedRecord: (rec) => {
        // D4 revive 宿主面：register（跨重启重建后不在内存的形态）+ 迁移上报
        //（W16 类外状态写点同构——entry 落盘，live/reload 视图同步）。
        this.deps.getStore().register(rec);
        this.deps.getStore().reportRecordTransition(rec);
      },
      // [U4 / §3.2.3] reopen 降级原语接线：锚失效 → store.markReopened（同 id 带
      // 历史重开——round 归零 + epoch+1 + stopReason=reopened + 新锚 binding 落盘）。
      // [W1/R1 方案 A] 锚入参经 transcriptAnchorOf 单点派生（引擎中立判别联合——
      // pi = sessionFile、zcode = engineHandle.sessionRef {sessionId,dbPath}，与
      // 判活 isAnchorResolvable / fork 守卫共享同一派生逻辑，无双源）。pi 锚取
      // rec.sessionFile 派生键（每轮回填更新，绕开 transcriptRef 过渡死锚——D1b
      // 清空后 transcriptRef 只在「重开已发生、新轮未确立」窗口内有值）；zcode 锚
      // 派生自 engineHandle.sessionRef。undefined = 无锚（从未开跑）——无世代可
      // 推进，返回 false 由调用方降级（派发守卫按全新 session 直派，不在此路径：
      // reviveOrThrow 仅在锚在且不可解析时调用本闭包）。
      reopenRecord: (rec) => {
        const anchor = transcriptAnchorOf(rec);
        if (anchor === undefined) return false;
        return this.deps.getStore().markReopened(rec, anchor);
      },
      // [U2b 修复轮/D2] 轮始簿记（store.markRoundStarted）——Continuation 的唯一轮始写点。
      markRoundStarted: (rec) => {
        this.deps.getStore().markRoundStarted(rec.id);
      },
      // [U5] idle keepalive 超时 = 进程回收（收口是用户动作 close 专属，
      // 超时不是用户动作；record 保持 idle 可续聊，锚在）。
      closeNow: (rec) => this.deps.idleTimeoutRecycle(rec),
      // [U5 / §3.2.5 顺序约束] closeAfterRound 挂起的 chat 域收口落账消费点（Continuation
      // settle 分支在轮次通知送达后调用）——清标志 + 收口落账（one-shot 主干与 chat 域
      // 共用 consumePendingArchive 单点，防标志清写漂移）。
      archiveAfterClosingRound: (rec) => this.consumePendingArchive(rec, "closeAfterRound (chat)"),
      // [U5 / §3.2.5] worktree 绑定丢失自动重建（三失败形态在 outcome 判别联合内）。
      // [S5 修复] repoPath 传进程 cwd——与 create() 的 mainCwd 同源（record/session/
      // binding 全按 encodeCwd(cwd) 物理分区，扫得到 record 的进程 cwd 必与创建时
      // 一致）；reconstruct 不再依赖注册表反查（收口 cleanup 已删条目）。
      rebuildWorktree: (rec) =>
        this.deps.getWorktreeManager().reconstruct(this.deps.getCwd(), rec.id, rec.patchFile),
      // [U5 / §3.2.5 形态②] apply 冲突用户可见提示（entry 落主 session，含 patch
      // 备份路径——prompt 前缀通道由 Continuation worktreeNotice 承担，双通道互补）。
      notifyWorktreeConflict: (recordId, patchFile) => {
        this.deps.getPi()?.appendEntry?.("subagent:worktree-rebuild-conflict", {
          id: recordId,
          patchFile,
        });
      },
    });
    this.continuations.set(record.id, created);
    return created;
  }

  /**
   * 泛化派发主干的 Continuation 轮入口（§3.4 ②载荷组装——归自 resumeColdRound
   * 现有实现）：model 身份重建（splitEngineModelRef，防多轮模型漂移探针 P-10）、
   * ExecuteOptions 组装（worktree 句柄）、detached 交棒 kickOffChatRound（priority
   * = background，轮次在 background 跑）。
   *
   * [modeless 波1] 首轮全量声明透传：input.firstRoundSpec（executeViaEngine 的
   * opts）存在时优先消费——schema/maxTurns/skillPath 等首轮声明不因走 Continuation
   * 编排而丢失（旧 chatMode 首轮亦有此缺口，坍缩后一并修复）；缺省（续轮）按
   * record 最小重建。task 恒以 input.task 为准（守卫段可能注入 reopen 摘要 /
   * worktree 重建提示前缀），worktree 恒以 record.worktreeHandle 现值为准。
   * identity 恒从 record.model 重建（resolved 留痕词形往返自洽，等价；[R4/D6-④]
   * record.model 缺席 = 用户未指定 → resolved.model 留空、任务不带 model，与首轮
   * 「缺席不盖章」同语义）。
   */
  dispatchChatRoundForContinuation(record: ExecutionRecord, input: ContinuationDispatchInput): void {
    const spec = input.firstRoundSpec;
    // [R4/D6-④] 续聊 identity 重建对 record.model 判空：undefined = 用户未指定模型
    //（引擎自身缺省解析）——跳过 splitEngineModelRef 重建、resolved.model 留空，
    // 与首轮「缺席不盖章」同语义（禁空串哨兵：读侧水合归一后 "" 不再产生）。
    const splitModel =
      record.model !== undefined && record.model !== "" ? splitEngineModelRef(record.model) : undefined;
    const identity: ResolvedIdentity = {
      agent: record.agent,
      agentConfig: undefined,
      resolved: {
        model:
          splitModel === undefined
            ? undefined
            : { id: splitModel.id, name: splitModel.name, provider: splitModel.provider, reasoning: false },
        thinkingLevel: record.thinkingLevel,
      },
    };
    const opts: ExecuteOptions =
      spec !== undefined
        ? { ...spec.opts, task: input.task, worktree: record.worktreeHandle }
        : { task: input.task, slug: record.slug, worktree: record.worktreeHandle };
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
   * [modeless 波1] message 资格的引擎能力轴检查（原 SP-5 升级 gate 的 canUpgradeTo
   * Conversation 记录级门删除后保留的引擎轴）：record 所属引擎（engine 留痕 ??
   * 默认引擎）capabilities.conversation 非 'unsupported' 才放行（pi native /
   * zcode cold 均可续）。与 record 无关——万物可续后不存在「一次性 record 不可续」
   * 的记录级形态。引擎未注册 = 无法验证续聊能力，fail-closed 拒绝。消费双写点：
   * ①messageHandler 入口（subagent-actions-core）②Continuation revive 翻边格。
   */
  engineSupportsConversation(record: Pick<ExecutionRecord, "engine">): boolean {
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
   * [R4 / C-4 兑现] Continuation 实例全量清理显式接口——原壳 dispose 直调
   * `this.continuations.clear()` 的跨聚合边（r0-inventory 清单① C-4）：字段所有权
   * 随 Continuation 协作面在本聚合，壳 dispose 编排改调本接口（聚合间零直写，G2）。
   */
  clearContinuations(): void {
    this.continuations.clear();
  }

  /**
   * [R4 / C-5 邻接兑现] Continuation 在途轮打断清队显式接口——原壳装配闭包
   * `this.continuations.get(id)?.abortAndClearQueue()`（RecordLifecycle deps 的
   * abortContinuationQueue 回调）：回调经壳装配指本聚合接口。
   */
  abortContinuationQueue(recordId: string): void {
    this.continuations.get(recordId)?.abortAndClearQueue();
  }

  /**
   * [U5] Continuation 仅清队接口（不打断在飞轮）——close 优雅收口的排队消息作废
   * （close 意愿优先；在飞轮照常跑完，轮终 settle 后收口落账）。
   */
  clearContinuationQueue(recordId: string): void {
    this.continuations.get(recordId)?.clearQueue();
  }

  /**
   * [U5] 在飞轮查询（Continuation.activeRunId 权威）——close 优雅收口 vs 立即收口落账
   * 的分流判据。进程镜像判据（isResumable）对协议轮存在 spawn 窗/镜像未注册的
   * 误判面，在飞轮状态是单一权威。
   */
  hasActiveContinuationRound(recordId: string): boolean {
    return this.continuations.get(recordId)?.hasActiveRound === true;
  }
}
