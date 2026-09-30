// extension-harness.ts — session-manager 测试共享的 extension 装配 harness
//（tool-error-handling / tool-non-json-response / watch-orchestration /
// session-start-recovery 四份测试的 pi/ctx 桩逐字重复提取）。
// 提取的只是装配样板——select 通道行为（deferred watch / action 分发）与全部
// 断言留在各自测试文件。
//
// 初始化顺序约束：本文件运行时 import 被测 ../../index.ts（其再 import
// pi-extension-logger）——测试文件若 mock 该 logger 模块，须先 import
// ./logger-mock.ts 再 import 本文件（见 logger-mock.ts 文件头）。

import { expect, vi, type Mock } from "vitest";

import registerExtension from "../../index.ts";

/** registerTool 捕获的注册工具形态（execute 以六工具用例的固定五参形态调用） */
export interface RegisteredTool { // oe-exempt:20260930:test:测试 harness 契约——多测试文件的断言面引用其字段类型
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

export interface EmittedEvent { // oe-exempt:20260930:test:事件断言形状契约——多测试文件消费
	event: string;
	data: Record<string, unknown>;
}

export interface ExtensionHarness {
	registered: RegisteredTool[];
	emitted: EmittedEvent[];
	/** pi.on 注册的 handler（session_start / session_compact 收口腿触发面） */
	handlers: Record<string, (event: unknown, ctx: unknown) => unknown>;
	/** rpc 模式 ctx 桩（sessionManager.getEntries 读 mountExtension 的 entries 入参） */
	ctx: Record<string, unknown>;
}

export interface ToolHarness extends ExtensionHarness { // oe-exempt:20260930:test:createToolHarness 返回契约，多测试文件消费其字段
	selectMock: Mock;
}

/**
 * 挂载被测 extension：registerTool 捕获工具、on 记录 handler、events.emit 收集事件，
 * ctx 为 rpc 模式 + select 桩 + sessionManager（getEntries → entries）。
 * select 通道实现由用例域提供：tool 级一次性应答（createToolHarness）或
 * watch 级 deferred（各 watch 测试文件自建后传入）。
 */
export function mountExtension(select: Mock, entries: unknown[] = []): ExtensionHarness {
	const registered: RegisteredTool[] = [];
	const emitted: EmittedEvent[] = [];
	const handlers: ExtensionHarness["handlers"] = {};
	registerExtension({
		registerTool: (tool: RegisteredTool) => registered.push(tool),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[event] = handler;
		},
		events: {
			emit: (event: string, data: Record<string, unknown>) => {
				emitted.push({ event, data });
			},
		},
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	} as never);
	const ctx = {
		mode: "rpc" as const,
		hasUI: true,
		ui: { select },
		sessionManager: { getEntries: () => entries, getSessionId: () => "parent-1" },
	};
	return { registered, emitted, handlers, ctx };
}

/** tool 级 harness：select 桩由实现函数构成（一次性应答形态） */
export function createToolHarness(selectImpl: (...args: unknown[]) => Promise<unknown>): ToolHarness {
	const selectMock = vi.fn(selectImpl);
	return { ...mountExtension(selectMock), selectMock };
}

/** 一次 watch 开表调用（deferred——由测试按调用序应答） */
export interface WatchInvocation { // oe-exempt:20260930:test:watch 调用记录形状——断言面契约
	notifyId: string;
	resolve: (value: unknown) => void;
}

/** 按开表顺序 resolve 第 n 次 watch（value = select 回包原样值） */
export function makeRespondWatch(watches: WatchInvocation[]): (index: number, value: unknown) => void {
	return (index, value) => {
		const inv = watches[index];
		if (!inv) throw new Error(`no watch invocation at index ${index}`);
		inv.resolve(value);
	};
}

/** 纯微任务排干（不推进假时钟——攒批窗计时不受污染） */
export async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** 工具文本结果形态（六工具 execute 成功路径的 content 投影） */
export interface ToolTextResult { // oe-exempt:20260930:test:runToolForText 返回契约——断言面消费
	content: Array<{ type: string; text: string }>;
}

function findTool(h: Pick<ExtensionHarness, "registered">, name: string): RegisteredTool {
	const t = h.registered.find((x) => x.name === name);
	if (!t) throw new Error(`tool not registered: ${name}`);
	return t;
}

/** 跑一次工具（callId/params 形态与六工具用例一致：双 undefined + harness ctx） */
export async function runToolCall(
	h: Pick<ExtensionHarness, "registered" | "ctx">,
	name: string,
	params: Record<string, unknown>,
	callId = "call-1",
): Promise<unknown> {
	return findTool(h, name).execute(callId, params, undefined, undefined, h.ctx);
}

/** 跑一次工具并取文本结果（成功路径断言用） */
export async function runToolForText(
	h: Pick<ExtensionHarness, "registered" | "ctx">,
	name: string,
	params: Record<string, unknown>,
	callId = "call-1",
): Promise<ToolTextResult> {
	return (await runToolCall(h, name, params, callId)) as ToolTextResult;
}

/** 工具执行 reject 断言（W4 throw 范式用例形态） */
export async function expectToolRejects(
	h: Pick<ExtensionHarness, "registered" | "ctx">,
	name: string,
	params: Record<string, unknown>,
	pattern: RegExp,
	callId = "call-1",
): Promise<void> {
	await expect(runToolCall(h, name, params, callId)).rejects.toThrow(pattern);
}
