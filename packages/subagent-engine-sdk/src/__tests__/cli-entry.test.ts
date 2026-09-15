// src/__tests__/cli-entry.test.ts
//
// runEngineCliEntry 安装的 logger sink 行为面（stderr 兜底 + host/log 反向请求）：
// debug 级不写 stderr（对齐 logger.ts CONSOLE_SINK 的「debug no-op」语义——引擎
// stderr 落宿主 [rpc:stderr] 全量 console.error 链路，debug 刷屏会淹没真异常，
// 常态路径的分级降噪依赖此跳过），warn/error 照旧落 stderr；host/log 反向请求
// 全级别透传（level 随行，宿主侧自行分级——stderr 跳过不削减宿主可观测面）。
// 子进程真进程形态（非 in-process spy）：sink 写的是子进程 process.stderr，必须
// 经真实 stdio 管道取证；probe 脚本 tmpdir 自写自删（fs-guard 白名单）。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runEngineCliEntry, type CliProtocolServerSink } from "../cli-entry.ts";
import { getLogger, resetLoggerSinkForTests } from "../logger.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SRC_URL_BASE = pathToFileURL(
  fileURLToPath(new URL("../", import.meta.url))
).href;

// probe 载荷（.mjs 经 node 原生 type-stripping import SDK src——同 zcode 引擎 bin
// 的 workspace 回退形态）：安装真实 runEngineCliEntry sink 后逐级打日志，stdout
// 回报 host/log 收到的 level 序列，stdin EOF 触发 rl close 的 debug 留痕（同样
// 不应落 stderr）。
const PROBE_SCRIPT = `
import { runEngineCliEntry } from ${JSON.stringify(`${SRC_URL_BASE}cli-entry.ts`)};
import { getLogger } from ${JSON.stringify(`${SRC_URL_BASE}logger.ts`)};

const reverseLevels = [];
runEngineCliEntry({
  component: "sink-probe",
  server: {
    handleFrame() {},
    reverseRequest(method, params) {
      if (method === "host/log" && params && typeof params.level === "string") {
        reverseLevels.push(params.level);
      }
      return Promise.resolve({ ok: true });
    },
  },
});
const logger = getLogger("sink-probe");
logger.debug("probe-debug-line");
logger.warn("probe-warn-line");
logger.error("probe-error-line");
// host/log 反向请求异步派发（microtask 链），让事件环跑一拍再回报。回报后由
// 宿主（父进程）关 stdin → rl close 触发 debug 留痕（stdin closed——同样不应
// 落 stderr；子进程自关 stdin 对 pipe 形态不产生 EOF，宿主侧关才是真实链路）。
setTimeout(() => {
  process.stdout.write("REVERSE " + JSON.stringify(reverseLevels) + "\\n");
}, 50);
`;

describe("runEngineCliEntry logger sink：debug 不写 stderr（CONSOLE_SINK 语义对齐）", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sdk-cli-entry-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("debug 跳过 stderr；warn/error 落 stderr；host/log 全级别透传", { timeout: 20_000 }, async () => {
    const probePath = join(dir, "sink-probe.mjs");
    writeFileSync(probePath, PROBE_SCRIPT);

    const child = spawn(process.execPath, [probePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    // REVERSE 回报到达后由宿主关 stdin（真实链路：EngineClient 关子进程 stdin →
    // rl close → debug 留痕），再等退出（close 后 stdio 已 flush——取证无竞态）。
    const reported = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`REVERSE 回报未到达；stderr=${stderr}; stdout=${stdout}`)),
        15_000,
      );
      const poll = setInterval(() => {
        if (!stdout.includes("REVERSE ")) return;
        clearInterval(timer);
        clearTimeout(timer);
        resolve();
      }, 10);
      child.once("error", (err: Error) => {
        clearInterval(poll);
        clearTimeout(timer);
        reject(err);
      });
    });
    await reported;
    child.stdin?.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`probe 未退出；stderr=${stderr}; stdout=${stdout}`)),
        15_000,
      );
      child.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (c: number | null) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);

    // warn/error 照旧落 stderr（兜底不丢）
    expect(stderr).toContain("[warn] [sink-probe] probe-warn-line");
    expect(stderr).toContain("[error] [sink-probe] probe-error-line");
    // debug 不落 stderr：显式打点 + rl close 留痕两条路径都要静默
    expect(stderr).not.toContain("[debug]");
    expect(stderr).not.toContain("probe-debug-line");
    expect(stderr).not.toContain("stdin closed");

    // host/log 反向请求全级别透传（debug 仍上报宿主，只是不刷 stderr）
    const reverseLine = stdout
      .split("\n")
      .find((l: string) => l.startsWith("REVERSE "));
    expect(reverseLine).toBeDefined();
    const parsed: unknown = JSON.parse(
      (reverseLine ?? "").slice("REVERSE ".length),
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(["debug", "warn", "error"]);
  });
});

// in-process 插桩覆盖腿：V8 coverage 只统计 vitest 主进程，上方子进程用例里的
// sink 代码跑在 spawn 出的 node 子进程内，不进 lcov → coverage-gate 对 cli-entry.ts
// 的 debug 降噪增量行（if + stderr.write）报 0 覆盖。本 describe 在主进程直调
// runEngineCliEntry，让 sink 闭包被 V8 插桩命中（lcov 命中源）；行为断言与子进程
// 腿同构（stderr 分级降噪 + host/log 全级别透传），真实 stdio 管道取证语义仍由
// 子进程腿独立承担，两条腿互补不替代。
describe("runEngineCliEntry logger sink：in-process 插桩覆盖腿", () => {
  afterAll(() => {
    // runEngineCliEntry 经 configureLoggerSink 把 sink 挂到 globalThis slot，
    // 用后清空防泄漏到同 worker 后续模块（logger.ts 的测试隔离出口）。
    resetLoggerSinkForTests();
  });

  it("debug 跳过 stderr；warn/error 落 stderr；host/log 全级别透传（与子进程腿同构）", async () => {
    const reverseCalls: Array<{ method: string; params: unknown }> = [];
    const fakeServer: CliProtocolServerSink = {
      handleFrame() {},
      reverseRequest(method, params) {
        reverseCalls.push({ method, params });
        return Promise.resolve({ ok: true });
      },
    };

    // 临时劫持 process.stderr.write 收集兜底输出（sink 写的是主进程 stderr，
    // 无真实管道可读）；原引用保存，finally 还原防泄漏到其他用例。劫持窗口只罩
    // runEngineCliEntry 安装 sink + 三条打点，vitest 自身输出不受影响。
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      runEngineCliEntry({ component: "sink-probe-inproc", server: fakeServer });
      const logger = getLogger("sink-probe-inproc");
      logger.debug("inproc-debug-line");
      logger.warn("inproc-warn-line");
      logger.error("inproc-error-line");
    } finally {
      process.stderr.write = originalWrite;
    }

    // debug 不落 stderr（降噪）；warn/error 照旧落 stderr（兜底不丢）。
    const stderrText = captured.join("");
    expect(stderrText).not.toContain("[debug]");
    expect(stderrText).not.toContain("inproc-debug-line");
    expect(stderrText).toContain("[warn] [sink-probe-inproc] inproc-warn-line");
    expect(stderrText).toContain("[error] [sink-probe-inproc] inproc-error-line");

    // host/log 反向请求同步发起、应答异步（microtask），等一拍再取证全级别透传。
    await Promise.resolve();
    const hostLog = reverseCalls.filter((c) => c.method === "host/log");
    expect(hostLog).toHaveLength(3);
    expect(hostLog.map((c) => (c.params as { level: string }).level)).toEqual([
      "debug",
      "warn",
      "error",
    ]);
  });
});
