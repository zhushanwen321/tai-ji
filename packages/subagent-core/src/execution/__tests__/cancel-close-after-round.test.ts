// src/execution/__tests__/cancel-close-after-round.test.ts
//
// [区1-U2 修复回归] cancel / 编排性关闭打断作废 closeAfterRound 挂起——
// RecordLifecycle.cancelBackground 与 disposeAllRecords 的打断路径补
// `record.closeAfterRound = undefined`（对齐 one-shot 域 settleOneShotOutcome
// aborted 分支先例，run-orchestration.ts）。
//
// 缺陷链（修复前）：close(force:false) 挂起 → cancel 抢先 settle（status=idle、
// 挂起残留）→ 轮收敛回调 onRunSettled 被 status 守卫拦截（不清挂起）→ 用户
// message 开新轮 → 轮终 settleRoundSuccess gate 放行 → closeAfterRound===true →
// archiveAfterClosingRound 意外归档。违背 §3.2.5 cancel 语义「暂停这一轮（可以
// 继续聊）」——用户 cancel 后的正常续聊轮被自动收起。
//
// 集成面 = registerFakePiEngine 协议替身（与 conversation-continuation.test.ts
// 同源 setup 形态）。

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

import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";
import { _resetSettledWatchdogsForTest } from "../lifecycle/settled-watchdog.ts";
import { _resetLifecycleState } from "../lifecycle/lifecycle-manager.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../assembly/types.ts";

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
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-close-"));
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
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

/** chatMode 续聊 record（轮 1 已完成形态；sessionFile 在盘 = 锚可解析，续轮走 resume）。 */
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

describe("集成：cancel × closeAfterRound（[区1-U2] cancel / 编排性关闭打断作废优雅收口挂起）", () => {
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

  it("close 挂起 → cancel 抢先 settle（挂起作废）→ message 新轮 → 轮终不归档，intent 保持 active", async () => {
    const record = makeChatRecord("sa-cancel-close", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // close 优雅收口挂起（在飞轮不打断——closeAfterRound=true）。
    await service["closeSubagent"](record, false);
    expect(record.closeAfterRound).toBe(true);

    // cancel 抢先 settle：打断在飞轮 + settle interrupted——挂起随打断作废
    //（cancel 语义 = 暂停这一轮可以继续聊，与「收口下一轮」意愿相反）。
    const cancelled = service.cancel(record.id);
    expect(cancelled).toBe(true);
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted");
    expect(record.closeAfterRound).toBeUndefined();

    // 中断轮的收敛应答迟到：onRunSettled 被 status 守卫拦截（不簿记、不清队列）
    //——挂起清除只能由 cancel 侧承担（本修复的缺陷链环节）。
    fake.runs[0]!.settle({ content: "interrupted round partial" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 用户 message：cancel 后的正常续聊轮（寻回翻 active + 新轮派发）。
    await service.chatActions.deliverChatMessage(record, "new round after cancel");
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    fake.runs[1]!.settle({ content: "continuation reply" });

    // 轮终：通知送达但**不归档**——残留挂起会在此触发 archiveAfterClosingRound
    // 意外归档（intent 翻 "archived" = 回归失败信号）。cancel 不动 intent：record
    // 从未归档（intent=undefined，语义 = active，types.ts「undefined = active 存量
    // 零迁移」投影），寻回翻 active 只发生在 archived 之后。
    await vi.waitFor(() => expect(record.result).toBe("continuation reply"));
    expect(record.round).toBe(2);
    expect(record.closeAfterRound).toBeUndefined();
    expect(record.intent).not.toBe("archived");
  });

  it("close 挂起 → disposeAllRecords 编排性关闭（挂起作废 + 立即归档收起）", async () => {
    const record = makeChatRecord("sa-dispose-close", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    await service["closeSubagent"](record, false);
    expect(record.closeAfterRound).toBe(true);

    const count = service.disposeAllRecords("parent-fork");

    // 编排性关闭 = 立即打断 + settle interrupted-by-parent + 自动收起（archived）
    //——挂起（等轮终归档）意愿被立即归档完全取代，随打断作废。
    expect(count).toBe(1);
    expect(record.closeAfterRound).toBeUndefined();
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted-by-parent");
    expect(record.intent).toBe("archived");
  });
});
