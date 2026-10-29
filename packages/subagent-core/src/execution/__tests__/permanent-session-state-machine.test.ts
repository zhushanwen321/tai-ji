// src/execution/__tests__/permanent-session-state-machine.test.ts
//
// [U2 / 永久会话模型] 两态状态机 CAS 语义 + 四意图原语副作用矩阵 + epoch 递增单测
// （设计 subagent-permanent-session-model.md §3.2.2/§3.2.3/§3.2.4/§3.2.5；验收条款：
// 「状态机 CAS 语义（running↔idle 迁移 + 非法迁移拒绝）+ 四原语副作用矩阵
// （.state/binding/manifest/.alive 各面写断言）+ epoch 递增」）。
//
// 桥接不变量（U2 迁移契约）：旧「closed 终态」⟺ idle ∧ closedReason 有值——
// legacy 终态原语（trySettleLegacyClosed/completeLegacyClosed）双写 closedReason +
// stopReason；新 settle 路径（markSettled）只写 stopReason（不终态化）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。
//
// [round5-g 合并产物] 吸收同域姊妹件（永久会话模型词汇/类型面）：
// - permanent-session-types.test.ts（TranscriptRef 守卫 / StopReason 词表 /
//   RecordBinding 新字段往返）。logger 桩与基座同款去重。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTableTests } from "@zhushanwen/state-machine/testing";

import {
  completeLegacyClosed,
  createRecord,
  resurrectClosed,
  tryEnterRunning,
  trySettleLegacyClosed,
} from "../persistence/execution-record.ts";
import { permanentSessionStatusMachine } from "../domain/record-status-machine.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { readRecordBinding, writeRecordBinding } from "../persistence/state-marker.ts";
import type { RecordBinding } from "../persistence/state-marker.ts";
import { NEW_STOP_REASONS, ROUND_TERMINAL_STOP_REASONS, STOP_REASONS } from "../domain/record-types.ts";
import { isPiTranscriptRef, isZcodeTranscriptRef, isValidStopReason } from "../domain/record-model.ts";
import type { TranscriptRef } from "../domain/record-types.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { Epoch } from "../domain/record-types.js";

// [teardown 竞态修复] 被测链传递性 logger 输出经 console 落 stderr——同步用例的刷写落在
// 文件结束的 teardown 窗口，与 worker rpc 关闭竞态 → vitest EnvironmentTeardownError
// （onUserConsoleLog pending）→ run 退出码 1。本文件对 logger 零断言依赖，mock 静默
// （rebuild-indexes.test.ts 同款先例）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

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

/** 最小可收尾 record（running 形态 + sessionFile 锚）。 */
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
  return new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
}

// ── ⓪ 机器表穷举（state-machine-infrastructure M2）──────────────────────────
// [M2 迁移] 表级组合（全状态 × 全事件）一行生成；行为级断言（下方 ①-⑤ 的 CAS
// 语义 / 副作用矩阵 / epoch / 回滚契约）保留域内（D5 保留口径）。
const tableCases = generateTableTests(permanentSessionStatusMachine);
it("generateTableTests 组合覆盖数与期望分布（2 态 × 7 事件 = 14 用例，拒绝组合在列）", () => {
  expect(tableCases).toHaveLength(14);
  const transitions = tableCases.filter((c) => c.expectation === "transition");
  const rejected = tableCases.filter((c) => c.expectation === "rejected");
  // 表 8 行（round-started 两态各一行）+ 词表内无 guard 分支 → 8 合法 / 6 拒绝
  expect(transitions).toHaveLength(8);
  expect(rejected).toHaveLength(6);
  expect(tableCases.every((c) => c.expectation !== "invariant-broken")).toBe(true);
});

// ── ① CAS 语义：running↔idle 迁移 + 非法迁移拒绝 ────────────────────────────

describe("两态状态机 CAS 语义", () => {
  it("trySettleLegacyClosed（settle 方向）：running→idle 收尾 + closedReason/stopReason 双写", () => {
    const rec = runningRecord();
    expect(trySettleLegacyClosed(rec, "gc")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBe("gc");
    expect(rec.stopReason).toBe("gc");
  });

  it("trySettleLegacyClosed：非 running（已收尾）重复 settle = 非法迁移拒绝（false，无副作用）", () => {
    const rec = runningRecord();
    expect(trySettleLegacyClosed(rec, "gc")).toBe(true);
    expect(trySettleLegacyClosed(rec, "cancelled")).toBe(false);
    expect(rec.closedReason).toBe("gc"); // 首次收尾位不被二次收尾覆盖
  });

  it("tryEnterRunning（wake 方向）：idle→running 翻转；running 重复 wake 拒绝", () => {
    const rec = runningRecord();
    expect(trySettleLegacyClosed(rec, "gc")).toBe(true);
    expect(tryEnterRunning(rec)).toBe(true);
    expect(rec.status).toBe("running");
    expect(tryEnterRunning(rec)).toBe(false); // 已 running：非法迁移拒绝
    expect(rec.status).toBe("running");
  });

  it("running↔idle 往返迁移（settle → wake → settle）构造性成立", () => {
    const rec = runningRecord();
    expect(trySettleLegacyClosed(rec, "user-close")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(tryEnterRunning(rec)).toBe(true);
    expect(rec.status).toBe("running");
    // tryEnterRunning 只翻占用位不清收尾位（清位归 resurrectClosed / U4 接管编排）——
    // 单向职责最小化，非法清位场景由专属原语承接。
    expect(rec.closedReason).toBe("user-close");
  });

  it("markSettled CAS：非 running 拒绝收尾（warn 返回 false，状态不被改写）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "idle";
    expect(store.markSettled(rec, "interrupted")).toBe(false);
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBeUndefined();
  });

  it("markReopened CAS：非 idle 拒绝重开（running 在途 = 非法迁移）", () => {
    const store = newStore();
    const rec = runningRecord();
    const ref: TranscriptRef = { engine: "pi", sessionFile: path.join(sessionsDir, "new.jsonl") };
    expect(store.markReopened(rec, ref)).toBe(false);
    expect(rec.epoch).toBeUndefined();
    expect(rec.transcriptRef).toBeUndefined();
  });

  it("resurrectClosed：已收尾 idle → running 接管翻回（清收尾位）；running no-op", () => {
    const rec = runningRecord();
    expect(trySettleLegacyClosed(rec, "gc")).toBe(true);
    expect(resurrectClosed(rec)).toBe(true);
    expect(rec.status).toBe("running");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.stopReason).toBeUndefined();
    expect(rec.endedAt).toBeUndefined();
    // running 入态防御性 no-op：接管是已收尾 record 的专属回边
    expect(resurrectClosed(rec)).toBe(false);
    expect(rec.status).toBe("running");
  });

  it("completeLegacyClosed 桥接：冻结 idle + closedReason/stopReason 双写 + outcome 派生", () => {
    const rec = runningRecord();
    completeLegacyClosed(
      rec,
      { text: "done", turns: 1, durationMs: 5, success: true, sessionId: "bg-1", toolCalls: [] },
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

describe("markSettled 副作用矩阵（轮收尾 = 不终态化）", () => {
  it("内存侧：status=idle + stopReason 写入；closedReason 不写（非终态）；record 留内存", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.round = 2;
    store.register(rec);
    expect(store.markSettled(rec, "interrupted")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("interrupted");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.endedAt).toBeUndefined(); // 非终态，duration 语义保持
    expect(store.getMutable("bg-1")).toBe(rec); // 留内存（随时可续聊）
  });

  it("终态收条面：record-settled 帧承载 {stopReason, endedAt}（③：`.state` 收条退场）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    store.markSettled(rec, "interrupted");
    // 终态收条的事实源 = 事件流：读最后一条 record-settled 帧原文。
    const settled = fs
      .readFileSync(path.join(manifestDir, `${rec.id}.events`), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; stopReason?: string; endedAt?: number })
      .filter((e) => e.type === "record-settled")
      .at(-1);
    expect(settled?.stopReason).toBe("interrupted");
    expect(typeof settled?.endedAt).toBe("number");
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
    // spawn 回填点 binding 写失败（best-effort）的窗口下，settle 写点承担创建路径——
    // 身份域取 settle 时点内存 record（齐全非残缺，对齐 markReopened 创建先例）。
    const binding = readRecordBinding(rec.sessionFile!);
    expect(binding).toBeDefined();
    expect(binding?.recordId).toBe("bg-1");
    expect(binding?.agent).toBe("general-purpose");
    expect(binding?.totalTokens).toBe(900);
    expect(binding?.turns).toBe(4);
    expect(binding?.round).toBe(2);
  });

  it("manifest 面：派生视图 legacy running（settle 非终态，session-reader 视角活跃成员）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    store.markSettled(rec, "interrupted");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(manifestDir, "bg-1.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(manifest.status).toBe("running"); // 旧三态下行派生视图（§3.2.8）
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

  it("无 sessionFile 锚：内存侧照常收尾，.state/binding 面跳过（warn 不抛）", () => {
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
  it("内存侧：新 transcriptRef + round 归零 + epoch+1 + stopReason=reopened；残留 lastAbandonedRound 不迁移", () => {
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

  it("zcode 锚：内存侧照常重开，binding 随锚键基底落盘（U6 会话库锚承接）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.status = "idle";
    store.register(rec);
    // dbPath 对齐真实形态：zcode 锚的 binding 落 `<dbPath>.<sessionId>` 旁（session-db
    // 目录由引擎创建，真实环境恒存在）——binding 写失败会被 markReopened 拒绝（epoch
    // 硬要求），fixture 目录必须真实存在。
    const zcodeDbDir = path.join(dir, "session-db");
    fs.mkdirSync(zcodeDbDir, { recursive: true });
    const dbPath = path.join(zcodeDbDir, "db.sqlite");
    const ref: TranscriptRef = { engine: "zcode", sessionId: "sess-abc", dbPath };
    expect(store.markReopened(rec, ref)).toBe(true);
    expect(rec.epoch).toBe(1);
    expect(rec.transcriptRef).toEqual(ref);
    expect(readRecordBinding(`${dbPath}.sess-abc`)?.epoch).toBe(1);
  });

  it("binding 写失败（新锚目录不存在）：拒绝重开 + 内存侧回滚（epoch 随 binding 持久化是硬要求，防二次 reopen 击穿）", () => {
    const store = newStore();
    const rec = runningRecord();
    rec.round = 3;
    rec.stopReason = "interrupted";
    rec.status = "idle";
    store.register(rec);
    // 失败注入：新锚落在不存在的子目录——writeRecordBinding 的 tmp 独占创建 ENOENT
    //（warn 留痕不抛），markReopened 必须拒绝而非吞错续跑。
    const badRef: TranscriptRef = {
      engine: "pi",
      sessionFile: path.join(sessionsDir, "no-such-dir", "reopened.jsonl"),
    };
    expect(store.markReopened(rec, badRef)).toBe(false);
    // 内存侧逐字段还原（record 保持重开前 idle 形态——拒绝情形不留半重开状态）
    expect(rec.transcriptRef).toBeUndefined();
    expect(rec.round).toBe(3);
    expect(rec.epoch).toBeUndefined();
    expect(rec.stopReason).toBe("interrupted");
    expect(rec.status).toBe("idle");
    // 拒绝后 record 可重试：合法新锚重开成功（epoch 从重开前基线推进）
    const goodRef: TranscriptRef = { engine: "pi", sessionFile: path.join(sessionsDir, "reopened.jsonl") };
    expect(store.markReopened(rec, goodRef)).toBe(true);
    expect(rec.epoch).toBe(1);
    expect(readRecordBinding(goodRef.sessionFile!)?.epoch).toBe(1);
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

  it("从 binding 恢复的 epoch 继续递增（跨进程防撞链封住）", () => {
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

// ── ⑤ markSettledOut 副作用矩阵（写权声明 + 收尾写入 journal 记录写侧）──────────

describe("markSettledOut 副作用矩阵", () => {
  it("markSettledOut：.alive release（release 出口①）+ entry 上报 + worktreeHandle 清句（占用位不动）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    fs.writeFileSync(
      `${rec.sessionFile}.alive`,
      JSON.stringify({ pid: process.pid, id: "bg-1", startedAt: Date.now() }),
      "utf-8",
    );
    expect(store.markSettledOut(rec)).toBe(true);
    expect(fs.existsSync(`${rec.sessionFile}.alive`)).toBe(false);
    expect(store.getMutable("bg-1")).toBe(rec); // 收尾 ≠ 内存回收（占用位不动）
  });

  it("markSettledOut 幂等：重复 close / dispose 重复调用无害（release 静默，恒 true）", () => {
    const store = newStore();
    const rec = runningRecord();
    store.register(rec);
    store.markSettledOut(rec);
    expect(store.markSettledOut(rec)).toBe(true);
    expect(fs.existsSync(`${rec.sessionFile}.alive`)).toBe(false);
    expect(store.getMutable("bg-1")).toBe(rec);
  });
});

// ══════ 来源: permanent-session-types.test.ts ══════

// src/execution/__tests__/permanent-session-types.test.ts
//
// [u-foundation / 永久会话模型] 新领域词汇的最小单测（设计
// subagent-permanent-session-model.md §3.2.1-§3.2.7；类型与骨架先行，填肉归
// U2-U7）。锁定范围：
//   ① TranscriptRef 判别联合收窄守卫（isPi/isZcodeTranscriptRef 运行时判别 +
//      类型穷尽——else 分支不可达构造性验证）；
//   ② StopReason 枚举完整性（旧 7 值 + 4 新展示值 = 11 无重复；outcome 词
//      completed/failed 不得混入——词表混淆回归锚）；
//   ③ RecordBinding 新字段（epoch/transcriptRef/lastAbandonedRound）持久化
//      往返保真 + 损坏载荷守卫归一 + 存量 binding 零迁移；
//   ④ ExecutionRecord 新字段可选性（构造零破坏：缺省 undefined + 可选赋值）；
//   ⑤ store 新收口原语骨架 throw not implemented（生产路径禁调的编程错误信号）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。




// [teardown 竞态修复] 被测链传递性 logger 输出经 console 落 stderr——同步用例的刷写落在
// 文件结束的 teardown 窗口，与 worker rpc 关闭竞态 → vitest EnvironmentTeardownError
// （onUserConsoleLog pending）→ run 退出码 1。本文件对 logger 零断言依赖，mock 静默
// （rebuild-indexes.test.ts 同款先例）。
// ── fixture ──────────────────────────────────────────────────────────────────

let psDir: string;

beforeEach(() => {
  psDir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-types-"));
});

afterEach(() => {
  fs.rmSync(psDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 最小合法 binding（v1 身份域齐全，无新字段——存量形态）。 */
function baseBinding(): RecordBinding {
  return {
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
  };
}

/** 最小合法 record（createRecord 现状形态，不带新字段）。 */
function baseRecord() {
  return createRecord("bg-1", {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "do things",
    slug: "do-things",
    startedAt: 1,
  });
}

// ── ① TranscriptRef 判别联合 ─────────────────────────────────────────────────

describe("TranscriptRef 判别联合收窄守卫", () => {
  const piRef: TranscriptRef = { engine: "pi", sessionFile: "2026-09-13-a.jsonl" };
  const zcodeRef: TranscriptRef = {
    engine: "zcode",
    sessionId: "sess-abc",
    dbPath: "/data/engines/zcode/session-db/db.sqlite",
  };

  it("两锚经守卫收窄后各只暴露引擎专有字段（类型穷尽 + 运行时判别）", () => {
    for (const ref of [piRef, zcodeRef]) {
      if (isPiTranscriptRef(ref)) {
        // 收窄后 sessionFile 可达（TS 层验证）；zcode 专有字段在窄类型上不存在。
        expect(ref.engine).toBe("pi");
        expect(typeof ref.sessionFile).toBe("string");
        expect(ref.sessionFile).toBe("2026-09-13-a.jsonl");
      } else if (isZcodeTranscriptRef(ref)) {
        expect(ref.engine).toBe("zcode");
        expect(typeof ref.sessionId).toBe("string");
        expect(typeof ref.dbPath).toBe("string");
      } else {
        // 联合穷尽：两守卫覆盖全部成员，此分支不可达（收窄守卫完备性的构造性验证）。
        throw new Error("unreachable: TranscriptRef union not exhausted by guards");
      }
    }
  });

  it("守卫交叉判别互斥（pi 锚不为 zcode，反之亦然）", () => {
    expect(isPiTranscriptRef(piRef)).toBe(true);
    expect(isZcodeTranscriptRef(piRef)).toBe(false);
    expect(isPiTranscriptRef(zcodeRef)).toBe(false);
    expect(isZcodeTranscriptRef(zcodeRef)).toBe(true);
  });
});

// ── ② StopReason 枚举完整性 ──────────────────────────────────────────────────

describe("StopReason 枚举完整性", () => {
  it("全枚举 = 旧 ClosedReason 7 值（6 写值 + disconnected 读侧兜底）+ 4 新展示值 + 3 引擎原值 + 2 迁移期旧值，共 16 无重复", () => {
    // [subagent-observability §3.3.3] 轮收条事实化：引擎原值 stop/error/aborted 入
    // 词表（轮终写入值域），completed/failed 降为迁移期旧值（历史帧解析放行，
    // 迁移完删旧值）。枚举完整性锚已迁 execution/domain/__tests__/record-types.test.ts
    // （词表文件同位）；本用例保留值数防线。
    expect([...STOP_REASONS]).toHaveLength(16);
    // 无重复（重复成员会撑长度 + 稀释枚举语义）。
    expect(new Set(STOP_REASONS).size).toBe(STOP_REASONS.length);
    for (const reason of [
      "parent-shutdown",
      "parent-fork",
      "parent-new",
      "user-close",
      "cancelled",
      "gc",
      "disconnected",
      ...NEW_STOP_REASONS,
      ...ROUND_TERMINAL_STOP_REASONS,
      "completed",
      "failed",
    ] as const) {
      expect(STOP_REASONS).toContain(reason);
    }
  });

  it("NEW_STOP_REASONS 恰为 4 个新展示值", () => {
    expect([...NEW_STOP_REASONS]).toEqual([
      "interrupted",
      "interrupted-by-restart",
      "interrupted-by-parent",
      "reopened",
    ]);
  });

  it("ROUND_TERMINAL_STOP_REASONS 恰为 3 个引擎原值（[subagent-observability §3.3.3] 轮收条事实化——停因只存引擎事实）", () => {
    expect([...ROUND_TERMINAL_STOP_REASONS]).toEqual(["stop", "error", "aborted"]);
  });

  it("isValidStopReason：合法成员（含迁移期旧值 completed/failed——历史帧解析放行）放行；垃圾值拒绝", () => {
    for (const reason of STOP_REASONS) {
      expect(isValidStopReason(reason)).toBe(true);
    }
    // [A-lite 裁决翻转 → subagent-observability 迁移期] completed/failed 曾是正常轮终
    // 展示位；轮收条事实化后为迁移期旧值（写侧产出随 u3 接线退役），历史帧解析词表
    // 保留放行——迁移完删旧值（§3.4）时本断言随成员一并删除。
    expect(isValidStopReason("completed")).toBe(true);
    expect(isValidStopReason("failed")).toBe(true);
    expect(isValidStopReason("bogus")).toBe(false);
    expect(isValidStopReason(undefined)).toBe(false);
  });
});

// ── 新词汇类型面（值域编译锚） ────────────────────────────────────────────────

describe("新词汇类型面值域", () => {
  it("Epoch 值域", () => {
    const epoch: Epoch = 0;
    expect(epoch).toBe(0);
  });
});

// ── ③ RecordBinding 新字段持久化 ────────────────────────────────────────────

describe("RecordBinding 新字段（epoch / transcriptRef / lastAbandonedRound）", () => {
  it("经 writeRecordBinding → readRecordBinding 往返保真", () => {
    const sessionFile = path.join(psDir, "sess.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    writeRecordBinding(sessionFile, {
      ...baseBinding(),
      epoch: 3,
      transcriptRef: { engine: "zcode", sessionId: "sess-abc", dbPath: "/x/db.sqlite" },
      lastAbandonedRound: { epoch: 2, round: 5 },
    });

    const read = readRecordBinding(sessionFile);
    expect(read).toBeDefined();
    expect(read?.epoch).toBe(3);
    expect(read?.transcriptRef).toEqual({
      engine: "zcode",
      sessionId: "sess-abc",
      dbPath: "/x/db.sqlite",
    });
    expect(read?.lastAbandonedRound).toEqual({ epoch: 2, round: 5 });
  });

  it("lastAbandonedRound: null 往返保留（null 与 undefined 同义 = 无标记）", () => {
    const sessionFile = path.join(psDir, "sess.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    writeRecordBinding(sessionFile, { ...baseBinding(), lastAbandonedRound: null });

    expect(readRecordBinding(sessionFile)?.lastAbandonedRound).toBeNull();
  });

  it("损坏载荷守卫归一：非 number epoch / 未知 engine / 缺字段标记 → undefined", () => {
    const sessionFile = path.join(psDir, "sess.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    fs.writeFileSync(
      `${sessionFile}.record-binding`,
      JSON.stringify({
        ...baseBinding(),
        epoch: "3",
        transcriptRef: { engine: "anthropic", sessionFile: "x.jsonl" },
        lastAbandonedRound: { epoch: 1 }, // 缺 round
      }),
      "utf-8",
    );

    const read = readRecordBinding(sessionFile);
    expect(read).toBeDefined();
    expect(read?.epoch).toBeUndefined();
    expect(read?.transcriptRef).toBeUndefined();
    expect(read?.lastAbandonedRound).toBeUndefined();
  });

  it("存量 binding（无新字段）读取零迁移：三字段均 undefined，身份域不受影响", () => {
    const sessionFile = path.join(psDir, "sess.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    writeRecordBinding(sessionFile, baseBinding());

    const read = readRecordBinding(sessionFile);
    expect(read?.recordId).toBe("bg-1");
    expect(read?.epoch).toBeUndefined();
    expect(read?.transcriptRef).toBeUndefined();
    expect(read?.lastAbandonedRound).toBeUndefined();
  });
});

// ── ④ ExecutionRecord 新字段可选性 ──────────────────────────────────────────

describe("ExecutionRecord 新字段可选性（构造零破坏）", () => {
  it("createRecord 不传新字段时四字段均 undefined（旧词汇零迁移）", () => {
    const rec = baseRecord();
    expect(rec.stopReason).toBeUndefined();
    expect(rec.epoch).toBeUndefined();
    expect(rec.lastAbandonedRound).toBeUndefined();
    expect(rec.transcriptRef).toBeUndefined();
  });

  it("四字段可选赋值（类型层验证：U2 写点就绪）", () => {
    const rec = baseRecord();
    rec.stopReason = "interrupted-by-parent";
    rec.epoch = 1;
    rec.lastAbandonedRound = { epoch: 0, round: 3 };
    rec.transcriptRef = { engine: "pi", sessionFile: "a.jsonl" };

    expect(rec.stopReason).toBe("interrupted-by-parent");
    expect(rec.epoch).toBe(1);
    expect(rec.lastAbandonedRound).toEqual({ epoch: 0, round: 3 });
    expect(rec.transcriptRef).toEqual({ engine: "pi", sessionFile: "a.jsonl" });
  });
});

// ── ⑤ store 新收口原语（U2 已实装，冒烟）────────────────────────────────────
// 详细行为矩阵（CAS 语义 / 原语副作用面 / epoch 递增）见
// permanent-session-state-machine.test.ts；此处仅锁定「骨架已填肉、可调用」。

describe("store 新收口原语（U2 实装冒烟）", () => {
  it("markSettled：running record 收口为 idle + stopReason（骨架 throw 已移除）", () => {
    const store = new RecordStore(() => path.join(psDir, "sessions"));
    const rec = baseRecord();
    store.register(rec);

    expect(store.markSettled(rec, "interrupted")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("interrupted");
  });
});
