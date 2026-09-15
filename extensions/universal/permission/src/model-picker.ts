/**
 * W7：/permission model overlay 选择器。
 *
 * 两级 TUI 选择：
 *  - 第一级（provider stage）：列出 'Auto' + 所有可用 provider（listAvailableModels）
 *  - 第二级（model stage）：选中具体 provider 后，列出该 provider 下的 model（按 provider + id 字典序）
 *  - 选 'Auto' 或具体 provider/model → done(SelectionResult)；Esc 回退 / 取消
 *
 * 三模式分发（pickModelViaOverlay）：
 *  - tui：ctx.ui.custom（ProviderModelSelectorComponent，overlay）。custom 的 factory 接收
 *    done 回调，comp 内部 onSelect/onCancel 最终调 done（参考 approval.ts ApprovalComponent）。
 *  - rpc：两次 ctx.ui.select（provider 含 auto，model）
 *  - headless（json/print）：返回 undefined（无交互 UI，降级）
 *
 * 关键设计：
 *  - ProviderModelSelectorComponent extends Container：Container 无 handleInput，必须 override
 *    委托给当前 stage 的 SelectList（WC9/WC15 critical）。
 *  - stage 切换用 clear() + addChild 重建（两态状态机）。
 *  - _resolved 守卫防二次 done（switchToModelStage 等异步路径可能重复触发）。
 */

import { type Component, Container, type SelectItem, SelectList, type SelectListTheme, truncateToWidth } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseModelRef } from "@zhushanwen/pi-llm-shared";

import type { ResolvedModelEntry } from "./classifier/model-resolver.js";
import { DEFAULT_SELECT_THEME } from "./select-theme.js";

// ──────────────────────── 类型 ────────────────────────

/** 选择结果（discriminated union）；undefined = cancel / 降级。 */
export type SelectionResult =
	| { kind: "auto" }
	| { kind: "specific"; provider: string; modelId: string };

/** provider stage 的 'auto' 项 value（用特殊标记区分真实 provider 名）。 */
const AUTO_VALUE = "__auto__";

/** SelectList 最大可见行数（picker overlay 不超过终端高度）。 */
const MAX_VISIBLE_ITEMS = 10;

/** box 边框左右各占用 1 列（│ × 2）。 */
const BORDER_OVERHEAD = 2;

// ──────────────────────── 辅助组件（inline Component stub，避免依赖 Box 的 padding/bg） ────────────────────────

/**
 * 最小 inline Component：渲染固定文本行（title / hint）。
 * Container 不要求 children 有 handleInput，只要 render + invalidate。
 */
class TextLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {
		// 无缓存，no-op
	}
}

// ──────────────────────── ProviderModelSelectorComponent ────────────────────────

/**
 * 两级 TUI 选择组件（provider → model）。
 *
 * 状态机：
 *  - stage='provider'：SelectList 列出 'Auto' + providers
 *  - stage='model'：SelectList 列出所选 provider 的 models
 *
 * 切换：clear() + addChild 重建（两态，无回退栈，model stage Esc 回退到 provider stage）。
 *
 * WC9/WC15 critical：Container 没有 handleInput，必须 override 委托给当前 stage 的 SelectList。
 * 测试 WR1：直接调 comp.handleInput('\r') 验证 SelectList.onSelect 被触发（锁定键盘委托通路）。
 *
 * done 桥接：comp 构造时传入 done（由 ctx.ui.custom 的 factory 提供），内部 onSelect/onCancel
 * 最终调 done（参考 ApprovalComponent）。_resolved 守卫防二次 done。
 */
export class ProviderModelSelectorComponent extends Container {
	private stage: "provider" | "model" = "provider";
	private readonly currentSpec: string;
	private readonly providers: readonly string[];
	private readonly modelsByProvider: ReadonlyMap<string, readonly ResolvedModelEntry[]>;
	private readonly done: (result: SelectionResult | undefined) => void;
	private readonly theme: SelectListTheme;
	private _resolved = false;
	private currentList: SelectList | null = null;

	constructor(
		currentSpec: string,
		providers: readonly string[],
		modelsByProvider: ReadonlyMap<string, readonly ResolvedModelEntry[]>,
		done: (result: SelectionResult | undefined) => void,
		theme: SelectListTheme = DEFAULT_SELECT_THEME,
	) {
		super();
		this.currentSpec = currentSpec;
		this.providers = providers;
		this.modelsByProvider = modelsByProvider;
		this.done = done;
		this.theme = theme;
		this.switchToProviderStage();
	}

	/**
	 * Container 无 handleInput（Container implements Component 但未声明 handleInput），
	 * 必须在此声明委托给当前 stage 的 SelectList（WC9/WC15 critical）。
	 * 不能用 override（Container 未声明该方法），直接新增方法满足 Component 接口。
	 */
	handleInput(data: string): void {
		this.currentList?.handleInput(data);
	}

	/**
	 * 重写 render：用 box 边框包裹 Container 子组件的输出。
	 */
	override render(width: number): string[] {
		const innerWidth = Math.max(0, width - BORDER_OVERHEAD);
		const inner = super.render(innerWidth);
		const lines: string[] = [];
		lines.push(`\u250C${"\u2500".repeat(innerWidth)}\u2510`);
		for (const line of inner) {
			const padded = truncateToWidth(line, innerWidth, "", true);
			lines.push(`\u2502${padded}\u2502`);
		}
		lines.push(`\u2514${"\u2500".repeat(innerWidth)}\u2518`);
		return lines;
	}

	private settle(result: SelectionResult | undefined): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done(result);
	}

	// ──────────────────────── provider stage ────────────────────────

	private switchToProviderStage(): void {
		this.stage = "provider";
		this.clear();
		this.currentList = this.buildProviderList();
		this.addChild(this.buildTitleBox("Select Provider", this.formatProviderHint()));
		this.addChild(this.currentList);
	}

	/** 构建 provider stage 的 SelectList（title + list 由调用方组装）。 */
	private buildProviderList(): SelectList {
		const selectedIndex = this.computeProviderSelectedIndex();
		const items = this.buildProviderItems();
		const list = new SelectList(items, MAX_VISIBLE_ITEMS, this.theme);
		list.setSelectedIndex(selectedIndex);
		list.onSelect = (item: SelectItem): void => {
			if (item.value === AUTO_VALUE) {
				this.settle({ kind: "auto" });
				return;
			}
			this.switchToModelStage(item.value);
		};
		list.onCancel = (): void => {
			this.settle(undefined);
		};
		return list;
	}

	/** provider stage items：'Auto' + 各 provider（含 model 数量）。 */
	private buildProviderItems(): SelectItem[] {
		const items: SelectItem[] = [
			{ value: AUTO_VALUE, label: "Auto", description: "select first available model" },
		];
		for (const provider of this.providers) {
			const models = this.modelsByProvider.get(provider) ?? [];
			items.push({
				value: provider,
				label: provider,
				description: `${models.length} model(s)`,
			});
		}
		return items;
	}

	/**
	 * 计算 provider stage 预选 index（currentSpec='auto' → 0；'provider/model' → findIndex）。
	 * 无效 ref（缺 / 或前后为空，如 'provider/'）→ parseModelRef 返 null → 0（整体回 Auto，
	 * ext-simplify-18 D4 登记的行为微变：不再预选半截 provider）。
	 */
	private computeProviderSelectedIndex(): number {
		if (this.currentSpec === "auto") return 0;
		const parsed = parseModelRef(this.currentSpec);
		if (!parsed) return 0;
		const idx = this.providers.indexOf(parsed.provider);
		return idx >= 0 ? idx + 1 : 0; // +1 跳过 'Auto'
	}

	private formatProviderHint(): string {
		return `Current: ${this.currentSpec}  |  [Up/Down] navigate  [Enter] select  [Esc] cancel`;
	}

	// ──────────────────────── model stage ────────────────────────

	private switchToModelStage(provider: string): void {
		this.stage = "model";
		this.clear();
		const models = this.modelsByProvider.get(provider) ?? [];
		this.currentList = this.buildModelList(provider, models);
		this.addChild(this.buildTitleBox(`Select Model - ${provider}`, this.formatModelHint()));
		this.addChild(this.currentList);
	}

	/** 构建 model stage 的 SelectList（按 provider + id 字典序，由 listAvailableModels 保证）。 */
	private buildModelList(provider: string, models: readonly ResolvedModelEntry[]): SelectList {
		const items: SelectItem[] = models.map((m) => ({
			value: m.id,
			label: m.id,
			description: `api: ${m.api}`,
		}));
		const list = new SelectList(items, MAX_VISIBLE_ITEMS, this.theme);
		const preSelected = this.computeModelSelectedIndex(models);
		list.setSelectedIndex(preSelected);
		list.onSelect = (item: SelectItem): void => {
			this.settle({ kind: "specific", provider, modelId: item.value });
		};
		list.onCancel = (): void => {
			// Esc 退回 provider stage（不 settle）
			this.switchToProviderStage();
		};
		return list;
	}

	/** 计算 model stage 预选 index（无效 ref → parseModelRef 返 null → 0）。 */
	private computeModelSelectedIndex(models: readonly ResolvedModelEntry[]): number {
		const parsed = parseModelRef(this.currentSpec);
		if (!parsed) return 0;
		const idx = models.findIndex((m) => m.id === parsed.modelId);
		return idx >= 0 ? idx : 0;
	}

	private formatModelHint(): string {
		return "[Up/Down] navigate  [Enter] select  [Esc] back to provider list";
	}

	// ──────────────────────── title box（G4） ────────────────────────

	/**
	 * G4：title/hint box（含当前选中提示 + 键位提示）。
	 * 用 Container 包裹 TextLines（保持纯文本，不依赖 Box 的 padding/bg）。
	 */
	private buildTitleBox(title: string, hint: string): Container {
		const box = new Container();
		box.addChild(new TextLines([`[pi-permission] ${title}`]));
		box.addChild(new TextLines([hint, ""]));
		return box;
	}
}

// ──────────────────────── pickModelViaOverlay ────────────────────────

/** overlay 上下文（从 Pi ExtensionContext 提取的最小子集）。 */
export interface ModelPickerContext {
	mode: "tui" | "rpc" | "json" | "print";
	/** E2：listAvailableModels 数据源（model 列表 + auth 判定），结构兼容 ExtensionContext.modelRegistry */
	modelRegistry: {
		getAll(): Model<Api>[];
		hasConfiguredAuth(model: Model<Api>): boolean;
	};
	ui: {
		notify(msg: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
		custom<T = void>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
	};
}

/**
 * 通过 overlay 选择模型（provider/model 或 auto）。
 *
 * @param ctx UI 上下文（mode + ui.*）
 * @param currentSpec 当前 classifier.model（'auto' 或 'provider/model-id'），用于预选
 * @param models 可用模型 Map（listAvailableModels 产物，按 provider 分组；调用方判空降级）
 * @returns 'auto' / 'provider/model-id' / undefined（cancel 或 headless 降级）
 */
export async function pickModelViaOverlay(
	ctx: ModelPickerContext,
	currentSpec: string,
	models: Map<string, ResolvedModelEntry[]>,
): Promise<string | undefined> {
	if (models.size === 0) return undefined;

	const providers = [...models.keys()];

	switch (ctx.mode) {
		case "tui":
			return await pickViaTui(ctx, currentSpec, providers, models);
		case "rpc":
			return await pickViaRpc(ctx, currentSpec, providers, models);
		case "json":
		case "print":
		default:
			return undefined;
	}
}

// ──────────────────────── TUI 分支 ────────────────────────

/**
 * TUI 分支：ctx.ui.custom + ProviderModelSelectorComponent。
 * custom 的 factory 接收 done 回调；comp 内部 onSelect/onCancel 最终调 done。
 */
async function pickViaTui(
	ctx: ModelPickerContext,
	currentSpec: string,
	providers: readonly string[],
	modelsByProvider: ReadonlyMap<string, readonly ResolvedModelEntry[]>,
): Promise<string | undefined> {
	const result = await ctx.ui.custom<SelectionResult | undefined>(
		(_tui, _theme, _kb, done) => {
			const comp = new ProviderModelSelectorComponent(
				currentSpec,
				providers,
				modelsByProvider,
				done,
			);
			return comp;
		},
		{ overlay: true },
	);
	return selectionResultToString(result);
}

// ──────────────────────── RPC 分支 ────────────────────────

async function pickViaRpc(
	ctx: ModelPickerContext,
	currentSpec: string,
	providers: readonly string[],
	modelsByProvider: ReadonlyMap<string, readonly ResolvedModelEntry[]>,
): Promise<string | undefined> {
	// 第一次 select：provider（含 Auto）
	const providerOptions = ["Auto", ...providers];
	const providerChoice = await ctx.ui.select(
		`[pi-permission] Select provider (current: ${currentSpec})`,
		providerOptions,
	);
	if (providerChoice === undefined) return undefined;
	if (providerChoice === "Auto") return "auto";

	// 第二次 select：model
	const models = modelsByProvider.get(providerChoice) ?? [];
	if (models.length === 0) return undefined;
	const modelOptions = models.map((m) => m.id);
	const modelChoice = await ctx.ui.select(
		`[pi-permission] Select model for ${providerChoice}`,
		modelOptions,
	);
	if (modelChoice === undefined) return undefined;
	return `${providerChoice}/${modelChoice}`;
}

// ──────────────────────── 辅助 ────────────────────────

/** SelectionResult → config 字符串（'auto' / 'provider/model-id'）。 */
function selectionResultToString(result: SelectionResult | undefined): string | undefined {
	if (result === undefined) return undefined;
	if (result.kind === "auto") return "auto";
	return `${result.provider}/${result.modelId}`;
}
