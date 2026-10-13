/**
 * 旧工具名精确规则迁移测试（tool-declaration-slimming D3 / U-B1 验收条款②）。
 *
 * 表驱动五分支：
 *  1. 精确旧名展开——subagent → start/manage/message、workflow → run/control，
 *     展开顺序承重（D3 契约①），pattern/action/source/description 保留；
 *  2. wildcard 不动——'*' 与其他含通配形态的 tool 一律原样；
 *  3. 幂等——迁移结果再迁移深度相等（无旧名即零变化）；
 *  4. 展开后 id 全唯一——makeNextIdCounter 从既有 user-N 最大值 +1 递增，
 *     不与既有规则冲突、展开条目互不冲突；
 *  5. 混合 wildcard 场景保序——经真实 matcher（matchNonBashTool，last-match-wins）
 *     断言「新名调用在迁移后规则集上的结论 = 迁移前旧名调用在原规则集上的结论；
 *     wildcard 对各调用的结论迁移前后不变」。旧名调用在迁移后不可达（旧工具名不再
 *     注册，D3「旧名不保留别名」），不对其迁移后结论作断言。
 *
 * 匹配器行为注释：matchNonBashTool 的 tool 字段经 wildcardToRegExp 全锚定匹配
 * （精确名 = 精确匹配，'*' = 匹配全部）；pattern 对 path 匹配（path 缺省时对
 * toolName）。测试用 path 固定为 "/x" 让 pattern '*' 命中路径、隔离 tool 维度。
 */
import { describe, expect, it } from "vitest";

import type { Rule } from "../types.js";
import { migrateLegacyToolRules } from "../rules/legacy-tool-names.js";
import { matchNonBashTool } from "../pipeline.js";

function userRule(overrides: Partial<Rule> & { id: string; tool: string }): Rule {
	return {
		pattern: "*",
		action: "deny",
		source: "user",
		...overrides,
	};
}

describe("旧工具名精确规则迁移（D3）— 表驱动五分支", () => {
	it("分支1：精确旧名展开（subagent 三条 + workflow 两条，展开顺序承重，其余字段保留）", () => {
		const rules: Rule[] = [
			userRule({ id: "user-1", tool: "subagent", pattern: "*", action: "deny", description: "no subagent" }),
			userRule({ id: "user-2", tool: "workflow", pattern: "*", action: "ask", description: "ask workflow" }),
		];

		const migrated = migrateLegacyToolRules(rules);

		expect(migrated).toHaveLength(5);
		// 展开顺序（D3 契约①）：subagent → start/manage/message；workflow → run/control
		expect(migrated.map((r) => r.tool)).toEqual([
			"subagent_start",
			"subagent_manage",
			"subagent_message",
			"workflow_run",
			"workflow_control",
		]);
		// 同 pattern/action/source/description 保留（只换 tool 名与 id）
		expect(migrated[0]).toMatchObject({ pattern: "*", action: "deny", source: "user", description: "no subagent" });
		expect(migrated[3]).toMatchObject({ pattern: "*", action: "ask", source: "user", description: "ask workflow" });
		// 原数组不被改写（纯函数）
		expect(rules).toHaveLength(2);
		expect(rules[0]?.tool).toBe("subagent");
	});

	it("分支2：wildcard 与其他工具规则不动；无旧名时零拷贝快速路径", () => {
		const wildcardRule = userRule({ id: "user-7", tool: "*", action: "allow" });
		const bashRule = userRule({ id: "user-8", tool: "bash", pattern: "git *" });
		const readGlobRule = userRule({ id: "user-9", tool: "read*", pattern: "*" });
		const rules = [wildcardRule, bashRule, readGlobRule];
		const migrated = migrateLegacyToolRules(rules);

		// 无旧名规则 → 返回原数组引用（零拷贝快速路径），条目零变化
		expect(migrated).toBe(rules);
		expect(migrated.map((r) => r.tool)).toEqual(["*", "bash", "read*"]);
	});

	it("分支3：幂等（已迁移配置再迁移深度相等）", () => {
		const legacy: Rule[] = [
			userRule({ id: "user-1", tool: "subagent", action: "deny" }),
			userRule({ id: "user-2", tool: "workflow", action: "ask" }),
			userRule({ id: "user-3", tool: "*", action: "allow" }),
		];
		const once = migrateLegacyToolRules(legacy);
		const twice = migrateLegacyToolRules(once);

		expect(twice).toEqual(once);
		expect(twice).toHaveLength(once.length);
	});

	it("分支4：展开后 id 全唯一（不与既有冲突、互不冲突、makeNextIdCounter 递增形态）", () => {
		const rules: Rule[] = [
			userRule({ id: "user-2", tool: "subagent", action: "deny" }),
			userRule({ id: "user-5", tool: "read", action: "allow" }),
			userRule({ id: "user-3", tool: "workflow", action: "ask" }),
		];
		const migrated = migrateLegacyToolRules(rules);

		const ids = migrated.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		// 未迁移规则 id 保持不变
		expect(migrated.find((r) => r.tool === "read")?.id).toBe("user-5");
		// 展开条目全部是新分配的 user-N（> 既有最大值 5）
		const expandedIds = migrated.filter((r) => r.tool.startsWith("subagent_") || r.tool.startsWith("workflow_")).map((r) => r.id);
		expect(expandedIds).toHaveLength(5);
		for (const id of expandedIds) {
			expect(id).toMatch(/^user-(\d+)$/);
			expect(Number.parseInt(id.slice(5), 10)).toBeGreaterThan(5);
		}
	});

	it("分支5：混合 wildcard 场景保序（真实 matcher：新名结论 = 迁移前旧名结论；wildcard 结论不变）", () => {
		// 混合规则集 A：精确 deny 在前、wildcard allow 在后——last-match-wins 下
		// 尾部 wildcard allow 覆盖前面的精确 deny（旧名调用结论 = allow）。
		// 若迁移把展开规则错误地追加到数组尾部（D3 契约①禁止的实装），新名 deny 会
		// 落到 wildcard allow 之后 → 结论翻成 deny ≠ 旧行为，本断言即红灯。
		const mixed: Rule[] = [
			userRule({ id: "user-1", tool: "subagent", pattern: "*", action: "deny" }),
			userRule({ id: "user-2", tool: "workflow", pattern: "*", action: "deny" }),
			userRule({ id: "user-3", tool: "*", pattern: "*", action: "allow" }),
			userRule({ id: "user-4", tool: "read", pattern: "*", action: "allow" }),
		];

		const migrated = migrateLegacyToolRules(mixed);

		// 保序：精确规则与其展开条目的相对位置不变（wildcard 仍在展开条目之后）
		const tools = migrated.map((r) => r.tool);
		expect(tools).toEqual([
			"subagent_start",
			"subagent_manage",
			"subagent_message",
			"workflow_run",
			"workflow_control",
			"*",
			"read",
		]);

		// ① 迁移前旧名调用的结论
		const before = {
			subagent: matchNonBashTool("subagent", "/x", mixed).action,
			workflow: matchNonBashTool("workflow", "/x", mixed).action,
		};
		// ② 迁移后新名调用的结论（拆分后旧名不可达，只有新名可调用）
		const after = {
			subagentStart: matchNonBashTool("subagent_start", "/x", migrated).action,
			subagentManage: matchNonBashTool("subagent_manage", "/x", migrated).action,
			subagentMessage: matchNonBashTool("subagent_message", "/x", migrated).action,
			workflowRun: matchNonBashTool("workflow_run", "/x", migrated).action,
			workflowControl: matchNonBashTool("workflow_control", "/x", migrated).action,
		};

		expect(after.subagentStart).toBe(before.subagent);
		expect(after.subagentManage).toBe(before.subagent);
		expect(after.subagentMessage).toBe(before.subagent);
		expect(after.workflowRun).toBe(before.workflow);
		expect(after.workflowControl).toBe(before.workflow);
		// 显式值锚（场景 A 真实结论）：尾部 wildcard allow 覆盖精确 deny
		expect(before.subagent).toBe("allow");
		expect(after.subagentStart).toBe("allow");

		// ③ wildcard 与其他规则对各调用的结论迁移前后不变
		expect(matchNonBashTool("read", "/x", migrated).action).toBe(matchNonBashTool("read", "/x", mixed).action);
		expect(matchNonBashTool("bash", "/x", migrated).action).toBe(matchNonBashTool("bash", "/x", mixed).action);
	});

	it("分支5b：反向混合集（wildcard deny 在前、精确 allow 在后）保序——新名结论 = 旧名结论", () => {
		// 与分支5互为镜像：旧名调用结论 = deny（尾部精确 allow 被…不——allow 在
		// wildcard deny 之后，last-match-wins 下 allow 胜。若错误追加，新名 allow
		// 落在最后 → 仍 allow，本场景区分度弱；承重面是「精确条目仍在 wildcard
		// 之前」的位置锚 + 与分支5合并覆盖两个方向）。
		const mixed: Rule[] = [
			userRule({ id: "user-1", tool: "*", pattern: "*", action: "deny" }),
			userRule({ id: "user-2", tool: "subagent", pattern: "*", action: "allow" }),
			userRule({ id: "user-3", tool: "workflow", pattern: "*", action: "ask" }),
		];
		const migrated = migrateLegacyToolRules(mixed);

		// 位置锚：展开条目紧跟原规则原位（wildcard deny 保持在前）
		expect(migrated.map((r) => r.tool)).toEqual([
			"*",
			"subagent_start",
			"subagent_manage",
			"subagent_message",
			"workflow_run",
			"workflow_control",
		]);

		const beforeSubagent = matchNonBashTool("subagent", "/x", mixed).action;
		const beforeWorkflow = matchNonBashTool("workflow", "/x", mixed).action;
		expect(matchNonBashTool("subagent_start", "/x", migrated).action).toBe(beforeSubagent);
		expect(matchNonBashTool("subagent_manage", "/x", migrated).action).toBe(beforeSubagent);
		expect(matchNonBashTool("subagent_message", "/x", migrated).action).toBe(beforeSubagent);
		expect(matchNonBashTool("workflow_run", "/x", migrated).action).toBe(beforeWorkflow);
		expect(matchNonBashTool("workflow_control", "/x", migrated).action).toBe(beforeWorkflow);
		// 显式值锚：尾部精确 allow/ask 胜出前部 wildcard deny
		expect(beforeSubagent).toBe("allow");
		expect(beforeWorkflow).toBe("ask");
		// wildcard deny 对无关工具的结论迁移前后不变（bash 只被头部 wildcard deny 命中）
		expect(matchNonBashTool("bash", "/x", migrated).action).toBe(matchNonBashTool("bash", "/x", mixed).action);
		expect(matchNonBashTool("bash", "/x", mixed).action).toBe("deny");
	});
});
