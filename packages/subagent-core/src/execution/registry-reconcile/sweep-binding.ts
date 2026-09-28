// src/execution/registry-reconcile/sweep-binding.ts
//
// SubagentService 与注册表对账 sweep（reconcile-sweep.ts）的装配绑定面。
//
// 从 subagent-service.ts 抽出的纯绑定代码（max-lines 纪律）：sweep 的 store 读侧
// 判据闭包 + FileRunStore 判据供给内聚本文件，机制与语义注释见 reconcile-sweep.ts。
// 变化轴：改 sweep 的 store 读侧判据只动本文件。
//
// 全部依赖经 ReconcileSweepBinding 惰性闭包注入（session 级状态运行时可变——
// 对齐 notify-host.ts createNotifyHost 的 deps 惰性求值先例）。

import { bestEffort } from "../assembly/best-effort.ts";
import { isLegacyClosedSettled } from "../persistence/execution-record.ts";
import { FileRunStore } from "../../orchestration/file-run-store.ts";
import { resolvePiWorkflowStateDir } from "../assembly/workflow-state-root.ts";
import type { PiLike } from "../notify/notify-host.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { runReconcileSweep } from "./reconcile-sweep.ts";

/** 绑定面（SubagentService 供给；全部惰性——见文件头注）。 */
export interface ReconcileSweepBinding { // oe-exempt:20260928:framework:sweep 依赖注入面 ports 契约先立——生产实现经 SubagentService 单点装配，测试 fake 为第二变体
  getStore(): RecordStore;
  getPi(): PiLike | null;
  /** 主 session 文件（sweep 差集输入源；未 flush/未知时 undefined = 空跑）。 */
  getMainSessionFile(): string | undefined;
}

/**
 * 注册对账 sweep（发射点枚举⑤）：对「本 session register entry × 对应
 * record/run ∈ 终态集 ∪ 已离场/不存在」差集补发 unregister——appendEntry 权威落盘
 * （唯一写路径，不经 emit——写法论证见 reconcile-sweep.ts 头注）。[F2] 判据按类型
 * 分流：subagent 走 RecordStore，workflow/畸形走 FileRunStore（findSettlementEvidenceSync——[W2/V1 D6] 判据源改接 fold/manifest 终态证据），
 * bash 无收口通道保守跳过（显式偏差 impl-plan §5）。触发点 = initSession（session
 * reattach / session_start 时机，根进程 only——与孤儿恢复同一单扫描者判据，
 * isChildProcess 由调用方传）。与 registry rebuild 的先后时序不作保证，残余窗口由
 * 下次 session_start 收口（设计明示容忍）。
 */
export function runPendingReconcileSweepForService(binding: ReconcileSweepBinding, isChildProcess: boolean): void {
  if (isChildProcess) return;
  try {
    // [F2] workflow run 判据供给：FileRunStore 构造轻量（无 IO 副作用，lastSavedAt
    // 空 Map——findSettlementEvidenceSync 同步只读不触碰节流记账），sweep 挂点低频
    // （initSession），每轮构造一次闭包持有。
    // [F-1 修复] stateDir 必须与 pi 壳 JsonlRunStore 的落盘布局同源
    //（<sessionDir>/workflow-state/，推导 = resolvePiWorkflowStateDir）；缺省根
    // <dataRoot>/workflow-state 是 zcode 宿主布局，与 pi 生产落盘不相交——曾致
    // findSettlementEvidenceSync 两证据面恒 missing → sweep 按终态补注销活跃 run（装配错位事故）。
    const workflowStore = new FileRunStore({ stateDir: resolvePiWorkflowStateDir() });
    runReconcileSweep({
      sessionFile: binding.getMainSessionFile(),
      lookupRecordState: (id) => {
        // [W2/V3 D5 桥接判据收敛] 旧「closed 终态」读判定 ⟺ isLegacyClosedSettled（唯一
        // 权威谓词）。[two-state-convergence U4] 轮终翻边 idle（无 closedReason）归 active
        // ——sweep 对账面行为不变（轮终注销已随 markRoundIdle 簿记⑧发射，不在册）。
        const memory = binding.getStore().getMutable(id);
        if (memory !== undefined) {
          return isLegacyClosedSettled(memory)
            ? { terminal: true, closedReason: memory.closedReason }
            : "active";
        }
        const disk = binding.getStore().findLightById(id);
        if (disk === undefined) return "missing";
        return isLegacyClosedSettled(disk)
          ? { terminal: true, closedReason: disk.closedReason }
          : "active";
      },
      // [F2] type=workflow 及畸形条目的收口判据（设计 D2 sweep 判据补全——
      // 「终态集 ∪ 已离场/不存在」对 workflow run 同样成立）。
      // [W2/V1 D6 判据源改接] 判据源 = journal run-settled 帧 ∨ manifest 终局面
      //（findSettlementEvidenceSync）——两态机持久化快照字段退役（活体写点删除后
      // v2 run 的 state 快照永停 running，旧判据对全部 v2 run 永判 active = sweep
      // 结构性静默失效）。判定矩阵保守侧（非终态/坏链/IO 故障均保守按活跃，不误
      // 注销）内聚在判据方法内；terminal 的 reason 已按 [W2 D5] 联合派生单点产出
      //（budget_limited/time_limited 细分保留）。
      lookupWorkflowRunState: (runId) => {
        const state = workflowStore.findSettlementEvidenceSync(runId);
        if (state.kind === "missing") return "missing";
        if (state.kind === "terminal") return { terminal: true, closedReason: state.reason };
        return "active";
      },
      appendEntry: (customType, data) => binding.getPi()?.appendEntry(customType, data),
    });
  } catch (err) {
    bestEffort(err, "pending reconcile sweep", "error");
  }
}
