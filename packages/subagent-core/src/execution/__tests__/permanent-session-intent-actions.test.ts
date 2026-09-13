// src/execution/__tests__/permanent-session-intent-actions.test.ts
//
// [U5 / §3.2.5 意愿动作] 验收单测族（实施单元 U5 验收条款逐项）：
//   1. cancel 新语义：abort 当前轮 → settle idle + interrupted + 放弃轮标记（无
//      closedReason、不终态化）——设计表格 cancel 行 / S1 取消后续聊前置。
//   2. close 归档编排：intent=archived + worktree 回收（patch 前移落盘）+ `.alive`
//      release + pending 注销补发（archived reason）——设计表格 close 行资源处置列。
//   3. 顺序约束 [写死]：收口轮 settle → 轮次通知送达 → intent 翻转 + 归档（Continuation
//      settle 分支 order 账本断言——route 先于 archive，防 gate ①静默吞收口轮通知）。
//   4. worktree 续聊重建三失败形态（worktree-manager.reconstruct：①patch 丢失/分支
//      不存在 → degrade-reopen；②apply 冲突 → 干净基线 conflict；③IO 错 → 响亮 throw）
//      ——设计 §3.2.5 worktree 续聊重建段。
//   5. message 隐含寻回：archived + message → intent 翻回 active（markReactivated）。
//   6. notifyId epoch 防撞：epoch>0 轮次通知 key = `id:epoch:round`（§3.2.3，reopen
//      后 round 归零不与历史轮撞键；epoch=0 恒旧格式——磁盘账本零迁移）。
//
// mock 形态：worktree 重建族 = mock execFile/registry/fs（对齐 worktree-manager.test.ts
// 同源范式）；close 归档编排 = mock deps 注入（RecordLifecycle 构造注入，无 fs 依赖）；
// Continuation 顺序约束 = mock host + order 账本（对齐 conversation-continuation.test.ts）。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── worktree-manager 依赖 mock（对齐 worktree-manager.test.ts 范式）──

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    symlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  symlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../persistence/alive-store.ts", () => ({
  isProcessAlive: vi.fn(),
}));

// kill 链记账 spy（archiveIdleRecord 断言消费——hoisted 形态对齐 conversation-continuation.test.ts）
const { killChildSpy } = vi.hoisted(() => ({ killChildSpy: vi.fn() }));
vi.mock("../engine/host/spawned-children.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/host/spawned-children.ts")>();
  return { ...actual, killRecordChildWithEscalation: killChildSpy };
});

const { mockLoad, mockAdd, mockRemove, registryEntries } = vi.hoisted(() => {
  type Entry = { repo: string; branch: string; checkout: string; pid: number; createdAt: number; sessionFile?: string };
  const entries: Entry[] = [];
  return {
    registryEntries: entries,
    mockLoad: vi.fn((): Entry[] => entries.slice()),
    mockAdd: vi.fn((e: Entry): void => {
      const idx = entries.findIndex((x) => x.branch === e.branch);
      if (idx >= 0) entries[idx] = e;
      else entries.push(e);
    }),
    mockRemove: vi.fn((branch: string): void => {
      const idx = entries.findIndex((x) => x.branch === branch);
      if (idx >= 0) entries.splice(idx, 1);
    }),
  };
});

vi.mock("../worktree/worktree-registry.ts", () => ({
  WorktreeRegistry: class {
    add = mockAdd;
    updatePid = vi.fn();
    remove = mockRemove;
    load = mockLoad;
  },
  SPAWN_GRACE_MS: 60_000,
}));

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

import { encodeCwd } from "../assembly/path-encoding.ts";
import { WorktreeManager } from "../worktree/worktree-manager.ts";

const mockExecFile = vi.mocked(
  execFile as unknown as (
    file: string,
    args: readonly string[],
    options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => void,
);
const mockExistsSync = vi.mocked(fs.existsSync);

type ExecFileResult = {
  err?: (Error & { code?: unknown; killed?: boolean; signal?: string }) | null;
  stdout?: string;
  stderr?: string;
};
function setupExecFile(impl?: (args: readonly string[]) => ExecFileResult): void {
  mockExecFile.mockImplementation(
    (_cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const r = impl ? impl(args) : { stdout: "" };
      if (r.err) cb(r.err, r.stdout ?? "", r.stderr ?? "");
      else cb(null, r.stdout ?? "", r.stderr ?? "");
    },
  );
}

const REPO = "/home/user/project";
const RECORD_ID = "bg-u5-rebuild";
const BRANCH = `pi-sub-${RECORD_ID}`;
/** [S5] checkout 不再读注册表——按 create() 同款命名约定派生。 */
const DERIVED_CHECKOUT = path.join(os.tmpdir(), "pi-subagents", encodeCwd(REPO), BRANCH);
const BASE_COMMIT = "abc123def456";
const PATCH_FILE = "/tmp/wt-u5/backup.patch";

function gitError(msg: string): Error & { code?: unknown } {
  return Object.assign(new Error(msg), { code: 1 });
}

describe("[U5 / §3.2.5] worktree 续聊重建三失败形态（WorktreeManager.reconstruct）", () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    registryEntries.length = 0;
    manager = new WorktreeManager("/home/user/.pi/agent");
  });

  it("正常路径：分支存在 + patch 可应用 → rebuilt（handle 回填 + 注册表补条目）", async () => {
    // [S5] 注册表零条目（归档 cleanup 已删）——重建依据 = repoPath 入参 + 命名约定派生
    setupExecFile((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "rev-parse") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "apply") return { stdout: "" };
      return { stdout: "" }; // worktree add / prune
    });
    // checkout 目录不存在（无需前置清理）；patch 备份在盘；node_modules 缺（跳过 symlink）
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === PATCH_FILE) return true;
      return false;
    });

    const outcome = await manager.reconstruct(REPO, RECORD_ID, PATCH_FILE);

    expect(outcome).toEqual({
      kind: "rebuilt",
      handle: { path: DERIVED_CHECKOUT, branch: BRANCH, baseCommit: BASE_COMMIT, mainCwd: REPO },
    });
    // 注册表补条目（pid=0 占位——续聊轮 spawn 后 registerPid 补全）
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ repo: REPO, branch: BRANCH, checkout: DERIVED_CHECKOUT, pid: 0 }),
    );
    // patch 实际应用（--check 干跑 + apply 两步）
    const applied = mockExecFile.mock.calls.filter((c) => (c[1] as readonly string[])[0] === "apply");
    expect(applied).toHaveLength(2);
  });

  it("[S5] 注册表无条目（归档 cleanup 已删）不阻断重建——repoPath + 命名约定派生 checkout", async () => {
    // registryEntries 保持空：旧实现按注册表 branch 反查恒落空 → degrade-reopen
    //（U5-D8 偏差形态）；修复后依据不入注册表，空表照常重建。
    setupExecFile((args) => {
      if (args[0] === "rev-parse") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "apply") return { stdout: "" };
      return { stdout: "" };
    });
    mockExistsSync.mockImplementation((p: unknown) => String(p) === PATCH_FILE);

    const outcome = await manager.reconstruct(REPO, RECORD_ID, PATCH_FILE);

    expect(outcome).toEqual({
      kind: "rebuilt",
      handle: { path: DERIVED_CHECKOUT, branch: BRANCH, baseCommit: BASE_COMMIT, mainCwd: REPO },
    });
    // git 命令锚定入参 repoPath（cwd），不查注册表（mockLoad 零调用）
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("形态①（分支不存在）→ degrade-reopen（调用方降级带历史重开）", async () => {
    setupExecFile((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { err: gitError("unknown revision") };
      return { stdout: "" };
    });

    const outcome = await manager.reconstruct(REPO, RECORD_ID, PATCH_FILE);
    expect(outcome).toMatchObject({ kind: "degrade-reopen" });
    if (outcome.kind === "degrade-reopen") {
      expect(outcome.reason).toContain(BRANCH);
    }
  });

  it("形态①（patch 备份丢失）→ degrade-reopen（重建依据消亡）", async () => {
    setupExecFile((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "rev-parse") return { stdout: `${BASE_COMMIT}\n` };
      return { stdout: "" };
    });
    mockExistsSync.mockImplementation(() => false); // patch 备份不在盘

    const outcome = await manager.reconstruct(REPO, RECORD_ID, PATCH_FILE);
    expect(outcome).toMatchObject({ kind: "degrade-reopen" });
    if (outcome.kind === "degrade-reopen") {
      expect(outcome.reason).toContain("patch backup file is gone");
    }
  });

  it("形态②（apply 冲突——归档期间分支有新提交）→ conflict（干净基线重建 + patchFile 备份留存，不降级 reopen）", async () => {
    setupExecFile((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "rev-parse") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "apply" && args[1] === "--check") return { err: gitError("patch does not apply") };
      return { stdout: "" };
    });
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === PATCH_FILE) return true;
      return false;
    });

    const outcome = await manager.reconstruct(REPO, RECORD_ID, PATCH_FILE);
    // 干净基线 handle 已建（不降级——transcript 仍有效，续聊资格不受工作区影响）
    expect(outcome).toEqual({
      kind: "conflict",
      handle: { path: DERIVED_CHECKOUT, branch: BRANCH, baseCommit: BASE_COMMIT, mainCwd: REPO },
      patchFile: PATCH_FILE,
    });
    // 实际 apply 未执行（--check 拒绝后止步）
    const applied = mockExecFile.mock.calls.filter(
      (c) => (c[1] as readonly string[])[0] === "apply" && (c[1] as readonly string[])[1] !== "--check",
    );
    expect(applied).toHaveLength(0);
  });

  it("形态③（重建 IO 错——worktree add 重试后仍失败）→ 响亮 throw（不静默回落）", async () => {
    setupExecFile((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "rev-parse") return { stdout: `${BASE_COMMIT}\n` };
      if (args[0] === "worktree") return { err: gitError("disk full while adding worktree") };
      return { stdout: "" };
    });
    mockExistsSync.mockImplementation(() => false);

    await expect(manager.reconstruct(REPO, RECORD_ID)).rejects.toThrow(/git worktree failed/);
  });
});

// ============================================================
// [U5] close 归档编排（RecordLifecycle.archiveRecord 单点）
// ============================================================

import * as path from "node:path";
import { RecordLifecycle, type RecordLifecycleDeps } from "../service/record-lifecycle.ts";
import { createRecord } from "../persistence/execution-record.ts";
import type { ExecutionRecord } from "../assembly/types.ts";
import type { WorktreeManager as WorktreeManagerType } from "../worktree/worktree-manager.ts";

function makeIntentRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "u5 intent task",
    slug: "u5",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  Object.assign(r, overrides);
  return r;
}

function makeLifecycleDeps(overrides: Partial<RecordLifecycleDeps> = {}): {
  deps: RecordLifecycleDeps;
  calls: { unregistered: Array<{ id: string; reason: string }>; cleanupHandles: string[]; patches: string[] };
} {
  const calls = { unregistered: [] as Array<{ id: string; reason: string }>, cleanupHandles: [] as string[], patches: [] as string[] };
  const deps: RecordLifecycleDeps = {
    assertReady: () => {},
    getStore: () =>
      ({
        markArchived: (rec: ExecutionRecord) => {
          rec.intent = "archived";
          return true;
        },
      }) as unknown as ReturnType<RecordLifecycleDeps["getStore"]>,
    getWorktreeManager: (() =>
      ({
        collectPatch: async (_h: unknown, patchFile: string) => {
          calls.patches.push(patchFile);
          return Object.freeze({ patchFile, failed: false, written: true });
        },
        cleanup: async (h: { branch: string }) => {
          calls.cleanupHandles.push(h.branch);
        },
      }) as unknown as WorktreeManagerType),
    getModelService: () => ({ getAgentDir: () => "/tmp/agent-dir" }) as never,
    getNotifyHost: () => ({
      emitPendingUnregister: (id: string, reason: string) => calls.unregistered.push({ id, reason }),
      notifyClosed: vi.fn(),
    }) as never,
    getSessionsDir: () => "/tmp/sessions",
    getPi: () => null,
    onRecordFinalizedCleanup: () => {},
    abortContinuationQueue: () => {},
    clearContinuationQueue: () => {},
    hasActiveContinuationRound: () => false,
    ...overrides,
  };
  return { deps, calls };
}

describe("[U5 / §3.2.5 close 行] 归档编排：worktree 回收 + patch 前移 + `.alive` 面 + pending 注销补发", () => {
  it("archiveRecord：collectPatch 前移（written 回填 patchFile）→ worktree cleanup → markArchived → 注销（reason=archived）→ notifyClosed", async () => {
    const { deps, calls } = makeLifecycleDeps();
    const lifecycle = new RecordLifecycle(deps);
    const handle = Object.freeze({ path: "/tmp/wt", branch: "pi-sub-arch", baseCommit: "abc", mainCwd: "/repo" });
    const record = makeIntentRecord("sa-archive-1", { worktreeHandle: handle });

    await lifecycle.archiveRecord(record, "test");

    // patch 前移：patch 落 sessionsDir/<branch>.patch（written 回填 record.patchFile）
    expect(calls.patches).toEqual([path.join("/tmp/agent-dir", "subagents", "--repo--", "sessions", "pi-sub-arch.patch")]);
    expect(record.patchFile).toBe(path.join("/tmp/agent-dir", "subagents", "--repo--", "sessions", "pi-sub-arch.patch"));
    // worktree 立即回收
    expect(calls.cleanupHandles).toEqual(["pi-sub-arch"]);
    // intent 翻转（markArchived 委托达点）
    expect(record.intent).toBe("archived");
    // 归档点补发注销（承接原 emitUnregister 语义——reason=archived）
    expect(calls.unregistered).toEqual([{ id: "sa-archive-1", reason: "archived" }]);
  });

  it("archiveIdleRecord（idle record close）：kill 链记账 + markArchived（不终态化——status 保持）", async () => {
    killChildSpy.mockClear();
    const { deps } = makeLifecycleDeps();
    const lifecycle = new RecordLifecycle(deps);
    const record = makeIntentRecord("sa-archive-idle", { status: "idle" });

    await lifecycle.archiveIdleRecord(record);

    expect(killChildSpy).toHaveBeenCalledWith("sa-archive-idle", "archiveIdleRecord");
    expect(record.intent).toBe("archived");
    expect(record.status).toBe("idle");
    // 不终态化：closedReason 恒 undefined（新 settle 语义——archived 是意愿位非死因）
    expect(record.closedReason).toBeUndefined();
  });
});

// ============================================================
// [U5 / §3.2.5 顺序约束 [写死]] 收口轮 settle → 通知送达 → intent 翻转 + 归档
// ============================================================

describe("[U5] close 顺序约束：Continuation settle 分支 route（通知送达）先于 archiveAfterClosingRound（归档）", () => {
  it("closeAfterRound 挂起轮 settle：order = finalize → route → archive（intent 翻转不吞收口轮通知）", async () => {
    const record = makeIntentRecord("sa-order-close", { status: "running" });
    const order: string[] = [];
    const host = {
      dispatchChatRound: vi.fn(),
      finalizeRoundOutcome: async () => {
        order.push("finalize");
      },
      routeRecord: () => {
        order.push("route");
      },
      notifyRecord: vi.fn(),
      killStaleChild: async () => {},
      killRoundChild: vi.fn(),
      upgradeGateAllows: () => true,
      reviveClosedRecord: vi.fn(),
      reopenRecord: () => true,
      markRoundStarted: vi.fn(),
      closeNow: async () => {},
      archiveAfterClosingRound: async (rec: ExecutionRecord) => {
        order.push("archive");
        rec.intent = "archived";
        rec.closeAfterRound = undefined;
      },
      rebuildWorktree: async () => {
        throw new Error("not expected in this test");
      },
      reactivateRecord: (rec: ExecutionRecord) => {
        rec.intent = "active";
      },
      notifyWorktreeConflict: vi.fn(),
    };
    const { ConversationContinuation } = await import("../assembly/conversation-continuation.ts");
    const cont = new ConversationContinuation(record, host as never);
    record.closeAfterRound = true; // close 优雅收口挂起

    cont.onRunSettled({ content: "closing round", engineId: "pi" } as never);

    await vi.waitFor(() => expect(order).toEqual(["finalize", "route", "archive"]));
    // 归档后标志消费
    expect(record.closeAfterRound).toBeUndefined();
    expect(record.intent).toBe("archived");
  });

  it("无挂起（正常轮 settle）：不触发归档消费", async () => {
    const record = makeIntentRecord("sa-order-normal", { status: "running" });
    const archived: string[] = [];
    const host = {
      dispatchChatRound: vi.fn(),
      finalizeRoundOutcome: async () => {},
      routeRecord: vi.fn(),
      notifyRecord: vi.fn(),
      killStaleChild: async () => {},
      killRoundChild: vi.fn(),
      upgradeGateAllows: () => true,
      reviveClosedRecord: vi.fn(),
      reopenRecord: () => true,
      markRoundStarted: vi.fn(),
      closeNow: async () => {},
      archiveAfterClosingRound: async (rec: ExecutionRecord) => {
        archived.push(rec.id);
      },
      rebuildWorktree: async () => ({ kind: "degrade-reopen", reason: "n/a" }) as never,
      reactivateRecord: vi.fn(),
      notifyWorktreeConflict: vi.fn(),
    };
    const { ConversationContinuation } = await import("../assembly/conversation-continuation.ts");
    const cont = new ConversationContinuation(record, host as never);

    cont.onRunSettled({ content: "normal round", engineId: "pi" } as never);

    await vi.waitFor(() => expect(host.routeRecord).toHaveBeenCalled());
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(archived).toEqual([]);
  });
});

// ============================================================
// [U5] message 隐含寻回（markReactivated）
// ============================================================

describe("[U5 / §3.2.2 事件表] archived + message → intent 翻回 active（store.markReactivated）", () => {
  it("markReactivated：archived → active（写面 + notifyChange）；非 archived 幂等 no-op", async () => {
    const { RecordStore } = await import("../persistence/record-store.ts");
    const store = new RecordStore("/tmp/u5-reactivate", undefined, {});
    const record = makeIntentRecord("sa-reactivate");
    store.register(record);

    // close 归档
    expect(store.markArchived(record)).toBe(true);
    expect(record.intent).toBe("archived");
    // message 寻回
    expect(store.markReactivated(record)).toBe(true);
    expect(record.intent).toBe("active");
    // 幂等：已 active 时 no-op
    expect(store.markReactivated(record)).toBe(true);
    expect(record.intent).toBe("active");
    store.dispose();
  });

  it("[S5] markArchived 清 worktreeHandle + 置 hadWorktree（重建守卫第三条判据承接）", async () => {
    const { RecordStore } = await import("../persistence/record-store.ts");
    const store = new RecordStore("/tmp/u5-markarch-hw", undefined, {});
    const handle = Object.freeze({ path: "/tmp/wt-ma", branch: "pi-sub-sa-ma-hw", baseCommit: "abc", mainCwd: "/repo" });
    const record = makeIntentRecord("sa-markarch-hw", { worktreeHandle: handle });
    store.register(record);

    expect(store.markArchived(record)).toBe(true);

    // 清句：handle 指向已删目录（调用方已回收 worktree），残留会让 Continuation
    // 重建守卫（!record.worktreeHandle）永不触发——S5 三层缺口之二。
    expect(record.worktreeHandle).toBeUndefined();
    // hadWorktree 兜底：entry/binding 的 worktree 投影与重建守卫第一条判据由本标志承载
    expect(record.hadWorktree).toBe(true);
    expect(record.intent).toBe("archived");
    // 幂等：重复归档（handle 已清）零影响
    expect(store.markArchived(record)).toBe(true);
    expect(record.hadWorktree).toBe(true);
    // 无 worktree record：零影响（hadWorktree 不被误置）
    const bare = makeIntentRecord("sa-markarch-bare");
    store.register(bare);
    store.markArchived(bare);
    expect(bare.hadWorktree).toBeUndefined();
    store.dispose();
  });
});

// ============================================================
// [U5 / §3.2.5] Continuation 派发的 worktree 重建分支（绑定丢失三分支派发形态）
// ============================================================

describe("[U5] dispatchRoundAsync worktree 绑定丢失 → 自动重建三分支", () => {
  /** mock host + order 账本（对齐 conversation-continuation.test.ts makeHost 形态）。 */
  function makeTestRig(record: ExecutionRecord, rebuildImpl: (rec: ExecutionRecord) => Promise<unknown>) {
    const calls = {
      dispatched: [] as Array<{ task: string; resume: unknown }>,
      notified: [] as Array<{ error?: string }>,
      conflicts: [] as Array<{ recordId: string; patchFile: string }>,
      reactivated: 0,
    };
    const host = {
      dispatchChatRound: (rec: ExecutionRecord, input: { task: string; resume?: unknown }) => {
        calls.dispatched.push({ task: input.task, resume: input.resume });
        void rec;
      },
      finalizeRoundOutcome: async () => {},
      routeRecord: vi.fn(),
      notifyRecord: (n: { error?: string }) => calls.notified.push(n),
      killStaleChild: async () => {},
      killRoundChild: vi.fn(),
      upgradeGateAllows: () => true,
      reviveClosedRecord: vi.fn(),
      reopenRecord: () => true,
      markRoundStarted: vi.fn(),
      closeNow: async () => {},
      archiveAfterClosingRound: async () => {},
      rebuildWorktree: rebuildImpl,
      reactivateRecord: (rec: ExecutionRecord) => {
        calls.reactivated += 1;
        rec.intent = "active";
      },
      notifyWorktreeConflict: (recordId: string, patchFile: string) => {
        calls.conflicts.push({ recordId, patchFile });
      },
    };
    return { host, calls };
  }

  it("rebuilt：handle 回填 record（后续轮/归档回收复用）+ 正常 resume 续轮派发", async () => {
    const handle = Object.freeze({ path: "/tmp/wt-rb", branch: `pi-sub-sa-wt-rb`, baseCommit: "abc", mainCwd: "/repo" });
    const record = makeIntentRecord("sa-wt-rb", { hadWorktree: true, worktreeHandle: undefined });
    const { host, calls } = makeTestRig(record, async () => ({ kind: "rebuilt", handle }));
    const { ConversationContinuation } = await import("../assembly/conversation-continuation.ts");
    const cont = new ConversationContinuation(record, host as never);

    cont.onMessage("continue after restart");

    await vi.waitFor(() => expect(calls.dispatched).toHaveLength(1));
    expect(record.worktreeHandle).toBe(handle); // handle 回填
    expect(calls.notified).toEqual([]); // 无失败通知（原地续聊）
  });

  it("conflict：干净基线 handle 回填 + 原地续聊 + 提示进 prompt（patch 备份路径）+ 用户可见通知通道", async () => {
    const handle = Object.freeze({ path: "/tmp/wt-cf", branch: `pi-sub-sa-wt-cf`, baseCommit: "abc", mainCwd: "/repo" });
    const record = makeIntentRecord("sa-wt-cf", { hadWorktree: true, patchFile: "/backup/sa-wt-cf.patch" });
    const { host, calls } = makeTestRig(record, async () => ({ kind: "conflict", handle, patchFile: "/backup/sa-wt-cf.patch" }));
    const { ConversationContinuation } = await import("../assembly/conversation-continuation.ts");
    const cont = new ConversationContinuation(record, host as never);

    cont.onMessage("continue after conflict");

    await vi.waitFor(() => expect(calls.dispatched).toHaveLength(1));
    expect(record.worktreeHandle).toBe(handle);
    // 形态②不降级 reopen：续轮 resume 锚照常携带（sessionFile 原样续写）
    expect(calls.dispatched[0]!.resume).not.toBeNull();
    // 提示前缀进 prompt（子 agent 可见）+ 用户可见通知通道（appendEntry 面）
    expect(calls.dispatched[0]!.task).toContain("clean baseline");
    expect(calls.dispatched[0]!.task).toContain("/backup/sa-wt-cf.patch");
    expect(calls.conflicts).toEqual([{ recordId: "sa-wt-cf", patchFile: "/backup/sa-wt-cf.patch" }]);
    expect(calls.notified).toEqual([]);
  });

  it("degrade-reopen（形态①）：fresh session + 摘要注入（不推进世代——U4 偏差同族）", async () => {
    const record = makeIntentRecord("sa-wt-dr", { hadWorktree: true });
    const { host, calls } = makeTestRig(record, async () => ({ kind: "degrade-reopen", reason: "branch gone" }));
    const { ConversationContinuation } = await import("../assembly/conversation-continuation.ts");
    const cont = new ConversationContinuation(record, host as never);
    const epochBefore = record.epoch ?? 0;
    const roundBefore = record.round ?? 0;

    cont.onMessage("continue after loss");

    await vi.waitFor(() => expect(calls.dispatched).toHaveLength(1));
    // fresh session（resume:undefined）+ 摘要前缀（历史轮数反映重开前形态）
    expect(calls.dispatched[0]!.resume).toBeUndefined();
    expect(calls.dispatched[0]!.task).toContain("Session reopened");
    expect(calls.dispatched[0]!.task).toContain("u5 intent task");
    // 不推进世代（markReopened CAS 仅收 idle——record 已 running；U4 偏差同族登记）
    expect(record.epoch ?? 0).toBe(epochBefore);
    expect(record.round ?? 0).toBe(roundBefore);
  });

  it("形态③ IO 错：rebuild throw → 失败轮末分流（响亮——onRoundRejected 独立载荷）", async () => {
    const record = makeIntentRecord("sa-wt-io", { hadWorktree: true });
    const { host, calls } = makeTestRig(record, async () => {
      throw new Error("git worktree failed: disk full");
    });
    const { ConversationContinuation } = await import("../assembly/conversation-continuation.ts");
    const cont = new ConversationContinuation(record, host as never);

    cont.onMessage("continue after io error");

    // 失败通知（独立载荷——失败原因 + 恢复指引可达宿主）
    await vi.waitFor(() => expect(calls.notified).toHaveLength(1));
    expect(calls.notified[0]!.error).toContain("git worktree failed: disk full");
    expect(calls.notified[0]!.error).toContain("Recovery");
    expect(calls.dispatched).toHaveLength(0); // 派发作废
  });
});

// ============================================================
// [U5 / §3.2.3] notifyId epoch 防撞（reopen 后 round 归零不与历史轮撞键）
// ============================================================

describe("[U5] notifyId epoch 防撞：epoch>0 → `id:epoch:round`（epoch=0 恒旧格式）", () => {
  it("轮次通知 key 按 epoch 分段（`id:round` / `id:epoch:round`）", async () => {
    // ledger 写账断言（生产装配形态——notifyId 在 notify 投影边界物化进账本 entry）
    const ledgerEntries: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const { createNotifier } = await import("../notify/notifier.ts");
    const { bindNotifyLedgerHost, _resetNotifyLedgerForTest } = await import("../notify/notify-ledger.ts");
    _resetNotifyLedgerForTest();
    bindNotifyLedgerHost({
      appendLedgerEntry: (customType, data) => {
        ledgerEntries.push({ customType, data: data as Record<string, unknown> });
      },
      readSessionEntries: () => [],
      isIdle: () => true,
      onAgentSettled: () => {},
      sendDelivery: () => {},
    });
    const notifier2 = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    // epoch=0（缺省）→ 旧格式 `id:round`（磁盘账本零迁移）
    notifier2.notify({
      id: "sa-epoch",
      status: "running",
      agent: "a",
      result: "r",
      startedAt: 1,
      endedAt: undefined,
      round: 2,
    });
    // epoch=3（reopen 后）→ `id:epoch:round`（round 归零不与历史轮撞键）
    notifier2.notify({
      id: "sa-epoch",
      status: "running",
      agent: "a",
      result: "r",
      startedAt: 1,
      endedAt: undefined,
      round: 2,
      epoch: 3,
    });
    const ids = ledgerEntries.map((e) => e.data.notifyId);
    expect(ids).toContain("sa-epoch:2");
    expect(ids).toContain("sa-epoch:3:2");
    _resetNotifyLedgerForTest();
  });
});
