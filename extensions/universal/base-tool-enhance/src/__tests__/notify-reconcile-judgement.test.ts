// src/__tests__/notify-reconcile-judgement.test.ts —— 补投判据纯函数（设计 §5 U1）：
// ① collectDeliveredTaskIds 五形态（正常消息/fork 副本/缺 details 旧消息/非 bash
// 通知/killed 无痕迹任务）+ content 双落盘形态容错；② 补投标记 entry 读写形态
// （customType background-bash:reconciled，data {taskId, reconciledAt}）
import { describe, expect, it } from "vitest";

import { BACKGROUND_BASH_CUSTOM_TYPE } from "../background/notify.ts";
import {
	buildReconciledMarkerData,
	collectDeliveredTaskIds,
	collectReconciledTaskIds,
	RECONCILED_MARKER_CUSTOM_TYPE,
} from "../background/notify-reconcile-judgement.ts";

const TASK_ID = "bt-1700000000-abcd12";
const OTHER_TASK_ID = "bt-1700000000-efgh34";

/** 送达消息 entry（pi CustomMessageEntry 落盘形态：type=custom_message + customType）。 */
function deliveredEntry(overrides: {
	taskId?: string;
	details?: unknown;
	content?: unknown;
	customType?: string;
} = {}): Record<string, unknown> {
	const taskId = overrides.taskId ?? TASK_ID;
	return {
		type: "custom_message",
		customType: overrides.customType ?? BACKGROUND_BASH_CUSTOM_TYPE,
		content: overrides.content ?? `[background-bash] ${taskId} finished (exit 0, 3m12s): pnpm test\nFull output: /tmp/out/${taskId}.log`,
		details: "details" in overrides ? overrides.details : { taskId, endReason: "natural", exitCode: 0 },
		display: true,
	};
}

describe("collectDeliveredTaskIds: five entry shapes (design §5 U1)", () => {
	it("normal delivered message: hits via details.taskId and content both", () => {
		const ids = collectDeliveredTaskIds([deliveredEntry()]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("fork copy (same shape carried into the forked session): hits identically", () => {
		// fork 复制 session 文件时送达消息原样带走——同形态命中是决策 5 的构造性来源
		const ids = collectDeliveredTaskIds([
			{ type: "user", content: "hello" }, // fork 前的旧消息
			deliveredEntry(), // 复制带来的送达消息
			{ type: "user", content: "after fork" },
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("legacy message without details: hits via content token alone", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry({ details: undefined }),
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("non-bash notification (different customType, content mentions bt- token): does NOT hit", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry({ customType: "subagent-bg-notify" }),
			deliveredEntry({ customType: "background-bash:reconciled", details: undefined }),
		]);
		expect(ids.size).toBe(0);
	});

	it("killed task with no delivery message: naturally absent (empty entries side)", () => {
		// kill 路径不产通知（notify.ts 单点归属规则）——entries 无该任务消息，集合不含它，
		// 补投判据的排除由 registry reason=killed 承担（执行器侧用例），此处锁定痕迹面为空
		const ids = collectDeliveredTaskIds([
			deliveredEntry(), // 只有别的任务的送达消息
			{ type: "custom", customType: "pending:unregister", data: { id: OTHER_TASK_ID, reason: "cancelled" } },
		]);
		expect(ids.has(TASK_ID)).toBe(true);
		expect(ids.has(OTHER_TASK_ID)).toBe(false);
	});
});

describe("collectDeliveredTaskIds: content落盘形态与脏数据容错", () => {
	it("TextContent[] content form (appendCustomMessageEntry accepts arrays) hits via text blocks", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry({
				details: undefined,
				content: [{ type: "text", text: `[background-bash] ${TASK_ID} finished (exit 0, 5s): pnpm test` }],
			}),
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("malformed entries (null / primitives / wrong field types) are skipped, not fatal", () => {
		const ids = collectDeliveredTaskIds([
			null,
			undefined,
			42,
			"custom_message",
			{ customType: BACKGROUND_BASH_CUSTOM_TYPE }, // content/details 均缺
			{ customType: BACKGROUND_BASH_CUSTOM_TYPE, content: 123, details: "no" },
			deliveredEntry({ details: { taskId: 42 } }), // details.taskId 非字符串 → 只剩 content 通道
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("multiple messages across tasks collect all ids", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry(),
			deliveredEntry({ taskId: OTHER_TASK_ID, details: undefined }),
		]);
		expect([...ids].sort()).toEqual([TASK_ID, OTHER_TASK_ID].sort());
	});
});

describe("reconciled marker entry: write/read shape contract (design decision 1)", () => {
	it("buildReconciledMarkerData produces {taskId, reconciledAt}", () => {
		expect(buildReconciledMarkerData(TASK_ID, 1_700_000_000_000)).toEqual({
			taskId: TASK_ID,
			reconciledAt: 1_700_000_000_000,
		});
	});

	it("marker customType is the plain-entry channel, distinct from the delivery customType", () => {
		// 通道纪律：账务走 plain custom entry（appendEntry），送达消息走 sendMessage——
		// 两者 customType 不得混用（NotifyLedger 同款纪律）
		expect(RECONCILED_MARKER_CUSTOM_TYPE).toBe("background-bash:reconciled");
		expect(RECONCILED_MARKER_CUSTOM_TYPE).not.toBe(BACKGROUND_BASH_CUSTOM_TYPE);
	});

	it("collectReconciledTaskIds picks marker entries and tolerates malformed data", () => {
		const ids = collectReconciledTaskIds([
			{ type: "custom", customType: RECONCILED_MARKER_CUSTOM_TYPE, data: { taskId: TASK_ID, reconciledAt: 1 } },
			{ type: "custom", customType: RECONCILED_MARKER_CUSTOM_TYPE }, // data 缺失
			{ type: "custom", customType: RECONCILED_MARKER_CUSTOM_TYPE, data: { reconciledAt: 2 } }, // taskId 缺
			{ type: "custom", customType: RECONCILED_MARKER_CUSTOM_TYPE, data: { taskId: 42 } }, // 非字符串
			{ type: "custom_message", customType: RECONCILED_MARKER_CUSTOM_TYPE, data: { taskId: OTHER_TASK_ID } }, // 误入消息通道的形态仍按 data 读
			deliveredEntry(), // 送达消息不是标记
			null,
			7,
		]);
		expect([...ids].sort()).toEqual([TASK_ID, OTHER_TASK_ID].sort());
	});

	it("delivered and reconciled collectors partition the two anchors without cross-talk", () => {
		const entries = [
			deliveredEntry(), // TASK_ID 送达痕迹在
			{ type: "custom", customType: RECONCILED_MARKER_CUSTOM_TYPE, data: { taskId: OTHER_TASK_ID, reconciledAt: 1 } },
		];
		expect(collectDeliveredTaskIds(entries).has(OTHER_TASK_ID)).toBe(false);
		expect(collectReconciledTaskIds(entries).has(TASK_ID)).toBe(false);
	});
});
