import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getLogger } from "../../core/logger.ts";

import { bestEffort } from "../assembly/best-effort.ts";
import { writeAtomicFile, writeAtomicFileSync } from "../../shared/atomic-write.ts";
import { isMissingFsError } from "./fs-error.ts";
import type { ClosedReason, ExecutionStatus } from "../assembly/types.ts";
// 类型面依赖（D5 终局投影词表单源）——纯 type import，无运行时循环
//（run-events 只依赖 core/logger 与 orchestration/models，不回指 execution 层）。
import type { RunErrorCode, RunOutcome } from "../../orchestration/run-events.ts";
import { ALL_RUN_OUTCOMES } from "../../orchestration/run-events.ts";

const logger = getLogger("subagents");

export interface ManifestRecord {
  id: string;
  rootSessionId: string;
  /** 直接父 subagent record ID（层级树构建用）。顶层 record 缺失（undefined）。M3a 补字段。 */
  parentRecordId?: string;
  agentName: string;
  /**
   * 终态枚举：finalizeRecord 写 running/closed/cancelled 三态。
   * SP-1 重构：旧 completed/failed 合并为 closed（L1 统一终态）。
   * cancelled 保持独立（用户取消语义）。crashed 不进 manifest——
   * crashed 曾是重启重建时的派生态，随永久会话模型 §3.2.4 重建单规则退役
   *（磁盘重建恒 idle，无派生终态）。
   * 历史 "error"/"completed"/"failed" 值由读侧 mapManifestStatus 向后兼容映射。
   */
  status: "running" | "closed" | "cancelled";
  /**
   * [U4c / D5 词汇双写过渡] 内部权威状态词汇（ExecutionStatus 二态）。
   * 与上方旧 status 三态投影**永久双写**——无版本磁盘 schema 不做破坏性变更；
   * session-reader（独立 npm 包独立进程）直读旧 status 做 identity 富字段投影
   * 与孤儿判定，删字段 = 外部消费方富字段降级。旧 status 只降权威地位不删字段。
   * 宿主内消费方不读本字段（终态判定走 `.state` 权威，D1）；本字段是词汇收口
   * （全景① ExecutionStatus+ClosedReason）在 manifest 写面的过渡锚。
   */
  executionStatus?: ExecutionStatus;
  /**
   * [U8 / B-restart manifest 契约面] 实际执行引擎 id（引擎域下行）。zcode record
   * 无子 session 文件（磁盘扫描缺员），manifest 是其重启可见性的兜底承载——
   * 缺 engine 域则 manifest 源投影丢引擎身份，U8b 与重启恢复无法路由读链。
   * 缺省 = pi。旧版 session-reader 未知字段跳过，无破坏。
   */
  engine?: string;
  /**
   * [U8 / B-restart] 引擎自描述定位符（与 SubagentRecord.engineHandle 同形）：
   * sessionRef 整体透传不枚举内部键（zcode = { sessionId, dbPath }）、journalPath
   * 绝对路径、poolKey 隔离池定位。zcode record 重启续聊的锚恢复数据源之一
   * （entry engineHandle.sessionRef 为主，本字段为 manifest 孤儿兜底）。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
  /**
   * [M2 Gate B] closed 终态的 L2 关闭原因（status="closed" 时有意义）。旧 manifest 无
   * 此字段（undefined = 死因不可考，读侧守卫归一 undefined）。缺失时 manifest 源重建
   * 的快照丢 closedReason，endedMessageGuard 把 user-close/cancelled 误分流进
   * 「reconnectable/fork-from」分支——本字段是 manifest 源快照三分流的唯一依据
   * （磁盘 sidecar 源由 .state reason 承载，不经本字段）。
   */
  closedReason?: ClosedReason;
  /**
   * [W4 收敛] v2 收编 record 的被动终局停因（record-settled 帧 stopReason 同名同值
   * ——interrupted-by-restart 族）。仅收编投影写入（buildAdoptedManifestProjection），
   * 轮终/终态原语投影不写——本字段是 sweep 判据第三级（findAdoptedStopReasonSync）
   * 区分「收编终局」与「轮终 idle」的唯一依据：v2 收编产物不在 findLightById 读取面，
   * 判据缺席时收编 record 落 missing 分支被误注销为 expired（注销词统一手术的修复点）。
   * 不并入 closedReason：那是 close/cancel 意愿动作词族，被动收编停因不进该词表。
   */
  stopReason?: string;
  createdAt: number;
  completedAt?: number;
  sessionFile?: string;
  /** FR-7 补字段：manifest 写入时从 ExecutionRecord 抓取，供 manifestToSubagent 投影真实值。 */
  task?: string;
  slug?: string;
  model?: string;
  /**
   * [P1b-2 / D5 终局投影] run 终局形态（completed/failed/cancelled）。record 域的
   * 投影能力面：record 终态写入链（markFinalized 族）接线归后继批次（Q2/P3 领地），
   * 本批只交付字段与读侧兼容。undefined = 未投影/旧 manifest（isValidManifest 不查
   * 可选字段，读侧守卫归一，不炸）。
   */
  outcome?: RunOutcome;
  /** [P1b-2 / D5 终局投影] 失败终局的结构化编码（见 outcome 注释的接线归属）。 */
  errorCode?: RunErrorCode;
}

/** JSON.stringify 缩进空格数（no-magic-numbers 合规）。 */
const MANIFEST_INDENT_SPACES = 2;

/** [perf] 缓存校验戳（与 record-store.ts Stamp 同构；manifest 是小文件，mtime+size 足够）。 */
interface Stamp {
  mtimeMs: number;
  size: number;
}

function statStamp(p: string): Stamp | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** 合法 manifest status 集合（3 态；运行时守卫用，磁盘文件可能陈旧/损坏）。
 * SP-1：completed/failed 合并为 closed。读侧 mapManifestStatus 向后兼容旧值。
 * crashed 不在其中。 */
const VALID_MANIFEST_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "closed",
  "cancelled",
  "completed", // 向后兼容旧 manifest 数据
  "failed",     // 向后兼容旧 manifest 数据
]);

/**
 * 校验 JSON.parse 产物是否为合法 ManifestRecord。
 * 关键字段类型检查——不合法返回 false，调用方据此过滤（防损坏/陈旧文件污染投影）。
 */
function isValidManifest(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.rootSessionId === "string" &&
    typeof v.agentName === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.status === "string" &&
    VALID_MANIFEST_STATUSES.has(v.status)
  );
}

export class ManifestStore {
  private readonly dir: string;

  /** [perf] per-file 缓存：file → { stamp, record }。record=null 表示「已解析但非法」（缓存
   *  负结果避免反复 parse 损坏文件）。stat 戳变化（writeManifest tmp→rename 后 mtime/size 变）
   *  自动失效；删除的文件在下次扫描时修剪。 */
  private readonly cache = new Map<string, { stamp: Stamp; record: ManifestRecord | null }>();

  constructor(dir: string) {
    this.dir = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 原子写：tmp → fsync → rename → fsync dir（shared/atomic-write 统一原语，
   * U6b 迁移——原逐行实现与 writeAtomicFile 逐环等值）。真异步（fs.promises，
   * 不阻塞 event loop）。
   *
   * 失败时原语尽力清理残留 tmp（debug 记录，不掩盖原错误）并原样上抛——
   * 调用方（RecordStore 写面：writeManifestPersisted 缺省异步分支 / 批写 barrier /
   * rebuildIndexes 重建降级（debug 留痕）/ rematerializeManifest（warn 语义））
   * 决定降级策略——各面降级策略分化见各调用点。
   */
  async writeManifest(record: ManifestRecord): Promise<void> {
    const filePath = path.join(this.dir, `${record.id}.json`);
    const content = JSON.stringify(record, null, MANIFEST_INDENT_SPACES);
    // ensureDir:false：目录由构造函数负责创建（缺目录 = 外部删除的异常态，
    // 维持旧实现的 fail-fast 上抛语义，不静默重建）
    await writeAtomicFile(filePath, content, { ensureDir: false });
  }

  /**
   * 按 id 读 manifest。文件不存在/JSON 损坏/schema 不合法均返回 null。
   * 调用方需处理 null。
   */
  async readManifest(id: string): Promise<ManifestRecord | null> {
    const filePath = path.join(this.dir, `${id}.json`);
    let content: string;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
    } catch (err) {
      // 分通道（对齐 listAllSync 的 isMissingFsError 纪律）：ENOENT = 文件缺失
      //（合法缺省，静默降级 null）；其余读错误 warn 留证后同样降级 null——IO
      // 故障不得伪装成 not-found。
      if (!isMissingFsError(err)) {
        bestEffort(err, `read manifest ${filePath} (readManifest)`, "error");
      }
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      return isValidManifest(parsed) ? parsed : null;
    } catch {
      // JSON 损坏（SyntaxError）降级为 null
      return null;
    }
  }

  /**
   * 同步读取所有 manifest 记录（best-effort，损坏/非法文件跳过）。
   * 供 RecordStore.collectRecords 投影 orphan 记录使用——替代对私有 dir 的反射访问。
   * 仅返回通过 isValidManifest 校验的记录。
   *
   * [perf] per-file 缓存 + stat 戳校验：collectRecords 每次渲染都调本方法，旧实现每次
   * 全量 readFileSync + JSON.parse 千级 manifest（实测 ~300ms/次）。命中缓存的文件零读取。
   */
  listAllSync(): readonly ManifestRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch (err) {
      // 目录不存在（ENOENT）= 无 manifest 可列（外部删除/首启窗口的合法缺省，静默
      // 空表）；其余读失败（EACCES/EIO 等）best-effort 留痕——静默空表会把 IO 故障
      // 伪装成 not-found，冷查链（collectRecords orphan 投影）消费方无从分辨。
      if (!isMissingFsError(err)) {
        bestEffort(err, `list manifests (readdir ${this.dir})`, "error");
      }
      return [];
    }
    const names = files.filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
    const disk = new Set(names);

    // 修剪已删除文件
    for (const f of this.cache.keys()) {
      if (!disk.has(f)) this.cache.delete(f);
    }

    const results: ManifestRecord[] = [];
    for (const file of names) {
      const filePath = path.join(this.dir, file);
      const stamp = statStamp(filePath);
      if (!stamp) {
        this.cache.delete(file);
        continue;
      }
      const cached = this.cache.get(file);
      if (cached && cached.stamp.mtimeMs === stamp.mtimeMs && cached.stamp.size === stamp.size) {
        if (cached.record) results.push(cached.record);
        continue;
      }
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        const record = isValidManifest(parsed) ? parsed : null;
        this.cache.set(file, { stamp, record });
        if (record) results.push(record);
      } catch (fileErr) {
        // best-effort：损坏/非法文件跳过（debug 记录便于排查）。缓存负结果防反复 parse。
        this.cache.set(file, { stamp, record: null });
        bestEffort(fileErr, `read manifest ${file} (listAllSync)`);
      }
    }
    return results;
  }

  /**
   * 启动时清扫 tmp 残留（[U4c / D6] tmp 恢复退役后的语义——[H4/U5 收口] 更名
   * recoverTmpFiles → sweepTmpFiles，名实对齐「静默删除」）。
   *
   * 旧语义（ADR-035 三分支：manifest 已存在删 tmp / tmp 合法且 manifest 缺失
   * promote / tmp 非法删）已随缓存降级退役——manifest 现为可丢可重建缓存
   * （权威 = `.state`，重建 = RecordStore.rebuildIndexes，D5），promote 半写 tmp
   * 只会把陈旧快照复活成「看似权威」的索引，语义失效；统一**静默删除**全部
   * tmp（含 0 字节/半写形态——D8 停机窗残留由本清扫顺带清理）。
   *
   * [T5④ / PS-13] per-file 容错保留：单个 tmp 删除失败（ENOENT——并发回收/外部
   * 清理抢先、EACCES 等）只 warn + 跳过该文件，不再中断整轮。promote 退役后
   * 无恢复形态，返回值简化为删除计数。
   *
   * @returns 删除的 tmp 文件数。
   */
  async sweepTmpFiles(): Promise<number> {
    let deleted = 0;
    let failed = 0;

    const files = fs.readdirSync(this.dir);
    const tmpFiles = files.filter((f) => f.includes(".json.tmp."));

    for (const tmpFile of tmpFiles) {
      const tmpPath = path.join(this.dir, tmpFile);
      try {
        fs.unlinkSync(tmpPath);
        deleted++;
      } catch (fileErr) {
        // [T5④/PS-13] 单文件失败不中断整轮：warn 留痕（含文件名与原因）后继续处理
        // 剩余 tmp。常见于 tmp 已被并发回收/外部清理删除（ENOENT）——自愈场景不再放大。
        failed++;
        logger.warn(`[subagents] sweepTmpFiles: failed to remove ${tmpFile}, skipping (leftovers retry on next startup)`, {
          detail: fileErr instanceof Error ? fileErr.message : String(fileErr),
        });
      }
    }

    if (failed > 0) {
      logger.warn(
        `[subagents] sweepTmpFiles: ${failed} of ${tmpFiles.length} tmp file(s) could not be removed`,
      );
    }

    return deleted;
  }
}

// ============================================================
// [W1 / U2a] record 域 manifest 落盘写面（容器 record-store.ts 的写通道实现体）
// ============================================================
//
// 写面语义三档集中（manifest 是物化投影不是事实源——D2）：
//   - 响亮（终态/持久通道 writeManifestRecordPersisted）：失败 error 日志 + 用户可见
//     entry——终态投影未落必须可见；
//   - 不响亮（缓存补缺通道 rematerializeManifestRecord / rebuildManifestRecordIfMissing）：
//     失败 warn/debug 留痕——缓存补缺失败不构成宿主错误；
//   - 守卫降级（bound 物化 materializeBoundRecordManifest，见下）：锚定未就绪跳过、
//     写失败日志跳过不阻塞。

/** manifest 写失败的双通道上报（error 日志给开发者 + entry 给用户，对齐
 *  writeManifestBestEffort 现状）。 */
export function reportManifestWriteFailure(
  id: string,
  err: unknown,
  appendEntry?: ((customType: string, data: unknown) => void) | null,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[subagents] manifest write failed (record=${id}): ${msg}`);
  appendEntry?.("subagent:manifest-write-failed", { id, error: msg });
}

/**
 * manifest 落盘统一通道：dir 提供时 writeAtomicFileSync 同步写（停机竞态构造性
 * 消灭；与 ManifestStore.writeManifest 字节形态一致——2 空格缩进 JSON，读侧/外部
 * session-reader 不感知差异）；缺省 fire-and-forget 异步写（仅纯内存测试形态）。
 * 写失败响亮（见 reportManifestWriteFailure）。
 */
export function writeManifestRecordPersisted(
  manifestStore: ManifestStore | undefined,
  dir: string | undefined,
  id: string,
  manifest: ManifestRecord,
  appendEntry?: ((customType: string, data: unknown) => void) | null,
): void {
  if (dir !== undefined) {
    try {
      writeAtomicFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES));
    } catch (err) {
      reportManifestWriteFailure(id, err, appendEntry);
    }
    return;
  }
  if (manifestStore !== undefined) {
    void manifestStore.writeManifest(manifest).catch((err: unknown) => {
      reportManifestWriteFailure(id, err, appendEntry);
    });
  }
}

/**
 * [H4 收口 / G1] entry 重物化腿的 manifest 投影补写（record-access 可重连终态
 * 重物化通道的唯一入口——store 外零 manifest 直写）。manifest 是可丢缓存（D5），
 * 本函数只做缺员补写：失败 warn 留痕不响亮（缓存补缺失败不构成宿主错误，对齐
 * 惰性补建通道的降级语义——区别于终态面 writeManifestRecordPersisted 的响亮）；
 * dir 接线时为同步写（停机窗防护与终态面同源）。
 */
export function rematerializeManifestRecord(
  manifestStore: ManifestStore | undefined,
  dir: string | undefined,
  manifest: ManifestRecord,
): void {
  const warnFailure = (err: unknown): void => {
    logger.warn("[subagents] rematerialize manifest write failed (cache backfill)", {
      detail: { id: manifest.id, error: err instanceof Error ? err.message : String(err) },
    });
  };
  if (dir !== undefined) {
    try {
      writeAtomicFileSync(path.join(dir, `${manifest.id}.json`), JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES));
    } catch (err) {
      warnFailure(err);
    }
    return;
  }
  if (manifestStore !== undefined) {
    void manifestStore.writeManifest(manifest).catch(warnFailure);
  }
}

/**
 * 单 record 的 manifest 惰性补建（boot 全量轮 + 查询面反查 miss 惰性通道共用）。
 * manifest 已存在 → 跳过；无落点（dir 与 store 均缺省，纯内存测试形态）→ 跳过；
 * 每 id 每进程至多尝试一次（tried 集合由调用方持有——boot 全量轮与惰性通道共享，
 * 防重复磁盘写）。写失败 debug 留痕不抛（缓存面，无需动作）。
 *
 * @param manifest 已构造好的派生投影（derivedManifestRecord 产物——构造归调用方，
 *        本函数不依赖投影轴）。
 * @returns true = 本次实际补写。
 */
export function rebuildManifestRecordIfMissing(
  dir: string | undefined,
  manifestStore: ManifestStore | undefined,
  id: string,
  manifest: ManifestRecord,
  tried: Set<string>,
): boolean {
  if (dir === undefined && manifestStore === undefined) return false;
  if (tried.has(id)) return false;
  tried.add(id);
  if (dir !== undefined) {
    try {
      if (fs.existsSync(path.join(dir, `${id}.json`))) return false;
      writeAtomicFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES));
      return true;
    } catch (err) {
      logger.debug("[subagents] rebuildIndexes: manifest rebuild skipped (write failed)", {
        detail: { id, error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }
  // 缺省降级形态（dir 缺省、store 在，纯内存测试形态外的测试分支）：
  // 异步写，失败同样静默降级。
  void manifestStore!.writeManifest(manifest).catch((err: unknown) => {
    logger.debug("[subagents] rebuildIndexes: manifest rebuild skipped (write failed)", {
      detail: { id, error: err instanceof Error ? err.message : String(err) },
    });
  });
  return true;
}

/**
 * 损坏 manifest 的双通道上报（status 越界 = 数据损坏）：logger.warn 给开发者
 * （事后排查，appendEntry 持久化，不显 TUI）；appendEntry 给用户（session 内可见，
 * 即使退出后也能从 session.jsonl 复盘事故原因）。调用方跳过该条而非降级 failed。
 */
export function reportInvalidManifestRecord(
  manifest: ManifestRecord,
  appendEntry?: ((customType: string, data: unknown) => void) | null,
): void {
  logger.warn("[subagents] skip manifest with invalid status", {
    detail: { id: manifest.id, status: manifest.status },
  });
  appendEntry?.("subagent:manifest-invalid-status", {
    id: manifest.id,
    status: manifest.status,
    rootSessionId: manifest.rootSessionId,
    agentName: manifest.agentName,
  });
}

// ============================================================
// [W1 / D2 决策 9] record-bound 物化写面（record 域）
// ============================================================

/**
 * record-bound 时物化一次 running manifest（spawn 回填点，引擎身份已知）。
 *
 * 为什么需要：运行中 zcode record 的 sa-id 读取锚定（session-reader 第一层
 * zcode manifest 定点直读需要 engine + sessionRef 双键）在 v1 时代完全依赖过程
 * entry 快照（轮终 reportRecordTransition 携带 engineHandle）——W1 停写过程
 * entry 后该窗口无锚。修复 = record-bound（spawn 回填）物化一次 status=running
 * 的 manifest，zcode 运行窗口锚定经既有第一层直读命中（零新增介质、「两条条目」
 * 口径保持——manifest 是物化投影不是条目）。
 *
 * 锚定就绪守卫（session-reader 孤儿判定的前提不变量「manifest 写点时
 * sessionFile 必已在盘」，discovery/subagents.ts 头注）：无守卫的 bound 物化会把
 * spawn 窗口（bound 早于子 session 首笔写入）内的 running record 被家族扫描误标
 * 已清理。守卫下的空窗 = spawn → 锚定就绪之间（秒级），该空窗内 v1 路径同样无
 * 可靠锚（行为对齐非回归）。两分支：
 *   - pi 分支（sessionFile 有值）：fs 探查文件存在性（零新依赖）——未就绪本轮
 *     跳过，由下一物化点（轮终/终态）自愈；
 *   - zcode 分支（无 sessionFile、engineHandle 在场）：**零探查**——bound 的产生
 *     点就是 spawn 回填，晚于引擎会话建立（sessionRef 双键来自引擎握手，
 *     getSessionRow 会话行级判读，非 dbPath 文件存在级——core 不新增 zcode 会话
 *     库依赖边）。
 *
 * 写失败降级（D2）：manifest 是投影不是事实源——写失败记日志跳过（不重试阻塞），
 * 锚定空窗延长但不消失（轮终/终态物化点与终态条目兜底）。区别于终态写面
 * writeManifestPersisted 的响亮语义：被接管的 v1 路径逐事件自愈，此处物化点稀疏，
 * 降级语义显式声明。
 *
 * @returns true = 已物化；false = 守卫跳过（锚定未就绪/无锚）或写失败降级。
 */
export function materializeBoundRecordManifest(
  dir: string,
  manifest: ManifestRecord,
): boolean {
  if (manifest.sessionFile !== undefined) {
    // pi 分支守卫：子 session 文件已在盘才物化（家族扫描孤儿判定的前提不变量）。
    if (!fs.existsSync(manifest.sessionFile)) return false;
  } else if (manifest.engineHandle === undefined) {
    // 双缺（spawn 窗口期未确立任何锚）：无锚可物化——静默跳过（非降级，正常空窗）。
    return false;
  }
  try {
    writeAtomicFileSync(path.join(dir, `${manifest.id}.json`), JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES));
    return true;
  } catch (err) {
    logger.warn(
      "[subagents] bound manifest materialization failed (projection only — skipped, next materialization point self-heals)",
      {
        detail: { id: manifest.id, dir, error: err instanceof Error ? err.message : String(err) },
      },
    );
    return false;
  }
}

// ============================================================
// run 级终局投影（[P1b-2 / D5-④] manifest-write 输出动作的落点）
// ============================================================
//
// ManifestRecord 是 record（ask）域持久面——一个 workflow run 对应多条 record
//（每 ask 一条，origin="workflow" + parentRunId），run 自身无 record。run 级
// outcome 硬套 ManifestRecord 全形会把 record 必填身份字段（rootSessionId 等）
// 填成假数据，故 run 终局投影用同族轻量载体 RunTerminalManifest，落点与 run
// store / journal 同目录（<workflow-state>/<runId>.json）：
// - 文件名 = <runId>.json（不命中 run state 保留清理的 wf-*.jsonl glob——终局
//   持久权威永不随缓存裁剪）；
// - 「已终局」单源锚定 = 本文件的 outcome 非空（D5 清理规则①）：保留清理的
//   资格判定读它，缺失/无 outcome = 活跃或 interrupted（D9-1：interrupted 非
//   终局，Q2 放弃窗终局化时写本形态 manifest 后才获清理资格）。

/** run 级终局投影 manifest（`<workflow-state>/<runId>.json`）。 */
export interface RunTerminalManifest {
  /** runId（文件名同 stem；generateRunId 的 wf-<ts>-<rand> 产物）。 */
  id: string;
  /** 脚本身份名（RunSpec.scriptName，终局诊断的最低身份数据）。 */
  workflowName: string;
  /** 终局形态——非空即「已终局」（D5 清理规则①单源锚定）。 */
  outcome: RunOutcome;
  /** 失败终局的结构化编码（completed/cancelled 缺省；abandon 路径的
   *  interrupted_abandoned 由 Q2 注册表单元附着，词表边界见 run-events.ts）。 */
  errorCode?: RunErrorCode;
  /**
   * [D5 诊断引用落账] 失败终局的子进程 stderr tee 文件绝对路径（成功/cancelled
   * 缺省）。取值 = 事件 journal 中最后一帧带 stderrTeePath 的 agent-settled（事件流
   * 投影，D6「权威在事件流」同款推导纪律——写侧在 persistTerminalProjection，
   * 本类型只定磁盘形状）。旧 manifest 无此字段（undefined = 无取证指针，读侧
   * 守卫归一，不炸）；仅诊断引用——文件受引擎侧轮转/过期清理管辖，读侧不得假设
   * 其永存。
   */
  stderrTeePath?: string;
  /** 终局墙钟时间（epoch ms）。 */
  settledAt: number;
}

/**
 * runId 白名单：与 run-events.ts journal 写读的 RUN_ID_PATTERN 同源同值（该侧
 * 未导出——manifest 文件名同样由 runId 直接拼出，路径穿越防线必须两处各自在位；
 * 漂移信号 = 任一侧收紧/放宽未同步，两处测试各自钉住）。
 */
const RUN_TERMINAL_MANIFEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertValidRunTerminalManifestId(runId: string): void {
  if (!RUN_TERMINAL_MANIFEST_ID_PATTERN.test(runId)) {
    throw new Error(
      `非法 runId ${JSON.stringify(runId)}：run 终局投影 manifest 文件名只接受字母数字开头、字符集 [A-Za-z0-9_-]、长度 ≤128 的 runId（防路径穿越）。runId 应来自 lifecycle.ts 的 generateRunId；收到非法值时检查调用方的 runId 传递链。`,
    );
  }
}

/** 终局形态词表集合（运行时守卫；词表 SSOT = run-events ALL_RUN_OUTCOMES）。 */
const RUN_TERMINAL_MANIFEST_OUTCOMES: ReadonlySet<string> = new Set(ALL_RUN_OUTCOMES);

/** 读侧最小形状校验：id/workflowName/outcome/settledAt 必填且类型合法。 */
function isRunTerminalManifest(value: unknown): value is RunTerminalManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.workflowName === "string" &&
    typeof v.outcome === "string" &&
    RUN_TERMINAL_MANIFEST_OUTCOMES.has(v.outcome) &&
    typeof v.settledAt === "number" &&
    (v.errorCode === undefined || typeof v.errorCode === "string") &&
    (v.stderrTeePath === undefined || typeof v.stderrTeePath === "string")
  );
}

/**
 * 写 run 级终局投影（原子写：tmp → fsync → rename，shared/atomic-write 统一原语；
 * 父目录缺失递归创建——manifest-write 执行点可能先于 run state 文件落盘）。
 * 写失败原样上抛，降级策略归调用方（pump 执行点 = error 留痕不阻断终局 coda）。
 */
export async function writeRunTerminalManifest(
  dir: string,
  manifest: RunTerminalManifest,
): Promise<void> {
  assertValidRunTerminalManifestId(manifest.id);
  const filePath = path.join(dir, `${manifest.id}.json`);
  await writeAtomicFile(filePath, JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES));
}

/**
 * 读 run 级终局投影。文件不存在 / JSON 损坏 / 形状不合法（含旧 manifest——无
 * outcome 字段的存量形态）一律返回 null（未终局语义，消费方按「无投影」处理，
 * 不炸）；errorCode / stderrTeePath 非法值由 isRunTerminalManifest 整体拒绝
 * （同 null 降级）；两字段缺省（旧 manifest）= undefined 合法通过（读侧兼容）。
 */
export async function readRunTerminalManifest(
  dir: string,
  runId: string,
): Promise<RunTerminalManifest | null> {
  assertValidRunTerminalManifestId(runId);
  const filePath = path.join(dir, `${runId}.json`);
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    // 分通道（对齐 listAllSync 的 isMissingFsError 纪律）：ENOENT（未终局/已清理）
    // = 合法缺省，静默降级 null；其余读错误 warn 留证后同样降级 null。
    if (!isMissingFsError(err)) {
      logger.warn(`[subagents] readRunTerminalManifest: read failed, degraded to null: ${filePath}`, {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return null; // ENOENT（未终局/已清理）按「无投影」降级。
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // 损坏 JSON——按「无投影」降级。
  }
  return isRunTerminalManifest(parsed) ? parsed : null;
}
