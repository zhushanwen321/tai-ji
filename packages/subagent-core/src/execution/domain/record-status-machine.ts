// src/execution/domain/record-status-machine.ts
//
// permanent-session 两态状态机声明（state-machine-infrastructure D6-M2 迁移，
// 2026-10-20）——running/idle 全部 status 翻边写点的合法性判定收进基建机器：
// 词表 = ExecutionStatus 两态（本文件是词表与 record-types.ts 的对齐锚，
// satisfies 双向锁定）；errorPolicy: 'result'（表外拒绝返回 { ok:false }，
// 域内原语把它转成 return false——CAS 拒绝语义保形，不抛错）。
//
// 迁移范围（D6-M2 边界声明，翻边写点全集已逐 Impl 亲读核实）：
//   idle→running 翻边：
//     - enter-running   ← tryEnterRunning（reviveOrThrow 编排；不清收尾位）
//     - resurrect       ← resurrectClosed（markResurrected 内部 + subagent-service
//                          复活成员直调两个入口；清终态遗留位）
//     - round-started   ← markRoundStarted 的 idle 源支（翻边执行）
//   running→idle 翻边：
//     - settle-legacy-closed ← trySettleLegacyClosed（markFinalized/markCancelled
//                              路径的翻边真身，调用方先行）
//     - round-idle      ← markRoundIdle（轮终翻边）
//     - settle          ← markSettled（中断族轮收尾翻边）
//   双态 / 自环（不构成翻边的准入判定）：
//     - round-started   ← markRoundStarted 的 running 源支（幂等重申自环——合法
//                          轮始源态横跨 running ∪ idle，D6-M2 两行承载）
//     - reopened        ← markReopened（idle 态内世代推进原语——CAS 仅收 idle、
//                          成功后 record 仍 idle；翻边归调用链紧随的 tryEnterRunning）
//
// 机器管辖外（域内保留，显式排除——不写 status 的原语与直写通道）：
//   - markFinalized / markCancelled：纯持久化收尾，内存翻边由调用方
//     trySettleLegacyClosed 先行完成（本机器 settle-legacy-closed 事件承载）。
//   - completeLegacyClosed：跟随写（前置条件 = trySettleLegacyClosed 已抢锁置 idle）。
//   - markSettledOut：close 收尾写权/journal 清句，无 status 写点。
//   - markReconstructedStatus：磁盘重建直写（重建是「初始态确定」不是「转移」，
//     state-machine-infrastructure 待验证检查点 2 豁免登记）。
//   - endedAt 终态冻结门（markRoundStartedImpl / markRoundIdleImpl）：throw 语义，
//     endedAt 不是 ExecutionStatus 的函数、两态词表表达不了——留原语层、先于
//     机器判定执行（false 与 throw 是两种拒绝形态，不折算混同）。
//   - 出生构造：createRecord 的 status:"running" 字面量与重建占位直写不经机器
//     （initial/占位承载、非转移判定，对照归档单元 initial: 'staging' 同款表述）。
//
// 终局原语族（closedReason 终局修饰 + binding 写盘编排）留域内：closedReason 是
// 状态修饰字段不是机器状态，进机器须把词表扩为多维、超出「两态直译」——翻边写点
// 先经机器判定再赋值（CAS 前置语义直译），重开原语不发翻边事件。

import { defineStateMachine } from "@zhushanwen/state-machine";
import type { StateSpec } from "@zhushanwen/state-machine";
import type { ExecutionStatus } from "./record-types.ts";

// 词表对齐锚：键集与 ExecutionStatus 两态互为穷举（satisfies 双向 excess check），
// record-types.ts 加态时此处编译报错——机器词表漂移的静态防线。
const STATUS_STATES = {
  running: {},
  idle: {},
} as const satisfies Record<ExecutionStatus, StateSpec>;

export const permanentSessionStatusMachine = defineStateMachine({
  name: "permanent-session-status",
  states: STATUS_STATES,
  // 出生构造不经机器（createRecord status:"running" 字面量直写）；initial 只承载
  // 声明完整性，record 诞生即 running。
  initial: "running",
  events: {
    "enter-running": {},
    resurrect: {},
    "round-started": {},
    "settle-legacy-closed": {},
    "round-idle": {},
    settle: {},
    reopened: {},
  },
  transitions: [
    // idle → running 翻边（单向 CAS——非 idle 源一律表外拒绝，原语转 return false）
    { from: "idle", on: "enter-running", to: "running" },
    { from: "idle", on: "resurrect", to: "running" },
    // markRoundStarted 双态可达：idle 源 = 翻边执行；running 源 = 幂等重申自环
    //（两行 from 不同，不触「同 (from,on) 多行须全带 guard」规则——D6-M2 裁决）
    { from: "idle", on: "round-started", to: "running" },
    { from: "running", on: "round-started", to: "running" },
    // running → idle 三写点（非 running 源一律表外拒绝）
    { from: "running", on: "settle-legacy-closed", to: "idle" },
    { from: "running", on: "round-idle", to: "idle" },
    { from: "running", on: "settle", to: "idle" },
    // markReopened 准入自环行：不翻边（成功后 record 仍 idle），与翻边判定同词表
    // 同构——留域内 CAS 即双轨，故进机器（from idle to idle）
    { from: "idle", on: "reopened", to: "idle" },
  ],
  errorPolicy: "result",
});
