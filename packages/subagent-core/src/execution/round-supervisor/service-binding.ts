// src/execution/round-supervisor/service-binding.ts
//
// [W4] SubagentService 与轮次活性监督器 / 注册对账 sweep 的装配绑定面。
//
// 从 subagent-service.ts 抽出（max-lines 纪律——监督器 deps 装配 + giveUp 编排 +
// sweep 挂点是纯绑定代码，内聚为一个文件；机制与语义注释见 supervisor.ts /
// reconcile-sweep.ts / domain.ts）。变化轴：改监督器通知文案 / giveUp 终态化编排 /
// sweep 的 store 读侧判据，只动本文件。
//
// 全部依赖经 RoundSupervisorBinding 惰性闭包注入（session 级状态运行时可变——
// 对齐 notify-host.ts createNotifyHost 的 deps 惰性求值先例）。

import { getLogger } from "../../core/logger.ts";
import { bestEffort } from "../best-effort.ts";
import { COLD_LOOKUP_SCAN_LIMIT } from "../cold-lookup.ts";
import { createRecord, tryTransition } from "../execution-record.ts";
import { hasLiveProcessHandle } from "../lifecycle-predicates.ts";
import { FileRunStore } from "../../orchestration/file-run-store.ts";
import { resolvePiWorkflowStateDir } from "../workflow-state-root.ts";
import type { PiLike } from "../notify-host.ts";
import type { RecordStore } from "../record-store.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";
import {
  RoundSupervisor,
  runReconcileSweep,
  type GiveUpKind,
  type SupervisorCandidateRecord,
  type SupervisorRecordView,
} from "./index.ts";

const logger = getLogger("subagents");

/** 绑定面（SubagentService 供给；全部惰性——见文件头注）。 */
export interface RoundSupervisorBinding {
  getStore(): RecordStore;
  getPi(): PiLike | null;
  /** 所属根 session id（候选过滤；未初始化时 null）。 */
  getSessionRootId(): string | null;
  /** 主 session 文件（sweep 差集输入源；未 flush/未知时 undefined = 空跑）。 */
  getMainSessionFile(): string | undefined;
  /**
   * record 终态化委托（service.finalizeRecord——注销合法发射点①的宿主路径）。
   * 监督器 giveUp 的内存 record 分支消费；CAS 防双收尾由本文件 giveUp 先 tryTransition。
   */
  finalizeClosed(record: ExecutionRecord, result: AgentResult): Promise<void>;
}

/** 监督器通知出口（决策指引 / 终止 / 替代通知统一走 steer——唤醒主 agent 的注意力
 *  而非自动复活任务；pi 缺席（dispose 后）静默丢弃，对齐 notify-host 语义）。 */
function supervisorNotify(binding: RoundSupervisorBinding, content: string): void {
  binding.getPi()?.sendMessage(
    { customType: "subagent-round-supervisor", content, display: false },
    { deliverAs: "steer" },
  );
}

/** record 视图（内存 getMutable 优先，磁盘 findLightById 兜底——boot 重认领面对的
 *  存量 record 只在磁盘：重启后内存 records Map 为空）。 */
function supervisorRecordView(binding: RoundSupervisorBinding, id: string): SupervisorRecordView | undefined {
  const memory = binding.getStore().getMutable(id);
  if (memory !== undefined) {
    return {
      id: memory.id,
      status: memory.status === "closed" ? "closed" : "running",
      resumable: memory.resumable === true,
      hasResult: memory.result !== undefined,
      chatMode: memory.chatMode === true,
      origin: memory.origin,
      rootSessionId: memory.rootSessionId,
      agent: memory.agent,
      slug: memory.slug,
      startedAt: memory.startedAt,
      closedReason: memory.closedReason,
    };
  }
  const disk = binding.getStore().findLightById(id);
  if (disk === undefined) return undefined;
  return {
    id: disk.id,
    status: disk.status === "closed" ? "closed" : "running",
    resumable: disk.resumable === true,
    hasResult: disk.result !== undefined,
    chatMode: disk.chatMode === true,
    origin: disk.origin,
    rootSessionId: disk.rootSessionId,
    agent: disk.agent,
    slug: disk.slug,
    startedAt: disk.startedAt,
    closedReason: disk.closedReason,
  };
}

/** 本 root session 的 running record 候选（内存 ∪ 磁盘重建投影）。
 *  [H2 W2] origin 透传——superseded 对账的 workflow 候选豁免判据（supervisor.evaluate
 *  消费面，W1 已把 origin 投影进 SubagentRecord）。 */
function supervisorCandidates(binding: RoundSupervisorBinding): SupervisorCandidateRecord[] {
  const rootFilter = binding.getSessionRootId() ?? undefined;
  return binding
    .getStore()
    .collectRecords(COLD_LOOKUP_SCAN_LIMIT, "running", rootFilter)
    .map((r) => ({
      id: r.id,
      rootSessionId: r.rootSessionId,
      agent: r.agent,
      slug: r.slug,
      startedAt: r.startedAt,
      origin: r.origin,
    }));
}

/**
 * 监督器「该放弃 / superseded」执行（RoundSupervisorDeps.giveUp）。
 * 形态分流：
 *  - 内存 record：CAS tryTransition → finalizeClosed（终态化 + 注销①发射 + worktree/
 *    manifest 收尾）——watchdog-expired 额外发终止通知（此时可重派）；superseded 的
 *    替代通知已由监督器先行发出。boot 直断不经本函数（孤儿恢复层直断 + in-flight
 *    的重启中断 error 语义由 finalizeOrphanRecord 落位，见 supervisor.bootPartition 头注）。
 *  - 磁盘态（内存无 + findLightById 命中，boot 重认领后看门狗到期的形态）：终态
 *    写面归口 store.markFinalized（[U2b/G1 收口] `.state` writeSync + entry/archive +
 *    manifest + `.alive` release，D8 写序——原 store 外终态 sidecar 直写 + 终态
 *    entry 直写两段独立 best-effort 直写点消灭；`.state` 重试耗尽返回
 *    false = 零持久化副作用，record 留 running 由 boot 孤儿恢复终态化承接，§3.4）
 *    ——不走 finalizeRecord（无内存 record，archive/CAS 不适用），其注销由对账
 *    sweep（发射点⑤「record 终态 → 差集补发」）收口。
 */
async function supervisorGiveUp(
  binding: RoundSupervisorBinding,
  recordId: string,
  kind: GiveUpKind,
  detail: { replacementId?: string },
): Promise<void> {
  const store = binding.getStore();
  const memory = store.getMutable(recordId);
  const errorText =
    kind === "watchdog-expired"
      ? "round supervisor: decision watchdog expired (guidance unanswered, no convergence) — task terminated; safe to re-dispatch"
      : `round supervisor: superseded by replacement task ${detail.replacementId ?? "(unknown)"}`;
  if (memory !== undefined) {
    const failedResult: AgentResult = {
      text: "",
      turns: memory.turnCount,
      durationMs: Date.now() - memory.startedAt,
      success: false,
      error: errorText,
      sessionId: memory.id,
      toolCalls: [],
    };
    // CAS 抢锁防与 cancel/dispose 双收尾；抢锁失败 = 对方已终态化，收尾跳过。
    if (!tryTransitionClosed(memory)) return;
    try {
      await binding.finalizeClosed(memory, failedResult);
    } catch (err) {
      bestEffort(err, `round supervisor give-up finalize (${recordId})`, "error");
    }
    if (kind === "watchdog-expired") {
      const view = supervisorRecordView(binding, recordId);
      if (view !== undefined) {
        supervisorNotify(
          binding,
          `Subagent "${view.agent}" (${view.slug || recordId}) was terminated after the decision watchdog ` +
            `expired without your decision. It is now closed — you can safely re-dispatch the task if still needed.`,
        );
      }
    }
    return;
  }
  // 磁盘态分支（boot 重认领后的放弃——record 不在内存）。
  const disk = store.findLightById(recordId);
  if (disk === undefined) return;
  // 终态投影 record 由磁盘 light 投影重建（createRecord 先例 = cold-lookup 的
  // resurrectColdRecord：identity 域经 identity 入参、readonly engineHandle 经构造
  // spread、运行态域随后补写——origin/parentRunId 不迁 [workflow origin 豁免 adopt
  // 链，本分支不可达]）。markFinalized 的 entry 面 = recordToSubagent 投影，磁盘
  // 投影的 result/turns/totalTokens 等终态快照字段随重建保真。
  const record: ExecutionRecord = {
    ...createRecord(recordId, {
      agent: disk.agent,
      model: disk.model,
      thinkingLevel: disk.thinkingLevel,
      mode: disk.mode,
      task: disk.task,
      slug: disk.slug,
      startedAt: disk.startedAt,
      rootSessionId: disk.rootSessionId,
      parentRecordId: disk.parentRecordId,
      depth: disk.depth,
      chatMode: disk.chatMode === true,
      engine: disk.engine,
      engineFallback: disk.engineFallback,
      collectMode: disk.collectMode,
    }),
    ...(disk.engineHandle !== undefined ? { engineHandle: disk.engineHandle } : {}),
  };
  record.sessionFile = disk.sessionFile;
  record.round = disk.round;
  record.resumable = disk.resumable;
  record.hadWorktree = disk.worktree === true;
  record.result = disk.result;
  record.turnCount = disk.turns;
  record.totalTokens = disk.totalTokens;
  record.error = errorText;
  record.endedAt = Date.now();
  // 防御：createRecord 产物恒 running，CAS 失败不可达（不终态化直接返回）。
  if (!tryTransition(record, "closed", "gc")) return;
  try {
    const persisted = store.markFinalized(record, "gc");
    if (!persisted) {
      // [§3.4] `.state` 重试耗尽：store 层已 error 级留痕，此处补调用方语境 + GUI
      // 通知面腿（对齐 doFinalizeRecord 同款接线）——record 留 running 形态，boot
      // 孤儿恢复终态化承接。
      logger.error(
        `[subagents] round supervisor give-up terminal write failed (record=${recordId}); ` +
          `record stays running on disk — boot orphan recovery will finalize it`,
      );
      binding.getPi()?.appendEntry?.("subagent:state-write-failed", {
        id: recordId,
        status: "closed",
        closedReason: "gc",
      });
    }
  } catch (err) {
    bestEffort(err, `round supervisor give-up entry (${recordId})`, "error");
  }
}

/** tryTransition closed+gc 的本地命名（CAS 语义见 execution-record.ts）。 */
function tryTransitionClosed(record: ExecutionRecord): boolean {
  return tryTransition(record, "closed", "gc");
}

/** 装配监督器实例（SubagentService.roundSupervisor 字段的工厂）。 */
export function createRoundSupervisorForService(binding: RoundSupervisorBinding): RoundSupervisor {
  return new RoundSupervisor({
    now: () => Date.now(),
    getRecordView: (id) => supervisorRecordView(binding, id),
    listCandidateRecords: () => supervisorCandidates(binding),
    hasLiveProcess: (recordId) => hasLiveProcessHandle(recordId),
    sendMergedFailureNotice: (view, errMsg) =>
      supervisorNotify(
        binding,
        `Subagent "${view.agent}" (${view.slug || view.id}) failed: the engine/child process driving it died ` +
          `(${errMsg}). The task is NOT completed and stays resumable — this supervisor has taken over and will ` +
          `deliver a resume/re-dispatch guidance shortly. Do NOT re-dispatch this task before that guidance arrives.`,
      ),
    sendDecisionGuidance: (view, opts) =>
      supervisorNotify(
        binding,
        `Subagent "${view.agent}" (${view.slug || view.id}, id=${view.id}) died mid-task and stays resumable. ` +
          `Decide now: resume it by sending a message to id=${view.id}, or re-dispatch a replacement task. ` +
          `If you take no action it will be terminated automatically when the decision watchdog expires.` +
          (opts.exemptionDisclaimer
            ? ` If you have already re-dispatched or no longer need this task, ignore this guidance; ` +
              `the original task will be terminated automatically when the watchdog expires.`
            : ""),
      ),
    sendReplacedNotice: (view, replacementId) =>
      supervisorNotify(
        binding,
        `Subagent "${view.agent}" (${view.slug || view.id}, id=${view.id}) was already replaced by your new ` +
          `task ${replacementId} (same agent/slug started within the watchdog window). The original record is ` +
          `being terminated; no resume is needed.`,
      ),
    giveUp: (recordId, kind, detail) => void supervisorGiveUp(binding, recordId, kind, detail),
  });
}

/**
 * [W4] 注册对账 sweep（发射点枚举⑤）：对「本 session register entry × 对应
 * record/run ∈ 终态集 ∪ 已归档/不存在」差集补发 unregister——appendEntry 权威落盘 +
 * 尽力 emit（写法论证见 reconcile-sweep.ts 头注）。[F2] 判据按类型分流：subagent 走
 * RecordStore，workflow/畸形走 FileRunStore（findStateByIdSync），bash 无收口通道
 * 保守跳过（显式偏差 impl-plan §5）。触发点 = initSession（session
 * reattach / session_start / 监督器启动三时机的承载点，根进程 only——与孤儿恢复
 * 同一单扫描者判据，isChildProcess 由调用方传）。与 registry rebuild 的先后时序
 * 不作保证，残余窗口由下次 session_start 收口（设计明示容忍）。
 */
export function runPendingReconcileSweepForService(binding: RoundSupervisorBinding, isChildProcess: boolean): void {
  if (isChildProcess) return;
  try {
    // [F2] workflow run 判据供给：FileRunStore 构造轻量（无 IO 副作用，lastSavedAt
    // 空 Map——findStateByIdSync 同步只读不触碰节流记账），sweep 挂点低频
    // （initSession），每轮构造一次闭包持有。
    // [F-1 修复] stateDir 必须与 pi 壳 JsonlRunStore 的落盘布局同源
    //（<sessionDir>/workflow-state/，推导 = resolvePiWorkflowStateDir）；缺省根
    // <dataRoot>/workflow-state 是 zcode 宿主布局，与 pi 生产落盘不相交——曾致
    // findStateByIdSync 恒 missing → sweep 按终态补注销活跃 run（W4 引入的装配错位）。
    const workflowStore = new FileRunStore({ stateDir: resolvePiWorkflowStateDir() });
    runReconcileSweep({
      sessionFile: binding.getMainSessionFile(),
      lookupRecordState: (id) => {
        const memory = binding.getStore().getMutable(id);
        if (memory !== undefined) {
          return memory.status === "closed"
            ? { terminal: true, closedReason: memory.closedReason }
            : "active";
        }
        const disk = binding.getStore().findLightById(id);
        if (disk === undefined) return "missing";
        return disk.status === "closed"
          ? { terminal: true, closedReason: disk.closedReason }
          : "active";
      },
      // [F2] type=workflow 及畸形条目的收口判据（设计 D2 sweep 判据补全——
      // 「终态集 ∪ 已归档/不存在」对 workflow run 同样成立）。running 映射 active
      // （含全行损坏的保守形态）；done → terminal（reason 即 DoneReason，经
      // closedReasonToPendingReason 未知值兜底）；文件缺失 → missing。
      lookupWorkflowRunState: (runId) => {
        const state = workflowStore.findStateByIdSync(runId);
        if (state.kind === "missing") return "missing";
        if (state.kind === "terminal") return { terminal: true, closedReason: state.reason };
        return "active";
      },
      appendEntry: (customType, data) => binding.getPi()?.appendEntry(customType, data),
      emit: (channel, data) => binding.getPi()?.events.emit(channel, data),
    });
  } catch (err) {
    bestEffort(err, "pending reconcile sweep", "error");
  }
}
