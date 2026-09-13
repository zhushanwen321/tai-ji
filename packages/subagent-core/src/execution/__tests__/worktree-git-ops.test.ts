// src/execution/__tests__/worktree-git-ops.test.ts
//
// worktree-git-ops 测试（sink 设计 U5 / ⛔3）：真实 git 临时仓集成（不 mock
// execFile/fs，先例 worktree-reconcile.integration.test.ts）。
//
// 覆盖：
//   - ⛔3 降级路径①锚点缺失/损坏（三形态：文件缺失 / 内容空白 / 内容不被 git 认）
//     → 断言 warn 发出 + 裸 diff + patchIncomplete:true
//   - ⛔3 降级路径②add 失败（真实 index.lock 冲突构造）→ 同上断言
//   - 新文件 + 已提交改动场景：完整机制 patch 含两者（`diff --cached <base>`）
//   - 大 diff maxBuffer：缺省 1MB 超限形态如实登记（GitRunError 上抛 + ⛔3① git
//     层降级 warn）/ 32MB 放宽后 gitRun 与 collectWorktreePatch 完整产出
//   - cleanupWorktree 三步容错（remove 失败不阻断 / onRemoved 抛错不 reject）
//   - listWorktreePorcelain 原始输出保真（与 execFileSync 原始输出逐字节全等）
//   - 保真读 / GitRunError / SafeId / dirty 谓词
//
// warn 断言经 configureCore 注入 log spy（facade 每次调用动态解析，配置即生效）。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import { DirtyWorktreeError } from "../assembly/types.ts";
import {
  assertSafeId,
  cleanupWorktree,
  collectWorktreePatch,
  GitRunError,
  gitRun,
  isSafeId,
  isTreeDirty,
  listWorktreePorcelain,
} from "../worktree/worktree-git-ops.ts";

/** git 辅助：repo/worktree 内执行（原始 stdout，不 trim——保真对照用）。 */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
}

// [HISTORICAL] 真实 git 子进程集成用例显式超时（对齐 worktree-reconcile.integration
// 满并行防超出口径）。
describe("worktree-git-ops", { timeout: 30_000 }, () => {
  let outerDir: string;
  let repo: string;
  let worktree: string;
  let branch: string;
  let baseCommit: string;
  let logCalls: Array<{ level: string; component: string; message: string; data?: unknown }>;

  /** warn 级日志调用（⛔3 断言用）。 */
  function warnCalls(): Array<{ message: string; data?: unknown }> {
    return logCalls.filter((c) => c.level === "warn");
  }

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-gitops-"));
    repo = path.join(outerDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@test.local");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    baseCommit = git(repo, "rev-parse", "HEAD").trim();

    branch = "pi-sub-t1";
    worktree = path.join(outerDir, "wt");
    git(repo, "worktree", "add", "-q", "-b", branch, worktree, baseCommit);

    logCalls = [];
    configureCore({
      dataRoot: () => outerDir,
      log: (level, component, message, data) => {
        logCalls.push({ level, component, message, data });
      },
    });
  });

  afterEach(() => {
    resetCoreForTests();
    fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /**
   * 标准三件套场景（⛔3 验收②的原材料）：
   * ① 已提交改动（worktree HEAD 前进一个 commit，新增 committed.txt）
   * ② 未提交改动（base.txt 追加一行）
   * ③ 新文件（new.txt，未跟踪）
   */
  function stageCommittedAndUncommittedAndNewFile(): void {
    fs.writeFileSync(path.join(worktree, "committed.txt"), "committed-change\n", "utf-8");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "wip");
    fs.appendFileSync(path.join(worktree, "base.txt"), "uncommitted\n", "utf-8");
    fs.writeFileSync(path.join(worktree, "new.txt"), "brand-new\n", "utf-8");
  }

  function patchFile(): string {
    return path.join(outerDir, "out.patch");
  }

  function commitAnchor(): { kind: "commit"; baseCommit: string } {
    return { kind: "commit", baseCommit };
  }

  function writeAnchorFile(content: string): string {
    const p = path.join(outerDir, "baseline.anchor");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  // ============================================================
  // collectWorktreePatch：完整机制（anchor 双形态）
  // ============================================================

  describe("collectWorktreePatch 完整机制", () => {
    it("commit 锚点：新文件 + 已提交改动场景 patch 含两者（⛔3 验收②，真实 git）", async () => {
      stageCommittedAndUncommittedAndNewFile();

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: commitAnchor(),
      });

      expect(result.written).toBe(true);
      expect(result.patchIncomplete).toBeUndefined();
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      // 已提交改动（committed.txt 在 worktree HEAD 前进的 commit 里引入）
      expect(patch).toContain("diff --git a/committed.txt b/committed.txt");
      // 新文件（add -A 暂存后 --cached diff 捕获）
      expect(patch).toContain("diff --git a/new.txt b/new.txt");
      // 未提交改动也在（同一基线机制覆盖全量）
      expect(patch).toContain("diff --git a/base.txt b/base.txt");
      // 无降级留痕时 warn 零发出
      expect(warnCalls()).toHaveLength(0);
    });

    it("anchor-file 锚点：宿主持久锚点文件（sidecar 语义）与 commit 锚点等价", async () => {
      stageCommittedAndUncommittedAndNewFile();
      const anchorFile = writeAnchorFile(`${baseCommit}\n`);

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: { kind: "anchor-file", path: anchorFile },
      });

      expect(result.written).toBe(true);
      expect(result.patchIncomplete).toBeUndefined();
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(patch).toContain("diff --git a/committed.txt b/committed.txt");
      expect(patch).toContain("diff --git a/new.txt b/new.txt");
    });

    it("保真读：patch 文件保留 git 原始尾换行（trim 会产出 corrupt patch）", async () => {
      fs.appendFileSync(path.join(worktree, "base.txt"), "uncommitted\n", "utf-8");

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: commitAnchor(),
      });

      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(result.written).toBe(true);
      expect(patch.endsWith("\n")).toBe(true);
      expect(patch).toContain("@@ -1");
    });

    it("空 diff：written=false 且不写文件（避免悬空路径）", async () => {
      const out = patchFile();

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: out,
        anchor: commitAnchor(),
      });

      expect(result.written).toBe(false);
      expect(result.patchIncomplete).toBeUndefined();
      expect(fs.existsSync(out)).toBe(false);
      expect(warnCalls()).toHaveLength(0);
    });
  });

  // ============================================================
  // 大 diff maxBuffer：Node execFile 缺省 1MB 超限 / 宿主 32MB 放宽
  // ============================================================

  describe("大 diff maxBuffer（缺省 1MB 超限 / 宿主 32MB）", () => {
    /** ~1.5MB 多行文本（30000 行 × ~51B），贴近批量重构的大 diff 真实场景。 */
    const BIG_CONTENT = Array.from(
      { length: 30_000 },
      (_, i) => `line-${i} ${"x".repeat(40)}`,
    ).join("\n");

    /** 在 worktree 给已跟踪 base.txt 追加 ~1.5MB（30000 行 × ~51B）。
     * 用已跟踪文件修改而非 untracked 新文件：纯 `git diff`（工作区 vs index）
     * 不含 untracked，直接 diff 用例才有大输出（贴近批量重构改既有文件场景）。 */
    function stageBigDiff(): void {
      fs.appendFileSync(path.join(worktree, "base.txt"), `\n${BIG_CONTENT}\n`, "utf-8");
    }

    it("gitRun 不传 maxBuffer：stdout 超 1MB → GitRunError（Node execFile 缺省行为不变）", async () => {
      stageBigDiff();

      await expect(gitRun(["diff"], { cwd: worktree })).rejects.toThrow(GitRunError);
    });

    it("gitRun 传 maxBuffer 32MB：超 1MB stdout 完整返回", async () => {
      stageBigDiff();

      const out = await gitRun(["diff"], { cwd: worktree, maxBuffer: 32 * 1024 * 1024 });

      expect(out.length).toBeGreaterThan(1_500_000);
      expect(out).toContain("diff --git a/base.txt b/base.txt");
    });

    it(
      "collectWorktreePatch 缺省：大 diff → GitRunError 原样上抛" +
        "（如实登记：diff --cached 超限先被 ⛔3① git 层按「锚点被拒」降级 warn，" +
        "降级裸 diff HEAD 再超限、无 catch 上抛）",
      async () => {
        stageBigDiff();

        const err = await collectWorktreePatch({
          worktreePath: worktree,
          patchFile: patchFile(),
          anchor: commitAnchor(),
        }).catch((e: unknown) => e);

        // 终态：降级裸 diff HEAD 同样超限（该路径无 catch），GitRunError 原样上抛，
        // patch 文件不产出
        expect(err).toBeInstanceOf(GitRunError);
        expect((err as GitRunError).message).toContain("git diff failed");
        expect(fs.existsSync(patchFile())).toBe(false);
        // 中间留痕：diff --cached 超限 ≠ 锚点损坏，但 ⛔3① git 层按既有 catch
        // 语义降级（最小修复不改降级判定），warn 如实发出
        const warns = warnCalls();
        expect(warns).toHaveLength(1);
        expect(warns[0].message).toContain("rejected by git");
      },
    );

    it("collectWorktreePatch 传 maxBuffer 32MB：大 diff 完整成 patch（无降级留痕）", async () => {
      stageBigDiff();

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: commitAnchor(),
        maxBuffer: 32 * 1024 * 1024,
      });

      expect(result.written).toBe(true);
      expect(result.patchIncomplete).toBeUndefined();
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(patch).toContain("diff --git a/base.txt b/base.txt");
      // patch 完整：全文行进 diff（内容 + diff 前缀 > 1.5MB，远超 1MB 缺省）
      expect(patch.length).toBeGreaterThan(1_500_000);
      expect(patch.endsWith("\n")).toBe(true);
      expect(warnCalls()).toHaveLength(0);
    });
  });

  // ============================================================
  // collectWorktreePatch：⛔3 降级路径①锚点缺失/损坏
  // ============================================================

  describe("⛔3① 锚点缺失/损坏 → warn + 裸 diff + patchIncomplete:true", () => {
    it("锚点文件缺失：warn 发出 + 裸 diff + patchIncomplete:true + 丢已提交改动", async () => {
      stageCommittedAndUncommittedAndNewFile();
      const missing = path.join(outerDir, "never-written.anchor");

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: { kind: "anchor-file", path: missing },
      });

      // 显著 warn（不做纯静默）
      const warns = warnCalls();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("anchor file missing or unreadable");
      expect(warns[0].data).toMatchObject({ anchorFile: missing });
      // patchIncomplete 留痕
      expect(result.written).toBe(true);
      expect(result.patchIncomplete).toBe(true);
      // 裸 diff：仅未提交改动 + 已暂存新文件（add -A 成功），丢已提交改动
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(patch).toContain("diff --git a/base.txt b/base.txt");
      expect(patch).toContain("diff --git a/new.txt b/new.txt");
      expect(patch).not.toContain("committed.txt");
    });

    it("锚点文件内容空白（损坏形态一）：warn 发出 + 裸 diff + patchIncomplete:true", async () => {
      stageCommittedAndUncommittedAndNewFile();
      const anchorFile = writeAnchorFile("   \n\t\n");

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: { kind: "anchor-file", path: anchorFile },
      });

      const warns = warnCalls();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("empty or blank");
      expect(result.patchIncomplete).toBe(true);
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(patch).toContain("diff --git a/base.txt b/base.txt");
      expect(patch).not.toContain("committed.txt");
    });

    it("锚点内容不被 git 认（损坏形态二）：warn 发出 + 裸 diff + patchIncomplete:true", async () => {
      stageCommittedAndUncommittedAndNewFile();
      const anchorFile = writeAnchorFile("deadbeef-not-a-real-commit\n");

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: { kind: "anchor-file", path: anchorFile },
      });

      const warns = warnCalls();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("rejected by git");
      expect(result.written).toBe(true);
      expect(result.patchIncomplete).toBe(true);
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(patch).toContain("diff --git a/base.txt b/base.txt");
      expect(patch).not.toContain("committed.txt");
    });

    it("commit 锚点为空串：warn 发出 + 裸 diff + patchIncomplete:true", async () => {
      stageCommittedAndUncommittedAndNewFile();

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: { kind: "commit", baseCommit: "   " },
      });

      const warns = warnCalls();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("anchor commit is empty");
      expect(result.patchIncomplete).toBe(true);
      expect(fs.readFileSync(result.patchFile, "utf-8")).toContain(
        "diff --git a/base.txt b/base.txt",
      );
    });

    it("锚点缺失且树干净：空 diff 不写文件，patchIncomplete 留痕不因 written=false 丢失", async () => {
      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: { kind: "anchor-file", path: path.join(outerDir, "absent.anchor") },
      });

      expect(result.written).toBe(false);
      expect(result.patchIncomplete).toBe(true);
      expect(fs.existsSync(result.patchFile)).toBe(false);
      expect(warnCalls()).toHaveLength(1);
    });
  });

  // ============================================================
  // collectWorktreePatch：⛔3 降级路径②add 失败
  // ============================================================

  describe("⛔3② add 失败 → warn + 裸 diff + patchIncomplete:true（真实 index.lock 冲突）", () => {
    /** 在 worktree 的 git 元数据目录放 index.lock（真实 git add 必然失败）。 */
    function blockIndex(): void {
      const gitDir = git(worktree, "rev-parse", "--git-dir").trim();
      fs.writeFileSync(path.join(gitDir, "index.lock"), "", "utf-8");
    }

    it("add 失败：warn 发出 + 裸 diff + patchIncomplete:true + 新文件不进 patch", async () => {
      stageCommittedAndUncommittedAndNewFile();
      blockIndex();

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: commitAnchor(),
      });

      // 非致命：不 reject，warn 显著（不做 fail-fast 也不静默）
      const warns = warnCalls();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("git add -A failed");
      expect(warns[0].data).toMatchObject({ worktreePath: worktree });
      expect(result.written).toBe(true);
      expect(result.patchIncomplete).toBe(true);
      // 裸 diff HEAD：已跟踪未提交改动在；已提交改动与 untracked 新文件丢
      //（D5 裁决：降级形态较 zsw `diff <base>` 多丢已提交改动，留痕可判断）
      const patch = fs.readFileSync(result.patchFile, "utf-8");
      expect(patch).toContain("diff --git a/base.txt b/base.txt");
      expect(patch).not.toContain("committed.txt");
      expect(patch).not.toContain("new.txt");
    });

    it("add 失败且树干净：written=false，patchIncomplete 留痕仍在", async () => {
      blockIndex();

      const result = await collectWorktreePatch({
        worktreePath: worktree,
        patchFile: patchFile(),
        anchor: commitAnchor(),
      });

      expect(result.written).toBe(false);
      expect(result.patchIncomplete).toBe(true);
      expect(warnCalls()).toHaveLength(1);
    });
  });

  // ============================================================
  // cleanupWorktree：三步容错
  // ============================================================

  describe("cleanupWorktree 三步容错", () => {
    it("正常路径：remove + branch -D + onRemoved 全部执行，资源真实消失", async () => {
      const onRemoved = vi.fn();

      await cleanupWorktree({ repo, worktreePath: worktree, branch, onRemoved });

      expect(onRemoved).toHaveBeenCalledTimes(1);
      expect(git(repo, "branch", "--list", branch).trim()).toBe("");
      expect(fs.existsSync(worktree)).toBe(false);
      expect(warnCalls()).toHaveLength(0);
    });

    it("remove 失败（locked worktree）不阻断：onRemoved 仍被调，不 reject", async () => {
      const onRemoved = vi.fn();
      // 确定性 remove 失败构造：locked working tree 连 --force 也拒绝移除
      git(repo, "worktree", "lock", worktree);

      await cleanupWorktree({ repo, worktreePath: worktree, branch, onRemoved });

      expect(onRemoved).toHaveBeenCalledTimes(1);
      // branch -D 因 worktree 元数据未清（used by worktree）也失败被容错吞掉——
      // 分支留给宿主 reaper/对账兜底收敛，本函数只保证不阻断、不丢步。
      expect(git(repo, "branch", "--list", branch).trim()).not.toBe("");
    });

    it("onRemoved 抛错不 reject：前两步已执行，失败仅 warn", async () => {
      const onRemoved = vi.fn(() => {
        throw new Error("registry remove failed");
      });

      await expect(
        cleanupWorktree({ repo, worktreePath: worktree, branch, onRemoved }),
      ).resolves.toBeUndefined();

      expect(onRemoved).toHaveBeenCalledTimes(1);
      expect(git(repo, "branch", "--list", branch).trim()).toBe("");
      const warns = warnCalls();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("onRemoved host hook failed");
    });

    it("onRemoved 缺席（可选钩子）不抛", async () => {
      await expect(
        cleanupWorktree({ repo, worktreePath: worktree, branch }),
      ).resolves.toBeUndefined();
      expect(git(repo, "branch", "--list", branch).trim()).toBe("");
    });
  });

  // ============================================================
  // listWorktreePorcelain：原始输出保真
  // ============================================================

  describe("listWorktreePorcelain 原始输出保真", () => {
    it("与 git 原始 stdout 逐字节全等（不 trim / 不加工）", async () => {
      const result = await listWorktreePorcelain({ repo });
      const raw = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf-8",
      });

      expect(result).toBe(raw);
      expect(result.endsWith("\n")).toBe(true);
    });

    it("内容含 worktree checkout 与 branch 行（git 原始行文即 realpath 形态）", async () => {
      const result = await listWorktreePorcelain({ repo });

      // git 输出的是 realpath 形态（macOS /var→/private/var）——这正是宿主
      // realpath 对账依赖原始输出、禁止加工的原因（设计 D5）。
      expect(result).toContain(`worktree ${fs.realpathSync(repo)}\n`);
      expect(result).toContain(`worktree ${fs.realpathSync(worktree)}\n`);
      expect(result).toContain(`branch refs/heads/${branch}\n`);
    });

    it("非 git 目录 → GitRunError", async () => {
      const notARepo = path.join(outerDir, "not-a-repo");
      fs.mkdirSync(notARepo, { recursive: true });

      await expect(listWorktreePorcelain({ repo: notARepo })).rejects.toBeInstanceOf(GitRunError);
    });
  });

  // ============================================================
  // gitRun / GitRunError / SafeId / dirty 谓词
  // ============================================================

  describe("gitRun / GitRunError", () => {
    it("失败命令 reject GitRunError（name/exitCode/stderr 诊断属性）", async () => {
      const err = await gitRun(["rev-parse", "definitely-not-a-ref"], { cwd: repo }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(GitRunError);
      const gitErr = err as GitRunError;
      expect(gitErr.name).toBe("GitRunError");
      expect(gitErr.message).toContain("git rev-parse failed");
      expect(typeof gitErr.exitCode).toBe("number");
      expect(gitErr.exitCode).not.toBe(0);
      expect(typeof gitErr.stderr).toBe("string");
    });

    it("成功命令 stdout 保真返回（不 trim，尾换行保留）", async () => {
      const out = await gitRun(["rev-parse", "HEAD"], { cwd: repo });

      expect(out.trim()).toBe(baseCommit);
      expect(out.endsWith("\n")).toBe(true);
    });
  });

  describe("SafeId", () => {
    it("isSafeId：白名单 ^[\\w-]+$ 放行 / 路径注入拒绝", () => {
      expect(isSafeId("bg-42_abc")).toBe(true);
      expect(isSafeId("a".repeat(64))).toBe(true);
      expect(isSafeId("../evil")).toBe(false);
      expect(isSafeId("a b")).toBe(false);
      expect(isSafeId("")).toBe(false);
      expect(isSafeId("a/b")).toBe(false);
    });

    it("assertSafeId：不合法抛 DirtyWorktreeError（消息含白名单说明）", () => {
      expect(() => assertSafeId("../evil")).toThrow(DirtyWorktreeError);
      expect(() => assertSafeId("../evil")).toThrow("must match ^[\\w-]+$");
      expect(() => assertSafeId("../evil", "sessionId")).toThrow(/sessionId/);
      expect(() => assertSafeId("ok-id_1")).not.toThrow();
    });
  });

  describe("isTreeDirty（dirty 谓词）", () => {
    it("空输出 / 纯空白 → false；porcelain 条目 → true", () => {
      expect(isTreeDirty("")).toBe(false);
      expect(isTreeDirty("\n")).toBe(false);
      expect(isTreeDirty("   \n")).toBe(false);
      expect(isTreeDirty(" M base.txt\n")).toBe(true);
      expect(isTreeDirty("?? new.txt\n")).toBe(true);
    });

    it("与真实 git status --porcelain 联动：干净树 false，改动后 true", async () => {
      expect(isTreeDirty(git(worktree, "status", "--porcelain"))).toBe(false);
      fs.appendFileSync(path.join(worktree, "base.txt"), "x\n", "utf-8");
      expect(isTreeDirty(git(worktree, "status", "--porcelain"))).toBe(true);
    });
  });
});
