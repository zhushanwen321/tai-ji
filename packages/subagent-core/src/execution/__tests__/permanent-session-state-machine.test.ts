// src/execution/__tests__/permanent-session-state-machine.test.ts
//
// [U2 / 永久会话模型] 两态状态机 CAS 语义 + 四意图原语副作用矩阵 + epoch 递增单测
// （设计 subagent-permanent-session-model.md §3.2.2/§3.2.3/§3.2.4/§3.2.5；验收条款：
// 「状态机 CAS 语义（running↔idle 迁移 + 非法迁移拒绝）+ 四原语副作用矩阵
// （.state/binding/manifest/.alive 各面写断言）+ epoch 递增」）。
//
// 桥接不变量（U2 迁移契约）：旧「closed 终态」⟺ idle ∧ closedReason 有值——
// 旧终态路径（tryTransition/completeRecord）双写 closedReason + stopReason；新
// settle 路径（markSettled）只写 stopReason（不终态化）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  completeRecord,
  createRecord,
  resurrectClosed,
  tryEnterRunning,
  tryTransition,
} from "../persistence/execution-record.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { readRecordBinding, readStateMarker, writeRecordBinding } from "../persistence/state-marker.ts";
import type { ExecutionRecord, TranscriptRef } from "../assembly/types.ts";

// ── fixture ──────────────────────────────────────────────────────────────────

let dir: string;
let sessionsDir: string;
let manifestDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-state-machine-"));
  sessionsDir = path.join(dir, "sessions");
  manifestDir = path.join(dir, "records");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 最小可收口 record（running 形态 + sessionFile 锚）。 */
function runningRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const rec = createRecord("bg-1", {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "do things",
    slug: "do-things",
    startedAt: 1,
  });
  (rec as { sessionFile?: string }).sessionFile = path.join(sessionsDir, "child.jsonl");
  return Object.assign(rec, over) as ExecutionRecord;
}

/** 回填点已跑过的存量 binding（markSettled 的 updateRecordBinding 前置）。 */
function seedBinding(sessionFile: string): void {
  writeRecordBinding(sessionFile, {
    v: 1,
    recordId: "bg-1",
    depth: 0,
    agent: "general-purpose",
    task: "do things",
    slug: "do-things",
    mode: "background",
    startedAt: 1,
    model: "test/model",
    worktree: false,
  });
}

function newStore(): RecordStore {
  return new RecordStore(sessionsDir, undefined, undefined, manifestDir);
}

// ── ① CAS 语义：running↔idle 迁移 + 非法迁移拒绝 ────────────────────────────

describe("两态状态机 CAS 语义", () => {
  it("tryTransition（settle 方向）：running→idle 收口 + closedReason/stopReason 双写", () => {
    const rec = runningRecord();
    expect(tryTransition(rec, "closed", "gc")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBe("gc");
    expect(rec.stopReason).toBe("gc");
  });

  it("tryTransition：非 running（已收口）重复 settle = 非法迁移拒绝（false，无副作用）", () => {
    const rec = runningRecord();
    expect(tryTransition(rec, "closed", "gc")).toBe(true);
    expect(tryTransition(rec, "closed", "cancelled")).toBe(false);
    expect(rec.closedReason).toBe("gc"); // 首次收口位不被二次收口覆盖
  });

  it("tryEnterRunning（wake 方向）：idle→running 翻转；running 重复 wake 拒绝", () => {
    const rec = runningRecord();
    expect(tryTransition(rec, "closed", "gc")).toBe(true);
    expect(tryEnterRunning(rec)).toBe(true);
    expect(rec.status).toBe("running");
    expect(tryEnterRunning(rec)).toBe(false); // 已 running：非法迁移拒绝
    expect(rec.status).toBe("running");
  });

  it("running↔idle 往返迁移（settle → wake → settle）构造性成立", () => {
    const rec = runningRecord();
    expect(tryTransition(rec, "closed", "user-close")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(tryEnterRunning(rec)).toBe(true);
    expect(rec.status).toBe("running");
    // tryEnterRunning 只翻占用位不清收口位（清位归 resurrectClosed / U4 接管编排）——
    // 单向职责最小化，非法清位场景由专属原语承接。
    expect(rec.closedReason).toBe("user-close");
  });

  it("markSettled CAS：非 running 拒绝收口（warn 返回 false，状态不被改写）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "idle";
    expect(store.markSettled(rec, "interrupted")).toBe(false);
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBeUndefined();
  });

  it("markReopened CAS：非 idle 拒绝重开（running 在飞 = 非法迁移）", () => {
    const store = newStore();
    const rec = runningRecord();
    const ref: TranscriptRef = { engine: "pi", sessionFile: path.join(sessionsDir, "new.jsonl") };
    expect(store.markReopened(rec, ref)).toBe(false);
    expect(rec.epoch).toBeUndefined();
    expect(rec.transcriptRef).toBeUndefined();
  });

  it("resurrectClosed：已收口 idle → running 接管翻回（清收口位）；running no-op", () => {
    const rec = runningRecord();
    expect(tryTransition(rec, "closed", "gc")).toBe(true);
    expect(resurrectClosed(rec)).toBe(true);
    expect(rec.status).toBe("running");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.stopReason).toBeUndefined();
    expect(rec.endedAt).toBeUndefined();
    // running 入态防御性 no-op：接管是已收口 record 的专属回边
    expect(resurrectClosed(rec)).toBe(false);
    expect(rec.status).toBe("running");
  });

  it("completeRecord 桥接：冻结 idle + closedReason/stopReason 双写 + outcome 派生", () => {
    const rec = runningRecord();
    completeRecord(
      rec,
      { text: "done", turns: 1, durationMs: 5, success: true, sessionId: "bg-1", toolCalls: [] },
      "closed",
      "gc",
    );
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBe("gc");
    expect(rec.stopReason).toBe("gc");
    expect(rec.outcome).toBe("completed");
    expect(rec.endedAt).toBeDefined();
  });
});

// ── ② markSettled 副作用矩阵（.state / binding / manifest / .alive）──────────

describe("markSettled 副作用矩阵（轮收口 = 不终态化）", () => {
  it("内存面：status=idle + stopReason 写入 + idleSince 刷新；closedReason 不写（非终态）；record 留内存", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.round = 2;
    store.register(rec);
    expect(store.markSettled(rec, "interrupted")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("interrupted");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.idleSince).toBeDefined();
    expect(rec.endedAt).toBeUndefined(); // 非终态，duration 语义保持
    expect(store.getMutable("bg-1")).toBe(rec); // 留内存（随时可续聊）
  });

  it(".state 面：新格式收条 {status:\"idle\", reason, endedAt} 落盘", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    store.markSettled(rec, "interrupted");
    // 直接读 sidecar 原文断言写面内容（经 readStateMarker 会落「旧版读新值」存在性
    // 降级分支——U2/U3 窗口期设计行为，读侧兼容归 U3，不在本写面测试断言范围）。
    const raw = JSON.parse(
      fs.readFileSync(`${rec.sessionFile}.state`, "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.status).toBe("idle");
    expect(raw.reason).toBe("interrupted");
    expect(typeof raw.endedAt).toBe("number");
  });

  it("binding 面：usage 快照（totalTokens/turns/round/endedAt）merge 进存量 binding", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.totalTokens = 4200;
    rec.turnCount = 7;
    rec.round = 3;
    rec.endedAt = undefined;
    seedBinding(rec.sessionFile!);
    store.register(rec);
    store.markSettled(rec, "gc");
    const binding = readRecordBinding(rec.sessionFile!);
    expect(binding?.totalTokens).toBe(4200);
    expect(binding?.turns).toBe(7);
    expect(binding?.round).toBe(3);
    expect(binding?.agent).toBe("general-purpose"); // 身份域不丢
  });

  it("binding 面：存量 binding 缺失时造全载荷（[U7] merge-or-create——统计基准不因回填点写失败而永久丢失）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.totalTokens = 900;
    rec.turnCount = 4;
    rec.round = 2;
    store.register(rec);
    store.markSettled(rec, "gc");
    // spawn 回填点 binding 写失败（best-effort）的窗口下，settle 写点承担创建腿——
    // 身份域取 settle 时点内存 record（齐全非残缺，对齐 markReopened 创建先例）。
    const binding = readRecordBinding(rec.sessionFile!);
    expect(binding).toBeDefined();
    expect(binding?.recordId).toBe("bg-1");
    expect(binding?.agent).toBe("general-purpose");
    expect(binding?.totalTokens).toBe(900);
    expect(binding?.turns).toBe(4);
    expect(binding?.round).toBe(2);
  });

  it("manifest 面：派生投影 legacy running（settle 非终态，session-reader 视角活跃成员）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    store.markSettled(rec, "interrupted");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(manifestDir, "bg-1.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(manifest.status).toBe("running"); // 旧三态下行投影（§3.2.8）
    expect(manifest.executionStatus).toBe("idle"); // 内部两态权威词汇
  });

  it(".alive 面：跨轮保留（settle 不释放写权声明，§3.2.4）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    fs.writeFileSync(
      `${rec.sessionFile}.alive`,
      JSON.stringify({ pid: process.pid, id: "bg-1", startedAt: Date.now() }),
      "utf-8",
    );
    store.markSettled(rec, "gc");
    expect(fs.existsSync(`${rec.sessionFile}.alive`)).toBe(true);
  });

  it("无 sessionFile 锚：内存面照常收口，.state/binding 面跳过（warn 不抛）", () => {
    const store = newStore();
    const rec = runningRecord();
    (rec as { sessionFile?: string }).sessionFile = undefined;
    store.register(rec);
    expect(store.markSettled(rec, "gc")).toBe(true);
    expect(rec.status).toBe("idle");
  });
});

// ── ③ markReopened 副作用矩阵（reopen 降级 + epoch 防撞）─────────────────────

describe("markReopened 副作用矩阵（带历史重开）", () => {
  it("内存面：新 transcriptRef + round 归零 + epoch+1 + stopReason=reopened；残留 lastAbandonedRound 不迁移", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.round = 5;
    rec.lastAbandonedRound = { epoch: 0, round: 4 };
    rec.status = "idle";
    store.register(rec);
    const ref: TranscriptRef = { engine: "pi", sessionFile: path.join(sessionsDir, "new.jsonl") };
    expect(store.markReopened(rec, ref)).toBe(true);
    expect(rec.transcriptRef).toEqual(ref);
    expect(rec.round).toBe(0);
    expect(rec.epoch).toBe(1);
    expect(rec.stopReason).toBe("reopened");
    expect(rec.lastAbandonedRound).toEqual({ epoch: 0, round: 4 }); // 跨 epoch 自然失效（判定层承接）
  });

  it("binding 面：pi 锚在新 sessionFile 旁造新 binding（epoch/transcriptRef/round 持久化）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "idle";
    store.register(rec);
    const newFile = path.join(sessionsDir, "reopened.jsonl");
    store.markReopened(rec, { engine: "pi", sessionFile: newFile });
    const binding = readRecordBinding(newFile);
    expect(binding).toBeDefined();
    expect(binding?.epoch).toBe(1);
    expect(binding?.round).toBe(0);
    expect(binding?.transcriptRef).toEqual({ engine: "pi", sessionFile: newFile });
    expect(binding?.recordId).toBe("bg-1");
  });

  it("zcode 锚（无文件载体）：内存面照常重开，binding 面跳过（U6 会话库锚承接）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "idle";
    store.register(rec);
    const ref: TranscriptRef = {
      engine: "zcode",
      sessionId: "sess-abc",
      dbPath: "/data/engines/zcode/session-db/db.sqlite",
    };
    expect(store.markReopened(rec, ref)).toBe(true);
    expect(rec.epoch).toBe(1);
    expect(rec.transcriptRef).toEqual(ref);
  });
});

// ── ④ epoch 递增（reopen 防撞：跨重启单调依赖 binding 持久化）────────────────

describe("epoch 递增（reopen 防撞）", () => {
  it("连续 reopen 单调递增（0 → 1 → 2）；常态 undefined 与 0 同义", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "idle";
    store.register(rec);
    expect(rec.epoch ?? 0).toBe(0);

    const fileA = path.join(sessionsDir, "gen-a.jsonl");
    const fileB = path.join(sessionsDir, "gen-b.jsonl");
    store.markReopened(rec, { engine: "pi", sessionFile: fileA });
    expect(rec.epoch).toBe(1);
    rec.status = "idle";
    store.markReopened(rec, { engine: "pi", sessionFile: fileB });
    expect(rec.epoch).toBe(2);
    // 跨重启恢复：新锚旁 binding 携带 epoch，读侧可复原单调计数
    expect(readRecordBinding(fileB)?.epoch).toBe(2);
  });

  it("从 binding 恢复的 epoch 继续递增（跨进程防撞链闭合）", () => {
    const rec = runningRecord();
    rec.status = "idle";
    const store = newStore();
    store.register(rec);
    const fileA = path.join(sessionsDir, "gen-a.jsonl");
    store.markReopened(rec, { engine: "pi", sessionFile: fileA });
    // 模拟跨重启：新 store 实例 + record 从 binding 重建（epoch 读回）
    const restored = readRecordBinding(fileA)?.epoch ?? 0;
    const rec2 = runningRecord();
    rec2.epoch = restored;
    rec2.status = "idle";
    const store2 = newStore();
    store2.register(rec2);
    store2.markReopened(rec2, { engine: "pi", sessionFile: path.join(sessionsDir, "gen-b.jsonl") });
    expect(rec2.epoch).toBe(2); // 不被二次 reopen 击穿（丢 epoch 会撞回 1）
  });
});

// ── ⑤ markArchived / markIdleEvicted 副作用矩阵（意愿位 + 写权声明）──────────

describe("markArchived / markIdleEvicted 副作用矩阵", () => {
  it("markArchived：intent=archived + .alive release（release 出口①）+ entry 上报", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    fs.writeFileSync(
      `${rec.sessionFile}.alive`,
      JSON.stringify({ pid: process.pid, id: "bg-1", startedAt: Date.now() }),
      "utf-8",
    );
    expect(store.markArchived(rec)).toBe(true);
    expect(rec.intent).toBe("archived");
    expect(fs.existsSync(`${rec.sessionFile}.alive`)).toBe(false);
    expect(store.getMutable("bg-1")).toBe(rec); // archived ≠ 内存回收（占用位不动）
  });

  it("markArchived 幂等：重复 close 无害（intent 恒 archived，release 静默）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    store.markArchived(rec);
    expect(store.markArchived(rec)).toBe(true);
    expect(rec.intent).toBe("archived");
  });

  it("markIdleEvicted：内存移除 + manifest 投影 + .alive release 后（写序 archive 先 release 后）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "running";
    store.register(rec);
    fs.writeFileSync(
      `${rec.sessionFile}.alive`,
      JSON.stringify({ pid: process.pid, id: "bg-1", startedAt: Date.now() }),
      "utf-8",
    );
    store.markIdleEvicted(rec);
    expect(store.getMutable("bg-1")).toBeUndefined(); // 内存回收
    expect(fs.existsSync(`${rec.sessionFile}.alive`)).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(manifestDir, "bg-1.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(manifest.status).toBe("running"); // 非终态化如实投影（磁盘仍可接管）
  });

  it("markIdleArchived（deprecated 别名）与 markIdleEvicted 写序全等", () => {
    const recA = runningRecord();
    const recB = runningRecord();
    (recB as { id: string }).id = "bg-2";
    const storeA = newStore();
    const storeB = newStore();
    storeA.register(recA);
    storeB.register(recB);
    storeA.markIdleArchived(recA);
    storeB.markIdleEvicted(recB);
    expect(storeA.getMutable("bg-1")).toBeUndefined();
    expect(storeB.getMutable("bg-2")).toBeUndefined();
    const manifestA = JSON.parse(fs.readFileSync(path.join(manifestDir, "bg-1.json"), "utf-8")) as Record<string, unknown>;
    const manifestB = JSON.parse(fs.readFileSync(path.join(manifestDir, "bg-2.json"), "utf-8")) as Record<string, unknown>;
    expect(manifestA.status).toBe(manifestB.status);
  });
});
