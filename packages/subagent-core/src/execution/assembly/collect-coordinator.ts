// src/execution/assembly/collect-coordinator.ts
//
// collectCoordinator：notifyComplete 唯一路由入口——async 直通 / sync 批缓冲 / 闭合检测
// （subagent-sync-collect 设计 §3.1.4 终态数据流 / D2 隐式批 / D5 service 层缓冲）。
//
// 职责（U2）：
//   route(record)：
//     - record.collectMode !== "sync" → deps.notifyAsync（现状 notifier.notify 路径，
//       执行序列逐字节一致，G3/A5 零回归）；
//     - record.collectMode === "sync" → deps.toNotifyRecord 终态快照登记入缓冲（内存，
//       登记时定格——record 对象后续可变不影响快照）→ 闭合检测。
//
//   闭合判定（⛔3 已核实 U1，impl-plan §7）：缓冲非空 && 无非终态 sync 成员。
//   「非终态」口径 = collectMode="sync" && 无 batchFinalized 标记 && status !== "closed"
//   ——池排队成员在 store.register 时即 status="running"，自动计入非终态（闭合等待它）；
//   batchFinalized=true 的已离场成员不阻止闭合。
//
//   跨轮续累（D2 隐式批）：缓冲跨多次 route 累积不清空（分两轮派 2+1 sync → 闭合时
//   单批三成员）；flush 后缓冲清空，后续 sync 成员自然开新批（语义 = "等所有 sync 待收"）。
//
// [U8 拆批盲窗修复] 闭合满足 → 同宏任务去抖合批 flush（不再立即 flush）：
//   盲窗机理：kickOffBackground 的 runAndFinalize（completeRecord+archive，record 从
//   store.listAllActive 移除）先于 .then 链的 notifyComplete。同同步段背靠背终态时，
//   成员 A route 触发闭合检测（只扫 listAllActive 非终态）看不到「已 archive 未路由」
//   的成员 B → 立即 flush([A])；B route 再 flush([B]) → 拆两条单成员批（G1 弱化，
//   单唤醒变两次）。
//   修复：闭合首次满足改排程 flush（setTimeout(0)，Node 1ms clamp——同一宏任务级窗口，
//   确定性、无可观察延迟）；窗口内后续 route 落缓冲后一并 flush（背靠背成员合单批）。
//   触发时重验闭合条件：窗口内若有新 sync 成员注册 running（跨轮续累反转）→ 保留缓冲
//   不 flush，等其终态 route 重新排程（终态必经 notifyComplete，不丢、不悬挂）。
//   交互语义（授权修复轮决策）：
//   - E9 dispose：service.convertPendingSyncBufferToAsync 先 cancelScheduledFlush
//     （取消而非同步 flush——放任触发会与逐条转 async 写账双通道并发 → 同成员双投递，
//     且触发点可能落在 notifier/store dispose 之后）；取消后缓冲原样保留，E9 单通路
//     完整接管（选语义最简）。
//   - E1 恢复补发：只在 session_start 编排处运行（此前 dispose 已取消挂起排程），
//     补发直走 notifier.notifyBatch 不经协调器；异常时序相撞由账本 sync-batch:<hash>
//     幂等拒绝兜底。
//
// flush 注入式（U3 已接线）：deps.flushBatch 由宿主注入——U3 接 service 闭包的
//「manifest 屏障（await 落盘）→ notifier.notifyBatch 单条批投递（ledger sync-batch
// hash 写账）→ batchFinalized 落标」（见 subagent-service.ts flushBatch 闭包）。
// 测试注入 fake 断言闭合条件。flush 异步（Promise<void>）、协调器 void 调用不等待：
// 缓冲在调用前已整体移交清空，flush 内部时序（屏障 → 写账 → 落标）与失败语义归
// 实现方（与 notifier.notify 同风格）。
//
// 不变量：
//   - 每个成员只登记一次：notifyComplete 调用点自带 CAS/gate 单次性（与既有 notify
//     单次性同源——cancelBackground CAS 抢锁 / kickOffBackground.then gate / watchdog
//     CAS），协调器不重复去重，不改变 at-least-once 语义。
//   - toNotifyRecord 返回 undefined（gate 未过/非终态）→ 静默跳过不入缓冲，与 async
//     路径的静默跳过对称——调用点 gate 语义不变，协调器不重复判定。
//   - 闭合判定只敏感于「是否还有非终态 sync」：本条终态在 store 的可见性（archive 后
//     磁盘重建时序）不影响判定正确性。
//   - [U8] 排程幂等：窗口内多条 route 至多一个挂起定时器；flush 只在触发时重验后执行，
//     缓冲在排程期内保持可枚举（pendingMembers 供 E9 dispose 转换读取）。

import type { BgNotifyRecord } from "../notify/notifier.ts";
import type { ExecutionRecord } from "./types.ts";

/** 闭合判定的 record 最小视图（ExecutionRecord / SubagentRecord 的同构子集）。
 *
 *  [U3 微调 / U5 已修] 原 deps 用 SubagentRecord——生产通路 collectRecords 经
 *  recordToSubagent 投影曾不含 collectMode/batchFinalized（U2 披露，U5 已补投影），
 *  保留结构化最小接口 + service 接线走 store.listAllActive()（原始 ExecutionRecord
 *  内存态，不经投影）——非终态 sync 成员必在内存（archive 只删终态），内存视图语义
 *  完整；纯注入测试的 SubagentRecord stub 结构兼容零改动。 */
export interface CollectScanRecord {
  status: string;
  /** [U2 桥接判据] 旧「closed 终态」读形态 = idle ∧ closedReason 有值（两态迁移
   *  不变量；装配点从 ExecutionRecord/SubagentRecord 投影，字段自然携带）。 */
  closedReason?: string;
  collectMode?: "sync";
  batchFinalized?: boolean;
}

/** 闭合判定的全 record 扫描上限（service 冷路径 COLD_LOOKUP_SCAN_LIMIT 同量级）。 */
export const COLLECT_SCAN_LIMIT = 1000;

/**
 * [two-state-convergence U4/D4 → U5 翻转] sync collect「未收口」判据 SSOT（单一导出，
 * 两消费方 import——{@link CollectCoordinator} hasRunningSync 主路径闭合门 +
 * sync-collect-domain E1 恢复扫描过滤器，防同构判据再分叉）：
 *
 *   未收口 = `status === 'running'`
 *
 * [U5 批行为翻转（设计 D4 第 1 行登记）] resumable 字段退役后旧 resumable 子句
 * 删除，判据退化为 status 直读——W4 新态（running + stopReason=failed + result=∅，
 * adoptEngineDeath 写点）翻为未收口挂起，恢复链 = run 域 readopt settle → settled
 * 边沿重扫 → 补发（SETTLED_RESCAN_LIMIT 达限退化为下次 session_start）。
 * U4 批被否谱系（纯 status 直读的部署边界反例）随「U4-U6 同 PR 交付无生产暴露」
 * 裁决消解。旧「closed 终态」子句（idle ∧ closedReason 有值，[U2 桥接判据]）被
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
  /** record → 通知快照（登记时定格）。undefined = gate 未过/非终态（静默跳过）。 */
  toNotifyRecord(record: ExecutionRecord): BgNotifyRecord | undefined;
  /** 闭合判定数据源（CollectScanRecord 最小视图，见接口注释——数据源须携带
   *  collectMode/batchFinalized 原始值，禁经 recordToSubagent 投影）。 */
  listRecords(limit: number): CollectScanRecord[];
  /** 批投递回调（合批窗口到期触发，缓冲整体移交后清空）。U3 接 service 闭包：
   *  manifest 屏障 → notifier.notifyBatch 写账 → batchFinalized 落标——屏障先于写账
   *  是「通知可达 ⇒ 索引就位」的构造性保证，故异步；协调器 void 调用不等待其完成。 */
  flushBatch(members: BgNotifyRecord[]): Promise<void>;
}

/** route 去向（测试/诊断断言用）。 */
export type CollectRouteResult =
  /** 非 sync record：notifyAsync 直通（现状路径）。 */
  | "async"
  /** gate 未过（toNotifyRecord undefined）：静默跳过，不入缓冲。 */
  | "sync-skipped"
  /** 入缓冲未闭合（仍有非终态 sync 成员）。 */
  | "sync-buffered"
  /** 闭合触发（[U8] flush 已排程合批——同宏任务窗口内的后续 route 一并投递）。 */
  | "sync-flushed";

export class CollectCoordinator {
  /** 批缓冲（内存）：已终态未 flush 的 sync 成员终态快照，跨 route 累积。
   *  [U8] 排程合批窗口期内保持可枚举（E9 dispose 转换依赖 pendingMembers 全量）。 */
  private readonly buffer: BgNotifyRecord[] = [];

  /** [U8] 挂起的合批排程定时器（undefined = 无排程）。 */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CollectCoordinatorDeps) {}

  /** notifyComplete 唯一路由入口。返回去向供测试/诊断断言。 */
  route(record: ExecutionRecord): CollectRouteResult {
    if (record.collectMode !== "sync") {
      this.deps.notifyAsync(record);
      return "async";
    }
    const snapshotRecord = this.deps.toNotifyRecord(record);
    if (!snapshotRecord) return "sync-skipped";
    this.buffer.push(snapshotRecord);
    return this.armFlushIfClosed() ? "sync-flushed" : "sync-buffered";
  }

  /** 诊断/测试：当前缓冲成员数（= 已终态未 flush 的 sync 成员数，含合批窗口内成员）。 */
  get pendingCount(): number {
    return this.buffer.length;
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

  /** 闭合判定 + 合批排程武装：缓冲非空 && 无非终态 sync 成员 → 排程 flush。
   *  已有排程挂起时幂等（同窗口合批，不重复定时器）。（S6 改名：原名 closeDetected
   *  读作纯检测，实带副作用——武装排程改状态，名实相符优先。） */
  private armFlushIfClosed(): boolean {
    if (this.buffer.length === 0) return false;
    if (this.hasRunningSync()) return false;
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
   *  窗口内新 sync 成员注册 running（跨轮续累反转）→ 保留缓冲不 flush，等其终态
   *  route 重新排程（终态必经 notifyComplete，不丢、不悬挂）。
   *  void 不等待 flush 的 async 屏障序列（manifest → 写账 → 落标）：缓冲已 splice
   *  先行整体移交，屏障 await 期间窗口内新成员重新入空缓冲开新批，互不干扰。 */
  private flushIfClosed(): void {
    if (this.buffer.length === 0) return;
    if (this.hasRunningSync()) return;
    const members = this.buffer.splice(0, this.buffer.length);
    void this.deps.flushBatch(members);
  }

  /** 是否存在非终态 sync 成员（collectMode=sync && 无 batchFinalized && isCollectPending）。
   *  非终态口径（⛔3 U1 已核实 + U3 resumable 补丁 → [two-state-convergence U4/D4
   *  → U5 翻转] 判据本体 SSOT 化为 isCollectPending——判据语义/翻转登记见其函数头，
   *  此处不再内联副本）：池排队/在跑成员在 store.register 时即 status="running"
   *  → 未收口，闭合等待它；batchFinalized=true 的已离场成员不阻止
   *  闭合；轮终形态（idle，U4 翻边权威词）视为已完成，不阻止闭合。 */
  private hasRunningSync(): boolean {
    for (const record of this.deps.listRecords(COLLECT_SCAN_LIMIT)) {
      if (record.collectMode === "sync" && record.batchFinalized !== true && isCollectPending(record)) {
        return true;
      }
    }
    return false;
  }
}
