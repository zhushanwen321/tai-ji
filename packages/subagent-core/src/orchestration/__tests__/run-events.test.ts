// run-events.test.ts —— run 事件词表 / 状态机 / record 流的测试（设计 §3.3 D5 →
// workflow-run-resume-revision [D2]/[D4] 重构后词表）。
//
// 覆盖：
// - 词表断言：RUN_EVENT_TYPES 9 个（[D4] 对齐 pi：ask-* → agent-*、新增
//   phase-started/phase-settled（[D3]）与 run-interrupted/run-resumed（[D2]）；
//   armed 随 [D5] 删、member-pool 随 [D6] 绑定消解删）；ALL_RUN_LIFECYCLES
//   四态 + interrupted 暂停态（[D2]）；ALL_RUN_OUTCOMES 四值（completed→done
//   改名、interrupted 移出、time_limited 升格）
// - 判别联合 exhaustive：switch 全 9 分支、无 default 吞噬（never 穷尽性断言——
//   编译期由 tsc --noEmit 把关，运行期用样本事件核对分支映射）
// - 载荷形状：样本事件逐字段断言（agent-settled / run-settled 各含成功与失败
//   两形态；run-interrupted / run-resumed 转移事件）
// - record 接口形态：最小内存 fake 验证 append/scan 可实现且调用形状成立
// - 状态机：词表 / 转移表穷尽（全 lifecycle × 全 trigger 组合遍历——表是可枚举
//   数据，不是散落 case）/ 终局与输出动作语义 / 纯函数边界（时钟随机探针）
// - record 实装：append→scan 往返等价 / 坏行容错 / 路径穿越拒绝（临时目录
//   mkdtempSync 自建自删，符合测试红线）
// - 删值后历史行兼容：旧词表（armed / member-pool / ask-*）历史行跳过计日志、
//   崩溃残留流 fold 停非 terminal 不误判坏帧
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALL_RUN_LIFECYCLES,
  ALL_RUN_OUTCOMES,
  CONTROL_TRIGGER_TYPES,
  doneReasonToRunOutcome,
  foldRunEventCheckpoint,
  INITIAL_RUN_LIFECYCLE_STATE,
  RUN_EVENT_TYPES,
  RUN_TRANSITIONS,
  TRANSITION_OUTPUT_TYPES,
  createRunEventJournal,
  transition,
  IllegalTransitionError,
  type AgentSettledEvent,
  type ControlTriggerType,
  type RunErrorCode,
  type RunEventJournal,
  type RunEventType,
  type RunLifecycle,
  type RunOutcome,
  type RunLifecycleState,
  type TransitionTrigger,
  type WorkflowRunEvent,
} from "../run-events.ts";
import { ALL_DONE_REASONS, isTerminalDoneReason } from "../models/types.ts";

// ── 样本事件（覆盖全部 9 个 type；路径值均为 fixture 假路径）────
//
// seq 信封：样本按全链时序取号（与 append 分配序一致——record 实装
// 用例的「append → scan 往返等价」直接复用样本数组断言）。

const TS = 1_758_000_000_000;

const runCreated: WorkflowRunEvent = {
  type: "run-created",
  seq: 1,
  ts: TS,
  runId: "wf-1758-a1",
  workflowName: "review-fix-loop",
  argsSummary: '{"pr":"#123"}',
  // [D1] 脚本源全文入事件（record 单源后 resume 重放的唯一 scriptSource 落点）
  scriptSource: "const r = await agent('review');",
};

/** [D3] phase 状态机转移事件样本。 */
const phaseStarted: WorkflowRunEvent = {
  type: "phase-started",
  seq: 2,
  ts: TS + 5,
  phase: "review",
};

const agentStarted: WorkflowRunEvent = {
  type: "agent-started",
  seq: 3,
  ts: TS + 10,
  taskIndex: 0,
  agentName: "reviewer-security",
  attempt: 1,
};

const agentRetrying: WorkflowRunEvent = {
  type: "agent-retrying",
  seq: 5,
  ts: TS + 30_000,
  taskIndex: 0,
  attempt: 1,
  backoffMs: 1000,
  reason: "provider 503",
};

const agentSettledFailed: AgentSettledEvent = {
  type: "agent-settled",
  seq: 6,
  ts: TS + 51_000,
  taskIndex: 0,
  attempt: 2,
  outcome: "failed",
  errorCode: "engine_crashed",
  durationMs: 21_000,
  stderrTeePath: "/record-fixture/wf-1758-a1/call-0-attempt-2.stderr.log",
  // [D1] 结果全文入事件（record 单源后 resume 缓存回放的唯一 result 落点）
  result: { content: "", error: "engine crashed mid-turn" },
};

const agentSettledCompleted: AgentSettledEvent = {
  type: "agent-settled",
  seq: 7,
  ts: TS + 120_000,
  taskIndex: 1,
  attempt: 1,
  outcome: "done",
  durationMs: 65_000,
  result: { content: "review complete: 2 findings" },
};

/** [D3] phase 内全部 call 落定的转移事件样本。 */
const phaseSettled: WorkflowRunEvent = {
  type: "phase-settled",
  seq: 9,
  ts: TS + 130_000,
  phase: "review",
};

/** [D2] 中断转移事件样本（崩溃收编来源——crashed）。 */
const runInterrupted: WorkflowRunEvent = {
  type: "run-interrupted",
  seq: 8,
  ts: TS + 125_000,
  errorCode: "crashed",
  reason: "process killed",
};

/** [D2] 复活转移事件样本（resume 编排写入——U2）。 */
const runResumed: WorkflowRunEvent = {
  type: "run-resumed",
  seq: 10,
  ts: TS + 200_000,
  reason: "resume requested",
  host: "pi-host-1",
};

const runSettledFailed: WorkflowRunEvent = {
  type: "run-settled",
  seq: 11,
  ts: TS + 180_000,
  outcome: "failed",
  errorCode: "engine_crashed",
  reason: "all agent waves failed",
  artifactsDir: "/record-fixture/wf-1758-a1",
};

const runSettledCompleted: WorkflowRunEvent = {
  type: "run-settled",
  seq: 11,
  ts: TS + 240_000,
  outcome: "done",
  artifactsDir: "/record-fixture/wf-1758-a1",
};

const runSettledCancelled: WorkflowRunEvent = {
  type: "run-settled",
  seq: 11,
  ts: TS + 90_000,
  outcome: "cancelled",
  reason: "user abort",
  artifactsDir: "/record-fixture/wf-1758-a1",
};

/** [D2] time_limited 升格为 outcome 的独立终局帧样本。 */
const runSettledTimeLimited: WorkflowRunEvent = {
  type: "run-settled",
  seq: 11,
  ts: TS + 250_000,
  outcome: "time_limited",
  reason: "budgetTimeMs exceeded",
  artifactsDir: "/record-fixture/wf-1758-a1",
};

// ── 穷尽性处理样例 ────────────────────────────────────────────

/** 剥离 seq 的载荷投影（seq 分配断言与载荷断言解耦用）。 */
function stripSeq<T extends { seq: number }>(event: T): Omit<T, "seq"> {
  const { seq: _s, ...rest } = event;
  return rest;
}

/**
 * switch 覆盖全部 9 个 type 且无 default 分支——switch 之后 event 只剩 never，
 * 对其赋值即穷尽性断言：词表新增成员时该行编译失败（tsc 把关），强制同步扩展
 * 本处理样例。返回分支标记供运行期核对样本事件各命中唯一分支。
 */
function labelOf(event: WorkflowRunEvent): string {
  switch (event.type) {
    case "run-created":
      return `run-created:${event.workflowName}`;
    case "phase-started":
      return `phase-started:${event.phase}`;
    case "agent-started":
      return `agent-started:${event.taskIndex}:${event.attempt}`;
    case "agent-retrying":
      return `agent-retrying:${event.taskIndex}:${event.backoffMs}`;
    case "agent-settled":
      return `agent-settled:${event.outcome}:${event.errorCode ?? "none"}`;
    case "phase-settled":
      return `phase-settled:${event.phase}`;
    case "run-interrupted":
      return `run-interrupted:${event.errorCode ?? "none"}`;
    case "run-resumed":
      return `run-resumed:${event.host ?? "none"}`;
    case "run-settled":
      return `run-settled:${event.outcome}:${event.errorCode ?? "none"}`;
  }
  const _exhaustive: never = event;
  return _exhaustive;
}

// ── 词表 ─────────────────────────────────────────────────────

describe("事件词表（D5 → [D4] 对齐 pi）", () => {
  it("RUN_EVENT_TYPES 恰好 9 个成员（[D4] agent-* 对齐 + phase-*/run-interrupted/run-resumed 新增；armed 随 [D5] 删、member-pool 随 [D6] 绑定消解删；无 world-run 族——脚本 API 面无子进程调用通道）", () => {
    expect(RUN_EVENT_TYPES).toEqual([
      "run-created",
      "phase-started",
      "agent-started",
      "agent-retrying",
      "agent-settled",
      "phase-settled",
      "run-interrupted",
      "run-resumed",
      "run-settled",
    ]);
  });

  it("ALL_RUN_OUTCOMES 四值（done / failed / cancelled / time_limited——[D2] completed→done 改名、interrupted 移出入 lifecycle、time_limited 升格）", () => {
    expect(ALL_RUN_OUTCOMES).toEqual(["done", "failed", "cancelled", "time_limited"]);
  });

  it("RunErrorCode 承载引擎/分类/终局/中断四族词表（编译期赋值由 tsc 把关）", () => {
    // 引擎固定码 + engine_ 前缀透传码 + 失败分类（classifyFailureKind 词表）
    // + run 级终局码（budget_limited）+ 中断来源族（crashed/terminated/startup-sweep）
    // + 历史帧解析保留成员（time_limited/interrupted_abandoned/idle-evicted——解析
    // 词表纪律，无新写入方）
    const codes: RunErrorCode[] = [
      "engine_crashed",
      "engine_probe_failed",
      "engine_custom_future",
      "stale_context",
      "schema_deterministic",
      "unknown",
      "budget_limited",
      "time_limited",
      "interrupted_abandoned",
      "idle-evicted",
      "crashed",
      "terminated",
      "startup-sweep",
    ];
    expect(codes).toHaveLength(13);
  });
});

// ── 判别联合穷尽性 ───────────────────────────────────────────

describe("判别联合 exhaustive（无 default 吞噬）", () => {
  it("9 类样本事件各命中唯一分支，标记与预期一致", () => {
    const samples: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      agentStarted,
      agentRetrying,
      agentSettledFailed,
      phaseSettled,
      runInterrupted,
      runResumed,
      runSettledFailed,
    ];
    expect(samples.map(labelOf)).toEqual([
      "run-created:review-fix-loop",
      "phase-started:review",
      "agent-started:0:1",
      "agent-retrying:0:1000",
      "agent-settled:failed:engine_crashed",
      "phase-settled:review",
      "run-interrupted:crashed",
      "run-resumed:pi-host-1",
      "run-settled:failed:engine_crashed",
    ]);
  });

  it("样本事件 type 全部落在词表内（词表与联合成员一致）", () => {
    const samples: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      agentStarted,
      agentRetrying,
      agentSettledFailed,
      agentSettledCompleted,
      phaseSettled,
      runInterrupted,
      runResumed,
      runSettledFailed,
      runSettledCompleted,
    ];
    expect(new Set(samples.map((e) => e.type))).toEqual(new Set(RUN_EVENT_TYPES));
  });
});

// ── 载荷形状 ─────────────────────────────────────────────────

describe("载荷形状（D5 载荷表 → [D1]/[D3] 增量）", () => {
  it("run-created：runId / workflowName / argsSummary / model 引用 + scriptSource 全文（[D1] 载荷表）", () => {
    expect(runCreated).toEqual({
      type: "run-created",
      seq: 1,
      ts: TS,
      runId: "wf-1758-a1",
      workflowName: "review-fix-loop",
      argsSummary: '{"pr":"#123"}',
      scriptSource: "const r = await agent('review');",
    });
  });

  it("phase-started / phase-settled：phase 名（[D3] 状态机转移事件）", () => {
    expect(phaseStarted).toEqual({
      type: "phase-started",
      seq: 2,
      ts: TS + 5,
      phase: "review",
    });
    expect(phaseSettled).toEqual({
      type: "phase-settled",
      seq: 9,
      ts: TS + 130_000,
      phase: "review",
    });
  });

  it("agent-started：agentName / attempt / taskIndex（[D4] 对齐 pi agent_start；memberRecordId 为 [D6] 绑定字段，缺省 = 首派）", () => {
    expect(agentStarted).toEqual({
      type: "agent-started",
      seq: 3,
      ts: TS + 10,
      taskIndex: 0,
      agentName: "reviewer-security",
      attempt: 1,
    });
    // [D6] 绑定字段化承载：续写帧携带 memberRecordId
    const rebinding: WorkflowRunEvent = { ...agentStarted, seq: 4, memberRecordId: "sa-wf-member-1" };
    expect((rebinding as Extract<WorkflowRunEvent, { type: "agent-started" }>).memberRecordId).toBe(
      "sa-wf-member-1",
    );
  });

  it("agent-retrying：attempt / backoffMs / reason", () => {
    expect(agentRetrying).toEqual({
      type: "agent-retrying",
      seq: 5,
      ts: TS + 30_000,
      taskIndex: 0,
      attempt: 1,
      backoffMs: 1000,
      reason: "provider 503",
    });
  });

  it("agent-settled 失败形态：outcome / errorCode / durationMs + 诊断引用（stderrTeePath）+ result 全文（[D1] 载荷表；result.sessionFile 同时承载 [D16③] 家族链数据源）", () => {
    expect(agentSettledFailed).toEqual({
      type: "agent-settled",
      seq: 6,
      ts: TS + 51_000,
      taskIndex: 0,
      attempt: 2,
      outcome: "failed",
      errorCode: "engine_crashed",
      durationMs: 21_000,
      stderrTeePath: "/record-fixture/wf-1758-a1/call-0-attempt-2.stderr.log",
      result: { content: "", error: "engine crashed mid-turn" },
    });
  });

  it("agent-settled 成功形态：errorCode / stderrTeePath 缺省 + result 全文（[D1] 载荷表；call 级 outcome 值域 = done/failed/cancelled 三值）", () => {
    expect(agentSettledCompleted).toEqual({
      type: "agent-settled",
      seq: 7,
      ts: TS + 120_000,
      taskIndex: 1,
      attempt: 1,
      outcome: "done",
      durationMs: 65_000,
      result: { content: "review complete: 2 findings" },
    });
  });

  it("run-interrupted：errorCode 来源标记 + reason（[D2] 中断转移——非终局帧，无 outcome 字段）", () => {
    expect(runInterrupted).toEqual({
      type: "run-interrupted",
      seq: 8,
      ts: TS + 125_000,
      errorCode: "crashed",
      reason: "process killed",
    });
  });

  it("run-resumed：reason + host（[D2] 复活转移——resume 编排写入，U2）", () => {
    expect(runResumed).toEqual({
      type: "run-resumed",
      seq: 10,
      ts: TS + 200_000,
      reason: "resume requested",
      host: "pi-host-1",
    });
  });

  it("run-settled 失败形态：outcome / errorCode / reason / artifactsDir", () => {
    expect(runSettledFailed).toEqual({
      type: "run-settled",
      seq: 11,
      ts: TS + 180_000,
      outcome: "failed",
      errorCode: "engine_crashed",
      reason: "all agent waves failed",
      artifactsDir: "/record-fixture/wf-1758-a1",
    });
  });

  it("run-settled 成功形态：errorCode / reason 缺省，artifactsDir 恒在；time_limited 形态（[D2] 升格独立 outcome、无码）", () => {
    expect(runSettledCompleted).toEqual({
      type: "run-settled",
      seq: 11,
      ts: TS + 240_000,
      outcome: "done",
      artifactsDir: "/record-fixture/wf-1758-a1",
    });
    expect(runSettledTimeLimited).toEqual({
      type: "run-settled",
      seq: 11,
      ts: TS + 250_000,
      outcome: "time_limited",
      reason: "budgetTimeMs exceeded",
      artifactsDir: "/record-fixture/wf-1758-a1",
    });
  });
});

// ── record 接口形态 ──────────────────────────────────────────

describe("RunEventJournal 接口形态（仅类型签名——实装归 journal 单元）", () => {
  it("append / scan 可实现且调用形状成立（内存 fake，零文件 IO）", async () => {
    const store = new Map<string, WorkflowRunEvent[]>();
    const journal: RunEventJournal = {
      append: async (runId, event) => {
        const list = store.get(runId) ?? [];
        // [W1] seq 分配归 journal 实装（input 形态入、完整事件出——契约形状验证）
        const full = { ...event, seq: list.length + 1 } as WorkflowRunEvent;
        list.push(full);
        store.set(runId, list);
        return full;
      },
      scan: async (runId) => store.get(runId) ?? [],
    };

    await journal.append("wf-1758-a1", runCreated);
    await journal.append("wf-1758-a1", agentRetrying);
    await journal.append("wf-1758-a1", runSettledFailed);

    // [W1] seq 由 journal 分配（fake 同款：末水位 + 1）——断言剥 seq 的载荷序
    // 与分配的 seq 序各自成立
    const scanned = await journal.scan("wf-1758-a1");
    expect(scanned.map(stripSeq)).toEqual([
      stripSeq(runCreated),
      stripSeq(agentRetrying),
      stripSeq(runSettledFailed),
    ]);
    expect(scanned.map((e) => e.seq)).toEqual([1, 2, 3]);
    await expect(journal.scan("wf-other")).resolves.toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 状态机（转移表 + transition 纯函数 + record 实装）
// ═══════════════════════════════════════════════════════════

/** 全触发类型（9 journal 事件 + 1 控制事件 = 10，穷尽遍历用；[D4] 词表后）。 */
const ALL_TRIGGER_TYPES: readonly (RunEventType | ControlTriggerType)[] = [
  ...RUN_EVENT_TYPES,
  ...CONTROL_TRIGGER_TYPES,
];

/** 每个触发类型一个代表性样本（穷尽遍历用；样本本身即词表内合法形态）。 */
const triggerSamples: Record<RunEventType | ControlTriggerType, TransitionTrigger> = {
  "run-created": runCreated,
  "phase-started": phaseStarted,
  "agent-started": agentStarted,
  "agent-retrying": agentRetrying,
  "agent-settled": agentSettledFailed,
  "phase-settled": phaseSettled,
  "run-interrupted": runInterrupted,
  "run-resumed": runResumed,
  "run-settled": runSettledFailed,
  "cancel-requested": { type: "cancel-requested", reason: "user abort" },
};

/** 构造某 lifecycle 的状态样本（terminal 带 outcome——真实终态形态）。 */
function stateOf(lifecycle: RunLifecycle): RunLifecycleState {
  return lifecycle === "terminal" ? { lifecycle, outcome: "done" } : { lifecycle };
}

/** 表外转移断言：抛 IllegalTransitionError，且错误信息含当前态与事件名。 */
function expectIllegalTransition(state: RunLifecycleState, trigger: TransitionTrigger): void {
  let caught: unknown;
  try {
    transition(state, trigger);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IllegalTransitionError);
  const err = caught as IllegalTransitionError;
  expect(err.from).toBe(state.lifecycle);
  expect(err.on).toBe(trigger.type);
  expect(err.message).toContain(state.lifecycle);
  expect(err.message).toContain(trigger.type);
}

// ── 状态词表 ─────────────────────────────────────────────────

describe("状态词表（D5-1 → [D2] 四态 + interrupted 暂停态）", () => {
  it("ALL_RUN_LIFECYCLES 五成员（created → running → settling → interrupted（暂停态）→ terminal；[D2] dispatched 并入 running、interrupted 以暂停态回归）", () => {
    expect(ALL_RUN_LIFECYCLES).toEqual([
      "created",
      "running",
      "settling",
      "interrupted",
      "terminal",
    ]);
  });

  it("CONTROL_TRIGGER_TYPES 仅 cancel-requested（不属 record 词表；watchdog-fired 随 D9 删除，host-died / abandon-elapsed 随 [W2 D2] 死形态清退删除）", () => {
    expect(CONTROL_TRIGGER_TYPES).toEqual(["cancel-requested"]);
    for (const t of CONTROL_TRIGGER_TYPES) {
      expect(RUN_EVENT_TYPES).not.toContain(t);
    }
  });

  it("TRANSITION_OUTPUT_TYPES 三个输出动作标签（kill-run-topology 随 D9-2 杀链删除）", () => {
    expect(TRANSITION_OUTPUT_TYPES).toEqual([
      "journal-append",
      "manifest-write",
      "notify",
    ]);
  });

  it("INITIAL_RUN_LIFECYCLE_STATE = created 且无 outcome", () => {
    expect(INITIAL_RUN_LIFECYCLE_STATE).toEqual({ lifecycle: "created" });
  });

  it("[D2] lifecycle 词表类型锁：RunLifecycle 恰为四态 + interrupted（暂停态回归的类型锚——增删任一成员本 Equal 断言编译红）", () => {
    // 编译期穷尽锁（形态对齐 shared SUBAGENT_STATUS_COVERAGE_LOCK 先例）：
    // RunLifecycle 增删任一成员时本 Equal 断言编译红，强制显式重审词表。
    type Expect<T extends true> = T;
    type Equal<X, Y> =
      (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
    type _FourPlusInterruptedLock = Expect<
      Equal<
        RunLifecycle,
        "created" | "running" | "settling" | "interrupted" | "terminal"
      >
    >;
    const _lock: _FourPlusInterruptedLock = true;
    expect(_lock).toBe(true);
  });
});

// ── 转移表完整性（表是数据，不是散落分支）────────────────────

describe("转移表完整性", () => {
  it("每行的 from / on / next / outputs 全部落在词表内", () => {
    const lifecycles = new Set<string>(ALL_RUN_LIFECYCLES);
    const triggers = new Set<string>(ALL_TRIGGER_TYPES);
    const outputs = new Set<string>(TRANSITION_OUTPUT_TYPES);
    expect(RUN_TRANSITIONS.length).toBeGreaterThan(0);
    for (const rule of RUN_TRANSITIONS) {
      expect(lifecycles.has(rule.from)).toBe(true);
      expect(lifecycles.has(rule.next)).toBe(true);
      expect(triggers.has(rule.on)).toBe(true);
      expect(rule.outputs.length).toBeGreaterThan(0);
      for (const output of rule.outputs) {
        expect(outputs.has(output)).toBe(true);
      }
    }
  });

  it("(from, on, guard) 键无重复（guard 互斥性由运行时兜底守卫）", () => {
    const keys = RUN_TRANSITIONS.map((r) => `${r.from}|${r.on}|${r.guard ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("guard 只出现在 running × agent-settled 条件族", () => {
    for (const rule of RUN_TRANSITIONS) {
      if (rule.guard !== undefined) {
        expect(rule.from).toBe("running");
        expect(rule.on).toBe("agent-settled");
      }
    }
  });

  it("终局行 outcome 可解析（固定值或 run-settled 事件行）；非终局行不声明 terminalOutcome", () => {
    for (const rule of RUN_TRANSITIONS) {
      if (rule.next === "terminal") {
        expect(rule.terminalOutcome !== undefined || rule.on === "run-settled").toBe(true);
      } else {
        expect(rule.terminalOutcome).toBeUndefined();
      }
    }
  });

  it("表规模快照：15 行 / 14 个合法 (lifecycle × 事件) 组合 / 36 个表外组合（5 × 10 = 50 全积）——[D2] dispatched 并入 running、armed 三行随 [D5] 删、member-pool 三行随 [D6] 删、新增 run-interrupted 两行 + run-resumed 一行 + phase 三行", () => {
    expect(RUN_TRANSITIONS).toHaveLength(15);
    const legalKeys = new Set(RUN_TRANSITIONS.map((r) => `${r.from}|${r.on}`));
    expect(legalKeys.size).toBe(14);
    expect(ALL_RUN_LIFECYCLES.length * ALL_TRIGGER_TYPES.length).toBe(50);
    expect(50 - legalKeys.size).toBe(36);
  });

  it("[D2] interrupted 唯一出边 = run-resumed（暂停态无特例转移行、无 guard——终局/取消在 interrupted 态表外 fail-fast，非「终局了却没死透」）", () => {
    const rows = RUN_TRANSITIONS.filter((r) => r.from === "interrupted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.on).toBe("run-resumed");
    expect(rows[0]!.next).toBe("running");
    expect(rows[0]!.guard).toBeUndefined();
  });

  it("[D2] 中断转移行 outputs 仅 journal-append（中断非终局——不写 manifest 派生缓存、不发终局通知）", () => {
    for (const rule of RUN_TRANSITIONS.filter((r) => r.on === "run-interrupted")) {
      expect(rule.next).toBe("interrupted");
      expect(rule.outputs).toEqual(["journal-append"]);
    }
  });
});

// ── 转移表穷尽（全 lifecycle × 全 trigger 组合遍历）──────────

describe.each(ALL_RUN_LIFECYCLES)("转移表穷尽：lifecycle=%s", (lifecycle) => {
  for (const triggerType of ALL_TRIGGER_TYPES) {
    const rules = RUN_TRANSITIONS.filter((r) => r.from === lifecycle && r.on === triggerType);

    if (rules.length === 0) {
      it(`${triggerType} → 表外 fail-fast`, () => {
        expectIllegalTransition(stateOf(lifecycle), triggerSamples[triggerType]);
      });
      continue;
    }

    if (rules.length === 1 && rules[0].guard === undefined) {
      const rule = rules[0];
      it(`${triggerType} → ${rule.next}${rule.terminalOutcome ? `(${rule.terminalOutcome})` : ""}`, () => {
        const result = transition(stateOf(lifecycle), triggerSamples[triggerType]);
        expect(result.state.lifecycle).toBe(rule.next);
        expect(result.outputs).toEqual(rule.outputs);
        if (rule.next === "terminal") {
          const expected =
            rule.terminalOutcome ?? (triggerType === "run-settled" ? runSettledFailed.outcome : undefined);
          expect(result.state.outcome).toBe(expected);
        } else {
          // 非终局行不产生 outcome（两维正交不变量）
          expect(result.state.outcome).toBeUndefined();
        }
      });
      continue;
    }

    // 条件族（当前唯一 = running × agent-settled 二支）
    it(`${triggerType} 条件二支：ctx.enterSettling=true → settling（终局判定）`, () => {
      const result = transition(stateOf(lifecycle), triggerSamples[triggerType], {
        enterSettling: true,
      });
      expect(result.state.lifecycle).toBe("settling");
      expect(result.state.outcome).toBeUndefined();
      expect(result.outputs).toEqual(["journal-append"]);
    });
    it(`${triggerType} 条件二支：ctx 缺省 / false → running（fold 保守支）`, () => {
      for (const ctx of [undefined, { enterSettling: false }]) {
        const result = transition(stateOf(lifecycle), triggerSamples[triggerType], ctx);
        expect(result.state.lifecycle).toBe("running");
        expect(result.outputs).toEqual(["journal-append"]);
      }
    });
  }
});

// ── 终局与输出动作语义 ───────────────────────────────────────

describe("终局与输出动作语义", () => {
  it("terminal 是吸收态：任意事件 × 任意 outcome 全部 fail-fast", () => {
    for (const outcome of ALL_RUN_OUTCOMES) {
      for (const triggerType of ALL_TRIGGER_TYPES) {
        expectIllegalTransition({ lifecycle: "terminal", outcome }, triggerSamples[triggerType]);
      }
    }
  });

  it("run-settled 的 outcome 透传到终态（done / failed / cancelled / time_limited——[D2] 四值全贯通）", () => {
    const settling: RunLifecycleState = { lifecycle: "settling" };
    expect(transition(settling, runSettledCompleted).state).toEqual({
      lifecycle: "terminal",
      outcome: "done",
    });
    expect(transition(settling, runSettledFailed).state).toEqual({
      lifecycle: "terminal",
      outcome: "failed",
    });
    expect(transition(settling, runSettledCancelled).state).toEqual({
      lifecycle: "terminal",
      outcome: "cancelled",
    });
    expect(transition(settling, runSettledTimeLimited).state).toEqual({
      lifecycle: "terminal",
      outcome: "time_limited",
    });
  });

  it("[D2] run-interrupted 双活跃态 → interrupted（暂停态，无 outcome）；interrupted 态的终局/取消事件表外 fail-fast——非「终局了却没死透」，可 resume 是唯一出边", () => {
    for (const lifecycle of ["running", "settling"] as const) {
      const result = transition({ lifecycle }, runInterrupted);
      expect(result.state).toEqual({ lifecycle: "interrupted" });
      expect(result.state.outcome).toBeUndefined();
      expect(result.outputs).toEqual(["journal-append"]);
    }
    // interrupted 非终局：run-settled / cancel-requested 均表外（无特殊转移行、无 guard）
    expectIllegalTransition({ lifecycle: "interrupted" }, runSettledFailed);
    expectIllegalTransition({ lifecycle: "interrupted" }, triggerSamples["cancel-requested"]);
    // 复活唯一出边
    const resumed = transition({ lifecycle: "interrupted" }, runResumed);
    expect(resumed.state).toEqual({ lifecycle: "running" });
    expect(resumed.outputs).toEqual(["journal-append"]);
  });

  it("cancel-requested 双活跃态 → terminal(cancelled)，输出含 journal-append + manifest-write + notify", () => {
    for (const lifecycle of ["running", "settling"] as const) {
      const result = transition({ lifecycle }, triggerSamples["cancel-requested"]);
      expect(result.state).toEqual({ lifecycle: "terminal", outcome: "cancelled" });
      expect([...result.outputs]).toEqual(
        expect.arrayContaining(["journal-append", "manifest-write", "notify"]),
      );
    }
  });

  it("[W2 D2] 删值控制触发 host-died / abandon-elapsed 在全部 lifecycle 表外 fail-fast（词表缩窄后不可再驱动转移——中断转移改走 run-interrupted 收编入口）", () => {
    // cast 构造：触发类型已出词表，运行时旧调用方/旧数据仍可能投递——契约 =
    // 一律 IllegalTransitionError（不再有「静默判读为待恢复态」的旁路）
    const deadTriggers = [
      { type: "host-died" },
      { type: "abandon-elapsed" },
    ] as unknown as TransitionTrigger[];
    for (const lifecycle of ALL_RUN_LIFECYCLES) {
      for (const trigger of deadTriggers) {
        expectIllegalTransition(stateOf(lifecycle), trigger);
      }
    }
  });

  it("完整事件链 fold：created → running（phase 切换 + 含重试波）→ settling → terminal（run-settled 透传 outcome；[D3] phase 事件为 running 自环）", () => {
    const chain: TransitionTrigger[] = [
      runCreated,
      phaseStarted,
      agentStarted,
      agentRetrying,
      agentSettledFailed,
      agentSettledCompleted,
      phaseSettled,
      runSettledCompleted,
    ];
    let state = INITIAL_RUN_LIFECYCLE_STATE;
    for (const trigger of chain) {
      state = transition(state, trigger).state;
    }
    expect(state).toEqual({ lifecycle: "terminal", outcome: "done" });
  });

  it("cancel 路径 fold：record 里的合成 run-settled(cancelled) 把 running 直接收敛到 terminal", () => {
    // 控制事件不进 record——fold 只见 run-created / agent-started / run-settled
    const chain: TransitionTrigger[] = [runCreated, agentStarted, runSettledCancelled];
    let state = INITIAL_RUN_LIFECYCLE_STATE;
    for (const trigger of chain) {
      state = transition(state, trigger).state;
    }
    expect(state).toEqual({ lifecycle: "terminal", outcome: "cancelled" });
  });

  it("[D2] 中断-复活链 fold：running → interrupted → running（resume）→ terminal——暂停态可续跑的全链构造", () => {
    const chain: TransitionTrigger[] = [
      runCreated,
      agentStarted,
      runInterrupted,
      runResumed,
      runSettledCompleted,
    ];
    let state = INITIAL_RUN_LIFECYCLE_STATE;
    for (const trigger of chain) {
      state = transition(state, trigger).state;
    }
    expect(state).toEqual({ lifecycle: "terminal", outcome: "done" });
  });
});

// ── 纯函数边界 ───────────────────────────────────────────────

describe("transition 纯函数边界", () => {
  it("不读时钟、不取随机数（探针抛错法——ts 信封由调用侧补）", () => {
    const originalNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => {
      throw new Error("transition 不得读时钟（ts 信封由调用侧补）");
    };
    Math.random = () => {
      throw new Error("transition 不得取随机数");
    };
    try {
      transition(INITIAL_RUN_LIFECYCLE_STATE, runCreated);
      transition({ lifecycle: "running" }, agentSettledFailed, { enterSettling: true });
      transition({ lifecycle: "running" }, triggerSamples["cancel-requested"]);
      // fail-fast 路径同样不碰时钟
      expectIllegalTransition({ lifecycle: "terminal", outcome: "done" }, runCreated);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

// ── record 实装（createRunEventJournal）─────────────────────

describe("record 实装（createRunEventJournal，临时目录自建自删）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-events-journal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("append → scan 往返等价（写入序保持 + seq 分配覆盖入参）", async () => {
    const journal = createRunEventJournal(dir);
    const events: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      agentStarted,
      agentRetrying,
      agentSettledFailed,
      runSettledFailed,
    ];
    for (const event of events) {
      await journal.append("wf-1758-a1", event);
    }
    const scanned = await journal.scan("wf-1758-a1");
    // [W1] append 分配的 seq 覆盖入参携带值（构造性单调：末水位 + 1）——样本
    // 自带 seq 与分配序刻意不同（末位样本 11 ≠ 分配 6），恰好钉死「分配权在
    // journal 实装、入参 seq 被无视」的契约
    expect(scanned.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // 剥离 seq 后载荷逐字段一致（零漂移）
    expect(scanned.map(({ seq: _s, ...rest }) => rest)).toEqual(
      events.map(({ seq: _s, ...rest }) => rest),
    );
  });

  it("文件落在 <dir>/<runId>.record.jsonl（[D1] record 单源流后缀；runId 自带 wf- 前缀）", async () => {
    const journal = createRunEventJournal(dir);
    await journal.append("wf-1758-a1", runCreated);
    expect(existsSync(join(dir, "wf-1758-a1.record.jsonl"))).toBe(true);
  });

  it("scan 不存在的 run → 空数组（未落账 / 已过保留期清理）", async () => {
    await expect(createRunEventJournal(dir).scan("wf-never")).resolves.toEqual([]);
  });

  it("多个 run 按 runId 隔离", async () => {
    const journal = createRunEventJournal(dir);
    await journal.append("wf-run-a", runCreated);
    await journal.append("wf-run-b", agentRetrying);
    // 各 run 独立分配 seq（首条各自为 1）
    const a = await journal.scan("wf-run-a");
    const b = await journal.scan("wf-run-b");
    expect(a.map(stripSeq)).toEqual([stripSeq(runCreated)]);
    expect(a[0]!.seq).toBe(1);
    expect(b.map(stripSeq)).toEqual([stripSeq(agentRetrying)]);
    expect(b[0]!.seq).toBe(1);
  });

  it("目录惰性自建：append 到不存在的目录链成功且可读回", async () => {
    const journal = createRunEventJournal(join(dir, "workflow-state"));
    await journal.append("wf-nested-1", runCreated);
    await expect(journal.scan("wf-nested-1")).resolves.toEqual([runCreated]);
  });

  it("坏行容错：垃圾行与词表外 type 行跳过并计数 warn，好行照常返回", async () => {
    const runId = "wf-bad-lines";
    writeFileSync(
      join(dir, `${runId}.record.jsonl`),
      [
        JSON.stringify(runCreated), // 好
        "{not json", // 坏：非法 JSON
        JSON.stringify(agentRetrying), // 好
        JSON.stringify({ type: "future-event", ts: 1 }), // 坏：词表外 type（词表漂移形态）
        JSON.stringify(runSettledCompleted), // 好
        "", // 尾部空行（写入行尾换行的正常形态）
      ].join("\n"),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await createRunEventJournal(dir).scan(runId);
      expect(events).toEqual([runCreated, agentRetrying, runSettledCompleted]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // 计数落日志（含坏行数与文件路径）
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain("2");
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain(`${runId}.record.jsonl`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("路径穿越拒绝：append 与 scan 双侧校验 runId", async () => {
    const journal = createRunEventJournal(dir);
    const evilRunIds = [
      "../evil", // 父目录逃逸
      "a/b", // 子路径注入
      "..", // 父目录
      "", // 空
      ".hidden", // 隐藏文件形态（首字符非字母数字）
      "wf-x\\y", // Windows 分隔符
      `${"x".repeat(129)}`, // 超长
    ];
    for (const runId of evilRunIds) {
      await expect(journal.append(runId, runCreated)).rejects.toThrow(/非法 runId/);
      await expect(journal.scan(runId)).rejects.toThrow(/非法 runId/);
    }
    // 未发生穿越副作用
    expect(existsSync(join(dir, "evil.record.jsonl"))).toBe(false);
    expect(existsSync(join(tmpdir(), "evil.record.jsonl"))).toBe(false);
  });

  // ── [W1] seq 单调分配（设计目标 4：W2 通知去重键的行身份载体）──────────

  it("append 返回含分配 seq 的完整事件，连续 append 严格递增", async () => {
    const journal = createRunEventJournal(dir);
    const first = await journal.append("wf-seq-1", { ...stripSeq(runCreated), runId: "wf-seq-1" });
    expect(first.seq).toBe(1);
    expect(first.type).toBe("run-created");
    const second = await journal.append("wf-seq-1", stripSeq(agentStarted));
    expect(second.seq).toBe(2);
    const third = await journal.append("wf-seq-1", stripSeq(agentRetrying));
    expect(third.seq).toBe(3);
  });

  it("重启续号：新 journal 实例（同目录）首 append 探测文件尾续号，不重号", async () => {
    const first = createRunEventJournal(dir);
    await first.append("wf-seq-2", stripSeq(runCreated));
    await first.append("wf-seq-2", stripSeq(agentStarted));
    // 「重启」= 新实例（进程内缓存 lastSeqByRunId 不跨实例——正确性靠文件尾探测）
    const second = createRunEventJournal(dir);
    const appended = await second.append("wf-seq-2", stripSeq(agentRetrying));
    expect(appended.seq).toBe(3);
  });

  it("seq 坏值行（0 / 负数 / 非整数 / 字符串）按坏行跳过，好行照常返回", async () => {
    const runId = "wf-seq-bad";
    writeFileSync(
      join(dir, `${runId}.record.jsonl`),
      [
        JSON.stringify({ ...stripSeq(runCreated), runId, seq: 0 }), // 坏：非正整数
        JSON.stringify({ ...stripSeq(agentStarted), seq: -1 }), // 坏：负数
        JSON.stringify({ ...stripSeq(agentRetrying), seq: 1.5 }), // 坏：非整数
        JSON.stringify({ ...stripSeq(phaseStarted), seq: "1" }), // 坏：字符串
        JSON.stringify({ ...stripSeq(agentSettledFailed), seq: 1 }), // 好
      ].join("\n"),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await createRunEventJournal(dir).scan(runId);
      expect(events.map((e) => e.type)).toEqual(["agent-settled"]);
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain("4");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("[W1 存量兼容读] 无 seq 的旧格式行放行（旧行为不变）+ fold 应用不推进水位 + 追加新行从 1 起号", async () => {
    const runId = "wf-seq-legacy";
    // W1 前的 record 形态（无 seq 字段；末行补换行——真实 record 每行 append 自带）
    writeFileSync(
      join(dir, `${runId}.record.jsonl`),
      [
        JSON.stringify(stripSeq(runCreated)),
        JSON.stringify(stripSeq(agentStarted)),
      ].join("\n") + "\n",
      "utf8",
    );
    const journal = createRunEventJournal(dir);
    // 旧格式行照常解析（D7 惰性兼容读——scan 放行，事件流可 fold）
    const scanned = await journal.scan(runId);
    expect(scanned.map((e) => e.type)).toEqual(["run-created", "agent-started"]);
    // fold：旧格式行正常应用（不跳过）但不推进水位（lastSeq 保持 0）
    const checkpoint = foldRunEventCheckpoint(scanned, () => {
      throw new Error("旧格式行不该被判坏帧");
    });
    expect(checkpoint.state).toEqual({ lifecycle: "running" });
    expect(checkpoint.lastSeq).toBe(0);
    // 追加新行从 1 起号（旧文件 maxSeq=0）；「带 seq 的行」从此严格递增
    const appended = await journal.append(runId, stripSeq(runSettledFailed));
    expect(appended.seq).toBe(1);
    // 混合 fold：旧行不跳过 + 新行 seq 守卫生效——重放去重不误伤旧行
    const mixed = await journal.scan(runId);
    expect(foldRunEventCheckpoint(mixed, () => {}).state).toEqual({
      lifecycle: "terminal",
      outcome: "failed",
    });
  });
});

// ── 删值后历史行兼容（词表缩窄前落账的存量 record 行）──────────
//
// [D2]/[D4]/[D5]/[D6] 词表重构的读侧契约：删值成员（armed / member-pool——
// [D5]/[D6] 删除；旧 ask-* 前缀行——[D4] 改名）的历史行经 scan 的词表外坏行
// 路径跳过 + 计数 warn（保守可诊断，不炸投影）；[D1] 历史数据处置——旧词表
// 历史行不进入任何解析路径、无兼容读。崩溃残留流（事件流停在非 terminal 的
// 未终局 run）不因词表缩窄产生坏帧——fold 停在最近一致态，注册表投影相
// （run-registry「fold 停在非 terminal」判读）照常工作。

describe("删值后历史行兼容（存量 record 行可解析或跳过计日志）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-events-legacy-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 删值成员历史行 fixture（[D4]/[D5]/[D6] 词表重构前成员的真实落账形态——字符串直写，不经现词表类型）。 */
  const legacyDeletedMemberLines = [
    JSON.stringify({
      type: "armed",
      seq: 2,
      ts: TS + 5,
      frame: { engine: "pi", armed: true },
    }),
    JSON.stringify({
      type: "member-pool",
      seq: 4,
      ts: TS + 15,
      action: "register",
      name: "reviewer-security",
      recordId: "sa-wf-member-1",
    }),
    JSON.stringify({
      type: "ask-settled",
      seq: 6,
      ts: TS + 51_000,
      taskIndex: 0,
      attempt: 2,
      outcome: "completed",
      durationMs: 21_000,
    }),
  ];

  it("armed / member-pool / 旧 ask-* 前缀历史行按词表外坏行跳过 + 计数 warn，保留行照常返回且可 fold 至 terminal", async () => {
    const runId = "wf-legacy-deleted";
    writeFileSync(
      join(dir, `${runId}.record.jsonl`),
      [
        JSON.stringify(runCreated), // 好（保留成员）
        ...legacyDeletedMemberLines, // 删值/改名成员历史行 → 跳过计日志
        JSON.stringify(runSettledCompleted), // 好
      ].join("\n"),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await createRunEventJournal(dir).scan(runId);
      expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // 计数落日志（含坏行数与文件路径——排障可定位到具体 record 流）
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain("3");
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain(`${runId}.record.jsonl`);
      // 好行 fold 照常收敛（历史残行不阻塞终局投影）
      const checkpoint = foldRunEventCheckpoint(events, () => {
        throw new Error("保留成员行不该被判坏帧");
      });
      expect(checkpoint.state).toEqual({ lifecycle: "terminal", outcome: "done" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("崩溃残留流（事件流停在非 terminal 的未终局 run）fold 停最近一致态、零坏帧出声", async () => {
    // 崩溃 run 的 record 形态：无终态帧，事件流停在 running——词表缩窄后全部
    // 行仍可解析，fold 停在 running（注册表投影相 interrupted 判读的输入形态）
    const runId = "wf-legacy-orphan";
    writeFileSync(
      join(dir, `${runId}.record.jsonl`),
      [JSON.stringify(runCreated), JSON.stringify(agentStarted)].join("\n"),
      "utf8",
    );
    const events = await createRunEventJournal(dir).scan(runId);
    const broken: string[] = [];
    const checkpoint = foldRunEventCheckpoint(events, (_err, lastType) => broken.push(lastType));
    expect(broken).toEqual([]);
    expect(checkpoint.state).toEqual({ lifecycle: "running" });
  });

  it("[D2] 中断转移帧已在盘的残留流 fold 停 interrupted 暂停态（非终局——resume 可续的全链输入形态）", async () => {
    const runId = "wf-legacy-interrupted";
    writeFileSync(
      join(dir, `${runId}.record.jsonl`),
      [JSON.stringify(runCreated), JSON.stringify(agentStarted), JSON.stringify(runInterrupted)].join("\n"),
      "utf8",
    );
    const events = await createRunEventJournal(dir).scan(runId);
    const broken: string[] = [];
    const checkpoint = foldRunEventCheckpoint(events, (_err, lastType) => broken.push(lastType));
    expect(broken).toEqual([]);
    expect(checkpoint.state).toEqual({ lifecycle: "interrupted" });
  });
});

// ── [W1] fold 检查点（seq 守卫：tail 截断重建后全量重读的幂等去重）──────────

describe("foldRunEventCheckpoint（seq 守卫，D6 域 fold 去重）", () => {
  const noop = (): void => {};

  it("全量重放同一事件序列产出逐字段相等 checkpoint（纯函数幂等；[D3] phase 骨架与 [D2] 中断投影随链产出）", () => {
    const events: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      agentStarted,
      agentSettledCompleted,
      phaseSettled,
      runSettledCompleted,
    ];
    const once = foldRunEventCheckpoint(events, noop);
    const twice = foldRunEventCheckpoint(events, noop);
    expect(twice).toEqual(once);
    expect(once.state).toEqual({ lifecycle: "terminal", outcome: "done" });
    expect(once.lastSeq).toBe(11);
    // [D3] phase 状态机投影半边：startedAt/settledAt 随转移事件落投影（settledBy
    // "frame"——phase-settled 帧值，不参与对称自愈的推导翻回）
    expect(once.phases.get("review")).toEqual({
      phase: "review",
      startedAt: TS + 5,
      settledAt: TS + 130_000,
      settledBy: "frame",
    });
  });

  it("seq ≤ 水位的事件按重放跳过：以既有 checkpoint 为初值重放全量流，不重复应用", () => {
    // 「截断重建后的幂等全量重读」形态：先消费前 3 条 → 再全量重读（前 3 条重放）
    const events: WorkflowRunEvent[] = [runCreated, phaseStarted, agentStarted, agentRetrying, agentSettledFailed, runSettledFailed];
    const first = foldRunEventCheckpoint(events.slice(0, 3), noop);
    expect(first.state).toEqual({ lifecycle: "running" });
    // 重放全量：前 3 条（seq ≤ 水位 3）跳过，后 3 条照常应用——终态正确收敛
    const full = foldRunEventCheckpoint(events, noop, first);
    expect(full.state).toEqual({ lifecycle: "terminal", outcome: "failed" });
    expect(full.lastSeq).toBe(11);
  });

  it("seq 跳号（gap）宽容放行——外部编辑形态不炸投影", () => {
    const gapped: WorkflowRunEvent[] = [
      { ...runCreated, seq: 1 },
      { ...agentStarted, seq: 5 },
      { ...runSettledCompleted, seq: 9 },
    ];
    const checkpoint = foldRunEventCheckpoint(gapped, noop);
    expect(checkpoint.state).toEqual({ lifecycle: "terminal", outcome: "done" });
    expect(checkpoint.lastSeq).toBe(9);
  });

  it("坏帧保守停在最近一致态（onBrokenFrame 出声后截断，水位保持已接受值）", () => {
    // [D2] 后 running × agent-settled 是表内转移（不传 ctx 走 more-work-expected
    // 保守支留 running）——坏帧构造改用 interrupted 态的表外事件（interrupted ×
    // run-settled 非法：暂停态唯一出边是 run-resumed）
    const chain: WorkflowRunEvent[] = [runCreated, agentStarted, runInterrupted];
    const checkpoint0 = foldRunEventCheckpoint(chain, () => {
      throw new Error("前置链不该被判坏帧");
    });
    expect(checkpoint0.state).toEqual({ lifecycle: "interrupted" });
    const broken: WorkflowRunEvent[] = [...chain, runSettledFailed];
    const seen: string[] = [];
    const checkpoint = foldRunEventCheckpoint(broken, (_err, lastType) => {
      seen.push(lastType);
    });
    expect(seen).toEqual(["run-settled"]);
    expect(checkpoint.state).toEqual({ lifecycle: "interrupted" });
    expect(checkpoint.lastSeq).toBe(8); // 水位保持已接受值（中断帧 seq）
  });

  it("[D3] fold 自愈：phase-started 转移事件缺失（postMessage 异步丢失窗口）时，按 agent-started 载荷的 phase 字段驱动 pending → running——缺失不判损坏", () => {
    const chain: WorkflowRunEvent[] = [runCreated, agentStarted, agentSettledCompleted];
    const checkpoint = foldRunEventCheckpoint(chain, () => {
      throw new Error("转移事件缺失窗口不该被判坏帧");
    });
    expect(checkpoint.state).toEqual({ lifecycle: "running" });
    // agent-started.phase 缺省（样本无 phase 字段）——无 phase 归属不造键
    expect(checkpoint.phases.size).toBe(0);
    // 携带 phase 归属的 agent-started 在场而无 phase-started → 自愈重建 phase 行
    const withPhase: WorkflowRunEvent = { ...agentStarted, phase: "impl" };
    const healed = foldRunEventCheckpoint([runCreated, withPhase], () => {
      throw new Error("转移事件缺失窗口不该被判坏帧");
    });
    expect(healed.phases.get("impl")).toEqual({ phase: "impl", startedAt: TS + 10 });
    expect(healed.state).toEqual({ lifecycle: "running" });
  });

  it("[D3 对称自愈] phase-settled 帧缺失：该 phase 在场 call 全部落定 → 按 agent-settled 帧行推导 phase 终局（行存在即权威）", () => {
    const chain: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      { ...agentStarted, phase: "review" },
      { ...agentSettledCompleted, taskIndex: 0, ts: TS + 120_000 },
    ];
    const checkpoint = foldRunEventCheckpoint(chain, () => {
      throw new Error("phase-settled 帧缺失（postMessage 异步丢失窗口）不该被判坏帧");
    });
    expect(checkpoint.state).toEqual({ lifecycle: "running" });
    expect(checkpoint.phases.get("review")).toEqual({
      phase: "review",
      startedAt: TS + 5,
      settledAt: TS + 120_000,
      settledBy: "derived",
    });
  });

  it("[D3 对称自愈] resume 重放：run-interrupted → run-resumed → 新 phase-started 重置后，崩溃前已完成的 phase 收束保持（缓存回话零新帧的恢复通道）", () => {
    const chain: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      { ...agentStarted, phase: "review" },
      { ...agentSettledCompleted, taskIndex: 0, ts: TS + 120_000 },
      phaseSettled,
      { ...runInterrupted, seq: 30 },
      { ...runResumed, seq: 31 },
      // resume 后脚本确定性重放重新执行 phase() 落新 phase-started 帧（taskIndex
      // 0 命中缓存回话，不落新 agent 事件——设计 D3「持久修复通道」）
      { ...phaseStarted, seq: 32, ts: TS + 300_000 },
    ];
    const checkpoint = foldRunEventCheckpoint(chain, () => {
      throw new Error("resume 重放形态不该被判坏帧");
    });
    expect(checkpoint.state).toEqual({ lifecycle: "running" });
    expect(checkpoint.phases.get("review")).toEqual({
      phase: "review",
      // startedAt 随重放 phase-started 更新；收束由对称自愈按已落定 call 行恢复
      startedAt: TS + 300_000,
      settledAt: TS + 120_000,
      settledBy: "derived",
    });
  });

  it("[D3 对称自愈] 同名义真重入：新 agent-started 到达 → 推导值翻回 running；新 call 落定后再度推导收束（推导态不是吸收态）", () => {
    const round1: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      { ...agentStarted, phase: "review" },
      { ...agentSettledCompleted, taskIndex: 0, ts: TS + 120_000 },
      // 同名义新一轮 phase-started：先瞬态推导为收束（与 resume 重放不可区分）
      { ...phaseStarted, seq: 10, ts: TS + 200_000 },
    ];
    const mid = foldRunEventCheckpoint(round1, () => {});
    expect(mid.phases.get("review")?.settledBy).toBe("derived");
    // 首个新 agent-started 到达 → 翻回 running
    const withNewCall = foldRunEventCheckpoint(
      [...round1, { ...agentStarted, seq: 11, ts: TS + 210_000, taskIndex: 1, phase: "review" }],
      () => {},
    );
    expect(withNewCall.phases.get("review")).toEqual({ phase: "review", startedAt: TS + 200_000 });
    // 新 call 落定 → 再度推导收束
    const settledAgain = foldRunEventCheckpoint(
      [
        ...round1,
        { ...agentStarted, seq: 11, ts: TS + 210_000, taskIndex: 1, phase: "review" },
        { ...agentSettledCompleted, seq: 12, ts: TS + 250_000, taskIndex: 1 },
      ],
      () => {},
    );
    expect(settledAgain.phases.get("review")).toEqual({
      phase: "review",
      startedAt: TS + 200_000,
      settledAt: TS + 250_000,
      settledBy: "derived",
    });
  });

  it("[D3 对称自愈] 重试在途：agent-retrying 使推导值翻回 running（call 行携上一次尝试的旧 settled，判据按 treatAsRunning）；phase-settled 帧值不参与翻回", () => {
    const chain: WorkflowRunEvent[] = [
      runCreated,
      phaseStarted,
      { ...agentStarted, phase: "review" },
      { ...agentSettledCompleted, taskIndex: 0, ts: TS + 120_000 },
    ];
    const derived = foldRunEventCheckpoint(chain, () => {});
    expect(derived.phases.get("review")?.settledBy).toBe("derived");
    const retrying = foldRunEventCheckpoint(
      [...chain, { ...agentRetrying, seq: 10, ts: TS + 130_000, taskIndex: 0 }],
      () => {},
    );
    expect(retrying.phases.get("review")?.settledAt).toBeUndefined();
    // 帧值（settledBy "frame"）随后到 phase-settled 落位后，agent 事件不再翻回
    const framed = foldRunEventCheckpoint([...chain, { ...phaseSettled, seq: 11 }], () => {});
    expect(framed.phases.get("review")).toEqual({
      phase: "review",
      startedAt: TS + 5,
      settledAt: TS + 130_000,
      settledBy: "frame",
    });
    const framedThenRetry = foldRunEventCheckpoint(
      [...chain, { ...phaseSettled, seq: 11 }, { ...agentRetrying, seq: 12, ts: TS + 140_000, taskIndex: 0 }],
      () => {},
    );
    expect(framedThenRetry.phases.get("review")?.settledAt).toBe(TS + 130_000);
  });

  it("[D2] 中断/复活投影：interrupted / resumed 骨架半边随转移事件产出（D10 预算算式的切段边界数据源）", () => {
    const chain: WorkflowRunEvent[] = [
      runCreated,
      agentStarted,
      runInterrupted,
      runResumed,
    ];
    const checkpoint = foldRunEventCheckpoint(chain, () => {
      throw new Error("转移事件不该被判坏帧");
    });
    expect(checkpoint.interrupted).toEqual({ errorCode: "crashed", reason: "process killed", ts: TS + 125_000 });
    expect(checkpoint.resumed).toEqual({ reason: "resume requested", host: "pi-host-1", ts: TS + 200_000 });
    expect(checkpoint.state).toEqual({ lifecycle: "running" });
  });
});

// ── DoneReason 终止性判定（词表语义单点；消费方 = 壳 workflow-notify 防偷懒收尾指令）──

describe("isTerminalDoneReason", () => {
  it("全词表表驱动：completed 唯一非终止性，其余成员均为终止性", () => {
    const expected: Record<string, boolean> = {
      completed: false,
      failed: true,
      aborted: true,
      budget_limited: true,
      time_limited: true,
    };
    // ALL_DONE_REASONS 是词表 SSOT——遍历它而非本地重抄，词表增删成员时本用例自适应
    for (const reason of ALL_DONE_REASONS) {
      expect(isTerminalDoneReason(reason)).toBe(expected[reason]);
    }
  });

  it("期望表与词表零差集（词表新增成员时本用例红——强制在此显式归类）", () => {
    const expectedMembers = [
      "completed",
      "failed",
      "aborted",
      "budget_limited",
      "time_limited",
    ];
    expect([...ALL_DONE_REASONS].sort()).toEqual([...expectedMembers].sort());
  });
});

// ── [W2 D5 → D2] DoneReason → RunOutcome 映射表定稿（五值逐行全表）──────────

describe("doneReasonToRunOutcome 映射表定稿（[D2] time_limited 升格后全表）", () => {
  // 期望表 = run-events.ts 映射注释定稿表的逐行镜像；err 面只断言 mapping 行，
  // errorCode 承载行的取值由 finalRunErrorCodeOf 单测域覆盖（stderr-tee 等）。
  const expectedRows: Record<string, RunOutcome> = {
    completed: "done", // 成功（[D2] completed→done 同词贯穿）
    failed: "failed", // 执行失败（errorCode 承载因提取）
    aborted: "cancelled", // 用户主动取消
    budget_limited: "failed", // 预算耗尽 = 用户视角的诚实失败归因（errorCode='budget_limited'）
    time_limited: "time_limited", // [D2] 活体墙钟预算超时升格独立 outcome（无码）
  };

  it("五值逐行与定稿表一致", () => {
    for (const reason of ALL_DONE_REASONS) {
      expect(doneReasonToRunOutcome(reason)).toBe(expectedRows[reason]);
    }
  });

  it("期望表与 DoneReason 词表零差集（词表新增成员时本用例红——强制先改定稿表再扩词表）", () => {
    expect(Object.keys(expectedRows).sort()).toEqual([...ALL_DONE_REASONS].sort());
  });

  it("[D2] interrupted 不在 outcome 词表（移出入 lifecycle 暂停态——「终局了却没死透」矛盾消除）；time_limited ∈ outcome 且新写入方无码（RunErrorCode 成员保留为历史帧解析）", () => {
    expect(ALL_RUN_OUTCOMES).not.toContain("interrupted");
    expect(ALL_RUN_OUTCOMES).toContain("time_limited");
    const idleEvicted: RunErrorCode = "idle-evicted";
    expect(idleEvicted).toBe("idle-evicted");
    const timeLimitedCode: RunErrorCode = "time_limited";
    expect(timeLimitedCode).toBe("time_limited");
  });
});
