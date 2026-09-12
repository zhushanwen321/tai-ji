// src/execution/worktree-registry.ts
//
// 全局 worktree 注册表：跨 repo 记录所有活 pi-sub-* worktree。
//
// 取代旧的 per-cwd 扫描 + .session mapping sidecar 链。
// 旧 reaper 的两个根本缺陷由此消除：
//   1. 触发覆盖：旧 scan 扫「当前 cwd 对应的 repo」，workspace 根 / 非 git 目录启动时
//      rev-parse 报错整个挂掉；且 tmpdir 下的 checkout 永远不会被 pi cwd "看到"。
//      → 新 scan 遍历全局注册表，不依赖 cwd 是否 git repo。
//   2. 判据脆弱：旧 scan 用 .finalized/.cancelled 终态 marker 作主判据，进程崩溃时
//      无人写终态 → 孤儿永久泄漏。→ 新判据：pid 死活一条判到底。
//
// 并发模型：
//   - 跨进程互斥（D5a）：add/updatePid/remove 的 load→mutate→save 全程持
//     proper-lockfile 异步锁（<worktrees.json>.lock，协议登记 data-source-registry.md §6）。
//     锁不可用（重试耗尽）时降级为无锁 RMW + warn——注册表是 best-effort 数据，
//     降级不比锁前更差，条目丢失由 reaper 对账兜底（worktree-manager scan 的
//     双向 diff，见 reconcileWithPhysical）。
//   - 同步 IO（readFileSync/writeFileSync）持锁执行：锁内临界区毫秒级，
//     async 锁 + sync IO 组合在单线程 event loop 内无 interleaving。
//   - 原子写：tmp+rename 统一走 shared/atomic-write（U6b），防写一半崩溃产生损坏 JSON。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";
import { writeAtomicFileSync } from "../shared/atomic-write.ts";
import lockfile from "proper-lockfile";

import { bestEffort } from "./best-effort.ts";

const logger = getLogger("subagents");

/** create→spawn 宽限期（ms）：pid=0 条目超过此阈值判 create 后崩溃。 */
export const SPAWN_GRACE_MS = 60_000;

/** JSON 缩进空格数（可读性 + diff 友好）。 */
const JSON_INDENT = 2;

/**
 * 锁参数：对齐三方同一磁盘协议的既有默认值——runtime 侧
 * packages/runtime/src/utils/file-lock.ts 的 withFileLockAsync、pi auth-storage
 * 范本、本文件 proper-lockfile 调用（retry 库参数：stale 30s / retries 10 /
 * factor 2 / 100ms~10s randomize）。互斥由 lockfile 路径（<worktrees.json>.lock）
 * + mkdir 原子协议保证；默认值对齐锚定的是各写方夺取时机（stale）与失败速度
 * （重试参数）行为一致（协议登记 data-source-registry.md §6）。
 */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 10;

/** 注册表 JSON 顶层结构的运行时类型守卫。 */
function isRegistryData(value: unknown): value is { entries: WorktreeEntry[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries)
  );
}

/**
 * 注册表条目：一条 = 一个活 worktree。
 * 字段全部来自 WorktreeHandle + session-runner 已捕获的 child.pid，零新数据源。
 */
export interface WorktreeEntry {
  /** 主仓库根目录（git -C <repo> 操作目标）。 */
  readonly repo: string;
  /** 分支名（"pi-sub-<recordId>"）。 */
  readonly branch: string;
  /** checkout 目录（tmpdir 下，= WorktreeHandle.path）。 */
  readonly checkout: string;
  /** 子进程 pid（0 = create-spawn 窗口，尚未拿到 pid）。 */
  readonly pid: number;
  /** 创建时间戳（ms，SPAWN_GRACE 判据 + 调试用）。 */
  readonly createdAt: number;
  /**
   * 对应 subagent session jsonl 文件全路径（诊断/兼容字段，reaper 据 pid 死活判孤儿）。
   * session-runner first header 拿到 pid 时补全（create 时 record.sessionFile 尚未确定）。
   * 可选：旧 worktrees.json / 非 worktree 模式无此字段，向后兼容（undefined 时 reaper 走原 pid 判据）。
   */
  readonly sessionFile?: string;
}

/**
 * 全局 worktree 注册表。
 *
 * 文件位置：<agentDir>/subagents/worktrees.json（repo 无关层级，跨 repo 共享）
 * 格式：{ "entries": WorktreeEntry[] }
 */
export class WorktreeRegistry {
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.filePath = path.join(agentDir, "subagents", "worktrees.json");
  }

  /**
   * 新增条目（create 成功后调，pid=0 占位）。
   * 同 branch 已存在则覆盖（防残留覆盖）。
   * 跨进程锁内 RMW（D5a）；锁降级路径见 mutate。
   */
  async add(entry: WorktreeEntry): Promise<void> {
    await this.mutate((entries) => {
      const idx = entries.findIndex((e) => e.branch === entry.branch);
      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
    });
  }

  /**
   * 更新 pid（runSpawn spawn() 返回后同步调）。
   * branch 不存在则忽略（create 后崩溃 + reaper 已清的竞态）。
   * sessionFile 可选补全：传入时填入 entry（reaper 据 pid 死活判孤儿，不读本字段）。
   */
  async updatePid(branch: string, pid: number, sessionFile?: string): Promise<void> {
    await this.mutate(
      (entries) => {
        const idx = entries.findIndex((e) => e.branch === branch);
        if (idx >= 0) {
          entries[idx] = {
            ...entries[idx],
            pid,
            ...(sessionFile !== undefined ? { sessionFile } : {}),
          };
        }
      },
      { branch, pid },
    );
  }

  /**
   * 移除条目（cleanup/reaper 清理后调）。
   * branch 不存在则忽略（幂等）。
   */
  async remove(branch: string): Promise<void> {
    await this.mutate(
      (entries) => {
        const filtered = entries.filter((e) => e.branch !== branch);
        if (filtered.length !== entries.length) {
          entries.length = 0;
          entries.push(...filtered);
        }
      },
      { branch },
    );
  }

  /**
   * 锁内 RMW 统一入口：withLock(load → mutate → save)。
   *
   * 降级语义（对齐本类既有 best-effort 约定——注册表写失败不阻断 create/cleanup
   * 主流程）：锁获取失败（重试耗尽 ELOCKED 等）→ warn + 无锁执行同一段 RMW
   * （= D5a 之前的 last-write-wins 行为，条目丢失由 reaper 对账兜底），
   * 不抛错、永不 reject（调用方含 session-runner 的 fire-and-forget 回调）。
   */
  private async mutate(
    mutate: (entries: WorktreeEntry[]) => void,
    context?: { branch?: string; pid?: number },
  ): Promise<void> {
    const run = (): void => {
      const entries = this.load();
      mutate(entries);
      this.save(entries, context);
    };
    try {
      await this.withLock(() => {
        run();
      });
    } catch (lockErr) {
      // 锁不可用（ELOCKED 重试耗尽 / 锁目录损坏等）：降级无锁 RMW。
      // 竞争窗口内可能丢条目（旧缺陷形态），由 reaper 对账（scan 双向 diff）收敛。
      logger.warn("[worktree] registry lock unavailable, degraded to lock-free RMW", {
        ...(context ?? {}),
        err: lockErr instanceof Error ? lockErr.message : String(lockErr),
      });
      try {
        run();
      } catch (err) {
        bestEffort(err, "worktree registry degraded RMW");
      }
    }
  }

  /**
   * proper-lockfile 直用的跨进程锁（取代已删除的共享 file-lock 包装，抽包去依赖）。
   * 锁协议对齐现存三方同协议实现——runtime 侧 packages/runtime/src/utils/file-lock.ts
   * 的 withFileLockAsync（范本 pi FileAuthStorageBackend，参数对齐 proper-lockfile
   * 内部 retry 库）与 extension 侧 @zhushanwen/pi-file-lock：
   *   - lockfile 路径 = <目标文件>.lock（proper-lockfile 默认，与 runtime 侧/
   *     extension 侧同一路径才互斥）
   *   - realpath:false —— 目标文件不存在也可锁（realpath 默认 true 时 ENOENT）
   *   - stale 30s：持锁进程崩溃后锁可被夺取
   *   - async retries 指数退避：10 次 / factor 2 / 100ms~10s / randomize，耗尽抛
   *     ELOCKED（调用方 mutate 的 catch 决定降级路径）
   *   - onCompromised：锁被 stale 夺取时标记，fn 执行前抛错——防止在失去互斥
   *     保证的锁下写盘（对齐 pi throwIfCompromised 语义）
   * 锁参数值由 LOCK_STALE_MS / LOCK_RETRIES 常量承载（防漂移说明见常量注释）。
   */
  private async withLock(fn: () => void): Promise<void> {
    // 锁前确保父目录存在：proper-lockfile 创建 lockfile（<目标>.lock）需要目录在
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let compromised: Error | undefined;
    const release = await lockfile.lock(this.filePath, {
      realpath: false,
      stale: LOCK_STALE_MS,
      retries: {
        retries: LOCK_RETRIES,
        factor: 2,
        minTimeout: 100,
        maxTimeout: 10_000,
        randomize: true,
      },
      onCompromised: (err: Error) => {
        compromised = err;
      },
    });
    try {
      if (compromised) throw compromised;
      fn();
    } finally {
      try {
        await release();
      } catch (unlockErr) {
        // 锁已 compromised（被 stale 夺取）时 unlock 必然失败且可忽略——记录留痕
        // 不外抛（对齐被替换的 file-lock 包装 finally catch 语义）。
        logger.debug("unlock failed after compromise (ignorable)", {
          detail: { err: unlockErr instanceof Error ? unlockErr.message : String(unlockErr) },
        });
      }
    }
  }

  /**
   * 加载全部条目（reaper 遍历用）。
   * 文件不存在 / 解析失败 / IO 错误 → 返回空数组（视为无活 worktree）。
   */
  load(): WorktreeEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRegistryData(parsed)) {
        return parsed.entries;
      }
      return [];
    } catch {
      // 文件不存在（首次运行）/ 解析失败（损坏）/ IO 错误 → 空注册表
      return [];
    }
  }

  /**
   * 原子写入全部条目（shared/atomic-write 统一原语，U6b 迁移——sync 档
   * writeAtomicFileSync；写失败时原语清理残留 tmp，消除旧实现「write 成功但
   * rename 失败漏清 tmp」缺陷）。
   * best-effort：写入失败不阻断主流程（create/cleanup 的 git 操作已执行，
   * 注册表与 git 状态的短暂不一致靠下次 reaper 对账收敛）。
   * 写盘失败时 warn 日志（带 branch/pid 上下文，补全失败可观测闭环）。
   */
  private save(entries: WorktreeEntry[], context?: { branch?: string; pid?: number }): void {
    try {
      writeAtomicFileSync(this.filePath, JSON.stringify({ entries }, null, JSON_INDENT));
    } catch (err) {
      bestEffort(err, "worktree registry save");
      // [worktree-reaper-fix] 补全写盘失败静默吞错时，条目 pid 恒 0、60s 后被 reaper 误删
      // 活 worktree 且无诊断线索。此 warn 与 reaper scan 的 pid=0 warn 呼应，形成闭环。
      logger.warn(
        "[worktree] registry save failed; pid may stay 0 and be reaped by orphan reaper",
        { ...(context ?? {}), err: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}
