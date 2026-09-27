/**
 * subagent-actions adapter + BG_MESSAGE + tool description 强化测试（FR-4/FR-5/FR-6/AC-4）。
 *
 * 修复目标：阻止 LLM 在 subagent 完成后继续轮询 subagent_list。三处冗余强化：
 *   1. adapter list action 返回 content 追加 reminder text block（每次 list 都看到）
 *   2. BG_MESSAGE 常量强化（启动时一次）
 *   3. tool description 强化（schema 阶段）
 *
 * 测试覆盖：adapter list 返回 content 数组含 reminder；BG_MESSAGE 字符串含
 * 'auto-injected' 关键词；description 源码含 'auto-injected'/'do not poll' 关键词。
 *
 * adapter import 不依赖 pi SDK（纯函数），可直接调用。description 测试用源码断言
 * （与 subagent-tool-prompt.test.ts 一致策略）；BG_MESSAGE [D6②] 权威源下沉 core
 * 后改为运行时断言（core 侧另有精确值快照）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ListHandlerResult, StartHandlerResult } from "@zhushanwen/subagent-core";
import { adapter } from "../interface/subagent-actions.ts";
import { BG_MESSAGE } from "@zhushanwen/subagent-core/execution/assembly/subagent-actions-core.ts";

// ── adapter reminder test fixtures ──

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUBAGENT_TOOL_SRC = readFileSync(
	join(__dirname, "../interface/subagent-tool.ts"),
	"utf-8",
);

/** 构造一个空 list domain object（adapter 需要 listResponse 字段）。 */
function emptyListResult(): ListHandlerResult {
	return { response: { running: 0, items: [] } };
}

/** 构造一个 running list domain object（adapter 需要 listResponse 字段）。 */
function runningListResult(running: number, count: number): ListHandlerResult {
	const items = Array.from({ length: count }, (_, i) => ({
		subagentId: `bg-${i}`,
		agent: "worker",
		slug: `task-${i}`,
		status: "running" as const,
		mode: "background" as const,
		duration: 0,
		model: "m",
		totalTokens: 0,
		sessionFile: undefined,
	}));
	return { response: { running, items } };
}

/** 构造一个 start domain object（负断言用：start 无 reminder）。 */
function startResult(): StartHandlerResult {
	return {
		kind: "bg",
		subagentId: "bg-0",
		sessionFile: undefined,
		slug: "task-0",
		model: undefined,
		response: { status: "running", mode: "background", message: BG_MESSAGE },
	};
}

describe("subagent-actions adapter list action reminder (FR-4/AC-4)", () => {
	it("list action 返回 content 是数组且第二个 text block 含 'auto-notif' 关键词", () => {
		// 模拟 service 调用 listHandler（不依赖 service 实例，构造 domain object 直接喂 adapter）
		const result = adapter({ action: "list", domain: emptyListResult() });

		// content 是数组（保证 reminder 不破坏 JSON 结构）
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content.length).toBeGreaterThanOrEqual(2);

		// 第二个 text block 是 reminder
		const reminderBlock = result.content[1];
		expect(reminderBlock.type).toBe("text");
		expect((reminderBlock as { text: string }).text).toMatch(/auto-notif|do not poll/i);
	});

	it("running list 同样带 reminder（与空 list 行为一致）", () => {
		const result = adapter({ action: "list", domain: runningListResult(2, 2) });

		expect(result.content.length).toBeGreaterThanOrEqual(2);
		expect((result.content[1] as { text: string }).text).toMatch(/auto-notif|do not poll/i);
	});
});

// ── list reminder 全文锚定（LLM 直接消费文本锁，第四轮架构审查 Strong 项）──

describe("list reminder 全文锚定", () => {
	// 上方 reminder describe 只断言关键词——重构/顺手清理改写全文不会红。本 describe
	// 逐字锁 LLM 看到的第二个 text block（期望值从 subagent-actions.ts 实现逐字复制）。

	it("list action 第二个 text block 逐字等于 reminder 全文（含前导 \\n\\n）", () => {
		const result = adapter({ action: "list", domain: emptyListResult() });

		expect(result.content).toHaveLength(2);
		expect(result.content[1]).toEqual({
			type: "text",
			text: "\n\nReminder: Subagent completion is auto-notified via auto-injected message (turn-triggering on idle). DO NOT bash sleep or poll in a loop — there is no poll action. Use action:'list' only when you concretely need state, then continue working or stop.",
		});
	});

	it("start action 无 reminder：第二个 text block 为空串（实现是空串形态，非省略 block）", () => {
		// start 的防轮询提醒在 BG_MESSAGE 里（response.message），list 专属 reminder
		// 不追加——content 恒两个 text block，非 list action 第二个为空串。
		const result = adapter({ action: "start", domain: startResult() });

		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("text");
		expect((result.content[1] as { text: string }).text).toBe("");
	});
});

describe("BG_MESSAGE 强化 (FR-5)", () => {
	it("BG_MESSAGE 字符串含 'auto-injected' 或 'do not poll' 关键词", () => {
		// [B9] 防回退守护测试：BG_MESSAGE 不被误改/弱化（如有人删掉 'auto-injected'
		// 提示词）。[D6②] 常量权威源已随领域内核下沉 core subagent-actions-core
		//（原为读 subagent-actions.ts 源码文本提取，实现位置迁移后改运行时断言——
		// 行为等值，core 侧另有精确值快照）。运行时行为由 adapter list reminder 测试覆盖。
		expect(BG_MESSAGE).toMatch(/auto-injected|do not poll/i);
	});
});

describe("subagent tool description 强化 (FR-6)", () => {
	/** 提取 description: `...` 模板字符串的原始内容。 */
	function extractDescription(src: string): string {
		const m = src.match(/description:\s*`([\s\S]*?)`,/);
		if (!m) throw new Error("description template literal not found");
		return m[1];
	}

	it("description 'do NOT wait' 段含 'auto-injected' 关键词", () => {
		// [B9] 防回退守护测试：验证源码 description 模板字符串常量不被误改，非运行时行为断言。
		const description = extractDescription(SUBAGENT_TOOL_SRC);
		// 定位 "After launching" 段（section header）
		const idx = description.indexOf("## After launching");
		expect(idx).toBeGreaterThan(-1);
		const section = description.slice(idx, idx + 600);
		expect(section).toMatch(/auto-injected/i);
	});
});