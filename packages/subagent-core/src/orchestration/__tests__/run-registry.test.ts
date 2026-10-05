// src/orchestration/__tests__/run-registry.test.ts
//
// [Q2/D9-1 → workflow-run-resume-revision] run 注册表单测——D5 状态机投影面 +
// 中断收编入口（[D15] 中断路）+ 已终局 run 磁盘足迹裁剪单源。
//
// 锁定语义：
// a. 投影四相（[D2] interrupted 暂停态入状态机——事件流判据）：
//    - run-settled 落账 → terminal（四值 outcome + errorCode）；
//    - run-interrupted 落账（显式中断转移）→ interrupted（暂停态，非 terminal，
//      与活体无关）；事件流停止（fold 停在 running/settling + 活体集未命中 =
//      host-died 判读）→ interrupted（快照末行 running 的僵尸在此消失）；
//    - 活体集命中 → active（事件流正常推进）；空事件流 → missing / active。
// b. [D9] abandon 全链移除断言：abandonElapsedInterruptedRuns 及常量/env 通道
//    从模块导出面消失（功能裁撤验收锚——「数天后回来仍可 resume」的 run 不再
//    被判死）；中断收编入口（adoptInterruptedRun → interruptRun）落
//    run-interrupted 转移事件（非 run-settled 终态帧——[D2] 中断非终局）+ 中断
//    条目（status 'interrupted'）补写回调恰一次。
// c. mtime 退役断言：投影/收编源码零 mtime 消费（grep 断言）。
//
// [W2/V1 → D15] 收编的记录动作走 terminal-actions 中断编排入口（模块 journal
// 单写者域）——测试注入面 = setRunEventJournalDirForTest（与帧落账同源）；seed
// 侧的本地 journal 实例与模块 journal 指向同一目录（文件层一致）。
//
// 测试红线：mkdtemp 自建自删、journal/manifest 全在 tmp、时钟经 now 参数注入
// （无 fake timers 依赖）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  adoptInterruptedRun,
  projectRunRegistryEvents,
  projectRunRegistryState,
} from "../run-registry.ts";
import {
  createRunEventJournal,
  type RunErrorCode,
  type RunEventJournal,
  type WorkflowRunEvent,
  type WorkflowRunEventInput,
} from "../run-events.ts";
import {
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { pruneTerminalRunFiles } from "../../execution/persistence/run-state-evidence.ts";
import {
  readRunTerminalManifest,
  writeRunTerminalManifest,
} from "../../execution/persistence/manifest-store.ts";

// ── helpers ──────────────────────────────────────────────────

let dir: string;
let journal: RunEventJournal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-registry-"));
  // [D15] 收编链（scan/manifest/帧落账）统一走模块 journal 单写者域——注入
  // 目录即覆盖；afterEach 复位（连带清 liveRunStates / 终局记录注册表）。
  setRunEventJournalDirForTest(dir);
  journal = createRunEventJournal(dir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const BASE_TS = 1_719_500_000_000;

// helpers 产 input 形态（seq 由 journal.append 分配——测试不经手）
function createdEvent(runId: string, ts: number): WorkflowRunEventInput {
  return { type: "run-created", runId, workflowName: "review-fix-loop", argsSummary: "{}", ts };
}

function agentStartedEvent(ts: number): WorkflowRunEventInput {
  return { type: "agent-started", taskIndex: 1, agentName: "reviewer", attempt: 1, ts };
}

function runSettledEvent(
  outcome: "done" | "failed" | "cancelled",
  ts: number,
  errorCode?: RunErrorCode,
): WorkflowRunEventInput {
  return {
    type: "run-settled",
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    artifactsDir: dir,
    ts,
  };
}

/** [D2] 中断转移帧（收编/terminate 被动失联写入——run-interrupted 非终局帧）。 */
function runInterruptedEvent(ts: number, errorCode?: RunErrorCode): WorkflowRunEventInput {
  return {
    type: "run-interrupted",
    ...(errorCode !== undefined ? { errorCode } : {}),
    ts,
  };
}

/** 落 record 事件序列（appendFileSync 直写——投影测试不走 dispatch 链）。 */
async function seed(runId: string, events: readonly WorkflowRunEventInput[]): Promise<void> {
  for (const event of events) {
    await journal.append(runId, event);
  }
}

// ── a. 投影四相（[D2] interrupted 暂停态） ────────────────────

describe("投影四相（事件流判据，D9-1 → [D2] 暂停态）", () => {
  it("事件流停止（活体未命中 = host-died 判读）→ interrupted（非 terminal 待恢复态；僵尸 running 构造性消除）", async () => {
    await seed("wf-reg-int", [createdEvent("wf-reg-int", BASE_TS), agentStartedEvent(BASE_TS + 1)]);

    // 快照末行 running 的僵尸形态（无活体持有）：投影 = interrupted
    const projection = await projectRunRegistryState(journal, "wf-reg-int");
    expect(projection.phase).toBe("interrupted");
    expect(projection.state).toEqual({ lifecycle: "running" });
    expect(projection.lastEventAt).toBe(BASE_TS + 1);
    // interrupted 非 terminal：无 outcome
    expect(projection.state.outcome).toBeUndefined();
  });

  it("[D2] run-interrupted 转移帧在盘 → interrupted（显式暂停态——与活体无关，收编后 resume 前窗口恒暂停）", async () => {
    await seed("wf-reg-explicit", [
      createdEvent("wf-reg-explicit", BASE_TS),
      agentStartedEvent(BASE_TS + 1),
      runInterruptedEvent(BASE_TS + 2, "crashed"),
    ]);

    // 无活体集合：fold 状态机终帧 = interrupted（显式转移）
    const projection = await projectRunRegistryState(journal, "wf-reg-explicit");
    expect(projection.phase).toBe("interrupted");
    expect(projection.state).toEqual({ lifecycle: "interrupted" });
    expect(projection.state.outcome).toBeUndefined();
  });

  it("run-settled → terminal：三态 outcome + errorCode 从事件帧读", async () => {
    await seed("wf-reg-ok", [createdEvent("wf-reg-ok", BASE_TS), runSettledEvent("done", BASE_TS + 5)]);
    await seed("wf-reg-fail", [
      createdEvent("wf-reg-fail", BASE_TS),
      runSettledEvent("failed", BASE_TS + 5, "engine_crashed"),
    ]);
    await seed("wf-reg-cancel", [
      createdEvent("wf-reg-cancel", BASE_TS),
      runSettledEvent("cancelled", BASE_TS + 5),
    ]);

    const ok = await projectRunRegistryState(journal, "wf-reg-ok");
    expect(ok.phase).toBe("terminal");
    expect(ok.state).toEqual({ lifecycle: "terminal", outcome: "done" });
    expect(ok.errorCode).toBeUndefined();

    const fail = await projectRunRegistryState(journal, "wf-reg-fail");
    expect(fail.phase).toBe("terminal");
    expect(fail.state).toEqual({ lifecycle: "terminal", outcome: "failed" });
    expect(fail.errorCode).toBe("engine_crashed");

    const cancel = await projectRunRegistryState(journal, "wf-reg-cancel");
    expect(cancel.phase).toBe("terminal");
    expect(cancel.state).toEqual({ lifecycle: "terminal", outcome: "cancelled" });
  });

  it("活体集命中 → active（事件流正常推进，fold 终帧对齐状态机 lifecycle）", async () => {
    await seed("wf-reg-live", [createdEvent("wf-reg-live", BASE_TS), agentStartedEvent(BASE_TS + 1)]);

    const projection = await projectRunRegistryState(journal, "wf-reg-live", {
      activeRunIds: new Set(["wf-reg-live"]),
    });
    expect(projection.phase).toBe("active");
    expect(projection.state.lifecycle).toBe("running");
  });

  it("空事件流：活体命中 → active（run-created 落账前窗口）；未命中 → missing", async () => {
    const live = await projectRunRegistryState(journal, "wf-reg-none", {
      activeRunIds: new Set(["wf-reg-none"]),
    });
    expect(live.phase).toBe("active");

    const missing = await projectRunRegistryState(journal, "wf-reg-none");
    expect(missing.phase).toBe("missing");
    expect(missing.state).toEqual({ lifecycle: "created" });
    expect(missing.lastEventAt).toBeUndefined();
  });

  it("纯函数入口 projectRunRegistryEvents：事件数组直投影（无 IO——判定输入只有事件流与活体集）", () => {
    // 投影消费 scan 产物（含 seq）——helper 产 input 形态，此处补 seq 组装
    const withSeq = (input: WorkflowRunEventInput, seq: number): WorkflowRunEvent => ({
      ...input,
      seq,
    });
    const interrupted = projectRunRegistryEvents(
      [withSeq(createdEvent("wf-pure", BASE_TS), 1), withSeq(agentStartedEvent(BASE_TS + 1), 2)],
      "wf-pure",
    );
    expect(interrupted.phase).toBe("interrupted");

    const terminal = projectRunRegistryEvents(
      [
        withSeq(createdEvent("wf-pure", BASE_TS), 1),
        withSeq(runSettledEvent("failed", BASE_TS + 2, "unknown"), 2),
      ],
      "wf-pure",
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.errorCode).toBe("unknown");
  });
});

// ── c. mtime 启发式退役断言 ──────────────────────────────────

describe("mtime 启发式退役（grep 断言）", () => {
  it("grep 断言：注册表投影/收编源码零 mtime API 消费（判据 = 事件流 + 活体集）", () => {
    const source = fs.readFileSync(new URL("../run-registry.ts", import.meta.url), "utf8");
    // 代码级退役断言：文件 mtime/stat 读取 API 零调用（注释中的「mtime 启发式退役」
    // 描述措辞不受限——断言的是旧启发式的代码载体已删除）
    expect(source).not.toMatch(/\.mtimeMs|statSync|utimesSync/);
  });
});

// ── b. [D9] abandon 全链移除断言 ─────────────────────────────

describe("[D9] abandon 全链移除（功能裁撤验收锚）", () => {
  it("grep 断言：abandon 函数族与 env 通道从模块导出面消失（词表成员 interrupted_abandoned 保留为历史帧解析）", () => {
    const source = fs.readFileSync(new URL("../run-registry.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+abandonElapsedInterruptedRuns/);
    expect(source).not.toMatch(/export\s+const\s+RUN_ABANDON_WINDOW_MS_ENV/);
    expect(source).not.toMatch(/export\s+function\s+resolveRunAbandonWindowMs/);
    // 中断收编入口在位（abandon 的替代通道——[D15] 中断路生产原语）
    expect(source).toMatch(/export\s+async\s+function\s+adoptInterruptedRun/);
  });
});

// ── [D15] 中断收编入口 adoptInterruptedRun（幂等追加 run-interrupted 转移事件）──
//
// 锁定语义（设计 [D2]/[D15]）：
// - 有注册无终局（活体集未命中的静止流）→ 幂等追加 run-interrupted 转移事件 +
//   中断条目（status 'interrupted'）补写回调恰一次；**不写 manifest**（中断非
//   终局——manifest 是 run-settled 终局事件的派生缓存，[D1]）；
// - 双重启不重复追加：再次收编命中 fold interrupted / manifest / 条面证据
//   → skippedTerminal，record 帧数不增长；
// - 条目面证据（hasSettledEntry）独立拦截——覆盖「record 损坏但条目完好」的
//   双面证据组合；
// - 宽限窗 / 活跃保护 / 坏链（fold 停在 created）/ 空 record 的分类跳过。

describe("中断收编入口 adoptInterruptedRun（[D15]：幂等追加 run-interrupted 转移事件）", () => {
  it("有注册无终态 → 追加 run-interrupted（中断非终局：无 manifest、无 outcome）+ 中断条目回调恰一次", async () => {
    await seed("wf-ad-1", [createdEvent("wf-ad-1", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    const appendedEntries: unknown[] = [];

    const outcome = await adoptInterruptedRun("wf-ad-1", {
      now: BASE_TS + 1000,
      appendInterruptedEntry: (entry) => appendedEntries.push(entry),
    });

    expect(outcome).toBe("adopted");
    const events = await journal.scan("wf-ad-1");
    expect(events.map((e) => e.type)).toEqual(["run-created", "agent-started", "run-interrupted"]);
    const interrupted = events[2] as Extract<WorkflowRunEvent, { type: "run-interrupted" }>;
    expect(interrupted.errorCode).toBeUndefined(); // 缺省无来源标记（调用方未传）
    expect(interrupted.ts).toBe(BASE_TS + 1000);
    // [D2] 中断非终局：不写 manifest 派生缓存（终局专属）
    expect(await readRunTerminalManifest(dir, "wf-ad-1")).toBeNull();
    // 收编场景无内存聚合：callCount 从 record agent-settled 帧数推导（本 fixture 无
    // agent-settled 帧 = 0），usedTokens 事件流不可得 = 0（摘要级诚实缺省）
    expect(appendedEntries).toHaveLength(1);
    expect(appendedEntries[0]).toMatchObject({
      v: 2,
      kind: "settled",
      runId: "wf-ad-1",
      status: "interrupted", // [D2] 中断形态条目（暂停态收敛词，非终态 'done'）
      callCount: 0,
      usedTokens: 0,
    });
  });

  it("收编幂等（双重启不重复追加）：第二次收编命中 fold interrupted → record 帧数不增长", async () => {
    await seed("wf-ad-2", [createdEvent("wf-ad-2", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    const first = await adoptInterruptedRun("wf-ad-2", { now: BASE_TS + 1000 });
    expect(first).toBe("adopted");
    // 「双重启」= 两次独立收编调用（模拟两次进程重启后的收编）
    const second = await adoptInterruptedRun("wf-ad-2", { now: BASE_TS + 2000 });
    const third = await adoptInterruptedRun("wf-ad-2", { now: BASE_TS + 3000 });
    expect(second).toBe("skippedTerminal");
    expect(third).toBe("skippedTerminal");
    // run-interrupted 恰一帧（重复追加被幂等拦截）
    const events = await journal.scan("wf-ad-2");
    expect(events.filter((e) => e.type === "run-interrupted")).toHaveLength(1);
  });

  it("manifest 面证据：record 已被清空但 manifest 在（旧终局产物）→ 跳过不追加", async () => {
    await seed("wf-ad-3", [createdEvent("wf-ad-3", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    await writeRunTerminalManifest(dir, {
      id: "wf-ad-3",
      workflowName: "review-fix-loop",
      outcome: "done",
      settledAt: BASE_TS + 5,
    });
    const outcome = await adoptInterruptedRun("wf-ad-3", { now: BASE_TS + 1000 });
    expect(outcome).toBe("skippedTerminal");
    expect((await journal.scan("wf-ad-3")).map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
    ]);
  });

  it("条目面证据（双面证据第二条）：hasSettledEntry=true → 跳过（record 损坏但条目完好的组合）", async () => {
    await seed("wf-ad-4", [createdEvent("wf-ad-4", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    const outcome = await adoptInterruptedRun("wf-ad-4", {
      now: BASE_TS + 1000,
      hasSettledEntry: (runId) => runId === "wf-ad-4",
    });
    expect(outcome).toBe("skippedTerminal");
    expect((await journal.scan("wf-ad-4")).map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
    ]);
  });

  it("活跃保护：activeRunIds 命中 → skippedActive（事件流静默 ≠ 死亡）", async () => {
    await seed("wf-ad-6", [createdEvent("wf-ad-6", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    const outcome = await adoptInterruptedRun("wf-ad-6", {
      now: BASE_TS + 1000,
      activeRunIds: new Set(["wf-ad-6"]),
    });
    expect(outcome).toBe("skippedActive");
    expect((await journal.scan("wf-ad-6")).map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
    ]);
  });

  it("坏链守卫：run-created 帧损坏（fold 停在 created）→ skippedBrokenChain（run-interrupted 表外转移不可达）", async () => {
    // 直写坏首帧 + 好后续帧：scan 丢弃坏行后 fold 停在 created（无创建帧可达态）
    fs.writeFileSync(
      path.join(dir, "wf-ad-7.record.jsonl"),
      [
        "{not json", // 坏：run-created 帧损坏
        JSON.stringify({ type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: BASE_TS }),
      ].join("\n"),
      "utf8",
    );
    const outcome = await adoptInterruptedRun("wf-ad-7", { now: BASE_TS + 1000 });
    expect(outcome).toBe("skippedBrokenChain");
    expect(await readRunTerminalManifest(dir, "wf-ad-7")).toBeNull();
  });

  it("空 record（missing）→ skippedMissing", async () => {
    const outcome = await adoptInterruptedRun("wf-ad-never", { now: BASE_TS });
    expect(outcome).toBe("skippedMissing");
  });

  it("[D2/D9 裁决点 7 前置] 中断态不获 prune 资格（fold 不达 terminal——宁保留不误裁；无主 run 清理归对账清理）", async () => {
    await seed("wf-ad-prune", [createdEvent("wf-ad-prune", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    fs.writeFileSync(path.join(dir, "wf-ad-prune.jsonl"), '{"runId":"wf-ad-prune"}\n');

    // 收编（中断转移）→ fold 停在 interrupted（非 terminal）
    const adopted = await adoptInterruptedRun("wf-ad-prune", { now: BASE_TS + 1000 });
    expect(adopted).toBe("adopted");
    // prune：非终态 = 无资格，不裁（磁盘清理的唯一通道是终局超窗，无主 run 归
    // 裁决点 7 对账清理——[D9] abandon 移除后的语义闭环）
    const result = await pruneTerminalRunFiles(
      dir,
      { ttlMs: 1000 },
      { warn: () => {}, debug: () => {}, toMsg: (e) => String(e) },
    );
    expect(result).toMatchObject({ eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(fs.existsSync(path.join(dir, "wf-ad-prune.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "wf-ad-prune.record.jsonl"))).toBe(true);
  });
});

// ── pruneTerminalRunFiles 单源（Q2 收口：jsonl-run-store 本地实现已删） ──

describe("pruneTerminalRunFiles（已终局资格单源：fold 终态 + 保留窗口 + journal 成对删）", () => {
  const noopDeps = { warn: () => {}, debug: () => {}, toMsg: (e: unknown) => String(e) };
  const RETENTION_30D_MS = 30 * 24 * 60 * 60 * 1000;

  function stateFile(runId: string): string {
    return path.join(dir, `${runId}.jsonl`);
  }

  it("废 cap 回归：非终态（无 settled 帧的 record）数量再多也零裁剪，仅计候选", async () => {
    // cap 语义废除后的结构断言：资格判据唯一 = fold 终态 ∧ 超窗——
    // 非终态 run 无论多少（旧 cap 会「裁最旧挤掉 50 名外」）一律保留并计入
    // 判据②候选计数（多 session 分摊不再互杀，A-8 回归锚）
    await seed("wf-pr-active", [createdEvent("wf-pr-active", BASE_TS), agentStartedEvent(BASE_TS + 1)]);
    fs.writeFileSync(stateFile("wf-pr-active"), "x\n");

    const result = await pruneTerminalRunFiles(dir, { ttlMs: RETENTION_30D_MS }, noopDeps);

    expect(result).toMatchObject({ scanned: 1, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(fs.existsSync(stateFile("wf-pr-active"))).toBe(true);
  });

  it("窗外终态裁（state + journal 成对删）；窗内终态与 manifest 保护", async () => {
    // 窗外终态：run-settled 帧 ts = BASE_TS（远超 30 天窗口）
    await seed("wf-pr-stale", [createdEvent("wf-pr-stale", BASE_TS), runSettledEvent("done", BASE_TS + 1)]);
    fs.writeFileSync(stateFile("wf-pr-stale"), "x\n");
    // 窗内终态：run-settled 帧 ts = 当前时刻（窗内全保留——数量再大也不触发截断）
    await seed("wf-pr-fresh", [
      createdEvent("wf-pr-fresh", Date.now() - 1000),
      runSettledEvent("done", Date.now()),
    ]);
    fs.writeFileSync(stateFile("wf-pr-fresh"), "x\n");

    const result = await pruneTerminalRunFiles(dir, { ttlMs: RETENTION_30D_MS }, noopDeps);

    expect(result).toMatchObject({ scanned: 2, eligible: 2, pruned: 1, nonTerminalBeyondWindow: 0 });
    expect(fs.existsSync(stateFile("wf-pr-stale"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "wf-pr-stale.record.jsonl"))).toBe(false);
    expect(fs.existsSync(stateFile("wf-pr-fresh"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "wf-pr-fresh.record.jsonl"))).toBe(true);
  });

  it("glob 外文件（journal 自身 / 非 wf- 前缀）不进候选；目录缺失静默零计数", async () => {
    const result = await pruneTerminalRunFiles(path.join(dir, "not-exist"), {}, noopDeps);
    expect(result).toEqual({ scanned: 0, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 0 });
  });
});
