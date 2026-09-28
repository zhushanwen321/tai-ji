// src/execution/registry-reconcile/reconcile-sweep-settlement.test.ts
//
// [W2/V4 D6] sweep 判据源改接后的补注销行为与幂等验证。
//
// V1 把 reconcile-sweep 的 workflow 分支判据源从两态机持久化快照（findStateByIdSync
// 的 state.status 字段）改接 journal run-settled 帧 ∨ manifest 终局面
//（FileRunStore.findSettlementEvidenceSync）——活体写点删除后 v2 run 的 state 快照
// 永停 running，旧判据对全部 v2 run 永判 active = sweep 结构性静默失效。本文件
// 验证改接后 sweep 对 v2 run 的补注销行为与幂等，并对 D6 判定矩阵的保守侧形态
// 各带断言（误注销为零——误注销活跃 run 是事故方向，不可逆）：
//
// | 改接后形态                          | sweep 判定              |
// |-------------------------------------|-------------------------|
// | journal run-settled 帧              | 补注销（reason 联合派生）|
// | journal 与 manifest 均不存在(ENOENT)| missing（视同终态补注销）|
// | journal 存在但无 settled 帧（坏链） | 保守按活跃，不补注销    |
// | journal 读错误（非 ENOENT IO 故障） | 保守按活跃，不补注销    |
//
// 验证形态：真实 FileRunStore 判据 + 真实 session 文件读写 + runReconcileSweep
// 本体——判据不 mock（mock 矩阵只证分流逻辑，不证 V1 改接后的真实读侧行为）；
// appendEntry 注入与 pi 同构（同步追加 JSONL 行到 session 文件），幂等验证走
// 完整落盘路径。写删目标全部 mkdtempSync 自建自删（禁触真实数据目录纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mapReasonToStatus } from "@zhushanwen/extension-protocol";

import { FileRunStore } from "../../orchestration/file-run-store.ts";
import { createRunEventJournal } from "../../orchestration/run-events.ts";
import { runReconcileSweep, type ReconcileSweepDeps } from "./reconcile-sweep.ts";

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

/** sweep 装配：真实 FileRunStore 判据 + 与 pi 同构的 appendEntry（追加进 session
 * 文件并记录调用）。lookupRecordState 不会被 workflow 条目命中——挂 throw 哨兵。 */
function assembleSweep(): { deps: ReconcileSweepDeps; unregisterAppends: unknown[] } {
  const store = new FileRunStore({ stateDir: stateDirOf() });
  const unregisterAppends: unknown[] = [];
  const deps: ReconcileSweepDeps = {
    sessionFile: path.join(tmpDir, "session.jsonl"),
    lookupRecordState: vi.fn(() => {
      throw new Error("subagent 判据不应被 workflow 条目命中");
    }),
    lookupWorkflowRunState: (runId) => {
      const state = store.findSettlementEvidenceSync(runId);
      if (state.kind === "missing") return "missing";
      if (state.kind === "terminal") return { terminal: true, closedReason: state.reason };
      return "active";
    },
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

describe("[W2/V4 D6] sweep 判据源改接后的 v2 run 补注销（真实 FileRunStore 判据）", () => {
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
      outcome: "completed",
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
      type: "ask-dispatched",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: 1001,
    });
    // 形态 b：坏链——首帧损坏（截断行）+ 无 settled 帧（run-settled 对坏链是
    // 表外转移，与 adoptInterruptedRun skippedBrokenChain 同款保守纪律）
    writeRegisterEntry("wf-v4-broken");
    fs.mkdirSync(stateDirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDirOf(), "wf-v4-broken.events.jsonl"),
      `{"trunc\n${JSON.stringify({ type: "run-created", runId: "wf-v4-broken", workflowName: "review-fix-loop", argsSummary: "{}", ts: 1000 })}\n`,
      "utf8",
    );
    // 形态 c：journal 读错误（非 ENOENT）——journal 路径为目录，readFileSync 抛 EISDIR
    writeRegisterEntry("wf-v4-iofail");
    fs.mkdirSync(path.join(stateDirOf(), "wf-v4-iofail.events.jsonl"), { recursive: true });

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
    // [W2 D5 显示语义不变量（reason 面）] interrupted → "failed" 诊断兜底容器
    //（细分语境 idle-evicted 由帧 errorCode 面保留；pending 条目 reason 面折叠）
    expect(unregisterAppends[0]).toMatchObject({ id: "wf-v4-manifest", reason: "failed" });
  });
});
