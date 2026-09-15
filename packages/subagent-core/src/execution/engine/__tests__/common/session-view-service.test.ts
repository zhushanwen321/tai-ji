// session-view-service.test.ts —— D1 journal 读取链收敛的守护测试。
//
// 三视角：①构建者——三级降级编排（①native ②journal ③outcome-only）逐级降级、
// registry 分发查表；②使用者——投影 parity（zcode 现役 journal 形态的新旧链
// 等价：coarse 成功两事件 → ③级、失败 error 事件 → 物化 assistant）；
// ③观察者——message_end 带 error 的记账语义（门②补录样本：现役 zcode 不产出，
// 作为守护实现的回归校验数据源）。
//
// parity 基准 = 被收敛前的 runtime 手写链（subagent-engine-history.ts，已删）：
// 同一 journal 输入，HistoryMessage[] 除随机 id 外逐字段等价。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JournalWriter } from "../../common/event-journal.ts";
import {
  extractEngineId,
  readSubagentHistoryMessages,
  registerNativeSessionReader,
  resetNativeSessionReaders,
} from "../../common/session-view-service.ts";
import { parseEngineHandle } from "../../common/session-view-types.ts";
import type { SubagentRecordSnapshot } from "../../common/session-view-types.ts";
import type { AgentEvent } from "../../../assembly/types.ts";
import type { SessionView } from "../../types.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "session-view-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  // reader registry 是进程级状态——重置回内置集，防 fake 注入跨用例泄漏
  resetNativeSessionReaders();
});

/** 最小 record 快照（默认 zcode + 池内相对 dbPath + 可选 journalPath）。 */
function makeRecord(overrides: Partial<SubagentRecordSnapshot> = {}): SubagentRecordSnapshot {
  return {
    subagentId: "sub-1",
    task: "do the thing",
    startedAt: 1_000,
    engine: "zcode",
    engineHandle: {
      sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
      poolKey: "shared",
    },
    ...overrides,
  };
}

/** journal 真实落盘（写侧 SSOT JournalWriter——读取链全真）。 */
async function writeJournal(path: string, events: AgentEvent[]): Promise<void> {
  const writer = new JournalWriter({ path, taskId: "sub-1", engineId: "zcode" });
  for (const ev of events) writer.append(ev);
  await writer.close();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// 单一 handle guard（双守卫收敛点）
// ============================================================

describe("parseEngineHandle（唯一 guard）", () => {
  it("合法形状：sessionRef 透传 + journalPath 可选", () => {
    expect(
      parseEngineHandle({
        sessionRef: { sessionId: "s", dbPath: "db.sqlite" },
        poolKey: "shared",
        journalPath: "/tmp/j.jsonl",
      }),
    ).toEqual({
      sessionRef: { sessionId: "s", dbPath: "db.sqlite" },
      poolKey: "shared",
      journalPath: "/tmp/j.jsonl",
    });
    expect(
      parseEngineHandle({ sessionRef: { sessionId: "s" }, poolKey: "shared" }),
    ).toEqual({ sessionRef: { sessionId: "s" }, poolKey: "shared" });
  });

  it("坏形状整体拒绝：非对象 / poolKey 缺失或空 / sessionRef 非法", () => {
    expect(parseEngineHandle(undefined)).toBeUndefined();
    expect(parseEngineHandle("x")).toBeUndefined();
    expect(parseEngineHandle({ sessionRef: {}, poolKey: "" })).toBeUndefined();
    expect(parseEngineHandle({ sessionRef: {}, poolKey: 1 })).toBeUndefined();
    expect(parseEngineHandle({ poolKey: "shared" })).toBeUndefined();
    expect(parseEngineHandle({ sessionRef: [], poolKey: "shared" })).toBeUndefined();
  });

  it("sessionRef 含非 string 值 → 整体拒绝（收敛选 extractor 严格版）", () => {
    expect(
      parseEngineHandle({ sessionRef: { sessionId: "s", n: 1 }, poolKey: "shared" }),
    ).toBeUndefined();
  });

  it("journalPath 空串视为缺省", () => {
    expect(
      parseEngineHandle({ sessionRef: {}, poolKey: "shared", journalPath: "" }),
    ).toEqual({ sessionRef: {}, poolKey: "shared" });
  });
});

describe("extractEngineId", () => {
  it("非 string / 空串 → 缺省 pi（存量 record 零迁移）；非空透传", () => {
    expect(extractEngineId(makeRecord({ engine: undefined }))).toBe("pi");
    expect(extractEngineId(makeRecord({ engine: 1 }))).toBe("pi");
    expect(extractEngineId(makeRecord({ engine: "" }))).toBe("pi");
    expect(extractEngineId(makeRecord({ engine: "zcode" }))).toBe("zcode");
  });

  it("缺省引擎 id 与 registry 的 DEFAULT_ENGINE_ID 同值（本地锚定防漂移守护）", async () => {
    const { DEFAULT_ENGINE_ID } = await import("../../registry.ts");
    expect(extractEngineId(makeRecord({ engine: undefined }))).toBe(DEFAULT_ENGINE_ID);
  });
});

// ============================================================
// 三级降级编排
// ============================================================

describe("降级链编排", () => {
  it("pi 引擎返回 []（A1 守护：pi 历史走调用方 JSONL 直读链）", async () => {
    expect(await readSubagentHistoryMessages(makeRecord({ engine: undefined }), dataDir)).toEqual(
      [],
    );
    expect(await readSubagentHistoryMessages(makeRecord({ engine: "pi" }), dataDir)).toEqual([]);
  });

  it("①级命中：registry 查表分发到 native reader，SessionView 投影（usage 挂末 turn）", async () => {
    const view: SessionView = {
      engineId: "zcode",
      sessionId: "sess-1",
      turns: [
        { text: "answer", thinking: "hmm", toolCalls: [], closed: true },
        { text: "more", thinking: "", toolCalls: [], closed: true },
      ],
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, total: 10 },
      source: "native",
    };
    registerNativeSessionReader("zcode", async () => view);
    const messages = await readSubagentHistoryMessages(makeRecord(), dataDir);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "do the thing", timestamp: 1_000 });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "answer",
      thinking: [{ content: "hmm", collapsed: true }],
      timestamp: 1_001,
    });
    // SessionView.usage 是聚合（无 per-turn 拆分）——挂最后一个 turn 供 GUI 展示
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "more",
      usage: { inputTokens: 7, outputTokens: 3 },
      timestamp: 1_002,
    });
  });

  it("[W11/H1] ①级 reader 不可达（协议 read 失败降级形态）→ ②级 journal 命中", async () => {
    // W11 后①级 reader 全经注入（生产 = runtime 协议 read，失败在其内部 catch 后
    // 返回 undefined）：注入一个恒 undefined 的 reader 复现「协议失败降②级」语义
    // （原「真 zcode reader 对不存在 db 内部 catch 降级」分支随 H1 内建 reader
    // 删除，sqlite 侧行为由 zcode 包 e2e 接替；NativeSessionReader 契约 = 不抛，
    // 失败以 undefined 表达）。
    registerNativeSessionReader("zcode", async () => undefined);
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, [
      { type: "text_delta", delta: "part one. " },
      { type: "text_delta", delta: "part two." },
      { type: "message_end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ]);
    const record = makeRecord({
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "part one. part two.",
      usage: { inputTokens: 10, outputTokens: 5 },
      status: "complete",
      timestamp: 1_001,
    });
  });

  it("②级也不可达（无 journalPath）→ ③级 outcome-only，永不返回空数组", async () => {
    // ①级无注册 reader（W11 后注册表初始为空）→ 直落②级；handle 无 journalPath → ③级
    const messages = await readSubagentHistoryMessages(
      makeRecord({ result: "final answer", endedAt: 2_000 }),
      dataDir,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "do the thing" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "final answer",
      status: "complete",
      timestamp: 2_000,
    });
  });

  it("③级 error 终态：result 缺 error 在 → status=error + error 字段；双缺占位", async () => {
    const failed = await readSubagentHistoryMessages(
      makeRecord({ error: "engine_run_failed: boom", endedAt: 2_000 }),
      dataDir,
    );
    expect(failed[1]).toMatchObject({
      content: "engine_run_failed: boom",
      status: "error",
      error: "engine_run_failed: boom",
      timestamp: 2_000,
    });
    const noOutcome = await readSubagentHistoryMessages(makeRecord(), dataDir);
    expect(noOutcome[1]).toMatchObject({ content: "(no outcome recorded)", status: "complete" });
  });

  it("handle 缺失 → ③级（空值防御，不依赖写侧完成时序）", async () => {
    const messages = await readSubagentHistoryMessages(
      makeRecord({ engineHandle: undefined, result: "r" }),
      dataDir,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ content: "r" });
  });

  // ============================================================
  // ①级判空降级矩阵（设计 D3：turns 无实质内容 = 本级不可用，与②级同语义）
  // ============================================================

  it("①级 defined 空 turns（{turns:[], source:'native'}）→ 降②级，journal 内容命中（不返回 [task] 空壳）", async () => {
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, [
      { type: "text_delta", delta: "journal answer" },
      { type: "turn_end" },
    ]);
    registerNativeSessionReader("zcode", async () => ({
      engineId: "zcode",
      sessionId: "sess-1",
      turns: [],
      source: "native",
    }));
    const record = makeRecord({
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "do the thing" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "journal answer" });
  });

  it("①级非空数组但全空 turn（截断/被杀残留形态）→ 同样降级：无 journalPath 落③级 outcome-only", async () => {
    registerNativeSessionReader("zcode", async () => ({
      engineId: "zcode",
      sessionId: "sess-1",
      // closeTurn 对 step-finish 无条件 push + applyPartToTurn 空 acc 创建——形态代码级可达
      turns: [{ text: "", thinking: "", toolCalls: [], closed: true }],
      source: "native",
    }));
    const messages = await readSubagentHistoryMessages(
      makeRecord({ result: "outcome text" }),
      dataDir,
    );
    // 不是「仅 task」空壳：①级空 turn 被判不可用 → ③级占位投影
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "outcome text" });
  });

  it("①级混合 turn（含空 turn 但任一有实质内容）→ 不降级，真实内容原样投影", async () => {
    registerNativeSessionReader("zcode", async () => ({
      engineId: "zcode",
      sessionId: "sess-1",
      turns: [
        { text: "", thinking: "", toolCalls: [], closed: true },
        { text: "real answer", thinking: "", toolCalls: [], closed: true },
      ],
      source: "native",
    }));
    const messages = await readSubagentHistoryMessages(makeRecord(), dataDir);
    // task + 两个 turn（空 turn 也随①级放行原样投影）
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ role: "assistant", content: "real answer" });
  });

  it("①空（defined 空 turns）②亦不可达（无 journalPath）→ 落③级 outcome-only 占位", async () => {
    registerNativeSessionReader("zcode", async () => ({
      engineId: "zcode",
      sessionId: "sess-1",
      turns: [],
      source: "native",
    }));
    const messages = await readSubagentHistoryMessages(
      makeRecord({ result: undefined, error: undefined }),
      dataDir,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "(no outcome recorded)",
      status: "complete",
    });
  });
});

// ============================================================
// registry 分发（取代引擎 id 硬编码）
// ============================================================

describe("reader registry 分发", () => {
  it("未注册引擎（未来）→ ③级保底（详情页至少有摘要卡）", async () => {
    const messages = await readSubagentHistoryMessages(
      makeRecord({ engine: "kimi", result: "r" }),
      dataDir,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ content: "r" });
  });

  it("新引擎注册 reader 后自动获得①级（接入第三引擎 runtime 零改动）", async () => {
    registerNativeSessionReader("kimi", async () => ({
      engineId: "kimi",
      turns: [{ text: "kimi says", thinking: "", toolCalls: [], closed: true }],
      source: "native",
    }));
    const messages = await readSubagentHistoryMessages(
      makeRecord({ engine: "kimi" }),
      dataDir,
    );
    expect(messages[1]).toMatchObject({ role: "assistant", content: "kimi says" });
  });

  it("同 id 覆盖注册（幂等，测试注入 fake 的机制面）", async () => {
    const view: SessionView = {
      engineId: "zcode",
      turns: [{ text: "overridden", thinking: "", toolCalls: [], closed: true }],
      source: "native",
    };
    registerNativeSessionReader("zcode", async () => view);
    const messages = await readSubagentHistoryMessages(makeRecord(), dataDir);
    expect(messages[1]).toMatchObject({ content: "overridden" });
  });
});

// ============================================================
// 投影 parity（zcode 现役 journal 形态，新旧链等价）
// ============================================================

describe("②级重放投影 parity（基准 = 收敛前 runtime 手写链）", () => {
  /** 走完整②级链（真 zcode reader ①级 miss → journal 重放）。 */
  async function replayViaJournal(
    events: AgentEvent[],
    recordOverrides: Partial<SubagentRecordSnapshot> = {},
  ): Promise<Awaited<ReturnType<typeof readSubagentHistoryMessages>>> {
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, events);
    const record = makeRecord({
      ...recordOverrides,
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    return readSubagentHistoryMessages(record, dataDir);
  }

  it("成功 journal（coarse 两事件：message_end+turn_end）→ 无 assistant 内容，降③级 outcome-only", async () => {
    // 旧链推演：applyMessageEnd 无未闭合 turn → usage 丢弃；sawAssistantContent=false → ③级
    const messages = await replayViaJournal(
      [
        { type: "message_end", usage: { input: 12_599, output: 17, cacheRead: 512, cacheWrite: 0 } },
        { type: "turn_end" },
      ],
      { result: "final answer" },
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "do the thing", timestamp: 1_000 });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      // ③级：result 优先（record 字段），journal 的 coarse usage 不进消息
      content: "final answer",
      status: "complete",
    });
  });

  it("失败 journal（[error] 单事件）→ 物化 assistant（error 文本 + complete + ts=base+1）", async () => {
    const messages = await replayViaJournal([
      { type: "error", message: "engine_run_failed: zcode exited 1" },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "engine_run_failed: zcode exited 1",
      status: "complete",
      timestamp: 1_001,
    });
  });

  it("失败 journal（[error, message_end(usage), turn_end] schema 形态）→ 物化 assistant 带聚合 usage", async () => {
    const messages = await replayViaJournal([
      { type: "error", message: "schema_emulation_failed: two rounds failed" },
      { type: "message_end", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "schema_emulation_failed: two rounds failed",
      status: "complete",
      usage: { inputTokens: 100, outputTokens: 20 },
      timestamp: 1_001,
    });
  });

  it("流式形态（deltas + tool 配对 + turn 边界）→ per-turn assistant + per-turn usage", async () => {
    const messages = await replayViaJournal([
      { type: "text_delta", delta: "part one. " },
      { type: "thinking_delta", delta: "hmm" },
      { type: "tool_start", toolName: "bash", args: { cmd: "ls" } },
      { type: "tool_end", toolName: "bash", result: { content: ["done"] } },
      { type: "message_end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
      { type: "text_delta", delta: "second turn" },
      { type: "turn_end" },
    ]);
    expect(messages).toHaveLength(3);
    const first = messages[1];
    expect(first).toMatchObject({
      role: "assistant",
      content: "part one. ",
      thinking: [{ content: "hmm", collapsed: true }],
      usage: { inputTokens: 10, outputTokens: 5 },
      timestamp: 1_001,
    });
    expect(first?.toolCalls).toHaveLength(1);
    expect(first?.toolCalls?.[0]).toMatchObject({
      toolName: "bash",
      input: { cmd: "ls" },
      output: "done",
      status: "completed",
      startTime: 1_001,
      endTime: 1_001,
    });
    expect(first?.toolCalls?.[0]?.id).toMatch(UUID_RE);
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "second turn",
      timestamp: 1_002,
    });
  });

  it("tool_end isError → status=error；result.details 透传；args 缺省 {}", async () => {
    const messages = await replayViaJournal([
      { type: "tool_start", toolName: "read" },
      {
        type: "tool_end",
        toolName: "read",
        result: { content: ["err text"], details: { path: "/x" } },
        isError: true,
      },
      { type: "turn_end" },
    ]);
    const tc = messages[1]?.toolCalls?.[0];
    expect(tc).toMatchObject({
      toolName: "read",
      input: {},
      output: "err text",
      details: { path: "/x" },
      status: "error",
    });
  });

  it("journal 白名单：journalPath 越界（engines 根外）→ 拒绝并降③级", async () => {
    const outsidePath = join(tmpdir(), "outside-journal-sub-1.jsonl");
    await writeJournal(outsidePath, [{ type: "text_delta", delta: "should not appear" }]);
    const record = makeRecord({
      result: "fallback",
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath: outsidePath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(messages[1]).toMatchObject({ content: "fallback" });
  });

  it("空 journal（无事件）→ ③级", async () => {
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, []);
    const record = makeRecord({
      result: "r",
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(messages[1]).toMatchObject({ content: "r" });
  });
});

// ============================================================
// message_end error 记账（门②补录样本——守护实现的回归校验）
// ============================================================

describe("message_end 携带 error 的记账语义（现役 zcode 不产出，回归校验）", () => {
  it("有内容 + message_end(error) 且无 turn_end 清除 → 末条 assistant 记账 status=error", async () => {
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, [
      { type: "text_delta", delta: "partial work" },
      { type: "message_end", error: "provider error" },
    ]);
    const record = makeRecord({
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "partial work",
      status: "error",
      error: "provider error",
    });
  });

  it("无内容 + message_end(error) → 物化单条（记账文本可见，不降③级）", async () => {
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, [{ type: "message_end", error: "provider error" }]);
    const record = makeRecord({
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "provider error",
      timestamp: 1_001,
    });
  });

  it("turn_end 在 message_end(error) 之后 → 瞬态清除（重放不残留记账）", async () => {
    const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
    await writeJournal(journalPath, [
      { type: "text_delta", delta: "recovered" },
      { type: "message_end", error: "transient" },
      { type: "turn_end" },
      { type: "text_delta", delta: " ok" },
      { type: "turn_end" },
    ]);
    const record = makeRecord({
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: ".zcode/cli/db/db.sqlite" },
        poolKey: "shared",
        journalPath,
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    // turn_end 清 lastError（瞬态恢复语义，C5 reducer 守护行为）——投影无 error 记账
    expect(messages[1]?.status).toBe("complete");
    expect(messages[1]?.error).toBeUndefined();
  });
});
