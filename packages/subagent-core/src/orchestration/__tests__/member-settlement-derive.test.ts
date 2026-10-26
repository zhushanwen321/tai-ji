// [subagent-observability §3.3.8] run 终局吸收成员交付的行为锁（u4 验收①③）：
// - 场景 2 断言：fan-out 半数失败 → partially_succeeded + failedMembers[].cause 点拼
//   （reason 不丢由 runtime WORKFLOW_DONE_REASON_SET 扩值承接——runtime 侧词表对账
//   在 packages/runtime/test/workflow-outcome-vocab-parity.test.ts，不在本包）；
// - UC-16 断言：run 主动取消不产生 partially_succeeded（cancelled 优先于成员集合派生，
//   被收尾成员判 cancelled 不判 failed）；
// - 脚本层失败（worker error / replay mismatch，run.state.error 有值）不被成员派生
//   覆盖（run 级终局优先序第二级——harness 系统层失败，成员无责）。
// 纯函数直测（无 IO / 无时钟——成员集合从 WorkflowRun.state.calls 构造）。
import { describe, expect, it } from "vitest";

import { AgentCall } from "../models/agent-call.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "../models/types.ts";
import { INITIAL_RUN_EVENT_FOLD } from "../run-events.ts";
import { IN_FLIGHT_CALL_CANCELLED_MSG } from "../worker-message-pump-constants.ts";
import type { RunSettlementRecord } from "../terminal-actions.ts";
import {
  ADOPTED_MEMBER_CAUSE,
  deriveRunOutcomeFromMembers,
  memberSettlementOf,
  settleMembersIntoFinalSettlement,
} from "../run-member-settlement.ts";

const BASE_OPTS: AgentCallOpts = { prompt: "task", agent: "member-agent" };

function makeTraceNode(id: number): ExecutionTraceNode {
  return {
    id,
    agent: "member-agent",
    status: "pending",
    children: [],
  } as unknown as ExecutionTraceNode;
}

/** 构造带 N 个已结算成员的 run 聚合（calls 直填——派生纯函数只读 calls 形态）。 */
function makeRunWithMembers(results: Array<AgentResult | undefined>): WorkflowRun {
  return new WorkflowRun(
    "wf-test",
    { scriptName: "fan-out", scriptSource: "", args: {} } as ConstructorParameters<typeof WorkflowRun>[1],
    {
      calls: new Map(
        results.map((result, i) => {
          const call = {
            id: i,
            opts: BASE_OPTS,
            status: result !== undefined ? "done" : "running",
            attempts: 1,
            ...(result !== undefined ? { result } : {}),
            traceNode: makeTraceNode(i),
          };
          return [i, call] as const;
        }),
      ),
      trace: { update: () => {} },
      budget: { usedTokens: 0, usedCost: 0 },
      scriptResult: undefined,
      error: undefined,
    } as unknown as ConstructorParameters<typeof WorkflowRun>[2],
    { startedAt: new Date(0).toISOString() },
  );
}

const OK: AgentResult = { content: "ok", sessionId: "s" };
const FAIL: AgentResult = {
  content: "",
  error: "provider rate_limited: too many requests",
  failure: { class: "provider", kind: "rate_limited", retryable: "conditional", retryAfterMs: 1200, raw: "provider rate_limited: too many requests" },
  sessionId: "s",
};
const FAIL_UNCLASSIFIED: AgentResult = {
  content: "",
  error: "something broke",
  sessionId: "s",
};
const CLOSEOUT_CANCELLED: AgentResult = {
  content: "",
  error: IN_FLIGHT_CALL_CANCELLED_MSG,
  sessionId: "s",
};
// [§3.3.1 P6] 被接管轮回执形态（output-collector collectOutcome ②-A 支）：回执层
// 成功、引擎未执行——无 error、无失败分类、无停因、promptDisposition=handled。
const ADOPTED: AgentResult = {
  content: "",
  sessionId: "s",
  promptDisposition: "handled",
};

const BASE_RECORD: RunSettlementRecord = { outcome: "done", settledAt: 0 };

describe("[§3.3.8 场景 2] run 终局吸收成员交付：partially_succeeded + failedMembers", () => {
  it("fan-out 半数失败（1 成功 1 失败）→ partially_succeeded + failedMembers[].cause 点拼", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, FAIL]));
    expect(derived).toBeDefined();
    expect(derived!.outcome).toBe("partially_succeeded");
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
  });

  it("全部成功交付 → done（无失败明细）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, OK]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });

  it("全部失败 → failed（明细如实逐成员携带）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([FAIL, FAIL_UNCLASSIFIED]));
    expect(derived!.outcome).toBe("failed");
    expect(derived!.failedMembers).toEqual([
      { taskIndex: 0, cause: "provider.rate_limited" },
      { taskIndex: 1, cause: "unknown" },
    ]);
  });

  it("空成员集 → undefined（脚本层判定，回落 DoneReason 路径）", () => {
    expect(deriveRunOutcomeFromMembers(makeRunWithMembers([]))).toBeUndefined();
  });

  it("closeOut 收尾成员（IN_FLIGHT_CALL_CANCELLED_MSG）判 cancelled 不判 failed——无失败集不误升", () => {
    // 1 成功 + 1 被收尾取消：cancelled 不进失败集——存在交付且无失败 → done
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, CLOSEOUT_CANCELLED]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });

  it("settleMembersIntoFinalSettlement：completed DoneReason 被成员派生升格 partially_succeeded（帧终局形态）", () => {
    const run = makeRunWithMembers([OK, FAIL]);
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "done" });
    expect(record.outcome).toBe("partially_succeeded");
    expect(record.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
  });

  it("error 前缀协议码回落点拼：failure 缺席时 cause = engine.<code>", () => {
    const run = makeRunWithMembers([
      OK,
      { content: "", error: "engine_crashed: worker died", sessionId: "s" },
    ]);
    const derived = deriveRunOutcomeFromMembers(run);
    expect(derived!.outcome).toBe("partially_succeeded");
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "engine.engine_crashed" }]);
  });
});

describe("[§3.3.8/§3.3.10 联动] 部分交付支：脚本层交付校验事实接入 run 结算", () => {
  it("无失败 + 脚本层部分交付事实 → done 升格 partially_succeeded + partialMembers 帧明细", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.scriptResult = {
      status: "ok",
      results: [],
      partialMembers: [{ taskIndex: 1, missing: ['file:/abs/report.md (not readable (ENOENT))'] }],
    };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("partially_succeeded");
    expect(record.partialMembers).toEqual([
      { taskIndex: 1, missing: ['file:/abs/report.md (not readable (ENOENT))'] },
    ]);
    expect(record.failedMembers).toBeUndefined();
  });

  it("部分失败 + 部分交付并存 → partially_succeeded 携带 failedMembers 与 partialMembers 双明细", () => {
    const run = makeRunWithMembers([OK, FAIL, OK]);
    run.state.scriptResult = {
      status: "partial",
      partialMembers: [{ taskIndex: 2, missing: ["structured_output (no valid structured output)"] }],
    };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("partially_succeeded");
    expect(record.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
    expect(record.partialMembers).toEqual([
      { taskIndex: 2, missing: ["structured_output (no valid structured output)"] },
    ]);
  });

  it("无部分交付事实（scriptResult 缺 partialMembers 载荷）→ done 不升格、帧无 partialMembers", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.scriptResult = { status: "ok", results: [] };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("done");
    expect(record.partialMembers).toBeUndefined();
  });

  it("畸形 partialMembers 条目（taskIndex 非整数 / missing 非字符串数组）fail-visible 丢弃——不进终局帧", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.scriptResult = {
      status: "ok",
      partialMembers: [
        { taskIndex: "0", missing: ["x"] }, // taskIndex 非数字
        { taskIndex: 1, missing: "not-an-array" }, // missing 非数组
      ],
    };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("done");
    expect(record.partialMembers).toBeUndefined();
  });

  it("脚本层失败（run.state.error）优先——不消费 partialMembers、不升格", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.error = "fan-out: all tasks failed (2/2)";
    run.state.scriptResult = { partialMembers: [{ taskIndex: 0, missing: ["x"] }] };
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed");
    expect(record.partialMembers).toBeUndefined();
  });
});

describe("[§3.3.8/UC-16] run 级终局优先于成员集合派生", () => {
  it("UC-16：run 主动取消（cancelled）不被成员派生覆盖——不产生 partially_succeeded", () => {
    const run = makeRunWithMembers([OK, CLOSEOUT_CANCELLED]); // 1 成功 + 1 被取消收尾
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "cancelled" });
    expect(record.outcome).toBe("cancelled");
    expect(record.failedMembers).toBeUndefined();
  });

  it("budget_limited / time_limited 终局同样不被成员集合覆盖（优先族）", () => {
    const run = makeRunWithMembers([OK, FAIL]);
    expect(settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed", errorCode: "budget_limited" }).outcome).toBe("failed");
    expect(settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "time_limited" }).outcome).toBe("time_limited");
  });

  it("脚本层失败（run.state.error 有值——worker error / replay mismatch）维持 failed 不被覆盖", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.error = "replay input mismatch: prompt drifted";
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed");
    expect(record.failedMembers).toBeUndefined();
  });

  it("in-flight 成员（未 settled）判 cancelled——成功成员在场时 run 不升 partially_succeeded", () => {
    // run 正常收尾（completed）但有一个成员未落定（closeOut 前的形态）：
    // cancelled 成员不计失败 → 无失败 + 存在交付 = done（UC-16 同语义面）
    const run = makeRunWithMembers([OK, undefined]);
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("done");
    expect(record.failedMembers).toBeUndefined();
  });
});

describe("[§3.3.8 P6 定稿] 被接管成员的聚合与 resume 归属", () => {
  /** 构造 done 态真实 AgentCall（memberSettlementOf 直测的形态还原——markRunning/markDone 状态机链）。 */
  function doneCall(id: number, result: AgentResult): AgentCall {
    const call = new AgentCall(id, BASE_OPTS, makeTraceNode(id));
    call.markRunning();
    call.markDone(result);
    return call;
  }

  it("memberSettlementOf：被接管轮（promptDisposition=handled）判 cancelled 不判 delivered——回执层成功不冒充交付", () => {
    expect(memberSettlementOf(doneCall(0, ADOPTED))).toBe("cancelled");
    // 对照组：同形回执（无接管事实）判 delivered
    expect(memberSettlementOf(doneCall(1, { content: "", sessionId: "s" }))).toBe("delivered");
  });

  it("部分被接管（1 交付 + 1 被接管）：被接管按「未交付且非失败」计——不进失败明细、run done", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, ADOPTED]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });

  it("全部成员被接管（零交付零失败）→ run failed + 逐成员被接管明细（harness.member_adopted，不借用 agent.no_deliverable）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([ADOPTED, ADOPTED]));
    expect(derived!.outcome).toBe("failed");
    expect(derived!.failedMembers).toEqual([
      { taskIndex: 0, cause: ADOPTED_MEMBER_CAUSE },
      { taskIndex: 1, cause: ADOPTED_MEMBER_CAUSE },
    ]);
    // 终局帧形态：done 合成记录被派生升格 failed + 明细（脚本正常收尾、成员全被接管）
    const record = settleMembersIntoFinalSettlement(makeRunWithMembers([ADOPTED, ADOPTED]), BASE_RECORD);
    expect(record.outcome).toBe("failed");
    expect(record.failedMembers).toEqual([
      { taskIndex: 0, cause: ADOPTED_MEMBER_CAUSE },
      { taskIndex: 1, cause: ADOPTED_MEMBER_CAUSE },
    ]);
  });

  it("混合失败 + 被接管：失败成员进明细，被接管成员按未交付计不泄漏进失败明细", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, FAIL, ADOPTED]));
    expect(derived!.outcome).toBe("partially_succeeded");
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
  });

  it("被接管与 closeOut 取消可区分：全 closeOut 取消（非接管）不触发全接管 failed 档", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([CLOSEOUT_CANCELLED, undefined]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });
});

describe("[§3.3.8 cause 序列化 guard] 点拼无自由文本泄漏（F1-11/F1-56）", () => {
  it("error 契约形态但前缀非协议码（含 ': ' 的自由文本）→ engine.unknown（fail-visible）", () => {
    const run = makeRunWithMembers([
      OK,
      { content: "", error: "connect ECONNREFUSED 127.0.0.1:8080: connection refused", sessionId: "s" },
    ]);
    const derived = deriveRunOutcomeFromMembers(run);
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "engine.unknown" }]);
  });

  it("无 ': ' 契约形态的 error → unknown（未分类标记，无 class 断言）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, FAIL_UNCLASSIFIED]));
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "unknown" }]);
  });

  it("error_ 透传面前缀同样落 engine.<code>（SDK 透传契约）", () => {
    const run = makeRunWithMembers([
      OK,
      { content: "", error: "engine_provider_timeout: upstream timed out", sessionId: "s" },
    ]);
    const derived = deriveRunOutcomeFromMembers(run);
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "engine.engine_provider_timeout" }]);
  });
});

describe("[§3.3.8 脚本层失败两形态分流] 成员明细的抑制边界（F1-60）", () => {
  it("全成员失败 + 脚本 throw（fan-out 全败终局上报）：终局帧带全量 failedMembers 明细", () => {
    const run = makeRunWithMembers([FAIL, FAIL_UNCLASSIFIED]);
    run.state.error = "fan-out: all tasks failed (2/2)";
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed"); // harness 层裁决不被改档
    expect(record.failedMembers).toEqual([
      { taskIndex: 0, cause: "provider.rate_limited" },
      { taskIndex: 1, cause: "unknown" },
    ]);
  });

  it("存在未终局成员的脚本层失败（worker crash 形态）：成员无责——明细维持抑制", () => {
    const run = makeRunWithMembers([FAIL, undefined]); // 第二成员在途（无 result）
    run.state.error = "worker exited without result";
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed");
    expect(record.failedMembers).toBeUndefined();
  });
});

describe("[§3.3.8] INITIAL_RUN_EVENT_FOLD 兼容（runSettled 骨架新字段缺省形态）", () => {
  it("fold 初值 runSettled = undefined（新字段不破坏既有 fold 契约）", () => {
    expect(INITIAL_RUN_EVENT_FOLD.runSettled).toBeUndefined();
  });
});
