// src/execution/assembly/host-mode.ts
//
// 主进程运行模式分类工具。
//
// 将 Pi 的 ExtensionMode（"tui"|"rpc"|"json"|"print"）聚合为业务语义的
// HostMode（"tui"|"gui"|"headless"），供 session-runner 的 W4 提示词守卫、
// handler 工厂分流、stdio 选择等消费点统一调用。
//
// 判定依据见 AGENTS.md「运行时环境区分」章节 +
// docs/extensions/tui-rendering-pitfalls.md 第四部分第 8 节。
// ExtensionMode 来自 Pi 源码 packages/coding-agent/src/core/extensions/types.ts:299
// （dist 中 core/extensions/types.d.ts:207）。
//
// 设计动机（.fix-plans/00-master-summary.md §一冲突 4）：
//   - 把散落多处的 `ctx.mode === "tui" || ctx.mode === "rpc"` 字面量比较
//     集中到单一修改点，未来 Pi 新增 mode 值时只改本文件。
//   - 业务语义命名（"gui"/"headless"）比原始枚举值更清晰表达意图。

// ExtensionMode 在 Pi SDK 的 core/extensions/types.d.ts 中定义为
// `"tui" | "rpc" | "json" | "print"`（ExtensionContext.mode 的类型），但未从包根
// 导出。这里定义与 SDK 同构的本地别名（ctx.mode 的字面量联合），由同包其他模块复用，
// 避免依赖未导出的内部类型。
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** 主进程运行模式分类。基于 ExtensionMode 聚合为业务语义。
 *  - "tui"：纯 Pi TUI，ctx.ui.custom 可用，用户在终端交互
 *  - "gui"：xyz-agent GUI，通过 rpc sidecar 通道与前端 Vue 组件交互
 *  - "headless"：无交互 UI 通道（json/print 输出模式，或 mode 未穿透） */
export type HostMode = "tui" | "gui" | "headless";

/** 从 ExtensionContext.mode 解析主进程模式分类。
 *  - "tui" → tui（纯 Pi TUI，ctx.ui.custom 可用）
 *  - "rpc" → gui（xyz-agent GUI，sidecar 通道可用）
 *  - "json"/"print"/undefined → headless（无交互通道）
 *
 *  undefined 归入 headless 是向后兼容：mode 未穿透 SessionRunnerContext 时
 *  按「无 UI」保守处理，避免误注入依赖 UI 的逻辑。 */
export function resolveHostMode(mode: ExtensionMode | undefined): HostMode {
  if (mode === "tui") return "tui";
  if (mode === "rpc") return "gui";
  return "headless"; // json/print/undefined
}

/** 主进程是否会响应子进程的 ask_user（UI 透传）。
 *  tui + gui 都会（冲突 3 裁决：TUI 必须注入 handler；GUI 透传所有 UI），
 *  headless 不会（无 UI 通道，注入 W4 提示词会误导 LLM）。 */
export function willRespondToAskUser(mode: ExtensionMode | undefined): boolean {
  const host = resolveHostMode(mode);
  return host === "tui" || host === "gui";
}

/** 主进程是否有交互 UI 通道（TUI 组件 / GUI sidecar）。
 *  非 headless 即有。用于 stdio 选择等不区分 tui/gui 的决策点。 */
export function hasInteractiveUI(mode: ExtensionMode | undefined): boolean {
  return resolveHostMode(mode) !== "headless";
}
