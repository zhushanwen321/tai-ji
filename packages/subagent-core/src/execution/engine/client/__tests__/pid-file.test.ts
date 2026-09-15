// pidfile 单元测试（W2，impl-plan §2.2「pidfile」+ §7.2 R9-3 / R9-3b）。
//
// 测试红线：禁真实数据目录——全部文件操作在 mkdtempSync 自建目录；「杀」一律注入
// killEngine fake，绝不真杀（真实杀路径的真机验证归 A8④ 场景族）。

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isProcessAlive,
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

const longLived: Array<{ stop: () => void }> = [];
function track<P extends { pid: number; stop: () => void }>(proc: P): P {
  longLived.push(proc);
  return proc;
}
afterEach(() => {
  for (const p of longLived.splice(0)) p.stop();
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

describe("pidfile 三条件清扫", () => {
  it("pid 已死（宿主崩溃残留）→ 陈旧文件被 unlink（R9-3 防堆积）", async () => {
    const deadHost = await spawnDeadProcess();
    const path = writePidfile("zcode", "pi", deadHost, 999999, null);
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => true,
    });
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.file.endsWith(`engine.pi.${deadHost}.pid`))).toBe(true);
    expect(result.killed).toEqual([]);
  });

  it("三条件全立（pid 活 + cmdline 符合 + engineStartTime 匹配 + 宿主死）→ 杀（注入 fake）+ 删文件", async () => {
    const engine = track(spawnLongLived());
    const deadHost = await spawnDeadProcess();
    // R9-3b 匹配分支：pidfile 记录目标 pid 的真实 OS 启动时间（readProcessStartTime
    // 与清扫内部同一数据源，真值一致）。
    const realStartTime = readProcessStartTime(engine.pid);
    expect(realStartTime).toBeDefined();
    const path = writePidfile("zcode", "pi", deadHost, engine.pid, realStartTime!);
    const killed: number[] = [];
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: (cmdline) => cmdline.includes(process.execPath.replace(/\\/g, "")) || cmdline.includes("node"),
      killEngine: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([engine.pid]);
    expect(existsSync(path)).toBe(false);
    expect(result.killed).toEqual([engine.pid]);
    expect(result.removed.some((r) => r.reason.includes("swept after kill"))).toBe(true);
  });

  it("R9-3b：engineStartTime 不匹配（同 cmdline 的 pid 复用）→ 判定不成立：删文件不杀", async () => {
    const engine = track(spawnLongLived());
    const deadHost = await spawnDeadProcess();
    // 写入一个必然不匹配的假启动时间（真实 lstart 是当天日期，假值取 2000 年）。
    const path = writePidfile("zcode", "pi", deadHost, engine.pid, "Sat Jan  1 00:00:00 2000");
    let killCalled = 0;
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => true,
      killEngine: () => {
        killCalled += 1;
      },
    });
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(
      result.removed.some((r) => r.reason.includes("start-time-mismatch")),
    ).toBe(true);
    // 进程未被波及（保守方向：复用识别后只清文件）
    expect(isProcessAlive(engine.pid)).toBe(true);
  });

  it("cmdline 身份校验不符（pid 被复用给无关进程）→ 判定不成立：删文件不杀（防误杀）", async () => {
    const engine = track(spawnLongLived());
    const deadHost = await spawnDeadProcess();
    const path = writePidfile("zcode", "pi", deadHost, engine.pid, null);
    // 让 engineStartTime 分支在 cmdline 之后短路：cmdline 谓词恒 false。
    let killCalled = 0;
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => false,
      killEngine: () => {
        killCalled += 1;
      },
    });
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.reason.includes("cmdline-mismatch"))).toBe(true);
  });

  it("宿主 pid 存活（活实例 / pid 复用疑似）→ 保守跳过不杀 + 保留文件（R9-3）", () => {
    const engine = track(spawnLongLived());
    const path = writePidfile("zcode", "pi", process.pid, engine.pid, null);
    let killCalled = 0;
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid + 1, // 不是自己的文件
      matchesEngineCmdline: () => true,
      killEngine: () => {
        killCalled += 1;
      },
    });
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(result.skipped.some((s) => s.reason === "host-pid-alive")).toBe(true);
  });

  it("自己的 pidfile（hostPid = 当前宿主）→ 跳过", () => {
    const path = writePidfile("zcode", "pi", process.pid, 123456, null);
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => true,
      killEngine: () => {
        throw new Error("must not kill own pidfile entry");
      },
    });
    expect(existsSync(path)).toBe(true);
    expect(result.skipped.some((s) => s.reason === "own-pidfile")).toBe(true);
  });

  it("Windows 平台：不杀只删（无可移植判据，安全方向）", async () => {
    const engine = track(spawnLongLived());
    const deadHost = await spawnDeadProcess();
    const path = writePidfile("zcode", "pi", deadHost, engine.pid, null);
    let killCalled = 0;
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => true,
      platform: "win32",
      killEngine: () => {
        killCalled += 1;
      },
    });
    expect(killCalled).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(result.removed.some((r) => r.reason.includes("win32 never kills"))).toBe(true);
  });

  it("无数量上限：多个陈旧文件一次全清（宿主崩溃重启 N 次的堆积回收）", async () => {
    const deadHosts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      deadHosts.push(await spawnDeadProcess());
      writePidfile("zcode", "pi", deadHosts[i], 999999, null);
    }
    const result = sweepStalePidfiles({
      engineDataDir: dataDir,
      engineId: "zcode",
      currentHostPid: process.pid,
      matchesEngineCmdline: () => true,
    });
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
