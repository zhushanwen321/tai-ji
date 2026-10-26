// src/execution/__tests__/permanent-session-stats-baseline.test.ts
//
// [round5-g 合并产物] 吸收同域姊妹件（永久会话 record 域）：
// permanent-session-legacy-compat.test.ts（存量形态兼容读取）。logger 桩同款去重。
//
// [U7 / 永久会话模型 §3.2.7] 统计口径单基准验收：事件流折叠为基准（[② 读侧换源]，
// 原 binding 快照读侧已退场）+ 内存增量覆盖 + revive/重启恢复（设计
// subagent-permanent-session-model.md §3.2.7 统计行与 round 基线行；impl-plan §2 U7
// 行验收条款「revive 前轮统计保留 + 跨重启恢复」）。
//
// 四组验收侧：
//   ① revive 前轮统计保留：事件流收条播种 → 新 store 实例 light 重建水合
//      （turns/tokens/round）→ markResurrected 基线水合 → 新轮增量在基线上累加
//      （跨轮连续；设计原文的 roundBaseTurnIndex 字段已随 H1 U6 / D7 ③ 退役，
//      等价实现 = 折叠收条 turns 水合 record.turnCount——轮 N 的 turn 基点 = 事件
//      流承载的累计值，不每轮从零）；
//   ② 跨重启恢复 + 内存增量衔接无跳变：内存终值 == settle 收条事件 == 新 store
//      重建值（settle 写点的 binding 快照仍在——写侧不变，读侧已换源折叠）；
//   ③ zcode 锚 settle 快照收编（U6-D2 交接）+ 重启锚恢复（B-restart store 面）：
//      锚键 binding 落盘 → entry 源可见 + 锚派生 → markResurrected zcode 分派
//      （acquire 键 + foreign 探针 + 折叠水合）→ markReopened/markSettledOut 锚分派；
//   ④ 归零覆盖回归（GUI 快修批次⑤根因）：冷复活后 register 的 entry 派生视图携带
//      水合值，不再以归零 entry last-writer-wins 覆盖磁盘原值。
//
// fixture 一律 mkdtempSync(tmpdir) 自建自删，不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { transcriptAnchorOf } from "../assembly/cold-lookup.ts";
import { createRecord, updateFromEvent } from "../persistence/execution-record.ts";
import { createRecordEventStream } from "../persistence/record-events.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { recordToSubagent } from "../persistence/record-store-rebuild.ts";
import { readRecordBinding, zcodeAnchorBasePath } from "../persistence/state-marker.ts";
import { seedTerminalRecord } from "./helpers/seed-terminal-record.ts";
import type { TranscriptRef } from "../domain/record-types.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { ResurrectDeniedError } from "../domain/record-types.ts";
import { v2RegisteredEntry, v2SettledEntry } from "./helpers/v2-record-entry.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { writeRecordBinding } from "../persistence/state-marker.js";

// [teardown 竞态修复] 被测链传递性 logger 输出（如扫描尾 fire-and-forget saveIndex 的
// 失败分支 warn，record-store-last-line.test.ts 同族根因）经 console 落 stderr——本文件
// 用例全同步，刷写落在文件结束的 teardown 窗口，与 worker rpc 关闭竞态 → vitest
// EnvironmentTeardownError（onUserConsoleLog pending）→ run 退出码 1。本文件对 logger
// 零断言依赖，mock 静默（rebuild-indexes.test.ts 同款先例）。
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
  return new RecordStore(() => sessionsDir, undefined, pi ?? null, () => manifestDir);
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
function appendRecordEntryLine(mainSessionFile: string, data: unknown): void {
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
    engine: "zcode",
  });
  rec.engineHandle = { sessionRef: { sessionId, dbPath }, poolKey: "shared" };
  return Object.assign(rec, over) as ExecutionRecord;
}

// ── ① revive 前轮统计保留（事件流折叠基准 + 跨轮连续）──────────────────

describe("U7① revive 前轮统计保留（事件流折叠基准）", () => {
  it("事件流轮终收条播种 → 新 store 实例 light 重建水合 turns/tokens/round/endedAt（identity 基底同样派生）", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");
    // 宿主 A 的轮终收条（事件流播种：created → round-started(3) → round-idle 快照）。
    seedTerminalRecord(manifestDir, {
      id: "bg-1",
      startedAt: 1,
      stopReason: "completed",
      rootSessionId: "root-1",
      idleRound: { round: 3, ts: 999, turns: 7, totalTokens: 4200 },
      epoch: 1,
    });

    // 重启：新 store 实例（fileCache 空、内存空）——buildRecord light 水合。
    const store2 = newStore();
    const found = store2.collectRecords(10, "all").find((r) => r.id === "bg-1");
    expect(found).toBeDefined();
    expect(found?.turns).toBe(7);
    expect(found?.totalTokens).toBe(4200);
    expect(found?.round).toBe(3);
    expect(found?.endedAt).toBe(999);
    expect(found?.status).toBe("idle"); // 重建单规则（§3.2.4）不受统计派生视图影响
  });

  it("markResurrected 水合基线 → 新轮增量在基线上累加（round N 的 turn 基点 = 事件流累计值）", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");
    // 事件流播种：created → bound(epoch 1) → round-started(3) → round-idle
    //（轮统计快照 + 放弃轮标记——收编与 revive 水合的折叠源）。
    seedTerminalRecord(manifestDir, {
      id: "bg-1",
      startedAt: 1,
      stopReason: "completed",
      rootSessionId: "root-1",
      boundSessionFile: child,
      idleRound: {
        round: 3,
        ts: 900,
        turns: 7,
        totalTokens: 4200,
        lastAbandonedRound: { epoch: 1, round: 2 },
      },
      epoch: 1,
    });

    const store2 = newStore();
    // 冷查重建链的最小等价形态（resurrectColdRecord 的 store 面契约边界）：
    // createRecord 归零基线 + sessionFile/round 水合（cold-lookup 职责）。
    const rec = piRecord("bg-1", child);
    rec.round = 3;
    store2.markResurrected(rec, true);

    // [U7] 统计基线水合：turns/tokens/round/epoch/放弃轮标记从折叠恢复，
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

  it("无事件流（无收条事件）→ light 统计保持缺省 0（不误派生视图）", () => {
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

// ── ①b 冷复活轮收条事实与 lastError 恢复（subagent-observability §3.3.6/§3.3.5）──
//
// 设计 §3.3.6「list 条目带 lastError（复活后旧失败轮仍可见）」的持久化半边：
// lastRound/lastError 经 hydrateReviveBaseline 从事件流折叠恢复——重启 → revive →
// recordToSubagent 直读可见，不停在新进程缺省 undefined。

describe("U7①b 冷复活轮收条事实与 lastError 恢复（§3.3.6/§3.3.5）", () => {
  /** 播种 created 帧身份域（createRecord fixture 同款缺省）。 */
  async function seedCreated(stream: ReturnType<typeof createRecordEventStream>, id: string): Promise<void> {
    await stream.append(id, {
      type: "record-created",
      ts: 1,
      id,
      agent: "worker",
      task: "t",
      slug: "s",
      origin: "tool",
      rootSessionId: "root-1",
      depth: 0,
      mode: "background",
      startedAt: 1,
    });
  }

  it("失败轮收条播种 → markResurrected 水合 lastRound/lastError → recordToSubagent 直读可见", async () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-facts");
    const stream = createRecordEventStream(() => manifestDir);
    await seedCreated(stream, "bg-facts");
    await stream.append("bg-facts", {
      type: "record-bound",
      ts: 1,
      sessionFile: child,
      engine: "pi",
      engineHandle: { sessionRef: { sessionFile: child }, poolKey: "shared" },
      epoch: 0,
    });
    await stream.append("bg-facts", { type: "record-round-started", ts: 2, round: 0, epoch: 0 });
    await stream.append("bg-facts", {
      type: "record-round-idle",
      ts: 900,
      round: 1,
      stopReason: "failed",
      engineStopReason: "error",
      failure: {
        class: "provider",
        kind: "rate_limited",
        retryable: "conditional",
        retryAfterMs: 1_320_000,
        raw: "429: tier_limit_exceeded",
      },
      turns: 7,
      totalTokens: 4200,
      error: "429: tier_limit_exceeded",
    });

    const store2 = newStore();
    const rec = piRecord("bg-facts", child); // createRecord 归零基线
    expect(rec.lastRound).toBeUndefined();
    expect(rec.lastError).toBeUndefined();
    store2.markResurrected(rec, true);

    // 轮收条事实 + lastError 恢复（fold 单源——水合后内存读侧权威源在场）。
    expect(rec.lastRound).toMatchObject({
      engineStopReason: "error",
      failure: { kind: "rate_limited", retryable: "conditional" },
    });
    expect(rec.lastError).toBe("429: tier_limit_exceeded");
    // 派生视图直读（list 消费链的输入形态——recordToSubagent 透传）。
    const view = recordToSubagent(rec);
    expect(view.lastRound).toMatchObject({ engineStopReason: "error" });
    expect(view.lastError).toBe("429: tier_limit_exceeded");
  });

  it("成功收条（旧帧无事实字段形态）→ lastError 不伪造、lastRound 只恢复帧上事实（收条轮数）、统计水合照常", async () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-ok-facts");
    const stream = createRecordEventStream(() => manifestDir);
    await seedCreated(stream, "bg-ok-facts");
    await stream.append("bg-ok-facts", { type: "record-round-started", ts: 2, round: 0, epoch: 0 });
    await stream.append("bg-ok-facts", {
      type: "record-round-idle",
      ts: 900,
      round: 1,
      stopReason: "completed",
      turns: 3,
      totalTokens: 120,
    });

    const store2 = newStore();
    const rec = piRecord("bg-ok-facts", child);
    store2.markResurrected(rec, true);

    // 旧帧无引擎事实字段（迁移期回落帧形态）→ lastRound 不伪造事实（无停因/失败
    // 分类等键），只恢复帧上承载的收条轮数（F1-46：turns 是收条帧事实，水合与写侧
    // roundFactsOf 同判据透传）；lastError 不伪造（无失败事实）；统计维度水合不受影响。
    expect(rec.lastRound).toEqual({ turns: 3 });
    expect(rec.lastError).toBeUndefined();
    expect(rec.turnCount).toBe(3);
    expect(rec.round).toBe(1);
  });
});

// ── ② 跨重启恢复 + 内存增量衔接无跳变 ────────────────────────────────

describe("U7② 跨重启恢复（内存终值 == settle 收条事件 == 重建值）", () => {
  it("内存增量累加 → settle 落收条 → 新 store 重建值逐字段一致（衔接无跳变）", () => {
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
    // 轮始写入 journal 记录（round-started 帧携带 round=1——[② 读侧换源] 后重建 round 的折叠源）。
    storeA.markRoundStarted("bg-1");
    expect(storeA.markSettled(rec, "gc")).toBe(true);
    const memTurns = rec.turnCount;
    const memTokens = rec.totalTokens;
    expect(memTurns).toBe(2);
    expect(memTokens).toBe(300);

    // settle 快照（binding 写侧——写侧不变）== 内存终值。
    const binding = readRecordBinding(child);
    expect(binding?.turns).toBe(memTurns);
    expect(binding?.totalTokens).toBe(memTokens);
    expect(binding?.round).toBe(1);

    // 重启：新 store 重建值 == 内存终值（active 以内存为准，idle/重启后以折叠收条
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

    // 主 session entry 族（v2 派生视图：注册 + 终态两条款——settle 条目承载统计/引擎锚；
    // v1 全量快照形态已随兼容层删除）。
    const mainSessionFile = path.join(dir, "main-session.jsonl");
    const settled: SubagentRecord = {
      id: "zc-1",
      agent: "general-purpose",
      task: "do zcode things",
      slug: "zcode-things",
      status: "idle",
      stopReason: "gc",
      mode: "background",
      startedAt: 1,
      rootSessionId: "root-1",
      parentRecordId: undefined,
      depth: 0,
      endedAt: 2,
      turns: 6,
      totalTokens: 800,
      model: "test/model",
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "s-1", dbPath }, poolKey: "shared" },
    };
    appendRecordEntryLine(mainSessionFile, v2RegisteredEntry(settled));
    appendRecordEntryLine(mainSessionFile, v2SettledEntry(settled));

    // 重启：新 store + initSession 恢复入口（recoverOrphanRecords 记忆 mainSessionFile）。
    const storeB = newStore();
    storeB.recoverOrphanRecords(undefined, mainSessionFile);
    const found = storeB.collectRecords(10, "all").find((r) => r.id === "zc-1");
    expect(found).toBeDefined();
    expect(found?.engine).toBe("zcode");
    expect(found?.turns).toBe(6);
    expect(found?.totalTokens).toBe(800);
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

  it("markSettledOut（zcode 锚）：release 分派（锚键 .alive 删除）", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const base = zcodeAnchorBasePath({ sessionId: "s-1", dbPath });
    const store = newStore();
    const rec = zcodeRecord("zc-1", dbPath, "s-1");
    rec.transcriptRef = { engine: "zcode", sessionId: "s-1", dbPath };
    store.register(rec);
    store.markResurrected(rec, false); // 接管形态 acquire（running 候选）
    expect(fs.existsSync(`${base}.alive`)).toBe(true);

    store.markSettledOut(rec);
    expect(fs.existsSync(`${base}.alive`)).toBe(false);
    expect(rec.status).toBe("running"); // 收尾写入 journal 记录不动占用位
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

describe("U7④ 归零覆盖回归：冷复活 entry 派生视图不再以归零值覆盖磁盘原值", () => {
  it("settle 落收条 → 冷复活 markResurrected → register 的 entry 派生视图携带水合值", () => {
    const child = path.join(sessionsDir, "child.jsonl");
    writeIdentityChild(child, "bg-1");

    // 宿主 A：turns=5 / tokens=1500 / round=2 的完整生命周期（事件流 + binding
    // 写侧快照双双落盘）。
    const storeA = newStore();
    const recA = piRecord("bg-1", child);
    recA.round = 2;
    storeA.register(recA);
    storeA.markRoundStarted("bg-1");
    for (let i = 0; i < 5; i += 1) {
      updateFromEvent(recA, { type: "turn_end" });
      updateFromEvent(recA, {
        type: "message_end",
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
      });
    }
    expect(storeA.markSettled(recA, "gc")).toBe(true);
    expect(recA.turnCount).toBe(5);
    expect(recA.totalTokens).toBe(1500);

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

    // 回归断言（[W1/D2 停写写点] + 事件流幂等）：冷复活对已注册 record（事件文件
    // 已有 created 帧）零 entry 写——「归零 entry last-writer-wins 覆盖磁盘原值」的
    // 威胁面结构性消失（原 GUI 快修批次⑤；register 的 registered 条目只在事件首写
    // 时落，见 RecordEventsWriteFace.syncCreation 幂等判定）。
    expect(entries).toHaveLength(0);

    // 水合保真的新承载面：内存 record 基线 = 事件流折叠水合值（[② 读侧换源]——
    // settle 收条事件承载统计，后续轮终 round-idle 事件/条目据此携带正确统计——
    // 覆盖原断言的回归意图）。
    expect(rec.turnCount).toBe(5);
    expect(rec.totalTokens).toBe(1500);
    expect(rec.round).toBe(2);

    // 磁盘 binding 写侧原值未被覆盖（merge 读侧不变——写侧快照仍在，读侧已换源）。
    expect(readRecordBinding(child)?.turns).toBe(5);
  });
});

// ══════ 来源: permanent-session-legacy-compat.test.ts ══════

// src/execution/__tests__/permanent-session-legacy-compat.test.ts
//
// [U8 / S8] 旧数据只读兼容（设计 §4 S8 行 + §3.2.4 双向兼容 + §3.2.8 session-reader
// 前向兼容铁律）：
//   - 旧格式磁盘组（旧 `.finalized`/`.cancelled` sidecar + v1 binding + 旧 manifest
//     值域 closed/completed/failed/cancelled，无 executionStatus/intent）经新代码读侧
//     投影：恒 idle + stopReason 桥接（finalized→reason / cancelled→interrupted），
//     不炸、不丢 identity；
//   - manifest 双写映射：markSettled 轮间 idle / markSettledOut 收口落账 → legacy
//     running（[u-arch / §3.4 方案 A] 收起概念删除，可续聊 record = 活跃成员）；
//   - 双写回读：manifest 源按 executionStatus（两态权威词）优先，settle 产物
//     （legacy running + executionStatus idle）读回 idle；
//   - [B-restart manifest 契约面] engine/engineHandle 域下行 + manifest 源回读
//     （zcode record 重启可见性兜底锚）。




/** [session-store-layout-inversion] 目录分区键 fixture（过 shared assertPiSessionId 合法性）。 */
const PARTITION_SID = "sid-legacy-compat";

// [teardown 竞态修复] 被测链传递性 logger 输出经 console 落 stderr——同步用例的刷写落在
// 文件结束的 teardown 窗口，与 worker rpc 关闭竞态 → vitest EnvironmentTeardownError
// （onUserConsoleLog pending）→ run 退出码 1。本文件对 logger 零断言依赖，mock 静默
// （rebuild-indexes.test.ts 同款先例）。
/** 最小合法子 session 文件（session header + identity custom entry，S8 旧数据形态）。 */
function writeLegacySessionJsonl(
  filePath: string,
  identity: { id: string; task: string; startedAt: number; rootSessionId?: string },
): void {
  const header = JSON.stringify({
    type: "session", version: 3, id: `sess-${identity.id}`, timestamp: new Date(identity.startedAt).toISOString(), cwd: "/tmp",
  });
  const identityData: Record<string, unknown> = {
    id: identity.id,
    agent: "worker",
    mode: "background",
    task: identity.task,
    slug: "legacy",
    startedAt: identity.startedAt,
  };
  if (identity.rootSessionId !== undefined) identityData.rootSessionId = identity.rootSessionId;
  const identityEntry = JSON.stringify({
    type: "custom",
    id: "id-1",
    parentId: null,
    timestamp: new Date(identity.startedAt).toISOString(),
    customType: "subagent-identity",
    data: identityData,
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n`, "utf-8");
}

/** 旧格式 v1 binding（UF-1 起即 v1，新写侧同版本——旧数据无新字段即「旧」形态）。 */
function writeLegacyBinding(sessionFile: string, id: string, startedAt: number): void {
  writeRecordBinding(sessionFile, {
    v: 1,
    recordId: id,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    agent: "worker",
    task: "legacy task",
    slug: "legacy",
    mode: "background",
    startedAt,
    model: "test/model",
    worktree: false,
  });
}

function makeExecutionRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord(id, {
    agent: "worker",
    model: "test/model",
    mode: "background",
    task: "compat task",
    slug: "compat",
    startedAt: 1000,
    rootSessionId: "root-session",
    controller: new AbortController(),
  });
  Object.assign(r, overrides);
  return r;
}

describe("[U8/S8] 旧格式磁盘组只读兼容——恒 idle + stopReason 桥接，不炸不丢", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-legacy-compat-"));
    sessionsDir = getSubagentSessionDir(PARTITION_SID, tmpDir);
    manifestDir = getSubagentRecordsDir(PARTITION_SID, tmpDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("旧 manifest（无 executionStatus）三值域 closed/completed/cancelled → manifest 源投影 idle + closedReason 保留", () => {
    // 磁盘组缺员（无子 session 文件）→ manifest 源兜底可见（mergedRecords 1.5）
    const writeOld = (id: string, status: string, closedReason?: string): void => {
      fs.writeFileSync(
        path.join(manifestDir, `${id}.json`),
        JSON.stringify({
          id,
          rootSessionId: "root-session",
          agentName: "worker",
          status,
          ...(closedReason !== undefined ? { closedReason } : {}),
          createdAt: 1000,
          completedAt: 2000,
          task: "old manifest task",
          slug: "oldman",
        }),
        "utf-8",
      );
    };
    writeOld("sa-om-closed", "closed", "user-close");
    writeOld("sa-om-completed", "completed");
    writeOld("sa-om-cancelled", "cancelled");

    const store = new RecordStore(() => sessionsDir, new ManifestStore(() => manifestDir));
    const all = store.collectRecords(20, "all");
    for (const id of ["sa-om-closed", "sa-om-completed", "sa-om-cancelled"]) {
      const rec = all.find((r) => r.id === id);
      expect(rec, id).toBeDefined();
      expect(rec?.status, id).toBe("idle"); // 旧终态三值统一 idle（mapManifestStatus）
      expect(rec?.agent, id).toBe("worker");
      expect(rec?.task, id).toBe("old manifest task");
    }
    expect(all.find((r) => r.id === "sa-om-closed")?.closedReason).toBe("user-close");
    store.dispose();
  });
});

describe("[U8] manifest 双写映射 + 双写回读 + engine 域下行", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-manifest-mapping-"));
    sessionsDir = getSubagentSessionDir(PARTITION_SID, tmpDir);
    manifestDir = getSubagentRecordsDir(PARTITION_SID, tmpDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const readManifest = (id: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(manifestDir, `${id}.json`), "utf-8")) as Record<string, unknown>;

  it("markSettled 轮间 idle（无 closedReason）→ legacy status=running + executionStatus=idle", () => {
    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
    const record = makeExecutionRecord("sa-settle");
    store.register(record);
    store.markSettled(record, "gc");

    const manifest = readManifest("sa-settle");
    expect(manifest.status).toBe("running"); // §3.2.8 活跃成员下行（可续聊 = 活跃）
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.closedReason).toBeUndefined();
    expect(manifest.intent).toBeUndefined(); // [u-arch] intent 停写（概念删除）
    store.dispose();
  });

  it("markSettledOut 收口落账 → legacy status=running + executionStatus=idle（[u-arch / §3.4 方案 A] 收起概念删除）", () => {
    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
    const record = makeExecutionRecord("sa-arch");
    store.register(record);
    store.markSettled(record, "gc");
    store.markSettledOut(record);

    const manifest = readManifest("sa-arch");
    // [u-arch / §3.4 方案 A] close 收口落账 record 投 running——可续聊 record =
    // 旧 reader 视角的活跃成员（原「收起位 → closed」下行分支随概念删除退役）。
    expect(manifest.status).toBe("running");
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.intent).toBeUndefined(); // intent 停写
    store.dispose();
  });

  it("[collect 退役] 存量批成员 manifest（桥接终态 cancelled 词汇）读侧容忍：投影 idle + closedReason 保留", () => {
    // 批写侧（markBatchFinalized → batchManifestRecord → legacyManifestStatusFields
    // 派生单点）已删。构造磁盘遗留形态（批时代产物词汇：legacy status=cancelled +
    // executionStatus=idle + closedReason/intent 缺省）——旧 session 文件必须可读。
    fs.writeFileSync(
      path.join(manifestDir, "sa-bridge.json"),
      JSON.stringify({
        id: "sa-bridge",
        rootSessionId: "root-session",
        agentName: "worker",
        status: "cancelled",
        executionStatus: "idle",
        closedReason: "cancelled",
        createdAt: 1000,
        completedAt: 2000,
        task: "bridge task",
        slug: "bridge",
      }),
      "utf-8",
    );

    const store = new RecordStore(() => sessionsDir, new ManifestStore(() => manifestDir));
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-bridge");
    expect(rec).toBeDefined();
    // 旧 cancelled 词汇读侧投影：idle（两态收敛）+ manifest closedReason 透传保留
    expect(rec?.status).toBe("idle");
    expect(rec?.closedReason).toBe("cancelled");
    store.dispose();
  });

  it("双写回读：settle 产物（legacy running + executionStatus idle）manifest 源读回 idle 非 running", () => {
    // 写侧：settle（legacy running 下行 + 权威词 idle）
    const writer = new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
    const record = makeExecutionRecord("sa-roundtrip");
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.dispose();
    expect(readManifest("sa-roundtrip").status).toBe("running");

    // 读侧：新进程（manifest 源兜底——磁盘组无子 session 文件）
    const reader = new RecordStore(() => sessionsDir, new ManifestStore(() => manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-roundtrip");
    expect(rec?.status).toBe("idle"); // executionStatus 优先（双写回读权威词）
    expect(rec?.closedReason).toBeUndefined();
    reader.dispose();
  });

  it("双写回读：markSettledOut 收口落账产物 manifest 源读回 idle（intent 停写停读）", () => {
    const writer = new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
    const record = makeExecutionRecord("sa-arch-rt");
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.markSettledOut(record);
    writer.dispose();

    const reader = new RecordStore(() => sessionsDir, new ManifestStore(() => manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-arch-rt");
    expect(rec?.status).toBe("idle");
    reader.dispose();
  });

  it("[B-restart] engine/engineHandle 域随 manifest 下行 + manifest 源回读（zcode 锚兜底）", () => {
    // zcode 锚基底目录真实存在（markSettled 的 binding 快照写点——U7 锚键 sidecar）
    fs.mkdirSync(path.join(tmpDir, "session-db"), { recursive: true });
    const engineHandle = {
      sessionRef: { sessionId: "z-sess-1", dbPath: path.join(tmpDir, "session-db", "db.sqlite") },
      poolKey: "shared",
    };
    const writer = new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
    const record = makeExecutionRecord("sa-zc", {
      engine: "zcode",
      engineHandle,
    });
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.dispose();

    // 写侧下行：manifest 携带 engine 域（旧 session-reader 未知字段跳过，无破坏）
    const manifest = readManifest("sa-zc");
    expect(manifest.engine).toBe("zcode");
    expect(manifest.engineHandle).toEqual(engineHandle);

    // 读侧回读：manifest 源投影恢复引擎身份与锚（重启可见性兜底）
    const reader = new RecordStore(() => sessionsDir, new ManifestStore(() => manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-zc");
    expect(rec?.engine).toBe("zcode");
    expect(rec?.engineHandle).toEqual(engineHandle);
    reader.dispose();
  });

  it("残留 intent 键被忽略（[u-arch] 停读证明）→ manifest 补建投 running、engine 域仍下行", () => {
    // 离线形态：主 session 末条 subagent-record entry 族（v2 注册 + 终态两条款）携带
    // 旧数据残留 intent 键（收起概念删除前 close 落盘形态），manifest 缺失 →
    // rebuildIndexes 惰性补建。v1 全量快照形态已随兼容层删除：残留键在 v2 读侧按
    // 契约字段集重建时自然忽略（与 chatMode 消亡同款先例），补建不再按 intent 派生
    // legacy closed——按 §3.4 方案 A 判定投 running。
    const mainSessionFile = path.join(tmpDir, "main-session.jsonl");
    const archived: SubagentRecord = {
      id: "sa-entry-arch",
      agent: "worker",
      task: "entry arch task",
      slug: "entryarch",
      status: "idle",
      stopReason: "gc",
      mode: "background",
      startedAt: 1000,
      rootSessionId: "root-session",
      parentRecordId: undefined,
      depth: 0,
      endedAt: 2000,
      turns: 1,
      totalTokens: 10,
      model: "test/model",
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      engine: "zcode",
    };
    // 残留旧键 intent 手写入注册条目载荷（v2 契约无此字段——读侧零携带证明）。
    const seeded = [
      { ...v2RegisteredEntry(archived), intent: "archived" },
      v2SettledEntry(archived),
    ];
    const lines = seeded.map((data) =>
      JSON.stringify({
        type: "custom",
        id: "seed-1",
        parentId: null,
        timestamp: new Date(1000).toISOString(),
        customType: "subagent-record",
        data,
      }),
    );
    fs.writeFileSync(mainSessionFile, `${lines.join("\n")}\n`, "utf-8");

    // 锚定 entry 源（recoverEntryOnlyOrphans 的 mainSessionFile 记忆点；非 interrupted
    // 终态条目在场 → 不触发纠偏 append），随后 collectRecords 经 mergedRecords 1.7
    //（zcode entry 源）→ 惰性 manifest 补建。
    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => manifestDir);
    store.recoverEntryOnlyOrphans(mainSessionFile, "root-session");
    const visible = store.collectRecords(10, "all").find((r) => r.id === "sa-entry-arch");
    expect(visible?.engine).toBe("zcode");

    const manifest = readManifest("sa-entry-arch");
    expect(manifest.status).toBe("running"); // 残留 intent 键不再派生 closed（§3.4 方案 A）
    expect(manifest.intent).toBeUndefined(); // 补建停写 intent
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.engine).toBe("zcode"); // entry 重建的 engine 域随补建下行
    store.dispose();
  });
});
