// src/__tests__/engine-journal-gc.test.ts
//
// 锁定引擎 journal TTL 回收包装的边界（数据安全风险）：
//   - cleanupExpiredEngineJournals：30 天 TTL 生效（超龄 journal-*.jsonl 回收、未到期保留、
//     不可清理名（如 zcode session-db 的 db.sqlite）零触碰——删除判据细节由
//     pool-manager.test.ts 深度覆盖，本文件锁包装层接线）
//   - engines 根不存在 / dataDir 解析失败不外抛（best-effort）
//   - startEngineJournalGcTimer：接线即扫一次 + 24h 复扫 + stop
//   - worktree .patch 孤儿清扫：仅 *.patch 按 mtime TTL，级联领地
//     （.jsonl / sidecar）零触碰；无参时清扫根走 getSessionStoreDir 缺省推导
//     （与写侧同源——生产接线恒无参，清扫恒生效）
//
// 范围注记（2026-10-12 裁决）：子代理会话文件（session 存储树 subagents 域的 .jsonl /
// sidecar / manifest / .events 族）不在本 GC 范围——回收归删主会话级联（runtime
// session-content-cascade）；.patch 例外（按 branch 命名无会话锚，级联无锚可达，
// 唯一 mtime 兜底通道——文件头范围声明 2）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupExpiredEngineJournals,
  startEngineJournalGcTimer,
} from "../persistence/engine-journal-gc.ts";
import { getSessionStoreDir } from "@taiji/shared/paths";

// dataDir 解析钉到 holder.value（默认 tmpAgentDir，beforeEach 赋值）——防止命中真实
// TAIJI_AGENT_DATA_DIR（或宿主 fallback）误清开发机数据（测试红线）。throw 开关供
// 「解析失败 = best-effort 吞掉」用例注入（vi.mock 工厂不能引用外部变量，经 holder 透出）。
const dataDirHolder = vi.hoisted(() => ({
  value: "",
  throwOnCall: false,
}));
vi.mock("../engine/common/data-dir.ts", () => ({
  getEngineDataDir: () => {
    if (dataDirHolder.throwOnCall) throw new Error("data dir not configured");
    return dataDirHolder.value;
  },
}));

// ============================================================
// helpers
// ============================================================

let tmpDataDir: string;

/** 复扫间隔（24h，与实现同值；测试独立写死防实现漂移）。 */
const RESWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-journal-gc-test-"));
  dataDirHolder.value = tmpDataDir;
  dataDirHolder.throwOnCall = false;
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

/** 在引擎 journal 目录内建一个文件，mtime 设为指定天数前。 */
function createEngineFile(relPath: string, daysAgo: number): string {
  const fullPath = path.join(tmpDataDir, "engines", relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, "{}\n", "utf-8");
  const targetTime = Date.now() / 1000 - daysAgo * 86400;
  fs.utimesSync(fullPath, targetTime, targetTime);
  return fullPath;
}

/** 在 session 存储树的 <sid>/subagents/sessions 段内建一个文件（worktree .patch 落盘布局，
 *  session-store-layout-inversion D2/D3 换根后形态），mtime 设为指定天数前。 */
const PATCH_TREE_SID = "sid-gc-patch-tree";
function createSubagentFile(relPath: string, daysAgo: number): string {
  const fullPath = path.join(tmpDataDir, "ext-sessions", PATCH_TREE_SID, "subagents", relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, "patch\n", "utf-8");
  const targetTime = Date.now() / 1000 - daysAgo * 86400;
  fs.utimesSync(fullPath, targetTime, targetTime);
  return fullPath;
}

// ============================================================
// cleanupExpiredEngineJournals
// ============================================================

describe("cleanupExpiredEngineJournals", () => {
  it("超龄 journal 随清理轮回收，未到期保留", () => {
    const oldJournal = createEngineFile(path.join("zcode", "shared", "journal-bg-1.jsonl"), 31);
    const youngJournal = createEngineFile(path.join("zcode", "shared", "journal-bg-2.jsonl"), 5);
    cleanupExpiredEngineJournals();
    expect(fs.existsSync(oldJournal)).toBe(false);
    expect(fs.existsSync(youngJournal)).toBe(true);
  });

  it("不可清理名零触碰（zcode 隔离会话库 db.sqlite 同池共存不被误删）", () => {
    const db = createEngineFile(path.join("zcode", "session-db", "db.sqlite"), 31);
    cleanupExpiredEngineJournals();
    expect(fs.existsSync(db)).toBe(true);
  });

  it("engines 根不存在时不抛（从未落 journal = 无可清理）", () => {
    expect(() => cleanupExpiredEngineJournals()).not.toThrow();
  });

  it("dataDir 解析失败不外抛（未配置宿主服务 = best-effort 吞掉）", () => {
    dataDirHolder.throwOnCall = true;
    expect(() => cleanupExpiredEngineJournals()).not.toThrow();
  });
});

// ============================================================
// worktree .patch 孤儿清扫（无条件执行；文件头范围声明 2）
// ============================================================

describe("cleanupExpiredEngineJournals: worktree patch sweep", () => {
  it("传 dataDir：超龄 .patch 回收、未到期保留（<sid>/subagents/sessions 落盘布局）", () => {
    const oldPatch = createSubagentFile("sessions/feat-main.patch", 31);
    const youngPatch = createSubagentFile("sessions/feat-dev.patch", 5);
    cleanupExpiredEngineJournals(tmpDataDir);
    expect(fs.existsSync(oldPatch)).toBe(false);
    expect(fs.existsSync(youngPatch)).toBe(true);
  });

  it("传 dataDir：级联领地零触碰（.jsonl 与 sidecar 同池共存不被误删）", () => {
    const jsonl = createSubagentFile("sessions/20261012T000000_sa-1.jsonl", 31);
    const sidecar = createSubagentFile("sessions/20261012T000000_sa-1.jsonl.alive", 31);
    const patch = createSubagentFile("sessions/feat-main.patch", 31);
    cleanupExpiredEngineJournals(tmpDataDir);
    expect(fs.existsSync(jsonl)).toBe(true);
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(fs.existsSync(patch)).toBe(false);
  });

  it("传 dataDir：存储树根不存在不抛（从未有过会话 = 合法空态）", () => {
    expect(() => cleanupExpiredEngineJournals(tmpDataDir)).not.toThrow();
  });

  it("不传 dataDir：清扫根经 resolveSessionStoreBase（getEngineDataDir 通道）推导，超龄 .patch 仍回收", () => {
    // 缺省通道 = store-base resolveSessionStoreBase → getEngineDataDir（本文件 mock 为
    // holder.value = tmpDataDir；生产 = env TAIJI_AGENT_DATA_DIR → 宿主 dataRoot，C-ext-31
    // ——事故回归锚：不得回退 shared getDataDir env 缺省，打包态 pi env 组合下必抛）。
    // 造数自建自删，不依赖 dataDirHolder 注入。
    const defaultRoot = getSessionStoreDir(tmpDataDir);
    const sid = "sid-gc-default-root";
    const patch = path.join(defaultRoot, sid, "subagents", "sessions", "feat-main.patch");
    fs.mkdirSync(path.dirname(patch), { recursive: true });
    fs.writeFileSync(patch, "patch\n", "utf-8");
    const targetTime = Date.now() / 1000 - 31 * 86400;
    fs.utimesSync(patch, targetTime, targetTime);
    try {
      cleanupExpiredEngineJournals();
      expect(fs.existsSync(patch)).toBe(false);
    } finally {
      fs.rmSync(path.join(defaultRoot, sid), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ============================================================
// startEngineJournalGcTimer（确定性触发：启动扫一次 + 24h 复扫）
// ============================================================

describe("startEngineJournalGcTimer", () => {
  it("接线即立即扫一次（不等第一个复扫点）", () => {
    vi.useFakeTimers();
    try {
      const old = createEngineFile(path.join("pi", "shared", "journal-timer-startup.jsonl"), 31);
      const stop = startEngineJournalGcTimer();
      stop();
      expect(fs.existsSync(old)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("24h 复扫清理接线后新出现的超龄 journal；未到复扫点不清理", () => {
    vi.useFakeTimers();
    try {
      const stop = startEngineJournalGcTimer();
      // 接线后新出现的超龄 journal：复扫点前保留
      const pending = createEngineFile(path.join("pi", "shared", "journal-timer-pending.jsonl"), 31);
      vi.advanceTimersByTime(RESWEEP_INTERVAL_MS - 1);
      expect(fs.existsSync(pending)).toBe(true);
      // 到 24h 复扫点 → 清理
      vi.advanceTimersByTime(1);
      expect(fs.existsSync(pending)).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop 后不再复扫", () => {
    vi.useFakeTimers();
    try {
      const stop = startEngineJournalGcTimer();
      stop();
      const late = createEngineFile(path.join("pi", "shared", "journal-timer-after-stop.jsonl"), 31);
      vi.advanceTimersByTime(3 * RESWEEP_INTERVAL_MS);
      expect(fs.existsSync(late)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
