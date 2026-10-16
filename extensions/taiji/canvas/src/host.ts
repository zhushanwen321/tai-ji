/**
 * taiji GUI 宿主判定与画布工具的前置门（设计 §3.1(2) 宿主检测）。
 *
 * 谓词单点在 @zhushanwen/pi-ext-guards（isTaijiGuiHost：env 信号 + ctx.mode === "rpc"
 * ——env 只证明 taiji runtime 在上游，TUI / json / print 形态宿主没有 marker 路由、
 * select 会落终端 UI，单查 env 会在 env 泄漏到独立 pi 时误入 select 挂起；禁超时
 * 探测，对齐时间平抑红线：不做「挂起后超时回退」类时间窗兜底，门必须在 select 之前）。
 * 本模块 re-export 供六工具与组合根共门 import；env 的双语义耦合登记 SSOT 与拆分
 * 迁移约束见 ext-guards 谓词分节注释（dmg-r1-7：自本文件与 plan state.ts 双实现收敛，
 * 一致性由构造保证，不再靠注释互指）。
 */

export { isTaijiGuiHost } from "@zhushanwen/pi-ext-guards";

/** 非 taiji GUI 宿主的结构化错误（设计：返回「画布需要 taiji 宿主」，不进入 select）。 */
export function hostGateError(): Error {
  return new Error(
    [
      "canvas_unavailable_host: 画布需要 taiji 宿主。",
      "当前运行环境不是 taiji GUI 托管的 pi（缺 TAIJI_AGENT_EXT_LOG=1 或 ctx.mode 非 rpc），",
      "画布工具依赖 taiji runtime 的 marker 路由与 CanvasService，独立 pi CLI 下不可用。",
      "恢复动作：在 taiji 桌面应用的会话中使用画布工具；纯 pi 环境请直接以对话方式规划。",
    ].join(""),
  );
}
