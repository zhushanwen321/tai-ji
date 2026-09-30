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
//       [N1] one-shot 完成通知载荷投影 details.status="running"。
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
// 通知域注入内核等价桩（对齐 notify-ledger.test.ts 先例，core 依赖闭包不含
// session-delivery）：[M3]/[N1] 的「同 id:round dedup 吞第二次」与投递时机治理依赖
// 内核 dedupe / 合批窗口语义（降级直发无 dedupe 会让 sendMessage 计数翻倍）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { configureNotifyDomain, resetNotifyDomainForTests } from "../../core/notify-ports.ts";
import type { DeliveryConfig, DeliveryHandle, DeliveryMessage, DeliveryPort } from "../../core/notify-ports.ts";
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
import type { ExecutionRecord } from "../assembly/types.ts";
import { SubagentService } from "../subagent-service.ts";

// ─── 投递内核等价桩（与 notifier.test.ts 同款切片：dedupe / busy gate / 合批窗口）──
function createDelivery(port: DeliveryPort, options?: DeliveryConfig): DeliveryHandle {
  const cfg = {
    mergeWindowMs: options?.mergeWindowMs ?? 0,
    mergeHoldActive: options?.mergeHoldActive,
    warn: options?.warn ?? ((msg: string, err?: unknown) => { console.warn(`[session-delivery] ${msg}`, err ?? ""); }),
  };
  const queue: DeliveryMessage[] = [];
  let inFlight = false;
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dedupSet = options?.dedupe ? new Set<string>() : null;

  function isBusy(): boolean {
    // V2 内核（msg-pipeline-debloat D2）：busy 判定 = isIdle() 单条件——hasPendingMessages
    // 自镜像四件套已拆除，在途队列判定内查 port 实装的 active 表，port 消费方不可见。
    try {
      return !port.isIdle();
    } catch {
      return true;
    }
  }

  function doSend(): void {
    if (disposed || queue.length === 0 || inFlight) return;
    inFlight = true;
    const batch = queue.splice(0);
    try {
      port.send(batch[0]!, "interrupt-at-turn-boundary");
    } catch (err) {
      cfg.warn("port.send failed", err);
    }
    inFlight = false;
  }

  function scheduleFlush(): void {
    if (disposed || queue.length === 0 || inFlight) return;
    if (isBusy()) return; // 本文件无退避轮询断言面：busy 即等待（合批 timer / settled 边沿）
    doSend();
  }

  return {
    send(msg) {
      if (disposed) return;
      if (dedupSet) {
        if (msg.dedupeKey !== undefined) {
          if (dedupSet.has(msg.dedupeKey)) return;
          dedupSet.add(msg.dedupeKey);
        }
      }
      queue.push(msg);
      const useMerge = cfg.mergeWindowMs > 0 && cfg.mergeHoldActive != null && cfg.mergeHoldActive();
      if (useMerge) {
        if (mergeTimer !== undefined) clearTimeout(mergeTimer);
        mergeTimer = setTimeout(() => {
          mergeTimer = undefined;
          scheduleFlush();
        }, cfg.mergeWindowMs);
        return;
      }
      if (mergeTimer !== undefined) {
        clearTimeout(mergeTimer);
        mergeTimer = undefined;
      }
      scheduleFlush();
    },
    flush() {
      if (disposed) return;
      if (mergeTimer !== undefined) {
        clearTimeout(mergeTimer);
        mergeTimer = undefined;
      }
      scheduleFlush();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      if (mergeTimer !== undefined) clearTimeout(mergeTimer);
    },
  };
}

// 投递内核经通知域窄端口注入——本文件是真实执行链路回归，投递内核同样保真实
// dedupe / 合批语义（settle 内 notify 与 run 续体回注同 notifyId 重放被吞，降级
// 直发无 dedupe 会让 sendMessage 计数翻倍）；afterEach 重置防注入态泄漏。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
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
    // result 从应答 content 写入——BgNotifyRecord 投影 status="running" 由
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

  it("[M3 busy 对照] 真在跑的 background 工作（镜像活进程 + 无 timer）→ closed 通知挂 60s 合并窗口不立即发送", async () => {
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

    // double-notify 防护：显式再 notifyComplete 一次（同 id:round）→ notifier dedup
    // key=`${id}:${round}` 吞第二次。
    internals.notifyHost.notifyComplete(settled);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // 对照（busy 半边，本文件独有断言面）：真在跑的 background 工作（镜像活进程 +
    // 无 timer）仍计入合并窗口——closed 通知挂 60s 不立即发送（合并窗口语义对真正
    // 的并发完成保留）。
    const busy = makeRecord("sa-busy");
    busy.status = "running";
    internals.store.register(busy);
    // 协议形态的「活进程」记账 = core 侧 spawnedChildren 镜像活位（hasRunningBackground
    // 判据 hasLiveProcessHandle 读本镜像）。
    coreSpawnedChildrenMirror().register(busy.id, { pid: 4321, killed: false });
    const done = makeRecord("sa-done");
    done.status = "idle"; // V1 终态形态：markRoundIdle 收口 idle，toNotifyRecord 放行
    internals.store.register(done);
    internals.notifyHost.notifyComplete(done);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // 未新增——busy 挂起合并窗口
  });

  it("[N1 载荷投影] one-shot 成功完成通知：details.status=running（轮终通知形态）、正文含真实结果，恰 1 条", async () => {
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
