// scaffold.test.ts — defineWoolExtension 接线：refreshModels D4 语义 + persist publish +
// streamSimple 骨架分发 + 管理命令注册 + 凭据解析捕获。

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { defineWoolExtension, type WoolFamilyExtensionDefinition } from "../scaffold.ts";
import { collectAssistantEvents, expectErrorOutcome, expectTextOutcome, assertConformantSequence } from "../testing/harness.ts";

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

	describe("clear 编排（D3 卸载编排②：persist:null 通道）", () => {
		type MockPi = ReturnType<typeof mockPi>;
		async function runClearCommand(
			mock: MockPi,
		): Promise<{ family: string; response: { v: number; ok: boolean; data?: unknown } } | undefined> {
			const manage = mock.commands.find((command) => command.name === "wool-qoder");
			expect(manage).toBeDefined();
			await manage!.options.handler(JSON.stringify({ v: 1, action: "clear" }));
			const last = mock.entries.filter((entry) => entry.type === "wool-manage-response").at(-1);
			return last?.data as { family: string; response: { v: number; ok: boolean; data?: unknown } } | undefined;
		}

		it("动态 provider：家族 clear 后 publish({persist:null}) 删 persist 目录 + 清进程内清单，响应并入 persistCleared:true", async () => {
			const mock = mockPi();
			let familyClearCalled = false;
			defineWoolExtension(
				echoDefinition({
					fetchModels: async () => [],
					manageHandlers: {
						status: async () => ({}),
						detect: async () => ({}),
						checkin: async () => ({}),
						clear: async () => {
							familyClearCalled = true;
							return { cleared: true, note: "family-side clear" };
						},
					},
				}),
			)(mock.pi);
			const providers = (mock.pi as unknown as { providers: Map<string, ProviderConfig> }).providers;
			// refreshModels 先跑一次：建立 publish 通道（模拟管理会话 spawn 时的离线恢复阶段）。
			const context = refreshContext({ allowNetwork: false });
			await providers.get("wool-qoder")?.refreshModels?.(context);

			const entry = await runClearCommand(mock);
			expect(familyClearCalled).toBe(true);
			const publications = (context as RefreshModelsContext & { publications: ModelsPublication[] }).publications;
			expect(publications.some((publication) => publication.persist === null)).toBe(true);
			expect(entry?.response.ok).toBe(true);
			expect(entry?.response.data).toMatchObject({ cleared: true, persistCleared: true });
		});

		it("静态清单 provider：无 refreshModels 通道，clear 回 persistCleared:false（如实报告无可清）", async () => {
			const mock = mockPi();
			defineWoolExtension(
				echoDefinition({
					manageHandlers: {
						status: async () => ({}),
						detect: async () => ({}),
						checkin: async () => ({}),
						clear: async () => ({ cleared: false }),
					},
				}),
			)(mock.pi);
			const entry = await runClearCommand(mock);
			expect(entry?.response.ok).toBe(true);
			expect(entry?.response.data).toMatchObject({ cleared: false, persistCleared: false });
		});

		it("refreshModels 从未跑过的动态 provider：clear 回 persistCleared:false，家族 clear 仍执行", async () => {
			const mock = mockPi();
			let familyClearCalled = false;
			defineWoolExtension(
				echoDefinition({
					fetchModels: async () => [],
					manageHandlers: {
						status: async () => ({}),
						detect: async () => ({}),
						checkin: async () => ({}),
						clear: async () => {
							familyClearCalled = true;
							return {};
						},
					},
				}),
			)(mock.pi);
			const entry = await runClearCommand(mock);
			expect(familyClearCalled).toBe(true);
			expect(entry?.response.data).toMatchObject({ persistCleared: false });
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

		describe("凭据优先级（D2 双通道：options.apiKey > oauth 钩子 > 皆无报错）", () => {
			/** 组装一个记录 resolvedAuth 的家族 stream + 已捕获 registry 的 streamSimple 环境。
			 * model 带 cost 零费率（done 路径 calculateCost 不因缺 cost 抛错）；家族 stream
			 * 对 ok:false 直抛（三家族 stream 的真实行为形态）。 */
			async function setupStream(
				registryResolve: () => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>,
			) {
				const { pi, providers, sessionStartHandlers } = mockPi();
				let seenAuth: unknown;
				let registryCalls = 0;
				defineWoolExtension(
					echoDefinition({
						stream: async (request) => {
							seenAuth = request.resolvedAuth;
							if (!request.resolvedAuth.ok) {
								throw new Error(request.resolvedAuth.error);
							}
							request.driver.open();
							request.driver.text("echo");
							return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
						},
					}),
				)(pi);
				for (const handler of sessionStartHandlers) {
					handler({}, {
						modelRegistry: {
							getApiKeyAndHeaders: async () => {
								registryCalls += 1;
								return registryResolve();
							},
						},
					} as unknown as ExtensionContext);
				}
				const config = providers.get("wool-qoder");
				const model = {
					id: "m",
					api: "wool-qoder",
					provider: "wool-qoder",
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				} as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];
				const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
				return {
					run: (options?: { apiKey?: string }) => {
						const stream = config?.streamSimple?.(model, context, options);
						if (stream === undefined) {
							throw new Error("streamSimple returned undefined");
						}
						return collectAssistantEvents(stream);
					},
					get seenAuth(): unknown {
						return seenAuth;
					},
					get registryCalls(): number {
						return registryCalls;
					},
				};
			}

			it("options.apiKey 在场即采信（registry 不被调，不做 oauth 刷新尝试）", async () => {
				const env = await setupStream(async () => ({ ok: true, apiKey: "registry-key" }));
				const events = await env.run({ apiKey: "models-json-key" });
				assertConformantSequence(events);
				expectTextOutcome(events, "echo");
				expect(env.seenAuth).toEqual({ ok: true, apiKey: "models-json-key" });
				expect(env.registryCalls).toBe(0);
			});

			it("options.apiKey 缺席 → registry oauth 凭据（apiKey 透传家族）", async () => {
				const env = await setupStream(async () => ({ ok: true, apiKey: "oauth-hook-key" }));
				const events = await env.run(undefined);
				assertConformantSequence(events);
				expectTextOutcome(events, "echo");
				expect(env.seenAuth).toEqual({ ok: true, apiKey: "oauth-hook-key" });
				expect(env.registryCalls).toBe(1);
			});

			it("双通道皆无（registry ok 但无 apiKey）→ error 终态带统一「凭据未配置」", async () => {
				const env = await setupStream(async () => ({ ok: true, headers: {} }));
				const events = await env.run(undefined);
				expectErrorOutcome(events, "凭据未配置：经 taiji 向导接入或在 pi 内 /login");
				const seen = env.seenAuth as { ok: boolean; error: string };
				expect(seen.ok).toBe(false);
				expect(seen.error).toContain("凭据未配置");
			});

			it("registry 解析失败（ok:false，如刷新链失败）→ 保留原错误（比统一消息可诊断）", async () => {
				const env = await setupStream(async () => ({ ok: false, error: "oauth refresh failed: 502" }));
				const events = await env.run(undefined);
				expectErrorOutcome(events, "oauth refresh failed: 502");
			});
		});
	});
});
