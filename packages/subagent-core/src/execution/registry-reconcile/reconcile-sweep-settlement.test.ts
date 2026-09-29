// src/execution/registry-reconcile/reconcile-sweep-settlement.test.ts
//
// [W2/V4 D6] sweep 判据源改接后的补注销行为与幂等验证。
//
// V1 把 reconcile-sweep 的 workflow 分支判据源从两态机持久化快照（findStateByIdSync
// 的 state.status 字段）改接 journal run-settled 帧 ∨ manifest 终局面
//（findRunSettlementEvidence 判定核）——活体写点删除后 v2 run 的 state 快照
// 永停 running，旧判据对全部 v2 run 永判 active = sweep 结构性静默失效。本文件
// 验证改接后 sweep 对 v2 run 的补注销行为与幂等，并对 D6 判定矩阵的保守侧形态
// 各带断言（误注销为零——误注销活跃 run 是事故方向，不可逆）：
//
// [U1 判定核抽取（workflow-run-store-convergence）] 第二个 describe 块 =
// findRunSettlementEvidence 判定核直测：三态判定矩阵逐分支与 sweep 装配无关的
// 直接断言面（枚举改接 U2 将复用该核，矩阵每分支需要不经 runReconcileSweep 的
// 行为锁）。warn 断言经 configureCore 注入 log spy（logger facade 动态解析宿主）。
//
// | 改接后形态                          | sweep 判定              |
// |-------------------------------------|-------------------------|
// | journal run-settled 帧              | 补注销（reason 联合派生）|
// | journal 与 manifest 均不存在(ENOENT)| missing（视同终态补注销）|
// | journal 存在但无 settled 帧（坏链） | 保守按活跃，不补注销    |
// | journal 读错误（非 ENOENT IO 故障） | 保守按活跃，不补注销    |
//
// 验证形态：真实判定核判据 + 真实 session 文件读写 + runReconcileSweep
// 本体——判据不 mock（mock 矩阵只证分流逻辑，不证 V1 改接后的真实读侧行为）；
// appendEntry 注入与 pi 同构（同步追加 JSONL 行到 session 文件），幂等验证走
// 完整落盘路径。写删目标全部 mkdtempSync 自建自删（禁触真实数据目录纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mapReasonToStatus } from "@zhushanwen/extension-protocol";

import type { LogLevel } from "../../core/logger.ts";
import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import { findRunSettlementEvidence } from "../persistence/run-state-evidence.ts";
import {
  createRunEventJournal,
  RUN_EVENT_JOURNAL_SUFFIX,
  type RunErrorCode,
} from "../../orchestration/run-events.ts";
import { runReconcileSweep, type ReconcileSweepDeps } from "./reconcile-sweep.ts";
import { settlementEvidenceToRunState } from "./sweep-binding.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2-v4-sweep-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** <sessionDir>/workflow-state 布局（与 pi 壳 JsonlRunStore 落盘布局同源）。 */
function stateDirOf(): string {
  return path.join(tmpDir, "workflow-state");
}

/** 追加 pending:register 行进 session 文件（JSONL，与 pi appendEntry 行形态同构；
 * appendFileSync 首调自建文件，多条 register 共存）。 */
function writeRegisterEntry(id: string): void {
  fs.appendFileSync(
    path.join(tmpDir, "session.jsonl"),
    `${JSON.stringify({ customType: "pending:register", data: { id, type: "workflow" } })}\n`,
    "utf8",
  );
}

/** 读 session 文件的 unregister data 行（幂等/落盘断言用）。 */
function readUnregisterEntries(): Array<{ id?: unknown; reason?: unknown; status?: unknown }> {
  const content = fs.readFileSync(path.join(tmpDir, "session.jsonl"), "utf8");
  return content
    .split("\n")
    .filter((l) => l.includes('"pending:unregister"'))
    .map((l) => (JSON.parse(l) as { data: { id?: unknown; reason?: unknown; status?: unknown } }).data);
}

/** sweep 装配：真实判定核判据 + 与 pi 同构的 appendEntry（追加进 session
 * 文件并记录调用）。lookupRecordState 不会被 workflow 条目命中——挂 throw 哨兵。 */
function assembleSweep(): { deps: ReconcileSweepDeps; unregisterAppends: unknown[] } {
  const unregisterAppends: unknown[] = [];
  const deps: ReconcileSweepDeps = {
    sessionFile: path.join(tmpDir, "session.jsonl"),
    lookupRecordState: vi.fn(() => {
      throw new Error("subagent 判据不应被 workflow 条目命中");
    }),
    lookupWorkflowRunState: (runId) =>
      settlementEvidenceToRunState(findRunSettlementEvidence(stateDirOf(), runId)),
    appendEntry: (customType, data) => {
      if (customType === "pending:unregister") unregisterAppends.push(data);
      fs.appendFileSync(
        path.join(tmpDir, "session.jsonl"),
        `${JSON.stringify({ customType, data })}\n`,
        "utf8",
      );
    },
  };
  return { deps, unregisterAppends };
}

describe("[W2/V4 D6] sweep 判据源改接后的 v2 run 补注销（真实判定核判据）", () => {
  it("journal run-settled 帧 → 补注销，reason 经 (outcome, errorCode) 联合派生（budget_limited 细分保留，非 outcome 兜底折叠）", async () => {
    writeRegisterEntry("wf-v4-budget");
    const journal = createRunEventJournal(stateDirOf());
    await journal.append("wf-v4-budget", {
      type: "run-created",
      runId: "wf-v4-budget",
      workflowName: "review-fix-loop",
      argsSummary: "{}",
      ts: 1000,
    });
    await journal.append("wf-v4-budget", {
      type: "run-settled",
      outcome: "failed",
      errorCode: "budget_limited",
      artifactsDir: stateDirOf(),
      ts: 2000,
    });
    const { deps, unregisterAppends } = assembleSweep();

    const result = runReconcileSweep(deps);

    expect(result.reconciled).toEqual(["wf-v4-budget"]);
    expect(unregisterAppends).toHaveLength(1);
    // [W2 D5 连带取值③] reason 单点派生：failed + budget_limited → "budget_limited"
    //（细分保留——纯 outcome 反推会折叠成 "failed"，该断言即折叠回归钉）；status
    // 经 mapReasonToStatus 单点（与 finalizeRun 直落同一映射）。
    expect(unregisterAppends[0]).toEqual({
      id: "wf-v4-budget",
      reason: "budget_limited",
      status: mapReasonToStatus("budget_limited"),
    });
  });

  it("幂等：补注销 entry 落盘后二次 sweep 差集消失，不重复追加", async () => {
    writeRegisterEntry("wf-v4-idem");
    const journal = createRunEventJournal(stateDirOf());
    await journal.append("wf-v4-idem", {
      type: "run-created",
      runId: "wf-v4-idem",
      workflowName: "review-fix-loop",
      argsSummary: "{}",
      ts: 1000,
    });
    await journal.append("wf-v4-idem", {
      type: "run-settled",
      outcome: "done",
      artifactsDir: stateDirOf(),
      ts: 2000,
    });
    const { deps } = assembleSweep();

    const first = runReconcileSweep(deps);
    expect(first.reconciled).toEqual(["wf-v4-idem"]);
    // 第二次 sweep（同一 session 文件已含补注销行）——差集已被抵消
    const second = runReconcileSweep(deps);
    expect(second.reconciled).toEqual([]);
    // session 文件中 unregister 行恰 1 条（无重复追加）
    expect(readUnregisterEntries()).toHaveLength(1);
  });

  it("保守侧矩阵（误注销为零）：非终态（无 settled 帧）/ 坏链（首帧损坏）/ IO 故障（EISDIR）→ 全部按活跃挂账，零补注销", async () => {
    // 形态 a：journal 存在但无 run-settled 帧（run 真未终局）
    writeRegisterEntry("wf-v4-live");
    const journal = createRunEventJournal(stateDirOf());
    await journal.append("wf-v4-live", {
      type: "run-created",
      runId: "wf-v4-live",
      workflowName: "review-fix-loop",
      argsSummary: "{}",
      ts: 1000,
    });
    await journal.append("wf-v4-live", {
      type: "agent-started",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: 1001,
    });
    // 形态 b：坏链——首帧损坏（截断行）+ 无 settled 帧（run-settled 对坏链是
    // 表外转移，与 adoptInterruptedRun skippedBrokenChain 同款保守纪律）。
    // journal 文件名经 RUN_EVENT_JOURNAL_SUFFIX 单源拼出（后缀改名跟随单源，
    // 禁手写后缀字面量——曾因手写旧后缀在 [D1] 改名后判定核读空文件误入 missing）。
    writeRegisterEntry("wf-v4-broken");
    fs.mkdirSync(stateDirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDirOf(), `wf-v4-broken${RUN_EVENT_JOURNAL_SUFFIX}`),
      `{"trunc\n${JSON.stringify({ type: "run-created", runId: "wf-v4-broken", workflowName: "review-fix-loop", argsSummary: "{}", ts: 1000 })}\n`,
      "utf8",
    );
    // 形态 c：journal 读错误（非 ENOENT）——journal 路径为目录，readFileSync 抛 EISDIR
    writeRegisterEntry("wf-v4-iofail");
    fs.mkdirSync(path.join(stateDirOf(), `wf-v4-iofail${RUN_EVENT_JOURNAL_SUFFIX}`), { recursive: true });

    const { deps, unregisterAppends } = assembleSweep();
    const result = runReconcileSweep(deps);

    // 三形态全部保守按活跃挂账：不进 reconciled、落 skippedActive
    expect(result.reconciled).toEqual([]);
    expect(result.skippedActive).toEqual(
      expect.arrayContaining(["wf-v4-live", "wf-v4-broken", "wf-v4-iofail"]),
    );
    expect(unregisterAppends).toHaveLength(0);
  });

  it("missing（journal 与 manifest 均不存在）→ 视同终态补注销（reason=expired）", async () => {
    // 只写 register、不落任何证据文件（死亡窗口残留形态）
    writeRegisterEntry("wf-v4-gone");
    const { deps, unregisterAppends } = assembleSweep();

    const result = runReconcileSweep(deps);

    expect(result.reconciled).toEqual(["wf-v4-gone"]);
    expect(unregisterAppends[0]).toMatchObject({ id: "wf-v4-gone", reason: "expired" });
  });

  it("manifest 终局面（journal 无帧但 manifest 在盘）→ 补注销；interrupted → 'failed' 诊断兜底折叠（reason 面不变量）", async () => {
    writeRegisterEntry("wf-v4-manifest");
    fs.mkdirSync(stateDirOf(), { recursive: true });
    // 活体物化后 journal 被裁的组合：manifest 终局面是第二证据通道
    fs.writeFileSync(
      path.join(stateDirOf(), "wf-v4-manifest.json"),
      JSON.stringify({ outcome: "interrupted", errorCode: "idle-evicted" }),
      "utf8",
    );
    const { deps, unregisterAppends } = assembleSweep();

    const result = runReconcileSweep(deps);

    expect(result.reconciled).toEqual(["wf-v4-manifest"]);
    // [D16⑤ manifest 面 reason 换源（词表外折叠收敛到判定核单点）] interrupted
    // manifest 是历史写入方产物形态（[D2] 前旧收编链物化，文件名未随 [D1] 迁移
    // 故磁盘可达）——词表外 outcome 在派生函数 runSettledOutcomeToDoneReason 的
    // default 分支折叠 "failed"（W2 D5「interrupted → failed 诊断兜底容器」先例），
    // 判定核 reason 恒 string、消费侧零处理，不落 completed 兜底（完成语义对
    // 中断形态是误报）
    expect(unregisterAppends[0]).toMatchObject({ id: "wf-v4-manifest", reason: "failed" });
  });
});

// ============================================================
// [U1 判定核抽取] findRunSettlementEvidence 直测（矩阵逐分支行为锁）
// ============================================================

/** 追加 run-created + run-settled 两帧（真实 journal 写路径）。 */
async function writeSettledJournal(
  runId: string,
  outcome: "done" | "cancelled" | "failed",
  errorCode?: RunErrorCode,
): Promise<void> {
  const journal = createRunEventJournal(stateDirOf());
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: "review-fix-loop",
    argsSummary: "{}",
    ts: 1000,
  });
  await journal.append(runId, {
    type: "run-settled",
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    artifactsDir: stateDirOf(),
    ts: 2000,
  });
}

/** journal 非终局形态：run-created + agent-started（无 settled 帧）。 */
async function writeLiveJournal(runId: string): Promise<void> {
  const journal = createRunEventJournal(stateDirOf());
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: "review-fix-loop",
    argsSummary: "{}",
    ts: 1000,
  });
  await journal.append(runId, {
    type: "agent-started",
    taskIndex: 1,
    agentName: "a",
    attempt: 1,
    ts: 1001,
  });
}

describe("[U1 判定核抽取] findRunSettlementEvidence 直测（矩阵逐分支）", () => {
  // warn 断言面：configureCore 注入 log spy（内层 hooks 与外层 tmpDir 生命周期
  // 组合——内层 afterEach 先于外层执行，resetCoreForTests 不影响外层 rmSync）。
  let logSpy: ReturnType<
    typeof vi.fn<(level: LogLevel, component: string, message: string, data?: unknown) => void>
  >;

  beforeEach(() => {
    resetCoreForTests();
    logSpy = vi.fn((_level: LogLevel, _component: string, _message: string, _data?: unknown) => {});
    const host: HostServices = {
      dataRoot: () => tmpDir,
      log: logSpy,
    };
    configureCore(host);
  });

  afterEach(() => {
    resetCoreForTests();
  });

  function warnMessages(): string[] {
    return logSpy.mock.calls.filter((c) => c[0] === "warn").map((c) => String(c[2]));
  }

  it("journal run-settled 帧 → terminal，reason 联合派生全词表（done/cancelled/failed±细分/time_limited 直判——[D2]）", async () => {
    await writeSettledJournal("wf-core-done", "done");
    await writeSettledJournal("wf-core-cancel", "cancelled");
    await writeSettledJournal("wf-core-budget", "failed", "budget_limited");
    // [D2] time_limited 直判：outcome 帧形态（runSettledOutcomeToDoneReason 双向恒等）
    await createRunEventJournal(stateDirOf()).append("wf-core-time", {
      type: "run-settled",
      outcome: "time_limited",
      artifactsDir: stateDirOf(),
      ts: 2000,
    });
    await writeSettledJournal("wf-core-failed", "failed");
    await writeSettledJournal("wf-core-interrupted", "failed", "idle-evicted");

    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-done")).toEqual({
      kind: "terminal",
      reason: "completed",
    });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-cancel")).toEqual({
      kind: "terminal",
      reason: "aborted",
    });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-budget")).toEqual({
      kind: "terminal",
      reason: "budget_limited",
    });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-time")).toEqual({
      kind: "terminal",
      reason: "time_limited",
    });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-failed")).toEqual({
      kind: "terminal",
      reason: "failed",
    });
    // interrupted → "failed" 是诊断兜底容器（DoneReason 无 interrupted 成员）
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-interrupted")).toEqual({
      kind: "terminal",
      reason: "failed",
    });
  });

  it("尾向扫描容忍：settled 之前坏行 / 尾部空行 / 文件尾无换行的 settled 行 → 仍 terminal（帧行独立有效）", () => {
    fs.mkdirSync(stateDirOf(), { recursive: true });
    const created = JSON.stringify({
      type: "run-created",
      runId: "wf-core-noisy",
      workflowName: "review-fix-loop",
      argsSummary: "{}",
      ts: 1000,
    });
    const settled = JSON.stringify({
      type: "run-settled",
      outcome: "done",
      artifactsDir: stateDirOf(),
      ts: 2000,
    });
    // 行序（写盘时序）：坏行（截断）→ created → settled → 尾空行 → …settled 无尾换行变体。
    // 文件名经 RUN_EVENT_JOURNAL_SUFFIX 单源拼出（禁手写后缀字面量——改名漂移防线）。
    fs.writeFileSync(
      path.join(stateDirOf(), `wf-core-noisy${RUN_EVENT_JOURNAL_SUFFIX}`),
      `{"trunc\n${created}\n${settled}\n\n`,
      "utf8",
    );
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-noisy")).toEqual({
      kind: "terminal",
      reason: "completed",
    });

    // settled 为文件末行且无换行（append 崩溃窗口形态）——尾向首行即命中
    fs.writeFileSync(
      path.join(stateDirOf(), `wf-core-tailless${RUN_EVENT_JOURNAL_SUFFIX}`),
      `${created}\n${settled}`,
      "utf8",
    );
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-tailless")).toEqual({
      kind: "terminal",
      reason: "completed",
    });
  });

  it("journal 存在但无 settled 帧（含坏链首帧）→ running（保守活跃，零 warn）", async () => {
    await writeLiveJournal("wf-core-live");

    // 坏链变体：首帧截断 + created 有效（run-settled 对坏链是表外转移）
    fs.mkdirSync(stateDirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDirOf(), `wf-core-broken${RUN_EVENT_JOURNAL_SUFFIX}`),
      `{"trunc\n${JSON.stringify({ type: "run-created", runId: "wf-core-broken", workflowName: "review-fix-loop", argsSummary: "{}", ts: 1000 })}\n`,
      "utf8",
    );

    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-live")).toEqual({ kind: "running" });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-broken")).toEqual({ kind: "running" });
    expect(warnMessages()).toHaveLength(0);
  });

  it("journal ENOENT → manifest 第二证据 → terminal（outcome 派生，errorCode 细分可选）", () => {
    fs.mkdirSync(stateDirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDirOf(), "wf-core-manifest.json"),
      JSON.stringify({ outcome: "cancelled" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDirOf(), "wf-core-manifest-timed.json"),
      JSON.stringify({ outcome: "failed", errorCode: "time_limited" }),
      "utf8",
    );

    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-manifest")).toEqual({
      kind: "terminal",
      reason: "aborted",
    });
    // [D2] failed && errorCode=time_limited 的历史 manifest 形态：派生折叠 failed
    //（time_limited 升格后 runSettledOutcomeToDoneReason 仅对 outcome=time_limited
    // 直判，failed+time_limited 码组合不再特判）
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-manifest-timed")).toEqual({
      kind: "terminal",
      reason: "failed",
    });
  });

  it("journal ENOENT + manifest 在盘但 outcome 非 string（不构成终局证据）→ missing", () => {
    fs.mkdirSync(stateDirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDirOf(), "wf-core-blank.json"),
      JSON.stringify({ workflowName: "review-fix-loop" }),
      "utf8",
    );
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-blank")).toEqual({ kind: "missing" });
  });

  it("journal 与 manifest 均不存在（ENOENT）→ missing", () => {
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-gone")).toEqual({ kind: "missing" });
  });

  it("journal 非 ENOENT 读错（EISDIR）→ running + warn 留证（宁挂账不误注销）", () => {
    fs.mkdirSync(path.join(stateDirOf(), `wf-core-iofail${RUN_EVENT_JOURNAL_SUFFIX}`), {
      recursive: true,
    });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-iofail")).toEqual({ kind: "running" });
    expect(warnMessages()).toHaveLength(1);
    expect(warnMessages()[0]).toContain("journal read failed");
    expect(warnMessages()[0]).toContain("wf-core-iofail");
  });

  it("manifest 非 ENOENT 读错（journal 无帧 + manifest 为 EISDIR 目录）→ running + warn 留证", async () => {
    await writeLiveJournal("wf-core-manifest-iofail");
    fs.mkdirSync(path.join(stateDirOf(), "wf-core-manifest-iofail.json"), { recursive: true });
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-manifest-iofail")).toEqual({
      kind: "running",
    });
    expect(warnMessages()).toHaveLength(1);
    expect(warnMessages()[0]).toContain("manifest read failed");
  });

  it("manifest JSON 损坏（截断，SyntaxError ≠ ENOENT）→ running + warn 留证（parse 错与 IO 错同落保守分支）", () => {
    fs.mkdirSync(stateDirOf(), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(), "wf-core-badjson.json"), `{"outcome": "compl`, "utf8");
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-badjson")).toEqual({ kind: "running" });
    expect(warnMessages()).toHaveLength(1);
    expect(warnMessages()[0]).toContain("manifest read failed");
  });

  it("journal settled 帧优先于 manifest（帧在盘即判终局，不再回看 manifest）", async () => {
    await writeSettledJournal("wf-core-both", "done");
    fs.writeFileSync(
      path.join(stateDirOf(), "wf-core-both.json"),
      JSON.stringify({ outcome: "cancelled" }),
      "utf8",
    );
    expect(findRunSettlementEvidence(stateDirOf(), "wf-core-both")).toEqual({
      kind: "terminal",
      reason: "completed",
    });
  });
});
