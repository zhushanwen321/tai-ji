// src/execution/__tests__/worktree-registry.test.ts
//
// WorktreeRegistry 单元测试。
// 用真实 tmpdir 做文件 IO（不 mock fs），验证：
//   - add/remove/load 语义
//   - 同 branch 覆盖（去重）
//   - 文件不存在 / 损坏 / IO 错误的降级
//   - 原子写（.tmp → rename）
//   - 锁内 RMW：每次变更先取 proper-lockfile 锁、锁不可用时降级无锁 RMW
//
// 锁的测法（判据三档之①：同步逻辑）：proper-lockfile 以确定性 FIFO 互斥桩替换
// （见下方 lockStub）——临界区的进入顺序由调用顺序构造，互斥与降级分支由此变为
// 可同步断言的逻辑，不依赖真实持锁时长与重试退避（满并行 + 系统余载下无稳定上界）。
// 两个真实 OS 进程之间的跨进程真互斥不属本层：并入 packages/runtime 的
// file-lock-parity（同一磁盘协议的集成探针，CI-only）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPAWN_GRACE_MS, type WorktreeEntry,WorktreeRegistry } from "../worktree/worktree-registry.ts";

const REPO_A = "/home/user/repo-a";
const REPO_B = "/home/user/repo-b";

// core logger 桩：断言锁降级路径的 warn 留痕（registry lock unavailable）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

/**
 * 确定性 proper-lockfile 桩：FIFO 互斥 + 可注入的两种失败形态。
 *
 * - FIFO：第 n 次 lock() 的获取完成排在前一次 release 之后（await 队尾），
 *   临界区顺序 = 调用顺序，满并行下也逐字节可预期；
 * - 记录 acquire/release 事件与 options（锁协议参数断言用；proper-lockfile 在目标
 *   路径后追加 `.lock` 作为磁盘锁文件，事件记的是追加后的实际锁路径）；
 * - failNextLock：下一次获取抛错（模拟 retries 耗尽的 ELOCKED）；
 * - compromiseNextLock：下一次获取时先触发 onCompromised（模拟锁被 stale 夺取）。
 */
const lockStub = vi.hoisted(() => {
  type LockEvent = { kind: "acquire" | "release"; file: string };
  const events: LockEvent[] = [];
  const options: Array<Record<string, unknown>> = [];
  let queueTail: Promise<void> = Promise.resolve();
  let holders = 0;
  let maxHolders = 0;
  let failWith: (Error & { code?: string }) | null = null;
  let compromiseOnAcquire = false;
  const lock = vi.fn(async (targetFile: string, opts: { onCompromised?: (err: Error) => void }) => {
    const prev = queueTail;
    let openGate!: () => void;
    queueTail = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    await prev; // FIFO：前一临界区释放后才算获取成功
    if (failWith !== null) {
      const err = failWith;
      failWith = null;
      openGate();
      throw err;
    }
    if (compromiseOnAcquire) {
      compromiseOnAcquire = false;
      opts.onCompromised?.(new Error("lock compromised by stale takeover"));
    }
    events.push({ kind: "acquire", file: `${targetFile}.lock` });
    options.push(opts as unknown as Record<string, unknown>);
    holders += 1;
    maxHolders = Math.max(maxHolders, holders);
    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      holders -= 1;
      events.push({ kind: "release", file: `${targetFile}.lock` });
      openGate();
    };
  });
  return {
    lock,
    events,
    options,
    maxHolders: (): number => maxHolders,
    reset(): void {
      events.length = 0;
      options.length = 0;
      holders = 0;
      maxHolders = 0;
      failWith = null;
      compromiseOnAcquire = false;
    },
    failNextLock(err: Error & { code?: string }): void {
      failWith = err;
    },
    compromiseNextLock(): void {
      compromiseOnAcquire = true;
    },
  };
});
vi.mock("proper-lockfile", () => ({ default: { lock: lockStub.lock } }));

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
    lockStub.reset();
    loggerMock.warn.mockClear();
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

  describe("D5a 锁内 RMW（写方并发不丢条目）", () => {
    it("add/remove 每次变更都先取锁：锁路径 = <worktrees.json>.lock，协议参数锁定", async () => {
      await registry.add(makeEntry({ branch: "pi-sub-wire-add" }));
      await registry.remove("pi-sub-wire-add");

      expect(lockStub.events).toEqual([
        { kind: "acquire", file: `${registryFile}.lock` },
        { kind: "release", file: `${registryFile}.lock` },
        { kind: "acquire", file: `${registryFile}.lock` },
        { kind: "release", file: `${registryFile}.lock` },
      ]);
      // 协议参数（与 runtime 侧 / extension 侧同一磁盘协议对齐）：目标文件不存在也可锁 +
      // stale 30s。改任一值即与其他两方失去互斥。
      expect(lockStub.options).toHaveLength(2);
      expect(lockStub.options[0]).toMatchObject({ realpath: false, stale: 30_000 });
      expect(typeof lockStub.options[0]?.onCompromised).toBe("function");
    });

    it("两个 registry 实例并发各 add：临界区串行、条目零丢失（锁内 RMW 不互相覆盖）", async () => {
      // 失败模式 G 的复现形态：无锁时两实例 load→mutate→save 交错，后写者覆盖
      // 先写者 → 条目丢失。锁内 RMW 串行后全部落盘。
      const r1 = new WorktreeRegistry(tmpAgentDir);
      const r2 = new WorktreeRegistry(tmpAgentDir);
      await Promise.all([
        r1.add(makeEntry({ branch: "pi-sub-w1-0" })),
        r2.add(makeEntry({ branch: "pi-sub-w2-0" })),
        r1.add(makeEntry({ branch: "pi-sub-w1-1" })),
        r2.add(makeEntry({ branch: "pi-sub-w2-1" })),
      ]);

      const loaded = r1.load();
      expect(loaded.map((e) => e.branch).sort()).toEqual([
        "pi-sub-w1-0",
        "pi-sub-w1-1",
        "pi-sub-w2-0",
        "pi-sub-w2-1",
      ]);
      // 锁时序：4 次 add = 4 组 acquire/release 严格交替（调用顺序），任意时刻
      // 至多一个持有者——互斥由构造保证，不靠真实持锁时长观测。
      expect(lockStub.events.map((e) => e.kind)).toEqual([
        "acquire",
        "release",
        "acquire",
        "release",
        "acquire",
        "release",
        "acquire",
        "release",
      ]);
      expect(lockStub.maxHolders()).toBe(1);
    });

    it("并发 add + remove 交错：remove 只删自己的 branch，他人 add 不丢", async () => {
      const r1 = new WorktreeRegistry(tmpAgentDir);
      const r2 = new WorktreeRegistry(tmpAgentDir);
      await r1.add(makeEntry({ branch: "pi-sub-keep" }));
      lockStub.reset();

      await Promise.all([
        r2.add(makeEntry({ branch: "pi-sub-n-0" })),
        r2.add(makeEntry({ branch: "pi-sub-n-1" })),
        r1.remove("pi-sub-keep"),
      ]);

      const loaded = r1.load();
      expect(loaded.map((e) => e.branch).sort()).toEqual(["pi-sub-n-0", "pi-sub-n-1"]);
      // remove 与 add 同在锁内串行：三次变更三组 acquire/release
      expect(lockStub.events).toHaveLength(6);
      expect(lockStub.maxHolders()).toBe(1);
    });

    it("锁不可用（retries 耗尽 ELOCKED）→ warn + 降级无锁 RMW，条目仍落盘且不 reject", async () => {
      lockStub.failNextLock(Object.assign(new Error("ELOCKED: lock unavailable"), { code: "ELOCKED" }));

      await expect(registry.add(makeEntry({ branch: "pi-sub-degraded" }))).resolves.toBeUndefined();

      // 降级不比锁前更差：同一条无锁 RMW 照常执行（条目丢失由 reaper 对账兜底）
      expect(registry.load().map((e) => e.branch)).toEqual(["pi-sub-degraded"]);
      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      expect(String(loggerMock.warn.mock.calls[0]?.[0])).toContain(
        "registry lock unavailable, degraded to lock-free RMW",
      );
      // 降级路径不再产生 acquire/release 事件（锁没拿到）
      expect(lockStub.events).toEqual([]);
    });

    it("锁被 stale 夺取（onCompromised）→ 临界区执行前抛错 → 降级无锁 RMW 仍生效", async () => {
      lockStub.compromiseNextLock();

      await expect(registry.add(makeEntry({ branch: "pi-sub-compromised" }))).resolves.toBeUndefined();

      expect(registry.load().map((e) => e.branch)).toEqual(["pi-sub-compromised"]);
      expect(String(loggerMock.warn.mock.calls.at(-1)?.[0])).toContain(
        "registry lock unavailable, degraded to lock-free RMW",
      );
      // 夺取标记在 fn 执行前抛错，但 release 仍被调用（finally）——无悬挂临界区
      expect(lockStub.events).toEqual([
        { kind: "acquire", file: `${registryFile}.lock` },
        { kind: "release", file: `${registryFile}.lock` },
      ]);
    });
  });
});
