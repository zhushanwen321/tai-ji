/**
 * Workflow Extension — commands
 *
 * 仅注册 /workflows 命令（FR-6）——打开交互式 TUI 面板（WorkflowsView，三级导航
 * phase → agent → detail，UC-3）。
 *
 * 功能由 tool 承担，命令仅保留 /workflows 打开面板：
 * - /workflow run <name> → 用 workflow tool { action: "run" }
 * - /workflow list → 用 workflow tool { action: "status" }
 * - /workflow abort <run-id> → 用 workflow tool { action: "abort" }
 * - /workflow save <name> → 用 workflow-script tool { action: "save" }
 * - /workflow delete <name> → 用 workflow-script tool { action: "delete" }
 *
 * 层归属：Interface。依赖 Pi SDK + Engine lifecycle（abort，注入 ViewActions）
 * + WorkflowsView（读 WorkflowRun 聚合根）。
 *
 * 参考：
 * - domain-models.md §FR-6（command 收口仅 /workflows，打开交互式面板）
 * - spec.md UC-3（用户输入 /workflows，打开三级导航 TUI 面板）
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { abortRun, getSubagentService } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { parseWorkflowRpcCommand, type WorkflowRpcAction } from "./command-actions.ts";
import { createWorkflowsView, type ViewActions } from "./views/WorkflowsView.ts";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { LIST_LIMIT } from "./list-shared.ts";

/** runId 截断长度（显示用）。 */
const RUNID_SHORT = 8;

/** status 显示顺序：running 优先（活跃态在前），再 startedAt 倒序。 */
const STATUS_ORDER: Record<string, number> = {
  running: 0,
  done: 2,
};
/** 未知 status 的默认排序权重（排在已知 status 之后）。 */
const UNKNOWN_STATUS_WEIGHT = 9;

// ── /workflows command ───────────────────────────────────────

/**
 * 注册 /workflows command——打开 workflow 交互式 TUI 面板（FR-6, UC-3）。
 *
 * 行为：
 * - 无 UI（RPC/print/json 模式）→ notify 提示（降级，不打开 TUI）
 * - `/workflows <runId>` 或前缀匹配唯一 run → 直接打开该 run 的 view
 * - `/workflows`（无参）：
 * · 0 runs → notify "No workflows"
 * · 1 run → 直接打开
 * · 多 runs → select 选 → 打开选中 run 的 view
 *
 * ViewActions（abort）由本 command 注入——view 本身不持 lifecycle 依赖，
 * 只通过 actions 回调与 engine 交互（解耦，便于 view 单测）。
 *
 * @param api ExtensionAPI
 * @param getRuns 获取当前 session 的 runs（Map<runId, WorkflowRun>）
 * @param deps LauncherDeps（lifecycle abort 用）
 */
export function registerWorkflowsCommand(
  api: ExtensionAPI,
  getRuns: () => Map<string, WorkflowRun>,
  deps: LauncherDeps,
): void {
  api.registerCommand("workflows", {
    description: "Open workflow panel. /workflows [runId] | /workflows abort <runId>",
    getArgumentCompletions(prefix: string) {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);

      // 第一级：lifecycle 动词（带尾随空格，选中后继续补 runId）
      if (parts.length <= 1) {
        return [
          { label: "abort", value: "abort ", description: "Abort a workflow run" },
        ].filter((opt) => opt.label.startsWith(trimmed.toLowerCase()));
      }

      // 第二级：lifecycle 动词后补全当前 session 的 runId
      if (parts[0] === "abort") {
        try {
          const runs = sortedRuns(getRuns());
          if (runs.length === 0) return null;
          return runs.map((r) => ({
            label: r.runId,
            value: r.runId,
            description: `${r.spec.scriptName} [${r.state.status}]`,
          }));
        } catch {
          // 拿不到运行时数据（getRuns 抛错）→ 静默降级，补全失败不影响 command
          return null;
        }
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // ── RPC 模式（xyz-agent GUI）：解析 lifecycle action 直接执行，不打开 TUI ──
      // hasUI 在 TUI 和 RPC 都为 true，不能用于区分；用 ctx.mode === "rpc" 判定 GUI 通道。
      if (ctx.mode === "rpc") {
        await handleRpcMode(parseWorkflowRpcCommand(args), ctx, deps);
        return;
      }

      // ── print/json 模式（headless）：不可交互 ──
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/workflows requires interactive mode", "error");
        return;
      }

      // 直接按 runId / 前缀匹配打开
      const directRunId = args.trim();
      if (directRunId) {
        await openByRunId(directRunId, getRuns, ctx, deps);
        return;
      }

      // 无参——列表选择
      await openFromList(getRuns, ctx, deps);
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * RPC 模式分支（xyz-agent GUI）：解析后的 lifecycle action 直接执行，不打开 TUI。
 *
 * 各 action 语义：
 * - abort → 调 lifecycle abortRun，成功/失败均 notify（不向上抛）
 * - lifecycle-removed → 已移除的 verb（pause/resume），给定制指引而非 Usage
 *   （F3 定稿——提示语义优先于 missing-id：run 一次性生命周期后不可挂起）
 * - lifecycle-missing-id → Usage 提示
 * - noop → 无 action 或未知 action：GUI 端已屏蔽此 command 入口，此处兜底
 */
async function handleRpcMode(
  parsed: WorkflowRpcAction,
  ctx: ExtensionCommandContext,
  deps: LauncherDeps,
): Promise<void> {
  switch (parsed.action) {
    case "abort": {
      try {
        await abortRun(parsed.runId, deps);
        // abort 单态后 pastTense 固定（原三态拼接随 pause/resume 删除）
        ctx.ui.notify(`Workflow ${parsed.runId}: aborted`, "info");
      } catch (err) {
        const msg = toErrorMessage(err);
        ctx.ui.notify(`Failed to abort workflow ${parsed.runId}: ${msg}`, "warning");
      }
      return;
    }
    case "lifecycle-removed":
      ctx.ui.notify(
        `Workflow ${parsed.verb} has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>`,
        "warning",
      );
      return;
    case "lifecycle-missing-id":
      ctx.ui.notify(`Usage: /workflows ${parsed.verb} <runId>`, "warning");
      return;
    case "noop":
      ctx.ui.notify("View workflows in the sidebar Flows tab", "info");
      return;
    default: {
      // exhaustiveness 断言：未来新增 action verb 忘加 case 时 tsc 报错
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled workflow RPC action: ${String(_exhaustive)}`);
    }
  }
}

/**
 * TUI 模式：按 runId 直接打开对应 run 的 view（精确匹配优先，前缀唯一匹配次之）。
 * 均未命中 → error notify。
 */
async function openByRunId(
  directRunId: string,
  getRuns: () => Map<string, WorkflowRun>,
  ctx: ExtensionCommandContext,
  deps: LauncherDeps,
): Promise<void> {
  const all = sortedRuns(getRuns());
  // 精确匹配优先
  const exact = all.find((r) => r.runId === directRunId);
  if (exact) {
    await openView(exact, ctx.ui.theme, ctx, deps);
    return;
  }
  // 前缀匹配
  const matched = all.filter((r) => r.runId.startsWith(directRunId));
  if (matched.length === 1) {
    await openView(matched[0], ctx.ui.theme, ctx, deps);
    return;
  }
  ctx.ui.notify(`Workflow '${directRunId}' not found`, "error");
}

/**
 * TUI 模式无参分支：0 runs → notify；单 run 直开；多 run → select 选择后打开。
 */
async function openFromList(
  getRuns: () => Map<string, WorkflowRun>,
  ctx: ExtensionCommandContext,
  deps: LauncherDeps,
): Promise<void> {
  const all = sortedRuns(getRuns());
  if (all.length === 0) {
    ctx.ui.notify("No workflows in current session.", "info");
    return;
  }

  // 单 run 直开
  if (all.length === 1) {
    await openView(all[0], ctx.ui.theme, ctx, deps);
    return;
  }

  // 多 run——select 选择
  const entries = all.map(
    (r) => `${r.spec.scriptName} [${r.state.status}] (${r.runId.slice(0, RUNID_SHORT)})`,
  );
  const selected = await ctx.ui.select("Select workflow:", entries);
  if (!selected) return;
  const idx = entries.indexOf(selected);
  if (idx === -1) return;
  await openView(all[idx], ctx.ui.theme, ctx, deps);
}

/**
 * 取 runs 按 status（running 优先）+ startedAt 倒序排序。
 * 复用 main 的 UX 顺序（活跃态在前，新的在前）。
 */
function sortedRuns(runs: Map<string, WorkflowRun>): WorkflowRun[] {
  const arr = Array.from(runs.values());
  return arr.sort((a, b) => {
    const sa = STATUS_ORDER[a.state.status] ?? UNKNOWN_STATUS_WEIGHT;
    const sb = STATUS_ORDER[b.state.status] ?? UNKNOWN_STATUS_WEIGHT;
    if (sa !== sb) return sa - sb;
    const ta = a.meta.startedAt ? new Date(a.meta.startedAt).getTime() : 0;
    const tb = b.meta.startedAt ? new Date(b.meta.startedAt).getTime() : 0;
    return tb - ta;
  });
}

/**
 * 打开 WorkflowsView（三级导航 TUI），注入 lifecycle ViewActions。
 *
 * ViewActions 通过 deps 调 lifecycle（abort），与 view 解耦——
 * view 单测可注入 mock actions（见 views/__tests__/WorkflowsView-signature.test.ts）。
 *
 * [H2 W3] live 进度数据源（设计 D2 进度源切换）：view 经 store 查询
 * collectRecordsByParentRunId(run.runId)（内存 ∪ 磁盘重建 ∪ manifest，LIST_LIMIT
 * 口径）配对 running trace node 渲染实时进度。service 单例未就绪（理论上 run 只能
 * 于 session 内存在，session_start 后必在；防御分支）时不注入——view 走终态
 * result 渲染路径。
 */
async function openView(
  run: WorkflowRun,
  theme: Theme,
  ctx: ExtensionCommandContext,
  deps: LauncherDeps,
): Promise<void> {
  const actions: ViewActions = {
    abort: (runId) => abortRun(runId, deps),
  };
  const service = getSubagentService();
  const liveRecords = service
    ? () => service.queries.collectRecordsByParentRunId(run.runId, LIST_LIMIT)
    : undefined;
  await createWorkflowsView(run, theme, ctx, actions, deps.store.stateFilePath(run.runId), liveRecords);
}
