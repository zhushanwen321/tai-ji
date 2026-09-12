// src/__tests__/chatmode-round-notify-real-chain.test.ts
//（P1 抽包留壳：subject 为 subagent-core 件真链路，注入 pi/session-delivery 真机制，见 impl-plan 偏差 #17）
//
// [N2] chatMode 轮次通知正文——真实执行链路测试（W3 协议形态）。
//
// round2 审查实证的断链（inproc 形态）：agent_settled → onRoundSettled 先 notifyComplete
//（此时 record.result 从未被写）→ 轮次通知正文恒 "(empty)"。inproc 修复 = onRoundSettled
// 从本轮 turns 派生回复文本写入 record.result。
//
// [W3 改写 → H1 U6] 契约变更：会话形态轮经协议引擎（registry 'pi' cli 形态 port），
// live turns 留在引擎进程内，core 的轮次文本增量权威 = run 应答 outcome.content。
// 本测试用 registerFakePiEngine 协议替身驱动同一链路：execute(conversation:true) →
// kickOffChatRound → engine.run → run 应答 settle（[H1 U6] 轮末分流 = run 应答驱动，
// sessionFile 锚点回填 = outcome.sessionFile 承载——旧 idle 相位帧驱动随相位机退役），
// 断言「通知正文含本轮真实回复（非 (empty)）」的行为语义保持。
// 禁止手工预置 record.result——正文必须从应答 settle 真实流入。
//
// 原 inproc 专有断言「record.turns[0].text 累积」随 turns 留守引擎进程消亡（core 侧
// record.turns 不再承接 live 轮次文本），其用户可见语义（通知正文含回复文本）由
// record.result / sendMessage content 断言承接。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { _resetLifecycleState } from "@zhushanwen/subagent-core/execution/lifecycle-manager.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import type { ModelInfo, ModelRegistryLike } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";

// 投递内核经通知域窄端口注入（u0-notify）——本测试是真实执行链路回归，
// 投递内核同样保真实 createDelivery（dedupe/合批语义参与断言：settle 内 notify 与
// run 续体 collectCoordinator 回注同 notifyId 重放被吞，降级直发无 dedupe 会让
// sendMessage 计数翻倍）。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

/** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
}

/** 暴露私有 store 的接口（测试专用 cast）。 */
interface ServiceInternals {
  store: { getMutable(id: string): ExecutionRecord | undefined };
}

describe("[N2] chatMode 轮次通知正文：真实执行链路（协议引擎替身）", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;
  let internals: ServiceInternals;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.clearAllMocks();
    // lifecycle-manager 模块级单例（idleTimers Map 跨用例共享），每用例前清空防泄漏。
    _resetLifecycleState();
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-notify-"));
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    vi.restoreAllMocks();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("真实 execute(conversation:true) + 协议 idle 相位/应答 settle 驱动 → 通知正文含本轮真实回复（非 (empty)）", async () => {
    const ROUND_REPLY = "THE ROUND REPLY";
    const SESSION_FILE = path.join(agentDir, "sess-round-1.jsonl");

    // 真实链路：execute → kickOffChatRound → 协议 engine.run（会话形态 chat{recordId}）。
    const handle = await service.execute({
      task: "tell me something",
      slug: "round-notify",
      conversation: true,
    });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    const run = fake.runs[0];
    expect(run.ctx.resume?.recordId).toBe(handle.subagentId);

    // 真实事件链（[H1 U6] 协议时序）：轮内流式 delta（text 增量 → stream widget 面）→
    // run 应答 settle（= agent_settled，outcome.content = 本轮增量权威 → record.result
    // 写入 → notify；sessionFile 锚点经 outcome.sessionFile 回填 + 绑定落盘）。
    run.emitDelta(ROUND_REPLY);
    run.settle({ content: ROUND_REPLY, sessionFile: SESSION_FILE });

    // settle → notifyComplete（record.result 从应答 content 写入）→ 无其他 busy background
    // → 立即 flush → pi.sendMessage。
    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });

    const sentMsg = pi.sendMessage.mock.calls[0]![0] as { customType: string; content: string };
    expect(sentMsg.customType).toBe("subagent-bg-notify");
    expect(sentMsg.content).toContain("finished a round");
    // [N2] 核心：正文含本轮真实回复文本（修复前此处是 "(empty)"）
    expect(sentMsg.content).toContain(ROUND_REPLY);
    expect(sentMsg.content).not.toContain("(empty)");

    // record 侧：result 从应答 content 真实流入（非手工预置）+ running-resumable + round+1
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.result).toBe(ROUND_REPLY);
    expect(record!.status).toBe("running");
    expect(record!.round).toBe(1);
    // 锚点回填：run 应答 outcome.sessionFile 已回填 record（[H1 U6] 旧 idle 相位
    // anchor 驱动退役后的唯一回填点，+ record-binding sidecar 落盘）
    expect(record!.sessionFile).toBe(SESSION_FILE);

    // 收尾：settle 后 run 续体的 collectCoordinator 回注与 settle 内 notify 同 id:round →
    // dedup 吞——总发送数仍恰为 1。
    await new Promise((r) => setTimeout(r, 30));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // [C2] 终态语义扩展的现状承接：末条轮次通知含 Full transcript 指针行——chatMode:true
    // 经 toNotifyRecord 条件透传 record.sessionFile（锚点回填产物）到通知正文。
    const lastMsg = pi.sendMessage.mock.calls[0]![0] as { content: string; details?: { sessionFile?: string } };
    expect(lastMsg.details?.sessionFile).toBe(SESSION_FILE);
    expect(lastMsg.content).toContain(`\n\nFull transcript: ${SESSION_FILE}`);
  });
});
