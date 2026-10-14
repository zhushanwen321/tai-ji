/**
 * taiji GUI 宿主判定与画布工具的前置门（设计 §3.1(2) 宿主检测）。
 *
 * 谓词与 extensions/universal/plan/src/state.ts 的 isTaijiGuiHost 完整形态对齐
 * （env 信号 + ctx.mode === "rpc"）：env 只证明 taiji runtime 在上游，TUI / json /
 * print 形态宿主没有 marker 路由、select 会落终端 UI——单查 env 会在 env 泄漏到
 * 独立 pi 时误入 select 挂起（禁超时探测，对齐时间平抑红线：不做「挂起后超时
 * 回退」类时间窗兜底，门必须在 select 之前）。
 *
 * 不直接 import plan 包的实现：canvas 是 taiji 组独立包，plan 未导出该函数
 * （其 state.ts 是包内叶模块）——两处谓词的一致性由本注释与两侧登记互指维持；
 * 该 env 的双语义耦合登记 SSOT 在 plan state.ts（canvas 是登记注释列名的消费方），
 * 日志开关若按登记的退役条件拆专用宿主信号 env，本谓词与 plan 一并迁移。
 */

/** 宿主 env 信号（与 plan isTaijiHost 同一信号；每次调用时读，不缓存）。 */
export function isTaijiHost(): boolean {
  return process.env.TAIJI_AGENT_EXT_LOG === "1";
}

export interface GuiHostContextLike { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  mode: string;
}

/** taiji GUI 宿主完整谓词：env 信号 + rpc 模式（marker select 只在 rpc 宿主有路由）。 */
export function isTaijiGuiHost(ctx: GuiHostContextLike): boolean {
  return isTaijiHost() && ctx.mode === "rpc";
}

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
