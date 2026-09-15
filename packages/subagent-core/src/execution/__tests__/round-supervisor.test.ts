// src/execution/__tests__/round-supervisor.test.ts
//
// [W4] 轮次活性监督器单测：三态判定（该等/该唤醒/该放弃）、纳管模型（死亡事件
// 纳管、重建不解管——镜像置死只作触发信号不作持续判据）、boot 分区（重认领 vs
// conversation 豁免 vs in-flight 跳过）、通知对账两级启发式（高置信撤销改送终止
// 通知 / 低置信豁免声明）。timer 用 fake timers；deps 全部替身注入（不触真实
// 数据目录——监督器对 fs 零依赖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionRecord } from "../assembly/types.ts";
import { RoundSupervisor, ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS, isAwakeWarrantedShape, type RoundSupervisorDeps, type SupervisorCandidateRecord, type SupervisorRecordView } from "../round-supervisor/index.ts";

function makeDeps(overrides: Partial<RoundSupervisorDeps> = {}): RoundSupervisorDeps & {
  notices: string[];
  guidances: Array<{ record: SupervisorRecordView; exemptionDisclaimer: boolean }>;
  replaced: Array<{ record: SupervisorRecordView; replacementId: string }>;
  givenUp: Array<{ recordId: string; kind: string; detail: { replacementId?: string } }>;
  views: Map<string, SupervisorRecordView>;
  candidates: SupervisorCandidateRecord[];
  live: Set<string>;
} {
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

/** 内存 record 替身（adoptOnProcessDeath 入参形态——字段访问面最小化）。 */
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
    rootSessionId: "sess-root",
    turnCount: 0,
    ...overrides,
  } as ExecutionRecord;
}

// ============================================================
// [P4-② ⛔ two-state-convergence U5] W4 唤醒链守卫（isAwakeWarrantedShape 直测）
// ——设计 D4 行为级 W4 行：同进程死亡纳管 → 运行时唤醒链；[U5/D4 MF-B] 判据
// 全子集化（!chatMode && running && !hasResult && !hasInFlightRun && !hasLiveProcess）
// ——resumable 字段退役后 W4 形态由「running + 无产出 + 无驱动」识别。
// ============================================================
describe("[P4-②] isAwakeWarrantedShape W4 唤醒链守卫（two-state-convergence U5 全子集谓词）", () => {
  it("W4 纳管态（running + 无产出 + 无在途 run/无活进程，非 chat）→ true（运行时唤醒链活）", () => {
    expect(isAwakeWarrantedShape({ status: "running" }, false, false, false)).toBe(true);
  });

  it("W4 新型（running + stopReason=failed，adoptEngineDeath U5 写点形态）→ true（谓词不消费 stopReason）", () => {
    expect(isAwakeWarrantedShape({ status: "running" }, false, false, false)).toBe(true);
  });

  it("翻边轮终形态（idle）→ false（status 子句排除——轮终收口不属 W4 唤醒域）", () => {
    expect(isAwakeWarrantedShape({ status: "idle" }, false, false, false)).toBe(false);
  });

  it("真在跑（有在途 run / 有活进程）→ false（该等）；已有产出 → false（[modeless 波1] conversation 豁免消亡——判据统一）", () => {
    expect(isAwakeWarrantedShape({ status: "running" }, false, true, false)).toBe(false);
    expect(isAwakeWarrantedShape({ status: "running" }, false, false, true)).toBe(false);
    // [modeless 波1] conversation 豁免子句删除：无产出无驱动的 running record（原
    // chatMode:true 豁免形态）同样判「该唤醒」——保守多管不漏。
    expect(isAwakeWarrantedShape({ status: "running" }, false, false, false)).toBe(true);
    expect(isAwakeWarrantedShape({ status: "running" }, true, false, false)).toBe(false);
  });
});

describe("RoundSupervisor 三态判定", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("该等：有活进程驱动 → 不干预（无指引、无放弃）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    deps.live.add("bg-1");
    supervisor.adoptOnProcessDeath(makeRecord(), "boom");
    expect(deps.guidances).toHaveLength(0);
    expect(deps.givenUp).toHaveLength(0);
  });

  it("该等：在途 run 记账（noteRunStarted）→ 不干预；noteRunEnded 后重评估", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.noteRunStarted("bg-1");
    supervisor.adoptOnProcessDeath(makeRecord(), "boom");
    expect(deps.guidances).toHaveLength(0);
    supervisor.noteRunEnded("bg-1");
    expect(deps.guidances).toHaveLength(1);
  });

  it("该唤醒：running + 无产出 + 无在途 run/无进程驱动 → 决策指引（一窗一次）+ 看门狗 armed", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.adoptOnProcessDeath(makeRecord(), "engine crashed");
    expect(deps.notices).toEqual(["merged:bg-1"]); // 合并单条通知（failed 如实 + 接管契约）
    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(false);
    // 重复死亡事件不重复通知、不重复指引（幂等）
    supervisor.adoptOnProcessDeath(makeRecord(), "again");
    expect(deps.notices).toHaveLength(1);
    expect(deps.guidances).toHaveLength(1);
    expect(supervisor.supervisedIds()).toEqual(["bg-1"]);
  });

  it("[重建不解管] 镜像重填再置死（引擎被动重建）不翻转判定：指引仍只送一次、纳管持续", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    // 死亡事件纳管时镜像已置死（hasLiveProcess=false）→ 该唤醒。
    supervisor.adoptOnProcessDeath(makeRecord(), "engine crashed");
    expect(deps.guidances).toHaveLength(1);
    // 模拟引擎被动重建：任一会话的下个请求触发 ensureConnected → 镜像重填（live=true）
    deps.live.add("bg-1");
    supervisor.noteRunEnded("bg-1"); // 重建后的重评估——镜像判「该等」仅解除看门狗
    expect(deps.guidances).toHaveLength(1); // 指引不重发（已在窗内）
    expect(supervisor.supervisedIds()).toEqual(["bg-1"]); // 纳管未解除（重建不解管）
    // 镜像再置死（重建的进程又死）：record 级状态未变 → 监督器继续管辖（不重复指引）
    deps.live.delete("bg-1");
    supervisor.noteRunEnded("bg-1");
    expect(deps.guidances).toHaveLength(1);
    expect(supervisor.supervisedIds()).toEqual(["bg-1"]);
  });

  it("已有完成产出（SP-5 upgrade 等待态）→ 不唤醒", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: true, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.adoptOnProcessDeath(makeRecord({ result: "done text" }), "x");
    expect(deps.guidances).toHaveLength(0);
  });

  it("[modeless 波1] conversation 豁免消亡：record 的死亡事件同入监督域（保守多管不漏）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-chat", { id: "bg-chat", status: "running", hasResult: false, rootSessionId: "r", agent: "chat", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.adoptOnProcessDeath(makeRecord({ id: "bg-chat" }), "x");
    expect(deps.notices).toHaveLength(1);
    expect(supervisor.supervisedIds()).toEqual(["bg-chat"]);
  });

  it("该放弃：决策看门狗到期 → giveUp(watchdog-expired) 并解除纳管；record 已终态则跳过", async () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    expect(deps.givenUp).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);
    expect(deps.givenUp).toEqual([{ recordId: "bg-1", kind: "watchdog-expired", detail: {} }]);
    expect(supervisor.supervisedIds()).toEqual([]);
  });

  it("看门狗等待期内 run 恢复（决策收敛）→ 解除看门狗，不放弃", async () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    supervisor.noteRunStarted("bg-1"); // 主 agent resume = 决策收敛
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);
    expect(deps.givenUp).toHaveLength(0);
  });

  it("[F5] 挂账转完成（SP-5 result 回填）→ 解除看门狗：到期不误 giveUp 已完成挂账 record", async () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.adoptOnProcessDeath(makeRecord(), "x"); // 该唤醒 → 指引 + 看门狗 armed
    expect(deps.guidances).toHaveLength(1);
    // upgrade 完成 → result 回填（挂账态），重评估触发（noteRunEnded 携带视图更新）
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: true, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    supervisor.noteRunEnded("bg-1");
    // armed 的看门狗必须已解除——2h 到期不得把已完成挂账 record 判死
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);
    expect(deps.givenUp).toHaveLength(0);
    expect(supervisor.supervisedIds()).toEqual(["bg-1"]); // 挂账态保持纳管（归 idle-gc 收口）
  });

  it("env ≤0 关闭该放弃路径：只指引永不放弃（回收层 opt-out）", async () => {
    vi.stubEnv("XYZ_SUBAGENT_ROUND_SUPERVISOR_WATCHDOG_MS", "0");
    RoundSupervisor._resetEnvCacheForTest();
    try {
      const deps = makeDeps();
      const supervisor = new RoundSupervisor(deps);
      deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
      supervisor.adoptOnProcessDeath(makeRecord(), "x");
      expect(deps.guidances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS * 3);
      expect(deps.givenUp).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      RoundSupervisor._resetEnvCacheForTest();
    }
  });
});

describe("RoundSupervisor boot 分区", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("running 无产出候选（原 already-resumable-idle 重认领形态）→ 纳管接管 + 送达指引", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.candidates.push({ id: "bg-1", rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1 });
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    const { readopted } = supervisor.bootPartition();
    expect(readopted).toEqual(["bg-1"]);
    expect(deps.guidances).toHaveLength(1);
    expect(supervisor.supervisedIds()).toEqual(["bg-1"]);
  });

  it("[U5/D4 MF-1] 重认领谓词已删：running 候选防御性全量纳管（生产链路候选门后恒空——磁盘重建恒 idle + 孤儿恢复先纠偏，循环体为防御结构）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.candidates.push({ id: "bg-2", rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1 });
    deps.views.set("bg-2", { id: "bg-2", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "s", startedAt: 1, closedReason: undefined });
    const { readopted } = supervisor.bootPartition();
    expect(readopted).toEqual(["bg-2"]);
    expect(supervisor.supervisedIds()).toEqual(["bg-2"]);
  });

  it("[modeless 波1] boot 分区去豁免：running 候选（防御性结构）同入监督域", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.candidates.push({ id: "bg-3", rootSessionId: "r", agent: "chat", slug: "s", startedAt: 1 });
    deps.views.set("bg-3", { id: "bg-3", status: "running", hasResult: false, rootSessionId: "r", agent: "chat", slug: "s", startedAt: 1, closedReason: undefined });
    const { readopted } = supervisor.bootPartition();
    expect(readopted).toEqual(["bg-3"]);
    expect(supervisor.supervisedIds()).toEqual(["bg-3"]);
  });
});

describe("RoundSupervisor 通知对账（送指引前查替代）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setupDeadRecord(): { deps: ReturnType<typeof makeDeps>; supervisor: RoundSupervisor } {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    deps.views.set("bg-1", { id: "bg-1", status: "running", hasResult: false, rootSessionId: "r", agent: "worker", slug: "fix-bug", startedAt: 1, closedReason: undefined });
    return { deps, supervisor };
  }

  it("高置信（同 root + 同 agent + 同 slug + 看门狗窗内新建）→ 撤销指引改送替代终止通知 + 该放弃", () => {
    const { deps, supervisor } = setupDeadRecord();
    deps.candidates.push({ id: "bg-2", rootSessionId: "r", agent: "worker", slug: "fix-bug", startedAt: Date.now() - 1000 });
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    expect(deps.guidances).toHaveLength(0); // 指引撤销
    expect(deps.replaced).toHaveLength(1);
    expect(deps.replaced[0].replacementId).toBe("bg-2");
    expect(deps.givenUp).toEqual([{ recordId: "bg-1", kind: "superseded", detail: { replacementId: "bg-2" } }]);
    expect(supervisor.supervisedIds()).toEqual([]);
  });

  it("低置信（仅 agent 同名）→ 不撤销指引，指引自带豁免声明", () => {
    const { deps, supervisor } = setupDeadRecord();
    deps.candidates.push({ id: "bg-2", rootSessionId: "r", agent: "worker", slug: "other-task", startedAt: Date.now() - 1000 });
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(true);
    expect(deps.givenUp).toHaveLength(0);
  });

  it("同名但超出看门狗窗（无时序关联）→ 无替代命中，指引不带豁免声明", () => {
    const { deps, supervisor } = setupDeadRecord();
    deps.candidates.push({ id: "bg-2", rootSessionId: "r", agent: "worker", slug: "fix-bug", startedAt: Date.now() - ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS - 10_000 });
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(false);
    expect(deps.givenUp).toHaveLength(0);
  });

  it("无候选 → 指引不带豁免声明", () => {
    const { deps, supervisor } = setupDeadRecord();
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(false);
  });

  it("高置信对账按 slug 改写漏判 → 落入低置信（残余双执行风险面，豁免声明兜住）", () => {
    const { deps, supervisor } = setupDeadRecord();
    deps.candidates.push({ id: "bg-2", rootSessionId: "r", agent: "worker", slug: "rewritten-slug", startedAt: Date.now() - 1000 });
    supervisor.adoptOnProcessDeath(makeRecord(), "x");
    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(true);
  });
});
