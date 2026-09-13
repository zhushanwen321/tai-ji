// round-liveness-supervisor.test.ts —— [W6] 轮次活性监督器的 conformance 黑盒场景。
//
// 设计权威源：chat-domain-v1x-liveness-governance.md §3.2 D2（record 去向单一裁决
// 表 + 三态判定 + 通知对账 + 纳管模型）+ D5（H9 keep-alive-no-progress 承接落点）
// + 验收 A2/A5/A8。
//
// 与 W4 单测（execution/__tests__/round-supervisor.test.ts）的分工：W4 用替身 deps
// 全排列覆盖判定矩阵（白盒视角）；本套件是**语义钉住层**——把设计裁决表的场景链
// （协议事件 → record 处置 → 监督动作）按黑盒视角钉成契约，只经公共出口
// （`round-supervisor/index.ts`）消费，不 import 内部符号。每条链对应一个真实验收
// 场景，替身 deps 是场景道具而非判定逻辑复制品：
//
//   场景一（表 3 行 1 全链，事故主链）：run 在途 → 引擎进程被 SIGTERM（crash
//     message 形态取自 engine-crash.test.ts 的协议实证）→ noteRunEnded +
//     adoptOnProcessDeath → 合并单条通知 + 决策指引（该唤醒）→ 看门狗到期 →
//     该放弃（giveUp(watchdog-expired)，此时可重派）。
//   场景二（裁决表 conversation 行）：chatMode record 死亡事件 → 豁免不纳管
//     （轮终 idle / settled-watchdog 管辖，D2 前置 1）。
//   场景三（表 3 行 2/3 × A5 落盘断言）：boot 分区重认领（already-resumable-idle）
//     vs conversation 豁免；in-flight 直断后的注册残留由对账 sweep **appendEntry
//     权威落盘**补发（A5「注销落盘可查」的构造性证据——sweep 写法钉死：不经 bus
//     emit 作权威）。
//   场景四（通知对账两级启发式，R4）：高置信替代 → 撤销指引改送终止通知 + 该放弃
//     （superseded）；低置信 → 指引自带豁免声明。
//   场景五（纳管模型：死亡事件纳管、重建不解管）：crash 纳管后引擎被动重建
//     （镜像重填）不解除纳管、不重发指引——判定只消费 record 级状态。
//
// timer 用 fake timers；监督器对 fs 零依赖（场景三的 session file 由 sweep 读侧
// 消费，mkdtempSync 自建自删）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS,
  RoundSupervisor,
  runReconcileSweep,
  type RoundSupervisorDeps,
  type SupervisorCandidateRecord,
  type SupervisorRecordView,
} from "../../../round-supervisor/index.ts";
import type { ExecutionRecord } from "../../../assembly/types.ts";

// ── 场景道具（替身 deps——黑盒观测面：通知/指引/替代/放弃四出口 + 三状态源）────

function makeDeps() {
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
    sendDecisionGuidance: (record, opts) =>
      guidances.push({ record, exemptionDisclaimer: opts.exemptionDisclaimer }),
    sendReplacedNotice: (record, replacementId) => replaced.push({ record, replacementId }),
    giveUp: (recordId, kind, detail) => givenUp.push({ recordId, kind, detail }),
  };
  return Object.assign(deps, { views, candidates, live, notices, guidances, replaced, givenUp });
}

/** 后台子代理 record 替身（死亡事件纳管入口的入参形态）。 */
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

function viewOf(record: ExecutionRecord, overrides: Partial<SupervisorRecordView> = {}): SupervisorRecordView {
  return {
    id: record.id,
    status: record.status === "idle" && record.closedReason !== undefined ? "closed" : "running",
    resumable: record.resumable === true,
    hasResult: record.result !== undefined,
    chatMode: record.chatMode === true,
    rootSessionId: record.rootSessionId,
    agent: record.agent,
    slug: record.slug,
    startedAt: record.startedAt,
    closedReason: record.closedReason,
    ...overrides,
  };
}

/**
 * 引擎进程信号死亡的真实错误 message 形态（engine-crash.test.ts 的协议实证——
 * EngineClient.onEngineExit signal 分支 → engineCrashedError）。
 */
const SIGTERM_CRASH_MESSAGE =
  "engine_crashed: engine process exited unexpectedly: signal SIGTERM. stderr tail: (captured diagnostics)";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("[W6/D2 表 3 行 1] 引擎死亡 → failed 如实 + 监督器接管（事故主链）", () => {
  it("run 在途 → SIGTERM crash → 纳管：合并单条通知 + 决策指引（该唤醒）→ 看门狗到期 giveUp（该放弃）", async () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    const record = makeRecord();
    deps.views.set(record.id, viewOf(record));

    // 该等：run 在途（协议 run 帧受理——noteRunStarted 记账）→ 死亡事件前不干预。
    supervisor.noteRunStarted(record.id);

    // 死亡事件：run 终态 failed（engine_crashed，SIGTERM 形态）→ 驱动记账解除 +
    // record 保持 resumable（subagent-service adoptResumableAfterEngineDeath 的
    // 生产序列）→ 监督器纳管。
    supervisor.noteRunEnded(record.id);
    supervisor.adoptOnProcessDeath(record, SIGTERM_CRASH_MESSAGE);

    // 表 3 行 1 通知契约：failed 如实 + 已接管契约合并为**单条**通知（无双通知
    // 时序窗口）；主 agent 是唯一决策者——监督器不自动复活，只送决策指引。
    expect(deps.notices).toEqual([`merged:${record.id}`]);
    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(false);
    expect(supervisor.supervisedIds()).toEqual([record.id]);

    // 该唤醒后的等待有主：决策看门狗 armed（默认 2h）——到期且无决策/无收敛 →
    // 该放弃（failed 终态化 + 注销 + 终止通知，此时可重派）。
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);
    expect(deps.givenUp).toEqual([{ recordId: record.id, kind: "watchdog-expired", detail: {} }]);
    expect(supervisor.supervisedIds()).toEqual([]);
  });

  it("死亡事件重复（二次 crash 事件）幂等：不重复通知、不重复指引", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    const record = makeRecord();
    deps.views.set(record.id, viewOf(record));
    supervisor.adoptOnProcessDeath(record, SIGTERM_CRASH_MESSAGE);
    supervisor.adoptOnProcessDeath(record, SIGTERM_CRASH_MESSAGE);
    expect(deps.notices).toHaveLength(1);
    expect(deps.guidances).toHaveLength(1);
  });
});

describe("[W6/D2 裁决表 conversation 行] chat 域豁免", () => {
  it("chatMode record 的死亡事件不入监督域（轮终 idle / settled-watchdog 管辖）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    supervisor.adoptOnProcessDeath(makeRecord({ chatMode: true, resumable: true }), SIGTERM_CRASH_MESSAGE);
    expect(deps.notices).toHaveLength(0);
    expect(deps.guidances).toHaveLength(0);
    expect(supervisor.supervisedIds()).toEqual([]);
  });
});

describe("[W6/D2 表 3 行 2/3 × A5] boot 分区与 sweep 落盘衔接", () => {
  it("already-resumable-idle（非 conversation）→ 重认领接管并送达指引", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    const record = makeRecord({ id: "bg-survivor" });
    deps.candidates.push({ id: record.id, rootSessionId: record.rootSessionId, agent: record.agent, slug: record.slug, startedAt: record.startedAt });
    deps.views.set(record.id, viewOf(record));
    const { readopted } = supervisor.bootPartition();
    expect(readopted).toEqual([record.id]);
    expect(deps.guidances).toHaveLength(1);
    expect(supervisor.supervisedIds()).toEqual([record.id]);
  });

  it("in-flight 直断后的注册残留 → 对账 sweep appendEntry 权威落盘（A5「注销落盘可查」）", () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-supervisor-sweep-"));
    try {
      const sessionFile = join(dir, "session-child.jsonl");
      // 子 session 文件里的 register 残留（进程死亡窗口内注销发射源已消失——
      // notify-host getPi() 为 null 的缺位形态）。
      writeFileSync(
        sessionFile,
        `${JSON.stringify({ customType: "pending:register", data: { id: "bg-inflight", type: "subagent", name: "worker", sessionId: "sess-root" } })}\n`,
        "utf8",
      );
      const appended: Array<{ customType: string; data: unknown }> = [];
      const result = runReconcileSweep({
        sessionFile,
        lookupRecordState: (id) =>
          id === "bg-inflight" ? { terminal: true, closedReason: "boot-abort" } : "active",
        appendEntry: (customType, data) => {
          appended.push({ customType, data });
          // 权威落盘 = 直接 appendEntry（写法钉死：不经 bus emit 作权威）——
          // 用真实文件追加复现「落盘可查」。
          writeFileSync(
            sessionFile,
            `${JSON.stringify({ customType, data })}\n`,
            { flag: "a" },
          );
        },
      });
      expect(result.reconciled).toEqual(["bg-inflight"]);
      expect(appended).toHaveLength(1);
      expect(appended[0].customType).toBe("pending:unregister");
      // 差集消费方（goal 守卫）从持久化 entries 算差集——文件里补发的 unregister
      // 对守卫直接生效（守卫计数归零，A5 断言「重开后守卫计数归零」）。
      const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.some((l) => l.customType === "pending:unregister" && l.data.id === "bg-inflight")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("sweep 保守性：record 仍活跃的注册跳过（不误注销活跃后台任务）", () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-supervisor-sweep-active-"));
    try {
      const sessionFile = join(dir, "session-child.jsonl");
      writeFileSync(
        sessionFile,
        `${JSON.stringify({ customType: "pending:register", data: { id: "bg-alive", type: "subagent", name: "worker", sessionId: "sess-root" } })}\n`,
        "utf8",
      );
      const result = runReconcileSweep({
        sessionFile,
        lookupRecordState: () => "active",
      });
      expect(result.reconciled).toEqual([]);
      expect(result.skippedActive).toEqual(["bg-alive"]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe("[W6/D2 通知对账（R4 两级启发式）]", () => {
  it("高置信替代（同 root + 同 agent + 同 slug + 窗内）→ 撤销指引改送终止通知 + 该放弃(superseded)", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    const record = makeRecord();
    deps.views.set(record.id, viewOf(record));
    // 主 agent 在指引送达前已重派同任务（唯一决策者，重派合法）。
    deps.candidates.push({ id: "bg-2", rootSessionId: "sess-root", agent: "worker", slug: "fix-bug", startedAt: Date.now() - 1000 });

    supervisor.adoptOnProcessDeath(record, SIGTERM_CRASH_MESSAGE);

    expect(deps.guidances).toHaveLength(0); // 指引撤销（无双执行残径）
    expect(deps.replaced).toHaveLength(1);
    expect(deps.replaced[0].replacementId).toBe("bg-2");
    expect(deps.givenUp).toEqual([{ recordId: record.id, kind: "superseded", detail: { replacementId: "bg-2" } }]);
    expect(supervisor.supervisedIds()).toEqual([]);
  });

  it("低置信（仅 agent 同名）→ 不撤销指引，指引自带豁免声明（残余决策交还主 agent）", () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    const record = makeRecord();
    deps.views.set(record.id, viewOf(record));
    deps.candidates.push({ id: "bg-2", rootSessionId: "sess-root", agent: "worker", slug: "other-task", startedAt: Date.now() - 1000 });

    supervisor.adoptOnProcessDeath(record, SIGTERM_CRASH_MESSAGE);

    expect(deps.guidances).toHaveLength(1);
    expect(deps.guidances[0].exemptionDisclaimer).toBe(true);
    expect(deps.givenUp).toHaveLength(0);
  });
});

describe("[W6/D2 纳管模型] 死亡事件纳管、重建不解管", () => {
  it("crash 纳管后引擎被动重建（镜像重填再置死）不解除纳管、不重发指引", async () => {
    const deps = makeDeps();
    const supervisor = new RoundSupervisor(deps);
    const record = makeRecord();
    deps.views.set(record.id, viewOf(record));

    supervisor.adoptOnProcessDeath(record, SIGTERM_CRASH_MESSAGE);
    expect(deps.guidances).toHaveLength(1);

    // 引擎被动重建（ensureConnected 退避重填镜像——任一会话的下个请求触发）：
    // 镜像判「该等」仅解除看门狗计时；record 级状态未变 → 纳管持续、指引不重发。
    deps.live.add(record.id);
    supervisor.noteRunEnded(record.id);
    expect(supervisor.supervisedIds()).toEqual([record.id]);
    expect(deps.guidances).toHaveLength(1);

    // 重建后的进程又死（镜像再置死）——判定仍只消费 record 级状态。
    deps.live.delete(record.id);
    supervisor.noteRunEnded(record.id);
    expect(supervisor.supervisedIds()).toEqual([record.id]);
    expect(deps.guidances).toHaveLength(1);
    expect(deps.givenUp).toHaveLength(0);
  });
});
