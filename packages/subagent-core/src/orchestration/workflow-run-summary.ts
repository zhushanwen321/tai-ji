/**
 * WorkflowRun 摘要投影（设计 D8/B5 —— U7）。
 *
 * 「宿主各写一遍」域的收口：pi tool-workflow.toRunSummary 与 zsw
 * orchestration-host 投影的字段集已实锤分叉（workflow vs name），本模块以 core
 * WorkflowRun 为准提供单一投影，宿主可在此基础上扩展自己的投影字段
 * （如 pi 版的 stateFile 需要 RunStore，归宿主扩展——core 不依赖具体 store 实例）。
 *
 * [W2/V1 D1 分流表] 投影读者换源：status/reason/completedAt 的活体终局源 =
 * 终局记录注册表（settledRecordOf——两态机活体写点删除后聚合字段停更）；
 * 恢复路径写点 run / v1 存量条目回落聚合字段（v1 兼容层读面，W4 sunset）。
 * 混合判源读收拢在本投影函数体内（A1 排除面「投影构建边界」的函数级锚定）。
 *
 * 层归属：Engine（纯投影，零 IO、零依赖）。字段名对齐 pi 版（name = scriptName）。
 */

import type { RunStatus, DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import { runSettledOutcomeToDoneReason, settledRecordOf } from "./terminal-actions.ts";

/**
 * WorkflowRun 的可序列化摘要（status action / 列表渲染用）。
 *
 * 字段与 pi tool-workflow.toRunSummary 一致（去除依赖 RunStore 的 stateFile——
 * 宿主可扩展投影自行追加）。slug 旧持久化 run 可能缺失（undefined 保真透传）。
 */
export interface WorkflowRunSummary {
  runId: string;
  /** 脚本身份名（spec.scriptName）。 */
  name: string;
  /** run 级简短标签（可选，旧持久化 run 缺失）。 */
  slug?: string;
  /**
   * 投影三态（[D2]）：done（终局）> interrupted（重水合中断标记——聚合 status
   * 词表保持两态，中断态经 meta.interruptedAt 在投影面表达，与 shared
   * WorkflowRunStatus 三态同词）> running。
   */
  status: RunStatus | "interrupted";
  reason?: DoneReason;
  /** ISO 时间戳，run 创建/启动时刻。 */
  startedAt: string;
  /** ISO 时间戳，终局时刻（活体终局 = run-settled 帧时序；恢复写点 = meta.completedAt）；未终局为 undefined。 */
  completedAt?: string;
  /** 失败/中止原因（state.error）。 */
  error?: string;
}

/**
 * WorkflowRun → 摘要投影。纯函数，不读 store、不发事件。
 *
 * @param run 聚合根（running 或已终局均可投影）
 */
export function runSummary(run: WorkflowRun): WorkflowRunSummary {
  const settled = settledRecordOf(run.runId);
  return {
    runId: run.runId,
    name: run.spec.scriptName,
    slug: run.spec.slug,
    status:
      settled !== undefined || run.state.status === "done"
        ? "done"
        : run.meta.interruptedAt !== undefined
          ? "interrupted"
          : "running",
    reason:
      settled !== undefined
        ? runSettledOutcomeToDoneReason(settled.outcome, settled.errorCode)
        : run.state.reason,
    startedAt: run.meta.startedAt,
    completedAt:
      settled !== undefined
        ? new Date(settled.settledAt).toISOString()
        : run.meta.completedAt,
    error: run.state.error,
  };
}

