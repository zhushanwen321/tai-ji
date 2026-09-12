// src/execution/__tests__/nested-visibility-env-propagation.test.ts
//
// SP-8 嵌套可见性修复验证（TC-3：PI_SUBAGENT_ROOT_SESSION_ID env 贯穿）。
//
// 验证 env 身份贯穿机制：
//   TC-3a: 根进程 initSession：无 env → sessionRootId = sessionId（自己是 ROOT）
//   TC-3b: 子进程 initSession：有 env → sessionRootId = env 值（贯穿真 ROOT）
//   TC-3c: 孙进程 initSession：env 链全程贯穿
//   TC-3d: 子进程 execute 创建的 record.rootSessionId = env 贯穿的真 ROOT
//   TC-3e: 子进程 collectRecords 用 sessionRootId 过滤
//
// mock 策略与 recursive-visibility-baseline.test.ts 一致（已收敛
// ./helpers/subagent-service-mocks.ts 四文件共享单源）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aliveStoreModule,
  childProcessModule,
  stateMarkerModule,
  fsSyncModule,
  manifestStoreModule,
} from "./helpers/subagent-service-mocks.ts";
import { registerFakePiEngine } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";

// ── mock modules ──

vi.mock("node:child_process", () => childProcessModule());
vi.mock("node:fs", async (importOriginal) => fsSyncModule(await importOriginal<typeof import("node:fs")>()));
vi.mock("../alive-store.ts", async (importOriginal) => aliveStoreModule(await importOriginal<typeof import("../alive-store.ts")>()));
vi.mock("../state-marker.ts", () => stateMarkerModule());
vi.mock("../manifest-store.ts", () => manifestStoreModule());

import { spawn } from "node:child_process";

import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { RecordStore } from "../record-store.ts";
import { createRecord } from "../execution-record.ts";
import { SubagentService } from "../subagent-service.ts";

const mockSpawn = vi.mocked(spawn);

// ── env 名常量（与 subagent-service.ts 一致）──
const ENV_ROOT_SESSION_ID = "PI_SUBAGENT_ROOT_SESSION_ID";
const ENV_SELF_RECORD_ID = "PI_SUBAGENT_SELF_RECORD_ID";
const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
const ENV_FORK_DEPTH = "PI_SUBAGENT_FORK_DEPTH";
const ENV_ROOT_CWD = "PI_SUBAGENT_ROOT_CWD";

// ── helpers ──

function getLastSpawnEnv(): Record<string, string | undefined> {
  return (mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined>) ?? {};
}

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

function setupService(sessionId: string, env?: Record<string, string>): SubagentService {
  const agentDir = "/tmp/env-prop-it";
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId,
    ctxModel,
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId });
  return service;
}

// ── 用例 ──

describe("TC-3: PI_SUBAGENT_ROOT_SESSION_ID env 贯穿正确", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("TC-3a: 根进程 initSession：无 env → sessionRootId = sessionId（自己是 ROOT）", () => {
    const service = setupService("root-it");
    // [R1 深绑改写] sessionRootId 随域 #2 聚合迁入 SessionBaselines，深绑路径改为
    // service → baselines 聚合实例（断言对象与强度不变，路径对齐终态结构）。
    const sessionRootId = (Reflect.get(service, "baselines") as { sessionRootId: string | null }).sessionRootId as string;
    expect(sessionRootId).toBe("root-it");
  });

  it("TC-3b: 子进程 initSession：有 env PI_SUBAGENT_ROOT_SESSION_ID → sessionRootId = env 值（贯穿真 ROOT）", () => {
    process.env[ENV_ROOT_SESSION_ID] = "real-root-session";
    const service = setupService("child-session");

    // [R1 深绑改写] 同上：sessionRootId 经 baselines 聚合路径读取。
    const sessionRootId = (Reflect.get(service, "baselines") as { sessionRootId: string | null }).sessionRootId as string;
    expect(sessionRootId).toBe("real-root-session"); // env 贯穿，不是 child-session
  });

  it("TC-3c: 孙进程 initSession：env 链全程贯穿，B 的 sessionRootId 仍为 ROOT", () => {
    // 模拟 B 子进程收到的 env（A 在 spawn B 时注入）
    process.env[ENV_ROOT_SESSION_ID] = "root-main-session";
    process.env[ENV_SELF_RECORD_ID] = "sa-a-record";
    process.env[ENV_DEPTH] = "1";

    const service = setupService("b-session");

    // B 的 sessionRootId 仍为 ROOT（env 贯穿，不被 B 自己的 sessionId 覆盖）
    // [R1 深绑改写] 同上：sessionRootId / execNesting 经 baselines 聚合路径读取。
    const sessionRootId = (Reflect.get(service, "baselines") as { sessionRootId: string | null }).sessionRootId as string;
    expect(sessionRootId).toBe("root-main-session");

    // B 的嵌套基线记录了 B 自己的身份（recordId + depth；[D3-⑤] execNesting 公共层）
    const baseline = ((Reflect.get(service, "baselines") as { execNesting: { baseline(): { recordId: string; depth: number } | null } }).execNesting).baseline()!;
    expect(baseline.recordId).toBe("sa-a-record");
    expect(baseline.depth).toBe(1);
  });

  it("TC-3d: 子进程 execute 创建的 record.rootSessionId = env 贯穿的真 ROOT", async () => {
    // [W3] 协议替身挂起（engine.run 不 settle）——record 保持 running 在 store 可观察
    clearEngines();
    registerFakePiEngine();
    process.env[ENV_ROOT_SESSION_ID] = "root-main-session";
    process.env[ENV_SELF_RECORD_ID] = "sa-parent";
    process.env[ENV_DEPTH] = "1";

    const service = setupService("child-session");

    // execute 创建 record（模拟 B 内创建 C）
    const handle = await service.execute({
      task: "nested task",
      slug: "test",
      ctxModel,
    });
    const store = Reflect.get(service, "store") as RecordStore;

    // collectRecords 用 sessionRootId 过滤（子进程应看到 ROOT 整棵树）
    const records = store.collectRecords(100, "all", "root-main-session");
    const found = records.find((r) => r.id === handle.subagentId);

    expect(found).toBeDefined();
    expect(found!.rootSessionId).toBe("root-main-session"); // 指向 ROOT，不是 child-session
    expect(found!.parentRecordId).toBe("sa-parent"); // 父链来自基线
    expect(found!.depth).toBe(2); // 基线 depth=1 + 1 = 2
  });

  it("TC-3e: 子进程 collectRecords 用 sessionRootId 过滤（能看到 ROOT 整棵树）", () => {
    process.env[ENV_ROOT_SESSION_ID] = "root-main-session";
    process.env[ENV_SELF_RECORD_ID] = "sa-parent";
    process.env[ENV_DEPTH] = "1";

    const service = setupService("child-session");

    // 手动注入一条 running record（避免需要真正 spawn）
    const store = Reflect.get(service, "store") as RecordStore;
    const recordC = createRecord("sa-c", {
      agent: "worker",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "deep nested",
      startedAt: Date.now(),
      rootSessionId: "root-main-session",
      parentRecordId: "sa-parent",
      depth: 2,
    });
    store.register(recordC);

    // collectRecords（不带 filter）用 this.sessionRootId 过滤
    const viaService = service.queries.collectRecords(100);
    const ids = viaService.map((r) => r.id);

    // C 的 record 归 ROOT（rootSessionId=root-main-session），能被子进程查到
    expect(ids).toContain("sa-c");
    expect(viaService.find((r) => r.id === "sa-c")!.rootSessionId).toBe("root-main-session");
  });
});
