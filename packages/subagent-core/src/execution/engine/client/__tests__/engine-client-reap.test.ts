// src/execution/engine/client/__tests__/engine-client-reap.test.ts
//
// [H1 U2 / 红线①收割链] 引擎退出链孤儿收割单测（设计
// docs/design/subagent-chat-run-unification.md §3.3 红线① + §5 U2 验收「收割链各分支」）。
//
// 覆盖分支：
//   - 非主动死亡（!intentionalKill && alreadyDead）POSIX → 复用 killProcessTree 负 pid
//     组杀（fire-and-forget），且仅组杀一次（无外层逐 pid 兜底——grace 窗不被压缩）；
//   - intentionalKill 路径跳过（主动 dispose 链已有两层杀——不叠加、优雅窗零压缩）；
//   - 引擎进程仍活（握手失败重建路径）不触发收割（下方既有组杀兜底承接，行为不变）；
//   - Windows 通道：置死前 mirror.snapshot 过滤活孤儿（state==="running" && !killed——
//     死 pid 与 killed 项不进清单）后逐 pid **异步 spawn** taskkill（无 spawnSync——
//     同步逐个会冻结 onEngineExit 回调、推迟 pending reject）；
//   - 收割插入点 = mirror.killAll() 置死清空之前（Windows 通道依赖快照活项）。
//
// 平台分派说明：Windows 通道经私有方法 reapOrphansViaMirrorSnapshot 直调覆盖
//（process.platform 判据在 vitest worker 内不可 stub——一行字面分派由 U4 真机 Windows
// 验收覆盖）；POSIX 分支用本机真实平台（darwin/linux）断言。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// killProcessTree spy（POSIX 组杀断言）；waitForChildExit 保留真实现（killAll 消费）。
const { killProcessTreeSpy } = vi.hoisted(() => ({ killProcessTreeSpy: vi.fn() }));
vi.mock("../reaper.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../reaper.ts")>();
  return { ...actual, killProcessTree: (...args: unknown[]) => killProcessTreeSpy(...(args as [])) };
});

// node:child_process spawn spy（Windows 通道 taskkill 断言；本文件不走 ensureConnected，
// 引擎 CLI spawn 不被触发）。
const { spawnSpy, spawnSyncSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
    pid: 424242,
  })),
  spawnSyncSpy: vi.fn(() => ({ status: 0, error: undefined })),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnSpy, spawnSync: spawnSyncSpy };
});

import { EngineClient } from "../engine-client.ts";
import type { MirrorEntry } from "../mirror.ts";

function makeClient(): EngineClient {
  return new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: ["-e", ""],
    hostKind: "test",
    hostVersion: "test-host-1.0",
    dataDir: "/tmp/engine-client-reap-test",
    envPrefixes: [],
  });
}

/** 塞一个已死的假引擎 child（exitCode 非 null = alreadyDead 判据命中）。 */
function plantDeadChild(client: EngineClient, pid: number): void {
  (client as unknown as { child: unknown }).child = {
    pid,
    exitCode: 1,
    signalCode: null,
    removeAllListeners: vi.fn(),
    on: vi.fn(),
  };
}

/** 塞一个活着的假引擎 child（alreadyDead 不命中——既有组杀兜底路径）。 */
function plantLiveChild(client: EngineClient, pid: number): void {
  (client as unknown as { child: unknown }).child = {
    pid,
    exitCode: null,
    signalCode: null,
    removeAllListeners: vi.fn(),
    on: vi.fn(),
  };
}

/** 在途请求 pending 直插（pending reject 时序断言用）。 */
function plantPendingRequest(client: EngineClient, id: number): { reject: ReturnType<typeof vi.fn> } {
  const pending = { resolve: vi.fn(), reject: vi.fn(), timer: undefined };
  (client as unknown as { pending: Map<number, typeof pending> }).pending.set(id, pending);
  return pending;
}

function mirrorEntry(pid: number, state: "running" | "exited", killed: boolean): MirrorEntry {
  return { pid, recordId: `sa-${pid}`, state, killed, updatedAt: Date.now() };
}

describe("红线①收割链：非主动死亡路径（POSIX 组杀）", () => {
  beforeEach(() => {
    killProcessTreeSpy.mockClear();
    spawnSpy.mockClear();
    spawnSyncSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("引擎意外死（alreadyDead + !intentionalKill）→ teardownProcess 内 mirror.killAll 之前组杀引擎 pid", () => {
    const client = makeClient();
    plantDeadChild(client, 4321);
    client.mirror.recordSpawned(9100, "sa-a"); // 死前 spawn 的任务子进程（活孤儿）

    (client as unknown as { teardownProcess: (d: string) => void }).teardownProcess("signal SIGKILL");

    // POSIX：复用 killProcessTree 负 pid 组杀（目标 = 引擎 pid，组内含任务子进程——
    // 不依赖镜像）
    expect(killProcessTreeSpy).toHaveBeenCalledTimes(1);
    expect(killProcessTreeSpy).toHaveBeenCalledWith(
      4321,
      expect.stringContaining("reap orphaned children"),
      { engineId: "fake" },
    );
    // 收割插入点在镜像置死之前：killAll 后快照已清（此处仅验证组杀发生在 teardown 内
    // 且镜像最终被置死清空）
    expect(client.mirror.size).toBe(0);
  });

  it("无外层逐 pid 兜底：组杀仅一次（5s grace 窗不被同步校验压缩）", () => {
    const client = makeClient();
    plantDeadChild(client, 4321);
    for (let i = 0; i < 5; i++) client.mirror.recordSpawned(9000 + i, `sa-${i}`); // 多个活孤儿

    (client as unknown as { teardownProcess: (d: string) => void }).teardownProcess("signal SIGKILL");

    // 升级链（SIGTERM → 5s grace → SIGKILL）内建覆盖残余职责：不逐 pid 补杀
    expect(killProcessTreeSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("intentionalKill 路径跳过收割（主动 dispose 链已有两层杀——不叠加、优雅窗零压缩）", () => {
    const client = makeClient();
    plantDeadChild(client, 4321);
    client.mirror.recordSpawned(9100, "sa-a");
    (client as unknown as { intentionalKill: boolean }).intentionalKill = true;

    (client as unknown as { teardownProcess: (d: string) => void }).teardownProcess("after intentional kill");

    expect(killProcessTreeSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(client.mirror.size).toBe(0); // 置死清空照常
  });

  it("引擎进程仍活（握手失败重建路径）→ 不触发收割分支（既有组杀兜底承接，行为不变）", () => {
    const client = makeClient();
    plantLiveChild(client, 4321);

    (client as unknown as { teardownProcess: (d: string) => void }).teardownProcess("handshake failed");

    // alreadyDead 不命中 → 收割链跳过；活进程组杀由 teardown 既有兜底承接（reason 原样）
    expect(killProcessTreeSpy).toHaveBeenCalledTimes(1);
    expect(killProcessTreeSpy).toHaveBeenCalledWith(4321, "handshake failed", { engineId: "fake" });
  });
});

describe("红线①收割链：Windows 通道（镜像快照过滤活孤儿 + 异步 taskkill）", () => {
  beforeEach(() => {
    killProcessTreeSpy.mockClear();
    spawnSpy.mockClear();
    spawnSyncSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("置死前快照过滤活孤儿：仅 state=running && !killed 进 taskkill 清单（历史死 pid 与 killed 项排除）", () => {
    const client = makeClient();
    plantDeadChild(client, 4321);
    client.mirror.recordSpawned(9100, "sa-live-orphan"); // 活孤儿 → 进清单
    client.mirror.recordSpawned(9101, "sa-exited");
    client.mirror.recordStateChanged({ pid: 9101, recordId: "sa-exited", state: "exited", killed: false });
    client.mirror.recordSpawned(9102, "sa-killed");
    client.mirror.recordStateChanged({ pid: 9102, recordId: "sa-killed", state: "exited", killed: true });

    (client as unknown as { reapOrphansViaMirrorSnapshot: (d: string) => void }).reapOrphansViaMirrorSnapshot(
      "signal SIGKILL",
    );

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith("taskkill", ["/PID", "9100", "/T", "/F"], { stdio: "ignore" });
    expect(killProcessTreeSpy).not.toHaveBeenCalled(); // win32 不复用引擎树杀（树根已死 = 空操作）
  });

  it("taskkill 异步 spawn 不阻塞 teardown（pending reject 在同步段完成——Continuation 失败通知链源头不被推迟）", () => {
    const client = makeClient();
    plantDeadChild(client, 4321);
    client.mirror.recordSpawned(9100, "sa-live-orphan");
    const pending = plantPendingRequest(client, 7);

    // Windows 通道直调 + teardown 全流程（快照 → 异步 spawn → killAll → pending reject）
    (client as unknown as { reapOrphansViaMirrorSnapshot: (d: string) => void }).reapOrphansViaMirrorSnapshot(
      "signal SIGKILL",
    );
    (client as unknown as { teardownProcess: (d: string) => void }).teardownProcess("signal SIGKILL");

    // spawn 是异步 fire-and-forget（返回即继续，无同步等待）；spawnSync 零调用——
    // 逐个同步 N×10s 上界会冻结 onEngineExit 同步回调与宿主事件循环
    expect(spawnSpy).toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(pending.reject).toHaveBeenCalledTimes(1); // 同步段完成（engine_crashed）
  });
});
