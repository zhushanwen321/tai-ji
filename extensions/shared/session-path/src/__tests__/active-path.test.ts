/**
 * filterActivePath 单测——四包（todo/plan/goal/scheduler）收编后的单一实现。
 * 覆盖：分支裁剪 / 无分支回归 / leafId 防御回退 / 统一后的回退取值口径（无 id
 * 尾条目）/ legacy 线性 fixture / 环状 parentId 防挂死。
 */
import { describe, expect, it } from "vitest";

import { filterActivePath, type ActivePathSessionView } from "../index";

interface BranchEntry { // oe-exempt:20261001:test:测试 fixture 形状契约（分支树 entry 最小形状，断言面消费）
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
}

function entry(id: string, parentId: string | null, customType = "x"): BranchEntry {
	return { type: "custom", id, parentId, customType, data: {} };
}

/** 撤回后真实形态：label entry 落文件尾（parentId = 回退后叶子） */
function labelEntry(id: string, parentId: string | null): BranchEntry {
	return { type: "label", id, parentId, targetId: "u-x", label: "taiji:revoked" };
}

function makeView(
	entries: Array<Record<string, unknown>>,
	leafId?: string | null,
): ActivePathSessionView<Record<string, unknown>> {
	return {
		getEntries: () => entries.slice(),
		getLeafId: leafId === undefined ? undefined : () => leafId,
	};
}

const idsOf = (entries: Array<Record<string, unknown>>): unknown[] =>
	entries.map((e) => e["id"]);

describe("filterActivePath（活跃路径裁剪单一实现）", () => {
	it("有分支 fixture：被撤子树不进输出——活跃路径 = leafId 沿 parentId 回溯", () => {
		// 树：e1 → e2(active)；e1 → e3(revoked，物理后写)；撤回落 label 锚 L（parentId=e2）
		const view = makeView([
			entry("e1", null),
			entry("e2", "e1", "active"),
			entry("e3", "e1", "revoked"),
			labelEntry("L", "e2"),
		], "L");

		expect(idsOf(filterActivePath(view))).toEqual(["e1", "e2", "L"]);
	});

	it("无分支回归：leafId = 文件尾 → 全量保留（现行为不变）", () => {
		const view = makeView([entry("e1", null), entry("e2", "e1")], "e2");

		expect(idsOf(filterActivePath(view))).toEqual(["e1", "e2"]);
	});

	it("leafId 防御：null / 指向不存在 entry / 视图不携带 getLeafId → 回退文件尾", () => {
		const entries = [entry("e1", null), entry("e2", "e1")];
		for (const leafId of [null, "missing-id", undefined]) {
			const clipped = filterActivePath(makeView(entries, leafId));
			expect(idsOf(clipped)).toEqual(["e1", "e2"]);
		}
	});

	it("统一回退取值口径：尾条目无 string id → 回退叶子 = 最后一条带 id 的条目，无 id 尾条目保留在输出", () => {
		// 收编前分叉点：plan/todo 取数组尾（无 id 条目）、goal/scheduler 取最后一条
		// 带 id 条目。统一为后者——回溯需要 id 锚点；无 id 条目按线性文件语义保留。
		const view = makeView([
			entry("e1", null, "id-having"),
			{ type: "custom", customType: "id-less-tail", data: {} },
		], null);

		const clipped = filterActivePath(view);
		expect(clipped).toHaveLength(2);
		expect(clipped[1]).toMatchObject({ customType: "id-less-tail" });
	});

	it("legacy fixture：全文件无 string id（线性最小形状）→ 不过滤，保持裁剪前行为", () => {
		const view: ActivePathSessionView<Record<string, unknown>> = {
			getEntries: () => [
				{ type: "custom", customType: "a", data: {} },
				{ type: "custom", customType: "b", data: {} },
			],
		};

		expect(filterActivePath(view)).toHaveLength(2);
	});

	it("环状 parentId（a↔b，leafId 指向环内）→ 回溯终止不挂死", () => {
		const view = makeView([entry("a", "b"), entry("b", "a")], "a");

		expect(new Set(idsOf(filterActivePath(view))).size).toBeGreaterThan(0);
	});

	it("空 entries → 原样返回空数组", () => {
		expect(filterActivePath(makeView([], "x"))).toEqual([]);
	});
});
