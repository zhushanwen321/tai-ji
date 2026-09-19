// src/execution/round-supervisor/reconcile-sweep.ts
//
// [W4] 注册对账 sweep——Plane E pending entry 死亡窗口对账 + ①段直落失败的窄竞态
// 窗兜底（reload-closeout D5 正名：触发点/对账逻辑零改动，职责声明按真实章程）。
//
// 设计锚点：D2「注册对账 sweep」（R2 增补、R3 钉死判据与写法）+ reload-closeout
// D4/D5（兜底归位：finalizeRun 直落承担注销主路径后，sweep 从「静默丢唯一兜底」
// 降回死亡窗口兜底）。
//
// 兜底的两类窗口：
// 1. 进程死亡（kill-9）：finalizeRun 未跑、无直落，注销 entry 永久缺位；
// 2. 直落失败窄竞态：finalizeRun 的 appendEntry 撞 reload 转换窗 assertActive
//    抛错（OR-4 围栏留痕后放行），差集残留到本 sweep 收口。
//
// 补发机制：对「本 session 的 register entry × 对应 record 状态 ∈ 终态集 ∪ record
// 已离场/不存在」的差集补发 unregister。**已离场**（archive 从内存移除、磁盘有
// finalized sidecar → 读侧重建 closed）与**不存在**（畸形条目对不上任何 record）
// 同视同终态——「查不到即补注销」判据兜底链才闭合。与 finalizeRun 直落互斥幂等：
// 直落后 id 不再 active，本 sweep 差集为空；直落失败时差集仍在，本 sweep 收口。
//
// 写法钉死（照 base-tool-enhance/src/background/pending-reconcile.ts 终态写法
// 先例）：**appendEntry 即唯一权威路径，不经 emit**——appendEntry 同步入账且不
// 依赖 listener 存活，差集消费方（goal 守卫 / pending_notifications 工具）全部从
// 持久化 entries 现算，appendEntry 对其直接生效。历史上并存过「尽力 emit 同步
// listener 内存视图」的第二写路径，随 listener 侧内存 registry 机制删除（对 entries
// 现算 isPendingActive 后，emit 到达时该 id 必已注销 = 恒 no-op 死路径）一并删除
// （与 finalizeRun emit 发射点删除同款论证）。
//
// 触发时机：session reattach / session_start / 监督器启动（由 subagent-service 在
// initSession 链内调用）。与 session_start 的 registry rebuild 先后时序不作保证，
// 残余窗口由下次 session_start 收口（设计明示容忍）。
//
// 判据保守性（[F2] 按类型分流收口）：
//  - type=subagent → record 差集对账（lookupRecordState）；
//  - type=workflow 及缺失/未知的畸形条目（normalizePendingType 归 workflow 的偏好）
//    → workflow run 判据（lookupWorkflowRunState，生产装配查 WorkflowRun store 的
//    run state 文件）：终态 ∪ 文件不存在 → 补注销；running → 跳过；全部行损坏
//    （读不出 ≠ 不存在）由判据侧保守按 running 处理（宁挂账不失明——误注销活跃
//    workflow run 是事故方向）。deps 未注入该判据时维持旧保守跳过（向后兼容）。
//  - type=bash → 无 record/store 可查（bash 注册随进程退出注销，进程死亡窗口的
//    丢失无补发通道）→ 保守跳过，显式偏差登记（impl-plan §5 #5）：挂账方向代价 =
//    每孤儿 bash 注册 1 条静态虚报，无空转驱动源（goal 守卫读侧过滤已使子 session
//    不受污染，本 session 虚报 defer 由熔断限损）。

import * as fs from "node:fs";

import { mapReasonToStatus, PENDING_UNREGISTER_ENTRY_TYPE } from "@zhushanwen/extension-protocol";

import { getLogger } from "../../core/logger.ts";

const logger = getLogger("subagents");

/** sweep 的 record 状态判据（subagent-service 供 store 读侧：内存 getMutable ∪
 *  磁盘 findLightById 两级）。 */
export type SupervisedRecordState =
  /** 活跃（真在跑 / [two-state-convergence U4] 轮终翻边 idle——sweep 只对账
   *  pending-notifications registry，轮终 record 的注销已随 markRoundIdle 簿记⑧
   *  发射、不在册，保守归 active 不动）——不动。 */
  | "active"
  /** 终态（closed，含 closedReason——映射 pending reason 用）。 */
  | { terminal: true; closedReason: string | undefined }
  /** 已离场/不存在（视同终态，补注销）。 */
  | "missing";

/** sweep 依赖注入（全部单测可替身）。 */
export interface ReconcileSweepDeps {
  /** 主 session 文件（差集输入源）。undefined = 无法读取，本轮空跑。 */
  sessionFile: string | undefined;
  /** record 状态判据（见 SupervisedRecordState）。 */
  lookupRecordState: (id: string) => SupervisedRecordState;
  /**
   * [F2] workflow run 状态判据（type=workflow 及畸形条目的收口依据）。生产装配查
   * WorkflowRun store（service-binding → FileRunStore.findStateByIdSync）。
   * 缺省（未注入）= workflow/畸形条目无收口通道，保守跳过（skippedNonSubagent）。
   */
  lookupWorkflowRunState?: (runId: string) => SupervisedRecordState;
  /** 权威写（pi.appendEntry）。缺失（dispose 后）= 本轮只判不写。 */
  appendEntry?: (customType: string, data: unknown) => void;
}

/** sweep 结果（日志 + 测试断言面）。 */
export interface ReconcileSweepResult {
  /** 补发 unregister 的注册 id。 */
  reconciled: string[];
  /** 差集内但判据为活跃（record/run running）而保守跳过的注册 id。 */
  skippedActive: string[];
  /** 差集内无收口通道而保守跳过的注册 id（bash；或 deps 未注入 workflow 判据时
   *  的 workflow/未知类型——显式偏差面，见文件头注 bash 段）。 */
  skippedNonSubagent: string[];
}

/**
 * 执行一次对账 sweep。同步（fs 读 + appendEntry 均同步，session_start 链内毫秒级）。
 * 幂等：重复执行时已补发的 id 有 unregister entry 抵消，差集不再出现。
 */
export function runReconcileSweep(deps: ReconcileSweepDeps): ReconcileSweepResult {
  const result: ReconcileSweepResult = {
    reconciled: [],
    skippedActive: [],
    skippedNonSubagent: [],
  };
  if (!deps.sessionFile) return result;

  const activeRegisters = collectActiveRegisterEntries(deps.sessionFile);
  for (const entry of activeRegisters) {
    sweepSingleRegister(deps, entry, result);
  }
  if (result.reconciled.length > 0) {
    // WARN 收口日志 = ①②④发射点残差/直落失败的观测通道（reload-closeout D4 覆盖
    // 判定：频次即残差兑现频率，日收口条数持续 > 个位数 → 按 D4 同款直落扩展）。
    logger.warn(
      `[subagents] reconcile sweep reconciled ${result.reconciled.length} unregister(s) for terminal/missing records: ${result.reconciled.join(",")}`,
    );
  }
  return result;
}

/**
 * 差集单条对账（保守性分流 [F2]）：按注册类型选收口判据——subagent 走 record 差集；
 * workflow/畸形（normalizePendingType 归 workflow 偏好）走 workflow run 判据；bash 无
 * record/store 可查，保守跳过（显式偏差，头注 bash 段）。
 */
function sweepSingleRegister(
  deps: ReconcileSweepDeps,
  entry: ActiveRegisterEntry,
  result: ReconcileSweepResult,
): void {
  const id = entry.id;
  if (entry.type === "bash") {
    result.skippedNonSubagent.push(id);
    return;
  }
  const state = entry.type === "subagent"
    ? deps.lookupRecordState(id)
    : deps.lookupWorkflowRunState?.(id);
  if (state === undefined) {
    // deps 未注入 workflow 判据：无收口通道，保守跳过（向后兼容——判据注入面
    // 缺席 ≠ 条目可注销）。
    result.skippedNonSubagent.push(id);
    return;
  }
  if (state === "active") {
    result.skippedActive.push(id);
    return;
  }
  appendUnregisterEntry(deps, id, state, result);
}

/** 补发单条 unregister：appendEntry 权威落盘（唯一写路径，不经 emit——论证见文件头注）。 */
function appendUnregisterEntry(
  deps: ReconcileSweepDeps,
  id: string,
  state: Exclude<SupervisedRecordState, "active">,
  result: ReconcileSweepResult,
): void {
  const reason =
    state === "missing" ? "expired" : closedReasonToPendingReason(state.closedReason);
  // 权威路径：直接 appendEntry 落盘。status 经 protocol mapReasonToStatus 单点映射
  // （与 pending-notifications listener / finalizeRun 直落 / bte 对账同一函数）——
  // 原 `status: reason` 裸写是词表漂移源：非 identity 映射 case（budget_limited→
  // failed）会落词表外值，未知值由 protocol default=completed 兜底。
  try {
    deps.appendEntry?.(PENDING_UNREGISTER_ENTRY_TYPE, {
      id,
      reason,
      status: mapReasonToStatus(reason),
    });
  } catch (err) {
    // 落盘失败：差集残留交下次 sweep（session_start / 监督器启动）重试。
    logger.warn(
      `[subagents] reconcile sweep appendEntry failed for ${id} (retry on next sweep): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  result.reconciled.push(id);
}

/** closedReason → pending reason（未知值交 pending-notifications mapReasonToStatus
 *  的 default=completed 兜底——诚实且对差集消费方无行为影响，reason 不参与计数）。 */
function closedReasonToPendingReason(closedReason: string | undefined): string {
  return closedReason ?? "completed";
}

// ── 差集读取（独立轻量实现，不复用 session-pending 的 per-file 增量游标——sweep
//    是低频全量操作，与后代判定的游标记账解耦，避免交错消费 offset）──

interface ActiveRegisterEntry {
  id: string;
  type: string | undefined;
}

/** entry.data 的最小形状（对齐 pending-notifications RegisterEntryData）。 */
interface RegisterDataLike {
  id?: unknown;
  type?: unknown;
}

function isRegisterDataLike(v: unknown): v is RegisterDataLike {
  return typeof v === "object" && v !== null;
}

/**
 * 读主 session 文件的 pending:register − pending:unregister 差集（register 顺序
 * 保留；同 id 重 register 去重）。文件不可读（首条 assistant 前未 flush / 被删）
 * 返回空集——sweep 空跑，下次触发点重试。坏行跳过（append 中途崩溃的截断行）。
 */
function collectActiveRegisterEntries(sessionFile: string): ActiveRegisterEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const unregistered = new Set<string>();
  const registers = new Map<string, string | undefined>();
  for (const line of content.split("\n")) {
    // 快速路径（对齐 session-pending S-4 按值匹配）：只解析含 pending 值的行。
    if (!line.includes('"pending:register"') && !line.includes('"pending:unregister"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 坏行跳过
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as { customType?: unknown; data?: unknown };
    if (!isRegisterDataLike(entry.data)) continue;
    const id = entry.data.id;
    if (typeof id !== "string") continue;
    if (entry.customType === "pending:register") {
      registers.set(id, typeof entry.data.type === "string" ? entry.data.type : undefined);
    } else if (entry.customType === "pending:unregister") {
      unregistered.add(id);
      registers.delete(id);
    }
  }
  return [...registers.entries()].map(([id, type]) => ({ id, type }));
}
