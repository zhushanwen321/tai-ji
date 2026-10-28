// src/execution/__tests__/settle-chain-transition.test.ts
//
// [P1b-1] settle 链收尾测试（run 显式状态机 D5 的 settle 接线批次）。
//
// 锁四面（验收条款 c：settle 链改调 transition 后直写通道删除）：
// 1. settleWorkflowRecord 收尾单点：CAS 通过 → exec.finalizeRecord 调用（closedReason
//    透传）；CAS 拒绝（竞态抢先收尾）→ 静默跳过（现状检查语义）。
// 2. settleOneShotOutcome（RunOrchestration）workflow origin 分支：成功/aborted →
//    record 终态化（idle + closedReason gc/cancelled）经收尾单点。
// 3. finalizeFailed / finalizeAborted（RecordLifecycle）workflow origin 分支：失败/
//    取消 → 同一收尾单点（静默吞失败路径的间接接入面）。
// 4. 直写通道删除断言（机器检查）：读两个领地源文件断言 workflow origin 直写对
//    （trySettleLegacyClosed(record + 内联 finalizeRecord 对）不再存在于
//    run-orchestration / record-lifecycle——收尾后唯一剩余点在持久化层 settle 原语。
//
// doFinalizeRecord 经 vi.mock 拦截（避免真实 manifest/archive 写侧）；journal 面
// （pump 接线段）走 vitest no-op 防线（本文件不注入目录——断言范围在 record 终态，
// journal 写入 journal 记录已由 run-event-dispatch / terminal-actions-run-events 两文件锁定）。
//
// 整合来源（round 5-g 测试提速，主被测对象 = record 收尾链与读侧投影五面）：
//   agent-result-mapper.test.ts（结果映射）/ notify-host-ended-at.test.ts（通知载荷
//   endedAt 物化）/ record-entry-collect.test.ts（v2 条目编解码）/ 
//   run-and-finalize-window-dispose.test.ts（one-shot 窗口收尾配对）。
// 否决未并：run-failure-worktree-cleanup（doFinalizeRecord 本体测试与本章
// finalize-record mock 自噬，保独立）。

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// logger 桩（提升自 notify-host-ended-at 段；logger.ts 运行时面仅 getLogger）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

vi.mock("../persistence/finalize-record.ts", () => ({
  doFinalizeRecord: vi.fn(async () => {}),
}));

import { createRecord, settleWorkflowRecord, trySettleLegacyClosed } from "../persistence/execution-record.ts";
import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  SUBAGENT_RECORD_ENTRY_KINDS,
  SUBAGENT_RECORD_ENTRY_VERSION,
  classifySubagentRecordEntryData,
  type SubagentRecordEntryV2,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from "../persistence/record-entry.ts";
import { buildCreatedEventPayload, toRegisteredEntryData, toSettledEntryData } from "../persistence/record-entry-write.ts";
import { v2Entries, v2RegisteredEntry, v2SettledEntry } from "./helpers/v2-record-entry.ts";
import { RunOrchestration } from "../service/run-orchestration.ts";
import { RecordLifecycle } from "../service/record-lifecycle.ts";
import type { ResolvedIdentity } from "../service/record-access.ts";
import { createNotifyHost, type NotifyHost, type PiLike } from "../notify/notify-host.ts";
import type { BgNotifyRecord } from "../notify/notifier.ts";
import { mapToWorkflowAgentResult } from "../assembly/agent-result-mapper.ts";
import type { AgentResult, ExecutionRecord } from "../domain/record-model.ts";
import type { AgentUsageTotal, ExecuteOptions, SubagentRecord, ToolCall } from "../assembly/types.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { makePi } from "./helpers/pi-mock.ts";
import { clearEngines } from "../engine/registry.ts";

// ── helpers ──────────────────────────────────────────────────

/** workflow origin 的 running record（真实两态机——CAS/终态断言全真）。 */
function makeWorkflowRecord(id: string): ExecutionRecord {
  return createRecord(id, {
    agent: "reviewer",
    mode: "background",
    task: "review it",
    slug: "reviewer",
    startedAt: Date.now(),
    origin: "workflow",
    parentRunId: `wf-${id}`,
  });
}

const successResult: AgentResult = {
  text: "done",
  turns: 1,
  durationMs: 10,
  success: true,
  sessionId: "sa-x",
  toolCalls: [],
};

// ── 1. settleWorkflowRecord 收尾单点 ─────────────────────────

describe("settleWorkflowRecord（D7 例外族收尾单点）", () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("CAS 通过 → exec.finalizeRecord 调用且 closedReason 透传", async () => {
    const record = makeWorkflowRecord("sa-sw-1");
    const finalizeRecord = vi.fn(async () => {});

    await settleWorkflowRecord(record, successResult, "gc", { finalizeRecord });

    expect(finalizeRecord).toHaveBeenCalledTimes(1);
    expect(finalizeRecord).toHaveBeenCalledWith(successResult, "gc");
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
  });

  it("CAS 拒绝（竞态抢先收尾）→ 静默跳过不覆盖（现状检查语义）", async () => {
    const record = makeWorkflowRecord("sa-sw-2");
    trySettleLegacyClosed(record, "cancelled"); // 抢先方
    const finalizeRecord = vi.fn(async () => {});

    await settleWorkflowRecord(record, successResult, "gc", { finalizeRecord });

    expect(finalizeRecord).not.toHaveBeenCalled();
    expect(record.closedReason).toBe("cancelled"); // 不被 "gc" 覆盖
  });
});

// ── 2. settleOneShotOutcome（RunOrchestration workflow origin 分支） ──

describe("settleOneShotOutcome 经收尾单点（workflow origin）", () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });
  function makeOrchestration() {
    const finalizeRecord = vi.fn(async () => {});
    const orchestration = new RunOrchestration({
      finalizeRecord,
    } as unknown as ConstructorParameters<typeof RunOrchestration>[0]);
    return { orchestration, finalizeRecord };
  }

  it("成功 → record idle + closedReason=gc + finalizeRecord('closed','gc')", async () => {
    const { orchestration, finalizeRecord } = makeOrchestration();
    const record = makeWorkflowRecord("sa-so-1");

    await orchestration.settleOneShotOutcome(record, successResult, false);

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
    expect(finalizeRecord).toHaveBeenCalledWith(record, expect.objectContaining({ success: true }), "closed", "gc");
  });

  it("aborted → closedReason=cancelled（不漂移为 gc）", async () => {
    const { orchestration, finalizeRecord } = makeOrchestration();
    const record = makeWorkflowRecord("sa-so-2");

    await orchestration.settleOneShotOutcome(record, successResult, true);

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled");
    expect(finalizeRecord).toHaveBeenCalledWith(record, successResult, "closed", "cancelled");
  });

  it("失败（success=false）→ closedReason=gc（原三分支等价：失败与成功同 gc）", async () => {
    const { orchestration, finalizeRecord } = makeOrchestration();
    const record = makeWorkflowRecord("sa-so-3");
    const failedResult: AgentResult = { ...successResult, success: false, error: "boom" };

    await orchestration.settleOneShotOutcome(record, failedResult, false);

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
    expect(finalizeRecord).toHaveBeenCalledWith(record, failedResult, "closed", "gc");
  });
});

// ── 3. finalizeFailed / finalizeAborted（RecordLifecycle workflow origin 分支） ──

describe("finalizeFailed / finalizeAborted 经收尾单点（workflow origin）", () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });
  function makeLifecycle() {
    const lifecycle = new RecordLifecycle({
      getWorktreeManager: () => ({}),
      getModelService: () => ({}),
      getStore: () => ({ markRoundIdle: vi.fn() }),
      getNotifyHost: () => ({}),
      getPi: () => null,
      getSessionsDir: () => os.tmpdir(),
    } as unknown as ConstructorParameters<typeof RecordLifecycle>[0]);
    return lifecycle;
  }

  it("finalizeFailed → record idle + closedReason=gc + 合成 failed result（不 re-throw）", async () => {
    const lifecycle = makeLifecycle();
    const record = makeWorkflowRecord("sa-ff-1");

    const result = await lifecycle.finalizeFailed(record, new Error("engine crashed"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("engine crashed");
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
  });

  it("finalizeAborted → record idle + closedReason=cancelled", async () => {
    const lifecycle = makeLifecycle();
    const record = makeWorkflowRecord("sa-fa-1");

    const result = await lifecycle.finalizeAborted(record);

    expect(result.success).toBe(false);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled");
  });

  it("非 workflow origin 不终态化（既有 U5 语义：失败轮落 idle 等续聊，D7 零外溢）", async () => {
    const lifecycle = makeLifecycle();
    const record = createRecord("sa-ff-2", {
      agent: "a",
      mode: "background",
      task: "t",
      slug: "a",
      startedAt: Date.now(),
    });

    const result = await lifecycle.finalizeFailed(record, new Error("x"));

    expect(result.success).toBe(false);
    expect(record.status).toBe("running"); // 走 markRoundIdle 分支（running 保持）
  });
});

// ── 4. 直写通道删除断言（验收 c 的机器检查） ─────────────────

describe("直写通道删除断言（grep 等价的机器检查）", () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });
  const here = path.dirname(fileURLToPath(import.meta.url));

  function readService(name: string): string {
    return fs.readFileSync(path.join(here, "../service", name), "utf8");
  }

  it("run-orchestration.ts 无 workflow origin 直写对（trySettleLegacyClosed + finalizeRecord 内联）", () => {
    const source = readService("run-orchestration.ts");
    expect(source).not.toContain("trySettleLegacyClosed(record");
    // settleOneShotOutcome 改调收尾单点
    expect(source).toContain("settleWorkflowRecord(record, result, aborted ? \"cancelled\" : \"gc\"");
  });

  it("record-lifecycle.ts 无 workflow origin 直写对", () => {
    const source = readService("record-lifecycle.ts");
    expect(source).not.toContain("trySettleLegacyClosed(record");
    expect(source).toContain("settleWorkflowRecord(record, failedResult");
    expect(source).toContain("settleWorkflowRecord(record, cancelledResult");
  });

  it("收尾单点唯一性：trySettleLegacyClosed(record + finalizeRecord 委托仅存在于持久化层 settle 原语", () => {
    // [D1 拆边 Class C] settleWorkflowRecord 下沉 execution/persistence/execution-record.ts
    // （记录级原语，零编排语义）——唯一剩余点在持久化层，编排层不再持有写侧。
    const record = fs.readFileSync(path.join(here, "../persistence/execution-record.ts"), "utf8");
    expect(record).toContain("trySettleLegacyClosed(record, closedReason)");
  });
});
// 来源段：agent-result-mapper.test.ts
//
// T3.14 (NFR-兼容性): AgentResult 映射字段对齐 —— D-A10 纯函数单测
// T3.1  (正常): executeAndAwait 返回 content → 间接覆盖（subagent-service.test.ts 集成验证）
//
// 测试范围: mapToWorkflowAgentResult 所有字段映射分支（success/error/usage/toolCalls）

describe("mapToWorkflowAgentResult (D-A10)", () => {
  const minimalResult: AgentResult = {
    text: "Hello",
    turns: 3,
    durationMs: 1200,
    success: true,
    sessionId: "session-123",
    toolCalls: [],
  };

  // ── T3.14: 正常成功路径 ──

  it("映射成功结果: text→content, durationMs/sessionId 透传", () => {
    const result = mapToWorkflowAgentResult(minimalResult);
    expect(result.content).toBe("Hello");
    expect(result.durationMs).toBe(1200);
    expect(result.sessionId).toBe("session-123");
    expect(result.error).toBeUndefined();
    expect(result.parsedOutput).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
  });

  // ── sessionFile 透传（方案 A：让 workflow 继承 subagent 的 session jsonl 路径）──

  it("映射 sessionFile: subagents AgentResult.sessionFile → workflow AgentResult.sessionFile 透传", () => {
    const r: AgentResult = {
      ...minimalResult,
      sessionFile: "/abs/path/.pi/agent/subagents/enc/sessions/2026-07-15T10-00-00-000Z_session-123.jsonl",
    };
    const result = mapToWorkflowAgentResult(r);
    expect(result.sessionFile).toBe("/abs/path/.pi/agent/subagents/enc/sessions/2026-07-15T10-00-00-000Z_session-123.jsonl");
  });

  it("映射 sessionFile: 无 sessionFile → workflow AgentResult.sessionFile undefined（窗口期/未回填）", () => {
    const r: AgentResult = { ...minimalResult, sessionFile: undefined };
    const result = mapToWorkflowAgentResult(r);
    expect(result.sessionFile).toBeUndefined();
  });

  it("映射 parsedOutput 透传（structured-output 契约 BC-8）", () => {
    const parsedData = { score: 0.95, label: "positive" };
    const r: AgentResult = { ...minimalResult, parsedOutput: parsedData };
    const result = mapToWorkflowAgentResult(r);
    expect(result.parsedOutput).toEqual(parsedData);
  });

  // ── D5-③: failureKind 分诊标签透传（产出侧 output-collector → 消费侧 executeAgentCall） ──

  it("failureKind 三态逐值透传（stale_context / schema_deterministic / unknown）", () => {
    for (const kind of ["stale_context", "schema_deterministic", "unknown"] as const) {
      const r: AgentResult = { ...minimalResult, success: false, error: "boom", failureKind: kind };
      const result = mapToWorkflowAgentResult(r);
      expect(result.failureKind).toBe(kind);
    }
  });

  it("failureKind 缺省（成功路径/上游未写）→ 不落键（消费侧按字段透传，RunErrorCode 缺省兜底 unknown）", () => {
    const result = mapToWorkflowAgentResult(minimalResult);
    expect(result.failureKind).toBeUndefined();
    expect("failureKind" in result).toBe(false);
  });

  // ── T3.14: 失败路径 ──

  it("映射失败: success=false 且 error → 填入 error 字段", () => {
    const r: AgentResult = { ...minimalResult, success: false, error: "timeout" };
    const result = mapToWorkflowAgentResult(r);
    expect(result.error).toBe("timeout");
    expect(result.content).toBe("Hello"); // content 仍保留（可能有部分输出）
  });

  it("映射失败: success=false 但无 error（abort 路径）→ error 填入 fallback 而非 undefined", () => {
    // H4: session-runner.ts abort 时 success=false, error=undefined。
    // 旧代码 error=undefined → executeAgentCall 误判 completed。
    // 修复后应 synthesize fallback error。
    const r: AgentResult = { ...minimalResult, success: false };
    const result = mapToWorkflowAgentResult(r);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("映射成功: success=true 且 error 存在 → error=undefined（不误填）", () => {
    const r: AgentResult = { ...minimalResult, success: true, error: "stale" };
    const result = mapToWorkflowAgentResult(r);
    expect(result.error).toBeUndefined();
  });

  // ── T3.14: usage 映射 ──

  it("映射 usage: AgentUsageTotal → AgentUsage（字段形状转换）", () => {
    const usage: AgentUsageTotal = {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      total: 1800,
      cost: 0.005,
    };
    const r: AgentResult = { ...minimalResult, usage };
    const result = mapToWorkflowAgentResult(r);
    expect(result.usage).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      cost: 0.005,
      contextTokens: 1800, // total → contextTokens
      turns: 3, // 来自 AgentResult.turns
    });
  });

  it("映射 usage: 无 usage → usage undefined", () => {
    const result = mapToWorkflowAgentResult(minimalResult);
    expect(result.usage).toBeUndefined();
  });

  // ── T3.14: toolCalls 映射 ──

  it("映射 toolCalls: ToolCall → ToolCallEntry（name/input 形状转换）", () => {
    const calls: ToolCall[] = [
      { toolName: "read", args: { path: "/a.txt" } },
      { toolName: "bash", args: { command: "ls" }, result: { content: ["ok"] }, isError: false },
    ];
    const r: AgentResult = { ...minimalResult, toolCalls: calls };
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!).toHaveLength(2);
    expect(result.toolCalls![0]).toEqual({ name: "read", input: '{"path":"/a.txt"}' });
    expect(result.toolCalls![1].name).toBe("bash");
  });

  it("映射 toolCalls: args=undefined → input=''", () => {
    const calls: ToolCall[] = [{ toolName: "list" }];
    const r: AgentResult = { ...minimalResult, toolCalls: calls };
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls![0].input).toBe("");
  });

  it("映射 toolCalls: 长 args 截断（>500 chars）", () => {
    const longStr = "x".repeat(600);
    const calls: ToolCall[] = [{ toolName: "write", args: { content: longStr } }];
    const r: AgentResult = { ...minimalResult, toolCalls: calls };
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls![0].input.length).toBeLessThanOrEqual(503); // 500 + "..."
  });

  it("映射 toolCalls: 无 toolCalls → undefined", () => {
    const r = { ...minimalResult, toolCalls: undefined } as unknown as AgentResult;
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls).toBeUndefined();
  });
});
// 来源段：notify-host-ended-at.test.ts
//
// [U8 / 设计 §3.3 D5 耗时来源] toNotifyRecord 的 endedAt 物化域单测：
//   1. running 轮终（生产 markRoundIdle 收尾形态：status="idle" ∧ 无 closedReason）→
//      载荷含 number 型 endedAt（物化前恒 undefined——bg-notify 边界行的耗时恒不显）；
//   2. ~~批成员（batchMember=true，closed 载荷形态）~~ [collect 退役 merge] 用例随
//      批机制删除（toNotifyRecord 收窄单参）；
//   3. legacyClosed（status="idle" ∧ closedReason 有值）保持原值透传（有则透传、
//      无则不补）——原「archived 归档提示」域外分支已随 2026-09-16 全链路删除裁决
//      消亡（收尾提示与任务结束同刻，无「收起延迟」失真源）；
//   4. 快照已有 endedAt 优先于派生时刻（settleRoundFailed / drain-drop 两条自带
//      endedAt 的既有构造路径保真）；
//   5. 派生边界一次完成：返回对象固定，时钟推进不追涨（新派生视图才取新时钟）；
//   6. record 内存零触碰：不写回 record.endedAt（「终态冻结信号」不变量）；
//   7. 收尾提示投递链（notifyClosed）复用同一映射：idle 写入 journal 记录形态物化 endedAt，
//      载荷形态由入口固定 closed。
//
// 时钟：vi.useFakeTimers({ toFake: ["Date"] })——只 fake Date，不碰真实定时器
//（本族零 timer 依赖；notifier 构造点无定时器武装）。
// 数据范围：createRecord 真工厂 + 真 NotifyHost（不 mock 映射内部），内存断言即真实对象。

/** 冻结时钟（派生时刻断言基准）。 */
const FROZEN_NOW = 1788189209000;
const AN_HOUR_MS = 60 * 60 * 1000;

/** 构造 ExecutionRecord（createRecord 真工厂，over 覆盖到目标形态）。 */
function makeEndedAtRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord(id, {
    agent: "worker",
    model: "prov/m1",
    mode: "background",
    task: "t",
    slug: "ended-at",
    startedAt: 1000,
    rootSessionId: "root-A",
  });
  return { ...base, ...over };
}

/** 通知簇 host（pi 缺席——本族只消费 toNotifyRecord；投递链用例单传 pi 替身）。 */
function makeHost(pi: PiLike | null = null): NotifyHost {
  return createNotifyHost({
    getPi: () => pi,
    getIsIdle: () => undefined,
  });
}

describe("[U8] 物化域 = running 轮终 + 批成员", () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("running 轮终载荷物化 endedAt = 派生时刻", () => {
    const host = makeHost();
    const record = makeEndedAtRecord("sa-round-idle", { status: "idle" });
    // 生产形态前提：markRoundIdle 不写内存 endedAt（「终态冻结信号」）——载荷缺值即本单元根因。
    expect(record.endedAt).toBeUndefined();

    const notify = host.toNotifyRecord(record);

    expect(notify).toBeDefined();
    expect(notify!.status).toBe("running");
    expect(typeof notify!.endedAt).toBe("number");
    expect(notify!.endedAt).toBe(FROZEN_NOW);
  });

  it("物化域内快照已有 endedAt 优先透传（不覆写为派生时刻）", () => {
    const host = makeHost();
    const roundTerminal = makeEndedAtRecord("sa-has-ended", { status: "idle", endedAt: 4242 });
    expect(host.toNotifyRecord(roundTerminal)!.endedAt).toBe(4242);
  });
});

describe("[U8] 域外分支不合成新值（原值透传）", () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("legacyClosed 无原值 → 不补；有原值 → 透传", () => {
    const host = makeHost();
    const legacy = makeEndedAtRecord("sa-legacy", { status: "idle", closedReason: "gc" });
    const legacyWithHistory = makeEndedAtRecord("sa-legacy-hist", {
      status: "idle",
      closedReason: "gc",
      endedAt: 777,
    });

    const noValue = host.toNotifyRecord(legacy);
    expect(noValue!.status).toBe("closed");
    expect(noValue!.endedAt).toBeUndefined();
    expect(host.toNotifyRecord(legacyWithHistory)!.endedAt).toBe(777);
  });
});

describe("[U8] 派生边界一次完成 + record 内存零触碰", () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("返回对象固定：时钟推进不追涨，新派生视图才取新时钟", () => {
    const host = makeHost();
    const notify = host.toNotifyRecord(makeEndedAtRecord("sa-fixed", { status: "idle" }));
    expect(notify!.endedAt).toBe(FROZEN_NOW);

    vi.setSystemTime(FROZEN_NOW + AN_HOUR_MS);

    // 物化 = 边界一次求值（非 getter / 延迟计算）——已返回对象不随读取时刻增长。
    expect(notify!.endedAt).toBe(FROZEN_NOW);
    // 每次派生视图独立物化：新派生视图取当时时钟。
    expect(host.toNotifyRecord(makeEndedAtRecord("sa-fixed-2", { status: "idle" }))!.endedAt).toBe(
      FROZEN_NOW + AN_HOUR_MS,
    );
  });

  it("endedAt 不写回 record 内存（「终态冻结信号」不变量）", () => {
    const host = makeHost();
    const roundTerminal = makeEndedAtRecord("sa-mem", { status: "idle" });
    const legacy = makeEndedAtRecord("sa-mem-legacy", { status: "idle", closedReason: "gc" });

    host.toNotifyRecord(roundTerminal);
    host.toNotifyRecord(legacy);

    expect(roundTerminal.endedAt).toBeUndefined();
    expect(legacy.endedAt).toBeUndefined();
  });
});

describe("[U8] 收尾提示投递链复用同一映射（notifyClosed）", () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("idle 写入 journal 记录形态送达：endedAt 物化（收尾时刻 ≈ 结束时刻）+ 载荷固定 closed", () => {
    const pi = makePi();
    const host = makeHost(pi);

    host.notifyClosed(makeEndedAtRecord("sa-close", { status: "idle" }));

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const details = pi.sendMessage.mock.calls[0]![0].details as BgNotifyRecord;
    expect(details.status).toBe("closed");
    expect(details.endedAt).toBe(FROZEN_NOW);
  });
});
// 来源段：record-entry-collect.test.ts
//
// subagent-record entry 契约（v2-only）：customType / 版本常量 / kind 词表 +
// 注册·终态条目载荷形态 + classifySubagentRecordEntryData 分类侧。
//
// 历史沿革：本文件原覆盖「v1 全量快照序列化白名单 + v1/v2 双版本分类」；v1 兼容层
// 下线后（project 未发布、无 v1 数据），写点契约只剩 v2「注册 + 终态两条小条目」，
// v1 全量快照派生视图与其读者分支已删除——本文件同步改写为 v2-only，播种一律经
// helpers/v2-record-entry.ts（生产写侧未导出等价测试入口）。
//
// classify 语义（record-entry.ts SSOT）：
//   ok:true          = 当前 v2 条目（kind 已过词表判定）
//   wrong-type       = data 非对象
//   missing-v        = 对象但 v 缺失
//   future-v         = v 有值但不是 2（含已删的 v1 全量快照形态与类型漂移）
//   unknown-kind     = v=2 但 kind 不在 ["registered","settled"]

/** 最小合法 SubagentRecord（缺省 = tool 来源、未收尾）。 */
function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    sessionFile: "sess-1.jsonl",
    ...over,
  } as SubagentRecord;
}

/** entry data 的 JSONL 形态字符串（appendEntry 落盘即此产物）。 */
function serialize(entry: SubagentRecordEntryV2): string {
  return JSON.stringify(entry);
}

const ENGINE_HANDLE = {
  sessionRef: { sessionId: "s-1", dbPath: "/tmp/db.sqlite" },
  poolKey: "shared",
} as const;

// ── v2 载荷契约（手写形态 = 生产类型逐字段钉住）──────────────────────────

const V2_REGISTERED: SubagentRecordRegisteredEntryData = {
  v: 2,
  kind: "registered",
  id: "sa-1",
  agent: "/home/u/agents/worker.md",
  task: "fix the flaky test",
  slug: "worker",
  origin: "workflow",
  parentRunId: "wf-1",
  stepIndex: 0,
  rootSessionId: "root-A",
  parentRecordId: undefined,
  depth: 1,
  startedAt: 1780000000000,
};

const V2_SETTLED: SubagentRecordSettledEntryData = {
  v: 2,
  kind: "settled",
  id: "sa-1",
  status: "idle",
  stopReason: "completed",
  outcome: "completed",
  endedAt: 1780000123000,
  turns: 3,
  totalTokens: 4500,
  model: "prov/m1",
  thinkingLevel: undefined,
  engine: "zcode",
  engineHandle: ENGINE_HANDLE,
  sessionFile: "/tmp/sessions/sa-1.jsonl",
  result: "done: 3 tests fixed",
};

describe("record-entry 常量面（customType / 版本 / kind 词表）", () => {
  it("keeps SUBAGENT_RECORD_CUSTOM_TYPE stable", () => {
    expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe("subagent-record");
  });

  it("版本常量 = 2；kind 词表恰为 registered/settled（D1：每实体两条小条目）", () => {
    expect(SUBAGENT_RECORD_ENTRY_VERSION).toBe(2);
    expect([...SUBAGENT_RECORD_ENTRY_KINDS]).toEqual(["registered", "settled"]);
  });
});

describe("v2 条目载荷形态", () => {
  it("注册条目 JSON round-trip：身份域在位，可选字段自然缺省（undefined 不落键）", () => {
    const revived = JSON.parse(serialize(V2_REGISTERED)) as Record<string, unknown>;
    expect(revived).toMatchObject({
      v: 2,
      kind: "registered",
      id: "sa-1",
      origin: "workflow",
      parentRunId: "wf-1",
      stepIndex: 0,
      rootSessionId: "root-A",
      depth: 1,
      startedAt: 1780000000000,
    });
    expect("parentRecordId" in revived).toBe(false);
  });

  it("终态条目 JSON round-trip：统计终值 + 锚链载荷 + result 全文在位", () => {
    const revived = JSON.parse(serialize(V2_SETTLED)) as Record<string, unknown>;
    expect(revived).toMatchObject({
      v: 2,
      kind: "settled",
      id: "sa-1",
      status: "idle",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 1780000123000,
      turns: 3,
      totalTokens: 4500,
      model: "prov/m1",
      engine: "zcode",
      sessionFile: "/tmp/sessions/sa-1.jsonl",
    });
    expect(revived.engineHandle).toEqual(ENGINE_HANDLE);
    expect(revived.result).toBe("done: 3 tests fixed");
    expect("thinkingLevel" in revived).toBe(false);
  });
});

// ── 测试播种辅助（helpers/v2-record-entry.ts）────────────────────────────

describe("v2 播种辅助：SubagentRecord → 现行主 session 条目族", () => {
  it("注册播种：身份域派生视图 + 可选字段缺省不落键", () => {
    const entry = v2RegisteredEntry(
      makeRecord({ origin: "workflow", parentRunId: "wf-1", stepIndex: 0, depth: 1 }),
    );
    expect(entry).toMatchObject({
      v: 2,
      kind: "registered",
      id: "sa-1",
      agent: "/home/u/agents/worker.md",
      task: "t",
      slug: "worker",
      origin: "workflow",
      parentRunId: "wf-1",
      stepIndex: 0,
      rootSessionId: "root-A",
      depth: 1,
      startedAt: 1000,
    });
    const revived = JSON.parse(serialize(entry)) as Record<string, unknown>;
    expect(revived).toMatchObject({ v: 2, kind: "registered", id: "sa-1", origin: "workflow" });
    // 顶层 record：无父、无 step、无 parentRunId → 键缺省。
    const top = JSON.parse(serialize(v2RegisteredEntry(makeRecord()))) as Record<string, unknown>;
    expect("parentRecordId" in top).toBe(false);
    expect("parentRunId" in top).toBe(false);
    expect("stepIndex" in top).toBe(false);
  });

  it("终态播种：终局域派生视图（停因/统计/引擎锚/result）", () => {
    const entry = v2SettledEntry(
      makeRecord({
        status: "idle",
        stopReason: "completed",
        outcome: "completed",
        endedAt: 2000,
        engine: "zcode",
        engineHandle: ENGINE_HANDLE,
        result: "done",
      }),
    );
    expect(entry).toMatchObject({
      v: 2,
      kind: "settled",
      id: "sa-1",
      status: "idle",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 2000,
      turns: 1,
      totalTokens: 42,
      model: "prov/m1",
      engine: "zcode",
      result: "done",
    });
    expect(entry.engineHandle).toEqual(ENGINE_HANDLE);
    // undefined 可选字段（error / thinkingLevel）不落键。
    const revived = JSON.parse(serialize(entry)) as Record<string, unknown>;
    expect("error" in revived).toBe(false);
    expect("thinkingLevel" in revived).toBe(false);
  });

  it("条目族：running 只产注册条目；已收尾再补终态条目（注册先行）", () => {
    expect(v2Entries(makeRecord()).map((e) => e.kind)).toEqual(["registered"]);
    expect(
      v2Entries(makeRecord({ status: "idle", stopReason: "completed", endedAt: 2000 })).map(
        (e) => e.kind,
      ),
    ).toEqual(["registered", "settled"]);
  });
});

// ── v2-only 分类侧 ───────────────────────────────────────────────────────

describe("classifySubagentRecordEntryData（v2-only）", () => {
  it("合法注册条目 → { ok:true, entry }，kind = 'registered'", () => {
    const result = classifySubagentRecordEntryData(V2_REGISTERED);
    expect(result).toEqual({ ok: true, entry: V2_REGISTERED });
    if (result.ok) {
      expect(result.entry.kind).toBe("registered");
    }
  });

  it("合法终态条目 → { ok:true, entry }，kind = 'settled' 且载荷可窄化", () => {
    const result = classifySubagentRecordEntryData(V2_SETTLED);
    expect(result.ok).toBe(true);
    if (result.ok && result.entry.kind === "settled") {
      expect(result.entry.stopReason).toBe("completed");
      expect(result.entry.result).toBe("done: 3 tests fixed");
    }
  });

  it("播种条目经 JSON round-trip 后仍判 ok（落盘形态 = 分类侧输入）", () => {
    const seeded = v2Entries(makeRecord({ status: "idle", stopReason: "completed", endedAt: 2000 }));
    expect(seeded).toHaveLength(2);
    for (const entry of seeded) {
      const revived = JSON.parse(serialize(entry)) as unknown;
      expect(classifySubagentRecordEntryData(revived).ok).toBe(true);
    }
  });

  it("wrong-type：非对象 data（undefined / number / null）", () => {
    expect(classifySubagentRecordEntryData(undefined)).toEqual({ ok: false, reason: "wrong-type" });
    expect(classifySubagentRecordEntryData(42)).toEqual({ ok: false, reason: "wrong-type" });
    expect(classifySubagentRecordEntryData(null)).toEqual({ ok: false, reason: "wrong-type" });
  });

  it("missing-v：对象但 v 缺失", () => {
    expect(classifySubagentRecordEntryData({ id: "sa-1" })).toEqual({
      ok: false,
      reason: "missing-v",
    });
    expect(classifySubagentRecordEntryData({ kind: "registered" })).toEqual({
      ok: false,
      reason: "missing-v",
    });
  });

  it("unknown-kind：v = 2 但 kind 缺失或不在词表", () => {
    expect(classifySubagentRecordEntryData({ v: 2, kind: "snapshot" })).toEqual({
      ok: false,
      reason: "unknown-kind",
    });
    expect(classifySubagentRecordEntryData({ v: 2 })).toEqual({ ok: false, reason: "unknown-kind" });
  });

  it("future-v：v 有值但非当前版本（含已删 v1 全量快照形态与类型漂移）", () => {
    // 已删除的 v1 全量快照形态：旧写点产物，现行契约结构性跳过。
    const legacyV1Snapshot = {
      v: 1,
      id: "sa-1",
      agent: "/home/u/agents/worker.md",
      task: "t",
      slug: "worker",
      status: "running",
      mode: "background",
      startedAt: 1000,
      turns: 1,
      totalTokens: 42,
      model: "prov/m1",
    };
    expect(classifySubagentRecordEntryData(legacyV1Snapshot)).toEqual({
      ok: false,
      reason: "future-v",
    });
    expect(classifySubagentRecordEntryData({ v: 3 })).toEqual({ ok: false, reason: "future-v" });
    expect(classifySubagentRecordEntryData({ v: "1" })).toEqual({ ok: false, reason: "future-v" });
  });
});

// ── [subagent-detail-model-info] modelSource 写侧（直测生产写侧——测试播种 helper
//    v2-record-entry 不派生该字段，绕开以锁生产行为）─────────────────────────────
describe("modelSource 写侧：注册/终态条目与 created 帧同域派生视图", () => {
  it("注册条目：modelSource 在场落键 + 缺省不落键", () => {
    const entry = toRegisteredEntryData({
      id: "sa-1",
      agent: "worker",
      task: "t",
      slug: "worker",
      depth: 0,
      startedAt: 1000,
      modelSource: "explicit",
    });
    expect(entry.modelSource).toBe("explicit");
    const revived = JSON.parse(serialize(entry)) as Record<string, unknown>;
    expect(revived.modelSource).toBe("explicit");

    const noSource = toRegisteredEntryData({
      id: "sa-2",
      agent: "worker",
      task: "t",
      slug: "worker",
      depth: 0,
      startedAt: 1000,
    });
    expect("modelSource" in noSource).toBe(false);
  });

  it("终态条目：SettledEntrySource → 条目派生视图（缺省不落键）", () => {
    const entry = toSettledEntryData(
      {
        id: "sa-1",
        status: "idle",
        turnCount: 1,
        totalTokens: 42,
        model: "prov/m1",
        modelSource: "preference",
        thinkingLevel: undefined,
      },
      2000,
    );
    expect(entry.modelSource).toBe("preference");
    const revived = JSON.parse(serialize(entry)) as Record<string, unknown>;
    expect(revived.modelSource).toBe("preference");

    const noSource = toSettledEntryData(
      {
        id: "sa-2",
        status: "idle",
        turnCount: 0,
        totalTokens: 0,
        model: undefined,
        thinkingLevel: undefined,
      },
      2000,
    );
    expect("modelSource" in noSource).toBe(false);
  });

  it("created 帧载荷：modelSource 同域（与 model/thinkingLevel 同款缺省不落键）", () => {
    const payload = buildCreatedEventPayload({
      startedAt: 1000,
      id: "sa-1",
      agent: "worker",
      task: "t",
      slug: "worker",
      origin: "tool",
      rootSessionId: "root",
      depth: 0,
      mode: "background",
      modelSource: "frontmatter",
    } as unknown as ExecutionRecord);
    expect((payload as Record<string, unknown>).modelSource).toBe("frontmatter");
  });
});
// 来源段：run-and-finalize-window-dispose.test.ts
//
// [D3-A4] runAndFinalize 的 one-shot 窗口收尾配对测试。
//
// 覆盖语义（disposeWindowEngine 接线的两条路径，窗口键 = record.id）：
// 1. engine.run 失败（prepare 期 reject / 进程死亡）→ catch 内收窗口（"one-shot-failed"）
//    + finalizeFailed 合成失败结果（swallow 不外抛——sync 调用方拿 failed result）。
// 2. engine.run 成功 → settle 后收窗口（"one-shot-settled"），与失败路径构成
//    「无论成败窗口必收」的配对不变量（不收即孤儿窗口实例驻留）。
//
// mock 策略：RunOrchestration 直构（settle-chain-transition.test.ts 同款部分 deps
// 注入），engine 走 registerFakePiEngine 替身（record.id 无窗口状态 → 解析回落
// registry 单例路径，run 捕获在 fake.runs）。

const failResult: AgentResult = {
  text: "",
  turns: 0,
  durationMs: 1,
  success: false,
  sessionId: "sa-x",
  toolCalls: [],
};

const wdSuccessResult: AgentResult = {
  text: "done",
  turns: 1,
  durationMs: 10,
  success: true,
  sessionId: "sa-x",
  toolCalls: [],
};

/** origin=tool 的 record（executeAndAwait 的 record 形态；modeless 后域模型唯一
 *  ExecutionMode="background"——runAndFinalize 恒走池槽路径，getPool 由 stub 承载）。 */
function makeToolRecord(id: string): ExecutionRecord {
  return createRecord(id, {
    agent: "reviewer",
    mode: "background",
    task: "review it",
    slug: "reviewer",
    startedAt: Date.now(),
    origin: "tool",
  });
}

const identity: ResolvedIdentity = {
  agent: "reviewer",
  agentConfig: undefined,
  resolved: { model: undefined, thinkingLevel: undefined },
};

/** RunOrchestration 直构（仅注入被测路径消费的 deps——其余 cast 绕过完整装配）。
 *  deps 类型走字面量推断（单实现场景不起具名接口）。 */
function makeOrchestration(result: AgentResult) {
  const deps = {
    disposeWindowEngine: vi.fn(),
    finalizeFailed: vi.fn(async () => result),
    finalizeRecord: vi.fn(async () => {}),
    // runCtx 构造消费（sessionRootId 缺省不入 wire）
    getSessionRootId: vi.fn(() => null),
    // origin=tool 的 settleOneShotOutcome 簿记（record.status=running 时走 markRoundIdle）
    getStore: vi.fn(() => ({ markRoundIdle: vi.fn(), markSettled: vi.fn() })),
    // [subagent-observability §3.3.7② one-shot 通道放行（u4 并行接线）] 轮应答通知经
    // getNotifyHost().notifyComplete——本文件断言面是窗口收尾配对，替身 no-op 即可。
    getNotifyHost: vi.fn(() => ({ notifyComplete: vi.fn() })),
    // pooled（modeless 后恒 background）的池槽路径：acquire 恒成功 / release no-op
    getPool: vi.fn(() => ({ acquire: vi.fn(async () => {}), release: vi.fn(), maxConcurrent: 2 })),
  };
  const orchestration = new RunOrchestration(
    deps as unknown as ConstructorParameters<typeof RunOrchestration>[0],
  );
  return { orchestration, deps };
}

describe("runAndFinalize one-shot 窗口收尾（D3-A4 失败路径）", () => {
  afterEach(() => {
    clearEngines();
    vi.restoreAllMocks();
  });

  it("engine.run 失败 → disposeWindowEngine('one-shot-failed') + finalizeFailed 结果外返", async () => {
    const fake: FakePiEnginePort = registerFakePiEngine();
    const { orchestration, deps } = makeOrchestration(failResult);
    const record = makeToolRecord("sa-wd-fail-1");

    const runErr = new Error("engine run boom");
    const pending = orchestration.runAndFinalize(
      record,
      { task: "review it", slug: "reviewer" } as ExecuteOptions,
      identity,
      undefined,
      0,
    );
    // run 已派发到替身引擎（窗口键无状态 → registry 单例路径）→ 驱动失败应答
    //（pooled 恒 background：engine.run 前有池槽 await，等派发落 fake.runs 再驱动）
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0].fail(runErr);

    // swallow 语义：不 reject，sync 调用方拿到合成 failed result
    await expect(pending).resolves.toBe(failResult);
    expect(deps.finalizeFailed).toHaveBeenCalledWith(record, runErr);
    // 失败路径同样收窗口（record.id 键）——不收即孤儿窗口实例
    expect(deps.disposeWindowEngine).toHaveBeenCalledWith(
      record.id,
      "one-shot-failed",
      "executeAndAwait runAndFinalize failure cleanup",
    );
  });

  it("engine.run 成功 → settle 后 disposeWindowEngine('one-shot-settled')（配对不变量）", async () => {
    const fake: FakePiEnginePort = registerFakePiEngine();
    const { orchestration, deps } = makeOrchestration(wdSuccessResult);
    const record = makeToolRecord("sa-wd-ok-1");

    const pending = orchestration.runAndFinalize(
      record,
      { task: "review it", slug: "reviewer" } as ExecuteOptions,
      identity,
      undefined,
      0,
    );
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0].settle({ content: "reviewed" });

    const result = await pending;
    expect(result.success).toBe(true);
    expect(deps.disposeWindowEngine).toHaveBeenCalledWith(
      record.id,
      "one-shot-settled",
      "executeAndAwait runAndFinalize settle cleanup",
    );
    // 失败路径未走：finalizeFailed 零调用
    expect(deps.finalizeFailed).not.toHaveBeenCalled();
  });
});
