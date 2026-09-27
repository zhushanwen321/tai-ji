import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getLogger } from "../../core/logger.ts";

import { bestEffort } from "../assembly/best-effort.ts";
import { writeAtomicFile } from "../../shared/atomic-write.ts";
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
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      return isValidManifest(parsed) ? parsed : null;
    } catch {
      // 文件缺失（ENOENT）或 JSON 损坏（SyntaxError）均降级为 null
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
    (v.errorCode === undefined || typeof v.errorCode === "string")
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
 * 不炸）；errorCode 非法值由 isRunTerminalManifest 整体拒绝（同 null 降级）。
 */
export async function readRunTerminalManifest(
  dir: string,
  runId: string,
): Promise<RunTerminalManifest | null> {
  assertValidRunTerminalManifestId(runId);
  const filePath = path.join(dir, `${runId}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsPromises.readFile(filePath, "utf-8"));
  } catch {
    return null; // ENOENT（未终局/已清理）或损坏 JSON——均按「无投影」降级。
  }
  return isRunTerminalManifest(parsed) ? parsed : null;
}
