// src/interface/display-state.ts
//
// [§2.2 B 档 · run 域] 展示态单一中间表示——run 域所有展示映射的唯一输入。
//
// 为什么需要（登记 §2.2）：run 生命周期的展示此前散在三处各写各的判定与映射
//（`WorkflowsView.renderHeader` 的徽标、`renderFooter` 的 abort 可用性、
// `computeRenderSignature` 的签名首段），每处自己决定「什么状态显示成什么」；改一处
// 漏一处即出现口径漂移（本批修掉的三处可见错误正是这种漂移的产物）。
//
// 边界（刻意不做的）：**不并子代理域与通知域**。run 生命周期（三态投影）与子代理执行
// 状态（running/idle）、通知正文（outcome + closedReason 兜底）没有共同的输入词汇，
// 强行共用一张表会把两套语义塞进一个枚举——`gui-mappers.ts` 与 `bg-notify-render.ts`
// 各自留在自己的域里（§2.2 裁决）。
//
// 单一判定源纪律：本模块**不判定状态**——`status` 直接取 core `runSummary(run).status`
//（pi 侧唯一投影，`tool-workflow.displayStatusOf` 同源），只把「生命周期 / 终局原因 /
// 可中断性 / 会计」整理成展示形态。判定 1 个、展示 1 个。
import { runSummary, type DoneReason, type WorkflowRun } from "@zhushanwen/subagent-core";

import type { ThemeLike } from "./format.ts";

/** run 展示三态（与 core `runSummary` 投影、shared `WorkflowRunStatus` 同词）。 */
export type RunDisplayStatus = "running" | "interrupted" | "done";

/** run 展示态（唯一中间表示）。 */
export interface RunDisplayState { // oe-exempt:20260930:framework:run 域展示契约——TUI 各渲染位共用同一形状，非单实现投机抽象
  /** 生命周期三态（唯一判定源 = core runSummary）。 */
  status: RunDisplayStatus;
  /** 终局原因（仅 status === "done" 且 core 侧有值时；展示文案与失败族判定用）。 */
  doneReason?: DoneReason;
  /** 可中断（abort）——仅 running；interrupted 态已停、done 已终局。 */
  abortable: boolean;
  /** 会计面（活体快照值；重启重建后的近似值同样走这里，见 §2.1b）。 */
  accounting: {
    usedTokens: number;
    maxTokens?: number;
    usedCost: number;
  };
}

/**
 * run → 展示态（纯函数，不读 store、不发事件）。
 *
 * 注意 `runSummary` 的终局判定优先读进程内终局注册表（活体终局），重启后由 record
 * 流 fold 出的聚合兜底——因此本函数对活体与重水合两种形态同样正确。
 */
export function runDisplayStateOf(run: WorkflowRun): RunDisplayState {
  const summary = runSummary(run);
  const budget = run.state.budget;
  return {
    status: summary.status,
    ...(summary.reason !== undefined ? { doneReason: summary.reason } : {}),
    abortable: summary.status === "running",
    accounting: {
      usedTokens: budget.usedTokens,
      ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
      usedCost: budget.usedCost,
    },
  };
}

/** 失败族终局（done 且原因非 completed）——色档与徽标共用同一判定，防两处各判。 */
export function isFailedTerminal(ds: RunDisplayState): boolean {
  return ds.status === "done" && ds.doneReason !== undefined && ds.doneReason !== "completed";
}

/**
 * 展示态 → 语义色调（run 域色档单表）。
 *
 * 与 `format.ts` 的 `statusColorToken`（trace 节点 / 通知域用）保持同档：running =
 * warning、interrupted = muted、失败族 = error、成功终局 = success；两处**输入词汇不同**
 *（本表吃 RunDisplayState，那张吃 StatusText），故各自成表但档位口径一致。
 */
export function runToneOf(ds: RunDisplayState): "success" | "warning" | "error" | "muted" {
  switch (ds.status) {
    case "running": return "warning";
    case "interrupted": return "muted";
    case "done": return isFailedTerminal(ds) ? "error" : "success";
  }
}

/**
 * 展示态 → 头部徽标（run 域唯一徽标构造点）。
 *
 * 文案与符号沿用既有 TUI 输出（逐字不变）：● running / ○ interrupted / ✓ completed /
 * ✗ failed / ✗ aborted / ⚠ budget / ⚠ timeout。done 缺 reason 时按 completed 显示
 *（旧格式 run 的常见形态）。
 */
export function formatRunBadge(ds: RunDisplayState, theme: ThemeLike): string {
  if (ds.status === "running") return theme.fg("warning", "\u25CF running");
  if (ds.status === "interrupted") return theme.fg("muted", "\u25CB interrupted");
  switch (ds.doneReason) {
    case "budget_limited": return theme.fg("error", "\u26A0 budget");
    case "time_limited": return theme.fg("error", "\u26A0 timeout");
    case "aborted": return theme.fg("error", "\u2717 aborted");
    case "failed": return theme.fg("error", "\u2717 failed");
    default: return theme.fg("success", "\u2713 completed");
  }
}

/**
 * 展示态 → 渲染签名片段（`computeRenderSignature` 用）。
 *
 * 签名的作用是「字段变了必须失效重绘」——把展示态的**生命周期面全字段**序列化进来，
 * 新增字段自动进签名，不再依赖「手工同步签名表」的纪律（原实现只放 status，新增展示
 * 字段靠人记得补签名，DS8 维护约定即为此存在）。会计面（accounting）**刻意不重复进
 * 本片段**：签名里已有的 `budgetPart` 是同一组值的既有同精度形态（token 取整桶 +
 * cost 定点小数），重复只会引入第二套精度口径。
 */
export function runDisplaySignaturePart(ds: RunDisplayState): string {
  return [ds.status, ds.doneReason ?? "-", ds.abortable ? "A" : "-"].join(":");
}
