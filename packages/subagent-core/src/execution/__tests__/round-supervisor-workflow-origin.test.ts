// src/execution/__tests__/round-supervisor-workflow-origin.test.ts
//
// [H2 W2] 治理决策表逐族——workflow origin record 对 round-supervisor 的豁免面
//（设计 subagent-workflow-record-unification.md §3.3 决策表 v3）：
//
//   - adopt 接管：豁免（adoptOnProcessDeath 对 workflow record 不纳管——引擎死亡即
//     run 失败即 record 终态化，无脚本可回的 resumable 等待无意义）；
//   - boot 分区重认领：豁免负面断言（classifySupervisorDomain 不把 workflow record
//     归入可 adopt 域 "run"）；
//   - superseded 分类：workflow origin 候选豁免（parallel 同 slug 并行是 workflow
//     常态而非替代关系——replacedNotice 不再把并行任务误述为替代）；
//   - 运行期监督：照旧纳管（H1 D8「非 chatMode 全量纳管」不因 adopt 豁免收窄——
//     noteRunStarted/noteRunEnded 记账对 workflow record 无 origin 门，只豁免 adopt）。
//
// 纯监督器单测：deps 全替身注入（对齐 round-supervisor.test.ts 形态，零 fs 依赖）。

import { describe, expect, it, vi } from "vitest";

import type { ExecutionRecord } from "../types.ts";
import {
  RoundSupervisor,
  type RoundSupervisorDeps,
  type SupervisorCandidateRecord,
  type SupervisorRecordView,
} from "../round-supervisor/index.ts";

interface TestDeps extends RoundSupervisorDeps {
  notices: string[];
  guidances: Array<{ record: SupervisorRecordView; exemptionDisclaimer: boolean }>;
  replaced: Array<{ record: SupervisorRecordView; replacementId: string }>;
  givenUp: Array<{ recordId: string; kind: string; detail: { replacementId?: string } }>;
  views: Map<string, SupervisorRecordView>;
  candidates: SupervisorCandidateRecord[];
  live: Set<string>;
}

function makeDeps(): TestDeps {
  const views = new Map<string, SupervisorRecordView>();
  const candidates: SupervisorCandidateRecord[] = [];
  const live = new Set<string>();
  const notices: string[] = [];
  const guidances: Array<{ record: SupervisorRecordView; exemptionDisclaimer: boolean }> = [];
  const replaced: Array<{ record: SupervisorRecordView; replacementId: string }> = [];
  const givenUp: Array<{ recordId: string; kind: string; detail: { replacementId?: string } }> = [];
  const deps: RoundSupervisorDeps = {
    now: () => Date.now(),
    getRecordView: (id) => views.get(id),
    listCandidateRecords: () => candidates,
    hasLiveProcess: (recordId) => live.has(recordId),
    sendMergedFailureNotice: (record) => notices.push(`merged:${record.id}`),
    sendDecisionGuidance: (record, opts) => guidances.push({ record, exemptionDisclaimer: opts.exemptionDisclaimer }),
    sendReplacedNotice: (record, replacementId) => replaced.push({ record, replacementId }),
    giveUp: (recordId, kind, detail) => givenUp.push({ recordId, kind, detail }),
  };
  return Object.assign(deps, { notices, guidances, replaced, givenUp, views, candidates, live });
}

/** 死亡纳管入参形态的内存 record 替身。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "bg-1",
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "fix-bug",
    startedAt: Date.now() - 1000,
    status: "running",
    resumable: true,
    rootSessionId: "sess-root",
    turnCount: 0,
    ...overrides,
  } as ExecutionRecord;
}

/** 该唤醒形态 view（running + resumable + 无产出 + 无驱动）。 */
function awakeView(id: string, over: Partial<SupervisorRecordView> = {}): SupervisorRecordView {
  return {
    id,
    status: "running",
    resumable: true,
    hasResult: false,
    chatMode: false,
    rootSessionId: "sess-root",
    agent: "worker",
    slug: "fix-bug",
    startedAt: 1,
    closedReason: undefined,
    ...over,
  };
}

describe("adopt 豁免（决策表 v3 改判）", () => {
  it("workflow record 死亡事件不纳管：零合并通知/零指引/零纳管记账；tool 对照全链照常", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-wf", awakeView("bg-wf", { origin: "workflow" }));
    deps.views.set("bg-tool", awakeView("bg-tool"));

    supervisor.adoptOnProcessDeath(
      makeRecord({ id: "bg-wf", origin: "workflow", parentRunId: "run-1" }),
      "engine crashed",
    );
    expect(deps.notices).toEqual([]);
    expect(deps.guidances).toHaveLength(0);
    expect(supervisor.supervisedIds()).toEqual([]);

    // 对照：origin=tool 同形态照常 adopt（合并通知 + 指引 + 纳管）
    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-tool" }), "engine crashed");
    expect(deps.notices).toEqual(["merged:bg-tool"]);
    expect(deps.guidances).toHaveLength(1);
    expect(supervisor.supervisedIds()).toEqual(["bg-tool"]);
  });

  it("conversation 豁免语义不回归：chatMode record 照旧不入监督域", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-chat", chatMode: true }), "x");
    expect(supervisor.supervisedIds()).toEqual([]);
  });
});

describe("boot 分区对 workflow 形态负面断言（重认领豁免）", () => {
  it("running+resumable+无产出的 workflow record 不被 boot 重认领；tool 对照被认领", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-wf", awakeView("bg-wf", { origin: "workflow" }));
    deps.views.set("bg-tool", awakeView("bg-tool"));
    deps.candidates.push(
      { id: "bg-wf", rootSessionId: "sess-root", agent: "worker", slug: "fix-bug", startedAt: 1, origin: "workflow" },
      { id: "bg-tool", rootSessionId: "sess-root", agent: "worker", slug: "fix-bug", startedAt: 1 },
    );

    const { readopted } = supervisor.bootPartition();
    expect(readopted).toEqual(["bg-tool"]); // workflow 形态被 classifySupervisorDomain 挡在可 adopt 域外
    expect(supervisor.supervisedIds()).toEqual(["bg-tool"]);
    expect(deps.guidances).toHaveLength(1); // 仅 tool record 的评估推进
  });
});

describe("superseded 豁免（parallel 同 slug 并行非替代）", () => {
  it("adopted tool record 的替代判定忽略 workflow origin 候选：无 replacedNotice/无 superseded giveUp", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-tool", awakeView("bg-tool"));
    // workflow 候选：同 root/同 agent/同 slug、看门狗窗内新建——旧判定（high-confidence）
    // 会误判替代；豁免后不参与对账（连 low-confidence 的 sameAgentOnly 都不触发）
    deps.candidates.push(
      { id: "bg-wf-1", rootSessionId: "sess-root", agent: "worker", slug: "fix-bug", startedAt: Date.now() - 1000, origin: "workflow" },
      { id: "bg-wf-2", rootSessionId: "sess-root", agent: "worker", slug: "fix-bug", startedAt: Date.now() - 500, origin: "workflow" },
    );

    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-tool" }), "engine crashed");
    expect(deps.replaced).toEqual([]);
    expect(deps.givenUp).toEqual([]);
    expect(deps.guidances).toHaveLength(1); // 无替代命中 → 正常送决策指引
    expect(deps.guidances[0]!.exemptionDisclaimer).toBe(false); // verdict=none（连 low-confidence 都不算）
  });

  it("对照：tool 来源同 slug 候选仍高置信替代（豁免只滤 workflow origin）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-tool", awakeView("bg-tool"));
    deps.candidates.push({
      id: "bg-tool-2",
      rootSessionId: "sess-root",
      agent: "worker",
      slug: "fix-bug",
      startedAt: Date.now() - 1000,
    });

    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-tool" }), "engine crashed");
    expect(deps.replaced).toEqual([{ record: expect.objectContaining({ id: "bg-tool" }), replacementId: "bg-tool-2" }]);
    expect(deps.givenUp).toEqual([{ recordId: "bg-tool", kind: "superseded", detail: { replacementId: "bg-tool-2" } }]);
  });
});

describe("运行期监督照旧纳管（H1 D8 不收窄——只豁免 adopt）", () => {
  it("noteRunStarted/noteRunEnded 对 workflow record 无 origin 门（在途记账照旧）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    // 在途记账面无 origin 分支：workflow record id 正常进/出 inFlightRuns，不抛不静默跳过
    expect(() => {
      supervisor.noteRunStarted("bg-wf");
      supervisor.noteRunEnded("bg-wf");
    }).not.toThrow();
    expect(supervisor.supervisedIds()).toEqual([]);

    // 记账解除后死亡事件仍被 adopt 豁免拦截（豁免面 = adopt 入口，非记账面）
    deps.views.set("bg-wf", awakeView("bg-wf", { origin: "workflow" }));
    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-wf", origin: "workflow" }), "boom");
    expect(supervisor.supervisedIds()).toEqual([]);
  });

  it("noteRun* 记账对已纳管 tool record 的「该等→重评估」语义不回归", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-tool", awakeView("bg-tool"));
    supervisor.noteRunStarted("bg-tool");
    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-tool" }), "boom"); // 在途 → 该等
    expect(deps.guidances).toHaveLength(0);
    supervisor.noteRunEnded("bg-tool"); // run 收口 → 重评估 → 该唤醒
    expect(deps.guidances).toHaveLength(1);
  });
});
