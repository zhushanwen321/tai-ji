// src/__tests__/channel-registry-register.test.ts
//
// Tests registerAskUserChannelHandler：ask-user 侧的 globalThis Symbol 握手注册纯函数。
//
// 覆盖（PR #85 #M4 + #M5）：
//   - 空 globalThis → 建 slot（仅 pending），handler 入 pending；**slot.registry === undefined**
//     （M4 核心断言：ask-user 永不创建 registry 实例）
//   - slot 存在但 registry 未就绪 → push pending（registry 仍 undefined）
//   - slot 存在且 registry 就绪 → 直接调 registry.register("ask_user", handler)，pending 不增长
//   - 重复调用：registry 就绪时 register 多次（同名覆盖幂等）；未就绪时 pending.length 增长
//   - version !== 1 → warn + 重建为新 slot，旧 pending 丢弃
//
// 隔离：每个用例前 Reflect.deleteProperty(globalThis, CHANNEL_HANDSHAKE_KEY)。
// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}));

import { beforeEach,describe, expect, it, vi } from "vitest";

import type { ChannelHandler } from "../channel-handler";
import {
	CHANNEL_HANDSHAKE_KEY,
	type ChannelRegistryHandshake,
	registerAskUserChannelHandler,
} from "../channel-registry-register";

// 拿到当前 slot（cast any 安全：测试控制 slot 写入，结构已知）
function readSlot(): ChannelRegistryHandshake | undefined {
	return Reflect.get(globalThis, CHANNEL_HANDSHAKE_KEY) as
		| ChannelRegistryHandshake
		| undefined;
}

/** 塞一个指定 version 的 slot（手动构造，绕过 registerAskUserChannelHandler）。 */
function writeSlot(slot: ChannelRegistryHandshake): void {
	Reflect.set(globalThis, CHANNEL_HANDSHAKE_KEY, slot);
}

/** 用 spy 构造 mock registry：register 是 vi.fn，pending flush 时可断言调用。 */
function makeMockRegistry(): {
	register: ReturnType<typeof vi.fn>;
	resolve: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
} {
	return {
		register: vi.fn(),
		resolve: vi.fn().mockReturnValue(undefined),
		list: vi.fn().mockReturnValue([]),
	};
}

// 占位 handler——测试只关心调用计数和参数，handler 实体不重要
const noopHandler: ChannelHandler = async () => undefined;

describe("registerAskUserChannelHandler", () => {
	beforeEach(() => {
		Reflect.deleteProperty(globalThis, CHANNEL_HANDSHAKE_KEY);
	});

	it("空 globalThis → 建 slot，handler 入 pending，slot.registry === undefined（M4 核心）", () => {
		expect(readSlot()).toBeUndefined();

		registerAskUserChannelHandler(noopHandler);

		const slot = readSlot();
		expect(slot).toBeDefined();
		expect(slot!.version).toBe(1);
		// M4 核心断言：ask-user 永不创建 registry 实例
		expect(slot!.registry).toBeUndefined();
		expect(slot!.pending).toHaveLength(1);
		expect(slot!.pending[0]).toEqual({ channel: "ask_user", handler: noopHandler });
	});

	it("slot 存在但 registry 未就绪 → push pending（registry 仍 undefined）", () => {
		// 预置 slot：version=1，pending=[]，registry 缺失（模拟 subagent-workflow 尚未 session_start）
		const preSlot: ChannelRegistryHandshake = { version: 1, pending: [] };
		writeSlot(preSlot);

		registerAskUserChannelHandler(noopHandler);

		const slot = readSlot();
		expect(slot).toBe(preSlot); // 同一对象，未重建
		expect(slot!.registry).toBeUndefined();
		expect(slot!.pending).toHaveLength(1);
		expect(slot!.pending[0]).toEqual({ channel: "ask_user", handler: noopHandler });
	});

	it("slot 存在且 registry 就绪 → 调 registry.register，pending 不增长", () => {
		const mockRegistry = makeMockRegistry();
		const preSlot: ChannelRegistryHandshake = {
			version: 1,
			registry: mockRegistry as unknown as ChannelRegistryHandshake["registry"],
			pending: [],
		};
		writeSlot(preSlot);

		registerAskUserChannelHandler(noopHandler);

		expect(mockRegistry.register).toHaveBeenCalledTimes(1);
		expect(mockRegistry.register).toHaveBeenCalledWith("ask_user", noopHandler);
		// pending 不增长（直接 register，不进队列）
		expect(preSlot.pending).toHaveLength(0);
	});

	it("registry 就绪时重复 register → register 被调多次（同名覆盖幂等，pending 始终 0）", () => {
		const mockRegistry = makeMockRegistry();
		const preSlot: ChannelRegistryHandshake = {
			version: 1,
			registry: mockRegistry as unknown as ChannelRegistryHandshake["registry"],
			pending: [],
		};
		writeSlot(preSlot);

		const h1: ChannelHandler = async () => "a";
		const h2: ChannelHandler = async () => "b";
		registerAskUserChannelHandler(h1);
		registerAskUserChannelHandler(h2);

		expect(mockRegistry.register).toHaveBeenCalledTimes(2);
		expect(mockRegistry.register).toHaveBeenNthCalledWith(1, "ask_user", h1);
		expect(mockRegistry.register).toHaveBeenNthCalledWith(2, "ask_user", h2);
		expect(preSlot.pending).toHaveLength(0); // 幂等：不进 pending
	});

	it("registry 未就绪时多次 register → pending.length 增长（顺序保留）", () => {
		// 第 1 次：空 globalThis → 建 slot + pending[0]
		const h1: ChannelHandler = async () => "a";
		registerAskUserChannelHandler(h1);
		// 第 2 次：slot 已存在、registry 仍 undefined → pending[1]
		const h2: ChannelHandler = async () => "b";
		registerAskUserChannelHandler(h2);

		const slot = readSlot();
		expect(slot!.registry).toBeUndefined();
		expect(slot!.pending).toHaveLength(2);
		expect(slot!.pending[0]).toEqual({ channel: "ask_user", handler: h1 });
		expect(slot!.pending[1]).toEqual({ channel: "ask_user", handler: h2 });
	});

	it("version !== 1 → warn + 重建为新 slot，旧 pending 丢弃", () => {
		// 塞一个 version=2 的旧 slot（模拟未来协议升级 / 脏数据）
		loggerMock.warn.mockClear();
		const legacyPending = [{ channel: "stale", handler: noopHandler }];
		const legacySlot = {
			version: 2 as const,
			registry: makeMockRegistry() as unknown as ChannelRegistryHandshake["registry"],
			pending: legacyPending,
		};
		writeSlot(legacySlot as unknown as ChannelRegistryHandshake);

		registerAskUserChannelHandler(noopHandler);

		const slot = readSlot();
		// 旧 slot 被替换（version 退回 1，pending 重置为仅含本次注册）
		expect(slot).not.toBe(legacySlot);
		expect(slot!.version).toBe(1);
		expect(slot!.pending).toEqual([{ channel: "ask_user", handler: noopHandler }]);
		// warn 被调用（包含 version mismatch 提示）
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		expect(loggerMock.warn.mock.calls[0]![0]).toContain("version mismatch");
	});

	it("registry 就绪但 slot 已预置 pending → 仍走 register 路径（pending 不被本函数消费）", () => {
		// 边界：subagent-workflow flush 后理论上 pending 应为空，但若 flush 漏了，
		// 新 handler 来时仍应直接 register（不消费遗留 pending——那是 subagent-workflow 的职责）。
		const mockRegistry = makeMockRegistry();
		const preExistingPending = [{ channel: "ask_user", handler: noopHandler }];
		const preSlot: ChannelRegistryHandshake = {
			version: 1,
			registry: mockRegistry as unknown as ChannelRegistryHandshake["registry"],
			pending: preExistingPending,
		};
		writeSlot(preSlot);

		registerAskUserChannelHandler(noopHandler);

		expect(mockRegistry.register).toHaveBeenCalledTimes(1);
		// 遗留 pending 未被消费（长度不变）
		expect(preSlot.pending).toHaveLength(1);
		expect(preSlot.pending).toBe(preExistingPending);
	});
});
