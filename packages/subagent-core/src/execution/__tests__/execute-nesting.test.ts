// src/__tests__/execute-nesting.test.ts
//
// D-030~D-033 嵌套 / 并发池 / 节流回归锁。独立于 execute-integration.test.ts。
//
// 用例：
//   D-032  background 进并发池（分层配额：max(1, maxConcurrent - depth)）
//   D-033  execute 入口通用嵌套护栏（execCtxAls 计 fork+非 fork 嵌套，深度>MAX 拒）
//   （原「嵌套抑制 onUpdate」「节流清理 throttleState」用例组已随 onEventThrottled
//   死路径删除一并移除——swf-perf-impl ledger #22 / cleanup-slice TC4）
//
// ── mock 策略 ──
//
// [关键] runSpawn（session-runner.ts）通过 child_process.spawn("pi",...) 启动子进程，
//   事件经 stdout JSON 流回流。它 **不走 getSdk / createAgentSession**。
//   因此本文件 mock 的是 node:child_process.spawn（返回 FakeChild），而非 getSdk/fakeSession
//   （那是对 in-process run() 的旧 mock，在 spawn 改造后是死代码）。
//
//   mock 模块工厂已收敛 ./helpers/subagent-service-mocks.ts（四文件共享单源，含
//   spawn → FakeChild / fs 同步方法 / temp-prompt / alive-store / state-marker /
//   manifest-store 的完整桩形与动机注释）。
//
//   所有断言语义不变：它们测的是 SubagentService 的 **编排逻辑**
//   （pool.acquire / execCtxAls 深度），这些逻辑
//   无论事件来自 fakeSession.subscribe 还是 FakeChild.stdout 都一致。

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aliveStoreModule,
  childProcessModule,
  driveChildToCompletion,
  stateMarkerModule,
  fsSyncModule,
  manifestStoreModule,
} from "./helpers/subagent-service-mocks.ts";

vi.mock("node:child_process", () => childProcessModule());
vi.mock("node:fs", async (importOriginal) => fsSyncModule(await importOriginal<typeof import("node:fs")>()));
vi.mock("../alive-store.ts", async (importOriginal) => aliveStoreModule(await importOriginal<typeof import("../alive-store.ts")>()));
vi.mock("../state-marker.ts", () => stateMarkerModule());
vi.mock("../manifest-store.ts", () => manifestStoreModule());

import { spawn } from "node:child_process";

import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import { MAX_FORK_DEPTH } from "../session-context-resolver.ts";
import { SubagentService } from "../subagent-service.ts";

const mockSpawn = vi.mocked(spawn);

// ============================================================
// 辅助：service 构造（与旧 setup 等价，但不再装配 fakeSdk）
// ============================================================

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

interface SetupResult {
  service: SubagentService;
}

function setup(): SetupResult {
  const agentDir = "/tmp/nest-it"; // fs 已 mock，路径不需真实存在
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "nest-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "nest-it" });
  return { service };
}

/** [W3] 协议替身注册 + 受控 settle（原 driveChildToCompletion 的等价驱动面）：
 *  execute 发起的 engine.run 由测试显式应答（轮终语义对齐 driveChild 的 close(0)）。 */
function setupWithFakeEngine(): SetupResult & { fake: FakePiEnginePort } {
  const base = setup();
  clearEngines();
  const fake = registerFakePiEngine();
  return { ...base, fake };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

/** [D3-⑤] execNesting（公共层 ExecutionNestingContext）.run 的 duck-type（绕过
 * import AsyncLocalStorage，足够本组用例——私字段经 Reflect 取，机制与旧 execCtxAls 同构）。 */
interface ExecCtxAls {
  run: <T>(store: { recordId: string | undefined; depth: number }, cb: () => T) => T;
}

describe("嵌套护栏 / 并发池 / 节流（D-030~D-033 回归锁）", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // D-032: background execute 进并发池（分层配额）
  // ============================================================

  it("[D-032] background execute 调 pool.acquire（进池限流）", async () => {
    const { service, fake } = setupWithFakeEngine();

    const pool = Reflect.get(service, "pool") as { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    const acquireSpy = vi.spyOn(pool, "acquire");

    const execPromise = service.execute({ task: "bg in pool", slug: "test", ctxModel });
    // detached kickOffChatRound → acquire。等替身 run 到位再驱动应答。
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "ok" });

    // 等 detached promise 链跑完（kickOffChatRound 的 .then notify）
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(acquireSpy).toHaveBeenCalled();
    // background execute 立即返回 handle（不等完成）
    const handle = await execPromise;
    expect(handle.mode).toBe("background");
    clearEngines();
  });

  // ============================================================
  // D-033: 通用嵌套护栏（execute 入口，execCtxAls 非 fork 路径）
  // ============================================================

  it("[D-033] execCtxAls depth=MAX 时 execute 抛错（nestingDepth=MAX+1 被拒）", async () => {
    const { service } = setup();

    // [R1 深绑改写] execNesting 随域 #2 聚合迁入 SessionBaselines（壳转发 getter 透传），
    // 深绑路径改为 service → baselines 聚合实例（断言对象与强度不变，路径对齐终态结构）。
    const execNesting = (Reflect.get(service, "baselines") as { execNesting: ExecCtxAls }).execNesting;

    await expect(
      execNesting.run({ recordId: "parent", depth: MAX_FORK_DEPTH }, () =>
        service.execute({ task: "too deep", slug: "test", ctxModel }),
      ),
    ).rejects.toThrow(/nesting depth/);

    // 无副作用：guard 在 createRecordForMode 之前，record 未创建
    expect(service.queries.collectRecords(10)).toHaveLength(0);
    // guard 在 spawn 之前——不应 spawn 任何子进程
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("[D-033] execCtxAls depth=MAX-1 时 execute 不抛（nestingDepth=MAX 允许）", async () => {
    const { service, fake } = setupWithFakeEngine();

    // [R1 深绑改写] 同上：execNesting 经 baselines 聚合路径取用。
    const execNesting = (Reflect.get(service, "baselines") as { execNesting: ExecCtxAls }).execNesting;

    const execPromise = execNesting.run({ recordId: "parent", depth: MAX_FORK_DEPTH - 1 }, () =>
      service.execute({ task: "at limit", slug: "test", ctxModel }),
    );
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "ok" });
    const result = await execPromise;

    expect(result.mode).toBe("background");
    clearEngines();
  });

  // ============================================================
  // 原嵌套抑制 onUpdate / 节流清理 throttleState 用例组（:322-355）已删除——
  // onEventThrottled 死路径删除（swf-perf-impl ledger #22 / cleanup-slice TC4/IF14，
  // 详见 .cw/swf-perf-impl/cleanup-slice-design.json）。恢复点：本 slice 前的 git 历史。
  // ============================================================
});
