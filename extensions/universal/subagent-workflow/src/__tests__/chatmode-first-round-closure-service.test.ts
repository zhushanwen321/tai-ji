// src/__tests__/chatmode-first-round-closure-service.test.ts
//（P1 抽包留壳：subject 为 subagent-core 件真链路，注入 pi/session-delivery 真机制，见 impl-plan 偏差 #17）
//
// [V2 决策 2/3 → W3 协议形态改写] chatMode 首轮闭环。
//
// W3 契约变更 → [H1 U6] chat-run 统一定形：会话形态轮走协议引擎（registry 'pi'
// cli 形态 port），原 inproc 面与 runAndFinalize 分流随删件消亡；[H1 U6] 轮末结算
// 载体 settleChatRoundFromResponse 语义按 D7 迁移清单并入 Continuation（onRunSettled），
// 旧轮次相位帧消费面随相位机退役。承接同一业务语义的现权威：
//   - 轮次收敛 = kickOffChatRound 的 run 应答（= agent_settled）→ Continuation
//     onRunSettled 成功分支：round 0→1 + record.result = outcome.content + 门→route
//     notify（chatMode running → status="running"，round 透传供 dedup key 递增）；
//   - settle 交棒 = run 应答驱动（onRunSettled 内 noteRoundSettledFromProtocol）；
//   - 原「首轮完成 record 留内存可续聊、round 恰 +1 不二次递增、result 单写点」的
//     正语义由本文件 T1/T2 直接钉住（T3/T4 废弃理由不变）。
//
// mock 结构：registerFakePiEngine 协议替身（run 应答由测试显式驱动）+ logger；
// 通知域注入真实 createDelivery（dedupe 语义参与断言）。
//
// [契约变更记录] 原文件「double-notify 防护」的现对应 = Continuation onRunSettled
// 内 notify（门→route）与主干回注同 id:round → notifier dedup 吞第二次（notifier 去重集
// 语义不变），由 [M3] 用例锁定。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger（doFinalizeRecord 的 manifest 写入降级路径用 logger.error）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "@zhushanwen/subagent-core/testing/execution/engine/host/spawned-children.ts";
import { _resetLifecycleState } from "@zhushanwen/subagent-core/execution/lifecycle-manager.ts";
import { createRecord } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import type { ModelInfo, ModelRegistryLike } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core/execution/types.ts";

// 投递内核经通知域窄端口注入（u0-notify）——[M3] 的「同 id:round dedup 吞第二次」
// 依赖真实内核 dedupe 语义，注入真实 createDelivery（降级直发无 dedupe 会发 2 条）。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

const STUB_MODEL: ModelInfo = {
  id: "test-model",
  name: "Test",
  provider: "test",
  reasoning: false,
};

/** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chatmode-closure-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
}

function makeRecord(chatMode: boolean, id = "sa-test"): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test-model",
    mode: "background",
    task: "do something",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode,
  });
}

/** 暴露 store / notifyHost 私有访问。
 *  [D4-①] notifyComplete 已随通知簇搬至 notify-host——经 notifyHost 面访问（行为等价）。
 *  [merge 适配] notifyComplete 调用点已改 collectCoordinator.route 路由（U2）：
 *  async/running record 直通 notifyHost.notify——入参为 toNotifyRecord 映射后的
 *  BgNotifyRecord（非 ExecutionRecord）。 */
interface ServiceInternals {
  store: RecordStore;
  notifyHost: {
    notify(record: { id: string; status: string; round?: number }): void;
    notifyComplete(record: ExecutionRecord): void;
  };
}

describe("[V2 决策 2/3] chatMode 首轮闭环：run 应答 settle（协议形态）", () => {
  let agentDir: string;
  let modelService: ModelConfigService;
  let service: SubagentService;
  let internals: ServiceInternals;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    agentDir = makeTmpAgentDir();
    modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── 改动 2 的协议承接：首轮 run 应答 = 轻量 idle 化 ───────────────────

  it("首轮 run 应答 settle：running(idle 折入) + round 0→1 + notifyComplete（status=running、round 透传）", async () => {
    const pi = makePi();
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 的 pi
    const spy = vi.spyOn(internals.notifyHost, "notify");

    const handle = await service.execute({ task: "do something", slug: "test", conversation: true });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    const run = fake.runs[0];
    expect(run.ctx.resume?.recordId).toBe(handle.subagentId); // 会话形态已声明（[H1 U6] resume 键）

    // run 应答（= agent_settled，[H1 U6] settle 交棒 run 应答驱动——旧 idle 相位帧
    // 随相位机退役）：本轮内容为增量权威（live turns 留引擎进程）
    run.settle({ content: "first-round-done" });

    // [改动 2 承接] 轻量 idle 化（v4 B-1：idle 折入 running）：status=running（notify 守卫放行）
    // + round 0→1（dedup key 递增）+ record.result 从应答 content 写入（单写点，非手工预置）
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.status).toBe("running");
    expect(record!.round).toBe(1);
    expect(record!.result).toBe("first-round-done");
    // 首条通知入参为 toNotifyRecord 映射后的 BgNotifyRecord（chatMode running →
    // status="running"，round 透传供 dedup key 递增）。spy 可能收到 settle 内 notify 与
    // run 续体 collectCoordinator 回注两次调用——同 id:round 在 notifier dedup 层吞并，
    // 用户可见面（pi.sendMessage）恒 1 条（末尾断言）。
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ id: record!.id, status: "running", round: 1 });
    // record 留 store（首轮完成不终态化——原 early-return 的正语义）
    expect(internals.store.getMutable(record!.id)).toBe(record);
    // 双通知点同 id:round → dedup：用户可见恰 1 条
    await new Promise((r) => setTimeout(r, 20));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("onRoundSettled 连续两轮（冷路径续轮）：round 累加（1→2，dedup key 区分每轮）", async () => {
    const handle = await service.execute({ task: "do something", slug: "test", conversation: true });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    const run1 = fake.runs[0];
    // [H1 U6] settle 交棒 = run 应答驱动（旧 idle 相位帧随相位机退役）
    run1.settle({ content: "round one", sessionFile: path.join(agentDir, "round-1.jsonl") });
    await vi.waitFor(() => {
      expect(internals.store.getMutable(handle.subagentId)?.round).toBe(1); // 第一轮已完成
    });

    // 第二轮：message → Continuation 派发新 run（[H1 U6] 每轮 = 新 run + resume 锚点）
    const { messageHandler } = await import("../interface/subagent-actions.ts");
    await messageHandler(service, { subagentId: handle.subagentId, text: "second round" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(2));

    const run2 = fake.runs[1];
    run2.settle({ content: "round two" });

    const record = internals.store.getMutable(handle.subagentId);
    await vi.waitFor(() => expect(record?.round).toBe(2)); // 第二轮 round 累加
    expect(record!.status).toBe("running");
    expect(record!.result).toBe("round two");
  });

  // ── double-notify 防护 + [M3] 轮次完成通知立即送达 ───────────────────

  it("[M3] chatMode 轮次完成通知立即送达（不挂 60s 合并窗口）+ 同 id:round dedup 吞第二次", async () => {
    // 生产场景：chatMode 轮次完成（idle 相位 arm idle timer → run 应答 settle →
    // notifyComplete），record 留 store、status=running。旧 piAdapter.hasRunningBackground
    // 按 mode==="background" 计数 → 对该 record 恒 true → notify 恒挂 60s 合并窗口，
    // 主 agent 的续聊回复固定延迟 60s（G1 失效）。修复后排除 isIdle（timer armed）record
    // → 立即 flush。
    //
    // 走真实 SubagentService 通知链（settle → collectCoordinator.route → BgNotifier →
    // pi.sendMessage），真实 createDelivery dedupe 语义参与断言。
    //
    // [N2] 禁止手工预置 record.result——轮次文本经协议应答 content 写入（协议形态下
    // core 的增量权威 = outcome.content，非 turns 派生）。
    const pi = makePi();
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 的 pi
    const handle = await service.execute({ task: "do something", slug: "test", conversation: true });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    const run = fake.runs[0];
    run.settle({ content: "first-round-done" }); // [H1 U6] run 应答 settle（= agent_settled）

    // [M3] 立即 flush——同步断言 sendMessage 已发出（旧实现此处挂 60s timer，0 次调用）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const record = internals.store.getMutable(handle.subagentId)!;
    expect(record.round).toBe(1);
    expect(record.result).toBe("first-round-done"); // 真实派生（非手工预置）
    const sentMsg = pi.sendMessage.mock.calls[0]![0] as { customType: string; content: string };
    expect(sentMsg.customType).toBe("subagent-bg-notify");
    expect(sentMsg.content).toContain("finished a round");
    expect(sentMsg.content).toContain("first-round-done");

    // double-notify 防护（原用例语义保留）：settle 内 notify + run 续体 collectCoordinator
    // 回注已同 id:round 被吞；显式再 notifyComplete 一次（同 id:round）→ notifier dedup
    // key=`${id}:${round}` 60s 内吞第二次。
    internals.notifyHost.notifyComplete(record);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // 对照：真在跑的 background 工作（镜像活进程 + 无 timer）仍计入合并窗口——closed 通知
    // 挂 60s 不立即发送（合并窗口语义对真正的并发完成保留）。
    const busy = makeRecord(false, "sa-busy");
    busy.status = "running";
    internals.store.register(busy);
    // 协议形态的「活进程」记账 = core 侧 spawnedChildren 镜像活位（原 mock getChildByRecord
    // 活句柄的等价物；hasRunningBackground 判据 hasLiveProcessHandle 读本镜像）。
    coreSpawnedChildrenMirror().register(busy.id, { pid: 4321, killed: false });
    const done = makeRecord(false, "sa-done");
    done.status = "closed"; // 终态 notify（toNotifyRecord 放行 closed）
    internals.store.register(done);
    internals.notifyHost.notifyComplete(done);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // 未新增——busy 挂起合并窗口
  });
});

// ── [N1] one-shot 成功完成通知（SP-5 回退 resumable 后仍送达）──────────────

describe("[N1] one-shot 成功完成通知：SP-5 回退 resumable 后仍送达", () => {
  let agentDir: string;
  let modelService: ModelConfigService;
  let service: SubagentService;
  let internals: ServiceInternals;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    agentDir = makeTmpAgentDir();
    modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("真实 execute + 协议应答(success) → 恰 1 条 subagent-bg-notify（status=closed、正文含真实结果），record 保持可升级", async () => {
    // 真实链路：execute → kickOffChatRound（非 chatMode 一次性 run）→ 协议应答 →
    // settleOneShotOutcome（SP-5 分支 → finalizeRoundToIdle 回退 running-resumable）→
    // collectCoordinator 回注 → BgNotifier → pi.sendMessage。
    // round2 审查实证：旧守卫（closed/isIdle only）对 SP-5 完成态恒拒绝 → 发送数 0。
    const pi = makePi();
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 的 pi

    const handle = await service.execute({ task: "one shot task", slug: "oneshot-n1" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0].settle({ content: "done" });

    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });
    const sentMsg = pi.sendMessage.mock.calls[0]![0] as {
      customType: string;
      content: string;
      details?: { status?: string };
    };
    expect(sentMsg.customType).toBe("subagent-bg-notify");
    // 完成语义：status=closed（对齐 tool 契约 "runs once, notifies on completion"；
    // running 分支文案不含 worktree patchFile 提示，one-shot 需要 closed 分支）
    expect(sentMsg.details?.status).toBe("closed");
    expect(sentMsg.content).toContain("completed");
    expect(sentMsg.content).toContain("done"); // 应答 content，经 MF-2 写入 record.result

    // 恰好 1 条：无第二个通知点（轮次 settle 仅 chatMode；回注后无再触发）
    await new Promise((r) => setTimeout(r, 20));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // SP-5 语义不破坏：record 回退 running-resumable（可 message 升级续聊），未终态化
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.status).toBe("running");
    expect(record!.result).toBe("done");
  });
});
