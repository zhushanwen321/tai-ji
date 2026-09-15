/**
 * WorkflowRun 摘要投影（设计 D8/B5 —— U7）。
 *
 * 「宿主各写一遍」域的收口：pi tool-workflow.toRunSummary 与 zsw
 * orchestration-host 投影的字段集已实锤分叉（workflow vs name），本模块以 core
 * WorkflowRun 为准提供单一投影，宿主可在此基础上扩展自己的投影字段
 * （如 pi 版的 stateFile 需要 RunStore，归宿主扩展——core 不依赖具体 store 实例）。
 *
 * 层归属：Engine（纯投影，零 IO、零依赖）。字段名对齐 pi 版（name = scriptName）。
 */

import type { RunStatus, DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";

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
  status: RunStatus;
  reason?: DoneReason;
  /** ISO 时间戳，run 创建/启动时刻。 */
  startedAt: string;
  /** ISO 时间戳，transition("done") 时设置；running run 为 undefined。 */
  completedAt?: string;
  /** 失败/中止原因（state.error）。 */
  error?: string;
}

/**
 * WorkflowRun → 摘要投影。纯函数，不读 store、不发事件。
 *
 * @param run 聚合根（running 或 done 均可投影）
 */
export function runSummary(run: WorkflowRun): WorkflowRunSummary {
  return {
    runId: run.runId,
    name: run.spec.scriptName,
    slug: run.spec.slug,
    status: run.state.status,
    reason: run.state.reason,
    startedAt: run.meta.startedAt,
    completedAt: run.meta.completedAt,
    error: run.state.error,
  };
}

/**
 * 判断是否存在指定名字、仍在 running 的 workflow script。
 *
 * pi 版遍历全部 session 的 runs（两层循环）；core 版收口为单 runs Map——
 * per-session 隔离由调用方（宿主逐 session 调用或传入聚合 Map）负责。
 *
 * @param runs run 注册表（runId → WorkflowRun）
 * @param name script 名（按 spec.scriptName 精确匹配）
 */
export function isScriptRunning(runs: Map<string, WorkflowRun>, name: string): boolean {
  for (const run of runs.values()) {
    if (run.spec.scriptName === name && run.state.status === "running") return true;
  }
  return false;
}
