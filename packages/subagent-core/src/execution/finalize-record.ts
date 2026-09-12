// src/execution/finalize-record.ts
//
// 时序收尾逻辑（从 subagent-service.ts 提取，降低主文件行数 < 1000 上限）。
//
// [U2a / §3.1 意图 API 迁移] 终态持久化四件套（.state 写 + entry/archive + manifest +
// .alive 删）归口 store.markFinalized / markCancelled——本文件降级为**副作用编排层**
// （collectPatch / completeRecord / worktree cleanup / pending 注销① / onFinalized 钩子，
// §3.1 副作用归属边界）。文件布局知识（写哪个文件、什么顺序）不再散落此处：D8 v7 写序
//（.state writeSync 先 → manifest writeSync 后 → .alive 删）由 store 内部单点保证。
//
// [Critical #1 / PR #85 精神保持] manifest 写失败响亮上报不阻断（logger.error +
// subagent:manifest-write-failed entry，§3.4 manifest 面）与终态原语返回 false 均不
// 得跳过 worktree cleanup——磁盘满/权限错时 worktree 泄漏比索引缺失严重；终态写失
// 败时 record 留 running 形态（磁盘无终态位），下次 boot 孤儿恢复终态化承接（§3.4）。
//
// B9 兜底：completeRecord/终态原语抛错→后续 cleanup 仍执行。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";

import { bestEffort } from "./best-effort.ts";
import { completeRecord } from "./execution-record.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import type { RecordStore } from "./record-store.ts";
import { readIdentityHeader, readIdentityTail } from "./session-reconstructor.ts";
import type { AgentResult, ClosedReason, ExecutionRecord } from "./types.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

const logger = getLogger("subagents");

/** doFinalizeRecord 的依赖（从 SubagentService 注入，避免 this 绑定 + 解耦可测试）。 */
export interface FinalizeDeps {
  worktreeManager: WorktreeManager;
  store: RecordStore;
  modelService: ModelConfigService;
  /** Pi ExtensionAPI（终态写失败的响亮 entry 上报）。null 在 dispose 后。 */
  pi: { appendEntry?: (type: string, data: unknown) => void } | null;
  /** pending-notifications 终态注销（绑定 pi.events.emit，由调用方闭包提供）。 */
  emitUnregister(id: string, status: string): void;
  /**
   * [F-5 修复] record 终态化的宿主侧收口钩子（recordId；best-effort，抛错由调用方
   * 在闭包内自行兜底）。单一汇聚点：doFinalizeRecord 是全部 closed 终态的必经路径
   *（finalizeRecord / closeChatIdle / finalizeFailed / finalizeAborted /
   * consumeCloseAfterRound）。收口面现 = Continuation 实例清理（[H1 U6] 旧 chat 轮
   * 路由注销面已随 interact 面退役）。finalizeRoundToIdle 不经本钩子（回 idle 非终态，
   * 续聊仍需容器）。
   */
  onFinalized?: (recordId: string) => void;
  /**
   * [T1/PS-9] subagent sessionDir（getSubagentSessionDir(agentDir, rootCwd)，调用方注入）。
   *
   * record.sessionFile 缺失（RC-1 握手失败 + LC-4 反查也未命中的残余形态）时用于磁盘
   * 反查：按 identity（record.id）扫目录找真实 session 文件，作为终态原语
   * （store.markFinalized/markCancelled 的 .state/manifest/.alive 面）的锚点依据——
   * 消除「sessionFile 缺失 → 终态原因丢失 + alive marker 残留」。undefined = 调用方
   * 无法提供（反查跳过，行为退回修复前）。
   */
  sessionDir?: string;
  // [review 修复] 已删除 redeliverPending 回调（MF-1 消费确认制补投）：pendingMessages
  // 三段消费链随 deliverToRunning 一并移除（无生产调用方，死机制）。
}

/**
 * [T1/PS-9] 按 record 身份在 sessionDir 反查 session 文件（record.sessionFile 缺失时用）。
 *
 * 匹配依据：session JSONL 的 identity custom entry 携带 record id（子进程 session_start
 * hook 写入），探测函数与 RecordStore 列表扫描同源（readIdentityHeader 头部 64KB →
 * readIdentityTail 尾部 64KB；续聊场景 identity 靠尾）。readIdentityAnywhere 需全文读，
 * 本反查是收尾路径的 best-effort，不做。
 *
 * @returns 匹配到的 session 文件绝对路径；目录不可读 / 无匹配返回 undefined（不抛）。
 */
function findSessionFileByRecordIdentity(
  sessionDir: string,
  recordId: string,
): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return undefined; // 目录缺失/不可读 → 反查跳过，行为退回无反查
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(sessionDir, name);
    const recon = readIdentityHeader(full) ?? readIdentityTail(full);
    if (recon?.id === recordId) return full;
  }
  return undefined;
}

/**
 * [T1/PS-9] Step 序言：sessionFile 缺失时按 record 身份在 sessionDir 反查回填。
 *
 * 放在一切步骤前，让终态原语（archive 投影 / .state / manifest / .alive release）
 * 统一受益。RC-1（握手失败）+ LC-4（收尾反查未命中）的残余形态下，磁盘上 session
 * 文件仍可能真实存在（identity 携带 record.id）——反查命中则终态原语有了锚点，
 * 终态原因不再丢失、alive marker 不再残留；未命中则保持旧行为（best-effort 跳过）。
 */
function resolveMissingSessionFile(deps: FinalizeDeps, record: ExecutionRecord): void {
  if (record.sessionFile || !deps.sessionDir) return;
  const resolved = findSessionFileByRecordIdentity(deps.sessionDir, record.id);
  if (resolved) {
    record.sessionFile = resolved;
    logger.warn(
      `[subagent] finalizeRecord: sessionFile was missing, resolved via sessionDir identity lookup: ${resolved}`,
    );
  }
}

/**
 * Step 0: collectPatch（best-effort，仅 worktree 绑定时执行）。
 * [MF#3] patchFile 写到 worktree 之外（sessionsDir/<branch>.patch），避免被 cleanup 删除；
 * 路径回填 record.patchFile，供调用方（tool result / /subagents list）应用。
 */
async function collectPatchIfWorktree(deps: FinalizeDeps, record: ExecutionRecord): Promise<void> {
  if (!record.worktreeHandle) return;
  try {
    const sessionsDir = getSubagentSessionDir(
      deps.modelService.getAgentDir(),
      record.worktreeHandle.mainCwd,
    );
    fs.mkdirSync(sessionsDir, { recursive: true });
    const patchFile = path.join(sessionsDir, `${record.worktreeHandle.branch}.patch`);
    const patch = await deps.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
    if (patch.written) record.patchFile = patchFile;
  } catch (pe: unknown) {
    bestEffort(pe, "collectPatch (finalizeRecord Step0)");
  }
}

/**
 * Step 3b: worktree cleanup（best-effort 幂等，仅 worktree 绑定时执行）。
 * [Critical] 绝不能因终态原语失败（含 manifest 写失败）而跳过（否则 worktree 泄漏）。
 */
async function cleanupWorktreeIfBound(deps: FinalizeDeps, record: ExecutionRecord): Promise<void> {
  if (!record.worktreeHandle) return;
  try {
    await deps.worktreeManager.cleanup(record.worktreeHandle);
  } catch (err) {
    bestEffort(err, "worktree cleanup (finalizeRecord Step3)");
  }
}

/**
 * 时序收尾（D-017，[U2a] 终态持久化面归口 store 意图原语后的编排形态）。
 *
 * 步骤：序言 sessionFile 反查 → Step 0 collectPatch → Step 1 completeRecord →
 * Step 2 终态原语（store.markFinalized / markCancelled：.state writeSync + entry/
 * archive + manifest + .alive 删，D8 v7 写序）→ Step 3b worktree cleanup →
 * pending 注销① → onFinalized 钩子。
 *
 * [Critical #1] 终态原语失败（返回 false = .state 重试耗尽；或意外抛错）不得跳过
 * worktree cleanup——写失败时 record 留 running（磁盘无终态位），副作用清理照常
 * （幂等）；§3.4 响亮 entry 上报由本编排层接线（store 层已 logger.error）。
 */
export async function doFinalizeRecord(
  deps: FinalizeDeps,
  record: ExecutionRecord,
  result: AgentResult,
  status: "closed",
  closedReason?: ClosedReason,
): Promise<void> {
  // [T1/PS-9] sessionFile 缺失时 sessionDir 反查（序言，先于一切步骤）。
  resolveMissingSessionFile(deps, record);

  // ── Step 0: collectPatch（best-effort）──
  await collectPatchIfWorktree(deps, record);

  // ── Step 1: completeRecord（B9: 抛错→后续仍执行）──
  try {
    completeRecord(record, result, status, closedReason);
  } catch (err) {
    bestEffort(err, "completeRecord (finalizeRecord B9)", "error");
  }

  // ── Step 2: 终态持久化四件套归口（B1 迁移点）──
  // cancelled 走 markCancelled（.state 载荷 status:"cancelled" + 精确 endedAt），其余
  // markFinalized。两原语内部写序 = .state writeSync 先 → binding/archive/manifest →
  // .alive 删（release 出口①，D8 v7）。生产路径恒 manifestDir 接线（subagent-service
  // 构造点）；缺省异步分支仅纯内存测试形态。
  let persisted = false;
  try {
    persisted =
      closedReason === "cancelled"
        ? deps.store.markCancelled(record)
        : deps.store.markFinalized(record, closedReason);
  } catch (err) {
    bestEffort(err, "store terminal primitive (finalizeRecord B9)", "error");
  }
  if (!persisted) {
    // [§3.4 / U1 偏差 6 接线] 终态写失败（重试耗尽）响亮 entry 上报——GUI 通知面腿；
    // 日志 error 级腿已由 state-marker 内部完成。record 留 running 形态（磁盘无终态
    // 位、未 archive），下次 boot 孤儿恢复终态化承接。
    const reasonDesc = closedReason ?? record.closedReason ?? "gc";
    logger.error(
      `[subagent] terminal state write failed after retries (record=${record.id}, reason=${reasonDesc}); ` +
        `record stays running on disk — boot orphan recovery will finalize it`,
    );
    deps.pi?.appendEntry?.("subagent:state-write-failed", {
      id: record.id,
      status,
      closedReason: reasonDesc,
    });
  }

  // ── Step 3b: worktree cleanup（best-effort，不可被终态写失败跳过）──
  await cleanupWorktreeIfBound(deps, record);

  // pending-notifications：终态注销（只记 registry 状态，通知由 BgNotifier 发）
  // [W4 发射点枚举归属①] 注销合法发射点枚举（设计 D2）第 ① 处：subagent record
  // 终态化（finalizeRecord 路径，含监督器放弃）。其余合法发射点：② = store
  // .markRoundIdle 簿记⑧（U5 收口后编排层无直发；setPendingUnregister →
  // emitPendingUnregister 唯一发射）；③ workflow run 终态迁移
  //（transition("done") 路径）；④ 监督器显式放弃（走本路径，终态化+注销同批）；
  // ⑤ 注册对账 sweep 补发（round-supervisor/reconcile-sweep.ts）。进程退出本身
  // 永远不是注销理由（subagent-service disposeAllRecords 的 emit 属①——其同批
  // completeRecord+archive 终态化）。
  deps.emitUnregister(record.id, status);

  // [F-5 修复] 宿主侧终态收口钩子（chat 轮路由注销的单一汇聚点，见 FinalizeDeps
  // .onFinalized 注释）。fire-and-forget：钩子失败不阻断收尾（闭包内自查）。
  try {
    deps.onFinalized?.(record.id);
  } catch (err) {
    bestEffort(err, "onFinalized hook (finalizeRecord)");
  }
}

/**
 * [H1 U2 / D7] 轮终处置的 outcome 入参（判别联合）。
 *
 * 命名与协议 AgentOutcome 同名不同物（设计 D7 v6：kind 判别联合消歧）——
 * kind 判别轮终分流：成功轮正文来源 = Continuation 成功分支的 content（协议
 * AgentOutcome.content 映射产物）；失败轮 reason = 失败原因原文。
 */
export type RoundSettlementOutcome =
  | { kind: "success"; content: string }
  | { kind: "failed"; reason: string };

/**
 * 对话模式轮次完成收尾：record 进 idle 态（非终态化，等待续聊）。
 *
 * [U2a/B5] 轮终簿记全集（①-⑨）归口 store.markRoundIdle——本方法瘦身为编排薄壳。
 * 簿记语义（细节与 result 写入规则见 record-store.markRoundIdle 方法头）：
 *   - 不调 completeRecord（record 不冻结，保留 turns[] 等运行时状态供续聊累积）
 *   - 不调 store.archive（record 留内存，getMutable 可查、list 可见）
 *   - 不 cleanup worktree（保留对话模式工作目录）
 *   - 不写 manifest（轮终回 running-resumable 非终态化，无终态快照可写）
 *   - **[B5/D3a] `.alive` 不再删除**——写权声明跨轮延续（release = 终态原语或
 *     idle-GC 归档两出口；轮终 record 仍 resumable、随时续聊 spawn 写同一
 *     sessionFile，删则轮后跨进程防御空窗）
 *   - [A3] 终态簿记已冻结（endedAt 已设）的调用由 store 内硬断言 fail-fast
 *     （复活终态的调用即 bug——S7 防御），throw 先于 store 簿记⑧的注销发射
 *
 * @throws Error record 终态簿记已冻结（completeRecord 已跑）仍被调用（store.markRoundIdle
 *   内硬断言——冻结权威判据 = endedAt 已设，写点枚举与两构造性调用面论证见其方法头）。
 */
export async function doFinalizeRoundToIdle(
  deps: FinalizeDeps,
  record: ExecutionRecord,
  outcome: RoundSettlementOutcome,
): Promise<void> {
  // 簿记①-⑨归口（含 A3 硬断言与⑨ reportRecordTransition entry 上报）。
  // 返回 false = record 不在 store 内存（debug 留痕，无副作用）——两构造性调用面
  //（Continuation 轮末分流 / settleOneShotOutcome SP-5）的 record 均在内存，false 即
  // 调用方 bug，留痕足够。
  deps.store.markRoundIdle(record.id, outcome);

  // [W4 发射点②] pending 注销（进程已死，从活跃后代差集移除）已随 U5 收口进
  // markRoundIdle 簿记⑧——SubagentService 构造点经 setPendingUnregister 注入
  // notifyHost.emitPendingUnregister，本编排层不再双轨重复发射。
}
