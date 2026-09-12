// src/execution/__tests__/state-marker.test.ts
//
// state-marker 专属测试（L4 合并：finalized-marker + tombstone-store 两模块收编）。
//
// 覆盖四层：
//   1. 写侧（.state 单一权威）：finalized/cancelled 往返、旧名残留清理；
//   2. 写侧响亮重试（U1 A3 / §3.4）：3 次指数退避（100ms 起）+ 仍失败 logger.error
//      响亮暴露返回 false（旧 best-effort 静默语义退役）；
//   3. 读侧（兼容读）：.state 优先、旧 .finalized / .cancelled 归一、旧名共存优先级
//   （.cancelled > .finalized，对齐合并前判定分支序）、损坏降级边界；
//   4. statStateStamp（缓存校验戳）：三文件合并戳的存在性/变化语义。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [U1 A3] 响亮重试断言需要 error 级日志可观察（对齐 record-store.test.ts mock 模式）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

// fs partial mock：writeFileSync 可注错（暂时/持久失败注入），其余转发真实实现
// （模式对齐 manifest-store-tmp-recovery.test.ts）。ESM namespace 不可 spyOn，
// 注错必须走模块 mock；真实实现引用收进 hoisted holder（vi.mock factory 先于
// 模块级 let 初始化执行，裸 let 会 TDZ）。
type WriteFileSyncFn = typeof import("node:fs").writeFileSync;
const { writeFileSyncMock, actualWriteRef } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  actualWriteRef: { current: undefined as WriteFileSyncFn | undefined },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  actualWriteRef.current = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
    default: { ...actual, writeFileSync: writeFileSyncMock },
  };
});

import {
  _setStateMarkerSleepForTest,
  readStateMarker,
  statStateStamp,
  writeCancelledState,
  writeFinalizedState,
} from "../state-marker.ts";
import { writeLegacyCancelledSidecar, writeLegacyFinalizedSidecar } from "./helpers/legacy-sidecar.ts";

describe("state-marker", () => {
  let tmpDir: string;
  let sessionFile: string;
  /** 退避替身记录的延迟序列（fake sleep——免真实等待，可断言指数退避）。 */
  let sleepDelays: number[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-marker-test-"));
    sessionFile = path.join(tmpDir, "2026-01-01_uuid.jsonl");
    sleepDelays = [];
    _setStateMarkerSleepForTest((ms) => {
      sleepDelays.push(ms);
    });
    loggerMock.error.mockClear();
    // 基线 = 真实写（个别用例以 mockImplementationOnce/Implementation 注错覆盖）。
    if (actualWriteRef.current === undefined) throw new Error("node:fs mock not initialized");
    writeFileSyncMock.mockReset().mockImplementation(actualWriteRef.current);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    _setStateMarkerSleepForTest(undefined); // 恢复实装同步等待
    vi.restoreAllMocks();
  });

  const readStateRaw = (): { status?: unknown; reason?: unknown; endedAt?: unknown } =>
    JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as Record<string, unknown>;

  // ============================================================
  // 写侧
  // ============================================================
  describe("写侧 .state", () => {
    it("writeFinalizedState 带 reason → .state {status:finalized, reason}", () => {
      writeFinalizedState(sessionFile, "user-close");
      expect(readStateRaw()).toEqual({ status: "finalized", reason: "user-close" });
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized", reason: "user-close" });
    });

    it("writeFinalizedState 无 reason → .state {status:finalized}（死因不可考语义）", () => {
      writeFinalizedState(sessionFile);
      expect(readStateRaw()).toEqual({ status: "finalized" });
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized" });
    });

    it("writeCancelledState → .state {status:cancelled, endedAt}", () => {
      writeCancelledState(sessionFile, 7000);
      expect(readStateRaw()).toEqual({ status: "cancelled", endedAt: 7000 });
      expect(readStateMarker(sessionFile)).toEqual({ status: "cancelled", endedAt: 7000 });
    });

    it("覆盖写：后写的 status 取代前者（单文件单状态，构造性互斥）", () => {
      writeFinalizedState(sessionFile, "gc");
      writeCancelledState(sessionFile, 8000);
      expect(readStateMarker(sessionFile)).toEqual({ status: "cancelled", endedAt: 8000 });
    });

    it("写 .state 时清理存量旧名 sidecar（.finalized / .cancelled 一并删）", () => {
      writeLegacyFinalizedSidecar(sessionFile, "gc");
      writeLegacyCancelledSidecar(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "w", startedAt: 1, endedAt: 2,
      });

      writeFinalizedState(sessionFile, "user-close");

      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
      expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(false);
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized", reason: "user-close" });
    });

    it("[§3.4] 写路径父目录不存在 → 重试耗尽不抛出、未写入、响亮暴露 + 返回 false", () => {
      const badPath = path.join(tmpDir, "nonexistent-sub", "session.jsonl");
      expect(writeFinalizedState(badPath)).toBe(false);
      expect(writeCancelledState(badPath, 1)).toBe(false);
      expect(readStateMarker(badPath)).toBeUndefined();
      // 响亮暴露：每次写函数调用各产出一条 error（终态权威未落必须可见）。
      expect(loggerMock.error).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // 写侧响亮重试（U1 A3 / §3.4：3 次指数退避 100ms 起 + 仍失败 logger.error）
  // ============================================================
  describe("写侧响亮重试", () => {
    it("暂时性失败 → 指数退避重试后成功：返回 true，无 error 日志", () => {
      writeFileSyncMock
        .mockImplementationOnce(() => {
          throw new Error("transient EBUSY");
        })
        .mockImplementationOnce(() => {
          throw new Error("transient EACCES");
        });

      expect(writeFinalizedState(sessionFile, "user-close")).toBe(true);
      expect(writeFileSyncMock).toHaveBeenCalledTimes(3); // 初始尝试 + 2 次重试后成功
      expect(sleepDelays).toEqual([100, 200]); // 指数退避：100ms 起
      expect(loggerMock.error).not.toHaveBeenCalled();
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized", reason: "user-close" });
    });

    it("持久失败 → 4 次尝试（1+3 重试）后返回 false + logger.error 响亮暴露（含恢复指引）", () => {
      writeFileSyncMock.mockImplementation(() => {
        throw new Error("ENOSPC: no space left");
      });

      expect(writeCancelledState(sessionFile, 7000)).toBe(false);
      expect(writeFileSyncMock).toHaveBeenCalledTimes(4); // 初始 + 3 次重试
      expect(sleepDelays).toEqual([100, 200, 400]); // 完整指数退避序列
      expect(loggerMock.error).toHaveBeenCalledTimes(1);
      const msg = String(loggerMock.error.mock.calls[0]?.[0]);
      expect(msg).toMatch(/terminal state marker write failed after retries/);
      expect(msg).toMatch(/record stays running/); // §3.4：不因写失败翻终态的处置指引
      // 磁盘确无终态位（record 留 running 形态的构造前提）。
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    });

    it("writeCancelledState 同款重试语义（终态二态共用 writeStateMarker）", () => {
      writeFileSyncMock.mockImplementationOnce(() => {
        throw new Error("transient");
      });

      expect(writeCancelledState(sessionFile, 9000)).toBe(true);
      expect(sleepDelays).toEqual([100]);
      expect(readStateMarker(sessionFile)).toEqual({ status: "cancelled", endedAt: 9000 });
    });
  });

  // ============================================================
  // 读侧：无 sidecar / .state 边界
  // ============================================================
  describe("读侧 .state", () => {
    it("无任何 sidecar → undefined（未终态化）", () => {
      expect(readStateMarker(sessionFile)).toBeUndefined();
    });

    it(".state JSON 损坏 → {status:finalized}（存在性即信号；不误判 cancelled）", () => {
      fs.writeFileSync(`${sessionFile}.state`, "not-json", "utf-8");
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized" });
    });

    it(".state status 非枚举值 → {status:finalized}（结构不合法降级）", () => {
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "bogus" }), "utf-8");
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized" });
    });

    it(".state finalized 且 reason 非字符串 → 忽略 reason 字段（不抛）", () => {
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "finalized", reason: 42 }), "utf-8");
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized" });
    });

    it(".state cancelled 缺 endedAt → {status:cancelled}（endedAt undefined，重建回落 mtime）", () => {
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "cancelled" }), "utf-8");
      expect(readStateMarker(sessionFile)).toEqual({ status: "cancelled" });
    });
  });

  // ============================================================
  // 读侧：兼容旧名（存量文件不迁移）
  // ============================================================
  describe("读侧兼容旧名", () => {
    it("旧 .finalized 带内容 → {status:finalized, reason}", () => {
      writeLegacyFinalizedSidecar(sessionFile, "parent-shutdown");
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized", reason: "parent-shutdown" });
    });

    it("旧 .finalized 空文件（v8.5 前格式）→ reason 空串（= 死因不可考）", () => {
      writeLegacyFinalizedSidecar(sessionFile);
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized", reason: "" });
    });

    it("旧 .cancelled 完整 tombstone → {status:cancelled, endedAt}", () => {
      writeLegacyCancelledSidecar(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "w", startedAt: 100, endedAt: 200,
      });
      expect(readStateMarker(sessionFile)).toEqual({ status: "cancelled", endedAt: 200 });
    });

    it("旧 .cancelled JSON 损坏 → undefined（不认 cancelled，对齐合并前降级）", () => {
      fs.writeFileSync(`${sessionFile}.cancelled`, "{broken", "utf-8");
      expect(readStateMarker(sessionFile)).toBeUndefined();
    });

    it("旧 .cancelled status 非 cancelled → undefined（结构不合法降级）", () => {
      fs.writeFileSync(`${sessionFile}.cancelled`, JSON.stringify({ status: "other", endedAt: 1 }), "utf-8");
      expect(readStateMarker(sessionFile)).toBeUndefined();
    });

    it("旧名共存（.cancelled + .finalized）→ cancelled 胜出（优先级对齐合并前分支序）", () => {
      writeLegacyFinalizedSidecar(sessionFile, "gc");
      writeLegacyCancelledSidecar(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "w", startedAt: 100, endedAt: 200,
      });
      expect(readStateMarker(sessionFile)).toEqual({ status: "cancelled", endedAt: 200 });
    });

    it(".state 优先于存量旧名（新写侧权威）", () => {
      writeLegacyCancelledSidecar(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "w", startedAt: 100, endedAt: 200,
      });
      writeFinalizedState(sessionFile, "user-close");
      expect(readStateMarker(sessionFile)).toEqual({ status: "finalized", reason: "user-close" });
    });
  });

  // ============================================================
  // statStateStamp（缓存校验）
  // ============================================================
  describe("statStateStamp", () => {
    it("三者皆无 → null（未终态化，缓存校验 null 语义）", () => {
      expect(statStateStamp(sessionFile)).toBeNull();
    });

    it(".state 存在 → 非 null；重写改变戳（mtime/size 至少一项变化）", () => {
      writeFinalizedState(sessionFile, "gc");
      const first = statStateStamp(sessionFile);
      expect(first).not.toBeNull();

      writeFinalizedState(sessionFile, "a-much-longer-reason-string");
      const second = statStateStamp(sessionFile);
      expect(second).not.toBeNull();
      expect(second).not.toEqual(first); // size 变化即戳变化
    });

    it("仅旧名存在 → 非 null（合并戳覆盖兼容读面）", () => {
      writeLegacyFinalizedSidecar(sessionFile, "gc");
      expect(statStateStamp(sessionFile)).not.toBeNull();
    });

    it("旧名删除后戳变化（GC 清理旧侧车 → 缓存正确失效）", () => {
      writeLegacyFinalizedSidecar(sessionFile, "gc");
      const withLegacy = statStateStamp(sessionFile);
      fs.rmSync(`${sessionFile}.finalized`, { force: true });
      expect(statStateStamp(sessionFile)).not.toEqual(withLegacy);
    });
  });
});
