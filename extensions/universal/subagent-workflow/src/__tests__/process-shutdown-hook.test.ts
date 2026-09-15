/**
 * [V2 决策 7 防线 i] process 级 shutdown hook 测试。
 *
 * 验证 index.ts factory 注册 process.on SIGTERM/SIGINT/beforeExit，handler 触发时
 * 调 killAllSpawnedChildren 收割全部活子进程，且 idempotent（多信号叠加只收割一次）。
 *
 * mock 策略（对齐 wave0-package-structure.test.ts）：
 *   - killAllSpawnedChildren → vi.fn（避免真实 kill + 可断言调用）
 *   - process.on → spy + mockImplementation 捕获 handler（不真实注册，防 listener 泄漏）
 *   - process.kill → spy mock（SIGINT handler re-raise 会 kill 自身，必须拦截防杀测试 runner）
 *   - process.removeListener → spy（断言 SIGINT re-raise 前先摘除自身 listener）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// [W3 改写] mock 目标随符号迁移更换：原 inproc session-runner（engines/pi/）随 W3
// 删件消亡，killAllSpawnedChildren 收敛到 engine/host/spawned-children.ts 公共面
//（宿主收割入口 = 镜像整体置死），index.ts 经 core barrel re-export 消费。mock 该深
// 路径模块（spread actual 保其余导出，镜像其他消费方不受影响），barrel re-export
// 命中同一物理模块 → factory 引用点被替换。
const killAllSpawnedChildrenMock = vi.fn();
vi.mock("@zhushanwen/subagent-core/execution/engine/host/spawned-children.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@zhushanwen/subagent-core/execution/engine/host/spawned-children.ts")>();
  return {
    ...actual,
    killAllSpawnedChildren: (...args: unknown[]) => killAllSpawnedChildrenMock(...(args as [string?])),
  };
});

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

// [HISTORICAL] 2026-09-15 对齐 PR #185 口径：describe 级 30s timeout 豁免——动态
// import("../index.ts") 模块图重（三层全量加载），整包满并行高负载下偶发超 vitest
// 默认 testTimeout，属模块加载 headroom 而非用例逻辑耗时。
describe("[V2 决策 7 防线 i] process 级 shutdown hook", { timeout: 30000 }, () => {
  type Handler = (...args: unknown[]) => void;
  const registered: Partial<Record<string, Handler>> = {};
  let onSpy: ReturnType<typeof vi.spyOn>;
  let removeListenerSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let resetGuard: () => void;

  // hook 显式 timeout：describe 级 { timeout } 不传播给 hook（vitest 4 行为），
  // 动态 import("../index.ts") 大模块图在全量并行高负载下偶发超默认 10s
  beforeEach(async () => {
    killAllSpawnedChildrenMock.mockReset();
    for (const k of Object.keys(registered)) delete registered[k];

    // 捕获 process.on 注册的 handler（不真实注册到全局 process，避免 listener 跨用例泄漏）。
    onSpy = vi.spyOn(process, "on");
    onSpy.mockImplementation(((event: string, handler: Handler) => {
      registered[event] = handler;
      return process;
    }) as never);
    // [review 修复配套] SIGINT handler re-raise 会 process.kill(process.pid, "SIGINT")——
    // 必须 mock 拦截，否则触发 handler 的用例会真实杀掉测试 runner 进程。
    killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    removeListenerSpy = vi.spyOn(process, "removeListener");

    // 直接 import src/index.ts（而非 extension-root/index.ts re-export）——后者只
    // re-export default，拿不到 named export _resetProcessShutdownGuardForTest。
    const mod = await import("../index.ts");
    resetGuard = (
      mod as unknown as { _resetProcessShutdownGuardForTest: () => void }
    )._resetProcessShutdownGuardForTest;
    mod.default(createMockExtensionAPI());
  }, 30000);

  afterEach(() => {
    onSpy.mockRestore();
    killSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it("factory 注册 process.on SIGTERM / SIGINT / beforeExit 三个 hook", () => {
    expect(registered["SIGTERM"]).toBeDefined();
    expect(registered["SIGINT"]).toBeDefined();
    expect(registered["beforeExit"]).toBeDefined();
  });

  it("SIGTERM handler 触发时调 killAllSpawnedChildren(\"SIGTERM\") + process.exitCode = 0", () => {
    resetGuard();
    registered["SIGTERM"]!("SIGTERM");
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledWith("SIGTERM");
    expect(process.exitCode).toBe(0);
  });

  it("SIGINT handler 触发时收割 + re-raise（先 removeListener 自身再 kill 自身，恢复默认终止）", () => {
    resetGuard();
    const beforeExitCode = process.exitCode;
    registered["SIGINT"]!("SIGINT");
    // 收割（SIGTERM 信号收割全部活子进程）
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledWith("SIGTERM");
    // re-raise：先摘除自身 listener（防递归），再向自身重发 SIGINT（无 listener → Node 默认终止）
    expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", registered["SIGINT"]);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    // 不再设 exitCode——退出由默认终止完成（signal death，非自然退出）
    expect(process.exitCode).toBe(beforeExitCode);
  });

  it("beforeExit handler 触发时调 killAllSpawnedChildren 但不 process.kill（自然退出）", () => {
    resetGuard();
    registered["beforeExit"]!();
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledWith("SIGTERM");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("idempotent：多信号叠加（SIGTERM 后又 SIGINT/beforeExit）只收割一次", () => {
    resetGuard();
    registered["SIGTERM"]!("SIGTERM");
    registered["SIGINT"]!("SIGINT");
    registered["beforeExit"]!();
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledTimes(1);
  });

  it("idempotent：session_shutdown 已收割后，process 级 handler 不重复 kill", () => {
    // 模拟 session_shutdown 先触发（resetGuard 后先收割一次），再 process 信号到达。
    resetGuard();
    registered["beforeExit"]!();
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledTimes(1);
    registered["SIGTERM"]!("SIGTERM");
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledTimes(1);
  });
});
