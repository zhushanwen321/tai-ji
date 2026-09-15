// src/__tests__/conversation-wiring.test.ts
//
// [modeless 波5 收尾] conversation 派发参数接线测试（参数已全链删除）。
//
// 演化：M9 原断言 conversation:true → record.chatMode === true；[modeless 波1]
// chatMode 字段消亡、参数转 accepted-no-op 弃用窗；[modeless 波5 收尾] 弃用窗到期，
// 参数从 ExecuteOptions/StartHandlerInput/AgentCallOpts 全链删除。本文件迁移为
// 「当前真实接线面」的等价断言（回归保护不缩水）：
//   1. createRecordForMode 现存形态判据：idleTimeoutMs 归属 record（全 record 生效的
//      idle GC 节奏，不再限定「对话模式」）+ record 无 chatMode 键（模式标志不得复活）
//   2. idle 续聊语义：续聊资格 = 引擎能力轴 service.engineSupportsConversation(record)
//      （messageHandler 唯一门槛）——「一次性 record 不可续」的记录级形态已消亡，
//      不依赖任何派发参数
//
// 两层验证：
//   1. 接线层：真实 SubagentService.execute（fake 引擎 run 永不 settle——阻断 detached
//      收尾，record 停在 running）→ 断言 record 创建字段集合 + 派发链（resume 锚点）
//   2. 透传层：startHandler + mock service → 断言 execute 收到 idleTimeoutMs 原值
//      （参数名漂移 / 透传丢失即红）
//
// [W3 改写] 原(mock inproc session-runner.runSpawn 永挂) 随 inproc pi 引擎目录删除消亡；
// 换 registerFakePiEngine 协议替身（FakeRun promise 永不 settle 同语义），派发观测点
// 从 mockRunSpawn 调用计数换成 fake.runs 捕获数。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { startHandler } from "../interface/subagent-actions.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import type { ModelInfo, ModelRegistryLike } from "@zhushanwen/subagent-core/execution/assembly/model-resolver.ts";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { ExecutionHandle, SubagentToolDetails } from "@zhushanwen/subagent-core/execution/assembly/types.ts";

const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

/** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

/** initSession 注入的最小 pi duck-type（同 subagent-service PiLike 形状，结构匹配即可）。 */
interface PiStub {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

function makePi(): PiStub {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 暴露私有 store 的接口（测试专用 cast）。 */
interface ServiceInternals {
  store: RecordStore;
}

// ============================================================
// 1. 接线层：execute({idleTimeoutMs}) → record 字段 + 派发链
// ============================================================

describe("[modeless] idleTimeoutMs 接线：execute → createRecordForMode", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-wiring-"));
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
    // 协议替身引擎：run 永不 settle（FakeRun promise 挂起），record 停在 running。
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("idleTimeoutMs:12345 → 落 record、无 chatMode 键、仍可续聊", async () => {
    const handle = await service.execute({
      task: "keep chatting with me",
      slug: "conv-test",
      idleTimeoutMs: 12345,
    });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    // idleTimeoutMs 归属 record（全 record 生效的 idle GC 节奏；优先级 参数 > env > 默认）
    expect(record!.idleTimeoutMs).toBe(12345);
    // [modeless] 模式标志消亡：record 级 chatMode 落值不得复活
    expect(Object.keys(record!)).not.toContain("chatMode");
    expect(record!.status).toBe("running");
    // idle 续聊资格 = 引擎能力轴（messageHandler 唯一门槛），与参数/record 形态无关
    expect(service.engineSupportsConversation(record!)).toBe(true);
    // execute 走到首轮派发（engine.run 已派发）——完整接线而非 early return
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    // 会话形态由 resume 锚点承载（协议 run 的 ctx.resume.recordId——[modeless 波2]
    // task.conversation 协议键已删，本轮起「每轮 = 新 run + resume 锚点」唯一形态）
    expect(fake.runs[0].ctx.resume?.recordId).toBe(handle.subagentId);
  });

  it("idleTimeoutMs 缺省 → undefined（不误置）+ 无 chatMode 键 + 仍可续聊（万物可续不依赖参数）", async () => {
    const handle = await service.execute({
      task: "one shot task",
      slug: "oneshot-test",
    });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.idleTimeoutMs).toBeUndefined();
    expect(Object.keys(record!)).not.toContain("chatMode");
    // 缺省派发同权可续——「一次性 record 不可续」的记录级形态已消亡（原
    // chatMode === false 断言的等价承接）
    expect(service.engineSupportsConversation(record!)).toBe(true);
  });
});

// ============================================================
// 2. 透传层：startHandler(service, {idleTimeoutMs}) → service.execute
//    参数逐字透传——接线回归保护（参数名漂移 / 透传丢失即红）
// ============================================================

function makeHandle(subagentId: string): ExecutionHandle {
  const details: SubagentToolDetails = {
    status: "running",
    mode: "background",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    slug: "conv-test",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    eventLog: [],
    displayItems: [],
    result: undefined,
  };
  return { mode: "background", subagentId, sessionFile: undefined, details };
}

function makeService(): SubagentService & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => makeHandle("sa-conv-1")),
    findRecord: vi.fn(() => undefined),
    cancel: vi.fn(() => false),
    collectRecords: vi.fn(() => []),
    getFullRecord: vi.fn(() => undefined),
    // [U1/U2] collect 契约面：startHandler 解析链必调；stub 回缺省 async
    getCollectSyncDefault: vi.fn(() => "async" as const),
  } as unknown as SubagentService & { execute: ReturnType<typeof vi.fn> };
}

describe("[modeless] startHandler 透传：idleTimeoutMs → execute 入参", () => {
  it("idleTimeoutMs:12345 原值透传给 service.execute", async () => {
    const svc = makeService();
    const result = await startHandler(
      svc,
      { task: "chat task", slug: "conv-pass", idleTimeoutMs: 12345 },
      undefined,
    );

    expect(svc.execute).toHaveBeenCalledTimes(1);
    expect(svc.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "chat task",
        slug: "conv-pass",
        idleTimeoutMs: 12345,
      }),
    );
    // bg 响应回执（LLM 可见）：detached + running
    expect(result.kind).toBe("bg");
    expect(result.subagentId).toBe("sa-conv-1");
    expect(result.response.status).toBe("running");
  });

  it("idleTimeoutMs 缺省 → execute 入参 idleTimeoutMs===undefined（不误置）", async () => {
    const svc = makeService();
    await startHandler(svc, { task: "plain task", slug: "plain-pass" }, undefined);

    expect(svc.execute).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutMs: undefined }),
    );
  });
});
