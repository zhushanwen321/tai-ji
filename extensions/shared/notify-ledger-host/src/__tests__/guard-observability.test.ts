// createPiNotifyLedgerHost 守卫观测参数测试（mock guardStaleCtx 捕获 opts——label
// 只存在于守卫调用参数中，无 mock 不可观测）。vi.mock 对整文件生效，故与真守卫
// 集成用例（create-pi-notify-ledger-host.test.ts）分档；importOriginal 保真
// toErrorMessage（onStale 的 error meta 文案依赖它）。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiNotifyLedgerHost } from "../index.ts";

/** 每次守卫调用的 opts 捕获（mock 前缀 = vi.mock 提升域合法引用）。 */
const mockCapturedGuardOpts: Array<{ label?: string; onStale?: (error?: unknown) => void }> = [];

vi.mock("@zhushanwen/pi-ext-guards", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@zhushanwen/pi-ext-guards")>();
	return {
		...actual,
		guardStaleCtx: vi.fn((fn: () => unknown, opts?: { label?: string; onStale?: (error?: unknown) => void }) => {
			mockCapturedGuardOpts.push(opts ?? {});
			return fn();
		}),
	};
});

function makePi(): ExtensionAPI {
	return { appendEntry: vi.fn(), on: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
}

function makeCtx(): ExtensionContext {
	return {
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
	} as unknown as ExtensionContext;
}

describe("守卫观测参数（label / stale warn 前缀）", () => {
	const MESSAGE = { customType: "bg-notify", content: "x", display: true };

	beforeEach(() => {
		mockCapturedGuardOpts.length = 0;
	});

	it("label = `${component}:sendDelivery`（装配方前缀归因）", () => {
		const host = createPiNotifyLedgerHost(makePi(), makeCtx(), {
			component: "session-manager",
			logger: { warn: vi.fn() },
		});
		host.sendDelivery(MESSAGE);
		expect(mockCapturedGuardOpts.map((o) => o.label)).toEqual(["session-manager:sendDelivery"]);
	});

	it("staleWarnPrefix 缺省：onStale warn 文案无前缀（subagent-workflow 形态，逐字节）", () => {
		const warn = vi.fn();
		createPiNotifyLedgerHost(makePi(), makeCtx(), { component: "subagent-workflow", logger: { warn } }).sendDelivery(
			MESSAGE,
		);
		mockCapturedGuardOpts[0]?.onStale?.(new Error("stale-x"));
		expect(warn).toHaveBeenCalledWith("notify delivery skipped (stale ctx)", { error: "stale-x" });
	});

	it("staleWarnPrefix 注入：onStale warn 文案带前缀（session-manager 形态，逐字节）", () => {
		const warn = vi.fn();
		createPiNotifyLedgerHost(makePi(), makeCtx(), {
			component: "session-manager",
			logger: { warn },
			staleWarnPrefix: "[session-manager] ",
		}).sendDelivery(MESSAGE);
		mockCapturedGuardOpts[0]?.onStale?.(new Error("stale-y"));
		expect(warn).toHaveBeenCalledWith("[session-manager] notify delivery skipped (stale ctx)", { error: "stale-y" });
	});
});
