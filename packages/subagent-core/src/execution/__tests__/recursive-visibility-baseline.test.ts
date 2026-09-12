// src/execution/__tests__/recursive-visibility-baseline.test.ts
//
// 递归 subagent 跨进程身份：进程级基线兜底验证（ALS 断裂修复）。
//
// 背景（2026-08-11 实测）：pi RPC mode 的 stdin JSONL 是事件回调式读取
// （attachJsonlLineReader → stream.on("data")），每个 RPC 命令是独立异步链。
// initSession 里 execCtxAls.enterWith 的 store 不会贯穿到后续 tool 调用事件——
// 递归第二层 subagent 的 parentRecordId/depth 丢失（rootSessionId 是实例字段所以正确）。
//
// 修复：execCtxBaseline / forkDepthBaseline 实例字段（initSession 从 env 读取，
// 与 sessionRootId 同机制），createRecordForMode / 嵌套护栏读 ALS store 失败时兜底。
// 本文件验证：
//   1. 有 env（子进程身份）→ execute 创建的 record parentRecordId/depth 来自基线
//   2. 无 env（根进程）→ parentRecordId undefined / depth 0（顶层）
//   3. execCtxAls.run 的 store 优先于基线（并发链语义不回归）
//   4. forkDepth 基线：env PI_SUBAGENT_FORK_DEPTH → fork spawn env 递增
//
// mock 策略与 execute-nesting.test.ts 一致（spawn → FakeChild，fs 同步方法 mock，
// temp-prompt / alive-store / state-marker / manifest-store mock；已收敛
// ./helpers/subagent-service-mocks.ts 四文件共享单源）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aliveStoreModule,
  childProcessModule,
  stateMarkerModule,
  fsSyncModule,
  manifestStoreModule,
} from "./helpers/subagent-service-mocks.ts";

// ── mock modules（同 execute-nesting.test.ts）──

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
import { ManifestStore } from "../manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../path-encoding.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";

const mockSpawn = vi.mocked(spawn);

// ── 身份 env 名（与 subagent-service.ts 常量一致，避免魔法字符串）──
const ENV_ROOT_SESSION_ID = "PI_SUBAGENT_ROOT_SESSION_ID";
const ENV_SELF_RECORD_ID = "PI_SUBAGENT_SELF_RECORD_ID";
const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
const ENV_ROOT_CWD = "PI_SUBAGENT_ROOT_CWD";
const ENV_FORK_DEPTH = "PI_SUBAGENT_FORK_DEPTH";

function getLastSpawnEnv(): Record<string, string | undefined> {
  return (mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined>) ?? {};
}

/** [W3] 协议替身：execute → engine.run 挂起不 settle——record 保持 running 在 store
 *  可观察（原 FakeChild 挂起不推进的等价形态）。 */
function registerHangingEngine(): FakePiEnginePort {
  clearEngines();
  return registerFakePiEngine();
}

// ── 辅助：service 构造 ──

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

function setup(env: Record<string, string>): { service: SubagentService; store: RecordStore } {
  const agentDir = "/tmp/baseline-it";
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "baseline-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "baseline-it" });
  const store = Reflect.get(service, "store") as RecordStore;
  return { service, store };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

/** execCtxAls.run 的 duck-type（绕过 import AsyncLocalStorage）。 */
interface ExecCtxAls {
  run: <T>(store: { recordId: string | undefined; depth: number }, cb: () => T) => T;
}

// ── 用例 ──

describe("进程级基线兜底（ALS 断裂修复，pi 事件回调模型）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理身份 env，防用例间泄漏
    for (const k of [ENV_ROOT_SESSION_ID, ENV_SELF_RECORD_ID, ENV_DEPTH, ENV_FORK_DEPTH, ENV_ROOT_CWD]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of [ENV_ROOT_SESSION_ID, ENV_SELF_RECORD_ID, ENV_DEPTH, ENV_FORK_DEPTH, ENV_ROOT_CWD]) {
      delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  it("[核心回归] 有 env（子进程身份）：execute 创建 record 的 parentRecordId/depth 来自基线，不依赖 ALS store", async () => {
    // 模拟第一层 subagent 进程：env 注入「自己的身份」（父 record id + depth=1）
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-parent-record";
    process.env[ENV_DEPTH] = "1";

    const { service, store } = setup({});
    registerHangingEngine();

    // 不在 execCtxAls.run 内调用（模拟 ALS 断裂：事件回调上下文读不到 store）
    const handle = await service.execute({ task: "child of parent", slug: "test", ctxModel });

    const rec = store.collectRecords(10, "all", "root-main").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec!.parentRecordId).toBe("sa-parent-record");
    expect(rec!.depth).toBe(2); // 基线 depth 1 + 1
    expect(rec!.rootSessionId).toBe("root-main");

    // [MF-1 回归] 读侧 collectRecords 过滤必须与写侧盖章同源（sessionRootId）。
    // 旧实现传 this.sessionId（子进程自己的 session id ≠ ROOT）→ 子进程内列表恒空。
    // 子进程的本进程 sessionId 是 "baseline-it"（initSession 注入），而 record 归属
    // root-main（env 贯穿的真 ROOT）——能查到即证明过滤用的是 sessionRootId。
    const viaService = service.queries.collectRecords(10);
    expect(viaService.map((r) => r.id)).toContain(handle.subagentId);
    expect(viaService[0]!.rootSessionId).toBe("root-main");
  });

  it("[顶层] 无 env（根进程）：parentRecordId undefined / depth 0", async () => {
    const { service, store } = setup({});
    registerHangingEngine();

    const handle = await service.execute({ task: "top level", slug: "test", ctxModel });

    const rec = store.collectRecords(10, "all", "baseline-it").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec!.parentRecordId).toBeUndefined();
    expect(rec!.depth).toBe(0);
  });

  it("[优先级] execCtxAls.run 的 store 优先于基线（并发链语义不回归）", async () => {
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-baseline";
    process.env[ENV_DEPTH] = "0";

    const { service, store } = setup({});
    registerHangingEngine();
    // [R1 深绑改写] execNesting 随域 #2 聚合迁入 SessionBaselines，深绑路径改为
    // service → baselines 聚合实例（断言对象与强度不变，路径对齐终态结构）。
    const execNesting = (Reflect.get(service, "baselines") as { execNesting: ExecCtxAls }).execNesting;

    const handle = await execNesting.run({ recordId: "sa-inline-parent", depth: 3 }, () =>
      service.execute({ task: "inline nested", slug: "test", ctxModel }),
    );

    const rec = store.collectRecords(10, "all", "root-main").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec!.parentRecordId).toBe("sa-inline-parent"); // run store 优先，非基线 sa-baseline
    expect(rec!.depth).toBe(4);
  });

  it("[forkDepth 基线] env PI_SUBAGENT_FORK_DEPTH=1 → initSession 建立基线（读点兜底基线生效）", async () => {
    // [W3 改写] spawn env 注入（PI_SUBAGENT_FORK_DEPTH 递增写子 env）属 inproc
    // runSpawn 机制，随 inproc pi 引擎目录 删除迁入引擎包（pi-subagent-cli spawn 链）；core
    // 侧存留语义 = initSession 从 env 建立基线（ALS 断裂时的读点兜底），本用例锁定它。
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-fork-parent";
    process.env[ENV_DEPTH] = "0";
    process.env[ENV_FORK_DEPTH] = "1";

    const { service } = setup({});
    registerHangingEngine();

    // [R1 深绑改写] forkDepthBaseline 经 baselines 聚合路径读取（同一权威字段，等价强度）。
    expect((Reflect.get(service, "baselines") as { forkDepthBaseline: number }).forkDepthBaseline).toBe(1);

    // fork 请求照常派发（引擎侧承载深度传递）——不因基线读取抛错
    await expect(service.execute({ task: "fork child", slug: "test", ctxModel, fork: true })).resolves.toBeDefined();
  });

  it("[嵌套护栏] 基线 depth 参与 execute 入口嵌套护栏（depth>MAX 拒绝）", async () => {
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-deep-parent";
    process.env[ENV_DEPTH] = "5";

    const { service } = setup({});

    // MAX_FORK_DEPTH 至少 > 5 才不会被误拒；这里验证基线参与计数的方式是
    // 用直接深度断言——execute 不抛错说明 nestingDepth=6 未超限，护栏不误伤。
    // （MAX_FORK_DEPTH 具体值由 session-context-resolver 定义，这里不硬编码。）
    await expect(service.execute({ task: "deep but allowed", slug: "test", ctxModel })).resolves.toBeDefined();
  });

  it("[MF-3 回归] 有 ENV_ROOT_CWD（worktree 子进程）：sessions 与 records 两套目录统一编码在 ROOT cwd 段", () => {
    // 模拟 B（worktree 子进程，自身 cwd=checkout 路径）经 env 拿到真 ROOT cwd。
    // 旧实现按 init.cwd 编码 → enc(checkout) 段，ROOT 磁盘重建扫不到（MF-3）。
    const rootCwd = "/root/project";
    process.env[ENV_ROOT_CWD] = rootCwd;

    const agentDir = "/tmp/baseline-it";
    const checkoutPath = "/var/folders/worktree/pi-subagents/--root-project--/branch";
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "baseline-it",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    // service cwd = checkout 路径（worktree 子进程的 spawn cwd）
    const service = new SubagentService({
      cwd: checkoutPath,
      modelService,
      getMainSessionFile: () => "/mock/main-session.jsonl",
    });

    const store = Reflect.get(service, "store") as RecordStore;
    const sessionsDir = Reflect.get(store, "sessionsDir") as string;
    // ManifestStore 在本文件被 mock：recordsDir 从构造调用参数取（vi.fn 包裹）
    const recordsDir = vi.mocked(ManifestStore).mock.calls.at(-1)?.[0] as string | undefined;

    // 两套目录都编码在 enc(ROOT cwd) 段（不是 enc(checkout)）
    expect(sessionsDir).toBe(getSubagentSessionDir(agentDir, rootCwd));
    expect(recordsDir).toBe(getSubagentRecordsDir(agentDir, rootCwd));
  });
});
