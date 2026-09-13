// src/__tests__/list-fields.test.ts
//
// [v4 A-6] recordToListItem 字段派生单测；[U3 C-outcome] closedReason 改锚 outcome。
//
// 验证 list 输出的字段派生正确：
//   - parent：从 record.parentRecordId 派生（顶层 record → undefined）
//   - resumable：从 isResumable 派生（running && 无活进程句柄）
//   - outcome：一等终态语义（projectOutcome 唯一出口）；closedReason 退出对外 JSON，
//     存量/重建 record（无 outcome 字段）由 deriveOutcome(closedReason, error) 兜底
//
// Mock 策略：vi.mock lifecycle-predicates 的 isResumable，控制其返回值模拟「有/无
// 活进程句柄」两种 running 子态。isResumable 真实逻辑（running && !hasLiveProcessHandle）
// 由 lifecycle-predicates.test.ts 覆盖；本测试聚焦 recordToListItem 的字段派生与透传。

import { describe, expect, it, vi } from "vitest";

// mock lifecycle-predicates：控制 isResumable 返回值。
// recordToListItem 内部 import 的 isResumable 经 vitest 自动接线拿到此 mock 版本。
vi.mock( "@zhushanwen/subagent-core/execution/lifecycle/lifecycle-predicates.ts", () => ({
	isResumable: vi.fn(),
}));

import { recordToListItem } from "../interface/subagent-actions.ts";
import { isResumable } from "@zhushanwen/subagent-core";
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

describe("recordToListItem — parent/resumable (v4 A-6)", () => {
	// ═══ parent：从 record.parentRecordId 派生 ═══

	it("parent：嵌套 record（parentRecordId='sa-A'）→ parent='sa-A'", () => {
		const rec = makeRecord({ parentRecordId: "sa-A" });
		expect(recordToListItem(rec).parent).toBe("sa-A");
	});

	it("parent：根层 record（parentRecordId=undefined）→ parent=undefined", () => {
		const rec = makeRecord({ parentRecordId: undefined });
		expect(recordToListItem(rec).parent).toBeUndefined();
	});

	// ═══ resumable：isResumable 透传（mock 模拟有/无活进程句柄） ═══

	it("resumable：running + 无活进程句柄（isResumable=true）→ true（B-1 续聊态）", () => {
		vi.mocked(isResumable).mockReturnValue(true);
		const rec = makeRecord({ status: "running" });
		expect(recordToListItem(rec).resumable).toBe(true);
	});

	it("resumable：running + 有活进程句柄（isResumable=false）→ false（正在执行）", () => {
		vi.mocked(isResumable).mockReturnValue(false);
		const rec = makeRecord({ status: "running" });
		expect(recordToListItem(rec).resumable).toBe(false);
	});

	it("resumable：已收口（idle+closedReason 桥接形态，isResumable=false）→ false", () => {
		vi.mocked(isResumable).mockReturnValue(false);
		const rec = makeRecord({ status: "idle", closedReason: "gc" });
		expect(recordToListItem(rec).resumable).toBe(false);
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
