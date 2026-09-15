/**
 * W8: RuleEditorComponent — TUI overlay for CRUD rule editing.
 *
 * 3-stage state machine（list/add/fill），Container override handleInput 委托。
 * G1：list → add → fill（无 delete-confirm，fill edit 模式底部 [Delete this rule]）。
 * G2：currentListRules = applyOps(initialRules, ops)，实时反映 ops。
 * G4：pattern 用 wildcard（`npm *`），不用正则。
 * G8：build 不生成 id。
 * G9：tool 只列 bash。
 * G13：sessionIdCounter 立即赋值真实 id。
 * WR8：focusIndex 以 customChildren.length 为模（New 模式 5 项、Edit 模式 6 项 Tab 循环）。
 */

import { type Component, Container, Input, isFocusable, type SelectItem, SelectList, type SelectListTheme, truncateToWidth } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import {
	ALL_TEMPLATES,
	applyOps,
	PRESET_COMMANDS,
	type RuleOp,
	type RuleTemplate,
	type TemplateSelections,
} from "./rule-templates.js";
import type { PermissionAction, Rule } from "./types.js";
import { DEFAULT_SELECT_THEME } from "./select-theme.js";

const MAX_VISIBLE = 12;

/** box 边框左右各占用 1 列（│ × 2）。 */
const BORDER_OVERHEAD = 2;

/** custom form 焦点指示前缀（▶ + 空格，1 显示列 + 1 空格）。 */
const FOCUS_INDICATOR_PREFIX = "\u25B6 ";

/** scope 选择：all/subcmd 二选一全可见。 */
const SCOPE_LIST_MAX_VISIBLE = 2;
/** action 选择：allow/deny/ask 三选一全可见。 */
const ACTION_LIST_MAX_VISIBLE = 3;
/** submit 选择：Submit/Cancel 二选一全可见。 */
const SUBMIT_LIST_MAX_VISIBLE = 2;

// ──────────────────────── TextLines component ────────────────────────

class TextLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {
		// no-op
	}
}

// ──────────────────────── Stage types ────────────────────────

type Stage = "list" | "add" | "fill";

/** fill stage 子类型（按模板分支）。 */
type FillKind =
	| "command-select" // allow-family / ask-before：命令选择 → commitFill
	| "deny-family" // deny-family：命令 → 子命令 → commitFill
	| "allow-subcmd" // allow-subcmd：命令 → Input 子命令 → commitFill
	| "custom"; // custom：5 项 form + Tab 焦点

// ──────────────────────── RuleEditorComponent ────────────────────────

/**
 * TUI overlay 组件：规则 CRUD 编辑器。
 *
 * Container override handleInput（W7 模式）：按 stage 委托给当前子组件。
 * settle 用 _resolved 守卫防二次 done。
 */
export class RuleEditorComponent extends Container {
	private stage: Stage = "list";
	private readonly initialRules: readonly Rule[];
	private readonly sessionIdCounter: () => string;
	private readonly done: (ops: RuleOp[]) => void;
	private readonly theme: SelectListTheme;
	private _resolved = false;

	/** 累积的操作列表（add/edit/delete）。 */
	ops: RuleOp[] = [];

	/** 当前活跃子组件引用（用于 handleInput 委托）。 */
	private currentList: SelectList | null = null;
	private currentInput: Input | null = null;

	/** fill stage 状态。 */
	private fillKind: FillKind = "command-select";
	private fillTemplate: RuleTemplate | null = null;
	private fillEditMode = false;
	private fillEditRuleId: string | null = null;
	private fillSelections: TemplateSelections = {};

	/** deny-family 子阶段：'cmd' = 选命令，'subcmd' = 选子命令。 */
	private denySubStage: "cmd" | "subcmd" = "cmd";

	/** Custom form 焦点索引（WR8：Tab 循环以 customChildren.length 为模）。 */
	private customFocusIndex = 0;
	private customChildren: Component[] = [];

	/** 搜索状态（command-select 界面）。 */
	private _searchInput: Input | null = null;
	private _commandList: SelectList | null = null;
	private _searchFocus = false; // true = 搜索框获焦，false = 列表获焦

	constructor(
		initialRules: readonly Rule[],
		sessionIdCounter: () => string,
		done: (ops: RuleOp[]) => void,
		theme: SelectListTheme = DEFAULT_SELECT_THEME,
	) {
		super();
		this.initialRules = initialRules;
		this.sessionIdCounter = sessionIdCounter;
		this.done = done;
		this.theme = theme;
		this.switchToListStage();
	}

	// ──────────────────────── 边框渲染 ────────────────────────

	override render(width: number): string[] {
		const innerWidth = Math.max(0, width - BORDER_OVERHEAD);
		let inner = super.render(innerWidth);

		// custom form 焦点指示（M4）：当前焦点字段的标签加 ▶ 前缀
		if (this.stage === "fill" && this.fillKind === "custom") {
			inner = this._injectFocusIndicator(inner);
		}

		const lines: string[] = [];
		lines.push(`\u250C${"\u2500".repeat(innerWidth)}\u2510`);
		for (const line of inner) {
			const padded = truncateToWidth(line, innerWidth, "", true);
			lines.push(`\u2502${padded}\u2502`);
		}
		lines.push(`\u2514${"\u2500".repeat(innerWidth)}\u2518`);
		return lines;
	}

	/**
	 * 在 custom form 渲染输出中给当前焦点字段的标签行加 ▶ 前缀（M4）。
	 *
	 * TextLines.render 输出原始未 padding 的标签行，故可精确匹配。
	 * 字段标签（与 startFillCustom 里 addChild 的 TextLines 一致）：
	 *   customFocusIndex 0 → "Pattern (wildcard, e.g. 'npm *')"
	 *   customFocusIndex 1 → "Action"
	 *   customFocusIndex 2 → "Tool"
	 *   customFocusIndex 3 → "Description (optional)"
	 *   index 4 (Submit) / 5 (Delete) 为 SelectList，无文字标签，不处理。
	 */
	private _injectFocusIndicator(lines: string[]): string[] {
		const fieldLabels = [
			"Pattern (wildcard, e.g. 'npm *')", // index 0
			"Action", // index 1
			"Tool", // index 2
			"Description (optional)", // index 3
		];
		const focusedLabel = fieldLabels[this.customFocusIndex];
		if (focusedLabel === undefined) return lines; // Submit/Delete 焦点：不加标记

		return lines.map((line) => {
			// 精确匹配当前焦点标签 → 加 ▶ 前缀
			if (line === focusedLabel) {
				return FOCUS_INDICATOR_PREFIX + line;
			}
			// 焦点已转移：去掉其他标签行残留的 ▶ 前缀（避免重复渲染累积）
			if (line.startsWith(FOCUS_INDICATOR_PREFIX) && fieldLabels.includes(line.slice(FOCUS_INDICATOR_PREFIX.length))) {
				return line.slice(FOCUS_INDICATOR_PREFIX.length);
			}
			return line;
		});
	}

	// ──────────────────────── handleInput override（Container 无 handleInput，必须新增） ────────────────────────

	handleInput(data: string): void {
		// Custom form：Tab 焦点路由（WR8）
		if (this.stage === "fill" && this.fillKind === "custom") {
			if (matchesKey(data, "tab")) {
				// ES2 修复：以 customChildren.length 为模，避免硬编码与实际 children 数量不一致。
				// New 模式 5 项（pattern/action/tool/desc/submit），Edit 模式 6 项（+delete）。
				const maxIndex = this.customChildren.length;
				if (maxIndex === 0) return; // 防御：无子组件时不循环
				this.customFocusIndex = (this.customFocusIndex + 1) % maxIndex;
				this.syncCustomFocus();
				this.invalidate();
				return;
			}
			// 委托给当前 focused 子组件
			const child = this.customChildren[this.customFocusIndex];
			if (child !== undefined && child.handleInput !== undefined) {
				child.handleInput(data);
			}
			return;
		}

		// command-select 界面：Tab 切换搜索框 ↔ 列表
		if (this.stage === "fill" && this._searchInput !== null && this._commandList !== null) {
			if (matchesKey(data, "tab")) {
				this._searchFocus = !this._searchFocus;
				this._searchInput.focused = this._searchFocus;
				this.invalidate();
				return;
			}
			// 根据焦点委托
			if (this._searchFocus) {
				// 搜索框获焦：输入字符时实时过滤列表
				this._searchInput.handleInput(data);
				// onSubmit（Enter）可能在 handleInput 内触发 stage 转换
				// （_resetStageRefs 会清 _searchInput），此时本轮渲染已由转换处理，直接返回。
				if (this._searchInput === null) return;
				// 使用 SelectList.setFilter 过滤
				const query = this._searchInput.getValue();
				this._commandList.setFilter(query);
				this.invalidate();
				return;
			}
			// 列表获焦
			this._commandList.handleInput(data);
			return;
		}

		// 独立 Input 组件（startCommandInput / startSubcmdInput）
		if (this.stage === "fill" && this.currentInput !== null) {
			this.currentInput.handleInput(data);
			return;
		}

		// 非 custom form：委托给当前 active 组件
		this.currentList?.handleInput(data);
	}

	/** 退出（外部 abort 用）。 */
	cancel(): void {
		this.settle();
	}

	/** settle：_resolved 守卫 + done(this.ops)。 */
	private settle(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done(this.ops);
	}

	/**
	 * 集中清理子组件引用（C3 根因修复）。
	 *
	 * Container.clear() 只清 children 数组，不清组件引用字段。
	 * 每个 switchTo* 或 startFill* 方法在 this.clear() 之后必须调用本方法，
	 * 杜绝手动清理遗漏导致的输入路由死锁（C1）。
	 *
	 * 注意：不清业务状态字段（fillKind/fillEditMode/fillEditRuleId/fillSelections/
	 * fillTemplate/denySubStage/customFocusIndex）——这些由各自的 enter*Mode 方法显式设置。
	 */
	private _resetStageRefs(): void {
		this._searchInput = null;
		this._commandList = null;
		this._searchFocus = false;
		this.currentInput = null;
		this.currentList = null;
		this.customChildren = [];
	}

	/** currentListRules = applyOps(initialRules, ops)（G2：实时反映 ops）。 */
	currentListRules(): Rule[] {
		return applyOps([...this.initialRules], this.ops);
	}

	// ──────────────────────── list stage ────────────────────────

	private switchToListStage(): void {
		this.stage = "list";
		this.clear();
		this._resetStageRefs();
		this.currentList = this.buildListStage();
		this.addChild(new TextLines(["[pi-permission] Permission Rules", ""]));
		this.addChild(this.currentList);
	}

	private buildListStage(): SelectList {
		const rules = this.currentListRules();
		const items: SelectItem[] = [];

		for (const rule of rules) {
			const desc = rule.description ?? rule.pattern;
			items.push({
				value: `rule:${rule.id}`,
				label: `[${rule.action}] ${rule.pattern}`,
				description: desc,
			});
		}

		items.push({ value: "__add__", label: "[+ Add rule]", description: "Add a new permission rule" });
		items.push({ value: "__done__", label: "[Done]", description: "Save and exit" });

		const list = new SelectList(items, MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__add__") {
				this.switchToAddStage();
				return;
			}
			if (item.value === "__done__") {
				this.settle();
				return;
			}
			// 进入 edit 模式
			const ruleId = item.value.replace(/^rule:/, "");
			this.enterFillEditMode(ruleId);
		};
		list.onCancel = (): void => {
			this.settle();
		};
		return list;
	}

	// ──────────────────────── add stage ────────────────────────

	private switchToAddStage(): void {
		this.stage = "add";
		this.clear();
		this._resetStageRefs();
		const items: SelectItem[] = ALL_TEMPLATES.map((t) => ({
			value: t.id,
			label: t.label,
			description: t.description,
		}));
		const list = new SelectList(items, MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			const template = ALL_TEMPLATES.find((t) => t.id === item.value);
			if (template !== undefined) {
				this.enterFillNewMode(template);
			}
		};
		list.onCancel = (): void => {
			this.switchToListStage();
		};
		this.currentList = list;
		this.addChild(new TextLines(["[pi-permission] Add Rule — Select Template", ""]));
		this.addChild(list);
	}

	// ──────────────────────── fill stage ────────────────────────

	private enterFillNewMode(template: RuleTemplate): void {
		this._resetStageRefs();
		this.fillTemplate = template;
		this.fillEditMode = false;
		this.fillEditRuleId = null;
		this.fillSelections = {};
		this.startFillForTemplate(template);
	}

	private enterFillEditMode(ruleId: string): void {
		this._resetStageRefs();
		const rules = this.currentListRules();
		const rule = rules.find((r) => r.id === ruleId);
		if (rule === undefined) {
			this.switchToListStage();
			return;
		}
		this.fillEditMode = true;
		this.fillEditRuleId = ruleId;
		this.fillSelections = {
			pattern: rule.pattern,
			action: rule.action,
			tool: rule.tool,
			description: rule.description,
		};
		// edit 模式走 custom form（用户可编辑所有字段）
		this.startFillCustom();
	}

	private startFillForTemplate(template: RuleTemplate): void {
		switch (template.id) {
			case "allow-family":
			case "ask-before":
				this.startFillCommandSelect("command-select");
				break;
			case "deny-family":
				this.denySubStage = "cmd";
				this.startFillDenyFamily();
				break;
			case "allow-subcmd":
				this.startFillAllowSubcmd();
				break;
			case "custom":
				this.startFillCustom();
				break;
			default:
				this.switchToListStage();
		}
	}

	// ── command-select（allow-family / ask-before）带搜索 ──

	private startFillCommandSelect(kind: FillKind): void {
		this.stage = "fill";
		this.fillKind = kind;
		this.clear();
		this._resetStageRefs();

		// 搜索输入框
		const searchInput = new Input();
		searchInput.setValue("");
		this.currentInput = searchInput;
		this._searchInput = searchInput;
		this._searchFocus = true; // 默认焦点在搜索框

		// 命令列表（初始显示全部）
		const allItems = this.buildPresetCommandItemsWithOther();
		const list = new SelectList(allItems, MAX_VISIBLE, this.theme);
		this.currentList = list;
		this._commandList = list;

		// 搜索输入变化时过滤列表
		searchInput.onSubmit = (val: string): void => {
			// Enter 在搜索框中 = 选择第一个匹配项或进入手动输入
			const filtered = this._filterCommands(allItems, val.trim());
			if (filtered.length === 0 || (filtered.length === 1 && filtered[0]?.value === "__other__")) {
				// 无匹配 → 进入手动输入
				this.startCommandInput();
				return;
			}
			// 有匹配 → 选中第一个（非 Other）
			const firstMatch = filtered.find((i) => i.value !== "__other__");
			if (firstMatch !== undefined) {
				this.onCommandSelected(firstMatch.value);
			}
		};
		searchInput.onEscape = (): void => {
			this.switchToListStage();
		};

		// 列表选择
		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__other__") {
				this.startCommandInput();
				return;
			}
			this.onCommandSelected(item.value);
		};
		list.onCancel = (): void => {
			this.switchToListStage();
		};

		// 渲染
		this.addChild(new TextLines(["[pi-permission] Select command", ""]));
		this.addChild(new TextLines(["Type to search · Tab to switch focus · Enter to select"]));
		this.addChild(searchInput);
		this.addChild(list);
	}

	/** 命令选中后：弹出子命令/全选 选择 */
	private onCommandSelected(cmd: string): void {
		// 弹出选择：整个命令家族 / 特定子命令
		this.clear();
		this._resetStageRefs();

		const scopeItems: SelectItem[] = [
			{ value: "__all__", label: `${cmd} * (all subcommands)`, description: `Allow/deny all invocations of ${cmd}` },
			{ value: "__subcmd__", label: `${cmd} <subcommand> *`, description: `Allow/deny a specific subcommand` },
		];
		const list = new SelectList(scopeItems, SCOPE_LIST_MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__all__") {
				this.fillSelections.cmd = cmd;
				this.commitFill();
			} else {
				// 进入子命令输入
				this.fillSelections.cmd = cmd;
				this.startSubcmdInput();
			}
		};
		list.onCancel = (): void => {
			// 返回命令选择
			this.startFillCommandSelect(this.fillKind);
		};
		this.currentList = list;
		this.addChild(new TextLines(["[pi-permission] Select scope for " + cmd, ""]));
		this.addChild(list);
	}

	/** 构建命令列表 + Other（在顶部） */
	private buildPresetCommandItemsWithOther(): SelectItem[] {
		const items: SelectItem[] = [
			{ value: "__other__", label: "[Type command manually]", description: "Tab here to type a custom command" },
		];
		for (const cmd of PRESET_COMMANDS) {
			items.push({
				value: cmd.cmd,
				label: `${cmd.cmd} — ${cmd.category}`,
				description: cmd.label,
			});
		}
		return items;
	}

	/** 过滤命令列表（Enter 时检查匹配用）。startsWith 与 SelectList.setFilter 一致（M5）。 */
	private _filterCommands(items: SelectItem[], query: string): SelectItem[] {
		if (query.length === 0) return items;
		const lower = query.toLowerCase();
		return items.filter((item) => {
			if (item.value === "__other__") return true; // 始终保留 Other
			return item.value.toLowerCase().startsWith(lower) || item.label.toLowerCase().startsWith(lower);
		});
	}

	// ── deny-family（命令 → 子命令）──

	private startFillDenyFamily(): void {
		this.stage = "fill";
		this.fillKind = "deny-family";
		this.clear();
		this._resetStageRefs();

		if (this.denySubStage === "cmd") {
			// 带搜索的命令选择
			const searchInput = new Input();
			searchInput.setValue("");
			this.currentInput = searchInput;
			this._searchInput = searchInput;
			this._searchFocus = true;

			const allItems = this.buildPresetCommandItemsWithOther();
			const list = new SelectList(allItems, MAX_VISIBLE, this.theme);
			this.currentList = list;
			this._commandList = list;

			searchInput.onSubmit = (val: string): void => {
				const filtered = this._filterCommands(allItems, val.trim());
				if (filtered.length === 0 || (filtered.length === 1 && filtered[0]?.value === "__other__")) {
					this.startCommandInput("deny-cmd");
					return;
				}
				const firstMatch = filtered.find((i) => i.value !== "__other__");
				if (firstMatch !== undefined) {
					this.fillSelections.cmd = firstMatch.value;
					this.denySubStage = "subcmd";
					this.startFillDenyFamily();
				}
			};
			searchInput.onEscape = (): void => {
				this.switchToListStage();
			};

			list.onSelect = (item: SelectItem): void => {
				if (item.value === "__other__") {
					this.startCommandInput("deny-cmd");
					return;
				}
				this.fillSelections.cmd = item.value;
				this.denySubStage = "subcmd";
				this.startFillDenyFamily();
			};
			list.onCancel = (): void => {
				this.switchToListStage();
			};

			this.addChild(new TextLines(["[pi-permission] Deny — Select command", ""]));
			this.addChild(new TextLines(["Type to search · Tab to switch focus · Enter to select"]));
			this.addChild(searchInput);
			this.addChild(list);
		} else {
			// subcmd 阶段
			const items: SelectItem[] = [
				{ value: "__any__", label: "[Any subcommand]", description: "Deny all subcommands of this command" },
				{ value: "__specific__", label: "[Specific subcommand]", description: "Deny a specific subcommand" },
			];
			const list = new SelectList(items, MAX_VISIBLE, this.theme);
			list.onSelect = (item: SelectItem): void => {
				if (item.value === "__any__") {
					this.fillSelections.subcmd = "__any__";
					this.commitFill();
					return;
				}
				// specific → Input
				this.startSubcmdInput();
			};
			list.onCancel = (): void => {
				// 回到 cmd 选择
				this.denySubStage = "cmd";
				this.startFillDenyFamily();
			};
			this.currentList = list;
			this.addChild(new TextLines([`[pi-permission] Deny ${this.fillSelections.cmd ?? "?"} — Select scope`, ""]));
			this.addChild(list);
		}
	}

	// ── allow-subcmd（命令 → Input 子命令）──

	private startFillAllowSubcmd(): void {
		this.stage = "fill";
		this.fillKind = "allow-subcmd";
		this.clear();
		this._resetStageRefs();

		// 带搜索的命令选择
		const searchInput = new Input();
		searchInput.setValue("");
		this.currentInput = searchInput;
		this._searchInput = searchInput;
		this._searchFocus = true;

		const allItems = this.buildPresetCommandItemsWithOther();
		const list = new SelectList(allItems, MAX_VISIBLE, this.theme);
		this.currentList = list;
		this._commandList = list;

		searchInput.onSubmit = (val: string): void => {
			const filtered = this._filterCommands(allItems, val.trim());
			if (filtered.length === 0 || (filtered.length === 1 && filtered[0]?.value === "__other__")) {
				this.startCommandInput("allow-subcmd-cmd");
				return;
			}
			const firstMatch = filtered.find((i) => i.value !== "__other__");
			if (firstMatch !== undefined) {
				this.fillSelections.cmd = firstMatch.value;
				this.startSubcmdInput();
			}
		};
		searchInput.onEscape = (): void => {
			this.switchToListStage();
		};

		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__other__") {
				this.startCommandInput("allow-subcmd-cmd");
				return;
			}
			this.fillSelections.cmd = item.value;
			this.startSubcmdInput();
		};
		list.onCancel = (): void => {
			this.switchToListStage();
		};

		this.addChild(new TextLines(["[pi-permission] Allow subcommand — Select command", ""]));
		this.addChild(new TextLines(["Type to search · Tab to switch focus · Enter to select"]));
		this.addChild(searchInput);
		this.addChild(list);
	}

	// ── custom form（5 项 Tab 焦点，WR8）──

	private startFillCustom(): void {
		this.stage = "fill";
		this.fillKind = "custom";
		this.clear();
		this._resetStageRefs();
		this.customFocusIndex = 0;

		// 1. pattern Input
		const patternInput = new Input();
		patternInput.setValue(this.fillSelections.pattern ?? "");
		patternInput.onSubmit = (val: string): void => {
			this.fillSelections.pattern = val;
		};
		patternInput.onEscape = (): void => {
			this.switchToListStage();
		};

		// 2. action SelectList
		const actionItems: SelectItem[] = [
			{ value: "allow", label: "allow" },
			{ value: "deny", label: "deny" },
			{ value: "ask", label: "ask" },
		];
		const actionList = new SelectList(actionItems, ACTION_LIST_MAX_VISIBLE, this.theme);
		actionList.onSelect = (item: SelectItem): void => {
			this.fillSelections.action = item.value as PermissionAction;
		};
		actionList.onCancel = (): void => {
			this.switchToListStage();
		};
		// 预选当前 action
		if (this.fillSelections.action !== undefined) {
			const idx = actionItems.findIndex((a) => a.value === this.fillSelections.action);
			if (idx >= 0) actionList.setSelectedIndex(idx);
		}

		// 3. tool SelectList（G9：只列 bash）
		const toolItems: SelectItem[] = [{ value: "bash", label: "bash" }];
		const toolList = new SelectList(toolItems, 1, this.theme);
		toolList.onSelect = (item: SelectItem): void => {
			this.fillSelections.tool = item.value;
		};
		toolList.onCancel = (): void => {
			this.switchToListStage();
		};

		// 4. description Input
		const descInput = new Input();
		descInput.setValue(this.fillSelections.description ?? "");
		descInput.onSubmit = (val: string): void => {
			this.fillSelections.description = val || undefined;
		};

		// 5. Submit SelectList
		const submitItems: SelectItem[] = [
			{ value: "__submit__", label: "[Submit]" },
			{ value: "__cancel__", label: "[Cancel]" },
		];
		const submitList = new SelectList(submitItems, SUBMIT_LIST_MAX_VISIBLE, this.theme);
		submitList.onSelect = (item: SelectItem): void => {
			if (item.value === "__submit__") {
				this.commitFill();
			} else {
				this.switchToListStage();
			}
		};
		submitList.onCancel = (): void => {
			this.switchToListStage();
		};

		this.customChildren = [patternInput, actionList, toolList, descInput, submitList];

		// 组装 UI
		const title = this.fillEditMode ? "Edit Rule (Tab to switch fields)" : "Custom Rule (Tab to switch fields)";
		this.addChild(new TextLines([`[pi-permission] ${title}`, ""]));
		this.addChild(new TextLines(["Pattern (wildcard, e.g. 'npm *')"]));
		this.addChild(patternInput);
		this.addChild(new TextLines(["Action"]));
		this.addChild(actionList);
		this.addChild(new TextLines(["Tool"]));
		this.addChild(toolList);
		this.addChild(new TextLines(["Description (optional)"]));
		this.addChild(descInput);
		this.addChild(new TextLines([""]));
		this.addChild(submitList);

		// edit 模式：底部加 [Delete this rule]
		if (this.fillEditMode && this.fillEditRuleId !== null) {
			const deleteItems: SelectItem[] = [{ value: "__delete__", label: "[Delete this rule]" }];
			const deleteList = new SelectList(deleteItems, 1, this.theme);
			deleteList.onSelect = (): void => {
				this.ops.push({ kind: "delete", id: this.fillEditRuleId! });
				this.switchToListStage();
			};
			deleteList.onCancel = (): void => {
				this.switchToListStage();
			};
			this.addChild(new TextLines([""]));
			this.addChild(deleteList);
			// 添加到 customChildren 以便 Tab 切换
			this.customChildren.push(deleteList);
		}

		this.syncCustomFocus();
	}

	// ── command Input（Other → 手动输入命令名）──

	private startCommandInput(returnTo?: string): void {
		this.clear();
		this._resetStageRefs();
		const input = new Input();
		input.focused = true;
		input.onSubmit = (val: string): void => {
			const cmd = val.trim();
			if (cmd.length > 0) {
				this.fillSelections.cmd = cmd;
				if (returnTo === "deny-cmd") {
					this.denySubStage = "subcmd";
					this.startFillDenyFamily();
				} else if (returnTo === "allow-subcmd-cmd") {
					this.startSubcmdInput();
				} else {
					this.commitFill();
				}
			}
		};
		input.onEscape = (): void => {
			this.switchToListStage();
		};
		this.currentInput = input;
		this.addChild(new TextLines(["[pi-permission] Enter command name", ""]));
		this.addChild(input);
	}

	// ── subcmd Input ──

	private startSubcmdInput(): void {
		this.clear();
		this._resetStageRefs();
		const input = new Input();
		input.focused = true;
		input.onSubmit = (val: string): void => {
			const subcmd = val.trim();
			if (subcmd.length > 0) {
				this.fillSelections.subcmd = subcmd;
				this.commitFill();
			}
		};
		input.onEscape = (): void => {
			this.switchToListStage();
		};
		this.currentInput = input;
		this.addChild(new TextLines(["[pi-permission] Enter subcommand name", ""]));
		this.addChild(input);
	}

	// ──────────────────────── commitFill ────────────────────────

	/** 提交当前 fill 结果：build rule + 赋 id + push op。 */
	private commitFill(): void {
		this._syncCustomFormValues(); // 兜底刷新 Input 值（M2 修复）

		// edit 模式：直接构造 Rule，绕过 fillTemplate.build（M1 修复）。
		// enterFillEditMode 走 custom form 但从不设置 fillTemplate，故 fillTemplate 为 null，
		// 旧逻辑会在 fillTemplate === null 时提前 switchToListStage()，导致 edit 永不落盘。
		if (this.fillEditMode && this.fillEditRuleId !== null) {
			const pattern = (this.fillSelections.pattern && this.fillSelections.pattern.trim()) || "*";
			const rule: Rule = {
				id: this.fillEditRuleId,
				pattern,
				action: this.fillSelections.action ?? "ask",
				tool: this.fillSelections.tool ?? "bash",
				source: "user",
				description: this.fillSelections.description,
			};
			this.ops.push({ kind: "edit", id: this.fillEditRuleId, rule });
			this.switchToListStage();
			return;
		}

		// new 模式：走 fillTemplate.build
		if (this.fillTemplate === null) {
			this.switchToListStage();
			return;
		}
		const built = this.fillTemplate.build(this.fillSelections);
		const ruleId = this.sessionIdCounter(); // G13：立即赋值
		const rule: Rule = {
			id: ruleId,
			...built,
		};
		this.ops.push({ kind: "add", rule });
		this.switchToListStage();
	}

	/**
	 * 兜底同步 custom form 的 Input 值到 fillSelections（M2 修复）。
	 *
	 * pi-tui Input.onSubmit 仅在 Enter 时触发，用户按 Tab 切换焦点不会触发 onSubmit。
	 * 本方法在 commitFill 入口调用，确保 Tab 后 Submit 的数据不丢失。
	 *
	 * customChildren index 约定（见 startFillCustom）：
	 *   [0]=patternInput, [1]=actionList, [2]=toolList, [3]=descInput, [4]=submitList[, 5]=deleteList
	 * SelectList（action/tool）的 onSelect 已实时更新 fillSelections，无需在此同步。
	 */
	private _syncCustomFormValues(): void {
		const patternInput = this.customChildren[0];
		if (patternInput instanceof Input) {
			this.fillSelections.pattern = patternInput.getValue();
		}
		const descInput = this.customChildren[3];
		if (descInput instanceof Input) {
			const desc = descInput.getValue();
			this.fillSelections.description = desc || undefined;
		}
	}

	// ──────────────────────── 辅助 ────────────────────────

	/** 同步 Custom form 焦点标志（Input.focused + rerender）。 */
	private syncCustomFocus(): void {
		for (let i = 0; i < this.customChildren.length; i++) {
			const child = this.customChildren[i];
			if (child !== undefined && isFocusable(child)) {
				child.focused = i === this.customFocusIndex;
			}
		}
	}
}
