// src/execution/__tests__/record-store-orphan-revive.test.ts
//
// [PS-10/T6④] revive() 复位 orphanJudged + [U4a / D3b (a″)] 孤儿恢复活实例跳过。
//
// [U3 / §3.2.4 迁移] 孤儿恢复已简化为 entry 面纠偏（一律保留 idle，锚在等 revive）：
//   - 原判定矩阵（IO 保守 / 末行截断 / SP-5 分流 / closed+gc 直断 / .state 防重锚）
//     随直断分支整体删除——子文件正文与 IO 状态不再参与判定；
//   - 防重语义变化：纠偏 entry 落盘后末条变 idle，判据自然不再命中（构造性幂等）；
//     orphanJudged 缓存降级为 appendEntry 失败场景的次级防线（本文件验证其语义）；
//   - 活实例跳过判据不变（findForeignLiveInstance 现查探针，pid 单判据 + self-pid
//     排除）——异宿主在持时不代写纠偏 entry。
//
// fs mock：只劫持 openSync 的读模式（"r"）按目标路径计数放行（保留文件 IO 注入面供
// 防重场景构造失败形态）；写模式与其余 fs 全部透传 actual。

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

import { RecordStore } from "../persistence/record-store.ts";
import { writeAliveMarker } from "../persistence/alive-store.ts";

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

/** 主 session 末条 entry 残留 running——entry 纠偏判据的命中前提。 */
function writeMainRunningEntry(id: string): string {
  const mainFile = path.join(tmpDir, "main-session.jsonl");
  const entry = JSON.stringify({
    type: "custom", id: `e-${id}`, parentId: null, customType: "subagent-record",
    data: { id, agent: "worker", task: "orphan revive", startedAt: 1000, status: "running" },
  });
  fs.writeFileSync(mainFile, entry + "\n", "utf-8");
  return mainFile;
}

function makeStore(appendEntryImpl?: (customType: string, data: unknown) => void): {
  store: RecordStore;
  appended: Array<{ customType: string; data: Record<string, unknown> }>;
} {
  const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const store = new RecordStore(tmpDir, undefined, {
    appendEntry: appendEntryImpl ?? ((customType: string, data: unknown) => {
      appended.push({ customType, data: data as Record<string, unknown> });
    }),
  } as never);
  return { store, appended };
}

describe("[PS-10] revive() 复位 orphanJudged（appendEntry 失败后重开可重判）", () => {
  /** openSync 透传真实实现（扫描侧需要真实 IO；mockReset 后默认实现返回 undefined，
   *  readIdentityHeader 会拿到非法 fd → 负缓存静默跳过，判定不发生）。 */
  function passthroughOpenSync(): void {
    const realOpenSync = fsActualHolder.fs!.openSync;
    openSyncMock.mockImplementation(
      (p: Parameters<typeof realOpenSync>[0], flags: Parameters<typeof realOpenSync>[1]) =>
        realOpenSync(p, flags),
    );
  }

  /** [U3 场景迁移] 原场景（读 IO 失败 → 保守落 resumable）随判定矩阵删除——扫描侧
   *  读失败由负缓存静默吸收（record 不可见 = 不判定）。orphanJudged 的次级防线语义
   *  改用 appendEntry 注入失败构造：纠偏 entry 未落盘 → 判据（末条 running）不自愈，
   *  重判资格完全由缓存承载。 */
  it("appendEntry 失败（纠偏 entry 未落盘）→ orphanJudged 拦截重复判定；revive 后重判收敛 idle entry", () => {
    const sessionFile = path.join(tmpDir, "orphan-revive.jsonl");
    writeOrphanSession(sessionFile, "sa-revive-1");
    const mainFile = writeMainRunningEntry("sa-revive-1");
    passthroughOpenSync();

    let failAppend = true;
    const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const { store } = makeStore((customType: string, data: unknown) => {
      if (failAppend) throw new Error("append entry failed (disk full)");
      appended.push({ customType, data: data as Record<string, unknown> });
    });

    // ── 阶段 1：纠偏落盘爆炸 → 异常传播（生产由 record-access try/catch 吸收），
    // orphanJudged 已标记；磁盘无 sidecar（纠偏不写 .state）──
    expect(() => store.recoverOrphanRecords("sess-orphan", mainFile)).toThrow(/append entry failed/);
    expect(appended).toHaveLength(0);
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);

    // ── 阶段 2（未 revive）：判据仍命中（entry 未落盘）但 orphanJudged 拦截 →
    // 零异常零重复（次级防线语义）──
    store.recoverOrphanRecords("sess-orphan", mainFile);
    expect(appended).toHaveLength(0);

    // ── 阶段 3：append 恢复 + /new 复活（revive 复位 orphanJudged）→ 重判纠偏落盘 ──
    failAppend = false;
    store.revive();
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(1); // 未 revive 时 orphanJudged 残留 → 零新 entry，此处红
    const corrected = appended[0];
    expect(corrected?.customType).toBe("subagent-record");
    expect(corrected?.data.status).toBe("idle");
    expect(corrected?.data.closedReason).toBeUndefined();
    expect(corrected?.data.stopReason).toBe("interrupted-by-restart");
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
  });

  it("未 revive 时重判资格保持（防重缓存语义不回归）：appendEntry 恢复后重复 recover 仍零新 entry", () => {
    const sessionFile = path.join(tmpDir, "orphan-norevive.jsonl");
    writeOrphanSession(sessionFile, "sa-revive-2");
    const mainFile = writeMainRunningEntry("sa-revive-2");
    passthroughOpenSync();

    let failAppend = true;
    const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const { store } = makeStore((customType: string, data: unknown) => {
      if (failAppend) throw new Error("append entry failed (disk full)");
      appended.push({ customType, data: data as Record<string, unknown> });
    });

    expect(() => store.recoverOrphanRecords("sess-orphan", mainFile)).toThrow(/append entry failed/);
    expect(appended).toHaveLength(0);

    // 同进程内不经历 revive（未重开）：append 已恢复也不重判——orphanJudged 防重语义保持
    failAppend = false;
    store.recoverOrphanRecords("sess-orphan", mainFile);
    expect(appended).toHaveLength(0);
  });
});

// ── [U4a / D3b (a″)] 孤儿恢复活实例跳过：findForeignLiveInstance 现查探针 ──
//
// 判据 = .alive marker 的 pid 活性（pid 单判据 + self-pid 排除）。验收（F2）：
//   - 探针活（异宿主 pid 在持声明）→ 跳过纠偏——boot 不得代写异宿主持有中 record 的
//     entry（同 root 双宿主形态下，宿主 A 的 boot 误判宿主 B 持有中的 record 会击穿
//     跨进程写权防御）；
//   - pid 死（无在持声明）/ self-pid 残留 → 正常纠偏（idle entry 落盘，无 .state sidecar
//     ——[U3] 直断防重锚写点已删）。
describe("[U4a / D3b (a″)] 孤儿恢复活实例跳过：现查探针（pid 单判据）", () => {
  /** openSync 透传真实实现（本 describe 的扫描路径需要真实 IO；mockReset 后默认
   *  实现返回 undefined，扫描侧会拿到非法 fd）。 */
  function passthroughOpenSync(): void {
    const realOpenSync = fsActualHolder.fs!.openSync;
    openSyncMock.mockImplementation(
      (p: Parameters<typeof realOpenSync>[0], flags: Parameters<typeof realOpenSync>[1]) =>
        realOpenSync(p, flags),
    );
  }

  it("探针活（异宿主 pid 在持声明）→ 跳过纠偏：零 entry", () => {
    const sessionFile = path.join(tmpDir, "orphan-foreign-live.jsonl");
    writeOrphanSession(sessionFile, "sa-probe-1");
    const mainFile = writeMainRunningEntry("sa-probe-1");
    // pid 1（launchd）必然存活且非本测试进程——异宿主「在持声明」的确定性形态
    writeAliveMarker(sessionFile, { pid: 1, id: "sa-probe-1", startedAt: Date.now() });
    passthroughOpenSync();

    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(0); // 跳过：不落任何纠偏 entry
  });

  it("pid 死（marker 残留但持有者已退）→ 正常纠偏：idle entry（无 closedReason、无 .state 防重锚）", () => {
    const sessionFile = path.join(tmpDir, "orphan-dead-pid.jsonl");
    writeOrphanSession(sessionFile, "sa-probe-2");
    const mainFile = writeMainRunningEntry("sa-probe-2");
    // 大 pid 用户空间必然不存在（ESRCH 判死）——原持有宿主已退出的残留 marker 形态
    writeAliveMarker(sessionFile, { pid: 9999999, id: "sa-probe-2", startedAt: Date.now() });
    passthroughOpenSync();

    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe("subagent-record");
    expect(appended[0]?.data.status).toBe("idle");
    expect(appended[0]?.data.closedReason).toBeUndefined();
    expect(appended[0]?.data.stopReason).toBe("interrupted-by-restart");
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
  });

  it("self-pid marker（pid 复用到本进程的残留声明）→ 放行纠偏：原持有者已死，record 确为孤儿", () => {
    const sessionFile = path.join(tmpDir, "orphan-self-pid.jsonl");
    writeOrphanSession(sessionFile, "sa-probe-3");
    const mainFile = writeMainRunningEntry("sa-probe-3");
    // self-pid 排除：findForeignLiveInstance 视同无 foreign——复用窗口内残留 marker
    // 不构成「异宿主在持」，record 是真孤儿应照常纠偏
    writeAliveMarker(sessionFile, { pid: process.pid, id: "sa-probe-3", startedAt: Date.now() });
    passthroughOpenSync();

    const { store, appended } = makeStore();
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.data.status).toBe("idle");
    expect(appended[0]?.data.closedReason).toBeUndefined();
  });
});
