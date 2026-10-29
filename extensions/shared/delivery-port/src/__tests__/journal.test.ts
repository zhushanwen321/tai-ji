// journal schema v2 定形与 v1 兼容读映射的单测锁定（设计「待验证检查点 1」，
// unified-delivery.impl-plan §0：检查点 1 → u2-delivery-port）。
// 锁定范围：① v2 outbox/ack data 字段定形与形态校验宽容度；② v1（notify 账本）
// 映射函数全字段（notifyId→id / timing / customType 通道映射 / record→details）；
// ③ 差集扫描基线（outbox 后写覆盖 / ack 双形态 / delivered details-id 双形态与
// 接受域）。schema 漂移在此红。
import { describe, expect, it } from "vitest";

import {
  ACK_CUSTOM_TYPE,
  DEFAULT_NOTIFY_CUSTOM_TYPE,
  OUTBOX_CUSTOM_TYPE,
  V1_ACK_CUSTOM_TYPE,
  V1_OUTBOX_CUSTOM_TYPE,
  collectDeliveredIds,
  extractDeliveryIds,
  mapV1OutboxData,
  readAckId,
  readOutboxDataV2,
  scanJournal,
} from "../journal.ts";

const T0 = 1_700_000_000_000;

function v2Payload(customType = DEFAULT_NOTIFY_CUSTOM_TYPE) {
	return { kind: "custom" as const, customType, content: "done: reviewer", display: true };
}

// ── ① v2 schema 定形 ────────────────────────────────────────────────────────

describe("v2 outbox data 定形（readOutboxDataV2）", () => {
	it("合法 v2 data 全字段读取（id/timing/payload/recordedAt 原样）", () => {
		const data = {
			v: 2,
			id: "wf-1:2",
			timing: "steer",
			payload: v2Payload("workflow-result"),
			recordedAt: T0,
		};
		const rec = readOutboxDataV2(data);
		expect(rec).toEqual({
			id: "wf-1:2",
			timing: "steer",
			payload: v2Payload("workflow-result"),
			recordedAt: T0,
		});
	});

	it("followUp 档合法", () => {
		expect(readOutboxDataV2({ v: 2, id: "a", timing: "followUp", payload: v2Payload(), recordedAt: T0 })?.timing).toBe(
			"followUp",
		);
	});

	// collectKey 可选字段 guard（result-collect 设计 §3.4）：合法键集读取，缺失/畸形
	// 按无键（不进类型不符分支，无键旧条目照常参与差集重放）。
	it("collectKey 合法键集原样读取", () => {
		const rec = readOutboxDataV2({ v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0, collectKey: ["k-1", "k-2"] });
		expect(rec?.collectKey).toEqual(["k-1", "k-2"]);
	});

	it.each([
		["collectKey 缺失", { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0 }],
		["collectKey 非数组", { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0, collectKey: "k-1" }],
		["collectKey 空数组", { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0, collectKey: [] }],
		["collectKey 含非 string", { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0, collectKey: ["k-1", 3] }],
		["collectKey 含空串", { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0, collectKey: ["k-1", ""] }],
	])("collectKey 缺失/畸形按无键、条目照常读取：%s", (_name, data) => {
		const rec = readOutboxDataV2(data);
		expect(rec).toBeDefined();
		expect(rec?.collectKey).toBeUndefined();
		expect(rec?.id).toBe("a");
	});

	it("ack outcome collected 识别（收取终局与 delivered 同列已完结）", () => {
		expect(readAckId({ v: 2, id: "a", outcome: "collected" })).toBe("a");
	});

	it.each([
		["缺 v 字段", { id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0 }],
		["v=1 旧形态", { v: 1, notifyId: "a", content: "c", record: {} }],
		["id 缺失", { v: 2, timing: "steer", payload: v2Payload(), recordedAt: T0 }],
		["timing 非法", { v: 2, id: "a", timing: "nextTurn", payload: v2Payload(), recordedAt: T0 }],
		["payload 非 custom kind", { v: 2, id: "a", timing: "steer", payload: { kind: "text", content: "x" }, recordedAt: T0 }],
		["payload 缺 content", { v: 2, id: "a", timing: "steer", payload: { kind: "custom", customType: "x", display: true }, recordedAt: T0 }],
		["recordedAt 缺失", { v: 2, id: "a", timing: "steer", payload: v2Payload() }],
	])("形态不符返回 undefined：%s", (_name, data) => {
		expect(readOutboxDataV2(data)).toBeUndefined();
	});
});

// ── ② v1 兼容读映射（检查点 1 锁定核心）─────────────────────────────────────

describe("v1 账本 entry 映射（mapV1OutboxData）", () => {
	it("缺省通道 v1：notifyId→id、timing=steer、customType=默认通道、record→details、display=true", () => {
		const rec = mapV1OutboxData({ v: 1, notifyId: "id-1:0", content: "body", record: { notifyId: "id-1:0", outcome: "completed" } }, T0);
		expect(rec).toEqual({
			id: "id-1:0",
			timing: "steer",
			payload: {
				kind: "custom",
				customType: DEFAULT_NOTIFY_CUSTOM_TYPE,
				content: "body",
				display: true,
				details: { notifyId: "id-1:0", outcome: "completed" },
			},
			recordedAt: T0,
		});
	});

	it("外部通道 v1（deliveryCustomType）：customType 按声明映射", () => {
		const rec = mapV1OutboxData(
			{ v: 1, notifyId: "wf-9", content: "workflow done", record: { ok: true }, deliveryCustomType: "workflow-result" },
			T0,
		);
		expect(rec?.payload.customType).toBe("workflow-result");
		expect(rec?.id).toBe("wf-9");
	});

	it.each([
		["content 非 string", { v: 1, notifyId: "a", content: 3, record: {} }],
		["record 非对象", { v: 1, notifyId: "a", content: "c", record: "x" }],
		["notifyId 缺失", { v: 1, content: "c", record: {} }],
	])("形态不符返回 undefined：%s", (_name, data) => {
		expect(mapV1OutboxData(data, T0)).toBeUndefined();
	});
});

// ── ③ ack 双形态 ────────────────────────────────────────────────────────────

describe("ack entry 读取（readAckId）", () => {
	it("v2 id 形态与 v1 notifyId 形态都识别", () => {
		expect(readAckId({ v: 2, id: "a" })).toBe("a");
		expect(readAckId({ v: 2, id: "a", outcome: "discarded" })).toBe("a");
		expect(readAckId({ v: 1, notifyId: "legacy" })).toBe("legacy");
	});
	it.each([["空对象", {}], ["未知 v", { v: 3, id: "a" }], ["空 id", { v: 2, id: "" }]])("非终局形态返回 undefined：%s", (_name, data) => {
		expect(readAckId(data)).toBeUndefined();
	});
});

// ── ④ 送达凭据提取（批展平逐条对位基元）─────────────────────────────────────

describe("deliveryId 提取（extractDeliveryIds）", () => {
	it("单条 details.deliveryId", () => {
		expect(extractDeliveryIds({ notifyId: "x", deliveryId: "dp-1" })).toEqual(["dp-1"]);
	});
	it("批形态 items[].deliveryId 逐项展平", () => {
		const details = {
			batch: true,
			items: [{ deliveryId: "a" }, { deliveryId: "b" }, { noId: true }, "junk"],
		};
		expect(extractDeliveryIds(details)).toEqual(["a", "b"]);
	});
	it("单条 + 批同存时全部收集（防御形态）", () => {
		expect(extractDeliveryIds({ deliveryId: "s", items: [{ deliveryId: "i" }] })).toEqual(["s", "i"]);
	});
	it("非对象 details 返回空", () => {
		expect(extractDeliveryIds(undefined)).toEqual([]);
		expect(extractDeliveryIds("x")).toEqual([]);
	});
});

// ── ⑤ 全量扫描基线 ─────────────────────────────────────────────────────────

describe("scanJournal 差集基线", () => {
	it("outbox/ack/delivered/channels 四面一次构建；v1/v2 混存兼容", () => {
		const entries: unknown[] = [
			// v2 存量（本端口上一实例）
			{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "dp-1", timing: "steer", payload: v2Payload(), recordedAt: T0 } },
			// v1 存量（账本退役前）
			{ type: "custom", customType: V1_OUTBOX_CUSTOM_TYPE, data: { v: 1, notifyId: "legacy-1", content: "old", record: {} } },
			// v1 外部通道存量
			{ type: "custom", customType: V1_OUTBOX_CUSTOM_TYPE, data: { v: 1, notifyId: "legacy-2", content: "wf", record: {}, deliveryCustomType: "workflow-result" } },
			// 终局列（v2 ack + v1 ack + discard）
			{ type: "custom", customType: ACK_CUSTOM_TYPE, data: { v: 2, id: "dp-1" } },
			{ type: "custom", customType: V1_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "legacy-1" } },
			// 对话记录已送达（v2 条目投出、ack 未落的强杀窗口形态）
			{ type: "custom_message", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, details: { deliveryId: "dp-1" } },
			{ type: "custom_message", customType: "workflow-result", details: { batch: true, items: [{ deliveryId: "legacy-2" }] } },
			// 无关 custom entry / 无关通道（details 撞键不收）
			{ type: "custom", customType: "other-ext", data: { x: 1 } },
			{ type: "custom_message", customType: "other-channel", details: { deliveryId: "should-not-match" } },
		];
		const scan = scanJournal(entries, T0);
		expect([...scan.outbox.keys()].sort()).toEqual(["dp-1", "legacy-1", "legacy-2"]);
		expect(scan.ackedIds).toEqual(new Set(["dp-1", "legacy-1"]));
		expect(scan.deliveredIds).toEqual(new Set(["dp-1", "legacy-2"]));
		expect(scan.channels).toEqual(new Set([DEFAULT_NOTIFY_CUSTOM_TYPE, "workflow-result"]));
		// v1 映射字段抽查（通道映射进 outbox 记录）
		expect(scan.outbox.get("legacy-2")?.payload.customType).toBe("workflow-result");
	});

	it("同 id 后写覆盖（fork 文件含同 id 多条 outbox entry 取最新）", () => {
		const entries: unknown[] = [
			{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: 1 } },
			{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "a", timing: "followUp", payload: v2Payload(), recordedAt: 2 } },
		];
		const scan = scanJournal(entries, T0);
		expect(scan.outbox.get("a")?.recordedAt).toBe(2);
		expect(scan.outbox.size).toBe(1);
	});

	it("重放差集（outbox − ack − delivered）空与非空两态", () => {
		const mk = (extra: unknown[]): Set<string> => {
			const scan = scanJournal(
				[
					{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "a", timing: "steer", payload: v2Payload(), recordedAt: T0 } },
					...extra,
				],
				T0,
			);
			const diff = new Set<string>();
			for (const id of scan.outbox.keys()) {
				if (!scan.ackedIds.has(id) && !scan.deliveredIds.has(id)) diff.add(id);
			}
			return diff;
		};
		expect(mk([])).toEqual(new Set(["a"]));
		expect(mk([{ type: "custom", customType: ACK_CUSTOM_TYPE, data: { v: 2, id: "a" } }])).toEqual(new Set());
		expect(mk([{ type: "custom_message", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, details: { deliveryId: "a" } }])).toEqual(new Set());
	});
});

// ── ⑥ collectDeliveredIds 接受域 ───────────────────────────────────────────

describe("collectDeliveredIds 接受域", () => {
	it("域外通道的 details.deliveryId 不收集（防撞键误判）", () => {
		const entries = [
			{ type: "custom_message", customType: "stray", details: { deliveryId: "a" } },
			{ type: "custom_message", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, details: { deliveryId: "b" } },
		];
		const delivered = collectDeliveredIds(entries, new Set([DEFAULT_NOTIFY_CUSTOM_TYPE]));
		expect(delivered).toEqual(new Set(["b"]));
	});
});
