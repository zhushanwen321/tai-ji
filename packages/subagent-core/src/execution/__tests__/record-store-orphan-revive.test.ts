// src/execution/__tests__/record-store-orphan-revive.test.ts
//
// [PS-10/T6④] revive() 复位 orphanJudged + [U4a / D3b (a″)] 孤儿恢复活实例跳过。
//
// [登记 §3.3 迁移] 播种与断言全部走 v2 条目族（v1 全量快照写点及其读面已随兼容层删除
// ——旧 closedReason 等 v1 专属观察面不复存在）。两个恢复入口各承一臂：
//   - entry-only 纠偏（recoverEntryOnlyOrphans，第一段）：主 session 有 v2 注册条目、
//     无子文件、无事件文件——orphanJudged 的次级防线语义（appendEntry 失败 → 判据
//     不自愈，重判资格完全由缓存承载；revive() 复位）只在此入口可达；
//   - journal 收编（recoverOrphanRecords → adoptV2Orphans，第二段）：事件文件在场
//     （created/bound 帧）→ 活实例跳过判据 = findForeignLiveInstance 现查探针
//     （pid 单判据 + self-pid 排除）——异宿主在持时不代写 v2 终态条目。
// 「内存持有（在途）不收编」由第三段（收编入口）的活体保护用例覆盖——两个入口共用
// records.has(id) 判据。
//
// 无 fs mock：v2 播种不写 subagent-identity 头（旧 v1 用例经 openSync 读 identity 才
// 需要劫持点）——读写全走真实 fs（tmpdir 自建自删）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { RecordStore } from "../persistence/record-store.ts";
// [W1 / U2a] 收编入口断言的观察面（u0 契约层 scan/路径原语）。
import { createRecordEventStream, recordEventsPath } from "../persistence/record-events.ts";
import type { RecordEvent } from "../persistence/record-events.ts";
import { createRecord } from "../persistence/execution-record.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { writeAliveMarker } from "../persistence/alive-store.ts";
// [登记 §3.3] v2 条目族（v1 全量快照写点已删——播种形态 = 注册/终态两条款）。
import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  SUBAGENT_RECORD_ENTRY_VERSION,
} from "../persistence/record-entry.ts";
import { v2RegisteredEntry } from "./helpers/v2-record-entry.ts";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-revive-"));
  loggerMock.debug.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 第一/第二段共用的目录布局：sessions 子目录（磁盘重建源）+ records 目录（事件/
 *  manifest 面）+ 主 session 文件（entry 源）。 */
function makeOrphanLayout(): { sessionsDir: string; recordsDir: string; mainFile: string } {
  const sessionsDir = path.join(tmpDir, "sessions");
  const recordsDir = path.join(tmpDir, "records");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  return { sessionsDir, recordsDir, mainFile: path.join(tmpDir, "main.jsonl") };
}

/** 播种用 SubagentRecord（v2 条目构造输入；缺省 rootSessionId = sess-orphan）。 */
function seedRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-base",
    agent: "worker",
    task: "orphan revive",
    slug: "s",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "sess-orphan",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: undefined,
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  };
}

/** 恢复侧 store（新实例 = 重启形态；recordsDir 接线 = 事件面在场）。注入 appendEntry
 *  先行调用：抛错即中止（append 未落盘 → appended 不记），透传即捕获落盘产物。 */
function makeStore(
  sessionsDir: string,
  recordsDir: string,
  appendEntryImpl?: (customType: string, data: unknown) => void,
): {
  store: RecordStore;
  appended: Array<{ customType: string; data: Record<string, unknown> }>;
} {
  const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const store = new RecordStore(sessionsDir, undefined, {
    appendEntry: (customType: string, data: unknown) => {
      appendEntryImpl?.(customType, data);
      appended.push({ customType, data: data as Record<string, unknown> });
    },
  } as never, recordsDir);
  return { store, appended };
}

describe("[PS-10] revive() 复位 orphanJudged（appendEntry 失败后重开可重判）", () => {
  /** entry-only 孤儿播种：主 session 只有 v2 注册条目——无子文件（不在 reconstructAll
   *  结果集）且无事件文件（journal 缺场），命中 recoverEntryOnlyOrphans。 */
  function seedEntryOnlyOrphan(id: string): {
    sessionsDir: string;
    recordsDir: string;
    mainFile: string;
  } {
    const { sessionsDir, recordsDir, mainFile } = makeOrphanLayout();
    v2AppendMainSessionLine(
      mainFile,
      SUBAGENT_RECORD_CUSTOM_TYPE,
      v2RegisteredEntry(seedRecord({ id })),
    );
    return { sessionsDir, recordsDir, mainFile };
  }

  /** [U3 场景迁移] orphanJudged 的次级防线语义用 appendEntry 注入失败构造：纠偏 entry
   *  未落盘 → 判据（注册条目无终态）不自愈，重判资格完全由缓存承载。 */
  it("appendEntry 失败（纠偏 entry 未落盘）→ orphanJudged 拦截重复判定；revive 后重判收敛 idle entry", () => {
    const { sessionsDir, recordsDir, mainFile } = seedEntryOnlyOrphan("sa-revive-1");

    let failAppend = true;
    const { store, appended } = makeStore(sessionsDir, recordsDir, () => {
      if (failAppend) throw new Error("append entry failed (disk full)");
    });

    // ── 阶段 1：纠偏 entry 落盘爆炸 → 异常传播（生产由 record-access try/catch 吸收），
    // orphanJudged 已标记；磁盘无事件文件（entry-only 纠偏不建 journal）──
    expect(() => store.recoverEntryOnlyOrphans(mainFile, "sess-orphan")).toThrow(/append entry failed/);
    expect(appended).toHaveLength(0);
    expect(fs.existsSync(recordEventsPath(recordsDir, "sa-revive-1"))).toBe(false);

    // ── 阶段 2（未 revive）：判据仍命中（终态条目未落盘）但 orphanJudged 拦截 →
    // 零异常零重复（次级防线语义；appendEntry 仍为爆炸实现，未拦截即再次抛出）──
    store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
    expect(appended).toHaveLength(0);

    // ── 阶段 3：append 恢复 + /new 复活（revive 复位 orphanJudged）→ 重判纠偏落盘 ──
    failAppend = false;
    store.revive();
    store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");

    expect(appended).toHaveLength(1); // 未 revive 时 orphanJudged 残留 → 零新 entry，此处红
    const corrected = appended[0];
    expect(corrected?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
    // v2 终态条目形态（v1 快照字段族无 v2 载体：closedReason 等不再断言）
    expect(corrected?.data.v).toBe(SUBAGENT_RECORD_ENTRY_VERSION);
    expect(corrected?.data.kind).toBe("settled");
    expect(corrected?.data.status).toBe("idle");
    expect(corrected?.data.stopReason).toBe("interrupted-by-restart");
    // 纠偏不建事件文件（entry-only 入口的磁盘面零副作用）
    expect(fs.existsSync(recordEventsPath(recordsDir, "sa-revive-1"))).toBe(false);
  });

  it("未 revive 时重判资格保持（防重缓存语义不回归）：appendEntry 恢复后重复 recover 仍零新 entry", () => {
    const { sessionsDir, recordsDir, mainFile } = seedEntryOnlyOrphan("sa-revive-2");

    let failAppend = true;
    const { store, appended } = makeStore(sessionsDir, recordsDir, () => {
      if (failAppend) throw new Error("append entry failed (disk full)");
    });

    expect(() => store.recoverEntryOnlyOrphans(mainFile, "sess-orphan")).toThrow(/append entry failed/);
    expect(appended).toHaveLength(0);

    // 同进程内不经历 revive（未重开）：append 已恢复也不重判——orphanJudged 防重语义保持
    failAppend = false;
    store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
    expect(appended).toHaveLength(0);
  });
});

// ── [U4a / D3b (a″)] 孤儿恢复活实例跳过：findForeignLiveInstance 现查探针 ──
//
// 判据 = .alive marker 的 pid 活性（pid 单判据 + self-pid 排除）。验收（F2）：
//   - 探针活（异宿主 pid 在持声明）→ 跳过收编——boot 不得代写异宿主持有中 record 的
//     v2 终态条目（同 root 双宿主形态下，宿主 A 的 boot 误判宿主 B 持有中的 record 会
//     击穿跨进程写权防御）；
//   - pid 死（无在持声明）/ self-pid 残留 → 正常收编（v2 终态条目 + record-settled 帧
//     落盘，无 .state sidecar——[U3] 直断防重锚写点已删）。
describe("[U4a / D3b (a″)] 孤儿恢复活实例跳过：现查探针（pid 单判据）", () => {
  /** 崩溃前形态种子（事件文件在场 = 归收编入口 recoverOrphanRecords）：真实写点落
   *  record-created / record-bound 帧（bound 携带 sessionFile 锚——活实例探针的探查
   *  对象），主 session 落同源 v2 注册条目。 */
  function seedJournalOrphan(id: string): {
    sessionsDir: string;
    recordsDir: string;
    mainFile: string;
    sessionFile: string;
  } {
    const { sessionsDir, recordsDir, mainFile } = makeOrphanLayout();
    const captured: Array<{ customType: string; data: unknown }> = [];
    const seedStore = new RecordStore(
      sessionsDir,
      undefined,
      {
        appendEntry: (customType: string, data: unknown) => {
          captured.push({ customType, data });
        },
      } as never,
      recordsDir,
    );
    const rec = v2MakeRecord({ id, rootSessionId: "sess-orphan" });
    seedStore.register(rec); // record-created 帧 + v2 注册条目（身份 + 锚点）
    const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    seedStore.reportRecordTransition(rec); // record-bound 帧（sessionFile 锚入账）
    // 主 session 只落注册条目（崩溃前无终态条目）。
    v2AppendMainSessionLine(mainFile, SUBAGENT_RECORD_CUSTOM_TYPE, captured[0]?.data);
    return { sessionsDir, recordsDir, mainFile, sessionFile };
  }

  it("探针活（异宿主 pid 在持声明）→ 跳过收编：零 settled entry、journal 零追加、manifest 未物化", () => {
    const { sessionsDir, recordsDir, mainFile, sessionFile } = seedJournalOrphan("sa-probe-1");
    // pid 1（launchd）必然存活且非本测试进程——异宿主「在持声明」的确定性形态
    writeAliveMarker(sessionFile, { pid: 1, id: "sa-probe-1", startedAt: Date.now() });

    const { store, appended } = makeStore(sessionsDir, recordsDir);
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(0); // 跳过：不落任何收编 entry
    // journal 零追加 + 收编 manifest 未物化（跳过是构造性的，不止条目面）
    expect(
      v2ReadEventLines(recordsDir, "sa-probe-1").some((e) => e.type === "record-settled"),
    ).toBe(false);
    expect(store.findAdoptedStopReasonSync("sa-probe-1")).toBeUndefined();
  });

  it("pid 死（marker 残留但持有者已退）→ 正常收编：v2 idle 终态条目 + record-settled 帧（无 .state 防重锚）", () => {
    const { sessionsDir, recordsDir, mainFile, sessionFile } = seedJournalOrphan("sa-probe-2");
    // 大 pid 用户空间必然不存在（ESRCH 判死）——原持有宿主已退出的残留 marker 形态
    writeAliveMarker(sessionFile, { pid: 9999999, id: "sa-probe-2", startedAt: Date.now() });

    const { store, appended } = makeStore(sessionsDir, recordsDir);
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
    // v2 终态条目形态（v1 快照字段族无 v2 载体：closedReason 等不再断言）
    expect(appended[0]?.data.v).toBe(SUBAGENT_RECORD_ENTRY_VERSION);
    expect(appended[0]?.data.kind).toBe("settled");
    expect(appended[0]?.data.status).toBe("idle");
    expect(appended[0]?.data.stopReason).toBe("interrupted-by-restart");
    // journal 唯一事实源：收编帧落账（幂等语义归第三段收编入口用例）
    expect(
      v2ReadEventLines(recordsDir, "sa-probe-2").filter((e) => e.type === "record-settled"),
    ).toHaveLength(1);
    // 收编 manifest 物化（sweep 判据第三级读取源）+ 无 legacy .state 防重锚
    expect(store.findAdoptedStopReasonSync("sa-probe-2")).toBe("interrupted-by-restart");
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
  });

  it("self-pid marker（pid 复用到本进程的残留声明）→ 放行收编：原持有者已死，record 确为孤儿", () => {
    const { sessionsDir, recordsDir, mainFile, sessionFile } = seedJournalOrphan("sa-probe-3");
    // self-pid 排除：findForeignLiveInstance 视同无 foreign——复用窗口内残留 marker
    // 不构成「异宿主在持」，record 是真孤儿应照常收编
    writeAliveMarker(sessionFile, { pid: process.pid, id: "sa-probe-3", startedAt: Date.now() });

    const { store, appended } = makeStore(sessionsDir, recordsDir);
    store.recoverOrphanRecords("sess-orphan", mainFile);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.data.kind).toBe("settled");
    expect(appended[0]?.data.status).toBe("idle");
    expect(appended[0]?.data.stopReason).toBe("interrupted-by-restart");
  });
});

// ── [W1 / U2a] 收编入口段专属 helper（v2* 前缀防重名）──────────────

function v2MakeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("bg-v2", {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "v2-journal",
    startedAt: 1000,
    rootSessionId: "sess-v2",
  });
  return { ...base, ...over };
}

function v2CapturePi(captured: unknown[]): { appendEntry: (customType: string, data: unknown) => void } {
  return {
    appendEntry: (customType: string, data: unknown) => {
      captured.push({ customType, data });
    },
  };
}

function v2ReadEventLines(recordsDir: string, id: string): RecordEvent[] {
  const content = fs.readFileSync(recordEventsPath(recordsDir, id), "utf8");
  const out: RecordEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as RecordEvent);
  }
  return out;
}

/** 主 session JSONL 行写入（appendEntry 落盘产物形态——与 pi 落盘同构）。 */
function v2AppendMainSessionLine(mainFile: string, customType: string, data: unknown): void {
  fs.appendFileSync(
    mainFile,
    `${JSON.stringify({
      type: "custom",
      id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType,
      data,
    })}\n`,
    "utf8",
  );
}

describe("收编入口（W1 D4：journal 重放 + 收编幂等）", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;
  let mainFile: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-v2-adopt-"));
    sessionsDir = path.join(rootDir, "sessions");
    recordsDir = path.join(rootDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
    mainFile = path.join(rootDir, "main.jsonl");
  });
  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 崩溃前形态种子：v2 注册条目 + created/bound 帧、无终态（kill -9 等价）。 */
  function seedCrashedRecord(id: string): ExecutionRecord {
    const captured: unknown[] = [];
    const store = new RecordStore(sessionsDir, undefined, v2CapturePi(captured), recordsDir);
    const rec = v2MakeRecord({ id });
    store.register(rec);
    const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);
    // 主 session 只落注册条目（崩溃前无终态条目）。
    const registered = (captured[0] as { data: unknown }).data;
    v2AppendMainSessionLine(mainFile, "subagent-record", registered);
    return rec;
  }

  /** 收编链（等价 kill -9 重启）：新 store + 主文件 → recoverOrphanRecords。 */
  function rebootStore(captured: unknown[]): RecordStore {
    const store = new RecordStore(sessionsDir, undefined, v2CapturePi(captured), recordsDir);
    store.recoverOrphanRecords(undefined, mainFile);
    return store;
  }

  /** 手工 v2 settled 条目行（D4 双面证据条目面的夹具构造——stopReason 可指定）。 */
  function appendManualSettledEntry(id: string, stopReason: string): void {
    v2AppendMainSessionLine(mainFile, "subagent-record", {
      v: 2,
      kind: "settled",
      id,
      status: "idle",
      stopReason,
      endedAt: Date.now(),
      turns: 0,
      totalTokens: 0,
      model: undefined,
      thinkingLevel: undefined,
    });
  }

  // [W1 / D4 双面证据第二面判别] interrupted 族条目 = 「条目面先行写、journal 帧
  // 缺失」不对称窗口残留（appendEvent fire-and-forget 失败），不构成跳过证据：
  // 收编放行 → 追加 settled 帧修复 journal（journal 唯一事实源承诺的自愈通道），
  // 二次重启由 fold settled 拦截不重复。
  it("夹具A journal 缺 settled 帧 + interrupted 终态条目 → 收编追加帧修复 journal，二次触发不重复", () => {
    seedCrashedRecord("sa-adopt-orphix");
    // 崩溃前条目面先行写了一条 interrupted settled（journal 帧因写失败缺失的形态）
    appendManualSettledEntry("sa-adopt-orphix", "interrupted");

    const captured: unknown[] = [];
    rebootStore(captured);
    const events = v2ReadEventLines(recordsDir, "sa-adopt-orphix");
    // journal 帧修复：record-settled 已追加
    expect(events.filter((e) => e.type === "record-settled")).toHaveLength(1);
    // 条目补写跟随收编链（adopted settled，幂等语义见双面证据注释）
    expect(captured.filter((c) => (c as { data: { kind?: string } }).data?.kind === "settled")).toHaveLength(1);

    // 二次重启：fold 已 settled → 不再追加（幂等）
    const captured2: unknown[] = [];
    rebootStore(captured2);
    expect(
      v2ReadEventLines(recordsDir, "sa-adopt-orphix").filter((e) => e.type === "record-settled"),
    ).toHaveLength(1);
  });

  it("夹具B journal 缺 settled 帧 + 非 interrupted 条目（completed）→ 保持跳过（双面证据成立）", () => {
    seedCrashedRecord("sa-adopt-final");
    appendManualSettledEntry("sa-adopt-final", "completed");

    const captured: unknown[] = [];
    rebootStore(captured);
    // 非 interrupted 真终态条目在 → 跳过收编，journal 零追加、条目零回调
    expect(
      v2ReadEventLines(recordsDir, "sa-adopt-final").filter((e) => e.type === "record-settled"),
    ).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it("验收③收编幂等（双重启不重复追加）：record-settled 帧恰一条、终态条目恰一条", async () => {
    seedCrashedRecord("sa-adopt-1");

    const capturedA: unknown[] = [];
    const storeA = rebootStore(capturedA);
    const eventsA = v2ReadEventLines(recordsDir, "sa-adopt-1");
    expect(eventsA.filter((e) => e.type === "record-settled")).toHaveLength(1);
    const settled = eventsA.find((e) => e.type === "record-settled");
    expect(settled).toMatchObject({ type: "record-settled", stopReason: "interrupted-by-restart" });
    expect(capturedA.filter((c) => (c as { data: { kind?: string } }).data?.kind === "settled")).toHaveLength(1);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(recordsDir, "sa-adopt-1.json"), "utf8") as string,
    ) as { id: string; agentName: string; executionStatus: string; stopReason?: string };
    expect(manifest).toMatchObject({ id: "sa-adopt-1", agentName: "worker", executionStatus: "idle" });
    // [W4 收敛] 收编停因上投影——sweep 判据第三级（findAdoptedStopReasonSync）的读取源。
    expect(manifest.stopReason).toBe("interrupted-by-restart");
    // 判据第三级本体：收编 manifest → 停因；非收编形态（文件缺失）→ undefined。
    expect(storeA.findAdoptedStopReasonSync("sa-adopt-1")).toBe("interrupted-by-restart");
    expect(storeA.findAdoptedStopReasonSync("sa-never-existed")).toBeUndefined();

    // 第二次重启：fold settled + 终态条目在（双面证据）→ 零追加。
    const capturedB: unknown[] = [];
    rebootStore(capturedB);
    const eventsB = v2ReadEventLines(recordsDir, "sa-adopt-1");
    expect(eventsB.filter((e) => e.type === "record-settled")).toHaveLength(1);
    expect(capturedB).toHaveLength(0);
  });

  it("夹具C 收编→复活续轮（round-started 清 fold settled）→轮完成前再崩溃→二次收编追加新帧（D4 非 interrupted 谓词复合回归）", () => {
    const id = "sa-adopt-relock";
    const rec = seedCrashedRecord(id);

    // 第一次收编（等价 kill -9 重启）：interrupted 收编帧 + 终态条目 + manifest。
    const first: unknown[] = [];
    rebootStore(first);
    expect(v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-settled")).toHaveLength(1);

    // 用户复活续跑：markResurrected 翻回活态 + markRoundStarted 落轮始帧——fold
    // settled 被 round-started 清除（record-events.ts fold 转移），旧 interrupted
    // 终态条目在（stopReason=interrupted-by-restart，中断族不构成跳过证据）。
    const liveStore = new RecordStore(sessionsDir, undefined, v2CapturePi([]), recordsDir);
    liveStore.markResurrected(rec, true);
    expect(liveStore.markRoundStarted(id)).toBe(true);
    expect(
      v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-round-started"),
    ).toHaveLength(1);

    // 轮完成前再崩溃 → 重启二次收编：旧 any-settled 判定会被首次收编的 interrupted
    // 条目误拦（实体永停 running 假活态）；非 interrupted 谓词放行 → 追加新
    // record-settled + settled 条目补写 + manifest 物化。
    const second: unknown[] = [];
    rebootStore(second);
    expect(v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-settled")).toHaveLength(2);
    expect(second.filter((c) => (c as { data: { kind?: string } }).data?.kind === "settled")).toHaveLength(1);
    expect(fs.existsSync(path.join(recordsDir, `${id}.json`))).toBe(true);

    // 三次重启：fold 已 settled（第二次收编帧）→ 幂等零追加。
    const third: unknown[] = [];
    rebootStore(third);
    expect(v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-settled")).toHaveLength(2);
    expect(third).toHaveLength(0);
  });

  it("验收⑤v2 新路径：重启后 manifest 经收编物化恢复可见（rematerialize 桥接为 v1 兼容专属零依赖）", async () => {
    seedCrashedRecord("sa-adopt-2");

    // 重启前 manifest 面 = bound 物化的 running 投影（子文件在盘）。
    const beforeManifest = JSON.parse(
      fs.readFileSync(path.join(recordsDir, "sa-adopt-2.json"), "utf8") as string,
    ) as { status: string };
    expect(beforeManifest.status).toBe("running");

    const captured: unknown[] = [];
    rebootStore(captured);

    // 重启后（收编物化）：executionStatus = idle（两态权威词）——manifest 可见性
    // 恢复通道 = 收编物化本身，与 record-access.ts rematerialize 桥接（v1 兼容
    // 专属——只认 v1 快照末条 closedReason）零依赖。
    const afterManifest = JSON.parse(
      fs.readFileSync(path.join(recordsDir, "sa-adopt-2.json"), "utf8") as string,
    ) as { executionStatus: string; closedReason?: string };
    expect(afterManifest.executionStatus).toBe("idle");
    expect(afterManifest.closedReason).toBeUndefined();
  });

  it("活体保护：内存持有（在途）与异宿主在持（pi 锚探活）均不收编", async () => {
    const capturedSeed: unknown[] = [];
    const holdingStore = new RecordStore(sessionsDir, undefined, v2CapturePi(capturedSeed), recordsDir);
    const rec = v2MakeRecord({ id: "sa-adopt-live" });
    holdingStore.register(rec);
    const sessionFile = path.join(sessionsDir, "sa-adopt-live.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    holdingStore.reportRecordTransition(rec);
    const registered = (capturedSeed[0] as { data: unknown }).data;
    v2AppendMainSessionLine(mainFile, "subagent-record", registered);

    // 同 store 持有（内存在册）：recoverOrphanRecords 的 v2 段跳过。
    holdingStore.recoverOrphanRecords(undefined, mainFile);
    const events = v2ReadEventLines(recordsDir, "sa-adopt-live");
    expect(events.some((e) => e.type === "record-settled")).toBe(false);

    // 新 store 无内存持有：正常收编（对照组——证明上一步跳过是活体保护所致）。
    const capturedCtrl: unknown[] = [];
    const ctrlStore = new RecordStore(sessionsDir, undefined, v2CapturePi(capturedCtrl), recordsDir);
    ctrlStore.recoverOrphanRecords(undefined, mainFile);
    expect(v2ReadEventLines(recordsDir, "sa-adopt-live").some((e) => e.type === "record-settled")).toBe(true);
  });

  it("空 journal / journal 未接线 / 坏链：skippedMissing / skippedNoIdentity 分类", async () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    // 空 journal（从未落账）。
    expect(store.adoptInterruptedRecord("sa-never-existed")).toBe("skippedMissing");

    // 坏链：事件文件只有 bound 帧（created 帧损坏/缺失的残文件形态）。
    fs.writeFileSync(
      recordEventsPath(recordsDir, "sa-broken-chain"),
      `${JSON.stringify({ type: "record-journal", id: "sa-broken-chain" })}\n`,
      "utf8",
    );
    const journal = createRecordEventStream(recordsDir);
    await journal.append("sa-broken-chain", {
      type: "record-bound",
      ts: Date.now(),
      sessionFile: "/tmp/x.jsonl",
      engine: "pi",
      engineHandle: { sessionRef: {}, poolKey: "shared" },
      epoch: 0,
    });
    expect(store.adoptInterruptedRecord("sa-broken-chain")).toBe("skippedNoIdentity");

    // journal 未接线（纯内存形态）：恒 skippedMissing。
    const memStore = new RecordStore(sessionsDir);
    expect(memStore.adoptInterruptedRecord("sa-any")).toBe("skippedMissing");
  });
});
