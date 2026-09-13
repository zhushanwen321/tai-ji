// src/execution/__tests__/inflight-production-wiring.test.ts
//
// [u7a 生产补挂] D5 在途推送的生产链路 wiring 测试（crash-forensics impl-plan §7 v6）。
//
// 背景：notifyInFlightChanged 此前唯一挂点 = host-bridge arm/disarm 委托，而
// createHostBridge 全仓无生产调用点——生产迁移点（subagent-service 裸 arm/disarm/
// 镜像置死、EngineClient 反向通道镜像）全部不推送，extension 监听者恒收不到帧，
// runtime 侧 inflight 镜像恒 0（Gate B A4 BLOCKED 根因 a）。
//
// 三视角：
//   ①使用者（extension reporter 视角）——注册 setInFlightListener 后，生产迁移点
//     （轮终 arm（Continuation.settleRoundSuccess）/ 续聊派发 disarm
//     （Continuation.dispatchRound）/ dispose 批量回收（disposeAllRecords）/
//     引擎反向通道 childSpawned/childStateChanged）每一处都被触发通知，监听者现取
//     getInFlightSnapshot 即含该 record 贡献的绝对计数（无参签名，发送时刻求值）。
//   ②构建者——推送携带的是双谓词过滤后的真实计数：活句柄 + 无 armed idle timer
//     才计在途；镜像置死后计数即刻回落（EngineClient 镜像桥接投影）。
//   ③观察者——EngineClient 镜像 → core 镜像的单向投影可从镜像面观察（core 镜像
//     条目随反向通道事件出现/置死），壳层监听者异常不反噬主链（既有出口测试覆盖，
//     此处不重复）。
//
// [dev-0.9.19 符号适配] 旧生产链（handleChatRoundPhase 相位帧 / armChatIdleTimer /
// interact 面 message 投递）已随 H1 U6 相位机退役；现生产链 = Continuation
// （轮终簿记 settleRoundSuccess arm / 派发入口 dispatchRound disarm）+ 协议 run
// 承载续聊投递（无 interact 面），本文件断言相应对齐 dev 现名。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../assembly/model-resolver.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { SubagentService, type PiLike } from "../subagent-service.ts";
import { _resetLifecycleState, armIdleTimer, hasIdleTimer } from "../lifecycle/lifecycle-manager.ts";
import {
  registerSpawnedChildForRecord,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import {
  getInFlightSnapshot,
  setInFlightListener,
  type InFlightSnapshot,
} from "../engine/inflight-snapshot.ts";
import { EngineClient } from "../engine/client/engine-client.ts";

const CTX_MODEL: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

/** 最小 fake 子进程（EventEmitter + killed/pid——hasLiveProcessHandle 消费面）。 */
function makeFakeChild(pid = 4242): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  (child as { pid?: number }).pid = pid;
  (child as { killed: boolean }).killed = false;
  return child;
}

interface ServiceInternals {
  store: RecordStore;
}

function setup(): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  fake: FakePiEnginePort;
} {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflight-wiring-"));
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({ modelRegistry: makeEmptyRegistry(), sessionId: "root-session", ctxModel: CTX_MODEL });
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi: makePi(), sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, fake };
}

/** chatMode 续聊态 record（首轮已完成等待续聊——v4 B-1 折入 running）。 */
function makeResumableRecord(id: string): ReturnType<typeof createRecord> {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "initial task",
    slug: "chat",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
  });
  record.status = "running";
  record.round = 1;
  record.controller = new AbortController();
  return record;
}

describe("u7a 生产迁移点 → 在途推送（wiring）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let fake: FakePiEnginePort;
  let seen: InFlightSnapshot[];

  beforeEach(() => {
    ({ agentDir, service, store, fake } = setup());
    seen = [];
    setInFlightListener(() => seen.push(getInFlightSnapshot()));
  });

  afterEach(() => {
    setInFlightListener(null);
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("轮终 arm（生产路径 = Continuation.settleRoundSuccess 轮终簿记）：活句柄翻入保活，推送 inFlight=0", async () => {
    const handle = await service.execute({ task: "first round", slug: "t", ctxModel: CTX_MODEL, conversation: true });
    // detached 派发链异步（dispatchRoundAsync → kickOffChatRound → pool acquire）：
    // 等协议 run 被 fake 捕获（与 delivery-methods.test.ts 同款等待惯例）。
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const run = fake.runs[0]!;
    // 引擎侧活句柄（生产经 EngineClient 反向通道桥接投影——此处直接落 core 镜像，
    // 桥接本体在下方 EngineClient 套件独立验证）
    registerSpawnedChildForRecord(handle.subagentId, makeFakeChild());
    expect(getInFlightSnapshot().inFlight).toBe(1); // 前置：在途句柄在场

    seen.length = 0;
    run.settle({ content: "round 1 done" }); // run 应答 = agent_settled（轮终分流触发器）
    await vi.waitFor(() => expect(hasIdleTimer(handle.subagentId)).toBe(true)); // 轮终 = timer armed
    expect(seen.at(-1)).toEqual({ inFlight: 0 }); // 保活不算在途（D5 谓词）
  });

  it("续聊投递 disarm（生产路径 = deliverChatMessage → Continuation.dispatchRound）：翻回正在执行，推送 inFlight=1", async () => {
    const record = makeResumableRecord("sa-wiring-disarm");
    record.sessionFile = path.join(agentDir, "child-session.jsonl"); // 续聊锚点（dispatchRound 守卫必需）
    // [U4] 锚可解析性要求文件真实在盘（isAnchorResolvable = existsSync）。
    fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
    store.register(record);
    registerSpawnedChildForRecord(record.id, makeFakeChild());
    armIdleTimer(record.id, () => {}); // 预置保活态（上轮已 settle 的形态）——disarm 挂点的真实生效面

    seen.length = 0;
    await service.chatActions.deliverChatMessage(record, "next round msg");

    // 续聊投递 = 新协议 run 承载（H1 U6 后无 interact 面；task.prompt = 聚合消息正文）
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(fake.runs[0]!.task.prompt).toBe("next round msg");
    expect(hasIdleTimer(record.id)).toBe(false);
    expect(seen.at(-1)).toEqual({ inFlight: 1 }); // disarm 后该 record 计在途
  });

  it("dispose 批量回收：逐 record kill+disarm 后收敛推送终态 inFlight=0", async () => {
    const record = makeResumableRecord("sa-wiring-dispose");
    store.register(record);
    registerSpawnedChildForRecord(record.id, makeFakeChild());
    expect(getInFlightSnapshot().inFlight).toBe(1);

    seen.length = 0;
    service.dispose();
    expect(seen.at(-1)).toEqual({ inFlight: 0 });
    expect(getInFlightSnapshot().inFlight).toBe(0);
  });
});

describe("u7a 数据面桥接：EngineClient 反向通道镜像 → core 镜像 + 推送", () => {
  let dataDir: string;
  let client: EngineClient;
  let seen: InFlightSnapshot[];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflight-bridge-"));
    // 不 connect（构造即被测面：镜像变更经 onChange 同步广播）——零子进程零 fs 写
    client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      hostKind: "test",
      hostVersion: "test-host-1.0",
      dataDir,
      envPrefixes: [],
    });
    seen = [];
    setInFlightListener(() => seen.push(getInFlightSnapshot()));
  });

  afterEach(() => {
    setInFlightListener(null);
    client.dispose();
    _resetCoreSpawnedChildrenMirrorForTest();
    _resetLifecycleState();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("childSpawned → core 镜像落项 + 推送 inFlight=1；childStateChanged(exited) → 置死 + 推送 inFlight=0", () => {
    client.mirror.recordSpawned(4242, "sa-bridge");
    expect(seen.at(-1)).toEqual({ inFlight: 1 });
    expect(getInFlightSnapshot().inFlight).toBe(1); // core 镜像已投影（计数数据源）

    client.mirror.recordStateChanged({ pid: 4242, recordId: "sa-bridge", state: "exited", killed: true });
    expect(seen.at(-1)).toEqual({ inFlight: 0 });
    expect(getInFlightSnapshot().inFlight).toBe(0);
  });

  it("同 recordId 重 spawn 覆盖 + killedAll 整体置死（引擎回收语义投影）", () => {
    client.mirror.recordSpawned(111, "sa-bridge-a");
    client.mirror.recordSpawned(222, "sa-bridge-b");
    expect(seen.at(-1)).toEqual({ inFlight: 2 });

    client.mirror.killAll(); // 引擎 exit / killAll：逐项 killedAll 事件
    expect(seen.at(-1)).toEqual({ inFlight: 0 });
    expect(getInFlightSnapshot().inFlight).toBe(0);
  });
});
