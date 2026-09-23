// src/__tests__/one-shot-upgrade.test.ts
//
// [modeless 波1 迁移] 原「SP-5 one-shot upgrade」：非 chatMode active record 收到
// message 时自动升级 chatMode。chatMode 字段与「升级」概念随 modeless 重构整体消亡
// （「模式」不是 record 状态——任何 record 的 message 都直接续聊），本文件保留的是该组
// 三个用例的真实行为内核：
//   one-shot record（首轮已结束、无活进程）收到 message → 统一投递 →
//   Continuation 派发新 run + 携 resume 锚点续写原 sessionFile → 轮终落 idle 后仍可再续。
// 原「chatMode 置位」断言无对应行为面，逐条迁移为 resume 锚点 / 轮次簿记 / 二次续聊断言
//（三个 TC 编号与场景逐条对位，见各用例头注）。
//
// mock 策略（[W3 改写 → H1 U6]）：真实 SubagentService + registerFakePiEngine 协议替身。
// 旧 interact 热/冷分流观测面随 interact 面退役：message 一律经 Continuation 派发新 run
//（fake.runs 捕获，resume 锚点在 ctx.resume——键切换后唯一会话形态键）。

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
import { createRecord } from "@zhushanwen/subagent-core/execution/persistence/execution-record.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import { messageHandler } from "@zhushanwen/subagent-core";

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

/** one-shot record（首轮已结束——modeless 下无 chatMode 字段，任何 record 同形）。
 *  sessionFile 必须落在测试自建 mkdtemp 目录且真实在盘——续聊链路 isAnchorResolvable
 *  用 existsSync 判锚可用，失效即降级 [Session reopened] 重开（不带 resume 锚），
 *  共用固定 /tmp 路径会因宿主残留文件存在与否得出环境相关的两种行为（CI 干净 runner
 *  实测复现）。 */
function makeOneShotRecord(
  sessionRootId: string,
  status: "running" = "running",
  id = "sa-oneshot",
  sessionFile: string,
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
  });
  record.status = status;
  record.controller = new AbortController();
  // v4 B-1：one-shot 完成后 record 为 running（idle 折入 running）+ isResumable（无活进程）。
  // sessionFile 总设（[H1 U6] resume 锚点形态键——续聊轮统一经新 run + ctx.resume 续写）。
  record.sessionFile = sessionFile;
  record.round = 1;
  return record;
}

// ============================================================
// one-shot record 续聊（原 SP-5 升级链的执行内核）
// ============================================================

describe("one-shot record 续聊（modeless：无升级步骤，message 即续 + resume 锚点）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;
  let fakeSessionFile: string;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = makeTmpAgentDir();
    fakeSessionFile = path.join(agentDir, "fake-session.jsonl");
    fs.writeFileSync(fakeSessionFile, "");
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    const internals = service as unknown as ServiceInternals;
    store = internals.store;
    sessionRootId = internals.sessionRootId!;
    // 协议替身引擎（registry 'pi'）——message 资格 gate（engineSupportsConversation）
    // 与续聊轮派发共用同一替身（capabilities.conversation = 'native'）。
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // TC-1（原「one-shot done 后 message 触发 upgrade（chatMode=true）」）：升级步骤消亡后
  // 保留的行为面 = 投递领域对象 + 新 run 携 resume 锚点 + record 非终态。
  it("TC-1: one-shot running record 收到 message → 统一投递 + 新 run 携 resume 锚点（无升级步骤）", async () => {
    const record = makeOneShotRecord(sessionRootId, "running", "sa-oneshot", fakeSessionFile);
    store.register(record);

    const result = await messageHandler(service, { subagentId: record.id, text: "follow-up" });

    // [modeless 波1] 无 chatMode 升级步骤：handler 直接返回投递领域对象
    expect(result).toEqual({
      kind: "message",
      subagentId: record.id,
      slug: record.slug,
      response: { delivered: true },
    });
    // 续聊轮 = 新 run + resume 锚点（每轮新 run，无 interact 热路径）
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    expect(fake.runs[0]!.ctx.taskId).toBe(record.id);
    expect(fake.runs[0]!.task.prompt).toBe("follow-up");
    expect(fake.runs[0]!.ctx.resume?.recordId).toBe(record.id);
    expect(fake.runs[0]!.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // 验证 record 仍为 running
    expect(record.status).toBe("running");
    // 验证 record 在内存中（非终态，未被 archive）
    expect(store.getMutable(record.id)).toBeDefined();
  });

  // TC-2（原「upgrade 后续聊派发（resume 锚点续写原文件）」）：投递形态与锚点身份不变，
  // 唯一变化 = chatMode 置位断言无对应行为面 → 迁为 status 非终态（两态下恒 running）+ 锚点。
  it("TC-2: one-shot record 收到 message → 新 run resume 续写原文件（resume 锚点 = record 身份）", async () => {
    const record = makeOneShotRecord(sessionRootId, "running", "sa-oneshot", fakeSessionFile);
    store.register(record);

    await messageHandler(service, { subagentId: record.id, text: "resume message" });

    // 验证续聊派发（Continuation → dispatchRoundGuarded → engine.run）
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    // resume 锚点 = record 身份（sessionFile 原样携带——ctx.resume 唯一会话形态键）
    expect(fake.runs[0].ctx.resume?.recordId).toBe(record.id);
    expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // 轮内在飞 = running（v4 B-1 两态：idle 折入 running，无 closed 形态）
    expect(record.status).toBe("running");
  });

  // TC-3（原「upgrade 后 record 可续聊（非终态）」）：原断言（在内存 + chatMode）升级为
  // 「轮终落 idle 后同 id 再续一轮」——「可续聊」的最强可证伪形态（二次续聊真实派发 +
  // 同一 resume 锚点），而非只看内存快照。
  it("TC-3: 轮终落 idle 后 record 可再次续聊（第二轮续聊携同一 resume 锚点）", async () => {
    const record = makeOneShotRecord(sessionRootId, "running", "sa-oneshot", fakeSessionFile);
    store.register(record);

    await messageHandler(service, { subagentId: record.id, text: "first resume" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));

    // 第一轮收链：轮终簿记 → 翻 idle 留守（非终态化、不 archive）
    fake.runs[0]!.settle({ content: "round 1 result" });
    await vi.waitFor(() => expect(store.getMutable(record.id)?.status).toBe("idle"));
    // 关键验证：record 仍在内存（getMutable 返回非 undefined）——未被 archive 到终态
    const mutable = store.getMutable(record.id);
    expect(mutable).toBeDefined();
    expect(mutable!.status).toBe("idle");

    // 同 id 再续一轮（万物可续：idle record 收到 message → 翻 running + 派发新 run）
    const second = await messageHandler(service, { subagentId: record.id, text: "second resume" });
    expect(second.response.delivered).toBe(true);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(2));
    expect(fake.runs[1]!.task.prompt).toBe("second resume");
    expect(fake.runs[1]!.ctx.resume?.recordId).toBe(record.id);
    expect(fake.runs[1]!.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // 二次续聊在飞 = running（非终态）
    expect(record.status).toBe("running");
  });
});
