// src/execution/__tests__/subagent-actions-core.test.ts
//
// ⛔4 行为快照等值测试（sink 设计 docs/design/subagent-core-sink-design.md（已删，git 可追溯） §5.4 ⛔4 /
// impl-plan u-core-actions）：六 handler（start/list/cancel/message/close/fork-from）
// 的校验、检查链、归属判定、终态映射，迁移前后行为逐项一致。
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
// 使快照期望值与实测值逐字可比。fake timers 已从文件级下沉进本段各 describe
//（round 5-g 合并：其余来源段需要真实 timers 跑 vi.waitFor/setTimeout）。
//
// 整合来源（round 5-g 测试提速，主被测对象 = subagent 动作链 actions-core + 冷查链）：
//   cold-lookup.test.ts（coldLookupForAction 依赖注入直测）/
//   get-record-for-action-restart.test.ts（getRecordForAction 跨重启重建集成）/
//   permanent-session-universal-resume.test.ts（messageHandler/forkFrom 万物可续矩阵）。
// 否决未并：subagent-service-multiproc-guard（alive-store 整模块 mock 与 alive-store
// 本体测试自噬）/ record-types（域词表本体）/ alive-store（persistence 本体异 subject）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// core logger 桩（提升自 cold-lookup / get-record-for-action-restart / universal-resume
// 三源同构 hoisted 去重，取 universal-resume 的 4 键超集——cold-lookup 断言 warn 通道）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

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
} from "../assembly/subagent-actions-core.ts";
import {
  COLD_LOOKUP_SCAN_LIMIT,
  coldLookupForAction,
  isAnchorResolvable,
  transcriptAnchorOf,
  type ColdLookupDeps,
} from "../assembly/cold-lookup.ts";
import { buildReopenSummaryPrompt } from "../assembly/conversation-continuation.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import type { ExecutionHandle, SubagentRecord, SubagentToolDetails } from "../assembly/types.ts";
import { clearEngines } from "../engine/registry.ts";
import { findForeignLiveInstance, readAliveMarker, writeAliveMarker } from "../persistence/alive-store.ts";
import { readRecordBinding } from "../persistence/state-marker.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { ResurrectDeniedError, type ClosedReason } from "../domain/record-types.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import { SubagentService } from "../subagent-service.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { seedTerminalRecordForSessionFile } from "./helpers/seed-terminal-record.ts";

// ── 时钟固定（duration 快照确定性，见文件头）──
const FROZEN_NOW = 1788189209000;

/** [U1/A4] 「异进程且存活」的确定性模拟 pid：1 号进程（launchd/init）必然存在且非
 *  本测试进程——kill(1, 0) 对普通用户返回 EPERM，isProcessAlive 按「存在但无权限」
 *  保守判活（self-pid 排除后不能再以本进程 pid 模拟异进程实例，同 cold-lookup.test.ts）。 */
const FOREIGN_LIVE_PID = 1;

/** 身份 env 名（与 subagent-service.ts 常量一致；各段 beforeEach/afterEach 清理防泄漏——
 *  测试进程可能继承 subagent env，会污染 rootCwd 编码目录与 sessionRootId 基线）。 */
const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

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
    ...over,
  } as SubagentRecord;
}

function makeService(over: Record<string, unknown> = {}): SubagentService {
  // 聚合范围形态对齐 subagent-service.ts D4：queries（读模型）与 chatActions（对话
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
    // [modeless 波1] messageHandler 的引擎轴资格判据读 service.engineSupportsConversation
    //（stub 缺省放行 = pi 默认引擎语义；拒绝情形专项见 conversation-continuation.test.ts）。
    engineSupportsConversation: vi.fn(() => true),
    ...over,
  };
  return {
    execute: m.execute,
    cancel: m.cancel,
    // [modeless 波1] messageHandler 引擎轴资格判据经平铺访问器（真实 service 为
    // 平铺方法，非 queries/chatActions 聚合范围成员），stub 须同构挂载。
    engineSupportsConversation: m.engineSupportsConversation,
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
// 终态映射 / list 派生视图
// ============================================================
describe("⛔4 mapExternalState / recordToListItem（终态映射，快照 = pi-sw 实测）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("ExecutionStatus → ExternalState 两态映射", () => {
    expect(mapExternalState("running")).toBe("active");
    expect(mapExternalState("idle")).toBe("idle");
  });

  it("running record → item（displayAgentName 短名 + duration 实时）", () => {
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
    });
  });

  it("closed record：outcome 一等直读 + duration = (endedAt - startedAt)/1000", () => {
    expect(
      recordToListItem(
        makeRec({
          id: "bg-c1",
          status: "idle",
          closedReason: "gc",
          outcome: "completed",
          startedAt: 1000,
          endedAt: 9000,
        }),
      ),
    ).toEqual({
      subagentId: "bg-c1",
      agent: "reader",
      slug: "src-slug",
      state: "idle",
      status: "idle",
      mode: "background",
      duration: 8,
      model: "prov/m1",
      totalTokens: 42,
      sessionFile: "sess-1.jsonl",
      parent: undefined,
      outcome: "completed",
    });
  });

  it("closed 存量（无 outcome 字段）→ deriveOutcome 兜底派生四形态", () => {
    const base = { id: "bg-c2", status: "idle" as const, startedAt: 1000, endedAt: 3000 };
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
    // parent-fork + 合成 error → failed（D6 显式取舍：父进程关闭未完成即失败，勿改 cancelled）
    expect(
      recordToListItem(
        makeRec({ ...base, id: "bg-c6", closedReason: "parent-fork", error: "closed due to parent-fork" }),
      ).outcome,
    ).toBe("failed");
  });
});

// ============================================================
// startHandler
// ============================================================
describe("⛔4 startHandler（校验 + 启动，快照 = pi-sw 实测）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
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
      idleTimeoutMs: 1000,
      engine: "pi",
      ctxModel: CTX_MODEL,
      signal,
    });
    // 常量与响应同源（宿主 adapter 复用范围）
    expect(BG_MESSAGE).toBe("detached, will notify on completion (auto-injected message, do not poll)");
    expect(NOTIFY_CONTRACT).toBe("ledger+at-least-once");
  });

  it("model 拒单向上传播：execute 抛裁决错误 → 原样穿越 handler（无受理响应产出，execute 不重试）", async () => {
    // 裁决发生在 service.execute 内部（IDENTITY 解析 → resolveModel），在 record 创建 /
    // runSpawn 之前——错误直接向上传播为 tool isError。resolveModel 层的拒单行为
    //（含双路径）由 model-ref.test.ts + model-resolver.test.ts 锁定；本用例锁定
    // handler 层传播语义：异常穿越 startHandler，不产出任何受理响应。
    const execute = vi.fn(async (): Promise<ExecutionHandle> => {
      throw new Error(
        'Model "prov/m1" (paramOverride) is not a registry entry. Did you mean one of these?\n  prov/M1',
      );
    });
    const err = await errOf(() =>
      startHandler(makeService({ execute }), { task: "t", slug: "s", model: "prov/m1" }, undefined),
    );
    expect(err.errorName).toBe("Error");
    expect(err.message).toContain("is not a registry entry");
    expect(err.message).toContain("Did you mean");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// listHandler
// ============================================================
describe("⛔4 listHandler（limit 夹紧 + 过滤 + enrich，快照 = pi-sw 实测）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("includeFinished:true → collectRecords(20,'all') + getFullRecord 补全派生视图", () => {
    const collectRecords = vi.fn(() => [
      makeRec({ id: "bg-1", slug: "one" }),
      makeRec({ id: "bg-2", slug: "two", status: "idle", closedReason: "gc", endedAt: 5000 }),
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
          },
          {
            subagentId: "bg-2",
            agent: "reader",
            slug: "two",
            state: "idle",
            status: "idle",
            mode: "background",
            duration: 4,
            model: "prov/m1",
            totalTokens: 42,
            sessionFile: "sess-1.jsonl",
            parent: undefined,
            outcome: "completed",
          },
        ],
      },
    });
    expect(collectRecords).toHaveBeenCalledWith(20, "all", false);
    // light record（getFullRecord undefined）回退原样派生视图
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

  it("空列表 → response 形态 { running: 0, items: [] }（LLM 消费方契约）", () => {
    expect(
      listHandler(makeService({ collectRecords: vi.fn(() => [] as SubagentRecord[]) }), { includeFinished: true }),
    ).toEqual({ response: { running: 0, items: [] } });
  });

  it("截断在 store 层：collectRecords 返回超 limit 条数 → listHandler 不自行截断（limit 仅透传）", () => {
    // 截断责任在 collectRecords（store 层），listHandler 只透传 limit + map。
    // mock 返回 3 条（模拟 store 未截断），验证 listHandler 不自行截断——全量透传。
    const records = [
      makeRec({ id: "r1", startedAt: 1 }),
      makeRec({ id: "r2", startedAt: 2 }),
      makeRec({ id: "r3", startedAt: 3 }),
    ];
    const collectRecords = vi.fn(() => records);
    const r = listHandler(makeService({ collectRecords }), { includeFinished: true, limit: 2 });
    expect(r.response.items).toHaveLength(3);
    expect(collectRecords).toHaveBeenCalledWith(2, "all", false);
  });

  it("顺序透传：items 保持 collectRecords 返回序（排序责任在 service 层，handler 不重排）", () => {
    // 故意按 startedAt 升序（与 desc 相反）
    const records = [makeRec({ id: "old", startedAt: 1 }), makeRec({ id: "new", startedAt: 5 })];
    const r = listHandler(makeService({ collectRecords: vi.fn(() => records) }), { includeFinished: true });
    expect(r.response.items.map((i) => i.subagentId)).toEqual(["old", "new"]);
  });

  it("includeWorkflow:true → collectRecords 第三参 true（workflow record 派生视图放行，排查通道）", () => {
    // 过滤责任在 store 层（collectRecords 第三参），listHandler 只透传——stub 按第三参
    // 分流返回，模拟 store 的 includeWorkflow 放行形态。
    const toolRecord = makeRec({ id: "tool-1", startedAt: 1 });
    const wfRecord = makeRec({ id: "wf-1", startedAt: 2, origin: "workflow", parentRunId: "run-1" });
    const collectRecords = vi.fn(() => [toolRecord, wfRecord]);
    const r = listHandler(makeService({ collectRecords }), { includeFinished: true, includeWorkflow: true });
    expect(collectRecords).toHaveBeenCalledWith(20, "all", true);
    expect(r.response.items.map((i) => i.subagentId)).toEqual(["tool-1", "wf-1"]);
  });
});

// ============================================================
// cancelHandler
// ============================================================
describe("⛔4 cancelHandler（检查 + 归属判定 + CAS 失败映射，快照 = pi-sw 实测）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
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
          makeService({ collectRecords: vi.fn(() => [makeRec({ id: "bg-9", status: "idle", endedAt: 5000 })]) }),
          { subagentId: "bg-9" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        'No subagent record with id "bg-9". It may have finished — use action:\'list\' with includeFinished:true to verify (add includeWorkflow:true to also see workflow-dispatched subagents).',
    });
  });

  it("mode 非 background → unsupported mode 文案（检查分支完整性）", async () => {
    expect(
      await errOf(() =>
        cancelHandler(
          // "sync" 是历史已裁撤值（ExecutionMode 现仅 "background"）——经 as never
          // 注入非法值专测检查分支，运行时检查按 !== "background" 拦截
          makeService({ findRecord: vi.fn(() => makeRec({ id: "bg-1", mode: "sync" as never })) }),
          { subagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message: "Cannot cancel subagent bg-1 (unsupported mode: sync)",
    });
  });

  it("[modeless 波1] cancel 语义统一：record（running）→ service.cancel 打断在途轮（无 close 别名归档）", async () => {
    const closeSubagent = vi.fn(async () => {});
    const r = await cancelHandler(
      makeService({
        findRecord: vi.fn(() => makeRec({ id: "bg-1" })),
        cancel: vi.fn(() => true),
        closeSubagent,
      }),
      { subagentId: "bg-1" },
    );
    expect(r).toEqual({ subagentId: "bg-1", response: { cancelled: true } });
    // cancel 不再是 close(force) 别名（归档归 close action；record 留 idle 可续聊）
    expect(closeSubagent).not.toHaveBeenCalled();
  });

  it("CAS 失败 + re-query evicted → 'unknown (evicted from memory)' 文案", async () => {
    let calls = 0;
    expect(
      await errOf(() =>
        cancelHandler(
          makeService({
            findRecord: vi.fn(() => {
              calls += 1;
              return calls === 1 ? makeRec({ id: "bg-1" }) : undefined;
            }),
            cancel: vi.fn(() => false),
          }),
          { subagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        "Subagent bg-1 could not be cancelled (it has no in-flight round; status: unknown (evicted from memory)). " +
        "For an idle record use action:'close' to archive it, or action:'message' to continue it.",
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
                ? makeRec({ id: "bg-1" })
                : makeRec({ id: "bg-1", status: "idle", endedAt: 5000 });
            }),
            cancel: vi.fn(() => false),
          }),
          { subagentId: "bg-1" },
        ),
      ),
    ).toEqual({
      errorName: "Error",
      message:
        "Subagent bg-1 could not be cancelled (it has no in-flight round; status: idle). " +
        "For an idle record use action:'close' to archive it, or action:'message' to continue it.",
    });
  });

  it("cancel 成功 → cancelled:true", async () => {
    const r = await cancelHandler(
      makeService({
        findRecord: vi.fn(() => makeRec({ id: "bg-1" })),
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
describe("⛔4 messageHandler（检查 + upgrade + 投递，快照 = pi-sw 实测）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
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

  it("record → deliverChatMessage(text trim) + 领域对象（[H1 U6] interrupt 退役；[modeless 波1] 全 record 同路）", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const chatRecord = makeExecRecord({ id: "bg-1", slug: "src-slug" });
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

  it("[modeless 波1·升级删除] running record 收 message → 直接投递（无 chatMode 置位）", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const rec = makeExecRecord({ id: "bg-1", status: "running" });
    await messageHandler(
      makeService({ getRecordForAction: vi.fn(() => rec), deliverChatMessage }),
      { subagentId: "bg-1", text: "hi" },
    );
    expect(deliverChatMessage).toHaveBeenCalledWith(rec, "hi");
  });

  it("[modeless 波1] message 资格引擎轴拒绝：unsupported 引擎（engineSupportsConversation=false）→ 硬拒 + fork/重派指引", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const zcodeRec = makeExecRecord({ id: "bg-z", status: "running", engine: "zcode" });
    const err = await errOf(() =>
      messageHandler(
        makeService({
          getRecordForAction: vi.fn(() => zcodeRec),
          deliverChatMessage,
          engineSupportsConversation: vi.fn(() => false),
        }),
        { subagentId: "bg-z", text: "hi" },
      ),
    );
    // 文案 = engineConversationMessageUnsupportedError 单源（错误码前缀 + 拒绝依据）
    expect(err.errorName).toBe("EngineError");
    expect(err.message).toContain("cannot continue this subagent by message");
    expect(deliverChatMessage).not.toHaveBeenCalled();
  });

  it("[引擎身份域损坏] 有原生引擎锚却无 engine 字段 → 显式抛错（不按 pi 生成误导性拒绝文案）", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const corrupt = makeExecRecord({
      id: "bg-corrupt",
      status: "running",
      engine: undefined,
      engineHandle: {
        sessionRef: { sessionId: "sess-corrupt", dbPath: "db.sqlite" },
        poolKey: "shared",
      },
    });
    const err = await errOf(() =>
      messageHandler(
        makeService({
          getRecordForAction: vi.fn(() => corrupt),
          deliverChatMessage,
          // 资格判据拒绝 → 拒绝文案的引擎 id 解析点被损坏检查拦截
          engineSupportsConversation: vi.fn(() => false),
        }),
        { subagentId: "bg-corrupt", text: "hi" },
      ),
    );
    expect(err.errorName).toBe("RecordEngineIdentityError");
    expect(err.message).toContain('record "bg-corrupt"');
    expect(err.message).toContain("refusing to route it to the default engine 'pi'");
    expect(err.message).not.toContain("cannot continue this subagent by message");
    expect(deliverChatMessage).not.toHaveBeenCalled();
  });

  it("[S3 域边界] workflow-origin record 收 message → 硬拒，文案含 list 检查指引 + subagent_batch 重派指引", async () => {
    const deliverChatMessage = vi.fn(async () => {});
    const wfRec = makeExecRecord({ id: "bg-wf", origin: "workflow" });
    const err = await errOf(() =>
      messageHandler(
        makeService({ getRecordForAction: vi.fn(() => wfRec), deliverChatMessage }),
        { subagentId: "bg-wf", text: "hi" },
      ),
    );
    expect(err.errorName).toBe("Error");
    expect(err.message).toContain("results are collected by the workflow run");
    expect(err.message).toContain("Recovery: use action:'list' with includeWorkflow:true to inspect it.");
    // [S3/core-U1] 重派指引（编排者裁定文案，逐字锁定）
    expect(err.message).toContain("To get these results, re-dispatch via the subagent_batch tool.");
    expect(deliverChatMessage).not.toHaveBeenCalled();
  });

  // [round2-notify-fix 合并注] 原「collect:'sync' 批成员硬拒续聊」回归锁随 modeless
  // 波1/波3 删除：chatMode/collectMode 字段消亡，sync 批成员批完成即自动归档、通知走
  // 统一轮终形态（批缓冲路由面消亡），message 对任何归属内 record 直接续聊——被锁的
  // 检查行为是 main 设计上有意移除的，不再保留测试。

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
          lookupRecordAnyState: vi.fn(() => makeRec({ id: "bg-1", status: "idle", closedReason: "disconnected" })),
        }),
        { subagentId: "bg-1", text: "hi" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect(caught instanceof ResurrectDeniedError).toBe(true);
  });

  it("[U4 缩型] endedMessageGuard：同树 idle record 归属通过（getRecordForAction 成功）→ 无形态拒绝，正常投递", async () => {
    // [U4 / §3.2.3 万物可续] 「主动关闭」文案消亡：user-close/cancelled 遗留位不再
    // 拒绝 message——getRecordForAction 准入放行后直达 deliverChatMessage。
    for (const closedReason of ["user-close", "cancelled", "gc", "parent-new"] as const) {
      const deliver = vi.fn(async () => {});
      const r = await messageHandler(
        makeService({
          getRecordForAction: vi.fn(() => {
            const rec = makeExecRecord({ id: "bg-1" });
            rec.closedReason = closedReason;
            return rec;
          }),
          engineSupportsConversation: vi.fn(() => true),
          deliverChatMessage: deliver,
        }),
        { subagentId: "bg-1", text: "hi" },
      );
      expect(r.response.delivered).toBe(true);
      expect(deliver).toHaveBeenCalled();
    }
  });

  it("[U4 缩型] endedMessageGuard：异树快照（getRecordForAction not-owned 拒绝）→ 跨树归属文案（closedReason 不再进文案）", async () => {
    const mkSvc = (sessionFile?: string) =>
      makeService({
        getRecordForAction: vi.fn(() => {
          throw new Error("subagent not found or not owned: bg-1. Recovery: ...");
        }),
        lookupRecordAnyState: vi.fn(() =>
          makeRec({ id: "bg-1", status: "idle", closedReason: "disconnected", rootSessionId: "root-B", sessionFile }),
        ),
      });
    const expectedHead = "subagent bg-1 belongs to a different session tree than this one (rootSessionId: root-B). " +
      "You cannot message it from here. ";
    // 有 sessionFile → 追加 source session
    expect((await errOf(() => messageHandler(mkSvc("sess-1.jsonl"), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      expectedHead +
        'Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"bg-1"}}' +
        " (source session: sess-1.jsonl); otherwise start a new subagent.",
    );
    // 无 sessionFile → 无追加
    expect((await errOf(() => messageHandler(mkSvc(undefined), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      expectedHead +
        'Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"bg-1"}}' +
        "; otherwise start a new subagent.",
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
    // 有 sessionFile → 追加 source session（[U4] 文案统一为跨树归属判据 + rootSessionId 回显）
    expect((await errOf(() => messageHandler(mkSvc("sess-1.jsonl"), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 belongs to a different session tree than this one (rootSessionId: root-B). You cannot message it from here. " +
        'Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"bg-1"}}' +
        " (source session: sess-1.jsonl); otherwise start a new subagent.",
    );
    // 无 sessionFile → 无追加
    expect((await errOf(() => messageHandler(mkSvc(undefined), { subagentId: "bg-1", text: "hi" }))).message).toBe(
      "subagent bg-1 belongs to a different session tree than this one (rootSessionId: root-B). You cannot message it from here. " +
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

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
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
// forkFromHandler（检查链 1–6）
// ============================================================
describe("⛔4 forkFromHandler（检查链 + slug 派生 + prompt 包装，快照 = pi-sw 实测）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  // [U4b/E2] 双宿主探针 fixture 目录：检查 3 现查探针读真实 .alive 侧车（不再读
  // rec.externalInstance 缓存字段），用临时目录落盘驱动，自建自删。
  let forkDir: string;
  /** [U4] 锚可解析性 fixture（fork-from 正常路径要求源文件真实在盘）。 */
  let forkAnchor: string;
  // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
  const forkDirs: string[] = [];
  beforeEach(() => {
    forkDir = fs.mkdtempSync(path.join(os.tmpdir(), "actions-core-fork-"));
    forkDirs.push(forkDir);
    forkAnchor = path.join(forkDir, "sess-1.jsonl");
    fs.writeFileSync(forkAnchor, "{}\n", "utf-8");
  });
  afterAll(() => {
    for (const d of forkDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

  it("检查 1：本进程内存 running → still-active 文案", async () => {
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

  it("检查 2：全态查无 → garbage-collected 文案", async () => {
    expect(await errOf(() => forkFromHandler(makeForkService(undefined), { sourceSubagentId: "bg-404" }))).toEqual({
      errorName: "Error",
      message:
        'No subagent record with id "bg-404". It may never have existed or been garbage-collected — ' +
        "use action:'list' with includeFinished:true to verify the id (add includeWorkflow:true to also see workflow-dispatched subagents).",
    });
  });

  it("[R5] 检查 3：zcode 源 → fork 通道未接入文案（准确理由 + 行动语言，无 retention 误导文字）", async () => {
    // zcode 形态：sessionFile 恒 undefined，历史在隔离 sqlite 会话库（engineHandle.sessionRef）。
    // 旧链路下该形态落检查 6 锚判据，文案「never started / retention expired」对 zcode 失实
    // （历史不随 pi retention 回收，真实原因是 fork 通道未接入）——zcode 按引擎早分流给出准确理由。
    const r = await errOf(() =>
      forkFromHandler(
        makeForkService(
          makeRec({
            id: "bg-1",
            status: "idle",
            engine: "zcode",
            sessionFile: undefined,
            engineHandle: { sessionRef: { sessionId: "zc-1", dbPath: "/tmp/zc/db.sqlite" }, poolKey: "shared" },
          }),
        ),
        { sourceSubagentId: "bg-1" },
      ),
    );
    expect(r.errorName).toBe("Error");
    // 准确理由：通道未接入 + 历史在隔离会话库
    expect(r.message).toContain("fork-from channel is not wired up yet");
    expect(r.message).toContain("isolated sqlite session db");
    // [G4] 不得复用 pi 的失实表述
    expect(r.message).not.toContain("never started");
    expect(r.message).not.toContain("retention expired");
    // 行动语言：message 同 id 重开（历史摘要自动注入）或 start 全新子代理
    expect(r.message).toContain("action:'message'");
    expect(r.message).toContain("(prior-task summary auto-injected)");
    expect(r.message).toContain("action:'start'");
  });

  it("[R5] 检查 3 先于 worktree 检查：zcode + worktree 源 → 仍是 zcode 通道文案（worktree 文案对 zcode 失实）", async () => {
    // 分流位置在 worktree 检查之前（设计 §5 W4：worktree 文案的「read its session file」
    // 行动语言对 zcode 无意义——zcode 无 sessionFile 载体）
    const r = await errOf(() =>
      forkFromHandler(
        makeForkService(
          makeRec({
            id: "bg-1",
            status: "idle",
            engine: "zcode",
            worktree: true,
            sessionFile: undefined,
            engineHandle: { sessionRef: { sessionId: "zc-1", dbPath: "/tmp/zc/db.sqlite" }, poolKey: "shared" },
          }),
        ),
        { sourceSubagentId: "bg-1" },
      ),
    );
    expect(r.errorName).toBe("Error");
    expect(r.message).toContain("fork-from channel is not wired up yet");
    expect(r.message).not.toContain("worktree isolation");
  });

  it("检查 4：异进程活实例（.alive 恒活外部 pid）→ another-process 文案（双宿主形态）", async () => {
    // [U4b/E2] 双宿主形态：宿主 A 持有中的 record（.alive = A 进程的活 pid 声明）被
    // 宿主 B 冷查重建，B fork-from 该源时检查 4 现查探针命中 → 拒绝（源仍在异进程
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

  it("检查 4 不误伤：running 快照（无活 pid，跨重启重建）放行 → 正常 fork", async () => {
    // [U4] 锚可解析性要求源 sessionFile 真实在盘（isAnchorResolvable = existsSync）。
    const sessionFile = path.join(forkDir, "sess-live.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const r = await forkFromHandler(
      makeForkService(makeRec({ id: "bg-1", status: "running", slug: "rebuilt", sessionFile })),
      { sourceSubagentId: "bg-1" },
    );
    expect(r).toEqual({
      kind: "fork-from",
      subagentId: "bg-new-1",
      sourceSessionFile: sessionFile,
      response: { newSubagentId: "bg-new-1", sourceSessionFile: sessionFile },
    });
  });

  it("[U4 检查 4 删除] cancelled / user-close 源 → fork-from 放行（万物可续后对任何 idle record 分叉）", async () => {
    // [U4 / §3.2.3] 主动告别不再是 fork 例外：检查 4 随形态枚举 gate 消亡——
    // message 与 fork-from 的「guard 一致性拒绝」双双转为放行。
    const sessionFile = path.join(forkDir, "sess-closed.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    for (const closedReason of ["cancelled", "user-close"] as const) {
      const execute = vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "background",
        subagentId: `bg-new-${closedReason}`,
        sessionFile: "sess-new.jsonl",
        details: makeDetails(),
      }));
      const r = await forkFromHandler(
        makeForkService(makeRec({ id: "bg-1", status: "idle", closedReason, sessionFile }), execute),
        { sourceSubagentId: "bg-1" },
      );
      expect(r.response.newSubagentId).toBe(`bg-new-${closedReason}`);
      expect(r.response.sourceSessionFile).toBe(sessionFile);
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("检查 5：worktree 记录 → isolation-lost 文案（含 sessionFile 路径插值）", async () => {
    expect(
      await errOf(() =>
        forkFromHandler(
          makeForkService(makeRec({ id: "bg-1", status: "idle", closedReason: "gc", worktree: true, sessionFile: "sess-1.jsonl" })),
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

  it("[U4 检查 6 锚判据化] 锚不可解析（字段缺失 / 文件被回收）→ 引导 message reopen 语义而非 start fresh", async () => {
    const expectedMessage =
      "subagent bg-1 has no transcript history left to fork from (it never started, or the transcript " +
      "was collected after its retention expired). " +
      "Recovery: use action:'message' on this id — it reopens on the same id with a fresh transcript " +
      "(prior-task summary auto-injected); or start a fresh subagent (action:'start').";
    // 字段缺失（entry-born：从未开跑）
    expect(
      await errOf(() =>
        forkFromHandler(
          makeForkService(makeRec({ id: "bg-1", status: "idle", closedReason: "gc", sessionFile: undefined })),
          { sourceSubagentId: "bg-1" },
        ),
      ),
    ).toEqual({ errorName: "Error", message: expectedMessage });
    // 字段在但文件不在（transcript 被回收）
    expect(
      await errOf(() =>
        forkFromHandler(
          makeForkService(makeRec({ id: "bg-1", status: "idle", closedReason: "gc", sessionFile: path.join(forkDir, "gone.jsonl") })),
          { sourceSubagentId: "bg-1" },
        ),
      ),
    ).toEqual({ errorName: "Error", message: expectedMessage });
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
        makeRec({ id: "bg-1", slug: "src-slug", agent: "/home/u/agents/reader.md", sessionFile: forkAnchor }),
        execute,
      ),
      { sourceSubagentId: "bg-1", prompt: "  continue the work  " },
    );
    expect(r).toEqual({
      kind: "fork-from",
      subagentId: "bg-new-1",
      sourceSessionFile: forkAnchor,
      response: { newSubagentId: "bg-new-1", sourceSessionFile: forkAnchor },
    });
    expect(execute).toHaveBeenCalledWith({
      task:
        "continue the work\n\n(You are continuing a previous subagent's inherited conversation via --fork. " +
        "Reconstruct state from that history first — what was done, decided, and remains — then execute the instruction above.)",
      slug: "src-slug-resumed",
      forkFromSessionFile: forkAnchor,
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
      makeForkService(makeRec({ id: "bg-1", slug: "src-slug", sessionFile: forkAnchor }), execute),
      { sourceSubagentId: "bg-1", prompt: undefined },
    );
    expect(execute).toHaveBeenCalledWith({
      task: FORK_FROM_DEFAULT_PROMPT,
      slug: "src-slug-resumed",
      forkFromSessionFile: forkAnchor,
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
      makeForkService(makeRec({ id: "bg-1", slug: "s".repeat(34), sessionFile: forkAnchor }), execute34),
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
        makeRec({ id: "bg-1", slug: "", agent: "/home/u/agents/helper.md", sessionFile: forkAnchor }),
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
      makeForkService(makeRec({ id: "bg-1", slug: "", agent: "", sessionFile: forkAnchor }), executeResumed),
      { sourceSubagentId: "bg-1", prompt: "p" },
    );
    expect(executeResumed.mock.calls[0]![0].slug).toBe("resumed-resumed");
  });
});

// ============================================================
// [subagent-observability §3.3.6 查询入口补全] list 条目轮收条事实字段
// （UC-1③：父 agent 查询拿到「上一轮怎么收尾」的真相通道——消费方先读事实，
// outcome 展示词保留为兼容读侧）。
// ============================================================
describe("recordToListItem 轮收条事实字段（subagent-observability u3）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("失败轮事实：lastRound 携带引擎停因原值 + 失败分类 + 正文摘要 + turns；swept 失联标注随附；lastError 透传", () => {
    const item = recordToListItem(
      makeRec({
        id: "bg-lr-fail",
        status: "idle",
        stopReason: "failed",
        turns: 6,
        result: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
        lastError: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
        lastRound: {
          engineStopReason: "error",
          failure: {
            class: "provider",
            kind: "rate_limited",
            retryable: "conditional",
            retryAfterMs: 1_320_000,
            raw: "429: tier_limit_exceeded",
          },
        },
      }),
    );
    expect(item.lastRound).toMatchObject({
      engineStopReason: "error",
      failure: { class: "provider", kind: "rate_limited", retryable: "conditional" },
      result: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
      turns: 6,
    });
    expect(item.lastError).toContain("tier_limit_exceeded");
    expect(item.swept).toBeUndefined();
  });

  it("失联清点命中：lastRound.swept 附注随 lastRound 派生（清点事实落轮收条附注——恢复动作 = 查 evidence + 续聊重建）", () => {
    const item = recordToListItem(
      makeRec({
        id: "bg-lr-swept",
        status: "idle",
        stopReason: "interrupted-by-restart",
        lastRound: {
          engineStopReason: "interrupted-by-restart",
          swept: { at: 1_700_000_000_000, evidence: "manifest=executionStatus:running" },
        },
      }),
    );
    expect(item.swept).toEqual({ at: 1_700_000_000_000, evidence: "manifest=executionStatus:running" });
    expect(item.lastRound?.engineStopReason).toBe("interrupted-by-restart");
    // 失联非失败：无 failure 分类（红点判据读 failure——失联轮不误报红点，中性档）。
    expect(item.lastRound?.failure).toBeUndefined();
  });

  it("被接管轮（promptDisposition=handled）事实透传；无 lastRound 事实的存量形态不落键（⛔4 快照零扰动）", () => {
    const handled = recordToListItem(
      makeRec({
        id: "bg-lr-handled",
        status: "idle",
        lastRound: { promptDisposition: "handled" },
      }),
    );
    // turns 随聚合字段派生（收条时点的累计 turn 数——makeRec 基线 turns=1）。
    expect(handled.lastRound).toEqual({ promptDisposition: "handled", turns: 1 });

    // 存量 record（无轮收条事实）→ lastRound/lastError/swept 键缺省（JSON 形态零新增键）。
    const legacy = recordToListItem(makeRec({ id: "bg-lr-legacy" }));
    expect("lastRound" in legacy).toBe(false);
    expect("lastError" in legacy).toBe(false);
    expect("swept" in legacy).toBe(false);
  });

  it("evidence 取证指针透传（查询漏斗附加——recordToListItem 只透传）；无指针的存量形态不落键", () => {
    const withEvidence = recordToListItem(
      makeRec({
        id: "bg-ev-1",
        evidence: { eventsFile: "/records/bg-ev-1.events", lastSeq: 7 },
      }),
    );
    expect(withEvidence.evidence).toEqual({ eventsFile: "/records/bg-ev-1.events", lastSeq: 7 });

    const noEvidence = recordToListItem(makeRec({ id: "bg-ev-2" }));
    expect("evidence" in noEvidence).toBe(false);
  });
});

// ============================================================
// listHandler 组合链：证据与轮收条事实（subagent-observability F1-39/F1-42/F1-46）
// ============================================================
// 断言走 listHandler 全链（collectRecords 漏斗条目 × getFullRecord 富化合并），
// 不只直调 recordToListItem——evidence 只附加在 collectRecords 的 mergedRecords
// 浅拷贝上（attachListEvidence 单点），富化替换丢漏斗产物即在本层拦截。
describe("listHandler 组合链：evidence/lastRound/lastError 两路在场（F1-39）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("内存路：富化对象不带 evidence 时从漏斗条目保留（修复前全链丢失的回归锚）", () => {
    const funneled = makeRec({
      id: "bg-mem-1",
      status: "running",
      lastError: "provider 500: upstream error",
      lastRound: { engineStopReason: "error" },
      evidence: { eventsFile: "/records/bg-mem-1.events", lastSeq: 3 },
    });
    // 内存富化形态（recordToSubagent 投影）：lastRound/lastError 直读在场，evidence 不产。
    const full = makeRec({
      id: "bg-mem-1",
      status: "running",
      lastError: "provider 500: upstream error",
      lastRound: { engineStopReason: "error" },
    });
    const r = listHandler(
      makeService({
        collectRecords: vi.fn(() => [funneled]),
        getFullRecord: vi.fn(() => full),
      }),
      { includeFinished: true },
    );
    expect(r.response.items).toHaveLength(1);
    expect(r.response.items[0].evidence).toEqual({
      eventsFile: "/records/bg-mem-1.events",
      lastSeq: 3,
    });
    expect(r.response.items[0].lastRound).toMatchObject({ engineStopReason: "error" });
    expect(r.response.items[0].lastError).toBe("provider 500: upstream error");
  });

  it("磁盘路：全量重建 full 无 lastRound/evidence（buildRecord 形态）→ 漏斗条目 fold 派生事实补缺；lastError 取 full", () => {
    // 漏斗 light 形态（扫描探测路径 projectFoldToLight 派生）：lastRound 带收条帧
    // turns 快照与 stderrTeePath、evidence 漏斗附加；在途形态 light.turns = 0。
    const funneled = makeRec({
      id: "bg-disk-1",
      status: "running",
      turns: 0,
      lastRound: {
        engineStopReason: "error",
        turns: 6,
        stderrTeePath: "/logs/pi-2026-10-23-bg-disk-1.jsonl",
      },
      evidence: {
        eventsFile: "/records/bg-disk-1.events",
        lastSeq: 12,
        stderrTeePath: "/logs/pi-2026-10-23-bg-disk-1.jsonl",
      },
    });
    // 磁盘全量重建 full 形态（buildRecord）：lastError 透传，lastRound/evidence 不恢复。
    const full = makeRec({
      id: "bg-disk-1",
      status: "running",
      turns: 14,
      lastError: "429: tier_limit_exceeded",
    });
    const r = listHandler(
      makeService({
        collectRecords: vi.fn(() => [funneled]),
        getFullRecord: vi.fn(() => full),
      }),
      { includeFinished: true },
    );
    const item = r.response.items[0];
    expect(item.evidence).toEqual({
      eventsFile: "/records/bg-disk-1.events",
      lastSeq: 12,
      stderrTeePath: "/logs/pi-2026-10-23-bg-disk-1.jsonl",
    });
    expect(item.lastRound).toMatchObject({
      engineStopReason: "error",
      turns: 6,
      stderrTeePath: "/logs/pi-2026-10-23-bg-disk-1.jsonl",
    });
    expect(item.lastError).toBe("429: tier_limit_exceeded");
  });
});

describe("listLastRoundOf turns 语义（F1-46：收条自身轮终值优先）", () => {

  beforeAll(() => {
    vi.useFakeTimers({ now: FROZEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("收条快照 turns 在场时不被 live 计数器覆盖（下一轮轮始起累加的 r.turns 不漂移上一轮收条）", () => {
    const item = recordToListItem(
      makeRec({
        id: "bg-turns-1",
        status: "running",
        turns: 9, // live 计数器（新一轮已推进）
        lastRound: { engineStopReason: "stop", turns: 6 }, // 上一轮收条定格
      }),
    );
    expect(item.lastRound?.turns).toBe(6);
  });

  it("旧快照（无 turns 字段）回落 live r.turns（兼容存量 RoundFacts 形态）", () => {
    const item = recordToListItem(
      makeRec({
        id: "bg-turns-2",
        status: "idle",
        turns: 4,
        lastRound: { engineStopReason: "stop" },
      }),
    );
    expect(item.lastRound?.turns).toBe(4);
  });
});
// 来源段：cold-lookup.test.ts
//
// [D4-③] coldLookupForAction 单元测试（依赖注入直测）。
//
// 背景：冷查链自 SubagentService 搬移后按 ColdLookupDeps 依赖注入设计，此前仅有经
// subagent-service 集成路径的 running 重建覆盖——closed 可重连候选的「恢复失败检查 /
// 部分恢复回边」（assertReconnectAllowed / resurrectColdRecord 的 wasClosed 分支）
// 零直测。[H1 U6] 文件随 cold-resurrect.ts → cold-lookup.ts 改名（chatMode 无条件
// 置位语义迁 Continuation D4 revive 格 + D5 gate，重建只水合持久化 chatMode）。
// 本文件锁定这些路径的可观察行为：
//   - 恢复失败：worktree 绑定丢失 / 异进程活实例（closed 与 running 候选）→
//     ResurrectDeniedError 且内存无残留（register 不被调用）；
//   - 部分恢复：closed 可重连记录 → resurrectClosed 回边翻回 running + 磁盘终态位
//     同步翻转（.state（L4 现行终态载体）与 legacy .finalized 删除 + .alive 刷新当前
//     进程）+ register/transition 上报——[U2a/B4] 回边三件套整体收编
//     store.markResurrected（deps 注入真实 RecordStore 实例承载）；
//   - [B4/D3c] 恢复源缺失（sessionFile 缺失 / marker 写失败）→ 响亮抛错中止重生主流程
//     （旧「单 try 吞错续跑」形态消灭——acquire 失败 = 双写风险敞口，§3.4）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

/** 磁盘/索引侧候选记录（SubagentRecord 最小合法形状 + closed 可重连缺省）。 */
function makeFound(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-cold-1",
    agent: "general-purpose",
    task: "cold recovery task",
    slug: "cold-test",
    status: "idle",
    closedReason: "parent-shutdown",
    mode: "background",
    startedAt: 1_700_000_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 1_700_000_100_000,
    turns: 0,
    totalTokens: 0,
    model: "test/model-a",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...overrides,
  };
}

interface DepOverrides {
  /** findLightById（idToFile 索引直查）返回值。 */
  direct?: SubagentRecord;
  /** collectRecords（磁盘全扫）返回清单。 */
  disk?: SubagentRecord[];
  /** getSessionRootId 返回值（归属校验）。 */
  rootId?: string;
  /** getBaselineRecordId 返回值（直接父校验）。 */
  baseline?: string;
}

/** 构造依赖注入桩。markResurrected 经真实 RecordStore 承载（[U2a/B4] 回边收编 store
 *  原语——磁盘三件套/内存翻回/register 需真实落盘语义，stub 无法验证）；register 用
 *  spy 包住 store.register 供「内存无残留」断言（markResurrected 内部 register 与
 *  spy 同一入口）。sessionsDir 经 beforeEach 刷新（describe 作用域变量模块级桥接）。 */
let currentSessionsDir = "";
function makeDeps(o: DepOverrides = {}): ColdLookupDeps {
  const store = new RecordStore(() => currentSessionsDir);
  const registerSpy = vi.spyOn(store, "register");
  return {
    findLightById: vi.fn(() => o.direct),
    collectRecords: vi.fn(() => o.disk ?? []),
    register: registerSpy,
    reportRecordTransition: vi.fn(),
    markResurrected: (record, wasClosed) => store.markResurrected(record, wasClosed),
    getSessionRootId: vi.fn(() => o.rootId ?? "root-session"),
    getBaselineRecordId: vi.fn(() => o.baseline),
  };
}

describe("[D4-③] coldLookupForAction 冷查/复活链", () => {
  let dir: string;
  // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
  const coldLookupDirs: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-lookup-"));
    coldLookupDirs.push(dir);
    currentSessionsDir = dir;
  });

  afterAll(() => {
    for (const d of coldLookupDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** tmpdir 下建 session 文件 + 可选终态 sidecar（.state / legacy .finalized）+ 可选
   *  .alive sidecar，返回 sessionFile 路径。 */
  function writeSessionFixture(
    opts: { state?: string; finalized?: string; aliveMarker?: string } = {},
  ): string {
    const sessionFile = path.join(dir, "20260901T000000-000_sa-cold-1.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    if (opts.state !== undefined) {
      fs.writeFileSync(`${sessionFile}.state`, opts.state, "utf-8");
    }
    if (opts.finalized !== undefined) {
      fs.writeFileSync(`${sessionFile}.finalized`, opts.finalized, "utf-8");
    }
    if (opts.aliveMarker !== undefined) {
      fs.writeFileSync(`${sessionFile}.alive`, opts.aliveMarker, "utf-8");
    }
    return sessionFile;
  }

  // ── 部分恢复（closed 可重连 → 透明重生回边）──

  it("closed 可重连记录（parent-shutdown）+ allowReconnect → 重生翻回 running：终态位清除、sidecar 翻转、register + transition 上报", () => {
    const sessionFile = writeSessionFixture({ finalized: JSON.stringify({ reason: "parent-shutdown" }) });
    const found = makeFound({ sessionFile, round: 2 });
    const deps = makeDeps({ disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    // 重生回边：closed → running，终态语义位清除
    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined();
    expect(record.endedAt).toBeUndefined();
    // [modeless 波1] chatMode 水合丢弃（旧持久化残留键不进内存 record）
    //（undefined）→ 重建 false（升级置位归 Continuation revive 格 + gate，不在重建层）
    // 身份/续聊字段从磁盘候选回填
    expect(record.sessionFile).toBe(sessionFile);
    expect(record.round).toBe(2);
    expect(record.model).toBe("test/model-a");
    expect(record.hadWorktree).toBe(false);
    // register + [v8.5 D] 重生后立刻上报 transition entry（live ≡ reload）
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledWith(record);
    // [review MF-8] .alive 刷新为当前进程（终态位 sidecar 已随 ③ 退场，不再有删除动作）
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "sa-cold-1" });
    // 冷查扫描契约：全目录兜底按 COLD_LOOKUP_SCAN_LIMIT 上限扫全量（无 root 过滤）
    expect(vi.mocked(deps.collectRecords)).toHaveBeenCalledWith(COLD_LOOKUP_SCAN_LIMIT, "all", undefined);
  });

  // [round2-notify-fix 合并注] 原「冷重建水合 collectMode」回归锁随 modeless 波1/波3
  // 删除：collectMode 字段已出 record（message 资格只看引擎能力轴，sync 成员身份迁
  // 登记态且跨重启不复活），被锁的水合行为是 main 设计上有意移除的。

  it("[P4-① ⛔ two-state-convergence U4] 轮终 idle record（markRoundIdle 产物：idle + .state 收条 + 无 closedReason）跨重启 readopt：wasClosed=true 三件套全量 + transition 恰一条 + .state 删除", () => {
    // U4 写侧翻边后正常轮终 = idle 形态落盘（stopReason=completed + .state 收条
    // {status:"idle",reason:"completed"}，closedReason 无、endedAt 无）——跨重启
    // message 冷查链 wasClosed = status!=='running' = true 路径，与旧 closed 可重连
    // 形态统一 acquire（D3c 两形态统一）。
    const sessionFile = writeSessionFixture({
      state: JSON.stringify({ status: "idle", reason: "completed", endedAt: 1_700_000_050_000 }),
    });
    // 候选 = 轮终翻边产物形态：status=idle + stopReason 在场 + closedReason 无
    const found = makeFound({
      sessionFile,
      status: "idle",
      closedReason: undefined,
      stopReason: "completed",
      round: 1,
    });
    const deps = makeDeps({ disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    // 三件套全量（markResurrected wasClosed=true）：
    //   ① 内存翻回 running（acquire marker 先行 + resurrectClosed 内存翻回）
    expect(record.status).toBe("running");
    //   ② 磁盘终态位不再需要清理（③ 后终态由事件流折叠决定，重开由 record-reopened 表达）
    //   ③ .alive 写权声明 acquire 到当前进程
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "sa-cold-1" });
    // register + transition entry 恰一条（重生后立刻上报——live ≡ reload，SP-2 先例）
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledWith(record);
    // 现状登记：resurrectColdRecord 的重建回填域不含 stopReason（候选的轮终停因展示位
    // 不跨重启水合）——重建水合缺口归 U5/U6 重建侧批次，本批不扩 readopt 行为。
    expect(record.round).toBe(1);
  });

  it("负向对照：重生被检查拒绝（worktree 绑定丢失）→ 终态 sidecar 不被误删", () => {
    // 检查先于任何状态突变与副作用（[v8.5 D] / [review MF-9]）：拒绝路径不得触碰磁盘
    const sessionFile = writeSessionFixture({
      state: JSON.stringify({ status: "finalized", reason: "parent-shutdown" }),
      finalized: JSON.stringify({ reason: "parent-shutdown" }),
    });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, worktree: true })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);

    expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("[U4 万物可续] idToFile 索引直查命中旧终态遗留位（closedReason=gc）→ 直接采用（两态全候选，不再回退全扫）", () => {
    const sessionFile = writeSessionFixture();
    const found = makeFound({ sessionFile, closedReason: "gc" });
    const deps = makeDeps({ direct: found, disk: [] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.collectRecords)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
  });

  it("[U3 / §3.2.4 桥接] idToFile 索引直查命中可重连 closed 候选 → 直接采用（无需回退全扫）", () => {
    const sessionFile = writeSessionFixture();
    const found = makeFound({ sessionFile });
    const deps = makeDeps({ direct: found, disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.collectRecords)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
  });

  it("候选持久化 chatMode=true（旧文件残留）→ [modeless 波1] 水合丢弃（message 资格只看引擎轴）", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  it("closed disconnected（.finalized 空内容兜底死因）同样落在可重连集内", () => {
    const sessionFile = writeSessionFixture({ finalized: "" });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, closedReason: "disconnected" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  // ── 恢复失败检查（ResurrectDeniedError + 内存无残留）──

  it("worktree 绑定丢失（跨重启 WorktreeHandle 不可序列化）→ ResurrectDeniedError 拒绝，register 不残留", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, worktree: true })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/worktree isolation/);
    // [R5] pi 形态（sessionFile 有值）：历史保全占位维持 sessionFile 路径渲染
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      new RegExp(`remains intact at ${sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`),
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("[R5] worktree 绑定丢失 zcode 形态（sessionFile undefined）→ 拒绝文案不产出 at undefined，改述隔离会话库承载", () => {
    // zcode record 的历史由隔离会话库经 engineHandle.sessionRef 承载、不随 worktree
    // checkout 丢失——sessionFile 占位按锚形态分流，硬渲染会产出 "at undefined"。
    // 拒绝语义（ResurrectDeniedError）不变，仅修文案占位准确性。
    const deps = makeDeps({
      disk: [
        makeFound({
          worktree: true,
          engine: "zcode",
          sessionFile: undefined,
          engineHandle: { sessionRef: { sessionId: "zc-1", dbPath: "/tmp/zc/db.sqlite" }, poolKey: "shared" },
        }),
      ],
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/worktree isolation/);
    // 不再出现 "at undefined" 占位泄漏
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/isolated session db/);
    let message = "";
    try {
      coldLookupForAction(makeDeps({
        disk: [
          makeFound({
            worktree: true,
            engine: "zcode",
            sessionFile: undefined,
            engineHandle: { sessionRef: { sessionId: "zc-1", dbPath: "/tmp/zc/db.sqlite" }, poolKey: "shared" },
          }),
        ],
      }), "sa-cold-1", true);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("at undefined");
    expect(message).toContain("not affected by the lost checkout");
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("closed 候选仍有异进程活实例（.alive 指向活 pid）→ 拒绝双写，register 不残留", () => {
    // [U1/A4] 探针已补 self-pid 排除——「异进程」模拟不能再用本测试进程 pid，改用
    // 恒活的外部 pid 1（launchd/init：kill(1,0) → EPERM → isProcessAlive 判活为真）。
    const sessionFile = writeSessionFixture();
    writeAliveMarker(sessionFile, { pid: FOREIGN_LIVE_PID, id: "sa-cold-1", startedAt: Date.now() });
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    // [U4] 统一占用拒绝句式（设计 §3.1 唯一拒绝形态：错误 → 权威源 → 重试闭环）
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /is writing this session/,
    );
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /close it or wait for it to exit, then retry/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("running 候选仍有异进程活实例（父进程重启后旧子进程尚存窗口）→ 拒绝并给恢复指引", () => {
    const sessionFile = writeSessionFixture();
    writeAliveMarker(sessionFile, { pid: FOREIGN_LIVE_PID, id: "sa-cold-1", startedAt: Date.now() });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running" })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /is writing this session/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("损坏 .alive marker（无法解析）→ 视为确死放行重生，marker 被当前进程覆盖写", () => {
    const sessionFile = writeSessionFixture({
      finalized: JSON.stringify({ reason: "parent-shutdown" }),
      aliveMarker: "{not valid json",
    });
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid });
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  // ── 候选过滤 / 归属与父层校验 ──

  it.each([
    ["自然完成死因 gc", "gc"],
    ["用户主动 close", "user-close"],
    ["用户取消", "cancelled"],
    ["编排性关闭 parent-fork", "parent-fork"],
    ["编排性关闭 parent-new", "parent-new"],
  ] as const satisfies readonly (readonly [string, ClosedReason])[])("[U4 万物可续] 旧终态遗留位（%s）→ 同样重生放行（形态枚举 gate 消亡）", (_label, _reason) => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, closedReason: _reason })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;
    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined();
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  it("[U4] allowReconnect 参数退役：两态全候选（idle 不再按可重连集把门），false 同样放行", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    const record = coldLookupForAction(deps, "sa-cold-1", false)!;
    expect(record.status).toBe("running");
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  it("rootSessionId 不匹配 → 返回 undefined（不区分失败形态，防跨 session 探测）", () => {
    const deps = makeDeps({ disk: [makeFound({ rootSessionId: "other-root" })], rootId: "root-session" });

    expect(coldLookupForAction(deps, "sa-cold-1", true)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("parentRecordId 跨层不匹配（候选有直接父）→ 原样抛 direct parent 错误（跨层导航指引）", () => {
    const deps = makeDeps({
      disk: [makeFound({ status: "running", parentRecordId: "sa-parent" })],
      baseline: undefined,
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/is owned by its direct parent/);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/parent=sa-parent/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("顶层候选（parentRecordId 缺失）遇嵌套进程 baseline → direct parent 错误带 (root layer) 回显", () => {
    const deps = makeDeps({
      disk: [makeFound({ status: "running", parentRecordId: undefined })],
      baseline: "rec-baseline-child",
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /parent=\(root layer\)/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  // ── 恢复源缺失（[B4/D3c] 响亮失败——吞错续跑形态消灭）──

  it("[B4] sessionFile 缺失的 closed 候选 → markResurrected 响亮抛错中止重生（无锚点无法声明写权）", () => {
    const deps = makeDeps({ disk: [makeFound({ sessionFile: undefined })] });

    // acquire 失败 = 双写风险敞口，禁止 best-effort 吞错续跑（§3.4/D3c——旧形态
    // 「跳过 sidecar 翻转、重生照常完成」随回边收编消灭：无锚点的 running record
    // 缺跨进程写权声明，正是 D3 要防的事故形态入口）。
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/no sessionFile anchor/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.reportRecordTransition)).not.toHaveBeenCalled();
  });

  it("[B4] sidecar 翻转失败（sessionFile 所在目录不存在，writeAliveMarker ENOENT）→ 响亮中止，终态位未被误删", () => {
    // 恢复源缺失形态：sessionFile 指向已消失的目录（推导路径过期 / 目录被清理）
    const sessionFile = path.join(dir, "vanished-dir", "20260901T000000-000_sa-cold-1.jsonl");
    // 离线预置终态位（目录存在时才可写——改为断言 acquire-first 失败后磁盘保持旧形态
    // 的推演基础：无终态位可删的目录缺失形态下，响亮失败即全部可观察行为）
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    // acquire-first 写权声明失败 → 整体响亮抛错（单 try 域原子收敛，D3c）。
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /write-lease acquire\/terminal-position flip failed/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.reportRecordTransition)).not.toHaveBeenCalled();
    // marker 写入确实失败（目录不存在，未落盘）
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });

  it("[B4/D3c] acquire-first 失败后磁盘保持旧形态（终态位未删，重生可重试）", () => {
    // acquire 成功但终态位删除失败不可构造（rmSync force 幂等）——验证 acquire-first
    // 顺序的可观察等价面：目录存在 + 终态位在，marker 写成功路径下才执行删除。
    // 本用例钉失败方向的可重试性：closed 候选 + 检查通过 + 目录消失 → 响亮中止后
    // .state 残留形态不变（无「半翻」状态）。
    const sessionFile = path.join(dir, "gone", "20260901T000000-000_sa-cold-1.jsonl");
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow();
    // 磁盘侧零触碰（目录本不存在——构造性「保持旧形态」）
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("[B4/D3c] running 候选接管（wasClosed=false）→ 仍 acquire marker（接管即声明，B/C 双写窗封住）", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    // 「接管即声明」：running 接管形态无终态位可删，但 acquire 照做——A 崩溃（marker
    // pid 死）→ B 接管刷新 pid=B → C 再触达被拦（S8⑤ 验收锚点的磁盘侧前置）。
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "sa-cold-1" });
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  it("[A3/S3] 冷查重建透传来源身份：workflow 批成员候选（origin+parentRunId）复活后保留——否则绕过 messageHandler one-shot 检查；tool 候选缺省 → 仍 undefined", () => {
    const sessionFile = writeSessionFixture();
    const wfDeps = makeDeps({
      disk: [makeFound({ sessionFile, origin: "workflow", parentRunId: "wf-run-1" })],
    });

    const wfRecord = coldLookupForAction(wfDeps, "sa-cold-1", true)!;

    // workflow 批成员收尾归档出内存后，message 冷复活必须带着 origin 进检查
    //（subagent-actions-core messageHandler 按 record.origin === "workflow" 拒绝）
    expect(wfRecord.origin).toBe("workflow");
    expect(wfRecord.parentRunId).toBe("wf-run-1");

    // tool 来源候选（无 origin）缺省形态不破坏：两字段 undefined 透传为 undefined
    const toolDeps = makeDeps({ disk: [makeFound({ sessionFile })] });
    const toolRecord = coldLookupForAction(toolDeps, "sa-cold-1", true)!;
    expect(toolRecord.origin).toBeUndefined();
    expect(toolRecord.parentRunId).toBeUndefined();
  });
});

// ============================================================
// [U6 / §3.2.6] transcript 锚引擎分派：transcriptAnchorOf 派生单点 +
// isAnchorResolvable 的 zcode 分支（隔离库条目存在性，内嵌只读 sqlite 查询）。
// fixture：真实 node:sqlite 建 tmp 库（mkdtempSync 自建自删）。
// ============================================================

describe("[U6] transcriptAnchorOf / isAnchorResolvable 引擎分派", () => {
  let zcodeDir: string;
  let zcodeDb: string;
  // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
  const zcodeDirs: string[] = [];

  beforeEach(() => {
    zcodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-zcode-"));
    zcodeDirs.push(zcodeDir);
    zcodeDb = path.join(zcodeDir, "db.sqlite");
  });

  afterAll(() => {
    for (const d of zcodeDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 最小隔离库（session 表 + 目标条目）。 */
  async function seedZcodeDb(sessionIds: string[]): Promise<void> {
    const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
    type Db = { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void }; close: () => void };
    const db = new DatabaseSync(zcodeDb) as unknown as Db;
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER)");
    for (const id of sessionIds) db.prepare("INSERT INTO session (id, time_created) VALUES (?, 1)").run(id);
    db.close();
  }

  it("zcode 锚（engineHandle.sessionRef 双键）→ 库条目在 = 可解析；条目被 TTL 清 / db 缺失 = 不可解析", async () => {
    await seedZcodeDb(["sess_z_1"]);
    const rec = {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "sess_z_1", dbPath: zcodeDb }, poolKey: "shared" },
    };
    expect(transcriptAnchorOf(rec)).toEqual({ engine: "zcode", sessionId: "sess_z_1", dbPath: zcodeDb });
    expect(isAnchorResolvable(rec)).toBe(true);

    const swept = {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "sess_swept", dbPath: zcodeDb }, poolKey: "shared" },
    };
    expect(isAnchorResolvable(swept)).toBe(false); // 条目不存在（TTL 清理后的锚失效形态）

    const noDb = {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "sess_z_1", dbPath: path.join(zcodeDir, "nope.sqlite") }, poolKey: "shared" },
    };
    expect(isAnchorResolvable(noDb)).toBe(false); // db 文件缺失（fail-closed）
  });

  it("zcode 锚查询异常（库文件存在但读不了）→ false + warn 留痕（库路径 + sessionId）", async () => {
    const corruptDb = path.join(zcodeDir, "corrupt.sqlite");
    fs.writeFileSync(corruptDb, "definitely not a sqlite database", "utf8");
    loggerMock.warn.mockClear();

    const rec = {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "sess_corrupt", dbPath: corruptDb }, poolKey: "shared" },
    };
    expect(isAnchorResolvable(rec)).toBe(false); // fail-closed 方向保留

    const warnCalls = loggerMock.warn.mock.calls;
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0]?.[0])).toContain("zcode 锚存在性查询异常");
    expect(warnCalls[0]?.[1]).toMatchObject({ dbPath: corruptDb, sessionId: "sess_corrupt" });
  });

  it("pi 锚现行判据不变：sessionFile 在盘可读（`{sessionFile}` 字面量入参兼容）", () => {
    const sessionFile = path.join(zcodeDir, "anchor.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    expect(isAnchorResolvable({ sessionFile })).toBe(true);
    expect(isAnchorResolvable({ sessionFile: path.join(zcodeDir, "gone.jsonl") })).toBe(false);
    expect(transcriptAnchorOf({ sessionFile })).toEqual({ engine: "pi", sessionFile });
  });

  it("显式 transcriptRef 优先；锚缺失（三载体皆无）→ undefined / false", () => {
    const explicit = {
      sessionFile: "/should/be/ignored.jsonl",
      transcriptRef: { engine: "zcode" as const, sessionId: "s1", dbPath: "/no-db.sqlite" },
    };
    expect(transcriptAnchorOf(explicit)).toEqual({ engine: "zcode", sessionId: "s1", dbPath: "/no-db.sqlite" });
    expect(isAnchorResolvable(explicit)).toBe(false);
    expect(transcriptAnchorOf({})).toBeUndefined();
    expect(isAnchorResolvable({})).toBe(false);
  });

  it("[U6] 冷查重建水合：zcode 候选（engineHandle.sessionRef）→ record.transcriptRef 落位（markResurrected 注入桩——zcode 无 sessionFile 锚，真实 store 写权声明侧的 zcode 接线属后续单元）", () => {
    const deps: ColdLookupDeps = {
      findLightById: vi.fn(() =>
        makeFound({
          status: "idle",
          sessionFile: undefined,
          engine: "zcode",
          engineHandle: { sessionRef: { sessionId: "sess_cold_z", dbPath: "/absent.sqlite" }, poolKey: "shared" },
        }),
      ),
      collectRecords: vi.fn(() => []),
      register: vi.fn(),
      reportRecordTransition: vi.fn(),
      markResurrected: vi.fn(),
      getSessionRootId: vi.fn(() => "root-session"),
      getBaselineRecordId: vi.fn(() => undefined),
    };
    const record = coldLookupForAction(deps, "sa-cold-1", true)!;
    expect(record.transcriptRef).toEqual({ engine: "zcode", sessionId: "sess_cold_z", dbPath: "/absent.sqlite" });
  });

  it("[A3/S3] 冷查重建水合引擎域：zcode 候选（engine + engineHandle）→ record.engine / record.engineHandle 在场（否则 resolveRoundEnginePort 按 engine ?? 'pi' 错投 pi 引擎）", () => {
    const engineHandle = { sessionRef: { sessionId: "sess_cold_z", dbPath: "/absent.sqlite" }, poolKey: "shared" };
    const deps: ColdLookupDeps = {
      findLightById: vi.fn(() =>
        makeFound({
          status: "idle",
          sessionFile: undefined,
          engine: "zcode",
          engineHandle,
        }),
      ),
      collectRecords: vi.fn(() => []),
      register: vi.fn(),
      reportRecordTransition: vi.fn(),
      markResurrected: vi.fn(),
      getSessionRootId: vi.fn(() => "root-session"),
      getBaselineRecordId: vi.fn(() => undefined),
    };
    const record = coldLookupForAction(deps, "sa-cold-1", true)!;
    // engine 域（identity）：消费方 resolveRoundEnginePort 分派依据，缺省即错投 pi
    expect(record.engine).toBe("zcode");
    // engineHandle 域（run 后回填的引擎定位符）：record → SubagentRecord 派生视图 / 锚派生
    // 单源（transcriptAnchorOf 消费方），重建后须在场
    expect(record.engineHandle).toBe(engineHandle);
    // pi 候选缺省形态不破坏：engine/engineHandle 均 undefined 透传为 undefined
    const piDeps: ColdLookupDeps = {
      ...deps,
      findLightById: vi.fn(() => makeFound({ sessionFile: path.join(zcodeDir, "anchor.jsonl") })),
    };
    fs.writeFileSync(path.join(zcodeDir, "anchor.jsonl"), "{}\n", "utf-8");
    const piRecord = coldLookupForAction(piDeps, "sa-cold-1", true)!;
    expect(piRecord.engine).toBeUndefined();
    expect(piRecord.engineHandle).toBeUndefined();
  });
});
// 来源段：get-record-for-action-restart.test.ts
//
// [M10] getRecordForAction 跨重启磁盘重建分支测试（cold-lookup.coldLookupForAction）。
//
// 背景：内存 miss → collectRecords(1000,"all",undefined).find(status==="running") →
// createRecord({chatMode: 持久化值}) → register → 回填 sessionFile/round。
// [H1 U6] 原「无条件 chatMode: true」（v4 A-3）已改水合保留持久化 chatMode
//（D4/D5：升级置位迁 Continuation revive 格 + messageHandler gate 双写点）。
// 该分支含多个仅此处独有的决策：
//   - chatMode 水合保留（磁盘无持久化 → false；升级在 message 链 gate 化）
//   - rootSessionFilter 传 undefined 后置校验（异树仍 throw not owned）
//   - sessionFile/round 从磁盘重建结果回填（round 无磁盘持久化 → undefined）
//
// fixture 构造参照 record-store.test.ts 的 writeSessionJsonl（真实 .jsonl 文件，
// identity custom entry + assistant message；无终态收条帧 → 重建兜底 idle +
// interrupted-by-restart，冷查接管后翻 running 跨重启可续聊态）。


/** 写一个最小合法 session.jsonl（session header + identity entry + 1 条 assistant message）。
 *  不写任何终态收条（.alive / 事件流 record-settled 帧）→ 重建兜底 idle，冷查接管翻 running。 */
function writeSessionJsonl(
  sessionsDir: string,
  identity: {
    id: string;
    rootSessionId: string;
    parentRecordId?: string;
    depth?: number;
    chatMode?: boolean;
    worktree?: boolean;
    origin?: "workflow";
    parentRunId?: string;
  },
): string {
  const file = path.join(sessionsDir, `${identity.id}.jsonl`);
  const startedAt = 1_700_000_000_000;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-uuid",
      timestamp: new Date(startedAt).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "custom",
      id: "id-1",
      parentId: null,
      timestamp: new Date(startedAt).toISOString(),
      customType: "subagent-identity",
      data: {
        id: identity.id,
        agent: "general-purpose",
        mode: "background",
        task: "restart recovery task",
        slug: "restart-test",
        startedAt,
        rootSessionId: identity.rootSessionId,
        ...(identity.parentRecordId !== undefined ? { parentRecordId: identity.parentRecordId } : {}),
        ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
        ...(identity.chatMode !== undefined ? { chatMode: identity.chatMode } : {}),
        ...(identity.worktree !== undefined ? { worktree: identity.worktree } : {}),
        ...(identity.origin !== undefined ? { origin: identity.origin } : {}),
        ...(identity.parentRunId !== undefined ? { parentRunId: identity.parentRunId } : {}),
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "id-1",
      timestamp: new Date(startedAt + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first round done" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: startedAt + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 暴露私有 store 供断言 register 副作用。 */
interface ServiceInternals { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  store: RecordStore;
}

describe("[M10] getRecordForAction 跨重启磁盘重建（S3 回归场景）", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;
  let service: SubagentService;
  let store: RecordStore;
  // [round6 慢用例治理] 删除推迟 afterAll：每例 mkdtempSync 独占目录（隔离不变），
  // fire 写与删除的间隔更长（原逐例删除紧贴用例结束，ENOTEMPTY 竞态窗口更大）。
  const restartDirs: string[] = [];

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-recon-"));
    restartDirs.push(agentDir);
    // [session-store-layout-inversion] 生产 store 目录经
    // getSubagentSessionDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
    // stubEnv 把写删目标收进本 mkdtemp 目录（自建自删红线）。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
    sessionsDir = getSubagentSessionDir("root-session", agentDir);
    recordsDir = getSubagentRecordsDir("root-session", agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    // 根进程身份：无 env → sessionRootId = sessionId（自己是 root）、execCtxBaseline = null
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllEnvs();
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  afterAll(() => {
    // maxRetries：collectRecords 触发的 fire-and-forget sessions-index 写可能与删除
    // 并发（ENOTEMPTY 竞态，全量并行跑时机器负载高会放大窗口）
    for (const d of restartDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("内存 miss + 磁盘 running（无 .alive）→ 重建 record：chatMode 水合保留（无持久化为 false，[H1 U6]）、sessionFile 回填、register 进内存", () => {
    // identity entry 故意不带 chatMode 字段——证明重建分支只水合持久化 chatMode
    //（[H1 U6] 无条件置位已迁 Continuation revive 格 + gate；one-shot 跨重启重建
    // false 后经 message 链 gate 升级置位）
    const file = writeSessionJsonl(sessionsDir, { id: "sa-restart-1", rootSessionId: "root-session" });
    expect(store.getMutable("sa-restart-1")).toBeUndefined(); // 前置：内存确无

    const record = service.chatActions.getRecordForAction("sa-restart-1");

    // [modeless 波1] chatMode 水合丢弃：磁盘无（或有）该键均不进内存 record
    //（message 资格只看引擎轴，与 record 无关）
    // sessionFile 从磁盘重建结果回填
    expect(record.sessionFile).toBe(file);
    // round 从 found 回填：light 磁盘重建无 round（内存态字段，跨重启不恢复）→ undefined
    expect(record.round).toBeUndefined();
    // 身份字段从磁盘 identity entry 回填
    expect(record.agent).toBe("general-purpose");
    expect(record.task).toBe("restart recovery task");
    expect(record.slug).toBe("restart-test");
    expect(record.rootSessionId).toBe("root-session");
    expect(record.parentRecordId).toBeUndefined();
    expect(record.status).toBe("running");
    // register 生效：进内存，二次调用走内存命中（同一引用）
    expect(store.getMutable("sa-restart-1")).toBe(record);
    expect(service.chatActions.getRecordForAction("sa-restart-1")).toBe(record);
  });

  it("rootSessionId 校验仍生效：异树 record（other-session）→ throw not found or not owned", () => {
    // rootSessionFilter 传 undefined（扫全量磁盘），异树 record 会被 find 命中并重建，
    // 但后置校验 record.rootSessionId !== this.sessionRootId 必须拦截
    writeSessionJsonl(sessionsDir, { id: "sa-foreign", rootSessionId: "other-session" });

    expect(() => service.chatActions.getRecordForAction("sa-foreign")).toThrow(/not found or not owned/);
  });

  it("直接父校验仍生效：孙级 record（parentRecordId=sa-parent）→ 主进程 throw direct parent", () => {
    writeSessionJsonl(sessionsDir, {
      id: "sa-grand",
      rootSessionId: "root-session",
      parentRecordId: "sa-parent",
      depth: 2,
    });

    // 重建后 parentRecordId=sa-parent ≠ 主进程 baseline(undefined) → cross-layer 检查拦截
    expect(() => service.chatActions.getRecordForAction("sa-grand")).toThrow(/direct parent/);
  });

  it("[U4 万物可续] 事件流终态收条（record-settled 帧）→ 冷查重建放行（idle 全候选，停因只是展示位）", () => {
    const file = writeSessionJsonl(sessionsDir, { id: "sa-fin", rootSessionId: "root-session" });
    // 终态收条已换源到事件流（`.state` sidecar 退场）；结算形态 = 冷查重建的 idle 候选。
    seedTerminalRecordForSessionFile(file, recordsDir, { stopReason: "disconnected" });

    const record = service.chatActions.getRecordForAction("sa-fin");
    expect(record.status).toBe("running"); // 接管翻边
    expect(record.sessionFile).toBe(file);
    expect(store.getMutable("sa-fin")).toBe(record); // 重建注册
  });

  it("[a3rv 归因] workflow-origin record 归档后、索引未预热（无 list 前置）→ 冷查仍能定位（origin 过滤只属展示侧，D7 检查可达）", () => {
    // 复现 a3rv 重验：批成员收尾（idle+gc）归档出内存后直接 message（无 action:'list'
    // 预热 idToFile 索引）。修复前冷查兜底全扫吃 [H2 W1] origin 展示过滤 → 同树
    // workflow record 被滤 → 候选 undefined → 「not found or not owned」上转，
    // endedMessageGuard 误分流「different session tree」；D7 workflow-origin 检查
    // 不可达。修复后冷查口径 includeWorkflow:true（治理语义），候选定位成功，
    // origin/parentRunId 随 resurrectColdRecord 透传（1543b39c1）。
    const file = writeSessionJsonl(sessionsDir, {
      id: "sa-wf-member",
      rootSessionId: "root-session",
      origin: "workflow",
      parentRunId: "wf-test-run",
    });
    seedTerminalRecordForSessionFile(file, recordsDir, { stopReason: "gc" }); // GC 收尾终态 → 重建 idle（可续候选）

    // 前置：内存确无（归档形态）；且未跑过任何 collectRecords（索引未热——与 a3rv
    // 剧本一致，list 预热会走 findLightById 直查，掩盖不了本缺陷的兜底全扫口径）
    expect(store.getMutable("sa-wf-member")).toBeUndefined();

    const record = service.chatActions.getRecordForAction("sa-wf-member", { allowReconnect: true });

    // 候选定位成功 + 身份域透传：messageHandler 的 D7 检查读 origin==="workflow"
    // 给出正确域边界拒绝（而非归属误导文案）
    expect(record.origin).toBe("workflow");
    expect(record.parentRunId).toBe("wf-test-run");
    expect(record.rootSessionId).toBe("root-session");
    expect(record.sessionFile).toBe(file);
  });

  // ============================================================
  // [review round2] 跨重启 worktree 绑定丢失防护
  // ============================================================
  // 场景：worktree:true 的 subagent 在父进程重启后续聊。WorktreeHandle
  // 不可序列化、重建后恒缺失，若无检查 → 冷路径 resume 的 spawn cwd 静默回落主 repo
  //（隔离失效，正是 worktree 要防的并发写冲突场景）。
  it("[review round2] worktree record 跨重启重建 → hadWorktree 标记 + 续聊被拒（行动语言）", async () => {
    clearEngines();
    const fake = registerFakePiEngine();
    // [H1 U6] 每轮 = 新 run + resume 锚点（旧 interact 冷路径替身注入随 interact 面退役），
    // 续聊检查链归 Continuation（dispatchRoundGuarded）。
    writeSessionJsonl(sessionsDir, {
      id: "sa-wt",
      rootSessionId: "root-session",
      worktree: true,
    });

    // [U4] worktree 绑定丢失的拒绝点前移到冷查准入检查（assertAdmissionAllowed——
    // 重建候选统一检查；[U5 接管] 拒绝动作将改为 worktree 自动重建 + patch 恢复）
    expect(() => service.chatActions.getRecordForAction("sa-wt")).toThrow(ResurrectDeniedError);
    await expect(async () => service.chatActions.getRecordForAction("sa-wt")).rejects.toThrow(
      /worktree isolation/,
    );
  });

  it("[review round2] 非 worktree record 跨重启重建 → 续聊不受 worktree 检查拦截（向后兼容）", async () => {
    clearEngines();
    const fake = registerFakePiEngine();
    // identity entry 无 worktree 字段（旧文件）→ found.worktree undefined → hadWorktree false
    writeSessionJsonl(sessionsDir, { id: "sa-nowt", rootSessionId: "root-session" });

    const record = service.chatActions.getRecordForAction("sa-nowt");
    expect(record.hadWorktree).toBe(false);

    // 冷路径续聊不被 worktree 检查拦截（resume 正常发起；后续 spawn 编排
    // 超出本用例关注点——runSpawn 在本文件是 no-op mock）
    await expect(service.chatActions.deliverChatMessage(record, "resume normal")).resolves.toBeUndefined();
  });
});
// 来源段：permanent-session-universal-resume.test.ts
//
// [U4 / §3.2.3 准入判据切换] 万物可续集成矩阵（验收条款 4 对应）：
//   ① 停因（旧 closedReason 7 值，均 ∈ StopReason）× message → 全部放行或自动降级
//      reopen（形态枚举 gate 消亡）；
//   ② 唯一拒绝 = 异进程活实例（ResurrectDeniedError 文案含 pid，统一占用句式）；
//   ③ reopen 触发：锚失效 + message → markReopened（round 归零 + epoch+1 +
//      stopReason=reopened + binding 落盘）+ resume:undefined + 摘要 prompt 注入；
//   ④ 归属拒绝（跨 session 树 not owned）保留（§3.2.3 判据三）。
//   ⑤ buildReopenSummaryPrompt 模板契约锁定（摘要来源 = task/agent/round/
//      totalTokens/turns + 末轮 result；缺省 fail-soft）。
//
// mock 手法：registerFakePiEngine 协议替身 + 真实 store/state-marker/alive-store
//（fixture 用临时目录写真实 .jsonl + 事件流终态帧（.events）+ .record-binding，
// 自建自删，不触碰真实数据目录——测试红线）。


/** 写最小合法 subagent session.jsonl（session header + identity entry + assistant
 *  message——transcript 有历史，锚可解析）。 */
function writeResumeSessionJsonl(
  sessionsDir: string,
  identity: { id: string; rootSessionId: string; task?: string },
): string {
  const file = path.join(sessionsDir, `${identity.id}.jsonl`);
  const startedAt = 1_700_000_000_000;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-uuid",
      timestamp: new Date(startedAt).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "custom",
      id: "id-1",
      parentId: null,
      timestamp: new Date(startedAt).toISOString(),
      customType: "subagent-identity",
      data: {
        id: identity.id,
        agent: "general-purpose",
        mode: "background",
        task: identity.task ?? "prior task body",
        slug: identity.id.replace(/^sa-/, ""),
        startedAt,
        rootSessionId: identity.rootSessionId,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "id-1",
      timestamp: new Date(startedAt + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior result text" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: startedAt + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 写 .alive marker（异进程活实例 fixture）。 */
function writeAliveMarkerFixture(sessionFile: string, pid: number, startedAt: number): void {
  fs.writeFileSync(
    `${sessionFile}.alive`,
    `${JSON.stringify({ pid, id: path.basename(sessionFile, ".jsonl"), startedAt })}\n`,
    "utf-8",
  );
}

describe("[U4 / §3.2.3] 万物可续矩阵：closedReason × message + 唯一拒绝 + reopen 降级 + 归属", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;
  let service: SubagentService;
  let pi: PiMock;
  let fake: FakePiEnginePort;
  // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
  const universalDirs: string[] = [];

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-universal-"));
    universalDirs.push(agentDir);
    // [session-store-layout-inversion] 生产 store 目录经
    // getSubagentSessionDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
    // stubEnv 把写删目标收进本 mkdtemp 目录（自建自删红线）；分区键 = initSession sid。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
    sessionsDir = getSubagentSessionDir("root-session-cur", agentDir);
    recordsDir = getSubagentRecordsDir("root-session-cur", agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    // modelRegistry stub：fork-from → service.execute 全链 resolveIdentity 需要
    //（modelRefFromVerified 调 source.getAvailable()，缺省时炸 TypeError）。
    const modelRegistry = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session-cur" });
    fake = registerFakePiEngine();
  });

  afterEach(async () => {
    service.dispose();
    clearEngines();
    await new Promise((r) => setTimeout(r, 0));
    vi.unstubAllEnvs();
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  afterAll(() => {
    for (const d of universalDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── ① closedReason（旧 7 值）× message：全部放行（可重连集 gate 消亡）──────

  it.each([
    "disconnected",
    "parent-shutdown",
    "user-close",
    "cancelled",
    "gc",
    "parent-fork",
    "parent-new",
  ] as const)("停因=%s（旧 closedReason 值）的磁盘 record 收 message → 同 id 续聊（resume 触达原文件）", async (reason) => {
    const file = writeResumeSessionJsonl(sessionsDir, { id: `sa-u4-${reason}`, rootSessionId: "root-session-cur" });
    // 终态收条已换源到事件流（record-settled 帧）——`.state` sidecar 退场。
    seedTerminalRecordForSessionFile(file, recordsDir, { stopReason: reason });

    const result = await messageHandler(service, { subagentId: `sa-u4-${reason}`, text: "follow up" });
    expect(result.response.delivered).toBe(true);
    expect(result.subagentId).toBe(`sa-u4-${reason}`); // 同 id，不开新 record

    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // resume 锚点 = 原 sessionFile 续写（锚可解析 → 非 reopen 降级）
    expect(fake.runs[0]!.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
    expect(fake.runs[0]!.task.prompt).toBe("follow up");

    // 翻边 running + 旧终态遗留位清除（closedReason 判据经全态快照确认）
    const snap = service.queries.findRecord(`sa-u4-${reason}`);
    expect(snap?.status).toBe("running");
    const full = service.queries.lookupRecordAnyState(`sa-u4-${reason}`);
    expect(full?.closedReason).toBeUndefined();
  });

  // ── ② 唯一拒绝 = 异进程活实例 ────────────────────────────────────────────

  it("异进程活实例（.alive + 恒活外部 pid）→ ResurrectDeniedError 含 pid 的统一占用句式（唯一拒绝形态）", async () => {
    const file = writeResumeSessionJsonl(sessionsDir, { id: "sa-u4-alive", rootSessionId: "root-session-cur" });
    seedTerminalRecordForSessionFile(file, recordsDir, { stopReason: "disconnected" });
    writeAliveMarkerFixture(file, FOREIGN_LIVE_PID, Date.now());
    expect(findForeignLiveInstance(file)).toBeDefined(); // 探针前置自检

    const err = await messageHandler(service, { subagentId: "sa-u4-alive", text: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResurrectDeniedError);
    const msg = (err as Error).message;
    expect(msg).toContain(`pid ${FOREIGN_LIVE_PID}`);
    expect(msg).toContain("is writing this session");
    expect(msg).toContain("close it or wait for it to exit, then retry");
    // 不派发、不注册内存
    expect(fake.runs.length).toBe(0);
    expect(service.queries.findRecord("sa-u4-alive")).toBeUndefined();
  });

  // ── ③ reopen 降级：锚失效 + message ─────────────────────────────────────

  it("锚失效（内存 idle record 的 transcript 被回收）+ message → markReopened：round 归零 + epoch+1 + stopReason=reopened + 新锚 binding + 摘要注入 + resume:undefined", async () => {
    // 场景构造：冷查重建（内存 idle record，锚文件在盘）→ 删除 transcript 文件
    //（模拟 30 天 GC 回收）→ message。可达性说明：record 出内存 + 文件被删 = 冷查
    // 找不到（磁盘重建源 = jsonl/manifest）——「锚失效 + message」的现实触发范围 =
    // record 仍在内存（或 manifest 源重建）而 transcript 被回收。
    const file = writeResumeSessionJsonl(sessionsDir, { id: "sa-u4-reopen", rootSessionId: "root-session-cur" });
    const record = service.chatActions.getRecordForAction("sa-u4-reopen");
    // 模拟既往轮次状态（binding 快照域有值——摘要来源）
    record.status = "idle";
    record.round = 1;
    record.result = "round one conclusion";
    record.turnCount = 7;
    record.totalTokens = 500;
    record.controller = new AbortController();

    fs.rmSync(file); // 锚失效：transcript 被 GC 回收

    const r = await service.chatActions.deliverChatMessage(record, "continue after gc").then(
      () => ({ delivered: true as const }),
      (e: unknown) => e,
    );
    expect(r).toEqual({ delivered: true });
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // 世代推进：round 归零 + epoch+1 + stopReason=reopened（markReopened 原语副作用）
    expect(record.status).toBe("running");
    expect(record.round).toBe(0);
    expect(record.epoch).toBe(1);
    // [U6/D4 轮始清点族扩字段] reopened 展示位随清点族退役——markReopened 写入的
    // stopReason='reopened' 被 revive 格同步清（重开信息由摘要 prompt 体感承载）。
    expect(record.stopReason).toBeUndefined();

    // resume:undefined（引擎开新 session——新锚由 run 应答回填）
    expect(fake.runs[0]!.ctx.resume?.resume).toBeUndefined();

    // 首轮 prompt = 历史摘要前缀 + 用户消息（§3.2.3 摘要来源契约）
    const prompt = fake.runs[0]!.task.prompt;
    expect(prompt).toContain("[Session reopened]");
    expect(prompt).toContain("- Completed rounds: 1");
    expect(prompt).toContain("- Usage so far: 500 tokens / 7 turns");
    expect(prompt).toContain("round one conclusion"); // 末轮 result 注入
    expect(prompt.endsWith("continue after gc")).toBe(true);

    // 新锚 binding 落盘（markReopened 内 writeRecordBinding——epoch 随 binding 持久化，
    // 跨重启单调防二次 reopen 击穿）
    const binding = readRecordBinding(record.sessionFile!);
    expect(binding?.recordId).toBe("sa-u4-reopen");
    expect(binding?.epoch).toBe(1);
    expect(binding?.transcriptRef).toMatchObject({ engine: "pi", sessionFile: record.sessionFile });
    expect(binding?.round).toBe(0);
  });

  // ── ④ 归属拒绝（跨 session 树）保留 ────────────────────────────────────

  it("跨 session 树 record（rootSessionId 异树）→ not owned 归属拒绝 + fork-from 分叉指引", async () => {
    writeResumeSessionJsonl(sessionsDir, { id: "sa-u4-foreigen", rootSessionId: "old-root-session" });

    const err = await messageHandler(service, { subagentId: "sa-u4-foreigen", text: "hi" }).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toMatch(/not found or not owned|belongs to a different session tree/);
    expect(fake.runs.length).toBe(0);
  });

  it("fork-from 对跨树源放行（锚可解析即分叉——fork-from 不做归属校验）", async () => {
    // 锚可解析：分叉新 id。[U4 检查 4 删除] 主动告别（user-close）源放行。
    const file = writeResumeSessionJsonl(sessionsDir, { id: "sa-u4-fk", rootSessionId: "old-root" });
    seedTerminalRecordForSessionFile(file, recordsDir, { stopReason: "user-close" });
    const r = await forkFromHandler(service, { sourceSubagentId: "sa-u4-fk", prompt: "branch off" });
    expect(r.response.newSubagentId).not.toBe("sa-u4-fk");
    expect(r.response.sourceSessionFile).toBe(file);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // 锚不可解析 → 引导 message reopen 的检查 5 文案，已在
    // subagent-actions-core.test.ts 单元面锁定（集成测试侧无独立构造价值：jsonl 删除后
    // record 随磁盘源消失，检查 2 先于检查 5 命中）。
  });
});

// ============================================================
// buildReopenSummaryPrompt 模板契约锁定（§3.2.3 摘要来源）
// ============================================================

describe("[U4] buildReopenSummaryPrompt 模板契约", () => {
  it("全字段：task/agent/round/totalTokens/turns/lastResult 全注入 + 用户消息在尾", () => {
    const p = buildReopenSummaryPrompt({
      id: "sa-x",
      task: "research abc lib",
      agent: "general-purpose",
      round: 4,
      totalTokens: 12_345,
      turns: 9,
      lastResult: "final answer was 42",
    });
    expect(p).toContain('[Session reopened]');
    expect(p).toContain('subagent "sa-x"');
    expect(p).toContain("SAME subagent id");
    expect(p).toContain("- Task: research abc lib");
    expect(p).toContain("- Agent: general-purpose");
    expect(p).toContain("- Completed rounds: 4");
    expect(p).toContain("- Usage so far: 12345 tokens / 9 turns");
    expect(p).toContain("- Last delivered result: final answer was 42");
    expect(p).toContain("Resume the work from this summary");
  });

  it("fail-soft：用量与 result 缺省 → 显式 not retained/unknown（不虚构数据）", () => {
    const p = buildReopenSummaryPrompt({ id: "sa-y", task: "t", agent: "a", round: 0 });
    expect(p).not.toContain("- Usage so far:"); // 用量缺省整行省略
    expect(p).toContain("- Last delivered result: (not retained)");
  });
});
