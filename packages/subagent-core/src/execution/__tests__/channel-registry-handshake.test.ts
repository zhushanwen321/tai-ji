// src/execution/__tests__/channel-registry-handshake.test.ts
//
// 决策 D（修复 M4）：channel handshake 协议升级测试。
//
// 测试对象：extensions/universal/subagent-workflow/src/execution/channel-registry-access.ts
//
// 协议契约（与 ask-user 侧严格对齐）：
//   key 字面量：     "@zhushanwen/pi-subagents.channelHandshake"
//   handshake 形状： { version: 1, registry?: UiChannelRegistry, pending: [{channel,handler}] }
//   canonical 唯一创建点：getOrCreateChannelRegistry（仅 subagent-workflow 侧创建）
//
// 关键不变量：
//   1. canonical registry 永远由 subagent-workflow 创建
//   2. ask-user 先到时只往 slot.pending 推，subagent-workflow 来时 flush
//   3. 重复调用返回同一实例（===）
//   4. version !== 1 时 warn + 丢弃重建

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import {
  CHANNEL_HANDSHAKE_KEY,
  getOrCreateChannelRegistry,
  type ChannelRegistryHandshake,
} from "../assembly/channel-registry-access.ts";

// ── 用例隔离：每个用例前清空 globalThis 槽位 ─────────────────
// handshake 是 globalThis 单例，跨用例污染会破坏测试确定性。
function clearSlot(): void {
  Reflect.deleteProperty(globalThis, CHANNEL_HANDSHAKE_KEY);
}

afterEach(() => {
  clearSlot();
  loggerMock.warn.mockClear();
});

/** 读取当前 slot（绕过本模块的 readHandshakeSlot，测试断言用）。 */
function readRawSlot(): ChannelRegistryHandshake | undefined {
  return Reflect.get(globalThis, CHANNEL_HANDSHAKE_KEY) as ChannelRegistryHandshake | undefined;
}

/** 手动塞一个 slot（模拟 ask-user 先到的场景）。 */
function injectSlot(slot: ChannelRegistryHandshake): void {
  Reflect.set(globalThis, CHANNEL_HANDSHAKE_KEY, slot);
}

describe("getOrCreateChannelRegistry — 空 globalThis 场景", () => {
  it("空 slot → 创建 canonical + slot，返回的 registry 有 register/resolve/list，slot.version===1，pending 为 []", () => {
    clearSlot();
    const registry = getOrCreateChannelRegistry();

    // registry 形状：canonical 三方法
    expect(typeof registry.register).toBe("function");
    expect(typeof registry.resolve).toBe("function");
    expect(typeof registry.list).toBe("function");

    // slot 被填充且形状正确
    const slot = readRawSlot();
    expect(slot).toBeDefined();
    expect(slot!.version).toBe(1);
    expect(slot!.registry).toBe(registry); // slot.registry 指向返回的 registry
    expect(slot!.pending).toEqual([]);
  });
});

describe("getOrCreateChannelRegistry — ask-user 先到（registry 未就绪 + pending 非空）", () => {
  it("模拟 ask-user 先到塞 pending → getOrCreate 创建 canonical + flush pending（handler 注册成功 + pending 清空）", () => {
    clearSlot();
    // ask-user 先到：塞 version:1 slot，registry 未就绪，pending 有 1 条
    const handler = vi.fn();
    injectSlot({
      version: 1,
      pending: [{ channel: "ask_user", handler }],
    });

    const registry = getOrCreateChannelRegistry();

    // canonical registry 被创建，pending 被 flush
    expect(registry.resolve("ask_user")).toBe(handler);
    // pending 已清空
    const slot = readRawSlot();
    expect(slot!.pending).toEqual([]);
    // slot.registry 现在指向返回的 registry
    expect(slot!.registry).toBe(registry);
  });

  it("flush 后 registry.resolve 能拿到 handler（集成验证 resolve 真的能取到）", () => {
    clearSlot();
    const handler = vi.fn();
    injectSlot({
      version: 1,
      pending: [{ channel: "ask_user", handler }],
    });

    const registry = getOrCreateChannelRegistry();
    // 调一次 resolve 拿到的 handler，确认是原始 handler 引用
    const resolved = registry.resolve("ask_user");
    expect(resolved).toBe(handler);
  });
});

describe("getOrCreateChannelRegistry — 二次调用（registry 已就绪）", () => {
  it("二次调用返回同一实例引用（===），不重建，不重复 flush", () => {
    clearSlot();
    const first = getOrCreateChannelRegistry();
    const second = getOrCreateChannelRegistry();
    expect(second).toBe(first); // 引用相等

    // slot.registry 也仍指向同一实例
    const slot = readRawSlot();
    expect(slot!.registry).toBe(first);
    expect(slot!.registry).toBe(second);
  });

  it("二次调用不重复 flush（pending 已清空，再次调用 pending 仍为 []）", () => {
    clearSlot();
    const handler = vi.fn();
    injectSlot({
      version: 1,
      pending: [{ channel: "ask_user", handler }],
    });

    getOrCreateChannelRegistry(); // 第一次：flush + 清空 pending
    getOrCreateChannelRegistry(); // 第二次：应跳过 flush 分支

    const slot = readRawSlot();
    expect(slot!.pending).toEqual([]);
    // handler 仍只被注册一次（resolve 仍是原 handler）
    const registry = slot!.registry!;
    expect(registry.resolve("ask_user")).toBe(handler);
    expect(registry.list()).toEqual(["ask_user"]);
  });
});

describe("getOrCreateChannelRegistry — canonical registry 三方法（形状验证）", () => {
  it("返回的 registry register 后 resolve 拿到 handler，list 列出 channel 名", () => {
    clearSlot();
    const registry = getOrCreateChannelRegistry();
    const handler = vi.fn();
    registry.register("custom_channel", handler);

    expect(registry.resolve("custom_channel")).toBe(handler);
    expect(registry.list()).toContain("custom_channel");
  });

  it("未注册的 channel resolve 返回 undefined", () => {
    clearSlot();
    const registry = getOrCreateChannelRegistry();
    expect(registry.resolve("not_registered")).toBeUndefined();
  });
});

describe("getOrCreateChannelRegistry — 多条 pending flush 顺序与覆盖", () => {
  it("多条 pending（不同 channel）flush 后都被注册，list 顺序保留插入顺序", () => {
    clearSlot();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    injectSlot({
      version: 1,
      pending: [
        { channel: "alpha", handler: h1 },
        { channel: "beta", handler: h2 },
        { channel: "gamma", handler: h3 },
      ],
    });

    const registry = getOrCreateChannelRegistry();
    expect(registry.resolve("alpha")).toBe(h1);
    expect(registry.resolve("beta")).toBe(h2);
    expect(registry.resolve("gamma")).toBe(h3);
    expect(registry.list()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("同名 channel 后者覆盖前者（pending 内重复 channel）", () => {
    clearSlot();
    const old = vi.fn();
    const fresh = vi.fn();
    injectSlot({
      version: 1,
      pending: [
        { channel: "ask_user", handler: old },
        { channel: "ask_user", handler: fresh }, // 后者覆盖
      ],
    });

    const registry = getOrCreateChannelRegistry();
    expect(registry.resolve("ask_user")).toBe(fresh);
    // list 不重复（Map key 唯一）
    expect(registry.list()).toEqual(["ask_user"]);
  });
});

describe("getOrCreateChannelRegistry — version 校验（向前兼容）", () => {
  it("version !== 1（如塞 {version:2,...}）→ warn + 重建为新 slot，旧 pending 数据丢弃", () => {
    clearSlot();
    loggerMock.warn.mockClear();
    // 塞一个 version:2 的 slot，含旧数据
    const staleHandler = vi.fn();
    injectSlot({
      version: 2 as unknown as 1, // 故意写错 version
      registry: undefined,
      pending: [{ channel: "ask_user", handler: staleHandler }],
    });

    const registry = getOrCreateChannelRegistry();

    // warn 被调用
    expect(loggerMock.warn).toHaveBeenCalled();
    // 旧 pending 数据被丢弃（staleHandler 没被注册）
    expect(registry.resolve("ask_user")).toBeUndefined();
    // slot 被重建为 version:1，pending 为空
    const slot = readRawSlot();
    expect(slot!.version).toBe(1);
    expect(slot!.pending).toEqual([]);
    expect(slot!.registry).toBe(registry);
  });

  it("version !== 1 时 warn 消息包含 got/expected 字样", () => {
    clearSlot();
    loggerMock.warn.mockClear();
    injectSlot({ version: 99 as unknown as 1, pending: [] });

    getOrCreateChannelRegistry();

    const msg = loggerMock.warn.mock.calls[0]?.[0] ?? "";
    expect(String(msg)).toMatch(/got/);
    expect(String(msg)).toMatch(/expected/);
  });
});
