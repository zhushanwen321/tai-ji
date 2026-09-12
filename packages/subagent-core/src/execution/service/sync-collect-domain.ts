// [H3/R2] SyncCollectDomain 聚合（域 #5：sync 批缓冲 + E9 dispose 转账 + E1 崩溃恢复）
// ——自 SubagentService 上帝类 strangler 抽取的第二个聚合（设计
// docs/design/subagent-service-decomposition.md §2.1 域 #5 / §3.3 D1 v3；成员归属以
// r0-inventory.md 清单① #26-#28 + 域 #5 分区为准）。
//
// 单一职责：自闭合批语义（设计 §3.1.4/§3.1.5）——collectCoordinator 装配（sync 批
// 缓冲 + 闭合检测 + flush 分流）、E9 dispose 转账（放弃攒批逐条转 async）、E1 崩溃
// 恢复（末条 entry 扫描 → 补发 + 落标）、settled 有界重扫、collectSync 配置读取。
//
// [D1 v3 红线 → U3 批写归口] 本聚合原直调的批写面已归口 store.markBatchFinalized
//（r0-inventory 清单②「不得改道」行随 record 持久化收敛设计 §3.1 markBatchFinalized
// 统一写点而终结）：批终态三写（manifest 屏障 + batchFinalized 落标）全部经 store
// 意图原语；E1 重建投影 sync-rebuild.ts 模块函数（D 通道）、scanLastRecordEntries
// 读——保持 store 直调/模块函数直调，不经任何中转。

// [R1 打样模式——R2 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值），聚合持过期引用会破 session
//    复活（dispose → initSession 翻转 disposed / pi / mainSessionFile 等），一切运行时
//    可变态断言/调用时现读。
//    [检查点①] flushBatch 依赖 service 闭包（原壳构造器装配闭包经 this.* 读 store/
//    notifyHost/sessionRootId）改为本 deps 接口显式注入——service 整实例零注入，
//    flushBatch 闭包随聚合迁移，闭包内读的聚合私有成员（e9ConvertedIds/屏障/落标/
//    预算）走聚合 this，外部状态走 deps 现读 getter。
// 2. 转发壳写法：壳保留同名私有 getter（collectCoordinator）与同名 public 方法
//    （recoverSyncCollectBatch/getCollectSyncDefault，D3 对外签名不变）单行转发；
//    纯内部方法（屏障/落标/预算等）壳内零转发（壳内无消费点）。
// 3. 跨聚合边收敛：他域直写本域字段的写点收敛为本聚合显式接口方法（G2 聚合间零
//    直写）——resetSettledRescan()（C-2：SessionBaselines.initSession 复活重置，
//    R1 打样时以 deps.resetSettledRescan 回调留的对接点，本聚合交付后改指此处）；
//    lazyDispose()（C-1：壳 dispose 惰化 settled 重扫 handler，原直改
//    settledRescanState.disposed）。
// 4. 深绑测试：本域测试面（sync-collect-recovery / collect-coordinator-service /
//    collect-mixed-dispatch 等）的深绑点全部指向留壳字段（store/manifestStore/
//    modelService/notifyHost）或壳转发 getter——晚绑定 deps 现读使 FR 字段替换语义
//    保持，聚合实例经壳 getter 读取与直读字段同一对象，断言零改写。

import { getLogger } from "../../core/logger.ts";

import { CollectCoordinator } from "../collect-coordinator.ts";
import { DEFAULT_COLLECT_SYNC } from "../config.ts";
import type { BatchBudgetParams, BgNotifyRecord } from "../notifier.ts";
import { bufferedMemberFallbackRecord, syncRebuildToNotifyMember } from "../sync-rebuild.ts";
import type { CollectSyncConfig, ExecutionRecord, SubagentRecord } from "../types.ts";

const logger = getLogger("subagents");

/** [v2 D4] E1 等待分支 settled 有界重扫上限。无上限重扫 = 泄漏（设计 §3.3 D4 被否
 *  谱系）；8 次覆盖重启后主 agent 对 resumable 成员的典型续跑轮次，达限仍有
 *  running → disposed，交下次 session_start 收敛。
 *  [R2] 常量 SSOT 随唯一消费主体（armSettledRescan）自壳文件迁入本聚合。 */
const SETTLED_RESCAN_LIMIT = 8;

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。全 getter 形态（零回调）：
 * 本聚合自闭合批语义，无跨域编排——dispose 侧 E9 转账/惰化由壳编排调用本聚合
 * 显式方法（正向），聚合对他域零反向写（settledRescanState 复活重置由他域经
 * resetSettledRescan 显式接口回调，见 C-2）。
 */
export interface SyncCollectDomainDeps {
  /** RecordStore 窄门面（E1 扫描读 / flushBatch 冷路径重建 / 批终态写 / 闭合判定扫描）。
   *  [U3 批写归口] manifest 屏障 + batchFinalized 落标合一进 markBatchFinalized（store
   *  唯一写入口，设计 §3.1）；reportSubagentRecord 直调通道随落标归口消亡。 */
  readonly getStore: () => {
    listAllActive(): ExecutionRecord[];
    getFullRecord(id: string): SubagentRecord | undefined;
    markBatchFinalized(records: readonly SubagentRecord[]): Promise<void>;
    scanLastRecordEntries(mainSessionFile: string | undefined): SubagentRecord[];
  };
  /** NotifyHost 窄门面（async 直通 / 快照映射 / 单条直发 / 批投递）。晚绑定现读：
   *  测试的 notifyHost 字段替换（FR 深绑形态）经壳字段现读保持生效。 */
  readonly getNotifyHost: () => {
    toNotifyRecord(record: ExecutionRecord): BgNotifyRecord | undefined;
    notify(record: BgNotifyRecord): void;
    notifyBatch(records: readonly BgNotifyRecord[], budget?: BatchBudgetParams): boolean;
  };
  /** pi 句柄（armSettledRescan 注册 agent_settled 订阅；initSession 时点晚绑定）。 */
  readonly getPi: () => { on?(event: "agent_settled", handler: () => void): void } | null;
  /** 所属根 session ID（flushBatch 兜底落标归属 / E1 候选 root 过滤；#2 聚合字段现读）。 */
  readonly getSessionRootId: () => string | null;
  /** 主 session 文件（E1 扫描读 pi 当前值，非注册时快照——旧 handler 语义，见
   *  settledRescanState 注释；#2 聚合字段现读）。 */
  readonly getMainSessionFile: () => string | undefined;
  /** collectSync 配置节热读（budget/default 同一读取点，modelService 留壳——窄化
   *  为节读取，聚合不感知 ModelConfigService）。 */
  readonly getCollectSyncSection: () => CollectSyncConfig | undefined;
}

/**
 * 域 #5 聚合：sync 批（E9/E1）自闭合批语义（R2 自 SubagentService 抽取）。
 *
 * 字段所有权（r0-inventory 清单① #26-#28 全部 3 个）：本聚合唯一写者；壳经
 * collectCoordinator getter 只读透传（route 调用点），其余字段壳零感知。
 */
export class SyncCollectDomain {
  private readonly deps: SyncCollectDomainDeps;

  /** collectCoordinator（subagent-sync-collect U2）：sync 批缓冲 + 闭合检测 + flush 分流。
   *  构造期装配后不可变（readonly），壳经 getter 只读透传。 */
  private readonly _collectCoordinator: CollectCoordinator;

  /** [E9] dispose 时已转 async 写账的成员 id（revive 后 flushBatch 防御过滤用）。
   *  背景：dispose 后同进程 revive（/resume /fork /new）时协调器内部缓冲仍持有已转换
   *  成员快照（协调器无 drain API，U5 领地不含 collect-coordinator.ts）——若后续新
   *  sync 成员触发闭合，陈旧快照会随批重投（新成员集新 hash，账本跨键不拦）→ 双重
   *  通知。flushBatch 闭包按本集过滤，陈旧成员零重投。id 唯一 per spawn，无误伤面。 */
  private readonly e9ConvertedIds = new Set<string>();

  /** [v2 D4] E1 等待分支的 settled 有界重扫状态（null = 未注册）。disposed 后保持
   *  非 null——同 session 内不再重复注册（补发完成/达限后 settled 边沿已无事可做，
   *  单注册即单重扫）；initSession（revive）经 resetSettledRescan() 置 null 允许新
   *  session 重新注册。pi.on 无 off（见 armSettledRescan）：旧 handler 闭包捕获旧
   *  state，未 disposed 时遇 settled 边沿仍会执行，扫描主 session 文件当前值
   *  （handler 不绑定注册时的文件域）；dispose 的惰化处置见 lazyDispose()。 */
  private settledRescanState: { disposed: boolean; scans: number } | null = null;

  constructor(deps: SyncCollectDomainDeps) {
    this.deps = deps;
    // collectCoordinator（subagent-sync-collect U2）：notifyComplete 唯一路由入口——
    // async 直通（字节不变）/ sync 批缓冲 + 闭合检测。[U3 接线点] 已接线：flush =
    // store.markBatchFinalized（manifest 屏障 + batchFinalized 落标合一原语，屏障
    // await 全部落盘——出口①，见下方闭包注释）先于 notifier.notifyBatch 单条批
    // 投递（幂等键 sync-batch:<hash> ledger 写账 → attemptDeliver 边沿投递）；
    // 闭合触发排程合批 flush：同宏任务去抖窗口收纳背靠背 route——U8 拆批盲窗修复。
    // 屏障先于写账 = 「通知可达 ⇒ 索引就位」的构造性保证（时序竞态修复，见
    // flushBatch 闭包注释）。
    // [U8] 排程与 E9/E1 交互：dispose 经 convertPendingSyncBufferToAsync 先取消挂起
    // 排程（取消而非同步 flush——双通道并发写账防护，见该函数注释）；E1 只在
    // session_start 编排处运行（此前 dispose 已取消排程，补发直走 notifyBatch 不经
    // 协调器），异常时序相撞由账本 sync-batch:<hash> 幂等拒绝兜底。
    // [检查点①] 闭包依赖显式化：闭包内聚合私有成员走 this，外部状态（notifyHost/
    // store/sessionRootId）经 deps 晚绑定 getter 现读——不持引用、不整实例注入。
    this._collectCoordinator = new CollectCoordinator({
      notifyAsync: (record) => {
        const notify = this.deps.getNotifyHost().toNotifyRecord(record);
        if (notify) this.deps.getNotifyHost().notify(notify);
      },
      toNotifyRecord: (record) => this.deps.getNotifyHost().toNotifyRecord(record),
      // 闭合判定数据源：listAllActive（原始 ExecutionRecord 内存态，携带 collectMode/
      // batchFinalized 原始值）。[U3 修正] 原接 collectRecords——其经 recordToSubagent
      // 投影丢 collectMode（U2 披露的投影缺口）→ 真链上闭合判定恒立即闭合、跨轮续累
      // 失效（真链 trace 实证）。非终态 sync 成员必在内存（archive 只删终态；磁盘重建
      // 残留属孤儿恢复域），内存视图语义完整。
      listRecords: (limit) => this.deps.getStore().listAllActive().slice(0, limit),
      flushBatch: async (members) => {
        // [E9 防御过滤] 排除 dispose 时已转 async 写账的成员（同进程 revive 后协调器
        // 缓冲残留的陈旧快照，见 e9ConvertedIds 字段注释）；全被排除 → 空批零副作用
        // 返回（成员已单独写账+落标，无需再动）。
        const live = members.filter((m) => !this.e9ConvertedIds.has(m.id));
        if (live.length === 0) return;
        // 成员全量快照：getFullRecord 冷路径重建（成员在 notifyComplete 前已 archive，
        // 内存无；闭合判定 hasRunningSync 的 listRecords 扫描已建 idToFile 索引，此处
        // 命中）。快照在屏障前一次取定，屏障写与落标共用同一份（manifest 与落标 entry
        // 字段同源）。
        // [S11] getFullRecord 不可达（子 session 文件缺失/已 GC 的窗口）的成员改用
        // 缓冲快照兜底落标，不再跳过——该成员仍随 live 进批写账（成员集 hash 含它），
        // 跳过落标的旧行为会在重启后让 E1 重新收集它（无标记候选），以异成员集 hash
        // 重新补发 → 同成员双投递（异 hash 不触发账本 sync-batch 幂等；旧注释「该
        // 窗口下 E1 本也收不到该成员」不成立：E1 走主 session 文件末条 entry 扫描，
        // 与 getFullRecord 的 manifest/子文件通路相互独立，manifest 屏障 best-effort
        // 写失败同样制造此窗口）。
        const fulls: SubagentRecord[] = [];
        const fullMissed: BgNotifyRecord[] = [];
        for (const m of live) {
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
        // accepted=false（同成员集批已在账——重复 flush / E1 重建重发形态）时已落标
        // 属幂等覆写（appendEntry last-writer-wins，该批此前成功投递时已落标），无
        // 行为差异。
        this.deps.getNotifyHost().notifyBatch(live, this.getCollectSyncBudget());
      },
    });
  }

  // ── 壳只读透传面（getter）──
  // [R1 打样模式 2] 壳侧同名私有 getter 透传（route 调用点零改动）；写路径无——
  // 构造期 readonly 装配后不可变。

  get collectCoordinator(): CollectCoordinator {
    return this._collectCoordinator;
  }

  // ── 跨聚合边显式接口（G2 聚合间零直写）──

  /** [C-2 显式接口] settled 重扫状态复活重置（置 null 允许新 session 重新注册）。
   *  SessionBaselines.initSession 的 revive 编排步经壳 deps 回调调到本方法（R1 打样
   *  时以 deps.resetSettledRescan 留的对接点，本聚合交付后改指此处——聚合间零直写）。
   *  语义注释（v2 D4）：新 session 的 E1 若再判「仍有 running」可重新注册。旧
   *  handler 闭包捕获旧 state：正常时序（session_shutdown → session_start）下已随
   *  dispose() 惰化；未经 dispose 的时序残留仍会在 settled 边沿执行——其扫描主
   *  sessionFile 当前值（非注册时的旧文件），行为等价于新 session 多注册一次扫描，
   *  由账本 sync-batch:<hash> 幂等 + batchFinalized 候选过滤收敛，无跨 session 污染面。 */
  resetSettledRescan(): void {
    this.settledRescanState = null;
  }

  /** [C-1 显式接口] dispose 惰化：settled 重扫 handler 置 disposed（幂等）。
   *  原壳 dispose 直改本聚合内部态 settledRescanState.disposed（r0-inventory 清单①
   *  C-1 跨聚合边，R0 登记、本单元兑现收敛）。时序契约（原壳 dispose 注释）：dispose
   *  后 trailing settled 边沿若仍触发，旧 handler 不得再跑扫描——notifier 随后将
   *  dispose，notifyBatch 短路返回 false 且不写账，而 E1 dispatched 段不判 accepted
   *  仍统一落标 → 批被标 batchFinalized 而通知从未写账（永久丢失，不可逆）。惰化后
   *  通知由下次重启的 E1 首扫兑现（成员无标记，候选可达）。与 initSession revive
   *  重置不冲突：dispose 是终态置 disposed，revive 置 null 是新 session 的重新注册，
   *  旧 state 对象随旧 handler 闭包保持 disposed 永久惰化。 */
  lazyDispose(): void {
    if (this.settledRescanState !== null) this.settledRescanState.disposed = true;
  }

  // ── E9：dispose 转账（壳 dispose 编排调用，时序见壳 dispose 注释）──

  /** [E9] dispose 时批未闭合：缓冲中已终态未通知成员逐条转 async 语义写账（放弃攒批）
   *  + 落 batchFinalized 标记（E1 重建扫描据此排除，防双重通知），交由既有 shutdown
   *  flush / resume 重放兑底；仍在跑的成员走现有退出路径（disposeAllRecords 关闭，
   *  与 async 一致）。写账用 notifier.notify 现有通路（ledger.record + attemptDeliver）。
   *  源序：写账先于落标——写账后崩溃 → E1 重建收该成员，但 async notifyId 与批 hash
   *  跨键不拦的重发属设计披露的 E9 残余窗（at-least-once 良性，PS-17 同族，v1 接受）。 */
  convertPendingSyncBufferToAsync(): void {
    // [U8 拆批修复·E9 交互] 挂起的合批排程先取消——dispose 已选「放弃攒批转 async」
    // 语义（最简语义 = 取消而非同步 flush）：放任排程触发会让 flushBatch（批 hash
    // 通道）与下方逐条 notify（async id 通道）双通道并发写账 → 同成员双投递，且触发
    // 点可能落在 notifier/store dispose 之后。取消后缓冲原样保留，本函数既有单通路
    // 完整接管（协调器侧幂等：无排程时 no-op）。
    this._collectCoordinator.cancelScheduledFlush();
    const members = this._collectCoordinator.pendingMembers();
    if (members.length === 0) return;
    for (const member of members) {
      this.e9ConvertedIds.add(member.id);
      this.deps.getNotifyHost().notify(member);
    }
    this.markMembersBatchFinalized(members.map((m) => m.id));
    logger.warn(
      `[subagents] E9 dispose: converted ${members.length} buffered sync member(s) to async notify`,
      { ids: members.map((m) => m.id) },
    );
  }

  // ── E1：崩溃恢复（壳 public 转发，index.ts session_start 编排处调用）──

  /**
   * [E1] sync 批崩溃恢复钩子（设计 §3.1.5 E1，index.ts session_start 恢复编排处调用，
   * 须晚于 initSession——孤儿终态恢复先行收敛 running 成员，「全员终态」判定才可达）：
   *
   *  - 扫描主 session 文件每 id 末条 subagent-record entry（store.scanLastRecordEntries，
   *    collectLastRecordEntries 同构 + 投影扩展含 collectMode/batchFinalized + 终态五
   *    字段；禁走 collectRecords light 路径——主 session 落标 entry 对它不可见）；
   *  - 只收 collectMode=sync 且无 batchFinalized 的成员（排除已通过批 flush 或 E9
   *    转换离场的，防双重通知），按 rootSessionId 过滤当前根；
   *  - 全员终态且账本无同成员集批记录 → manifest 屏障（await 落盘，「通知可达 ⇒
   *    索引就位」构造性保证，与 flushBatch 同款）→ notifyBatch 补发（内容 = 末条
   *    entry 终态快照；账本 record 同 hash 幂等拒绝 = 已投递/已在账，两种结局都算
   *    「已处理」）；
   *  - 仍有 running → 本次不动，注册 settled 有界重扫（D4，见 armSettledRescan）——
   *    成员延迟终态（主 agent 冷路径 resume → 正常流落 entry）由 settled 边沿驱动
   *    重扫收敛，不再依赖「下次 session_start」作唯一再驱动（v2 §2.4 断链 4）；
   *    running 口径与协调器同构
   *    （resumable 豁免，v2 D3——覆写不可达的防御分支残余不被误判「仍在跑」）；
   *  - 补发尝试后统一补 batchFinalized 标记（账本拒绝也算已投递；直接用末条重建快照
   *    落标不经 getFullRecord——子文件缺失/已 GC 时标记仍可落盘，窗口自愈不依赖二次
   *    重启；补标自身崩溃重入幂等收敛，末条 entry last-writer-wins）。
   *
   *  async 化（时序屏障修复）：返回 Promise 但**内部自捕获不外抛**——宿主 index.ts
   *  session_start 以同步 try/catch 调用（其 catch 兑现不到 promise 内的异常），
   *  自捕获维持同款 warn 容错语义，浮动调用零适配、不产生 unhandled rejection。
   *
   *  [U8 拆批修复] 与协调器合批排程无交集：E1 只在 session_start 编排处运行（此前
   *  dispose 已取消挂起排程），补发直走 notifier.notifyBatch 不经协调器；异常时序
   *  相撞由账本 sync-batch:<hash> 幂等拒绝兜底。
   */
  async recoverSyncCollectBatch(): Promise<void> {
    try {
      const { outcome } = await this.runSyncCollectRecoveryScan();
      // [v2 D4] 断链 4：等待分支不再死等——挂 settled 有界重扫（幂等单注册）。
      if (outcome === "waiting") {
        this.armSettledRescan();
      }
    } catch (err) {
      // 与 index.ts 调用点原 try/catch 的 warn 容错同语义（该处 catch 对 async 化后
      // 的 promise 异常兑现不到，容错收敛到本方法内部）。
      logger.warn("[subagents] sync collect batch recovery failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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

  // ── 批投递内部通路（flushBatch / E1 / E9 共用）──

  /** [E9 专用] batchFinalized 落标 + manifest 写（设计 §3.1.5 E9）——已归口
   *  store.markBatchFinalized（U3 批写归口）。批通知路径（flush/E1）的「manifest
   *  屏障 → 写账 → 落标」序列见各自调用点；E9 转换的成员走 async 单条通知（全文
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

  // ── E1 内部：扫描 → 判定 → 补发（E1 首扫与 settled 重扫共用）──

  /** [E1/D4] 单次「扫描→判定→可达则补发+落标」，E1 首扫与 settled 重扫共用同一实现
   *  （防两处复制粘贴分岔）。三态返回：idle（无 sync 候选——已全部落标/E9 转换/异根，
   *  无事可等）/ waiting（仍有 running 成员，本次不动）/ dispatched（全员终态，已补发
   *  +统一落标）。async：补发前有 manifest 屏障 await（见函数头 E1 注释）。 */
  /** 返回 outcome + waitingIds（达限 warn 需滞留成员 id，D6 #7b——仅 waiting 态非空）。 */
  private async runSyncCollectRecoveryScan(): Promise<{
    outcome: "idle" | "waiting" | "dispatched";
    waitingIds: string[];
  }> {
    const lastRecords = this.deps.getStore().scanLastRecordEntries(this.deps.getMainSessionFile());
    if (lastRecords.length === 0) return { outcome: "idle", waitingIds: [] };
    const rootFilter = this.deps.getSessionRootId();
    const candidates = lastRecords.filter(
      (r) =>
        r.collectMode === "sync" &&
        r.batchFinalized !== true &&
        (rootFilter === undefined || r.rootSessionId === rootFilter),
    );
    if (candidates.length === 0) return { outcome: "idle", waitingIds: [] };
    // [v2 D3] 与协调器 hasRunningSync 同构口径（collect-coordinator.ts）：running+
    // resumable 视为已完成、不阻止补发——成功成员崩溃时的末条 entry 恒为轮终
    // running+resumable（SP-5 有意语义），旧口径只看 status !== "closed" 会把主场景
    // （批内含成功成员）顶死在「等自然终态」永不补发（v2 §2.3 断链 3）。
    const running = candidates.filter((r) => r.resumable !== true && r.status !== "closed");
    if (running.length > 0) {
      logger.debug(
        `[subagents] E1 sync batch recovery: ${running.length} member(s) still running, wait for natural completion`,
        { ids: running.map((r) => r.id) },
      );
      return { outcome: "waiting", waitingIds: running.map((r) => r.id) };
    }
    // [U3 批写归口 / 时序屏障] manifest 屏障 + 统一落标合一进 store.markBatchFinalized，
    // 整体先于写账投递——E1 补发同样是批通知（指针行消费依赖反查索引），「通知可达 ⇒
    // 索引就位」的构造性保证与 flushBatch 同款。落标前置后「账本拒绝（accepted=false）
    // 也统一补标」的 E1 既有语义不变（合一原语内落标无条件）。
    await this.deps.getStore().markBatchFinalized(candidates);
    // 全员终态：单条批补发（budget 热读与 flushBatch 同源）；账本同 hash 幂等拒绝也算
    // 已投递（批已在账/已销账，重放由账本承接）——两种结局统一补标。
    const members = candidates.map((r) => syncRebuildToNotifyMember(r));
    const accepted = this.deps.getNotifyHost().notifyBatch(members, this.getCollectSyncBudget());
    logger.warn(
      `[subagents] E1 sync batch recovery: re-notified ${members.length} member(s) (ledger accepted=${accepted})`,
      { ids: members.map((m) => m.id) },
    );
    return { outcome: "dispatched", waitingIds: [] };
  }

  /** [v2 D4] 注册 agent_settled 有界重扫（幂等：settledRescanState 非 null 不叠加注册
   *  ——E1 现仅 session_start 单调用点，守卫是防第二入口引入时的注册叠加断言面）。
   *  每次 settled 边沿重跑同一 E1 扫描（runSyncCollectRecoveryScan）：dispatched
   *  （补发+落标完成，scan 的 warn 已留痕）或 idle（候选已被其他通路落标）→ disposed；
   *  累计 SETTLED_RESCAN_LIMIT 次仍在等 → disposed + warn 留痕（D6 #7b / SC-2：达限
   *  放弃重扫意味着滞留成员的批通知要等下次 session_start 才收敛，含滞留 id 的 warn
   *  是唯一线索，debug 级排障不可见；后续事件零处理，下次 session_start 再收敛）。
   *  pi.on 无 off（0.84.4 实装）——disposed 标志包装兑现退订（scheduler extension
   *  index.ts subscribeSettled 同款先例）。P-settled 定谳（0.84.4 dist 实装证据）：
   *  pi.on 为 per-extension 列表分发——loader.js `on()` 把 handler push 进
   *  extension.handlers.get(event) 数组（非覆盖），runner.js `emit()` 对全部
   *  extension 的全部 handler 逐一 await；故本注册与 ledger host 经
   *  piAdapter.onAgentSettled 注册的 settled 分发互不干扰，无需降级并入 host 链。 */
  private armSettledRescan(): void {
    if (this.settledRescanState !== null) return;
    const state = { disposed: false, scans: 0 };
    this.settledRescanState = state;
    this.deps.getPi()?.on?.("agent_settled", async () => {
      if (state.disposed) return;
      state.scans += 1;
      // await 完整补发序列（manifest 屏障 → 写账 → 落标）：pi emit 对 handler 逐一
      // await（P-settled 定谳，0.84.4 dist runner.js），async 化不改变分发语义。
      const { outcome, waitingIds } = await this.runSyncCollectRecoveryScan();
      if (outcome === "waiting" && state.scans < SETTLED_RESCAN_LIMIT) return;
      state.disposed = true;
      if (outcome === "waiting") {
        // D6 #7b / SC-2：warn + 滞留成员 id（debug 级排障不可见——达限即批通知挂起至下次 session_start）
        logger.warn(
          `[subagents] E1 settled rescan: reached limit (${SETTLED_RESCAN_LIMIT}) with member(s) still running, disposed until next session_start`,
          { ids: waitingIds },
        );
      }
    });
  }

  // [E1 语义对齐 toNotifyRecord] 补发成员映射 syncRebuildToNotifyMember 拆至
  // sync-rebuild.ts（变化轴：恢复批通知语义）：one-shot 成功成员末条恒
  // running+resumable（SP-5），直通 status 会让恢复批批头「0 finished」且丢
  // patchFile 的 git-apply 指针——对齐后补发记录为 closed + outcome 物化 +
  // patchFile 透传。调用点：runSyncCollectRecoveryScan。
}
