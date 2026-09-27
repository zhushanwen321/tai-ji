/**
 * [V2 决策 7 防线 i] process 级 shutdown hook 测试。
 *
 * 验证 index.ts factory 注册 process.on SIGTERM/SIGINT/beforeExit，handler 触发时
 * 调 markAllSpawnedChildrenDead 清空镜像记账，且 idempotent（多信号叠加只触发一次）。
 *
 * mock 策略（对齐 wave0-package-structure.test.ts）：
 *   - markAllSpawnedChildrenDead → vi.fn（避免真实镜像清空 + 可断言调用）
 *   - process.on → spy + mockImplementation 捕获 handler（不真实注册，防 listener 泄漏）
 *   - process.kill → spy mock（SIGINT handler re-raise 会 kill 自身，必须拦截防杀测试 runner）
 *   - process.removeListener → spy（断言 SIGINT re-raise 前先摘除自身 listener）
 *
 * 装载成本分层：index.ts 模块图三层全量加载——factory 在 beforeAll 只跑一次
 *（process.on 已被 spy 拦截，handler 存 registered Map 不跨用例泄漏），每用例只付
 * mock 重置 + guard 重置。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// [W3 改写] mock 目标随符号迁移更换：原 inproc session-runner（engines/pi/）随 W3
// 删件消亡，markAllSpawnedChildrenDead 收敛到 engine/host/spawned-children.ts 公共面
//（宿主收割入口 = 镜像整体置死），index.ts 经 core barrel re-export 消费。mock 该深
// 路径模块（spread actual 保其余导出，镜像其他消费方不受影响），barrel re-export
// 命中同一物理模块 → factory 引用点被替换。
const markAllSpawnedChildrenDeadMock = vi.fn();
vi.mock("@zhushanwen/subagent-core/execution/engine/host/spawned-children.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@zhushanwen/subagent-core/execution/engine/host/spawned-children.ts")>();
  return {
    ...actual,
    markAllSpawnedChildrenDead: () => markAllSpawnedChildrenDeadMock(),
  };
});

// 直接 import src/index.ts（而非 extension-root/index.ts re-export）——后者只
// re-export default，拿不到 named export _resetProcessShutdownGuardForTest。
// vi.mock 自动提升 → 静态 import 时 mock 面已生效。
import subagentsExtension, { _resetProcessShutdownGuardForTest } from "../index.ts";

/** 最小 mock ExtensionAPI（对齐 wave0-package-structure.test.ts 的 createMockExtensionAPI）。 */
function createMockExtensionAPI(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    appendEntry: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;
}

describe("[V2 决策 7 防线 i] process 级 shutdown hook", () => {
  type Handler = (...args: unknown[]) => void;
  const registered: Partial<Record<string, Handler>> = {};
  let onSpy: ReturnType<typeof vi.spyOn>;
  let removeListenerSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  // [HISTORICAL] 2026-09-15 对齐 PR #185 口径：本 describe 曾用动态 import +
  // describe 级 30s timeout 豁免（每用例付 index.ts 三层全量模块图重求值，高负载下
  // 偶发超默认 testTimeout）。现改静态 import + beforeAll 单次 factory 装载，
  // per-case 大模块图成本消失，30s 豁免随之收敛回默认。
  beforeAll(() => {
    // 捕获 process.on 注册的 handler（不真实注册到全局 process，避免 listener 泄漏）。
    onSpy = vi.spyOn(process, "on");
    onSpy.mockImplementation(((event: string, handler: Handler) => {
      registered[event] = handler;
      return process;
    }) as never);
    // [review 修复配套] SIGINT handler re-raise 会 process.kill(process.pid, "SIGINT")——
    // 必须 mock 拦截，否则触发 handler 的用例会真实杀掉测试 runner 进程。
    killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    removeListenerSpy = vi.spyOn(process, "removeListener");

    subagentsExtension(createMockExtensionAPI());
  });

  beforeEach(() => {
    markAllSpawnedChildrenDeadMock.mockReset();
    // spy 调用记录每用例清零（不清 implementation：spy 拦截面必须跨用例持续在位）
    killSpy.mockClear();
    removeListenerSpy.mockClear();
    _resetProcessShutdownGuardForTest();
  });

  afterAll(() => {
    onSpy.mockRestore();
    killSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it("factory 注册 process.on SIGTERM / SIGINT / beforeExit 三个 hook", () => {
    expect(registered["SIGTERM"]).toBeDefined();
    expect(registered["SIGINT"]).toBeDefined();
    expect(registered["beforeExit"]).toBeDefined();
  });

  it("SIGTERM handler 触发时调 markAllSpawnedChildrenDead() + process.exitCode = 0", () => {
    registered["SIGTERM"]!("SIGTERM");
    expect(markAllSpawnedChildrenDeadMock).toHaveBeenCalledWith();
    expect(process.exitCode).toBe(0);
  });

  it("SIGINT handler 触发时收割 + re-raise（先 removeListener 自身再 kill 自身，恢复默认终止）", () => {
    const beforeExitCode = process.exitCode;
    registered["SIGINT"]!("SIGINT");
    // 镜像记账清空（无参——函数不发任何进程信号）
    expect(markAllSpawnedChildrenDeadMock).toHaveBeenCalledWith();
    // re-raise：先摘除自身 listener（防递归），再向自身重发 SIGINT（无 listener → Node 默认终止）
    expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", registered["SIGINT"]);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    // 不再设 exitCode——退出由默认终止完成（signal death，非自然退出）
    expect(process.exitCode).toBe(beforeExitCode);
  });

  it("beforeExit handler 触发时调 markAllSpawnedChildrenDead 但不 process.kill（自然退出）", () => {
    registered["beforeExit"]!();
    expect(markAllSpawnedChildrenDeadMock).toHaveBeenCalledWith();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("idempotent：多信号叠加（SIGTERM 后又 SIGINT/beforeExit）只收割一次", () => {
    registered["SIGTERM"]!("SIGTERM");
    registered["SIGINT"]!("SIGINT");
    registered["beforeExit"]!();
    expect(markAllSpawnedChildrenDeadMock).toHaveBeenCalledTimes(1);
  });
});
