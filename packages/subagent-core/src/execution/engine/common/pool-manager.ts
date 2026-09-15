// src/execution/engine/common/pool-manager.ts
//
// 引擎 journal 生命周期管理（TTL 回收）。现行权威：docs/extensions/subagents/architecture.md
//（现状 SSOT 导航页）+ constraints.json C-ext-15。
//
// [池抽象降级 2026-09-13] 原隔离目录池机制整体退役：两引擎（pi / zcode）均无池化
// 实现，poolKey 恒 'shared'，journal 固定落 engines/<engineId>/shared/。随之删除：
//   - acquirePool + refs.json 引用计数（acquire 半边生产零调用；release 半边依赖的
//     refs 计数在恒 'shared' 布局下无真实生命周期语义）；
//   - deletePoolNativeState（池内引擎原生状态删除——共享布局下池目录只含 journal，
//     无原生状态可删）与 .pool-cleanup-failed 标记机制；
//   - cleanupSpawnedFiles（生产零调用的单次性产物清理）。
// journal 回收只剩本文件唯一机制：30 天 mtime TTL（与 session-file-gc 的 session
// TTL 同时间尺度）——record 主数据的死亡（主 session 文件被引擎侧管理）对 core 无
// 触发点，done record 的 journal 没有精确回收锚，按 mtime 兜底回收是既有口径的
// 落地（原 D8 分域「journal 依赖 30 天 TTL 自然回收」）。
//
// 目录枚举边界（保留原 A9 守卫形态）：扫描把 engines/<engineId>/ 下每个子目录都
// 遍历——zcode 隔离会话库 session-db/ 会被当子目录枚举，但 db.sqlite* 不匹配任何
// 删除条件（只删 journal-*.jsonl 与 refs.json 残留），由 zcode 侧 A9 守卫测试
//（公共 API + 枚举断言）钉死。

import * as fsSync from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../../core/logger.ts";

import { resolveEnginesRoot } from "../paths.ts";
import { toErrorMessage } from "../../../core/error-message.ts";

const logger = getLogger("subagents");

/** journal 文件名前缀（与 paths.ts 的 journal-<taskId>.jsonl 命名约定一致）。 */
const JOURNAL_PREFIX = "journal-";
/** journal 文件名后缀。 */
const JOURNAL_SUFFIX = ".jsonl";
/**
 * 池时代 refs.json 的残留清理目标（[池抽象降级] 后不再有写面；存量文件按 mtime
 * 同 TTL 回收，处理降级过渡期残留）。
 */
const LEGACY_REFS_FILENAME = "refs.json";

/** readdir withFileTypes 的条目结构子集。 */
interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
}

/** 清理的文件系统依赖面（结构接口：测试注入 fake，免 vi.mock 整个 fs 模块）。 */
export interface PoolFsDeps {
  readdirSync(path: string): DirEntryLike[];
  statSync(path: string): { mtimeMs: number };
  rmSync(path: string, opts: { recursive?: boolean; force?: boolean }): void;
  rmdirSync(path: string): void;
}

/**
 * 按 TTL 回收全部引擎目录的超龄 journal：engines/<engineId>/<分组>/ 下 journal-*.jsonl
 * 与池时代残留 refs.json，mtime 超龄即删；目录内可清理条目清空且目录已空 → 移除目录
 * 本身（目录内仍有其他文件——如 zcode session-db 的 db.sqlite——时保留）。
 * 语义 = 「journal 依赖 30 天 TTL 自然回收」（record 主数据由引擎侧主 session 文件
 * 管理，其删除对 core 无触发点，只能靠 mtime 兜底）。
 */
export function cleanupExpiredJournals(
  dataDir: string,
  ttlMs: number,
  fs: PoolFsDeps = nodeFs,
  now: number = Date.now(),
): void {
  const enginesRoot = resolveEnginesRoot(dataDir);
  let engines: DirEntryLike[];
  try {
    engines = fs.readdirSync(enginesRoot);
  } catch {
    return; // engines 根不存在（从未落 journal）= 无可清理
  }
  for (const engineEntry of engines) {
    if (!engineEntry.isDirectory()) continue;
    const engineDir = join(enginesRoot, engineEntry.name);
    let groups: DirEntryLike[];
    try {
      groups = fs.readdirSync(engineDir);
    } catch {
      continue;
    }
    for (const groupEntry of groups) {
      if (!groupEntry.isDirectory()) continue;
      cleanupGroupByTtl(join(engineDir, groupEntry.name), ttlMs, fs, now);
    }
  }
}

/** 单分组目录 TTL 清理：超龄 journal/refs 残留删除 + 空目录回收。 */
function cleanupGroupByTtl(poolDir: string, ttlMs: number, fs: PoolFsDeps, now: number): void {
  let entries: DirEntryLike[];
  try {
    entries = fs.readdirSync(poolDir);
  } catch {
    return;
  }
  let removedAll = true;
  for (const entry of entries) {
    if (isCleanableName(entry.name)) {
      const path = join(poolDir, entry.name);
      try {
        if (now - fs.statSync(path).mtimeMs > ttlMs) {
          unlinkBestEffort(path, fs);
        } else {
          removedAll = false; // 未超龄条目保留 → 目录保留
        }
      } catch (err) {
        // stat 失败（并发删除等）跳过该条——TTL 扫描周期性重跑，最终一致
        logger.debug(
          `[pool-manager] ttl cleanup stat failed for ${path}: ` +
            `${toErrorMessage(err)}`,
        );
      }
    } else {
      removedAll = false; // 非清理目标（zcode session-db 的 db.sqlite 等）→ 目录保留
    }
  }
  if (!removedAll) return;
  try {
    // 目录内可清理条目全部删净且无其他文件 → 回收目录本身；rmdir 失败（并发写入等）
    // 留待下轮扫描，不构成错误
    fs.rmdirSync(poolDir);
  } catch (err) {
    logger.debug(
      `[pool-manager] ttl cleanup rmdir failed for ${poolDir}: ${toErrorMessage(err)}`,
    );
  }
}

/** 清理目标文件名判定（journal-*.jsonl + 池时代 refs.json 残留）。 */
function isCleanableName(name: string): boolean {
  return (
    (name.startsWith(JOURNAL_PREFIX) && name.endsWith(JOURNAL_SUFFIX)) ||
    name === LEGACY_REFS_FILENAME
  );
}

/** unlink 单文件（force 豁免 ENOENT；失败 best-effort 留痕）。 */
function unlinkBestEffort(path: string, fs: Pick<PoolFsDeps, "rmSync">): void {
  try {
    fs.rmSync(path, { force: true, recursive: true });
  } catch (err) {
    logger.debug(`[pool-manager] ttl cleanup failed for ${path}: ${toErrorMessage(err)}`);
  }
}

// ── 默认 fs 实现 ────────────────────────────────────────────────

const nodeFs: PoolFsDeps = {
  readdirSync: (p) => fsSync.readdirSync(p, { withFileTypes: true }),
  statSync: (p) => fsSync.statSync(p),
  rmSync: (p, o) => fsSync.rmSync(p, o),
  rmdirSync: (p) => fsSync.rmdirSync(p),
};
