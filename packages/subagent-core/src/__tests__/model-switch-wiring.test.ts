// src/__tests__/model-switch-wiring.test.ts
//
// [subagent-model-switch 一致性修复 r2/U4] setModel 生产接线三函数直驱单测
// （装配点 = subagent-service.setModel deps 闭包；本文件直接驱动
// model-switch-wiring.ts 的生产实装，不经编排桩注入）。
//
// 覆盖面（设计锚点 §7.2 步骤①附加校验 / §7.4 全切转发面 / §7.5「run 已终局」行）：
//   ① assertRunNotTerminalForSwitch：journal fold 终局判定——run-settled 四值
//      outcome 全拒（错误消息含 outcome 与 runId）；interrupted（显式转移帧 /
//      事件流停止两种形态）与 missing（空事件流）放行。
//   ② listAcceptedMemberRunIdsForSwitch：collectRecordsByParentRunId 三参透传
//      （runId / MODEL_SWITCH_MEMBER_LIST_LIMIT / rootSessionFilter）+ 产物映射
//      为成员 runId 清单。
//   ③ resolveMemberEnginePortForSwitch：pi 成员窗口键透传 parentRunId（与
//      routeWorkflowEngine 的 piEngine 注入同源）；非 pi 成员走
//      resolveWorkflowWindowEnginePort（routing mock 断言通道与参数面——通道本体
//      行为归 routing 自有测试域）；record / parentRunId 缺失 throw 归失败名单；
//      native 位 + setModel 方法缺席装配损坏守卫 fail-fast；非 native 引擎不被
//      守卫误伤；原生引擎锚 + engine 身份域丢失的 record 损坏经
//      resolveEngineRouteId 透传抛 RecordEngineIdentityError（与派发链同一裁决
//      单点）。
//
// 测试红线：journal/manifest 全在 mkdtemp tmp（setRunEventJournalDirForTest 注入
// + afterEach 复位）；无 fake timers；routing mock 的 factory 补齐同模块其他
// 导入方所需成员（terminal-actions 的 disposeWorkflowWindowEngineState）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EngineCapabilities,
  SetModelParams,
  SetModelResult,
} from "@zhushanwen/subagent-engine-sdk";

// routing mock：非 pi 成员的窗口实例解析通道断言面。factory 补齐
// disposeWorkflowWindowEngineState（terminal-actions 顶层导入，本测试不触达）。
const routingMock = vi.hoisted(() => ({
  resolveWorkflowWindowEnginePort: vi.fn(),
  disposeWorkflowWindowEngineState: vi.fn(),
}));
vi.mock("../execution/engine/routing.ts", () => ({
  resolveWorkflowWindowEnginePort: routingMock.resolveWorkflowWindowEnginePort,
  disposeWorkflowWindowEngineState: routingMock.disposeWorkflowWindowEngineState,
}));

import type { SubagentRecord } from "../execution/assembly/types.ts";
import { RecordEngineIdentityError } from "../execution/engine/common/session-view-service.ts";
import { DEFAULT_ENGINE_ID } from "../execution/engine/registry.ts";
import { createRecord } from "../execution/persistence/execution-record.ts";
import type { ExecutionRecord } from "../execution/domain/record-model.ts";
import {
  MODEL_SWITCH_MEMBER_LIST_LIMIT,
  assertRunNotTerminalForSwitch,
  listAcceptedMemberRunIdsForSwitch,
  resolveMemberEnginePortForSwitch,
} from "../execution/service/model-switch-wiring.ts";
import type { SetModelCapableEnginePort } from "../execution/service/run-model-switch-aggregate.ts";
import {
  createRunEventJournal,
  type RunEventJournal,
  type WorkflowRunEventInput,
} from "../orchestration/run-events.ts";
import { setRunEventJournalDirForTest } from "../orchestration/terminal-actions.ts";

// ============================================================
// ① assertRunNotTerminalForSwitch —— journal fold 直驱
// ============================================================

let dir: string;
let journal: RunEventJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-switch-wiring-"));
  // 模块 journal 单写者域注入（scanRunEvents 缺省走模块锚）——seed 侧本地实例与
  // 模块 journal 指向同一目录（文件层一致，run-registry.test.ts 同范式）。
  setRunEventJournalDirForTest(dir);
  journal = createRunEventJournal(dir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  routingMock.resolveWorkflowWindowEnginePort.mockReset();
  routingMock.disposeWorkflowWindowEngineState.mockReset();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const BASE_TS = 1_719_500_000_000;

async function seed(runId: string, events: readonly WorkflowRunEventInput[]): Promise<void> {
  for (const event of events) {
    await journal.append(runId, event);
  }
}

function createdEvent(runId: string, ts: number): WorkflowRunEventInput {
  return { type: "run-created", runId, workflowName: "review-fix-loop", argsSummary: "{}", ts };
}

function agentStartedEvent(ts: number): WorkflowRunEventInput {
  return { type: "agent-started", taskIndex: 1, agentName: "reviewer", attempt: 1, ts };
}

function runSettledEvent(
  outcome: "done" | "failed" | "cancelled" | "time_limited",
  ts: number,
): WorkflowRunEventInput {
  return { type: "run-settled", outcome, artifactsDir: dir, ts };
}

describe("assertRunNotTerminalForSwitch（§7.2 步骤①附加校验：终局 fail-fast）", () => {
  it.each(["done", "failed", "cancelled", "time_limited"] as const)(
    "run-settled（outcome=%s）→ throw，错误消息含 outcome 与 runId（§7.5「run 已终局」行）",
    async (outcome) => {
      const runId = `wf-term-${outcome}`;
      await seed(runId, [createdEvent(runId, BASE_TS), runSettledEvent(outcome, BASE_TS + 5)]);

      await expect(assertRunNotTerminalForSwitch(runId)).rejects.toThrow(
        new RegExp(`已终局（${outcome}）[\\s\\S]*runId=${runId}`),
      );
    },
  );

  it("run-interrupted 显式转移帧 → 放行（interrupted 非 terminal，中断后补切的合法场景）", async () => {
    const runId = "wf-wiring-interrupted";
    await seed(runId, [
      createdEvent(runId, BASE_TS),
      agentStartedEvent(BASE_TS + 1),
      { type: "run-interrupted", errorCode: "crashed", ts: BASE_TS + 2 },
    ]);

    await expect(assertRunNotTerminalForSwitch(runId)).resolves.toBeUndefined();
  });

  it("事件流停止（running 快照、无终局帧、无活体集）→ 投影 interrupted → 放行", async () => {
    const runId = "wf-wiring-stalled";
    await seed(runId, [createdEvent(runId, BASE_TS), agentStartedEvent(BASE_TS + 1)]);

    await expect(assertRunNotTerminalForSwitch(runId)).resolves.toBeUndefined();
  });

  it("空事件流（missing）→ 放行（§7.2 步骤①只拦 terminal）", async () => {
    await expect(assertRunNotTerminalForSwitch("wf-wiring-missing")).resolves.toBeUndefined();
  });
});

// ============================================================
// ② listAcceptedMemberRunIdsForSwitch —— fake store 直驱
// ============================================================

function makeLightRecord(over: Partial<SubagentRecord> & { id: string }): SubagentRecord {
  return {
    agent: "reviewer",
    task: "t",
    slug: "s",
    status: "running",
    mode: "background",
    startedAt: 1,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 1,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: undefined,
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  };
}

describe("listAcceptedMemberRunIdsForSwitch（§7.4 全切转发面：三参透传 + id 映射）", () => {
  it("collectRecordsByParentRunId 收到 (runId, MODEL_SWITCH_MEMBER_LIST_LIMIT, rootSessionFilter)，产物映射为 id 清单", () => {
    const members = [
      makeLightRecord({ id: "bg-1", parentRunId: "run-1" }),
      makeLightRecord({ id: "bg-2", parentRunId: "run-1" }),
    ];
    const collect = vi.fn(() => members);
    const store = { collectRecordsByParentRunId: collect };

    const ids = listAcceptedMemberRunIdsForSwitch(store, "root-session-1", "run-1");

    expect(collect).toHaveBeenCalledWith("run-1", MODEL_SWITCH_MEMBER_LIST_LIMIT, "root-session-1");
    expect(ids).toEqual(["bg-1", "bg-2"]);
  });

  it("rootSessionFilter undefined 缺省透传（宿主 sessionRootId ?? sessionId ?? undefined 的 undefined 形态）", () => {
    const collect = vi.fn((): SubagentRecord[] => []);
    const store = { collectRecordsByParentRunId: collect };

    const ids = listAcceptedMemberRunIdsForSwitch(store, undefined, "run-2");

    expect(collect).toHaveBeenCalledWith("run-2", MODEL_SWITCH_MEMBER_LIST_LIMIT, undefined);
    expect(ids).toEqual([]);
  });

  it("全状态不过滤（终态成员也在清单——已退出成员由引擎 not-active 应答承接）", () => {
    const members = [
      makeLightRecord({ id: "bg-live", status: "running" }),
      makeLightRecord({ id: "bg-done", status: "idle" }),
    ];
    const store = { collectRecordsByParentRunId: vi.fn(() => members) };

    const ids = listAcceptedMemberRunIdsForSwitch(store, undefined, "run-3");

    expect(ids).toEqual(["bg-live", "bg-done"]);
  });
});

// ============================================================
// ③ resolveMemberEnginePortForSwitch —— fake store + fake port + routing mock
// ============================================================

function capsWith(setModel: EngineCapabilities["setModel"]): EngineCapabilities {
  return {
    schemaEnforcement: "native",
    steer: "unsupported",
    conversation: "native",
    personaInjection: "flag",
    eventGranularity: "stream",
    sandbox: "emulated",
    sessionRead: "full",
    resume: "native",
    interrupt: "kill-only",
    permissionMode: "native",
    maxTurns: true,
    setModel,
  };
}

/** setModel 转发通道替身（接口面窄化为 wiring 触达的 capabilities/setModel）。 */
function fakeSwitchPort(
  setModel: EngineCapabilities["setModel"],
): SetModelCapableEnginePort {
  const port = {
    id: "fake",
    capabilities: () => capsWith(setModel),
    async setModel(_params: SetModelParams): Promise<SetModelResult> {
      throw new Error("fake port: setModel not expected in wiring tests");
    },
  };
  return port as SetModelCapableEnginePort;
}

/** pi 成员 ExecutionRecord（engine 缺席 = pi 缺省投影，createRecord 真实构造）。 */
function makeMemberRecord(id: string, over: { parentRunId?: string; engine?: string } = {}): ExecutionRecord {
  return createRecord(id, {
    agent: "reviewer",
    mode: "background",
    task: "t",
    slug: "s",
    startedAt: 1,
    parentRunId: over.parentRunId,
    engine: over.engine,
  });
}

describe("resolveMemberEnginePortForSwitch（U5 转发面：窗口键 + 路由 + 守卫）", () => {
  it("pi 成员：resolveChatEnginePort 收到的 windowKey === parentRunId（窗口键透传），返回同 port", () => {
    const port = fakeSwitchPort("native");
    const resolveChatEnginePort = vi.fn(() => port);
    const record = makeMemberRecord("bg-pi", { parentRunId: "run-window-1" });
    const store = { getMutable: vi.fn(() => record), findLightById: vi.fn(() => undefined), findByIdManifestFallback: vi.fn(() => undefined) };

    const resolved = resolveMemberEnginePortForSwitch(store, resolveChatEnginePort, "bg-pi");

    expect(resolveChatEnginePort).toHaveBeenCalledTimes(1);
    expect(resolveChatEnginePort).toHaveBeenCalledWith("run-window-1");
    expect(resolved).toBe(port);
  });

  it("getMutable miss → findLightById 回退命中（轻量快照路径同判）", () => {
    const port = fakeSwitchPort("native");
    const light = makeLightRecord({ id: "bg-light", parentRunId: "run-window-2" });
    const store = {
      getMutable: vi.fn(() => undefined),
      findLightById: vi.fn(() => light),
      findByIdManifestFallback: vi.fn(() => undefined),
    };

    const resolved = resolveMemberEnginePortForSwitch(
      store,
      vi.fn(() => port),
      "bg-light",
    );

    expect(resolved).toBe(port);
  });

  it("record 缺失（两源均 miss）→ throw（聚合归失败名单，不中断其余成员）", () => {
    const store = {
      getMutable: vi.fn(() => undefined),
      findLightById: vi.fn(() => undefined),
      findByIdManifestFallback: vi.fn(() => undefined),
    };

    expect(() =>
      resolveMemberEnginePortForSwitch(
        store,
        vi.fn(() => fakeSwitchPort("native")),
        "bg-missing",
      ),
    ).toThrow(/成员 record 不存在[\s\S]*bg-missing/);
  });

  it("parentRunId 留痕缺失 → throw（无法解析引擎窗口）", () => {
    const record = makeMemberRecord("bg-orphan", { parentRunId: undefined });
    const store = { getMutable: vi.fn(() => record), findLightById: vi.fn(() => undefined), findByIdManifestFallback: vi.fn(() => undefined) };

    expect(() =>
      resolveMemberEnginePortForSwitch(
        store,
        vi.fn(() => fakeSwitchPort("native")),
        "bg-orphan",
      ),
    ).toThrow(/缺少 parentRunId 留痕[\s\S]*bg-orphan/);
  });

  it(`非 pi 成员（engine="zcode"）→ 走 resolveWorkflowWindowEnginePort(parentRunId, engineId)，不经 chat 通道`, () => {
    const port = fakeSwitchPort("unsupported");
    routingMock.resolveWorkflowWindowEnginePort.mockReturnValue(port);
    const record = makeMemberRecord("bg-zcode", { parentRunId: "run-window-3", engine: "zcode" });
    const store = { getMutable: vi.fn(() => record), findLightById: vi.fn(() => undefined), findByIdManifestFallback: vi.fn(() => undefined) };
    const resolveChatEnginePort = vi.fn();

    const resolved = resolveMemberEnginePortForSwitch(store, resolveChatEnginePort, "bg-zcode");

    expect(resolveChatEnginePort).not.toHaveBeenCalled();
    expect(routingMock.resolveWorkflowWindowEnginePort).toHaveBeenCalledTimes(1);
    expect(routingMock.resolveWorkflowWindowEnginePort).toHaveBeenCalledWith(
      "run-window-3",
      "zcode",
    );
    expect(resolved).toBe(port);
  });

  it("native 位 + setModel 方法缺席 → throw（装配损坏 fail-fast，归失败名单）", () => {
    // 集成 bug 形态：capabilities 声明 native 但方法未挂——运行时对象层面模拟。
    const brokenPort = {
      id: "fake",
      capabilities: () => capsWith("native"),
    } as unknown as SetModelCapableEnginePort;
    const record = makeMemberRecord("bg-broken", { parentRunId: "run-window-4" });
    const store = { getMutable: vi.fn(() => record), findLightById: vi.fn(() => undefined), findByIdManifestFallback: vi.fn(() => undefined) };

    expect(() =>
      resolveMemberEnginePortForSwitch(store, vi.fn(() => brokenPort), "bg-broken"),
    ).toThrow(/setModel=native[\s\S]*no[\s\S]*setModel method[\s\S]*bg-broken/);
  });

  it("capability 非 native（unsupported）不触发守卫——放行返回（聚合层预检先行，非 pi 路由同样适用）", () => {
    // 守卫只拦「native 位 + 方法缺席」组合；unsupported 引擎成员必须到达聚合预检
    // 落 not-applicable（§8 场景 7 步骤④），拦在 wiring 会错位进失败名单。
    const port = fakeSwitchPort("unsupported");
    const record = makeMemberRecord("bg-legacy", { parentRunId: "run-window-5" });
    const store = { getMutable: vi.fn(() => record), findLightById: vi.fn(() => undefined), findByIdManifestFallback: vi.fn(() => undefined) };

    const resolved = resolveMemberEnginePortForSwitch(store, vi.fn(() => port), "bg-legacy");

    expect(resolved).toBe(port);
  });

  it("engine 身份域丢失（原生锚 dbPath 在、engine 缺席）→ 透传 RecordEngineIdentityError（与派发链同一裁决单点）", () => {
    const light = {
      ...makeLightRecord({ id: "bg-corrupt", parentRunId: "run-window-6" }),
      engineHandle: { sessionRef: { dbPath: "/tmp/zcode-db.sqlite" }, poolKey: "shared" },
    };
    const store = {
      getMutable: vi.fn(() => undefined),
      findLightById: vi.fn(() => light),
      findByIdManifestFallback: vi.fn(() => undefined),
    };

    expect(() =>
      resolveMemberEnginePortForSwitch(
        store,
        vi.fn(() => fakeSwitchPort("native")),
        "bg-corrupt",
      ),
    ).toThrow(RecordEngineIdentityError);
  });

  it(`路由判据锚定：engine 缺席 = ${DEFAULT_ENGINE_ID} 缺省（存量 record 零迁移）`, () => {
    const port = fakeSwitchPort("native");
    const record = makeMemberRecord("bg-default", { parentRunId: "run-window-7" });
    const store = { getMutable: vi.fn(() => record), findLightById: vi.fn(() => undefined), findByIdManifestFallback: vi.fn(() => undefined) };
    const resolveChatEnginePort = vi.fn(() => port);

    resolveMemberEnginePortForSwitch(store, resolveChatEnginePort, "bg-default");

    // 缺省路由走 chat 通道（窗口感知形态）而非 routing 表——pi 成员窗口键 = parentRunId。
    expect(resolveChatEnginePort).toHaveBeenCalledWith("run-window-7");
    expect(routingMock.resolveWorkflowWindowEnginePort).not.toHaveBeenCalled();
  });

  it("三源兜底（D3 缺陷五回归）：内存/文件扫描双 miss 的 zcode 成员经 manifest 兜底解析端口——不再误入失败名单", () => {
    const port = fakeSwitchPort("unsupported");
    routingMock.resolveWorkflowWindowEnginePort.mockReturnValue(port);
    // zcode 成员 settle 后出内存、无子 session 文件不在扫描集——唯一磁盘载体 =
    // bound 物化的 manifest（boundMaterialize 写点产物，投影含 parentRunId/engine）。
    const manifestSourced = makeLightRecord({
      id: "bg-zc-settled",
      parentRunId: "run-window-8",
      engine: "zcode",
    });
    const store = {
      getMutable: vi.fn(() => undefined),
      findLightById: vi.fn(() => undefined),
      findByIdManifestFallback: vi.fn(() => manifestSourced),
    };
    const resolveChatEnginePort = vi.fn();

    const resolved = resolveMemberEnginePortForSwitch(store, resolveChatEnginePort, "bg-zc-settled");

    expect(store.findByIdManifestFallback).toHaveBeenCalledWith("bg-zc-settled");
    expect(resolveChatEnginePort).not.toHaveBeenCalled();
    expect(routingMock.resolveWorkflowWindowEnginePort).toHaveBeenCalledWith(
      "run-window-8",
      "zcode",
    );
    expect(resolved).toBe(port);
  });
});
