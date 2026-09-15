/**
 * production.test.ts — createProductionClassifier + createPipelineDeps 装配测试。
 *
 * C1a 收口后 createProductionClassifier(ctx) 的 resolveModel 注入走 llm-shared resolveModel
 * （不再预检凭证），callLLM 注入闭包捕获 ctx（凭证在 callLLM 内部 getApiKeyAndHeaders）。
 * 测试用 mock ctx.modelRegistry + vi.mock llm-shared（resolveModel + callLLM）精确控制，覆盖：
 *  - TC1: toSelector 任意字符串 → ref 精确选择器（'auto' 不走 selector，由 resolveModel 注入层本地处理）
 *  - TC3: 'auto' 且 getAvailable 空 → resolveModel 返回 null → fail-closed ask（不触达 callLLM）
 *  - TC4（静态断言）: production.ts 收口完成——无 getApiProvider/streamSimple/@ts-ignore，走 callLLM
 *  - TC4（装配）: resolveModel 命中 → callLLM 收到 model → ok:true 正常分类（链路通）
 *  - TC5: callLLM 返回 ok:false（LLM 调用失败）→ classifier fail-closed fallback
 *  - TC7: 'auto' 直接取 getAvailable() 首个（permission 本地解析，不经过 llm-shared 非精确 selector）
 *  - m1: 每次 createPipelineDeps 创建独立 classifier（CL-classifier-singleton）
 */
import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalContext } from "../approval.js";
import type { CheckPermissionDeps } from "../pipeline.js";
import { createPipelineDeps, createProductionClassifier, toSelector } from "../production.js";

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

// vi.mock 必须在 import 之前（vitest hoisting）。替换 llm-shared 的 resolveModel + callLLM
// 为可控 mock，默认透传 actual（真实实现），单测用 mockImplementation/mockResolvedValue 精确控制。
vi.mock("@zhushanwen/pi-llm-shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@zhushanwen/pi-llm-shared")>();
	return {
		...actual,
		resolveModel: vi.fn(actual.resolveModel),
		callLLM: vi.fn(actual.callLLM),
	};
});

// mock 后再 import，拿到的是 mock 版（用于单测配置返回值）
const { resolveModel: resolveModelShared, callLLM: callLLMShared } = await import("@zhushanwen/pi-llm-shared");

// ──────────────────────── fixtures ────────────────────────

/** 测试用 model（resolveModel mock 的返回值；callLLM 已 mock，不触达真实 provider） */
const MOCK_MODEL_A: Model<Api> = {
	id: "model-a",
	name: "Model A",
	api: "bogus-api" as Api,
	provider: "test-co",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

function makeApprovalCtx(): ApprovalContext {
	return {
		mode: "headless",
		ui: {
			notify() {},
			select() {
				return Promise.resolve(undefined);
			},
			custom() {
				return Promise.resolve(undefined);
			},
		},
	};
}

/** 构造 mock ctx（仅 modelRegistry 相关方法，其余字段 createProductionClassifier 不用） */
function makeMockCtx(over: {
	getAll?: () => Model<Api>[];
	getAvailable?: () => Model<Api>[];
	hasConfiguredAuth?: (m: Model<Api>) => boolean;
	find?: (provider: string, id: string) => Model<Api> | null;
	getApiKeyAndHeaders?: (m: Model<Api>) => Promise<{ ok: true; apiKey: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }>;
} = {}): ExtensionContext {
	const modelRegistry = {
		getAll: over.getAll ?? vi.fn(() => []),
		getAvailable: over.getAvailable ?? vi.fn(() => []),
		hasConfiguredAuth: over.hasConfiguredAuth ?? vi.fn(() => false),
		find: over.find ?? vi.fn(() => null),
		getApiKeyAndHeaders: over.getApiKeyAndHeaders ?? vi.fn(async () => ({ ok: false, error: "no auth" })),
	};
	return { modelRegistry } as unknown as ExtensionContext;
}

beforeEach(() => {
	vi.mocked(resolveModelShared).mockReset();
	vi.mocked(callLLMShared).mockReset();
});

// ──────────────────────── TC1/TC2: toSelector 映射 ────────────────────────

describe("toSelector（仅 ref 精确指定）", () => {
	it("任意字符串都映射为 ref（auto 由 production resolveModel 层自行处理，不走 selector）", () => {
		expect(toSelector("auto")).toEqual({ type: "ref", ref: "auto" });
		expect(toSelector("anthropic/claude-sonnet")).toEqual({ type: "ref", ref: "anthropic/claude-sonnet" });
		expect(toSelector("openai/gpt-4o")).toEqual({ type: "ref", ref: "openai/gpt-4o" });
	});
});

// ──────────────────────── createProductionClassifier ────────────────────────

describe("createProductionClassifier", () => {
	it("返回带 classifyRisk 的对象", () => {
		const classifier = createProductionClassifier(makeMockCtx());
		expect(typeof classifier.classifyRisk).toBe("function");
	});

	it("ref 模式 resolveModel 返回 null → classifyRisk fail-closed 返回 ask（不 throw）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(null);
		const classifier = createProductionClassifier(makeMockCtx());
		const result = await classifier.classifyRisk(
			{ toolName: "bash", command: "ls", cwd: "/tmp" },
			{ enabled: true, model: "nonexistent-provider/no-such-model", timeout: 5, autoApproveLowRisk: false, autoDenyHighRisk: true },
		);
		expect(result.outcome).toBe("ask");
		expect(result.risk_level).toBe("medium");
	});
});

// ──────────────────────── resolveModel 装配（C3 + C1a 收口） ────────────────────────

describe("resolveModel 装配（resolveModel + callLLM）", () => {
	const CTX = { toolName: "bash", command: "ls", cwd: "/tmp" };
	const CFG_AUTO = { enabled: true, model: "auto", timeout: 5, autoApproveLowRisk: false, autoDenyHighRisk: true };
	const CFG_REF = { enabled: true, model: "test-co/model-a", timeout: 5, autoApproveLowRisk: false, autoDenyHighRisk: true };

	it("TC3: auto 且 getAvailable 空 → resolveModel null → fail-closed ask（不触达 callLLM）", async () => {
		const ctx = makeMockCtx({ getAvailable: () => [] });
		const classifier = createProductionClassifier(ctx);
		const result = await classifier.classifyRisk(CTX, CFG_AUTO);
		expect(result.outcome).toBe("ask");
		expect(result.confidence).toBe(0);
		// auto 是 permission 本地解析，不经过 llm-shared resolveModel
		expect(resolveModelShared).not.toHaveBeenCalled();
		expect(callLLMShared).not.toHaveBeenCalled();
	});

	it("TC4（静态断言）: production.ts 收口完成——无 getApiProvider/streamSimple/@ts-ignore，classifier 走 callLLM", () => {
		const source = readFileSync(new URL("../production.ts", import.meta.url), "utf-8");
		// 匹配代码形式（import 调用 / 字段定义），注释里的历史描述不算残留
		expect(source).not.toMatch(/getApiProvider\s*\(/);
		expect(source).not.toMatch(/streamSimple\s*[:=]/);
		expect(source).not.toMatch(/\/\/\s*@ts-ignore/);
		expect(source).not.toMatch(/import\s*\{[^}]*getApiProvider/);
		// classifier LLM 调用收口到 llm-shared callLLM（注入闭包捕获 ctx）
		expect(source).toMatch(/callLLM\s*:/);
		expect(source).toContain('from "@zhushanwen/pi-llm-shared"');
	});

	it("TC4（装配）: ref resolveModel 命中 → callLLM 收到 model → ok:true 正常分类（收口链路通）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(MOCK_MODEL_A);
		vi.mocked(callLLMShared).mockResolvedValue({
			ok: true,
			content: '{"outcome":"allow","risk_level":"low","reasoning":"safe","confidence":0.9}',
		});
		const classifier = createProductionClassifier(makeMockCtx());
		const result = await classifier.classifyRisk(CTX, CFG_REF);
		expect(result.outcome).toBe("allow");
		// 关键：resolveModel 返回 model 后，callLLM 被调用且收到该 model（收口链路 resolve→callLLM 通）
		expect(callLLMShared).toHaveBeenCalledOnce();
		// callLLM(ctx, opts) 两个参数：mock.calls[0] = [ctx, opts]
		const opts = vi.mocked(callLLMShared).mock.calls[0]![1];
		expect(opts.model).toBe(MOCK_MODEL_A);
		expect(opts.messages).toHaveLength(1);
		expect(opts.systemPrompt.length).toBeGreaterThan(0);
		// ref 精确指定只调 1 次 resolveModel
		expect(vi.mocked(resolveModelShared)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resolveModelShared)).toHaveBeenCalledWith(expect.anything(), { type: "ref", ref: "test-co/model-a" });
	});

	it("TC4b: ref resolveModel 成功 → onLog 输出 '[pi-permission] classifier: using model <modelId>'（契约 C2，R2 验收前提）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(MOCK_MODEL_A);
		vi.mocked(callLLMShared).mockResolvedValue({ ok: true, content: "x" });
		const classifier = createProductionClassifier(makeMockCtx());
		loggerMock.warn.mockClear();
		await classifier.classifyRisk(CTX, CFG_REF);
		// onLog 实装为 logger.warn（production.ts），成功路径日志在 LLM 调用前输出
		expect(loggerMock.warn).toHaveBeenCalledWith("[pi-permission] classifier: using model model-a");
	});

	it("TC5: callLLM 返回 ok:false（LLM 调用失败）→ classifier fail-closed fallback（不 throw）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(MOCK_MODEL_A);
		vi.mocked(callLLMShared).mockResolvedValue({ ok: false, error: "token expired" });
		const classifier = createProductionClassifier(makeMockCtx());
		const result = await classifier.classifyRisk(CTX, CFG_REF);
		expect(result.outcome).toBe("ask");
		expect(result.confidence).toBe(0);
		expect(callLLMShared).toHaveBeenCalledOnce();
	});

	it("TC7: auto 直接取 getAvailable 首个（permission 本地兼容，不经过非精确 ModelSelector）", async () => {
		const ctx = makeMockCtx({ getAvailable: () => [MOCK_MODEL_A] });
		vi.mocked(callLLMShared).mockResolvedValue({ ok: true, content: "x" });
		const classifier = createProductionClassifier(ctx);
		const result = await classifier.classifyRisk(CTX, CFG_AUTO);
		expect(callLLMShared).toHaveBeenCalledOnce();
		const opts = vi.mocked(callLLMShared).mock.calls[0]![1];
		expect(opts.model).toBe(MOCK_MODEL_A);
		// auto 不经过 llm-shared resolveModel
		expect(resolveModelShared).not.toHaveBeenCalled();
		// callLLM ok:true 但 content 非 JSON → parser fallback ask（链路已证明 resolve→callLLM 非 null）
		expect(result.outcome).toBe("ask");
	});
});

// ──────────────────────── createPipelineDeps ────────────────────────

describe("createPipelineDeps", () => {
	it("装配完整 CheckPermissionDeps（5 个字段齐全）", () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		expect(deps).toBeInstanceOf(Object);
		expect(typeof deps.analyzeBashStructure).toBe("function");
		expect(typeof deps.matchRulesForArgv).toBe("function");
		expect(typeof deps.getDefaultRules).toBe("function");
		expect(typeof deps.classifier.classifyRisk).toBe("function");
		expect(typeof deps.requestUserApproval).toBe("function");
	});

	it("getDefaultRules 返回内置危险规则（12 条）", () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		const rules = deps.getDefaultRules();
		expect(rules.length).toBe(12);
		expect(rules.every((r) => r.source === "builtin-danger")).toBe(true);
	});

	it("analyzeBashStructure 是真实实现（干净命令 → clean=true）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		const analysis = await deps.analyzeBashStructure("ls -la");
		expect(analysis.clean).toBe(true);
		expect(analysis.commands).toEqual([["ls", "-la"]]);
	});

	it("requestUserApproval 走 headless 分支（M1：signal abort → fail-closed deny）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		// M1：headless 无 signal 时永挂，故用已 aborted 的 signal 触发 fail-closed deny。
		const controller = new AbortController();
		controller.abort();
		const decision = await deps.requestUserApproval(
			{ toolName: "bash", command: "rm", reason: "test" },
			{ toolName: "bash", command: "rm", cwd: "/tmp" },
			controller.signal,
		);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
	});

	it("deps 满足 CheckPermissionDeps 类型（结构兼容）", () => {
		const deps: CheckPermissionDeps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		// 仅验证类型兼容（运行时已在上面测试）
		expect(deps).toBeDefined();
	});

	it("m1：每次 createPipelineDeps 创建独立 classifier（CL-classifier-singleton：modelRegistry 绑 ctx 不安全）", () => {
		const ctx = makeMockCtx();
		const deps1 = createPipelineDeps(makeApprovalCtx(), ctx);
		const deps2 = createPipelineDeps(makeApprovalCtx(), ctx);
		// 每次 createPipelineDeps 都新建 classifier（无模块级单例）
		expect(deps1.classifier).not.toBe(deps2.classifier);
		expect(deps1.classifier.classifyRisk).not.toBe(deps2.classifier.classifyRisk);
	});
});
