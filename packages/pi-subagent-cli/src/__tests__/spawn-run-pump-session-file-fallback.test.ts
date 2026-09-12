// src/__tests__/spawn-run-pump-session-file-fallback.test.ts
//
// close finalizer 接线测试（sessionFile 兜底面：LC-4 后缀反查 + 仍缺时的响亮 warn）。
//
// 被测对象 = wireChildStdoutPump 的 close 收尾链（LC-4 → 仍缺 warn → resolveExit），
// fake child（PassThrough stdout/stdin + EventEmitter 手动 close）驱动：
//   - close 时 sessionFile 仍缺 → 响亮 warn（含 recordId / unobtainable / 全路 miss
//     归因 / 人工排查指引），run 正常终态（resolveExit 必达）——不静默、不自动认领；
//   - sessionFile 已由握手/header 填上 → 不产生 [sessionfile] warn；
//   - [U-A5] 宿主回调 onChildStateChanged 抛错 → 不逃出 close 监听器，resolveExit
//     必达且 LC-4 兜底链不被跳过（G1：链上任一步抛错不许跳过后续步骤）；
//   - LC-4 回填链 onHandleReady 抛错 → resolveExit 仍必达，sessionFile 已落位
//     （先赋值后回调）；
//   - agent_end 未置位（信号退出）→ 退出码仍按 128+ 折算，warn 步骤不改变退出码口径。
//   - child 'error' 事件（spawn 失败，F4）：失败码 127 收尾 + 错误消息快照落 runEnd，
//     真实 close 迟到再达不得改写已 settle 的失败终态（Node ENOENT 实测时序）。
//
// session 文件 fixture 落在 mkdtempSync 自建目录（tmpdir 白名单，不触碰真实数据目录）。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { configureLoggerSink, resetLoggerSinkForTests, type LogLevel } from "@zhushanwen/subagent-engine-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpawnRunCallbacks } from "../spawn-runner.ts";
import {
  createSessionIdentityTracker,
  wireChildStdoutPump,
  type SessionIdentityTracker,
  type StdoutPumpDeps,
} from "../spawn-run-pump.ts";

/** LC-4 后缀反查目标 sessionId（fixture 文件名 `<ts>_<sessionId>.jsonl` 后缀段）。 */
const SESSION_ID = "pump-sess";

let dir: string;
let logs: Array<{ level: LogLevel; component: string; message: string }>;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "pump-close-"));
  logs = [];
  configureLoggerSink({
    log: (level, component, message) => {
      logs.push({ level, component, message });
    },
  });
});

afterEach(() => {
  resetLoggerSinkForTests();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 本 run 的日志里含 [sessionfile] 的 warn 文案。 */
function sessionFileWarnings(): string[] {
  return logs
    .filter((l) => l.level === "warn" && l.message.includes("[sessionfile]"))
    .map((l) => l.message);
}

/** LC-4 后缀反查目标 fixture（文件在 sessionDir、名以 _<sessionId>.jsonl 结尾即可命中）。 */
function writeLc4Fixture(): string {
  const filePath = join(dir, `20260910T010101_${SESSION_ID}.jsonl`);
  fs.writeFileSync(filePath, `${JSON.stringify({ type: "message", id: "e1" })}\n`);
  return filePath;
}

/** fake child（PassThrough stdout/stdin + 手动 close/error；precedent: ui-request-queue.test.ts）。 */
function makeFakeChild(): {
  child: ChildProcess;
  fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  fireError: (err: Error) => void;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = {
    stdout,
    stdin,
    stderr: null,
    killed: false,
    pid: 4242,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  } as unknown as ChildProcess;
  return {
    child,
    fireClose: (code, signal = null) => {
      emitter.emit("close", code, signal);
      stdout.end();
      stdin.end();
    },
    fireError: (err) => {
      emitter.emit("error", err);
    },
  };
}

interface PumpHarness {
  identity: SessionIdentityTracker;
  exitPromise: Promise<number>;
  fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  fireError: (err: Error) => void;
  readyCalls: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
  runEnd: import("../spawn-run-pump.ts").RunEndState;
}

/** 装配 close 收尾链（endedCleanly 缺省 true = agent_end 主动终结）。 */
function wirePump(
  overrides: Partial<SpawnRunCallbacks> = {},
  endedCleanly = true,
): PumpHarness {
  const { child, fireClose, fireError } = makeFakeChild();
  const readyCalls: PumpHarness["readyCalls"] = [];
  const callbacks: SpawnRunCallbacks = {
    onEvent: () => {},
    onHandleReady: (partial) => {
      readyCalls.push(partial);
    },
    ...overrides,
  };
  const identity = createSessionIdentityTracker(dir, callbacks);
  const runEnd: import("../spawn-run-pump.ts").RunEndState = { endedCleanly };
  const deps: StdoutPumpDeps = {
    child,
    recordId: "rec-pump-test",
    callbacks,
    identity,
    handleSdkEvent: () => {},
    enqueueUi: () => {},
    stderrTee: undefined,
    runEnd,
  };
  return { identity, exitPromise: wireChildStdoutPump(deps), fireClose, fireError, readyCalls, runEnd };
}

describe("close finalizer sessionFile 兜底接线（LC-4 + 仍缺响亮 warn）", () => {
  it("close 时 sessionFile 仍缺：响亮 warn（recordId + unobtainable + 全路 miss 归因 + 排查指引），run 正常终态", async () => {
    const h = wirePump();

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0); // resolveExit 必达 + 正常折算
    expect(h.identity.sessionFile).toBeUndefined();
    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("unobtainable for rec-pump-test");
    expect(warns[0]).toContain("all acquisition paths missed: spawn handshake, late response, agent_end backfill, LC-4 suffix lookup");
    expect(warns[0]).toContain("record finalized without transcript anchor");
    expect(warns[0]).toContain("Recovery:");
  });

  it("sessionFile 已回填（握手/header 命中）：不产生 [sessionfile] warn", async () => {
    writeLc4Fixture();
    const h = wirePump();
    const known = join(dir, "known-session.jsonl");
    h.identity.applyGetStateFields({ sessionFile: known });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBe(known);
    expect(sessionFileWarnings()).toHaveLength(0);
  });

  it("[U-A5] 宿主回调 onChildStateChanged 抛错：不逃出 close 监听器，resolveExit 必达且 LC-4 兜底链不被跳过", async () => {
    const lc4File = writeLc4Fixture();
    const h = wirePump({
      onChildStateChanged: () => {
        throw new Error("宿主镜像回调抛错（模拟 server 组帧链失败）");
      },
    });
    // sessionId 已知（握手只回 sessionId 的形态）、sessionFile 缺 → close 期 LC-4 反查
    h.identity.applyGetStateFields({ sessionId: SESSION_ID });

    // 原实现：异常从 close 监听器逃出（本行即抛）且 LC-4/resolveExit 双双被跳过 → run 永挂
    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0); // resolveExit 必达 + 正常折算（endedCleanly=true）
    expect(h.identity.sessionFile).toBe(lc4File); // LC-4 反查仍执行（必达区）
    expect(sessionFileWarnings()).toHaveLength(0); // LC-4 命中 → 无 unobtainable warn
    // 降级留痕（非 [sessionfile] 前缀，不经过 sessionFileWarnings）
    const allWarnText = logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(allWarnText.some((w) => w.includes("close finalizer step 'reportChildExited' failed for rec-pump-test"))).toBe(true);
  });

  it("LC-4 回填链 onHandleReady 抛错：resolveExit 仍必达，sessionFile 已落位（先赋值后回调）", async () => {
    const lc4File = writeLc4Fixture();
    const h = wirePump({
      onHandleReady: () => {
        throw new Error("server 组帧失败（模拟）");
      },
    });
    h.identity.applyGetStateFields({ sessionId: SESSION_ID });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    // LC-4 命中后 applyGetStateFields 先落 sessionFile 再调 onHandleReady——回调抛错
    // 被 bestEffort 吞掉，落位不回滚
    expect(h.identity.sessionFile).toBe(lc4File);
    const allWarnText = logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(allWarnText.some((w) => w.includes("close finalizer step 'LC-4 suffix lookup' failed for rec-pump-test"))).toBe(true);
    expect(sessionFileWarnings()).toHaveLength(0); // sessionFile 已落位 → 无 unobtainable warn
  });

  it("agent_end 未置位（信号退出）：退出码仍按 128+ 折算，warn 步骤不改变退出码口径", async () => {
    const h = wirePump({}, false);

    h.fireClose(null, "SIGTERM");
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(128);
    expect(h.identity.sessionFile).toBeUndefined();
    expect(sessionFileWarnings()).toHaveLength(1); // 仍缺 → warn 照发（口径与 128+ 并存）
  });
});

describe("child error 事件收尾（spawn 失败形态，F4）", () => {
  /** ENOENT 形态的 fake error（Node spawn 失败的 error 事件等价物）。 */
  const enoentError = (): Error =>
    Object.assign(new Error("spawn /nonexistent/pi ENOENT"), { code: "ENOENT" });

  it("spawn 'error'（典型 ENOENT）：失败码 127 收尾 + 错误快照落 runEnd，绝不伪成功", async () => {
    const h = wirePump({}, false);

    h.fireError(enoentError());
    const exitCode = await h.exitPromise;

    // 子进程从未运行 → 失败终态（127）；(null,null) 的 0 折算（伪成功）已根除
    expect(exitCode).toBe(127);
    expect(h.runEnd.childErrorMessage).toContain("ENOENT");
    // 清理链照走（U-A5）：无身份可回填 → sessionFile 全 miss warn 照发
    expect(h.identity.sessionFile).toBeUndefined();
    expect(sessionFileWarnings().length).toBeGreaterThanOrEqual(1);
  });

  it("error 先达 + 真实 close(-2, null) 迟到再达（Node ENOENT 实测时序）：终态仍 127", async () => {
    const h = wirePump({}, false);

    h.fireError(enoentError());
    // 真实 close 携 negated errno（code=-2）；promise 已按失败口径 settle，
    // close 参数不得经 0 折算改写终态（close finalizer 各步骤幂等重跑无害）
    h.fireClose(-2, null);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(127);
  });

  it("endedCleanly 已置位且无 error：口径不变（回归锚，agent_end 主动 kill 仍 0）", async () => {
    const h = wirePump({}, true);

    h.fireClose(null, "SIGTERM"); // agent_end 后 killChain 的 SIGTERM close
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.runEnd.childErrorMessage).toBeUndefined();
  });
});
