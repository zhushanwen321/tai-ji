// pidfile 单元测试（W2，impl-plan §2.2「pidfile」+ §7.2 R9-3 / R9-3b）。
//
// 测试红线：禁真实数据目录——全部文件操作在 mkdtempSync 自建目录；「杀」一律注入
// killEngine fake，绝不真杀（真实杀路径的真机验证归 A8④ 场景族）。
//
// [单测层极端测试整治] 三条件清扫的进程事实（pid 存活 / cmdline / OS 启动时间）经
// SweepStalePidfilesOptions 探测原语注入为确定性桩（判据③→确定性同步化）：清扫
// 判定链本身是纯逻辑，不依赖真进程即可全覆盖；真实 ps/lstart 探测链保留 1 条
// 冒烟挂 TAIJI_TEST_INTEGRATION 门控（本地默认跳过、CI 真跑）。

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../../../../test-guard/integration-gate.ts";
import {
  probePidAliveness,
  pidfilePath,
  readPidfile,
  readProcessStartTime,
  removePidfile,
  sweepStalePidfiles,
  writePidfileAtomic,
} from "../pid-file.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w2-pidfile-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function writePidfile(engineId: string, hostKind: string, hostPid: number, enginePid: number, engineStartTime: string | null): string {
  const path = pidfilePath(dataDir, engineId, hostKind, hostPid);
  writePidfileAtomic(path, {
    enginePid,
    hostPid,
    engineStartTime,
    engineId,
    hostKind,
    writtenAt: new Date().toISOString(),
  });
  return path;
}

describe("pidfile 原子写/读/删", () => {
  it("文件名 = engine.<hostKind>.<hostPid>.pid（实例维度，不共用 engine.pid）；内容含三要素", () => {
    const path = writePidfile("zcode", "pi", 111, 222, "Mon Sep  8 21:14:32 2026");
    expect(path.endsWith(join("engines", "zcode", "engine.pi.111.pid"))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readPidfile(path)).toMatchObject({
      enginePid: 222,
      hostPid: 111,
      engineStartTime: "Mon Sep  8 21:14:32 2026",
      engineId: "zcode",
      hostKind: "pi",
    });
    removePidfile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("坏 JSON / 缺关键字段 → readPidfile undefined（调用方按陈旧处理）", () => {
    const dir = join(dataDir, "engines", "x");
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, "engine.pi.1.pid");
    writeFileSync(bad, "{not json");
    expect(readPidfile(bad)).toBeUndefined();
    const incomplete = join(dir, "engine.pi.2.pid");
    writeFileSync(incomplete, JSON.stringify({ enginePid: 1 }));
    expect(readPidfile(incomplete)).toBeUndefined();
  });
});

describe("pidfile 三条件清扫（探测原语注入桩）", () => {
  /** 桩探测环境：pid 事实全部由注入原语给出（不触碰真实进程表）。 */
  interface ProbeWorld {
    /** 存活 pid 集合（probeAliveness 按此回答；其余 pid 一律已死）。 */
    alivePids?: Set<number>;
    /** 存活 pid 的 cmdline（缺省给一个含 node 的引擎形态命令行）。 */
    cmdlineOf?: (pid: number) => string;
    /** 存活 pid 的 OS 启动时间（缺省与 pidfile 写入值一致的固定串）。 */
    startTimeOf?: (pid: number) => string;
  }

  const MATCHED_START_TIME = "Mon Sep  8 21:14:32 2026";

  function sweepWith(
    world: ProbeWorld,
    opts: Partial<Parameters<typeof sweepStalePidfiles>[0]> = {},
  ) {
    return sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: (cmdline) => cmdline.includes("node"),
      ...opts,
      probeAliveness: (pid) => (world.alivePids?.has(pid) ? true : false),
      readCmdline: (pid) =>
        world.alivePids?.has(pid) ? (world.cmdlineOf?.(pid) ?? "/usr/local/bin/node /engines/fake/bin/cli.js") : undefined,
      readStartTime: (pid) =>
        world.alivePids?.has(pid) ? (world.startTimeOf?.(pid) ?? MATCHED_START_TIME) : undefined,
    });
  }

  it("pid 已死（宿主崩溃残留）→ 陈旧文件被 unlink（R9-3 防堆积）", () => {
    // 宿主 pid 与引擎 pid 都不在存活集 → 宿主死 + 引擎死 双成立
    const path = writePidfile("zcode", "pi", 4711, 999_999_998, null);
    const result = sweepWith({});
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.file.endsWith(`engine.pi.4711.pid`))).toBe(true);
    expect(result.removed.some((r) => r.reason === "engine-pid-dead")).toBe(true);
    expect(result.killed).toEqual([]);
  });

  it("三条件全立（pid 活 + cmdline 符合 + engineStartTime 匹配 + 宿主死）→ 杀（注入 fake）+ 删文件", () => {
    const path = writePidfile("zcode", "pi", 4711, 4242, MATCHED_START_TIME);
    const killed: number[] = [];
    const result = sweepWith(
      { alivePids: new Set([4242]) },
      {
        killEngine: (pid) => killed.push(pid),
      },
    );
    expect(killed).toEqual([4242]);
    expect(existsSync(path)).toBe(false);
    expect(result.killed).toEqual([4242]);
    expect(result.removed.some((r) => r.reason.includes("swept after kill"))).toBe(true);
  });

  it("R9-3b：engineStartTime 不匹配（同 cmdline 的 pid 复用）→ 判定不成立：删文件不杀", () => {
    const path = writePidfile("zcode", "pi", 4711, 4242, "Sat Jan  1 00:00:00 2000");
    let killCalled = 0;
    // 桩启动时间与 pidfile 记录值必然不同（pid 复用的 OS 事实模拟）
    const result = sweepWith(
      { alivePids: new Set([4242]), startTimeOf: () => MATCHED_START_TIME },
      {
        killEngine: () => {
          killCalled += 1;
        },
      },
    );
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.reason.includes("start-time-mismatch"))).toBe(true);
  });

  it("cmdline 身份校验不符（pid 被复用给无关进程）→ 判定不成立：删文件不杀（防误杀）", () => {
    const path = writePidfile("zcode", "pi", 4711, 4242, null);
    let killCalled = 0;
    // 存活 pid 的 cmdline 是无关进程（不含 node）——cmdline 谓词恒 false 分支
    const result = sweepWith(
      { alivePids: new Set([4242]), cmdlineOf: () => "/usr/sbin/cupsd -f" },
      {
        killEngine: () => {
          killCalled += 1;
        },
      },
    );
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.reason.includes("cmdline-mismatch"))).toBe(true);
  });

  it("宿主 pid 存活（活实例 / pid 复用疑似）→ 保守跳过不杀 + 保留文件（R9-3）", () => {
    const path = writePidfile("zcode", "pi", 4712, 4242, null);
    let killCalled = 0;
    const result = sweepWith(
      { alivePids: new Set([4712, 4242]) },
      {
        currentHostPid: process.pid + 1, // 不是自己的文件
        killEngine: () => {
          killCalled += 1;
        },
      },
    );
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(result.skipped.some((s) => s.reason === "host-pid-alive")).toBe(true);
  });

  it("自己的 pidfile（hostPid = 当前宿主）→ 跳过", () => {
    const path = writePidfile("zcode", "pi", process.pid, 123456, null);
    const result = sweepWith({});
    expect(existsSync(path)).toBe(true);
    expect(result.skipped.some((s) => s.reason === "own-pidfile")).toBe(true);
  });

  it("Windows 平台：不杀只删（无可移植判据，安全方向）", () => {
    const path = writePidfile("zcode", "pi", 4711, 4242, null);
    let killCalled = 0;
    const result = sweepWith(
      { alivePids: new Set([4242]) },
      {
        platform: "win32",
        killEngine: () => {
          killCalled += 1;
        },
      },
    );
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.reason.includes("win32 never kills"))).toBe(true);
  });

  it("无数量上限：多个陈旧文件一次全清（宿主崩溃重启 N 次的堆积回收）", () => {
    for (const hostPid of [4711, 4712, 4713]) {
      writePidfile("zcode", "pi", hostPid, 999_999_998, null);
    }
    const result = sweepWith({});
    expect(result.removed.length).toBe(3);
    expect(readdirSync(join(dataDir, "engines", "zcode")).filter((f) => f.endsWith(".pid"))).toEqual([]);
  });

  it("目录不存在（首次启动）→ 空结果不抛错", () => {
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "never-created",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => true,
    });
    expect(result).toEqual({ killed: [], removed: [], skipped: [] });
  });
});

// ── 真实探测链冒烟（进程事实 = 判据③，挂 TAIJI_TEST_INTEGRATION 门控）────────────
// 覆盖真实 ps command=/lstart= 探测 + 真进程存活判定与清扫判定链的对接（mock 桩覆盖
// 判定逻辑全分支；此处只验「真实原语 ↔ 判定链」的数据形态对接，杀仍注入 fake）。
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `pidfile 三条件清扫（真实探测链冒烟）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
    /** 造一个已死的宿主 pid：短命进程跑完即尸。 */
    function spawnDeadProcess(): Promise<number> {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
        child.once("exit", () => resolve(child.pid!));
      });
    }

    /** 造一个长活进程（返回 stop 函数）；cmdline 形态可被 matchesEngineCmdline 命中。 */
    function spawnLongLived(): { pid: number; stop: () => void } {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      return { pid: child.pid!, stop: () => process.kill(child.pid!, "SIGKILL") };
    }

    it("三条件全立（真实进程 + 真实 ps 探测）→ 杀（注入 fake）+ 删文件", async () => {
      const engine = spawnLongLived();
      try {
        const deadHost = await spawnDeadProcess();
        // pidfile 记录目标 pid 的真实 OS 启动时间（readProcessStartTime 与清扫内部
        // 同一数据源，真值一致）
        const realStartTime = readProcessStartTime(engine.pid);
        expect(realStartTime).toBeDefined();
        const path = writePidfile("zcode", "pi", deadHost, engine.pid, realStartTime!);
        const killed: number[] = [];
        const result = sweepStalePidfiles({
          engineDataDir: dataDir,
          engineId: "zcode",
          currentHostPid: process.pid,
          matchesEngineCmdline: (cmdline) =>
            cmdline.includes(process.execPath.replace(/\\/g, "")) || cmdline.includes("node"),
          killEngine: (pid) => killed.push(pid),
        });
        expect(killed).toEqual([engine.pid]);
        expect(existsSync(path)).toBe(false);
        expect(result.killed).toEqual([engine.pid]);
        expect(result.removed.some((r) => r.reason.includes("swept after kill"))).toBe(true);
      } finally {
        engine.stop();
      }
    });

    it("真实 pid 探测语义：活进程 true、已回收死 pid false（probePidAliveness 契约锚）", async () => {
      const alive = spawnLongLived();
      try {
        expect(probePidAliveness(alive.pid)).toBe(true);
      } finally {
        alive.stop();
      }
      const dead = await spawnDeadProcess();
      expect(probePidAliveness(dead)).toBe(false);
    });
  },
);
