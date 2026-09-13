// src/execution/engine/common/pool-manager.ts
//
// 隔离目录池管理（P2 公共降级层）。现行权威：docs/extensions/subagents/architecture.md
//（现状 SSOT 导航页）+ constraints.json C-ext-15——原设计 subagent-engine-abstraction.md
// D5（隔离目录池化保留，随 record 生命周期回收，清理只做到池粒度）/ §3.3.9（目录布局 /
// refs.json 方案）已删除，git 可追溯。
//
// refs.json 文件形态（D8 接线，dual-track-convergence）：引用计数的唯一权威源是
// 池目录内 refs.json——进程重启后计数可恢复（文件在即计数在）。.acquire 登记
// taskId（幂等刷新 ts），release 移除 taskId 并删对应 journal；计数归零删池内
// 引擎原生状态。读写全同步 fs 且无 await 让出点——单线程事件循环天然不交错，
// §3.3.9「进程内互斥」由此满足（宿主是唯一写者，无跨进程竞争）。
//
// 删除边界（D5 三条硬规则）：
//   1. 只删引擎原生状态（隔离 HOME / config / db.sqlite，均可由 preparer 重建）；
//   2. journal-*.jsonl 不随池删——生命周期跟随 record，release 只删「该 record 自己的」
//      journal（record GC 时联动，避免「池删导致仍存 record 的历史从②级静默跌③级」）；
//   3. 删除失败置 .pool-cleanup-failed 标记文件（可观测不静默），启动期扫描该标记告警。
//   隔离库边界（2026-09 会话库隔离，设计 docs/architecture/zcode-session-db-isolation.md D4）：
//   zcode 隔离会话库不在池目录内，但 TTL 扫描会枚举 session-db/（engines/<id>/ 下每个
//   子目录都被当池遍历）——db.sqlite* 不匹配任何删除条件（无 refs.json 早退；孤儿 journal
//   只匹配 journal-*.jsonl），由 A9 守卫测试（公共 API + 枚举断言）钉死。
//
// TTL 兜底（cleanupExpiredPoolRefs）：record 主数据的死亡（主 session 文件被 pi 侧
// 管理）对 core 无触发点，done record 的 journal 因此没有精确回收锚——按 30 天 mtime
// 兜底回收（journal/refs 条目），与 session-file-gc 的 session TTL 同时间尺度，是
// D8 分域口径「journal 依赖 30 天 TTL 自然回收」的落地（workflow 域 taskId 占位无
// record 生命周期锚，同样依赖此兜底）。

import * as fsSync from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../../core/logger.ts";

import { resolveEnginesRoot, resolveJournalPath, resolvePoolDir, sanitizeSeg } from "../paths.ts";
import { toErrorMessage } from "../../../core/error-message.ts";

const logger = getLogger("subagents");

/** 清理失败标记文件名（置于池目录内；内容为 JSON 失败清单）。 */
export const POOL_CLEANUP_FAILED_MARKER = ".pool-cleanup-failed";

/** 池引用登记文件名（§3.3.9 目录布局）。 */
export const REFS_JSON_FILENAME = "refs.json";

/** refs.json 的 v1 schema 版本号。 */
const REFS_VERSION = 1 as const;

/** journal 文件名前缀（与 paths.ts 的 journal-<taskId>.jsonl 命名约定一致）。 */
const JOURNAL_PREFIX = "journal-";
/** journal 文件名后缀。 */
const JOURNAL_SUFFIX = ".jsonl";

/** refs.json 单条引用登记（§3.3.9 v1 形态）。 */
interface PoolRefEntry {
  taskId: string;
  ts: number;
}

/** refs.json v1 文件形态。 */
interface PoolRefsFile {
  v: 1;
  refs: Record<string, PoolRefEntry>;
}

/** readdir withFileTypes 的条目结构子集。 */
interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
}

/** 池管理的文件系统依赖面（结构接口：测试注入 fake，免 vi.mock 整个 fs 模块）。 */
export interface PoolFsDeps {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  readdirSync(path: string): DirEntryLike[];
  statSync(path: string): { mtimeMs: number };
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  rmdirSync(path: string): void;
}

// ============================================================
// refs.json 读写（原子写 + 防御读）
// ============================================================

function emptyRefs(): PoolRefsFile {
  return { v: REFS_VERSION, refs: {} };
}

/**
 * 读池引用登记。ENOENT / 损坏 JSON / 非 v1 形态 → 空登记起步（warn 留痕）——
 * refs 丢失的后果是「池留置」（保守方向），不是误删。
 */
function readPoolRefs(poolDir: string, fs: Pick<PoolFsDeps, "existsSync" | "readFileSync">): PoolRefsFile {
  const refsPath = join(poolDir, REFS_JSON_FILENAME);
  if (!fs.existsSync(refsPath)) return emptyRefs();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(refsPath));
  } catch (err) {
    logger.warn(
      `[pool-manager] refs.json unparsable for ${poolDir}, starting from empty refs: ` +
        `${toErrorMessage(err)}`,
    );
    return emptyRefs();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRefs();
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== REFS_VERSION || typeof obj.refs !== "object" || obj.refs === null) {
    logger.warn(`[pool-manager] refs.json unexpected shape for ${poolDir}, starting from empty refs`);
    return emptyRefs();
  }
  const refs: Record<string, PoolRefEntry> = {};
  for (const [taskId, entry] of Object.entries(obj.refs as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.taskId !== "string" || typeof e.ts !== "number") continue;
    refs[taskId] = { taskId: e.taskId, ts: e.ts };
  }
  return { v: REFS_VERSION, refs };
}

/** 原子写回 refs.json（tmp + rename）。失败置清理失败标记（§3.3.9），不 throw。 */
function writePoolRefs(
  poolDir: string,
  file: PoolRefsFile,
  fs: Pick<PoolFsDeps, "writeFileSync" | "renameSync">,
): boolean {
  const refsPath = join(poolDir, REFS_JSON_FILENAME);
  const tmpPath = `${refsPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(file)}\n`);
    fs.renameSync(tmpPath, refsPath);
    return true;
  } catch (err) {
    markCleanupFailed(
      poolDir,
      [`(${REFS_JSON_FILENAME} write): ${toErrorMessage(err)}`],
      fs,
    );
    return false;
  }
}

// ============================================================
// acquire / release
// ============================================================

/**
 * 获取池目录：mkdir -p（幂等）+ refs.json 登记 taskId（幂等：已存在刷新 ts），
 * 返回池目录绝对路径。路径一律经 paths.ts resolvePoolDir 派生（双端同源，禁自拼）。
 * taskId = 引用计数 key（chat 域 = record.id；与 journal 文件名同源）。
 */
export function acquirePool(
  dataDir: string,
  engineId: string,
  poolKey: string,
  taskId: string,
  fs: Pick<PoolFsDeps, "mkdirSync" | "existsSync" | "readFileSync" | "writeFileSync" | "renameSync"> = nodeFs,
): string {
  const poolDir = resolvePoolDir(dataDir, engineId, poolKey);
  fs.mkdirSync(poolDir, { recursive: true });
  const file = readPoolRefs(poolDir, fs);
  file.refs[taskId] = { taskId, ts: Date.now() };
  // 写失败置标记但池目录已建——run 照常用池（标记可观测， refs 登记下次 acquire 重试）
  writePoolRefs(poolDir, file, fs);
  return poolDir;
}

/**
 * 释放一次池引用（record GC / 删除时调用）：
 *   1. 删该 taskId 的 journal 文件（journal 生命周期跟随 record，§3.3.9 release 语义
 *      ——record 已死则②级数据源无保留意义；无条目也删，record 死亡是充分条件）；
 *   2. refs.json 移除该 taskId；移除后归零 → 删池内引擎原生状态（其他 journal 保留）；
 *   3. taskId 不在 refs（进程重启前 refs 丢失 / 未 acquire 的释放）→ 保守不删池：
 *      删池决策必须有 refs 归零证据，凭空删除可能误删其他引用方正在使用的池。
 * 删除失败置标记文件并 warn，不静默不 throw（清理失败不是 record GC 的失败）。
 */
export function releasePoolRef(
  dataDir: string,
  engineId: string,
  poolKey: string,
  taskId: string,
  fs: PoolFsDeps = nodeFs,
): void {
  const poolDir = resolvePoolDir(dataDir, engineId, poolKey);
  removeJournalFile(dataDir, engineId, poolKey, taskId, fs);

  const file = readPoolRefs(poolDir, fs);
  if (file.refs[taskId] === undefined) {
    logger.debug(`[pool-manager] release without live ref, skip pool deletion: ${poolDir} (${taskId})`);
    return;
  }
  delete file.refs[taskId];
  writePoolRefs(poolDir, file, fs);
  if (Object.keys(file.refs).length === 0) {
    deletePoolNativeState(poolDir, fs);
  }
}

/** 删单个 journal 文件（force 豁免 ENOENT；失败置标记可观测）。 */
function removeJournalFile(
  dataDir: string,
  engineId: string,
  poolKey: string,
  taskId: string,
  fs: Pick<PoolFsDeps, "rmSync" | "writeFileSync" | "renameSync">,
): void {
  const journalPath = resolveJournalPath(dataDir, engineId, poolKey, taskId);
  try {
    fs.rmSync(journalPath, { force: true, recursive: true });
  } catch (err) {
    markCleanupFailed(
      resolvePoolDir(dataDir, engineId, poolKey),
      [`(journal ${taskId}): ${toErrorMessage(err)}`],
      fs,
    );
  }
}

// ============================================================
// TTL 兜底清理（journal / refs 条目按 30 天 mtime 回收）
// ============================================================

/**
 * 按 TTL 回收全部引擎池的超龄引用：journal mtime 超龄 → 删 journal + 移除 refs 条目；
 * refs 条目 ts 超龄且 journal 不存在 → 移除（孤儿条目）；无 refs 对应的超龄 journal
 * （refs 丢失场景）→ 删；归零删池内引擎原生状态（未超龄 journal 保留——目录随之保留）。
 * 语义 = D8 分域口径「journal 依赖 30 天 TTL 自然回收」的落地（record 主数据由 pi 侧
 * 主 session 文件管理，其删除对 core 无触发点，done record 只能靠 mtime 兜底）。
 */
export function cleanupExpiredPoolRefs(
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
    return; // engines 根不存在（从未建池）= 无可清理
  }
  for (const engineEntry of engines) {
    if (!engineEntry.isDirectory()) continue;
    const engineDir = join(enginesRoot, engineEntry.name);
    let pools: DirEntryLike[];
    try {
      pools = fs.readdirSync(engineDir);
    } catch {
      continue;
    }
    for (const poolEntry of pools) {
      if (!poolEntry.isDirectory()) continue;
      cleanupPoolByTtl(join(engineDir, poolEntry.name), ttlMs, fs, now);
    }
  }
}

/** 单池 TTL 清理（见 cleanupExpiredPoolRefs 语义分解）。两阶段见下方辅助函数。 */
function cleanupPoolByTtl(poolDir: string, ttlMs: number, fs: PoolFsDeps, now: number): void {
  const file = readPoolRefs(poolDir, fs);
  const hadRefs = Object.keys(file.refs).length > 0;

  // 1. refs 条目决策：journal 超龄（或 journal 不在 + 条目 ts 超龄）→ 移除
  let changed = removeExpiredRefEntries(poolDir, file, ttlMs, fs, now);

  // 2. 无主超龄 journal（无任何 refs 条目对应——refs 丢失/损坏重建场景）：按 mtime 删。
  // readdir 失败 → 中止本池清理（阶段 1 的 refs 变更不落盘，下次扫描按原 refs 重算）。
  let entries: DirEntryLike[];
  try {
    entries = fs.readdirSync(poolDir);
  } catch {
    return;
  }
  if (removeOrphanJournals(poolDir, file, entries, ttlMs, fs, now)) changed = true;

  if (!changed) return;
  writePoolRefs(poolDir, file, fs);
  if (hadRefs && Object.keys(file.refs).length === 0) {
    deletePoolNativeState(poolDir, fs);
  }
}

/**
 * TTL 阶段 1——refs 条目决策（直接变更 file.refs，按需删对应 journal）：
 * journal 超龄 → 删 journal + 移除条目；journal 不在 + 条目 ts 超龄 → 移除（孤儿条目）。
 * 返回 refs 是否有变更。
 */
function removeExpiredRefEntries(
  poolDir: string,
  file: PoolRefsFile,
  ttlMs: number,
  fs: PoolFsDeps,
  now: number,
): boolean {
  let changed = false;
  for (const [taskId, entry] of Object.entries(file.refs)) {
    const journalPath = join(poolDir, `${JOURNAL_PREFIX}${sanitizeSeg(taskId)}${JOURNAL_SUFFIX}`);
    if (fs.existsSync(journalPath)) {
      const age = now - fs.statSync(journalPath).mtimeMs;
      if (age > ttlMs) {
        unlinkBestEffort(journalPath, fs);
        delete file.refs[taskId];
        changed = true;
      }
    } else if (now - entry.ts > ttlMs) {
      delete file.refs[taskId];
      changed = true;
    }
  }
  return changed;
}

/**
 * TTL 阶段 2——无主超龄 journal 回收。ownedSegments 基于阶段 1 变更后的 refs
 * （仍有 refs 对应的 journal 不动）。返回是否有删除。
 */
function removeOrphanJournals(
  poolDir: string,
  file: PoolRefsFile,
  entries: DirEntryLike[],
  ttlMs: number,
  fs: PoolFsDeps,
  now: number,
): boolean {
  let changed = false;
  const ownedSegments = new Set(Object.keys(file.refs).map((taskId) => sanitizeSeg(taskId)));
  for (const entry of entries) {
    if (!isJournalFile(entry.name)) continue;
    const segment = journalTaskSegment(entry.name);
    if (segment !== undefined && ownedSegments.has(segment)) continue;
    const journalPath = join(poolDir, entry.name);
    try {
      if (now - fs.statSync(journalPath).mtimeMs > ttlMs) {
        unlinkBestEffort(journalPath, fs);
        changed = true;
      }
    } catch (err) {
      // stat 失败（并发删除等）跳过该条——TTL 扫描周期性重跑，最终一致
      logger.debug(
        `[pool-manager] ttl cleanup stat failed for ${journalPath}: ` +
          `${toErrorMessage(err)}`,
      );
    }
  }
  return changed;
}

/** journal 文件名 → taskId 段（journal-<seg>.jsonl → seg；形态不符返回 undefined）。 */
function journalTaskSegment(name: string): string | undefined {
  if (!name.startsWith(JOURNAL_PREFIX) || !name.endsWith(JOURNAL_SUFFIX)) return undefined;
  return name.slice(JOURNAL_PREFIX.length, name.length - JOURNAL_SUFFIX.length);
}

/** unlink 单文件（force 豁免 ENOENT；失败 best-effort 留痕）。 */
function unlinkBestEffort(path: string, fs: Pick<PoolFsDeps, "rmSync">): void {
  try {
    fs.rmSync(path, { force: true, recursive: true });
  } catch (err) {
    logger.debug(`[pool-manager] ttl cleanup failed for ${path}: ${toErrorMessage(err)}`);
  }
}

// ============================================================
// 归零删池（引擎原生状态）
// ============================================================

/** journal 文件名判定（与 paths.ts 的 journal-<taskId>.jsonl 命名约定一致）。 */
function isJournalFile(name: string): boolean {
  return name.startsWith(JOURNAL_PREFIX) && name.endsWith(JOURNAL_SUFFIX);
}

/** 删池内引擎原生状态：逐条目删除（跳过 journal），目录清空后移除目录本身。 */
function deletePoolNativeState(poolDir: string, fs: PoolFsDeps): void {
  const failures: string[] = [];
  let entries: DirEntryLike[];
  try {
    entries = fs.readdirSync(poolDir);
  } catch {
    // 池目录不存在（从未创建 / 已删）= 无原生状态可清，视为成功
    return;
  }
  for (const entry of entries) {
    if (isJournalFile(entry.name)) continue;
    try {
      fs.rmSync(join(poolDir, entry.name), { recursive: true, force: true });
    } catch (err) {
      failures.push(`${entry.name}: ${toErrorMessage(err)}`);
    }
  }
  if (failures.length > 0) {
    markCleanupFailed(poolDir, failures, fs);
    return;
  }
  try {
    // 目录内只剩 journal（或已空）：只剩 journal 时保留目录（journal 生命周期跟 record）
    const remaining = fs.readdirSync(poolDir);
    if (remaining.every((e) => isJournalFile(e.name))) return;
    fs.rmdirSync(poolDir);
  } catch (err) {
    markCleanupFailed(
      poolDir,
      [`(rmdir): ${toErrorMessage(err)}`],
      fs,
    );
  }
}

/** 置 .pool-cleanup-failed 标记（失败清单 JSON）+ warn——可观测不静默（D5）。 */
function markCleanupFailed(
  poolDir: string,
  failures: string[],
  fs: Pick<PoolFsDeps, "writeFileSync">,
): void {
  const marker = join(poolDir, POOL_CLEANUP_FAILED_MARKER);
  const payload = JSON.stringify({ ts: Date.now(), failures });
  logger.warn(
    `[pool-manager] pool cleanup failed for ${poolDir} (${failures.length} item(s)); ` +
      `marker written to ${marker} — re-run cleanup after fixing the underlying error`,
  );
  try {
    fs.writeFileSync(marker, `${payload}\n`);
  } catch (err) {
    // 标记本身也写不进（目录只读/磁盘满）——error 级留痕是最后防线，不再上抛
    logger.warn(
      `[pool-manager] failed to write cleanup-failed marker ${marker}: ` +
        `${toErrorMessage(err)}`,
    );
  }
}

// ============================================================
// 单次性产物清理（spawnedFiles）
// ============================================================

/** cleanupSpawnedFiles 选项。 */
export interface SpawnedFilesCleanupOpts {
  /**
   * resume 场景保留：true = 全部保留（no-op）。resume 续接原 session，prompt 文件
   * 等单次性产物不再重写（§3.3.7 preparer resume 语义），清理留给 record 终局。
   */
  keepForResume: boolean;
}

/**
 * 清理单次性产物（preparer 的 spawnedFiles：临时 prompt / persona 文件）。
 * 任务结束即清理（D5）；单条失败收集 warn 不 throw（部分清理优于整体失败），ENOENT
 * 幂等忽略。
 */
export function cleanupSpawnedFiles(
  paths: string[],
  opts: SpawnedFilesCleanupOpts,
  fs: Pick<PoolFsDeps, "rmSync"> = nodeFs,
): void {
  if (opts.keepForResume) return;
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[pool-manager] spawned file cleanup failed for ${p}: ` +
          `${toErrorMessage(err)}`,
      );
    }
  }
}

// ── 默认 fs 实现 ────────────────────────────────────────────────

const nodeFs: PoolFsDeps = {
  mkdirSync: (p, o) => fsSync.mkdirSync(p, o),
  readdirSync: (p) => fsSync.readdirSync(p, { withFileTypes: true }),
  statSync: (p) => fsSync.statSync(p),
  existsSync: (p) => fsSync.existsSync(p),
  readFileSync: (p) => fsSync.readFileSync(p, "utf8"),
  writeFileSync: (p, d) => fsSync.writeFileSync(p, d, "utf8"),
  renameSync: (from, to) => fsSync.renameSync(from, to),
  rmSync: (p, o) => fsSync.rmSync(p, o),
  rmdirSync: (p) => fsSync.rmdirSync(p),
};
