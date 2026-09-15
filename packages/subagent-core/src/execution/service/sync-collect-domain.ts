// [H3/R2] SyncCollectDomain 聚合（域 #5：sync 批缓冲 + E9 dispose 转账）
// ——自 SubagentService 上帝类 strangler 抽取的第二个聚合（设计
// docs/architecture/subagent-service-decomposition.md §2.1 域 #5 / §3.3 D1 v3；成员归属以
// r0-inventory.md 清单① #26-#28 + 域 #5 分区为准）。
//
// 单一职责：自闭合批语义（设计 §3.1.4/§3.1.5）——collectCoordinator 装配（sync 批
// 缓冲 + 闭合检测 + flush 分流 + 批闭合自动 close）、E9 dispose 转账（放弃攒批逐条转
// async + 协调状态清空）、collectSync 配置读取。
//
// [modeless 波3·E1 退役] 崩溃恢复钩子（E1 扫描补发 + settled 有界重扫）随 collectMode
// 记录态消亡一并退役：批协调状态 = 协调器内存登记态（registerMember 派发登记），随
// session 生命周期消亡、崩溃后不恢复（调用方 subagent-workflow session-lifecycle 的
// service.recoverSyncCollectBatch() 调用点保留为 accepted-no-op 至波 5 清理）。成员
// record 本体不受影响：已 settle 成员 idle+result（通知已投递/随批投递），崩溃在途
// 成员由孤儿恢复纠偏 idle+interrupted。
//
// [D1 v3 红线 → U3 批写归口] 本聚合原直调的批写面已归口 store.markBatchFinalized
//（r0-inventory 清单②「不得改道」行随 record 持久化收敛设计 §3.1 markBatchFinalized
// 统一写点而终结）：批终态三写（manifest 屏障 + batchFinalized 落标）全部经 store
// 意图原语。

// [R1 打样模式——R2 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值），聚合持过期引用会破 session
//    复活（dispose → initSession 翻转 disposed / pi / mainSessionFile 等），一切运行时
//    可变态断言/调用时现读。
//    [检查点①] flushBatch 依赖 service 闭包（原壳构造器装配闭包经 this.* 读 store/
//    notifyHost/sessionRootId）改为本 deps 接口显式注入——service 整实例零注入，
//    flushBatch 闭包随聚合迁移，闭包内读的聚合私有成员（屏障/落标/预算）走聚合 this，
//    外部状态走 deps 现读 getter。
// 2. 转发壳写法：壳保留同名私有 getter（collectCoordinator）与同名 public 方法
//    （getCollectSyncDefault，D3 对外签名不变）单行转发。
// 3. 跨聚合边收敛：他域直写本域字段的写点收敛为本聚合显式接口方法（G2 聚合间零
//    直写）——dispose()（壳 dispose 编排调用，批协调状态清空）。
// 4. 深绑测试：本域测试面（collect-coordinator-service / collect-mixed-dispatch 等）
//    的深绑点全部指向留壳字段（store/manifestStore/modelService/notifyHost）或壳转发
//    getter——晚绑定 deps 现读使 FR 字段替换语义保持。

import { getLogger } from "../../core/logger.ts";

import { CollectCoordinator } from "../assembly/collect-coordinator.ts";
import { DEFAULT_COLLECT_SYNC } from "../assembly/config.ts";
import type { BatchBudgetParams, BgNotifyRecord } from "../notify/notifier.ts";
import { bufferedMemberFallbackRecord } from "../persistence/sync-rebuild.ts";
import type { CollectSyncConfig, ExecutionRecord, SubagentRecord } from "../assembly/types.ts";

const logger = getLogger("subagents");

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。全 getter 形态（零回调）：
 * 本聚合自闭合批语义，无跨域编排——dispose 侧 E9 转账/状态清空由壳编排调用本聚合
 * 显式方法（正向），聚合对他域零反向写。
 */
export interface SyncCollectDomainDeps {
  /** RecordStore 窄门面（闭合判定扫描 / flushBatch 冷路径重建 / 批终态写）。
   *  [U3 批写归口] manifest 屏障 + batchFinalized 落标合一进 markBatchFinalized（store
   *  唯一写入口，设计 §3.1）。 */
  readonly getStore: () => {
    listAllActive(): ExecutionRecord[];
    getFullRecord(id: string): SubagentRecord | undefined;
    markBatchFinalized(records: readonly SubagentRecord[]): Promise<void>;
  };
  /** NotifyHost 窄门面（async 直通 / 快照映射 / 单条直发 / 批投递）。晚绑定现读：
   *  测试的 notifyHost 字段替换（FR 深绑形态）经壳字段现读保持生效。 */
  readonly getNotifyHost: () => {
    toNotifyRecord(record: ExecutionRecord, opts?: { batchMember?: boolean }): BgNotifyRecord | undefined;
    notify(record: BgNotifyRecord): void;
    notifyBatch(records: readonly BgNotifyRecord[], budget?: BatchBudgetParams): boolean;
  };
  /** 批成员自动 close（[modeless 波3]：批闭合自动归档——成员为一次性计算单元，
   *  批通知即终态通知；归档编排本体在 RecordLifecycle.archiveBatchMembers，经壳装配
   *  闭包注入。本聚合零 lifecycle 直依）。 */
  readonly closeMembers: (recordIds: readonly string[]) => Promise<void>;
  /** 所属根 session ID（flushBatch 兜底落标归属；#2 聚合字段现读）。 */
  readonly getSessionRootId: () => string | null;
  /** collectSync 配置节热读（budget/default 同一读取点，modelService 留壳——窄化
   *  为节读取，聚合不感知 ModelConfigService）。 */
  readonly getCollectSyncSection: () => CollectSyncConfig | undefined;
}

/**
 * 域 #5 聚合：sync 批自闭合语义（R2 自 SubagentService 抽取；[modeless 波3] E1 面退役）。
 *
 * 字段所有权（r0-inventory 清单① #26-#28 全部 3 个）：本聚合唯一写者；壳经
 * collectCoordinator getter 只读透传（route/register 调用点），其余字段壳零感知。
 */
export class SyncCollectDomain {
  private readonly deps: SyncCollectDomainDeps;

  /** collectCoordinator（subagent-sync-collect U2）：完成通知唯一路由入口——
   *  async 直通（字节不变）/ sync 批缓冲 + 闭合检测。
   *  构造期装配后不可变（readonly），壳经 getter 只读透传。
   *  [U3 接线点] 已接线：flush = store.markBatchFinalized（manifest 屏障 + batchFinalized
   *  落标合一原语，屏障 await 全部落盘——出口①，见下方闭包注释）先于
   *  notifier.notifyBatch 单条批投递（幂等键 sync-batch:<hash> ledger 写账 →
   *  attemptDeliver 边沿投递），投递后批成员自动 close（[modeless 波3]，通知送达后
   *  归档——close 顺序约束 [写死] 同款）；闭合触发排程合批 flush：同宏任务去抖窗口
   *  收纳背靠背 route——U8 拆批盲窗修复。屏障先于写账 = 「通知可达 ⇒ 索引就位」的
   *  构造性保证（时序竞态修复，见 flushBatch 闭包注释）。
   *  [U8] 排程与 E9 交互：dispose 经 convertPendingSyncBufferToAsync 先取消挂起排程
   *  （取消而非同步 flush——双通道并发写账防护，见该函数注释）。 */
  private readonly _collectCoordinator: CollectCoordinator;

  constructor(deps: SyncCollectDomainDeps) {
    this.deps = deps;
    // [检查点①] 闭包依赖显式化：闭包内聚合私有成员走 this，外部状态（notifyHost/
    // store/sessionRootId）经 deps 晚绑定 getter 现读——不持引用、不整实例注入。
    this._collectCoordinator = new CollectCoordinator({
      notifyAsync: (record) => {
        const notify = this.deps.getNotifyHost().toNotifyRecord(record);
        if (notify) this.deps.getNotifyHost().notify(notify);
      },
      toNotifyRecord: (record, opts) => this.deps.getNotifyHost().toNotifyRecord(record, opts),
      // 闭合判定数据源：listAllActive（原始 ExecutionRecord 内存态，status 原始值）。
      // 成员资格由协调器登记集承载（[modeless 波3]），扫描只读 status
      // （isCollectPending）——未收口成员必在内存（archive 只删终态），内存视图语义完整。
      listRecords: (limit) => this.deps.getStore().listAllActive().slice(0, limit),
      flushBatch: async (members) => {
        // 成员全量快照：getFullRecord 冷路径重建（成员在 route 前已 settle；闭合判定
        // hasUnsettledMember 的 listRecords 扫描已建 idToFile 索引，此处命中）。快照在
        // 屏障前一次取定，屏障写与落标共用同一份（manifest 与落标 entry 字段同源）。
        // [S11] getFullRecord 不可达（子 session 文件缺失/已 GC 的窗口）的成员改用
        // 缓冲快照兜底落标，不再跳过——该成员仍随 live 进批写账（成员集 hash 含它），
        // 跳过落标的旧行为会在重启后让恢复链重新收集它（无标记候选），以异成员集 hash
        // 重新补发 → 同成员双投递（异 hash 不触发账本 sync-batch 幂等）。
        const fulls: SubagentRecord[] = [];
        const fullMissed: BgNotifyRecord[] = [];
        for (const m of members) {
          const full = this.deps.getStore().getFullRecord(m.id);
          if (full) fulls.push(full);
          else fullMissed.push(m);
        }
        // [U3 批写归口] manifest 屏障 + batchFinalized 落标合一进 store.markBatchFinalized
        //（唯一写入口；内部序 = manifest 落盘**完成**先于落标 entry，manifestDir 接线后
        // 同步落盘无 fire-and-forget），整体先于 notifyBatch 写账投递——「通知可达 ⇒
        // 索引就位」构造性保持（D4②/D5，缓存降级下 barrier 不可删）。miss 成员（S11）
        // 以缓冲快照兜底同批落标——markBatchFinalized 会为其多写一笔 manifest（投影
        // sessionFile undefined 自然缺省），较旧路径（miss 成员零 manifest）只多不少，
        // 反查落空本就由 session-reader 绝对路径兜底承接。
        await this.deps.getStore().markBatchFinalized([
          ...fulls,
          ...fullMissed.map((m) => bufferedMemberFallbackRecord(m, this.deps.getSessionRootId() ?? undefined)),
        ]);
        // 单条批投递：空批/dispose → 零副作用返回（设计 §3.1.3 出口①）。
        // [U3 源序变化] 落标已随 markBatchFinalized 前置到写账前——合一原语形态下
        // 「屏障 → 写账 → 落标」三段不可兼得，构造性 barrier 优先（设计钉死不可删）；
        // accepted=false（同成员集批已在账——重复 flush 形态）时已落标属幂等覆写
        // （appendEntry last-writer-wins，该批此前成功投递时已落标），无行为差异。
        this.deps.getNotifyHost().notifyBatch(members, this.getCollectSyncBudget());
        // [modeless 波3] 批闭合自动 close：通知送达后归档成员（close 顺序约束 [写死]
        // 同款——归档即 gate ①静默，提前会吞批通知）。成员为一次性计算单元，批通知
        // 即终态通知；自动 close 后 record 不再 idle 留守，E4（sync+conversation 组合）
        // 的升级语义面结构性消亡。「续聊批成员」路径 = fork-from（归档 record 可 fork，
        // 已有能力）。归档幂等（markArchived no-op）；此处 await 完整归档编排
        //（worktree 回收含在内——见 RecordLifecycle.archiveBatchMembers）。
        await this.deps.closeMembers(members.map((m) => m.id));
      },
    });
  }

  // ── 壳只读透传面（getter）──
  // [R1 打样模式 2] 壳侧同名私有 getter 透传（route/register 调用点零改动）；写路径
  // 无——构造期 readonly 装配后不可变。

  get collectCoordinator(): CollectCoordinator {
    return this._collectCoordinator;
  }

  /** [modeless 波3] 当前登记成员数（pendingSyncCount 口径，start 响应回显段消费）。 */
  get memberCount(): number {
    return this._collectCoordinator.memberCount;
  }

  // ── E9：dispose 转账（壳 dispose 编排调用，时序见壳 dispose 注释）──

  /** [E9] dispose 时批未闭合：缓冲中已终态未通知成员逐条转 async 语义写账（放弃攒批）
   *  + 落 batchFinalized 标记 + 协调状态整体清空，交由既有 shutdown flush / resume
   *  重放兑底；仍在跑的成员走现有退出路径（disposeAllRecords 关闭，与 async 一致）。
   *  写账用 notifier.notify 现有通路（ledger.record + attemptDeliver）。
   *  [modeless 波3] 末尾 clear()：缓冲 + 登记集 + 挂起排程整体清空——同进程 revive
   *  后陈旧协调状态不得跨 session 复活（旧 e9ConvertedIds 防御过滤随整体清空消亡：
   *  clear 后缓冲必空，flushBatch 闭包无陈旧成员可重投）。 */
  convertPendingSyncBufferToAsync(): void {
    // [U8 拆批修复·E9 交互] 挂起的合批排程先取消——dispose 已选「放弃攒批转 async」
    // 语义（最简语义 = 取消而非同步 flush）：放任排程触发会让 flushBatch（批 hash
    // 通道）与下方逐条 notify（async id 通道）双通道并发写账 → 同成员双投递，且触发
    // 点可能落在 notifier/store dispose 之后。取消后缓冲原样保留，本函数既有单通路
    // 完整接管（协调器侧幂等：无排程时 no-op）。
    this._collectCoordinator.cancelScheduledFlush();
    const members = this._collectCoordinator.pendingMembers();
    for (const member of members) {
      this.deps.getNotifyHost().notify(member);
    }
    if (members.length > 0) {
      this.markMembersBatchFinalized(members.map((m) => m.id));
      logger.warn(
        `[subagents] E9 dispose: converted ${members.length} buffered sync member(s) to async notify`,
        { ids: members.map((m) => m.id) },
      );
    }
    this._collectCoordinator.clear();
  }

  // ── collectSync 配置读取（壳 public 转发 getCollectSyncDefault）──

  /**
   * collectSync.default 当前生效值（subagent-sync-collect U2，偏差#3 接线：
   * startHandler 缺省 collect 解析用）。
   * config 未配/读失败 → DEFAULT_COLLECT_SYNC.default 兜底（E5 不炸启动）。
   * 新 session 生效语义与 engine 配置一致（globalConfig 由 ModelConfigService
   * reloadGlobalConfig 刷新）。
   */
  /** collectSync 节单读取点（S9，code-simplify）：「读节」一处，「投影成 default 或
   *  budget」各自 accessor 负责（getCollectSyncDefault / getCollectSyncBudget）。 */
  private collectSyncSection(): CollectSyncConfig | undefined {
    return this.deps.getCollectSyncSection();
  }

  getCollectSyncDefault(): "async" | "sync" {
    return this.collectSyncSection()?.default ?? DEFAULT_COLLECT_SYNC.default;
  }

  /** [U4 deviation #8 接线] collectSync 预算热读（flush 时读值，与 getCollectSyncDefault
   *  同款访问链）。节缺失/读失败 → undefined → notifyBatch 落 buildBatchLlmContent
   *  设计默认值（4000/24000，E5 不炸启动）。sanitizeCollectSync 保证节存在时两字段
   *  必有合法正整数。 */
  private getCollectSyncBudget(): BatchBudgetParams | undefined {
    const cs = this.collectSyncSection();
    return cs !== undefined ? { perItemChars: cs.perItemChars, totalChars: cs.totalChars } : undefined;
  }

  // ── 批投递内部通路（E9 共用）──

  /** [E9 专用] batchFinalized 落标 + manifest 写（设计 §3.1.5 E9）——已归口
   *  store.markBatchFinalized（U3 批写归口）。E9 转换的成员走 async 单条通知（全文
   *  注入、无指针行消费），manifest 无时序要求，且 dispose 编排中写账（逐条 notify）
   *  先于本调用——「写账先于落标」源序在此路径保持。
   *  路径 = getFullRecord 冷路径重建 → markBatchFinalized（manifestDir 接线后 manifest
   *  同步落盘，dispose 同步链内完成——D8 停机窗方向；落标 entry 随原语后半落）。
   *  getFullRecord 不可达（子 session 文件缺失/已 GC）→ 跳过该成员（详见 flushBatch
   *  闭包注释）。 */
  private markMembersBatchFinalized(memberIds: readonly string[]): void {
    const fulls: SubagentRecord[] = [];
    for (const id of memberIds) {
      const full = this.deps.getStore().getFullRecord(id);
      if (full) fulls.push(full);
    }
    // 反查索引缺失只影响指针行反查（session-reader 错误文案已指引绝对路径兜底），
    // 不构成落标失败（原语内部 best-effort 同源语义）。
    void this.deps.getStore().markBatchFinalized(fulls);
  }
}
