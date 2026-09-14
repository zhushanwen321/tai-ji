/**
 * commands.test.ts — W6 T7: handlePermissionCommand 单元测试。
 *
 * 覆盖 /permission 命令各参数分支：
 *  - 无参 → 显示菜单（当前模式 + 可用模式列表）
 *  - set yolo/auto/approve/strict → 切换模式
 *  - invalid mode → 错误提示
 *  - status → 详细配置
 *  - 当前状态（已是目标模式）→ "Already in X mode"
 *  - model/rule 异步 handler（D4 后直调模块函数，测试在模块边界 vi.mock 控制）
 *
 * handlePermissionCommand 是纯函数（输入 args + config + onSave，输出 string），
 * 不依赖 Pi 运行时，便于单测。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// D4：model/rule handler 直调模块函数，测试边界移到模块真实依赖位置
// （model-resolver / rule-editor）。vi.mock factory 被提升到文件顶部，不能引用
// 外部变量，因此默认返回值统一在 beforeEach 设置（每用例可覆盖）。
vi.mock("../classifier/model-resolver.js", () => ({
	listAvailableModels: vi.fn(),
}));
vi.mock("../rule-editor.js", () => ({
	editRulesViaOverlay: vi.fn(),
}));

import { listAvailableModels } from "../classifier/model-resolver.js";
import { handlePermissionCommand, handlePermissionModelCommand, handlePermissionRuleCommand } from "../commands.js";
import type { ModelPickerContext } from "../model-picker.js";
import { editRulesViaOverlay, type RuleEditorContext } from "../rule-editor.js";
import type { RuleOp } from "../rule-templates.js";
import { DEFAULT_CONFIG, type PermissionConfig, type Rule } from "../types.js";

beforeEach(() => {
	vi.mocked(listAvailableModels).mockReset();
	vi.mocked(listAvailableModels).mockReturnValue(new Map());
	vi.mocked(editRulesViaOverlay).mockReset();
	vi.mocked(editRulesViaOverlay).mockResolvedValue(undefined);
});

// ──────────────────────── mock helpers ────────────────────────

/** 构造一个可变 config 副本（默认 yolo）。 */
function makeConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
	return {
		mode: "yolo",
		enabled: true,
		classifier: { enabled: true, model: "auto", timeout: 90, autoApproveLowRisk: true, autoDenyHighRisk: true },
		userRules: [],
		...overrides,
	};
}

/** onSave mock：总是成功。 */
function successSave(): (config: PermissionConfig) => { success: boolean; error?: string } {
	return vi.fn(() => ({ success: true }));
}

// ──────────────────────── 无参：显示菜单 ────────────────────────

describe("/permission 无参 → 显示菜单", () => {
	it("无参显示当前模式 + 可用模式列表", () => {
		const config = makeConfig({ mode: "approve" });
		const msg = handlePermissionCommand(undefined, config, successSave());
		expect(msg).toContain("Current mode");
		expect(msg).toContain("approve");
		expect(msg).toContain("Available modes");
		expect(msg).toContain("yolo");
		expect(msg).toContain("auto");
		expect(msg).toContain("strict");
	});

	it("空字符串等同无参 → 显示菜单", () => {
		const msg = handlePermissionCommand("", makeConfig(), successSave());
		expect(msg).toContain("Current mode");
	});

	it("纯空白等同无参 → 显示菜单", () => {
		const msg = handlePermissionCommand("   ", makeConfig(), successSave());
		expect(msg).toContain("Current mode");
	});

	it("当前模式在列表中用 ► 标记", () => {
		const msg = handlePermissionCommand(undefined, makeConfig({ mode: "auto" }), successSave());
		expect(msg).toContain("► auto");
		expect(msg).not.toContain("► yolo");
	});
});

// ──────────────────────── status 子命令 ────────────────────────

describe("/permission status → 详细配置", () => {
	it("status 显示 mode/enabled/classifier/userRules", () => {
		const config = makeConfig({
			mode: "strict",
			classifier: { enabled: true, model: "zhipu/glm-4-flash", timeout: 30, autoApproveLowRisk: false, autoDenyHighRisk: true },
			userRules: [{ id: "u1", tool: "bash", pattern: "rm *", action: "deny", source: "user" }],
		});
		const msg = handlePermissionCommand("status", config, successSave());
		expect(msg).toContain("mode:");
		expect(msg).toContain("strict");
		expect(msg).toContain("enabled:");
		expect(msg).toContain("classifier:");
		expect(msg).toContain("zhipu/glm-4-flash");
		expect(msg).toContain("userRules:");
		expect(msg).toContain("1 rule(s)");
	});

	it("status 显示 autoApproveLowRisk=false", () => {
		const config = makeConfig({
			classifier: { enabled: true, model: "auto", timeout: 90, autoApproveLowRisk: false, autoDenyHighRisk: true },
		});
		const msg = handlePermissionCommand("status", config, successSave());
		expect(msg).toContain("autoApproveLow:");
		expect(msg).toContain("false");
	});
});

// ──────────────────────── 切换模式 ────────────────────────

describe("/permission <mode> → 切换模式", () => {
	it("set yolo（从 strict 切到 yolo）→ onSave 被调，返回切换成功", () => {
		const config = makeConfig({ mode: "strict" });
		const onSave = vi.fn(() => ({ success: true }));
		const msg = handlePermissionCommand("yolo", config, onSave);
		expect(msg).toContain("Switched to YOLO mode");
		expect(msg).toContain("完全无防护");
		expect(onSave).toHaveBeenCalledOnce();
		// onSave 收到的新 config mode=yolo
		const savedConfig = onSave.mock.calls[0]![0] as PermissionConfig;
		expect(savedConfig.mode).toBe("yolo");
	});

	it("set auto → 切换到 auto 模式", () => {
		const msg = handlePermissionCommand("auto", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Auto mode");
		expect(msg).toContain("安全命令规则直接放行");
	});

	it("set approve → 切换到 approve 模式", () => {
		const msg = handlePermissionCommand("approve", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Approve mode");
	});

	it("set strict → 切换到 strict 模式", () => {
		const msg = handlePermissionCommand("strict", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Strict mode");
		expect(msg).toContain("全部审批");
	});

	it("已是目标模式 → 'Already in X mode'，不调 onSave", () => {
		const onSave = vi.fn(() => ({ success: true }));
		const msg = handlePermissionCommand("yolo", makeConfig({ mode: "yolo" }), onSave);
		expect(msg).toContain("Already in YOLO mode");
		expect(onSave).not.toHaveBeenCalled();
	});

	it("onSave 失败 → 返回失败信息（含 error）", () => {
		const onSave = vi.fn(() => ({ success: false, error: "disk full" }));
		const msg = handlePermissionCommand("strict", makeConfig({ mode: "yolo" }), onSave);
		expect(msg).toContain("Failed to switch");
		expect(msg).toContain("disk full");
	});

	it("切换模式保留 enabled/classifier/userRules（仅改 mode）", () => {
		const config = makeConfig({
			mode: "yolo",
			enabled: false,
			classifier: { enabled: false, model: "custom", timeout: 10, autoApproveLowRisk: false, autoDenyHighRisk: false },
			userRules: [{ id: "u1", tool: "bash", pattern: "x", action: "deny", source: "user" }],
		});
		const onSave = vi.fn(() => ({ success: true }));
		handlePermissionCommand("strict", config, onSave);
		const saved = onSave.mock.calls[0]![0] as PermissionConfig;
		expect(saved.mode).toBe("strict");
		expect(saved.enabled).toBe(false); // 保留
		expect(saved.classifier.model).toBe("custom"); // 保留
		expect(saved.classifier.autoApproveLowRisk).toBe(false); // 保留
		expect(saved.userRules).toHaveLength(1); // 保留
	});
});

// ──────────────────────── invalid mode ────────────────────────

describe("/permission <invalid> → 错误提示", () => {
	it("未知 mode → 错误信息 + 可用模式列表 + Usage 含 rule/model", () => {
		const msg = handlePermissionCommand("invalid-mode", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
		expect(msg).toContain("invalid-mode");
		expect(msg).toContain("yolo, auto, approve, strict");
		// M6：Usage 提示应列出所有子命令（含 rule/model）
		expect(msg).toContain("rule");
		expect(msg).toContain("model");
	});

	it("拼错的 mode（yoloo）→ 错误提示", () => {
		const msg = handlePermissionCommand("yoloo", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
		expect(msg).toContain("yoloo");
	});

	it("大小写敏感（YOLO 大写无效）", () => {
		const msg = handlePermissionCommand("YOLO", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
		expect(msg).toContain("YOLO");
	});

	it("未知子命令（foo）当 invalid mode 处理", () => {
		const msg = handlePermissionCommand("foo", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
	});
});

// ──────────────────────── 边界 ────────────────────────

describe("/permission 边界", () => {
	it("args 含前后空白 → trim 后识别模式", () => {
		const msg = handlePermissionCommand("  strict  ", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Strict mode");
	});

	it("default config 调无参 → 含 'yolo'（默认模式）", () => {
		const msg = handlePermissionCommand(undefined, DEFAULT_CONFIG, successSave());
		expect(msg).toContain("yolo");
	});
});

// ──────────────────────── /permission model（W7 T6） ────────────────────────

/** 构造一条 ResolvedModelEntry（测试 helper）。 */
function makeModelEntry(provider: string, id: string): ResolvedModelEntry {
	return {
		provider,
		id,
		api: "openai-completions",
	};
}

/** 默认可用模型：co → [m1]（非空，供正常选择流程用例）。 */
function defaultModels(): Map<string, ResolvedModelEntry[]> {
	return new Map([["co", [makeModelEntry("co", "m1")]]]);
}

/** 构造 mock ctx（mode + modelRegistry + ui.notify/custom/select）。 */
function makeModelPickerCtx(overrides: Partial<ModelPickerContext> = {}): ModelPickerContext {
	const base: ModelPickerContext = {
		mode: "rpc",
		modelRegistry: {
			getAll: vi.fn(() => []),
			hasConfiguredAuth: vi.fn(() => false),
		},
		ui: {
			notify: vi.fn(),
			select: vi.fn(() => Promise.resolve("Auto")),
			custom: vi.fn(() => Promise.resolve(undefined)),
		},
	};
	return {
		mode: overrides.mode ?? base.mode,
		modelRegistry: overrides.modelRegistry ?? base.modelRegistry,
		ui: { ...base.ui, ...overrides.ui },
	};
}

describe("/permission model（W7）", () => {
	it("无可用 model（空 Map）→ notify 降级提示，不调 save", async () => {
		const ctx = makeModelPickerCtx();
		const save = vi.fn(() => ({ success: true }));
		vi.mocked(listAvailableModels).mockReturnValue(new Map());
		await handlePermissionModelCommand(ctx, makeConfig(), save);
		expect(ctx.ui.notify).toHaveBeenCalledOnce();
		const [msg, level] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(msg).toContain("No available models");
		expect(level).toBe("warning");
		expect(save).not.toHaveBeenCalled();
	});

	it("选 'Auto' → 写回 config.classifier.model='auto' + notify 成功", async () => {
		const ctx = makeModelPickerCtx({
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Auto")),
				custom: vi.fn(),
			},
		});
		const save = vi.fn(() => ({ success: true }));
		vi.mocked(listAvailableModels).mockReturnValue(defaultModels());
		const config = makeConfig({ classifier: { enabled: true, model: "co/old", timeout: 90, autoApproveLowRisk: true, autoDenyHighRisk: true } });
		await handlePermissionModelCommand(ctx, config, save);
		expect(save).toHaveBeenCalledOnce();
		const savedConfig = save.mock.calls[0]![0] as PermissionConfig;
		expect(savedConfig.classifier.model).toBe("auto");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("set to: auto"), "info");
	});

	it("选 provider/model → 写回 config.classifier.model='provider/model-id' + notify", async () => {
		const selectMock = vi.fn()
			.mockResolvedValueOnce("co") // provider
			.mockResolvedValueOnce("m1"); // model
		const ctx = makeModelPickerCtx({
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const save = vi.fn(() => ({ success: true }));
		vi.mocked(listAvailableModels).mockReturnValue(defaultModels());
		await handlePermissionModelCommand(ctx, makeConfig(), save);
		expect(save).toHaveBeenCalledOnce();
		const savedConfig = save.mock.calls[0]![0] as PermissionConfig;
		expect(savedConfig.classifier.model).toBe("co/m1");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("set to: co/m1"), "info");
	});

	it("cancel（undefined）→ notify 取消，不调 save", async () => {
		const ctx = makeModelPickerCtx({
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)), // cancel
				custom: vi.fn(),
			},
		});
		const save = vi.fn(() => ({ success: true }));
		vi.mocked(listAvailableModels).mockReturnValue(defaultModels());
		await handlePermissionModelCommand(ctx, makeConfig(), save);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
		expect(save).not.toHaveBeenCalled();
	});

	it("save 失败 → notify error（含 error 信息），不抛错", async () => {
		const ctx = makeModelPickerCtx({
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Auto")),
				custom: vi.fn(),
			},
		});
		const save = vi.fn(() => ({ success: false, error: "disk full" }));
		vi.mocked(listAvailableModels).mockReturnValue(defaultModels());
		await handlePermissionModelCommand(ctx, makeConfig(), save);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "error");
	});

	it("handler 返回 Promise（async 签名）", () => {
		const ctx = makeModelPickerCtx();
		const save = vi.fn(() => ({ success: true }));
		vi.mocked(listAvailableModels).mockReturnValue(defaultModels());
		const result = handlePermissionModelCommand(ctx, makeConfig(), save);
		// Promise.is 兼容检查
		expect(result).toBeInstanceOf(Promise);
		// 避免 unhandled rejection
		result.catch(() => undefined);
	});

	it("写回保留其余字段（仅改 classifier.model）", async () => {
		const ctx = makeModelPickerCtx({
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Auto")),
				custom: vi.fn(),
			},
		});
		const save = vi.fn(() => ({ success: true }));
		vi.mocked(listAvailableModels).mockReturnValue(defaultModels());
		const config = makeConfig({
			mode: "strict",
			enabled: false,
			classifier: { enabled: false, model: "co/old", timeout: 30, autoApproveLowRisk: false, autoDenyHighRisk: false },
			userRules: [{ id: "u1", tool: "bash", pattern: "rm *", action: "deny", source: "user" }],
		});
		await handlePermissionModelCommand(ctx, config, save);
		const saved = save.mock.calls[0]![0] as PermissionConfig;
		expect(saved.mode).toBe("strict"); // 保留
		expect(saved.enabled).toBe(false); // 保留
		expect(saved.classifier.enabled).toBe(false); // 保留
		expect(saved.classifier.timeout).toBe(30); // 保留
		expect(saved.classifier.model).toBe("auto"); // 改
		expect(saved.userRules).toHaveLength(1); // 保留
	});
});

// ──────────────────────── /permission rule（W8 T9） ────────────────────────

/** 构造 RuleEditorContext mock。 */
function makeRuleEditorCtx(overrides: Partial<RuleEditorContext> = {}): RuleEditorContext {
	return {
		mode: overrides.mode ?? "rpc",
		ui: {
			notify: overrides.ui?.notify ?? vi.fn(),
			select: overrides.ui?.select ?? vi.fn(() => Promise.resolve(undefined)),
			custom: overrides.ui?.custom ?? vi.fn(() => Promise.resolve(undefined)),
		},
	};
}

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

function makeCounter(): () => string {
	let n = 1;
	return (): string => `user-${n++}`;
}

describe("/permission rule（W8）", () => {
	it("editRulesViaOverlay 返回 undefined → notify no changes，不调 save", async () => {
		const notify = vi.fn();
		const save = vi.fn(() => ({ success: true }));
		const ctx = makeRuleEditorCtx({ ui: { notify, select: vi.fn(), custom: vi.fn() } });
		vi.mocked(editRulesViaOverlay).mockResolvedValue(undefined);
		await handlePermissionRuleCommand(ctx, makeConfig(), makeCounter(), save);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No changes"), "info");
		expect(save).not.toHaveBeenCalled();
	});

	it("editRulesViaOverlay 返回空 ops → notify no changes", async () => {
		const notify = vi.fn();
		const save = vi.fn(() => ({ success: true }));
		const ctx = makeRuleEditorCtx({ ui: { notify, select: vi.fn(), custom: vi.fn() } });
		vi.mocked(editRulesViaOverlay).mockResolvedValue([]);
		await handlePermissionRuleCommand(ctx, makeConfig(), makeCounter(), save);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No changes"), "info");
		expect(save).not.toHaveBeenCalled();
	});

	it("ops 非空 → applyOps + save + notify N changes", async () => {
		const notify = vi.fn();
		const save = vi.fn(() => ({ success: true }));
		const ops: RuleOp[] = [{ kind: "add", rule: makeRule({ id: "user-1", pattern: "git *" }) }];
		const ctx = makeRuleEditorCtx({ ui: { notify, select: vi.fn(), custom: vi.fn() } });
		vi.mocked(editRulesViaOverlay).mockResolvedValue(ops);
		const config = makeConfig({ userRules: [] });
		await handlePermissionRuleCommand(ctx, config, makeCounter(), save);
		expect(save).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 change(s)"), "info");
		// save 收到的 config.userRules 含新规则
		const savedConfig = save.mock.calls[0]![0] as PermissionConfig;
		expect(savedConfig.userRules).toHaveLength(1);
		expect(savedConfig.userRules[0]!.pattern).toBe("git *");
	});

	it("save 失败 → notify error", async () => {
		const notify = vi.fn();
		const save = vi.fn(() => ({ success: false, error: "disk full" }));
		const ops: RuleOp[] = [{ kind: "add", rule: makeRule({ id: "user-1" }) }];
		const ctx = makeRuleEditorCtx({ ui: { notify, select: vi.fn(), custom: vi.fn() } });
		vi.mocked(editRulesViaOverlay).mockResolvedValue(ops);
		await handlePermissionRuleCommand(ctx, makeConfig(), makeCounter(), save);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "error");
	});

	it("保存保留 mode/enabled/classifier（仅改 userRules）", async () => {
		const save = vi.fn(() => ({ success: true }));
		const ops: RuleOp[] = [{ kind: "add", rule: makeRule({ id: "user-1" }) }];
		const ctx = makeRuleEditorCtx({ ui: { notify: vi.fn(), select: vi.fn(), custom: vi.fn() } });
		vi.mocked(editRulesViaOverlay).mockResolvedValue(ops);
		const config = makeConfig({
			mode: "strict",
			enabled: false,
			classifier: { enabled: false, model: "custom", timeout: 10, autoApproveLowRisk: false, autoDenyHighRisk: false },
		});
		await handlePermissionRuleCommand(ctx, config, makeCounter(), save);
		const saved = save.mock.calls[0]![0] as PermissionConfig;
		expect(saved.mode).toBe("strict");
		expect(saved.enabled).toBe(false);
		expect(saved.classifier.model).toBe("custom");
	});

	it("editRulesViaOverlay 收到正确的 initialRules 和 sessionIdCounter", async () => {
		const save = vi.fn(() => ({ success: true }));
		const ctx = makeRuleEditorCtx({ ui: { notify: vi.fn(), select: vi.fn(), custom: vi.fn() } });
		const existingRules = [makeRule({ id: "user-5" })];
		const counter = makeCounter();
		vi.mocked(editRulesViaOverlay).mockResolvedValue(undefined);
		await handlePermissionRuleCommand(ctx, makeConfig({ userRules: existingRules }), counter, save);
		expect(editRulesViaOverlay).toHaveBeenCalledOnce();
		const [_callCtx, callRules, callCounter] = vi.mocked(editRulesViaOverlay).mock.calls[0]!;
		expect(callRules).toEqual(existingRules);
		expect(typeof callCounter).toBe("function");
	});
});
