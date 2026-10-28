// jsonl-run-store-merged.test.ts —— subagent-workflow C11 簇合并产物（round5-G）。
// 共同被测业务模块：`src/jsonl-run-store.ts`。mock 相容：单侧 mock @zhushanwen/pi-extension-logger、@zhushanwen/subagent-core/core/logger.ts——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/jsonl-run-store-session-file.test.ts（28 用例，skip 0）
//   - src/__tests__/workflow-notify.test.ts（37 用例，skip 0）

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CustomEntry, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Budget, isRunSettled, Trace, WorkflowRun, runMemberViews, runSummary, RUN_EVENTS_SUFFIX, WORKFLOW_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_ENTRY_VERSION } from '@zhushanwen/subagent-core'
import { JsonlRunStore, type RunSettlementRecord } from '../jsonl-run-store.ts'
import { mkCtx, mkPi } from '@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts'
import { fileURLToPath } from 'node:url'
import { STALE_CTX_MARKER } from '@zhushanwen/pi-ext-guards'
import { type DeliveryPortHandle, DELIVERY_PORT_SLOT_KEY } from '@zhushanwen/pi-delivery-port'
import { MAX_NOTIFIED_RUN_IDS, notifyDone, trackNotifiedRunId, WORKFLOW_DONE_NOTIFY_ID_PREFIX } from '../workflow-notify.ts'
import { runSettledEffects, type RunSettledEffectsEnv } from '../workflow-events.ts'

// logger mock（文件级）：jsonl-run-store.ts 模块级 getLogger 拿到此 mock，
// 坏行拒绝 / 历史分流 / stale guard 的留痕断言消费。
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const { loggerFns } = vi.hoisted(() => ({
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerFns,
  setPiHandle: vi.fn(),
}));

// ======== 来源：jsonl-run-store-session-file.test.ts ========
describe("jsonl-run-store-session-file", () => {
  /** 向 stateDir 的 record 流追加一帧（raw JSONL——模拟 core 写者写入 journal 记录）。 */
  function appendRecordLine(tmpDir: string, runId: string, line: Record<string, unknown>): string {
    const recordPath = path.join(tmpDir, `${runId}${RUN_EVENTS_SUFFIX}`);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.appendFileSync(recordPath, `${JSON.stringify(line)}\n`, "utf8");
    return recordPath;
  }

  /** [D1] 手工 v2 注册条目夹具（字段集 = core lifecycle 写点同构）。 */
  function v2RegisteredEntry(runId: string, recordPath: string): CustomEntry {
    return {
      type: "custom",
      customType: WORKFLOW_RECORD_CUSTOM_TYPE,
      data: {
        v: WORKFLOW_RECORD_ENTRY_VERSION,
        kind: "registered",
        runId,
        workflowName: "test-script",
        scriptName: "test-script",
        slug: "test-script",
        startedAt: Date.now(),
        recordPath,
      },
      id: `seed-v2-reg-${runId}`,
      parentId: null,
      timestamp: new Date().toISOString(),
    };
  }

  /** [W1 / D1] 手工 v2 终态条目夹具（kind: settled）。 */
  function v2SettledEntry(runId: string): CustomEntry {
    return {
      type: "custom",
      customType: WORKFLOW_RECORD_CUSTOM_TYPE,
      data: {
        v: WORKFLOW_RECORD_ENTRY_VERSION,
        kind: "settled",
        runId,
        status: "done",
        reason: "completed",
        outcome: "done",
        settledAt: Date.now(),
        callCount: 1,
        usedTokens: 0,
      },
      id: `seed-v2-settled-${runId}`,
      parentId: null,
      timestamp: new Date().toISOString(),
    };
  }

  /** record 流三帧夹具：created + settled call（带 result 全文/sessionFile）+ run-settled。 */
  function seedSettledRunWithCall(
    tmpDir: string,
    runId: string,
    result: Record<string, unknown>,
  ): string {
    appendRecordLine(tmpDir, runId, { type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
    appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1 });
    appendRecordLine(tmpDir, runId, { type: "agent-settled", seq: 3, ts: 1200, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 100, result });
    return appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 4, ts: 1300, outcome: "done", artifactsDir: tmpDir });
  }

  // ── record 重建 round-trip（sessionFile / result 全文保真）────────────

  describe("W1[D1]: record 重建 round-trip（call 级详情经 agent-settled result 恢复）", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
      loggerMock.warn.mockClear();
      loggerMock.debug.mockClear();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    it("loadAll round-trip: spec.budgetTimeMs 经 run-created 帧恢复（core rebuildRunFromRecord 同款条件式）", async () => {
      const runId = "run-rt-budget";
      const recordPath = appendRecordLine(tmpDir, runId, {
        type: "run-created",
        seq: 1,
        ts: 1000,
        runId,
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('x')",
        budgetTimeMs: 600_000,
      });
      appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      expect(restored[0]!.spec.budgetTimeMs).toBe(600_000);
    });

    it("[§3.3.6/§3.3.9 budget] agent-started input 载荷 → call.opts 声明值恢复（budgetViewOf 消费）；旧格式帧回落占位不误报", async () => {
      const runId = "run-rt-input-opts";
      const recordPath = appendRecordLine(tmpDir, runId, {
        type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')",
      });
      // taskIndex 0：input 载荷携带声明入参（maxTurns/timeoutMs——重派集窗口的预算事实源）。
      appendRecordLine(tmpDir, runId, {
        type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1,
        input: JSON.stringify({ prompt: "p0", maxTurns: 3, timeoutMs: 45_000 }),
      });
      appendRecordLine(tmpDir, runId, { type: "agent-settled", seq: 3, ts: 1200, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 100, result: { content: "r0" } });
      // taskIndex 1：旧格式帧（无 input 载荷）——无可恢复声明值，opts 占位（未声明语义）。
      appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 4, ts: 1250, taskIndex: 1, agentName: "reviewer", attempt: 1 });
      appendRecordLine(tmpDir, runId, { type: "agent-settled", seq: 5, ts: 1300, taskIndex: 1, attempt: 1, outcome: "done", durationMs: 50, result: { content: "r1" } });
      appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 6, ts: 1400, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      const calls = restored[0]!.state.calls;
      expect(calls.get(0)?.opts).toEqual({ prompt: "p0", maxTurns: 3, timeoutMs: 45_000 });
      expect(calls.get(1)?.opts).toEqual({ prompt: "" });

      // 端到端：成员表 budget 分轴从恢复的声明值派生（已声明上界不显示为「显式无界」）。
      const members = runMemberViews(restored[0]!, { now: 2000 });
      expect(members[0]!.budget).toEqual({ maxTurns: 3, timeoutMs: 45_000, budgetTokens: null, budgetTimeMs: null });
      expect(members[1]!.budget).toEqual({ maxTurns: null, timeoutMs: null, budgetTokens: null, budgetTimeMs: null });
    });

    it("[§2.1 / ADR-0094] loadAll round-trip: worker-log 诊断帧 → run.state.errorLogs 重建（此前重启即空）", async () => {
      const runId = "run-rt-error-logs";
      const recordPath = appendRecordLine(tmpDir, runId, {
        type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')",
      });
      appendRecordLine(tmpDir, runId, { type: "worker-log", seq: 2, ts: 1500, entry: { level: "warn", message: "w1" } });
      appendRecordLine(tmpDir, runId, { type: "worker-log", seq: 3, ts: 1600, entry: { level: "error", message: "e1" } });
      appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 4, ts: 2000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      expect(restored[0]!.state.errorLogs).toEqual([
        { level: "warn", message: "w1" },
        { level: "error", message: "e1" },
      ]);
    });

    it("[§2.1 / ADR-0094] 无诊断帧的旧 journal → errorLogs 空数组（不因新帧类型而拒绝旧流）", async () => {
      const runId = "run-rt-error-logs-legacy";
      const recordPath = appendRecordLine(tmpDir, runId, {
        type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')",
      });
      appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      expect(restored[0]!.state.errorLogs).toEqual([]);
    });

    it("loadAll round-trip: 旧格式帧（无 budgetTimeMs）/ 0 值 → spec 无预算（不限时，与 core 侧等价）", async () => {
      const legacyId = "run-rt-budget-legacy";
      const legacyPath = appendRecordLine(tmpDir, legacyId, { type: "run-created", seq: 1, ts: 1000, runId: legacyId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
      appendRecordLine(tmpDir, legacyId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });
      const zeroId = "run-rt-budget-zero";
      const zeroPath = appendRecordLine(tmpDir, zeroId, { type: "run-created", seq: 1, ts: 1000, runId: zeroId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTimeMs: 0 });
      appendRecordLine(tmpDir, zeroId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(legacyId, legacyPath), v2RegisteredEntry(zeroId, zeroPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      const byId = new Map(restored.map((r) => [r.runId, r]));
      expect(byId.get(legacyId)!.spec.budgetTimeMs).toBeUndefined();
      expect(byId.get(zeroId)!.spec.budgetTimeMs).toBeUndefined();
    });

    it("loadAll round-trip: spec.budgetTimeMs 取最近一条 run-resumed 的生效值（覆盖 created；旧格式 run-resumed 回落 created）", async () => {
      // created 60min + run-resumed 120min → 生效 120min（跨崩溃存续的 record 侧）
      const overrideId = "run-rt-budget-resumed";
      const overridePath = appendRecordLine(tmpDir, overrideId, { type: "run-created", seq: 1, ts: 1000, runId: overrideId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTimeMs: 3_600_000 });
      appendRecordLine(tmpDir, overrideId, { type: "run-interrupted", seq: 2, ts: 2000, errorCode: "crashed" });
      appendRecordLine(tmpDir, overrideId, { type: "run-resumed", seq: 3, ts: 3000, budgetTimeMs: 7_200_000 });
      appendRecordLine(tmpDir, overrideId, { type: "run-settled", seq: 4, ts: 4000, outcome: "done", artifactsDir: tmpDir });

      // created 60min + 旧格式 run-resumed（无 budgetTimeMs）→ 回落 created 60min
      const legacyResumedId = "run-rt-budget-legacy-resumed";
      const legacyResumedPath = appendRecordLine(tmpDir, legacyResumedId, { type: "run-created", seq: 1, ts: 1000, runId: legacyResumedId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTimeMs: 3_600_000 });
      appendRecordLine(tmpDir, legacyResumedId, { type: "run-interrupted", seq: 2, ts: 2000, errorCode: "crashed" });
      appendRecordLine(tmpDir, legacyResumedId, { type: "run-resumed", seq: 3, ts: 3000 });
      appendRecordLine(tmpDir, legacyResumedId, { type: "run-settled", seq: 4, ts: 4000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(overrideId, overridePath), v2RegisteredEntry(legacyResumedId, legacyResumedPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      const byId = new Map(restored.map((r) => [r.runId, r]));
      expect(byId.get(overrideId)!.spec.budgetTimeMs).toBe(7_200_000);
      expect(byId.get(legacyResumedId)!.spec.budgetTimeMs).toBe(3_600_000);
    });

    it("loadAll round-trip: spec.budgetTokens 与时间轴同构——无 run-resumed 回落 created（0 值不限）", async () => {
      // created 10k → 生效 10k
      const createdId = "run-rt-tokens-created";
      const createdPath = appendRecordLine(tmpDir, createdId, { type: "run-created", seq: 1, ts: 1000, runId: createdId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTokens: 10_000 });
      appendRecordLine(tmpDir, createdId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });
      // created 无 budgetTokens / 0 值 → 不限制（旧格式行为不劣化）
      const legacyId = "run-rt-tokens-legacy";
      const legacyPath = appendRecordLine(tmpDir, legacyId, { type: "run-created", seq: 1, ts: 1000, runId: legacyId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
      appendRecordLine(tmpDir, legacyId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });
      const zeroId = "run-rt-tokens-zero";
      const zeroPath = appendRecordLine(tmpDir, zeroId, { type: "run-created", seq: 1, ts: 1000, runId: zeroId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTokens: 0 });
      appendRecordLine(tmpDir, zeroId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [
        v2RegisteredEntry(createdId, createdPath),
        v2RegisteredEntry(legacyId, legacyPath),
        v2RegisteredEntry(zeroId, zeroPath),
      ];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      const byId = new Map(restored.map((r) => [r.runId, r]));
      expect(byId.get(createdId)!.spec.budgetTokens).toBe(10_000);
      expect(byId.get(legacyId)!.spec.budgetTokens).toBeUndefined();
      expect(byId.get(zeroId)!.spec.budgetTokens).toBeUndefined();
    });

    it("loadAll round-trip: spec.budgetTokens 取最近一条 run-resumed 的生效值（覆盖 created；旧格式 run-resumed 回落 created）", async () => {
      // created 10k + run-resumed 50k → 生效 50k（跨崩溃存续的 record 侧）
      const overrideId = "run-rt-tokens-resumed";
      const overridePath = appendRecordLine(tmpDir, overrideId, { type: "run-created", seq: 1, ts: 1000, runId: overrideId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTokens: 10_000 });
      appendRecordLine(tmpDir, overrideId, { type: "run-interrupted", seq: 2, ts: 2000, errorCode: "crashed" });
      appendRecordLine(tmpDir, overrideId, { type: "run-resumed", seq: 3, ts: 3000, budgetTokens: 50_000 });
      appendRecordLine(tmpDir, overrideId, { type: "run-settled", seq: 4, ts: 4000, outcome: "done", artifactsDir: tmpDir });

      // created 10k + 旧格式 run-resumed（无 budgetTokens）→ 回落 created 10k
      const legacyResumedId = "run-rt-tokens-legacy-resumed";
      const legacyResumedPath = appendRecordLine(tmpDir, legacyResumedId, { type: "run-created", seq: 1, ts: 1000, runId: legacyResumedId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTokens: 10_000 });
      appendRecordLine(tmpDir, legacyResumedId, { type: "run-interrupted", seq: 2, ts: 2000, errorCode: "crashed" });
      appendRecordLine(tmpDir, legacyResumedId, { type: "run-resumed", seq: 3, ts: 3000 });
      appendRecordLine(tmpDir, legacyResumedId, { type: "run-settled", seq: 4, ts: 4000, outcome: "done", artifactsDir: tmpDir });

      const entries: CustomEntry[] = [v2RegisteredEntry(overrideId, overridePath), v2RegisteredEntry(legacyResumedId, legacyResumedPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      const byId = new Map(restored.map((r) => [r.runId, r]));
      expect(byId.get(overrideId)!.spec.budgetTokens).toBe(50_000);
      expect(byId.get(legacyResumedId)!.spec.budgetTokens).toBe(10_000);
    });

    it("loadAll round-trip: AgentCall.sessionFile / sessionId 经 result 载荷恢复（overlay 定位链）", async () => {
      const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
      const runId = "run-rt-001";
      const recordPath = seedSettledRunWithCall(tmpDir, runId, {
        content: "done",
        sessionId: "session-abc",
        sessionFile: sessionFilePath,
      });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      expect(restored).toHaveLength(1);
      expect(restored[0]!.runId).toBe(runId);
      const call = restored[0]!.state.calls.get(0);
      expect(call).toBeDefined();
      expect(call!.sessionFile).toBe(sessionFilePath);
      expect(call!.sessionId).toBe("session-abc");
      expect(call!.result?.content).toBe("done");
      expect(call!.status).toBe("done");
    });

    it("loadAll round-trip: result 全文不裁（10000 字符 content 逐字节恢复——resume 缓存回放的数据）", async () => {
      const longContent = "q".repeat(10000);
      const runId = "run-rt-long";
      const recordPath = seedSettledRunWithCall(tmpDir, runId, { content: longContent });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      expect(restored[0]!.state.calls.get(0)!.result?.content).toHaveLength(10000);
      // trace 节点回链同一 result（D-10 引用共享重建）
      expect(restored[0]!.state.trace.toArray()[0]!.result?.content).toBe(longContent);
    });

    it("loadAll round-trip: spec.scriptSource 经 run-created 帧恢复（[D1] resume 重放的脚本体数据）", async () => {
      const runId = "run-rt-script";
      const recordPath = seedSettledRunWithCall(tmpDir, runId, { content: "done" });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      expect(restored[0]!.spec.scriptSource).toBe("agent('x')");
      expect(restored[0]!.spec.scriptName).toBe("test-script");
      // meta.startedAt 优先 run-created 帧 ts（ISO 往返）
      expect(restored[0]!.meta.startedAt).toBe(new Date(1000).toISOString());
      expect(restored[0]!.meta.completedAt).toBe(new Date(1300).toISOString());
    });

    it("在途 call（dispatched 无 settled）重建为 running——恢复链 closeOut 的消费形态", async () => {
      const runId = "run-rt-inflight";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
      appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1 });
      appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 3, ts: 1150, taskIndex: 1, agentName: "reviewer", attempt: 1, phase: "review" });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      // [D6(a) 第 3 步] 活体判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(restored[0]!)).toBe(false);
      for (const call of restored[0]!.state.calls.values()) {
        expect(call.status).toBe("running");
      }
      // phase 归属随 dispatched 帧恢复（traceNode.phase——分组展示供源）
      expect(restored[0]!.state.calls.get(1)!.traceNode.phase).toBe("review");
      expect(restored[0]!.state.calls.get(0)!.traceNode.agent).toBe("worker");
    });

    it("[U10] 中断流 fold：run-interrupted 无复活无终局 → meta.interruptedAt 置位（派生视图 interrupted 非僵尸 running）；复活流清除标记", async () => {
      // 已收编 run（流含 run-interrupted）重新加载进内存后的派生视图：聚合 status 保持两态
      // （running），中断态经 meta.interruptedAt 表达——runSummary 据此派生视图
      // 'interrupted'，CLI/TUI 不显示僵尸「运行中」；resume 复活（run-resumed
      // 'interrupted'，CLI/TUI 不显示僵尸「运行中」；resume 复活（run-resumed
      // 尾帧）后标记清除回 running。
      const runId = "run-rt-interrupted";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
      appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1 });
      appendRecordLine(tmpDir, runId, { type: "run-interrupted", seq: 3, ts: 1200, errorCode: "crashed", reason: "Process killed" });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const restored = await store.loadAll();
      // [D6(a) 第 3 步] 活体判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(restored[0]!)).toBe(false); // 聚合两态保持
      expect(restored[0]!.meta.interruptedAt).toBe(new Date(1200).toISOString());
      expect(runSummary(restored[0]!).status).toBe("interrupted");

      // 复活流（同流追加 run-resumed）：标记清除，派生视图回 running
      const runId2 = "run-rt-resumed";
      const recordPath2 = appendRecordLine(tmpDir, runId2, { type: "run-created", seq: 1, ts: 1000, runId: runId2, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
      appendRecordLine(tmpDir, runId2, { type: "run-interrupted", seq: 2, ts: 1100, errorCode: "crashed", reason: "Process killed" });
      appendRecordLine(tmpDir, runId2, { type: "run-resumed", seq: 3, ts: 1200, reason: "resume plan: replay=1 redispatch=1", host: "h" });
      const store2 = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx([v2RegisteredEntry(runId2, recordPath2)]) });
      const restored2 = await store2.loadAll();
      expect(restored2[0]!.meta.interruptedAt).toBeUndefined();
      expect(runSummary(restored2[0]!).status).toBe("running");
    });
  });

  // ── stateFilePath：唯一持久件（record 流）指针 ───────────────────────

  describe("W2[D1]: RunStore.stateFilePath 暴露 record 流路径", () => {
    let tmpDir: string;
    let store: JsonlRunStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
      store = new JsonlRunStore({ runsDir: tmpDir });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    it("stateFilePath(runId) 返回 <runsDir>/<runId>.record.jsonl（[D1] 唯一持久件）", () => {
      const result = store.stateFilePath("run-foo");
      expect(result).toBe(path.join(tmpDir, `run-foo${RUN_EVENTS_SUFFIX}`));
      expect(result.endsWith(".record.jsonl")).toBe(true);
    });
  });

  // ── W17/W1: workflow-record 条目范围（零条目写锚定 + v2 收编读侧）──────

  describe("W17/W1[D1]: workflow-record 条目范围（零条目写锚定 + v2 收编读侧）", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-w17-"));
      loggerMock.warn.mockClear();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    it("customType 常量字面量钉住：WORKFLOW_RECORD_CUSTOM_TYPE === 'workflow-record'", () => {
      // 写点引用常量（单源）；本断言钉住常量与消费方（W18 runtime extractor）约定的
      // 字面量拼写，防重命名漂移后静默丢重建。
      expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe("workflow-record");
    });

    it("[停写锚定] save 全程零 workflow-record entry、零 state 文件（[D1] 无物化情形）", async () => {
      const entries: CustomEntry[] = [];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries) });
      const runId = "run-w17-shape";
      const run = WorkflowRun.reconstruct(
        runId,
        { scriptSource: "agent('x')", args: {}, scriptName: "test-script", scriptPath: "/tmp/x.js" },
        { budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
        { startedAt: new Date().toISOString() },
      );
      await store.save(run);

      expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
      // 无 state 快照文件（[D1] 投影退役锚）
      expect(fs.existsSync(path.join(tmpDir, `${runId}.jsonl`))).toBe(false);
    });

    it("[D4 接管] store rebind 后 v2 终态条目补写走新 pi（旧 pi 不再收 entry）", async () => {
      const entriesOld: CustomEntry[] = [];
      const entriesNew: CustomEntry[] = [];
      const runId = "run-w17-rebind";
      // v2 收编面夹具：注册条目 + record 已终局（终态条目缺失 → loadAll 幂等补写）
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 2000, seq: 2 });
      const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];

      const store = new JsonlRunStore({
        runsDir: tmpDir,
        pi: mkPi(entriesOld),
        ctx: mkCtx(seedEntries),
      });
      // rebind 换源：条目补写侧路由到新 pi
      store.rebind(mkPi(entriesNew), mkCtx(seedEntries));

      const loaded = await store.loadAll();
      // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(loaded[0]!)).toBe(true);
      expect(loaded[0]?.state.reason).toBe("completed");

      // 补写落新 pi：seed 注册之外恰 1 条终态条目（kind: settled）
      const wfNew = entriesNew.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE);
      expect(wfNew).toHaveLength(1);
      expect((wfNew[0]!.data as { kind?: string }).kind).toBe("settled");
      // 旧 pi 不再收 entry（appendEntry 源已换新）
      expect(entriesOld).toHaveLength(0);
    });

    it("[record 权威] state 文件从不存在，loadAll 仍从 record 流重建（唯一事实源证明）", async () => {
      const runId = "run-w1-record";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendRecordLine(tmpDir, runId, { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5, result: { content: "ok" }, ts: 2000, seq: 2 });
      appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 3000, seq: 3 });
      // 无任何 state 文件被创建过（[D1] 后磁盘唯一持久件 = record 流）

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.runId).toBe(runId);
      // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(loaded[0]!)).toBe(true);
      expect(loaded[0]!.state.reason).toBe("completed");
      // 终态条目缺失 → 幂等补写恰 1 条（收编条目半边）；载荷与 core finalizeRun 同构
      const settledEntries = entries.filter(
        (e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE && (e.data as { kind?: string }).kind === "settled",
      );
      expect(settledEntries).toHaveLength(1);
      const data = settledEntries[0]!.data as Record<string, unknown>;
      expect(data["v"]).toBe(WORKFLOW_RECORD_ENTRY_VERSION);
      expect(data["kind"]).toBe("settled");
      expect(data["runId"]).toBe(runId);
      expect(data["status"]).toBe("done");
      expect(data["outcome"]).toBe("done");
      expect(data["reason"]).toBe("completed");
      expect(data["settledAt"]).toBe(3000);
      expect(data["callCount"]).toBe(1); // record agent-settled 帧数派生视图
    });

    it("[D2] 历史形态 interrupted outcome 帧被 scan 词表外坏行跳过（[D1] 历史数据处置——旧词表行不进解析路径，run 重建退 running 交收编）", async () => {
      const runId = "run-w1-interrupted";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "interrupted", errorCode: "interrupted_abandoned", reason: "abandon window elapsed", artifactsDir: tmpDir, ts: 3000, seq: 2 });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      // interrupted 已出 outcome 词表（[D2] 入 lifecycle）——历史帧在 strict 读面按
      // 词表外值拒绝（RecordStreamCorruptionError 上抛，storeHealthy=false——与半截
      // 行同语义，不静默跳过把损坏伪装成「无终局」）
      await expect(store.loadAll()).rejects.toThrow(/词表外 outcome/);
    });

    it("[收编幂等] 终态条目已在 → 补写跳过；双重启 loadAll 不重复追加", async () => {
      const runId = "run-w1-idem";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "failed", errorCode: "engine_crashed", reason: "boom", artifactsDir: tmpDir, ts: 3000, seq: 2 });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId)];
      const storeA = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const loaded = await storeA.loadAll();
      // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(loaded[0]!)).toBe(true);
      expect(loaded[0]!.state.reason).toBe("failed");
      expect(loaded[0]!.state.error).toBe("boom");
      // 条目已在：不追加（数量不变）
      expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);

      // 第二次启动（新 store 实例读同一 session 面）：仍恰 2 条，零重复追加
      const storeB = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      await storeB.loadAll();
      expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
    });

    it("[非终局不补写] record 无 run-settled → running 交恢复链，零条目追加", async () => {
      const runId = "run-w1-running";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendRecordLine(tmpDir, runId, { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5, result: { content: "ok" }, ts: 2000, seq: 2 });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      // [D6(a) 第 3 步] 活体判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(loaded[0]!)).toBe(false);
      expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(1);
    });

    it("[场景 18 锚] record 中部坏行 → loadAll 拒绝（读失败不静默跳过——唯一事实源读不出即拒绝）", async () => {
      const runId = "run-w1-badline";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      fs.appendFileSync(recordPath, "{truncated-not-json\n", "utf8"); // 中部坏行
      appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 3000, seq: 2 });

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      // [D1] 反转（原坏行宽容收编）：拒绝语义——错误含文件/行定位与恢复指引
      await expect(store.loadAll()).rejects.toThrow(/record 流损坏/);
      await expect(store.loadAll()).rejects.toThrow(/恢复/);
    });

    it("[中断收编] 注册条目指向缺失 record 流且无终态条目 → degraded running 重建交恢复链", async () => {
      const runId = "run-w1-missing";
      const entries: CustomEntry[] = [
        v2RegisteredEntry(runId, path.join(tmpDir, `${runId}${RUN_EVENTS_SUFFIX}`)),
      ];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      const loaded = await store.loadAll();
      // 设计 §3.1 失败路径样例「全文件不可解析 → 该 run 按中断收编」：静默跳过会让
      // 该实体对恢复链与收编扫描全部不可见——degraded running 基线交恢复链收编。
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.runId).toBe(runId);
      // [D6(a) 第 3 步] 活体判定源 = 终局记录注册表（聚合不持 status）
      expect(isRunSettled(loaded[0]!)).toBe(false);
      expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(runId);
    });

    it("[存续分流] record 流缺失 + 终态条目在 → 跳过不重建（呈现侧归条目读者，不伪造收编）", async () => {
      const runId = "run-w1-missing-settled";
      const entries: CustomEntry[] = [
        v2RegisteredEntry(runId, path.join(tmpDir, `${runId}${RUN_EVENTS_SUFFIX}`)),
        v2SettledEntry(runId),
      ];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      // 条目在 = 实体呈现面归条目读者（runtime 投影）；壳侧不产生 running 聚合
      //（对不在场的流交恢复链 = 伪造收编事实）
      await expect(store.loadAll()).resolves.toEqual([]);
      expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("settled entry present");
    });

    it("[历史实体分流] 旧后缀锚点（.events.jsonl 注册条目）→ 跳过不重建（D1 历史数据处置：不读旧两件套）", async () => {
      const runId = "run-legacy-anchor";
      // 旧格式两件套在盘（历史遗留——不读不写不主动删）
      const legacyJournalPath = path.join(tmpDir, `${runId}.events.jsonl`);
      fs.mkdirSync(path.dirname(legacyJournalPath), { recursive: true });
      fs.writeFileSync(legacyJournalPath, `${JSON.stringify({ type: "run-created", ts: 1000, runId, workflowName: "t", argsSummary: "{}" })}\n`, "utf8");
      fs.writeFileSync(path.join(tmpDir, `${runId}.jsonl`), `{"runId":"${runId}"}\n`, "utf8");

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, legacyJournalPath)];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      // 旧后缀锚点 = 历史 run：不重建（从壳侧读取面消失 = D1 预期行为），零读取
      await expect(store.loadAll()).resolves.toEqual([]);
    });

    it("[终局帧损坏] record 坏行 + 终态条目在 → 仍拒绝（条目救不回损坏的流——判读无第二判据）", async () => {
      const runId = "run-w1-settled-entry-final";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      // 终局帧损坏：[D1] 拒绝语义不因条目在场放宽（条目是派生视图锚不是第二判据）
      fs.appendFileSync(recordPath, '{"type":"run-settled","outcome":"compl\n', "utf8");

      const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId)];
      const store = new JsonlRunStore({ runsDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
      await expect(store.loadAll()).rejects.toThrow(/record 流损坏/);
      // 条目数量不变——不产生任何补写
      expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
    });

    it("entry 形态检查：v2 但 kind 不在词表（半写/漂移）→ 静默跳过不崩（对齐 future-v 的不猜测解析）", async () => {
      const entries: CustomEntry[] = [
        {
          type: "custom",
          customType: WORKFLOW_RECORD_CUSTOM_TYPE,
          data: { v: WORKFLOW_RECORD_ENTRY_VERSION, kind: "migrated" },
          id: "seed-unknown-kind",
          parentId: null,
          timestamp: new Date().toISOString(),
        },
      ];
      const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
      await expect(store.loadAll()).resolves.toEqual([]);
    });
  });

  // ── D5 store stale guard（rebind 面——被测对象是 JsonlRunStore rebind 后的条目补写）──

  describe("D5 store stale guard：rebind 后窗口内 stale appendEntry 统一 debug 丢弃", () => {
    it("stale 抛错不进错误路径：loadAll 终态条目补写被检查丢弃（不 reject）、读回终态", async () => {
      const staleMessage = "Extension runner is stale after session replacement";
      const entriesStale: CustomEntry[] = [];
      const piStale = mkPi(entriesStale, {
        appendEntry: vi.fn(() => {
          throw new Error(staleMessage);
        }),
      });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-adopt-stale-"));
      try {
        // v2 收编面夹具：注册条目 + record 已终局（终态条目缺失 → loadAll 幂等补写）
        const runId = "wf-stale-1";
        const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
        appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 2000, seq: 2 });
        const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];

        const store = new JsonlRunStore({
          runsDir: tmpDir,
          ctx: mkCtx(seedEntries),
        });
        // rebind 后新 pi 随下一次 reload 窗口变 stale（appendEntry 抛 PS-30 文案）
        store.rebind(piStale, mkCtx(seedEntries));

        // 补写撞 stale → guardStaleCtx 分诊丢弃（debug 留痕），loadAll 不 reject、
        // 读回终态（条目是派生视图锚：stale 窗口内缺失由下次 loadAll 幂等补写自愈）
        const loaded = await store.loadAll();
        expect(loaded).toHaveLength(1);
        // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
        expect(isRunSettled(loaded[0]!)).toBe(true);
        expect(entriesStale).toHaveLength(0); // stale 条目被丢弃
        // save（no-op）照常 settle
        const run = WorkflowRun.reconstruct(
          "wf-stale-2",
          { scriptSource: "agent('x')", args: {}, scriptName: "test-script", scriptPath: "/tmp/x.js" },
          { reason: "completed", budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
          { startedAt: new Date().toISOString() },
        );
        await expect(store.save(run)).resolves.toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    });
  });
});

// ======== 来源：workflow-notify.test.ts ========
describe("workflow-notify", () => {
  // ── 通道词表（extension-protocol SSOT 值的本地镜像；值锚定锁 =
  // contract.notify-custom-types.test.ts） ──────────────────────────

  const WORKFLOW_RESULT_CUSTOM_TYPE = "workflow-result";

    /** pi 实装 stale 文案的完整形态（E1 崩溃堆栈原文，探针 PS-30 检查其稳定性）。 */
  const PI_STALE_ERROR = `This extension ctx is stale ${STALE_CTX_MARKER} or reload. Do not use a captured pi or command ctx after ctx.newSession().`;

  // ── mock 面（全文件单一定义；helpers-gui.test.ts 同款 duck typing） ──

  type RunMock = {
    spec: { scriptName: string; slug?: string };
    meta?: { startedAt: string };
    state: {
      status: string;
      reason?: string;
      scriptResult?: unknown;
      /** failed 终局时 extractFailureErrorCode 遍历的调用注册表（其他形态不触达）。 */
      calls?: Map<unknown, unknown>;
      trace: { toArray: () => Array<{ stepIndex: number; agent: string; status: string }> };
    };
  };

  function makeRun(overrides?: {
    scriptName?: string;
    slug?: string;
    status?: string;
    reason?: string;
    scriptResult?: unknown;
    trace?: Array<{ stepIndex: number; agent: string; status: string }>;
    /** failed 终局 errorCode 提取的消费方（calls.set(1, { result })，payload 域用）。 */
    failedCall?: { error: string; failureKind: string };
  }): RunMock {
    const calls = new Map<unknown, unknown>();
    if (overrides?.failedCall) {
      calls.set(1, { result: overrides.failedCall });
    }
    return {
      spec: { scriptName: overrides?.scriptName ?? "build", slug: overrides?.slug },
      meta: { startedAt: new Date().toISOString() },
      state: {
        status: overrides?.status ?? "done",
        // reason 不设默认：生产 reason 恒由 settlement 派生（W2/V1 载荷换源后
        // state.reason 不被读取），显式传值仅服务 details.reason 断言范围
        reason: overrides?.reason,
        scriptResult: overrides?.scriptResult,
        calls,
        trace: { toArray: () => overrides?.trace ?? [] },
      },
    };
  }

  const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

  function makePi(sendMessageImpl?: (...args: unknown[]) => void): {
    pi: ExtensionAPI;
    sendMessage: ReturnType<typeof vi.fn>;
  } {
    const sendMessage = vi.fn(sendMessageImpl);
    const pi = { sendMessage } as unknown as ExtensionAPI;
    return { pi, sendMessage };
  }

  /** 从 sendMessage 第 call 次调用的消息里取 details（GUI 协议观测点）。 */
  function sentDetails(sendMessage: ReturnType<typeof vi.fn>, call = 0): unknown {
    return (sendMessage.mock.calls[call] as [{ details: unknown }])[0].details;
  }

  type FakePortMock = {
    handle: DeliveryPortHandle;
    /** port.deliver 受理的注入消息（从 envelope 还原——断言范围与原 sentMessages 同形）。 */
    sentMessages: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
      collectKey?: string[];
    }[];
    /** 下一次 deliver 返回 rejected（persist-failed 形态）。 */
    rejectNext: () => void;
  };

    /** fake 投递端口（deliver 消费方：同 id 幂等吞 + 受理即记录；port 本体行为由
 *  pi-delivery-port 套件锁定）。 */
  function makeFakePort(): FakePortMock {
    const seen = new Set<string>();
    const sentMessages: FakePortMock["sentMessages"] = [];
    let rejectNextFlag = false;
    const handle: DeliveryPortHandle = {
      deliver(envelope, opts) {
        if (rejectNextFlag) {
          rejectNextFlag = false;
          return { kind: "rejected", reason: "persist-failed (fake)" };
        }
        const id = envelope.id ?? "gen-id";
        if (seen.has(id)) return { kind: "swallowed", reason: "already-seen" };
        seen.add(id);
        sentMessages.push({
          customType: envelope.payload.customType,
          content: envelope.payload.content,
          display: envelope.payload.display,
          details: envelope.payload.details,
          collectKey: opts?.collectKey,
        });
        return { kind: "accepted", id };
      },
      flush: () => {},
    };
    return {
      handle,
      sentMessages,
      rejectNext: () => {
        rejectNextFlag = true;
      },
    };
  }

  // pi-delivery-port 进程级槽（notifyDone 生产码直接 import 该包 getDeliveryPort 读槽）。
  const PORT_SLOT_KEY = DELIVERY_PORT_SLOT_KEY;

  /** port 注入（直接写进程级槽——生产接线 = base-tool-enhance session_start 的
 *  bindDeliveryPort；本包 notifyDone 与 session-manager recordManagedNotify 同款
 *  直读槽访问器消费）。 */
  function bindFakePort(mock: FakePortMock): void {
    Reflect.set(globalThis, PORT_SLOT_KEY, { current: mock.handle });
  }

  /** [W2/V1] 终局记录构造（notifyDone 载荷源换帧直取后的测试通道——reason 词表 →
 *  (outcome, errorCode) 按 D5 映射反构）。 */
  function settlementFor(reason: string | undefined): import("../jsonl-run-store.ts").RunSettlementRecord {
    switch (reason) {
      case "completed":
        return { outcome: "done", settledAt: 0 }; // [D2] 成功值 completed→done
      case "aborted":
        return { outcome: "cancelled", settledAt: 0 };
      case "failed":
        return { outcome: "failed", errorCode: "unknown", settledAt: 0 };
      case "budget_limited":
        return { outcome: "failed", errorCode: "budget_limited", settledAt: 0 };
      case "time_limited":
        return { outcome: "time_limited", settledAt: 0 }; // [D2] 升格独立 outcome、无码
      case undefined:
        return { outcome: "done", settledAt: 0 };
      default:
        return { outcome: "failed", errorCode: "unknown", settledAt: 0 };
    }
  }

  // 「port 缺席」构造性保证：任何用例（含 port 路径 describe 内注入 / 用例中途
  // re-inject）结束后重置端口注入——后续降级直发 / GUI / stale / bounded 用例恒走
  // getDeliveryPort() === undefined 的降级分支。
  afterEach(() => {
    Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
  });

  // ── port 主投（pi-delivery-port 槽注入，unified-delivery 波 2 生产装配形态） ──

  describe("notifyDone — port 主投（C-ext-19 语义由 port 内包）", () => {
    let mock: FakePortMock;

    beforeEach(() => {
      mock = makeFakePort();
      bindFakePort(mock);
    });

    it("①→② 受理先于注入：notifyId = wf-done:<runId> 作幂等键，送达通道保持 workflow-result，content 不变，pi 直发零调用", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({ scriptName: "fan-out", scriptResult: { status: "ok" } });

      notifyDone(pi, "wf-17abc", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      // port.deliver 受理：幂等键形态 wf-done:<runId>（port 落投递日志先于受理注入）
      expect(mock.sentMessages).toHaveLength(1);
      expect(mock.sentMessages[0]?.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
      // 全文逐字锚定（分支矩阵锁见文末 describe）：header + Script Result + Agent Trace
      expect(mock.sentMessages[0]?.content).toBe(
        "Workflow 'fan-out' done: done (completed)\n" +
          "\n" +
          "--- Script Result ---\n" +
          '{\n  "status": "ok"\n}\n' +
          "\n" +
          "--- Agent Trace ---",
      );
      expect(mock.sentMessages[0]?.details).toMatchObject({
        notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-17abc`,
        runId: "wf-17abc",
      });
      // 主投不经 pi 直发（port 是唯一注入出口）
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("幂等键拒绝：同 runId 重复 notifyDone（全新 Set 绕过内存层）不双投递", () => {
      const { pi } = makePi();
      const run = makeRun();

      notifyDone(pi, "wf-dup", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));
      // 第二次调用持全新 Set（模拟内存窗口挤出 / 重启后的重复收尾回调）——
      // 持久层幂等键承接去重（port 判重吞）
      notifyDone(pi, "wf-dup", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      expect(mock.sentMessages).toHaveLength(1);
    });

    it("port rejected（persist-failed 形态）→ error 留痕（含 notifyId/content 摘要），去重不标记、不上抛", () => {
      const { pi } = makePi();
      const run = makeRun();
      const notified = new Set<string>();

      // 已知丢失情形（如实登记，见 notifyDone 注释）：rejected = 受理未发生、投递日志
      // 未落、重放无源——该终局通知丢失，仅 error 日志留痕供手工补偿。deliver 同步
      // 返回无抛错通道（原账本 record 抛错上抛 finalizeRun 围栏的链路随退役消失）。
      mock.rejectNext();
      notifyDone(pi, "wf-stale", runAsParam(run), notified, undefined, settlementFor(run.state.reason));
      expect(loggerFns.error).toHaveBeenCalledWith(
        expect.stringContaining("delivery rejected"),
        expect.objectContaining({
          runId: "wf-stale",
          notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-stale`,
          contentPreview: expect.stringContaining("Workflow 'build' done"),
        }),
      );
      // 去重未标记：进程内的重复收尾回调不被去重阻断（防御形态）
      expect(notified.has("wf-stale")).toBe(false);
      expect(mock.sentMessages).toHaveLength(0);

      // 重复收尾回调（若到达）：rejected 消退 → 受理成功 + 去重标记
      notifyDone(pi, "wf-stale", runAsParam(run), notified, undefined, settlementFor(run.state.reason));
      expect(mock.sentMessages).toHaveLength(1);
      expect(notified.has("wf-stale")).toBe(true);
    });

      // [③ 回执逐条处理完毕（关闭） / ④ 断连重启重放随账本退役] 两用例的行为锁由 port 内包语义承接：
    // 送达判定（details-id 凭据命中 → 确认 → 终局判重）与 session_start 差集重放
    // 由 pi-delivery-port 套件「四步对位」/「session_start 差集重放」段锁定，本文件
    // 不重复设条。
  });

  // ── 降级路径（port 缺席：装配异常窗口） ──────────────────────

  describe("notifyDone — 降级直发（port 缺席，装配异常窗口降级）", () => {
    // 无注入环境由文件级 afterEach 构造性保证：notifyDone 走
    // getDeliveryPort() === undefined 的降级分支。
    it("fire-once 直发 pi.sendMessage：triggerTurn 单通道（无 deliverAs），details 携带 notifyId + 降级 warn 留痕", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun();

      notifyDone(pi, "wf-fallback", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [msg, opts] = sendMessage.mock.calls[0] as [
        { customType: string; content: string; display: boolean; details: { notifyId?: string } },
        Record<string, unknown>,
      ];
      expect(msg.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
      expect(msg.display).toBe(true);
      // 全文逐字锚定：completed + 无 scriptResult + 空 trace + 无 artifacts 的最小形态
      expect(msg.content).toBe("Workflow 'build' done: done (completed)\n\n--- Agent Trace ---");
      expect(msg.details.notifyId).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-fallback`);
      // u9 偏差裁决承袭（D7 账本化配套）：deliverAs 已删
      expect(opts).toEqual({ triggerTurn: true });
      // 降级可见性：缺席 warn（修复信号——检查 base-tool-enhance 装配）
      expect(loggerFns.warn).toHaveBeenCalledWith(
        expect.stringContaining("delivery port not bound"),
        expect.objectContaining({ runId: "wf-fallback" }),
      );
    });
  });

  // ── content 全文锚定（LLM 可见文本锁） ────────────────────────

  // notifyDone 的 content 分支矩阵（workflow-notify.ts parts 构造，期望值逐字取自实现）：
  //   ① header 恒有：`Workflow '<name>' done: <status>[ (<reason>)]`
  //   ② F3 防偷懒收尾指令段：reason ∈ isTerminalDoneReason 词表（failed/aborted/
  //     budget_limited/time_limited——completed 不含）时追加
  //   ③ Script Result 段：scriptResult 非 undefined 且非 null 时追加（含 bounded
  //     pretty 序列化形态，序列化本体由 core bounded-serialize.test.ts 锚定）
  //   ④ Agent Trace 段恒有：空 trace = 仅标题；非空 = `[<i>] <agent>: <status>` 行
  //   ⑤ Artifacts 段：artifactsDir 传入时追加（含 events journal 派生路径）
  // 经降级路径直测（ledger 未 bind → pi.sendMessage 直发）；prompt-quality 的源码
  // 关键词断言是源码级防线，与这里的输出级锚定互补，不在此重复。

  describe("notifyDone — content 分支矩阵全文锚定", () => {
    it("F3 段：terminal reason（budget_limited）→ 追加防偷懒收尾指令（逐字）", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({ reason: "budget_limited" });

      notifyDone(pi, "wf-budget", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
      expect(msg.content).toBe(
        "Workflow 'build' done: done (budget_limited)\n" +
          "\n" +
          "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains NOT DONE, and give the user the single most important next step.\n" +
          "\n" +
          "--- Agent Trace ---",
      );
    });

    it("Artifacts 段：artifactsDir 传入 → 末尾追加产物指针（含 events journal 派生路径）", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun();

      notifyDone(pi, "wf-art-1", runAsParam(run), new Set(), "/tmp/wf-state", settlementFor(run.state.reason));

      const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
      expect(msg.content).toBe(
        "Workflow 'build' done: done (completed)\n" +
          "\n" +
          "--- Agent Trace ---\n" +
          "\n" +
          "--- Artifacts ---\n" +
          "Artifacts dir: /tmp/wf-state\n" +
          "Events journal: /tmp/wf-state/wf-art-1.record.jsonl",
      );
    });

    it("全段组合：failed + 无 scriptResult + 非空 trace + artifactsDir（F3/Trace 行/Artifacts 齐）", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({
        reason: "failed",
        trace: [
          { stepIndex: 0, agent: "builder", status: "completed" },
          { stepIndex: 1, agent: "reviewer", status: "failed" },
        ],
      });

      notifyDone(pi, "wf-full-1", runAsParam(run), new Set(), "/tmp/wf-state", settlementFor(run.state.reason));

      const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
      expect(msg.content).toBe(
        "Workflow 'build' done: done (failed)\n" +
          "\n" +
          "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains NOT DONE, and give the user the single most important next step.\n" +
          "\n" +
          "--- Agent Trace ---\n" +
          "[0] builder: completed\n" +
          "[1] reviewer: failed\n" +
          "\n" +
          "--- Artifacts ---\n" +
          "Artifacts dir: /tmp/wf-state\n" +
          "Events journal: /tmp/wf-state/wf-full-1.record.jsonl",
      );
    });

    it("scriptResult null → 无 Script Result 段（null 与 undefined 同为缺省形态）", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({ scriptResult: null });

      notifyDone(pi, "wf-null", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
      expect(msg.content).toBe("Workflow 'build' done: done (completed)\n\n--- Agent Trace ---");
    });

    it("[W2/V1] settlement completed（reason 缺省的联合派生形态）→ header 带 completed 后缀，无 F3 段", () => {
      const { pi, sendMessage } = makePi();
      const run: RunMock = {
        spec: { scriptName: "build" },
        state: { trace: { toArray: () => [] } },
      };

      notifyDone(pi, "wf-noreason", runAsParam(run), new Set(), undefined, settlementFor((run as { state?: { reason?: string } }).state?.reason));

      const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
      // [W2/V1 D1 第 7 行] 载荷源换终局记录——reason 恒由 settlement 派生（completed
      // 派生自带后缀），原 I2 兜底的「无后缀」异常形态退役
      expect(msg.content).toBe("Workflow 'build' done: done (completed)\n\n--- Agent Trace ---");
    });
  });

  // ── 终局载荷（D7） ───────────────────────────────────────────

  // [P4 / D7] notifyDone 终局载荷扩展（impl-plan P4 验收条款 a：成功/失败/取消
  // 各恰好一条，载荷含 outcome / 结果摘要或 errorCode / 产物与 journal 指针）。
  // 覆盖范围：三态 outcome 映射（completed→completed、failed→failed、aborted→
  // cancelled，与 core doneReasonToRunOutcome（dispatchFinalRunSettle 消费）同构）；
  // 成功载荷 resultSummary（bounded 截断）+ 指针面；失败载荷 errorCode（最后失败
  // call 的 failureKind）+ 证据指针、零 resultSummary；取消载荷零 errorCode /
  // 零 resultSummary（cancelled 无失败帧语义）；幂等键沿用 wf-done:<runId>、
  // 送达通道保持 workflow-result、每 run 恰好一条。

  const ARTIFACTS_DIR = "/tmp/wf-state-root/workflow-state";

  describe("notifyDone 终局载荷（D7）", () => {
    it("成功：outcome=done + resultSummary + 产物目录与 journal 指针，恰好一条", () => {
      const mock = makeFakePort();
      bindFakePort(mock);
      const run = makeRun({ reason: "completed", scriptResult: { ok: true, files: 3 } });

      notifyDone(makePi().pi, "wf-payload-ok", runAsParam(run), new Set(), ARTIFACTS_DIR, settlementFor(run.state.reason));

      expect(mock.sentMessages).toHaveLength(1);
      const delivery = mock.sentMessages[0]!;
      expect(delivery.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
      // collectKey 债权申报 = runId（result-collect 设计 §3.4：collect 以 runId 命中收取）
      expect(delivery.collectKey).toEqual(["wf-payload-ok"]);
      const details = delivery.details as Record<string, unknown>;
      expect(details["notifyId"]).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-payload-ok`);
      expect(details["outcome"]).toBe("done");
      expect(typeof details["resultSummary"]).toBe("string");
      expect(details["resultSummary"]).toContain("ok");
      expect(details["errorCode"]).toBeUndefined();
      expect(details["artifactsDir"]).toBe(ARTIFACTS_DIR);
      expect(details["eventsJournalPath"]).toBe(`${ARTIFACTS_DIR}/wf-payload-ok.record.jsonl`);
      // 文案含产物指针段（主 agent 可操作的入口）
      expect(delivery.content).toContain("Artifacts dir:");
      expect(delivery.content).toContain(`Events journal: ${ARTIFACTS_DIR}/wf-payload-ok.record.jsonl`);
    });

    it("失败：outcome=failed + errorCode（最后失败 call 的 failureKind）+ 证据指针，零 resultSummary", () => {
      const mock = makeFakePort();
      bindFakePort(mock);
      const run = makeRun({ reason: "failed", failedCall: { error: "engine crashed", failureKind: "unknown" } });

      notifyDone(makePi().pi, "wf-payload-fail", runAsParam(run), new Set(), ARTIFACTS_DIR, settlementFor(run.state.reason));

      expect(mock.sentMessages).toHaveLength(1);
      const details = mock.sentMessages[0]!.details as Record<string, unknown>;
      expect(details["outcome"]).toBe("failed");
      expect(details["errorCode"]).toBe("unknown");
      expect(details["resultSummary"]).toBeUndefined();
      expect(details["eventsJournalPath"]).toBe(`${ARTIFACTS_DIR}/wf-payload-fail.record.jsonl`);
    });

    it("取消：outcome=cancelled（aborted 经 cancel-requested 同构映射），零 errorCode / 零 resultSummary", () => {
      const mock = makeFakePort();
      bindFakePort(mock);
      const run = makeRun({ reason: "aborted" });

      notifyDone(makePi().pi, "wf-payload-cancel", runAsParam(run), new Set(), ARTIFACTS_DIR, settlementFor(run.state.reason));

      expect(mock.sentMessages).toHaveLength(1);
      const details = mock.sentMessages[0]!.details as Record<string, unknown>;
      expect(details["outcome"]).toBe("cancelled");
      expect(details["errorCode"]).toBeUndefined();
      expect(details["resultSummary"]).toBeUndefined();
    });

    it("成功但 scriptResult 缺省 → resultSummary 缺省（载荷字段可缺席）；artifactsDir 未注入 → 指针面整体缺席", () => {
      const mock = makeFakePort();
      bindFakePort(mock);
      const run = makeRun({ reason: "completed" });

      notifyDone(makePi().pi, "wf-payload-bare", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      expect(mock.sentMessages).toHaveLength(1);
      const details = mock.sentMessages[0]!.details as Record<string, unknown>;
      expect(details["outcome"]).toBe("done");
      expect(details["resultSummary"]).toBeUndefined();
      expect(details["artifactsDir"]).toBeUndefined();
      expect(details["eventsJournalPath"]).toBeUndefined();
      // 旧调用兼容：content 无 Artifacts 段（字节形态与扩展前一致）
      expect(mock.sentMessages[0]!.content).not.toContain("Artifacts dir:");
    });

    it("resultSummary bounded 截断（500 上限，超限带截断标记不截断为裸切片）", () => {
      const mock = makeFakePort();
      bindFakePort(mock);
      const big = "x".repeat(2000);
      const run = makeRun({ reason: "completed", scriptResult: big });

      notifyDone(makePi().pi, "wf-payload-big", runAsParam(run), new Set(), ARTIFACTS_DIR, settlementFor(run.state.reason));

      const summary = (mock.sentMessages[0]!.details as Record<string, unknown>)["resultSummary"] as string;
      expect(summary.length).toBeLessThanOrEqual(600); // 500 + 截断标记余量
      expect(summary).toContain("x");
    });
  });

  // ── 成员结算明细透传（[subagent-observability §3.3.8]）─────────────────────
  //
  // 终局帧携带 failedMembers[].cause（`"<class>.<kind>"` 点拼）/ partialMembers
  // 明细后，通知链两呈现面同帧可见：① Agent Trace 行追加结清事实（failed 成员
  // 点拼 cause、部分交付成员 missing 清单；无明细行字节不变——既有全文锚不受
  // 影响）；② done details 透传明细数组（无明细终局恒缺省，与帧缺省形态一致）。
  // 全链用例经真 JsonlRunStore 读 record 流帧走 runSettledEffects 管线——
  // 帧 → settledRecordOf → notifyDone 全链 failedMembers 可见（通知载荷断裂点
  // 回归防线；runSettledEffects 的 settledRecordOf 注入形态由 workflow-events
  // 测试锁定，此处按生产装配形态接线真 store）。

  describe("notifyDone — 成员结算明细透传（§3.3.8）", () => {
    it("Agent Trace 行：failed 成员追加点拼 cause、partial 成员追加 missing 清单，无明细行字节不变", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({
        trace: [
          { stepIndex: 0, agent: "builder", status: "completed" },
          { stepIndex: 1, agent: "explorer", status: "failed" },
          { stepIndex: 2, agent: "coder", status: "completed" },
        ],
      });
      const settlement: RunSettlementRecord = {
        outcome: "partially_succeeded",
        settledAt: 0,
        failedMembers: [{ taskIndex: 1, cause: "provider.rate_limited" }],
        partialMembers: [{ taskIndex: 2, missing: ["report.md", "data.json"] }],
      };

      notifyDone(pi, "wf-members-trace", runAsParam(run), new Set(), undefined, settlement);

      const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
      expect(msg.content).toContain("[1] explorer: failed (provider.rate_limited)");
      expect(msg.content).toContain("[2] coder: completed (partial: missing report.md, data.json)");
      // 无成员明细的 trace 行不带后缀（既有形态逐字节不变）
      expect(msg.content).toContain("[0] builder: completed\n");
    });

    it("done details：failedMembers/partialMembers 帧同源透传；无明细终局两字段缺省", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun();
      const settlement: RunSettlementRecord = {
        outcome: "partially_succeeded",
        settledAt: 0,
        failedMembers: [{ taskIndex: 1, cause: "harness.turn_budget_exhausted" }],
        partialMembers: [{ taskIndex: 0, missing: ["a.txt"] }],
      };

      notifyDone(pi, "wf-members-details", runAsParam(run), new Set(), undefined, settlement);
      const details = sentDetails(sendMessage) as Record<string, unknown>;
      expect(details["failedMembers"]).toEqual([{ taskIndex: 1, cause: "harness.turn_budget_exhausted" }]);
      expect(details["partialMembers"]).toEqual([{ taskIndex: 0, missing: ["a.txt"] }]);

      const bare = makePi();
      notifyDone(bare.pi, "wf-members-bare", runAsParam(run), new Set(), undefined, settlementFor("completed"));
      const bareDetails = sentDetails(bare.sendMessage) as Record<string, unknown>;
      expect(bareDetails["failedMembers"]).toBeUndefined();
      expect(bareDetails["partialMembers"]).toBeUndefined();
    });

    it("全链：record 流 run-settled 帧含成员明细 → JsonlRunStore.settledRecordOf → runSettledEffects 通知载荷可见", async () => {
      const runsDir = mkdtempSync(join(os.tmpdir(), "wf-members-chain-"));
      try {
        const store = new JsonlRunStore({ runsDir });
        const runId = "wf-members-chain";
        appendFileSync(
          join(runsDir, `${runId}${RUN_EVENTS_SUFFIX}`),
          `${JSON.stringify({
          type: "run-settled",
          seq: 1,
          ts: Date.now() - 100,
          outcome: "partially_succeeded",
          artifactsDir: runsDir,
          failedMembers: [{ taskIndex: 1, cause: "provider.rate_limited" }],
          partialMembers: [{ taskIndex: 2, missing: ["report.md"] }],
        })}\n`,
          "utf8",
        );

        const { pi, sendMessage } = makePi();
        const env: RunSettledEffectsEnv = {
          resolvePi: () => pi,
          notifiedRunIds: new Set(),
          state: { runsDir, runs: new Map() },
          settledRecordOf: (id) => store.settledRecordOf(id),
          lsRef: { lastSessionId: "sess-members" },
        };
        // runId 是 runSettledEffects 的 settlement 查询键（须与 record 流文件名一致）——
        // 本文件 makeRun 的 RunMock 不含 runId，此处显式补齐。
        const run = {
          ...makeRun({ trace: [{ stepIndex: 1, agent: "explorer", status: "failed" }] }),
          runId,
        };

        runSettledEffects(env, run as never);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const [msg] = sendMessage.mock.calls[0] as [{ details: Record<string, unknown>; content: string }];
        expect(msg.details["failedMembers"]).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
        expect(msg.details["partialMembers"]).toEqual([{ taskIndex: 2, missing: ["report.md"] }]);
        expect(msg.content).toContain("[1] explorer: failed (provider.rate_limited)");
        await store.dispose();
      } finally {
        rmSync(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    });
  });

  // ── scriptResult 序列化 — boundedPrettySerialize 等价锚定（IF13/#19，TC5/ES5）──
  //
  // bounded 序列化必须与旧实现（全量 JSON.stringify(x, null, 2) + slice(0,8000)+标记）
  // 逐字节等价。断言范围（design IF13/ES5 fixture）：
  // - 深嵌套大对象 >8000 → slice(0,8000) + "\n... (truncated)" 逐字节一致
  // - 循环引用 → String(value) 整串回退
  // - 含 BigInt → String(value) 整串回退且不抛出
  // - 含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）
  // - undefined/function 属性省略；数组元素 undefined → null
  // - 恰好 8000 不加标记 / 8001 → 截到 8000+标记 / 截断点落在转义序列中间
  // - ≤8000 全形态（原语/数组/嵌套/NaN/Unicode）与原生逐字节一致
  //
  // 观察口径：经 notifyDone 公共入口（boundedPrettySerialize 为 helpers 私有），
  // 从 sendMessage 的 content 中提取 "--- Script Result ---" 段。

  /** 提取 content 中 "--- Script Result ---" 段（空 trace 时结尾固定为 Agent Trace 标头）。 */
  function scriptResultSection(sendMessage: ReturnType<typeof vi.fn>): string {
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][0] as { content: string };
    const content = msg.content;
    const start = content.indexOf("--- Script Result ---\n");
    expect(start).toBeGreaterThan(-1);
    const end = content.lastIndexOf("\n\n--- Agent Trace ---");
    expect(end).toBeGreaterThan(start);
    return content.slice(start + "--- Script Result ---\n".length, end);
  }

  /** 旧实现参照（全量序列化 + 截断）。 */
  function legacySerialize(x: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(x, null, 2);
    } catch {
      serialized = String(x);
    }
    return serialized.length > 8000
      ? serialized.slice(0, 8000) + "\n... (truncated)"
      : serialized;
  }

  function runAndGetSection(scriptResult: unknown): string {
    const { pi, sendMessage } = makePi();
    notifyDone(pi, "run-if13", runAsParam(makeRun({ scriptResult })), new Set(), undefined, settlementFor(undefined));
    return scriptResultSection(sendMessage);
  }

  // ── 深嵌套大对象 fixture ──────────────────────────────────────

  function deepNested(): unknown {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 60; i++) {
      cur.header = `level-${i}-数据`;
      cur.items = Array.from({ length: 12 }, (__, j) => ({
        id: j,
        name: `item-${i}-${j}`,
        tags: ["alpha", "βeta", "γλυφ"],
        nested: { deep: { deeper: { value: i * 1000 + j } } },
      }));
      cur.next = {};
      cur = cur.next as Record<string, unknown>;
    }
    cur.end = "leaf";
    return root;
  }

  describe("notifyDone scriptResult — bounded 序列化等价锚定（IF13）", () => {
    it("深嵌套大对象（>8000）：与全量 stringify 后 slice+标记 逐字节一致", () => {
      const x = deepNested();
      expect(JSON.stringify(x, null, 2).length).toBeGreaterThan(10_000); // 确认确实超预算
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
    });

    it("循环引用 → String(value) 整串回退（不抛出）", () => {
      const x: Record<string, unknown> = { a: 1 };
      x.self = x;
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
      expect(runAndGetSection(x)).toBe(String(x));
    });

    it("含 BigInt → String(value) 整串回退且不抛出（对齐旧整体 catch）", () => {
      const x = { count: 10n, label: "big" };
      expect(runAndGetSection(x)).toBe(String(x));
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
    });

    it("含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）", () => {
      const x = { at: new Date(0), note: "ts" };
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
      expect(runAndGetSection(x)).toContain('"1970-01-01T00:00:00.000Z"');
    });

    it("undefined/function 属性省略与原生一致；数组内 undefined/function → null", () => {
      const x = {
        keep: 1,
        dropU: undefined,
        dropF: () => 1,
        arr: [undefined, 2, () => 3, null],
      };
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
      expect(runAndGetSection(x)).toBe(JSON.stringify(x, null, 2));
    });

    it("≤8000 全形态与原生逐字节一致（原语/数组/嵌套/NaN/Infinity/Unicode）", () => {
      // 注：null / undefined 顶层被 notifyDone 上游检查（!== undefined && !== null）
      // 跳过整段，不进序列化路径，不在此用例面内。
      const cases: unknown[] = [
        "plain string",
        42,
        true,
        NaN,
        Infinity,
        [1, [2, [3, "x"]]],
        { a: { b: { c: [1, "汉", { d: null }] } } },
        { emptyObj: {}, emptyArr: [] },
        { unicode: "line sep  pic ⌘" },
      ];
      for (const x of cases) {
        expect(runAndGetSection(x)).toBe(legacySerialize(x));
      }
    });
  });

  describe("notifyDone scriptResult — 截断边界（恰好 8000 / 8001 / 转义序列中间）", () => {
    /** 构造 pretty 全文恰好 len 字符的对象：{\n  "a": "<S>"\n} = 13 + S.length。 */
    function sizedStringObject(totalLen: number): { a: string } {
      return { a: "x".repeat(totalLen - 13) };
    }

    it("恰好 8000：不加标记，输出 === 原生全文", () => {
      const x = sizedStringObject(8000);
      expect(JSON.stringify(x, null, 2).length).toBe(8000); // 前置校验构造正确
      const section = runAndGetSection(x);
      expect(section).toBe(JSON.stringify(x, null, 2));
      expect(section).not.toContain("(truncated)");
      expect(section.length).toBe(8000);
    });

    it("8001：截到 8000 + 标记", () => {
      const x = sizedStringObject(8001);
      expect(JSON.stringify(x, null, 2).length).toBe(8001);
      const section = runAndGetSection(x);
      expect(section).toBe(JSON.stringify(x, null, 2).slice(0, 8000) + "\n... (truncated)");
      expect(section.length).toBe(8000 + "\n... (truncated)".length);
    });

    it("截断点落在转义序列中间（\\u0001 被切半）：与 slice 逐字节一致", () => {
      // 控制字符 U+0001 被 JSON.stringify 转义为 6 字符序列 \u0001（现代 Node 对
      // U+2028 不转义——ES2019 JSON superset，实测 JSON.stringify("\\u2028") 输出原字符，
      // 故用必转义的控制字符）。pad 逐字符平移使全文第 8000 字符扫过转义序列内部，
      // 命中起始反斜杠——截断点切在转义序列中间（不补任何转义封口，末尾裸反斜杠）。
      const esc = "\u0001";
      let x: unknown = null;
      let full = "";
      for (let pad = 0; pad < 40; pad++) {
        const candidate = { pad: "p".repeat(pad), payload: Array.from({ length: 1200 }, () => esc + "汉") };
        const s = JSON.stringify(candidate, null, 2);
        if (s.length > 8000 && s.charCodeAt(7999) === 92) {
          x = candidate;
          full = s;
          break;
        }
      }
      expect(x).not.toBeNull();
      expect(full.charCodeAt(7999)).toBe(92); // 第 8000 字符 = 反斜杠（转义序列开头被切）
      const section = runAndGetSection(x);
      expect(section).toBe(full.slice(0, 8000) + "\n... (truncated)");
      // 截断段（前 8000 字符）末尾是裸反斜杠——切在转义序列中间，未补转义/结构封口
      expect(section.slice(0, 8000).endsWith("\\")).toBe(true);
    });
  });

  // ── details 形状（S#13 收尾：`__gui__` 死构造已删除，通知 details 不含 GUI 描述符）──

  // notifyDone 在 run 到达 done 终态时发送完成通知。GUI 描述符构造已删除（isWorkflow
  // 块分支恒折叠单行不消费 `__gui__`，构造即死代码——D8 同款裁决）；本节锁 details
  // 基础字段形状与「不含 __gui__ 键」的负向断言。

  /** notifyDone details 内联镜像（workflow-notify.ts WorkflowNotifyDetails 已去 export 为模块私有）。 */
  type WorkflowNotifyDetails = {
    runId: string;
    name: string;
    status: string;
    reason: string | undefined;
    traceLength: number;
    /** [u9] 账本幂等键（wf-done:<runId>）——无 ledger 绑定，走降级直发，字段原样携带。 */
    notifyId: string;
  };

  describe("notifyDone — details 形状", () => {
    it("通知 details 不含 __gui__ 键（GUI 描述符死构造已删除）", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({ status: "done", reason: "completed", slug: "ci" });

      notifyDone(pi, "run-nogui1", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const details = sentDetails(sendMessage) as Record<string, unknown>;
      expect(Object.keys(details)).not.toContain("__gui__");
    });

    it("去重：同一 runId 第二次调用不发送消息", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({ status: "done", reason: "completed" });
      const notified = new Set<string>();

      notifyDone(pi, "run-dedup", runAsParam(run), notified, undefined, settlementFor(run.state.reason));
      notifyDone(pi, "run-dedup", runAsParam(run), notified, undefined, settlementFor(run.state.reason));

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("details 基础字段正确（runId/name/status/reason/traceLength）", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({
        status: "done",
        reason: "completed",
        scriptName: "my-workflow",
        trace: [
          { stepIndex: 0, agent: "coder", status: "done" },
          { stepIndex: 1, agent: "reviewer", status: "done" },
        ],
      });

      notifyDone(pi, "run-base123", runAsParam(run), new Set(), undefined, settlementFor(run.state.reason));

      const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
      expect(details.runId).toBe("run-base123");
      expect(details.name).toBe("my-workflow");
      expect(details.status).toBe("done");
      expect(details.reason).toBe("completed");
      expect(details.traceLength).toBe(2);
    });
  });

  describe("trackNotifiedRunId（notifiedRunIds 有界 FIFO）", () => {
    it("W3TC11: 有界 FIFO——超 cap 删最旧（Set 迭代序=插入序）", () => {
      const set = new Set<string>();
      trackNotifiedRunId(set, "a", 3);
      trackNotifiedRunId(set, "b", 3);
      trackNotifiedRunId(set, "c", 3);
      trackNotifiedRunId(set, "d", 3);

      // "a" 最旧被删——Set 迭代序=插入序，删迭代器首元素即删最旧
      expect(set.size).toBe(3);
      expect(Array.from(set)).toEqual(["b", "c", "d"]);
    });

    it("W3TC12: 有界后旧 id 不再去重——被挤出窗口的 runId 再 notifyDone 会重新发送", () => {
      const { pi, sendMessage } = makePi();
      const run = makeRun({ status: "done", reason: "completed" });
      const set = new Set<string>();

      // old 首次通知 + track
      notifyDone(pi, "old", runAsParam(run), set, undefined, settlementFor(run.state.reason));
      trackNotifiedRunId(set, "old", 3);
      // 3 个新 run 依次通知 + track——"old" 被挤出窗口（set 现为 n1/n2/n3）
      for (const id of ["n1", "n2", "n3"]) {
        notifyDone(pi, id, runAsParam(run), set, undefined, settlementFor(run.state.reason));
        trackNotifiedRunId(set, id, 3);
      }
      expect(set.size).toBe(3);
      expect(Array.from(set)).toEqual(["n1", "n2", "n3"]);

      // 第二次对 "old" 的 notifyDone：has 为 false → 重新发送
      notifyDone(pi, "old", runAsParam(run), set, undefined, settlementFor(run.state.reason));

      // 旧行为『永不重复』在挤出窗口后不成立——边界显式固定：
      // old 首次 + n1/n2/n3 + old 二次 = 5 次
      expect(pi.sendMessage).toHaveBeenCalledTimes(5);
    });

    it("W3TC13: 幂等——重复 track 同一 id 不改变插入位置", () => {
      const set = new Set<string>();
      trackNotifiedRunId(set, "x", 3);
      trackNotifiedRunId(set, "x", 3); // 重复：Set.add 不改变迭代位置
      trackNotifiedRunId(set, "y", 3);
      trackNotifiedRunId(set, "z", 3);
      trackNotifiedRunId(set, "w", 3); // 触发超限：若第二次 track("x") 误重置位置，被删的将错为 y

      // 被删的是 "x"（首次插入位置不变仍最旧），非 "y"
      expect(set.size).toBe(3);
      expect(Array.from(set)).toEqual(["y", "z", "w"]);
    });

    it("生产默认 cap 锚定：不传 cap 时窗口上限 === MAX_NOTIFIED_RUN_IDS（循环实测 1001 次）", () => {
      expect(MAX_NOTIFIED_RUN_IDS).toBe(1000);
      const set = new Set<string>();
      for (let i = 0; i < 1001; i++) {
        trackNotifiedRunId(set, `run-${i}`);
      }
      expect(set.size).toBe(MAX_NOTIFIED_RUN_IDS);
      // 最旧的 run-0 已被挤出窗口
      expect(set.has("run-0")).toBe(false);
      expect(set.has("run-1")).toBe(true);
      expect(set.has("run-1000")).toBe(true);
    });
  });

  // ── stale ctx 检查（guardStaleCtx 接入，出自 notify-stale-guard.test.ts）──────
  //
  // stale ctx 检查接入（crash-resilience D1 / ext-guards 审计 §7 blockers#1 收尾）：
  // notifyDone（workflow-notify.ts）[u9 账本化] 主路径走 ledger（courier 装配层
  // sendDelivery 已内置 stale 防御）；本组用例覆盖的是 ledger 未 bind 的降级直发
  // 分支——pi.sendMessage 经 guardStaleCtx 包裹后 stale 错误（含 PS-30 分诊词）静默
  // 降级不外抛；非 stale 错误原样上抛（同一错误实例，检查不吞真实 bug）；正常路径
  // 参数透传零变化（A2 负面验证的单测）。sendDelivery 半边（同链路家族同判，
  // 被测入口是 session-lifecycle 的 bindLedgerHostAndRecover seam）已迁
  // session-lifecycle.test.ts。形态对齐 ext-guards guard-stale-ctx.test.ts；分诊无
  // isCtxStale 注入（与生产接入一致，文案兜底由 PS-30 门禁检查）。

  describe("notifyDone stale ctx 检查（guardStaleCtx 接入）", () => {
    it("stale 错误静默降级：不外抛（session 替换窗口不再崩 pi）", () => {
      const { pi, sendMessage } = makePi(() => {
        throw new Error(PI_STALE_ERROR);
      });

      expect(() => notifyDone(pi, "run-stale", runAsParam(makeRun({ scriptResult: { ok: 1 } })), new Set(), undefined, settlementFor(undefined))).not.toThrow();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("非 stale 错误原样上抛：同一错误实例，检查不吞真实 bug", () => {
      const boom = new Error("real bug: serialization exploded");
      const { pi } = makePi(() => {
        throw boom;
      });

      expect(() => notifyDone(pi, "run-boom", runAsParam(makeRun({ scriptResult: { ok: 1 } })), new Set(), undefined, settlementFor(undefined))).toThrow(boom);
    });

    it("正常路径零变化：workflow-result 消息与单通道 triggerTurn 参数原样透传（[u9] 账本化后直发仅存于 ledger 未 bind 的降级形态——deliverAs 已删，本组无绑定环境）", () => {
      const { pi, sendMessage } = makePi();

      notifyDone(pi, "run-ok", runAsParam(makeRun({ scriptResult: { ok: 1 } })), new Set(), undefined, settlementFor(undefined));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [msg, opts] = sendMessage.mock.calls[0] as [
        { customType: string; content: string; display: boolean },
        Record<string, unknown>,
      ];
      expect(msg.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
      expect(msg.display).toBe(true);
      expect(msg.content).toContain("Workflow 'build' done");
      expect(opts).toEqual({ triggerTurn: true });
    });
  });

  // ── M10: notifyDone 序列化有循环引用保护（IF13 后形态，源码锚定）─────────
  //
  // IF13（#19）：notifyDone 的 scriptResult 序列化从「整体 try { JSON.stringify(x, null, 2) }
  // catch { String(x) }」重构为 boundedPrettySerialize（只生成 ≤8000 前缀）。循环引用
  // 保护语义不变，锚定点：(1) notifyDone 调用 boundedPrettySerialize(scriptResult)；
  // (2) 实现内祖先 Set 检查（命中 throw）+ 顶层 try-catch 整体回退 String(value)
  // ——(2) 已随实现下沉锚定于 core __tests__/bounded-serialize.test.ts。
  // 行为级等价（回退输出与旧实现逐字节一致）由本文件 bounded 序列化 describe 锚定。
  // 本条是 bounded 性能契约在壳侧的唯一防线（robustness-medium-batch2 豁免保留项，
  // 出自 robustness-medium-batch2-interface.test.ts）。

  describe("M10: notifyDone serialization has circular ref protection", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const PKG_ROOT = join(__dirname, "..", "..");

    function readSrc(relPath: string): string {
      return readFileSync(join(PKG_ROOT, relPath), "utf-8");
    }

    const src = readSrc(join("src", "workflow-notify.ts"));

    it("notifyDone serializes scriptResult via boundedPrettySerialize", () => {
      // 调用点：scriptResult 不再直接 JSON.stringify，走 bounded 序列化
      const callMatch = src.match(/boundedPrettySerialize\(run\.state\.scriptResult,\s*MAX_RESULT_LENGTH\)/);
      expect(callMatch).toBeTruthy();
    });
  });
});
