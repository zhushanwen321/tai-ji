// src/__tests__/worktree-manager.test.ts
//
// WorktreeManager 单元测试。
// mock execFile（git 命令）+ WorktreeRegistry（注册表）+ alive-store（进程探活）。
//
// [全局注册表重构] scan 不再读 sidecar / 不再依赖 cwd 是否 git repo。
// 判据从「终态 marker 状态机」改为「pid 死活」。
// 测试重点覆盖原方案缺失的崩溃残留场景（P0）。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirtyWorktreeError } from "../assembly/types.ts";

// ── mock modules ──

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    symlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  symlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../persistence/alive-store.ts", () => ({
  isProcessAlive: vi.fn(),
}));

// WorktreeRegistry mock：内存数组模拟，add/updatePid/remove/load 全部可追踪
const { mockLoad, mockAdd, mockUpdatePid, mockRemove, registryEntries } = vi.hoisted(() => {
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
    mockUpdatePid: vi.fn((branch: string, pid: number, sessionFile?: string): void => {
      const e = entries.find((x) => x.branch === branch);
      if (e) {
        e.pid = pid;
        if (sessionFile !== undefined) e.sessionFile = sessionFile;
      }
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
    updatePid = mockUpdatePid;
    remove = mockRemove;
    load = mockLoad;
  },
  SPAWN_GRACE_MS: 60_000,
}));


import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isProcessAlive } from "../persistence/alive-store.ts";
import { encodeCwd } from "../assembly/path-encoding.ts";
import { WorktreeManager } from "../worktree/worktree-manager.ts";

// 被测链路（gitRunAsync）调用四参形态（file, args, options, callback）；vi.mocked
// 直接包 execFile 会推导到无 options 重载，显式绑定四参签名
const mockExecFile = vi.mocked(
  execFile as unknown as (
    file: string,
    args: readonly string[],
    options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => void,
);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockIsProcessAlive = vi.mocked(isProcessAlive);

/**
 * gitRunAsync（execFile callback 风格）mock 装配。
 * impl 返回 {err?, stdout?, stderr?}；err 模拟失败路径（exitCode=killed/signal 挂在 err 上）。
 */
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

const MAIN_CWD = "/home/user/project";
const AGENT_DIR = "/home/user/.pi/agent";
const RECORD_ID = "bg-42-abc";
const BASE_COMMIT = "abc123def456";

/** create 路径期望（tmpdir/pi-subagents/<enc(mainCwd)> 下） */
function expectedCreatePath(recordId: string): string {
  return path.join(os.tmpdir(), "pi-subagents", encodeCwd(MAIN_CWD), `pi-sub-${recordId}`);
}

/** 构造完整 handle（含 mainCwd，供 cleanup/collectPatch 测试用） */
function makeHandle(checkoutPath: string = expectedCreatePath(RECORD_ID)) {
  return Object.freeze({
    path: checkoutPath,
    branch: `pi-sub-${RECORD_ID}`,
    baseCommit: BASE_COMMIT,
    mainCwd: MAIN_CWD,
  });
}

function setupCleanTree(): void {
  setupExecFile((_args: readonly string[]) => {
    // rev-parse 真实输出形态：hash + \n（gitRunAsync 不 trim，消费点 trim 后才得干净 hash）
    if (_args?.[0] === "rev-parse" && _args?.[1] === "HEAD") return { stdout: `${BASE_COMMIT}\n` };
    return { stdout: "" };
  });
  // worktreePath 不存在（无需前置清理）；node_modules 存在
  mockExistsSync.mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.includes("pi-sub-")) return false; // checkout 目录不存在
    if (s.includes("node_modules")) return true;
    return false;
  });
}

/** 向注册表注入一条活条目（模拟 create 后的状态）。 */
function injectEntry(overrides: Partial<{ branch: string; pid: number; checkout: string; repo: string; createdAt: number; sessionFile: string }> = {}): void {
  registryEntries.push({
    repo: overrides.repo ?? MAIN_CWD,
    branch: overrides.branch ?? "pi-sub-orphan1",
    checkout: overrides.checkout ?? path.join(os.tmpdir(), "pi-sub-orphan1"),
    pid: overrides.pid ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
    sessionFile: overrides.sessionFile,
  });
}

describe("WorktreeManager", () => {
  let mgr: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    registryEntries.length = 0;
    mgr = new WorktreeManager(AGENT_DIR);
  });

  describe("create", () => {
    it("正常流程返回冻结 handle（path 在 tmpdir，含 mainCwd）", async () => {
      setupCleanTree();

      const handle = await mgr.create(MAIN_CWD, RECORD_ID);

      expect(handle.path).toBe(expectedCreatePath(RECORD_ID));
      expect(handle.branch).toBe(`pi-sub-${RECORD_ID}`);
      expect(handle.baseCommit).toBe(BASE_COMMIT);
      expect(handle.mainCwd).toBe(MAIN_CWD);
      expect(Object.isFrozen(handle)).toBe(true);
    });

    it("成功后写入注册表（pid=0 占位）", async () => {
      setupCleanTree();

      await mgr.create(MAIN_CWD, RECORD_ID);

      expect(mockAdd).toHaveBeenCalledTimes(1);
      const entry = mockAdd.mock.calls[0]![0] as { repo: string; branch: string; pid: number };
      expect(entry.repo).toBe(MAIN_CWD);
      expect(entry.branch).toBe(`pi-sub-${RECORD_ID}`);
      expect(entry.pid).toBe(0);
    });

    it("脏树抛 DirtyWorktreeError 且不写注册表（status 与 rev-parse 并行，均发起）", async () => {
      setupExecFile((args: readonly string[]) => {
        if (args[0] === "status") return { stdout: "M src/index.ts\n" };
        return { stdout: "" };
      });

      // async create：同步 throw 变 rejected promise
      await expect(mgr.create(MAIN_CWD, RECORD_ID)).rejects.toThrow(DirtyWorktreeError);
      expect(mockAdd).not.toHaveBeenCalled();
      // allSettled 并行：两条读命令都发起（rev-parse 结果在脏树时被丢弃）
      const cmds = mockExecFile.mock.calls.map((c) => `${c[1]?.[0]} ${c[1]?.[1] ?? ""}`);
      expect(cmds).toContain("status --porcelain");
      expect(cmds).toContain("rev-parse HEAD");
    });

    it("recordId 含特殊字符抛 DirtyWorktreeError", async () => {
      await expect(mgr.create(MAIN_CWD, "../evil-path")).rejects.toThrow(DirtyWorktreeError);
      await expect(mgr.create(MAIN_CWD, "hello world")).rejects.toThrow(DirtyWorktreeError);
      await expect(mgr.create(MAIN_CWD, "")).rejects.toThrow(DirtyWorktreeError);
      await expect(mgr.create(MAIN_CWD, "a;b")).rejects.toThrow(DirtyWorktreeError);
    });

    it("recordId 单字符 / 连续短横线合法", async () => {
      setupCleanTree();
      expect((await mgr.create(MAIN_CWD, "a")).branch).toBe("pi-sub-a");
      expect((await mgr.create(MAIN_CWD, "--test--")).branch).toBe("pi-sub---test--");
    });

    it("残留 checkout 目录存在时前置清理（fs.rmSync）", async () => {
      setupCleanTree();
      // worktreePath 已存在 → 触发前置 rmSync
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("pi-sub-bg-42-abc")) return true; // checkout 残留
        if (s.includes("node_modules")) return true;
        return false;
      });

      await mgr.create(MAIN_CWD, RECORD_ID);

      expect(fs.rmSync).toHaveBeenCalledWith(
        expectedCreatePath(RECORD_ID),
        { recursive: true, force: true },
      );
    });

    it("symlink 失败时回滚 worktree + 分支 + 注册表（回滚经 gitRunAsync）", async () => {
      setupCleanTree();
      // symlink 抛错触发 MF#3 回滚
      vi.mocked(fs.symlinkSync).mockImplementation(() => {
        throw new Error("symlink permission denied");
      });

      await expect(mgr.create(MAIN_CWD, RECORD_ID)).rejects.toThrow("symlink permission denied");

      // 回滚：worktree remove + branch delete（异步路径）+ registry remove
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "remove", "--force"]),
        expect.anything(),
        expect.anything(),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["branch", "-D"]),
        expect.anything(),
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith(`pi-sub-${RECORD_ID}`);
    });
    it("per-repo mutex：同 repo 并发 create 的 worktree add 串行（maxActive=1）", async () => {
      // clearAllMocks 不清 mockImplementation——重置前例注入的 symlinkSync throw，本用例走完整 create
      vi.mocked(fs.symlinkSync).mockImplementation(() => {});
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("node_modules")) return true;
        return false;
      });
      let writeActive = 0;
      let maxWriteActive = 0;
      let addCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          const isAdd = args[0] === "worktree" && args[1] === "add";
          if (isAdd) {
            // 只对写命令（worktree add）计并发——读命令（status/rev-parse）无锁可并行是设计预期
            writeActive++;
            maxWriteActive = Math.max(maxWriteActive, writeActive);
            addCount++;
          }
          setTimeout(() => {
            if (isAdd) writeActive--;
            // rev-parse 真实输出带尾换行；baseCommit 由消费点 trim
            cb(null, args[0] === "rev-parse" ? `${BASE_COMMIT}\n` : "", "");
          }, 5);
        },
      );

      const handles = await Promise.all([
        mgr.create(MAIN_CWD, "con-a"),
        mgr.create(MAIN_CWD, "con-b"),
      ]);

      // 两个 create 全部成功、branch 不同
      expect(handles[0].branch).toBe("pi-sub-con-a");
      expect(handles[1].branch).toBe("pi-sub-con-b");
      // 同 repo 的 2 个 worktree add 全部执行且互斥（per-repo mutex）
      expect(addCount).toBe(2);
      expect(maxWriteActive).toBe(1);
    });
  });

  describe("registerPid", () => {
    it("委托 registry.updatePid", () => {
      mgr.registerPid("pi-sub-bg-1", 12345);
      expect(mockUpdatePid).toHaveBeenCalledWith("pi-sub-bg-1", 12345, undefined);
    });
  });

  describe("cleanup", () => {
    it("worktree remove + branch -D + 注册表移除（cwd 用 handle.mainCwd）", async () => {
      setupExecFile();
      const handle = makeHandle();

      await mgr.cleanup(handle);

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", handle.path],
        expect.objectContaining({ cwd: MAIN_CWD }),
        expect.anything(),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", handle.branch],
        expect.objectContaining({ cwd: MAIN_CWD }),
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith(handle.branch);
    });

    it("worktree remove 失败时 branch -D + 注册表移除仍执行（best-effort 分离）", async () => {
      // 第一条 git（worktree remove）失败，第二条（branch -D）应仍执行
      setupExecFile((args) => {
        if (args[1] === "remove") {
          return { err: Object.assign(new Error("Command failed: git worktree remove"), { code: 128 }), stderr: "fatal: worktree locked" };
        }
        return { stdout: "" };
      });
      const handle = makeHandle();

      // 不应抛错
      await expect(mgr.cleanup(handle)).resolves.toBeUndefined();

      // branch -D 仍被调用
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", handle.branch],
        expect.anything(),
        expect.anything(),
      );
      // 注册表仍被移除
      expect(mockRemove).toHaveBeenCalledWith(handle.branch);
    });

    it("[S5] keepBranch:true（归档回收）跳过 branch -D——分支是续聊重建依据", async () => {
      setupExecFile();
      const handle = makeHandle();

      await mgr.cleanup(handle, { keepBranch: true });

      // worktree remove 照常（释放 checkout 隔离）
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", handle.path],
        expect.objectContaining({ cwd: MAIN_CWD }),
        expect.anything(),
      );
      // 分支保留（reconstruct 按 `pi-sub-<recordId>` 命名约定重建的依据）
      const branchDeletes = mockExecFile.mock.calls.filter(
        (c) => (c[1] as readonly string[])[0] === "branch" && (c[1] as readonly string[])[1] === "-D",
      );
      expect(branchDeletes).toHaveLength(0);
      // 注册表条目照常移除（分支存活但无 checkout——对账器方向二只扫 tmpdir 物理目录，不触碰）
      expect(mockRemove).toHaveBeenCalledWith(handle.branch);
    });
  });

  describe("collectPatch", () => {
    it("有改动返回 patch 文件", async () => {
      setupExecFile((args) => (args[0] === "diff" ? { stdout: "diff --git a/src\n+// new" } : { stdout: "" }));

      const handle = makeHandle();
      const patchFile = path.join(os.tmpdir(), `outside-${RECORD_ID}.patch`);

      const result = await mgr.collectPatch(handle, patchFile);

      expect(result.failed).toBe(false);
      expect(result.written).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith("git", ["add", "-A"], expect.anything(), expect.anything());
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["diff", "--cached", BASE_COMMIT],
        expect.anything(),
        expect.anything(),
      );
    });

    it("无改动返回 failed=false, written=false（不写文件）", async () => {
      setupExecFile();
      const result = await mgr.collectPatch(makeHandle(), "/tmp/x.patch");
      expect(result.failed).toBe(false);
      expect(result.written).toBe(false);
    });

    it("patch 内容 = git diff stdout 原文（含尾部换行不被裁剪），git apply --check 兼容", async () => {
      // 真实 git diff 输出以 \n 结尾；旧实现 gitRunAsync resolve(stdout.trim())
      // 裁掉尾换行 → 落盘 patch 在干净副本上 `git apply --check` 报
      // "corrupt patch at line N"（2026-08-16 门 4 实测，exit 128）
      const rawDiff =
        "diff --git a/data.txt b/data.txt\n" +
        "index c690e0d..f858a88 100644\n" +
        "--- a/data.txt\n" +
        "+++ b/data.txt\n" +
        "@@ -1 +1,2 @@\n" +
        " base content\n" +
        "+appended\n";
      setupExecFile((args) => (args[0] === "diff" ? { stdout: rawDiff } : { stdout: "" }));

      await mgr.collectPatch(makeHandle(), "/tmp/x.patch");

      // 写盘字节与 diff stdout 逐字节一致（保真 = 不裁剪两端空白）
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe(rawDiff);
      expect(written.endsWith("\n")).toBe(true);
    });
  });

  // ============================================================
  // gitRunAsync 包装与 per-repo mutex（Phase 1 异步化新增）
  // ============================================================
  describe("gitRunAsync（经 collectPatch/cleanup 公共面触达）", () => {
    it("非零退出：message 同构 + exitCode/stderr 属性（P-errshape：stderr 在 callback 第三参）", async () => {
      setupExecFile((args) => {
        if (args[0] === "diff") {
          return {
            err: Object.assign(new Error("Command failed: git diff --cached abc123def456\nfatal: bad object"), { code: 128 }),
            stderr: "fatal: bad object",
          };
        }
        return { stdout: "" };
      });

      // diff 无 try/catch，直接向上抛（与旧同步 gitRun 行为一致）
      const err = await mgr.collectPatch(makeHandle(), "/tmp/x.patch").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("git diff failed: Command failed: git diff --cached");
      expect((err as { exitCode?: number }).exitCode).toBe(128);
      expect((err as { stderr?: string }).stderr).toBe("fatal: bad object");
    });

    it("超时路径：killed+SIGTERM 标记 timedOut，不挂误导性 exitCode", async () => {
      setupExecFile((args) => {
        if (args[0] === "diff") {
          return { err: Object.assign(new Error("Command failed: git diff --cached"), { killed: true, signal: "SIGTERM", code: null }) };
        }
        return { stdout: "" };
      });

      const err = await mgr.collectPatch(makeHandle(), "/tmp/x.patch").catch((e: unknown) => e);
      expect((err as Error).message).toContain("git diff failed:");
      expect((err as { timedOut?: boolean }).timedOut).toBe(true);
      expect((err as { exitCode?: number }).exitCode).toBeUndefined();
    });

    it("per-repo mutex：同 repo 写类命令串行（最大并发 1），全部完成无饥饿", async () => {
      let active = 0;
      let maxActive = 0;
      // 异步完成 cb：若队列失效，后继命令的 impl 入口会先于前驱 cb 到达 → active=2
      mockExecFile.mockImplementation(
        (_cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          active++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active--;
            cb(null, "", "");
          }, 5);
          void args;
        },
      );

      const distinct = [1, 2, 3].map((i) =>
        Object.freeze({ ...makeHandle(path.join(os.tmpdir(), `pi-sub-mut-${i}`)), branch: `pi-sub-mut-${i}` }),
      );
      await Promise.all(distinct.map((h) => mgr.cleanup(h)));

      // 同 repo 6 条写命令（3×(remove+branch -D)）全部执行（无饥饿）
      const writeCalls = mockExecFile.mock.calls.filter(
        (c) => (c[1]?.[0] === "worktree" && c[1]?.[1] === "remove") || (c[1]?.[0] === "branch" && c[1]?.[1] === "-D"),
      );
      expect(writeCalls).toHaveLength(6);
      // 队列生效：任何时刻至多 1 条写命令在途
      expect(maxActive).toBe(1);
    });

    it("mutex 前驱失败不传染后继：第一个 remove 失败，后续同 repo 写命令正常执行", async () => {
      let removeCount = 0;
      setupExecFile((args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removeCount++;
          if (removeCount === 1) {
            return { err: Object.assign(new Error("Command failed: git worktree remove"), { code: 128 }) };
          }
        }
        return { stdout: "" };
      });

      const h1 = Object.freeze({ ...makeHandle(), branch: "pi-sub-fail-1" });
      const h2 = Object.freeze({ ...makeHandle(), branch: "pi-sub-fail-2" });
      await Promise.all([mgr.cleanup(h1), mgr.cleanup(h2)]);

      // h2 的 remove 正常执行（第 2 次），h1/h2 的 branch -D 各自执行
      expect(removeCount).toBe(2);
      const branchCalls = mockExecFile.mock.calls.filter((c) => c[1]?.[0] === "branch" && c[1]?.[1] === "-D");
      expect(branchCalls).toHaveLength(2);
      // 两个注册表条目都移除（各自 cleanup 尾部执行）
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-fail-1");
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-fail-2");
    });
  });

  // ============================================================
  // scan：全局注册表 + pid 死活判据（核心重构）
  // ============================================================
  describe("scan", () => {
    it("pid 已死的条目被清理（正常退出未 cleanup / 崩溃残留）", async () => {
      setupExecFile();
      injectEntry({ branch: "pi-sub-dead", pid: 11111 });
      mockIsProcessAlive.mockReturnValue(false); // pid 死

      await mgr.scan();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", expect.any(String)],
        expect.objectContaining({ cwd: MAIN_CWD }),
        expect.anything(),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-dead"],
        expect.objectContaining({ cwd: MAIN_CWD }),
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-dead");
    });

    it("pid 活的条目不删（绝不删活进程）", async () => {
      // 物理面也 mock 存在（branch --list 返回该分支 + checkout 目录在）——
      // D5b 对账的两个方向（清孤儿 / 清幻影条目）都必须不动活条目。
      setupExecFile((args: readonly string[]) => {
        if (args[0] === "branch" && args[1] === "--list") return { stdout: "pi-sub-alive\n" };
        return { stdout: "" };
      });
      const checkout = path.join(os.tmpdir(), "pi-sub-orphan1");
      injectEntry({ branch: "pi-sub-alive", pid: 22222, checkout });
      mockIsProcessAlive.mockReturnValue(true); // pid 活
      mockExistsSync.mockImplementation((p: unknown) => String(p) === checkout);

      await mgr.scan();

      const removeCalls = mockExecFile.mock.calls.filter(
        (c) => c[1]?.[0] === "worktree" && c[1]?.[1] === "remove",
      );
      expect(removeCalls).toHaveLength(0);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("崩溃残留：无终态 + pid 死 → 清理（原 P0 缺陷场景）", async () => {
      // 这是原 reaper 永远泄漏的场景：进程崩溃无人写终态 marker
      setupExecFile();
      injectEntry({ branch: "pi-sub-crash", pid: 33333 });
      mockIsProcessAlive.mockReturnValue(false); // 崩溃后进程已死

      await mgr.scan();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-crash"],
        expect.anything(),
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-crash");
    });

    it("pid=0 + 未超 SPAWN_GRACE → 跳过（可能正在 spawn）", async () => {
      setupExecFile();
      injectEntry({ branch: "pi-sub-spawning", pid: 0, createdAt: Date.now() });

      await mgr.scan();

      const removeCalls = mockExecFile.mock.calls.filter(
        (c) => c[1]?.[0] === "worktree" && c[1]?.[1] === "remove",
      );
      expect(removeCalls).toHaveLength(0);
    });

    it("pid=0 + 超 SPAWN_GRACE → 清理（create 后崩溃）", async () => {
      setupExecFile();
      const sixtyOneMinAgo = Date.now() - 61 * 60 * 1000;
      injectEntry({ branch: "pi-sub-spawn-crash", pid: 0, createdAt: sixtyOneMinAgo });

      await mgr.scan();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-spawn-crash"],
        expect.anything(),
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-spawn-crash");
    });

    it("跨 repo 清理：条目 repo 字段作为 git -C 目标", async () => {
      setupExecFile();
      const OTHER_REPO = "/home/user/other-repo";
      injectEntry({ branch: "pi-sub-cross", pid: 44444, repo: OTHER_REPO });
      mockIsProcessAlive.mockReturnValue(false);

      await mgr.scan();

      // git 命令的 cwd 应为 OTHER_REPO，非 MAIN_CWD
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["branch", "-D", "pi-sub-cross"]),
        expect.objectContaining({ cwd: OTHER_REPO }),
        expect.anything(),
      );
    });

    it("空注册表时无操作", async () => {
      setupExecFile();
      // registryEntries 已在 beforeEach 清空
      await mgr.scan();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("worktree remove 失败时 branch -D + 注册表移除仍执行（best-effort）", async () => {
      setupExecFile((args) => {
        if (args[0] === "worktree") {
          return { err: Object.assign(new Error("Command failed: git worktree remove"), { code: 128 }) };
        }
        return { stdout: "" };
      });
      injectEntry({ branch: "pi-sub-stubborn", pid: 55555 });
      mockIsProcessAlive.mockReturnValue(false);

      await mgr.scan();

      // branch -D 仍被调用（两次 git 调用各自独立）
      const branchDeleteCalls = mockExecFile.mock.calls.filter(
        (c) => c[1]?.[0] === "branch" && c[1]?.[1] === "-D",
      );
      expect(branchDeleteCalls).toHaveLength(1);
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-stubborn");
    });
  });
});
