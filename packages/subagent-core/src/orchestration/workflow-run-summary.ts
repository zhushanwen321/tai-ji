/**
 * WorkflowRun 摘要派生视图（设计 D8/B5 —— U7）。
 *
 * 「宿主各写一遍」域的收尾：pi tool-workflow.toRunSummary 与 zsw
 * orchestration-host 派生视图的字段集已实锤分叉（workflow vs name），本模块以 core
 * WorkflowRun 为准提供单一派生视图，宿主可在此基础上扩展自己的派生视图字段
 * （如 pi 版的 stateFile 需要 RunStore，归宿主扩展——core 不依赖具体 store 实例）。
 *
 * [W2/V1 D1 → D6(a) 第 1 步换源] 派生视图读者换源：status/reason/completedAt 的终局源 =
 * 终局记录注册表（settledRecordOf）。注册表两个记源——活体终局由 dispatch 链
 * terminal 写入 journal 记录 note；恢复路径 run（重启后重新加载的 done run）由重建点
 * `noteRebuiltSettlement` 把 fold 出的 run-settled 事实注入（壳
 * foldRecordStreamToRun）。聚合 `state.status` 不再参与终局判定。
 * 混合判源读收拢在本派生视图函数体内（A1 排除范围「派生视图构建边界」的函数级锚定）。
 *
 * 层归属：Engine（纯派生视图，零 IO、零依赖）。字段名对齐 pi 版（name = scriptName）。
 */

import type { DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import { runSettledOutcomeToDoneReason, settledRecordOf } from "./terminal-actions.ts";

/**
 * WorkflowRun 的可序列化摘要（status action / 列表渲染用）。
 *
 * 字段与 pi tool-workflow.toRunSummary 一致（去除依赖 RunStore 的 stateFile——
 * 宿主可扩展派生视图自行追加）。slug 旧持久化 run 可能缺失（undefined 保真透传）。
 */
export interface WorkflowRunSummary {
  runId: string;
  /** 脚本身份名（spec.scriptName）。 */
  name: string;
  /** run 级简短标签（可选，旧持久化 run 缺失）。 */
  slug?: string;
  /**
   * 派生视图三态（[D2]，与 shared WorkflowRunStatus / 展示层 RunDisplayStatus 同词）：
   * done（终局）> interrupted（重新加载时的中断标记——经 meta.interruptedAt 在派生视图侧
   * 表达）> running。[D6(a)] 判定唯一源 = 终局记录注册表 + 中断标记，与聚合
   * 快照无关（两态机词表已退役）。
   */
  status: "running" | "interrupted" | "done";
  reason?: DoneReason;
  /** ISO 时间戳，run 创建/启动时刻。 */
  startedAt: string;
  /** ISO 时间戳，终局时刻（= 终局记录注册表的 run-settled 帧时序；注册表 miss 回落 meta.completedAt）；未终局为 undefined。 */
  completedAt?: string;
  /** 失败/中止原因（state.error）。 */
  error?: string;
}

/**
 * WorkflowRun → 摘要派生视图。纯函数，不读 store、不发事件。
 *
 * @param run 聚合根（running 或已终局均可生成派生视图）
 */
export function runSummary(run: WorkflowRun): WorkflowRunSummary {
  const settled = settledRecordOf(run.runId);
  return {
    runId: run.runId,
    name: run.spec.scriptName,
    slug: run.spec.slug,
    status:
      settled !== undefined
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

