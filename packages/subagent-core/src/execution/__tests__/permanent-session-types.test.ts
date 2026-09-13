// src/execution/__tests__/permanent-session-types.test.ts
//
// [u-foundation / 永久会话模型] 新领域词汇的最小单测（设计
// subagent-permanent-session-model.md §3.2.1-§3.2.7；类型与骨架先行，填肉归
// U2-U7）。锁定面：
//   ① TranscriptRef 判别联合收窄守卫（isPi/isZcodeTranscriptRef 运行时判别 +
//      类型穷尽——else 分支不可达构造性验证）；
//   ② StopReason 枚举完整性（旧 7 值 + 4 新展示值 = 11 无重复；outcome 词
//      completed/failed 不得混入——词表混淆回归锚）；
//   ③ RecordBinding 新字段（epoch/transcriptRef/lastAbandonedRound）持久化
//      往返保真 + 损坏载荷守卫归一 + 存量 binding 零迁移；
//   ④ ExecutionRecord 新字段可选性（构造零破坏：缺省 undefined + 可选赋值）；
//   ⑤ store 新意图原语骨架 throw not implemented（生产路径禁调的编程错误信号）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecord } from "../execution-record.ts";
import { RecordStore } from "../record-store.ts";
import { readRecordBinding, writeRecordBinding } from "../state-marker.ts";
import type { RecordBinding } from "../state-marker.ts";
import {
  NEW_STOP_REASONS,
  ROUND_TERMINAL_STOP_REASONS,
  STOP_REASONS,
  isPiTranscriptRef,
  isZcodeTranscriptRef,
  isValidStopReason,
} from "../types.ts";
import type {
  Epoch,
  ExecutionStatusV2,
  Intent,
  LegacyClosedStatus,
  TranscriptRef,
} from "../types.ts";

// ── fixture ──────────────────────────────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-types-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
    chatMode: true,
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
  it("全枚举 = 旧 ClosedReason 7 值（6 写值 + disconnected 读侧兜底）+ 4 新展示值 + 2 正常轮终展示值，共 13 无重复", () => {
    expect([...STOP_REASONS]).toHaveLength(13);
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

  it("ROUND_TERMINAL_STOP_REASONS 恰为 2 个正常轮终展示值（A-lite）", () => {
    expect([...ROUND_TERMINAL_STOP_REASONS]).toEqual(["completed", "failed"]);
  });

  it("isValidStopReason：合法成员（含正常轮终 completed/failed）放行；垃圾值拒绝", () => {
    for (const reason of STOP_REASONS) {
      expect(isValidStopReason(reason)).toBe(true);
    }
    // [A-lite 裁决翻转] completed/failed 原锁拒绝（派生 outcome 词汇不混入
    // stopReason 词表）——区1-U1+区3-U1 一致性审查后 markRoundIdle 正常轮终
    // 需要停因展示位（SubagentList failed 判据 + 排障「为什么停」），两词入值域
    //（status 保持 running-resumable，见 types.ts StopReason 注释）。
    expect(isValidStopReason("completed")).toBe(true);
    expect(isValidStopReason("failed")).toBe(true);
    expect(isValidStopReason("bogus")).toBe(false);
    expect(isValidStopReason(undefined)).toBe(false);
  });
});

// ── 新词汇类型面（值域编译锚） ────────────────────────────────────────────────

describe("新词汇类型面值域", () => {
  it("Intent / ExecutionStatusV2 / LegacyClosedStatus / Epoch 值域", () => {
    const intents: Intent[] = ["active", "archived"];
    expect(intents).toEqual(["active", "archived"]);

    const statuses: ExecutionStatusV2[] = ["running", "idle"];
    expect(statuses).toEqual(["running", "idle"]);

    const legacy: LegacyClosedStatus = "closed";
    expect(legacy).toBe("closed");

    const epoch: Epoch = 0;
    expect(epoch).toBe(0);
  });
});

// ── ③ RecordBinding 新字段持久化 ────────────────────────────────────────────

describe("RecordBinding 新字段（epoch / transcriptRef / lastAbandonedRound）", () => {
  it("经 writeRecordBinding → readRecordBinding 往返保真", () => {
    const sessionFile = path.join(dir, "sess.jsonl");
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
    const sessionFile = path.join(dir, "sess.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    writeRecordBinding(sessionFile, { ...baseBinding(), lastAbandonedRound: null });

    expect(readRecordBinding(sessionFile)?.lastAbandonedRound).toBeNull();
  });

  it("损坏载荷守卫归一：非 number epoch / 未知 engine / 缺字段标记 → undefined", () => {
    const sessionFile = path.join(dir, "sess.jsonl");
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
    const sessionFile = path.join(dir, "sess.jsonl");
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
  it("createRecord 不传新字段时五字段均 undefined（旧词汇零迁移）", () => {
    const rec = baseRecord();
    expect(rec.intent).toBeUndefined();
    expect(rec.stopReason).toBeUndefined();
    expect(rec.epoch).toBeUndefined();
    expect(rec.lastAbandonedRound).toBeUndefined();
    expect(rec.transcriptRef).toBeUndefined();
  });

  it("五字段可选赋值（类型层验证：U2 写点就绪）", () => {
    const rec = baseRecord();
    rec.intent = "archived";
    rec.stopReason = "interrupted-by-parent";
    rec.epoch = 1;
    rec.lastAbandonedRound = { epoch: 0, round: 3 };
    rec.transcriptRef = { engine: "pi", sessionFile: "a.jsonl" };

    expect(rec.intent).toBe("archived");
    expect(rec.stopReason).toBe("interrupted-by-parent");
    expect(rec.epoch).toBe(1);
    expect(rec.lastAbandonedRound).toEqual({ epoch: 0, round: 3 });
    expect(rec.transcriptRef).toEqual({ engine: "pi", sessionFile: "a.jsonl" });
  });
});

// ── ⑤ store 新意图原语（U2 已实装，冒烟）────────────────────────────────────
// 详细行为矩阵（CAS 语义 / 原语副作用面 / epoch 递增）见
// permanent-session-state-machine.test.ts；此处仅锁定「骨架已填肉、可调用」。

describe("store 新意图原语（U2 实装冒烟）", () => {
  it("markSettled：running record 收口为 idle + stopReason（骨架 throw 已移除）", () => {
    const store = new RecordStore(path.join(dir, "sessions"));
    const rec = baseRecord();
    store.register(rec);

    expect(store.markSettled(rec, "interrupted")).toBe(true);
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("interrupted");
  });
});
