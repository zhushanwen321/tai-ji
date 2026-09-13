// src/execution/__tests__/permanent-session-stats-baseline.test.ts
//
// [U7 / 永久会话模型 §3.2.7] 统计口径单基准验收：binding 快照为基准 + 内存增量
// 覆盖 + revive/重启恢复（设计 subagent-permanent-session-model.md §3.2.7 统计行
// 与 round 基线行；impl-plan §2 U7 行验收条款「revive 前轮统计保留 + 跨重启 binding
// 恢复」）。
//
// 四组验收面：
//   ① revive 前轮统计保留：fake binding 落盘 → 新 store 实例 light 重建水合
//      （turns/tokens/round）→ markResurrected 基线水合 → 新轮增量在基线上累加
//      （跨轮连续；设计原文的 roundBaseTurnIndex 字段已随 H1 U6 / D7 ③ 退役，
//      等价实现 = binding.turns 水合 record.turnCount——轮 N 的 turn 基点 = binding
//      记录的累计值，不每轮从零）；
//   ② 跨重启 binding 恢复 + 内存增量衔接无跳变：内存终值 == settle 快照 ==
//      新 store 重建值；
//   ③ zcode 锚 settle 快照收编（U6-D2 交接）+ 重启锚恢复（B-restart store 面）：
//      锚键 binding 落盘 → entry 源可见 + 锚派生 → markResurrected zcode 分派
//      （acquire 键 + foreign 探针 + 水合）→ markReopened/markArchived 锚分派；
//   ④ 归零覆盖回归（GUI 快修批次⑤根因）：冷复活后 register 的 entry 投影携带
//      水合值，不再以归零 entry last-writer-wins 覆盖磁盘原值。
//
// fixture 一律 mkdtempSync(tmpdir) 自建自删，不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { transcriptAnchorOf } from "../cold-lookup.ts";
import { createRecord, updateFromEvent } from "../execution-record.ts";
import { RecordStore } from "../record-store.ts";
import { readRecordBinding, zcodeAnchorBasePath, writeRecordBinding } from "../state-marker.ts";
import type { ExecutionRecord, TranscriptRef } from "../types.ts";
import { ResurrectDeniedError } from "../types.ts";

// ── fixture ──────────────────────────────────────────────────────────────────

let dir: string;
let sessionsDir: string;
let manifestDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-stats-baseline-"));
  sessionsDir = path.join(dir, "sessions");
  manifestDir = path.join(dir, "records");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function newStore(pi?: { appendEntry?: (customType: string, data: unknown) => void }): RecordStore {
  return new RecordStore(sessionsDir, undefined, pi ?? null, manifestDir);
}

/** pi 锚 record（running 形态，sessionFile 指向磁盘已存在的子文件）。 */
function piRecord(id: string, sessionFile: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const rec = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "do things",
    slug: "do-things",
    startedAt: 1,
    rootSessionId: "root-1",
    chatMode: true,
  });
  (rec as { sessionFile?: string }).sessionFile = sessionFile;
  return Object.assign(rec, over) as ExecutionRecord;
}

/** 最小合法子 session 文件（session header + subagent-identity entry）。 */
function writeIdentityChild(file: string, id: string): void {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "sess-uuid",
    timestamp: new Date(1).toISOString(),
    cwd: "/tmp",
  });
  const identity = JSON.stringify({
    type: "custom",
    id: "e1",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    customType: "subagent-identity",
    data: { id, agent: "general-purpose", mode: "background", task: "do things", startedAt: 1, rootSessionId: "root-1" },
  });
  fs.writeFileSync(file, `${header}\n${identity}\n`, "utf-8");
}

/** 主 session 文件写一条 subagent-record entry（entry 源的磁盘供给形态）。 */
function appendRecordEntryLine(mainSessionFile: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({
    type: "custom",
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "subagent-record",
    data,
  });
  fs.appendFileSync(mainSessionFile, `${line}\n`, "utf-8");
}

/** zcode 锚 record（engineHandle.sessionRef 单源形态——transcriptAnchorOf 派生链）。 */
function zcodeRecord(id: string, dbPath: string, sessionId: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const rec = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "do zcode things",
    slug: "zcode-things",
    startedAt: 1,
    rootSessionId: "root-1",
    chatMode: true,
    engine: "zcode",
  });
  rec.engineHandle = { sessionRef: { sessionId, dbPath }, poolKey: "shared" };
  return Object.assign(rec, over) as ExecutionRecord;
}

// ── ① revive 前轮统计保留（pi binding 基线水合 + 跨轮连续）──────────────────

describe("U7① revive 前轮统计保留（binding 基准）", () => {
  it("fake binding 落盘 → 新 store 实例 light 重建水合 turns/tokens/round（identity 基底同样投影）", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");
    // settle 快照（宿主 A 收口产物）。
    writeRecordBinding(child, {
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
      rootSessionId: "root-1",
      totalTokens: 4200,
      turns: 7,
      round: 3,
      epoch: 1,
      endedAt: 999,
    });

    // 重启：新 store 实例（fileCache 空、内存空）——buildRecord light 水合。
    const store2 = newStore();
    const found = store2.collectRecords(10, "all").find((r) => r.id === "bg-1");
    expect(found).toBeDefined();
    expect(found?.turns).toBe(7);
    expect(found?.totalTokens).toBe(4200);
    expect(found?.round).toBe(3);
    expect(found?.endedAt).toBe(999);
    expect(found?.status).toBe("idle"); // 重建单规则（§3.2.4）不受统计投影影响
  });

  it("markResurrected 水合基线 → 新轮增量在基线上累加（round N 的 turn 基点 = binding 累计值）", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");
    writeRecordBinding(child, {
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
      rootSessionId: "root-1",
      totalTokens: 4200,
      turns: 7,
      round: 3,
      epoch: 1,
      lastAbandonedRound: { epoch: 1, round: 2 },
    });

    const store2 = newStore();
    // 冷查重建链的最小等价形态（resurrectColdRecord 的 store 面契约边界）：
    // createRecord 归零基线 + sessionFile/round 水合（cold-lookup 职责）。
    const rec = piRecord("bg-1", child);
    rec.round = 3;
    store2.markResurrected(rec, true);

    // [U7] 统计基线水合：turns/tokens/round/epoch/放弃轮标记从 binding 恢复，
    // 不随 createRecord 归零。
    expect(rec.turnCount).toBe(7);
    expect(rec.totalTokens).toBe(4200);
    expect(rec.round).toBe(3);
    expect(rec.epoch).toBe(1);
    expect(rec.lastAbandonedRound).toEqual({ epoch: 1, round: 2 });
    expect(rec.status).toBe("running"); // resurrectClosed 翻回

    // 新轮增量在基线上累加（updateFromEvent 唯一更新点）：turn_end 后 turnCount =
    // 基线 7 + 1，不每轮从零。
    updateFromEvent(rec, { type: "turn_end" });
    updateFromEvent(rec, {
      type: "message_end",
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    });
    expect(rec.turnCount).toBe(8);
    expect(rec.totalTokens).toBe(4230);
  });

  it("无 binding（存量子文件零迁移）→ light 统计保持缺省 0（不误投影）", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-2");
    const store = newStore();
    const found = store.collectRecords(10, "all").find((r) => r.id === "bg-2");
    expect(found).toBeDefined();
    expect(found?.turns).toBe(0);
    expect(found?.totalTokens).toBe(0);
    expect(found?.round).toBeUndefined();
  });
});

// ── ② 跨重启 binding 恢复 + 内存增量衔接无跳变 ────────────────────────────────

describe("U7② 跨重启 binding 恢复（内存终值 == settle 快照 == 重建值）", () => {
  it("内存增量累加 → settle 落快照 → 新 store 重建值逐字段一致（衔接无跳变）", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");

    // 宿主 A：内存 running record 增量累加（updateFromEvent 唯一更新点）。
    const storeA = newStore();
    const rec = piRecord("bg-1", child);
    storeA.register(rec);
    updateFromEvent(rec, { type: "turn_end" });
    updateFromEvent(rec, {
      type: "message_end",
      usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    });
    updateFromEvent(rec, { type: "turn_end" });
    rec.round = 1;
    expect(storeA.markSettled(rec, "gc")).toBe(true);
    const memTurns = rec.turnCount;
    const memTokens = rec.totalTokens;
    expect(memTurns).toBe(2);
    expect(memTokens).toBe(300);

    // settle 快照（binding）== 内存终值。
    const binding = readRecordBinding(child);
    expect(binding?.turns).toBe(memTurns);
    expect(binding?.totalTokens).toBe(memTokens);
    expect(binding?.round).toBe(1);

    // 重启：新 store 重建值 == 内存终值（active 以内存为准，idle/重启后以 binding
    // 为准，两者衔接无跳变）。
    const storeB = newStore();
    const found = storeB.collectRecords(10, "all").find((r) => r.id === "bg-1");
    expect(found?.turns).toBe(memTurns);
    expect(found?.totalTokens).toBe(memTokens);
    expect(found?.round).toBe(1);
  });
});

// ── ③ zcode 锚 settle 快照收编 + 重启锚恢复（B-restart store 面）──────────────

describe("U7③ zcode 锚 settle 快照与重启恢复", () => {
  it("markSettled（zcode 锚）：锚键 binding 落盘（epoch/统计终值/transcriptRef），无 .state 面（无文件锚）", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const store = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1", { round: 2 });
    rec.turnCount = 6;
    rec.totalTokens = 800;
    rec.epoch = 1;
    store.register(rec);
    expect(store.markSettled(rec, "gc")).toBe(true);

    // 锚键 = `<dbPath>.<sessionId>` + .record-binding（zcodeAnchorBasePath）。
    const base = zcodeAnchorBasePath({ sessionId: "s-1", dbPath });
    const binding = readRecordBinding(base);
    expect(binding).toBeDefined();
    expect(binding?.recordId).toBe("zc-1");
    expect(binding?.turns).toBe(6);
    expect(binding?.totalTokens).toBe(800);
    expect(binding?.round).toBe(2);
    expect(binding?.epoch).toBe(1);
    expect(binding?.transcriptRef).toEqual({ engine: "zcode", sessionId: "s-1", dbPath });
    // .state / pi binding 面 zero（无子 session 文件锚）。
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".state"))).toEqual([]);
  });

  it("重启：主 session entry（engine zcode + engineHandle.sessionRef）→ entry 源可见 + 锚派生 + 统计恢复", () => {
    const dbPath = path.join(dir, "db.sqlite");
    // 宿主 A settle（锚键 binding 落盘）。
    const storeA = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1", { round: 2 });
    rec.turnCount = 6;
    rec.totalTokens = 800;
    rec.epoch = 1;
    storeA.register(rec);
    storeA.markSettled(rec, "gc");

    // 主 session entry（settle entry 投影——reportRecordTransition 产物形态）。
    const mainSessionFile = path.join(dir, "main-session.jsonl");
    appendRecordEntryLine(mainSessionFile, {
      v: 1,
      id: "zc-1",
      agent: "general-purpose",
      task: "do zcode things",
      slug: "zcode-things",
      status: "idle",
      stopReason: "gc",
      mode: "background",
      startedAt: 1,
      rootSessionId: "root-1",
      depth: 0,
      turns: 6,
      totalTokens: 800,
      model: "test/model",
      round: 2,
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "s-1", dbPath }, poolKey: "shared" },
    });

    // 重启：新 store + initSession 恢复入口（recoverOrphanRecords 记忆 mainSessionFile）。
    const storeB = newStore();
    storeB.recoverOrphanRecords(undefined, mainSessionFile);
    const found = storeB.collectRecords(10, "all").find((r) => r.id === "zc-1");
    expect(found).toBeDefined();
    expect(found?.engine).toBe("zcode");
    expect(found?.turns).toBe(6);
    expect(found?.totalTokens).toBe(800);
    expect(found?.round).toBe(2);
    expect(found?.status).toBe("idle");
    // 锚恢复（cold-lookup 链等价断言）：engineHandle.sessionRef → zcode 锚。
    const anchor = transcriptAnchorOf(found ?? {});
    expect(anchor).toEqual({ engine: "zcode", sessionId: "s-1", dbPath });
  });

  it("markResurrected（zcode 锚）：锚键 acquire + binding 水合（epoch/统计）+ register", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const storeA = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1", { round: 2 });
    rec.turnCount = 6;
    rec.totalTokens = 800;
    rec.epoch = 1;
    storeA.register(rec);
    storeA.markSettled(rec, "gc");

    const storeB = newStore();
    // 冷查重建链最小等价形态：createRecord 归零 + transcriptRef 水合（transcriptAnchorOf
    // 产物——resurrectColdRecord 职责）。
    const rec2 = zcodeRecord("zc-1", dbPath, "s-1");
    rec2.transcriptRef = { engine: "zcode", sessionId: "s-1", dbPath };
    storeB.markResurrected(rec2, true);

    // 写权声明键 = 锚基底 + .alive（与 pi `${sessionFile}.alive` 同构）。
    expect(fs.existsSync(`${zcodeAnchorBasePath({ sessionId: "s-1", dbPath })}.alive`)).toBe(true);
    // 统计/epoch 基线水合（不再被「no sessionFile anchor」硬拒）。
    expect(rec2.turnCount).toBe(6);
    expect(rec2.totalTokens).toBe(800);
    expect(rec2.epoch).toBe(1);
    expect(rec2.status).toBe("running");
    expect(storeB.getMutable("zc-1")).toBe(rec2);
  });

  it("markResurrected（zcode 锚）：异进程持有时 ResurrectDeniedError（acquire 点探针收编）", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const base = zcodeAnchorBasePath({ sessionId: "s-1", dbPath });
    // 预写异宿主声明（pid 1 = launchd，恒活且非 self——findForeignLiveInstance 拦截形态）。
    fs.writeFileSync(`${base}.alive`, `${JSON.stringify({ pid: 1, id: "zc-1", startedAt: 1000 })}\n`, "utf-8");

    const store = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1");
    rec.transcriptRef = { engine: "zcode", sessionId: "s-1", dbPath };
    expect(() => store.markResurrected(rec, true)).toThrow(ResurrectDeniedError);
    expect(() => store.markResurrected(rec, true)).toThrow(/pid 1/);
  });

  it("markReopened（zcode 锚）：新 sessionId 键下 binding 落盘（epoch 单调持久化）", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const store = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1");
    rec.turnCount = 6;
    rec.totalTokens = 800;
    rec.epoch = 1;
    store.register(rec);
    // 旧锚（s-1）先经 settle 落 binding（reopen 前提：锚失效但历史键留存）。
    store.markSettled(rec, "gc");

    const newRef: TranscriptRef = { engine: "zcode", sessionId: "s-2", dbPath };
    expect(store.markReopened(rec, newRef)).toBe(true);
    expect(rec.epoch).toBe(2);
    expect(rec.transcriptRef).toEqual(newRef);

    const binding = readRecordBinding(zcodeAnchorBasePath({ sessionId: "s-2", dbPath }));
    expect(binding).toBeDefined();
    expect(binding?.epoch).toBe(2);
    expect(binding?.turns).toBe(6);
    expect(binding?.transcriptRef).toEqual(newRef);
    // 旧锚键 binding 保留（历史锚回溯，与 pi 侧旧文件 binding 同族）。
    expect(readRecordBinding(zcodeAnchorBasePath({ sessionId: "s-1", dbPath }))).toBeDefined();
  });

  it("markArchived（zcode 锚）：release 分派（锚键 .alive 删除）", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const base = zcodeAnchorBasePath({ sessionId: "s-1", dbPath });
    const store = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1");
    rec.transcriptRef = { engine: "zcode", sessionId: "s-1", dbPath };
    store.register(rec);
    store.markResurrected(rec, false); // 接管形态 acquire（running 候选）
    expect(fs.existsSync(`${base}.alive`)).toBe(true);

    store.markArchived(rec);
    expect(fs.existsSync(`${base}.alive`)).toBe(false);
    expect(rec.intent).toBe("archived");
  });

  it("双锚皆缺（spawn 窗口期）→ markResurrected 维持响亮硬拒（现行语义保留）", () => {
    const store = newStore();
    const rec = createRecord("na-1", {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      task: "t",
      slug: "t",
      startedAt: 1,
    });
    expect(() => store.markResurrected(rec, true)).toThrow(/no sessionFile anchor/);
  });
});

// ── ④ 归零覆盖回归（GUI 快修批次⑤根因）──────────────────────────────────────

describe("U7④ 归零覆盖回归：冷复活 entry 投影不再以归零值覆盖磁盘原值", () => {
  it("settle 落 binding → 冷复活 markResurrected → register 的 entry 投影携带水合值", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");
    // 宿主 A settle：binding 终值 turns=5 / tokens=1500 / round=2。
    writeRecordBinding(child, {
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
      rootSessionId: "root-1",
      totalTokens: 1500,
      turns: 5,
      round: 2,
    });

    // 重启：新 store + pi mock 收集 subagent-record entry（register 内置上报）。
    const entries: Array<Record<string, unknown>> = [];
    const storeB = newStore({
      appendEntry: (customType, data) => {
        if (customType === "subagent-record") entries.push(data as Record<string, unknown>);
      },
    });

    // 冷复活链最小等价：createRecord（归零基线）→ markResurrected。
    const rec = piRecord("bg-1", child);
    storeB.markResurrected(rec, true);

    // 回归断言：register 的 entry 投影 turns/totalTokens = binding 水合值——
    // 修复前形态 = createRecord 归零（0/0）经 entry last-writer-wins 覆盖磁盘原值。
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1]!;
    expect(last.turns).toBe(5);
    expect(last.totalTokens).toBe(1500);
    expect(last.round).toBe(2);

    // 磁盘 binding 原值未被覆盖（merge 读侧不变）。
    expect(readRecordBinding(child)?.turns).toBe(5);
  });
});
