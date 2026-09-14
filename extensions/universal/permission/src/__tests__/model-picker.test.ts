/**
 * model-picker.test.ts — W7 T5：model picker 单元测试。
 *
 * 覆盖：
 *  - listAvailableModels（2）：E2 后走 mock ctx.modelRegistry（详细覆盖在 model-resolver.test.ts）
 *  - pickModelViaOverlay（3）：TUI mock custom / RPC mock select / headless 降级
 *  - ProviderModelSelectorComponent（5，含 WR1 handleInput 锁定）：
 *      构造 / 初始 stage / provider onSelect / switchToModelStage / model onSelect
 *      + 直接调 comp.handleInput('\r') 验证 SelectList.onSelect 触发（WR1）
 *
 * 用真实 pi-tui SelectList（不 mock），验证键盘委托集成通路（WR1 critical）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

import type { ResolvedModelEntry } from "../classifier/model-resolver.js";
import { listAvailableModels } from "../classifier/model-resolver.js";
import {
	type ModelPickerContext,
	pickModelViaOverlay,
	ProviderModelSelectorComponent,
	type SelectionResult,
} from "../model-picker.js";
import { DEFAULT_SELECT_THEME } from "../select-theme.js";

// ──────────────────────── mock fixtures（listAvailableModels） ────────────────────────

/** 构造一条 ResolvedModelEntry（测试 helper；E5 后仅 provider/id/api）。 */
function makeEntry(provider: string, id: string): ResolvedModelEntry {
	return {
		provider,
		id,
		api: "openai-completions",
	};
}

/** 构造 mock Model（modelRegistry.getAll 用）。 */
function makeMockModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: "",
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

/** 构造 models Map（用于 component / pickModelViaOverlay 测试，避免真实数据源）。 */
function makeModelsMap(providers: Record<string, ResolvedModelEntry[]>): Map<string, ResolvedModelEntry[]> {
	return new Map(Object.entries(providers));
}

// ──────────────────────── listAvailableModels（E2 数据源接入） ────────────────────────

describe("MPT1: listAvailableModels（E2 走 ctx.modelRegistry）", () => {
	it("mock ctx.modelRegistry：hasConfiguredAuth 过滤后按 provider 分组（OAuth provider 可见）", () => {
		const ctx: ModelPickerContext = {
			mode: "rpc",
			modelRegistry: {
				getAll: () => [makeMockModel("auth-co", "m1"), makeMockModel("noauth-co", "m2")],
				hasConfiguredAuth: (m) => m.provider === "auth-co",
			},
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		};
		const map = listAvailableModels(ctx);
		expect(map.has("auth-co")).toBe(true);
		expect(map.has("noauth-co")).toBe(false);
	});

	it("registry 无可选模型 → 空 Map（picker 降级提示）", () => {
		const ctx: ModelPickerContext = {
			mode: "rpc",
			modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false },
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		};
		const map = listAvailableModels(ctx);
		expect(map.size).toBe(0);
	});
});

// ──────────────────────── pickModelViaOverlay（3 cases） ────────────────────────

function makePickerCtx(overrides: Partial<ModelPickerContext> = {}): ModelPickerContext {
	const base: ModelPickerContext = {
		mode: "tui",
		modelRegistry: {
			getAll: vi.fn(() => []),
			hasConfiguredAuth: vi.fn(() => false),
		},
		ui: {
			notify: vi.fn(),
			select: vi.fn(() => Promise.resolve(undefined)),
			custom: vi.fn(() => Promise.resolve(undefined)),
		},
	};
	return {
		mode: overrides.mode ?? base.mode,
		modelRegistry: overrides.modelRegistry ?? base.modelRegistry,
		ui: { ...base.ui, ...overrides.ui },
	};
}

describe("MPT2: pickModelViaOverlay 分发", () => {
	it("headless（json）→ 返回 undefined（降级）", async () => {
		const ctx = makePickerCtx({ mode: "json" });
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBeUndefined();
	});

	it("空 models Map → 返回 undefined（降级，无论 mode）", async () => {
		const ctx = makePickerCtx({ mode: "tui" });
		const result = await pickModelViaOverlay(ctx, "auto", new Map());
		expect(result).toBeUndefined();
	});

	it("RPC 模式：第一次选 Auto → 返回 'auto'", async () => {
		const ctx = makePickerCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Auto")),
				custom: vi.fn(),
			},
		});
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBe("auto");
		expect(ctx.ui.select).toHaveBeenCalledOnce();
	});

	it("RPC 模式：选 provider 后选 model → 返回 'provider/model'", async () => {
		const selectMock = vi.fn()
			.mockResolvedValueOnce("co") // provider
			.mockResolvedValueOnce("m1"); // model
		const ctx = makePickerCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBe("co/m1");
		expect(ctx.ui.select).toHaveBeenCalledTimes(2);
	});

	it("RPC 模式：第一次 select undefined（cancel）→ 返回 undefined", async () => {
		const ctx = makePickerCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)),
				custom: vi.fn(),
			},
		});
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBeUndefined();
	});

	it("TUI 模式：custom factory 被调用，comp done settle 结果", async () => {
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		// 模拟 ctx.ui.custom：构造 comp 并模拟 done({kind:'auto'})
		const customMock = vi.fn(
			<T,>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					factory({}, {}, {}, (r: T) => resolve(r));
				}),
		);
		const ctx = makePickerCtx({ mode: "tui", ui: { notify: vi.fn(), select: vi.fn(), custom: customMock } });
		// 在 factory 内拿到 comp，但这里 mock 直接调 done({kind:'auto'})
		// 改写 mock：构造真实 comp 并用 handleInput('\r') 触发 onSelect
		customMock.mockImplementationOnce(
			<T,>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					const comp = factory({}, {}, {}, (r: T) => resolve(r)) as ProviderModelSelectorComponent;
					// 触发 provider stage 的 'Auto' 选中（index 0）
					comp.handleInput("\r"); // Enter → onSelect(Auto) → done({kind:'auto'})
				}),
		);
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBe("auto");
		expect(customMock).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── ProviderModelSelectorComponent（5 cases + WR1） ────────────────────────

describe("MPT3: ProviderModelSelectorComponent 构造 + 初始 stage", () => {
	it("构造：初始 stage='provider'，render 非空含 'Select Provider'", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Select Provider");
		expect(joined).toContain("Auto");
		expect(done).not.toHaveBeenCalled();
	});

	it("currentSpec='auto' → 预选 'Auto'（index 0）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\r"); // Enter 选中预选项（Auto）
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as SelectionResult | undefined;
		expect(result).toEqual({ kind: "auto" });
	});

	it("currentSpec='provider/modelId' → 预选该 provider（Enter 直接到 model stage）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("co/m1", ["co"], models, done);
		// 预选 'co'（index 1），Enter 触发 switchToModelStage（不 done）
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled(); // 进入 model stage，未 settle
		const lines = comp.render(80);
		expect(lines.join("\n")).toContain("Select Model");
	});
});

describe("MPT4: ProviderModelSelectorComponent provider onSelect", () => {
	it("provider stage 选 Auto → done({kind:'auto'})", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\r"); // Enter 选中预选 Auto
		expect(done).toHaveBeenCalledWith({ kind: "auto" });
	});

	it("provider stage 选具体 provider → switchToModelStage（不 done）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 下移到 'co'（index 1），Enter 进入 model stage
		comp.handleInput("\x1b[B"); // Down arrow
		comp.handleInput("\r"); // Enter
		expect(done).not.toHaveBeenCalled();
		expect(comp.render(80).join("\n")).toContain("Select Model");
	});

	it("provider stage Esc → done(undefined)（cancel）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\x1b"); // Esc
		expect(done).toHaveBeenCalledWith(undefined);
	});
});

describe("MPT5: ProviderModelSelectorComponent model onSelect", () => {
	it("model stage 选 model → done({kind:'specific', provider, modelId})", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1"), makeEntry("co", "m2")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 下移到 'co'，Enter 进 model stage
		comp.handleInput("\x1b[B"); // Down
		comp.handleInput("\r"); // Enter → model stage
		// model stage 预选 m1（provider + id 字典序第一个）
		comp.handleInput("\r"); // Enter 选 m1
		expect(done).toHaveBeenCalledWith({ kind: "specific", provider: "co", modelId: "m1" });
	});

	it("model stage Esc → 回退到 provider stage（不 done）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 进 model stage
		comp.handleInput("\x1b[B"); // Down
		comp.handleInput("\r"); // Enter → model stage
		// Esc 回退
		comp.handleInput("\x1b"); // Esc
		expect(done).not.toHaveBeenCalled();
		expect(comp.render(80).join("\n")).toContain("Select Provider"); // 回到 provider stage
	});

	it("_resolved 守卫：done 后再 handleInput no-op", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\r"); // Auto → done
		expect(done).toHaveBeenCalledOnce();
		// 二次输入 no-op
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── WR1: handleInput 键盘委托锁定（critical） ────────────────────────

describe("MPT6: WR1 handleInput 委托 SelectList.onSelect（critical）", () => {
	it("handleInput('\\r') 直接触发 SelectList.onSelect（不绕过键盘委托通路）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 直接调 handleInput('\r')，验证：
		// 1. Container.handleInput 不存在，组件 override 委托给 SelectList
		// 2. SelectList.handleInput('\r') 触发 onSelect → comp.settle({kind:'auto'})
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as SelectionResult | undefined;
		expect(result).toEqual({ kind: "auto" });
	});

	it("handleInput(down + enter) 链式触发 SelectList 导航 + onSelect", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// Down 移动到 'co'，Enter 选中 → 进 model stage（done 未调）
		comp.handleInput("\x1b[B"); // Down
		comp.handleInput("\r"); // Enter
		expect(done).not.toHaveBeenCalled(); // 进入 model stage
		// model stage Enter 选中 m1
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ kind: "specific", provider: "co", modelId: "m1" });
	});
});

// ──────────────────────── DEFAULT_SELECT_THEME（G2 修正验证） ────────────────────────

describe("MPT7: DEFAULT_SELECT_THEME（G2/WR2 修正）", () => {
	it("selectedPrefix 在文本前加 '▶ '", () => {
		expect(DEFAULT_SELECT_THEME.selectedPrefix("text")).toBe("\u25B6 text");
	});

	it("selectedPrefix 非 identity（有视觉区分）", () => {
		const result = DEFAULT_SELECT_THEME.selectedPrefix("foo");
		expect(result).not.toBe("foo");
		expect(result.startsWith("\u25B6")).toBe(true);
	});
});

// ──────────────────────── V2b: currentSpec 预选钉值（ext-simplify-18 D4 parseModelRef 采用） ────────────────────────

describe("MPT8: V2b currentSpec 预选钉值（parseModelRef 采用后行为锁定）", () => {
	it("合法 ref：provider 与 model 双预选命中（两 stage Enter 落到 currentSpec 对应项）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1"), makeEntry("co", "m2")] });
		const comp = new ProviderModelSelectorComponent("co/m2", ["other", "co"], models, done);
		// provider stage 预选 'co'（index 2：Auto + other + co），Enter → model stage（不 settle）
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		// model stage 预选 m2（非列表第一个 m1），Enter → done(specific co/m2)
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ kind: "specific", provider: "co", modelId: "m2" });
	});

	it("病态输入 'provider/'（尾空 modelId）：parseModelRef 返 null → provider 预选回 Auto", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1")] });
		// 行为微变（ext-simplify-18 D4 登记）：旧版 provider 预选命中 idx+1，
		// 新版整 ref 无效 → 整体回 Auto（Enter → done({kind:'auto'})）
		const comp = new ProviderModelSelectorComponent("co/", ["co"], models, done);
		comp.handleInput("\r"); // 预选 index 0（Auto），Enter → done({kind:'auto'})
		expect(done).toHaveBeenCalledWith({ kind: "auto" });
	});
});
