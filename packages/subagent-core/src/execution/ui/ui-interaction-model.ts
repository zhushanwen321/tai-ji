// src/execution/ui/ui-interaction-model.ts
//
// Pi ctx.ui method 的交互模型分类。
//
// 固化 Pi rpc-mode.ts（--mode rpc 子进程的 ctx.ui 实现）中 10 个会发
// extension_ui_request 的 method 的交互模型分类，供 session-runner 决定：
//   - 是否透传到主进程 handler（dialog 类才透传，fire-and-forget 不透传）
//   - 是否进 L2 全局串行队列（dialog 类才排队，争输入焦点）
//
// 分类依据（.fix-plans/00-master-summary.md §一冲突 2「维度 1」）：
//
//   | 交互模型 | method | 行为 | 子进程不回会怎样 |
//   |---|---|---|---|
//   | dialog（占输入焦点，等响应） | select confirm input editor |
//     子进程在 pendingExtensionRequests 注册 Promise 等 id 对应 response |
//     Promise 永挂 + 内存泄漏 |
//   | fire-and-forget（纯展示/写入，不等响应） |
//     notify setStatus setWidget setTitle set_editor_text | output() 完即返回 |
//     无影响 |
//
// 未知 method 默认按 fire-and-forget 处理（保守：不透传、不排队），
// 避免 Pi 未来新增 method 时误判为 dialog 导致不必要的串行。

/** dialog 类 method 集合：占输入焦点、等响应、需透传 + 排队。
 *  与 Pi rpc-mode.ts 的 pendingExtensionRequests 注册逻辑一一对应。 */
const DIALOG_METHODS: ReadonlySet<string> = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

/** 判断 method 是否为 dialog 类（占输入焦点，等响应）。
 *
 *  dialog 类（select/confirm/input/editor）：
 *    - 子进程在 pendingExtensionRequests 注册 Promise 等对应 id 的 response
 *    - 主进程必须透传 + 进 L2 全局串行队列（争输入焦点）
 *    - 不响应会导致子进程 Promise 永挂 + 内存泄漏
 *
 *  fire-and-forget 类（notify/setStatus/setWidget/setTitle/set_editor_text 及未知 method）：
 *    - 子进程 output() 完即返回，不注册 pending
 *    - 默认不透传（TUI 下不影响输入交互），不排队
 *
 *  @param method Pi rpc-types.ts 的 method 字段值
 *  @returns dialog 类返回 true，fire-and-forget 类（含未知 method）返回 false */
export function isDialogMethod(method: string): boolean {
  return DIALOG_METHODS.has(method);
}
