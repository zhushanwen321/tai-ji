// src/shared/agent-event.ts
//
// AgentEvent 类型唯一出口（两包合并后 import 收口）。
//
// 合并前 AgentEvent 分别定义在 execution/types.ts（subagents 侧）和
// orchestration/live/types.ts（workflow 侧）——两份定义完全一致但独立维护。
// 合并后本文件是单一 source of truth——re-export execution/types.ts 的 AgentEvent，
// orchestration 层通过本文件引用（替代 orchestration/live/types.ts 的旧副本）。
//
// wave-3 删 orchestration/live/types.ts 后，AgentEvent 的唯一定义在 execution/types.ts。
// 本 re-export 保持「shared/ 是类型共享层」的架构约定。

export type { AgentEvent } from "../execution/assembly/types.ts";
