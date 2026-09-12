// src/execution/__tests__/delivery-methods.test.ts
//
// 会话形态续聊投递单元测试（M2-B1 投递基础设施 → H1 chat-run 统一定形）。
//
// [W3 改写] 投递链路协议化：deliverChatMessage → pi EnginePort（registry cli 形态
// port 的替身 registerFakePiEngine）。
// [H1 U2/U6 改写] 每轮 = 新 run + resume 锚点（ctx.resume，键切换后唯一会话形态键），
// Continuation 单飞承接防双写者守卫（原 resumeColdRound resumesInFlight 守卫退役）；
// 轮末分流 = run 应答驱动（onRunSettled，D7）——[H1 U6] 旧 interact 热路径/冷路径
// 分流与 settleChatRoundFromResponse 结算载体的断言段随载体退役删除。
// 原 inproc stdin 字节断言（sendPromptCommand/streamingBehavior/EPIPE 写后死检测）
// 随 inproc pi 引擎目录 删除归 pi-subagent-cli 包内测试。
//
// 本文件断言的编排语义（守卫/状态迁移/单飞隔离）与改线前逐点同构。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import * as lifecycle from "../lifecycle-manager.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { SubagentService } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delivery-test-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(() => {}),
    events: { emit: vi.fn(() => {}) },
    sendMessage: vi.fn(() => {}),
  };
}

/** chatMode idle record（第一轮已完成，等待续聊）。sessionFile 由调用方覆盖为 agentDir 下路径。 */
function makeIdleRecord(id = "sa-chat"): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "chat",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
  });
  // v4 B-1：idle 折入 running。"等待续聊"态现为 status="running"（isIdle/isResumable 派生谓词区分）。
  record.status = "running";
  record.round = 1;
  record.controller = new AbortController();
  return record;
}

describe("会话形态续聊投递（run + resume 锚点）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    // sessionFile 用 agentDir 下路径（finalizeRoundToIdle 写 .idle sidecar 不留 /tmp 垃圾）
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // [U2a/B5] 轮终簿记归口 store.markRoundIdle（按 id 查内存）——record 须 register 进
    // store（生产链路 getRecordForAction/run 流程的 record 恒在内存，测试补齐同形态）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(record);
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("续聊 message → run 收到 resume 锚点（ctx.resume 唯一会话形态键）；轮终 round+1 保持 running", async () => {
    const beforeRound = record.round;

    await service.chatActions.deliverChatMessage(record, "next round msg");

    // Continuation：锚点校验通过后派发（record 保持 running）
    expect(record.status).toBe("running");

    // detached：等协议 run 被调（续聊 = ctx.resume 锚点）
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const run = fake.runs[0]!;
    expect(run.task.prompt).toBe("next round msg");
    expect(run.task.conversation).toBe(true);
    expect(run.ctx.resume).toEqual({
      recordId: record.id,
      resume: {
        sessionRef: { recordId: record.id, sessionFile: record.sessionFile },
        poolKey: "shared",
      },
    });

    // 模拟引擎 agent_settled 应答（轮末分流 = run 应答驱动，D7）
    run.settle({ content: "round text" });

    // 等 detached 完成：round 累加、record 保持 running-resumable（v4 B-1 idle 折入 running）
    await vi.waitFor(() => expect(record.round).toBe(beforeRound! + 1));
    expect(record.status).toBe("running");
  });

  it("终态 closed record → throw 行动语言（D4 表 closed 硬拒格），不派发 run", async () => {
    record.status = "closed";
    // [H1 U2] D4 表 closed 硬拒格：closedReason 非 可重连集（undefined/gc）→ 硬拒 +
    // start 新的指引（Continuation reviveOrThrow 文案）
    await expect(service.chatActions.deliverChatMessage(record, "msg")).rejects.toThrow(
      /cannot be messaged or resumed/,
    );
    expect(fake.runs.length).toBe(0);
  });

  it("record 无 sessionFile → 同步拒绝（D4 表锚点缺失格：no transcript anchor + re-dispatch 指引），不触发 kickOff", async () => {
    record.sessionFile = undefined;
    await expect(service.chatActions.deliverChatMessage(record, "msg")).rejects.toThrow(
      /no transcript anchor/,
    );
    expect(fake.runs.length).toBe(0);
  });

  it("record 无 controller → 投递 throw 行动语言（MF-4），不触发 kickOff", async () => {
    record.controller = undefined;
    await expect(service.chatActions.deliverChatMessage(record, "msg")).rejects.toThrow(/not ready for a new message/);
    expect(fake.runs.length).toBe(0);
  });
});

// ============================================================
// deliverChatMessage（chatMode 统一投递入口 → Continuation 编排）
// ============================================================

describe("deliverChatMessage（chatMode 统一投递 → Continuation 派发）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord(); // chatMode:true, running, round=1
    // sessionFile：续聊锚点需要
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // [U2a/B5] markRoundIdle 按 id 查 store 内存——record 须 register（见上 describe 注）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(record);
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("轮间 message → Continuation 派发新轮 + 执行态信号清除（[H1 U2] 承接原冷路径语义）", async () => {
    record.result = "上一轮增量";
    record.resumable = true;

    await service.chatActions.deliverChatMessage(record, "after you finish");

    // [H1 U2] 每轮 = 新 run + resume 锚点（§3.4 dispatchRound）
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const run = fake.runs[0]!;
    expect(run.task.prompt).toBe("after you finish");
    expect(run.ctx.resume?.recordId).toBe(record.id);
    expect(run.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // 轮始执行态信号清除（§5.4 isStreaming 公式）+ 迁移上报
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
    expect(record.resumable).toBeUndefined();
  });

  it("settle 交棒 = run 应答驱动（D7）：派发后挂中段守护，应答 settle 后轮终守护清空", async () => {
    await service.chatActions.deliverChatMessage(record, "msg");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    const { hasSettledWatchdog, getSettledWatchdogPhase } = await import("../settled-watchdog.ts");
    expect(hasSettledWatchdog(record.id)).toBe(true);
    expect(getSettledWatchdogPhase(record.id)).toBe("mid-round");

    // [H1 U2 / D7] settle 交棒 = run 应答驱动（onRunSettled 内 noteRoundSettledFromProtocol）：
    // 应答后轮终簿记完成，两段守护一并清（不残留 armed——收尾段 fire 会对已收敛轮误杀）
    fake.runs[0]!.settle({ content: "round text" });
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(hasSettledWatchdog(record.id)).toBe(false);
  });
});

// ============================================================
// 续聊并发守卫（review round2 MF1：同 turn 批量两条 message 双 kickOff 双 spawn）
// ============================================================
// 复现链（reviewer 探针实证）：pi 对同一条 assistant message 的 tool calls 顺序执行，
// tool1 的投递在续聊返回即 resolve——早于协议 run 完成（pool.acquire await 等
// 异步点）；tool2 立即执行 → 第二次 kickOff。v4 两态收敛后的 status 守卫对
// running-resumable record 恒放行 → 两次 kickOff → 两个 pi 子进程以 --session 同一
// JSONL 双写 + 第一个进程脱离记账成孤儿。
describe("deliverChatMessage 并发守卫（review round2 MF1）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // [U2a/B5] markRoundIdle 按 id 查 store 内存——record 须 register（见上 describe 注）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(record);
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("同 record 轮在途连续两条 message → 第二条入队不打断单飞（构造性单写者），轮终 drain 聚合派发", async () => {
    // 第一条：派发新轮（run 挂起不 resolve——模拟在途轮）
    await expect(service.chatActions.deliverChatMessage(record, "first msg")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // 第二条：run 在途 → [H1 U2 / D2 打断语义] abort 在途轮 signal + 入队（不打断单飞、
    // 不二次派发——修复前双 kickOff 双写 session 的守卫由 Continuation 单飞构造性承接）
    await expect(service.chatActions.deliverChatMessage(record, "second msg")).resolves.toBeUndefined();
    expect(fake.runs.length).toBe(1);
    const continuation = (
      // [R4 深绑改写] continuations 队列已迁 RunOrchestration 聚合——读取路径改经
      // 聚合实例（断言对象与强度不变）。
      service as unknown as {
        runOrchestration: { continuations: Map<string, { pendingCount: number }> };
      }
    ).runOrchestration.continuations.get(record.id);
    expect(continuation?.pendingCount).toBe(1);

    // 轮终（应答收敛）→ drain → 队列消息派发为下一轮（单写者前置满足）
    fake.runs[0]!.settle({ content: "done" });
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[1]!.task.prompt).toBe("second msg");
  });

  it("守卫是 record 级：A 在途轮不拦截 B 的 message", async () => {
    const recordB = makeIdleRecord("sa-chat-b");
    recordB.sessionFile = path.join(agentDir, "fake-session-b.jsonl");
    // [U2a/B5] 同 beforeEach——recordB 须 register 进 store（markRoundIdle 内存查）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(recordB);

    await service.chatActions.deliverChatMessage(record, "A msg");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // B 的续聊轮不受 A 在途影响（Continuation per-record 实例）
    await expect(service.chatActions.deliverChatMessage(recordB, "B msg")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[1]!.ctx.resume?.recordId).toBe(recordB.id);

    fake.runs[0]!.settle({ content: "A done" });
    fake.runs[1]!.settle({ content: "B done" });
    // 轮终簿记完成（Continuation 无全局在途集合——终态守卫由 per-record 实例承载），
    // 断言两轮各自 round+1 即单飞收口的可观察结果。
    await vi.waitFor(() => expect(record.round).toBe(2));
    await vi.waitFor(() => expect(recordB.round).toBe(2));
  });
});
