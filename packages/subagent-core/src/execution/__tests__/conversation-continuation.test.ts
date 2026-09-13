// src/execution/__tests__/conversation-continuation.test.ts
//
// [H1 U2] ConversationContinuation 单测族（§5 U2 验收清单逐项对应用例）+ SubagentService
// 集成面（one-shot 四分支回归 / closeAfterRound 优雅收口消费（U5：在飞轮不打断，挂起 →
// 轮终通知送达后归档）/ 引擎死亡单发通知 / stale-child 兜底 / 收割链之外的 chat 编排面）。
//
// 设计权威源：docs/architecture/subagent-chat-run-unification.md §3.4（伪码即实现契约）/
// §3.3 D4 状态迁移表 / D5 双写点 gate / D7 轮末分流。Continuation 单测 = mock host
//（编排能力全注入，次序断言用 order 账本）；集成面 = registerFakePiEngine 协议替身
//（与 delivery-methods.test.ts 同源 setup 形态）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

const { killChildSpy } = vi.hoisted(() => ({ killChildSpy: vi.fn() }));
vi.mock("../engine/host/spawned-children.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/host/spawned-children.ts")>();
  return { ...actual, killRecordChildWithEscalation: killChildSpy };
});

import { ConversationContinuation } from "../assembly/conversation-continuation.ts";
import type {
  ContinuationDispatchInput,
  ContinuationHost,
} from "../assembly/conversation-continuation.ts";
import type { RoundSettlementOutcome } from "../persistence/finalize-record.ts";
import { createNotifier, type BgNotifyRecord } from "../notify/notifier.ts";
import { bindNotifyLedgerHost } from "../notify/notify-ledger.ts";
import type { AgentOutcome, EngineCapabilities, EngineHandle } from "../engine/types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../engine/port.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import {
  armMidRoundNoProgress,
  getSettledWatchdogPhase,
  hasSettledWatchdog,
  _resetSettledWatchdogsForTest,
  _setMidRoundNoProgressWindowMsForTest,
} from "../lifecycle/settled-watchdog.ts";
import { _resetLifecycleState } from "../lifecycle/lifecycle-manager.ts";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  registerSpawnedChildForRecord,
} from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../assembly/types.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE, type SubagentRecordEntryData } from "../persistence/record-entry.ts";

// [U4] 锚可解析性 fixture（模块级——makeRecord 缺省锚消费）：每个用例独立 tmp 文件。
beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-anchor-"));
  fixtureFile = path.join(fixtureDir, "anchor.jsonl");
  fs.writeFileSync(fixtureFile, "{}\n", "utf-8");
});
afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ============================================================
// Continuation 单测（mock host）
// ============================================================

interface HostCalls {
  order: string[];
  dispatched: Array<ContinuationDispatchInput & { recordId: string }>;
  finalized: Array<{ recordId: string; outcome: RoundSettlementOutcome }>;
  routed: string[];
  notified: BgNotifyRecord[];
  killStale: string[];
  killedRound: Array<{ recordId: string; source: string }>;
  revived: string[];
  /** [U4 / §3.2.3] reopen 降级原语委托达点（host.reopenRecord → store.markReopened）。 */
  reopened: string[];
  /** [U4] reopenRecord mock 返回值（默认 true；CAS 拒绝场景显式覆盖）。 */
  reopenAllowed: boolean;
  /** [U2b 修复轮/D2] 轮始簿记委托达点（markRoundStarted host 成员）。 */
  roundStarts: string[];
  closed: string[];
  gateAllows: boolean;
  /** [U5] 归档/寻回/重建委托达点。 */
  archived: Array<{ recordId: string; source: string }>;
  reactivated: string[];
  rebuilt: string[];
  conflictNotices: Array<{ recordId: string; patchFile: string }>;
}

/** [U4] 锚可解析性 fixture：正常 resume 路径要求 sessionFile 真实在盘（isAnchorResolvable
 *  = fs.existsSync）——假路径会误触 reopen 降级分支。beforeEach 建 tmp 空文件。 */
let fixtureDir = "";
let fixtureFile = "";

function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-cont", ...rest } = overrides;
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "cont",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  Object.assign(r, rest);
  // [U4] 缺省锚 = 真实 tmp fixture（正常 resume 路径）；显式传 undefined 仍可得无锚形态。
  if (!("sessionFile" in rest)) r.sessionFile = fixtureFile;
  return r;
}

function makeHost(record: ExecutionRecord, overrides: Partial<HostCalls> = {}): {
  host: ContinuationHost;
  calls: HostCalls;
} {
  const calls: HostCalls = {
    order: [],
    dispatched: [],
    finalized: [],
    routed: [],
    notified: [],
    killStale: [],
    killedRound: [],
    revived: [],
    reopened: [],
    reopenAllowed: true,
    roundStarts: [],
    closed: [],
    gateAllows: true,
    archived: [],
    reactivated: [],
    rebuilt: [],
    conflictNotices: [],
    ...overrides,
  };
  const host: ContinuationHost = {
    dispatchChatRound: (rec, input) => {
      calls.order.push(`dispatch:${rec.id}`);
      calls.dispatched.push({ ...input, recordId: rec.id });
    },
    finalizeRoundOutcome: async (rec, outcome) => {
      calls.order.push(`finalize:${outcome.kind}`);
      calls.finalized.push({ recordId: rec.id, outcome });
      // 模拟真实 doFinalizeRoundToIdle 的 round+1（dedup key 断言依赖）。
      // 刻意不清 closedReason（真实实现清）——notifyGate 门用例需要构造
      // 「running record + closedReason 残留」的门语义形态（真实链路该形态
      // 由 finalize 清除前的窗口构成，门是防御性第二闸）。
      record.round = (record.round ?? 0) + 1;
    },
    routeRecord: (rec) => {
      calls.order.push(`route:${rec.id}`);
      calls.routed.push(rec.id);
    },
    notifyRecord: (n) => {
      calls.order.push("notify");
      calls.notified.push(n);
    },
    killStaleChild: async (id) => {
      calls.order.push(`killStale:${id}`);
      calls.killStale.push(id);
    },
    killRoundChild: (id, source) => {
      calls.killedRound.push({ recordId: id, source });
    },
    upgradeGateAllows: () => calls.gateAllows,
    reviveClosedRecord: (rec) => {
      calls.revived.push(rec.id);
    },
    reopenRecord: (rec) => {
      // [U4 / §3.2.3] 模拟 store.markReopened 副作用（round 归零 + epoch+1 +
      // stopReason=reopened）——降级路径的字段断言在单元面锁定。
      if (!calls.reopenAllowed) return false;
      record.transcriptRef = { engine: "pi", sessionFile: record.sessionFile ?? "" };
      record.round = 0;
      record.epoch = (record.epoch ?? 0) + 1;
      record.stopReason = "reopened";
      calls.reopened.push(rec.id);
      return true;
    },
    markRoundStarted: (rec) => {
      // [U2b 修复轮/D2] mock host 记委托达点；record 实际清除语义由真实 store 链
      // 在集成面验证（下方「轮始 markRoundStarted 接线」用例）。
      calls.order.push(`roundStart:${rec.id}`);
      calls.roundStarts.push(rec.id);
    },
    closeNow: async (rec) => {
      calls.closed.push(rec.id);
    },
    // [U5] 新增 host 成员（closeAfterRound 归档消费 / 寻回 / worktree 重建 / 冲突提示）。
    archiveAfterClosingRound: async (rec) => {
      calls.order.push(`archive:${rec.id}`);
      calls.archived.push({ recordId: rec.id, source: "test" });
    },
    rebuildWorktree: async (rec) => {
      calls.rebuilt.push(rec.id);
      // 缺省 mock = 重建成功（无 handle 的 record 回填假 handle——hadWorktree 用例消费）。
      return {
        kind: "rebuilt",
        handle: Object.freeze({ path: "/tmp/wt-rebuilt", branch: `pi-sub-${rec.id}`, baseCommit: "abc", mainCwd: "/tmp/repo" }),
      };
    },
    reactivateRecord: (rec) => {
      calls.reactivated.push(rec.id);
      record.intent = "active";
    },
    notifyWorktreeConflict: (recordId, patchFile) => {
      calls.conflictNotices.push({ recordId, patchFile });
    },
  };
  return { host, calls };
}

function makeOutcome(partial: Partial<AgentOutcome> = {}): AgentOutcome {
  return { content: "", engineId: "pi", ...partial } as AgentOutcome;
}

describe("ConversationContinuation — [U4 万物可续] idle → running 翻边（revive 格，含非 chatMode 升级两成员）", () => {
  it.each(["disconnected", "parent-shutdown", "user-close", "cancelled", "gc", "parent-fork", "parent-new"] as const)(
    "idle + closedReason=%s（旧终态遗留位）+ 非 chatMode → D5 gate 放行 → 升级 chatMode=true + revive + 续聊轮派发（resume 锚点）",
    async (reason) => {
      const record = makeRecord({ id: `sa-revive-${reason}`, chatMode: false });
      record.status = "idle";
      record.closedReason = reason;
      const { host, calls } = makeHost(record);
      const cont = new ConversationContinuation(record, host);

      cont.onMessage("continue please");

      // 升级置位（D4 revive 格——v4 显式化：水合保留持久化 chatMode 后的升级语义）
      expect(record.chatMode).toBe(true);
      expect(record.status).toBe("running");
      expect(record.closedReason).toBeUndefined();
      expect(calls.revived).toEqual([record.id]);
      // [U4 万物可续] 旧终态遗留位（含 deliberately closed 家族）不再是拒绝理由：
      // 七值 × message 全放行（形态枚举 gate 消亡，closedReason 只是展示位）。
      // 续聊轮派发：锚可解析（fixture 在盘）→ 正常 resume 路径（非 reopen 降级）
      expect(calls.reopened).toEqual([]);
      await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
      expect(calls.dispatched[0]!.task).toBe("continue please");
      expect(calls.dispatched[0]!.resume?.sessionRef["sessionFile"]).toBe(fixtureFile);
    },
  );

  it("idle + 非 chatMode + D5 gate 不过（unsupported 引擎）→ 硬拒 + fork/重派指引，chatMode 不置位", async () => {
    const record = makeRecord({ id: "sa-gate-deny", chatMode: false, engine: "zcode" });
    record.status = "idle";
    record.closedReason = "disconnected";
    const { host, calls } = makeHost(record, { gateAllows: false });
    const cont = new ConversationContinuation(record, host);

    let gateError: (Error & { recovery?: string }) | undefined;
    try {
      cont.onMessage("hi");
    } catch (err) {
      gateError = err as Error & { recovery?: string };
    }
    // message = 失败原因（capabilities.conversation = 'unsupported' 依据）
    expect(gateError?.message).toContain("cannot be upgraded to a resumable conversation");
    // recovery = fork/重派指引（D5：避免升级后续聊行为悬空）
    expect(gateError?.recovery).toContain("fork-from");
    expect(gateError?.recovery).toContain("action:'start'");
    expect(record.chatMode).toBe(false);
    expect(record.status).toBe("idle");
    expect(calls.revived).toEqual([]);
    expect(calls.dispatched.length).toBe(0);
  });

  it("idle + chatMode 已置位 → 不经 gate 直接 revive（gate 判据不触达）", async () => {
    const record = makeRecord({ id: "sa-revive-chat", chatMode: true });
    record.status = "idle";
    record.closedReason = "parent-shutdown";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("hello again");

    expect(record.status).toBe("running");
    expect(calls.revived).toEqual([record.id]);
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
  });

  it("[U4 / §3.2.3] 锚失效（字段在、文件被回收）→ reopen 降级：markReopened（round 归零 + epoch+1 + stopReason=reopened）+ resume:undefined + 摘要前缀注入", async () => {
    const record = makeRecord({ id: "sa-reopen", chatMode: true, round: 3, result: "prior conclusion", turnCount: 7 });
    record.status = "idle";
    record.closedReason = "disconnected";
    // 删除 fixture 文件 = 锚失效（transcript 被回收）
    fs.rmSync(fixtureFile);
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("pick it up");

    // markReopened 降级原语触达（host.reopenRecord → store.markReopened）
    expect(calls.reopened).toEqual([record.id]);
    // 世代推进：round 归零 + epoch+1 + stopReason=reopened（mock 内模拟真实原语副作用）
    expect(record.round).toBe(0);
    expect(record.epoch).toBe(1);
    expect(record.stopReason).toBe("reopened");
    // 翻边 + 续聊派发：resume:undefined（引擎开新 session，新锚由 run 应答回填）
    expect(record.status).toBe("running");
    expect(calls.revived).toEqual([record.id]);
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(calls.dispatched[0]!.resume).toBeUndefined();
    // 首轮 prompt = 历史摘要前缀 + 用户消息（buildReopenSummaryPrompt 契约）
    expect(calls.dispatched[0]!.task).toContain("[Session reopened]");
    expect(calls.dispatched[0]!.task).toContain("- Task: initial task");
    expect(calls.dispatched[0]!.task).toContain("- Completed rounds: 3");
    expect(calls.dispatched[0]!.task).toContain("prior conclusion");
    expect(calls.dispatched[0]!.task).toContain("pick it up");
  });

  it("[U4] reopen CAS 拒绝（host.reopenRecord false）→ 同步响亮拒绝，不派发", () => {
    const record = makeRecord({ id: "sa-reopen-cas", chatMode: true });
    record.status = "idle";
    fs.rmSync(fixtureFile);
    const { host, calls } = makeHost(record, { reopenAllowed: false });
    const cont = new ConversationContinuation(record, host);

    expect(() => cont.onMessage("hi")).toThrow(/could not be reopened for a fresh transcript/);
    expect(record.status).toBe("idle");
    expect(calls.dispatched.length).toBe(0);
    expect(calls.revived).toEqual([]);
  });

  it("[U4] 锚字段缺失（从未开跑）→ 全新 session 直派（无 markReopened、无世代推进）", async () => {
    const record = makeRecord({ id: "sa-noanchor", chatMode: true, sessionFile: undefined });
    record.status = "idle";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("first message ever");

    expect(calls.reopened).toEqual([]);
    expect(record.status).toBe("running");
    expect(record.epoch).toBeUndefined();
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(calls.dispatched[0]!.resume).toBeUndefined();
    // 无锚 = 无历史可摘要，不注入 reopen 摘要前缀
    expect(calls.dispatched[0]!.task).toBe("first message ever");
  });
});

describe("ConversationContinuation — D2 打断 / abort 不终态化 / 单飞", () => {
  it("轮在途 message → abort 在途轮 signal + 入队（record 不终态化、不二次派发）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const round1Signal = calls.dispatched[0]!.signal;

    cont.onMessage("interrupt: change angle");

    // D2：打断 = 轮级 abort（非 record 级 cancel——record 保持 running）
    expect(round1Signal.aborted).toBe(true);
    expect(record.status).toBe("running");
    expect(cont.pendingCount).toBe(1);
    expect(calls.dispatched.length).toBe(1); // 单飞：无二次派发
    expect(calls.order.filter((s) => s.startsWith("dispatch")).length).toBe(1);
  });

  it("abort 收敛（onRunSettled 失败形态）→ drain 聚合队列为下一轮（单写者前置满足后才派发）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    cont.onMessage("msg A");
    cont.onMessage("msg B");

    // 被打断轮以失败形态收敛（abort 合成 error outcome）
    cont.onRunSettled(makeOutcome({ content: "", error: "engine_run_failed: run aborted" }));

    // 失败簿记 + drain：两条聚合为一轮输入
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(2));
    expect(calls.dispatched[1]!.task).toBe("msg A\n\nmsg B");
    expect(cont.pendingCount).toBe(0);
  });

  it("record 终态化后 onRunSettled → 整体 early-return：不簿记、不通知、不 drain（close 抢先）", async () => {
    const record = makeRecord({});
    record.status = "idle";
    record.closedReason = "user-close";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    // 成功形态应答（close 抢先后的迟到应答）
    cont.onRunSettled(makeOutcome({ content: "late" }));
    expect(calls.finalized.length).toBe(0);
    expect(calls.routed.length).toBe(0);
    expect(calls.notified.length).toBe(0);
    expect(cont.pendingCount).toBe(0);

    // 失败形态应答（迟到）同样 early-return
    cont.onRunSettled(makeOutcome({ content: "", error: "late failure" }));
    expect(calls.finalized.length).toBe(0);
    expect(calls.notified.length).toBe(0);
  });

  it("close 语义（abortAndClearQueue）→ abort 在途 + 清空队列（终态化由 host.closeNow 承接）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const signal = calls.dispatched[0]!.signal;
    cont.onMessage("queued during round");

    cont.abortAndClearQueue();

    expect(signal.aborted).toBe(true);
    expect(cont.pendingCount).toBe(0);
    expect(record.status).toBe("running"); // 终态化归 closeNow（编排方调用）
  });
});

describe("ConversationContinuation — [S1 P1] cancel 废弃轮身份 + 迟到轮应答丢弃（轮身份校验）", () => {
  it("cancel（abortAndClearQueue）废弃轮身份：hasActiveRound=false，后续 message 不走 D2 打断入队、直接派发新轮", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(cont.hasActiveRound).toBe(true);

    // cancel 编排（record-lifecycle cancelBackground 的 Continuation 面）：abort 轮 +
    // 清队列 + 轮身份废弃；record settle 为 idle 由调用方承接（此处最小模拟）。
    cont.abortAndClearQueue();
    expect(cont.hasActiveRound).toBe(false);
    record.status = "idle";

    // 旧轮 run 仍在飞（未模拟收敛）——message revive 不入队、直接派发新轮
    //（修复前：activeRunId 残留 → 走 D2 打断分支入队，被死轮拖到引擎收敛才 drain）。
    cont.onMessage("after cancel");
    expect(cont.pendingCount).toBe(0);
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(2));
    expect(calls.dispatched[1]!.task).toBe("after cancel");
  });

  it("被取消轮迟到失败/成功应答 → 整体丢弃：零簿记、零通知、不误清新轮在途标记、warn 含双方 runId", async () => {
    const record = makeRecord({ id: "sa-stale-drop" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const staleHandlers = calls.dispatched[0]!.handlers;

    // cancel → revive → 新轮已占位（旧轮 run 应答仍未到达——pi 停轮收敛可达 15s）
    cont.abortAndClearQueue();
    record.status = "idle";
    cont.onMessage("after cancel");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(2));
    expect(cont.hasActiveRound).toBe(true); // 新轮在途

    // 旧轮迟到应答（失败形态 = cancel 合成 abortedRunOutcome；成功形态双保险同断）
    staleHandlers.onRejected(new Error("engine_run_failed: run aborted before terminal answer"));
    staleHandlers.onSettled(makeOutcome({ content: "late stale content" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.finalized.length).toBe(0); // 无簿记（round 不多跳 +1）
    expect(calls.notified.length).toBe(0); // 无失败通知（防双通知 id:N/id:N+1）
    expect(calls.routed.length).toBe(0); // 无成功回注（防旧正文冒充）
    expect(record.round).toBe(0); // 无簿记 → round 不跳（createRecord 初值 0，迟到轮不给 roundNo 位多跳 +1）
    expect(calls.dispatched.length).toBe(2); // 无 drain 派发（迟到应答不带队列语义）
    expect(cont.hasActiveRound).toBe(true); // 新轮在途标记不被误清
    // warn 留痕：含 record id 与双方 runId（派发序号形态——旧 #r1 vs 新 #r2）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("stale round outcome dropped for sa-stale-drop"),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("#r1"));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("#r2"));
  });

  it("D2 打断的正常收敛不受轮身份校验影响：在飞轮 message 打断入队 → 该轮应答（轮身份未变）→ 正常簿记 + drain", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    cont.onMessage("queued msg"); // D2 打断（abort 轮 signal + 入队，轮身份保留）

    // 该轮收敛应答经 handlers 闭包到达（activeRunId 未变）→ 校验放行 → 正常失败簿记 + drain
    calls.dispatched[0]!.handlers.onSettled(
      makeOutcome({ content: "", error: "engine_run_failed: run aborted" }),
    );

    await vi.waitFor(() => expect(calls.dispatched.length).toBe(2));
    expect(calls.finalized).toEqual([
      { recordId: record.id, outcome: { kind: "failed", reason: "engine_run_failed: run aborted" } },
    ]);
    expect(calls.dispatched[1]!.task).toBe("queued msg");
  });
});

describe("ConversationContinuation — 轮末分流（D7）与通知面", () => {
  it("成功轮：doFinalizeRoundToIdle(success) → notifyGate 门 → route（route 晚于簿记——order 断言）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onRunSettled(makeOutcome({ content: "round text" }));

    await vi.waitFor(() => expect(calls.routed.length).toBe(1));
    expect(calls.finalized).toEqual([{ recordId: record.id, outcome: { kind: "success", content: "round text" } }]);
    const finalizeIdx = calls.order.indexOf("finalize:success");
    const routeIdx = calls.order.indexOf(`route:${record.id}`);
    expect(finalizeIdx).toBeGreaterThanOrEqual(0);
    expect(routeIdx).toBeGreaterThan(finalizeIdx); // route 晚于轮终簿记
    expect(calls.notified.length).toBe(0); // 成功通知经 route（record.result 权威），非独立载荷
  });

  it("失败轮：lastError 簿记（failed outcome）+ 独立载荷失败通知（不经 route）+ round 同样 +1（dedup 分离）", async () => {
    const record = makeRecord({ id: "sa-fail", round: 1 });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onRunSettled(makeOutcome({ content: "", error: "engine_crashed: child died" }));

    await vi.waitFor(() => expect(calls.notified.length).toBe(1));
    // 失败通知：独立构造载荷（closed+failed 形态——正文 = 失败摘要 + 恢复指引）
    const notify = calls.notified[0]!;
    expect(notify.status).toBe("closed");
    expect(notify.outcome).toBe("failed");
    expect(notify.error).toContain("round did not complete: engine_crashed: child died");
    expect(notify.error).toContain("Recovery");
    expect(notify.error).toContain("action:'message'");
    // dedup key = record:round：round 已随簿记 +1 → 失败通知与上一轮成功通知 key 分离
    expect(record.round).toBe(2);
    expect(notify.round).toBe(2);
    // 不经 route(record)——其正文恒读 record.result = 前值，直接复用会以旧正文冒充失败通知
    expect(calls.routed.length).toBe(0);
    expect(calls.finalized[0]!.outcome).toEqual({ kind: "failed", reason: "engine_crashed: child died" });
  });

  it("[U5] 成功分支 notifyGate 三元组门：编排性关闭自动收起（archived）后迟到应答不注入（route 不调）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    // [U5] 编排性关闭自动收起形态（disposeAllRecords：settle interrupted-by-parent +
    // intent=archived + 放弃轮标记）——迟到的在飞轮应答经 gate ①归档静默拦截。
    record.intent = "archived";
    record.lastAbandonedRound = { epoch: 0, round: 0 };

    cont.onRunSettled(makeOutcome({ content: "late round" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(calls.routed.length).toBe(0); // gate ① 静默——不注入可能已切换的 session
  });

  it("[U5] 失败分支 notifyGate 三元组门：cancel 中断轮放弃标记命中不双发（gate ②防双发）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    // [U5] cancelBackground 已先行（settle interrupted + 放弃轮标记 {epoch 0, round 1}
    // ——失败 settle 的 round 推进（=1）不越过标记轮）→ 迟到失败帧经 gate ②标记命中
    // 丢弃（防双发）。
    record.lastAbandonedRound = { epoch: 0, round: 1 };

    cont.onRunSettled(makeOutcome({ content: "", error: "aborted" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(calls.notified.length).toBe(0); // gate ② 阻断——防双发
  });

  it("[U5] 失败分支 notifyGate 三元组门：编排性关闭（parent-fork）自动收起后迟到帧不注入（防僵尸回执）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    // [U5] disposeAllRecords(parent-fork) 自动收起形态——gate ①静默（v4 A-6 僵尸
    // 回执防御的承接面）。
    record.intent = "archived";
    record.lastAbandonedRound = { epoch: 0, round: 0 };

    cont.onRunSettled(makeOutcome({ content: "", error: "boom" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(calls.notified.length).toBe(0);
    expect(calls.routed.length).toBe(0);
  });

  it("settle 交棒次序：onRunSettled 内 noteRoundSettledFromProtocol 先于轮终簿记（watchdog phase 观察）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    // 模拟泛化主干 arm（acquire 后挂中段——真实 arm 点在 kickOffChatRound）
    armMidRoundNoProgress(record.id, {
      onMidTimeout: () => {},
      onSettleTimeout: () => {},
    });
    expect(getSettledWatchdogPhase(record.id)).toBe("mid-round");

    // finalize mock 内观察：交棒（mid-round → settled）先于簿记
    let phaseAtFinalize: string | undefined;
    const origFinalize = host.finalizeRoundOutcome;
    const spyHost: ContinuationHost = {
      ...host,
      finalizeRoundOutcome: async (rec, outcome) => {
        phaseAtFinalize = getSettledWatchdogPhase(rec.id);
        await origFinalize(rec, outcome);
      },
    };
    const cont = new ConversationContinuation(record, spyHost);
    cont.onRunSettled(makeOutcome({ content: "text" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(phaseAtFinalize).toBe("settled"); // 交棒先于簿记（watchdog 停表早于状态写）
    // 轮终簿记后两段一并清（不残留 armed——收尾段 fire 会对已收敛轮误发 kill）
    await vi.waitFor(() => expect(hasSettledWatchdog(record.id)).toBe(false));
  });

  it("成功分支不写 roundBaseTurnIndex（base 死记账退役——负向断言）", async () => {
    const record = makeRecord({ turnCount: 5 });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onRunSettled(makeOutcome({ content: "round text" }));

    await vi.waitFor(() => expect(calls.routed.length).toBe(1));
    // [H1 U6] base 死记账（roundBaseTurnIndex）已随字段退役——负向断言锚点改为
    // turns 记账不触碰（round 推进不携带 base 副作用）。
    expect(record.turnCount).toBe(5);
  });

  it("stale-child 兜底先于派发（红线②——killStaleChild 在 dispatch 之前的 order 断言）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("next round");

    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(calls.killStale).toEqual([record.id]);
    expect(calls.order.indexOf(`killStale:${record.id}`)).toBeLessThan(
      calls.order.indexOf(`dispatch:${record.id}`),
    );
  });

  it("watchdog fire → killRoundChild + abort 轮 signal（run 收敛后失败分支统一收口）", async () => {
    const record = makeRecord({});
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const signal = calls.dispatched[0]!.signal;

    cont.onWatchdogFire({ phase: "mid-round", waitedMs: 1000 });

    expect(calls.killedRound).toEqual([{ recordId: record.id, source: "settled watchdog (mid-round)" }]);
    expect(signal.aborted).toBe(true);
    expect(record.status).toBe("running"); // kill 本身不终态化——收口归 run 应答
  });

  it("派发前轮始簿记（[U2b/D2] 归口 store.markRoundStarted——host 委托达点先于 dispatch）", async () => {
    const record = makeRecord({ round: 1 });
    record.result = "上一轮增量";
    record.resumable = true;
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("next");

    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    // 轮始簿记经 host.markRoundStarted 委托 store 原语（status=running + result/
    // resumable 清除 + 迁移上报一体——原三行现场写消灭）；record 实际清除语义由
    // 真实 store 链在集成面验证。委托先于 dispatch（spinner 恢复时序锚点）。
    expect(calls.roundStarts).toEqual([record.id]);
    expect(calls.order.indexOf(`roundStart:${record.id}`)).toBeLessThan(
      calls.order.indexOf(`dispatch:${record.id}`),
    );
  });

  it("[A2] drain 守卫失败 → 不 throw（无 unhandled rejection）+ 队列丢弃失败通知 + queue 清空（controller 缺失防御触发链）+ 丢弃通知独立 dedup 身份过真实去重链", async () => {
    // 可达触发链：[U4] 锚点缺失格已随万物可续消亡（无锚续轮 = 降级 fresh 直派）、
    // [U5] worktree 绑定丢失守卫改为自动重建（不 throw）——drain 同步守卫现存的
    // throw = controller 缺失防御（MF-4）。首轮在途 message 打断入队 → 首轮失败
    // settle → drain 以 firstRound=false 走 controller 守卫 → throw。修复前 throw
    // 逃逸 settleRoundFailed 的 void promise = unhandled rejection（Node ≥15 默认
    // 崩宿主）且队列消息静默丢失。
    const record = makeRecord({ id: "sa-drain-guard", sessionFile: undefined });
    const { host, calls } = makeHost(record);

    // 通知面接真实 notifier + ledger（生产装配形态：ContinuationHost.notifyRecord →
    // notifyHost.notify → createNotifier().notify → ledger 四步链）。纯 push mock 不过
    // 真实去重——修复前丢弃通知与同轮失败单发同 key（`id:round`）会被 ledger 幂等吞
    // （sentMessages 恒 1 条），本用例的 2 条断言即该 bug 的回归锚。
    // 元素形态 = 两列合一（ledger 写账 entry 带 data；送达落盘 entry 带 content 等，
    // 与 notify-ledger.test.ts makeLedgerHost 的 entries/sessionEntries 共享数组同构）。
    const ledgerEntries: Array<{
      type: string;
      customType: string;
      data?: unknown;
      content?: string;
      display?: boolean;
      details?: unknown;
    }> = [];
    const delivered: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
    bindNotifyLedgerHost({
      appendLedgerEntry: (customType, data) => {
        ledgerEntries.push({ type: "custom", customType, data });
      },
      readSessionEntries: () => ledgerEntries,
      isIdle: () => true,
      onAgentSettled: () => {},
      // 送达即落盘 custom_message entry（ledger 回执扫描输入，模拟 pi 落盘）。
      sendDelivery: (message) => {
        delivered.push(message);
        ledgerEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      },
    });
    const notifier = createNotifier({
      sendMessage: () => {}, // ledger 路径送达出口 = sendDelivery；本端口仅内核兜底路径消费
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    const origNotifyRecord = host.notifyRecord;
    host.notifyRecord = (n) => {
      origNotifyRecord(n);
      notifier.notify(n);
    };

    try {
      const cont = new ConversationContinuation(record, host);
      cont.startFirstRound("round 1"); // firstRound=true，无锚点守卫
      await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
      cont.onMessage("queued while running");
      expect(cont.pendingCount).toBe(1);

      // 防御形态触发：controller 丢失（MF-4 内部态错误——drain 守卫 throw 面）
      record.controller = undefined;
      // 首轮失败收敛 → settleRoundFailed 尾部 drain 触发 controller 守卫 throw（修复后就地转错误面）
      cont.onRunSettled(makeOutcome({ content: "", error: "engine_crashed: child died" }));

      // 第一条 = 失败单发（既有语义）；第二条 = drain 守卫失败的队列丢弃通知
      await vi.waitFor(() => expect(calls.notified.length).toBe(2));
      const dropped = calls.notified[1]!;
      expect(dropped.status).toBe("closed");
      expect(dropped.outcome).toBe("failed");
      expect(dropped.error).toContain("queued message could not be dispatched");
      expect(dropped.error).toContain("not ready for a new message");
      // 独立 dedup 身份：与同轮失败单发 key（`id:round`）区分，避免被永久去重吞掉
      expect(dropped.dedupKey).toBe("sa-drain-guard:1:drain-drop");
      // 真实去重链上两条都可达（修复前第二条同 key 被 ledger 吞——本断言红），
      // 且第二条 notifyId 独立、正文为丢弃文案（key 独立性在投递产物上可见）
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      expect(delivered[0]!.details).toMatchObject({ notifyId: "sa-drain-guard:1" });
      expect(delivered[1]!.details).toMatchObject({ notifyId: "sa-drain-guard:1:drain-drop" });
      expect(delivered[1]!.content).toContain("queued message could not be dispatched");
      // 队列清空 + record 保持 running-resumable + 无僵尸轮派发
      expect(cont.pendingCount).toBe(0);
      expect(record.status).toBe("running");
      expect(calls.dispatched.length).toBe(1);
      // 队列丢弃留痕（warn）
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("queued message dispatch rejected"),
      );
    } finally {
      // dispose 摘除 ledger 模块级绑定——防泄漏到同文件后续用例
      notifier.dispose();
    }
  });

  it("[A2] drain 守卫失败 + notifyGate 三元组门拦（[U5] 放弃轮标记命中）→ 通知不发（防双发语义一致）", async () => {
    const record = makeRecord({ id: "sa-drain-gate", sessionFile: undefined });
    // [U5] cancel 已先行（放弃轮标记 {epoch 0, round 1}）——失败 settle 的 round
    // 推进（=1）不越过标记轮：失败单发与 drain 丢弃通知同被 gate ②阻断。
    record.lastAbandonedRound = { epoch: 0, round: 1 };
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    cont.onMessage("queued while running");
    // 防御形态触发：controller 丢失（drain 守卫 throw 面）
    record.controller = undefined;
    cont.onRunSettled(makeOutcome({ content: "", error: "boom" }));

    // 失败单发被门拦（既有语义）→ drain 守卫失败的通知同被门拦：notified 恒 0
    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.notified.length).toBe(0);
    expect(cont.pendingCount).toBe(0);
    expect(calls.dispatched.length).toBe(1);
  });
});

// ============================================================
// SubagentService 集成面（fake engine 协议替身）
// ============================================================

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

interface ServiceInternals {
  store: RecordStore;
}

function makeService(): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  pi: PiLike;
  fake: FakePiEnginePort;
} {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-integration-"));
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  // execute() 路径的 pi 链三层解析需要 registry（首轮派发用例消费）
  modelService.initModel({
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true },
    sessionId: "root-session",
    ctxModel: { id: "m", name: "M", provider: "prov", reasoning: false },
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi, fake };
}

/** chatMode 续聊 record（首轮已完成，等待续聊）。 */
function makeChatRecord(id: string, agentDir: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "cont",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  record.status = "running";
  record.round = 1;
  record.sessionFile = path.join(agentDir, `${id}-session.jsonl`);
  fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
  return record;
}

describe("集成：chat 轮末分流（D7）——成功轮 / 失败轮 / 空正文兜底", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("成功轮：round+1 + result = 本轮 content + route 晚于簿记（次序断言）+ record 保持 running-resumable", async () => {
    const record = makeChatRecord("sa-round-ok", agentDir);
    store.register(record);
    const routeOrder: string[] = [];
    const coord = (service as unknown as {
      collectCoordinator: { route(r: ExecutionRecord): unknown };
    }).collectCoordinator;
    const storeSpy = vi.spyOn(store, "reportRecordTransition");
    const original = coord.route.bind(coord);
    Object.assign(coord, {
      route: (r: ExecutionRecord) => {
        routeOrder.push(`route:round=${r.round}`);
        original(r);
      },
    });

    await service.chatActions.deliverChatMessage(record, "round two");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "round two reply" });

    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.result).toBe("round two reply");
    // route 晚于轮终簿记（簿记 = reportRecordTransition 携带新 round；route 观察到 round=2）
    expect(storeSpy).toHaveBeenCalled();
    expect(routeOrder).toEqual(["route:round=2"]);
  });

  it("空 content 成功轮 → result = '(no output this round)'，lastError 不混入正文（D7 ⑤）", async () => {
    const record = makeChatRecord("sa-round-empty", agentDir);
    record.lastError = "stale engine_crashed: previous failure";
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "again");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "" });

    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.result).toBe("(no output this round)");
    expect(record.result).not.toContain("stale engine_crashed");
  });

  it("[U2b 修复轮/D2] 轮始 markRoundStarted 接线（真实 store 链）：派发即清上一轮 result/resumable，轮终 round 累加链不断", async () => {
    const record = makeChatRecord("sa-round-start", agentDir);
    record.result = "round 1 text";
    record.resumable = true;
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "round two");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // 轮在途：轮始簿记（store.markRoundStarted）已清执行态信号——isStreaming 公式
    //（result undefined 才显示 streaming）经归口原语达成，status 重申 running。
    expect(record.result).toBeUndefined();
    expect(record.resumable).toBeUndefined();
    expect(record.status).toBe("running");
    // 轮终链不断：markRoundIdle round+1 + 新一轮 result 写入（round 累加链回归锚）
    fake.runs[0]!.settle({ content: "round two reply" });
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.result).toBe("round two reply");
    expect(record.resumable).toBe(true);
  });

  it("失败轮：round 同样 +1 + result = 前值 ?? 失败摘要 + lastError 写入 + 失败通知单发（正文带失败摘要与恢复指引）", async () => {
    const record = makeChatRecord("sa-round-fail", agentDir);
    record.result = "first round output"; // 前值（有最后成功正文则保留）
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "round two");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "", error: "engine_round_crashed: child died", exitCode: null });

    await vi.waitFor(() => expect(record.round).toBe(2));
    // D7 失败轮写入规则：result = 前值 ?? 失败摘要。Continuation 主链轮始已清
    // result（[U2b/D2] markRoundStarted 归口——isStreaming 语义），前值分支
    // 不可达 → 失败摘要；lastError 写失败原因
    expect(record.result).toBe("round did not complete: engine_round_crashed: child died");
    expect(record.lastError).toBe("engine_round_crashed: child died");
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    // 失败通知：独立载荷（正文 = 失败摘要 + 恢复指引），dedup key = id:2
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ content?: string; details?: { notifyId?: string; round?: number } }]
    >;
    const content = calls[0]?.[0]?.content ?? "";
    expect(content).toContain("failed");
    expect(content).toContain("round did not complete: engine_round_crashed: child died");
    expect(content).toContain("Recovery");
    const details = calls[0]?.[0]?.details as { notifyId?: string } | undefined;
    expect(details?.notifyId).toBe(`${record.id}:2`);
    // 失败通知不经 route(record)——route 零调用（防旧正文冒充失败通知）。
    // [H1 U6] roundBaseTurnIndex 负向断言随 base 死记账字段退役删除。
  });

  it("首轮失败（无前值）→ result = 失败摘要（非 undefined——renderer hasRunning 判据保持）", async () => {
    const handle = await service.execute({ task: "first round", slug: "t", conversation: true });
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.fail(new Error("spawn prepare failed: model not available"));

    const record = store.getMutable(handle.subagentId);
    await vi.waitFor(() => expect(record?.resumable).toBe(true));
    expect(record?.status).toBe("running");
    expect(record?.result).toBe("round did not complete: spawn prepare failed: model not available");
    expect(record?.result).toBeDefined();
    // 失败通知单发
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
  });
});

describe("集成：close 优雅收口（[U5] §3.2.5 close = 归档：在飞轮不打断，closeAfterRound 挂起 → 轮终通知送达后归档）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("轮在途 close(force:false) → 优雅收口挂起（closeAfterRound=true，不打断在飞轮）→ 轮终通知送达后归档 + intent=archived", async () => {
    const record = makeChatRecord("sa-close-mid", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    await service["closeSubagent"](record, false);

    // [U5] close = 优雅收口：不打断在飞轮——closeAfterRound 挂起（设计 close 行
    // 「在飞轮优雅收口后归档」），status 保持 running（轮在飞）。
    expect(record.status).toBe("running");
    expect(record.closeAfterRound).toBe(true);
    expect(record.intent).toBeUndefined();

    // 轮终收敛：收口轮 settle → 轮次通知送达（route 过 gate ③豁免）→ 归档消费点。
    fake.runs[0]!.settle({ content: "closing round text" });
    await vi.waitFor(() => expect(record.intent).toBe("archived"));
    // 顺序约束 [写死]：归档前轮次通知已送达（pi.sendMessage 被调——轮次通知先于
    // intent 翻转，gate ①静默不吞收口轮通知）。
    expect(pi.sendMessage).toHaveBeenCalled();
    // 收口轮 settle 后 idle + 关闭挂起标志已消费
    expect(record.status).toBe("running");
    expect(record.closeAfterRound).toBeUndefined();
    // 「已收起」提示（chatMode 归档通知一条）
    await vi.waitFor(() => {
      const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("close 归档后 queue 不再派发（archived 静默 + idle 收口），message 寻回翻回 active", async () => {
    const record = makeChatRecord("sa-close-queue", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // 在途轮打断入队
    await service.chatActions.deliverChatMessage(record, "queued msg");
    // [2026-09-13 design-code-sync 接线] continuations 队列已迁 ChatRounds 聚合——
    // 读取路径改经聚合实例（断言对象与强度不变）。
    const conts = (
      service as unknown as { chatRounds: { continuations: Map<string, { pendingCount: number }> } }
    ).chatRounds.continuations;
    expect(conts.get(record.id)?.pendingCount).toBe(1);

    // [U5] close 优雅收口挂起（不打断在飞轮、不清队列——轮终后归档消费）。
    await service["closeSubagent"](record, false);
    expect(record.closeAfterRound).toBe(true);

    // 轮终收敛：settle → 通知送达 → 归档（intent=archived）。close 时排队消息已随
    // 收起意愿作废（clearQueue——不打断在飞轮）→ 轮终 drain 无排队可派发（无续轮）。
    fake.runs[0]!.settle({ content: "late" });
    await vi.waitFor(() => expect(record.intent).toBe("archived"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(conts.get(record.id)?.pendingCount ?? 0).toBe(0);
    expect(fake.runs.length).toBe(1); // 队列已随 close 作废——无 drain 派发
    // [U5] 归档后 message = 隐含寻回：intent 翻回 active（markReactivated）+ 续聊
    //（锚文件由 fake 引擎持有（fixture 目录无实体文件）→ reopen 降级 + fresh 派发承接）
    await service.chatActions.deliverChatMessage(record, "after close");
    await vi.waitFor(() => expect(record.intent).toBe("active"));
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
  });
});

describe("集成：[S1 P1] cancel 后续聊——被取消轮迟到 run 应答丢弃（不串轮/不双通知/不覆盖新轮正文）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it("round 2 在飞 cancel → message revive 派发新轮 → 旧轮迟到 abort 失败应答零副作用 → 新轮成功不被覆盖", async () => {
    const record = makeChatRecord("sa-s1-late", agentDir);
    store.register(record);

    // round 2 在飞（续聊轮）
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // cancel（真链 cancelBackground：abort + kill 镜像 + settle idle/interrupted +
    // 放弃轮标记 + Continuation 轮身份废弃）
    expect(service.cancel(record.id)).toBe(true);
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted");

    // S1 续聊：message revive——新轮直接派发（旧轮 run 仍挂在 fake 上未收敛）
    await service.chatActions.deliverChatMessage(record, "resume after cancel");
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(record.status).toBe("running");

    // 旧轮（round 2）迟到失败应答：cancel 合成 abortedRunOutcome 的 reject 形态，
    // 到达时 record 已被 revive 翻回 running（status 守卫失守）——轮身份校验拦截
    fake.runs[0]!.fail(new Error("engine_run_failed: run sa-s1-late aborted before terminal answer"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 迟到零副作用：无失败簿记（round 不多跳到 2）、无失败通知、record 不被标 failed
    expect(record.round).toBe(1);
    expect(record.stopReason).toBe("interrupted"); // 未被 failed 覆盖
    expect(record.status).toBe("running");
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // 新轮（round 2 位）成功收敛：round 推进到 2 + 新正文 + 成功通知单发（唯一通知）
    fake.runs[1]!.settle({ content: "resume reply" });
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.stopReason).toBe("completed");
    expect(record.result).toBe("resume reply");
    expect(record.resumable).toBe(true);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ details?: { notifyId?: string } }]
    >;
    expect(calls[0]?.[0]?.details).toMatchObject({ notifyId: "sa-s1-late:2" });
  });
});

describe("集成：one-shot（非 chatMode）settleOneShotOutcome 四分支零变化回归（G3）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    ({ agentDir, service, store } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeOneShotRecord(id: string): ExecutionRecord {
    const record = createRecord(id, {
      agent: "general-purpose",
      model: "prov/model-1",
      mode: "background",
      task: "t",
      slug: "oneshot",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    store.register(record);
    return record;
  }

  async function settleOneShot(
    record: ExecutionRecord,
    result: { text: string; success: boolean; error?: string },
    aborted: boolean,
  ): Promise<void> {
    // [R4 深绑改写] settleOneShotOutcome 本体已迁 RunOrchestration 聚合（顶部
    // D7 origin==="workflow" CAS 抢锁分支原样随迁）——bracket 调用改经聚合实例。
    await (
      service as unknown as {
        runOrchestration: {
          settleOneShotOutcome: (
            r: ExecutionRecord,
            result: { text: string; success: boolean; error?: string },
            aborted: boolean,
          ) => Promise<void>;
        };
      }
    ).runOrchestration.settleOneShotOutcome(record, result as never, aborted);
  }

  it("分支①：成功（无挂起）→ doFinalizeRoundToIdle 保持 running-resumable（SP-5——成功轮不终态化）", async () => {
    const record = makeOneShotRecord("sa-oneshot-ok");
    await settleOneShot(record, { text: "done text", success: true }, false);
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.result).toBe("done text");
    expect(record.closedReason).toBeUndefined();
  });

  it("分支②：成功 + closeAfterRound → settle（SP-5 保持 running-resumable），挂起标志留给主干 route 后归档消费（[U5] 顺序约束）", async () => {
    const record = makeOneShotRecord("sa-oneshot-close");
    record.closeAfterRound = true;
    await settleOneShot(record, { text: "done", success: true }, false);
    // [U5] settle 不终态化；标志不清——归档消费在主干尾部 route 之后（本单元
    // settleOneShotOutcome 的职责边界 = settle，通知/归档归 kickOffChatRound 主干）。
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.result).toBe("done");
    expect(record.closeAfterRound).toBe(true);
    expect(record.closedReason).toBeUndefined();
  });

  it("分支③：失败 + closeAfterRound → settle failed（保持 running-resumable），挂起标志留给主干归档消费（[U5]）", async () => {
    const record = makeOneShotRecord("sa-oneshot-fail-close");
    record.closeAfterRound = true;
    await settleOneShot(record, { text: "", success: false, error: "boom" }, false);
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.lastError).toBe("boom");
    expect(record.closeAfterRound).toBe(true);
  });

  it("分支④：失败（无挂起）→ settle failed 不终态化（[U5] 万物可续——失败轮可续聊）", async () => {
    const record = makeOneShotRecord("sa-oneshot-fail");
    await settleOneShot(record, { text: "", success: false, error: "boom" }, false);
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.closedReason).toBeUndefined();
    expect(record.lastError).toBe("boom");
  });

  it("分支⑤：aborted → [U5] cancel 语义 settle interrupted + 放弃轮标记（不终态化）", async () => {
    const record = makeOneShotRecord("sa-oneshot-abort");
    await settleOneShot(record, { text: "partial", success: true }, true);
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted");
    expect(record.closedReason).toBeUndefined();
    expect(record.lastAbandonedRound).toEqual({ epoch: 0, round: 0 });
    // cancel 优先于 close 挂起（用户显式叫停——挂起作废）
    expect(record.closeAfterRound).toBeUndefined();
  });
});

describe("集成：引擎死亡 → Continuation 单发失败通知（D8 监督豁免维持回归）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("chatMode 轮 run reject（engine_crashed）→ 失败通知单发 + record 保持 running-resumable（不走监督器接管）", async () => {
    const record = makeChatRecord("sa-engine-death", agentDir);
    store.register(record);
    const adoptSpy = vi.spyOn(
      (service as unknown as { roundSupervisor: { adoptOnProcessDeath: (r: ExecutionRecord, m: string) => void } })
        .roundSupervisor,
      "adoptOnProcessDeath",
    );

    await service.chatActions.deliverChatMessage(record, "risky round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.fail(
      Object.assign(new Error("engine process exited unexpectedly: signal SIGKILL"), {
        name: "EngineSdkError",
      }),
    );

    // MF-6：record 保持 running-resumable（容器不被销毁——用户再 message 自动 resume）
    await vi.waitFor(() => expect(record.resumable).toBe(true));
    expect(record.status).toBe("running");
    // D8 豁免维持：chatMode 不进监督域接管链（adopt 调用 gate = chatMode !== true）
    expect(adoptSpy).not.toHaveBeenCalled();
    // 单发：Continuation 失败通知恰一条（不存在 supervisor merged notice 双发面）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ content?: string }]
    >;
    expect(calls[0]?.[0]?.content).toContain("engine process exited unexpectedly");
  });
});

describe("集成：stale-child 派发前兜底（红线②）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    vi.useRealTimers();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("镜像在途子进程活着 → kill 记账 + 协议 cancel + 有界退出窗后派发（无活项 = 直接派发）", async () => {
    const record = makeChatRecord("sa-stale-child", agentDir);
    store.register(record);
    // 模拟上一轮子进程滞留（引擎存活期状态错配——Continuation 无在途 run 但镜像有活项）
    registerSpawnedChildForRecord(record.id, { pid: 999999, killed: false } as never);

    await service.chatActions.deliverChatMessage(record, "next round");

    // kill 记账（镜像置死——[H1 U6] 协议 cancel 帧随 interact 面退役，真实杀链 =
    // 轮级 abort signal → cancel 帧 + 引擎轮末收割）
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "stale-child guard (dispatch)");
    // 有界退出窗（STALE_CHILD_EXIT_WAIT_MS=300ms）后派发——双写窗收敛
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(fake.runs[0]!.task.prompt).toBe("next round");
  });

  it("镜像无活项 → 派发不经兜底窗（无 kill、无 cancel）", async () => {
    const record = makeChatRecord("sa-no-stale", agentDir);
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "next round");

    expect(killChildSpy).not.toHaveBeenCalledWith(record.id, "stale-child guard (dispatch)");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
  });
});

describe("集成：[A1] one-shot（非 chatMode）pi background 轮楔死熔断回归（G3 行为零变化恢复）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("one-shot 轮 arm 恢复（轮开跑即挂中段守护）+ fire → kill + abort + [U5] 失败轮 settle + 失败通知单发", async () => {
    // 测试注入秒级窗（M6 seam）——fire 走真实 timer 全链（arm → mid-round 到期 → 处置）。
    // 窗值须大于 vi.waitFor 轮询间隔（50ms），保证 arm 断言先于 fire 到期。
    _setMidRoundNoProgressWindowMsForTest(120);
    const handle = await service.execute({ task: "wedged task", slug: "oneshot-wedge" });
    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // arm 恢复断言（回归锚点：H1 重构曾误删——修复前本断言红，楔死 run 无恢复计时）
    await vi.waitFor(() => expect(hasSettledWatchdog(record!.id)).toBe(true));
    expect(getSettledWatchdogPhase(record!.id)).toBe("mid-round");

    // fire（在途 run 永悬 = 楔死形态）→ 处置：kill + abort 轮 signal + [U5] 失败轮
    // settle（markRoundIdle——保持 running-resumable，不终态化；watchdog 杀轮非用户
    // 放弃，失败通知必须送达）
    await vi.waitFor(() => expect(record!.resumable).toBe(true));
    expect(record!.status).toBe("running");
    expect(record!.closedReason).toBeUndefined();
    expect(killChildSpy).toHaveBeenCalledWith(record!.id, "settled watchdog (one-shot)");
    expect(record!.controller?.signal.aborted).toBe(true);
    // 失败文案（旧 onHotPathSettledWatchdogTimeout 非 chatMode 分支同文——含恢复指引）
    expect(record!.lastError).toContain("subagent did not reach agent_settled");
    expect(record!.lastError).toContain("settled watchdog");
    expect(record!.lastError).toContain("Recovery");
    // 失败通知发出（独立载荷过 notifyGate 门 → notifyHost.notify）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ content?: string; details?: { notifyId?: string; outcome?: string } }]
    >;
    expect(calls[0]?.[0]?.content).toContain(`Subagent "general-purpose" (${record!.id}) failed`);
    expect(calls[0]?.[0]?.content).toContain("settled watchdog");
    expect(calls[0]?.[0]?.content).toContain("Recovery");
    expect(calls[0]?.[0]?.details?.outcome).toBe("failed");
  });

  it("chat 轮路径零变化：continuation 轮 arm 仍走 onWatchdogFire（fire 不触发 one-shot 处置）", async () => {
    _setMidRoundNoProgressWindowMsForTest(300);
    const record = makeChatRecord("sa-chat-wedge", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    await vi.waitFor(() => expect(hasSettledWatchdog(record.id)).toBe(true));

    // fire → Continuation.onWatchdogFire（kill + abort，收口归 run 应答）——record 不终态化
    await vi.waitFor(() => expect(killChildSpy).toHaveBeenCalledWith(record.id, "settled watchdog (mid-round)"));
    // abort 的是轮级 signal（run ctx.signal——引擎侧杀链驱动），非 record 级 controller
    expect(fake.runs[0]!.ctx.signal?.aborted).toBe(true);
    expect(record.status).toBe("running");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("集成：[A5] D5 gate 判定本体直测（canUpgradeToConversation——此前仅被 mock）", () => {
  let agentDir: string;
  let service: SubagentService;

  beforeEach(() => {
    ({ agentDir, service } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("registry 注册 engine capabilities.conversation='unsupported' 的 stub → false", () => {
    const fake = registerFakePiEngine();
    const caps = { ...fake.capabilities(), conversation: "unsupported" as const };
    registerEngine("stub-unsupported", () => ({ id: "stub-unsupported", capabilities: () => caps }) as never);

    expect(service.canUpgradeToConversation({ engine: "stub-unsupported" })).toBe(false);
  });

  it("引擎未注册 → fail-closed false（catch 分支）；engine 缺省 → 默认引擎（pi conversation=native）放行", () => {
    expect(service.canUpgradeToConversation({ engine: "no-such-engine" })).toBe(false);
    expect(service.canUpgradeToConversation({})).toBe(true);
  });
});

// ============================================================
// 集成：live usage 喂入（H2 Gate B 修复）——chat 轮 / pi one-shot / 非 pi 引擎
// ============================================================
//
// [H2 Gate B] W3 删 inproc pi 引擎（session-runner.ts agentEvent 出口）时，协议化
// service 侧 chat 轮与 tool one-shot 的 live reducer 喂入（updateFromEvent）一并断链
// ——record.turns/totalTokens 恒 0，而 journal-replay / session-view-service 重放路径
// 保真（live 落后于 replay 的倒挂）。修复 = runWorkflowEngineTask observedEvent 同款
// 喂入恢复（reducer 与重放同源，C5 守护）。本组用例锁三形态：
//   1. chat 轮（kickOffChatRound chatMode 分支）：实时累积 + 轮终 entry 保真 + 跨轮持续
//      （Continuation 轮间共用同一 record 实例）+ close 终态 entry 保真；
//   2. pi one-shot（kickOffChatRound 非 chatMode 分支——修复前连 onEvent 都不传）：
//      实时累积 + outcome 写入不重置（completeRecord 只读不重置契约）；
//   3. 非 pi 引擎（kickOffEngineRun → runEngineTask——修复前事件只喂 journal）：
//      实时累积 + 终态 entry 保真（非 pi one-shot 一次 run 即终态化）。
// 红锚：任一形态喂入行移除即转红（totalTokens 恒 0）。

/** 非 pi 引擎替身（run 挂起捕获；settle 由用例驱动——runEngineTask 喂入用例专用）。 */
class FeedCaptureEngine implements EnginePort {
  readonly id = "zcode";
  readonly runs: Array<{
    ctx: RunContext;
    emitEvent: (event: unknown) => void;
    settle: (content: string) => void;
  }> = [];

  capabilities(): EngineCapabilities {
    return {
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "stream",
      sandbox: "none",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
    };
  }

  async probe(): Promise<{ ok: true; engineVersion: string; checks: Array<{ name: string; ok: true }> }> {
    return { ok: true, engineVersion: "fake-zcode", checks: [{ name: "bin", ok: true }] };
  }

  run(_task: unknown, ctx: RunContext): Promise<EngineRunResult> {
    return new Promise<EngineRunResult>((resolve) => {
      this.runs.push({
        ctx,
        emitEvent: (event) => ctx.onEvent?.(event as never),
        settle: (content) =>
          resolve({
            handle: {
              data: {
                v: 1,
                engineId: this.id,
                sessionRef: { recordId: ctx.taskId },
                adapterVersion: "feed-capture-engine",
              } satisfies EngineHandle["data"],
            },
            outcome: { content, engineId: this.id },
          }),
      });
    });
  }

  async read(): Promise<{ engineId: string; turns: never[]; source: "outcome-only" }> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }
}

describe("集成：live usage 喂入（H2 Gate B）——chat 轮 / pi one-shot / 非 pi 引擎", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;
  let entries: SubagentRecordEntryData[];
  let prevDataDirEnv: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
    // journal 落盘隔离（非 pi 引擎用例 wireEventJournal 写盘；测试红线：不触真实数据目录）
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-usage-feed-"));
    process.env.XYZ_AGENT_DATA_DIR = path.join(agentDir, "engine-data");
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true },
      sessionId: "root-session",
      ctxModel: { id: "m", name: "M", provider: "prov", reasoning: false },
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    entries = [];
    (pi.appendEntry as ReturnType<typeof vi.fn>).mockImplementation(
      (customType: string, data: unknown) => {
        if (customType === SUBAGENT_RECORD_CUSTOM_TYPE) entries.push(data as SubagentRecordEntryData);
      },
    );
    service.initSession({ pi, sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
    else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 本 record 的 entry 序列（appendEntry 捕获投影）。 */
  function entriesFor(id: string): SubagentRecordEntryData[] {
    return entries.filter((e) => (e as { id?: string }).id === id);
  }

  it("chat 轮：message_end(usage) → totalTokens/turnCount 实时累积；轮终 entry 保真；跨轮持续；close 终态 entry 保真", async () => {
    const record = makeChatRecord("sa-usage-chat", agentDir);
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "round one");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // 引擎协议事件（pi-subagent-cli spawn-event-translator 的协议产物形态）
    fake.runs[0]!.emitEvent({
      type: "message_end",
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, cost: 0.5 },
    });
    fake.runs[0]!.emitEvent({ type: "text_delta", delta: "working" });
    fake.runs[0]!.emitEvent({ type: "turn_end" });
    fake.runs[0]!.emitEvent({ type: "message_end", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });

    // live record 实时累积（修复前：轮实际消耗 LLM 而 record 恒 0）
    expect(record.totalTokens).toBe(190); // (100+50+20+10) + (7+3)
    expect(record.turnCount).toBe(1);

    // 轮终 settle → 轮终簿记 entry 携带非零 usage（chat 域轮终不终态——终态 = close）
    fake.runs[0]!.settle({ content: "round one reply" });
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.totalTokens).toBe(190);
    const roundEntry = entriesFor(record.id).at(-1);
    expect(roundEntry).toMatchObject({ id: record.id, totalTokens: 190 });

    // 跨轮持续：Continuation 轮间共用同一 record 实例，第二轮继续累积
    await service.chatActions.deliverChatMessage(record, "round two");
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    fake.runs[1]!.emitEvent({
      type: "message_end",
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
    fake.runs[1]!.emitEvent({ type: "turn_end" });
    expect(record.totalTokens).toBe(200);

    // [U5] close 归档 → 收口轮 settle + 归档 entry totalTokens/turns 保真（list /
    // 重启重建源读到的形态；record 不终态化——markRoundIdle 保持 running-resumable，
    // entry status 投影随之）
    fake.runs[1]!.settle({ content: "round two reply" });
    await vi.waitFor(() => expect(record.round).toBe(3));
    await service["closeSubagent"](record, false);
    await vi.waitFor(() => expect(record.intent).toBe("archived"));
    const finalEntry = entriesFor(record.id).at(-1);
    expect(finalEntry).toMatchObject({ id: record.id, status: "running", totalTokens: 200, turns: 2 });
  });

  it("pi one-shot：message_end(usage) → totalTokens/turnCount 实时累积；outcome 写入不重置", async () => {
    const handle = await service.execute({ task: "oneshot usage", slug: "oneshot-usage" });
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    fake.runs[0]!.emitEvent({
      type: "message_end",
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, cost: 0.5 },
    });
    fake.runs[0]!.emitEvent({ type: "turn_end" });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.totalTokens).toBe(180);
    expect(record!.turnCount).toBe(1);

    // settle → outcome 字段写入不重置 turns/totalTokens（completeRecord 只读契约）
    fake.runs[0]!.settle({ content: "done" });
    await vi.waitFor(() => expect(record!.result).toBe("done"));
    expect(record!.totalTokens).toBe(180);
    expect(record!.turnCount).toBe(1);
  });

  it("非 pi 引擎（runEngineTask）：message_end(usage) → totalTokens 实时累积；终态 entry 保真", async () => {
    const zcode = new FeedCaptureEngine();
    registerEngine("zcode", () => zcode);

    const handle = await service.execute({ task: "zcode usage", slug: "zc-usage", engine: "zcode" });
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    zcode.runs[0]!.emitEvent({
      type: "message_end",
      usage: { input: 30, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.totalTokens).toBe(42); // 修复前：事件只喂 journal，record 恒 0

    // 非 pi one-shot 一次 run 即终态化（finalizeEngineOutcome → closed/gc + entry 落盘）
    zcode.runs[0]!.settle("done");
    await vi.waitFor(() => expect(record!.status).toBe("idle"));
    const finalEntry = entriesFor(record!.id).at(-1);
    expect(finalEntry).toMatchObject({ id: record!.id, status: "idle", totalTokens: 42 });
  });
});

// ============================================================
// [U6 / §3.2.6] zcode record 的 Continuation 续聊派发：resumeAnchor 引擎分派
//（zcode 锚 {sessionId, dbPath} → 引擎侧 resume 读 + 新 session 注入）+ 锚缺失/
// 失效分支的引擎中立化。fixture：真实 node:sqlite 建 tmp 库（锚可解析形态）。
// ============================================================

describe("ConversationContinuation — [U6] zcode 锚分派与降级", () => {
  let zcodeDir: string;
  let zcodeDb: string;

  beforeEach(() => {
    zcodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-zcode-"));
    zcodeDb = path.join(zcodeDir, "db.sqlite");
  });

  afterEach(() => {
    fs.rmSync(zcodeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** zcode record（sessionFile 恒 undefined；锚 = engineHandle.sessionRef）。 */
  function makeZcodeRecord(over: {
    sessionId?: string;
    dbPath?: string;
    round?: number;
  }): ExecutionRecord {
    return makeRecord({
      id: "sa-zcode",
      engine: "zcode",
      sessionFile: undefined,
      round: over.round ?? 2,
      engineHandle: {
        sessionRef: {
          sessionId: over.sessionId ?? "sess_z_anchor",
          dbPath: over.dbPath ?? zcodeDb,
        },
        poolKey: "shared",
      },
    });
    // 注：engineHandle.poolKey 是持久化 record 形状成员（读侧守卫要求非空，值恒 'shared'），
    // 不随 [池抽象降级] 协议面退役删除——resume 锚（ResumeAnchor）才不再携带 poolKey。
  }

  async function seedZcodeDb(): Promise<void> {
    const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
    type Db = { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void }; close: () => void };
    const db = new DatabaseSync(zcodeDb) as unknown as Db;
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER)");
    db.prepare("INSERT INTO session (id, time_created) VALUES ('sess_z_anchor', 1)").run();
    db.close();
  }

  it("锚可解析（库条目在）→ resume 锚携带 zcode 形态（sessionRef={sessionId,dbPath}），无摘要前缀", async () => {
    await seedZcodeDb();
    const record = makeZcodeRecord({});
    record.status = "idle";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("继续看导出接口");

    expect(record.status).toBe("running");
    expect(calls.reopened).toEqual([]);
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    // resume 锚 = zcode 形态（引擎侧据此走 session/resume 读 + 新 session 注入）
    expect(calls.dispatched[0]!.resume).toEqual({
      sessionRef: { sessionId: "sess_z_anchor", dbPath: zcodeDb },
    });
    // 锚在 → 不注入 reopen 摘要（历史由引擎侧结构化注入，非宿主摘要）
    expect(calls.dispatched[0]!.task).toBe("继续看导出接口");
  });

  it("锚失效（库条目被 TTL 清）→ 降级：reopenRecord 闭包恒 false（zcode 无 pi 锚）不抛错，无世代推进 + 摘要前缀 + resume:undefined", async () => {
    // dbPath 指向不存在文件 = 锚失效（isAnchorResolvable fail-closed）
    const record = makeZcodeRecord({ dbPath: path.join(zcodeDir, "swept.sqlite"), round: 4 });
    record.status = "idle";
    // reopenAllowed=false 复刻真实 run-orchestration 闭包对 zcode record 的行为
    //（sessionFile undefined → markReopened pi 锚不可构造 → 恒 false）
    const { host, calls } = makeHost(record, { reopenAllowed: false });
    const cont = new ConversationContinuation(record, host);

    expect(() => cont.onMessage("继续")).not.toThrow();
    expect(record.status).toBe("running");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    // 无世代推进（无 markReopened 侧作用）：round 保持连续
    expect(record.round).toBe(4);
    expect(record.epoch).toBeUndefined();
    expect(calls.dispatched[0]!.resume).toBeUndefined();
    expect(calls.dispatched[0]!.task).toContain("[Session reopened]");
    expect(calls.dispatched[0]!.task).toContain("继续");
  });

  it("锚缺失（zcode record 无 engineHandle——从未开跑）→ 全新 session 直派（resume:undefined、无摘要）", async () => {
    const record = makeZcodeRecord({});
    record.engineHandle = undefined;
    record.status = "idle";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("first contact");

    expect(record.status).toBe("running");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(calls.dispatched[0]!.resume).toBeUndefined();
    expect(calls.dispatched[0]!.task).toBe("first contact");
  });
});
