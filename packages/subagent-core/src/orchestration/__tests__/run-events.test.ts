// run-events.test.ts —— run 事件词表 / 状态机 / journal 的测试（设计 §3.3 D5）。
//
// 覆盖：
// - 词表断言：RUN_EVENT_TYPES 恰好 7 个（无 world-run 族——taiji 脚本 API 面无
//   子进程调用通道）；ALL_RUN_OUTCOMES 三态正交
// - 判别联合 exhaustive：switch 全 7 分支、无 default 吞噬（never 穷尽性断言——
//   编译期由 tsc --noEmit 把关，运行期用样本事件核对分支映射）
// - 载荷形状：7 类样本事件逐字段断言（ask-settled / run-settled 各含成功与失败
//   两形态）
// - journal 接口形态：最小内存 fake 验证 append/scan 可实现且调用形状成立
// - 状态机：词表 / 转移表穷尽（全 lifecycle × 全 trigger 组合遍历——表是可枚举
//   数据，不是散落 case）/ 终局与输出动作语义 / 纯函数边界（时钟随机探针）
// - journal 实装：append→scan 往返等价 / 坏行容错 / 路径穿越拒绝（临时目录
//   mkdtempSync 自建自删，符合测试红线）
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALL_RUN_LIFECYCLES,
  ALL_RUN_OUTCOMES,
  CONTROL_TRIGGER_TYPES,
  foldRunEventCheckpoint,
  INITIAL_RUN_STATE,
  RUN_EVENT_TYPES,
  RUN_TRANSITIONS,
  TRANSITION_OUTPUT_TYPES,
  createRunEventJournal,
  transition,
  IllegalTransitionError,
  type AskSettledEvent,
  type ControlTriggerType,
  type RunErrorCode,
  type RunEventJournal,
  type RunEventType,
  type RunLifecycle,
  type RunState,
  type TransitionTrigger,
  type WorkflowRunEvent,
} from "../run-events.ts";
import { ALL_DONE_REASONS, isTerminalDoneReason } from "../models/types.ts";

// ── 样本事件（覆盖全部 7 个 type；路径值均为 fixture 假路径）────
//
// [W1] seq 信封：样本按全链时序取 1..8（与 append 分配序一致——journal 实装
// 用例的「append → scan 往返等价」直接复用样本数组断言）。

const TS = 1_758_000_000_000;

const runCreated: WorkflowRunEvent = {
  type: "run-created",
  seq: 1,
  ts: TS,
  runId: "wf-1758-a1",
  workflowName: "review-fix-loop",
  argsSummary: '{"pr":"#123"}',
};

const askDispatched: WorkflowRunEvent = {
  type: "ask-dispatched",
  seq: 3,
  ts: TS + 10,
  taskIndex: 0,
  agentName: "reviewer-security",
  attempt: 1,
};

const askExecuting: WorkflowRunEvent = {
  type: "ask-executing",
  seq: 4,
  ts: TS + 20,
  taskIndex: 0,
  agentName: "reviewer-security",
  attempt: 1,
};

const askRetrying: WorkflowRunEvent = {
  type: "ask-retrying",
  seq: 5,
  ts: TS + 30_000,
  taskIndex: 0,
  attempt: 1,
  backoffMs: 1000,
  reason: "provider 503",
};

const askSettledFailed: AskSettledEvent = {
  type: "ask-settled",
  seq: 6,
  ts: TS + 51_000,
  taskIndex: 0,
  attempt: 2,
  outcome: "failed",
  errorCode: "engine_crashed",
  durationMs: 21_000,
  stderrTeePath: "/journal-fixture/wf-1758-a1/ask-0-attempt-2.stderr.log",
};

const askSettledCompleted: AskSettledEvent = {
  type: "ask-settled",
  seq: 7,
  ts: TS + 120_000,
  taskIndex: 1,
  attempt: 1,
  outcome: "completed",
  durationMs: 65_000,
};

const armed: WorkflowRunEvent = {
  type: "armed",
  seq: 2,
  ts: TS + 5,
  frame: { engine: "pi", armed: true },
};

const runSettledFailed: WorkflowRunEvent = {
  type: "run-settled",
  seq: 8,
  ts: TS + 180_000,
  outcome: "failed",
  errorCode: "engine_crashed",
  reason: "all ask waves failed",
  artifactsDir: "/journal-fixture/wf-1758-a1",
};

const runSettledCompleted: WorkflowRunEvent = {
  type: "run-settled",
  seq: 8,
  ts: TS + 240_000,
  outcome: "completed",
  artifactsDir: "/journal-fixture/wf-1758-a1",
};

const runSettledCancelled: WorkflowRunEvent = {
  type: "run-settled",
  seq: 8,
  ts: TS + 90_000,
  outcome: "cancelled",
  reason: "user abort",
  artifactsDir: "/journal-fixture/wf-1758-a1",
};

// ── 穷尽性处理样例 ────────────────────────────────────────────

/** 剥离 seq 的载荷投影（seq 分配断言与载荷断言解耦用）。 */
function stripSeq<T extends { seq: number }>(event: T): Omit<T, "seq"> {
  const { seq: _s, ...rest } = event;
  return rest;
}

/**
 * switch 覆盖全部 7 个 type 且无 default 分支——switch 之后 event 只剩 never，
 * 对其赋值即穷尽性断言：词表新增成员时该行编译失败（tsc 把关），强制同步扩展
 * 本处理样例。返回分支标记供运行期核对样本事件各命中唯一分支。
 */
function labelOf(event: WorkflowRunEvent): string {
  switch (event.type) {
    case "run-created":
      return `run-created:${event.workflowName}`;
    case "ask-dispatched":
      return `ask-dispatched:${event.taskIndex}:${event.attempt}`;
    case "ask-executing":
      return `ask-executing:${event.taskIndex}:${event.attempt}`;
    case "ask-retrying":
      return `ask-retrying:${event.taskIndex}:${event.backoffMs}`;
    case "ask-settled":
      return `ask-settled:${event.outcome}:${event.errorCode ?? "none"}`;
    case "armed":
      return "armed";
    case "run-settled":
      return `run-settled:${event.outcome}:${event.errorCode ?? "none"}`;
  }
  const _exhaustive: never = event;
  return _exhaustive;
}

// ── 词表 ─────────────────────────────────────────────────────

describe("事件词表（D5）", () => {
  it("RUN_EVENT_TYPES 恰好 7 个成员（无 world-run 族——脚本 API 面无子进程调用通道）", () => {
    expect(RUN_EVENT_TYPES).toEqual([
      "run-created",
      "ask-dispatched",
      "ask-executing",
      "ask-retrying",
      "ask-settled",
      "armed",
      "run-settled",
    ]);
  });

  it("ALL_RUN_OUTCOMES 三态正交（completed / failed / cancelled）", () => {
    expect(ALL_RUN_OUTCOMES).toEqual(["completed", "failed", "cancelled"]);
  });

  it("RunErrorCode 承载三族词表（编译期赋值由 tsc 把关）", () => {
    // 引擎固定码 + engine_ 前缀透传码 + 失败分类（classifyFailureKind 词表）
    // + run 级终局码（budget_limited/time_limited，dispatchFinalRunSettle 恒等映射族）
    const codes: RunErrorCode[] = [
      "engine_crashed",
      "engine_probe_failed",
      "engine_custom_future",
      "stale_context",
      "schema_deterministic",
      "unknown",
      "budget_limited",
      "time_limited",
    ];
    expect(codes).toHaveLength(8);
  });
});

// ── 判别联合穷尽性 ───────────────────────────────────────────

describe("判别联合 exhaustive（无 default 吞噬）", () => {
  it("7 类样本事件各命中唯一分支，标记与预期一致", () => {
    const samples: WorkflowRunEvent[] = [
      runCreated,
      askDispatched,
      askExecuting,
      askRetrying,
      askSettledFailed,
      armed,
      runSettledFailed,
    ];
    expect(samples.map(labelOf)).toEqual([
      "run-created:review-fix-loop",
      "ask-dispatched:0:1",
      "ask-executing:0:1",
      "ask-retrying:0:1000",
      "ask-settled:failed:engine_crashed",
      "armed",
      "run-settled:failed:engine_crashed",
    ]);
  });

  it("样本事件 type 全部落在词表内（词表与联合成员一致）", () => {
    const samples: WorkflowRunEvent[] = [
      runCreated,
      askDispatched,
      askExecuting,
      askRetrying,
      askSettledFailed,
      askSettledCompleted,
      armed,
      runSettledFailed,
      runSettledCompleted,
    ];
    expect(new Set(samples.map((e) => e.type))).toEqual(new Set(RUN_EVENT_TYPES));
  });
});

// ── 载荷形状 ─────────────────────────────────────────────────

describe("载荷形状（D5 载荷表）", () => {
  it("run-created：runId / workflowName / argsSummary / model 引用", () => {
    expect(runCreated).toEqual({
      type: "run-created",
      seq: 1,
      ts: TS,
      runId: "wf-1758-a1",
      workflowName: "review-fix-loop",
      argsSummary: '{"pr":"#123"}',
    });
  });

  it("ask-dispatched / ask-executing：agentName / attempt / taskIndex", () => {
    expect(askDispatched).toEqual({
      type: "ask-dispatched",
      seq: 3,
      ts: TS + 10,
      taskIndex: 0,
      agentName: "reviewer-security",
      attempt: 1,
    });
    expect(askExecuting).toEqual({
      type: "ask-executing",
      seq: 4,
      ts: TS + 20,
      taskIndex: 0,
      agentName: "reviewer-security",
      attempt: 1,
    });
  });

  it("ask-retrying：attempt / backoffMs / reason", () => {
    expect(askRetrying).toEqual({
      type: "ask-retrying",
      seq: 5,
      ts: TS + 30_000,
      taskIndex: 0,
      attempt: 1,
      backoffMs: 1000,
      reason: "provider 503",
    });
  });

  it("ask-settled 失败形态：outcome / errorCode / durationMs + 诊断引用（stderrTeePath）", () => {
    expect(askSettledFailed).toEqual({
      type: "ask-settled",
      seq: 6,
      ts: TS + 51_000,
      taskIndex: 0,
      attempt: 2,
      outcome: "failed",
      errorCode: "engine_crashed",
      durationMs: 21_000,
      stderrTeePath: "/journal-fixture/wf-1758-a1/ask-0-attempt-2.stderr.log",
    });
  });

  it("ask-settled 成功形态：errorCode / stderrTeePath 缺省", () => {
    expect(askSettledCompleted).toEqual({
      type: "ask-settled",
      seq: 7,
      ts: TS + 120_000,
      taskIndex: 1,
      attempt: 1,
      outcome: "completed",
      durationMs: 65_000,
    });
  });

  it("armed：武装确认帧内容占位（frame）", () => {
    expect(armed).toEqual({
      type: "armed",
      seq: 2,
      ts: TS + 5,
      frame: { engine: "pi", armed: true },
    });
  });

  it("run-settled 失败形态：outcome / errorCode / reason / artifactsDir", () => {
    expect(runSettledFailed).toEqual({
      type: "run-settled",
      seq: 8,
      ts: TS + 180_000,
      outcome: "failed",
      errorCode: "engine_crashed",
      reason: "all ask waves failed",
      artifactsDir: "/journal-fixture/wf-1758-a1",
    });
  });

  it("run-settled 成功形态：errorCode / reason 缺省，artifactsDir 恒在", () => {
    expect(runSettledCompleted).toEqual({
      type: "run-settled",
      seq: 8,
      ts: TS + 240_000,
      outcome: "completed",
      artifactsDir: "/journal-fixture/wf-1758-a1",
    });
  });
});

// ── journal 接口形态 ─────────────────────────────────────────

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
    await journal.append("wf-1758-a1", askRetrying);
    await journal.append("wf-1758-a1", runSettledFailed);

    // [W1] seq 由 journal 分配（fake 同款：末水位 + 1）——断言剥 seq 的载荷序
    // 与分配的 seq 序各自成立
    const scanned = await journal.scan("wf-1758-a1");
    expect(scanned.map(stripSeq)).toEqual([
      stripSeq(runCreated),
      stripSeq(askRetrying),
      stripSeq(runSettledFailed),
    ]);
    expect(scanned.map((e) => e.seq)).toEqual([1, 2, 3]);
    await expect(journal.scan("wf-other")).resolves.toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 状态机（转移表 + transition 纯函数 + journal 实装）
// ═══════════════════════════════════════════════════════════

/** 全触发类型（7 journal 事件 + 4 控制事件 = 11，穷尽遍历用）。 */
const ALL_TRIGGER_TYPES: readonly (RunEventType | ControlTriggerType)[] = [
  ...RUN_EVENT_TYPES,
  ...CONTROL_TRIGGER_TYPES,
];

/** 每个触发类型一个代表性样本（穷尽遍历用；样本本身即词表内合法形态）。 */
const triggerSamples: Record<RunEventType | ControlTriggerType, TransitionTrigger> = {
  "run-created": runCreated,
  "ask-dispatched": askDispatched,
  "ask-executing": askExecuting,
  "ask-retrying": askRetrying,
  "ask-settled": askSettledFailed,
  armed,
  "run-settled": runSettledFailed,
  "cancel-requested": { type: "cancel-requested", reason: "user abort" },
  "watchdog-fired": { type: "watchdog-fired", reason: "no progress 10m" },
  "host-died": { type: "host-died" },
  "abandon-elapsed": { type: "abandon-elapsed" },
};

/** 构造某 lifecycle 的状态样本（terminal 带 outcome——真实终态形态）。 */
function stateOf(lifecycle: RunLifecycle): RunState {
  return lifecycle === "terminal" ? { lifecycle, outcome: "completed" } : { lifecycle };
}

/** 表外转移断言：抛 IllegalTransitionError，且错误信息含当前态与事件名。 */
function expectIllegalTransition(state: RunState, trigger: TransitionTrigger): void {
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

describe("状态词表（D5-1 两维正交）", () => {
  it("ALL_RUN_LIFECYCLES 六态（created → dispatched → running → settling → terminal + interrupted）", () => {
    expect(ALL_RUN_LIFECYCLES).toEqual([
      "created",
      "dispatched",
      "running",
      "settling",
      "terminal",
      "interrupted",
    ]);
  });

  it("CONTROL_TRIGGER_TYPES 四个控制事件（不属 journal 词表）", () => {
    expect(CONTROL_TRIGGER_TYPES).toEqual([
      "cancel-requested",
      "watchdog-fired",
      "host-died",
      "abandon-elapsed",
    ]);
    for (const t of CONTROL_TRIGGER_TYPES) {
      expect(RUN_EVENT_TYPES).not.toContain(t);
    }
  });

  it("TRANSITION_OUTPUT_TYPES 六个输出动作标签", () => {
    expect(TRANSITION_OUTPUT_TYPES).toEqual([
      "journal-append",
      "manifest-write",
      "notify",
      "registry-project",
      "kill-run-topology",
      "journal-cleanup-eligible",
    ]);
  });

  it("INITIAL_RUN_STATE = created 且无 outcome", () => {
    expect(INITIAL_RUN_STATE).toEqual({ lifecycle: "created" });
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

  it("guard 只出现在 running × ask-settled 条件族", () => {
    for (const rule of RUN_TRANSITIONS) {
      if (rule.guard !== undefined) {
        expect(rule.from).toBe("running");
        expect(rule.on).toBe("ask-settled");
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

  it("表规模快照：24 行 / 23 个合法 (lifecycle × 事件) 组合 / 43 个表外组合（6 × 11 = 66 全积）", () => {
    expect(RUN_TRANSITIONS).toHaveLength(24);
    const legalKeys = new Set(RUN_TRANSITIONS.map((r) => `${r.from}|${r.on}`));
    expect(legalKeys.size).toBe(23);
    expect(ALL_RUN_LIFECYCLES.length * ALL_TRIGGER_TYPES.length).toBe(66);
    expect(66 - legalKeys.size).toBe(43);
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

    // 条件族（当前唯一 = running × ask-settled 二支）
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

  it("run-settled 的 outcome 透传到终态（completed / failed / cancelled）", () => {
    const settling: RunState = { lifecycle: "settling" };
    expect(transition(settling, runSettledCompleted).state).toEqual({
      lifecycle: "terminal",
      outcome: "completed",
    });
    expect(transition(settling, runSettledFailed).state).toEqual({
      lifecycle: "terminal",
      outcome: "failed",
    });
    expect(transition(settling, runSettledCancelled).state).toEqual({
      lifecycle: "terminal",
      outcome: "cancelled",
    });
  });

  it("cancel-requested 三活跃态 → terminal(cancelled)，输出含 journal-append + manifest-write + notify", () => {
    for (const lifecycle of ["dispatched", "running", "settling"] as const) {
      const result = transition({ lifecycle }, triggerSamples["cancel-requested"]);
      expect(result.state).toEqual({ lifecycle: "terminal", outcome: "cancelled" });
      expect([...result.outputs]).toEqual(
        expect.arrayContaining(["journal-append", "manifest-write", "notify"]),
      );
    }
  });

  it("host-died 五个非终局态（含 interrupted 幂等重判）→ interrupted，输出 registry-project", () => {
    for (const lifecycle of ["created", "dispatched", "running", "settling", "interrupted"] as const) {
      const result = transition({ lifecycle }, triggerSamples["host-died"]);
      expect(result.state).toEqual({ lifecycle: "interrupted" });
      expect(result.outputs).toContain("registry-project");
    }
  });

  it("abandon-elapsed：interrupted → terminal(failed)，manifest-write + journal-cleanup-eligible，无 journal-append（journal 冻结）", () => {
    const result = transition({ lifecycle: "interrupted" }, triggerSamples["abandon-elapsed"]);
    expect(result.state).toEqual({ lifecycle: "terminal", outcome: "failed" });
    expect(result.outputs).toContain("manifest-write");
    expect(result.outputs).toContain("journal-cleanup-eligible");
    expect(result.outputs).not.toContain("journal-append");
  });

  it("watchdog-fired 状态自持（kill 后由 ask-settled 事件证据驱动迁移），输出 kill-run-topology", () => {
    for (const lifecycle of ["dispatched", "running", "settling"] as const) {
      const result = transition({ lifecycle }, triggerSamples["watchdog-fired"]);
      expect(result.state).toEqual({ lifecycle });
      expect(result.outputs).toEqual(["kill-run-topology"]);
    }
  });

  it("完整事件链 fold：created → dispatched → running（含重试波）→ terminal（run-settled 透传 outcome）", () => {
    const chain: TransitionTrigger[] = [
      runCreated,
      armed,
      askDispatched,
      askExecuting,
      askRetrying,
      askSettledFailed,
      askSettledCompleted,
      runSettledCompleted,
    ];
    let state = INITIAL_RUN_STATE;
    for (const trigger of chain) {
      state = transition(state, trigger).state;
    }
    expect(state).toEqual({ lifecycle: "terminal", outcome: "completed" });
  });

  it("cancel 路径 fold：journal 里的合成 run-settled(cancelled) 把 running 直接收敛到 terminal", () => {
    // 控制事件不进 journal——fold 只见 run-created / ask-dispatched / run-settled
    const chain: TransitionTrigger[] = [runCreated, askDispatched, runSettledCancelled];
    let state = INITIAL_RUN_STATE;
    for (const trigger of chain) {
      state = transition(state, trigger).state;
    }
    expect(state).toEqual({ lifecycle: "terminal", outcome: "cancelled" });
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
      transition(INITIAL_RUN_STATE, runCreated);
      transition({ lifecycle: "running" }, askSettledFailed, { enterSettling: true });
      transition({ lifecycle: "running" }, triggerSamples["cancel-requested"]);
      transition({ lifecycle: "interrupted" }, triggerSamples["abandon-elapsed"]);
      // fail-fast 路径同样不碰时钟
      expectIllegalTransition({ lifecycle: "terminal", outcome: "completed" }, runCreated);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

// ── journal 实装（createRunEventJournal）─────────────────────

describe("journal 实装（createRunEventJournal，临时目录自建自删）", () => {
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
      armed,
      askDispatched,
      askExecuting,
      askRetrying,
      askSettledFailed,
      runSettledFailed,
    ];
    for (const event of events) {
      await journal.append("wf-1758-a1", event);
    }
    const scanned = await journal.scan("wf-1758-a1");
    // [W1] append 分配的 seq 覆盖入参携带值（构造性单调：末水位 + 1）——样本
    // 自带 seq 与分配序刻意不同（末位样本 8 ≠ 分配 7），恰好钉死「分配权在
    // journal 实装、入参 seq 被无视」的契约
    expect(scanned.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 剥离 seq 后载荷逐字段一致（零漂移）
    expect(scanned.map(({ seq: _s, ...rest }) => rest)).toEqual(
      events.map(({ seq: _s, ...rest }) => rest),
    );
  });

  it("文件落在 <dir>/<runId>.events.jsonl（runId 自带 wf- 前缀，渲染名即设计的 wf-<id>.events.jsonl）", async () => {
    const journal = createRunEventJournal(dir);
    await journal.append("wf-1758-a1", runCreated);
    expect(existsSync(join(dir, "wf-1758-a1.events.jsonl"))).toBe(true);
  });

  it("scan 不存在的 run → 空数组（未落账 / 已过保留期清理）", async () => {
    await expect(createRunEventJournal(dir).scan("wf-never")).resolves.toEqual([]);
  });

  it("多个 run 按 runId 隔离", async () => {
    const journal = createRunEventJournal(dir);
    await journal.append("wf-run-a", runCreated);
    await journal.append("wf-run-b", askRetrying);
    // 各 run 独立分配 seq（首条各自为 1）
    const a = await journal.scan("wf-run-a");
    const b = await journal.scan("wf-run-b");
    expect(a.map(stripSeq)).toEqual([stripSeq(runCreated)]);
    expect(a[0]!.seq).toBe(1);
    expect(b.map(stripSeq)).toEqual([stripSeq(askRetrying)]);
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
      join(dir, `${runId}.events.jsonl`),
      [
        JSON.stringify(runCreated), // 好
        "{not json", // 坏：非法 JSON
        JSON.stringify(askRetrying), // 好
        JSON.stringify({ type: "future-event", ts: 1 }), // 坏：词表外 type（词表漂移形态）
        JSON.stringify(runSettledCompleted), // 好
        "", // 尾部空行（写入行尾换行的正常形态）
      ].join("\n"),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await createRunEventJournal(dir).scan(runId);
      expect(events).toEqual([runCreated, askRetrying, runSettledCompleted]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // 计数落日志（含坏行数与文件路径）
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain("2");
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain(`${runId}.events.jsonl`);
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
    expect(existsSync(join(dir, "evil.events.jsonl"))).toBe(false);
    expect(existsSync(join(tmpdir(), "evil.events.jsonl"))).toBe(false);
  });

  // ── [W1] seq 单调分配（设计目标 4：W2 通知去重键的行身份载体）──────────

  it("append 返回含分配 seq 的完整事件，连续 append 严格递增", async () => {
    const journal = createRunEventJournal(dir);
    const first = await journal.append("wf-seq-1", { ...stripSeq(runCreated), runId: "wf-seq-1" });
    expect(first.seq).toBe(1);
    expect(first.type).toBe("run-created");
    const second = await journal.append("wf-seq-1", stripSeq(askDispatched));
    expect(second.seq).toBe(2);
    const third = await journal.append("wf-seq-1", stripSeq(askRetrying));
    expect(third.seq).toBe(3);
  });

  it("重启续号：新 journal 实例（同目录）首 append 探测文件尾续号，不重号", async () => {
    const first = createRunEventJournal(dir);
    await first.append("wf-seq-2", stripSeq(runCreated));
    await first.append("wf-seq-2", stripSeq(askDispatched));
    // 「重启」= 新实例（进程内缓存 lastSeqByRunId 不跨实例——正确性靠文件尾探测）
    const second = createRunEventJournal(dir);
    const appended = await second.append("wf-seq-2", stripSeq(askRetrying));
    expect(appended.seq).toBe(3);
  });

  it("seq 坏值行（0 / 负数 / 非整数 / 字符串）按坏行跳过，好行照常返回", async () => {
    const runId = "wf-seq-bad";
    writeFileSync(
      join(dir, `${runId}.events.jsonl`),
      [
        JSON.stringify({ ...stripSeq(runCreated), runId, seq: 0 }), // 坏：非正整数
        JSON.stringify({ ...stripSeq(askDispatched), seq: -1 }), // 坏：负数
        JSON.stringify({ ...stripSeq(askRetrying), seq: 1.5 }), // 坏：非整数
        JSON.stringify({ ...stripSeq(armed), seq: "1" }), // 坏：字符串
        JSON.stringify({ ...stripSeq(askSettledFailed), seq: 1 }), // 好
      ].join("\n"),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await createRunEventJournal(dir).scan(runId);
      expect(events.map((e) => e.type)).toEqual(["ask-settled"]);
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain("4");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("[W1 存量兼容读] 无 seq 的旧格式行放行（旧行为不变）+ fold 应用不推进水位 + 追加新行从 1 起号", async () => {
    const runId = "wf-seq-legacy";
    // W1 前的 journal 形态（无 seq 字段；末行补换行——真实 journal 每行 append 自带）
    writeFileSync(
      join(dir, `${runId}.events.jsonl`),
      [
        JSON.stringify(stripSeq(runCreated)),
        JSON.stringify(stripSeq(askDispatched)),
      ].join("\n") + "\n",
      "utf8",
    );
    const journal = createRunEventJournal(dir);
    // 旧格式行照常解析（D7 惰性兼容读——scan 放行，事件流可 fold）
    const scanned = await journal.scan(runId);
    expect(scanned.map((e) => e.type)).toEqual(["run-created", "ask-dispatched"]);
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

// ── [W1] fold 检查点（seq 守卫：tail 截断重建后全量重读的幂等去重）──────────

describe("foldRunEventCheckpoint（seq 守卫，D6 域 fold 去重）", () => {
  const noop = (): void => {};

  it("全量重放同一事件序列产出逐字段相等 checkpoint（纯函数幂等）", () => {
    const events: WorkflowRunEvent[] = [runCreated, armed, askDispatched, askSettledCompleted, runSettledCompleted];
    const once = foldRunEventCheckpoint(events, noop);
    const twice = foldRunEventCheckpoint(events, noop);
    expect(twice).toEqual(once);
    expect(once.state).toEqual({ lifecycle: "terminal", outcome: "completed" });
    expect(once.lastSeq).toBe(8);
  });

  it("seq ≤ 水位的事件按重放跳过：以既有 checkpoint 为初值重放全量流，不重复应用", () => {
    // 「截断重建后的幂等全量重读」形态：先消费前 3 条 → 再全量重读（前 3 条重放）
    const events: WorkflowRunEvent[] = [runCreated, armed, askDispatched, askRetrying, askSettledFailed, runSettledFailed];
    const first = foldRunEventCheckpoint(events.slice(0, 3), noop);
    expect(first.state).toEqual({ lifecycle: "running" });
    // 重放全量：前 3 条（seq ≤ 水位 3）跳过，后 3 条照常应用——终态正确收敛
    const full = foldRunEventCheckpoint(events, noop, first);
    expect(full.state).toEqual({ lifecycle: "terminal", outcome: "failed" });
    expect(full.lastSeq).toBe(8);
  });

  it("seq 跳号（gap）宽容放行——外部编辑形态不炸投影", () => {
    const gapped: WorkflowRunEvent[] = [
      { ...runCreated, seq: 1 },
      { ...askDispatched, seq: 5 },
      { ...runSettledCompleted, seq: 9 },
    ];
    const checkpoint = foldRunEventCheckpoint(gapped, noop);
    expect(checkpoint.state).toEqual({ lifecycle: "terminal", outcome: "completed" });
    expect(checkpoint.lastSeq).toBe(9);
  });

  it("坏帧保守停在最近一致态（onBrokenFrame 出声后截断，水位保持已接受值）", () => {
    // dispatched × ask-settled（缺 ask-dispatched）= 表外转移 → 坏帧
    const broken: WorkflowRunEvent[] = [runCreated, askSettledFailed, runSettledFailed];
    const seen: string[] = [];
    const checkpoint = foldRunEventCheckpoint(broken, (_err, lastType) => {
      seen.push(lastType);
    });
    expect(seen).toEqual(["ask-settled"]);
    expect(checkpoint.state).toEqual({ lifecycle: "dispatched" });
    expect(checkpoint.lastSeq).toBe(1);
  });
});

// ── DoneReason 终止性判定（词表语义单点；消费方 = 壳 workflow-notify 防偷懒收尾指令）──

describe("isTerminalDoneReason", () => {
  it("全词表表驱动：completed 唯一非终止性，其余成员均为终止性", () => {
    const expected: Record<string, boolean> = {
      completed: false,
      failed: true,
      aborted: true,
      invalid_args: true,
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
      "invalid_args",
      "budget_limited",
      "time_limited",
    ];
    expect([...ALL_DONE_REASONS].sort()).toEqual([...expectedMembers].sort());
  });
});
