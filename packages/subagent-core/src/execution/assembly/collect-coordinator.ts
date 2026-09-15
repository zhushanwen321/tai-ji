// src/execution/assembly/collect-coordinator.ts
//
// collectCoordinator：完成通知唯一路由入口——async 直通 / sync 批缓冲 / 闭合检测
// （subagent-sync-collect 设计 §3.1.4 终态数据流 / D2 隐式批 / D5 service 层缓冲）。
//
// 职责（U2 + [modeless 波3]）：
//   registerMember(recordId)：
//     - 派发时点登记（executeViaEngine 读 ExecuteOptions.collect 路由选项后调用）——
//       collect 是 start 调用方的通知路由选择（sync=完成通知攒批一次唤醒 / async=逐个
//       通知），不是 record 身份；成员身份只活在本聚合内存（随 session 生命周期消亡）。
//
//   route(record)：
//     - record.id 未登记 → deps.notifyAsync（现状 notifier.notify 路径，执行序列
//       逐字节一致，G3/A5 零回归）；
//     - 已登记 → deps.toNotifyRecord 终态快照（batchMember 终态载荷形态）登记入缓冲
//       （内存，登记时定格——record 对象后续可变不影响快照）→ 闭合检测。
//
//   闭合判定（⛔3 已核实 U1，impl-plan §7）：缓冲非空 && 无「登记中且未收口」成员。
//   「未收口」口径 = 已登记 && status running（isCollectPending SSOT）——池排队成员在
//   store.register 时即 status="running"，自动计入未收口（闭合等待它）；已随批 flush
//   离场的成员自登记集删除，不再参与判定。
//
//   跨轮续累（D2 隐式批）：缓冲跨多次 route 累积不清空（分两轮派 2+1 sync → 闭合时
//   单批三成员）；flush 后缓冲清空 + 批成员自登记集离场，后续 sync 派发登记自然开新批
//   （语义 = "等所有 sync 待收"）。
//
//   批闭合自动 close（[modeless 波3]，结构化消灭 E4 诱因面）：flush 投递完成后由
//   flushBatch 注入方对成员执行归档——成员是「一次性计算单元」，完成通知（批）即终态
//   通知，无续聊留守语义；「续聊批成员」路径 = fork-from（归档 record 可 fork，已有
//   能力）。归档在 deps.flushBatch 实现内编排（本聚合零 store/lifecycle 直依）。
//
// [U8 拆批盲窗修复] 闭合满足 → 同宏任务去抖合批 flush（不再立即 flush）：
//   盲窗机理：终态簿记（markRoundIdle，record 翻 idle）先于 Continuation settle 链的
//   notifyComplete route。同同步段背靠背终态时，成员 A route 触发闭合检测（只扫
//   listAllActive 未收口）看不到「已收口未路由」的成员 B → 立即 flush([A])；B route
//   再 flush([B]) → 拆两条单成员批（G1 弱化，单唤醒变两次）。
//   修复：闭合首次满足改排程 flush（setTimeout(0)，Node 1ms clamp——同一宏任务级窗口，
//   确定性、无可观察延迟）；窗口内后续 route 落缓冲后一并 flush（背靠背成员合单批）。
//   触发时重验闭合条件：窗口内若有新 sync 成员登记且 running（跨轮续累反转）→ 保留
//   缓冲不 flush，等其终态 route 重新排程（终态必经 notifyComplete，不丢、不悬挂）。
//   交互语义（授权修复轮决策）：
//   - E9 dispose：service.convertPendingSyncBufferToAsync 先 cancelScheduledFlush
//     （取消而非同步 flush——放任触发会与逐条转 async 写账双通道并发 → 同成员双投递，
//     且触发点可能落在 notifier/store dispose 之后）；取消后缓冲原样保留，E9 单通路
//     完整接管（选语义最简），随后 clear() 清空全部协调状态。
//   - E1 恢复补发：[modeless 波3] 已随 collectMode 记录态消亡退役（批协调状态为内存
//     登记态，崩溃后不恢复；成员 record 本体仍健全——settle 态 idle+result / 孤儿恢复
//     idle+interrupted）。
//
// flush 注入式（U3 已接线）：deps.flushBatch 由宿主注入——U3 接 service 闭包的
//「manifest 屏障（await 落盘）→ notifier.notifyBatch 单条批投递（ledger sync-batch
// hash 写账）→ batchFinalized 落标 → 批成员自动 close」（见 sync-collect-domain
// flushBatch 闭包）。
// 测试注入 fake 断言闭合条件。flush 异步（Promise<void>）、协调器 void 调用不等待：
// 缓冲在调用前已整体移交清空，flush 内部时序（屏障 → 写账 → 落标 → close）与失败语义
// 归实现方（与 notifier.notify 同风格）。
//
// 不变量：
//   - 每个成员只登记一次：route 调用点自带 CAS/gate 单次性（与既有 notify 单次性
//     同源——cancelBackground CAS 抢锁 / settle gate / watchdog CAS），协调器不重复
//     去重，不改变 at-least-once 语义。
//   - toNotifyRecord 返回 undefined（gate 未过/非终态）→ 静默跳过不入缓冲，与 async
//     路径的静默跳过对称——调用点 gate 语义不变，协调器不重复判定。
//   - 闭合判定只敏感于「登记成员是否全部收口」：本条终态在 store 的可见性（archive
//     后磁盘重建时序）不影响判定正确性。
//   - [U8] 排程幂等：窗口内多条 route 至多一个挂起定时器；flush 只在触发时重验后执行，
//     缓冲在排程期内保持可枚举（pendingMembers 供 E9 dispose 转换读取）。

import type { BgNotifyRecord } from "../notify/notifier.ts";
import type { ExecutionRecord } from "./types.ts";

/** 闭合判定的 record 最小视图（ExecutionRecord / SubagentRecord 的同构子集）。
 *
 *  [U3 微调 / U5 已修] 原 deps 用 SubagentRecord——生产通路 collectRecords 经
 *  recordToSubagent 投影曾不含批域原始值（U2 披露，U5 已补投影），保留结构化最小
 *  接口 + service 接线走 store.listAllActive()（原始 ExecutionRecord 内存态，不经
 *  投影）——未收口成员必在内存（archive 只删终态），内存视图语义完整；纯注入测试的
 *  SubagentRecord stub 结构兼容零改动。
 *  [modeless 波3] collectMode/batchFinalized 判据字段随成员身份迁移登记态删除——
 *  闭合判定 = 登记集成员资格 × isCollectPending(status)。 */
export interface CollectScanRecord {
  id: string;
  status: string;
}

/** 闭合判定的全 record 扫描上限（service 冷路径 COLD_LOOKUP_SCAN_LIMIT 同量级）。 */
export const COLLECT_SCAN_LIMIT = 1000;

/**
 * [two-state-convergence U4/D4 → U5 翻转] sync collect「未收口」判据 SSOT（单一导出，
 * 消费方 import 复用——{@link CollectCoordinator} hasUnsettledMember 主路径闭合门，
 * 防同构判据再分叉）：
 *
 *   未收口 = `status === 'running'`
 *
 * [U5 批行为翻转（设计 D4 第 1 行登记）] resumable 字段退役后旧 resumable 子句
 * 删除，判据退化为 status 直读——W4 新态（running + stopReason=failed + result=∅，
 * adoptEngineDeath 写点）翻为未收口挂起（readopt settle → 补发）。
 * 旧「closed 终态」子句（idle ∧ closedReason 有值，[U2 桥接判据]）被
 * status 子句吸收（closed 恒 idle → 恒 false）；markSettled 轮间 idle 同样由
 * status 子句排除。
 */
export function isCollectPending(record: Pick<CollectScanRecord, "status">): boolean {
  return record.status === "running";
}

/** 协调器宿主依赖（全部注入——协调器零 service/store 直依，可独立单测）。 */
export interface CollectCoordinatorDeps {
  /** async 直通（现状 notifier.notify 路径，字节不变）。 */
  notifyAsync(record: ExecutionRecord): void;
  /** record → 通知快照（登记时定格）。undefined = gate 未过/非终态（静默跳过）。
   *  [modeless 波3] batchMember=true = 批成员终态载荷形态（closed 载荷带 result——
   *  攒批一次唤醒的 one-shot 语义，批头计数 / patchFile 提示依赖 closed+outcome 形态）。 */
  toNotifyRecord(record: ExecutionRecord, opts?: { batchMember?: boolean }): BgNotifyRecord | undefined;
  /** 闭合判定数据源（CollectScanRecord 最小视图；成员资格由本聚合登记集承载）。 */
  listRecords(limit: number): CollectScanRecord[];
  /** 批投递回调（合批窗口到期触发，缓冲整体移交后清空）。U3 接 service 闭包：
   *  manifest 屏障 → notifier.notifyBatch 写账 → batchFinalized 落标 → 批成员自动
   *  close——屏障先于写账是「通知可达 ⇒ 索引就位」的构造性保证，故异步；协调器 void
   *  调用不等待其完成。 */
  flushBatch(members: BgNotifyRecord[]): Promise<void>;
}

/** route 去向（测试/诊断断言用）。 */
export type CollectRouteResult =
  /** 未登记成员（async 路由 record）：notifyAsync 直通（现状路径）。 */
  | "async"
  /** gate 未过（toNotifyRecord undefined）：静默跳过，不入缓冲。 */
  | "sync-skipped"
  /** 入缓冲未闭合（仍有登记中未收口成员）。 */
  | "sync-buffered"
  /** 闭合触发（[U8] flush 已排程合批——同宏任务窗口内的后续 route 一并投递）。 */
  | "sync-flushed";

export class CollectCoordinator {
  /** 批缓冲（内存）：已终态未 flush 的 sync 成员终态快照，跨 route 累积。
   *  [U8] 排程合批窗口期内保持可枚举（E9 dispose 转换依赖 pendingMembers 全量）。 */
  private readonly buffer: BgNotifyRecord[] = [];

  /** [modeless 波3] sync 路由成员登记集（内存，随 session 生命周期消亡）：
   *  派发时点登记（registerMember）→ 终态 route 入缓冲 → flush 离场（批闭合）。
   *  成员身份的唯一权威（collectMode 字段已出 record）；已随批离场（flush 删登记）
   *  的成员不再参与闭合判定。cancel/归档等「settle 前离场」成员保留登记（record 已非
   *  running 不阻止闭合；后续轮若再 route 仍按成员入批——与旧 collectMode 字段残留
   *  语义同构）。 */
  private readonly members = new Set<string>();

  /** [U8] 挂起的合批排程定时器（undefined = 无排程）。 */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CollectCoordinatorDeps) {}

  /** [modeless 波3] 派发时点成员登记（executeViaEngine 读 collect 路由选项后调用）。
   *  幂等（Set 语义）；同 id 重复登记无副作用。 */
  registerMember(recordId: string): void {
    this.members.add(recordId);
  }

  /** [modeless 波3] 成员资格查询（失败轮分流判据：成员入批 / async 失败单发——
   *  route 自带通知副作用，不可作谓词使用）。 */
  isMember(recordId: string): boolean {
    return this.members.has(recordId);
  }

  /** 完成通知唯一路由入口。返回去向供测试/诊断断言。 */
  route(record: ExecutionRecord): CollectRouteResult {
    if (!this.members.has(record.id)) {
      this.deps.notifyAsync(record);
      return "async";
    }
    const snapshotRecord = this.deps.toNotifyRecord(record, { batchMember: true });
    if (!snapshotRecord) return "sync-skipped";
    this.buffer.push(snapshotRecord);
    return this.armFlushIfClosed() ? "sync-flushed" : "sync-buffered";
  }

  /** 诊断/测试：当前缓冲成员数（= 已终态未 flush 的 sync 成员数，含合批窗口内成员）。 */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** [modeless 波3] 当前登记成员数（= 已登记未随批离场的成员总数——pendingSyncCount
   *  口径「未闭合批 sync 成员总数（含本条）」的登记态承载；settle 前离场的 cancel/
   *  归档成员保留登记，与旧 collectMode 字段残留计数语义同构）。 */
  get memberCount(): number {
    return this.members.size;
  }

  /** 诊断/测试 + E9 dispose 转换数据源：缓冲成员快照（副本，非活引用）。 */
  pendingMembers(): BgNotifyRecord[] {
    return [...this.buffer];
  }

  /** [U8·E9 交互] 取消挂起的合批排程（缓冲原样保留——dispose 转 async 通路仍读得到
   *  全部成员）。无排程时 no-op；幂等。 */
  cancelScheduledFlush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** [modeless 波3·E9] 批协调状态整体清空（挂起排程取消 + 缓冲 + 登记集）：
   *  dispose 转账后协调状态随 session 生命周期消亡——同进程 revive 后陈旧缓冲/登记
   *  不得跨 session 复活（旧 e9ConvertedIds 防御集随整体清空消亡）。幂等。 */
  clear(): void {
    this.cancelScheduledFlush();
    this.buffer.length = 0;
    this.members.clear();
  }

  /** 闭合判定 + 合批排程武装：缓冲非空 && 无登记中未收口成员 → 排程 flush。
   *  已有排程挂起时幂等（同窗口合批，不重复定时器）。（S6 改名：原名 closeDetected
   *  读作纯检测，实带副作用——武装排程改状态，名实相符优先。） */
  private armFlushIfClosed(): boolean {
    if (this.buffer.length === 0) return false;
    if (this.hasUnsettledMember()) return false;
    this.scheduleFlush();
    return true;
  }

  /** [U8] 同宏任务去抖合批排程：setTimeout(0)（Node 1ms clamp）——窗口跨度覆盖一个
   *  完整事件循环轮次（当前 poll 段 I/O 回调 + 微任务链排空），足以收纳 finalize 链
   *  间隙内的背靠背 route，同时无可观察延迟（毫秒级 < 任意 LLM/投递时标）。 */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushIfClosed();
    }, 0);
  }

  /** 合批窗口到期：重验闭合条件后整体移交 flushBatch 并清空。
   *  窗口内新 sync 成员登记且 running（跨轮续累反转）→ 保留缓冲不 flush，等其终态
   *  route 重新排程（终态必经 notifyComplete，不丢、不悬挂）。
   *  void 不等待 flush 的 async 屏障序列（manifest → 写账 → 落标 → 自动 close）：
   *  缓冲已 splice 先行整体移交、批成员同步自登记集离场（批已闭合），屏障 await
   *  期间窗口内新派成员重新登记入空缓冲开新批，互不干扰。 */
  private flushIfClosed(): void {
    if (this.buffer.length === 0) return;
    if (this.hasUnsettledMember()) return;
    const members = this.buffer.splice(0, this.buffer.length);
    for (const m of members) this.members.delete(m.id);
    void this.deps.flushBatch(members);
  }

  /** 是否存在登记中且未收口的成员（isCollectPending SSOT——[two-state-convergence
   *  U4/D4 → U5 翻转] 判据语义/翻转登记见其函数头，此处不再内联副本）：池排队/在跑
   *  成员在 store.register 时即 status="running" → 未收口，闭合等待它；已随批离场
   *  （flush 删登记）的成员不参与判定；轮终形态（idle，U4 翻边权威词）视为已完成，
   *  不阻止闭合。 */
  private hasUnsettledMember(): boolean {
    for (const record of this.deps.listRecords(COLLECT_SCAN_LIMIT)) {
      if (this.members.has(record.id) && isCollectPending(record)) {
        return true;
      }
    }
    return false;
  }
}
