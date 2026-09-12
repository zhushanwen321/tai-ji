// [H3/R3] RecordLifecycle 聚合（域 #4/#11/#17/#18：回收面 + close 三路 + cancel +
// finalize 簇）——自 SubagentService 上帝类 strangler 抽取的第三个聚合的**终态迁移
// 写面**（设计 docs/design/subagent-service-decomposition.md §2.1 / §3.3 D5；成员归属
// 以 r0-inventory.md 清单① + 域分区为准）。
//
// [计划变更 D-R3-1] G1「每聚合 ≤700 行」与 R0 八域体量（分区实测 833 物理行）冲突，
// 拆两文件（dev agent 停线报告、主 agent 核验追认）：本文件（终态写面 #4/#11/#17/#18）
// + record-access.ts（读建面
// #3/#8/#10/#13）。两文件组间零互调（已验证——终态组方法只消费 deps + 组内互调），
// 各自独立 deps，壳分别装配——聚合间零 import（G2 / R1 打样模式 3）。
//
// 单一职责：record 的**终态迁移**——dispose 批量回收（含被否谱系 #3 的 onParentFork/
// onParentNew 编排性关闭 + GC timer）、close action 三路分流、cancel CAS 抢锁终态、
// finalize 簇（doFinalizeRecord 委托）。**本聚合 = store 与终态迁移入口的唯一宿主
// （D5，H4「意图级写操作」落点）**：H4 后续在本聚合接口面上收口持久化。
//
// [R1 打样模式——R3 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）。pi/会话基线运行时可变
//   （initSession 注入 / 复活翻转），断言/调用时经壳 getter 现读；叶子模块实例（store/
//   manifestStore/worktreeManager/modelService/notifyHost）为 #1 留壳共享依赖，getter
//   现读同一实例——深绑测试的 FR 替换语义保持。
// 2. 转发壳写法：壳保留同名方法（含原可见性）单行转发（D3 壳终态保留面：disposeAllRecords/
//   onParentFork/onParentNew/startGcTimer/cancel/recoverManifestTmpFiles）；聚合内部
//   互调（cancelBackground/closeChatIdle/finalizeRecord/promoteSessionFileFromEngineHandle/
//   stopGcTimer）保持 private，不经壳。
// 3. 跨聚合边收敛（r0-inventory 清单① C-4/C-5/C-6）：
//    - C-5（onRecordFinalizedCleanup 跨域汇聚点，本体在壳 #14 Continuation 协作面）：
//      deps.onRecordFinalizedCleanup 回调——disposeAllRecords/cancelBackground 直调点
//      与 doFinalizeRecord deps.onFinalized 钩子闭包统一经此回调（现状显式注入形态
//      天然兼容，清单①预判兑现）；R4 抽取 Continuation 协作面时回调改指聚合显式接口。
//    - C-6（roundSupervisor/reconcile sweep 装配闭包调 finalizeRecord）：闭包经壳
//      late-bound 读取壳转发方法——天然兼容聚合化，壳装配零改动（清单①预判兑现）。
//    - C-4（壳 dispose 直调 continuations.clear）：#14 Continuation 状态清理，壳 dispose
//      编排消费——R4 领地，本单元留置不动（壳直调壳字段，非跨聚合写）。
//    - closeSubagent 对 Continuation 队列的清空（continuations.get(...)?.abortAndClearQueue）：
//      deps.abortContinuationQueue 回调（同 C-5 邻接面，R4 改指聚合显式接口）。
//    - cancelBackground 的 collectCoordinator.route（#5 SyncCollect 显式 getter 投影）：
//      deps.getCollectCoordinator() 晚绑定现读——聚合间经显式接口协作（route 是
//      CollectCoordinator 公共方法），零私有互调。
// 4. 只搬不改：方法体除依赖注入通道替换外逐字节保留——本聚合是 H4 落点宿主，写点
//    通道表（r0-inventory 清单②）中 #4 的 promoteSessionFileFromEngineHandle（A 通道
//    唯一 R3 迁移项）+ store.archive（B）+ manifest/sidecar（D/E）原样随迁。

import { toErrorMessage } from "../../core/error-message.ts";

import { getLogger } from "../../core/logger.ts";

import { bestEffort } from "../best-effort.ts";
import type { CollectCoordinator } from "../collect-coordinator.ts";
import { completeRecord, tryTransition } from "../execution-record.ts";
import { killRecordChildWithEscalation } from "../engine/host/spawned-children.ts";
import { startIdleGc } from "../idle-gc.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode record 的 disarm 面（终态化/取消
// 路径防误杀）。
import { disarmIdleTimer } from "../lifecycle-manager.ts";
import { isIdle, isResumable } from "../lifecycle-predicates.ts";
import { doFinalizeRecord } from "../finalize-record.ts";
import { FileRunStore } from "../../orchestration/file-run-store.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { NotifyHost, PiLike } from "../notify-host.ts";
import type { RecordStore } from "../record-store.ts";
// [W4] 轮次活性监督器三态撤下 + settled watchdog disarm（终态路径防 timer 误触发）。
import { disarmRoundFromProtocol, disarmSettledWatchdog } from "../settled-watchdog.ts";
import { resolvePiWorkflowStateDir } from "../workflow-state-root.ts";
import type { WorktreeManager } from "../worktree-manager.ts";
import type { AgentResult, ClosedReason, ExecutionRecord } from "../types.ts";

const logger = getLogger("subagents");

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。跨域边三类：
 * - 断言面（assertReady）：close/cancel 入口的就绪门（本体在 SessionBaselines，壳转发）。
 * - 跨域汇聚回调（onRecordFinalizedCleanup / abortContinuationQueue）：#14 Continuation
 *   协作面的终态清理与队列清空（C-5），壳装配指向壳方法；R4 抽取后改指聚合显式接口。
 * - 显式接口协作（getCollectCoordinator）：#5 SyncCollect 的公共投影（route 投递）。
 */
export interface RecordLifecycleDeps {
  /** [D4 下沉] assertReady 断言（本体在 SessionBaselines，壳转发）。 */
  readonly assertReady: () => void;
  /** RecordStore（#1 留壳共享依赖；本聚合消费面：批量回收/终态 archive/GC 数据源）。 */
  readonly getStore: () => RecordStore;
  /** WorktreeManager（终态 worktree 绑定清理，fire-and-forget）。 */
  readonly getWorktreeManager: () => WorktreeManager;
  /** ModelConfigService（doFinalizeRecord FinalizeDeps 形参——独立模块签名要求具体类型）。 */
  readonly getModelService: () => ModelConfigService;
  /** NotifyHost（pending 注销 + closeChatIdle 终态通知）。 */
  readonly getNotifyHost: () => NotifyHost;
  /** subagent sessionDir（doFinalizeRecord FinalizeDeps.sessionDir——sessionFile 缺失时
   *  磁盘 identity 反查依据；壳构造期同源推导）。 */
  readonly getSessionsDir: () => string;
  /** pi 句柄（manifest 写失败事件 appendEntry；initSession 时点晚绑定，dispose 后 null）。 */
  readonly getPi: () => PiLike | null;
  /** [C-5 显式回调] record 终态化路径的宿主侧收口汇聚点（#14 Continuation 实例清理，
   *  本体在壳）。disposeAllRecords/cancelBackground 直调点 + doFinalizeRecord
   *  deps.onFinalized 钩子统一经此回调。 */
  readonly onRecordFinalizedCleanup: (recordId: string) => void;
  /** [C-5 邻接回调] Continuation 在途轮打断清队（#14 continuations Map 消费——原壳
   *  closeSubagent 内 continuations.get(id)?.abortAndClearQueue()）。 */
  readonly abortContinuationQueue: (recordId: string) => void;
  /** [显式接口协作] #5 SyncCollect 的 collectCoordinator 公共投影（cancelBackground
   *  终态 route 投递；晚绑定现读聚合 getter）。 */
  readonly getCollectCoordinator: () => CollectCoordinator;
}

/**
 * 域 #4/#11/#17/#18 聚合：record 终态迁移写面（R3 自 SubagentService 抽取）。
 *
 * 字段所有权（r0-inventory 清单①）：#29 stopIdleGc（GC timer stop 句柄）——本聚合
 * 唯一写者；壳经 startGcTimer/stopGcTimer 转发面触达，字段壳零感知。
 */
export class RecordLifecycle {
  private readonly deps: RecordLifecycleDeps;

  constructor(deps: RecordLifecycleDeps) {
    this.deps = deps;
  }

  // ── 域 #4 回收面 ──

  /** SP-4: 关闭所有活跃 record。
   *
   *  遍历 store 中所有 running record，逐个 CAS 转终态 + completeRecord + archive。
   *  对有 worktreeHandle 的 record 触发 worktreeManager.cleanup（T3: worktree 绑定清理）。
   *
   *  [T2⑥ / PS-1] 补齐三回收面（对照 dispose() 的既有形态，消除同文件双标）：
   *  controller.abort + kill（收敛到 killChildWithEscalation）+ disarmIdleTimer +
   *  disarmSettledWatchdog。旧实现只关 record 不中止执行——「record 已关」≠「执行已
   *  处置」：在途子进程继续跑且无任何用户可及的取消通道（cancel 只查内存 running，
   *  archive 后恒 false），若挂死唯一上界是默认关闭的 spawn watchdog → 泄漏至宿主退出。
   *  abort/kill/timer 三面对已终态/已死 record 均幂等 no-op，dispose() 先行的
   *  abortRunningControllers + killAllSpawnedChildren 不受影响（parent-shutdown 路径
   *  双保险）。
   *
   *  [v4 A-6] 旧实现的 recentlyCascaded 收集（供已删除的 before_agent_start 注入告知）
   *  与 drainCascaded 已一并移除——被关 record 的告知改由 list 的 closedReason 表达。
   *
   *  [M1 Gate B] 本路径曾整体缺 manifest 反查索引（不经 doFinalizeRecord 的唯一终态
   *  写点缺口）：优雅停机关掉的在途 record 重启后 list 不可见（records/<id>.json 不
   *  存在）、message 报 not found——「展示层∪动作链」双失。[B3/D8] 终态化归口
   *  store.markFinalized 后 manifest 随终态原语落盘（manifestDir 接线后 writeSync 同步
   *  完成于本同步函数体内，停机窗 fire-and-forget 竞态构造性消灭；生产构造点恒传
   *  manifestDir，缺省降级异步仅纯内存测试形态，SIGKILL 竞态丢失由
   *  recoverOrphanRecords 的可重连 entry 重物化自愈兜底）。
   *  归口同时补齐 .state 权威写与 .alive release——重启后行为按 D8 矩阵五行
   *  （chat×fork-new 收紧硬拒 / one-shot×shutdown 放宽可续 / 纳管态降级手动 resurrect）。
   *
   *  [M1 sessionFile 锚点提升] 在途 record 的 sessionFile 尚未回填（run 应答未到）时，
   *  R4 运行中句柄回填（onHandleReady → backfillEngineHandle）可能已把引擎上报的子
   *  session 文件路径写进 engineHandle.sessionRef——提升为 record.sessionFile 后，
   *  archive entry 与 manifest 都带上真实锚点，重启 revive/fork-from 可直接定位子文件。
   *  提升源与 settle 回填（outcomeToAgentResult）同 authority（引擎 sessionRef）。
   *
   *  @param reason 关闭原因（parent-fork / parent-new / parent-shutdown）
   *  @returns 被关闭的 record 数量
   */
  disposeAllRecords(reason: ClosedReason): number {
    const activeRecords = this.deps.getStore().listAllActive();
    let count = 0;
    for (const record of activeRecords) {
      // [T2⑥/PS-1] 回收面 i：abort 在途 controller（排队的 acquire / 在途 signal listener
      // 立即感知取消）。幂等：已 aborted 的 controller.abort() 是 no-op。
      record.controller?.abort();
      // 回收面 ii：回收子进程（SIGTERM + 30s SIGKILL 升级，收敛 T2④同款）。
      // 回收面 iii：disarm idle timer + settled watchdog（进程回收后 timer 只会误触发）。
      killRecordChildWithEscalation(record.id, `disposeAllRecords (${reason})`);
      disarmIdleTimer(record.id);
      disarmSettledWatchdog(record.id);
      // closed 抢先的 record 由 continue 跳过（ExecutionStatus 两态后无第三态）。
      // 与 closeChatIdle 对称：record 无在途 AgentResult，构造合成 result。
      if (record.status === "running") {
        if (!tryTransition(record, "closed", reason)) continue;
      }
      const result: AgentResult = {
        text: "",
        turns: record.turnCount,
        durationMs: Date.now() - record.startedAt,
        success: false,
        error: `closed due to ${reason}`,
        sessionId: record.id,
        toolCalls: [],
      };
      completeRecord(record, result, "closed", reason);
      // [M1 sessionFile 锚点提升] 先于终态原语——archive entry 与 manifest 随之携带锚点。
      this.promoteSessionFileFromEngineHandle(record);
      // [B3/D8] 终态化归口 markFinalized：原「不写 .state 不删 .alive + manifest
      // fire-and-forget」升级为完整终态原语（.state writeSync 权威 + manifest + .alive
      // 删，D8 v7 写序）——D8 行为变化矩阵五行生效点（chat×fork-new 硬拒收紧 /
      // one-shot×shutdown 放宽可续 / 纳管态降级手动 resurrect，均已接受）。生产路径
      // 恒 manifestDir 接线（subagent-service 构造点）；缺省异步分支仅纯内存测试形态，
      // 其余面不变。
      const persisted = this.deps.getStore().markFinalized(record, reason);
      if (!persisted) {
        // [§3.4] .state 重试耗尽：响亮 entry 上报（record 磁盘留 running，boot 孤儿
        // 恢复终态化承接）；清理副作用继续——dispose 路径幂等且无重试机会。
        logger.error(
          `[subagents] disposeAllRecords: terminal state write failed after retries ` +
            `(record=${record.id}, reason=${reason}); record stays running on disk — boot orphan recovery will finalize it`,
        );
        this.deps.getPi()?.appendEntry?.("subagent:state-write-failed", {
          id: record.id,
          status: "closed",
          closedReason: reason,
        });
      }
      // [F-5 修复] 本路径不经 doFinalizeRecord（编排性关闭直连 completeRecord+终态原语），
      // chat 轮路由注销在此补齐（幂等；闭包持 record/stream 引用，防泄漏）。
      // [H1 U2] 汇聚点扩为 onRecordFinalizedCleanup（路由注销 + Continuation 清理）。
      this.deps.onRecordFinalizedCleanup(record.id);
      // worktree 绑定清理（T3）。cleanup 已 async 化——同步签名（返回计数）不变，
      // 清理 fire-and-forget：失败经 bestEffort 留痕，不阻塞/不影响计数返回。
      if (record.worktreeHandle) {
        void this.deps.getWorktreeManager().cleanup(record.worktreeHandle).catch((err: unknown) => {
          bestEffort(err, `worktree cleanup (${reason})`);
        });
      }
      // pending-notifications 注销
      this.deps.getNotifyHost().emitPendingUnregister(record.id, "closed");
      count++;
    }
    return count;
  }

  /** SP-4: /fork 新 session 时清理旧 record。
   *  调用 disposeAllRecords("parent-fork")。由 index.ts 的 session_before_fork handler 触发。 */
  onParentFork(): number {
    return this.disposeAllRecords("parent-fork");
  }

  /** SP-4: /new 创建全新 session 时清理旧 record。
   *  调用 disposeAllRecords("parent-new")。由 index.ts 的 session_before_switch
   *  （reason==="new"）handler 触发。 */
  onParentNew(): number {
    return this.disposeAllRecords("parent-new");
  }

  /**
   * [M1 Gate B] sessionFile 锚点提升：record.sessionFile 未回填（run 应答未到）但 R4
   * 运行中句柄回填已把引擎上报的子 session 文件路径写进 engineHandle.sessionRef 时，
   * 提升为 record.sessionFile。提升源与 settle 回填（outcomeToAgentResult /
   * finalizeEngineOutcome）同 authority（引擎 sessionRef.sessionFile）。
   *
   * 消费方：disposeAllRecords / cancelBackground 的终态化——让 archive entry 与
   * manifest 带真实锚点，重启后 revive/fork-from 可定位子文件。无 engineHandle 或
   * sessionRef 无 sessionFile（handle_ready 前就停机的残余形态）保持 undefined——
   * 该子形态无确定性恢复路径（子文件名 `<ts>_<sessionId>.jsonl` 由子进程生成，
   * 宿主无记录映射），恢复语义降级为「manifest 可见 + fork-from/start 指引」。
   */
  private promoteSessionFileFromEngineHandle(record: ExecutionRecord): void {
    if (record.sessionFile !== undefined) return;
    const sessionFile = record.engineHandle?.sessionRef.sessionFile;
    if (typeof sessionFile !== "string" || sessionFile === "") return;
    record.sessionFile = sessionFile;
  }

  /** SP-4: idle record GC（30 天 TTL，实现抽至 idle-gc.ts）。stop 函数（dispose 调）。 */
  private stopIdleGc: (() => void) | undefined;

  /** 启动 idle record GC 定时器（session_start 调用，幂等）。
   *  [W4] WorkflowRun store（FileRunStore）同批纳入：running 且 startedAt 超 30 天
   *  锚窗的 run 终态化归档（只终态化不补注销，见 idle-gc.ts 头注）。宿主未
   *  configureCore 时 loadAll 抛错由 idle-gc 内部吞掉（单轮跳过）。
   *  [F-1 修复] stateDir 与 pi 壳 JsonlRunStore 落盘布局同源
   *  （resolvePiWorkflowStateDir → <sessionDir>/workflow-state/）——缺省 dataRoot 根
   *  与 pi 生产落盘不相交，WorkflowRun GC 曾恒空转（W4 引入的装配错位）。 */
  startGcTimer(): void {
    if (this.stopIdleGc) return;
    this.stopIdleGc = startIdleGc(this.deps.getStore(), new FileRunStore({ stateDir: resolvePiWorkflowStateDir() }));
  }

  /** 停止 idle record GC 定时器（dispose 调用）。 */
  stopGcTimer(): void {
    this.stopIdleGc?.();
    this.stopIdleGc = undefined;
  }

  // ── 域 #11 close 三路 ──

  /**
   * close action 的统一行为分流（running 子态 × force）。
   *
   *   chatMode（[H1 U2 / D4] close 行统一）：
   *     force:true                        → cancelBackground（显式 SIGTERM + closed+cancelled 终态）
   *     force:false（任意子态）           → abort 在途轮 + 清空队列（Continuation）+ 立即终态化
   *       （closeChatIdle：closed/user-close + notifyClosed——「closeAfterRound 等轮终」
   *       挂起标志随 chat 域长驻消亡退役：D4 close = abort + 清队列 + 立即终态化，
   *       不等轮终；S7 无僵尸轮、无 close 后追加通知由 onRunSettled 终态守卫构造性保证）
   *   非 chatMode（one-shot，现状不变）：
   *     running + force:false + 无在跑轮  → closeChatIdle（立即终态化）
   *     running + force:false + 有活进程  → 置 closeAfterRound=true（settleOneShotOutcome 消费——照旧）
   *   其他终态                            → 幂等 no-op（已结束）
   *
   * 与设计决策 5 一致：close = 正式终态（走 finalize），force 只影响 running 时机。
   *
   * @param record 目标 record（getRecordForAction 已校验归属）
   * @param force true=立即终止（running 时 SIGTERM）/ false=优雅关闭
   */
  async closeSubagent(record: ExecutionRecord, force: boolean): Promise<void> {
    this.deps.assertReady();
    if (record.status === "running") {
      if (force) {
        // 立即终止：cancelBackground（controller.abort + tryTransition closed+cancelled + finalize）
        this.cancelBackground(record);
      } else if (record.chatMode) {
        // [H1 U2 / D4] chat close：abort 在途轮（幂等——无在途轮 no-op）+ 清空队列，
        // 随即立即终态化（closeChatIdle 收口——closeAfterRound 挂起标志在 chat 域退役，
        // 不再有「轮完成时终态化」的等待窗；[H1 U6] 消费点 closeAfterRoundSettled 已删，
        // S7 无僵尸轮、无 close 后追加通知由 onRunSettled 终态守卫构造性保证）。
        this.deps.abortContinuationQueue(record.id);
        await this.closeChatIdle(record);
      } else if (isIdle(record) || isResumable(record)) {
        // [M5] 无在跑轮：Path A（isIdle timer armed、进程保活等待续聊）/ Path B（isResumable
        // 无活进程）→ 立即终态化 done（closeChatIdle 内回收保活进程 + disarm timer）。
        await this.closeChatIdle(record);
      } else {
        // 优雅关闭：正在执行（有活进程在跑轮），标记 closeAfterRound，轮完成时终态化
        //（one-shot 消费点在 settleOneShotOutcome CAS 分支——照旧，G3）
        record.closeAfterRound = true;
      }
    }
    // 其他终态（closed）：幂等 no-op
  }

  /**
   * 无在跑轮 record 的手动终态化为 done（close action 的 isIdle/isResumable 分支）。
   *
   * 无在途 AgentResult（轮次完成时 record 未冻结，turns[] 保留运行时状态），
   * 构造合成 done result（对齐 cancelBackground 的 cancelledResult 模式）。
   * 走 doFinalizeRecord 的完整终态化路径（completeRecord + archive + finalized + worktree
   * cleanup + alive marker + manifest）。
   *
   * [M5] 覆盖两路：Path B（无活进程，同旧行为）与 Path A（idle timer armed、进程保活等待
   * 续聊）。Path A 必须先显式回收进程 + disarm timer——否则 record 已终态化但保活进程
   * 继续驻留（终态后无人再杀它：closeSubagent 不再来、idle timer 已 disarm、runSpawn
   * promise 早已 resolve），直到宿主进程退出。
   *
   * 不走 tryTransition（v4 B-1 此态 status=running，但由 doFinalizeRecord 内部的
   * completeRecord 直接覆盖 status，与 cancelBackground 对 record 的处理同构）。
   */
  async closeChatIdle(record: ExecutionRecord): Promise<void> {
    // [M5] Path A：回收保活进程 + disarm idle timer（终态化后无其他 kill 路径）。
    // [T2④ / LC-2] 终止语义收敛：SIGTERM 被无视时 30s 升级 SIGKILL——终态化后
    // record 已 archive，挂住 = 幽灵进程无任何后续回收通道。同时 disarm settled
    // watchdog（本路径终态化 = settled 等待窗口终结，防 watchdog 误杀后续同 id 资源）。
    // [W3] 实际终止在引擎进程内（协议 interact close force → 引擎侧杀链）；
    // killRecordChildWithEscalation 只做镜像置死记账。
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    killRecordChildWithEscalation(record.id, "closeChatIdle");
    // 合成 closed result（无在途 AgentResult，`record.result ?? ""` 模式）。
    // [W16 P-1 修复] text 必须沿用轮终真实 result：
    // completeRecord 会执行 record.result = result.text，合成空串会把轮终真实值抹空，
    // archive 落的 close 终态 subagent-record entry（D4 重建源）随之失真——重开
    // session 后 result 回退空串。
    const doneResult: AgentResult = {
      text: record.result ?? "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: true,
      sessionId: record.id,
      toolCalls: [],
    };
    await doFinalizeRecord(
      {
        worktreeManager: this.deps.getWorktreeManager(),
        store: this.deps.getStore(),
        modelService: this.deps.getModelService(),
        pi: this.deps.getPi(),
        emitUnregister: (id, st) => this.deps.getNotifyHost().emitPendingUnregister(id, st),
        // [F-5 修复] 同 finalizeRecord——chat 轮路由注销单一汇聚点钩子
        //（[H1 U2] 汇聚点扩为 onRecordFinalizedCleanup：路由注销 + Continuation 清理）。
        onFinalized: (id) => this.deps.onRecordFinalizedCleanup(id),
        sessionDir: this.deps.getSessionsDir(),
      },
      record,
      doneResult,
      "closed",
      "user-close", // close action 主动关闭
    );
    // [C-1] 终态通知（设计 D2 路径②）：正文空串占位 + sessionFile 指针行（idle 下
    // 末轮增量已由该轮轮次通知送达，终态再发属重复）。doneResult.text 已改保真
    // （P-1 修复），正文空由 notifyClosed 的 emptyBody 参数显式表达。
    // dedup 身份独立于轮次通知（notifyClosed 置 round=undefined），60s 窗内不被吞。
    // 防重入：closeSubagent 对 closed record 幂等 no-op，本路径不会被二次进入。
    this.deps.getNotifyHost().notifyClosed(record, true);
  }

  // [H1 U6] closeAfterRoundSettled（[M5] chat 域「轮完成时终态化」消费面）已随 chat 域
  // closeAfterRound 挂起标志退役删除：D4 close = abort 在途 + 清空队列 + 立即终态化
  //（closeChatIdle），不等轮终；one-shot 域的 closeAfterRound 消费走 consumeCloseAfterRound
  //（settleOneShotOutcome，照旧）。

  // ── 域 #17 取消 ──

  /** 取消 background record（tryTransition CAS 抢锁防重复副作用）。 */
  cancel(id: string): boolean {
    this.deps.assertReady();
    const record = this.deps.getStore().getMutable(id);
    if (!record) return false;
    return this.cancelBackground(record);
  }

  /**
   * 取消 background record。CAS 抢锁（tryTransition）——抢到则 notify + 写 tombstone；
   * 没抢到（detached 已 finalize，record 已终态）返回 false，不触碰任何收尾副作用。
   *
   * stop 手段（abort/kill/disarm）无条件先执行：对已终态 record 幂等无害，且保证
   * cancel 语义 = 进程必死；收尾副作用（completeRecord/tombstone/archive/notify）只归
   * CAS 赢家。[A2-1] 此前 CAS 被误删，cancel 可在 doFinalizeRecord Step 0 await 窗口
   * 命中已终态 record——覆写终态 + tombstone/finalized 双标 + notify 双发 + 谎报 true。
   */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    // [M6] 显式 kill + disarm：chatMode 首轮 agent_settled 后 runSpawn 提前 resolveRun(0)
    // 返回，`opts.signal.removeEventListener("abort", onAbort)`（session-runner runSpawn 尾部）
    // 已移除 abort→kill listener；热路径续聊轮（PiEngine 直接 stdin 写入）不再
    // 进 runSpawn。此后 cancel 只有 controller.abort() 无人响应——record 已终态化 cancelled
    // 但子进程继续跑完当前 turn（工具副作用继续发生），之后 agent_settled 还对已 archived
    // record 触发脏通知（round+1 → 新 dedup key → "finished a round"），最终靠 5min idle
    // timer 兜底 kill。故 cancel 必须显式 kill + disarm idle timer。非 chatMode 路径
    // listener 仍在（abort 已 kill 一次），此处对已 killed child 是 no-op，无副作用。
    // [T2④ / LC-2] 裸 SIGTERM 收敛到 killRecordChildWithEscalation：SIGTERM 被无视时
    // 30s 升级 SIGKILL——cancel 语义 = 进程必死，不能赌 SIGTERM 生效（record 已终态化，
    // 此后无其他回收通道）。settled watchdog 同步撤下（等待窗口随取消终结，幂等）。
    // [W3 → H1 U6] 在途 run 的实际终止经 controller.abort → 轮级 signal（RemoteEngine
    // cancel 分级：cancel 帧 → grace → 杀链）；[H1 U6] 旧 interact cancel 通道随
    // interact 面退役。
    killRecordChildWithEscalation(record.id, "cancelBackground");
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    this.deps.onRecordFinalizedCleanup(record.id);
    // [A2-1] CAS 抢锁防重复收尾：running 才放行。doFinalizeRecord Step 0 await 窗口内
    // record 可能已被终态化（closed）但尚未 archive——没抢到说明 detached 已 finalize，
    // cancel 来晚了，闭嘴返回 false（completeRecord 会覆写终态 + tombstone/finalized
    // 双标 + notify 双发，绝不可执行）。
    if (!tryTransition(record, "closed", "cancelled")) {
      return false; // detached 已 finalize，cancel 来晚了
    }
    // 抢到锁：completeRecord（用空 result 填 cancelled）+ 终态原语（archive + notify）。
    // cancelled 终态靠 sidecar 标记（session.jsonl 被 abort 截断），collectRecords 重建时
    // override status=cancelled。durationMs 用真实耗时（startedAt → now）。
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    completeRecord(record, cancelledResult, "closed", "cancelled");
    // [M1 sessionFile 锚点提升] 先于终态原语——spawn 窗口期 cancel 的 record
    // 经 engineHandle 提升后，sidecar 与 manifest 都能落在真实子文件上。
    this.promoteSessionFileFromEngineHandle(record);
    // [B2] 终态写面归口 store.markCancelled：.state writeSync（cancelled + 精确 endedAt）+
    // 终态 usage binding 快照 + archive + manifest（closedReason=cancelled 让
    // endedMessageGuard 走「主动关闭」专属文案——sessionFile 缺失形态的重启可见性由此
    // 承接，Gate B sq-c）+ .alive 删（release 出口①）。
    const persisted = this.deps.getStore().markCancelled(record);
    if (!persisted) {
      // [§3.4] .state 重试耗尽：响亮 entry 上报（record 磁盘留 running，boot 孤儿恢复
      // 终态化承接）；cancel 副作用继续——进程已死、CAS 已抢锁，通知与清理不可丢。
      logger.error(
        `[subagents] cancelBackground: terminal state write failed after retries ` +
          `(record=${record.id}); record stays running on disk — boot orphan recovery will finalize it`,
      );
      this.deps.getPi()?.appendEntry?.("subagent:state-write-failed", {
        id: record.id,
        status: "closed",
        closedReason: "cancelled",
      });
    }
    // worktree cleanup（终态 sidecar 单文件单状态，无互斥清理需求）。
    // cleanup 已 async 化——boolean 同步返回语义不变，清理 fire-and-forget。
    if (record.worktreeHandle) {
      void this.deps.getWorktreeManager().cleanup(record.worktreeHandle).catch((err: unknown) => {
        bestEffort(err, "worktree cleanup (cancelBackground)");
      });
    }
    // pending-notifications：cancel 注销（只记 registry 状态）
    this.deps.getNotifyHost().emitPendingUnregister(record.id, "closed");
    // cancel 完成通知（与轮次收尾 .then 对称——cancel 抢先时 .then 跳过 notify）
    this.deps.getCollectCoordinator().route(record);
    return true;
  }

  // ── 域 #18 finalize 簇（H4 落点 D5）──

  /**
   * D-017 时序收尾：委托 doFinalizeRecord（提取到 finalize-record.ts，降低本文件行数）。
   * [Critical #1] cleanup 不因写失败被跳过（写失败在 Step 2 已响亮上报，cleanup 继续；
   * 详见 finalize-record.ts）。 */
  async finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    status: "closed",
    closedReason?: ClosedReason,
  ): Promise<void> {
    await doFinalizeRecord(
      {
        worktreeManager: this.deps.getWorktreeManager(),
        store: this.deps.getStore(),
        modelService: this.deps.getModelService(),
        pi: this.deps.getPi(),
        emitUnregister: (id, st) => this.deps.getNotifyHost().emitPendingUnregister(id, st),
        // [F-5 修复] 同 closeChatIdle——chat 轮路由注销单一汇聚点钩子
        //（[H1 U2] 汇聚点扩为 onRecordFinalizedCleanup：路由注销 + Continuation 清理）。
        onFinalized: (id) => this.deps.onRecordFinalizedCleanup(id),
        sessionDir: this.deps.getSessionsDir(),
      },
      record,
      result,
      status,
      closedReason,
    );
  }

  /** run() 创建期异常的收尾（H1 修复）：createAndConfigureSession 失败会抛，本方法合成 failed
   *  AgentResult → CAS 抢锁 → finalizeRecord（与正常路径同形）。返回合成 result 供 runAndFinalize
   *  继续返回（不 re-throw，swallow 策略）。
   *  [W3 契约变更⑤（run 期失败清理前置副作用）] kickOffEngineRun 前已建的 worktree
   *  （executeViaEngine 创建点，record.worktreeHandle 已绑定）经本方法 → finalizeRecord
   *  → doFinalizeRecord Step 3b cleanupWorktreeIfBound 清理（manifest 多声明 run 期
   *  失败 / engine.run prepare 期 reject 共用本收尾链）；CAS 没抢锁（cancel 抢先终态）
   *  时由 cancelBackground 的 worktree cleanup 覆盖。唯一前置副作用 = worktree（并发
   *  池槽 acquire/release 在 kickOffEngineRun finally 内自回收，journal 是宿主数据不清理）。 */
  async finalizeFailed(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = toErrorMessage(err);
    // durationMs 用真实耗时（startedAt → now），避免失败统计恒为 0 失真。
    const failedResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: errMsg, sessionId: record.id, toolCalls: [] };
    // CAS 抢锁：抢到（status 仍 running）则完整收尾；没抢到（cancel 已先设 cancelled）跳过。
    // SP-1: failed → closed + gc（通用失败终态）。
    if (tryTransition(record, "closed", "gc")) {
      await this.finalizeRecord(record, failedResult, "closed", "gc");
    }
    return failedResult;
  }

  /** S1: 排队中被 abort 走 cancelled 终态（对齐已运行被 abort 的 cancelBackground）。 */
  async finalizeAborted(record: ExecutionRecord): Promise<AgentResult> {
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    if (tryTransition(record, "closed", "cancelled")) {
      await this.finalizeRecord(record, cancelledResult, "closed", "cancelled");
    }
    return cancelledResult;
  }
}
