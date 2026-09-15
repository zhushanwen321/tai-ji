/**
 * W8: Rule editor overlay — three-mode dispatch (TUI / RPC / headless).
 *
 * editRulesViaOverlay：主入口，按 ctx.mode 分发。
 * editViaRpc：RPC 循环（list → action → fill → ...）。
 * G16：RPC listOptions 用 applyOps(initialRules, ops) 重建。
 */

import { RuleEditorComponent } from "./rule-editor-component.js";
import { ALL_TEMPLATES, applyOps, PRESET_COMMANDS, type RuleOp } from "./rule-templates.js";
import type { Rule } from "./types.js";

// ──────────────────────── 类型 ────────────────────────

/** 编辑结果：RuleOp[]（有变更）或 undefined（cancel / headless 降级）。 */
export type RuleEditorResult = RuleOp[] | undefined;

/** editRulesViaOverlay 的 UI 上下文子集（从 Pi ExtensionContext 提取）。 */
export interface RuleEditorContext {
	mode: "tui" | "rpc" | "json" | "print";
	ui: {
		notify(msg: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
		custom<T = void>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
		/** 可选文本输入（custom 模板 / Reject-with-Reason 用）。SDK 提供，mock 可能缺失。 */
		input?(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	};
}

// ──────────────────────── editRulesViaOverlay（主入口） ────────────────────────

/**
 * 通过 overlay 编辑规则（TUI / RPC / headless 三模式分发）。
 *
 * @param ctx UI 上下文（mode + ui.*）
 * @param initialRules 当前 userRules
 * @param sessionIdCounter user-N id 生成器闭包
 * @returns RuleOp[]（有变更）或 undefined（cancel / headless）
 */
export async function editRulesViaOverlay(
	ctx: RuleEditorContext,
	initialRules: readonly Rule[],
	sessionIdCounter: () => string,
): Promise<RuleEditorResult> {
	switch (ctx.mode) {
		case "tui":
			return await editViaTui(ctx, initialRules, sessionIdCounter);
		case "rpc":
			return await editViaRpc(ctx, initialRules, sessionIdCounter);
		case "json":
		case "print":
		default:
			ctx.ui.notify("[pi-permission] Rule editor not available in headless mode. Edit <agentDir>/config/permission-ext-config.json directly.", "warning");
			return undefined;
	}
}

// ──────────────────────── TUI 分支 ────────────────────────

async function editViaTui(
	ctx: RuleEditorContext,
	initialRules: readonly Rule[],
	sessionIdCounter: () => string,
): Promise<RuleEditorResult> {
	return await ctx.ui.custom<RuleOp[]>(
		(_tui, _theme, _kb, done) => {
			const comp = new RuleEditorComponent(
				initialRules,
				sessionIdCounter,
				done,
			);
			return comp;
		},
		{ overlay: true },
	);
}

// ──────────────────────── RPC 分支（G16） ────────────────────────

/** RPC 循环内的 select/input 句柄（deps mock 优先，缺省回落 ctx.ui）。 */
interface RpcIo {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
}

/**
 * 解析 RPC 循环的 input 句柄：
 * ctx.ui.input 可用 → 用真实文本输入（custom 模板需要自由文本）；
 * 不可用 → fallback 把 input 降级为单选项 select（占位符文本，仅保底）。
 */
function resolveRpcInput(ctx: RuleEditorContext): RpcIo["input"] {
	return typeof ctx.ui.input === "function"
		? (title: string, ph?: string) => ctx.ui.input!(title, ph)
		: (title: string, ph?: string) => ctx.ui.select(title, [ph ?? ""]).then((v) => v === undefined ? undefined : v);
}

/** 单轮 RPC list 画面：当前规则集（applyOps 反映前序操作）+ 标签 + 选项。 */
function buildRpcListState(
	initialRules: readonly Rule[],
	ops: RuleOp[],
): { currentRules: Rule[]; ruleLabels: string[]; listOptions: string[] } {
	const currentRules = applyOps([...initialRules], ops);
	const ruleLabels = currentRules.map((r) => `[${r.action}] ${r.pattern}`);
	const listOptions = [...ruleLabels, "[+ Add rule]", "[Done]"];
	return { currentRules, ruleLabels, listOptions };
}

/**
 * 选择了一条现有规则 → edit 模式（rpcEditFlow；ops 原地追加产生的 op）。
 */
async function handleRpcRuleSelection(
	io: RpcIo,
	listChoice: string,
	ruleLabels: readonly string[],
	currentRules: readonly Rule[],
	ops: RuleOp[],
): Promise<void> {
	const ruleIdx = ruleLabels.indexOf(listChoice);
	if (ruleIdx >= 0 && ruleIdx < currentRules.length) {
		const existingRule = currentRules[ruleIdx];
		if (existingRule !== undefined) {
			const editOp = await rpcEditFlow(io.select, io.input, existingRule);
			if (editOp !== undefined) {
				ops.push(editOp);
			}
		}
	}
}

/**
 * RPC 循环主体：list → action select → fill input → ... 直到 Done / cancel。
 *
 * G16：每次 op 后 listOptions 更新（反映前序操作）。
 */
async function runRpcLoop(
	io: RpcIo,
	initialRules: readonly Rule[],
	sessionIdCounter: () => string,
): Promise<RuleEditorResult> {
	const ops: RuleOp[] = [];

	for (;;) {
		// 构建 listOptions（G16：用 applyOps 反映前序操作）
		const { currentRules, ruleLabels, listOptions } = buildRpcListState(initialRules, ops);

		const listChoice = await io.select("[pi-permission] Permission Rules", listOptions);
		if (listChoice === undefined) {
			// cancel
			return undefined;
		}

		if (listChoice === "[Done]") {
			return ops.length > 0 ? ops : undefined;
		}

		if (listChoice === "[+ Add rule]") {
			const op = await rpcAddFlow(io.select, io.input, sessionIdCounter);
			if (op !== undefined) {
				ops.push(op);
			}
			continue;
		}

		// 选择了一条现有规则 → edit 模式
		await handleRpcRuleSelection(io, listChoice, ruleLabels, currentRules, ops);
	}
}

/**
 * RPC 循环编辑：list → action select → fill input → ... 直到 Done / cancel。
 *
 * G16：每次 op 后 listOptions 更新（反映前序操作）。
 */
export async function editViaRpc(
	ctx: RuleEditorContext,
	initialRules: readonly Rule[],
	sessionIdCounter: () => string,
): Promise<RuleEditorResult> {
	const io: RpcIo = {
		select: ctx.ui.select,
		input: resolveRpcInput(ctx),
	};
	return await runRpcLoop(io, initialRules, sessionIdCounter);
}

/** RPC add flow：选模板 → fill。 */
async function rpcAddFlow(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	input: (title: string, placeholder?: string) => Promise<string | undefined>,
	sessionIdCounter: () => string,
): Promise<RuleOp | undefined> {
	const templateLabels = ALL_TEMPLATES.map((t) => t.label);
	const templateChoice = await select("[pi-permission] Select template", templateLabels);
	if (templateChoice === undefined) return undefined;

	const template = ALL_TEMPLATES.find((t) => t.label === templateChoice);
	if (template === undefined) return undefined;

	const selections: Record<string, string | undefined> = {};

	if (template.id === "custom") {
		// custom: pattern + action + tool + description
		const pattern = await input("[pi-permission] Pattern (wildcard, e.g. 'npm *')", "npm *");
		if (pattern === undefined) return undefined;
		selections.pattern = pattern;

		const actionChoice = await select("[pi-permission] Action", ["allow", "deny", "ask"]);
		if (actionChoice === undefined) return undefined;
		selections.action = actionChoice;

		selections.tool = "bash"; // G9
		const desc = await input("[pi-permission] Description (optional)", "");
		selections.description = desc || undefined;
	} else {
		// 非 custom：选命令（带搜索）
		const cmdResult = await rpcSelectCommand(select, input);
		if (cmdResult === undefined) return undefined;
		selections.cmd = cmdResult;

		// 选择范围：整个命令家族 / 特定子命令
		if (template.id !== "allow-family" && template.id !== "ask-before") {
			// deny-family / allow-subcmd：需要选子命令
			const scopeChoice = await select(`[pi-permission] Select scope for ${cmdResult}`, [
				`${cmdResult} * (all subcommands)`,
				`${cmdResult} <subcommand> * (specific)`,
			]);
			if (scopeChoice === undefined) return undefined;

			if (scopeChoice.includes("<subcommand>")) {
				const subcmd = await input("[pi-permission] Enter subcommand name", "");
				if (subcmd === undefined || subcmd.trim().length === 0) return undefined;
				selections.subcmd = subcmd.trim();
			} else {
				selections.subcmd = "__any__";
			}
		}
	}

	const built = template.build(selections);
	const ruleId = sessionIdCounter(); // G13：立即赋值
	const rule: Rule = { id: ruleId, ...built };
	return { kind: "add", rule };
}

/** RPC 命令选择（带搜索） */
async function rpcSelectCommand(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	input: (title: string, placeholder?: string) => Promise<string | undefined>,
): Promise<string | undefined> {
	// 先问用户是否要搜索
	const modeChoice = await select("[pi-permission] How to select command?", [
		"[Browse list]",
		"[Type to search]",
	]);
	if (modeChoice === undefined) return undefined;

	if (modeChoice === "[Type to search]") {
		// 直接输入命令名
		const cmd = await input("[pi-permission] Enter command name", "");
		if (cmd === undefined || cmd.trim().length === 0) return undefined;
		return cmd.trim();
	}

	// 浏览列表
	const cmdOptions = [...PRESET_COMMANDS.map((c) => c.label), "[Other]"];
	const cmdChoice = await select("[pi-permission] Select command", cmdOptions);
	if (cmdChoice === undefined) return undefined;

	if (cmdChoice === "[Other]") {
		const cmd = await input("[pi-permission] Enter command name", "");
		if (cmd === undefined || cmd.trim().length === 0) return undefined;
		return cmd.trim();
	}

	const preset = PRESET_COMMANDS.find((c) => c.label === cmdChoice);
	return preset?.cmd ?? cmdChoice;
}

/** RPC edit flow：仅支持删除已有规则（Delete / Cancel，不支持改字段）。 */
async function rpcEditFlow(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	_input: (title: string, placeholder?: string) => Promise<string | undefined>,
	existingRule: Rule,
): Promise<RuleOp | undefined> {
	const actionChoice = await select(`[pi-permission] Edit rule: ${existingRule.pattern}`, [
		"[Delete this rule]",
		"[Cancel]",
	]);
	if (actionChoice === undefined || actionChoice === "[Cancel]") return undefined;
	if (actionChoice === "[Delete this rule]") {
		return { kind: "delete", id: existingRule.id };
	}
	return undefined;
}
