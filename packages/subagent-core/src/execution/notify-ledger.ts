// src/execution/notify-ledger.ts
//
// U2 B-ledger：后台通知的持久账本与 courier（设计 docs/architecture/pi-boundary-reliability.md 附录 D
// §3.3 D4/D5）。
//
// 通知拆为两个正交关注点：
//   - 存在性（账本）：pi.appendEntry("subagent-bg-notify-ledger") 内存同步入账，
//     先于一切投递尝试（进程内时序）；文件落盘随 pi flush 管线 debounce（非 fsync，
//     PS-17）——强杀落在 flush 窗口时账目丢失、该通知跨重启不重放（真丢失面，
//     与 PS-14 首写延迟同族；日常触发概率低，观察项见 pi-semantics PS-17）；
//   - 可达性（courier）：只在「主 session 确定空闲」的时刻投递——agent_settled 边沿
//    （边沿回调内 isIdle 恒真：_emitAgentSettled 先复位 _isAgentRunActive 再发事件，
//     agent-session.js:327-331）+ 120s 超时看门狗兜底（主 session 长期无 settled 时）。
//     发送前二次复查 isIdle，竞态窗口内新 run 已启动则放弃本次、消息挂回 pending
//     等下一边沿（D5 零宽容：busy 场景无任何依赖）。
//
// 四步生命周期（D4）：
//   ① record：appendEntry(ledger entry) 落盘（先于一切投递尝试）
//   ② deliver：settled 边沿 / 看门狗触发 attemptDeliver——单通道
//      pi.sendMessage({triggerTurn:true})（steer/followUp/nextTurn 通道已全部删除，
//      D5）；同一边沿的多条 pending 合并为一条注入
//   ③ ack：回执判定成功（主 session 出现 notifyId 匹配的 subagent-bg-notify
//      custom_message entry）后 appendEntry("subagent-bg-notify-ack")
//   ④ replay：重启恢复扫描 ledger/ack/abandoned entry 差集重放；重放按 notifyId 幂等去重
//    （details 携带 notifyId，重复条目可识别）
//
// 止损上半场（T4③/PS-6）：④只保证「送达保证」下半场，回执确认不可达时（如送达
// entry 被 compaction 清除）attempts 无上限 = 同一条通知每 120s 重复注入并
// triggerTurn 无限唤醒 LLM。收敛：重投达 NOTIFY_REDELIVERY_MAX_ATTEMPTS 仍无回执 →
// 写 abandoned 终态 entry 放弃（warn 含 subagent 标识与 subagents action:"list"
// 手动核对指引），放弃号跨重启不复活（恢复扫描视同已销账）。
//
// 通道分工（D4）：ledger/ack/abandoned 用 plain appendEntry（type=custom 不进 LLM 上下文——
// session-manager sessionEntryToContextMessages 对 custom 返回 []）；送达消息用
// pi.sendMessage({triggerTurn:true})（custom_message 进上下文）。两通道不得混用。
//
// fork/compaction 归属（D4）：扫描域 = 单 session 文件，幂等键作用域随文件域隔离。
// fork 复制 session 文件时继承未销账 pending 属可接受语义（分身重放补投 + notifyId
// 去重保证至多一次送达；「送达已落盘、销账未落盘」的强杀窗口允许重复，凭 notifyId
// 可识别，见 G2）。compaction 对 entry 的保留行为实装未验证（P-B4 探针，阶段 5 实测）
// ——compactionCheck() 提供条件降级：检测到 ledger/ack entry 被 compaction 清除时按
// 内存态补写（record-store 重建矩阵的内存重建同构思路，降级路径而非主路径）。
//
// 模块级绑定：bindNotifyLedgerHost 由 index.ts 的 session_start handler 装配（pi +
// ctx 在该处可用），notifier.notify 经 getBoundNotifyLedger 消费——不经
// SubagentService.piAdapter（该适配层不在 U2 改动面）。未 bind 时 notifier 退回
// delivery 内核路径（向后兼容旧装配 / 无 ledger 的测试场景）。

import { getLogger } from "../core/logger.ts";

/** U4 分桶日志与 index.ts 装配层共用同一具名 logger（getLogger 缓存单例）。 */
const logger = getLogger("subagents");

/** 账本 entry customType（plain custom entry，不进 LLM 上下文）。 */
export const NOTIFY_LEDGER_CUSTOM_TYPE = "subagent-bg-notify-ledger";
/** 销账 entry customType（plain custom entry，不进 LLM 上下文）。 */
export const NOTIFY_ACK_CUSTOM_TYPE = "subagent-bg-notify-ack";
/**
 * [T4③/PS-6] 放弃终态 entry customType（plain custom entry，不进 LLM 上下文）。
 * 与 ack 同形同域：恢复/compaction 扫描把它视同已销账——放弃条目跨重启不复活。
 */
export const NOTIFY_ABANDONED_CUSTOM_TYPE = "subagent-bg-notify-abandoned";

/**
 * 送达消息的 customType。notifier.ts / bg-notify-render / index.ts（messageRenderer
 * 注册）同名字符串的单一常量源——本模块不 import notifier（避免循环依赖：
 * notifier.notify → getBoundNotifyLedger），等值由 notify-ledger.test.ts 钉住。
 */
export const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

/**
 * 看门狗周期与超时（ms）：主 session 长期无 settled 时的兜底触发面（D5 ②）。
 * 周期即超时——sent 后一个周期无回执即重投（正常时序 settled 远早于周期到达，
 * 回执销账先行；只有消息真丢失（如 steer 滞留内存队列后 session 异常）才触发重投，
 * at-least-once + notifyId 幂等兜底）。
 */
export const NOTIFY_WATCHDOG_MS = 120_000;

/**
 * [T4③/PS-6] 单条通知投递尝试上限（attempts 字段含首次投递）：看门狗把 sent 超期
 * 条目转回 pending 前，attempts 已达本上限 → 不再重投，转放弃终态（abandoned entry
 * + warn 恢复指引）。被否语义：「重投无限但幂等」——幂等只防重复入账，不防重复
 * 投递唤醒 LLM（设计 docs/architecture/crash-forensics-and-watchdog.md 附录 E §7.2 T4③）。
 */
export const NOTIFY_REDELIVERY_MAX_ATTEMPTS = 5;

/**
 * U4 投递计数分桶（设计 §5 U4：分桶口径与 §2.2 三条丢失路径一一对应，回归时定位到
 * 具体环节）：
 *   - ②settleRejected → §2.2「delivery busy parked / 投递尝试被拒」：sendDelivery
 *     受理失败（抛异常）次数（ledger 主路径下投递被拒的唯一形态；降级内核路径的
 *     settle rejected 由 delivery warn 注入覆盖）；
 *   - ①watchdogReplays → §2.2「busy 窗口滞留（steer 内存队列滞留 / 合批窗口顺延）」：
 *     sent 超期无回执 → 看门狗转回 pending 重投的条数（同一消息多次超时累计）；
 *   - ③recoveryReplays → §2.2「重启内存态清零」：session_start 恢复重放条数。
 */
export interface NotifyDeliveryBucketMetrics {
  /** 投递尝试被拒（sendDelivery 受理失败）次数。 */
  settleRejected: number;
  /** 销账超时 → 看门狗重投条数（累计）。 */
  watchdogReplays: number;
  /** session_start 恢复重放条数（累计）。 */
  recoveryReplays: number;
}

/** ledger entry 的 data schema（v1）。content 为预格式化文案（notifier
 *  buildLlmContent 产物）——恢复重放直接复用，ledger 不依赖格式化函数。
 *  record 为投递 details（BgNotifyRecord 投影，含 notifyId）——对 ledger 不透明
 *  （仅透传给送达 details / 重放），恢复扫描时经 isPlainObject 运行时校验。 */
export interface NotifyLedgerEntryData {
  v: 1;
  notifyId: string;
  /** 预格式化通知正文（重放时原样投递，G4 字节锁定由此保真）。 */
  content: string;
  /** details record（回执匹配键 notifyId 在其内）。 */
  record: object;
}

/** ack entry 的 data schema（v1）。 */
export interface NotifyAckEntryData {
  v: 1;
  notifyId: string;
}

/** [T4③/PS-6] abandoned entry 的 data schema（v1，与 ack 同形——终态标记只需身份键）。 */
export interface NotifyAbandonedEntryData {
  v: 1;
  notifyId: string;
}

/** ledger 依赖的宿主最小接口（index.ts session_start 装配；解耦便于测试）。 */
export interface NotifyLedgerHost {
  /** 写 plain custom entry（ledger/ack/abandoned 通道；pi.appendEntry）。 */
  appendLedgerEntry(customType: string, data: unknown): void;
  /** 读当前 session 全部 entry（回执扫描 + 恢复扫描；ctx.sessionManager.getEntries()）。 */
  readSessionEntries(): readonly unknown[];
  /** 主 agent 是否空闲（发送前二次复查用；ctx.isIdle()）。 */
  isIdle(): boolean;
  /** 订阅 settled 边沿（pi.on("agent_settled")——无退订语义：createExtensionAPI.on
   *  只 push 进 extension.handlers、无 off（pi 0.84.4 loader.js:209-214），由 ledger
   *  disposed 标志包装）。注意与 ctx.events.on(channel) 消歧：后者走 eventBus、有
   *  trackEventBusSubscription 退订通路（loader.js:174、:338），语义不同。 */
  onAgentSettled(handler: () => void): void;
  /** 单通道送达（pi.sendMessage({triggerTurn:true})）。 */
  sendDelivery(message: { customType: string; content: string; display: boolean; details?: unknown }): void;
}

/** 账面一条通知（entry 持久形态 + 运行时投递状态）。 */
interface NotifyLedgerItem {
  notifyId: string;
  content: string;
  record: object;
  recordedAt: number;
  /** 最近一次投递受理时刻；undefined = 尚未投递（pending，等下一边沿）。 */
  sentAt: number | undefined;
  /** 投递尝试次数（含首次；达 NOTIFY_REDELIVERY_MAX_ATTEMPTS 后超期即放弃，诊断用）。 */
  attempts: number;
}

/** 通知账本（四步生命周期载体）。 */
export interface NotifyLedger {
  /** ① 写账（appendEntry 先于一切投递尝试）。幂等：同 notifyId 已在账（pending/sent）
   *  或已销账 → 返回 false（调用方跳过投递——notifyId 幂等去重）。 */
  record(notifyId: string, content: string, record: object): boolean;
  /** ② 投递尝试：isIdle 二次复查，busy / 探测异常 → 挂回 pending 等下一边沿；idle →
   *  同批 pending 合并单条送达（triggerTurn 直达）。 */
  attemptDeliver(): void;
  /** ③ 回执销账：扫 session entries，出现 notifyId 匹配的送达 custom_message entry
   *  → appendEntry(ack) + 摘账（内存态不承担销账职责，权威 = 多列 entry 差集）。 */
  checkReceipts(): void;
  /** ④ 重启恢复：扫 ledger/ack/abandoned entry 差集，未销账且未放弃号重新入账并投递
   *  （已销账零重发；已放弃号不复活——[T4③/PS-6] 止损终态跨重启生效）。
   *  @returns 重放条数。 */
  recoverFromSession(): number;
  /** compaction 降级（P-B4 未验证）：检测 ledger/ack/abandoned entry 被清除 → 按内存态补写。
   *  @returns 补写条数。 */
  compactionCheck(): number;
  /** 诊断/测试：pending（已记账未投递）条数。 */
  pendingCount(): number;
  /**
   * [T4④/PS-5] pending 只读快照（notifyId/content/record，副本非活引用）：
   * 供 SubagentService.dispose 在「shutdown flush 被 isIdle 门拦」时把未投递
   * pending 复写落盘（同一 ledger entry 通道，notifyId 幂等）供重启 replay。
   * 消费侧配合面仅此只读方法——不改变 attemptDeliver/abandon 既有语义。
   */
  pendingEntries(): ReadonlyArray<{ notifyId: string; content: string; record: object }>;
  /** 诊断/测试：已投递待回执条数。 */
  waitingReceiptCount(): number;
  /** U4 诊断：三桶计数快照（副本；增量同时经 extensionLogger 通道落日志）。 */
  deliveryMetrics(): NotifyDeliveryBucketMetrics;
  /** 销毁：清看门狗 timer + 摘模块级绑定。settled 边沿静默：直调实例由闭包内
   *  disposed 标志短路；bind 路径实例从 boundLedger 摘除（单例 handler 不再分发到它）。 */
  dispose(): void;
}

// ─── entry 形态判定（运行时 guard，无 unsafe cast） ──────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 扫 ledger/ack/abandoned 三列 plain custom entry（恢复 / compaction 检查共用）。 */
function scanSessionLedgerEntries(entries: readonly unknown[]): {
  ledger: Map<string, NotifyLedgerEntryData>;
  acked: Set<string>;
  abandoned: Set<string>;
} {
  const ledger = new Map<string, NotifyLedgerEntryData>();
  const acked = new Set<string>();
  const abandoned = new Set<string>();
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry["type"] !== "custom") continue;
    const customType = entry["customType"];
    const data = entry["data"];
    if (!isPlainObject(data)) continue;
    const notifyId = data["notifyId"];
    if (typeof notifyId !== "string") continue;
    if (customType === NOTIFY_LEDGER_CUSTOM_TYPE) {
      const content = data["content"];
      const record = data["record"];
      if (typeof content === "string" && isPlainObject(record)) {
        // 后写覆盖：fork 文件含同 notifyId 多条 ledger entry 时取最新
        ledger.set(notifyId, { v: 1, notifyId, content, record });
      }
    } else if (customType === NOTIFY_ACK_CUSTOM_TYPE) {
      acked.add(notifyId);
    } else if (customType === NOTIFY_ABANDONED_CUSTOM_TYPE) {
      abandoned.add(notifyId);
    }
  }
  return { ledger, acked, abandoned };
}

/** 收集 wanted 集合中已送达（custom_message entry 出现）的 notifyId。
 *  送达 entry 两种形态都匹配：单条 details.notifyId / 批量 details.items[].notifyId
 *  （对齐 courier 合并投递的 details 结构）。 */
function collectDeliveredNotifyIds(entries: readonly unknown[], wanted: Set<string>): Set<string> {
  const delivered = new Set<string>();
  if (wanted.size === 0) return delivered;
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry["type"] !== "custom_message") continue;
    if (entry["customType"] !== NOTIFY_CUSTOM_TYPE) continue;
    const details = entry["details"];
    if (!isPlainObject(details)) continue;
    const notifyId = details["notifyId"];
    if (typeof notifyId === "string" && wanted.has(notifyId)) {
      delivered.add(notifyId);
    }
    const items = details["items"];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (isPlainObject(item)) {
          const id = item["notifyId"];
          if (typeof id === "string" && wanted.has(id)) delivered.add(id);
        }
      }
    }
  }
  return delivered;
}

// ─── 账本实现 ────────────────────────────────────────────────

export function createNotifyLedger(
  host: NotifyLedgerHost,
  options?: { registerSettledListener?: boolean },
): NotifyLedger {
  /** 在账未销账（recorded / sent 两态）。 */
  const items = new Map<string, NotifyLedgerItem>();
  /** 已销账内存索引（notifyId 幂等判重 + compaction 补写源；权威 = ack entry 列）。 */
  const ackedIds = new Set<string>();
  /**
   * [T4③/PS-6] 已放弃终态内存索引（幂等判重 + compaction 补写源；权威 = abandoned
   * entry 列）。与 ackedIds 同型：放弃是终态，同 notifyId 绝不再入账/重投/复活。
   */
  const abandonedIds = new Set<string>();
  /** U4 投递计数三桶（诊断快照源；增量经 emitBucketLog 落 extensionLogger）。 */
  const buckets: NotifyDeliveryBucketMetrics = {
    settleRejected: 0,
    watchdogReplays: 0,
    recoveryReplays: 0,
  };
  let disposed = false;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;

  const api: NotifyLedger = {
    record(notifyId, content, record): boolean {
      if (disposed) return false;
      // 幂等去重：在账（pending/sent）/ 已销账 / 已放弃（[T4③] 终态绝不重发）→ false
      if (items.has(notifyId) || ackedIds.has(notifyId) || abandonedIds.has(notifyId)) return false;
      host.appendLedgerEntry(NOTIFY_LEDGER_CUSTOM_TYPE, {
        v: 1,
        notifyId,
        content,
        record,
      } satisfies NotifyLedgerEntryData);
      items.set(notifyId, { notifyId, content, record, recordedAt: Date.now(), sentAt: undefined, attempts: 0 });
      ensureWatchdog();
      return true;
    },

    attemptDeliver(): void {
      if (disposed) return;
      const pending = [...items.values()].filter((i) => i.sentAt === undefined);
      if (pending.length === 0) return;
      // 发送前二次复查（D5 零宽容）：busy / 探测异常（session 关闭等）→ 放弃本次，
      // 消息挂回 pending 等下一边沿 / 看门狗
      try {
        if (!host.isIdle()) return;
      } catch {
        return;
      }
      const message = mergeItems(pending);
      try {
        host.sendDelivery(message);
      } catch {
        // 受理失败：留 pending（账已落盘，下一边沿重试 + 重启恢复兜底）。
        // U4 ②settleRejected 桶：投递尝试被拒按事件次计数（对齐内核 onSettled
        // per-批次口径），增量落日志供回归定位。
        buckets.settleRejected += 1;
        emitBucketLog("settleRejected", buckets.settleRejected, { pending: pending.length });
        return;
      }
      const now = Date.now();
      for (const item of pending) {
        item.sentAt = now;
        item.attempts += 1;
      }
    },

    checkReceipts(): void {
      if (disposed || items.size === 0) return;
      const delivered = collectDeliveredNotifyIds(host.readSessionEntries(), new Set(items.keys()));
      for (const notifyId of delivered) {
        ack(notifyId);
      }
    },

    recoverFromSession(): number {
      if (disposed) return 0;
      const state = scanSessionLedgerEntries(host.readSessionEntries());
      for (const notifyId of state.acked) ackedIds.add(notifyId);
      // [T4③/PS-6] 放弃终态跨重启生效：abandoned entry 视同已销账，下方差集重放跳过
      // ——放弃号重启后不复活不重投（止损语义不以进程边界失效）。
      for (const notifyId of state.abandoned) abandonedIds.add(notifyId);
      let replayed = 0;
      for (const entry of state.ledger.values()) {
        if (state.acked.has(entry.notifyId)) continue; // 已销账零重发
        if (abandonedIds.has(entry.notifyId)) continue; // 已放弃不复活（止损终态）
        if (items.has(entry.notifyId) || ackedIds.has(entry.notifyId)) continue; // 幂等
        items.set(entry.notifyId, {
          ...entry,
          recordedAt: Date.now(),
          sentAt: undefined,
          attempts: 0,
        });
        replayed += 1;
      }
      if (replayed > 0) {
        // U4 ③recoveryReplays 桶：重启恢复重放条数（index.ts 装配层的重复日志已并入）
        buckets.recoveryReplays += replayed;
        emitBucketLog("recoveryReplays", buckets.recoveryReplays, { replayed });
        ensureWatchdog();
        // 「送达已落盘、销账未落盘」的强杀窗口（custom_message entry 已写、ack 尚未写）：
        // 回执已在 session 文件里，先消费它补写 ack，避免对已送达条目必然重投一次
        //（边沿/看门狗路径都是先 checkReceipts 再 attemptDeliver，恢复路径对齐同序；
        // G2 仍保留 at-least-once 兜底语义，此处只是零成本消除常见重复）。
        checkReceipts();
        attemptDeliver();
      }
      return replayed;
    },

    compactionCheck(): number {
      if (disposed) return 0;
      const state = scanSessionLedgerEntries(host.readSessionEntries());
      let rewritten = 0;
      for (const item of items.values()) {
        if (!state.ledger.has(item.notifyId)) {
          host.appendLedgerEntry(NOTIFY_LEDGER_CUSTOM_TYPE, {
            v: 1,
            notifyId: item.notifyId,
            content: item.content,
            record: item.record,
          } satisfies NotifyLedgerEntryData);
          rewritten += 1;
        }
      }
      for (const notifyId of ackedIds) {
        if (!state.acked.has(notifyId)) {
          host.appendLedgerEntry(NOTIFY_ACK_CUSTOM_TYPE, { v: 1, notifyId } satisfies NotifyAckEntryData);
          rewritten += 1;
        }
      }
      // [T4③/PS-6] 放弃终态同享补写：内存是权威，compaction 清掉 abandoned entry 后
      // 不补写会让放弃号在下次重启按差集复活（重投重启）。
      for (const notifyId of abandonedIds) {
        if (!state.abandoned.has(notifyId)) {
          host.appendLedgerEntry(NOTIFY_ABANDONED_CUSTOM_TYPE, { v: 1, notifyId } satisfies NotifyAbandonedEntryData);
          rewritten += 1;
        }
      }
      return rewritten;
    },

    pendingCount(): number {
      let n = 0;
      for (const item of items.values()) {
        if (item.sentAt === undefined) n += 1;
      }
      return n;
    },

    pendingEntries(): ReadonlyArray<{ notifyId: string; content: string; record: object }> {
      const out: Array<{ notifyId: string; content: string; record: object }> = [];
      for (const item of items.values()) {
        if (item.sentAt !== undefined) continue;
        // 逐条浅拷贝：消费方（dispose 落盘复写）不得持有内部可变态。
        out.push({ notifyId: item.notifyId, content: item.content, record: { ...item.record } });
      }
      return out;
    },

    waitingReceiptCount(): number {
      let n = 0;
      for (const item of items.values()) {
        if (item.sentAt !== undefined) n += 1;
      }
      return n;
    },

    deliveryMetrics(): NotifyDeliveryBucketMetrics {
      return { ...buckets };
    },

    dispose(): void {
      disposed = true;
      if (watchdogTimer !== undefined) {
        clearInterval(watchdogTimer);
        watchdogTimer = undefined;
      }
      if (getBoundLedger() === api) setBoundLedger(undefined);
    },
  };

  // ─── 内部函数（闭包） ─────────────────────────────────────

  function ack(notifyId: string): void {
    if (!items.has(notifyId)) return;
    host.appendLedgerEntry(NOTIFY_ACK_CUSTOM_TYPE, { v: 1, notifyId } satisfies NotifyAckEntryData);
    items.delete(notifyId);
    ackedIds.add(notifyId);
    maybeStopWatchdog();
  }

  /** 同一边沿的多条 pending 合并为一条注入（D5）。合并形态对齐 delivery 内核
   *  buildBatchPayload：content 以 "\n\n---\n\n" join；details 包装 {batch:true,
   *  items}（bg-notify-render 的 extractBgNotifyRecord 按 item 顶层字段读取）。 */
  function mergeItems(batch: NotifyLedgerItem[]): {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  } {
    if (batch.length === 1) {
      return { customType: NOTIFY_CUSTOM_TYPE, content: batch[0]!.content, display: true, details: batch[0]!.record };
    }
    return {
      customType: NOTIFY_CUSTOM_TYPE,
      content: batch.map((i) => i.content).join("\n\n---\n\n"),
      display: true,
      details: { batch: true, items: batch.map((i) => i.record) },
    };
  }

  /** [T4③/PS-6] 放弃终态：appendEntry(abandoned) 落盘终态标记（重启恢复不复活）+
   *  warn 恢复指引。放弃后账面摘除（pending/waiting 计数归零、看门狗可停），同
   *  notifyId 被 record 幂等拒绝——「确认不可达」的止损上半场；通知内容本身仍可
   *  经 subagents action:"list" 手动核对（账本 entry 与 result 落盘不受影响）。
   *  放弃不计入 watchdogReplays 桶（该桶口径 = 实际发生重投的条数）。 */
  function abandonItem(item: NotifyLedgerItem): void {
    host.appendLedgerEntry(NOTIFY_ABANDONED_CUSTOM_TYPE, { v: 1, notifyId: item.notifyId } satisfies NotifyAbandonedEntryData);
    items.delete(item.notifyId);
    abandonedIds.add(item.notifyId);
    // 消息含 subagent 标识与恢复指引（S-E 验收面）；notifyId/attempts 等动态值按
    // D4 约定放 data 参数（msg 近固定 key，限流命中面）。
    logger.warn(
      `Subagent "${itemLabel(item)}" notification abandoned - no receipt after ` +
        `${NOTIFY_REDELIVERY_MAX_ATTEMPTS} delivery attempts; verify manually via subagents action:"list"`,
      { notifyId: item.notifyId, attempts: item.attempts },
    );
    maybeStopWatchdog();
  }

  /** 放弃 warn 的 subagent 标识：优先 record.agent（人可读）；record 形态异常时
   *  （ledger 对 record 不透明，见 NotifyLedgerEntryData）退回 notifyId（仍可检索）。 */
  function itemLabel(item: NotifyLedgerItem): string {
    if (isPlainObject(item.record)) {
      const agent = item.record["agent"];
      if (typeof agent === "string" && agent.length > 0) return agent;
    }
    return item.notifyId;
  }

  function ensureWatchdog(): void {
    if (watchdogTimer !== undefined || disposed) return;
    // 看门狗（D5 ②兜底触发面）：回执检查 + 超时重投 + pending 补投。
    watchdogTimer = setInterval(() => {
      if (disposed) return;
      checkReceipts();
      // sent 超过一个周期无回执 → 转回 pending（attempts 累加），本次 tick 的
      // attemptDeliver 即重投——正常时序 settled 边沿早已销账，只有消息真丢失才到这
      const cutoff = Date.now() - NOTIFY_WATCHDOG_MS;
      let timedOut = 0;
      // [T4③/PS-6] 止损：attempts 已达上限仍超期 = 确认不可达 → 放弃转终态，
      // 不再重投（同一条完成通知不无限重复注入唤醒 LLM）。
      const givenUp: NotifyLedgerItem[] = [];
      for (const item of items.values()) {
        if (item.sentAt === undefined || item.sentAt > cutoff) continue;
        if (item.attempts >= NOTIFY_REDELIVERY_MAX_ATTEMPTS) {
          givenUp.push(item);
          continue;
        }
        item.sentAt = undefined;
        timedOut += 1;
      }
      for (const item of givenUp) abandonItem(item);
      if (timedOut > 0) {
        // U4 ①watchdogReplays 桶：busy 窗口滞留兜底的重投条数（同一消息反复超时累计）
        buckets.watchdogReplays += timedOut;
        emitBucketLog("watchdogReplays", buckets.watchdogReplays, { timedOut });
      }
      attemptDeliver();
    }, NOTIFY_WATCHDOG_MS);
  }

  function maybeStopWatchdog(): void {
    if (items.size === 0 && watchdogTimer !== undefined) {
      clearInterval(watchdogTimer);
      watchdogTimer = undefined;
    }
  }

  function attemptDeliver(): void {
    api.attemptDeliver();
  }

  function checkReceipts(): void {
    api.checkReceipts();
  }

  /** U4 分桶日志：计数经既有 extensionLogger 通道暴露（appendEntry 落 session JSONL
   *  不进 LLM/TUI + XYZ_AGENT_DEBUG=1 落 `<dataDir>/logs/`），替代无痕内存态。
   *  msg 固定 key（限流命中面），动态值按 D4 约定放 data 参数。 */
  function emitBucketLog(
    bucket: keyof NotifyDeliveryBucketMetrics,
    total: number,
    extra: Record<string, unknown>,
  ): void {
    logger.warn(`notify delivery bucket [${bucket}]`, { total, ...extra });
  }

  // settled 边沿（D5 ①触发点）：先查回执（销账上一轮投递），再投递新 pending。
  // 回执可见性时序（custom message 落盘 message_end → appendCustomMessageEntry 先于
  // _emitAgentSettled）= 设计 P-B1(b) 探针门待证项（docs/architecture/pi-boundary-reliability.md 附录 D
  // D5）——实测若晚于 S3 阈值，按既定降级路径收敛为「只记账 + 超时看门狗直达」。
  // at-least-once 正确性不承重于该时序：checkReceipts 错过边沿由看门狗 + 重启恢复兜底
  // （P-B0 相邻机制已源码级锚定，agent-session.js:327-331，PS-07）。
  // [MF-5] registerSettledListener=false（bind 路径）时跳过注册：pi.on("agent_settled")
  // 无退订语义——createExtensionAPI.on 只 push 进 extension.handlers、无 off
  //（pi 0.84.4 dist/core/extensions/loader.js:209-214）。注意消歧两类订阅面：此处的
  // pi.on 是生命周期事件订阅（无退订）；ctx.events.on(channel) 走 eventBus、有
  // trackEventBusSubscription 退订通路（loader.js:174、:338）——勿按后者的可退订
  // 语义「修复」此处。per-bind 注册会随 session 切换累积死 handler
  // （旧实例 disposed 短路但物理监听永存）——bind 用模块级单例 handler
  // （settledEdgeDispatch）+ boundLedger 引用切换替代（见 bindNotifyLedgerHost）。
  if (options?.registerSettledListener !== false) {
    host.onAgentSettled(() => {
      if (disposed) return;
      checkReceipts();
      attemptDeliver();
    });
  }

  return api;
}

// ─── 模块级绑定（notifier 消费入口） ──────────────────────────

// C-ext-06：跨模块单例经 globalThis[Symbol.for] slot 持有，不用裸模块级 let——
// jiti 因路径字符串不同加载多份模块时裸 let 会单例分裂：index.ts 的 bind 与
// notifier.ts 的 getBoundNotifyLedger 各持一份绑定 → notify 静默走「未 bind →
// 退回 delivery 内核路径」分岔（无任何 warn），U2 at-least-once 退化回 C-ext-19
// 立约要防的 at-most-once 事故基线。先例：model-config-service MODEL_SERVICE_SLOT_KEY /
// dialogQueue / channelHandshake / ui-observability 同款（docs/standards.md §7.5）。
const NOTIFY_LEDGER_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.notifyLedger");

type NotifyLedgerSlot = {
  current: NotifyLedger | undefined;
  /**
   * [MF-5] settled 物理监听注册标志：物理监听（host.onAgentSettled → pi.on）只在
   * 首次 bind 时注册一次；真实环境 pi 是同一 emitter，后续 /resume /fork /new 的
   * session_start 只切换 boundLedger 引用，不新增监听。与 boundLedger 同 slot 持有
   * （C-ext-06）——裸模块级 let 在 jiti 路径分裂下双实例各持旗标 → 同一 emitter
   * 双注册 settledEdgeDispatch；并入 slot 后旗标与绑定单介质同源。
   */
  listenerRegistered: boolean;
};

function getNotifyLedgerSlot(): NotifyLedgerSlot {
  // globalThis 无 symbol 索引签名，但运行时支持 symbol 键——用 Reflect 安全读写，
  // 避免双重断言。NotifyLedgerSlot 是运行时保证的固定形状（本文件唯一写入点）。
  let slot = Reflect.get(globalThis, NOTIFY_LEDGER_SLOT_KEY) as NotifyLedgerSlot | undefined;
  if (!slot) {
    slot = { current: undefined, listenerRegistered: false };
    Reflect.set(globalThis, NOTIFY_LEDGER_SLOT_KEY, slot);
  }
  return slot;
}

/** 当前绑定的 ledger（bind/dispose/reset 三个写点与消费读点全部经 slot，单介质同源）。 */
function getBoundLedger(): NotifyLedger | undefined {
  return getNotifyLedgerSlot().current;
}

function setBoundLedger(ledger: NotifyLedger | undefined): void {
  getNotifyLedgerSlot().current = ledger;
}

/**
 * [MF-5] settled 边沿模块级单例 handler：分发目标恒为当前活跃 ledger。
 * disposed 实例已在 dispose() 中从 boundLedger 摘除 → 不会成为分发目标
 * （短路语义与旧闭包 handler 的 `if (disposed) return` 等价；api 方法内
 * disposed 守卫双保险）。boundLedger 为 undefined（未 bind / 已全部 dispose）时
 * 静默返回，对齐旧闭包在实例不存在时的无动作语义。
 */
function settledEdgeDispatch(): void {
  const ledger = getBoundLedger();
  if (ledger === undefined) return;
  ledger.checkReceipts();
  ledger.attemptDeliver();
}

/**
 * session_start 装配（index.ts）：构造新 ledger 并绑定为模块级单例（notifier.notify
 * 经 getBoundNotifyLedger 消费）。重复 bind（/resume /fork /new 的 session_start）
 * 替换旧实例——内存态清零符合「内存不承担销账职责」，权威 = entry 多列差集
 * （调用方随后 recoverFromSession 重建）。
 *
 * [MF-5] 监听单例化：首次 bind 经当次 host 注册模块级单例 handler
 * （settledEdgeDispatch），后续 bind 只换 boundLedger 引用——物理监听数不随
 * session 切换增长。直调 createNotifyLedger（旧装配 / 测试）不经过此路径，
 * 保留 per-instance 注册（默认 registerSettledListener 语义不变）。
 */
export function bindNotifyLedgerHost(host: NotifyLedgerHost): NotifyLedger {
  getBoundLedger()?.dispose();
  if (!getNotifyLedgerSlot().listenerRegistered) {
    getNotifyLedgerSlot().listenerRegistered = true;
    host.onAgentSettled(settledEdgeDispatch);
  }
  const ledger = createNotifyLedger(host, { registerSettledListener: false });
  setBoundLedger(ledger);
  return ledger;
}

/**
 * notifier.notify 消费入口：未 bind（旧装配 / 无 ledger 的测试）→ undefined，
 * notifier 退回 delivery 内核路径（向后兼容）。
 */
export function getBoundNotifyLedger(): NotifyLedger | undefined {
  return getBoundLedger();
}

/** 测试隔离：dispose 并清模块级绑定。[MF-5] 同步重置监听注册标志——测试的 mock
 *  host 是新 emitter（真实 pi 同一 emitter，本函数仅测试路径调用），不复位则后续
 *  bind 不再注册、新 mock 的 fireSettled 失效。 */
export function _resetNotifyLedgerForTest(): void {
  getBoundLedger()?.dispose();
  setBoundLedger(undefined);
  getNotifyLedgerSlot().listenerRegistered = false;
}
