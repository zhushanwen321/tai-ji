// src/execution/__tests__/run-orchestration.test.ts
//
// [H3/R5 测试归位] run 域执行编排聚合（execution/service/run-orchestration.ts）的
// 同名域测试文件。本文件用例自 subagent-service.test.ts「execute() worktree 路径」
// 块整块迁入（用例名与断言零改动，纯移动）；壳级生命周期/查询/emit 面用例留在
// subagent-service.test.ts。同域姊妹文件：conversation-continuation.test.ts（Continuation
// 协作面）/ chat-engine-routing.test.ts（引擎编排分叉）/ execute-nesting.test.ts /
// execute-and-await-worktree.test.ts / delivery-methods.test.ts /
// stream-sink-retirement.test.ts / explicit-agent-ref-guard.test.ts /
// subagent-service-notify-gate.test.ts / workflow-agent-dispatch.test.ts（派发链 × run 域协作面）。
//
// 覆盖（execute 入口 = RunOrchestration.execute，worktree 与 fork 解耦后）：
//   1. worktree:true + fork:false → 解耦后正常（不抛 requires fork）
//   2. worktree:true + fork:true  → 创建 worktree 路径（不抛 requires fork）
//   3. worktree:false + fork:false → 默认路径（不创建 worktree）
//   4. create-await 竞态守卫：create 的 await 窗口内 dispose 抢先 → cleanup 被调 +
//      early-failed 返回（不 kickOff）——「赋值 worktreeHandle → 终态检查 → 轮次
//      kick-off 同一同步段」不变量的回归锚点。
//
// 策略：真实 ModelConfigService 指向 os.tmpdir() 空目录，mock PiLike；本文件不 mock
// spawn（与 subagent-service.test.ts 文件头约定一致——execute 的 spawn 集成测试在
// execute-nesting / execute-integration）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelConfigService } from "../model-config-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { SubagentService } from "../subagent-service.ts";
import type { WorktreeManager } from "../worktree-manager.ts";

// ── 工具:建临时 agentDir + 真实 ModelConfigService（自 subagent-service.test.ts 迁移段自持副本）──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  // agentDir/subagents/ 子目录(config 默认路径会用,空即可)
  return dir;
}

function makeModelService(agentDir: string): ModelConfigService {
  return new ModelConfigService({ agentDir, cwd: agentDir });
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn<(customType: string, data?: unknown) => void>>;
  events: { emit: ReturnType<typeof vi.fn<(channel: string, data: unknown) => void>> };
  sendMessage: ReturnType<typeof vi.fn<(message: Parameters<PiLike["sendMessage"]>[0], options?: Parameters<PiLike["sendMessage"]>[1]) => void>>;
} {
  return {
    appendEntry: vi.fn((customType: string, data?: unknown) => {}),
    events: { emit: vi.fn((channel: string, data: unknown) => {}) },
    sendMessage: vi.fn(() => {}),
  };
}

describe("execute() worktree 路径（worktree 与 fork 解耦）", () => {
  let agentDir: string;
  let modelService: ModelConfigService;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = makeModelService(agentDir);
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ============================================================
  // worktree（文件隔离）与 fork（上下文继承）已解耦：worktree:true 可独立于 fork 工作
  // （worktreeManager.create 只看 opts.worktree，不读 fork）。此组验证三种 fork/worktree
  // 组合下 worktree 路径的行为（均不应抛 'requires fork'——该 guard 已移除）：
  //   1. worktree:true + fork:false → 解耦后正常（创建 worktree 路径，不抛 requires fork）
  //   2. worktree:true + fork:true  → 创建 worktree 路径（测试环境 git 失败，抛非 requires fork 错）
  //   3. worktree:false + fork:false → 默认路径（不创建 worktree）
  //
  // 本文件不 mock spawn（保持与源文件头声明一致——execute 集成测试在 execute-nesting /
  // run-spawn-integration），因此 case 验证「不抛 requires fork」而非「执行完成」：
  // 执行越过 worktree 创建后在后续步骤（worktreeManager.create 调 git / runSpawn 调
  // spawn）抛与 fork/worktree 无关的错。用 try/catch 断言抛出的不是 requires fork。
  // ============================================================

  /** 构造已就绪的 service（initSession + initModel 注入 ctxModel，使 resolveIdentity 不因 model 拗错）。 */
  function makeReadyService(): SubagentService {
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "s1" });
    // 注入 modelRegistry + ctxModel：让 resolveIdentity 越过 resolveModel，
    // 使 guard 之后的失败点稳定在 worktreeManager.create（git）或 runSpawn（spawn），
    // 而非 modelService.resolveModel——避免与 guard 无关的 model 错误掩盖被测点。
    modelService.initModel({
      modelRegistry: {
        getAvailable: () => [],
        find: () => undefined,
        hasConfiguredAuth: () => false,
      },
      sessionId: "s1",
      ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
    });
    return service;
  }

  it("worktree:true + fork:false → 解耦后不抛 'requires fork'（worktree 独立于 fork）", async () => {
    const service = makeReadyService();
    // 解耦后 worktree:true+fork:false 不再 throw requires fork（worktreeManager.create 只看 worktree）
    try {
      await service.execute({
        task: "worktree without fork (decoupled)",
        slug: "test",
        worktree: true,
        fork: false,
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
    } catch (err) {
      // 解耦后绝不抛 requires fork（执行继续到 worktreeManager.create/spawn 才可能抛其他错）
      expect((err as Error).message).not.toMatch(/requires fork/);
    }
  });

  it("worktree:true + fork:true → 创建 worktree 路径（不抛 'requires fork'）", async () => {
    const service = makeReadyService();
    // 执行继续：先创建 record，然后 worktreeManager.create 调 git（测试环境无 repo → 抛与 fork 无关的错）
    try {
      await service.execute({
        task: "worktree with fork",
        slug: "test",
        worktree: true,
        fork: true,
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
      // 若未抛（理论上 worktreeManager.create 在某些环境成功）也 OK——重点是没命中 guard
    } catch (err) {
      // guard 放行：抛出的错误绝不能是 "requires fork"
      expect((err as Error).message).not.toMatch(/requires fork/);
    }
  });

  it("worktree:false + fork:false → 默认路径（不创建 worktree，不抛 'requires fork'）", async () => {
    const service = makeReadyService();
    // 默认路径：runSpawn 调 child_process.spawn（测试环境无真实 pi → 抛与 fork 无关的错）
    try {
      await service.execute({
        task: "default path",
        slug: "test",
        worktree: false,
        fork: false,
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
    } catch (err) {
      // guard 放行：抛出的错误绝不能是 "requires fork"
      expect((err as Error).message).not.toMatch(/requires fork/);
    }
  });

  // ============================================================
  // create-await 竞态守卫（Phase 2）：create 的 await 窗口内 dispose/cancel
  // 可把 record CAS 成 closed——守卫须主动 cleanup + early-failed 返回，不 kickOff。
  // 实现约束固化：「赋值 record.worktreeHandle → 终态检查 → 轮次 kick-off」
  // 必须同一同步段（中间禁止 await），本用例即该不变量的回归锚点。
  // ============================================================
  it("守卫：create await 窗口内 dispose 抢先 → cleanup 被调 + early-failed 返回（不 kickOff）", async () => {
    const service = makeReadyService();
    const wtm = Reflect.get(service, "worktreeManager") as WorktreeManager;
    const handle = Object.freeze({
      path: "/tmp/wt-guard",
      branch: "pi-sub-guard",
      baseCommit: "abc123",
      mainCwd: "/repo",
    }) as Parameters<WorktreeManager["cleanup"]>[0];
    let resolveCreate!: (h: unknown) => void;
    vi.spyOn(wtm, "create").mockImplementation(
      () => new Promise<unknown>((r) => { resolveCreate = r; }) as ReturnType<WorktreeManager["create"]>,
    );
    const cleanupSpy = vi.spyOn(wtm, "cleanup").mockResolvedValue(undefined);

    const execP = service.execute({
      task: "guard test",
      slug: "test",
      worktree: true,
      fork: false,
      ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
    });
    // 微任务推进：record 已建 + execute 挂在 pending create 上
    await new Promise((r) => { setTimeout(r, 0); });
    // dispose 抢先（无需 record id）：CAS running → closed，此时 worktreeHandle 仍
    // undefined（dispose 的 fire-and-forget cleanup 跳过）——守卫是唯一的清理点
    service.disposeAllRecords("parent-shutdown");
    resolveCreate(handle);

    const ret = await execP;
    // 守卫生效：handle 被主动清理（不等 60s reaper）
    expect(cleanupSpy).toHaveBeenCalledWith(handle);
    // 返回 early-failed 形态（details.status 已 closed），而非 kickOff 的 running 形态
    expect(ret.mode).toBe("background");
    expect(ret.details).toMatchObject({ status: "closed" });
  });
});
