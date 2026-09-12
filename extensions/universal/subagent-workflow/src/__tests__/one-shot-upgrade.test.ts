// src/__tests__/one-shot-upgrade.test.ts
//
// SP-5 one-shot upgrade：非 chatMode active record 收到 message 时自动升级 chatMode。
//
// 场景：one-shot subagent（conversation=false）完成首轮后 record 仍在内存（running），
// LLM 调 message 续聊 → messageHandler 检测非 chatMode + active → gate 放行 →
// 置 chatMode=true（upgrade）→ deliverChatMessage 统一路径（Continuation 派发新轮）。
//
// [W3 改写 → H1 U6] mock 策略：真实 SubagentService + registerFakePiEngine 协议替身。
// [H1 U6] 旧 interact 热/冷分流观测面随 interact 面退役：upgrade 后 message 一律经
// Continuation 派发新 run（fake.runs 捕获，resume 锚点在 ctx.resume——键切换后唯一
// 会话形态键）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { createRecord } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import { messageHandler } from "../interface/subagent-actions.ts";

// [commit 前修复] 测试进程可能继承宿主（pi 子进程链）的 PI_SUBAGENT_* 身份 env：
// initSession 的 sessionRootId/execCtx 基线读 env 优先于 init.sessionId——宿主 env
// 泄漏时 cross-tree 守卫（15448af73）把本测试自建的 record 判为异树拒绝 message
//（守卫行为正确，测试缺清理）。与 subagent-core collect-mixed-dispatch.test.ts
// 同病同修：beforeEach 删五键后再 initSession（delete 不 restore，同包既有范式）。
const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-test-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
}

interface ServiceInternals {
  store: RecordStore;
  sessionRootId: string | null;
}

/** 非 chatMode background record（one-shot 模式）。 */
function makeOneShotRecord(
  sessionRootId: string,
  status: "running" = "running",
  id = "sa-oneshot",
): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "one-shot task",
    slug: "oneshot",
    startedAt: 1000,
    rootSessionId: sessionRootId,
    // chatMode 不传 = undefined = 非 chatMode（one-shot）
  });
  record.status = status;
  record.controller = new AbortController();
  // v4 B-1：one-shot 完成后 record 为 running（idle 折入 running）+ isResumable（无活进程）。
  // sessionFile 总设（[H1 U6] resume 锚点形态键——续聊轮统一经新 run + ctx.resume 续写）。
  record.sessionFile = "/tmp/fake-session.jsonl";
  record.round = 1;
  return record;
}

// ============================================================
// SP-5 one-shot upgrade
// ============================================================

describe("SP-5 one-shot upgrade（message → chatMode + resume 锚点续聊）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    const internals = service as unknown as ServiceInternals;
    store = internals.store;
    sessionRootId = internals.sessionRootId!;
    // 协议替身引擎（registry 'pi'）。
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // TC-1: one-shot done 后 message 触发 upgrade（chatMode=true）
  // 场景：one-shot running record → message → chatMode 被置 true → Continuation
  // 派发新轮（[H1 U6] 每轮 = 新 run + resume 锚点，无 interact 热路径）
  it("TC-1: one-shot running record 收到 message → chatMode 升级为 true + Continuation 派发新轮", async () => {
    const record = makeOneShotRecord(sessionRootId, "running");
    store.register(record);

    expect(record.chatMode).toBeFalsy();

    await messageHandler(service, { subagentId: record.id, text: "follow-up" });

    // 验证升级后的 chatMode 与投递形态：Continuation 派发新 run（resume 锚点续写）
    expect(record.chatMode).toBe(true);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    expect(fake.runs[0]!.task.prompt).toBe("follow-up");
    expect(fake.runs[0]!.ctx.resume?.recordId).toBe(record.id);
    expect(fake.runs[0]!.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // 验证 record 仍为 running
    expect(record.status).toBe("running");
    // 验证 record 在内存中（非终态，未被 archive）
    expect(store.getMutable(record.id)).toBeDefined();
  });

  // TC-2: upgrade 后续聊派发（resume 锚点续写原文件）
  // 场景：one-shot running-resumable record → message → chatMode=true →
  // Continuation 派发新轮（[H1 U6] 新 run + resume 锚点）
  it("TC-2: one-shot running-resumable record 收到 message → chatMode 升级 + 新 run resume", async () => {
    const record = makeOneShotRecord(sessionRootId);
    store.register(record);

    expect(record.chatMode).toBeFalsy();

    await messageHandler(service, { subagentId: record.id, text: "resume message" });

    // 验证 chatMode 被升级
    expect(record.chatMode).toBe(true);
    // 验证续聊派发（Continuation → kickOffChatRound → engine.run）
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    // resume 锚点 = record 身份（sessionFile 原样携带——ctx.resume 唯一会话形态键）
    expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // record 被 resumeRound 设为 running，轮次收尾后保持 running（v4 B-1 idle 折入 running）
    // 关键是 record 不在终态
    expect(record.status).not.toBe("closed");
  });

  // TC-3: upgrade 后 record 可续聊（非终态）
  // 场景：验证升级后的 record 不会被 finalize 为终态，仍可接受后续 message
  it("TC-3: upgrade 后 record 可续聊（非终态，仍在内存）", async () => {
    const record = makeOneShotRecord(sessionRootId);
    store.register(record);

    await messageHandler(service, { subagentId: record.id, text: "first resume" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));

    // chatMode 已升级
    expect(record.chatMode).toBe(true);

    // 关键验证：record 仍在内存（getMutable 返回非 undefined）——未被 archive 到终态
    const mutable = store.getMutable(record.id);
    expect(mutable).toBeDefined();
    expect(mutable!.chatMode).toBe(true);

    // 验证 status 不是终态（closed 是终态；running 是非终态，v4 B-1 idle 折入 running）
    expect(record.status).toBe("running");
  });
});
