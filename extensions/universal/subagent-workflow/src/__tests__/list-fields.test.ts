// src/__tests__/list-fields.test.ts
//
// [v4 A-6] recordToListItem 字段派生单测；[U3 C-outcome] closedReason 改锚 outcome。
//
// 验证 list 输出的字段派生正确：
//   - parent：从 record.parentRecordId 派生（顶层 record → undefined）
//   - outcome：一等终态语义（projectOutcome 唯一出口）；closedReason 退出对外 JSON，
//     存量/重建 record（无 outcome 字段）由 deriveOutcome(closedReason, error) 兜底
//
// [two-state-convergence U5/D4] resumable 字段已从 SubagentListItem 退役（idle 即
// resumable——state 主字段已并存表达可续聊），相关派生单测随字段删除。

import { describe, expect, it } from "vitest";

import { recordToListItem } from "../interface/subagent-actions.ts";
import type { SubagentRecord } from "@zhushanwen/subagent-core";

// ── SubagentRecord stub 工厂（最小合法 record） ──

function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "sa-test",
		agent: "general-purpose",
		task: "test task",
		slug: "test-slug",
		status: "running",
		mode: "background",
		startedAt: Date.now(),
		rootSessionId: "session-main",
		parentRecordId: undefined,
		depth: 0,
		endedAt: undefined,
		turns: 0,
		totalTokens: 0,
		model: "test/model",
		thinkingLevel: undefined,
		eventLog: [],
		displayItems: [],
		result: undefined,
		error: undefined,
		sessionFile: undefined,
		...over,
	};
}

describe("recordToListItem — parent/outcome (v4 A-6 + U3 C-outcome)", () => {
	// ═══ parent：从 record.parentRecordId 派生 ═══

	it("parent：嵌套 record（parentRecordId='sa-A'）→ parent='sa-A'", () => {
		const rec = makeRecord({ parentRecordId: "sa-A" });
		expect(recordToListItem(rec).parent).toBe("sa-A");
	});

	it("parent：根层 record（parentRecordId=undefined）→ parent=undefined", () => {
		const rec = makeRecord({ parentRecordId: undefined });
		expect(recordToListItem(rec).parent).toBeUndefined();
	});

	// ═══ resumable 字段退役断言（[U5/D4]）：list JSON 不再携带该键 ═══

	it("resumable 字段已退役：list item 不携带（idle 即 resumable，state 主字段承载）", () => {
		const rec = makeRecord({ status: "idle" });
		const item = recordToListItem(rec);
		expect("resumable" in item).toBe(false);
		const parsed = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
		expect("resumable" in parsed).toBe(false);
	});

	// ═══ outcome：一等终态披露（U3 C-outcome，projectOutcome 唯一出口）═══

	it("outcome：closed + closedReason='parent-fork' + 合成 error → 'failed'（D6 显式取舍：父进程关闭未完成即失败，勿改 cancelled）", () => {
		const rec = makeRecord({
			status: "idle",
			closedReason: "parent-fork",
			error: "closed due to parent-fork",
		});
		expect(recordToListItem(rec).outcome).toBe("failed");
	});

	it("outcome：closed + closedReason='cancelled' → 'cancelled'（取消优先于 error）", () => {
		const rec = makeRecord({
			status: "idle",
			closedReason: "cancelled",
			error: "aborted",
		});
		expect(recordToListItem(rec).outcome).toBe("cancelled");
	});

	it("outcome：closed + gc 正常完成（存量形态，无 outcome 字段、无 error）→ 兑底派生 'completed'", () => {
		const rec = makeRecord({ status: "idle", closedReason: "gc" });
		expect(recordToListItem(rec).outcome).toBe("completed");
	});

	it("outcome：closed + gc + error（存量失败形态）→ 兑底派生 'failed'", () => {
		const rec = makeRecord({ status: "idle", closedReason: "gc", error: "spawn EPIPE" });
		expect(recordToListItem(rec).outcome).toBe("failed");
	});

	it("outcome：一等字段存在时直读透传（不重推导）", () => {
		const rec = makeRecord({ status: "idle", outcome: "failed", closedReason: "gc" });
		expect(recordToListItem(rec).outcome).toBe("failed");
	});

	it("outcome：running record → undefined（终态语义不适用活跃态）", () => {
		const rec = makeRecord({ status: "running" });
		expect(recordToListItem(rec).outcome).toBeUndefined();
	});

	it("closedReason 退出对外 JSON：list item 不再携带（内部诊断字段），outcome 字段在位", () => {
		const rec = makeRecord({ status: "idle", closedReason: "gc", error: "boom" });
		const item = recordToListItem(rec);
		expect("closedReason" in item).toBe(false);
		const parsed = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
		expect("closedReason" in parsed).toBe(false);
		expect(parsed.outcome).toBe("failed");
		// 旧字段保留（向后兼容）
		expect(parsed.status).toBe("idle");
		expect(parsed.state).toBe("idle");
		expect(parsed.mode).toBe("background");
	});
});
