/**
 * workflow-record 自描述 entry 的 schema 契约单源（W17 [D4]；词表/guard 收敛
 * 二轮复审候选 2）。
 *
 * 三方消费格局（壳写点 / 壳 loadAll 重建 / runtime 投影扫描）此前各自持有
 * customType 字面量与 v1 判定逻辑（壳 collectRecordRun / runtime
 * parseSelfDescribedWorkflowSnapshot 双实现、shared 另持一份字面量），独立演化
 * 即静默漂移——本模块收敛两件事：
 * 1. customType 与 entry schema 版本常量（版本 bump 单点，写点与读判定同源）；
 * 2. 纯判定函数 classifyWorkflowRecordEntryData——entry data 的 v1 分支分类。
 *
 * 判定与策略分离：本函数无 IO、无日志。reason 词表是判定结果的结构化输出，
 * 日志策略（何时出声 / 去重键 / 静默）留消费方——壳 per-entry warn 留证与
 * runtime warnOnce 去重是两消费方各自的可观测性选择，收敛判定不收敛日志。
 *
 * 不在本模块的：
 * - snapshot 层解码（SNAPSHOT_VERSION 守卫 + fromRunSnapshot）——run-snapshot.ts
 *   codec 单源；entry 层 v 与 snapshot 层 v 是两级独立版本（entry schema 演化
 *   vs 快照格式演化）；
 * - runtime 投影的 runId 存在性守卫——投影键需求（record 需要 runId 做 Map 键），
 *   非 entry schema 面，壳解码链自有等价校验（fromRunSnapshot）。
 */

/**
 * 自描述 workflow record entry 的 customType。命名对齐 `subagent-record`
 * （连字符风格）。写点字面量与常量的等值由壳
 * __tests__/jsonl-run-store-session-file.test.ts 断言钉住（消费方引用本常量，
 * 勿用裸字符串）。
 */
export const WORKFLOW_RECORD_CUSTOM_TYPE = "workflow-record";

/**
 * `workflow-record` entry 的 data schema 版本（W17 起 v1）。消费方按 v 判别
 * 解析，不认识的版本跳过而非猜测；与快照层 SNAPSHOT_VERSION（"wf-run-v2"）
 * 是两级独立版本号。
 */
export const WORKFLOW_RECORD_ENTRY_VERSION = 1 as const;

/**
 * 判定结果判别联合。
 *
 * ok = v1 且带 snapshot（snapshot 未经形状校验——truthy 即放行，解码归消费方，
 * 与收敛前壳 `!data.snapshot` / runtime `typeof snapshot !== 'object'` 双实现的
 * 最宽共同判定面一致）。
 */
export type WorkflowRecordEntryClassification =
  | { ok: true; snapshot: unknown }
  | { ok: false; reason: "wrong-type" | "missing-v" | "future-v" | "no-snapshot" };

/**
 * entry data → v1 分类（纯函数，无 IO 无日志）。
 *
 * 分支语义（与收敛前壳/runtime 双实现的判定面逐分支对齐）：
 * - wrong-type：data 非对象（截断/半写连对象都不是）；
 * - missing-v：对象但 v 缺失（写点恒定 v:1，缺失即形态损坏）；
 * - future-v：v 有值但非当前版本（含类型漂移如 "1" 字符串——升级前旧版读取
 *   属正常降级）；
 * - no-snapshot：v1 但 snapshot falsy；
 * - ok：v1 且 snapshot truthy。
 */
export function classifyWorkflowRecordEntryData(data: unknown): WorkflowRecordEntryClassification {
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "wrong-type" };
  }
  const record = data as Record<string, unknown>;
  if (record.v === undefined) {
    return { ok: false, reason: "missing-v" };
  }
  if (record.v !== WORKFLOW_RECORD_ENTRY_VERSION) {
    return { ok: false, reason: "future-v" };
  }
  if (!record.snapshot) {
    return { ok: false, reason: "no-snapshot" };
  }
  return { ok: true, snapshot: record.snapshot };
}
