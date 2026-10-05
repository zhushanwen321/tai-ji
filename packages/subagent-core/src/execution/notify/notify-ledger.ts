// src/execution/notify/notify-ledger.ts
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
//     agent-session.js:327-331）。发送前二次复查 isIdle，竞态窗口内新 run 已启动则
//     放弃本次、消息挂回 pending 等下一边沿。sent 后无回执不重投——通知可能丢失是
//     已接受代价（ADR-0112 事实驱动：时间窗重投属补偿猜测，不建）。
//
// 四步生命周期（D4）：
//   ① record：appendEntry(ledger entry) 落盘（先于一切投递尝试）
//   ② deliver：settled 边沿触发 attemptDeliver——单通道
//      pi.sendMessage({triggerTurn:true})（steer/followUp/nextTurn 通道已全部删除，
//      D5）；同一边沿的多条 pending 合并为一条注入。[u9] 送达通道按条目可指：
//      record(..., { deliveryCustomType }) 允许外部结果语义通知携带自己的送达
//      customType（如 workflow 收口通知的 "workflow-result"——runtime
//      event-interpreter 按该类型识别 run 完成驱动 W18 workflow-record 失效信号，
//      不能复用 NOTIFY_CUSTOM_TYPE）；缺省仍为 NOTIFY_CUSTOM_TYPE（既有行为零
//      变化）。分组投递：默认通道组保持合批，外部通道组逐条（batch 合并形态
//      {batch,items} 对外部通道无消费契约，且 details 须保持调用方原样）。
//   ③ ack：回执判定成功（主 session 出现 notifyId 匹配的送达 custom_message
//      entry——customType ∈ {NOTIFY_CUSTOM_TYPE} ∪ 在账条目声明的外部通道）后
//      appendEntry("subagent-bg-notify-ack")
//   ④ replay：重启恢复扫描 ledger/ack entry 差集重放；重放按 notifyId 幂等去重
//    （details 携带 notifyId，重复条目可识别），送达通道随 entry 保留
//
// 通道分工（D4）：ledger/ack 用 plain appendEntry（type=custom 不进 LLM 上下文——
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

import { getLogger } from "../../core/logger.ts";
import { SUBAGENT_BG_NOTIFY_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
import { collectDeliveredNotifyIds, isPlainObject } from "./notify-ledger-helpers.ts";
import { GLOBAL_SLOT_KEYS } from "../../shared/global-slots.ts";

/** U4 分桶日志与 index.ts 装配层共用同一具名 logger（getLogger 缓存单例）。 */
const logger = getLogger("subagents");

/** 账本 entry customType（plain custom entry，不进 LLM 上下文）。 */
export const NOTIFY_LEDGER_CUSTOM_TYPE = "subagent-bg-notify-ledger";
/** 销账 entry customType（plain custom entry，不进 LLM 上下文）。 */
export const NOTIFY_ACK_CUSTOM_TYPE = "subagent-bg-notify-ack";

/**
 * 送达消息的 customType——notify 词表单源（extension-protocol 的
 * SUBAGENT_BG_NOTIFY_CUSTOM_TYPE）的兼容别名：notifier.ts / bg-notify-render /
 * 壳 index.ts（messageRenderer 注册）/ shared 集合消费同一常量，历史名保留供
 * 本包既有消费面（等值锁 = 壳 __tests__/contract.notify-custom-types.test.ts）。
 */
export const NOTIFY_CUSTOM_TYPE = SUBAGENT_BG_NOTIFY_CUSTOM_TYPE;

/**
 * U4 投递计数分桶（设计 §5 U4：分桶口径与 §2.2 丢失路径对应，回归时定位到
 * 具体环节）：
 *   - ②settleRejected → 「delivery busy parked / 投递尝试被拒」：sendDelivery
 *     受理失败（抛异常）次数（ledger 主路径下投递被拒的唯一形态；降级内核路径的
 *     settle rejected 由 delivery warn 注入覆盖）；
 *   - ③recoveryReplays → 「重启内存态清零」：session_start 恢复重放条数。
 */
export interface NotifyDeliveryBucketMetrics {
  /** 投递尝试被拒（sendDelivery 受理失败）次数。 */
  settleRejected: number;
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
  /**
   * [u9] 送达 customType（NotifyRecordOptions.deliveryCustomType 的落盘形态）。
   * 缺省（undefined）= NOTIFY_CUSTOM_TYPE 旧格式——存量 entry 零迁移，恢复扫描
   * 对缺省按默认通道处理。
   */
  deliveryCustomType?: string;
}

/** ack entry 的 data schema（v1）。 */
export interface NotifyAckEntryData {
  v: 1;
  notifyId: string;
}

/**
 * record 的投递通道选项（[u9] notifyDone 账本化——C-ext-19 迁移）。
 *
 * 背景：workflow 收口通知的送达 customType 是 WORKFLOW_RESULT_CUSTOM_TYPE
 * （extension-protocol notify 词表单源；runtime event-interpreter 按该类型识别
 * run 完成并驱动 W18 workflow-record 失效信号，taiji 完成通知 display 覆写 SSOT
 * 亦按它收录），不能复用 NOTIFY_CUSTOM_TYPE——值由调用方声明（core 不替调用方
 * 选通道）。
 */
export interface NotifyRecordOptions {
  /**
   * 该条通知的送达 customType：sendDelivery 透传给 pi.sendMessage + 回执扫描的
   * 接受域扩展（details.notifyId 匹配仍在，通道只是匹配前置条件）。缺省
   * （undefined）= NOTIFY_CUSTOM_TYPE，既有调用零变化。
   */
  deliveryCustomType?: string;
}

/** ledger 依赖的宿主最小接口（index.ts session_start 装配；解耦便于测试）。 */
export interface NotifyLedgerHost {
  /** 写 plain custom entry（ledger/ack 通道；pi.appendEntry）。 */
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
  /** [u9] 送达通道（undefined = NOTIFY_CUSTOM_TYPE 默认通道）。 */
  deliveryCustomType: string | undefined;
}

/** 通知账本（四步生命周期载体）。 */
export interface NotifyLedger {
  /** ① 写账（appendEntry 先于一切投递尝试）。幂等：同 notifyId 已在账（pending/sent）
   *  或已销账 → 返回 false（调用方跳过投递——notifyId 幂等去重）。
   *  [u9] options.deliveryCustomType 声明该条的送达通道（缺省 = NOTIFY_CUSTOM_TYPE），
   *  随 ledger entry 落盘、恢复重放保留。 */
  record(notifyId: string, content: string, record: object, options?: NotifyRecordOptions): boolean;
  /** ② 投递尝试：isIdle 二次复查，busy / 探测异常 → 挂回 pending 等下一边沿；idle →
   *  同批 pending 合并单条送达（triggerTurn 直达）。 */
  attemptDeliver(): void;
  /** ③ 回执销账：扫 session entries，出现 notifyId 匹配的送达 custom_message entry
   *  → appendEntry(ack) + 摘账（内存态不承担销账职责，权威 = 多列 entry 差集）。 */
  checkReceipts(): void;
  /** ④ 重启恢复：扫 ledger/ack entry 差集，未销账号重新入账并投递（已销账零重发）。
   *  @returns 重放条数。 */
  recoverFromSession(): number;
  /** compaction 降级（P-B4 未验证）：检测 ledger/ack entry 被清除 → 按内存态补写。
   *  @returns 补写条数。 */
  compactionCheck(): number;
  /** 诊断/测试：pending（已记账未投递）条数。 */
  pendingCount(): number;
  /**
   * [T4④/PS-5] pending 只读快照（notifyId/content/record，副本非活引用）：
   * 供 SubagentService.dispose 在「shutdown flush 被 isIdle 门拦」时把未投递
   * pending 复写落盘（同一 ledger entry 通道，notifyId 幂等）供重启 replay。
   * 消费侧配合面仅此只读方法——不改变 attemptDeliver 既有语义。
   */
  pendingEntries(): ReadonlyArray<{
    notifyId: string;
    content: string;
    record: object;
    /** [u9] 送达通道（dispose 复写落盘必须透传，缺省会把它改判默认通道） */
    deliveryCustomType?: string;
  }>;
  /** 诊断/测试：已投递待回执条数。 */
  waitingReceiptCount(): number;
  /** U4 诊断：三桶计数快照（副本；增量同时经 extensionLogger 通道落日志）。 */
  deliveryMetrics(): NotifyDeliveryBucketMetrics;
  /** 销毁：摘模块级绑定。settled 边沿静默：直调实例由闭包内
   *  disposed 标志短路；bind 路径实例从 boundLedger 摘除（单例 handler 不再分发到它）。 */
  dispose(): void;
}

// ─── 恢复 / compaction 扫描（isPlainObject guard 在 notify-ledger-helpers.ts） ──

/** 扫 ledger/ack 两列 plain custom entry（恢复 / compaction 检查共用）。 */
function scanSessionLedgerEntries(entries: readonly unknown[]): {
  ledger: Map<string, NotifyLedgerEntryData>;
  acked: Set<string>;
} {
  const ledger = new Map<string, NotifyLedgerEntryData>();
  const acked = new Set<string>();
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
        // 后写覆盖：fork 文件含同 notifyId 多条 ledger entry 时取最新；
        // deliveryCustomType 缺省/形态异常 → undefined（默认通道，存量 entry 兼容）
        const deliveryCustomType = data["deliveryCustomType"];
        ledger.set(notifyId, {
          v: 1,
          notifyId,
          content,
          record,
          deliveryCustomType: typeof deliveryCustomType === "string" ? deliveryCustomType : undefined,
        });
      }
    } else if (customType === NOTIFY_ACK_CUSTOM_TYPE) {
      acked.add(notifyId);
    }
  }
  return { ledger, acked };
}

/**
 * [U9] 合并投递的 items 构造：批 wrapper record（{batch:true, items}）展平一层，
 * 其成员 spread 进外层 items 并补 wrapper 身份键；非 wrapper record 原样保留。
 *
 * 为什么必须展平：两条 pending 在父 session busy 窗口先后闭合时，同一边沿的合并
 * 会产出 {batch:true, items:[{batch:true, items:[…]}, …]} 嵌套——下游
 * parseBgNotifyDetails 只解一层，对 wrapper 逐条 null，全 wrapper 时整条 null、
 * 整批记录静默消失。当前 wrapper 生产方（sync collect 批）已退役，但 mergeItems
 * 自身仍产单层批形态，且存量未销账 wrapper entry 重放 + 同边沿合并即可触发嵌套
 * ——本展平是不变量级防线（fd3e8ef1f merge 曾无痕回退本函数与配套测试，本次恢复）。
 *
 * 为什么必须补身份键：改「展平不补键」会切断销账链——合并态的回执匹配面 =
 * collectDeliveredNotifyIds 经 details.items[].notifyId，成员共享批 notifyId 即该批
 * 整体回执语义；不补则批账目永不销账。
 *
 * 身份键取值 = item.notifyId（账本身份键 = 回执匹配的判据键）：批路径两者恒等，
 * 账本键才是销账判据，二者万一背离时以销账可达为准。
 */
function flattenBatchItems(batch: NotifyLedgerItem[]): unknown[] {
  const items: unknown[] = [];
  for (const item of batch) {
    const members = batchWrapperMembers(item.record);
    if (members === undefined) {
      items.push(item.record);
      continue;
    }
    for (const member of members) {
      items.push(isPlainObject(member) ? { ...member, notifyId: item.notifyId } : member);
    }
  }
  return items;
}

/** [U9] 批 wrapper record 判定 + 成员取出：{batch:true, items:[…]} → 成员数组；
 *  其余形态（单条 BgNotifyRecord / 非法载荷）→ undefined（调用方原样保留）。 */
function batchWrapperMembers(record: unknown): readonly unknown[] | undefined {
  if (!isPlainObject(record) || record["batch"] !== true) return undefined;
  const members = record["items"];
  return Array.isArray(members) ? members : undefined;
}

// ─── 自包含 helper（原 createNotifyLedger 闭包内，行为零变化） ──────────

/** 同一边沿的多条 pending 合并为一条注入（D5）。合并形态对齐 delivery 内核
 *  buildBatchPayload：content 以 "\n\n---\n\n" join；details 包装 {batch:true,
 *  items}（bg-notify-render 的 extractBgNotifyRecord 按 item 顶层字段读取）。
 *  [u9] 不再携带 customType——送达通道由 deliverBatch 的分组键统一决定。 */
function mergeItems(batch: NotifyLedgerItem[]): {
  content: string;
  display: boolean;
  details?: unknown;
} {
  if (batch.length === 1) {
    return { content: batch[0]!.content, display: true, details: batch[0]!.record };
  }
  return {
    content: batch.map((i) => i.content).join("\n\n---\n\n"),
    display: true,
    details: { batch: true, items: flattenBatchItems(batch) },
  };
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
  /** U4 投递计数两桶（诊断快照源；增量经 emitBucketLog 落 extensionLogger）。 */
  const buckets: NotifyDeliveryBucketMetrics = {
    settleRejected: 0,
    recoveryReplays: 0,
  };
  let disposed = false;

  const api: NotifyLedger = {
    record(notifyId, content, record, options?): boolean {
      if (disposed) return false;
      // 幂等去重：在账（pending/sent）/ 已销账 → false
      // [round2-notify-fix] 拒绝时 warn 留痕：历史上此分支静默（零日志），同键碰撞导致的
      // 通知丢失无排查线索（2026-09-14 事故的观测盲区）。warn 不改变行为，仅提供可检索
      // 证据；预期内的同轮重发（重复 flush / E1 重建重发）也会留痕——可接受，重发本就
      // 罕见且值得被看见。
      if (items.has(notifyId) || ackedIds.has(notifyId)) {
        logger.warn(
          "[subagents] notify ledger rejected duplicate notifyId (already " +
            `${ackedIds.has(notifyId) ? "acked" : "in-ledger"}) — notification dropped by idempotency`,
          { detail: { notifyId } },
        );
        return false;
      }
      const deliveryCustomType = options?.deliveryCustomType;
      host.appendLedgerEntry(NOTIFY_LEDGER_CUSTOM_TYPE, {
        v: 1,
        notifyId,
        content,
        record,
        deliveryCustomType,
      } satisfies NotifyLedgerEntryData);
      items.set(notifyId, {
        notifyId,
        content,
        record,
        recordedAt: Date.now(),
        sentAt: undefined,
        deliveryCustomType,
      });
      return true;
    },

    attemptDeliver(): void {
      if (disposed) return;
      const pending = [...items.values()].filter((i) => i.sentAt === undefined);
      if (pending.length === 0) return;
      // 发送前二次复查（D5 零宽容）：busy / 探测异常（session 关闭等）→ 放弃本次，
      // 消息挂回 pending 等下一边沿。探测异常 warn 留痕（读失败与 busy 分
      // 通道——busy 是正常挂回，异常是故障信号；静默吞掉会把持续探测故障伪装成
      // 「宿主一直 busy」，通知延迟无从归因）。
      try {
        if (!host.isIdle()) return;
      } catch (err) {
        logger.warn("[subagents] notify ledger isIdle probe failed — delivery deferred to next settled edge", {
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      // [u9] 按送达通道分组（Map 迭代序 = pending 出现序，确定性）：默认通道保持
      // 合批（D5 既有行为）；外部通道组逐条投递——batch 合并形态 {batch,items} 对
      // 外部通道无消费契约，且 details 必须保持调用方原样（如 workflow 收口通知的
      // WorkflowNotifyDetails 单条形态）。部分组失败不影响其他组（成功组照常标
      // sent，失败组留 pending 等下一边沿）。
      const groups = new Map<string, NotifyLedgerItem[]>();
      for (const item of pending) {
        const channel = item.deliveryCustomType ?? NOTIFY_CUSTOM_TYPE;
        const group = groups.get(channel);
        if (group) group.push(item);
        else groups.set(channel, [item]);
      }
      for (const [channel, group] of groups) {
        if (channel === NOTIFY_CUSTOM_TYPE) {
          deliverBatch(channel, group);
        } else {
          for (const item of group) deliverBatch(channel, [item]);
        }
      }
    },

    checkReceipts(): void {
      if (disposed || items.size === 0) return;
      // [u9] 回执接受域 = 默认通道 ∪ 在账条目声明的外部通道（逐次现算——通道集合
      // 随账面变化，不做缓存态）
      const channels = new Set<string>([NOTIFY_CUSTOM_TYPE]);
      for (const item of items.values()) {
        if (item.deliveryCustomType !== undefined) channels.add(item.deliveryCustomType);
      }
      const delivered = collectDeliveredNotifyIds(host.readSessionEntries(), new Set(items.keys()), channels);
      for (const notifyId of delivered) {
        ack(notifyId);
      }
    },

    recoverFromSession(): number {
      if (disposed) return 0;
      const state = scanSessionLedgerEntries(host.readSessionEntries());
      for (const notifyId of state.acked) ackedIds.add(notifyId);
      let replayed = 0;
      for (const entry of state.ledger.values()) {
        // 幂等：在账不重建；已销账零重发（state.acked 已在上方全量并入 ackedIds）
        if (items.has(entry.notifyId) || ackedIds.has(entry.notifyId)) continue;
        items.set(entry.notifyId, {
          ...entry,
          recordedAt: Date.now(),
          sentAt: undefined,
          deliveryCustomType: entry.deliveryCustomType,
        });
        replayed += 1;
      }
      if (replayed > 0) {
        // U4 ③recoveryReplays 桶：重启恢复重放条数（index.ts 装配层的重复日志已并入）
        buckets.recoveryReplays += replayed;
        emitBucketLog("recoveryReplays", buckets.recoveryReplays, { replayed });
        // 「送达已落盘、销账未落盘」的强杀窗口（custom_message entry 已写、ack 尚未写）：
        // 回执已在 session 文件里，先消费它补写 ack，避免对已送达条目必然重投一次
        //（恢复路径对齐边沿路径同序：先 checkReceipts 再 attemptDeliver）。
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
            deliveryCustomType: item.deliveryCustomType,
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
      return rewritten;
    },

    pendingCount(): number {
      let n = 0;
      for (const item of items.values()) {
        if (item.sentAt === undefined) n += 1;
      }
      return n;
    },

    pendingEntries(): ReadonlyArray<{
      notifyId: string;
      content: string;
      record: object;
      /** [u9] 送达通道必须随复写透传：恢复扫描后写覆盖，缺省会把它改判成默认通道
       *（wf-done 重放走 subagent-bg-notify 而非 workflow-result，W18 失效信号失联）。 */
      deliveryCustomType?: string;
    }> {
      const out: Array<{ notifyId: string; content: string; record: object; deliveryCustomType?: string }> = [];
      for (const item of items.values()) {
        if (item.sentAt !== undefined) continue;
        // 逐条浅拷贝：消费方（dispose 落盘复写）不得持有内部可变态。
        out.push({
          notifyId: item.notifyId,
          content: item.content,
          record: { ...item.record },
          ...(item.deliveryCustomType !== undefined ? { deliveryCustomType: item.deliveryCustomType } : {}),
        });
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
      if (getBoundLedger() === api) setBoundLedger(undefined);
    },
  };

  // ─── 内部函数（闭包） ─────────────────────────────────────

  function ack(notifyId: string): void {
    if (!items.has(notifyId)) return;
    host.appendLedgerEntry(NOTIFY_ACK_CUSTOM_TYPE, { v: 1, notifyId } satisfies NotifyAckEntryData);
    items.delete(notifyId);
    ackedIds.add(notifyId);
  }

  /** [u9] 单个发送单元：一批条目（默认通道多条合批 / 其余逐条时为单条）按指定
   *  通道发送，受理成功全批标 sent，失败留 pending（账已落盘，下一边沿重试 + 重启
   *  恢复重放）。U4 ②settleRejected 桶：投递尝试被拒按事件次计数（对齐内核
   *  onSettled per-message 终态口径——批次内每条各回调一次，ext-simplify-08
   *  D1/B1），增量落日志供回归定位。 */
  function deliverBatch(channel: string, batch: NotifyLedgerItem[]): void {
    const message = mergeItems(batch);
    try {
      host.sendDelivery({ customType: channel, content: message.content, display: message.display, details: message.details });
    } catch {
      buckets.settleRejected += 1;
      emitBucketLog("settleRejected", buckets.settleRejected, { pending: batch.length });
      return;
    }
    const now = Date.now();
    for (const item of batch) {
      item.sentAt = now;
    }
  }

  function attemptDeliver(): void {
    api.attemptDeliver();
  }

  function checkReceipts(): void {
    api.checkReceipts();
  }

  /** U4 分桶日志：计数经既有 extensionLogger 通道暴露（appendEntry 落 session JSONL
   *  不进 LLM/TUI + TAIJI_AGENT_DEBUG=1 落 `<dataDir>/logs/`），替代无痕内存态。
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
  // D5）；错过边沿的回执由重启恢复重放消费（本地链路消息不丢，ADR-0112 故障模型）。
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
// dialogQueue / channelHandshake / ui-observability 同款（docs/STANDARDS.md §7.5）。
const NOTIFY_LEDGER_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.notifyLedger);

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
