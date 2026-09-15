// stderr-rotation.test.ts —— W11 引擎侧 stderr 轮转模块守护（设计 §3.9 写入面表
// 「宿主侧引擎 stderr」行 + impl-plan §2.11 规格）。
//
// 三视角：①构建者——路径/参数/轮转原语逐分支；②使用者——tee 落盘经实例维度
// 路径；③观察者——清理三判据（同前缀 + pid 已死 + mtime 过期同时成立才删，
// 双实例互不删对方文件）。

import {
  existsSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupStaleStderrLogs,
  DEFAULT_STDERR_KEEP_DAYS,
  DEFAULT_STDERR_MAX_BYTES,
  isPidAlive,
  rotateStderrLogIfNeeded,
  stderrLogPathFor,
  stderrLogPidOf,
  stderrRotationParams,
  ZCODE_STDERR_LOG_PREFIX,
} from "../logs/stderr-rotation.ts";

let dir: string;
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 3600 * 1000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-stderr-rot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("路径与参数", () => {
  it("实例维度路径：<engineDataDir>/logs/zcode-appserver-stderr-<pid>.log", () => {
    expect(stderrLogPathFor("/data", 1234)).toBe(
      `/data/logs/${ZCODE_STDERR_LOG_PREFIX}1234.log`,
    );
    expect(ZCODE_STDERR_LOG_PREFIX).toBe("zcode-appserver-stderr-");
  });

  it("轮转参数缺省 50MB / 7 天；env 两键覆盖；非法值回缺省", () => {
    expect(DEFAULT_STDERR_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(DEFAULT_STDERR_KEEP_DAYS).toBe(7);
    expect(stderrRotationParams({})).toEqual({
      maxBytes: DEFAULT_STDERR_MAX_BYTES,
      keepDays: DEFAULT_STDERR_KEEP_DAYS,
    });
    expect(
      stderrRotationParams({ TAIJI_LOG_MAX_BYTES: "1024", TAIJI_LOG_KEEP_DAYS: "3" }),
    ).toEqual({ maxBytes: 1024, keepDays: 3 });
    expect(stderrRotationParams({ TAIJI_LOG_MAX_BYTES: "-1", TAIJI_LOG_KEEP_DAYS: "x" })).toEqual(
      stderrRotationParams({}),
    );
  });

  it("pid 解析：本前缀形态（含轮转副本）；非本前缀 undefined", () => {
    expect(stderrLogPidOf("zcode-appserver-stderr-42.log")).toBe(42);
    expect(stderrLogPidOf("zcode-appserver-stderr-42.log.1690000000000")).toBe(42);
    expect(stderrLogPidOf("other.log")).toBeUndefined();
    expect(stderrLogPidOf("zcode-appserver-stderr-abc.log")).toBeUndefined();
  });
});

describe("尺寸轮转", () => {
  it("超阈值 rename 副本返回 true；未超 / 文件不存在返回 false", () => {
    const over = join(dir, "zcode-appserver-stderr-1.log");
    writeFileSync(over, "x".repeat(100));
    expect(rotateStderrLogIfNeeded(over, { maxBytes: 10, keepDays: 7 })).toBe(true);
    expect(
      readdirSync(dir).some((n) => n.startsWith("zcode-appserver-stderr-1.log.")),
    ).toBe(true);

    const under = join(dir, "zcode-appserver-stderr-2.log");
    writeFileSync(under, "x");
    expect(rotateStderrLogIfNeeded(under, { maxBytes: 1024, keepDays: 7 })).toBe(false);

    expect(
      rotateStderrLogIfNeeded(join(dir, "nope.log"), { maxBytes: 1, keepDays: 7 }),
    ).toBe(false);
  });
});

describe("过期清理三判据", () => {
  it("pid 已死 + mtime 过期 → 删；任一不成立 → 保留；双实例互不删对方文件", () => {
    const deadPid = 4_000_000; // 极大概率未被占用；意外存活的保守分支下用例自跳过
    if (isPidAlive(deadPid)) return;
    const deadOld = join(dir, `${ZCODE_STDERR_LOG_PREFIX}${deadPid}.log`);
    const deadFresh = join(dir, `${ZCODE_STDERR_LOG_PREFIX}${deadPid + 1}.log`);
    const aliveOld = join(dir, `${ZCODE_STDERR_LOG_PREFIX}${process.pid}.log`);
    const unrelated = join(dir, "unrelated.log");
    for (const f of [deadOld, deadFresh, aliveOld, unrelated]) writeFileSync(f, "x");
    const old = new Date(NOW - 8 * DAY_MS);
    const fresh = new Date(NOW - 1 * DAY_MS);
    utimesSync(deadOld, old, old);
    utimesSync(deadFresh, fresh, fresh);
    utimesSync(aliveOld, old, old);

    const result = cleanupStaleStderrLogs(dir, {}, NOW);
    expect(existsSync(deadOld)).toBe(false);
    expect(existsSync(deadFresh)).toBe(true); // mtime 未过期
    expect(existsSync(aliveOld)).toBe(true); // 本进程存活——实例文件不删
    expect(existsSync(unrelated)).toBe(true); // 非本前缀
    expect(result).toEqual({ deleted: 1, skipped: 2 });
  });

  it("keepDays env 覆盖生效（1 天删 2 天旧件；7 天保留）", () => {
    const deadPid = 4_000_002;
    if (isPidAlive(deadPid)) return;
    const f = join(dir, `${ZCODE_STDERR_LOG_PREFIX}${deadPid}.log`);
    writeFileSync(f, "x");
    const twoDaysAgo = new Date(NOW - 2 * DAY_MS);
    utimesSync(f, twoDaysAgo, twoDaysAgo);
    expect(cleanupStaleStderrLogs(dir, { TAIJI_LOG_KEEP_DAYS: "1" }, NOW).deleted).toBe(1);
    writeFileSync(f, "x");
    utimesSync(f, twoDaysAgo, twoDaysAgo);
    expect(cleanupStaleStderrLogs(dir, { TAIJI_LOG_KEEP_DAYS: "7" }, NOW).deleted).toBe(0);
  });

  it("目录缺失 → 零删除不抛", () => {
    expect(cleanupStaleStderrLogs(join(dir, "nope"), {}, NOW)).toEqual({
      deleted: 0,
      skipped: 0,
    });
  });
});
