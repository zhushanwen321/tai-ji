// src/__tests__/worktree-registry.test.ts
//
// WorktreeRegistry 单元测试。
// 用真实 tmpdir 做文件 IO（不 mock fs），验证：
//   - add/updatePid/remove/load 语义
//   - 同 branch 覆盖（去重）
//   - 文件不存在 / 损坏 / IO 错误的降级
//   - 原子写（.tmp → rename）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPAWN_GRACE_MS, type WorktreeEntry,WorktreeRegistry } from "../worktree/worktree-registry.ts";

const REPO_A = "/home/user/repo-a";
const REPO_B = "/home/user/repo-b";

function makeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repo: REPO_A,
    branch: "pi-sub-bg-1",
    checkout: path.join(os.tmpdir(), "pi-sub-bg-1"),
    pid: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("WorktreeRegistry", () => {
  let tmpAgentDir: string;
  let registry: WorktreeRegistry;
  let registryFile: string;

  beforeEach(() => {
    tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-registry-test-"));
    registry = new WorktreeRegistry(tmpAgentDir);
    registryFile = path.join(tmpAgentDir, "subagents", "worktrees.json");
  });

  afterEach(() => {
    fs.rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  describe("add + load", () => {
    it("add 后 load 能读到", async () => {
      const entry = makeEntry();
      await registry.add(entry);
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(entry);
    });

    it("多条目跨 repo 共存", async () => {
      const entryA = makeEntry({ repo: REPO_A, branch: "pi-sub-bg-1" });
      const entryB = makeEntry({ repo: REPO_B, branch: "pi-sub-bg-2" });
      await registry.add(entryA);
      await registry.add(entryB);
      const loaded = registry.load();
      expect(loaded).toHaveLength(2);
    });

    it("同 branch add 覆盖（去重）", async () => {
      const entry = makeEntry({ pid: 0 });
      await registry.add(entry);
      // 同 branch 再次 add（覆盖）
      const updated = makeEntry({ pid: 999 });
      await registry.add(updated);
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].pid).toBe(999);
    });
  });

  describe("updatePid", () => {
    it("补全 pid（create 占位 → first header 补全）", async () => {
      await registry.add(makeEntry({ branch: "pi-sub-bg-1", pid: 0 }));
      await registry.updatePid("pi-sub-bg-1", 12345);
      const loaded = registry.load();
      expect(loaded[0].pid).toBe(12345);
    });

    it("branch 不存在时忽略（幂等）", async () => {
      await registry.add(makeEntry({ branch: "pi-sub-bg-1" }));
      await registry.updatePid("pi-sub-nonexistent", 12345);
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].pid).toBe(0); // 原条目未变
    });

    it("update 不改变其他字段", async () => {
      const entry = makeEntry({ branch: "pi-sub-bg-1", repo: REPO_A, checkout: "/tmp/x" });
      await registry.add(entry);
      await registry.updatePid("pi-sub-bg-1", 999);
      const loaded = registry.load();
      expect(loaded[0].repo).toBe(REPO_A);
      expect(loaded[0].checkout).toBe("/tmp/x");
      expect(loaded[0].branch).toBe("pi-sub-bg-1");
    });
  });

  describe("remove", () => {
    it("移除指定 branch", async () => {
      await registry.add(makeEntry({ branch: "pi-sub-bg-1" }));
      await registry.add(makeEntry({ branch: "pi-sub-bg-2" }));
      await registry.remove("pi-sub-bg-1");
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].branch).toBe("pi-sub-bg-2");
    });

    it("branch 不存在时忽略（幂等）", async () => {
      await registry.add(makeEntry({ branch: "pi-sub-bg-1" }));
      await registry.remove("pi-sub-nonexistent");
      expect(registry.load()).toHaveLength(1);
    });

    it("空注册表 remove 不报错", async () => {
      await expect(registry.remove("pi-sub-anything")).resolves.not.toThrow();
    });
  });

  describe("降级与健壮性", () => {
    it("文件不存在时 load 返回空数组", async () => {
      expect(registry.load()).toEqual([]);
    });

    it("损坏 JSON 时 load 返回空数组", async () => {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, "{ not valid json }}}", "utf-8");
      expect(registry.load()).toEqual([]);
    });

    it("entries 字段缺失时 load 返回空数组", async () => {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, '{"other": 123}', "utf-8");
      expect(registry.load()).toEqual([]);
    });

    it("save 创建不存在的父目录", async () => {
      // registryFile 在 tmpAgentDir/subagents/ 下，subagents 目录不存在
      expect(fs.existsSync(path.dirname(registryFile))).toBe(false);
      await registry.add(makeEntry());
      expect(fs.existsSync(registryFile)).toBe(true);
    });

    it("save 后无残留 .tmp 文件（原子写）", async () => {
      await registry.add(makeEntry());
      const tmpFile = `${registryFile}.tmp`;
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe("SPAWN_GRACE_MS 常量", () => {
    it("值为 60s", async () => {
      expect(SPAWN_GRACE_MS).toBe(60_000);
    });
  });

  describe("D5a 锁互斥（两写方并发不丢条目）", () => {
    // [HISTORICAL] 2026-08-20 PR #185：真实 proper-lockfile 文件锁 RMW 用例显式超时——
    // 单跑 >1s，整包满并行 + 系统余载下 100/31 次持锁 load→mutate→save 超过 vitest
    // 默认 5s testTimeout（隔离跑通过，纯环境饿死），对齐本包 record-store-index 口径。
    it("两个 registry 实例（模拟两 pi 进程写方）并发各 add 50 条，零丢失", { timeout: 30_000 }, async () => {
      // 失败模式 G 的复现形态：无锁时两实例 load→mutate→save 交错，后写者覆盖
      // 先写者 → 条目丢失。锁内 RMW 应保证 100 条全部落盘。
      const r1 = new WorktreeRegistry(tmpAgentDir);
      const r2 = new WorktreeRegistry(tmpAgentDir);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        tasks.push(r1.add(makeEntry({ branch: `pi-sub-w1-${i}` })));
        tasks.push(r2.add(makeEntry({ branch: `pi-sub-w2-${i}` })));
      }
      await Promise.all(tasks);
      const loaded = r1.load();
      expect(loaded).toHaveLength(100);
      // 两写方的条目都在（非「后写者全量覆盖」形态）
      expect(loaded.filter((e) => e.branch.startsWith("pi-sub-w1-"))).toHaveLength(50);
      expect(loaded.filter((e) => e.branch.startsWith("pi-sub-w2-"))).toHaveLength(50);
    });

    it("并发 add + remove 交错：remove 只删自己的 branch", { timeout: 30_000 }, async () => {
      const r1 = new WorktreeRegistry(tmpAgentDir);
      const r2 = new WorktreeRegistry(tmpAgentDir);
      await r1.add(makeEntry({ branch: "pi-sub-keep" }));
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 30; i++) {
        tasks.push(r2.add(makeEntry({ branch: `pi-sub-n-${i}` })));
      }
      tasks.push(r1.remove("pi-sub-keep"));
      await Promise.all(tasks);
      const loaded = r1.load();
      expect(loaded).toHaveLength(30);
      expect(loaded.find((e) => e.branch === "pi-sub-keep")).toBeUndefined();
    });
  });
});
