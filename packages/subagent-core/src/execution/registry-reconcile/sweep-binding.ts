// src/execution/registry-reconcile/sweep-binding.ts
//
// SubagentService 与注册表对账 sweep（reconcile-sweep.ts）的装配绑定侧。
//
// 从 subagent-service.ts 抽出的纯绑定代码（max-lines 纪律）：sweep 的 store 读侧
// 判据闭包内聚本文件（workflow 判据经共享判定核 findRunSettlementEvidence，
// [U1] 判定核抽取），机制与语义注释见 reconcile-sweep.ts。
// 变化原因：改 sweep 的 store 读侧判据只动本文件。
//
// 全部依赖经 ReconcileSweepBinding 惰性闭包注入（session 级状态运行时可变——
// 对齐 notify-host.ts createNotifyHost 的 deps 惰性求值先例）。

import { bestEffort } from "../assembly/best-effort.ts";
import { isLegacyClosedSettled } from "../persistence/execution-record.ts";
import { findRunSettlementEvidence, type RunSettlementEvidence } from "../persistence/run-state-evidence.ts";
import { resolvePiWorkflowRunsDir } from "../assembly/workflow-state-root.ts";
import type { SettlementReason } from "../../shared/run-vocabulary.ts";
import type { PiLike } from "../notify/notify-host.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { runReconcileSweep, type SupervisedRecordState } from "./reconcile-sweep.ts";

/**
 * [D16⑤] 判定核三态 → sweep 的 SupervisedRecordState 映射（生产装配与判定
 * 矩阵测试共用同一份——两份手抄会漂移）。
 *
 * manifest 面 reason 换源：判定核 terminal.reason 经 runSettledOutcomeToDoneReason
 * 穷尽 switch 派生——词表内值（[D2] 四值）恒派生非 undefined；词表外历史值
 * （旧写入方 manifest outcome=interrupted 族——文件名未随 [D1] 迁移，磁盘可达）
 * 的折叠收敛在派生函数单点（default 分支折 "failed"，W2 D5 先例「interrupted →
 * failed 诊断兜底容器」：中断形态注销 reason 报 completed 是完成语义误报），
 * 本消费方零处理直传（reason 恒 string，不落 reconcile-sweep
 * settlementReasonToPendingReason 的 completed 兜底）。
 */
export function settlementEvidenceToRunState(state: RunSettlementEvidence): SupervisedRecordState {
  if (state.kind === "missing") return "missing";
  if (state.kind === "terminal") {
    return { terminal: true, settlementReason: state.reason };
  }
  return "active";
}

/**
 * [subagent-observability §3.3.4/§3.3.6 失联结清判定位] 轮收条停因 → 失联结清态
 * （reconcile-sweep 直通族的「在途被重启打断 → lost」事实判定位，走查补）：轮收条
 * 已写且停因 = 宿主重启打断族（interrupted-by-restart——u3 失联清点的轮收条补写值，
 * 也是崩溃重建单规则的无收条回落值）→ 该 record 的在途轮被宿主重启打断，其 pending
 * 债未经轮终发射点②结清 → 补结清为 lost（失联）。正常轮终（completed/failed——
 * 结清已随轮终发射点②完成）与其余形态归 active 不动。
 * 返回 undefined = 非失联形态（调用方回落既有分流）。
 *
 * 注：结清值 lost 的类型防线 = 返回值显式 SettlementReason 词表（shared/run-vocabulary
 * ALL_SETTLEMENT_REASONS 封闭五值）——"lost" 是结清枚举成员而非 ClosedReason 词表成员，
 * 词表归属在类型层表达，拼错值编译期报错。经 settlementReasonToPendingReason 直通为
 * 注销 reason，历史六值通道 mapReasonToStatus 对 lost 落 unknown（fail-visible 如实），
 * 新权威通道 resolveSettlementReason("lost") 原样解析（双通道以新写入方为权威，§3.3.6）。
 */
function lostSettlementOf(
  stopReason: string | undefined,
): { terminal: true; settlementReason: SettlementReason } | undefined {
  return stopReason === "interrupted-by-restart"
    ? { terminal: true, settlementReason: "lost" }
    : undefined;
}

/** 绑定侧（SubagentService 供给；全部惰性——见文件头注）。 */
export interface ReconcileSweepBinding { // oe-exempt:20260928:framework:sweep 依赖注入范围 ports 契约先立——生产实现经 SubagentService 单点装配，测试 fake 为第二变体
  getStore(): RecordStore;
  getPi(): PiLike | null;
  /** 主 session 文件（sweep 差集输入源；未 flush/未知时 undefined = 空跑）。 */
  getMainSessionFile(): string | undefined;
  /** 当前 rootSessionId（run 域 state 目录分区键；initSession 后即有值）。 */
  getRootSessionId(): string;
}

/**
 * 注册对账 sweep（发射点枚举⑤）：对「本 session register entry × 对应
 * record/run ∈ 终态集 ∪ 已离场/不存在」差集补发 unregister——appendEntry 权威落盘
 * （唯一写路径，不经 emit——写法论证见 reconcile-sweep.ts 头注）。[F2] 判据按类型
 * 分流：subagent 走 RecordStore，workflow/畸形走共享判定核（findRunSettlementEvidence——[W2/V1 D6] 判据源改接 journal/manifest 终态证据），
 * bash 无收尾通道保守跳过（显式偏差 impl-plan §5）。触发点 = initSession（session
 * reattach / session_start 时机，根进程 only——与孤儿恢复同一单扫描者判据，
 * isChildProcess 由调用方传）。与 registry rebuild 的先后时序不作保证，残余窗口由
 * 下次 session_start 收尾（设计明示容忍）。
 */
export function runPendingReconcileSweepForService(binding: ReconcileSweepBinding, isChildProcess: boolean): void {
  if (isChildProcess) return;
  try {
    // [U1 判定核抽取] workflow run 判据供给改调共享判定核 findRunSettlementEvidence
    //（journal 尾向 + manifest 第二证据 + 保守矩阵，单源注释在
    // persistence/run-state-evidence.ts）——判定核以 stateDir 直接参数化。
    // 目录解析每轮 sweep 一次、闭包内复用。
    // [F-1 修复] stateDir 必须与 pi 壳 JsonlRunStore 的落盘布局同源
    //（`<root>/<rootSid>/workflow/runs/`，推导 = resolvePiWorkflowRunsDir——
    //[session-store-layout-inversion D2/D3] 分区键 rootSessionId 经 binding 注入）
    // ——与 pi 生产落盘不相交的目录会致判据两证据面恒 missing → sweep 按终态补注销
    // 活跃 run（装配错位事故）。
    const workflowStateDir = resolvePiWorkflowRunsDir(binding.getRootSessionId());
    runReconcileSweep({
      sessionFile: binding.getMainSessionFile(),
      lookupRecordState: (id) => {
        // [W2/V3 D5 桥接判据收敛] 旧「closed 终态」读判定 ⟺ isLegacyClosedSettled（唯一
        // 权威谓词）。[two-state-convergence U4] 轮终翻边 idle（无 closedReason）归 active
        // ——sweep 对账面行为不变（轮终注销已随 markRoundIdle 簿记⑧发射，不在册）。
        const memory = binding.getStore().getMutable(id);
        if (memory !== undefined) {
          if (isLegacyClosedSettled(memory)) {
            return { terminal: true, settlementReason: memory.closedReason };
          }
          return lostSettlementOf(memory.stopReason) ?? "active";
        }
        const disk = binding.getStore().findLightById(id);
        if (disk !== undefined) {
          if (isLegacyClosedSettled(disk)) {
            return { terminal: true, settlementReason: disk.closedReason };
          }
          return lostSettlementOf(disk.stopReason) ?? "active";
        }
        // [W4 收敛] v2 收编 record 的第三级判据：v1 磁盘读侧（findLightById）不含
        // 收编产物（events 帧 + manifest 派生视图），无本级时收编 record 落 missing 分支
        // 被误注销为 expired——注销词统一手术的修复点（与 run 侧 D6 判据源改接
        // findRunSettlementEvidence 同构：判据接终局证据，不接两态机持久化字段）。
        // [subagent-observability u3] 收编停因 = 宿主重启打断族（interrupted-by-restart）
        // → 结清值 lost（失联结清判定位同款事实——收编 record 的在途轮同被重启打断，
        // 债未经轮终发射点②结清）；其余收编停因维持直通。
        const adoptedStopReason = binding.getStore().findAdoptedStopReasonSync(id);
        if (adoptedStopReason !== undefined) {
          return lostSettlementOf(adoptedStopReason) ?? { terminal: true, settlementReason: adoptedStopReason };
        }
        return "missing";
      },
      // [F2] type=workflow 及畸形条目的收尾判据（设计 D2 sweep 判据补全——
      // 「终态集 ∪ 已离场/不存在」对 workflow run 同样成立）。
      // [W2/V1 D6 判据源改接] 判据源 = journal run-settled 帧 ∨ manifest 终局条目
      //（经 [U1] 共享判定核 findRunSettlementEvidence）——两态机持久化快照字段
      // 退役（活体写点删除后 v2 run 的 state 快照永停 running，旧判据对全部 v2
      // run 永判 active = sweep 结构性静默失效）。判定矩阵保守侧（非终态/坏链/
      // IO 故障均保守按活跃，不误注销）内聚在判定核内；terminal 的 reason 已按
      // [W2 D5] 联合派生单点产出（budget_limited/time_limited 细分保留）。
      lookupWorkflowRunState: (runId) =>
        settlementEvidenceToRunState(findRunSettlementEvidence(workflowStateDir, runId)),
      appendEntry: (customType, data) => binding.getPi()?.appendEntry(customType, data),
    });
  } catch (err) {
    bestEffort(err, "pending reconcile sweep", "error");
  }
}
