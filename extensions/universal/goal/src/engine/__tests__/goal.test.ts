/**
 * engine/goal.ts 测试 — Goal 状态机 + createGoalState
 *
 * transitionStatus 完备性两层：fast-check 抽样（不 throw ⟺ (from,to) ∈ 期望合法边表）
 * + (from,target) 6×6 穷举基线（M3 迁移对账矩阵，36 组合全跑）。期望边表硬编码自
 * 领域语义、独立于实现（不 import 实现侧转移表——M3 迁移前后同一期望表对账）。
 * 机器表级另设 generateTableTests 穷举生成组（D5/D6 每步判据第二款）——直测
 * GOAL_MACHINE 全状态×全事件，与包装层基线互为独立防线。
 */
import { describe, expect } from "vitest";
import { it, fc } from "@fast-check/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateTableTests } from "@zhushanwen/state-machine/testing";
import { GOAL_MACHINE, createGoalState, isActiveStatus, isTerminalStatus, transitionStatus } from "../goal";
import type { GoalStatus } from "../types";

const STATUS_VALUES: GoalStatus[] = ["active", "paused", "blocked", "complete", "budget_limited", "cancelled"];
const statusArb = fc.constantFrom(...STATUS_VALUES);
// 独立于实现的终态集合（交叉校验，非循环）
const TERMINAL: ReadonlySet<GoalStatus> = new Set(["complete", "budget_limited", "cancelled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 期望合法边表（M3 迁移基线 oracle）：9 条合法边硬编码自领域语义——
// 用户 pause/resume/cancel、agent report_blocked/complete、token 预算耗尽。
const EXPECTED_LEGAL_EDGES: ReadonlyArray<readonly [GoalStatus, GoalStatus]> = [
	["active", "paused"],
	["active", "blocked"],
	["active", "complete"],
	["active", "budget_limited"],
	["active", "cancelled"],
	["paused", "active"],
	["paused", "cancelled"],
	["blocked", "active"],
	["blocked", "cancelled"],
];
const expectedLegalEdge = new Set(EXPECTED_LEGAL_EDGES.map(([from, to]) => `${from}→${to}`));

describe("isTerminalStatus", () => {
	it.prop([statusArb])("⟺ 在 {complete, budget_limited, cancelled} 内", (s) => isTerminalStatus(s) === TERMINAL.has(s));
});

describe("isActiveStatus", () => {
	it.prop([statusArb])("⟺ status === active", (s) => isActiveStatus(s) === (s === "active"));
});

describe("transitionStatus", () => {
	// ⭐ 完备性（抽样）：不 throw ⟺ (from, to) ∈ 期望合法边表（独立 oracle，非循环）
	it.prop([statusArb, statusArb])("完备性：不 throw ⟺ (from,to) ∈ 期望合法边表", (from, to) => {
		const inTable = expectedLegalEdge.has(`${from}→${to}`);
		let threw = false;
		try {
			transitionStatus(from, to);
		} catch {
			threw = true;
		}
		return threw === !inTable;
	});

	it("smoke：active → paused 合法，返回 to", () => {
		expect(transitionStatus("active", "paused")).toBe("paused");
	});
	it("smoke：终态 complete → active 非法 throw（不可逆）", () => {
		expect(() => transitionStatus("complete", "active")).toThrow();
	});
});

// ── M3 迁移基线（V7 对账矩阵）：(from,target) 6×6 穷举 ──────────────
// 迁移前测存量邻接表实现（基线），迁移后测机器包装（to 等价 + throw 形态）；
// 期望合法边表（expectedLegalEdge，文件顶部）迁移前后同一份。

describe("transitionStatus (from,target) 6×6 穷举基线（V7 对账矩阵）", () => {
	for (const from of STATUS_VALUES) {
		for (const target of STATUS_VALUES) {
			const legal = expectedLegalEdge.has(`${from}→${target}`);
			it(`${from} → ${target}：${legal ? `合法，返回 ${target}` : "非法，throw"}`, () => {
				if (legal) {
					expect(transitionStatus(from, target)).toBe(target);
				} else {
					expect(() => transitionStatus(from, target)).toThrow();
				}
			});
		}
	}
});

// ── 机器级穷举生成组（D5/D6 每步判据第二款）：全状态 × 全事件 ──────────
// generateTableTests(GOAL_MACHINE) 直测机器表（词表/表行误改、terminal
// 拒绝语义），与上方包装层 6×6（transitionStatus 行为对账）互为独立防线。
// 必须在收集阶段（模块顶层）调用——describe/it 不能在测试回调内注册。
const generatedCases = generateTableTests(GOAL_MACHINE);

describe("GOAL_MACHINE 穷举覆盖对账", () => {
	it("全组合 36（6 态 × 6 事件）= 合法 9 + 表外 27 + 不变量破坏 0", () => {
		// 合法 9 ⟺ 上方 EXPECTED_LEGAL_EDGES 的 9 条 (from,to) 边（本表
		// from×event→to 单射，两维度同源对账）；覆盖数对账防生成器静默漏覆盖。
		expect(generatedCases).toHaveLength(36);
		expect(generatedCases.filter((c) => c.expectation === "transition")).toHaveLength(9);
		expect(generatedCases.filter((c) => c.expectation === "rejected")).toHaveLength(27);
		expect(generatedCases.filter((c) => c.expectation === "invariant-broken")).toHaveLength(0);
	});
});

describe("createGoalState", () => {
	it("默认值：status active + 计数器清零 + 预警 flag false", () => {
		expect(createGoalState("my obj")).toMatchObject({
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			currentTurnIndex: 0,
			lastTurnTokensUsed: 0,
			budgetLimitSteeringSent: false,
			tokenWarning70Sent: false,
			tokenWarning90Sent: false,
		});
		// completedAtTurnIndex 是 optional：createGoalState 省略该键（访问得 undefined）
		expect(createGoalState("my obj").completedAtTurnIndex).toBeUndefined();
	});

	it("objective 透传", () => {
		expect(createGoalState("my obj").objective).toBe("my obj");
	});

	it("goalId 符合 UUID v4 格式", () => {
		expect(createGoalState("obj").goalId).toMatch(UUID_RE);
	});

	it("两次调用生成不同 goalId（唯一性）", () => {
		expect(createGoalState("obj").goalId).not.toBe(createGoalState("obj").goalId);
	});

	describe("budget 合并", () => {
		it("无 overrides → DEFAULT_BUDGET（{}）", () => {
			expect(createGoalState("obj").budget).toEqual({});
		});
		it("tokenBudget override 生效", () => {
			expect(createGoalState("obj", { tokenBudget: 10000 }).budget.tokenBudget).toBe(10000);
		});
	});
});

// ── E1 检查：状态变更唯一执行点（.status 裸赋值扫描）──

describe("E1 检查：src 内禁止 .status 裸赋值（必须走 transitionStatus 查表）", () => {
	it("扫描 src/**/*.ts（排除 __tests__）：0 命中", () => {
		// 正则逐字来自设计定稿，不得自行修改：
		// (?![=>]) 排除 ==/===/=>（比较与箭头函数形态）；(?!\s*transitionStatus\b) 放行白名单查表赋值。
		// 扫描粒度 = 整文件内容（非逐行）：\s* 必须能跨行吃换行，才能排除
		// `state.status =\n transitionStatus(...)` 这类跨行白名单赋值形态，逐行实现会误报。
		const re = /\.status\s*=(?![=>])(?!\s*transitionStatus\b)/g;
		const srcDir = fileURLToPath(new URL("../../", import.meta.url));
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const dirent of readdirSync(dir, { withFileTypes: true })) {
				if (dirent.name === "__tests__") continue;
				const abs = join(dir, dirent.name);
				if (dirent.isDirectory()) {
					walk(abs);
				} else if (dirent.isFile() && dirent.name.endsWith(".ts")) {
					const content = readFileSync(abs, "utf8");
					let match: RegExpExecArray | null;
					while ((match = re.exec(content)) !== null) {
						// 行号 = 命中起点之前的换行数 + 1
						const line = content.slice(0, match.index).split("\n").length;
						offenders.push(`${abs}:${line}`);
					}
				}
			}
		};
		walk(srcDir);
		expect(
			offenders,
			`检测到 ${offenders.length} 处 .status 裸赋值（状态变更必须走 transitionStatus 查表，见设计 §5.4 E1 / goal 状态机声明 engine/goal.ts）:\n`
				+ offenders.join("\n"),
		).toEqual([]);
	});
});
