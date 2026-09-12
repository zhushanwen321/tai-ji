// src/execution/sessions-index.ts
//
// [perf L-1] sessions-index.json —— identity 探测结果的磁盘种子。
//
// 背景：RecordStore 冷启动首扫需逐个探测 sessions/*.jsonl 的 identity（头部 64KB →
// 尾部 64KB → 全文 fallback）。session 数量大时该探测是冷扫描的主要成本。本模块把
// 「本目录的探测结论」（per-file identity 或负标记）持久化到 sessionsDir 的兄弟位置
// （<enc> 段内），下次进程/实例首扫直接用索引条目构造缓存条目（零内容读取）。
//
// 语义：
//   - 读侧（loadIndex）永不抛：文件缺失/JSON 损坏/结构不符/版本低 → 空索引（= 今天的
//     全量行为，下轮 dirty 重写自愈）；版本高于自身 → 空索引 + higherVersion 标志
//     （整体忽略不消费，RecordStore 据此抑制本轮及后续落盘，防 v1/v2 last-writer-wins
//     覆盖振荡）。
//   - 写侧（saveIndex）：tmp(pid+seq)+fsync+rename+目录 fsync 原子写（逐环复刻
//     ManifestStore.writeManifest 的生产模式）。失败本身向上抛；fire-and-forget 的
//     .catch 兜底在 RecordStore 侧。
//   - 损坏/降级走 logger.debug（PI_EXT_DEBUG=1 可见，默认 no-op），不 console.error
//     ——索引是纯性能缓存，降级自愈不应告警。
//
// 无状态纯函数模块：不依赖 RecordStore 任何内部状态。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";
import { writeAtomicFile } from "../shared/atomic-write.ts";

import type { ExecutionMode, RecordOrigin } from "./types.ts";

const logger = getLogger("subagents");

// ============================================================
// 常量（测试锚点 SSOT：RecordStore 与测试从同一来源引用，禁止内联字面量）
// ============================================================

/** 索引文件名（落 sessionsDir 兄弟位置——写索引不改 sessionsDir 目录 mtime，不击穿 L0 快路径）。 */
export const INDEX_FILENAME = "sessions-index.json";

/** 索引格式版本。schema 变更必须递增：低版本文件整体丢弃（空索引，下轮 dirty 重写自愈）；高版本整体忽略（higherVersion，不重写）。 */
export const INDEX_VERSION = 1;

/** 两次成功落盘的最小墙钟间隔（节流：overlay 打开期间的高频扫描不放大磁盘写）。 */
export const INDEX_WRITE_MIN_INTERVAL_MS = 60_000;

// ============================================================
// 类型（DM1 磁盘顶层 + DM2 条目）
// ============================================================

/**
 * 正索引条目：「该文件有 identity」的身份字段 + stat 戳。
 *
 * 不含 sessionFile（加载侧由 sessionsDir + basename 重构，绝对路径因 agentDir 迁移
 * 整体失效）；不含 forkDepth/chatMode（投影源 SubagentRecord 无此二字段，buildRecord
 * 构造 light 时不读——存了也无消费方；未来需要时升 INDEX_VERSION）。
 */
export interface SessionsIndexEntry {
  /** tagged union 判别（负条目为 true）。显式声明 false 供 TS narrowing（与 record-store.ts FileCacheEntry 同款）。 */
  negative?: false;
  /** jsonl stat 戳（mtime+size）——不匹配 = 内容变化，调用方回退重探测。 */
  mtimeMs: number;
  size: number;
  id: string;
  agent: string;
  /** 执行模式。运行时校验宽容历史 "sync" 值（白名单 sync|background，镜像 isIdentityData）；类型层由 ExecutionMode 收窄。 */
  mode: ExecutionMode;
  task: string;
  slug: string;
  startedAt: number;
  /** undefined 表示缺失（旧文件/顶层）。JSON 序列化时被丢弃，往返保持 undefined。 */
  rootSessionId: string | undefined;
  parentRecordId: string | undefined;
  depth: number;
  /** 空串合法：尾部探测（readIdentityTail）拿不到 model 时的合法结果，不当损坏。 */
  model: string;
  thinkingLevel: string | undefined;
  /**
   * 来源身份（H2 S3 修复：light→索引→重建往返闭合）。undefined 表示缺失
   * （旧索引文件/origin 缺省 = "tool" 语义），可选字段不升 INDEX_VERSION——
   * 对齐 rootSessionId/parentRecordId 先例（宽容守卫 + 序列化自然缺省）。
   */
  origin?: RecordOrigin;
  /** origin="workflow" 时所属 workflow run id（undefined = 缺失/tool 来源）。 */
  parentRunId?: string;
}

/**
 * 负索引条目：「该文件确认无 identity」（junk/异构文件）。与内存负缓存
 * NegativeFileEntry 语义对齐——把「没有」这一事实持久化，跨实例零重探测。
 */
export interface SessionsIndexNegativeEntry {
  negative: true;
  mtimeMs: number;
  size: number;
}

/** 磁盘 JSON 顶层结构（key = jsonl basename 不含路径）。 */
export interface SessionsIndexFile {
  version: 1;
  pid: number;
  entries: Record<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
}

/** saveIndex 输入（内存形态）。 */
export interface SessionsIndexData {
  entries: Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
}

/** loadIndex 输出。恒返回该形态对象（不抛、不返回 null）。 */
export interface LoadedSessionsIndex {
  entries: Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
  /** true = 磁盘版本高于自身：条目整体不消费，且本进程及后续不得写盘（防 v1/v2 互相覆盖振荡）。 */
  higherVersion: boolean;
}

// ============================================================
// 条目级校验（ES3：单条目损坏仅丢弃该条目，不放大为整体失效）
// ============================================================

// 以下字段组谓词按原 isPositiveIndexEntry 的检查顺序切分（stamp/identity → 会话描述
// → 可选 string → depth/model/thinkingLevel），组内与组间短路求值顺序不变。

/** 执行模式白名单：宽容历史 "sync" 值（ExecutionMode 现值仅 "background"，"sync" 是旧数据合法值，放行不丢弃）。 */
function isKnownIndexMode(mode: unknown): boolean {
  return mode === "sync" || mode === "background";
}

/** 戳 + 身份字段组（mtimeMs/size/id/agent/mode）。 */
function hasStampAndIdentityFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.mtimeMs === "number" &&
    typeof v.size === "number" &&
    typeof v.id === "string" &&
    typeof v.agent === "string" &&
    isKnownIndexMode(v.mode)
  );
}

/** 会话描述字段组（task/slug/startedAt）。 */
function hasSessionDescFields(v: Record<string, unknown>): boolean {
  return typeof v.task === "string" && typeof v.slug === "string" && typeof v.startedAt === "number";
}

/** 可选 string 字段组（rootSessionId/parentRecordId/parentRunId：undefined 表示缺失，合法）。 */
function hasOptionalStringFields(v: Record<string, unknown>): boolean {
  return (
    (v.rootSessionId === undefined || typeof v.rootSessionId === "string") &&
    (v.parentRecordId === undefined || typeof v.parentRecordId === "string") &&
    (v.parentRunId === undefined || typeof v.parentRunId === "string")
  );
}

/** 来源域字段组（origin 守卫宽容：undefined 缺省合法，字面量白名单对齐 readEntryOriginFields）。 */
function hasOriginFields(v: Record<string, unknown>): boolean {
  return (
    v.origin === undefined || v.origin === "workflow" || v.origin === "tool"
  );
}

/** 深度/模型/思考档字段组（model 空串合法——尾部探测拿不到 model 的合法结果，DS4）。 */
function hasModelFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.depth === "number" &&
    typeof v.model === "string" && // 空串合法（DS4）
    (v.thinkingLevel === undefined || typeof v.thinkingLevel === "string")
  );
}

/** 正条目类型谓词：镜像 isIdentityData（session-reconstructor.ts:244-253）的字段检查 + 索引特有戳/形态字段。 */
function isPositiveIndexEntry(raw: unknown): raw is SessionsIndexEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return (
    hasStampAndIdentityFields(v) &&
    hasSessionDescFields(v) &&
    hasOptionalStringFields(v) &&
    hasOriginFields(v) &&
    hasModelFields(v)
  );
}

/** 负条目类型谓词（tagged union 形态检查）。 */
function isNegativeIndexEntry(raw: unknown): raw is SessionsIndexNegativeEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return v.negative === true && typeof v.mtimeMs === "number" && typeof v.size === "number";
}

/**
 * 校验单条索引条目。返回 undefined = 条目损坏，调用方仅丢弃该条目
 * （该文件本轮回退探测，其余条目正常保留/命中）。
 */
export function validateIndexEntry(
  raw: unknown,
): SessionsIndexEntry | SessionsIndexNegativeEntry | undefined {
  if (!isPositiveIndexEntry(raw) && !isNegativeIndexEntry(raw)) return undefined;
  return raw;
}

// ============================================================
// 读侧（IF1：永不抛）
// ============================================================

/** 磁盘顶层已通过形态校验后的窄化视图（version 数值 + entries 对象）。
 *  type alias（非 interface）——赋给 Record<string, unknown> 依赖隐式索引签名。 */
type ValidIndexTop = {
  version: number;
  entries: Record<string, unknown>;
};

/** unknown → Node fs 错误码（非 Error 或无 code → undefined）。 */
function errorCodeOf(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** 读索引文件文本。读失败 → null：ENOENT = 正常首跑保持静默；其余读失败（EACCES 等
 * 长期权限异常）留 debug 线索——空索引回退本身可自愈，但权限类异常不会自己消失，需可诊断。 */
function readIndexFile(indexPath: string, encDir: string): string | null {
  try {
    return fs.readFileSync(indexPath, "utf-8");
  } catch (err) {
    const code = errorCodeOf(err);
    if (code !== "ENOENT") {
      logger.debug("[subagents] sessions-index read failed, fallback to empty", {
        detail: { dir: encDir, code },
      });
    }
    return null;
  }
}

/** JSON.parse 索引内容。损坏（截断/外部编辑）→ null，走 debug：可降级自愈场景，不 console.error。 */
function parseIndexJson(raw: string, indexPath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.debug("[subagents] sessions-index corrupted JSON, fallback to empty", {
      detail: { path: indexPath, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

/** DM1 头部字段形态守卫（version 数值 + entries 非空 object 非数组）。 */
function isIndexTopHeader(v: Record<string, unknown>): v is ValidIndexTop {
  return (
    typeof v.version === "number" &&
    typeof v.entries === "object" &&
    v.entries !== null &&
    !Array.isArray(v.entries)
  );
}

/** 顶层结构校验（DM1）。不符 → null（两条 debug 文案与判定条件一一对应）。 */
function readTopLevel(parsed: unknown, indexPath: string): ValidIndexTop | null {
  if (typeof parsed !== "object" || parsed === null) {
    logger.debug("[subagents] sessions-index invalid top-level shape, fallback to empty", {
      detail: { path: indexPath },
    });
    return null;
  }
  const top = parsed as Record<string, unknown>;
  if (!isIndexTopHeader(top)) {
    logger.debug("[subagents] sessions-index invalid header fields, fallback to empty", {
      detail: { path: indexPath },
    });
    return null;
  }
  return top;
}

/** 逐条校验收集：坏条目仅丢弃该条目，其余保留（ES3 条目级降级）。 */
function collectValidEntries(
  entriesObj: Record<string, unknown>,
): Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry> {
  const entries = new Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>();
  for (const [key, value] of Object.entries(entriesObj)) {
    const entry = validateIndexEntry(value);
    if (entry !== undefined) entries.set(key, entry);
  }
  return entries;
}

/**
 * 读取指定目录（<enc> 段）的 sessions-index.json。永不抛：
 *   - 文件不存在/读失败/JSON.parse 失败/顶层结构不符/版本低于自身
 *     → { entries: 空 Map, higherVersion: false }（空索引 = 今天的全量行为）
 *   - 版本高于自身 → { entries: 空 Map, higherVersion: true }
 *     （整体忽略——即使 entries 合法也不消费，防陈旧 schema 灌入；RecordStore 据此抑制落盘）
 *   - 版本匹配 → 逐条 validateIndexEntry（坏条目丢弃，其余保留）
 *
 * 只读精确路径 INDEX_FILENAME：.tmp. 残留文件不匹配文件名，天然被忽略。
 */
export function loadIndex(encDir: string): LoadedSessionsIndex {
  const empty: LoadedSessionsIndex = { entries: new Map(), higherVersion: false };
  const indexPath = path.join(encDir, INDEX_FILENAME);

  const raw = readIndexFile(indexPath, encDir);
  if (raw === null) return empty;

  const parsed = parseIndexJson(raw, indexPath);
  if (parsed === null) return empty;

  const top = readTopLevel(parsed, indexPath);
  if (top === null) return empty;

  if (top.version > INDEX_VERSION) {
    // 高版本：整体忽略（entries 即使合法也不消费）；调用方据 higherVersion 抑制写盘
    return { entries: new Map(), higherVersion: true };
  }
  if (top.version < INDEX_VERSION) {
    // 低版本：整体丢弃 → 空索引；本轮全扫 dirty 后重写自愈
    logger.debug("[subagents] sessions-index stale version, discarded", {
      detail: { path: indexPath, version: top.version, expected: INDEX_VERSION },
    });
    return empty;
  }

  return { entries: collectValidEntries(top.entries), higherVersion: false };
}

// ============================================================
// 写侧（IF2：原子写；失败向上抛——fire-and-forget 的 .catch 兜底在调用方）
// ============================================================

/**
 * 原子写索引（shared/atomic-write 统一原语，U6b 迁移：tmp → fsync → rename →
 * fsync 目录）。原逐行实现（逐环复刻 ManifestStore.writeManifest 的生产模式）
 * 与 writeAtomicFile 逐环等值；tmp 带 pid+单调序号双后缀防撞的语义由原语的
 * atomicTmpPathFor 接管（pid 防两进程共用同一 tmp，seq+rand 防同进程并发
 * saveIndex 共用同一 tmp）。rename 原子性保证读侧看到旧版或完整新版，绝无半成品。
 * ensureDir:false——旧实现无 mkdir（目录由 sessionsDir 布局保证），缺目录维持
 * fail-fast 上抛（调用方 .catch 兜底），不静默重建。
 *
 * 失败向上抛——RecordStore 的 flushIndexAfterScan 以 fire-and-forget .catch 消费
 *（写失败不影响任何扫描结果，恢复 dirty 待下轮过窗重试）。
 */
export async function saveIndex(encDir: string, data: SessionsIndexData): Promise<void> {
  const filePath = path.join(encDir, INDEX_FILENAME);
  const file: SessionsIndexFile = {
    version: INDEX_VERSION,
    pid: process.pid,
    entries: Object.fromEntries(data.entries),
  };
  await writeAtomicFile(filePath, JSON.stringify(file), { ensureDir: false });
}
