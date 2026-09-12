// src/execution/lifecycle-predicates.ts
//
// v4 B-1 ExecutionStatus 两态收敛后的派生谓词。
//
// 旧三态（running/idle/cancelled）折为两态（running/closed）后，「对话模式等待续聊」
//（旧 idle）和「正在执行」都是 status="running"，需派生谓词区分。谓词复用已有
// lifecycle-manager.hasIdleTimer（idle timer 是否 armed）与 core 侧 spawnedChildren
// 状态镜像读点（engine/host/spawned-children.ts，活进程句柄是否存在），不新增状态记账。
//
// 两种 running 子态（v4 B-1；[H1 U6 后现状] 长驻保活形态已退役——每轮 = 新进程，
// 轮末进程随 agent_settled 回收，权威注释见 run-orchestration.ts [H1 U6] 段）：
//   - 等待续聊（旧 idle）：轮完成后进程已回收 → isResumable=true（无活进程），
//     续聊走 deliverMessage 冷路径 resume（续写原 session 文件）。旧设计另有
//     「agent_settled arm idle timer 保活进程待热路径 prompt」一路——该 arm 链随
//     H1 U6 长驻退役失活：armIdleTimer 唯一生产接线在 createHostBridge
//     （host-bridge.ts，全仓无生产调用点），运行时 hasIdleTimer 恒 false，
//     故 isIdle 生产恒 false，notify 守卫（notify-host.ts）实际生效的放行谓词 =
//     closed 或 isResumable。isIdle 谓词保留 = 既有判据形态不删（语义变化/显式
//     idle 状态设计属独立议题，见 impl-plan Gate B 收口登记的 backlog）。
//   - 正在执行：isIdle=false、isResumable=false（有活进程）。

import { hasIdleTimer } from "./lifecycle-manager.ts";
// [W6 拆依赖] 活进程句柄读点改经 core 侧 spawnedChildren 状态镜像公共面
// （engine/host/spawned-children.ts），不再深路径 import inproc pi 引擎目录 内部——
// 行为不变（镜像 ∪ inproc 权威 map 并读，见该文件头注释的过渡桥语义）。
import { hasLiveProcessHandleCore } from "./engine/host/spawned-children.ts";
import type { ExecutionRecord } from "./types.ts";

/**
 * 活进程句柄是否存在（isResumable 子判据）。
 *
 * [W6] 改读 core 侧状态镜像（engine/host/spawned-children.ts 的 hasLiveProcessHandleCore：
 * 镜像项存在且未 killed = 有活进程句柄；迁移期内建 pi 的 inproc 权威 map 并读兜底）。
 * 轮末进程随 agent_settled 回收 / 被 kill 后镜像项置死或移除 = 无活进程
 * （等待续聊态 / 跨重启重建同理）。
 */
export function hasLiveProcessHandle(recordId: string): boolean {
  return hasLiveProcessHandleCore(recordId);
}

/**
 * 对话模式等待续聊态（旧 idle 收敛后的派生谓词）。
 *
 * 判据：该 record 有 armed idle timer（lifecycle-manager.hasIdleTimer）。
 *
 * [H1 U6 后现状] arm 链随长驻形态退役失活（armIdleTimer 唯一生产接线在
 * createHostBridge，全仓无生产调用点）——运行时本谓词恒 false，notify 守卫的
 * 轮次完成放行实际由 {@link isResumable} 承担。谓词保留为既有判据形态
 * （notify 合批 hasRunningBackground / 守卫散点消费），删除属语义变更待独立议题。
 */
export function isIdle(record: ExecutionRecord): boolean {
  return hasIdleTimer(record.id);
}

/**
 * 可冷路径 resume（running 且无活进程句柄）。
 *
 * 等待续聊态的现行判据（[H1 U6] 每轮 = 新进程、轮末即回收，完成的轮次天然无活
 * 进程句柄；跨重启重建同理）。deliverMessage 冷路径、GC、close action 的
 * 「无活进程立即终态化」分支据此判定。
 *
 * 与 {@link isIdle} 的关系：isIdle 生产恒 false（见其 JSDoc），本谓词是
 * 「等待续聊」唯一运行时生效的派生判据。
 *
 * [v4 A-6] 签名泛化为 Pick<"id"|"status">：ExecutionRecord（活态）与 SubagentRecord
 * （list 快照）均结构兼容——recordToListItem 据此为 list 输出派生 resumable 字段。
 */
export function isResumable(record: Pick<ExecutionRecord, "id" | "status">): boolean {
  return record.status === "running" && !hasLiveProcessHandle(record.id);
}
