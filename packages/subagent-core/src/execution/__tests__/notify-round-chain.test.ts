// src/execution/__tests__/notify-round-chain.test.ts
//
// 通知链路真实执行回归（u-5c 迁自壳套件两文件，被测主体是 core 件）：
//   - [N2]（迁自壳 chatmode-round-notify-real-chain.test.ts，全文件唯一用例，
//     N2 空回复回归的唯一防线——迁移保活）：chatMode 轮次通知正文经真实执行链路
//     （execute → kickOffChatRound → 协议 engine.run → run 应答 settle →
//     notifyComplete → BgNotifier → pi.sendMessage）流入本轮真实回复，非 "(empty)"。
//   - 首轮闭环独有断言面（迁自壳 first-round-closure-service.test.ts；其余条目
//     core conversation-continuation.test.ts 已有同层更强覆盖，随壳文件删除）：
//       T1  notifyComplete 入参形状（record 入参 = 轮终翻边后簿记，round/result 已写）；
//       [M3] busy 对照：真在跑 background（镜像活进程 + 无 timer）仍挂合并窗口；
//       [N1] one-shot 完成通知载荷派生视图 details.status="running"。
//
// round2 审查实证的断链（inproc 形态）：agent_settled → onRoundSettled 先 notifyComplete
//（此时 record.result 从未被写）→ 轮次通知正文恒 "(empty)"。修复 = onRoundSettled
// 从 run 应答 outcome.content 写入 record.result。
//
// [W3 改写 → H1 U6] 契约：会话形态轮经协议引擎（registry 'pi' cli 形态 port），
// live turns 留在引擎进程内，core 的轮次文本增量权威 = run 应答 outcome.content。
// registerFakePiEngine 协议替身驱动同一链路，断言「通知正文含本轮真实回复（非
// (empty)）」的行为语义。禁止手工预置 record.result——正文必须从应答 settle 真实流入。
//
// 通知域 fake 投递端口（DeliveryPortHandle 替身，core 依赖闭包不含 pi-delivery-
// port——消费 notify-ports 转写类型）：[M3]/[N1] 的「同 id:round 幂等吞第二次」与
// merge 判定分流依赖 port.deliver 消费语义（降级直发无 dedupe 会让 sendMessage
// 计数翻倍）；替身形态（幂等吞 / merge 透传 / 非 merge 受理即注入）见 makeFakePort。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { configureNotifyDomain, resetNotifyDomainForTests, type DeliveryPortHandle } from "../../core/notify-ports.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { emptyRegistry, CTX_MODEL } from "./helpers/model-registry-mock.ts";
import { clearEngines } from "../engine/registry.ts";
import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import { _resetLifecycleState } from "../lifecycle/lifecycle-manager.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import { SubagentService } from "../subagent-service.ts";

// ─── fake 投递端口（port.deliver 消费方：同 id 幂等吞 + merge 判定分流）────────
//
// 波 2 改写对位：原「投递内核等价桩」（dedupe / busy gate / 合批窗口）随内核队列
// 持有退役——port 形态下受理即入 pi 原生队列（忙时不拒），合批窗口在端口侧。
// 本文件断言面只需三片：幂等键判重（同 id:round 吞）、merge 判定透传（hasRunning-
// Background 的 M3 判据回归锚）、非 merge 条目受理即注入（观察面 = pi.sendMessage）。

type FakePortRecord = { id: string; merge: boolean };

function makeFakePort(inject: (message: unknown) => void) {
  const seen = new Set<string>();
  const records: FakePortRecord[] = [];
  const handle: DeliveryPortHandle = {
    deliver(envelope, opts) {
      const id = envelope.id ?? "gen-id";
      if (seen.has(id)) return { kind: "swallowed", reason: "already-seen" };
      seen.add(id);
      const merge = opts?.merge ?? false;
      records.push({ id, merge });
      if (!merge) {
        // 受理即注入（pi 原生队列忙时不拒——本文件无注入失败场景）；details 由
        // 真实 port 在注入前补 deliveryId，本替身按 notifier 业务 details 原样透传。
        inject({
          customType: envelope.payload.customType,
          content: envelope.payload.content,
          display: envelope.payload.display,
          details: envelope.payload.details,
        });
      }
      return { kind: "accepted", id };
    },
    flush() {
      // merge:true 条目在真实 port 走 60s 窗口；本文件对 merge 条目的断言面是
      // 「不立即注入」（窗口判定透传锚），无到期出站断言，flush 直通为空。
    },
  };
  return { handle, records };
}

// 投递端口经通知域窄端口注入（getDeliveryPort 槽访问器；当前用例的 fake port 由
// describe 内 beforeEach 装配赋值）；afterEach 重置防注入态泄漏。
let currentFakePort: ReturnType<typeof makeFakePort> | undefined;
beforeEach(() => {
  configureNotifyDomain({ getDeliveryPort: () => currentFakePort?.handle });
});
afterEach(() => {
  resetNotifyDomainForTests();
  currentFakePort = undefined;
});

/** 暴露私有 store / notifyHost 的接口（测试专用 cast）。
 *  [D4-①] notifyComplete 已随通知簇搬至 notify-host——经 notifyHost 面访问。
 *  [merge 适配] notifyComplete 调用点已改 notifyHost 直通（U2）：入参为
 *  ExecutionRecord（非 toNotifyRecord 映射后的 BgNotifyRecord）。 */
type ServiceInternals = {
  store: RecordStore;
  notifyHost: {
    notify(record: { id: string; status: string; round?: number }): void;
    notifyComplete(record: ExecutionRecord): void;
  };
};

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "notify-round-chain-"));
}

function makeRecord(id = "sa-test"): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test-model",
    mode: "background",
    task: "do something",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
  });
}

describe("[N2] chatMode 轮次通知正文：真实执行链路（协议引擎替身）", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: PiMock;
  let internals: ServiceInternals;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.clearAllMocks();
    // lifecycle-manager 模块级单例（idleTimers Map 跨用例共享），每用例前清空防泄漏。
    _resetLifecycleState();
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: emptyRegistry(),
      sessionId: "root-session",
      ctxModel: CTX_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    fake = registerFakePiEngine();
    // fake port 装配（闭包读 let pi——用例内换 pi 后注入面随新 spy）：非 merge 条目
    // 受理即注入 pi.sendMessage。
    currentFakePort = makeFakePort((message) => {
      pi.sendMessage(message as never, { triggerTurn: true });
    });
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("真实 execute + 协议 idle 相位/应答 settle 驱动 → 通知正文含本轮真实回复（非 (empty)）", async () => {
    const ROUND_REPLY = "THE ROUND REPLY";
    const SESSION_FILE = path.join(agentDir, "sess-round-1.jsonl");

    // 真实链路：execute → kickOffChatRound → 协议 engine.run（会话形态 resume{recordId}）。
    const handle = await service.execute({
      task: "tell me something",
      slug: "round-notify",
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

    // record 侧：result 从应答 content 真实流入（非手工预置）+ 轮终翻 idle
    //（[two-state-convergence U4/D3]——idle 即 resumable）+ round+1
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.result).toBe(ROUND_REPLY);
    expect(record!.status).toBe("idle");
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

describe("首轮闭环独有断言面（迁自壳 first-round-closure-service.test.ts）", () => {
  let agentDir: string;
  let service: SubagentService;
  let internals: ServiceInternals;
  let fake: FakePiEnginePort;
  let pi: PiMock;

  beforeEach(() => {
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: emptyRegistry(),
      sessionId: "root-session",
      ctxModel: CTX_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    fake = registerFakePiEngine();
    pi = makePi();
    // fake port 装配（闭包读 let pi——用例内换 pi 后注入面随新 spy）。
    currentFakePort = makeFakePort((message) => {
      pi.sendMessage(message as never, { triggerTurn: true });
    });
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("[T1 独有面] 首轮 notifyComplete 入参形状：轮终翻边 idle 后簿记（round 透传 + result 已写）", async () => {
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 捕获的 pi
    // [collect 退役] 成功轮完成通知唯一通道 = notifyHost.notifyComplete（内部
    // toNotifyRecord 映射 + notifier.notify）——观察点挂 notifyComplete（record 入参）。
    const spy = vi.spyOn(internals.notifyHost, "notifyComplete");

    const handle = await service.execute({ task: "do something", slug: "test" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0]!.settle({ content: "first-round-done" });

    // [two-state-convergence U4/D3] 写面翻边：轮终落 idle（idle 即 resumable）+
    // round 0→1（dedup key 递增）+ record.result 从应答 content 写入。
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.status).toBe("idle");
    expect(record!.round).toBe(1);
    expect(record!.result).toBe("first-round-done");
    // 首条通知入参 = 完成通知的 record（轮终翻边 idle，round 已随簿记 +1 透传，
    // result 从应答 content 写入——BgNotifyRecord 派生视图 status="running" 由
    // notify-host 的映射用例承保）。[collect 退役] 原「settle 内 notify 与 run 续体
    // collectCoordinator 回注」双调用点收敛为成功轮单通道——用户可见面
    //（pi.sendMessage）恒 1 条（末尾断言）。
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ id: record!.id, round: 1, result: "first-round-done" });
    // record 留 store（首轮完成不终态化——原 early-return 的正语义）
    expect(internals.store.getMutable(record!.id)).toBe(record);
    // 双通知点同 id:round → dedup：用户可见恰 1 条
    await new Promise((r) => setTimeout(r, 20));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("[M3 busy 对照] 真在跑的 background 工作（镜像活进程 + 无 timer）→ merge:true 透传端口（窗口判定），非 merge 条目受理即注入", async () => {
    // fake port 装配：非 merge 条目受理即注入 pi.sendMessage（真实 port 直通形态）
    currentFakePort = makeFakePort((message) => {
      pi.sendMessage(message as never, { triggerTurn: true });
    });
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 捕获的 pi
    // 正例（立即送达半边）：chat 轮次完成（轮终翻 idle + arm idle timer → run 应答
    // settle → notifyComplete），record 留 store。旧 hasRunningBackground 按
    // mode==="background" 计数 → 对该 record 恒 true → notify 恒挂 60s 合并窗口，
    // 主 agent 的续聊回复固定延迟 60s（G1 失效）。修复后排除 isIdle（timer armed）
    // record → 立即 flush。
    const handle = await service.execute({ task: "do something", slug: "test" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0]!.settle({ content: "first-round-done" });

    // [M3] 立即 flush——同步断言 sendMessage 已发出（旧实现此处挂 60s timer，0 次调用）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const settled = internals.store.getMutable(handle.subagentId)!;
    expect(settled.round).toBe(1);
    expect(settled.result).toBe("first-round-done"); // 真实派生（非手工预置）

    // double-notify 防护：显式再 notifyComplete 一次（同 id:round）→ port 幂等键
    // `id:round` 判重吞第二次（swallowed，不重复注入）。
    internals.notifyHost.notifyComplete(settled);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // 对照（busy 半边，本文件独有断言面）：真在跑的 background 工作（镜像活进程 +
    // 无 timer）计入合并窗口判定——done 通知以 merge:true 受理（窗口攒批成员，端口
    // 60s 窗口承载，不立即注入；合并窗口语义对真正的并发完成保留）。
    const busy = makeRecord("sa-busy");
    busy.status = "running";
    internals.store.register(busy);
    // 协议形态的「活进程」记账 = core 侧 spawnedChildren 镜像活位（hasRunningBackground
    // 判据 hasLiveProcessHandle 读本镜像）。
    coreSpawnedChildrenMirror().register(busy.id, { pid: 4321, killed: false });
    const done = makeRecord("sa-done");
    done.status = "idle"; // V1 终态形态：markRoundIdle 收尾 idle，toNotifyRecord 放行
    internals.store.register(done);
    internals.notifyHost.notifyComplete(done);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // 未新增——merge:true 不立即注入
    expect(currentFakePort!.records.at(-1)).toMatchObject({ merge: true }); // M3 判据回归锚
  });

  it("[N1 载荷派生视图] one-shot 成功完成通知：details.status=running（轮终通知形态）、正文含真实结果，恰 1 条", async () => {
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 捕获的 pi

    const handle = await service.execute({ task: "one shot task", slug: "oneshot-n1" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0]!.settle({ content: "done" });

    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });
    const sentMsg = pi.sendMessage.mock.calls[0]![0] as {
      customType: string;
      content: string;
      details?: { status?: string };
    };
    expect(sentMsg.customType).toBe("subagent-bg-notify");
    // 完成语义 [modeless]：轮终通知 status=running（旧 idle 折入 running 携带本轮
    // Reply）；closed 仅归档/GC/cancel 路径出现
    expect(sentMsg.details?.status).toBe("running");
    expect(sentMsg.content).toContain("finished a round");
    expect(sentMsg.content).toContain("done"); // 应答 content，经 MF-2 写入 record.result

    // 恰好 1 条：无第二个通知点（轮终 settle 单写点；回注同 id:round 被 dedup 吞）
    await new Promise((r) => setTimeout(r, 20));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // record 落 idle 留守可续聊（万物可续：message 直接续、fork-from 可继承），未终态化
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.status).toBe("idle");
    expect(record!.result).toBe("done");
  });
});
