/**
 * rule-editor-component.test.ts — W8 T7: RuleEditorComponent 单元测试。
 *
 * 覆盖：
 *  - 构造 + 初始 list stage
 *  - list stage 选择规则 → fill(edit)
 *  - list stage [+ Add] → add stage
 *  - add stage 选模板 → fill stage
 *  - [Done] → settle ops
 *  - _resolved 守卫
 *  - currentListRules 实时反映 ops（G2）
 *  - WR1 handleInput 锁定（Container override 委托）
 *  - Tab 焦点路由（WR8）
 */
import { describe, expect, it, vi } from "vitest";

import { RuleEditorComponent } from "../rule-editor-component.js";
import type { RuleOp } from "../rule-templates.js";
import type { Rule } from "../types.js";

// ──────────────────────── helpers ────────────────────────

function makeRule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: "user-1",
		tool: "bash",
		pattern: "npm *",
		action: "allow",
		source: "user",
		...overrides,
	};
}

/** 构造一个 RuleEditorComponent 并收集 done 结果。 */
function createComp(
	initialRules: Rule[] = [],
	doneFn?: (ops: RuleOp[]) => void,
): { comp: RuleEditorComponent; done: ReturnType<typeof vi.fn>; counter: () => string } {
	let nextId = 1;
	const counter = (): string => `user-${nextId++}`;
	const done = vi.fn(doneFn ?? (() => undefined));
	const comp = new RuleEditorComponent(initialRules, counter, done);
	return { comp, done, counter };
}

// ──────────────────────── 构造 + 初始 list stage ────────────────────────

describe("REC1: 构造 + 初始 list stage", () => {
	it("构造不抛错，render 非空", () => {
		const { comp } = createComp();
		const lines = comp.render(80);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("初始 render 含 'Permission Rules'", () => {
		const { comp } = createComp([makeRule()]);
		expect(comp.render(80).join("\n")).toContain("Permission Rules");
	});

	it("list stage 含已有规则 + [+ Add rule] + [Done]", () => {
		const { comp } = createComp([makeRule({ id: "user-1", pattern: "npm *" })]);
		const text = comp.render(80).join("\n");
		expect(text).toContain("npm *");
		expect(text).toContain("[+ Add rule]");
		expect(text).toContain("[Done]");
	});
});

// ──────────────────────── list stage Enter 行为 ────────────────────────

describe("REC2: list stage Enter 行为", () => {
	it("Enter 选 [+ Add rule] → add stage（render 含 'Select Template'）", () => {
		const { comp } = createComp();
		// 预选在第一条（[+ Add rule]），因为无规则时它是第一项
		// 但有 [Done] 在最后，所以 [+ Add rule] 是 index 0（无规则时）
		comp.handleInput("\r"); // Enter
		const text = comp.render(80).join("\n");
		expect(text).toContain("Select Template");
	});

	it("Enter 选 [Done] → settle 空 ops（无规则时 [Done] 是第二项）", () => {
		const { comp, done } = createComp();
		comp.handleInput("\x1b[B"); // Down → [Done]
		comp.handleInput("\r"); // Enter
		expect(done).toHaveBeenCalledOnce();
		const ops = done.mock.calls[0]![0] as RuleOp[];
		expect(ops).toEqual([]);
	});
});

// ──────────────────────── add stage 选模板 ────────────────────────

describe("REC3: add stage 选模板", () => {
	it("选 allow-family 模板 → fill stage（render 含 'Select command'）", () => {
		const { comp } = createComp();
		// 进 add stage
		comp.handleInput("\r"); // Enter → add stage（[+ Add rule] 预选）
		// add stage 第一条是 allow-family，Enter 选中
		comp.handleInput("\r");
		const text = comp.render(80).join("\n");
		expect(text).toContain("Select command");
	});

	it("add stage Esc → 回 list stage", () => {
		const { comp } = createComp();
		comp.handleInput("\r"); // → add stage
		comp.handleInput("\x1b"); // Esc
		const text = comp.render(80).join("\n");
		expect(text).toContain("Permission Rules");
		expect(text).not.toContain("Select Template");
	});
});

// ──────────────────────── fill stage：命令选择 + commitFill ────────────────────────

describe("REC4: fill stage 命令选择 + commitFill", () => {
	it("选 npm → commitFill → 回 list stage，新规则出现", () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { comp, done } = createComp();
		// → add stage → 选 allow-family → fill stage（command-select 带搜索）
		comp.handleInput("\r"); // [+ Add rule]
		comp.handleInput("\r"); // allow-family
		// fill stage：搜索框默认获焦，Enter（空 query）→ 选中第一个匹配 npm → 进入 scope 列表
		comp.handleInput("\r");
		// scope 列表：第一条是 `${cmd} * (all subcommands)`（__all__），Enter → commitFill
		comp.handleInput("\r");
		// commitFill → switchToListStage，list 现在应有新规则
		const text = comp.render(80).join("\n");
		expect(text).toContain("npm *");
		expect(comp.ops).toHaveLength(1);
		expect(comp.ops[0]!.kind).toBe("add");
		expect(comp.ops[0]!.rule.pattern).toBe("npm *");
		expect(comp.ops[0]!.rule.action).toBe("allow");
	});
});

// ──────────────────────── _resolved 守卫 ────────────────────────

describe("REC5: _resolved 守卫", () => {
	it("settle 后再 handleInput no-op（done 只调一次）", () => {
		const { comp, done } = createComp();
		// 选 [Done]
		comp.handleInput("\r"); // [+ Add rule]（但无规则时第一条是 [+ Add rule]）
		// 实际无规则时 items = ["[+ Add rule]", "[Done]"]
		// Enter 选了 [+ Add rule]，进 add stage
		// 回到 list 用 cancel
		comp.handleInput("\x1b"); // Esc → back to list
		// 现在 list 有 [+ Add rule] 和 [Done]
		comp.handleInput("\x1b[B"); // Down → [Done]
		comp.handleInput("\r"); // Enter → settle
		expect(done).toHaveBeenCalledOnce();
		// 再次输入 no-op
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── currentListRules（G2） ────────────────────────

describe("REC6: currentListRules 实时反映 ops（G2）", () => {
	it("初始 currentListRules 等于 initialRules", () => {
		const rules = [makeRule({ id: "user-1" })];
		const { comp } = createComp(rules);
		expect(comp.currentListRules()).toEqual(rules);
	});

	it("ops.push add 后 currentListRules 包含新规则", () => {
		const { comp } = createComp([makeRule({ id: "user-1" })]);
		comp.ops.push({ kind: "add", rule: makeRule({ id: "user-2", pattern: "git *" }) });
		const rules = comp.currentListRules();
		expect(rules).toHaveLength(2);
		expect(rules[1]!.pattern).toBe("git *");
	});
});

// ──────────────────────── WR1 handleInput 锁定 ────────────────────────

describe("REC7: WR1 handleInput 委托锁定（critical）", () => {
	it("handleInput('\\r') 直接触发 SelectList.onSelect（list stage [Done]）", () => {
		const { comp, done } = createComp();
		// list stage：无规则 → items = [[+ Add rule], [Done]]
		// Down → [Done]
		comp.handleInput("\x1b[B");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});

	it("handleInput(down + enter) 链式触发导航 + onSelect", () => {
		const { comp, done } = createComp([makeRule({ id: "user-1", pattern: "npm *" })]);
		// list items: [npm * (rule), [+ Add rule], [Done]]
		// 预选 index 0（npm *），Enter → fill(edit)
		comp.handleInput("\r");
		// fill(edit) 模式，render 应含 Edit Rule
		const text = comp.render(80).join("\n");
		expect(text).toContain("Edit Rule");
		// done 不应被调（还在 fill stage）
		expect(done).not.toHaveBeenCalled();
	});
});

// ──────────────────────── WR8 Tab 焦点路由 ────────────────────────

describe("REC8: WR8 Tab 焦点路由（Custom form）", () => {
	it("custom form Tab 循环焦点（5 项）", () => {
		const { comp } = createComp();
		// → add stage
		comp.handleInput("\r"); // [+ Add rule]
		// 选 custom（最后一条模板，index 4）
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[B"); // Down x4
		comp.handleInput("\r"); // Enter → custom fill
		const text = comp.render(80).join("\n");
		expect(text).toContain("Custom Rule");
		// Tab 5 次应回到原焦点（模 5）
		for (let i = 0; i < 5; i++) comp.handleInput("\t");
		// 不应抛错
		expect(comp.render(80).length).toBeGreaterThan(0);
	});
});

// ──────────────────────── cancel ────────────────────────

describe("REC9: cancel", () => {
	it("cancel() 调 done(ops)（可能为空）", () => {
		const { comp, done } = createComp();
		comp.cancel();
		expect(done).toHaveBeenCalledOnce();
	});

	it("cancel 后 _resolved 守卫生效", () => {
		const { comp, done } = createComp();
		comp.cancel();
		comp.cancel();
		expect(done).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── Wave 2: edit 提交保留改动（M1 + M2） ────────────────────────

describe("REC10: Wave 2 — edit 提交保留改动（M1）", () => {
	it("edit 规则改 action 后 ops 含 edit 且字段正确", () => {
		const initialRule = makeRule({ id: "user-1", pattern: "npm *", action: "allow" });
		const { comp } = createComp([initialRule]);
		// list stage 第一条是规则，Enter 进 edit（custom form，edit 模式）
		comp.handleInput("\r");
		// 焦点在 pattern（index 0），Tab 到 action（index 1）
		comp.handleInput("\t"); // → action
		comp.handleInput("\x1b[B"); // Down → deny（移动指针）
		comp.handleInput("\r"); // Enter → actionList.onSelect → fillSelections.action = "deny"
		// Tab 经 tool / description 到 submit
		comp.handleInput("\t"); // → tool (index 2)
		comp.handleInput("\t"); // → description (index 3)
		comp.handleInput("\t"); // → submit (index 4)
		comp.handleInput("\r"); // submit → commitFill
		// 回到 list stage，ops 应含 1 个 edit
		expect(comp.ops).toHaveLength(1);
		expect(comp.ops[0]!.kind).toBe("edit");
		const editOp = comp.ops[0]!;
		if (editOp.kind === "edit") {
			expect(editOp.id).toBe("user-1");
			expect(editOp.rule.id).toBe("user-1");
			expect(editOp.rule.pattern).toBe("npm *"); // 未改 pattern
			expect(editOp.rule.action).toBe("deny"); // 改成 deny
			expect(editOp.rule.tool).toBe("bash");
		}
	});

	it("edit 提交后 pattern 通过 _syncCustomFormValues 保留（即使没按 Enter 确认 Input）", () => {
		// 验证 M2：Input.onSubmit 仅在 Enter 时触发；Tab 切走不触发。
		// commitFill 入口的 _syncCustomFormValues 兜底读 getValue，确保预填值不丢。
		const initialRule = makeRule({ id: "user-1", pattern: "npm *", action: "allow" });
		const { comp } = createComp([initialRule]);
		comp.handleInput("\r"); // 进 edit
		// 焦点在 pattern，直接 Tab 到 submit（不按 Enter 确认 pattern）
		comp.handleInput("\t"); // → action
		comp.handleInput("\t"); // → tool
		comp.handleInput("\t"); // → description
		comp.handleInput("\t"); // → submit
		comp.handleInput("\r"); // submit → commitFill（入口调 _syncCustomFormValues）
		expect(comp.ops).toHaveLength(1);
		const editOp = comp.ops[0]!;
		if (editOp.kind === "edit") {
			expect(editOp.rule.pattern).toBe("npm *"); // _syncCustomFormValues 读到预填值
			expect(editOp.rule.action).toBe("allow"); // 原 action 保留
		}
	});

	it("edit 模式 commitFill 绕过 fillTemplate.build（M1：不再被 fillTemplate===null 吞掉）", () => {
		// 直接验证：edit 进入 custom form 后 fillTemplate 始终为 null，
		// 旧逻辑会 switchToListStage() 提前返回，ops 为空。
		// 新逻辑：edit 分支前置，直接构造 Rule。
		const initialRule = makeRule({ id: "user-1", pattern: "git *", action: "ask" });
		const { comp } = createComp([initialRule]);
		comp.handleInput("\r"); // 进 edit
		// 焦点一路 Tab 到 submit，不改任何字段
		for (let i = 0; i < 4; i++) comp.handleInput("\t"); // pattern→action→tool→desc→submit
		comp.handleInput("\r"); // submit
		expect(comp.ops).toHaveLength(1);
		const editOp = comp.ops[0]!;
		if (editOp.kind === "edit") {
			expect(editOp.rule.pattern).toBe("git *");
			expect(editOp.rule.action).toBe("ask");
		}
	});
});

// ──────────────────────── Wave 2: custom form 焦点指示（M4） ────────────────────────

describe("REC11: Wave 2 — custom form 焦点指示（M4）", () => {
	it("初始焦点在 Pattern，render 含 ▶ Pattern 标记且不含 ▶ Action", () => {
		const { comp } = createComp();
		// 进 custom form：add → 选 custom 模板（index 4）
		comp.handleInput("\r"); // [+ Add rule]
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[B"); // Down x4 到 custom
		comp.handleInput("\r"); // Enter custom
		const text = comp.render(80).join("\n");
		expect(text).toContain("▶ Pattern");
		expect(text).not.toContain("▶ Action");
	});

	it("Tab 后焦点到 Action，render 含 ▶ Action 标记且 ▶ Pattern 消失", () => {
		const { comp } = createComp();
		comp.handleInput("\r");
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\r");
		comp.handleInput("\t"); // Tab → Action
		const text = comp.render(80).join("\n");
		expect(text).toContain("▶ Action");
		expect(text).not.toContain("▶ Pattern");
	});

	it("连续 Tab 循环焦点：Pattern → Action → Tool → Description → 回 Pattern 区域无重复 ▶", () => {
		const { comp } = createComp();
		comp.handleInput("\r");
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\r");
		// 焦点 0=Pattern → 1=Action → 2=Tool → 3=Description
		const labels = ["▶ Pattern", "▶ Action", "▶ Tool", "▶ Description (optional)"];
		for (const expected of labels) {
			const text = comp.render(80).join("\n");
			expect(text).toContain(expected);
			comp.handleInput("\t");
		}
	});
});

// ──────────────────────── Wave 3: 搜索过滤一致性（M5） ────────────────────────

describe("REC12: Wave 3 — 搜索过滤一致性（M5）", () => {
	it("输入前缀匹配的字符，列表过滤显示对应命令", () => {
		const { comp } = createComp();
		// 进 command-select：add → allow-family
		comp.handleInput("\r"); // [+ Add rule]
		comp.handleInput("\r"); // allow-family（第一条模板，预选）
		// 现在在 command-select，焦点默认在搜索框
		// 输入 'gi'（git value 的前缀，startsWith 匹配）
		comp.handleInput("g");
		comp.handleInput("i");
		const text = comp.render(80).join("\n");
		// git 应在过滤后列表中
		expect(text).toMatch(/git/i);
		// 非前缀匹配的命令不应出现（如 npm，'gi' 不是其前缀）
		expect(text).not.toMatch(/npm/i);
	});

	it("输入非前缀字符，实时列表不显示不匹配项（startsWith 一致性）", () => {
		const { comp } = createComp();
		comp.handleInput("\r"); // [+ Add rule]
		comp.handleInput("\r"); // allow-family
		// 输入 'install'（不是任何命令 value/label 的前缀；npm install 的 value 是 'npm'）
		for (const ch of "install") comp.handleInput(ch);
		const text = comp.render(80).join("\n");
		// npm 不应出现（startsWith 不匹配）
		expect(text).not.toMatch(/npm/i);
		// 实时列表（SelectList.setFilter）无匹配 → 显示 noMatch 文案
		// 注：__other__ 仅在 Enter 选择路径（_filterCommands）保留，不在实时显示保留
		// （SelectList.setFilter 是 pi-tui 内置 value.startsWith，不感知 __other__）
		expect(text).toContain("No matching commands");
	});

	it("__other__ 在 Enter 选择路径始终保留（_filterCommands 语义）", () => {
		const { comp } = createComp();
		comp.handleInput("\r");
		comp.handleInput("\r");
		// 输入任意字符（无命令 value 以 zzz 开头）
		for (const ch of "zzz") comp.handleInput(ch);
		// 实时显示已被 setFilter 清空（No matching commands），但 _filterCommands
		// 保留 __other__ → Enter 触发 onSubmit → filtered 含 __other__ → 进入手动输入
		comp.handleInput("\r");
		const text = comp.render(80).join("\n");
		expect(text).toContain("Enter command name"); // startCommandInput 界面
	});
});

// ──────────────────────── C1/C2/C3: _resetStageRefs 死锁修复回归 ────────────────────────

describe("REC13: C3 — _resetStageRefs 多次 stage 转换不残留旧组件引用（死锁修复回归）", () => {
	// C3 根因：switchTo*/startFill* 方法手动清理子组件引用时遗漏字段，
	// 导致 handleInput 把输入路由到已清空的旧组件（输入死锁）。
	// _resetStageRefs 集中清理 _searchInput/_commandList/_searchFocus/
	// currentInput/currentList/customChildren，杜绝遗漏。
	// 因这些字段是 private，通过行为验证：Esc 回退后再进 stage，
	// 输入字符应作用于「新」组件而非残留的旧组件（不 crash、过滤正确）。
	it("command-select → Esc 回退 → 再进 command-select：输入字符过滤新列表（不路由到旧组件）", () => {
		const { comp } = createComp();
		// 1. 进 command-select stage（add → allow-family）
		comp.handleInput("\r"); // [+ Add rule] → add stage
		comp.handleInput("\r"); // allow-family → command-select stage
		expect(comp.render(80).join("\n")).toContain("Select command");
		// 2. 输入字符到 searchInput（验证旧 _searchInput 活跃：能过滤列表）
		comp.handleInput("g");
		comp.handleInput("i");
		let text = comp.render(80).join("\n");
		expect(text).toMatch(/git/i); // 'gi' 前缀过滤出 git
		// 3. Esc 回退：command-select 的 searchInput.onEscape → switchToListStage
		//    → _resetStageRefs 清空 _searchInput/_commandList
		comp.handleInput("\x1b");
		text = comp.render(80).join("\n");
		expect(text).toContain("Permission Rules"); // 回到 list stage
		// 4. 再进 command-select stage（list → add → allow-family）
		comp.handleInput("\r"); // [+ Add rule] → add stage
		comp.handleInput("\r"); // allow-family → command-select stage（新建 _searchInput/_commandList）
		expect(comp.render(80).join("\n")).toContain("Select command");
		// 5. 关键：输入字符应作用于「新」searchInput → 过滤新 commandList
		//    若旧引用残留，过滤会错乱或 crash。输入 'gi' 应再次过滤出 git。
		comp.handleInput("g");
		comp.handleInput("i");
		text = comp.render(80).join("\n");
		expect(text).toMatch(/git/i); // 新列表被正确过滤
		// npm 不应出现（'gi' 不是 npm 前缀）—— 证明输入路由到新组件而非旧组件
		expect(text).not.toMatch(/npm/i);
	});

	it("custom form → Esc 回退 → 再进 command-select：Tab/字符不误触发旧 customChildren", () => {
		// 跨 fillKind 转换（custom → list → command-select）：
		// customChildren 在 _resetStageRefs 被清空，再进 command-select 时
		// handleInput 不应走 custom 分支（fillKind 已变为 command-select）。
		const { comp } = createComp();
		// 进 custom form：add → custom 模板（index 4）
		comp.handleInput("\r"); // [+ Add rule]
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[B"); // Down x4 → custom
		comp.handleInput("\r"); // Enter → custom form
		expect(comp.render(80).join("\n")).toContain("Custom Rule");
		// Esc：pattern Input.onEscape → switchToListStage → _resetStageRefs 清 customChildren
		comp.handleInput("\x1b");
		expect(comp.render(80).join("\n")).toContain("Permission Rules");
		// 再进 command-select
		comp.handleInput("\r"); // [+ Add rule]
		comp.handleInput("\r"); // allow-family → command-select
		expect(comp.render(80).join("\n")).toContain("Select command");
		// 输入字符 + Tab：不应 crash，不应误触发残留 customChildren 的 Tab 路由
		comp.handleInput("g");
		comp.handleInput("\t"); // Tab 切换搜索框↔列表（command-select 语义，非 custom Tab 循环）
		// 不抛错 + 仍处于 command-select stage
		const text = comp.render(80).join("\n");
		expect(text).toContain("Select command");
	});

	it("连续多次 add↔list 转换不残留 currentList（Enter 选模板稳定生效）", () => {
		// 多次 switchToAddStage/switchToListStage 循环：每次 _resetStageRefs 清 currentList，
		// 新 currentList 正确赋值。验证连续进 add stage 选模板仍能正常进入 fill stage。
		const { comp } = createComp();
		for (let round = 0; round < 3; round++) {
			// list → add
			comp.handleInput("\r"); // [+ Add rule] → add stage
			expect(comp.render(80).join("\n")).toContain("Select Template");
			// add → list（Esc）
			comp.handleInput("\x1b");
			expect(comp.render(80).join("\n")).toContain("Permission Rules");
		}
		// 最后一次进 add 并选 allow-family：currentList 是新建的，onSelect 正常触发
		comp.handleInput("\r"); // → add stage
		comp.handleInput("\r"); // allow-family → command-select
		expect(comp.render(80).join("\n")).toContain("Select command");
	});
});
