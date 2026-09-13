// [H3/R3] RecordLifecycle 聚合（域 #4/#11/#17/#18：回收面 + close 三路 + cancel +
// finalize 簇）——自 SubagentService 上帝类 strangler 抽取的第三个聚合的**终态迁移
// 写面**（设计 docs/architecture/subagent-service-decomposition.md §2.1 / §3.3 D5；成员归属
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
//   互调（cancelBackground/close 收起 markArchived——旧 closeChatIdle 已改优雅收口
//   归档/finalizeRecord/promoteSessionFileFromEngineHandle/
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

import * as fs from "node:fs";
import * as path from "node:path";

import { toErrorMessage } from "../../core/error-message.ts";

import { getLogger } from "../../core/logger.ts";

import { bestEffort } from "../best-effort.ts";
import { tryTransition } from "../execution-record.ts";
import { killRecordChildWithEscalation } from "../engine/host/spawned-children.ts";
// [u7a 生产补挂] 批量 dispose 收敛点推最新在途计数（D5 出口——engine 域叶子模块，
// 本模块不得被 inflight-snapshot 反向依赖，import 方向单向安全）。
import { notifyInFlightChanged } from "../engine/inflight-snapshot.ts";
import { startIdleGc } from "../idle-gc.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode record 的 disarm 面（终态化/取消
// 路径防误杀）。
import { disarmIdleTimer } from "../lifecycle-manager.ts";
import { isIdle, isResumable } from "../lifecycle-predicates.ts";
import { doFinalizeRecord } from "../finalize-record.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import { FileRunStore } from "../../orchestration/file-run-store.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { NotifyHost, PiLike } from "../notify-host.ts";
import type { RecordStore } from "../record-store.ts";
// [W4] 轮次活性监督器三态撤下 + settled watchdog disarm（终态路径防 timer 误触发）。
import { disarmRoundFromProtocol, disarmSettledWatchdog } from "../settled-watchdog.ts";
import { resolvePiWorkflowStateDir } from "../workflow-state-root.ts";
import type { WorktreeManager } from "../worktree-manager.ts";
import type { AgentResult, ClosedReason, ExecutionRecord, StopReason } from "../types.ts";

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
  /** NotifyHost（pending 注销 + close 收起终态通知——旧 closeChatIdle 已改优雅收口）。 */
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
   *  closeSubagent 内 continuations.get(id)?.abortAndClearQueue()）。[U5] cancel/
   *  disposeAllRecords 的立即打断路径同样消费（中断轮 + 队列清空）。 */
  readonly abortContinuationQueue: (recordId: string) => void;
  /** [U5] Continuation 仅清队（不打断在飞轮）——close 优雅收口的排队消息作废。 */
  readonly clearContinuationQueue: (recordId: string) => void;
  /** [U5] 在飞轮查询（close 优雅收口 vs 立即归档分流判据——activeRunId 权威）。 */
  readonly hasActiveContinuationRound: (recordId: string) => boolean;
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

  /**
   * SP-4: 关闭所有活跃 record——[U5 / §3.2.5 编排性关闭] 改**自动收起**（设计事件表
   * running+active --编排性关闭--> idle+archived 行 / K10 决策）：
   *
   *   - **立即打断**在飞轮（不挂起、不等收口——主 session 已 fork/new，进程随宿主
   *     回收）：record.controller.abort（级联轮级 signal）+ kill 链记账 + disarm +
   *     Continuation 队列清空（deps.abortContinuationQueue）；
   *   - settle 回 idle：stopReason=interrupted-by-parent（parent-shutdown 走
   *     interrupted-by-restart——§3.2.2 host shutdown 行），**不终态化**（旧 CAS
   *     closed+parent-* 退役）；在飞轮置放弃轮标记（gate ②判据——迟到回注按标记
   *     丢弃，v4 A-6 僵尸回执防御承接；归档静默 gate ①双重兜底）；
   *   - intent=archived（自动收起：旧 session 树内仍可 message 寻回——终态化会剥夺
   *     寻回，K10 被否理由）；
   *   - worktree 按收起同款回收（patch 前移归档点 + cleanup，fire-and-forget——本
   *     函数同步签名保持，dispose 停机窗不 await；竞态丢失面与旧实现一致，由 boot
   *     后 worktree 重建链承接）；
   *   - 归档点补发注销（承接原 emitUnregister 语义，发射点①挂载归档原语）。
   *
   *  [M1 sessionFile 锚点提升] 保留：先于 settle 原语——写面随之携带真实锚点。
   *
   *  @param reason 关闭原因（parent-fork / parent-new / parent-shutdown——只作日志
   *         与 stopReason 映射输入）
   *  @returns 被收起的 record 数量
   */
  disposeAllRecords(reason: ClosedReason): number {
    const stopReason: StopReason =
      reason === "parent-shutdown" ? "interrupted-by-restart" : "interrupted-by-parent";
    const activeRecords = this.deps.getStore().listAllActive();
    let count = 0;
    for (const record of activeRecords) {
      // 回收面 i：abort 在途 controller（排队的 acquire / 在途 signal listener 立即
      // 感知打断）。幂等：已 aborted 的 controller.abort() 是 no-op。
      record.controller?.abort();
      // 回收面 ii：杀链记账（SIGTERM + 30s SIGKILL 升级，收敛 T2④同款）。
      // 回收面 iii：disarm idle timer + settled watchdog（进程回收后 timer 只会误触发）。
      killRecordChildWithEscalation(record.id, `disposeAllRecords (${reason})`);
      disarmIdleTimer(record.id);
      disarmSettledWatchdog(record.id);
      disarmRoundFromProtocol(record.id);
      // 在飞轮打断 + 队列清空（Continuation 打断编排的 dispose 侧触发——立即打断
      // 不挂起，排队消息随主 session 分叉作废）。
      this.deps.abortContinuationQueue(record.id);
      // [M1 sessionFile 锚点提升] 先于 settle 原语——写面随之携带锚点。
      this.promoteSessionFileFromEngineHandle(record);
      if (record.status === "running") {
        // [区1-U2] 打断作废 close 优雅收口挂起（对齐 one-shot 域 settleOneShotOutcome
        // aborted 分支先例）：归档后挂起残留会在寻回复活的下一轮轮终触发意外再归档。
        record.closeAfterRound = undefined;
        // 放弃轮标记（通知 gate ②）：在飞轮 {epoch, round}——迟到回注按两步判定
        // 丢弃；标记随 settle 的 binding 快照持久化（跨重启有效）。
        record.lastAbandonedRound = { epoch: record.epoch ?? 0, round: record.round ?? 0 };
        const settled = this.deps.getStore().markSettled(record, stopReason);
        if (!settled) {
          // CAS 拒绝 = 竞态抢先收口（settle 已被其他路径执行）——不重复 settle，
          // 归档面继续（markArchived 幂等）。
          logger.warn(
            `[subagents] disposeAllRecords: settle rejected for ${record.id} (already settled) — archiving continues`,
          );
        }
      }
      // worktree 收起同款回收：patch 前移归档点（未提交改动快照先于 worktree 销毁）
      // + cleanup。fire-and-forget（本函数同步签名；停机窗 await 会阻塞退出）。
      // [S5 修复] 发起先于 markArchived——markArchived 现清 record.worktreeHandle
      //（归档即绑定消亡），async 闭包在首个 await 前的同步段已捕获 handle 局部量，
      // 但发起在前使两写面的时序不依赖该执行细节。
      if (record.worktreeHandle) {
        void this.archiveWorktreeResources(record, `disposeAllRecords (${reason})`);
      }
      // 自动收起：intent 翻转 archived + `.alive` release + manifest（markArchived，
      // §3.2.4 release 出口①；含 worktreeHandle 清句——S5 修复）。
      this.deps.getStore().markArchived(record);
      // 归档点补发注销（发射点①挂载归档原语；reason 词值 = archived——
      // pending-notifications mapReasonToStatus default 落 completed）。
      this.deps.getNotifyHost().emitPendingUnregister(record.id, "archived");
      count++;
    }
    // [u7a 生产补挂] 批量 dispose 收敛点推一次终态快照（绝对计数语义下循环内逐条推
    // 与收敛后单推等价，单推省 N-1 次同步派发）。此刻镜像已由上方 kill/disarm 全量
    // 清零（壳 dispose 链的 killAllSpawnedChildren 更先行——两清零路径正交幂等）。
    notifyInFlightChanged();
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
   * close action 的统一行为分流（[U5 / §3.2.5 close 行] close = 收起（archived），
   * 不再终态化；force 只影响在飞轮的处置时机）。
   *
   *   running + force:true  → cancel 语义立即打断（abort + settle interrupted + 放弃
   *                           轮标记）+ 随即归档
   *   running + force:false（chatMode 在飞轮 / one-shot 有活进程）
   *                         → 置 closeAfterRound 挂起（**优雅收口**——不打断在飞轮），
   *                           收口轮 settle → 轮次通知送达 → 归档（消费点：
   *                           Continuation settle 分支 / one-shot 主干尾部，
   *                           顺序约束 [写死]——intent 翻转必须在通知链之后，
   *                           否则 gate ①归档静默吞掉收口轮通知）
   *   running + force:false + 无活进程（isIdle/isResumable）
   *                         → 立即归档收口（archiveIdleRecord）
   *   idle                  → 立即归档收口（幂等——已 archived 时 markArchived no-op）
   *
   * @param record 目标 record（getRecordForAction 已校验归属）
   * @param force true=立即终止（中断在飞轮）/ false=优雅关闭（等收口轮）
   */
  async closeSubagent(record: ExecutionRecord, force: boolean): Promise<void> {
    this.deps.assertReady();
    if (record.status === "running") {
      if (force) {
        // 立即终止 = cancel 语义（不终态化）+ 归档。cancelBackground 的返回值只
        // 反映「是否有在飞轮被中断」，归档幂等恒执行。
        this.cancelBackground(record);
        await this.archiveIdleRecord(record);
        return;
      }
      const inFlightRound = this.deps.hasActiveContinuationRound(record.id);
      if (!inFlightRound && (isIdle(record) || isResumable(record))) {
        // 无在跑轮（[M5] isIdle timer armed 保活 / isResumable 轮终进程已回收——
        // chat 轮间与 one-shot 完成态同判；在飞轮判据以 Continuation activeRunId
        // 为权威——进程镜像对协议轮有 spawn 窗误判面）：立即归档收口
        //（archiveIdleRecord 内回收保活进程 + disarm timer）。
        await this.archiveIdleRecord(record);
        return;
      }
      // 在飞轮在跑（chat / one-shot）：[U5] 优雅收口——不打断在飞轮（设计 close 行
      // 「在飞轮优雅收口后归档」，closeAfterRound 挂起消费机制沿用），轮终 settle →
      // 通知送达后由 Continuation settle 分支 / one-shot 主干尾部消费归档（顺序约束
      // [写死]）。排队消息随 close 意愿作废（clearQueue 只清队不打断）。
      this.deps.clearContinuationQueue(record.id);
      record.closeAfterRound = true;
      return;
    }
    // idle record（settle 后 / 从未 running）：立即归档收口。
    await this.archiveIdleRecord(record);
  }

  /**
   * [U5 / §3.2.5] 归档资源编排（close 意愿动作的资源收口单点）：
   *   collectPatch 前移（未提交改动快照先于 worktree 销毁——原 doFinalizeRecord
   *   Step 0 机制挂载归档点）→ worktree 立即回收 → store.markArchived（intent 翻转
   *   + `.alive` release + manifest，§3.2.4 release 出口①）→ 归档点补发注销（承接
   *   原 emitUnregister 语义，发射点①挂载归档原语）→ notifyClosed「已收起」提示
   *   （chatMode 一条——终态通知消亡后的归档提示载体，载荷判据经 toNotifyRecord
   *   的 archived 分支落 closed+completed）。
   *
   * 顺序约束 [写死]：挂起路径（closeAfterRound）本方法只能在**收口轮轮次通知送达
   * 之后**调用（Continuation settle 分支 / one-shot 主干尾部的 route 之后）——归档
   * 即 gate ①静默，提前调用会吞掉收口轮通知。立即路径（idle close / force）无在飞
   * 通知约束。
   */
  async archiveRecord(record: ExecutionRecord, source: string): Promise<void> {
    if (record.worktreeHandle) {
      await this.archiveWorktreeResources(record, source);
    }
    this.deps.getStore().markArchived(record);
    // 归档点补发注销（pending-notifications registry 记账——通知由通知链自有路径）。
    this.deps.getNotifyHost().emitPendingUnregister(record.id, "archived");
    // 「已收起」提示（chatMode；one-shot 显式静默——notifyClosed 内部 chatMode 门，
    // G4 one-shot close 字节不变承诺延续）。归档后调用：toNotifyRecord 的 archived
    // 分支放行 closed 载荷。
    this.deps.getNotifyHost().notifyClosed(record, true);
  }

  /**
   * worktree 资源收口（patch 前移 + cleanup，串行 async 链）。archiveRecord 与
   * disposeAllRecords（同步链 fire-and-forget）共用——失败 best-effort 留痕不阻断
   * 归档写面（patch 失败 = 续聊重建时无备份可恢复，形态①降级承接；cleanup 失败
   * = reaper 兜底）。
   */
  private async archiveWorktreeResources(record: ExecutionRecord, source: string): Promise<void> {
    const handle = record.worktreeHandle;
    if (!handle) return;
    const manager = this.deps.getWorktreeManager();
    try {
      // patch 前移（collectPatchIfWorktree 同款——sessionsDir/<branch>.patch，
      // written 才回填防悬空路径）。
      const sessionsDir = getSubagentSessionDir(
        this.deps.getModelService().getAgentDir(),
        handle.mainCwd,
      );
      fs.mkdirSync(sessionsDir, { recursive: true });
      const patchFile = path.join(sessionsDir, `${handle.branch}.patch`);
      const patch = await manager.collectPatch(handle, patchFile);
      if (patch.written) record.patchFile = patchFile;
    } catch (err) {
      bestEffort(err, `collectPatch (archive ${source})`);
    }
    try {
      // [S5 修复] keepBranch：归档回收释放 checkout（并发写隔离语义达成）但保留
      // 分支——分支是续聊重建依据（reconstruct 按 `pi-sub-<recordId>` 命名约定 +
      // rev-parse --verify 重建；删了分支 = 重建依据消亡，续聊恒降级 reopen）。
      await manager.cleanup(handle, { keepBranch: true });
    } catch (err) {
      bestEffort(err, `worktree cleanup (archive ${source})`);
    }
  }

  /**
   * 无在跑轮 record 的手动收起（close action 的 idle / 无活进程分支）。
   *
   * [M5] 保留保活进程回收语义：isIdle（timer armed 保活）必须先显式回收进程 +
   * disarm timer——否则归档后无人再杀它。随后走 {@link archiveRecord} 归档编排
   * （不终态化——record 留内存 idle + archived，message 寻回可续聊）。
   */
  async archiveIdleRecord(record: ExecutionRecord): Promise<void> {
    // [T2④ / LC-2] SIGTERM 被无视时 30s 升级 SIGKILL；settled watchdog 同步撤下。
    // [W3] 实际终止在引擎进程内（kill 链记账 + abort 驱动）。
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    killRecordChildWithEscalation(record.id, "archiveIdleRecord");
    await this.archiveRecord(record, "close(idle)");
  }

  /**
   * [U5 / §3.2.1 资源组] idle 超时**进程回收**（现状 5min 保留）：idle timer 到期
   * 只回收保活进程——归档（archived）是用户意愿位（close 专属），超时不是用户动作，
   * 不动 intent / 占用位 / stopReason，record 保持 idle 随时可续聊（锚在）。
   * （[H1 U6→U5] 旧 closeNow = idle 超时终态化——终态概念删除后改为纯资源回收。）
   */
  async idleTimeoutRecycle(record: ExecutionRecord): Promise<void> {
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    killRecordChildWithEscalation(record.id, "idleTimeoutRecycle");
  }

  // [H1 U6] closeAfterRoundSettled（[M5] chat 域「轮完成时终态化」消费面）已随 chat 域
  // closeAfterRound 挂起标志退役删除：D4 close = abort 在途 + 清空队列 + 立即终态化
  //（[U5] 旧 closeChatIdle 语义已改 archiveIdleRecord 归档收口）；one-shot 域的
  // closeAfterRound 消费走 consumePendingArchive（主干尾部 route 后归档）
  //（settleOneShotOutcome，照旧）。

  // ── 域 #17 取消 ──

  /** 取消 background record（[U5] cancel = 暂停这一轮：中断 + settle + 放弃轮标记，
   *  不终态化）。false = record 非 running（无在飞轮可中断——idle/已收口态）。 */
  cancel(id: string): boolean {
    this.deps.assertReady();
    const record = this.deps.getStore().getMutable(id);
    if (!record) return false;
    return this.cancelBackground(record);
  }

  /**
   * 取消 background record——[U5 / §3.2.5 cancel 行] 新语义：abort 当前轮（Continuation
   * D2 打断编排）→ settle 为 idle + stopReason=interrupted → **置放弃轮标记**
   * lastAbandonedRound={epoch, round}（通知 gate ②判据，随 settle 的 binding 快照
   * 持久化）。**不再终态化**（旧 CAS closed+cancelled + `.state` cancelled tombstone +
   * worktree cleanup + manifest cancelled 全部退役）——record 留内存 idle 随时可续聊
   * （G4：cancel 不是处决）；取消轮不产生完成通知（settle 簿记既有承接——旧
   * route(record) 完成回注删除，中断轮的迟到引擎帧由 gate ②标记判定丢弃）。
   *
   * stop 手段（abort/kill/disarm/队列清空）无条件先执行：对 idle record 幂等无害，
   * 且保证 cancel 语义 = 进程必死（[M6/T2④] kill 链 + escalation 保留——abort 轮级
   * signal 驱动引擎停轮，kill 链对已退出子进程是幂等记账）。
   *
   * CAS：仅 running 放行（markSettled 内部判定）。没抢到（竞态已 settle）返回 false，
   * 不重复置标记（竞态赢家的 settle 语义优先——[A2-1] 防双收尾精神保留）。
   *
   * @returns true = 中断完成；false = record 非 running（无在飞轮，cancel 无对象）。
   */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    // [M6/T2④/LC-2] 显式 kill + disarm：abort 轮级 signal 驱动引擎停轮（cancel 帧 →
    // grace → 杀链），killRecordChildWithEscalation 保证镜像/残留进程必死；settled
    // watchdog 撤下（等待窗口随取消终结）。
    killRecordChildWithEscalation(record.id, "cancelBackground");
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    // 在飞轮打断 + 队列清空（cancel 语义 = 停下这一轮——排队消息随用户显式叫停丢弃；
    // Continuation 实例保留：record 未消亡，续聊经 continuationFor 复用）。
    this.deps.abortContinuationQueue(record.id);
    // [M1 sessionFile 锚点提升] 先于 settle 原语——写面随之携带锚点（spawn 窗口期
    // cancel 的 record 经 engineHandle 提升后落真实子文件）。
    this.promoteSessionFileFromEngineHandle(record);
    if (record.status !== "running") {
      return false; // 无在飞轮可中断（idle / 竞态已 settle）
    }
    // 置放弃轮标记（通知 gate ②判据）：在飞轮 {epoch, round}。随 markSettled 的
    // binding 快照持久化（跨重启有效——丢标记 = 中断轮迟到回注防双发失效）。
    // [区1-U2] 打断作废 close 优雅收口挂起（对齐 one-shot 域 settleOneShotOutcome
    // aborted 分支先例）：cancel 抢先 settle 后轮收敛回调（onRunSettled）被 status
    // 守卫拦截，挂起的消费点不可达——残留挂起会在用户续聊的下一轮轮终触发意外归档
    //（cancel 语义 = 暂停这一轮可以继续聊，§3.2.5）。
    record.closeAfterRound = undefined;
    record.lastAbandonedRound = { epoch: record.epoch ?? 0, round: record.round ?? 0 };
    const persisted = this.deps.getStore().markSettled(record, "interrupted");
    if (!persisted) {
      // markSettled CAS 拒绝 = 竞态抢先收口（同 [A2-1]——对方收尾语义优先，闭嘴
      // 返回 false）。markSettled 对 .state 写失败 warn 后仍返回 true（轮收口非终态，
      // 内存态已收口，磁盘面滞后由下次收口/接管补写）。
      return false;
    }
    // pending-notifications：取消轮注销（进程已死从活跃差集移除；reason=interrupted——
    // 词表映射 aborted）。取消轮不产生完成通知（设计 cancel 行——无需额外注销）。
    this.deps.getNotifyHost().emitPendingUnregister(record.id, "interrupted");
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

  /**
   * run() 创建期异常的收尾（H1 修复）：createAndConfigureSession 失败会抛，本方法合成
   * failed AgentResult。返回合成 result 供 runAndFinalize 继续返回（不 re-throw，
   * swallow 策略）。
   *
   * [U5 / §3.2.2 事件表 settle 行] 失败轮**不终态化**（旧 closed+gc 一次性销毁退役）：
   * markRoundIdle failed（保持 running-resumable——与成功 SP-5 同形态，失败轮同样
   * 万物可续 G1；stopReason/批次投影归轮终簿记）。CAS 前置检查防 cancel/dispose 抢先
   * settle 后 double bookkeeping（与簿记之间无 await——单线程同步段原子）。
   *
   * [W3 契约变更⑤退役] 旧 worktree cleanup 随终态化退役：失败轮 record 留内存，
   * worktree 随续聊保留 / 随归档（close）回收 / 随 idle-gc（30 天）回收。
   */
  async finalizeFailed(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = toErrorMessage(err);
    // durationMs 用真实耗时（startedAt → now），避免失败统计恒为 0 失真。
    const failedResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: errMsg, sessionId: record.id, toolCalls: [] };
    // [D7 例外族] workflow origin 失败 = 立即终态化（维持现状——workflow agent 结果
    // 由脚本返回值承载，留内存 idle 会绑架 hasRunning / 恒挂 idle-gc / 被误升级 /
    // goal defer 恒挂，设计 D7 四面连带；§1.4 out-of-scope）。
    if (record.origin === "workflow") {
      if (tryTransition(record, "closed", "gc")) {
        await this.finalizeRecord(record, failedResult, "closed", "gc");
      }
      return failedResult;
    }
    // CAS 前置：cancel/dispose 抢先 settle（status 已离 running）则跳过簿记。
    if (record.status === "running") {
      this.deps.getStore().markRoundIdle(record.id, { kind: "failed", reason: errMsg });
    }
    return failedResult;
  }

  /**
   * S1: 排队中被 abort（[U5] 非 workflow 对齐 cancelBackground 新语义：settle
   * interrupted + 放弃轮标记，不终态化——排队窗 abort 与在飞 abort 同为「用户取消」
   * 语义；workflow origin 维持 cancelled 终态化，D7 例外族）。
   */
  async finalizeAborted(record: ExecutionRecord): Promise<AgentResult> {
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    if (record.origin === "workflow") {
      if (tryTransition(record, "closed", "cancelled")) {
        await this.finalizeRecord(record, cancelledResult, "closed", "cancelled");
      }
      return cancelledResult;
    }
    this.cancelBackground(record);
    return cancelledResult;
  }
}
