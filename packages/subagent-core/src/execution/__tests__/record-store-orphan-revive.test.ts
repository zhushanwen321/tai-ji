// src/execution/__tests__/record-store-orphan-revive.test.ts
//
// [PS-10/T6④] revive() 复位 orphanJudged——落实 recoverOrphanRecords 注释承诺
// 「IO 恢复后重开可重判」。
//
// 缺陷（设计 §4.3 PS-10）：resumable 形态（IO-error 保守分支）无 .state sidecar
// 锚，重判资格完全由 orphanJudged 实例级缓存承载；dispose 有 clear 但 /new 复活路径
// revive() 此前不复位 → 同进程内曾经的 IO 失败记录永久停留 resumable。
//
// 覆盖（验收④：IO 恢复记录 revive 后再次扫描会重新判定，不再停留 resumable）：
//   阶段 1  IO 失败（openSync EACCES 注入）→ 判定落 resumable entry（保守分支真实触发）
//   阶段 2  IO 恢复 + revive() → 再次 recoverOrphanRecords 重新判定收敛 closed+gc
//           （未修复时 orphanJudged 残留 → 605 行 continue 零 entry，本用例红）
//
// fs mock：只劫持 openSync 的读模式（"r"）按目标路径计数放行——扫描侧
// readIdentityHeader（session-reconstructor）与判定侧 readLastJsonlLine（record-store
// 私有）走同一原语，放行计数 = 让扫描成功、判定失败的最小注入面；写模式（sidecar）
// 与其余 fs 全部透传 actual。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openSyncMock, fsActualHolder, loggerMock } = vi.hoisted(() => ({
  openSyncMock: vi.fn(),
  fsActualHolder: {} as { fs?: typeof import("node:fs") },
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsActualHolder.fs = actual;
  return { ...actual, openSync: openSyncMock };
});
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { RecordStore } from "../record-store.ts";
import { writeAliveMarker } from "../alive-store.ts";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-revive-"));
  loggerMock.debug.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  openSyncMock.mockReset();
});

/** 最小合法 session.jsonl：session header + subagent-identity + 完整 assistant 末行。 */
function writeOrphanSession(filePath: string, id: string): void {
  const header = JSON.stringify({
    type: "session", version: 3, id: "sess-uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
  });
  const identityEntry = JSON.stringify({
    type: "custom", id: "id-1", parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z", customType: "subagent-identity",
    data: { id, agent: "worker", mode: "background", task: "orphan revive", startedAt: 1000, rootSessionId: "sess-orphan" },
  });
  const assistantMsg = JSON.stringify({
    type: "message", id: "msg-1", parentId: "id-1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "result" }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: "stop", timestamp: 2000,
    },
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
}

function makeStore(): { store: RecordStore; appended: Array<{ customType: string; data: Record<string, unknown> }> } {
  const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const store = new RecordStore(tmpDir, undefined, {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data: data as Record<string, unknown> });
    },
  } as never);
  return { store, appended };
}

describe("[PS-10] revive() 复位 orphanJudged（IO 恢复后重开可重判）", () => {
  it("IO 失败落 resumable → revive 后 IO 恢复，再次扫描重新判定收敛 closed+gc", () => {
    const sessionFile = path.join(tmpDir, "orphan-revive.jsonl");
    writeOrphanSession(sessionFile, "sa-revive-1");
    const realOpenSync = fsActualHolder.fs!.openSync;

    // 目标路径读模式 open 的放行计数：阶段 1 只放行 1 次（扫描侧 readIdentityHeader），
    // 判定侧 readLastJsonlLine 的 open 注入 EACCES（IO 暂时失败的保守形态）。
    let allowReads = Infinity;
    openSyncMock.mockImplementation((p: unknown, flags: unknown) => {
      if (p === sessionFile && typeof flags === "string" && flags.includes("r")) {
        if (allowReads <= 0) {
          const err = new Error(`EACCES: permission denied, open '${sessionFile}'`) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        allowReads--;
      }
      return realOpenSync(p as Parameters<typeof realOpenSync>[0], flags as Parameters<typeof realOpenSync>[1]);
    });

    // ── 阶段 1：IO 失败 → 保守落 resumable（注释承诺的形态）──
    allowReads = 1;
    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan");

    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe("subagent-record");
    expect(appended[0]?.data.status).toBe("running");
    expect(appended[0]?.data.resumable).toBe(true);
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false); // 保守分支无 sidecar 锚

    // ── 阶段 2：IO 恢复 + /new 复活（revive 复位 orphanJudged）→ 重判收敛终态 ──
    allowReads = Infinity;
    store.revive();
    store.recoverOrphanRecords("sess-orphan");

    expect(appended).toHaveLength(2); // 未修复时 orphanJudged 残留 → 零新 entry，此处红
    const rejudged = appended[1];
    expect(rejudged?.data.status).toBe("closed");
    expect(rejudged?.data.closedReason).toBe("gc");
    expect(rejudged?.data.resumable).toBeUndefined(); // 不再停留 resumable
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(true); // 终态防重锚落盘
  });

  it("未 revive 时重判资格保持（防重缓存语义不回归）：重复 recover 零新 entry", () => {
    const sessionFile = path.join(tmpDir, "orphan-norevive.jsonl");
    writeOrphanSession(sessionFile, "sa-revive-2");
    const realOpenSync = fsActualHolder.fs!.openSync;
    let allowReads = Infinity;
    openSyncMock.mockImplementation((p: unknown, flags: unknown) => {
      if (p === sessionFile && typeof flags === "string" && flags.includes("r")) {
        if (allowReads <= 0) {
          const err = new Error(`EACCES: permission denied, open '${sessionFile}'`) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        allowReads--;
      }
      return realOpenSync(p as Parameters<typeof realOpenSync>[0], flags as Parameters<typeof realOpenSync>[1]);
    });

    allowReads = 1;
    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan");
    expect(appended).toHaveLength(1);

    // 同进程内不经历 revive（未重开）：IO 已恢复也不重判——同 session 防重语义保持
    allowReads = Infinity;
    store.recoverOrphanRecords("sess-orphan");
    expect(appended).toHaveLength(1);
  });
});

// ── [U4a / D3b (a″)] 孤儿恢复活实例跳过：findForeignLiveInstance 现查探针 ──
//
// 原判据 = 重建时缓存的 rec.externalInstance（分支 3 填充）；externalInstance 字段链
// 删除后换直接探针（pid 单判据 + self-pid 排除）。验收（F2）：
//   - 探针活（异宿主 pid 在持声明）→ 跳过终态化——boot 不得误杀异宿主持有中 record
//     （同 root 双宿主形态下，宿主 A 的 boot 把宿主 B 持有中的 record 直断 gc 会
//     击穿跨进程写权防御，设计 D3b (a″)）；
//   - pid 死（无在持声明）→ 正常终态化（closed+gc + .state 防重锚）。
describe("[U4a / D3b (a″)] 孤儿恢复活实例跳过：现查探针（pid 单判据）", () => {
  /** openSync 透传真实实现（本 describe 的判定路径需要真实 IO；mockReset 后默认
   *  实现返回 undefined，readLastJsonlLine 会拿到非法 fd）。 */
  function passthroughOpenSync(): void {
    const realOpenSync = fsActualHolder.fs!.openSync;
    openSyncMock.mockImplementation(
      (p: Parameters<typeof realOpenSync>[0], flags: Parameters<typeof realOpenSync>[1]) =>
        realOpenSync(p, flags),
    );
  }

  it("探针活（异宿主 pid 在持声明）→ 跳过终态化：零 entry + 无 .state 防重锚", () => {
    const sessionFile = path.join(tmpDir, "orphan-foreign-live.jsonl");
    writeOrphanSession(sessionFile, "sa-probe-1");
    // pid 1（launchd）必然存活且非本测试进程——异宿主「在持声明」的确定性形态
    writeAliveMarker(sessionFile, { pid: 1, id: "sa-probe-1", startedAt: Date.now() });
    passthroughOpenSync();

    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan");

    expect(appended).toHaveLength(0); // 跳过：不落任何终态/resumable entry
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false); // 未终态化 = 无防重锚
  });

  it("pid 死（marker 残留但持有者已退）→ 正常终态化：closed+gc entry + .state 防重锚", () => {
    const sessionFile = path.join(tmpDir, "orphan-dead-pid.jsonl");
    writeOrphanSession(sessionFile, "sa-probe-2");
    // 大 pid 用户空间必然不存在（ESRCH 判死）——原持有宿主已退出的残留 marker 形态
    writeAliveMarker(sessionFile, { pid: 9999999, id: "sa-probe-2", startedAt: Date.now() });
    passthroughOpenSync();

    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan");

    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe("subagent-record");
    expect(appended[0]?.data.status).toBe("closed");
    expect(appended[0]?.data.closedReason).toBe("gc");
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(true); // 终态防重锚落盘
  });

  it("self-pid marker（pid 复用到本进程的残留声明）→ 放行清理：原持有者已死，record 确为孤儿", () => {
    const sessionFile = path.join(tmpDir, "orphan-self-pid.jsonl");
    writeOrphanSession(sessionFile, "sa-probe-3");
    // self-pid 排除：findForeignLiveInstance 视同无 foreign——复用窗口内残留 marker
    // 不构成「异宿主在持」，record 是真孤儿应照常终态化
    writeAliveMarker(sessionFile, { pid: process.pid, id: "sa-probe-3", startedAt: Date.now() });
    passthroughOpenSync();

    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan");

    expect(appended).toHaveLength(1);
    expect(appended[0]?.data.status).toBe("closed");
    expect(appended[0]?.data.closedReason).toBe("gc");
  });
});
