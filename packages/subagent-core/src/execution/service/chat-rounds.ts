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
// fire 处置 + 轮末收口协作（finalizeRoundToIdle / consumePendingArchive）+ SP-5 升级
// gate（canUpgradeToConversation）+ Continuation 生命周期显式接口（清理/清队/在飞轮
// 查询）。run 域执行入口（execute/executeAndAwait/executeViaEngine）、引擎编排
//（kickOffEngineRun/runEngineTask/adopt）、终态收口（settleOneShotOutcome）与
// pool/worktree 资源装配留 run-orchestration。
//
// [G2 / R1 打样模式 3] 与 run-orchestration 零互调零 import：跨文件协作经壳 deps
// 回调编排（workflow-dispatch.ts 同款形态）——
//   - 本聚合 → RunOrchestration：taskSpecWithModel / outcomeToAgentResult /
//     settleOneShotOutcome / writeBindingForRecord / effectiveMaxConcurrentFor /
//     resolveChatEnginePort（壳装配闭包指 runOrchestration 实例方法）；
//   - RunOrchestration → 本聚合：startFirstChatRound / kickOffChatRound
//    （executeViaEngine 的 chatMode 首轮与 one-shot 派发调用点，经其 deps 回调；
//     kickOffChatRound 回调签名收窄为五参形态——resume/continuation 缺省语义归本聚合）。
// 两方向均为窄函数接口注入，聚合文件间静态 import 仅 ResolvedIdentity type-only
//（record-access.ts，边界守卫台账登记边）。
// [接线完成 2026-09-13 design-code-sync] 壳（subagent-service.ts）组装 ChatRounds 实例
// 并注入上述双向协作闭包（RecordLifecycle 的 C-4/C-5 回调同步改指本聚合显式接口）；
// run-orchestration 折算行回落至 800 锁定线内，头部自述已按接线后现实校准。
//
// [R1 打样模式——R4 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）——#1 留壳共享依赖
//   （store/modelService/notifyHost/pool/worktreeManager/roundSupervisor/
//    collectCoordinator）getter 现读同一实例；会话基线运行时可变态
//   （sessionRootId/streamSink/uiObservability/pi/cwd）经壳 getter 现读；R3 聚合显式
//    接口（finalizeFailed/finalizeAborted/idleTimeoutRecycle/archiveRecord）壳装配指
//    RecordLifecycle 实例方法。
// 2. 只搬不改：方法体除依赖通道替换（this.X → this.deps.Y()）外逐字节保留——
//    通道替换清单 = 上方「本聚合 → RunOrchestration」六项协作回调；Continuation
//    协作面内部互调（continuationFor/kickOffChatRound/onOneShotSettledWatchdogTimeout
//    等）随族同迁，保持 this 直调。
// 3. 模块常量：STALE_CHILD_EXIT_WAIT_MS + delay 随唯一消费主体
//   （killStaleChildBeforeDispatch）自 run-orchestration 迁入；PRIORITY_BACKGROUND /
//    MS_PER_SECOND / SECONDS_PER_MINUTE 消费常量叶子文件 service-constants.ts。

import { getLogger } from "../../core/logger.ts";

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { CollectCoordinator } from "../collect-coordinator.ts";
import type { ConcurrencyPool } from "../concurrency-pool.ts";
import {
  ConversationContinuation,
  type ContinuationDispatchInput,
  type ContinuationRoundHandlers,
} from "../conversation-continuation.ts";
import { updateFromEvent } from "../execution-record.ts";
import { doFinalizeRoundToIdle, type RoundSettlementOutcome } from "../finalize-record.ts";
import { SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";
import { killRecordChildWithEscalation } from "../engine/host/spawned-children.ts";
import type { EnginePort } from "../engine/port.ts";
import { splitEngineModelRef } from "../engine/model-validation.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "../engine/registry.ts";
import type { AgentOutcome } from "../engine/types.ts";
import { hasLiveProcessHandle } from "../lifecycle-predicates.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { NotifyHost, PiLike } from "../notify-host.ts";
// [H1 U2] notify 门（notifier.ts）——轮末回注双闸消费（kickOffChatRound 尾部 +
// onOneShotSettledWatchdogTimeout 失败通知过门）。
import { notifyGateAllowsDelivery } from "../notifier.ts";
import type { RecordStore } from "../record-store.ts";
// [R3] ResolvedIdentity 接口本体在 record-access.ts（生产者 resolveIdentity 所属聚合），
// 本聚合单向 type import（D-R3-2 同款非环形态，边界守卫台账登记边）。
import type { ResolvedIdentity } from "./record-access.ts";
import type { RoundSupervisor } from "../round-supervisor/index.ts";
import {
  armMidRoundNoProgress,
  disarmRoundFromProtocol,
  refreshFromProtocolEvent,
  type SettledWatchdogFireInfo,
} from "../settled-watchdog.ts";
import { createBackgroundStream, type StreamSink } from "../stream-sink.ts";
import type { UiRequestObservability } from "../ui-request-observability.ts";
import type { WorktreeManager } from "../worktree-manager.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionRecord,
} from "../types.ts";
import type { ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";
// [R6/D-R4-4] 值语义纯量消费常量叶子文件（聚合→支撑文件方向合法）。
import { PRIORITY_BACKGROUND, MS_PER_SECOND, SECONDS_PER_MINUTE } from "./service-constants.ts";

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
 *   getWorktreeManager/getCwd/getPi/getRoundSupervisor/getCollectCoordinator）：
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
   *  revive register 面 / 轮次簿记原语 markRoundIdle·markRoundStarted·markReopened·
   *  markReactivated）。 */
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
  /** [R2 SyncCollect 显式接口] collectCoordinator 公共投影（轮末回注 route 投递 +
   *  Continuation routeRecord 回调面）。 */
  readonly getCollectCoordinator: () => CollectCoordinator;
  /** [R3 RecordLifecycle 显式接口] 轮次 run 失败的收尾（kickOffChatRound catch 面）。 */
  readonly finalizeFailed: (record: ExecutionRecord, err: unknown) => Promise<AgentResult>;
  /** [R3 RecordLifecycle 显式接口] one-shot 轮排队中被 abort 的收尾（[U5] cancel 语义
   *  settle）。 */
  readonly finalizeAborted: (record: ExecutionRecord) => Promise<AgentResult>;
  /** [R3 RecordLifecycle 显式接口 / U5] idle 超时进程回收（Continuation closeNow
   *  回调面——归档是用户意愿位，超时回收不动 intent/占用位）。 */
  readonly idleTimeoutRecycle: (record: ExecutionRecord) => Promise<void>;
  /** [R3 RecordLifecycle 显式接口 / U5] 归档资源编排（consumePendingArchive 挂起消费
   *  点——source 供留痕，调用方保证在收口轮通知送达之后）。 */
  readonly archiveRecord: (record: ExecutionRecord, source: string) => Promise<void>;
  /** [RunOrchestration 协作回调] engine.run taskSpec 装配单一来源（executeOptions
   *  协议映射 + model = record 留痕词形覆盖）。 */
  readonly taskSpecWithModel: (opts: ExecuteOptions, model: string | undefined) => AgentCallOpts;
  /** [RunOrchestration 协作回调] AgentOutcome → execution AgentResult 单一映射源
   * （含 sessionFile 回填 + binding 落盘）。 */
  readonly outcomeToAgentResult: (record: ExecutionRecord, outcome: AgentOutcome) => AgentResult;
  /** [RunOrchestration 协作回调] one-shot（非 chatMode）轮终收口（成功/失败 settle
   *  + abort cancel 语义 + D7 workflow origin 分支）。 */
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
   * [U5 / §3.2.5 close 顺序约束] closeAfterRound 挂起标志的归档消费（原「清标志 +
   * 终态化」退役——终态化改归档）。**调用时序 [写死]**：本方法必须在收口轮的轮次
   * 通知送达之后执行（Continuation settle 分支 / kickOffChatRound 主干尾部——
   * route 已过 gate ③收口轮豁免并写账；随后 intent 翻转，归档静默 gate ①只作用于
   * 收口轮之后新产生的回注）。
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
    // [U6b / B-routing] 轮次引擎按 record.engine 分派（非 pi 会话轮——zcode cold 续聊
    // 经 dispatchChatRoundForContinuation 进入本主干，钉死 pi 会把 zcode chatMode 轮
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
        // [U6b / B-routing] 非 pi 会话轮（zcode cold 续聊）的运行中句柄回填通道：每轮
        // session/create 新会话，新 sessionRef 经 onHandleReady 回传——**覆写**语义，
        // 刻意区别于 runEngineTask backfillEngineHandle 的补缺语义（one-shot 单轮 +
        // LC-4 迟到补发用补缺；cold 续聊每轮换锚，旧 sessionId 必须被替换——否则
        // transcriptAnchorOf 派生的 resume 锚停在旧 session，引擎侧注入的历史每轮
        // 缺最新一轮）。落 entry 经 store.reportRecordTransition（appendEvent 既有
        // engineHandle 投影通道——GUI 经 entry 重建 record 即拿到新锚）。pi 不挂本
        // 回调：pi 会话锚是 outcome.sessionFile 回填面（下方 writeBindingForRecord），
        // pi 行为零变化。
        const backfillRoundHandle = (partial: { sessionRef: Record<string, string> }): void => {
          record.engineHandle = {
            ...(record.engineHandle ?? {}),
            sessionRef: { ...partial.sessionRef },
            // 持久化形状保留字段（record-store 读侧守卫要求非空）；恒 'shared'——
            // [池抽象降级 2026-09-13] 协议面 poolKey 已删，无引擎侧实际值。
            poolKey: SHARED_POOL_KEY,
          };
          this.deps.getStore().reportRecordTransition(record);
        };
        const { outcome } = await engine.run(
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
          this.deps.writeBindingForRecord(record);
        }
        if (record.chatMode && continuation !== undefined) {
          // [H1 U2] 轮末分流：run 应答（= agent_settled）回流 Continuation——round+1 /
          // 通知 / 交棒 / drain 全在 onRunSettled 单点（D7）。
          continuation.onSettled(outcome);
        } else {
          // 一次性 run 终态收口（对齐原 settleOneShotOutcome：成功轮 SP-5 回退
          // running-resumable 等待 upgrade；失败/取消一次性销毁）。
          const result = this.deps.outcomeToAgentResult(record, outcome);
          await this.deps.settleOneShotOutcome(record, result, signal?.aborted === true);
        }
        // background 回注：仅当本路径抢到 CAS 才 notify。gate 三元组（[U5 / §3.2.7]）：
        // intent=archived 静默（编排性关闭自动收起）/ 放弃轮标记命中丢弃（cancel 中断
        // 轮防双发）/ 其余放行。
        // [H1 U2] Continuation 轮跳过——通知归属 Continuation 双闸（成功 gate→route /
        // 失败独立载荷过门），本段回注即双 route。
        if (continuation === undefined && notifyGateAllowsDelivery(record)) {
          this.deps.getCollectCoordinator().route(record);
          // [U5 / §3.2.5 close 顺序约束] 收口轮 settle（settleOneShotOutcome）→ 通知
          // 送达（本 route）→ 归档——closeAfterRound 挂起标志的 one-shot 消费点。
          if (record.closeAfterRound === true) {
            await this.consumePendingArchive(record, "closeAfterRound (one-shot)");
          }
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
    // 后走 kickOffChatRound 既有吞错面（CAS 已收口，其 finalizeFailed 前置检查跳过）。
    record.controller?.abort();
    // fire = 本轮等待窗口终结（timer 回调已自删 entry，此处幂等清防御收尾段残留）。
    disarmRoundFromProtocol(record.id);
    // [U5] 失败轮 settle（不终态化——markRoundIdle 保持 running-resumable 万物可续；
    // watchdog 杀轮非用户放弃，不置放弃轮标记——失败通知必须送达，gate ①②不拦）。
    if (record.status !== "running") {
      return; // 已被 cancel/dispose 抢先收口——不重复收尾（watchdog disarm 由对方承接）
    }
    const failReason =
      `subagent did not reach agent_settled (${windowDesc}; settled watchdog); ` +
      `the process was terminated to bound the wait. ` +
      `Recovery: check state with subagents action:'list', then re-send your message to continue.`;
    const failedResult: AgentResult = {
      text: "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: false,
      error: failReason,
      sessionId: record.id,
      toolCalls: [],
    };
    this.deps.getStore().markRoundIdle(record.id, { kind: "failed", reason: failReason });
    // 失败通知（独立载荷过 notifyGate 三元组门——①归档静默/②放弃轮标记阻断）。
    if (!notifyGateAllowsDelivery(record)) return;
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
  }

  // [H1 U6] chat 域相位机整族已随旧协议轮次相位通道退役删除（语义迁移归属）：
  //   - handleChatRoundPhase（settled/idle/failed/active 相位分诊）
  //     → settle 交棒 = run 应答驱动（Continuation onRunSettled 内
  //     noteRoundSettledFromProtocol，先于轮终簿记）；armMidRoundNoProgress 挂载 =
  //     kickOffChatRound 轮开跑 arm；中段刷新 = run 事件通道 9 种既有事件。
  //   - armChatIdleTimer（idle 相位帧 → idle timer 挂载）→ 相位帧消费面退役；
  //     [u7a 重接] arm 语义由 Continuation.settleRoundSuccess 轮终簿记后的
  //     armIdleKeepalive 承载（活句柄保活 + D5 在途推送，见 conversation-continuation.ts）
  //     ——30 天 idle-gc 只归档不终态化不变。
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
   *   - 非 pi（zcode 等 chatMode 轮，Continuation dispatchChatRoundForContinuation 唯一
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
   * chatMode 首轮派发入口（[D-R4-1 兑现] RunOrchestration.executeViaEngine 的
   * Continuation 协作回调面）：continuationFor ensure + startFirstRound（首轮
   * task = dispatchRound([task])，无 resume——新 session，锚点由 run 应答回填）。
   */
  startFirstChatRound(record: ExecutionRecord, task: string): void {
    this.continuationFor(record).startFirstRound(task);
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
      // [U4 / §3.2.3] reopen 降级原语接线：锚失效 → store.markReopened（同 id 带
      // 历史重开——round 归零 + epoch+1 + stopReason=reopened + 新锚 binding 落盘）。
      // 锚入参 = record.sessionFile 路径复用（pi transcript 按路径定位：旧文件已被
      // 回收，续轮 resume:undefined 派发后引擎在同目录开新 session，新锚由 run 应答
      // 回填——writeBindingForRecord 在回填点重写 binding，markReopened 落旧路径旁
      // 的 binding 为过渡死数据，随 session-file-gc 孤儿清理回收）。zcode 锚
      //（sessionId 变更）的重开接线归 U6 transcript 锚单元。
      reopenRecord: (rec) => {
        if (rec.sessionFile === undefined) return false;
        return this.deps.getStore().markReopened(rec, { engine: "pi", sessionFile: rec.sessionFile });
      },
      // [U2b 修复轮/D2] 轮始簿记（store.markRoundStarted）——Continuation 的唯一轮始写点。
      markRoundStarted: (rec) => {
        this.deps.getStore().markRoundStarted(rec.id);
      },
      // [U5] idle keepalive 超时 = 进程回收（不归档——归档是用户意愿位 close 专属，
      // 超时不是用户动作；record 保持 idle 可续聊，锚在）。
      closeNow: (rec) => this.deps.idleTimeoutRecycle(rec),
      // [U5 / §3.2.5 顺序约束] closeAfterRound 挂起的 chat 域归档消费点（Continuation
      // settle 分支在轮次通知送达后调用）——清标志 + 归档（one-shot 主干与 chat 域
      // 共用 consumePendingArchive 单点，防标志清写漂移）。
      archiveAfterClosingRound: (rec) => this.consumePendingArchive(rec, "closeAfterRound (chat)"),
      // [U5 / §3.2.5] worktree 绑定丢失自动重建（三失败形态在 outcome 判别联合内）。
      // [S5 修复] repoPath 传进程 cwd——与 create() 的 mainCwd 同源（record/session/
      // binding 全按 encodeCwd(cwd) 物理分区，扫得到 record 的进程 cwd 必与创建时
      // 一致）；reconstruct 不再依赖注册表反查（归档 cleanup 已删条目）。
      rebuildWorktree: (rec) =>
        this.deps.getWorktreeManager().reconstruct(this.deps.getCwd(), rec.id, rec.patchFile),
      // [U5 / §3.2.2] message 隐含寻回（intent 翻回 active + manifest 投影）。
      reactivateRecord: (rec) => {
        this.deps.getStore().markReactivated(rec);
      },
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
   * （close 意愿优先；在飞轮照常跑完，轮终 settle 后归档）。
   */
  clearContinuationQueue(recordId: string): void {
    this.continuations.get(recordId)?.clearQueue();
  }

  /**
   * [U5] 在飞轮查询（Continuation.activeRunId 权威）——close 优雅收口 vs 立即归档
   * 的分流判据。进程镜像判据（isResumable）对协议轮存在 spawn 窗/镜像未注册的
   * 误判面，在飞轮状态是单一权威。
   */
  hasActiveContinuationRound(recordId: string): boolean {
    return this.continuations.get(recordId)?.hasActiveRound === true;
  }
}
