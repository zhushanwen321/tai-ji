// src/__tests__/worktree-stale-recovery.integration.test.ts
//
// [1.2 / 1.3] 真实 git repo + 真实 WorktreeManager 回归（不 mock fs/execFile）：
//   - [1.2] patch 备份丢失 → reconstruct 零副作用：checkout 目录 / 注册表条目 /
//     node_modules 软链 / git worktree 登记四者全无（修复前会先建好再丢弃，残留到
//     宿主进程死亡；消费方对 degrade-reopen 不接收 handle → 每续轮重复重建）；
//   - [1.3] create 遇陈旧 git 元数据（`<repo>/.git/worktrees/<branch>` 登记 +
//     残留分支仍在）→ prune → 删残留分支 → 重试成功（修复前恒抛
//     `a branch named '<b>' already exists`，同 recordId 永久卡死）；
//   - [1.3] reconstruct 遇陈旧登记 → prune → 重试成功，且既有分支存活
//     （既有分支是重建依据，恢复链不删）。
//
// 隔离手段（同 worktree-reconcile.integration.test.ts）：TMPDIR 重定向到测试私有目录——
// checkout 物理根 = os.tmpdir()/pi-subagents 跟随 TMPDIR；agentDir / repo 均在私有目录内，
// mkdtempSync 自建自删，不触碰真实仓库与真实数据目录。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeCwd } from "../assembly/path-encoding.ts";
import { WorktreeRegistry } from "../worktree/worktree-registry.ts";
import { WorktreeManager } from "../worktree/worktree-manager.ts";

/** 原始 TMPDIR（beforeEach 重定向、afterEach 还原）。 */
const ORIG_TMPDIR = os.tmpdir();

/** git 辅助：repo 内执行（输出 trim）。 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

// 真实 git 子进程 + 注册表文件锁：对齐 worktree-reconcile.integration.test.ts 口径显式超时
describe("[1.2/1.3] worktree patch 判定前置 + 陈旧 git 元数据恢复（真实 git）", { timeout: 30_000 }, () => {
  let outerDir: string;
  let agentDir: string;
  let repo: string;
  let registry: WorktreeRegistry;
  let mgr: WorktreeManager;

  const RECORD_ID = "sa-stale-1";
  const BRANCH = `pi-sub-${RECORD_ID}`;

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(ORIG_TMPDIR, "wt-stale-recovery-"));
    // 物理面根重定向：os.tmpdir() 跟随 TMPDIR env（darwin/linux 均如此）
    process.env.TMPDIR = outerDir;

    agentDir = path.join(outerDir, "agent");
    repo = path.join(outerDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@test.local");
    git(repo, "config", "user.name", "test");
    // node_modules 目录 + gitignore：主树保持 clean（create 的脏树前置校验），
    // 同时让 node_modules 软链路径真实走到。
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n", "utf-8");
    fs.writeFileSync(path.join(repo, "a.txt"), "init\n", "utf-8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");

    registry = new WorktreeRegistry(agentDir);
    mgr = new WorktreeManager(agentDir);
  });

  afterEach(() => {
    process.env.TMPDIR = ORIG_TMPDIR;
    fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** checkout 目录按 create()/reconstruct() 同款命名约定派生。 */
  function derivedCheckout(): string {
    return path.join(os.tmpdir(), "pi-subagents", encodeCwd(repo), BRANCH);
  }

  /** git 侧是否登记了该分支的 worktree（物理面判据）。 */
  function worktreeRegistered(): boolean {
    return git(repo, "worktree", "list", "--porcelain").includes(`refs/heads/${BRANCH}`);
  }

  it("[1.2] patch 备份丢失 → degrade-reopen 零副作用（无 checkout / 无注册表条目 / 无软链 / 无 git 登记）", async () => {
    // 真实走通 create → cleanup(keepBranch)（= close 归档回收形态：checkout 回收、分支保留）
    const handle = await mgr.create(repo, RECORD_ID);
    expect(handle.path).toBe(derivedCheckout());
    expect(fs.existsSync(path.join(handle.path, "node_modules"))).toBe(true); // 软链已建
    await mgr.cleanup(handle, { keepBranch: true });
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(registry.load()).toEqual([]);
    expect(git(repo, "rev-parse", "--verify", BRANCH)).toBeTruthy(); // 分支是重建依据，保留

    const missingPatch = path.join(outerDir, "gone.patch");
    const outcome = await mgr.reconstruct(repo, RECORD_ID, missingPatch);

    expect(outcome).toMatchObject({ kind: "degrade-reopen" });
    if (outcome.kind === "degrade-reopen") {
      expect(outcome.reason).toContain("patch backup file is gone");
    }
    // 零副作用四连：判定前置后不应留下任何重建产物
    expect(fs.existsSync(derivedCheckout())).toBe(false);
    expect(registry.load()).toEqual([]);
    expect(worktreeRegistered()).toBe(false);
    expect(fs.existsSync(path.join(derivedCheckout(), "node_modules"))).toBe(false);
  });

  it("[1.3] create：陈旧 git 登记 + 残留分支仍在 → prune + 删残留分支 + 重试成功", async () => {
    // 造陈旧形态：worktree add 建分支 → 手动 rm 目录（git 侧登记残留、分支仍在）
    const stalePath = path.join(outerDir, "stale-checkout");
    git(repo, "worktree", "add", "-q", "-b", BRANCH, stalePath, "HEAD");
    fs.rmSync(stalePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("prunable");
    expect(git(repo, "rev-parse", "--verify", BRANCH)).toBeTruthy();

    const handle = await mgr.create(repo, RECORD_ID);

    expect(handle.branch).toBe(BRANCH);
    expect(handle.path).toBe(derivedCheckout());
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(path.join(handle.path, "node_modules"))).toBe(true);
    expect(git(repo, "rev-parse", "--verify", BRANCH)).toBeTruthy();
    expect(worktreeRegistered()).toBe(true);
    expect(registry.load().map((e) => e.branch)).toEqual([BRANCH]);
    // 陈旧登记已被新登记取代（无 prunable 残留）
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("prunable");
  });

  it("[1.3] reconstruct：陈旧登记（目录被外部 rm）→ prune + 重试成功，既有分支存活", async () => {
    const handle = await mgr.create(repo, RECORD_ID);
    // 模拟归档后 checkout 被外部清掉但 git 元数据残留（注册表条目已删）
    fs.rmSync(handle.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await registry.remove(BRANCH);
    expect(registry.load()).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("prunable");

    const outcome = await mgr.reconstruct(repo, RECORD_ID);

    expect(outcome).toEqual({
      kind: "rebuilt",
      handle: expect.objectContaining({ path: derivedCheckout(), branch: BRANCH, mainCwd: repo }),
    });
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(path.join(handle.path, "node_modules"))).toBe(true);
    // 既有分支是重建依据——恢复链不删（deleteStaleBranch=false）
    expect(git(repo, "rev-parse", "--verify", BRANCH)).toBeTruthy();
    expect(worktreeRegistered()).toBe(true);
    expect(registry.load().map((e) => e.branch)).toEqual([BRANCH]);
  });
});
