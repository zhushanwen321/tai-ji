// src/execution/__tests__/record-identity-fold.test.ts
//
// [身份换源第一步] 子文件无 identity entry 时，身份域从事件流折叠取得
// （record-store.scanFile：identity entry → **事件流折叠** → .record-binding 兜底）。
//
// 背景（event-sourcing 收敛）：`.state` 收条退场后，`.record-binding` 是最后一个
// 「身份域的旁路载体」。事件流已承载它的全部独有字段（身份域 + model/thinkingLevel/
// worktree 在 record-created；sessionFile/engine/engineHandle 在 record-bound），
// 因此读侧要先问折叠，绑定只兜存量/残事件文件形态。
//
// 本套件锁定的关键难点 = **折叠的 id 入口**：折叠要 record id，而子文件没有 identity
// entry 时 id 无从由身份来。结构性入口 = 事件目录本身（文件名主名即 id，文件内
// record-bound 帧携带 sessionFile）——本套件用「无 binding sidecar」的 fixture 证明
// 身份确实来自折叠腿而非绑定腿（fixture 里没有 .record-binding 文件，断言其不存在）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import {
  createRecordEventJournal,
  recordEventsPath,
  toRecordJournalHeader,
} from "../persistence/record-events.ts";
import { RECORD_BINDING_SIDECAR_EXT } from "../persistence/state-marker.ts";

const STARTED_AT = 1_700_000_000_000;
const RECORD_ID = "sa-fold-1";

/** engine-CLI 化子 session 文件 fixture：{session, message} 条目族，**无身份 entry**。 */
function writeIdentityLessChildSession(sessionsDir: string): string {
  const file = path.join(sessionsDir, "20260910T000000-000_sa-fold-1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-child",
      timestamp: new Date(STARTED_AT).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date(STARTED_AT + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first round done" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: STARTED_AT + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 事件流身份 fixture：record-created（全身份域 + model/thinkingLevel/worktree）。
 *  经生产 journal 写入（非手写帧——seq 分配与头行契约单源）。 */
async function seedCreatedFrame(recordsDir: string): Promise<void> {
  const journal = createRecordEventJournal(recordsDir);
  await journal.append(RECORD_ID, {
    type: "record-created",
    ts: STARTED_AT,
    id: RECORD_ID,
    agent: "general-purpose",
    task: "fold identity task",
    slug: "fold-slug",
    origin: "workflow",
    parentRunId: "wf-run-fold",
    stepIndex: 3,
    rootSessionId: "root-session",
    parentRecordId: "sa-parent",
    depth: 1,
    mode: "background",
    startedAt: STARTED_AT,
    model: "prov/model-fold",
    thinkingLevel: "high",
    worktree: true,
  });
}

/** 损坏身份 fixture：record-created 载荷 task 为 number（类型漂移）。
 *  手写帧——损坏形态无法经生产 journal（类型层已拒绝），只能直接落盘构造。 */
function seedCorruptCreatedFrame(recordsDir: string, sessionFile: string): void {
  const created = {
    type: "record-created",
    seq: 1,
    ts: STARTED_AT,
    id: RECORD_ID,
    agent: "general-purpose",
    task: 42,
    slug: "fold-slug",
    origin: "tool",
    rootSessionId: "root-session",
    depth: 0,
    mode: "background",
    startedAt: STARTED_AT,
  };
  const bound = {
    type: "record-bound",
    seq: 2,
    ts: STARTED_AT + 500,
    sessionFile,
    engine: "pi",
    engineHandle: { sessionRef: { recordId: RECORD_ID }, poolKey: "shared" },
    epoch: 1,
  };
  fs.writeFileSync(
    recordEventsPath(recordsDir, RECORD_ID),
    `${JSON.stringify(toRecordJournalHeader(RECORD_ID))}\n${JSON.stringify(created)}\n${JSON.stringify(bound)}\n`,
    "utf-8",
  );
}

/** record-bound 帧（折叠腿与子文件的唯一结构链接：sessionFile）。 */
async function seedBoundFrame(recordsDir: string, sessionFile: string): Promise<void> {
  const journal = createRecordEventJournal(recordsDir);
  await journal.append(RECORD_ID, {
    type: "record-bound",
    ts: STARTED_AT + 500,
    sessionFile,
    engine: "pi",
    engineHandle: { sessionRef: { recordId: RECORD_ID }, poolKey: "shared" },
    epoch: 1,
  });
}

/** 终局帧（收条换源面：终态收条 = 折叠结果，非 .state sidecar）。 */
async function seedSettledFrame(recordsDir: string): Promise<void> {
  const journal = createRecordEventJournal(recordsDir);
  await journal.append(RECORD_ID, {
    type: "record-settled",
    ts: STARTED_AT + 2000,
    stopReason: "completed",
    outcome: "completed",
    endedAt: STARTED_AT + 2000,
    turns: 1,
    totalTokens: 30,
  });
}

describe("[身份换源第一步] 无 identity entry 子文件的身份域 = 事件流折叠", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-identity-fold-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    recordsDir = getSubagentRecordsDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("created + bound + settled 事件在（无 .record-binding）→ collectRecords 重建，身份字段与收条全部来自折叠", async () => {
    const file = writeIdentityLessChildSession(sessionsDir);
    await seedCreatedFrame(recordsDir);
    await seedBoundFrame(recordsDir, file);
    await seedSettledFrame(recordsDir);
    // 负前提（本用例的全部意义）：「绑定腿不存在」——identity 只可能来自折叠。
    expect(fs.existsSync(`${file}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(false);

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    const records = store.collectRecords(10, "all", undefined, true);

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.id).toBe(RECORD_ID);
    // 身份域（record-created 载荷）
    expect(rec.agent).toBe("general-purpose");
    expect(rec.task).toBe("fold identity task");
    expect(rec.slug).toBe("fold-slug");
    expect(rec.startedAt).toBe(STARTED_AT);
    expect(rec.rootSessionId).toBe("root-session");
    expect(rec.parentRecordId).toBe("sa-parent");
    expect(rec.depth).toBe(1);
    expect(rec.origin).toBe("workflow");
    expect(rec.parentRunId).toBe("wf-run-fold");
    expect(rec.stepIndex).toBe(3);
    // 绑定侧独有字段（随「事件流承载」进 record-created）：model/thinkingLevel/worktree
    expect(rec.model).toBe("prov/model-fold");
    expect(rec.thinkingLevel).toBe("high");
    expect(rec.worktree).toBe(true);
    // 子文件锚（折叠腿必须把扫描到的文件路径带回 base）
    expect(rec.sessionFile).toBe(file);
    // 终态收条（折叠的 record-settled 帧，非 .state sidecar）
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("completed");
    // 统计域仍走 binding 快照投影（scanFile 的 binding round/turns/tokens/endedAt 补投影，
    // 本步只换身份域）——无 binding 时 light 的 endedAt 缺省 undefined，步 2 退场绑定
    // 时这条统计腿要一并换源（折叠 record-settled.endedAt）。
    expect(rec.endedAt).toBeUndefined();
  });

  it("对照组：无事件文件也无绑定 → 不重建（证明重建确由折叠腿承载，不是别的兜底）", () => {
    writeIdentityLessChildSession(sessionsDir);

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toEqual([]);
  });

  it("边界：有事件文件但缺 record-bound 帧（无 sessionFile 链接）→ 不重建（id 入口是结构性链接，不猜测）", async () => {
    writeIdentityLessChildSession(sessionsDir);
    await seedCreatedFrame(recordsDir);

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toEqual([]);
  });

  it("fold 身份腿不认损坏载荷：record-created 身份域类型漂移 → 不重建（零幻影，与 identityFromBinding 同向）", async () => {
    const file = writeIdentityLessChildSession(sessionsDir);
    seedCorruptCreatedFrame(recordsDir, file);

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toEqual([]);
  });

  it("折叠腿命中后 findLightById 可直查（id→file 索引随扫描建立）", async () => {
    const file = writeIdentityLessChildSession(sessionsDir);
    await seedCreatedFrame(recordsDir);
    await seedBoundFrame(recordsDir, file);

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toHaveLength(1);
    expect(store.findLightById(RECORD_ID)?.id).toBe(RECORD_ID);
  });
});
