// src/execution/__tests__/subagent-actions-core.test.ts
//
// ⛔4 行为快照等值测试（sink 设计 docs/design/subagent-core-sink-design.md §5.4 ⛔4 /
// impl-plan u-core-actions）：六 handler（start/list/cancel/message/close/fork-from）
// 的校验、守卫链、归属判定、终态映射，迁移前后行为逐项一致。
//
// 期望值形态：**硬编码自 pi-sw 现实现（extensions/universal/subagent-workflow
// src/interface/subagent-actions.ts）迁移前实测输出**——临时探针以 stub SubagentService
// 驱动 pi-sw 六 handler，dump 实际 JSON（含错误文案逐字 / execute/deliver/close 调用
// 参数），本文件将输出固化为字面量。core 测试不 import pi-sw 源码（core vitest 红线：
// pi-coding-agent 零运行时触点）；pi 侧收缩改造（u-sw-actions）后以同款探针复测即得
// 「迁移前后逐项一致」的可证伪断言。
//
// stub SubagentService 仅实现 handler 触达的方法子集（形态同 pi-sw tool-action.test.ts），
// 领域内核的分支逻辑由 stub 返回值驱动——真实 service 行为归属 subagent-service 各自测试。
//
// duration 确定性：recordToListItem 对无 endedAt 的 running record 经 computeElapsedSeconds
// 读 Date.now()——本文件用 fake timers 固定时钟（now = 探针首跑实值 1788189209000），
// 使快照期望值与实测值逐字可比。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BG_MESSAGE,
  DEFAULT_LIST_LIMIT,
  FORK_FROM_DEFAULT_PROMPT,
  MAX_LIST_LIMIT,
  NOTIFY_CONTRACT,
  cancelHandler,
  closeHandler,
  endedMessageGuard,
  forkFromHandler,
  listHandler,
  mapExternalState,
  messageHandler,
  recordToListItem,
  startHandler,
  wrapForkFromPrompt,
} from "../subagent-actions-core.ts";
import { ResurrectDeniedError } from "../types.ts";
import { writeAliveMarker } from "../alive-store.ts";
import type {
  ExecutionHandle,
  ExecutionRecord,
  SubagentRecord,
  SubagentToolDetails,
} from "../types.ts";
import type { SubagentService } from "../subagent-service.ts";

// ── 时钟固定（duration 快照确定性，见文件头）──
const FROZEN_NOW = 1788189209000;

/** [U1/A4] 「异进程且存活」的确定性模拟 pid：1 号进程（launchd/init）必然存在且非
 *  本测试进程——kill(1, 0) 对普通用户返回 EPERM，isProcessAlive 按「存在但无权限」
 *  保守判活（self-pid 排除后不能再以本进程 pid 模拟异进程实例，同 cold-lookup.test.ts）。 */
const FOREIGN_LIVE_PID = 1;

beforeAll(() => {
  vi.useFakeTimers({ now: FROZEN_NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

// ── stub 工厂（与迁移前探针同形态，期望值由此驱动产生）──

function makeDetails(over: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    status: "running",
    mode: "background",
    agent: "/home/u/agents/worker.md",
    model: "prov/m1",
    thinkingLevel: undefined,
    slug: "src-slug",
    turns: 1,
    totalTokens: 10,
    elapsedSeconds: 1,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    ...over,
  } as SubagentToolDetails;
}

function makeExecRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "bg-1",
    agent: "/home/u/agents/reader.md",
    model: "prov/m1",
    thinkingLevel: undefined,
    mode: "background",
    task: "t",
    slug: "src-slug",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 1,
    totalTokens: 10,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    chatMode: true,
    sessionFile: "sess-1.jsonl",
    ...over,
  } as ExecutionRecord;
}

function makeRec(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "bg-1",
    agent: "/home/u/agents/reader.md",
    task: "t",
    slug: "src-slug",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    sessionFile: "sess-1.jsonl",
    chatMode: true,
    ...over,
  } as SubagentRecord;
}

function makeService(over: Record<string, unknown> = {}): SubagentService {
  // 聚合面形态对齐 subagent-service.ts D4：queries（读模型）与 chatActions（对话
  // action 面）分组挂载，mock 按同构 key 装配（over 仍传平铺 key，最小化快照用例改动）。
  const m = {
    execute: vi.fn(),
    cancel: vi.fn(() => false),
    findRecord: vi.fn(() => undefined),
    collectRecords: vi.fn(() => [] as SubagentRecord[]),
    getFullRecord: vi.fn(() => undefined as SubagentRecord | undefined),
    lookupRecordAnyState: vi.fn(() => undefined as SubagentRecord | undefined),
    getRecordForAction: vi.fn(),
    closeSubagent: vi.fn(),
    deliverChatMessage: vi.fn(),
    // [H1 U2 / D5 双写点①] messageHandler 升级 gate 判据读 service.canUpgradeToConversation
    //（stub 缺省放行 = pi 默认引擎语义；gate 拒绝面专项见 conversation-continuation.test.ts）。
    canUpgradeToConversation: vi.fn(() => true),
    // [U2] startHandler 缺省 collect 解析读真实 config（偏差#3 接线）：stub 缺省 async
    //（本文件不测 collect 语义，专项见 start-collect-guard.test.ts）。
    getCollectSyncDefault: vi.fn(() => "async" as const),
    ...over,
  };
  return {
    execute: m.execute,
    cancel: m.cancel,
    // [H1 U2 / D5 双写点①] messageHandler 升级 gate 判据经平铺访问器（真实 service 为
    // 平铺方法，非 queries/chatActions 聚合面成员），stub 须同构挂载。
    canUpgradeToConversation: m.canUpgradeToConversation,
    // [U2 偏差#3 接线] startHandler 经平铺访问器读 config 缺省 collect（真实 service
    // 为平铺方法 subagent-service.ts:1786，非 queries 聚合面成员），stub 须同构挂载。
    getCollectSyncDefault: m.getCollectSyncDefault,
    queries: {
      findRecord: m.findRecord,
      lookupRecordAnyState: m.lookupRecordAnyState,
      collectRecords: m.collectRecords,
      getFullRecord: m.getFullRecord,
      onChange: vi.fn(() => () => {}),
    },
    chatActions: {
      getRecordForAction: m.getRecordForAction,
      closeSubagent: m.closeSubagent,
      deliverChatMessage: m.deliverChatMessage,
    },
  } as unknown as SubagentService;
}

/** 实测 reject 输出的捕获形态：{ errorName, message }。 */
async function errOf(fn: () => unknown): Promise<{ errorName: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    return {
      errorName: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  throw new Error("expected handler rejection, got resolve");
}

const CTX_MODEL = { id: "m1", name: "Model One", provider: "prov", reasoning: true };

// ============================================================
// 终态映射 / list 投影
// ============================================================
describe("⛔4 mapExternalState / recordToListItem（终态映射，快照 = pi-sw 实测）", () => {
  it("ExecutionStatus → ExternalState 两态映射", () => {
    expect(mapExternalState("running")).toBe("active");
    expect(mapExternalState("closed")).toBe("ended");
  });

  it("running record → item（displayAgentName 短名 + duration 实时 + resumable）", () => {
    expect(
      recordToListItem(
        makeRec({
          id: "bg-r1",
          agent: "/home/u/agents/reader.md",
          slug: "read-doc",
          status: "running",
          startedAt: 1000,
          endedAt: undefined,
          totalTokens: 42,
          sessionFile: "sess-1.jsonl",
          parentRecordId: "bg-0",
          resumable: true,
        }),
      ),
    ).toEqual({
      subagentId: "bg-r1",
      agent: "reader",
      slug: "read-doc",
      state: "active",
      status: "running",
      mode: "background",
      duration: 1788189208, // floor((FROZEN_NOW - 1000) / 1000)，与探针首跑实值一致
      model: "prov/m1",
      totalTokens: 42,
      sessionFile: "sess-1.jsonl",
      parent: "bg-0",
      resumable: true,
    });
  });

  it("closed record：outcome 一等直读 + duration = (endedAt - startedAt)/1000", () => {
    expect(
      recordToListItem(
        makeRec({
          id: "bg-c1",
          status: "closed",
          closedReason: "gc",
          outcome: "completed",
          startedAt: 1000,
          endedAt: 9000,
          resumable: false,
        }),
      ),
    ).toEqual({
      subagentId: "bg-c1",
      agent: "reader",
      slug: "src-slug",
      state: "ended",
      status: "closed",
      mode: "background",
      duration: 8,
      model: "prov/m1",
      totalTokens: 42,
      sessionFile: "sess-1.jsonl",
      parent: undefined,
      resumable: false,
      outcome: "completed",
    });
  });

  it("closed 存量（无 outcome 字段）→ deriveOutcome 兜底派生四形态", () => {
    const base = { id: "bg-c2", status: "closed" as const, startedAt: 1000, endedAt: 3000 };
    // gc + 无 error → completed
    expect(recordToListItem(makeRec({ ...base, closedReason: "gc" })).outcome).toBe("completed");
    // cancelled → cancelled
    expect(
      recordToListItem(makeRec({ ...base, id: "bg-c3", closedReason: "cancelled" })).outcome,
    ).toBe("cancelled");
    // gc + error → failed
    expect(
      recordToListItem(makeRec({ ...base, id: "bg-c4", closedReason: "gc", error: "boom" })).outcome,
    ).toBe("failed");
    // disconnected + 无 error → completed（派生语义，非 cancelled——快照实测）
    expect(
      recordToListItem(makeRec({ ...base, id: "bg-c5", closedReason: "disconnected" })).outcome,
    ).toBe("completed");
  });
});

// ============================================================
// startHandler
// ============================================================
describe("⛔4 startHandler（校验 + 启动，快照 = pi-sw 实测）", () => {
  it("缺 input / task 空白 / slug 缺失或空白 / slug 超长 → 逐字错误文案", async () => {
    expect(await errOf(() => startHandler(makeService(), undefined, undefined))).toEqual({
      errorName: "Error",
      message:
        "action:'start' requires task and slug (top-level fields). " +
        'Correct: {"action":"start","task":"<your task>","slug":"<kebab-case>"}',
    });
    expect(await errOf(() => startHandler(makeService(), { task: "   ", slug: "x" }, undefined))).toEqual({
      errorName: "Error",
      message:
        "task is required for action:'start' (top-level field, must not be whitespace-only). " +
        'Correct: {"action":"start","task":"...","slug":"..."}',
    });
    expect(await errOf(() => startHandler(makeService(), { task: "ok" }, undefined))).toEqual({
      errorName: "Error",
      message:
        "slug is required for action:'start' (top-level field, must not be whitespace-only). " +
        'Correct: {"action":"start","task":"...","slug":"<kebab-case>"}',
    });
    expect(await errOf(() => startHandler(makeService(), { task: "ok", slug: "   " }, undefined))).toEqual({
      errorName: "Error",
      message:
        "slug is required for action:'start' (top-level field, must not be whitespace-only). " +
        'Correct: {"action":"start","task":"...","slug":"<kebab-case>"}',
    });
    expect(
      await errOf(() => startHandler(makeService(), { task: "ok", slug: "a".repeat(36) }, undefined)),
    ).toEqual({
      errorName: "Error",
      message:
        'slug must be ≤35 chars (got 36). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".',
    });
  });

  it("正常启动 → 领域对象全字段 + execute 参数（task/slug trim、拍平透传、ctxModel/signal）", async () => {
    const execute = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
      mode: "background",
      subagentId: "bg-9-abc",
      sessionFile: "sess-9.jsonl",
      details: makeDetails({ status: "running", slug: "long-running", model: "prov/resolved" }),
    }));
    const signal = new AbortController().signal;
    const r = await startHandler(
      makeService({ execute }),
      {
        task: "  long task  ",
        slug: "long-running",
        agent: "/x/agent.md",
        model: "prov/m2",
        thinkingLevel: "high",
        skillPath: "/s/SKILL.md",
        appendSystemPrompt: ["a"],
        schema: { type: "object" },
        maxTurns: 5,
        graceTurns: 1,
        fork: false,
        worktree: false,
        cwd: "/w",
        conversation: true,
        idleTimeoutMs: 1000,
        engine: "pi",
      },
      signal,
      CTX_MODEL,
    );
    expect(r).toEqual({
      kind: "bg",
      subagentId: "bg-9-abc",
      sessionFile: "sess-9.jsonl",
      slug: "long-running",
      model: "prov/resolved",
      response: {
        status: "running",
        mode: "background",
        message: "detached, will notify on completion (auto-injected message, do not poll)",
        notifyContract: "ledger+at-least-once",
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({
      task: "long task", // trim 生效
      slug: "long-running",
      agent: "/x/agent.md",
      model: "prov/m2",
      thinkingLevel: "high",
      skillPath: "/s/SKILL.md",
      appendSystemPrompt: ["a"],
      schema: { type: "object" },
      maxTurns: 5,
      graceTurns: 1,
      fork: false,
      worktree: false,
      cwd: "/w",
      conversation: true,
      idleTimeoutMs: 1000,
      engine: "pi",
      ctxModel: CTX_MODEL,
      signal,
    });
    // 常量与响应同源（宿主 adapter 复用面）
    expect(BG_MESSAGE).toBe("detached, will notify on completion (auto-injected message, do not poll)");
    expect(NOTIFY_CONTRACT).toBe("ledger+at-least-once");
  });
});

// ============================================================
// listHandler
// ============================================================
describe("⛔4 listHandler（limit 夹紧 + 过滤 + enrich，快照 = pi-sw 实测）", () => {
  it("includeFinished:true → collectRecords(20,'all') + getFullRecord 补全投影", () => {
    const collectRecords = vi.fn(() => [
      makeRec({ id: "bg-1", slug: "one" }),
      makeRec({ id: "bg-2", slug: "two", status: "closed", endedAt: 5000 }),
    ]);
    const getFullRecord = vi.fn((id: string) =>
      id === "bg-1" ? makeRec({ id: "bg-1", slug: "one", model: "prov/full", totalTokens: 77 }) : undefined,
    );
    const r = listHandler(makeService({ collectRecords, getFullRecord }), { includeFinished: true });
    expect(r).toEqual({
      response: {
        running: 1,
        items: [
          {
            subagentId: "bg-1",
            agent: "reader",
            slug: "one",
            state: "active",
            status: "running",
            mode: "background",
            duration: 1788189208,
            model: "prov/full",
            totalTokens: 77,
            sessionFile: "sess-1.jsonl",
            parent: undefined,
            resumable: true,
          },
          {
            subagentId: "bg-2",
            agent: "reader",
            slug: "two",
            state: "ended",
            status: "closed",
            mode: "background",
            duration: 4,
            model: "prov/m1",
            totalTokens: 42,
            sessionFile: "sess-1.jsonl",
            parent: undefined,
            resumable: false,
            outcome: "completed",
          },
        ],
      },
    });
    expect(collectRecords).toHaveBeenCalledWith(20, "all", false);
    // light record（getFullRecord undefined）回退原样投影
    expect(getFullRecord).toHaveBeenCalledWith("bg-2");
  });

  it("缺省 → collectRecords(20,'running')", () => {
    const collectRecords = vi.fn(() => [] as SubagentRecord[]);
    listHandler(makeService({ collectRecords }), undefined);
    expect(collectRecords).toHaveBeenCalledWith(20, "running", false);
  });

  it("limit 夹紧：500 → 100 上限；0 → 1 下限（非默认值）", () => {
    const high = vi.fn(() => [] as SubagentRecord[]);
    listHandler(makeService({ collectRecords: high }), { includeFinished: true, limit: 500 });
    expect(high).toHaveBeenCalledWith(100, "all", false);

    const low = vi.fn(() => [] as SubagentRecord[]);
    listHandler(makeService({ collectRecords: low }), { includeFinished: true, limit: 0 });
    expect(low).toHaveBeenCalledWith(1, "all", false);

    expect(DEFAULT_LIST_LIMIT).toBe(20);
    expect(MAX_LIST_LIMIT).toBe(100);
  });
});

// ============================================================
// cancelHandler
// ============================================================
describe("⛔4 cancelHandler（守卫 + 归属判定 + CAS 失败映射，快照 = pi-sw 实测）", () => {
  it("id 空白 → 逐字错误文案", async () => {
    expect(await errOf(() => cancelHandler(makeService(), { subagentId: "   " }))).toEqual({
      errorName: "Error",
      message: "cancelParam.subagentId is required for action:'cancel'",
    });
  });

  it("findRecord 无 + 全树无 → not found 文案", async () => {
    expect(await errOf(() => cancelHandler(makeService(), { subagentId: "bg-x" }))).toEqual({
      errorName: "Error",
      message:
        'No subagent record with id "bg-x". It may have finished — use action:\'list\' with includeFinished:true to verify (add includeWorkflow:true to also see workflow-dispatched subagents).',
    });
  });

  it("归属判定：findRecord 无但全树列出同 id running（异进程）→ owned-by-another-process 文案", async () => {
    expect(
      await errOf(() =>
        cancelHandler(
          makeService({ collectRecords: vi.fn(() => [makeRec({ id: "bg-9", status: "running" })]) }),
          { subagentId: "bg-9" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        'Subagent record "bg-9" is running but owned by another process in the tree ' +
        "(it was spawned by a different subagent process) — this process cannot cancel it; " +
        "cancel only works for subagents spawned by the current process.",
    });
  });

  it("归属判定边界：全树列出但已终态 → 回落 not found 文案（非 owned-by）", async () => {
    expect(
      await errOf(() =>
        cancelHandler(
          makeService({ collectRecords: vi.fn(() => [makeRec({ id: "bg-9", status: "closed", endedAt: 5000 })]) }),
          { subagentId: "bg-9" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        'No subagent record with id "bg-9". It may have finished — use action:\'list\' with includeFinished:true to verify (add includeWorkflow:true to also see workflow-dispatched subagents).',
    });
  });

  it("mode 非 background → unsupported mode 文案（守卫分支完整性）", async () => {
    expect(
      await errOf(() =>
        cancelHandler(
          // "sync" 是历史已裁撤值（ExecutionMode 现仅 "background"）——经 as never
          // 注入非法值专测守卫分支，运行时守卫按 !== "background" 拦截
          makeService({ findRecord: vi.fn(() => makeRec({ id: "bg-1", mode: "sync" as never })) }),
          { subagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message: "Cannot cancel subagent bg-1 (unsupported mode: sync)",
    });
  });

  it("chatMode → close(force:true) 别名路径 + cancel 响应", async () => {
    const closeSubagent = vi.fn(async () => {});
    const chatRecord = makeExecRecord({ id: "bg-1", chatMode: true });
    const r = await cancelHandler(
      makeService({
        findRecord: vi.fn(() => makeRec({ id: "bg-1", chatMode: true })),
        getRecordForAction: vi.fn(() => chatRecord),
        closeSubagent,
      }),
      { subagentId: "bg-1" },
    );
    expect(r).toEqual({ subagentId: "bg-1", response: { cancelled: true } });
    expect(closeSubagent).toHaveBeenCalledWith(chatRecord, true);
  });

  it("CAS 失败 + re-query evicted → 'unknown (evicted from memory)' 文案", async () => {
    let calls = 0;
    expect(
      await errOf(() =>
        cancelHandler(
          makeService({
            findRecord: vi.fn(() => {
              calls += 1;
              return calls === 1 ? makeRec({ id: "bg-1", chatMode: undefined }) : undefined;
            }),
            cancel: vi.fn(() => false),
          }),
          { subagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message: "Subagent bg-1 could not be cancelled (it likely just finished; status: unknown (evicted from memory))",
    });
  });

  it("CAS 失败 + re-query 有记录 → 当前真实 status 进文案（closed）", async () => {
    let calls = 0;
    expect(
      await errOf(() =>
        cancelHandler(
          makeService({
            findRecord: vi.fn(() => {
              calls += 1;
              return calls === 1
                ? makeRec({ id: "bg-1", chatMode: undefined })
                : makeRec({ id: "bg-1", status: "closed", endedAt: 5000 });
            }),
            cancel: vi.fn(() => false),
          }),
          { subagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message: "Subagent bg-1 could not be cancelled (it likely just finished; status: closed)",
    });
  });

  it("cancel 成功 → cancelled:true", async () => {
    const r = await cancelHandler(
      makeService({
        findRecord: vi.fn(() => makeRec({ id: "bg-1", chatMode: undefined })),
        cancel: vi.fn(() => true),
      }),
      { subagentId: "bg-1" },
    );
    expect(r).toEqual({ subagentId: "bg-1", response: { cancelled: true } });
  });
});

// ============================================================
// messageHandler + endedMessageGuard（归属判定 + 文案分流）
// ============================================================
describe("⛔4 messageHandler（守卫 + upgrade + 投递，快照 = pi-sw 实测）", () => {
  it("id/text 空白 → 逐字错误文案", async () => {
    expect(await errOf(() => messageHandler(makeService(), { subagentId: "  ", text: "hi" }))).toEqual({
      errorName: "Error",
      message: "messageParam.subagentId is required for action:'message'",
    });
    expect(await errOf(() => messageHandler(makeService(), { subagentId: "bg-1", text: "   " }))).toEqual({
      errorName: "Error",
      message:
        "messageParam.text is required for action:'message' (must not be whitespace-only). " +
        'Correct: {"action":"message","messageParam":{"subagentId":"sa-...","text":"your follow-up"}}',
    });
  });

  it("chatMode record → deliverChatMessage(text trim) + 领域对象（[H1 U6] interrupt 退役）", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const chatRecord = makeExecRecord({ id: "bg-1", chatMode: true, slug: "src-slug" });
    const r = await messageHandler(
      makeService({ getRecordForAction: vi.fn(() => chatRecord), deliverChatMessage }),
      { subagentId: "bg-1", text: "  go on  ", interrupt: true },
    );
    expect(r).toEqual({
      kind: "message",
      subagentId: "bg-1",
      slug: "src-slug",
      response: { delivered: true },
    });
    expect(deliverChatMessage).toHaveBeenCalledWith(chatRecord, "go on");
  });

  it("one-shot upgrade：非 chatMode running record 收 message → 置位 chatMode 后投递", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const upgradeRec = makeExecRecord({ id: "bg-1", chatMode: false, status: "running" });
    await messageHandler(
      makeService({ getRecordForAction: vi.fn(() => upgradeRec), deliverChatMessage }),
      { subagentId: "bg-1", text: "hi" },
    );
    expect(upgradeRec.chatMode).toBe(true);
    expect(deliverChatMessage).toHaveBeenCalledWith(upgradeRec, "hi");
  });

  it("[H1 U2 / D5 双写点①] one-shot upgrade gate 拒绝：unsupported 引擎（canUpgradeToConversation=false）→ 硬拒 + fork/重派指引，chatMode 不置位", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const zcodeRec = makeExecRecord({ id: "bg-z", chatMode: false, status: "running", engine: "zcode" });
    const err = await errOf(() =>
      messageHandler(
        makeService({
          getRecordForAction: vi.fn(() => zcodeRec),
          deliverChatMessage,
          canUpgradeToConversation: vi.fn(() => false),
        }),
        { subagentId: "bg-z", text: "hi" },
      ),
    );
    // 文案 = engineConversationUpgradeUnsupportedError 单源（错误码前缀 + 拒绝依据）
    expect(err.errorName).toBe("EngineError");
    expect(err.message).toContain("cannot be upgraded to a resumable conversation");
    expect(zcodeRec.chatMode).toBe(false);
    expect(deliverChatMessage).not.toHaveBeenCalled();
  });

  it("getRecordForAction 拒绝 + 无终态快照 → 原错误透传（文案最准原则）", async () => {
    expect(
      await errOf(() =>
        messageHandler(
          makeService({
            getRecordForAction: vi.fn(() => {
              throw new Error('No subagent record with id "bg-404" (it may have finished).');
            }),
            lookupRecordAnyState: vi.fn(() => undefined),
          }),
          { subagentId: "bg-404", text: "hi" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message: 'No subagent record with id "bg-404" (it may have finished).',
    });
  });

  it("ResurrectDeniedError → 原样透传（实例身份保持，不被 fork-from 指引改写）", async () => {
    const original = new ResurrectDeniedError("subagent bg-1 cannot be transparently resumed (worktree binding lost)");
    let caught: unknown;
    try {
      await messageHandler(
        makeService({
          getRecordForAction: vi.fn(() => {
            throw original;
          }),
          lookupRecordAnyState: vi.fn(() => makeRec({ id: "bg-1", status: "closed", closedReason: "disconnected" })),
        }),
        { subagentId: "bg-1", text: "hi" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect(caught instanceof ResurrectDeniedError).toBe(true);
  });

  it("endedMessageGuard 分流：closed+user-close / cancelled → 主动关闭文案", async () => {
    const mkSvc = (closedReason: "user-close" | "cancelled") =>
      makeService({
        getRecordForAction: vi.fn(() => {
          throw new Error("not found or not owned");
        }),
        lookupRecordAnyState: vi.fn(() =>
          makeRec({ id: "bg-1", status: "closed", closedReason, sessionFile: "sess-1.jsonl" }),
        ),
      });
    expect(await errOf(() => messageHandler(mkSvc("user-close"), { subagentId: "bg-1", text: "hi" }))).toEqual({
      errorName: "Error",
      message:
        "subagent bg-1 was deliberately closed by user (closedReason: user-close) — " +
        "it cannot be messaged or resumed; nothing can reattach to it. " +
        "Recovery: start a new subagent (action:'start'); use action:'list' with includeFinished:true to review its final output (add includeWorkflow:true to also see workflow-dispatched subagents).",
    });
    expect(await errOf(() => messageHandler(mkSvc("cancelled"), { subagentId: "bg-1", text: "hi" }))).toEqual({
      errorName: "Error",
      message:
        "subagent bg-1 was deliberately closed by user (closedReason: cancelled) — " +
        "it cannot be messaged or resumed; nothing can reattach to it. " +
        "Recovery: start a new subagent (action:'start'); use action:'list' with includeFinished:true to review its final output (add includeWorkflow:true to also see workflow-dispatched subagents).",
    });
  });

  it("endedMessageGuard 分流：closed 断联类 → reconnectable 文案（describeClosedContext 逐字）", async () => {
    const mkSvc = (closedReason: ExecutionRecord["closedReason"], sessionFile?: string) =>
      makeService({
        getRecordForAction: vi.fn(() => {
          throw new Error("not found or not owned");
        }),
        lookupRecordAnyState: vi.fn(() => makeRec({ id: "bg-1", status: "closed", closedReason, sessionFile })),
      });
    const expectedTail =
      'Recovery: resume from that history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"bg-1"}}, ' +
      "or read key points directly from the session file.";
    // parent-shutdown 专属短语
    expect((await errOf(() => messageHandler(mkSvc("parent-shutdown", "sess-1.jsonl"), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 is ended but reconnectable (closedReason: parent-shutdown" +
        " — it was disconnected when the previous parent session exited" +
        "). Its conversation history is intact at sess-1.jsonl. " + expectedTail,
    );
    // disconnected 专属短语
    expect((await errOf(() => messageHandler(mkSvc("disconnected", "sess-1.jsonl"), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 is ended but reconnectable (closedReason: disconnected" +
        " — it ended in a previous session (exact cause unknown)" +
        "). Its conversation history is intact at sess-1.jsonl. " + expectedTail,
    );
    // 无 closedReason → "unknown" + 空短语；无 sessionFile → "(session file unavailable)"
    expect((await errOf(() => messageHandler(mkSvc(undefined, undefined), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 is ended but reconnectable (closedReason: unknown). " +
        "Its conversation history is intact at (session file unavailable). " + expectedTail,
    );
  });

  it("endedMessageGuard 分流：running 异归属（不同 session 树）→ fork-from branch 指引", async () => {
    const mkSvc = (sessionFile?: string) =>
      makeService({
        getRecordForAction: vi.fn(() => {
          throw new Error("not found or not owned");
        }),
        lookupRecordAnyState: vi.fn(() =>
          makeRec({ id: "bg-1", status: "running", rootSessionId: "root-B", sessionFile }),
        ),
      });
    // 有 sessionFile → 追加 source session
    expect((await errOf(() => messageHandler(mkSvc("sess-1.jsonl"), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 is alive but belongs to a different session tree than this one. You cannot message it from here. " +
        'Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"bg-1"}}' +
        " (source session: sess-1.jsonl); otherwise start a new subagent.",
    );
    // 无 sessionFile → 无追加
    expect((await errOf(() => messageHandler(mkSvc(undefined), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 is alive but belongs to a different session tree than this one. You cannot message it from here. " +
        'Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"bg-1"}}' +
        "; otherwise start a new subagent.",
    );
  });

  it("endedMessageGuard 直测：非 Error 原始值 + 无快照 → 包装为 Error(String(original))", () => {
    const e = endedMessageGuard(makeService({ lookupRecordAnyState: vi.fn(() => undefined) }), "bg-1", "plain string failure");
    expect(e.name).toBe("Error");
    expect(e.message).toBe("plain string failure");
  });
});

// ============================================================
// closeHandler
// ============================================================
describe("⛔4 closeHandler（force 语义透传，快照 = pi-sw 实测）", () => {
  it("id 空白 → 逐字错误文案", async () => {
    expect(await errOf(() => closeHandler(makeService(), { subagentId: "" }))).toEqual({
      errorName: "Error",
      message: "closeParam.subagentId is required for action:'close'",
    });
  });

  it("force:true / 缺省 false → closeSubagent(record, force) 透传 + closed:true", async () => {
    const record = makeExecRecord({ id: "bg-1" });
    const closeForce = vi.fn(async () => {});
    const r1 = await closeHandler(
      makeService({ getRecordForAction: vi.fn(() => record), closeSubagent: closeForce }),
      { subagentId: "bg-1", force: true },
    );
    expect(r1).toEqual({ kind: "close", subagentId: "bg-1", response: { closed: true } });
    const closeGrace = vi.fn(async () => {});
    const r2 = await closeHandler(
      makeService({ getRecordForAction: vi.fn(() => record), closeSubagent: closeGrace }),
      { subagentId: "bg-1" },
    );
    expect(r2).toEqual({ kind: "close", subagentId: "bg-1", response: { closed: true } });
    expect(closeForce).toHaveBeenCalledWith(record, true);
    expect(closeGrace).toHaveBeenCalledWith(record, false);
  });
});

// ============================================================
// forkFromHandler（守卫链 1–6）
// ============================================================
describe("⛔4 forkFromHandler（守卫链 + slug 派生 + prompt 包装，快照 = pi-sw 实测）", () => {
  // [U4b/E2] 双宿主探针 fixture 目录：守卫 3 现查探针读真实 .alive 侧车（不再读
  // rec.externalInstance 缓存字段），用临时目录落盘驱动，自建自删。
  let forkDir: string;
  beforeEach(() => {
    forkDir = fs.mkdtempSync(path.join(os.tmpdir(), "actions-core-fork-"));
  });
  afterEach(() => {
    fs.rmSync(forkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeForkService(source: SubagentRecord | undefined, execute = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
    mode: "background",
    subagentId: "bg-new-1",
    sessionFile: "sess-new.jsonl",
    details: makeDetails(),
  })), inMemory?: SubagentRecord) {
    return makeService({
      findRecord: vi.fn(() => inMemory),
      lookupRecordAnyState: vi.fn(() => source),
      execute,
    });
  }

  it("sourceSubagentId 空白 → 逐字错误文案", async () => {
    expect(await errOf(() => forkFromHandler(makeService(), { sourceSubagentId: " " }))).toEqual({
      errorName: "Error",
      message: "forkFromParam.sourceSubagentId is required for action:'fork-from'",
    });
  });

  it("守卫 1：本进程内存 running → still-active 文案", async () => {
    expect(
      await errOf(() =>
        forkFromHandler(makeForkService(undefined, undefined, makeRec({ id: "bg-1" })), { sourceSubagentId: "bg-1" }),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        "subagent bg-1 is still active in this process — use action:'message' to continue it directly. " +
        "If you want a parallel branch from its history, close it first (action:'close'), then fork-from.",
    });
  });

  it("守卫 2：全态查无 → garbage-collected 文案", async () => {
    expect(await errOf(() => forkFromHandler(makeForkService(undefined), { sourceSubagentId: "bg-404" }))).toEqual({
      errorName: "Error",
      message:
        'No subagent record with id "bg-404". It may never have existed or been garbage-collected — ' +
        "use action:'list' with includeFinished:true to verify the id (add includeWorkflow:true to also see workflow-dispatched subagents).",
    });
  });

  it("守卫 3：异进程活实例（.alive 恒活外部 pid）→ another-process 文案（双宿主形态）", async () => {
    // [U4b/E2] 双宿主形态：宿主 A 持有中的 record（.alive = A 进程的活 pid 声明）被
    // 宿主 B 冷查重建，B fork-from 该源时守卫 3 现查探针命中 → 拒绝（源仍在异进程
    // 运行，接续会读到半截历史）。[U1/A4] self-pid 排除后「异进程」不能用本测试进程
    // pid 模拟，改恒活外部 pid 1（launchd/init：kill(1,0) → EPERM → isProcessAlive 判活）。
    const sessionFile = path.join(forkDir, "sess-foreign.jsonl");
    writeAliveMarker(sessionFile, { pid: FOREIGN_LIVE_PID, id: "bg-1", startedAt: 5 });
    expect(
      await errOf(() =>
        forkFromHandler(
          makeForkService(makeRec({ id: "bg-1", status: "running", sessionFile })),
          { sourceSubagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        "subagent bg-1 is still running in another process (alive pid marker present). " +
        "Recovery: wait until it finishes, or operate it in its own session; then retry fork-from.",
    });
  });

  it("守卫 3 不误伤：running 快照（无活 pid，跨重启重建）放行 → 正常 fork", async () => {
    const r = await forkFromHandler(
      makeForkService(makeRec({ id: "bg-1", status: "running", slug: "rebuilt", sessionFile: "sess-1.jsonl" })),
      { sourceSubagentId: "bg-1" },
    );
    expect(r).toEqual({
      kind: "fork-from",
      subagentId: "bg-new-1",
      sourceSessionFile: "sess-1.jsonl",
      response: { newSubagentId: "bg-new-1", sourceSessionFile: "sess-1.jsonl" },
    });
  });

  it("守卫 4：cancelled / user-close → deliberately-closed 文案（guard 与 message 一致性）", async () => {
    for (const closedReason of ["cancelled", "user-close"] as const) {
      expect(
        await errOf(() =>
          forkFromHandler(
            makeForkService(makeRec({ id: "bg-1", status: "closed", closedReason, sessionFile: "sess-1.jsonl" })),
            { sourceSubagentId: "bg-1" },
          ),
        ),
      ).toEqual({
        errorName: "Error",
        message:
          `subagent bg-1 was deliberately closed by user (closedReason: ${closedReason}) — ` +
          "deliberately-closed records cannot be resumed or branched from; nothing can reattach to them. " +
          "Recovery: start a fresh subagent (action:'start'); use action:'list' with includeFinished:true to review its final output (add includeWorkflow:true to also see workflow-dispatched subagents).",
      });
    }
  });

  it("守卫 5：worktree 记录 → isolation-lost 文案（含 sessionFile 路径插值）", async () => {
    expect(
      await errOf(() =>
        forkFromHandler(
          makeForkService(makeRec({ id: "bg-1", status: "closed", closedReason: "gc", worktree: true, sessionFile: "sess-1.jsonl" })),
          { sourceSubagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        "subagent bg-1 was created with worktree isolation; that binding was lost when its parent process ended. " +
        "Resuming from its history would run outside the original worktree isolation. " +
        "Recovery: start a new subagent with action:'start' and carry over key findings manually " +
        "(read sess-1.jsonl if needed).",
    });
  });

  it("守卫 6：无子 session 文件 → no-child-session 文案", async () => {
    expect(
      await errOf(() =>
        forkFromHandler(
          makeForkService(makeRec({ id: "bg-1", status: "closed", closedReason: "gc", sessionFile: undefined })),
          { sourceSubagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        "subagent bg-1 has no child session file to inherit from (it never started successfully). " +
        "Recovery: start a fresh subagent (action:'start') describing the task again.",
    });
  });

  it("正常：显式 prompt → wrapForkFromPrompt 包装 + slug 派生 'src-slug-resumed' + execute 参数", async () => {
    const execute = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
      mode: "background",
      subagentId: "bg-new-1",
      sessionFile: "sess-new.jsonl",
      details: makeDetails(),
    }));
    const r = await forkFromHandler(
      makeForkService(
        makeRec({ id: "bg-1", slug: "src-slug", agent: "/home/u/agents/reader.md", sessionFile: "sess-1.jsonl" }),
        execute,
      ),
      { sourceSubagentId: "bg-1", prompt: "  continue the work  " },
    );
    expect(r).toEqual({
      kind: "fork-from",
      subagentId: "bg-new-1",
      sourceSessionFile: "sess-1.jsonl",
      response: { newSubagentId: "bg-new-1", sourceSessionFile: "sess-1.jsonl" },
    });
    expect(execute).toHaveBeenCalledWith({
      task:
        "continue the work\n\n(You are continuing a previous subagent's inherited conversation via --fork. " +
        "Reconstruct state from that history first — what was done, decided, and remains — then execute the instruction above.)",
      slug: "src-slug-resumed",
      forkFromSessionFile: "sess-1.jsonl",
    });
  });

  it("无 prompt → FORK_FROM_DEFAULT_PROMPT 逐字", async () => {
    const execute = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
      mode: "background",
      subagentId: "bg-new-2",
      sessionFile: "sess-new-2.jsonl",
      details: makeDetails(),
    }));
    await forkFromHandler(
      makeForkService(makeRec({ id: "bg-1", slug: "src-slug", sessionFile: "sess-1.jsonl" }), execute),
      { sourceSubagentId: "bg-1", prompt: undefined },
    );
    expect(execute).toHaveBeenCalledWith({
      task: FORK_FROM_DEFAULT_PROMPT,
      slug: "src-slug-resumed",
      forkFromSessionFile: "sess-1.jsonl",
    });
    expect(FORK_FROM_DEFAULT_PROMPT).toBe(
      "You are taking over work from a previous subagent whose full conversation history you inherited (--fork). " +
      "First reconstruct state from that history: list what was already done, decided, and left unfinished (a few bullet lines). " +
      "Then continue the remaining work to completion.",
    );
    expect(wrapForkFromPrompt("p")).toBe(
      "p\n\n(You are continuing a previous subagent's inherited conversation via --fork. " +
      "Reconstruct state from that history first — what was done, decided, and remains — then execute the instruction above.)",
    );
  });

  it("slug 派生：34 字符源 slug 截 27 + '-resumed'；fallback 链 slug||agent||'resumed'", async () => {
    const execute34 = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
      mode: "background",
      subagentId: "bg-new-3",
      sessionFile: undefined,
      details: makeDetails(),
    }));
    await forkFromHandler(
      makeForkService(makeRec({ id: "bg-1", slug: "s".repeat(34), sessionFile: "sess-1.jsonl" }), execute34),
      { sourceSubagentId: "bg-1", prompt: "p" },
    );
    expect(execute34.mock.calls[0]![0].slug).toBe(`${"s".repeat(27)}-resumed`);

    const executeAgent = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
      mode: "background",
      subagentId: "bg-new-4",
      sessionFile: undefined,
      details: makeDetails(),
    }));
    await forkFromHandler(
      makeForkService(
        makeRec({ id: "bg-1", slug: "", agent: "/home/u/agents/helper.md", sessionFile: "sess-1.jsonl" }),
        executeAgent,
      ),
      { sourceSubagentId: "bg-1", prompt: "p" },
    );
    expect(executeAgent.mock.calls[0]![0].slug).toBe("/home/u/agents/helper.md-resumed");

    const executeResumed = vi.fn(async (_opts: { task: string; slug?: string; agent?: string }): Promise<ExecutionHandle> => ({
      mode: "background",
      subagentId: "bg-new-5",
      sessionFile: undefined,
      details: makeDetails(),
    }));
    await forkFromHandler(
      makeForkService(makeRec({ id: "bg-1", slug: "", agent: "", sessionFile: "sess-1.jsonl" }), executeResumed),
      { sourceSubagentId: "bg-1", prompt: "p" },
    );
    expect(executeResumed.mock.calls[0]![0].slug).toBe("resumed-resumed");
  });
});
