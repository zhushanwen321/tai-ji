// src/execution/lifecycle/lifecycle-predicates.ts
//
// 执行状态派生谓词。
//
// [U2 两态迁移] 永久会话模型状态机 = running | idle（终态概念删除）；本文件谓词
// 的「两态（running/closed）」语境自 v4 B-1 演化而来——「对话模式等待续聊」与
// 「正在执行」曾同为 status="running" 靠派生谓词区分；U2 后「等待续聊」的权威
// 词汇 = idle（markSettled 收口），谓词保留 = 既有判据形态不删（桥接期消费方
// 零改动；显式 idle 状态设计归后续单元）。谓词复用 lifecycle-manager.hasIdleTimer
// （idle timer 是否 armed）与 core 侧 spawnedChildren 状态镜像读点
// （engine/host/spawned-children.ts，活进程句柄是否存在），不新增状态记账。
//
// 两种 running 子态（v4 B-1；[H1 U6 后现状] 长驻保活形态已退役——每轮 = 新进程，
// 轮末进程随 agent_settled 回收，权威注释见 run-orchestration.ts [H1 U6] 段）：
//   - 等待续聊：轮完成后进程已回收 → U4 翻边后轮终真实写 idle（isResumable 即
//     idle 派生，[U5/D4]），续聊走 deliverMessage 冷路径 resume（续写原 session
//     文件）。chat 轮终经 armIdleKeepalive（conversation-continuation.ts，
//     [u7a 补挂] 唯一生产 arm 接线）挂 idle timer 保活 → isIdle=true——超时处置 =
//     RecordLifecycle.idleTimeoutRecycle（[U5] 进程回收，不动意愿位/占用位）。
//     notify 守卫（notify-host.ts）的放行谓词 = 旧终态遗留（idle ∧ closedReason
//     有值，U2 桥接判据）/ [U5] archived（归档提示载荷）或 isResumable（idle）。
//   - 正在执行：isIdle=false、isResumable=false（running 直读为假）。

import { hasIdleTimer } from "./lifecycle-manager.ts";
// [W6 拆依赖] 活进程句柄读点改经 core 侧 spawnedChildren 状态镜像公共面
// （engine/host/spawned-children.ts），不再深路径 import inproc pi 引擎目录 内部——
// 行为不变（镜像 ∪ inproc 权威 map 并读，见该文件头注释的过渡桥语义）。
import { hasLiveProcessHandleCore } from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../assembly/types.ts";

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
 * [u7a 补挂后现状] arm 链已复活（chat 轮终 armIdleKeepalive——轮终保活，超时 =
 * [U5] idleTimeoutRecycle 进程回收），本谓词生产可真：closeSubagent 的「无在跑轮」
 * 分流（Path A timer armed）与 notify 合批 hasRunningBackground 消费。
 */
export function isIdle(record: ExecutionRecord): boolean {
  return hasIdleTimer(record.id);
}

/**
 * 可续聊态（[two-state-convergence U5/D4] idle 派生——「idle 即 resumable」的
 * 单一权威实现）。
 *
 * [U5 判据迁移] 旧判据「running 且无活进程句柄」依赖 U4 已退役的轮终桥接形态
 * （轮终现已真实写 idle）；新判据 = status 直读。消费方行为变化（设计 D4 数据级
 * 已裁决）：idle-GC 候选从「running 桥接形态」扩张到全部 idle（含中断族 idle、
 * `.state` 重建 idle——范围扩张已接受）；W4 死亡纳管态（running）自然退出 GC
 * 候选（supervisor 接管链 settle 后落 idle 回到候选集）。notify-host 放行子句中
 * 本谓词被 `status !== 'idle'` 前置子句短路吸收（冗余但无害）。
 *
 * [v4 A-6] 签名泛化为 Pick<"id"|"status">：ExecutionRecord（活态）与 SubagentRecord
 * （list 快照）均结构兼容。
 */
export function isResumable(record: Pick<ExecutionRecord, "id" | "status">): boolean {
  return record.status === "idle";
}
