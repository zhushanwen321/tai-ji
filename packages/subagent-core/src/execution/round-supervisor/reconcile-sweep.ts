// src/execution/round-supervisor/reconcile-sweep.ts
//
// [W4] 注册对账 sweep——死亡窗口投递缺口的补发通道（发射点枚举第 5 处）。
//
// 设计权威源：docs/design/chat-domain-v1x-liveness-governance.md §3.2 D2「注册对账
// sweep」（R2 增补、R3 钉死判据与写法）。
//
// 问题：注销经进程内 pi.events appendEntry 落盘，进程死亡时发射源消失
// （notify-host getPi() 为 null），注销 entry 可能永久缺位 → goal 守卫幻 defer、
// pending_notifications 工具虚报活跃。
//
// 补发机制：对「本 session 的 register entry × 对应 record 状态 ∈ 终态集 ∪ record
// 已归档/不存在」的差集补发 unregister。**已归档**（archive 从内存移除、磁盘有
// finalized sidecar → 读侧重建 closed）与**不存在**（畸形条目对不上任何 record）
// 同视同终态——「查不到即补注销」判据兜底链才闭合。
//
// 写法钉死（照 base-tool-enhance/src/background/pending-reconcile.ts 先例）：
// **直接 appendEntry 权威落盘 + 尽力 emit 同步内存视图**——不经 bus emit 作权威：
// pending-notifications 的 unregister listener 落盘条件是其内存 registry 该 id
// active，而两个 extension 的加载/派发顺序无保障，顺序反转时 emit 被静默吞。
// 差集消费方（goal 守卫）从持久化 entries 算差集，appendEntry 对守卫直接生效；
// emit 之外尽力同步 listener 内存视图（失败无害）。
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
  /** 已归档/不存在（视同终态，补注销）。 */
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
  /** 尽力 emit（pi.events.emit；listener 缺失/抛错无害）。 */
  emit?: (channel: string, data: unknown) => void;
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
    logger.warn(
      `[subagents] reconcile sweep re-emitted ${result.reconciled.length} unregister(s) for terminal/missing records: ${result.reconciled.join(",")}`,
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
  reemitUnregister(deps, id, state, result);
}

/** 补发单条 unregister：appendEntry 权威落盘 + 尽力 emit 同步内存视图（均失败保守处理）。 */
function reemitUnregister(
  deps: ReconcileSweepDeps,
  id: string,
  state: Exclude<SupervisedRecordState, "active">,
  result: ReconcileSweepResult,
): void {
  const reason =
    state === "missing" ? "expired" : closedReasonToPendingReason(state.closedReason);
  // 权威路径：直接 appendEntry 落盘（不经 bus emit 作权威——先例论证见文件头注）。
  try {
    deps.appendEntry?.("pending:unregister", { id, reason, status: reason });
  } catch (err) {
    // 落盘失败：差集残留交下次 sweep（session_start / 监督器启动）重试。
    logger.warn(
      `[subagents] reconcile sweep appendEntry failed for ${id} (retry on next sweep): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  // 尽力补 emit（listener 就绪时同步 pending 内存视图，缩短工具投影不一致窗口）。
  try {
    deps.emit?.("pending:unregister", { id, reason });
  } catch (err) {
    // 尽力语义：emit 失败无害（appendEntry 已是权威路径），debug 留痕供排查。
    logger.debug(
      `[subagents] reconcile sweep best-effort emit failed (harmless) for ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
