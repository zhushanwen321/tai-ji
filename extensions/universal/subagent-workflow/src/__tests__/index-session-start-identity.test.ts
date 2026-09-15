// src/__tests__/index-session-start-identity.test.ts
//
// [M4 / V2 决策 5] identity 子进程写入测试。
//
// 验证 session 装配（identity 重建块）的写入职责（[u-5b / A-V3] 改写为 bootstrap
// seam 直测——identity 重建住在 session-lifecycle.ts 装配链最前段，fake pi 捕获
// appendEntry 即可断言，不再挂载 index.ts、不再整类 mock SubagentService/pi-ai/typebox）：
//   1. 子进程（PI_SUBAGENT_SELF_RECORD_ID 存在）：调 pi.appendEntry 写
//      customType="subagent-identity" 的 custom entry，data 字段与 env 组装的
//      SubagentIdentityData 一致（id/agent/mode/task/slug/startedAt/rootSessionId/
//      parentRecordId/depth/forkDepth/worktree）。
//   2. 主进程（无 PI_SUBAGENT_SELF_RECORD_ID）：不写 identity custom entry。
//   3. 可选字段缺失（slug/parentRecordId/forkDepth/worktree 未注入）：identity 仍写入，
//      可选字段为 undefined / false，不抛错。
//   4. 主进程分支下 loadAll 裁剪接线（21 done → 20）与 identity 共存（W3TC9）——
//      装配结果 result.runs 直接观察（旧形态经 registerWorkflowsCommand 捕获 runs
//      getter，观察面等价迁移）。
//
// 修复背景：旧实现父进程 fs.appendFileSync 补写的 custom entry 缺 id/parentId →
// 污染 pi _buildIndex leafId → message tree 断成两棵 → 多轮对话丢上下文。
// 改由子进程（session 文件所有者）在 session_start 用 pi.appendEntry 写，
// pi 自动生成 id/parentId → message tree 连续。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import type { WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core";
import { IDENTITY_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
import type { SessionLifecycleDeps } from "../session-lifecycle.ts";

// session_start 的 recoverCrashedRuns（loadAll 淘汰接线 W3TC9 依赖）经 oncePerProcess
// 守卫（u-audit-fix），守卫 Map 是模块级状态：beforeEach resetModules + 用例内动态
// import setupSessionLifecycle 每用例取新鲜模块实例，否则首用例消费 key 后 W3TC9 的
// 裁剪链静默不执行（静态引用跨 resetModules 存活，守卫 Map 不随用例重置）。

// ── helpers ──────────────────────────────────────────────────────────────────

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_MODE",
  "PI_SUBAGENT_TASK",
  "PI_SUBAGENT_SLUG",
  "PI_SUBAGENT_STARTED_AT",
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_PARENT_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_FORK_DEPTH",
  "PI_SUBAGENT_WORKTREE",
] as const;

function clearIdentityEnv(): void {
  for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
}

/** 可观察 appendEntry 的 fake pi（identity 写入断言面）。 */
function createFakePi(): {
  pi: ExtensionAPI;
  appendEntrySpy: ReturnType<typeof vi.fn>;
} {
  const appendEntrySpy = vi.fn();
  const noop = (): void => {
    /* fake */
  };
  const pi = {
    appendEntry: appendEntrySpy,
    events: { emit: vi.fn() },
    on: noop,
    sendMessage: noop,
  } as unknown as ExtensionAPI;
  return { pi, appendEntrySpy };
}

/** 最小 fake ExtensionContext（tui mode，足够走完装配）。 */
function createFakeCtx(): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode: "tui",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-identity-1",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-identity-1.jsonl",
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

/** seam deps：fake 双 Service 工厂 + fake wtm + fake store（loadAll 可配）。 */
function makeSeamDeps(loadAll: () => Promise<WorkflowRunType[]> = async () => []): SessionLifecycleDeps {
  return {
    createServices: (() => ({
      service: {
        initSession: vi.fn(),
        recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
        startGcTimer: vi.fn(),
      },
      modelService: {
        initModel: vi.fn(),
        reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
      },
      reused: false,
    })) as never,
    worktreeManager: { scan: vi.fn(async () => {}) },
    createRunStore: () =>
      ({
        loadAll,
        save: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      }) as never,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  clearIdentityEnv();
});

afterEach(() => {
  clearIdentityEnv();
});

// ── tests ──

describe("session_start identity 子进程写入（M4 / V2 决策 5）", () => {
  it("子进程（PI_SUBAGENT_SELF_RECORD_ID 存在）：appendEntry 写完整 identity custom entry", async () => {
    process.env.PI_SUBAGENT_SELF_RECORD_ID = "rec-child-1";
    process.env.PI_SUBAGENT_AGENT = "worker";
    process.env.PI_SUBAGENT_MODE = "background";
    process.env.PI_SUBAGENT_TASK = "fix the bug";
    process.env.PI_SUBAGENT_SLUG = "fix-bug";
    process.env.PI_SUBAGENT_STARTED_AT = "1700000000000";
    process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root-session-9";
    process.env.PI_SUBAGENT_PARENT_RECORD_ID = "rec-parent-0";
    process.env.PI_SUBAGENT_DEPTH = "2";
    process.env.PI_SUBAGENT_FORK_DEPTH = "1";
    process.env.PI_SUBAGENT_WORKTREE = "true";

    const { pi, appendEntrySpy } = createFakePi();
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");

    await setupSessionLifecycle(pi, createFakeCtx(), makeSeamDeps());

    // 找到 identity 的 appendEntry 调用（customType = IDENTITY_CUSTOM_TYPE）
    const identityCall = appendEntrySpy.mock.calls.find(
      (c: unknown[]) => c[0] === IDENTITY_CUSTOM_TYPE,
    );
    expect(identityCall).toBeDefined();
    // customType 第一参数
    expect(identityCall![0]).toBe(IDENTITY_CUSTOM_TYPE);
    // data 第二参数：与 env 组装的 SubagentIdentityData 一致
    const data = identityCall![1] as Record<string, unknown>;
    expect(data).toMatchObject({
      id: "rec-child-1",
      agent: "worker",
      mode: "background",
      task: "fix the bug",
      slug: "fix-bug",
      startedAt: 1700000000000,
      rootSessionId: "root-session-9",
      parentRecordId: "rec-parent-0",
      depth: 2,
      forkDepth: 1,
      // [modeless 波5] chatMode 不再入 identity（模式消亡，写面停写）
      // [review round2] worktree 隔离标志经 env 贯穿写入 identity entry（跨重启重建
      // 拒绝续聊的数据源）
      worktree: true,
    });
    expect(Object.keys(data)).not.toContain("chatMode");
  });

  it("主进程（无 PI_SUBAGENT_SELF_RECORD_ID）：不写 identity custom entry", async () => {
    // 不设 SELF_RECORD_ID（主进程环境）
    const { pi, appendEntrySpy } = createFakePi();
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");

    await setupSessionLifecycle(pi, createFakeCtx(), makeSeamDeps());

    // 无 identity 的 appendEntry 调用（logger.warn 等可能调 workflow:log，需过滤）
    const identityCall = appendEntrySpy.mock.calls.find(
      (c: unknown[]) => c[0] === IDENTITY_CUSTOM_TYPE,
    );
    expect(identityCall).toBeUndefined();
  });

  it("可选字段缺失（slug/parentRecordId/forkDepth/worktree 未注入）：identity 仍写入，可选字段为默认", async () => {
    process.env.PI_SUBAGENT_SELF_RECORD_ID = "rec-child-2";
    process.env.PI_SUBAGENT_AGENT = "explorer";
    process.env.PI_SUBAGENT_MODE = "background";
    process.env.PI_SUBAGENT_TASK = "scan code";
    process.env.PI_SUBAGENT_STARTED_AT = "1700000000002";
    process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root-9";
    process.env.PI_SUBAGENT_DEPTH = "1";
    // 不设 SLUG / PARENT_RECORD_ID / FORK_DEPTH / WORKTREE

    const { pi, appendEntrySpy } = createFakePi();
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");

    await setupSessionLifecycle(pi, createFakeCtx(), makeSeamDeps());

    const identityCall = appendEntrySpy.mock.calls.find(
      (c: unknown[]) => c[0] === IDENTITY_CUSTOM_TYPE,
    );
    expect(identityCall).toBeDefined();
    const data = identityCall![1] as Record<string, unknown>;
    // 必填字段正常
    expect(data.id).toBe("rec-child-2");
    expect(data.agent).toBe("explorer");
    expect(data.mode).toBe("background");
    expect(data.startedAt).toBe(1700000000002);
    // 可选字段缺失 → undefined / false（chatMode 已随 modeless 波1 停写，键不存在）
    expect(Object.keys(data)).not.toContain("chatMode");
    expect(data.slug).toBeUndefined();
    expect(data.parentRecordId).toBeUndefined();
    expect(data.forkDepth).toBeUndefined();
    expect(data.worktree).toBe(false);
  });

  it("W3TC9: 主进程分支 session_start 裁剪接线——21 done 经 loadAll 裁到 20（identity 与淘汰共存）", async () => {
    // identity handler 前段（appendEntry）与裁剪接线（loadAll 循环后）共存于同一
    // session 装配——主进程分支（PI_SUBAGENT_SELF_RECORD_ID 未设，beforeEach
    // 已清）验证裁剪同样生效。
    const T0 = Date.parse("2020-01-01T00:00:00.000Z");
    const doneRuns = Array.from({ length: 21 }, (_, i) =>
      WorkflowRun.reconstruct(
        `wf-id-${i}`,
        {
          scriptSource: "execute() {}",
          args: {},
          scriptName: "test",
          scriptPath: "/fake/test.js",
        },
        {
          status: "done",
          reason: "completed",
          budget: new Budget({ maxTokens: 1000 }),
          calls: new Map(),
          trace: new Trace(),
          errorLogs: [],
        },
        {
          startedAt: new Date(T0 + i * 60_000).toISOString(),
          completedAt: new Date(T0 + i * 60_000).toISOString(),
        },
      ));

    const { pi } = createFakePi();
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const result = await setupSessionLifecycle(pi, createFakeCtx(), makeSeamDeps(async () => doneRuns));

    // 装配结果 runs Map（旧形态经 registerWorkflowsCommand 捕获 getter，等价迁移）
    const runs = result.runs;
    // 21 done 裁 1：最旧（wf-id-0）被裁
    expect(runs.size).toBe(20);
    expect(runs.has("wf-id-0")).toBe(false);
    for (let i = 1; i < 21; i++) {
      expect(runs.has(`wf-id-${i}`)).toBe(true);
    }
  });
});
