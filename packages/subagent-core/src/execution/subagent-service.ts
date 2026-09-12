// 执行编排 + 记录领域 Service（D4 按变化轴拆分后的编排核：execute/executeAndAwait 入口、
// record 生命周期、cancel）。通知簇 → notify-host.ts；轮末分流归 ConversationContinuation
//（[H1 U2] §3.4）；冷路径查询链 → cold-lookup.ts（[H1 U6] 原 cold-resurrect.ts 改名落位）。
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigService.initModel。

import { getLogger } from "../core/logger.ts";

import type { AgentResult as WorkflowAgentResult, AgentCallOpts } from "../orchestration/models/types.ts";
import { bestEffort } from "./best-effort.ts";
// [R2] 域 #5 聚合转发 getter 返回类型标注（值装配已迁聚合，仅 type 引用）。
import type { CollectCoordinator } from "./collect-coordinator.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode record 的 disarm 面（终态化/取消
// 路径防误杀）——[R3] 消费已随终态写面迁 service/record-lifecycle.ts；[R4]
// DEFAULT_IDLE_TIMEOUT_MS 消费（assertIdleTimeoutMsSafe 错误文案基准）已随 run 域
// 迁 service/run-orchestration.ts——本文件 lifecycle-manager 零 import。
import { type ConcurrencyPool, DefaultConcurrencyPool } from "./concurrency-pool.ts";
// [R4] execution-record 消费（project/tryTransition/updateFromEvent）已随 run 域迁
// service/run-orchestration.ts（+ workflow-dispatch.ts 的 updateFromEvent）——壳内零消费。
// [R4] doFinalizeRoundToIdle（finalizeRoundToIdle wrapper）已随 run 域迁
// service/run-orchestration.ts——壳内零消费。
// [R4] ConversationContinuation 装配（continuations 队列 + continuationFor）已随域 #14
// Continuation 协作面迁 service/run-orchestration.ts——壳内零消费。
// [R1] 转发 getter 返回类型标注（值构造已迁聚合，仅 type 引用）。
import type { ExecutionNestingContext } from "./engine/common/nesting-guard.ts";
// [R4] mergeRunSignals / executeOptionsToEngineTaskSpec / SLUG_MAX_LENGTH / journal 接线 /
// capability 预检等消费已随 R4 域迁 service/run-orchestration.ts +
// service/workflow-dispatch.ts——壳内零消费（机制注释随消费主体迁移）。
import { setHostUiRequestEndpoint } from "./engine/host/host-ui-endpoint.ts";
import type { HostBridgeServiceFace } from "./engine/host/host-bridge.ts";
// [W6 宿主面下沉 → W3 纯镜像] killAll / killRecord / register 三函数经
// spawnedChildren 状态镜像公共面（engine/host/spawned-children.ts）——子进程活在
// 引擎进程内，本模块只做镜像记账（终止意图位），实际终止经协议 interact cancel/close。
// [R4] killRecordChildWithEscalation / registerSpawnedChildForRecord 消费已随 run 域迁
// service/run-orchestration.ts + workflow-dispatch.ts——壳内剩 killAllSpawnedChildren
//（dispose 收割兜底）。
import { killAllSpawnedChildren } from "./engine/host/spawned-children.ts";
// [R4] 引擎路由/registry/model-validation/engine-sdk 消费已随 run 域与 workflow 族迁
// 两个聚合文件——壳内零消费。
import { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "./model-resolver.ts";
import { type NotifyHost, type PiLike, createNotifyHost } from "./notify-host.ts";
// [T4④ / PS-5] flush 被门拦时的未投递 pending 落盘账本（persistUndeliveredNotificationsForReplay 消费）
// [R2] BatchBudgetParams / BgNotifyRecord 类型引用已随域 #5 聚合迁至 service/sync-collect-domain.ts（壳内零消费）。
// [H1 U2] notify 门迁 notifier.ts（Continuation 双闸共用），此处 re-export 保持既有
// import 路径（测试消费面 `from "../subagent-service.ts"` 不变）。
// [R4] notifyGateAllowsDelivery 的值消费（kickOffChatRound / onOneShotSettledWatchdog
// Timeout 双闸）已随 run 域迁聚合——壳内零值消费，仅保留 re-export（机制不变）。
export { notifyGateAllowsDelivery } from "./notifier.ts";
import { getBoundNotifyLedger, NOTIFY_LEDGER_CUSTOM_TYPE } from "./notify-ledger.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "./path-encoding.ts";
import type { StatusFilter } from "./record-store.ts";
import { RecordStore } from "./record-store.ts";
// [W4] 轮次活性监督器（D2「等待有主」权威层；机制与注释见 round-supervisor/，
// 装配绑定面在 service-binding.ts——变化轴独立）。[B-6/R4] 字段留壳（boot/dispose
// 时序消费在壳 + C-6 装配闭包经壳转发 late-bound）。
import type { RoundSupervisor } from "./round-supervisor/index.ts";
import {
  createRoundSupervisorForService,
  runPendingReconcileSweepForService,
} from "./round-supervisor/service-binding.ts";
import type { StreamSink, SubagentStream } from "./stream-sink.ts";
// [R4] settled-watchdog 全族消费（arm/disarm/refresh）已随 run 域与 workflow 族迁两个
// 聚合文件；hasLiveProcessHandle（killStaleChildBeforeDispatch）已迁 run-orchestration。
// [R4] state-marker（writeRecordBinding）已迁 run-orchestration；EngineSdkError/
// ResumeAnchor（引擎死亡分诊）已迁 run-orchestration。
import type {
  AgentEvent,
  AgentResult,
  ClosedReason,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionRecord,
  RecordSnapshot,
  SubagentRecord,
} from "./types.ts";
// [R4] ExecutionMode / ForkDepthExceededError / DEFAULT_AGENT_NAME / WorktreeHandle 消费
// 已随 run 域迁聚合——types import 收窄为转发签名所需类型面。
import { registerGlobalObservability } from "./ui-request-observability.ts";
// [R1] 转发 getter 返回类型标注（实例已迁聚合，仅 type 引用）。
import type { UiRequestObservability } from "./ui-request-observability.ts";
import { WorktreeManager } from "./worktree-manager.ts";
// [H3/R6] 聚合面接口类型声明（queries/chatActions 消费面 + 构造参数）外移支撑文件
// 后经 type-only import 消费（编译后擦除，与 bootstrap→壳的 SubagentService 值边
// 不构成值环）。
import type {
  SubagentChatActions,
  SubagentQueries,
  SubagentServiceInit,
} from "./service/service-bootstrap.ts";
// [H3/R6] ENV_SELF_RECORD_ID 常量 SSOT 归位常量叶子文件（D-R3-2 兑现，原随域 #2
// 聚合声明）——壳 reconcile sweep 装配闭包判据消费。
import { ENV_SELF_RECORD_ID } from "./service/service-constants.ts";
// [H3/R1] 域 #2 聚合（session 注入 + ALS/嵌套身份基线）——壳经转发 getter/方法透传，
// 对外签名零变化。
import {
  disposedUiRequestStub,
  SessionBaselines,
  type SubagentServiceSessionInit,
} from "./service/session-baselines.ts";
// [H3/R2] 域 #5 聚合（sync 批自闭合语义：collectCoordinator 装配 + E9 转账 + E1 恢复）——
// 检查点① flushBatch 显式依赖注入随聚合落地；C-1/C-2 跨聚合边收敛为其显式接口。
import { SyncCollectDomain } from "./service/sync-collect-domain.ts";
// [H3/R3] 域 #3/#4/#8/#10/#11/#13/#17/#18 聚合（record 读建面 + 终态迁移写面）——壳经
// 转发方法透传，对外签名零变化。[计划变更 D-R3-1] G1 ≤700 与八域体量（833 物理行）
// 冲突，拆两文件（dev agent 停线报告、主 agent 核验追认）：record-access.ts（#3/#8/#10/#13 读建面）+ record-lifecycle.ts
//（#4/#11/#17/#18 终态写面，D5/H4 落点）；两聚合组间零互调零 import，壳分别装配。
// [R4] ResolvedIdentity 的壳内消费（R3 过渡转发签名）已删——type import 随删转发清零。
import { RecordAccess } from "./service/record-access.ts";
import { RecordLifecycle } from "./service/record-lifecycle.ts";
// [H3/R4] 域 #6/#7/#12/#14/#15 聚合（run 域执行编排 + Continuation 协作面）与
// [D-R4-1] 拆分的 workflow 族聚合（executeWorkflowAgent 派发链）——两文件组间零互调
// 零 import（跨文件协作经壳 deps 闭包，G2「经壳编排」形态），壳分别装配、经转发
// 方法透传，对外签名零变化。
import { RunOrchestration } from "./service/run-orchestration.ts";
import { WorkflowDispatch } from "./service/workflow-dispatch.ts";

const logger = getLogger("subagents");

// [R6] 聚合面接口类型声明（SubagentQueries / SubagentChatActions / SubagentServiceInit）
// 已外移支撑文件 service/service-bootstrap.ts——壳经 type-only import 消费（编译后
// 擦除），bootstrap→壳仅存的 SubagentService 值边（createSubagentService 构造依赖）
// 不构成值环（壳对 bootstrap 零 re-export）。

// [v4 A-1] EPIPE 连续失败计数器在 stdin-writer.ts（stdin 错误域，避免 session-runner
// 反向 import 本文件 helper 产生循环依赖）。同步路径（PiEngine 热路径投递，D2 协议知识
// 下沉后）与异步路径（session-runner child.stdin.on('error')）共用 stdin-writer 的同一计数器。

// [R1] disposedUiRequestStub（dispose 后 stub UI handler，含背景/降级语义注释）已随
// 域 #2 聚合迁至 service/session-baselines.ts——壳 dispose 应答端替换经顶部 import 消费。

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *  session_start 时从 ctx.ui 注入，background 执行期间用于把合并后的 text_delta
 *  通过 setWidget 通道转发到 RPC stdout（不经 sendMessage 的持久化路径）。 */
export type { StreamSink } from "./stream-sink.ts";

// pi 依赖端口类型 re-export：测试侧 mock PiLike 历来从本模块取（与 StreamSink 同构的门面模式）
export type { PiLike } from "./notify-host.ts";

/** session_start 注入参数（session 级）。
 *  [R1] 接口本体已迁 service/session-baselines.ts（唯一消费者 SessionBaselines.initSession）；
 *  此处类型别名 re-export 保持既有导出符号面（外部 `from "./subagent-service.ts"` 消费零改动）。 */
export type { SubagentServiceSessionInit };


// [R1] 跨进程身份贯穿 env 名常量（ENV_ROOT_SESSION_ID / ENV_DEPTH / ENV_ROOT_CWD，
// 含 [MF-3] 注释）SSOT 已随域 #2 聚合迁至 service/session-baselines.ts；[R6/D-R3-2]
// ENV_SELF_RECORD_ID 因跨聚合消费（record-access）归位 service/service-constants.ts
// 常量叶子文件——壳经顶部 import 消费（reconcile sweep 装配闭包的判据）。
// [R2] SETTLED_RESCAN_LIMIT 常量 SSOT 已随域 #5 聚合迁至 service/sync-collect-domain.ts
//（唯一消费主体 armSettledRescan）。
// [R3] ResolvedIdentity 接口本体（resolveIdentity 产物）已随读建面迁
// service/record-access.ts——壳经顶部 type import 消费（R4 领地 execute/executeAndAwait/
// workflow 派发链的局部类型标注不变）。

/**
 * 执行编排 Service。进程级单例。
 *
 *   session_start:
 *     1. modelService = getModelConfigService() ?? new ModelConfigService({cwd, agentDir})
 *     2. service = getSubagentService() ?? new SubagentService({cwd, modelService})
 *     3. modelService.initModel({modelRegistry, sessionId, entries})
 *     4. service.initSession({pi, sessionId})
 *
 *   session_shutdown:
 *     service.dispose()
 *
 * 第三宿主不经 session_start 流程时改用 createSubagentService(init) 参数注入构造。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */

export class SubagentService {

  // ── 域 #1 依赖装配（壳组合根；R1-R4 抽取后留壳）（R0 重排）──

  private readonly pool: ConcurrencyPool;
  private readonly store: RecordStore;
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;

  /** [D4-①] 通知簇 host 面（notifyComplete/notifyClosed/pending 注册注销 + notifier
   *  实例封装，原私有通知簇四方法与模块函数的搬移落点——notify-host.ts）。
   *  deps 惰性求值（pi/session 级状态运行时可变），行为与原 constructor 内
   *  createNotifier(this.piAdapter()) 逐字节等价。session_start revive，shutdown dispose。
   *  [sync-collect 合并] toNotifyRecord/notify/notifyBatch 随批路由需要由 host 导出
   *  （collectCoordinator 闭包与 E9/E1 直发路径消费，见 notify-host.ts 接口注释）。 */
  private readonly notifyHost: NotifyHost = createNotifyHost({
    getPi: () => this.pi,
    listRunning: () => this.store.listRunning(),
    getIsIdle: () => this.isIdleFn,
  });

  private readonly manifestStore: ManifestStore;

  /**
   * [D6 #7a] records 目录（与 manifestStore 同源同一推导）——屏障失败 warn 带 manifest
   * 文件路径用（ManifestStore.dir 私有，此处不破封装另存同源值；漂移由构造点同语句保证不发生）。
   */
  private readonly recordsDir: string;

  /**
   * [T1/PS-9] subagent sessionDir（getSubagentSessionDir 推导，与 store 同源同一 rootCwd）。
   * 传给 doFinalizeRecord 的 FinalizeDeps.sessionDir——record.sessionFile 缺失时 finalize
   * 用它做磁盘 identity 反查（marker/alive 清理的依据）。
   */
  private readonly sessionsDir: string;

  constructor(init: SubagentServiceInit) {
    this.cwd = init.cwd;
    this.modelService = init.modelService;
    this.getMainSessionFile = init.getMainSessionFile;
    // [R1] 域 #2 基线聚合：进程级初值（uiRequestHandler / rootCwd env 推导）在聚合构造期
    // 落位；deps 全晚绑定闭包（构造期零求值——store/notifyHost 等后续才构造的依赖经闭包
    // 现读，形态先例 = D4 late-bound getter 与 notifyHost 装配闭包）。
    this.baselines = new SessionBaselines(
      { cwd: init.cwd, uiRequestHandler: init.uiRequestHandler },
      {
        // [D4 late-bound getter `() => ({pi, disposed})`] assertReady 断言状态现读：
        // pi（initSession 时点注入，经壳 getter 透传聚合）+ disposed（壳旗标）。
        readAssertState: () => ({ pi: this.pi, disposed: this._disposed }),
        // session 复活（initSession 内 revive 步骤回调）——旗标写点留壳（断言面同源）。
        reviveDisposed: () => {
          this._disposed = false;
        },
        // [C-2 显式回调 → R2 已对接] #5 SyncCollect 的 settledRescanState 复活重置改指
        // SyncCollectDomain 显式接口（resetSettledRescan）——聚合间零直写（G2）。晚绑定
        // 闭包构造期零求值，syncCollect 后置构造安全（R1 打样时预留的对接点）。
        resetSettledRescan: () => {
          this.syncCollect.resetSettledRescan();
        },
        getStore: () => this.store,
        getNotifyHost: () => this.notifyHost,
        // [跨域编排回调] initSession 复活后编排（R3/R4 域方法；抽取后改指聚合显式接口）。
        recoverOrphans: () => this.recoverOrphansIfRootProcess(),
        bootRoundSupervisor: () => this.roundSupervisor.bootPartition(),
        runPendingReconcileSweep: () =>
          runPendingReconcileSweepForService(
            {
              getStore: () => this.store,
              getPi: () => this.pi,
              getSessionRootId: () => this.sessionRootId,
              getMainSessionFile: () => this.mainSessionFile,
              finalizeClosed: (record, result) => this.finalizeRecord(record, result, "closed", "gc"),
            },
            (process.env[ENV_SELF_RECORD_ID] ?? "") !== "",
          ),
      },
    );
    // [W6 R3 MF-A] 壳侧应答端登记：cli 形态引擎经 host/askUser 反向请求消费（discovery
    // portFactory 构造 EngineClient 时读取该登记）。
    setHostUiRequestEndpoint(init.uiRequestHandler);
    this.pool = new DefaultConcurrencyPool(this.modelService.getGlobalConfig().maxConcurrent);
    this.worktreeManager = new WorktreeManager(this.modelService.getAgentDir());
    // [MF-3] worktree 隔离下全树落盘目录统一到 ROOT cwd：子进程（spawn cwd = worktree checkout 路径）
    // 若按自身 cwd 编码目录，深层 record 写到 enc(worktree) 段，ROOT 磁盘重建扫不到。
    // rootCwd 的 env 推导随域 #2 聚合（session-baselines.ts 构造器）；sessions 与 records 两套
    // 目录必须同源（同一 rootCwd），否则 enc 段不变量断裂（只改其一会让同 record 的
    // session 文件与 manifest 分落两段，GC/重建互相找不到）。
    const sessionsDir = getSubagentSessionDir(this.modelService.getAgentDir(), this.rootCwd);
    const recordsDir = getSubagentRecordsDir(this.modelService.getAgentDir(), this.rootCwd);
    this.sessionsDir = sessionsDir;
    this.recordsDir = recordsDir;
    this.manifestStore = new ManifestStore(recordsDir);
    // [U1 偏差 3 收尾 / D8 v7] 第 4 参 manifestDir 接线（与 manifestStore 同源同一
    // recordsDir，构造点同语句保证不漂移）：终态原语（markFinalized/markCancelled/
    // markBatchFinalized）的 manifest 面走 writeAtomicFileSync 同步落盘——停机窗
    // fire-and-forget 竞态构造性消灭；生产构造点恒传 manifestDir（见下方构造
    // 调用），缺省降级异步分支仅纯内存测试形态可达。
    this.store = new RecordStore(sessionsDir, this.manifestStore, this.pi ?? undefined, recordsDir);
    // [W4 发射点② / U5 收口项②] markRoundIdle 簿记⑧的 pending 注销闭包接线（唯一
    // 装配点——轮终注销由 store 统一发射，调用方薄壳不再双轨重复发）。
    this.store.setPendingUnregister((id, status) => this.notifyHost.emitPendingUnregister(id, status));
    // [R2] 域 #5 聚合：sync 批自闭合语义（collectCoordinator 装配 + E9 dispose 转账 +
    // E1 崩溃恢复 + settled 有界重扫 + collectSync 配置读取）。deps 全晚绑定闭包（构造期
    // 零求值——store/notifyHost/baselines 基线字段等运行时可变态经闭包
    // 现读，形态先例 = D4 late-bound getter 与 R1 装配）；[检查点①] flushBatch 显式依赖
    // 注入随聚合落地：CollectCoordinator 在聚合构造器内装配，flushBatch 闭包的外部状态
    // 经 deps getter 现读，service 整实例零注入。
    this.syncCollect = new SyncCollectDomain({
      getStore: () => this.store,
      getNotifyHost: () => this.notifyHost,
      getPi: () => this.pi,
      getSessionRootId: () => this.sessionRootId,
      getMainSessionFile: () => this.mainSessionFile,
      getCollectSyncSection: () => this.modelService.getGlobalConfig().collectSync,
    });
    // [R3] 域 #3/#8/#10/#13 聚合（record 读建面：孤儿恢复/查询投影/action 网关/身份解析
    // 与 record 创建）。deps 全晚绑定闭包（构造期零求值——store/manifestStore/modelService
    // 为 #1 留壳共享依赖经 getter 现读同一实例；sessionRootId/sessionId/mainSessionFile/
    // execNesting 为 #2 基线字段运行时可变态现读壳 getter）；assertReady 经壳转发方法
    // 现读（D4 下沉形态）。与 recordLifecycle 组间零 import（G2），壳分别装配。
    this.recordAccess = new RecordAccess({
      assertReady: () => this.assertReady(),
      getStore: () => this.store,
      getManifestStore: () => this.manifestStore,
      getModelService: () => this.modelService,
      getSessionRootId: () => this.sessionRootId,
      getSessionId: () => this.sessionId,
      getMainSessionFile: () => this.mainSessionFile,
      getExecNesting: () => this.execNesting,
    });
    // [R3] 域 #4/#11/#17/#18 聚合（record 终态迁移写面：dispose 批量回收/close 三路/
    // cancel/finalize 簇——D5「store 与终态迁移入口的唯一宿主」，H4 落点）。跨聚合边
    // 收敛：C-5（onRecordFinalizedCleanup 汇聚点 + Continuation 队列清空，本体在壳
    // #14 协作面）经 deps 回调；cancelBackground 的 collectCoordinator.route 经 #5
    // 显式 getter 投影现读（聚合间零私有互调）。C-6（roundSupervisor/reconcile sweep
    // 装配闭包调 finalizeRecord）经壳转发方法 late-bound 读取，装配点零改动。
    this.recordLifecycle = new RecordLifecycle({
      assertReady: () => this.assertReady(),
      getStore: () => this.store,
      getWorktreeManager: () => this.worktreeManager,
      getModelService: () => this.modelService,
      getNotifyHost: () => this.notifyHost,
      getSessionsDir: () => this.sessionsDir,
      getPi: () => this.pi,
      getCollectCoordinator: () => this.collectCoordinator,
      // [R4 / C-5 兑现] Continuation 协作面本体（continuations 队列 +
      // onRecordFinalizedCleanup + abortAndClearQueue）已迁 RunOrchestration 聚合——
      // R3 装配时指向壳闭包的两个回调改指聚合显式接口（r0-inventory 清单① C-5
      // 收敛完成；聚合间零直写，G2）。
      onRecordFinalizedCleanup: (id) => this.runOrchestration.onRecordFinalizedCleanup(id),
      abortContinuationQueue: (id) => {
        this.runOrchestration.abortContinuationQueue(id);
      },
    });
    // [R4] 域 #6/#7/#12/#14/#15 聚合（run 域执行编排 + Continuation 协作面 + pool/
    // worktree 资源）。deps 全晚绑定闭包（构造期零求值——#1 留壳共享依赖经 getter
    // 现读同一实例；R3 聚合显式接口直指 recordAccess/recordLifecycle，聚合间零私有
    // 互调 G2）。[B-6] roundSupervisor 留壳（boot/dispose 时序消费在壳 + C-6 装配
    // 闭包经壳转发 late-bound 天然兼容），聚合经 getter 现读。
    this.runOrchestration = new RunOrchestration({
      assertReady: () => this.assertReady(),
      getStore: () => this.store,
      getModelService: () => this.modelService,
      getCwd: () => this.cwd,
      getWorktreeManager: () => this.worktreeManager,
      getNotifyHost: () => this.notifyHost,
      getPool: () => this.pool,
      getPi: () => this.pi,
      getSessionRootId: () => this.sessionRootId,
      getStreamSink: () => this.streamSink,
      getUiObservability: () => this.uiObservability,
      getExecNesting: () => this.execNesting,
      getRoundSupervisor: () => this.roundSupervisor,
      getCollectCoordinator: () => this.collectCoordinator,
      resolveIdentity: (opts, pre) => this.recordAccess.resolveIdentity(opts, pre),
      resolveIdentityForEngine: (engine, engineModel, agent, agentConfig, opts) =>
        this.recordAccess.resolveIdentityForEngine(engine, engineModel, agent, agentConfig, opts),
      createRecordForMode: (identity, opts, mode, originFields) =>
        this.recordAccess.createRecordForMode(identity, opts, mode, originFields),
      buildEarlyFailedHandle: (record) => this.recordAccess.buildEarlyFailedHandle(record),
      finalizeRecord: (record, result, status, closedReason) =>
        this.recordLifecycle.finalizeRecord(record, result, status, closedReason),
      finalizeFailed: (record, err) => this.recordLifecycle.finalizeFailed(record, err),
      finalizeAborted: (record) => this.recordLifecycle.finalizeAborted(record),
      closeChatIdle: (record) => this.recordLifecycle.closeChatIdle(record),
    });
    // [R4 / D-R4-1 拆分] workflow 族聚合（executeWorkflowAgent + runWorkflowEngineTask
    // + 类外派发 helper）——与 RunOrchestration 组间零互调零 import，跨文件协作
    //（池槽/终态收口/outcome 映射/资源回收/port 解析/入口校验）经本装配闭包指回
    // runOrchestration 实例方法（G2「经壳编排」形态）。
    this.workflowDispatch = new WorkflowDispatch({
      assertReady: () => this.assertReady(),
      assertIdleTimeoutMsSafe: (opts) => this.runOrchestration.assertIdleTimeoutMsSafe(opts),
      getExecNesting: () => this.execNesting,
      getModelService: () => this.modelService,
      resolveChatEnginePort: () => this.runOrchestration.resolveChatEnginePort(),
      resolveIdentity: (opts) => this.recordAccess.resolveIdentity(opts),
      resolveIdentityForEngine: (engine, engineModel, agent, agentConfig, opts) =>
        this.recordAccess.resolveIdentityForEngine(engine, engineModel, agent, agentConfig, opts),
      createRecordForMode: (identity, opts, mode, originFields) =>
        this.recordAccess.createRecordForMode(identity, opts, mode, originFields),
      getNotifyHost: () => this.notifyHost,
      getStreamSink: () => this.streamSink,
      getUiObservability: () => this.uiObservability,
      getSessionRootId: () => this.sessionRootId,
      getRoundSupervisor: () => this.roundSupervisor,
      acquirePoolOrFinalize: (record, signal, priority) =>
        this.runOrchestration.acquirePoolOrFinalize(record, signal, priority),
      outcomeToAgentResult: (record, outcome) =>
        this.runOrchestration.outcomeToAgentResult(record, outcome),
      settleOneShotOutcome: (record, result, aborted) =>
        this.runOrchestration.settleOneShotOutcome(record, result, aborted),
      finalizeFailed: (record, err) => this.recordLifecycle.finalizeFailed(record, err),
      releaseRoundResources: (record, holdSlot, stream) =>
        this.runOrchestration.releaseRoundResources(record, holdSlot, stream),
    });
    // #11：注册进程级 observability 单例——inproc UI 请求队列 handleUiRequest（已删） 经
    // globalThis 桥接（notifyMissingHandlerGlobal）调到同一实例，共享
    // warnedMissingHandlerSessions 去重集合。未注册时 queue 走 fallback warn（不去重）。
    registerGlobalObservability(this.uiObservability);
  }

  // [D4-①] 通知簇四方法（notifyComplete / notifyClosed / piAdapter / toNotifyRecord）
  // 与 emitPendingRegister / emitPendingUnregister 模块函数已整体搬移至 notify-host.ts
  //（本类经 this.notifyHost 消费；行为逐字节等价，搬移 + 依赖注入）。

  // ── 对外聚合面（域 #0，壳终态保留 D3）（R0 重排）──

  /** [D4 查询面聚合] 读模型消费面（壳 interface/ 视图与 tool 查询经此访问；
   *  纯委托——方法本体保留 private 实现不重写，行为逐字节等价）。 */
  readonly queries: SubagentQueries = {
    findRecord: (id) => this.findRecord(id),
    lookupRecordAnyState: (id) => this.lookupRecordAnyState(id),
    collectRecords: (limit, statusFilter, includeWorkflow) =>
      this.collectRecords(limit, statusFilter, includeWorkflow),
    // [H2 W1] parentRunId 查询入口：rootSessionFilter 口径与 private collectRecords 一致
    //（sessionRootId → sessionId → undefined 兜底），委托 store（不过滤 origin）。
    collectRecordsByParentRunId: (parentRunId, limit) =>
      this.store.collectRecordsByParentRunId(
        parentRunId,
        limit,
        this.sessionRootId ?? this.sessionId ?? undefined,
      ),
    getFullRecord: (id) => this.getFullRecord(id),
    onChange: (listener) => this.onChange(listener),
  };

  /** [D4 对话 action 面聚合] chat 域 message/close 消费面（壳 subagent-actions 经此访问；
   *  纯委托同上。PiEngineService 适配器不经此——引擎边界走 piEngineServiceAdapter）。 */
  readonly chatActions: SubagentChatActions = {
    getRecordForAction: (id, opts) => this.getRecordForAction(id, opts),
    closeSubagent: (record, force) => this.closeSubagent(record, force),
    deliverChatMessage: (record, text) => this.deliverChatMessage(record, text),
  };

  // ── 域 #2 SessionBaselines 聚合转发（R1 抽取；本体 execution/service/session-baselines.ts）──

  /** [R1] 域 #2 聚合实例：session 级基线状态（pi / session 身份 / fork ALS / 嵌套 ALS /
   *  UI handler 面）的唯一宿主与唯一写者（r0-inventory 清单① #13-#25 共 13 字段）。
   *  deps 全晚绑定闭包（装配见构造器），壳经下方 getter/方法透传，对外签名零变化。 */
  private readonly baselines: SessionBaselines;

  // 基线字段读路径透传（R1 打样模式 2·strangler 转发壳）：壳内既有 this.X 引用点零改动；
  // 写点已收口聚合方法（D1 单写者），只 getter 无 setter = 壳侧只读。
  private get pi(): PiLike | null { return this.baselines.pi; }
  private get sessionId(): string | null { return this.baselines.sessionId; }
  private get mainSessionFile(): string | undefined { return this.baselines.mainSessionFile; }
  private get sessionRootId(): string | null { return this.baselines.sessionRootId; }
  private get streamSink(): StreamSink | null { return this.baselines.streamSink; }
  private get isIdleFn(): (() => boolean) | undefined { return this.baselines.isIdleFn; }
  private get execNesting(): ExecutionNestingContext { return this.baselines.execNesting; }
  private get rootCwd(): string { return this.baselines.rootCwd; }
  private get uiObservability(): UiRequestObservability { return this.baselines.uiObservability; }

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。
   *  本体已迁 SessionBaselines.initSession（fork/exec 嵌套基线建立、复活与跨域编排时序
   *  逐行等价随迁）；壳纯转发，对外签名不变。 */
  initSession(init: SubagentServiceSessionInit): void {
    this.baselines.initSession(init);
  }

  /**
   * [F6] 当前根 session id 的只读访问——引擎接线方（SAR 等）构造 RunContext 注入
   * `ctx.sessionRootId`（pi 引擎 relay 归属键 SESSION_ID 权威源）。initSession 后有值
   * （根进程 = 本 session id；嵌套 = env 贯穿的真 ROOT）。[D3+] 壳终态保留面。
   */
  getSessionRootId(): string | null {
    return this.baselines.getSessionRootId();
  }

  /** UI streaming sink 只读访问（workflow 域消费）。[D3+] 壳终态保留面。 */
  getStreamSink(): StreamSink | null { return this.baselines.getStreamSink(); }

  /** [D4 下沉] 就绪断言本体已迁聚合（late-bound getter 现读 pi/disposed，错误文案不变）；
   *  壳 9 个调用点经此转发。 */
  private assertReady(): void {
    this.baselines.assertReady();
  }
  // ── 域 #5 SyncCollectDomain 聚合转发（R2 抽取；本体 execution/service/sync-collect-domain.ts）──

  /** [R2] 域 #5 聚合实例：sync 批自闭合语义（collectCoordinator 装配 + E9 dispose 转账 +
   *  E1 崩溃恢复 + settled 有界重扫 + collectSync 配置读取）的唯一宿主与唯一写者
   *  （r0-inventory 清单① #26-#28）。deps 全晚绑定闭包（装配见构造器；检查点①
   *  flushBatch 显式依赖注入随聚合落地），壳经下方 getter/方法透传，对外签名零变化。 */
  private readonly syncCollect: SyncCollectDomain;

  // collectCoordinator 读路径透传（R1 打样模式 2·strangler 转发壳）：壳内既有 route
  // 调用点（#11 cancel / #14 引擎编排 / Continuation 装配）零改动；无写路径（构造期
  // readonly 装配，聚合单写者）。
  private get collectCoordinator(): CollectCoordinator {
    return this.syncCollect.collectCoordinator;
  }

  /** [E1] sync 批崩溃恢复（index.ts session_start 恢复编排处调用）。本体已迁
   *  SyncCollectDomain（扫描/补发/落标/settled 重扫时序逐行等价随迁）；壳纯转发，
   *  对外签名不变。 */
  recoverSyncCollectBatch(): Promise<void> {
    return this.syncCollect.recoverSyncCollectBatch();
  }

  /** collectSync.default 当前生效值（startHandler 缺省 collect 解析用；本体与配置读取
   *  链已迁聚合）。[D3+] 壳终态保留面（subagent-actions-core 消费）。 */
  getCollectSyncDefault(): "async" | "sync" {
    return this.syncCollect.getCollectSyncDefault();
  }

  // ── 域 #3/#4/#8/#10/#11/#13/#17/#18 RecordAccess + RecordLifecycle 聚合转发（R3 抽取；
  // 本体 execution/service/record-access.ts + record-lifecycle.ts）──

  /** [R3] 读建面聚合实例（域 #3 孤儿恢复 / #8 查询面 / #10 action 网关 / #13 身份解析与
   *  record 创建的唯一宿主）。deps 全晚绑定闭包（装配见构造器），壳经下方同名方法
   *  透传，对外签名零变化。[D-R3-1] 与 RecordLifecycle 拆分的计划变更见聚合文件头。 */
  private readonly recordAccess: RecordAccess;

  /** [R3] 终态迁移写面聚合实例（域 #4 回收面 / #11 close 三路 / #17 cancel / #18
   *  finalize 簇的唯一宿主——D5「store 与终态迁移入口的唯一宿主」，H4 落点）。
   *  deps 全晚绑定闭包（装配见构造器；C-5 跨域汇聚经回调、collectCoordinator 经 #5
   *  显式投影现读），壳经下方同名方法透传，对外签名零变化。 */
  private readonly recordLifecycle: RecordLifecycle;

  // ── 域 #3 孤儿/manifest 恢复 聚合转发（R3 抽取；本体 execution/service/record-access.ts）──

  /** [R3] 孤儿终态恢复编排入口（baselines deps.recoverOrphans 回调消费点——initSession
   *  复活后编排，时序逐行等价随迁读建面）；壳纯转发，签名不变。 */
  private recoverOrphansIfRootProcess(): void {
    this.recordAccess.recoverOrphansIfRootProcess();
  }

  /** 启动恢复：manifest tmp 残留清扫（ADR-035；index.ts session_start 每次都调）。
   *  [U4c / D6] tmp 恢复已退役为**静默删除**——manifest 现为可丢可重建缓存（权威
   *  = `.state`，重建 = rebuildIndexes），promote 半写 tmp 的恢复语义失效；本入口
   *  只清残留（含 0 字节/半写形态）。本体已迁 RecordAccess（行为随 ManifestStore
   * 退役语义）；壳纯转发，对外签名不变。 */
  async recoverManifestTmpFiles(): Promise<{ deleted: number; recovered: number }> {
    return this.recordAccess.recoverManifestTmpFiles();
  }

  /**
   * [U4c / G1] 缓存降级重建通道（boot 全量腿）：manifest 与 sessions-index 均为
   * 可丢缓存，本入口在 boot revive 完成后（initSession 的孤儿恢复/重物化已收敛
   * 磁盘态）全量重建——幂等补缺（幸存 manifest 不覆写），失败静默降级不抛。
   * 语义细节见 RecordStore.rebuildIndexes（D5 三要素）。壳纯转发。
   */
  rebuildIndexes(): number {
    return this.store.rebuildIndexes();
  }

  // ── 域 #4 回收面 聚合转发（R3 抽取；本体 execution/service/record-lifecycle.ts）──
  // [被否谱系 #3] 回收面显式归 RecordLifecycle——disposeAllRecords/onParentFork/
  // onParentNew 编排性关闭 + GC timer 随终态写面迁移；壳只保留时序编排（检查点③：
  // dispose 调用顺序与现状逐行等价，E9 先于批量 archive）。promoteSessionFileFromEngine
  // Handle（A 通道写点，清单②#1）/stopIdleGc/stopGcTimer 为聚合内部互调成员，壳内零
  // 消费 → 零转发（R2 打样模式 2）。

  /** SP-4: 关闭所有活跃 record（dispose 编排 parent-shutdown 路径 + D3 对外面）。
   *  本体已迁 RecordLifecycle（三回收面 + manifest 补写 + 锚点提升时序逐行等价随迁）；
   *  壳纯转发，对外签名不变。 */
  disposeAllRecords(reason: ClosedReason): number {
    return this.recordLifecycle.disposeAllRecords(reason);
  }

  /** SP-4: /fork 新 session 时清理旧 record（index.ts session_before_fork handler 触发）。
   *  本体已迁 RecordLifecycle；壳纯转发，对外签名不变。 */
  onParentFork(): number {
    return this.recordLifecycle.onParentFork();
  }

  /** SP-4: /new 创建全新 session 时清理旧 record（index.ts session_before_switch 触发）。
   *  本体已迁 RecordLifecycle；壳纯转发，对外签名不变。 */
  onParentNew(): number {
    return this.recordLifecycle.onParentNew();
  }

  /** 启动 idle record GC 定时器（session_start 调用，幂等）。本体已迁 RecordLifecycle
   *  （stopIdleGc 句柄为聚合唯一写者字段）；壳纯转发，对外签名不变。 */
  startGcTimer(): void {
    this.recordLifecycle.startGcTimer();
  }

  /** 停止 idle record GC 定时器（dispose 编排消费点）。壳纯转发。 */
  private stopGcTimer(): void {
    this.recordLifecycle.stopGcTimer();
  }

  // ── 域 #13 身份解析/record 创建（R3 抽取；本体 execution/service/record-access.ts）──
  // [R4] resolveIdentity / resolveIdentityForEngine / createRecordForMode /
  // buildEarlyFailedHandle 四转发已删（R3 过渡期消费方 = R4 域派发链，已随域迁
  // RunOrchestration/WorkflowDispatch，经 deps 装配闭包直指 recordAccess 聚合——
  // 壳内与全仓零剩余消费，删转发判据满足）。

  // ── 域 #8 查询面 聚合转发（R3 抽取；本体 execution/service/record-access.ts）──
  // 消费方 = queries 聚合面（D3 壳保留）+ Continuation handlers（R4 领地），壳保留
  // 转发方法 → 调用点零改动。

  /** 按 id 查内存 running record 的只读快照（G3-002 修复）。本体已迁 RecordAccess
   *  （assertReady 就绪门经 deps 现读）；壳纯转发，签名不变。 */
  private findRecord(id: string): RecordSnapshot | undefined {
    return this.recordAccess.findRecord(id);
  }

  /** [v8.5 A1/B] 全态查找（message 拒绝文案分流 + fork-from 源解析共用）。本体已迁
   *  RecordAccess；壳纯转发。 */
  private lookupRecordAnyState(id: string): SubagentRecord | undefined {
    return this.recordAccess.lookupRecordAnyState(id);
  }

  /** 订阅 store 变更（widget/list requestRender）。本体已迁 RecordAccess；壳纯转发。 */
  private onChange(listener: () => void): () => void {
    return this.recordAccess.onChange(listener);
  }

  // [D4] listRunning 已删除：零生产调用方（TUI 计数经 collectRecords / notify-host 的
  // piAdapter 直调 store.listRunning 覆盖），唯一消费是初始空态单测——保留 store 层方法。

  /** 合并内存 + 磁盘 record（/subagents list + tool list 消费，按 rootSessionId 过滤）。
   *  本体已迁 RecordAccess；壳纯转发（默认参数在聚合侧保持同值）。 */
  private collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    includeWorkflow: boolean = false,
  ): SubagentRecord[] {
    return this.recordAccess.collectRecords(limit, statusFilter, includeWorkflow);
  }

  /** [perf] 单 record 详情懒加载。本体已迁 RecordAccess；壳纯转发。 */
  private getFullRecord(id: string): SubagentRecord | undefined {
    return this.recordAccess.getFullRecord(id);
  }

  // ── 域 #10 action 网关 聚合转发（R3 抽取；本体 execution/service/record-access.ts）──
  // coldLookupDeps 字段（清单① #30，唯一消费方 getRecordForAction 冷查分支）为聚合
  // 内部成员，壳内零消费 → 零转发；壳只保留 getRecordForAction 转发（chatActions 面 +
  // piEngineServiceAdapter + Continuation handlers 消费点）。

  /**
   * 按 id 查 record 并做归属校验（message/close action 的统一入口；含 SP-2 冷查复活
   * 与 v4 A-5 直接父校验）。本体已迁 RecordAccess；壳纯转发，签名不变。
   */
  private getRecordForAction(id: string, opts?: { allowReconnect?: boolean }): ExecutionRecord {
    return this.recordAccess.getRecordForAction(id, opts);
  }

  // ── 域 #11 close 三路 聚合转发（R3 抽取；本体 execution/service/record-lifecycle.ts）──
  // 消费点：closeSubagent（chatActions 面 + piEngineServiceAdapter + Continuation
  // handlers 装配回调）。cancelBackground / closeChatIdle 为聚合内部互调成员或已随
  // R4 域迁走（closeChatIdle 的 R3 过渡转发已删——消费方 continuationFor closeNow
  // 回调随域迁 RunOrchestration，经 deps 直指 recordLifecycle；壳内与全仓零剩余
  // 消费，删转发判据满足）。

  /**
   * close action 的统一行为分流（running 子态 × force：chatMode abort+清队+立即终态 /
   * one-shot closeAfterRound 挂起 / force 走 cancelBackground）。本体已迁 RecordLifecycle；
   * 壳纯转发，签名不变。
   */
  private closeSubagent(record: ExecutionRecord, force: boolean): Promise<void> {
    return this.recordLifecycle.closeSubagent(record, force);
  }

  // [H1 U6] closeAfterRoundSettled（[M5] chat 域「轮完成时终态化」消费面）已随 chat 域
  // closeAfterRound 挂起标志退役删除：D4 close = abort 在途 + 清空队列 + 立即终态化
  //（closeChatIdle），不等轮终；one-shot 域的 closeAfterRound 消费走 consumeCloseAfterRound
  //（settleOneShotOutcome，照旧）。

  // ── 域 #17 取消 聚合转发（R3 抽取；本体 execution/service/record-lifecycle.ts）──

  /** 取消 background record（tryTransition CAS 抢锁防重复副作用）。本体已迁
   *  RecordLifecycle；壳纯转发，对外签名不变（D3 壳终态保留面）。 */
  cancel(id: string): boolean {
    return this.recordLifecycle.cancel(id);
  }

  // ── 域 #6/#7/#12/#14/#15 RunOrchestration + WorkflowDispatch 聚合转发（R4 抽取；
  // 本体 execution/service/run-orchestration.ts + workflow-dispatch.ts，[D-R4-1] 拆分
  // 边界与偏差登记见聚合文件头）──

  /** [R4] 域 #6-#15 核心编排聚合实例：run 域执行编排（execute/executeAndAwait 入口、
   *  引擎编排 + adopt 分诊、settleOneShotOutcome 终态收口、Continuation 协作面 +
   *  continuations 队列（C-4/C-5 宿主）、pool/worktree 资源）。deps 全晚绑定闭包
   *  （装配见构造器），壳经下方同名方法透传，对外签名零变化。 */
  private readonly runOrchestration: RunOrchestration;

  /** [R4 / D-R4-1] workflow 族聚合实例（executeWorkflowAgent 派发链 + 类外 helper）。
   *  与 runOrchestration 组间零互调零 import（跨文件协作经壳 deps 闭包）。 */
  private readonly workflowDispatch: WorkflowDispatch;

  /**
   * 预解析 model（renderCall 标题行用，同步）。本体已迁 RunOrchestration；壳纯转发，
   * 对外签名不变（subagent-actions-core 消费）。
   */
  resolveModel(
    agent: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
    agentConfig?: AgentConfig,
  ): ResolvedModel {
    return this.runOrchestration.resolveModel(agent, override, ctxModel, agentConfig);
  }

  /**
   * 统一执行入口。mode 固定 background（sync 已删除）。本体已迁 RunOrchestration
   *  （路由 → identity → record 创建 → worktree → 引擎 run 编排逐行等价随迁）；
   *  壳纯转发，对外签名不变（subagent-tool / subagent-actions 消费）。 */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    return this.runOrchestration.execute(opts);
  }

  /**
   * workflow 编排层专用 sync-await 接口（D-A1）。本体已迁 RunOrchestration；壳纯转发
   *  （SAR / piEngineServiceAdapter 消费）。 */
  async executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    return this.runOrchestration.executeAndAwait(opts, signal, onEvent, stream);
  }

  /**
   * [H2 W2] workflow 域统一派发入口。本体已迁 WorkflowDispatch（[D-R4-1] workflow 族
   * 独立聚合）；壳纯转发，对外签名不变（SAR / pump 消费）。 */
  async executeWorkflowAgent(
    opts: AgentCallOpts,
    parentRunId: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    return this.workflowDispatch.executeWorkflowAgent(opts, parentRunId, signal, onEvent, stream);
  }

  /**
   * [D5 双写点 gate 判据] SP-5 升级（one-shot → chatMode）的 conversation 位检查。
   *  本体已迁 RunOrchestration；壳纯转发（subagent-actions-core 消费）。 */
  canUpgradeToConversation(record: Pick<ExecutionRecord, "engine">): boolean {
    return this.runOrchestration.canUpgradeToConversation(record);
  }

  /**
   * [V2 决策 3 → H1 U2 改写 / U6 定形] chatMode 统一投递入口。本体已迁
   *  RunOrchestration；壳纯转发（chatActions 聚合面消费）。 */
  private async deliverChatMessage(record: ExecutionRecord, text: string): Promise<void> {
    return this.runOrchestration.deliverChatMessage(record, text);
  }

  // ── 域 #18 finalize 簇 聚合转发（R3 抽取；本体 execution/service/record-lifecycle.ts；
  // H4 落点 D5）──
  // [R4] finalizeFailed / finalizeAborted 两转发已删（R3 过渡期消费方 = R4 域派发链，
  // 已随域迁 RunOrchestration/WorkflowDispatch，经 deps 装配闭包直指 recordLifecycle
  // ——壳内与全仓零剩余消费，删转发判据满足）。finalizeRecord 转发保留：消费方 =
  // C-6 装配闭包（roundSupervisor/reconcile sweep 的 finalizeClosed——经壳转发方法
  // late-bound 读取，装配点零改动，清单①预判兑现）。

  /**
   * D-017 时序收尾：委托 doFinalizeRecord（finalize-record.ts 独立模块）。本体已迁
   * RecordLifecycle（FinalizeDeps 装配经 deps 现读 + onFinalized 钩子经 C-5 回调）；
   * 壳纯转发，签名不变。
   */
  private finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    status: "closed",
    closedReason?: ClosedReason,
  ): Promise<void> {
    return this.recordLifecycle.finalizeRecord(record, result, status, closedReason);
  }

  /**
   * [W4] 轮次活性监督器（D2「等待有主」权威层）：死亡事件纳管（run failed / 引擎
   * exited → adoptOnProcessDeath）+ boot 分区重认领（initSession）+ 三态判定
   * （record 级视图）+ 该放弃（终态化 failed + 注销 + 终止通知）。装配绑定面
   * （deps/giveUp 编排/sweep 挂点）在 round-supervisor/service-binding.ts——变化轴
   * 独立（通知文案 / 终态化编排 / store 读侧判据只动该文件），本字段只持实例。
   */
  private readonly roundSupervisor: RoundSupervisor = createRoundSupervisorForService({
    getStore: () => this.store,
    getPi: () => this.pi,
    getSessionRootId: () => this.sessionRootId,
    getMainSessionFile: () => this.mainSessionFile,
    finalizeClosed: (record, result) => this.finalizeRecord(record, result, "closed", "gc"),
  });





  /** 引擎服务面适配器（HostBridgeServiceFace 结构视图）：闭包持有本实例的编排面。
   *  [W3] chat 域轮次交接可选面（takeChatRound/runChatRound/resumeChatRound）随
   *  inproc PiEngine 删除移除——引擎经协议 converse，不再回调宿主编排面。 */
  private piEngineServiceAdapter(): HostBridgeServiceFace {
    return {
      executeAndAwait: (opts, signal, onEvent, stream) => this.executeAndAwait(opts, signal, onEvent, stream),
      getRecordForAction: (id) => this.getRecordForAction(id),
      closeSubagent: (record, force) => this.closeSubagent(record, force),
      cancel: (id) => this.cancel(id),
      collectRecords: (limit, statusFilter) => this.collectRecords(limit, statusFilter),
      reportRecordTransition: (record) => this.store.reportRecordTransition(record),
    };
  }

  /** [D4 聚合连带] 引擎服务面的显式结构视图（SAR 构造 resolveHostPiEnginePort 时
   *  传入的 getService 兼容位消费——W3 后该面无引擎侧消费方，保留使 SAR 调用点
   *  零改动，W8 收口时随签名一并清理）。getter 形态：face 视图（惰性构造）。 */
  get asEngineService(): HostBridgeServiceFace {
    return this.piEngineServiceAdapter();
  }

  // ── 壳生命周期编排与断言（dispose 时序留壳 = R3 检查点③；D4 断言面）（R0 重排）──

  private _disposed = false;
  // [B-7 已清] _seq 死字段（全文件零消费）按 r0-inventory 清单①登记于 R1 删除。

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。
   *
   * [M-7] dispose 顺序假设：pending:unregister emit 依赖 pending-notifications 扩展的
   * listener 仍然存活。若 pending-notifications 先于本扩展执行 session_shutdown（后注册
   * 先执行的语义下会如此），listener 已注销，unregister 事件被静默丢弃。这是可接受的
   * 退化——进程退出后两侧状态本就不保证一致，下次 session_start 的 crash recovery 会修正。 */

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stopGcTimer();
    // [v2 D4/C-1] settled 重扫 handler 惰化：原直改聚合内部态 settledRescanState.disposed
    // （r0-inventory 清单① C-1 跨聚合边，R2 兑现收敛为显式接口）——时序契约注释随迁
    // SyncCollectDomain.lazyDispose（trailing 边沿不扫描防「已落标未写账」的永久丢失）。
    this.syncCollect.lazyDispose();
    // [dispose stub] 第一时间换 stub，防 trailing ui_request 调到 stale handler 闭包
    // （仍持有 disposed session 的 ctx）产生误导性 console.error。stub 干净降级为 cancelled。
    // 必须在 emit/abort 之前——这些步骤可能同步触发 trailing pump。
    // [D4-④] 原 setUiRequestHandler 方法已删（initSession 参数为唯一注入入口）。
    // [R1/C-3] 原直写聚合字段两行（handler 换 stub + 缺失告警去重重置）收敛为显式接口
    // 方法 disposeSessionUi()——字段所有权在聚合（时序契约注释随迁）。
    this.baselines.disposeSessionUi();
    // [W6 R3 MF-A] dispose 后壳侧应答端同步换 stub（trailing host/askUser 干净降级为
    // cancelled，与 inproc inproc UI 请求队列（已删） 的 trailing 语义同构）。
    setHostUiRequestEndpoint(disposedUiRequestStub);
    // [R0/C1 孤儿进程修复] 先 abort running controllers + kill spawned children，再 dispose 资源。
    // abortRunningControllers 需要在 disposeAllRecords archive 之前执行（archive 后 store 找不到 record）。
    this.store.abortRunningControllers();
    killAllSpawnedChildren();
    // [H1 U2/U6] Continuation 实例全量清理（路由注销面已随 interact 面退役）——
    // dispose 后容器不应再收 message。
    // [R4 / C-4 兑现] 原直调 this.continuations.clear() 的跨聚合写边收敛为聚合显式
    // 接口（字段所有权随域 #14 迁 RunOrchestration）。
    this.runOrchestration.clearContinuations();
    // [E9] 批未闭合时缓冲终态成员逐条转 async 写账 + 落 batchFinalized（设计 §3.1.5 E9）。
    // 必须在 disposeAllRecords 之前——它会把活跃 record（含 SP-5 成功回退的
    // running+resumable 缓冲成员）全部 archive 清内存，之后再 getFullRecord 落标只剩
    // 冷 idToFile（无目录扫描则 miss → 跳过落标 → E1 重建误收已转换成员）；先转换取
    // 内存命中，与 flushBatch 出口①同款通路。同样在 flushPendingNotifications 之前
    //（转换条目加入本次 flush）与 notifier/store dispose 之前（写账与 appendEntry
    // 通道仍可用）。仍在跑成员不在此处理——后续 disposeAllRecords 按现有退出路径关闭。
    // [R2] 本体迁 SyncCollectDomain.convertPendingSyncBufferToAsync（E9 转账时序逐行等价）。
    this.syncCollect.convertPendingSyncBufferToAsync();
    // SP-4: 级联关闭所有活跃 record（parent-shutdown reason）
    // 在 abort/kill 之后执行：先终止子进程，再清理 record 状态。
    this.disposeAllRecords("parent-shutdown");
    // [review MF1] 在途 resume 守卫清空（正常由轮次收尾 finally 清除；此处兜底
    // abort/kill 后仍挂着的条目，防跨 session 复活时残留）
    // flush 待发通知（session_shutdown 尽力投递一次）。
    this.notifyHost.flushPendingNotifications();
    // [T4④ / PS-5] flush 被 isIdle 门拦时的丢失面闭合：attemptDeliver 的 isIdle 二次
    // 复查失败时 pending 挂在 ledger 内存态，随后 dispose 销毁——旧注释「flush 后 dispose
    //（防丢失）」的承诺与行为不符。现把未投递 pending 经 ledger entry 通道复写落盘
    // （notifyId 幂等，重复 entry 由恢复扫描后写覆盖吸收），重启 recoverFromSession 按
    // 账面差集重放补投——「不丢」由落盘账本承接而非本次 flush。
    this.persistUndeliveredNotificationsForReplay();
    this.notifyHost.dispose();
    // [W4] 监督器停机（清 timer + 纳管记账；注册/record 不动——process 档跨 shutdown
    // 存活，重开 session 由 boot 分区重认领 + sweep 对账收口）。
    this.roundSupervisor.dispose();
    this.store.dispose();
  }

  /**
   * [T4④ / PS-5] shutdown flush 被门拦时把未投递 pending 复写落盘（供重启 replay）。
   *
   * 触发条件：flushPendingNotifications 后 ledger 仍有 pending（isIdle 门拦 / sendDelivery
   * 受理失败的残留）且主 agent 非 idle——即本次 shutdown 注定投不出去。落盘动作 =
   * pi.appendEntry 重写 NOTIFY_LEDGER_CUSTOM_TYPE entry（与 ledger.record 同通道同 schema，
   * notifyId 幂等：恢复扫描按后写覆盖 + ack/abandoned 差集去重，重复账面不产生重复投递）。
   * 主 agent idle 时 flush 已投出，无需复写（零开销）。
   */
  private persistUndeliveredNotificationsForReplay(): void {
    try {
      const ledger = getBoundNotifyLedger();
      const pending = ledger?.pendingEntries() ?? [];
      if (pending.length === 0) return;
      if (this.isIdleFn?.() !== false) return; // idle：flush 已投出（或无 gate 场景照旧）
      for (const item of pending) {
        this.pi?.appendEntry(NOTIFY_LEDGER_CUSTOM_TYPE, {
          v: 1,
          notifyId: item.notifyId,
          content: item.content,
          record: item.record,
        });
      }
      logger.warn(
        `[subagents] shutdown flush blocked by busy main agent: ${pending.length} pending notification(s) persisted to ledger for replay on next session_start`,
        { count: pending.length },
      );
    } catch (err) {
      // 落盘复写是防丢失增强，失败不阻断 dispose（账本原 entry 仍随 pi flush 落盘）。
      bestEffort(err, "persistUndeliveredNotificationsForReplay", "error");
    }
  }
}

// [R6] 进程单例访问器族（SERVICE_SLOT_KEY / getServiceSlot / getSubagentService /
// setSubagentService / createSubagentService）已外移 service/service-bootstrap.ts
//（globalThis[Symbol.for] slot 防 jiti 多实例分裂，机制注释随迁）；barrel
// packages/subagent-core/src/index.ts 直接改指向该文件，壳不做 re-export（防壳↔
// bootstrap 值环——设计 v4 import 纪律）。
