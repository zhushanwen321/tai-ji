// src/__tests__/conversation-wiring.test.ts
//
// [M9] conversation:true → record.chatMode 接线穿透测试。
//
// 背景：「持续对话」特性的 LLM 入口接线（subagent-tool params → startHandler 透传 →
// execute → createRecordForMode 的 `chatMode: opts.conversation === true` +
// `idleTimeoutMs: opts.idleTimeoutMs`，subagent-service.ts L1234-1235）此前无任何测试——
// 全部 chatMode 测试手工构造 chatMode:true record，startHandler 测试不传 conversation。
// 若参数名漂移或透传丢失（subagent-actions.ts L206-207），1970 个用例仍全绿。
//
// 两层验证：
//   1. 接线层：真实 SubagentService.execute（fake 引擎 run 永不 settle——阻断 detached
//      收尾，record 停在 running）→ 断言内存 record.chatMode === true / idleTimeoutMs 生效；
//      缺省对照 chatMode === false
//   2. 透传层：startHandler + mock service → 断言 execute 收到 conversation/idleTimeoutMs 原值
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
import type { ModelInfo, ModelRegistryLike } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { ExecutionHandle, SubagentToolDetails } from "@zhushanwen/subagent-core/execution/types.ts";

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
// 1. 接线层：execute({conversation, idleTimeoutMs}) → record 字段
// ============================================================

describe("[M9] conversation:true 接线：execute → createRecordForMode", () => {
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

  it("conversation:true + idleTimeoutMs:12345 → record.chatMode===true、idleTimeoutMs 生效", async () => {
    const handle = await service.execute({
      task: "keep chatting with me",
      slug: "conv-test",
      conversation: true,
      idleTimeoutMs: 12345,
    });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.chatMode).toBe(true);
    expect(record!.idleTimeoutMs).toBe(12345);
    expect(record!.status).toBe("running");
    // execute 走到 kickOffChatRound（engine.run 已派发）——完整接线而非 early return
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    // chat 会话形态接线：run ctx 携带 chat.recordId（协议 run.params.chat 承载位）
    expect(fake.runs[0].ctx.resume?.recordId).toBe(handle.subagentId);
    expect(fake.runs[0].task.conversation).toBe(true);
  });

  it("conversation 缺省 → record.chatMode===false、idleTimeoutMs undefined（一次性模式不误升级）", async () => {
    const handle = await service.execute({
      task: "one shot task",
      slug: "oneshot-test",
    });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.chatMode).toBe(false);
    expect(record!.idleTimeoutMs).toBeUndefined();
  });
});

// ============================================================
// 2. 透传层：startHandler(service, {conversation, idleTimeoutMs}) → service.execute
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

describe("[M9] startHandler 透传：conversation/idleTimeoutMs → execute 入参", () => {
  it("conversation:true + idleTimeoutMs:12345 原值透传给 service.execute", async () => {
    const svc = makeService();
    const result = await startHandler(
      svc,
      { task: "chat task", slug: "conv-pass", conversation: true, idleTimeoutMs: 12345 },
      undefined,
    );

    expect(svc.execute).toHaveBeenCalledTimes(1);
    expect(svc.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "chat task",
        slug: "conv-pass",
        conversation: true,
        idleTimeoutMs: 12345,
      }),
    );
    // bg 响应回执（LLM 可见）：detached + running
    expect(result.kind).toBe("bg");
    expect(result.subagentId).toBe("sa-conv-1");
    expect(result.response.status).toBe("running");
  });

  it("conversation 缺省 → execute 入参 conversation===undefined（不误置 true）", async () => {
    const svc = makeService();
    await startHandler(svc, { task: "plain task", slug: "plain-pass" }, undefined);

    expect(svc.execute).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: undefined, idleTimeoutMs: undefined }),
    );
  });
});
