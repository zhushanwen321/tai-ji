// src/journal.ts
//
// 投递日志（delivery journal，设计 §3.3 词条 / §3.7 耐久面行）的 entry schema 与
// 扫描/映射函数。schema 定形与 v1 兼容读映射 = 设计「待验证检查点 1」（unified-
// delivery §7）落点，由 src/__tests__/journal.test.ts 单测锁定。
//
// 介质 = session entries（pi 进程内 appendEntry plain entry，不进 LLM 上下文——
// 通道分工纪律与账本 D4 同源：ADR-0062 session JSONL 唯一写方 = pi 进程，runtime
// 无法代写；append-only 契约 = 写入即不可改删，compaction 只追加边界 entry，
// getEntries 全量读取不受影响——设计 §3.8 正交性段）。
//
// 差集口径（重放与判重共用）：未投递 = outbox − (ack ∪ delivered)；
//   - ack = 终局 entry（delivered / discarded 同列——discard 在 append-only 介质
//     下不可无痕删除，以 outcome 字段落终局列，重放差集同判）；
//   - delivered = 对话记录中出现 details 携带该 id 的通知条目（'details-id' 送达
//     凭据，§3.3 送达凭据词条）——单条形态 details.deliveryId / 批形态
//     details.items[].deliveryId 逐项展平命中。
//
// v1 存量（notify 账本，波 2 后半退役）：ledger / ack 两列 entry 兼容读，
// notifyId 映射 id（任务书目标 3），恢复重放零迁移（读侧映射，存量 entry 零改写）。

import { SUBAGENT_BG_NOTIFY_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
import type { CustomPayload } from "@zhushanwen/session-delivery";

import type { DeliveryTiming } from "./types.ts";

/** v2 outbox entry customType（plain entry，不进 LLM 上下文）。 */
export const OUTBOX_CUSTOM_TYPE = "delivery-port-outbox";
/** v2 ack / discard 终局 entry customType（plain entry）。 */
export const ACK_CUSTOM_TYPE = "delivery-port-ack";

/** v1 存量（notify 账本）outbox entry customType——重放扫描兼容读。 */
export const V1_OUTBOX_CUSTOM_TYPE = "subagent-bg-notify-ledger";
/** v1 存量（notify 账本）ack entry customType——重放扫描兼容读。 */
export const V1_ACK_CUSTOM_TYPE = "subagent-bg-notify-ack";

/** entry data schema 版本字面量（v1 = 账本存量形态 / v2 = 本端口定形）。 */
const SCHEMA_V1 = 1;
const SCHEMA_V2 = 2;

/** 默认投递通道（notify 词表单源 = extension-protocol SUBAGENT_BG_NOTIFY_CUSTOM_TYPE）。 */
export const DEFAULT_NOTIFY_CUSTOM_TYPE: string = SUBAGENT_BG_NOTIFY_CUSTOM_TYPE;

// ─── entry data schema ──────────────────────────────────────

/** v1 outbox entry data（存量格式：统一投递前旧通知账本的 outbox entry 原样，兼容读用；原 schema 见 git 历史）。 */
export interface OutboxEntryDataV1 { // oe-exempt:20261017:framework:投递日志 entry schema v1（账本存量 session 兼容读，append-only 永存）
  v: typeof SCHEMA_V1;
  notifyId: string;
  /** 预格式化通知正文（重放原样投递）。 */
  content: string;
  /** details record（对 journal 不透明，透传给注入 details）。 */
  record: object;
  /** v1 送达通道（缺省 = DEFAULT_NOTIFY_CUSTOM_TYPE 旧格式）。 */
  deliveryCustomType?: string;
}

/**
 * v2 outbox entry data（待验证检查点 1 定形；设计 §3.7 耐久面行字段集）。
 * payload 为调用方业务原样（不含 deliveryId——凭据 id 由端口在注入前统一写入
 * details，重放重投时同样注入；journal 记录保持业务原样使记录与注入形态解耦）。
 */
export interface OutboxEntryDataV2 { // oe-exempt:20261017:framework:投递日志 entry schema v2（现行形态，版本化兼容读族）
  v: typeof SCHEMA_V2;
  /** 幂等键（v1 notifyId 的 v2 位）。 */
  id: string;
  /** 期望注入时机（重放按原档重报）。 */
  timing: DeliveryTiming;
  /** custom 载荷（调用方原样）。 */
  payload: CustomPayload;
  /** 落账时间（epoch ms）。 */
  recordedAt: number;
}

/**
 * v2 终局 entry data：ack（delivered / cancelled 终局）与 discard（forget 失败条目
 * 的持久标记——append-only 介质下与 ack 同列承载，重放差集同判「不再重投」）。
 * outcome 缺省 = "delivered"（ack 主形态，字段缺省省体积）。
 */
export interface AckEntryDataV2 { // oe-exempt:20261017:framework:回执 entry schema v2（现行形态，版本化兼容读族）
  v: typeof SCHEMA_V2;
  id: string;
  outcome?: "delivered" | "discarded";
}

/** v1 ack entry data（存量格式：旧通知账本的 ack entry 原样，兼容读用；原 schema 见 git 历史）。 */
export interface AckEntryDataV1 { // oe-exempt:20261017:framework:回执 entry schema v1（账本存量兼容读，append-only 永存）
  v: typeof SCHEMA_V1;
  notifyId: string;
}

// ─── journal 记录（内存投影）─────────────────────────────────

/**
 * 投递日志一条记录的内存投影（outbox entry 的运行时形态，重放重投的重建源）。
 * 与 OutboxEntryDataV2 字段一一对应（v1 经 mapV1OutboxData 映射进同一形态）。
 */
export interface JournalRecord { // oe-exempt:20261017:framework:投递日志记录契约（DeliveryStore persist 载荷）
  id: string;
  timing: DeliveryTiming;
  payload: CustomPayload;
  recordedAt: number;
}

/** 扫描结果（构造期全量 + 运行时增量维护的基线形态）。 */
export interface JournalScan { // oe-exempt:20261017:framework:投递日志差集扫描契约（session_start 重放面）
  /** outbox 记录（id → record；后写覆盖——同 id 多条 entry 取最新）。 */
  outbox: Map<string, JournalRecord>;
  /** 终局 id（ack ∪ discard）。 */
  ackedIds: Set<string>;
  /** 对话记录已送达 id（details-id 凭据命中）。 */
  deliveredIds: Set<string>;
  /** 回执接受域通道（默认通道 ∪ journal 中出现过的通道——持久化的接受域形态）。 */
  channels: Set<string>;
}

// ─── 运行时 guard ───────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── v1 → journal 映射（检查点 1 锁定点）────────────────────

/**
 * v1 账本 entry → journal 记录映射：
 * - id = notifyId（任务书目标 3「notifyId 映射 id」）；
 * - timing = "steer"（v1 投递恒 sendMessage({triggerTurn:true}) 无 deliverAs——
 *   pi sendCustomMessage 的忙时分支即 steer 队列（agent-session.js:1762-1768），
 *   语义等价 steer 档）；
 * - payload = { kind:"custom", customType: deliveryCustomType ?? 默认通道,
 *   content, display:true, details: record }（单条消息形态回构）；
 * - recordedAt = 扫描时点（v1 无落账时点字段，重放只用于展示与排序，取扫描时点）。
 *
 * 字段形态不符（content 非 string / record 非对象）返回 undefined（该 entry 视为
 * 噪音跳过，不抛——重放扫描对存量脏数据宽容，对齐账本扫描的逐条 guard 形态）。
 */
export function mapV1OutboxData(data: unknown, scannedAt: number): JournalRecord | undefined {
  if (!isPlainObject(data) || data["v"] !== SCHEMA_V1) return undefined;
  const notifyId = data["notifyId"];
  const content = data["content"];
  const record = data["record"];
  if (typeof notifyId !== "string" || notifyId === "") return undefined;
  if (typeof content !== "string" || !isPlainObject(record)) return undefined;
  const deliveryCustomType = data["deliveryCustomType"];
  return {
    id: notifyId,
    timing: "steer",
    payload: {
      kind: "custom",
      customType:
        typeof deliveryCustomType === "string" && deliveryCustomType !== ""
          ? deliveryCustomType
          : DEFAULT_NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
      details: record,
    },
    recordedAt: scannedAt,
  };
}

/** v2 outbox entry → journal 记录（字段形态不符返回 undefined，同 v1 宽容口径）。 */
export function readOutboxDataV2(data: unknown): JournalRecord | undefined {
  if (!isPlainObject(data) || data["v"] !== SCHEMA_V2) return undefined;
  const id = data["id"];
  const timing = data["timing"];
  const payload = data["payload"];
  const recordedAt = data["recordedAt"];
  if (typeof id !== "string" || id === "") return undefined;
  if (timing !== "steer" && timing !== "followUp") return undefined;
  if (!isPlainObject(payload)) return undefined;
  const customType = payload["customType"];
  const content = payload["content"];
  const display = payload["display"];
  if (typeof customType !== "string" || typeof content !== "string" || typeof display !== "boolean") {
    return undefined;
  }
  if (typeof recordedAt !== "number") return undefined;
  return {
    id,
    timing,
    recordedAt,
    payload: {
      kind: "custom",
      customType,
      content,
      display,
      ...(payload["details"] !== undefined ? { details: payload["details"] } : {}),
    },
  };
}

/** ack/discard entry → 终局 id（v1 notifyId / v2 id 双形态；非终局 entry 返回 undefined）。 */
export function readAckId(data: unknown): string | undefined {
  if (!isPlainObject(data)) return undefined;
  if (data["v"] === SCHEMA_V2) {
    const id = data["id"];
    return typeof id === "string" && id !== "" ? id : undefined;
  }
  if (data["v"] === SCHEMA_V1) {
    const notifyId = data["notifyId"];
    return typeof notifyId === "string" && notifyId !== "" ? notifyId : undefined;
  }
  return undefined;
}

// ─── 送达凭据扫描（'details-id'）────────────────────────────

/**
 * 从注入消息 details 提取送达凭据 id 集（单条 details.deliveryId + 批形态
 * details.items[].deliveryId 逐项展平——「批展平逐条对位」的判定基元）。
 */
export function extractDeliveryIds(details: unknown): string[] {
  if (!isPlainObject(details)) return [];
  const ids: string[] = [];
  const single = details["deliveryId"];
  if (typeof single === "string" && single !== "") ids.push(single);
  const items = details["items"];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (isPlainObject(item)) {
        const id = item["deliveryId"];
        if (typeof id === "string" && id !== "") ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * 扫对话记录，收集 channels 接受域内已送达（custom_message entry 出现 details
 * 携带该 id）的通知 id。接受域防无关 custom_message 的 details 撞键误判。
 * entries 形态 = ctx.sessionManager.getEntries()（custom_message entry：
 * { type:"custom_message", customType, details }）。
 */
export function collectDeliveredIds(
  entries: readonly unknown[],
  channels: ReadonlySet<string>,
): Set<string> {
  const delivered = new Set<string>();
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry["type"] !== "custom_message") continue;
    const customType = entry["customType"];
    if (typeof customType !== "string" || !channels.has(customType)) continue;
    for (const id of extractDeliveryIds(entry["details"])) {
      delivered.add(id);
    }
  }
  return delivered;
}

// ─── 全量扫描（构造期 / 重放基线）───────────────────────────

/**
 * 全量扫描当前 session entries 构建投递日志基线（port 构造期一次；运行时增量由
 * createDeliveryPort 的 JournalState 维护，不重扫——session 替换 = 新实例重新装配
 * 重新扫描）。channels 从 outbox 记录的通道集现算并并入默认通道。
 */
export function scanJournal(entries: readonly unknown[], scannedAt: number): JournalScan {
  const outbox = new Map<string, JournalRecord>();
  const ackedIds = new Set<string>();
  const channels = new Set<string>([DEFAULT_NOTIFY_CUSTOM_TYPE]);
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (entry["type"] !== "custom") continue;
    const customType = entry["customType"];
    const data = entry["data"];
    if (customType === OUTBOX_CUSTOM_TYPE) {
      const rec = readOutboxDataV2(data);
      if (rec) {
        outbox.set(rec.id, rec);
        channels.add(rec.payload.customType);
      }
    } else if (customType === V1_OUTBOX_CUSTOM_TYPE) {
      const rec = mapV1OutboxData(data, scannedAt);
      if (rec) {
        outbox.set(rec.id, rec);
        channels.add(rec.payload.customType);
      }
    } else if (customType === ACK_CUSTOM_TYPE || customType === V1_ACK_CUSTOM_TYPE) {
      const id = readAckId(data);
      if (id !== undefined) ackedIds.add(id);
    }
  }
  const deliveredIds = collectDeliveredIds(entries, channels);
  return { outbox, ackedIds, deliveredIds, channels };
}
