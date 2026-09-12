// src/__tests__/execute-and-await-worktree.test.ts
//
// executeAndAwait 的 worktree 失败收尾测试（W1 code review 修复回归锁）。
//
// 覆盖：worktreeManager.create 抛错时 record 被 finalizeFailed（status→failed）且原错外抛。
// （worktree 与 fork 解耦后，worktree:true+fork:false 的解耦验证见 subagent-service.test.ts。）
//
// ── mock 策略 ──
//
// 复用 execute-nesting.test.ts 的 spawn / node:fs / manifest-store / temp-prompt / alive-store
// / state-marker mock 范式，已收敛到 ./helpers/subagent-service-mocks.ts 单源（四文件
// 共享）。本文件 **不驱动 FakeChild 完成**——被测的两个分支都在 runSpawn 之前抛/收尾
// （worktree create 在步骤 2.5，runSpawn 在步骤 5），因此 spawn 即使被调也无人驱动，
// 测试在抛错后立即断言即可结束。
//
// worktreeManager 是 SubagentService 构造时 new 出的私有字段（WorktreeManager 实例，非模块）。
// 测试 2 用 vi.spyOn(Reflect.get(service, "worktreeManager"), "create") 注入抛错，无需模块级 mock。

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aliveStoreModule,
  childProcessModule,
  stateMarkerModule,
  fsSyncModule,
  manifestStoreModule,
} from "./helpers/subagent-service-mocks.ts";

vi.mock("node:child_process", () => childProcessModule());
vi.mock("node:fs", async (importOriginal) => fsSyncModule(await importOriginal<typeof import("node:fs")>()));
vi.mock("../alive-store.ts", async (importOriginal) => aliveStoreModule(await importOriginal<typeof import("../alive-store.ts")>()));
vi.mock("../state-marker.ts", () => stateMarkerModule());
vi.mock("../manifest-store.ts", () => manifestStoreModule());

import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { RecordStore } from "../record-store.ts";
import type { WorktreeManager } from "../worktree-manager.ts";
import { SubagentService } from "../subagent-service.ts";

// ── 辅助：service 构造（与 execute-nesting.test.ts setup 等价）──

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

interface SetupResult {
  service: SubagentService;
  worktreeManager: WorktreeManager;
}

function setup(): SetupResult {
  const agentDir = "/tmp/exec-await-worktree-it"; // fs 已 mock，路径不需真实存在
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "exec-await-worktree-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "exec-await-worktree-it" });
  // worktreeManager 是 SubagentService 构造时 new 的 private 字段（无外部注入入口），
  // 测试经 Reflect.get 访问后 cast 到生产导出类型 WorktreeManager（已在文件顶部 import），
  // 让字段/方法签名与生产类型契约绑定。
  const worktreeManager = Reflect.get(service, "worktreeManager") as WorktreeManager;
  return { service, worktreeManager };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

/**
 * 从 service 取出 private store（断言 record 终态用）。
 *
 * worktreeManager 与 store 都是 SubagentService 构造时 new 出的 private 字段——
 * 无外部注入入口，测试只能经 Reflect.get 访问。这里 cast 到生产导出类型
 * （RecordStore / WorktreeManager）而非内联匿名 shape，让测试与生产类型契约绑定：
 * 字段改名/签名变更时 tsc 立即报错（而非静默漂移）。
 */
function getStore(service: SubagentService): RecordStore {
  return Reflect.get(service, "store") as RecordStore;
}

describe("executeAndAwait worktree 失败收尾", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // worktreeManager.create 抛错 → record 收尾为 failed + 原错外抛
  // ============================================================
  it("worktreeManager.create 失败时 finalizeFailed 收尾 record 并抛原错", async () => {
    const { service, worktreeManager } = setup();

    const createErr = new Error("worktree create boom");
    vi.spyOn(worktreeManager, "create").mockImplementation(() => {
      throw createErr;
    });

    // spy store.archive：finalizeFailed 真实收尾链（CAS→completeRecord→archive）的最末一步。
    // 捕获传入 archive 的 record，断言其 status 已被推向 "failed"（证明 finalizeFailed 完整执行，
    // 而非仅 tryTransition 中途返回）。archive 真实执行（不 mockImplementation）以保留移出 running map 的语义。
    const store = getStore(service);
    const archiveSpy = vi.spyOn(store, "archive");

    await expect(
      service.executeAndAwait({
        task: "worktree create will fail",
        slug: "worktree-create-fail",
        worktree: true,
        fork: true,
        ctxModel,
      }),
    ).rejects.toBe(createErr);

    // finalizeFailed 完整执行：record 经 CAS→completeRecord 推到 failed 终态后 archive。
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    // store 现已强类型为 RecordStore → archive 入参为 ExecutionRecord，无需 `as` 断言。
    const archivedRecord = archiveSpy.mock.calls[0]![0];
    expect(archivedRecord.status).toBe("closed");
    // archive 后 record 已移出 running map → listRunning 空、getMutable 取不到。
    expect(store.listRunning()).toHaveLength(0);
    expect(store.getMutable(archivedRecord.id)).toBeUndefined();
  });

  // ============================================================
  // create-await 竞态守卫（Phase 2）：create await 窗口内 dispose 抢先把
  // record CAS 成 closed → 守卫 cleanup + throw cancelled（失败 throw 语义，
  // SAR.run 的 catch 会转 AgentResult.error）。守卫 throw 不落在 try 内
  // （否则被上方 catch 当 create 失败再走 finalizeFailed，对已 closed record 语义未定义）。
  // ============================================================
  it("守卫：create await 窗口内 dispose 抢先 → cleanup 被调 + throw cancelled（不进 runAndFinalize）", async () => {
    const { service, worktreeManager } = setup();

    const handle = Object.freeze({
      path: "/tmp/wt-guard2",
      branch: "pi-sub-guard2",
      baseCommit: "abc123",
      mainCwd: "/repo",
    }) as Parameters<WorktreeManager["cleanup"]>[0];
    let resolveCreate!: (h: unknown) => void;
    vi.spyOn(worktreeManager, "create").mockImplementation(
      () => new Promise<unknown>((r) => { resolveCreate = r; }) as ReturnType<WorktreeManager["create"]>,
    );
    const cleanupSpy = vi.spyOn(worktreeManager, "cleanup").mockResolvedValue(undefined);

    const execP = service.executeAndAwait({
      task: "guard test",
      slug: "guard-test",
      worktree: true,
      fork: true,
      ctxModel,
    });
    // 微任务推进：record 已建 + executeAndAwait 挂在 pending create 上
    await new Promise((r) => { setTimeout(r, 0); });
    // dispose 抢先：CAS running → closed（此刻 worktreeHandle 仍 undefined，
    // dispose 的 fire-and-forget cleanup 跳过）——守卫是唯一清理点
    service.disposeAllRecords("parent-shutdown");
    resolveCreate(handle);

    await expect(execP).rejects.toThrow("cancelled during worktree creation");
    expect(cleanupSpy).toHaveBeenCalledWith(handle);
  });
});
