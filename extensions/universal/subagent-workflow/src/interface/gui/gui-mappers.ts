/**
 * GUI 协议映射辅助函数 —— run/subagent 状态字符串 → 协议 TreeItem 状态 + 图标。
 *
 * 协议包 @zhushanwen/extension-protocol 的 list-tree 组件用 TreeItem.status（三态）
 * + TreeItem.icon 表达运行态。本模块把**子代理执行状态**（ExecutionStatus）映射到
 * 这两个枚举，供 subagent-actions.ts 复用。
 *
 * 参考：@zhushanwen/extension-protocol GuiComponentProps['list-tree']。
 */

import type { ExecutionStatus } from "@zhushanwen/subagent-core";
import type { GuiContext, TreeItem, TreeItemIcon } from "@zhushanwen/extension-protocol";

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
 * [§2.2 入参收窄] 本模块服务的状态域 = **子代理执行状态**（`ExecutionStatus`
 * "running" | "idle"，唯一生产调用方 subagent-actions.ts 传的就是 SubagentListItem
 * .status）。
 *
 * 历史形态是裸 string + 关键词子串匹配（failed/abort/cancel/crash/error/budget/
 * time_limited），宣称服务 workflow run 状态——但 workflow 路径早已无调用方，那些
 * 失败关键词分支在生产**全部不可达**，用例也只是在测死词表。收窄到显式联合后，
 * 新增状态值会在编译期强制补齐分支（与 format.ts 的 statusGlyph 同款做法）。
 */
type SubagentDisplayStatus = ExecutionStatus;

/** 子代理状态 → 协议三态 / 图标（穷尽 switch，无 default 静默兜底）。 */
function displayIndexOf(status: SubagentDisplayStatus): { tree: TreeStatus; icon: TreeItemIcon } {
  switch (status) {
    // running = 有任务在飞；idle = 无进行中工作（可续聊）——「为什么停」不进树形状态
    //（协议无该维度），空闲落 done/check。
    case "running": return { tree: "running", icon: "circle" };
    case "idle": return { tree: "done", icon: "check" };
    // 运行时兜底：类型层已排除域外值，但 extension 入参来自宿主/存量数据，可能带
    // 旧词表（如 done/failed）——落 done/check（与收窄前的 default 行为一致），
    // 不抛错（树形渲染不该因一个状态字崩掉整棵列表）。
    default: return { tree: "done", icon: "check" };
  }
}

/**
 * 子代理执行状态 → list-tree 三态 status。
 *
 *   running → running；idle → done（空闲 = 无进行中工作，check 图标）
 */
export function mapRunStatus(status: SubagentDisplayStatus): TreeStatus {
  return displayIndexOf(status).tree;
}

/**
 * 子代理执行状态 → TreeItem.icon。
 *
 *   running → circle；idle → check
 */
export function mapRunIcon(status: SubagentDisplayStatus): TreeItemIcon {
  return displayIndexOf(status).icon;
}
