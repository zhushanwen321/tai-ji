// src/execution/engine/host-task-spec.ts
//
// ExecuteOptions → AgentCallOpts 的宿主侧最小正向映射（U0：chat 工具域引擎分支）。
//
// [D6 任务形状合流] 产出类型从原 AgentTaskSpec 改为合流形状 AgentCallOpts（单一任务
// 形状，EnginePort.run 入参——原 AgentTaskSpec 已删除）。字段映射是 ExecuteOptions →
// AgentCallOpts 的中立直译（prompt=task 正文、description=slug 短标签；agent/model/
// thinkingLevel/skillPath/appendSystemPrompt/schema/maxTurns/graceTurns/worktree/cwd
// 同名透传）。不 import 任何具体引擎模块（registry.ts 依赖方向纪律：上层按中立类型
// 组装声明，引擎细节归引擎）。
//
// schema 只传本体（budgetFields）：PI_WORKFLOW_SCHEMA env 值由引擎侧从 wire task.schema
// 派生（H1 schema 传输归位），宿主侧无 env 预编码通道——chat 域与 workflow 域同源，
// 不存在两个取值源。
//
// fork 族在调用本 mapper 前已被 capability-gate 预检拒绝（[D3-④]
// capabilities 驱动的调用前拒绝，非 pi 引擎 unsupported），透传仅保持映射完整性——
// 未来引擎支持时无需改本函数。forkFromSessionFile 同属预检面（fork 通道族同判据），
// 透传语义相同：pi 引擎经协议 task.forkSource 消费（--fork 载体，fork-from 断联恢复），
// zcode 引擎被 gate 拒绝不会到达。（[modeless 波5 收尾] conversation 派发参数已删，
// 原对话参数预检面随之退役。）

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { ExecuteOptions } from "../assembly/types.ts";

/** 纯函数：ExecuteOptions（chat 域执行选项）→ 合流任务声明 AgentCallOpts。无副作用、幂等。 */
export function executeOptionsToEngineTaskSpec(opts: ExecuteOptions): AgentCallOpts {
  return {
    prompt: opts.task,
    ...identityFields(opts),
    ...budgetFields(opts),
    ...deliveryFields(opts),
    // 运行期字段（signal/ctxModel）不入声明——归 RunContext（port.ts 删字段去向）。
  };
}

/** 声明面基础字段（slug/agent/model/thinkingLevel/skillPath/appendSystemPrompt 同名透传）。 */
function identityFields(opts: ExecuteOptions): Partial<AgentCallOpts> {
  return {
    ...(opts.slug !== undefined ? { description: opts.slug } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.skillPath !== undefined ? { skillPath: opts.skillPath } : {}),
    ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  };
}

/** 约束面字段（schema/maxTurns/graceTurns 同名透传）。 */
function budgetFields(opts: ExecuteOptions): Partial<AgentCallOpts> {
  return {
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.graceTurns !== undefined ? { graceTurns: opts.graceTurns } : {}),
  };
}

/** 运行载体字段（fork 族 / worktree / cwd / idleTimeoutMs 同名透传）。 */
function deliveryFields(opts: ExecuteOptions): Partial<AgentCallOpts> {
  return {
    ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
    // fork-from 源 session 文件（W3 断链修复：协议化后唯一 lossless 载体回到本映射）。
    // 唯一改名点：ExecuteOptions.forkFromSessionFile → 中立任务形状 forkSource
    // （与 SDK 协议字段、引擎侧 SpawnRunParams.forkSource 三层同名）。
    ...(opts.forkFromSessionFile !== undefined ? { forkSource: opts.forkFromSessionFile } : {}),
    ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  };
}
