// src/__tests__/alive-store.test.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// [U1 A4] removeAliveMarker 失败留痕断言需要 warn 可观察。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// fs partial mock：unlinkSync 可注错（release 失败留痕用例），其余转发真实实现。
// ESM namespace 不可直接赋值/spyOn，注错必须走模块 mock（state-marker.test.ts 同款）。
type UnlinkSyncFn = typeof import("node:fs").unlinkSync;
const { unlinkSyncMock, actualUnlinkRef } = vi.hoisted(() => ({
  unlinkSyncMock: vi.fn(),
  actualUnlinkRef: { current: undefined as UnlinkSyncFn | undefined },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  actualUnlinkRef.current = actual.unlinkSync;
  return {
    ...actual,
    unlinkSync: unlinkSyncMock,
    default: { ...actual, unlinkSync: unlinkSyncMock },
  };
});

import {
  findForeignLiveInstance,
  isProcessAlive,
  readAliveMarker,
  removeAliveMarker,
  writeAliveMarker,
} from "../alive-store.ts";
import type { AliveMarker } from "../types.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alive-store-test-"));
}

/**
 * [U1 A4] 「异进程且存活」的确定性模拟 pid：1 号进程（launchd/init）必然存在且非
 * 本测试进程——kill(1, 0) 对普通用户返回 EPERM，isProcessAlive 按「存在但无权限」
 * 保守判活。self-pid 排除后不能再以本进程 pid 模拟异进程实例。
 */
const FOREIGN_LIVE_PID = 1;

describe("alive-store", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    // unlinkSync mock 基线复位 = 真实实现（个别用例注错覆盖后恢复）。
    if (actualUnlinkRef.current !== undefined) {
      unlinkSyncMock.mockReset().mockImplementation(actualUnlinkRef.current);
    }
    loggerMock.warn.mockClear();
  });

  // ── writeAliveMarker + readAliveMarker 往返 ──

  it("write → read round-trip", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const marker: AliveMarker = { pid: 12345, id: "bg-1-abc", startedAt: Date.now() };

    writeAliveMarker(sessionFile, marker);
    const result = readAliveMarker(sessionFile);

    expect(result).toEqual(marker);
    // 验证 sidecar 文件是单行 JSON
    const raw = fs.readFileSync(`${sessionFile}.alive`, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trim())).toEqual(marker);
  });

  // ── readAliveMarker 损坏文件 ──

  it("readAliveMarker returns undefined for corrupted file", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(`${sessionFile}.alive`, "not-json", "utf-8");

    expect(readAliveMarker(sessionFile)).toBeUndefined();
  });

  it("readAliveMarker returns undefined for structurally invalid JSON", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    // pid 字段缺失
    fs.writeFileSync(`${sessionFile}.alive`, '{"id":"x","startedAt":1}\n', "utf-8");

    expect(readAliveMarker(sessionFile)).toBeUndefined();
  });

  it("readAliveMarker returns undefined when file does not exist", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");

    expect(readAliveMarker(sessionFile)).toBeUndefined();
  });

  // ── removeAliveMarker ──

  it("removeAliveMarker removes existing sidecar", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const marker: AliveMarker = { pid: 1, id: "x", startedAt: 0 };

    writeAliveMarker(sessionFile, marker);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);

    removeAliveMarker(sessionFile);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });

  it("removeAliveMarker does not throw when file does not exist", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");

    expect(() => removeAliveMarker(sessionFile)).not.toThrow();
  });

  // ── isProcessAlive ──

  it("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive returns false for non-existent pid", () => {
    // pid 0 不存在于用户空间（kill(0,0) 在某些 OS 有特殊语义，用大数更安全）
    expect(isProcessAlive(9999999)).toBe(false);
  });

  it("isProcessAlive returns true for EPERM (process exists but no permission)", () => {
    // 模拟 EPERM：进程存在但无权限发信号
    const err = new Error("EPERM") as NodeJS.ErrnoException;
    err.code = "EPERM";
    const originalKill = process.kill;
    process.kill = (_pid: number, _signal?: string | number) => {
      throw err;
    };
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  it("isProcessAlive returns false for ESRCH (no such process)", () => {
    // 模拟 ESRCH：进程不存在
    const err = new Error("ESRCH") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    const originalKill = process.kill;
    process.kill = (_pid: number, _signal?: string | number) => {
      throw err;
    };
    try {
      expect(isProcessAlive(12345)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });

  it("isProcessAlive returns false for unknown errors", () => {
    // 模拟未知错误：保守判死
    const originalKill = process.kill;
    process.kill = (_pid: number, _signal?: string | number) => {
      throw new Error("unknown error");
    };
    try {
      expect(isProcessAlive(12345)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });

  // ── [U1 A4] findForeignLiveInstance：self-pid 排除 + pid 单判据三态 ──

  describe("findForeignLiveInstance（D3c/D3b v7：self-pid 排除 + pid 单判据）", () => {
    it("本进程 pid（marker.pid === process.pid）→ 放行（视同无 foreign，D3c 排除）", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      writeAliveMarker(sessionFile, { pid: process.pid, id: "bg-1", startedAt: Date.now() });

      expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
    });

    it("异进程 pid 活 → 拦截（返回 marker，在持声明）", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const marker: AliveMarker = { pid: FOREIGN_LIVE_PID, id: "bg-1", startedAt: Date.now() };
      writeAliveMarker(sessionFile, marker);

      expect(findForeignLiveInstance(sessionFile)).toEqual(marker);
    });

    it("pid 死 → 放行（确死，允许透明重生）", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      // 大 pid 用户空间必然不存在（isProcessAlive ESRCH 判死，与既有用例同款手法）
      writeAliveMarker(sessionFile, { pid: 9999999, id: "bg-1", startedAt: Date.now() });

      expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
    });

    it("软超时不再参与判定：异进程 pid 活 + startedAt 超 1h 仍拦截（防御不随 idle 时长衰减）", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const stale: AliveMarker = {
        pid: FOREIGN_LIVE_PID,
        id: "bg-1",
        startedAt: Date.now() - 2 * 3_600_000, // 2h 前——旧三判据形态下会超软超时放行
      };
      writeAliveMarker(sessionFile, stale);

      expect(findForeignLiveInstance(sessionFile)).toEqual(stale);
    });

    it("marker 缺失/损坏 → 放行（无声明）", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
      fs.writeFileSync(`${sessionFile}.alive`, "not-json", "utf-8");
      expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
    });
  });

  // ── [U1] removeAliveMarker 失败留痕（D3a：release 失败 bestEffort 留痕）──

  describe("removeAliveMarker 失败留痕", () => {
    it("删除失败（非 ENOENT）→ warn 留痕不抛出", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      writeAliveMarker(sessionFile, { pid: 1, id: "x", startedAt: 0 });
      unlinkSyncMock.mockImplementation(() => {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });
      expect(() => removeAliveMarker(sessionFile)).not.toThrow();
      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    });

    it("ENOENT（marker 不存在）→ 静默（幂等终态，无 warn）", () => {
      tmpDir = makeTmpDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      unlinkSyncMock.mockImplementation(() => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });
      expect(() => removeAliveMarker(sessionFile)).not.toThrow();
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });
  });
});
