/**
 * 原子写原语（sink 设计 U6a / B6）：tmp+rename 的单一实现。
 *
 * 背景：core 内部曾散布 6-7 份 tmp+rename 写点（manifest-store / sessions-index /
 * worktree-registry / engine-discovery / zcode preparer / zcode appserver-home），
 * tmp 命名各异（`.tmp.<pid>` / `.tmp_<pid>_<rand>` / `.tmp-<pid>-<ts>`）、失败路径
 * 清理纪律不齐（worktree-registry 失败时漏清残留 tmp）。本模块给出统一原语供全
 * 部写点收敛（调用点迁移归 u-wire 单元，本单元只建原语）。现存消费方 5 处：
 * manifest-store / sessions-index / worktree-registry / engine-discovery / record-store
 * （manifest writeSync 面）——zcode preparer 与 zcode appserver-home 两处写点已随
 * 2026-09 共享宿主 HOME 重构删除。
 *
 * **统一 tmp 命名约定**：`<最终路径>.tmp.<pid>.<seq>-<rand>`。
 * - `.tmp.` 标记向后兼容 manifest-store 既有扫描（`x.json` 的 tmp 名为
 *   `x.json.tmp.…`，命中其 `.json.tmp.` 模式）；
 * - pid 防两进程共用同一 tmp，seq+rand 防同进程内并发写同目标共用同一 tmp
 *   （对齐 sessions-index tmp 后缀的双重防撞设计）。
 *
 * **失败清理语义**：写入或 rename 失败 → 尽力 unlink 自身 tmp（失败仅 debug
 * 记录）→ 原错误原样上抛（不掩盖、不包装）。rename 成功后 tmp 已不存在，无需
 * 清理。跨进程/跨历史的陈旧残留 tmp 不由写入路径处理——统一走
 * listStaleTmpFiles / cleanupStaleTmpFiles 扫描入口（崩溃残留恢复语义的单点，
 * 见 sink 设计 §4 S6）。
 *
 * **两种耐久档位**（对齐现存两族写点的生产模式）：
 * - sync（writeAtomicFileSync）：writeFileSync + renameSync，无 fsync——对齐
 *   worktree-registry / engine-discovery / record-store（manifest writeSync 面）
 *   同步写点现状（注册表/发现缓存/索引类，进程崩溃窗口可容忍）；
 * - async（writeAtomicFile）：fsync 文件 → rename → 尽力 fsync 目录——对齐
 *   manifest-store / sessions-index 的生产耐久模式（掉电也不丢已确认写入）。
 */

import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";
import { toErrorMessage } from "../core/error-message.ts";

const logger = getLogger("subagents");

/** tmp 命名标记：`${最终路径}.tmp.${pid}.${uniq}`。 */
const TMP_MARKER = ".tmp.";

/** 解析约定 tmp 名：贪婪目标段 + `.tmp.` + pid + `.` + uniq（alnum/-）。 */
const TMP_NAME_PATTERN = /^(.+)\.tmp\.(\d+)\.[0-9A-Za-z-]+$/;

/** 同进程内 tmp 单调序号（与随机段联合防并发写同目标撞名）。 */
let tmpSeq = 0;

/** 随机段生成参数：base36 编码去掉「0.x」前缀后取 6 字符。 */
const RAND_RADIX = 36;
const RAND_SLICE_START = 2;
const RAND_SLICE_END = 8;

/**
 * 目标文件的原子写 tmp 路径（统一约定：`<最终路径>.tmp.<pid>.<seq>-<rand>`）。
 *
 * 独立导出供调用方预告 tmp 名（如崩溃恢复扫描按约定反查）与测试锚定命名形态；
 * 两个 write 原语内部各自调用（每次写独立 tmp，并发写同目标互不串写）。
 */
export function atomicTmpPathFor(filePath: string): string {
  tmpSeq += 1;
  const rand = Math.random().toString(RAND_RADIX).slice(RAND_SLICE_START, RAND_SLICE_END);
  return `${filePath}${TMP_MARKER}${process.pid}.${tmpSeq}-${rand}`;
}

/** 约定 tmp 路径的解析视图。 */
export interface AtomicTmpRef {
  /** tmp 文件自身完整路径。 */
  tmpPath: string;
  /** 该 tmp 写入的目标路径（约定前缀还原）。 */
  targetPath: string;
  /** 创建该 tmp 的进程 pid（扫描方可据此实现存活过滤等策略）。 */
  pid: number;
}

/**
 * 解析约定 tmp 路径为目标视图；非约定形态返回 null。
 *
 * 注意贪婪匹配方向：目标名自身含 `.tmp.` 时（如 `foo.tmp.json.tmp.1-x`）
 * 前缀段正确还原为 `foo.tmp.json`。反之，恰以 `.tmp.<数字>.<uniq>` 结尾的
 * 用户文件会被误认——清理入口只应在受管目录（runtime 数据目录）内使用。
 */
export function parseAtomicTmpPath(tmpPath: string): AtomicTmpRef | null {
  const match = TMP_NAME_PATTERN.exec(tmpPath);
  if (match === null) return null;
  return { tmpPath, targetPath: match[1], pid: Number(match[2]) };
}

// ── 写入原语 ─────────────────────────────────────────────────

export interface AtomicWriteOptions {
  /** 字符串内容的编码（默认 "utf8"；Uint8Array 内容忽略此项）。 */
  encoding?: BufferEncoding;
  /** 目标父目录缺失时递归创建（默认 true，对齐四处同步写点的 mkdir 纪律）。 */
  ensureDir?: boolean;
}

export interface AtomicWriteFileOptions extends AtomicWriteOptions {
  /**
   * rename 成功后尽力 fsync 目标目录（默认 true）。POSIX 不要求；失败不否定
   * 已成功的 rename（对齐 manifest-store/sessions-index 的 best-effort 目录
   * fsync）。设 false 跳过（省两次目录句柄开销，弱耐久场景）。
   */
  fsyncDir?: boolean;
}

const DEFAULT_ENCODING: BufferEncoding = "utf8";

/** 失败路径清理自身 tmp：尽力 unlink，失败仅 debug（不掩盖原错误）。 */
function removeTmpBestEffortSync(tmpPath: string): void {
  try {
    unlinkSync(tmpPath);
  } catch (cleanupErr) {
    // tmp 可能已被 rename 消费或从未创建；原错误由调用方上抛
    logger.debug("[subagent-core] atomic-write cleanup tmp failed", {
      detail: toErrorMessage(cleanupErr),
      tmpPath,
    });
  }
}

/**
 * 同步原子写（writeFileSync + renameSync，无 fsync）。
 *
 * 读者要么看到旧版完整内容、要么看到新版完整内容，绝无半成品（rename 原子性）。
 * 失败语义见模块头。适用 prep/注册表类高频小文件；需掉电耐久用 writeAtomicFile。
 */
export function writeAtomicFileSync(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  if (options.ensureDir !== false) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const tmpPath = atomicTmpPathFor(filePath);
  try {
    writeFileSync(tmpPath, content, encoding);
    renameSync(tmpPath, filePath);
  } catch (err) {
    // rename 未成功 → 清理残留 tmp（尽力，不掩盖原错误）
    removeTmpBestEffortSync(tmpPath);
    throw err;
  }
}

/**
 * 异步原子写（fsync 文件 → rename → 尽力 fsync 目录）。
 *
 * manifest-store.writeManifest / sessions-index.saveIndex 生产耐久模式的统一
 * 实现。失败语义见模块头。真异步（fs.promises，不阻塞 event loop）。
 */
export async function writeAtomicFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  const fsyncDir = options.fsyncDir ?? true;
  if (options.ensureDir !== false) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const tmpPath = atomicTmpPathFor(filePath);
  const dirPath = path.dirname(filePath);

  let renamed = false;
  try {
    // 1. 写 tmp → fsync 文件
    const fh = await fsPromises.open(tmpPath, "w");
    try {
      await fh.writeFile(content, encoding);
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 2. rename tmp → final（放在 try 内：失败时 catch 清理 tmp）
    await fsPromises.rename(tmpPath, filePath);
    renamed = true;

    // 3. fsync 目录（尽力：POSIX 不要求，失败不否定已成功的 rename）
    if (fsyncDir) {
      try {
        const dirFh = await fsPromises.open(dirPath, "r");
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch (dirSyncErr) {
        logger.debug("[subagent-core] atomic-write fsync dir failed", {
          detail: toErrorMessage(dirSyncErr),
          dirPath,
        });
      }
    }
  } catch (err) {
    // rename 未成功 → 清理残留 tmp（尽力，不掩盖原错误）
    if (!renamed) {
      try {
        await fsPromises.unlink(tmpPath);
      } catch (cleanupErr) {
        logger.debug("[subagent-core] atomic-write cleanup tmp failed", {
          detail: toErrorMessage(cleanupErr),
          tmpPath,
        });
      }
    }
    throw err;
  }
}

// ── 崩溃残留扫描 / 清理（S6 统一恢复语义的单点）──────────────

/**
 * 扫描目录内全部约定形态的 tmp 文件（不做删除）。
 *
 * 供两类消费方：
 * - cleanupStaleTmpFiles 的内部步骤；
 * - 需要按域校验内容再决定「删 or 提升为正式文件」的宿主恢复逻辑（基于
 *   listStaleTmpFiles + parseAtomicTmpPath().targetPath 组合实现；曾有的
 *   manifest promote 消费方已随 U4c 缓存降级退役为 sweepTmpFiles 纯删除）。
 *
 * 目录不存在 → 返回空数组（恢复扫描对未初始化布局宽容）。非约定形态文件
 * 一律不认（用户数据零误伤边界见 parseAtomicTmpPath 注释）。
 */
export function listStaleTmpFiles(dir: string): AtomicTmpRef[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (readdirErr) {
    if (typeof (readdirErr as NodeJS.ErrnoException).code === "string" &&
        (readdirErr as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw readdirErr;
  }
  const refs: AtomicTmpRef[] = [];
  for (const name of names) {
    // 以 join 后完整路径解析：targetPath 需带目录前缀（恢复提升 rename 用）
    const ref = parseAtomicTmpPath(path.join(dir, name));
    if (ref !== null) {
      refs.push(ref);
    }
  }
  return refs;
}

export interface CleanupStaleTmpOptions {
  /**
   * 只清理 mtime 早于 now - maxAgeMs 的残留（进程内在途写入的兜底保护窗口）。
   * 缺省 = 全清（启动期恢复场景，目录归本进程管）。需按 pid 存活过滤的调用方
   * 改用 listStaleTmpFiles 自行实现策略（ref.pid 可判活）。
   */
  maxAgeMs?: number;
  /** maxAgeMs 的基准时刻（缺省 Date.now()；测试注入确定性时钟）。 */
  now?: number;
}

export interface CleanupStaleTmpResult {
  /** 已删除（含扫描与删除之间已消失的——幂等终态）。 */
  removed: string[];
  /** 因 maxAgeMs 窗口内被保留的（疑似他方在途写入）。 */
  kept: string[];
  /** unlink 失败的（尽力语义，错误已 debug 记录）。 */
  failed: string[];
}

/**
 * 清理目录内约定形态的 tmp 残留（单条失败不阻断其余条目，逐条结果回传）。
 *
 * 恢复语义（删除级恢复；曾对齐的 manifest-store promote 分支已随 U4c 退役）：本函数只做
 * 「删除」级恢复；「校验后提升为正式文件」需域知识（manifest 记录合法性），
 * 由调用方基于 listStaleTmpFiles + parseAtomicTmpPath().targetPath 自行实现。
 */
export function cleanupStaleTmpFiles(
  dir: string,
  options: CleanupStaleTmpOptions = {},
): CleanupStaleTmpResult {
  const now = options.now ?? Date.now();
  const result: CleanupStaleTmpResult = { removed: [], kept: [], failed: [] };
  for (const ref of listStaleTmpFiles(dir)) {
    if (options.maxAgeMs !== undefined) {
      try {
        const mtimeMs = statSync(ref.tmpPath).mtimeMs;
        if (now - mtimeMs < options.maxAgeMs) {
          result.kept.push(ref.tmpPath);
          continue;
        }
      } catch (statErr) {
        if (typeof (statErr as NodeJS.ErrnoException).code === "string" &&
            (statErr as NodeJS.ErrnoException).code === "ENOENT") {
          // 扫描与 stat 之间已消失（他方收尾）——按已删除的幂等终态记账
          result.removed.push(ref.tmpPath);
          continue;
        }
        logger.debug("[subagent-core] cleanupStaleTmpFiles stat failed", {
          detail: toErrorMessage(statErr),
          tmpPath: ref.tmpPath,
        });
        result.failed.push(ref.tmpPath);
        continue;
      }
    }
    try {
      unlinkSync(ref.tmpPath);
      result.removed.push(ref.tmpPath);
    } catch (unlinkErr) {
      if (typeof (unlinkErr as NodeJS.ErrnoException).code === "string" &&
          (unlinkErr as NodeJS.ErrnoException).code === "ENOENT") {
        result.removed.push(ref.tmpPath);
      } else {
        logger.debug("[subagent-core] cleanupStaleTmpFiles unlink failed", {
          detail: toErrorMessage(unlinkErr),
          tmpPath: ref.tmpPath,
        });
        result.failed.push(ref.tmpPath);
      }
    }
  }
  return result;
}
