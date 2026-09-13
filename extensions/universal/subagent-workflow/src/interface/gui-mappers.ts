/**
 * GUI 协议映射辅助函数 —— run/subagent 状态字符串 → 协议 TreeItem 状态 + 图标。
 *
 * 协议包 @xyz-agent/extension-protocol 的 list-tree 组件用 TreeItem.status（三态）
 * + TreeItem.icon 表达运行态。本模块把 workflow/subagent 领域的丰富状态字符串收口
 * 到这两个枚举，供 helpers.ts / tool-workflow.ts / subagent-actions.ts 复用。
 *
 * 参考：@xyz-agent/extension-protocol GuiComponentProps['list-tree']。
 */

import type { GuiContext, TreeItem, TreeItemIcon } from "@xyz-agent/extension-protocol";

/**
 * 从 Pi ExtensionContext 构造协议 GuiContext 的最小子集。
 *
 * Pi SDK 的 ExtensionContext 在结构上满足协议 GuiContext（有 mode/hasUI/ui），
 * 但 ui.custom 的泛型签名与协议 GuiContext.ui.custom 不兼容（前者复杂泛型，后者
 * 简化签名），直接 `as GuiContext` 会触发 TS 结构兼容错误（ui.custom 参数逆变）。
 * 此 helper 显式提取 mode/hasUI，构造最小 GuiContext，规避 ui.custom 签名冲突。
 *
 * 与 ask-user extension 的 runRpcInteraction 同构（见 ask-user/src/index.ts）。
 */
export function toGuiCtx(ctx: { mode: GuiContext["mode"]; hasUI: boolean } | undefined): GuiContext | undefined {
  if (!ctx) return undefined;
  return { mode: ctx.mode, hasUI: ctx.hasUI };
}

/** TreeItem.status 枚举（协议三态）。 */
type TreeStatus = NonNullable<TreeItem["status"]>;

/**
 * 状态字符串是否为失败态（mapRunStatus/mapRunIcon 共享谓词——两映射仅返回值形态不同，
 * 关键词表必须同步演化，抽单点防双写漂移）。入参须已 toLowerCase。
 */
function isFailedStatus(s: string): boolean {
  return (
    s.includes("failed") ||
    s.includes("abort") ||
    s.includes("cancel") ||
    s.includes("crash") ||
    s.includes("error") ||
    s.includes("budget") ||
    s.includes("time_limited")
  );
}

/**
 * 把 workflow/subagent 状态字符串映射到 list-tree 的三态 status。
 *
 * 输入可能是纯 RunStatus（running/done）、RunStatus+reason 组合
 * （如 "done (failed)"），或 subagent status（running/idle/legacy done/failed/
 * cancelled/crashed）。
 *
 * 映射规则：
 *   - running → running
 *   - failed / aborted / error / crashed / cancelled / budget_limited / time_limited → failed
 *   - 其他（done / completed / success / pending / idle）→ done
 *
 * [U8 两态] subagent 的 idle（无任务在飞可续聊）在协议三态里落 done（空闲 = 无
 * 进行中工作，check 图标）；「为什么停」不进树形状态（协议无该维度）。
 */
export function mapRunStatus(status: string): TreeStatus {
  const s = status.toLowerCase();
  if (s.includes("running")) return "running";
  if (isFailedStatus(s)) return "failed";
  return "done";
}

/**
 * 把状态字符串映射到 TreeItem.icon。
 *
 *   running                       → circle（进行中）
 *   failed/abort/cancel/crash     → cross
 *   其他（done）                  → check
 */
export function mapRunIcon(status: string): TreeItemIcon {
  const s = status.toLowerCase();
  if (s.includes("running")) return "circle";
  if (isFailedStatus(s)) return "cross";
  return "check";
}
