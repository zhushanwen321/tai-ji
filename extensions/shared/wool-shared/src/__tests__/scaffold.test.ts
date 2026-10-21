// scaffold.test.ts — defineWoolExtension 接线：refreshModels D4 语义 + persist publish +
// streamSimple 骨架分发 + 管理命令注册 + 凭据解析捕获。

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { defineWoolExtension, type WoolFamilyExtensionDefinition } from "../scaffold.ts";
import { collectAssistantEvents, expectTextOutcome, assertConformantSequence } from "../testing/harness.ts";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => void;

	function mockPi() {
		const providers = new Map<string, ProviderConfig>();
		const commands: Array<{ name: string; options: { handler: (args: string) => Promise<void> } }> = [];
		const sessionStartHandlers: SessionStartHandler[] = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		const pi = {
			registerProvider: (nameOrProvider: string | { id: string }, config?: ProviderConfig) => {
				if (typeof nameOrProvider === "string" && config !== undefined) {
					providers.set(nameOrProvider, config);
				}
			},
			registerCommand: (name: string, options: { handler: (args: string) => Promise<void> }) => {
				commands.push({ name, options });
			},
			on: (event: string, handler: SessionStartHandler) => {
				if (event === "session_start") {
					sessionStartHandlers.push(handler);
				}
				return () => {};
			},
			appendEntry: (type: string, data?: unknown) => {
				entries.push({ type, data });
			},
			// 测试窥视口：动态清单用例经 pi 取捕获的 provider config。
			providers,
		} as unknown as ExtensionAPI;
		return { pi, providers, commands, sessionStartHandlers, entries };
	}

function echoDefinition(overrides: Partial<WoolFamilyExtensionDefinition> = {}): WoolFamilyExtensionDefinition {
	return {
		familyId: "qoder",
		displayName: "Wool Qoder",
		api: "wool-qoder",
		stream: async (request) => {
			request.driver.open();
			request.driver.text("echo");
			return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
		},
		...overrides,
	};
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	const publications: ModelsPublication[] = [];
	return {
		credential: undefined,
		stored: undefined,
		publish: async (publication: ModelsPublication) => {
			publications.push(publication);
			return true;
		},
		allowNetwork: true,
		force: undefined,
		signal: new AbortController().signal,
		...overrides,
		// 测试窥视口：外部经 context.publish 之外的途径读取记录——挂到函数属性上。
		...( { publications } as Record<string, unknown>),
	} as RefreshModelsContext & { publications: ModelsPublication[] };
}

describe("defineWoolExtension 接线", () => {
	it("按 wool-<family> 注册 provider；api 必填语义由 pi 校验（此处确认透传）", () => {
		const { pi, providers } = mockPi();
		const factory = defineWoolExtension(echoDefinition({ staticModels: [] }));
		factory(pi);
		const config = providers.get("wool-qoder");
		expect(config).toBeDefined();
		expect(config?.api).toBe("wool-qoder");
		expect(config?.name).toBe("Wool Qoder");
		expect(config?.streamSimple).toBeTypeOf("function");
		expect(config?.refreshModels).toBeUndefined(); // 无 fetchModels = 静态清单 provider
	});

	it("静态清单：models 直接装载（echo 形态）", () => {
		const { pi, providers } = mockPi();
		defineWoolExtension(echoDefinition())(pi);
		const models = providers.get("wool-qoder")?.models ?? [];
		expect(Array.isArray(models)).toBe(true);
	});

	it("静态清单 provider 不注册 refreshModels，管理命令按 handlers 注册", () => {
		const { pi, providers, commands } = mockPi();
		defineWoolExtension(
			echoDefinition({
				manageHandlers: { status: async () => ({ loggedIn: false }), detect: async () => ({}), checkin: async () => ({}), clear: async () => ({}) },
			}),
		)(pi);
		expect(providers.get("wool-qoder")?.refreshModels).toBeUndefined();
		expect(commands.map((command) => command.name)).toEqual(["wool-qoder"]);
	});

	describe("refreshModels（D4 语义 + P7 persist 结论）", () => {
		function dynamicDefinition(): WoolFamilyExtensionDefinition {
			return echoDefinition({
				fetchModels: async (ctx) => {
					if (!ctx.allowNetwork) {
						throw new Error("family must not touch network in offline phase");
					}
					return [
						{
							id: "up-1",
							name: "Upstream 1",
							api: "wool-qoder",
							provider: "wool-qoder",
							baseUrl: "https://upstream.invalid",
							type: "chat" as const,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 1024,
						},
					];
				},
			});
		}

		it("离线阶段（allowNetwork=false）：家族不被调用；persist 有值即恢复", async () => {
			const { pi } = mockPi();
			defineWoolExtension(dynamicDefinition())(pi);
			const providers = (pi as unknown as { providers: Map<string, ProviderConfig> }).providers;
			const refreshModels = providers.get("wool-qoder")?.refreshModels;
			expect(refreshModels).toBeTypeOf("function");

			const context = refreshContext({
				allowNetwork: false,
				stored: {
					models: [
						{
							id: "persisted",
							name: "Persisted",
							api: "wool-qoder",
							provider: "wool-qoder",
							baseUrl: "https://upstream.invalid",
							type: "chat" as const,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 1024,
						},
					],
				},
			});
			const result = await refreshModels?.(context);
			expect(result?.map((model) => (model as { id: string }).id)).toEqual(["persisted"]);
		});

		it("带网首拉：家族被调用 → replace → 扩展自己 publish persist（P7 结论）", async () => {
			const { pi } = mockPi();
			defineWoolExtension(dynamicDefinition())(pi);
			const providers = (pi as unknown as { providers: Map<string, ProviderConfig> }).providers;
			const refreshModels = providers.get("wool-qoder")?.refreshModels;
			const context = refreshContext();
			const result = await refreshModels?.(context);
			expect(result?.map((model) => (model as { id: string }).id)).toEqual(["up-1"]);
			const publications = (context as RefreshModelsContext & { publications: ModelsPublication[] }).publications;
			expect(publications).toHaveLength(1);
			expect(publications[0].persist).toBeDefined();
			expect((publications[0].persist as { models: unknown[] }).models).toHaveLength(1);
		});

		it("缓存命中：进程内已有清单且非 force → 家族不被调用、零 publish", async () => {
			const { pi } = mockPi();
			defineWoolExtension(dynamicDefinition())(pi);
			const providers = (pi as unknown as { providers: Map<string, ProviderConfig> }).providers;
			const refreshModels = providers.get("wool-qoder")?.refreshModels;

			const first = refreshContext();
			await refreshModels?.(first);
			const second = refreshContext();
			const result = await refreshModels?.(second);
			expect(result?.map((model) => (model as { id: string }).id)).toEqual(["up-1"]);
			const publications = (second as RefreshModelsContext & { publications: ModelsPublication[] }).publications;
			expect(publications).toHaveLength(0);
		});

		it("force=true 绕过缓存：家族再被调用 + persist 再 publish", async () => {
			const { pi } = mockPi();
			defineWoolExtension(dynamicDefinition())(pi);
			const providers = (pi as unknown as { providers: Map<string, ProviderConfig> }).providers;
			const refreshModels = providers.get("wool-qoder")?.refreshModels;
			await refreshModels?.(refreshContext());
			const forced = refreshContext({ force: true });
			await refreshModels?.(forced);
			const publications = (forced as RefreshModelsContext & { publications: ModelsPublication[] }).publications;
			expect(publications).toHaveLength(1);
		});
	});

	describe("streamSimple", () => {
		it("经骨架执行家族 stream：事件流纪律成立", async () => {
			const { pi, providers, sessionStartHandlers } = mockPi();
			defineWoolExtension(echoDefinition())(pi);
			// 模拟 pi 会话启动：session_start 捕获 registry（凭据解析器）。
			for (const handler of sessionStartHandlers) {
				handler({}, {
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "tok" }),
					},
				} as unknown as ExtensionContext);
			}
			const config = providers.get("wool-qoder");
			const model = { id: "m", api: "wool-qoder", provider: "wool-qoder" } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];
			const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
			const stream = config?.streamSimple?.(model, context, undefined);
			expect(stream).toBeDefined();
			const events = await collectAssistantEvents(stream!);
			assertConformantSequence(events);
			expectTextOutcome(events, "echo");
		});

		it("session_start 未跑即调 streamSimple → fail-fast 拒绝（生命周期 bug 不静默）", async () => {
			const { pi, providers } = mockPi();
			defineWoolExtension(echoDefinition())(pi);
			const config = providers.get("wool-qoder");
			const model = { id: "m", api: "wool-qoder", provider: "wool-qoder" } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];
			const context = { messages: [] } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
			expect(() => config?.streamSimple?.(model, context, undefined)).toThrow(/before session_start/);
		});
	});
});
