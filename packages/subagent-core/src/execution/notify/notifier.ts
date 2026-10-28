// src/execution/notify/notifier.ts
//
// Background 完成回注主对话（单条通知通道）。
//
// 职责：
//   - buildLlmContent：格式化通知文案（本文件唯一逻辑职责）
//   - createNotifier：薄工厂——投递统一走 pi 半区投递端口（getDeliveryPort 进程级
//     槽，unified-delivery 波 2 切换）：port.deliver 主投（受理前落投递日志 + 直达
//     pi 原生唯一队列 + details-id 送达凭据 + 重启差集重放）；port 缺席（装配异常 /
//     版本混装窗口）降级既有最深层直发兜底（createDirectSendHandle）+ warn 留痕 +
//     诊断计数——降级代价显式登记：无判重无耐久（重复提交可能双投），仅覆盖装配
//     异常窗口，不作为常态路径（fail-fast 导向：warn 即修复信号）。
//
// [collect 退役] 原 notifyBatch / buildBatchLlmContent / computeBatchBudget /
// buildBatchNotifyId（sync 批通知三件套 + 批幂等键）已随 collect 批机制整体删除。
// [波 2 退役] 通知账本（notify-ledger 四步生命周期）随波 2 shadow 比对通过退役，
// 语义由 port 承接（老能力映射 #1-#3）。

// 投递通道：port.deliver 受理即入 pi 原生 steer/followUp 队列（忙时不拒），两档出队
// 注入时机由 pi 队列原生承载；本模块唯一 intent 形态 = turn 边界档（缺省，端口侧
// 翻译为 pi sendMessage steer 档 + triggerTurn）。

import { getLogger } from "../../core/logger.ts";
import { SUBAGENT_BG_NOTIFY_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
import type { FailureCause } from "@zhushanwen/subagent-engine-sdk";
import {
  getNotifyDomainPorts,
  type DeliveryHandle,
  type DeliveryPort,
} from "../../core/notify-ports.ts";

import { deriveOutcome } from "../persistence/execution-record.ts";
import type { AbandonedRoundMark, ClosedReason, Epoch, ExecutionOutcome } from "../domain/record-types.ts";

/**
 * 送达消息的 customType——notify 词表单源（extension-protocol 的
 * SUBAGENT_BG_NOTIFY_CUSTOM_TYPE）的兼容别名：notifier / bg-notify-render /
 * 壳 index.ts（messageRenderer 注册）/ shared 集合消费同一常量，历史名保留供
 * 本包既有消费方（值锚定锁 = 壳 __tests__/contract.notify-custom-types.test.ts）。
 * （原定义在 notify-ledger.ts，随账本退役迁入本文件。）
 */
export const NOTIFY_CUSTOM_TYPE = SUBAGENT_BG_NOTIFY_CUSTOM_TYPE;

// ============================================================
// [T4① / PS-2 → U5 二元组] notify 门（H1 U2 自 subagent-service.ts 迁入——
// Continuation 成功/失败分支双闸共用；原位置 re-export 保持既有 import 路径不变）
// ============================================================

/**
 * notify 门的 record 状态入参（永久会话模型 §3.2.7 通知 gate 的判据源，
 * 全部从 ExecutionRecord 同名字段直传——调用点 `notifyGateAllowsDelivery(record)`）。
 */
export interface NotifyGateRecordState {
  /** record 当前世代（两步判定的比较基准——非标记槽 epoch，§3.2.7 显式两步）。 */
  readonly epoch?: Epoch;
  /** 放弃轮标记（gate 判据，单槽）：abort（cancel / 编排性关闭打断）时置在途轮。 */
  readonly lastAbandonedRound?: AbandonedRoundMark | null;
  /** 当前轮次（gate 第二步的回注轮缺省源——settle 推进后的值，正常轮通知凭此
   *  越过旧标记；被中断轮不推进，迟到回注轮 ≤ 标记轮被丢弃）。 */
  readonly round?: number;
}

/**
 * notify 门的回注声明身份（迟到帧自带；缺省 = 读 record 自身——同世代、当前轮）。
 * 现有消费点的回注均从 record 派生视图（无独立世代/轮载体），缺省路径恒命中「同世代」，
 * 拦截由第二步标记判定承担；跨世代重复帧的最终防线 = notifyId（id:epoch:round）
 * 投递日志判重（reopen 前最后轮必已同步入账，晚到回注必为重复帧——设计 §3.2.7 论证）。
 */
export interface NotifyGateInbound {
  /** 回注声明世代（缺省 = record 当前 epoch，第一步恒同世代）。 */
  readonly epoch?: Epoch;
  /** 回注声明轮（缺省 = record.round ?? 0）。 */
  readonly round?: number;
}

/**
 * [U5 / §3.2.7 通知 gate] 轮次完成回注的投递门。
 *
 * 两个阻断维度承接旧 closedReason 集合门的事故防御（v4 A-6 僵尸回执 / cancelled
 * 防双发），判据源 = 「放弃标记」单维（收尾/静默场景由放弃轮标记 + 轮身份检查 +
 * notifyId 账本三层承接——原 intent=archived 静默 gate 随 intent 概念删除退役）：
 *
 *   ① 回注 epoch ≠ record 当前 epoch → 丢弃（跨世代回注）；
 *   ② 放弃轮标记命中 → 阻断（承接原 cancelled 阻断防双发）。**显式两步**（比较基准
 *      = record 当前 epoch，非标记槽 epoch——reopen 后标记残留旧 epoch，按标记槽比较
 *      会把新世代全部正常轮通知吞掉）：
 *        第一步：回注 epoch ≠ record 当前 epoch → 丢弃；
 *        第二步：同 epoch 时标记非空、标记槽世代 = 当前世代且回注轮 ≤ 标记轮 → 丢弃。
 *
 * 收尾轮豁免（构造性）：close 挂起等待的最后一轮（closeAfterRound 消费）通知正常
 * 送达——close 不置放弃轮标记（标记只由 cancel/编排性关闭的 abort 置位），且收尾
 * 写入 journal 记录的编排挂在轮次通知送达之后（§3.2.5 顺序约束 [写死]），settle 时点 record 仍
 * running 非放弃轮，①②均不命中。收尾后的残余迟到回注由轮身份检查（Continuation
 * abortAndClearQueue 废弃轮身份）+ 投递日志 notifyId 判重承接。
 *
 * 正常轮通知不该被旧标记吞的论证（为何比较 record.round 而非标记槽）：正常轮 N settle
 * 后 round 已推进（markRoundIdle +1），回注轮 = record.round > 标记轮 → 放行，重复帧由
 * notifyId 去重兜底；只有「被显式放弃的轮」才进标记（stopReason 单值会被新轮覆盖，
 * 无法承载 per-round 终局）。
 *
 * 消费方：Continuation 成功/失败分支双闸 + drain 丢弃通知 + 泛化派发主干尾部
 *（one-shot 回注）+ watchdog 失败通知（run-orchestration）。
 */
export function notifyGateAllowsDelivery(
  state: NotifyGateRecordState,
  inbound: NotifyGateInbound = {},
): boolean {
  const currentEpoch = state.epoch ?? 0;
  // ① 第一步：跨世代回注丢弃（比较基准 = record 当前 epoch）。
  const inboundEpoch = inbound.epoch ?? currentEpoch;
  if (inboundEpoch !== currentEpoch) return false;
  // ② 第二步：标记槽在当前世代且回注轮 ≤ 标记轮 → 丢弃（防双发）。标记槽世代 ≠
  // 当前世代（reopen 残留）→ 标记自然失效，跨世代重复帧由 notifyId 去重承接。
  const mark = state.lastAbandonedRound;
  if (mark != null && mark.epoch === currentEpoch) {
    const inboundRound = inbound.round ?? state.round ?? 0;
    if (inboundRound <= mark.round) return false;
  }
  return true;
}

/** U4：delivery warn 出口注入用——facade 同 component 同引用，与 index.ts 的
 *  getLogger("subagents") 共享单例；configureCore 后透明切换到宿主实现。 */
const notifyLogger = getLogger("subagents");

/**
 * 一条待发送的完成通知记录。
 * SP-1: done/failed/crashed 合并为 closed + closedReason L2 子枚举。
 */
export interface BgNotifyRecord {
  id: string;
  /**
   * 完成状态。v4 B-1 两态收敛：closed（终态，含 cancelled，closedReason 表达 L2 原因）
   * 或 running（对话模式轮次完成，旧 idle 折入 running，携带本轮结果送回主 agent）。
   * toNotifyRecord 检查放行后经此联合穷尽。
   */
  status: "running" | "closed";
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。内部诊断 + outcome 兜底派生输入。 */
  closedReason?: ClosedReason;
  /**
   * 终态三态对外语义（U3 C-outcome）。notify() 派生视图边界物化：closed 入参缺省时按
   * deriveOutcome(closedReason, error) 兜底填充（所有可达流程下与 completeLegacyClosed
   * 冻结的 record.outcome 等价——toNotifyRecord 构造点在 completeLegacyClosed 之后；该
   * 构造点属 U3 领地外，不透传本字段）。buildLlmContent 与 bg-notify-render 只读本字段。
   */
  outcome?: ExecutionOutcome;
  agent: string;
  /** 执行所用 model（RecordSnapshot.model），用于完成通知显示。 */
  model?: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number | undefined;
  /**
   * 对话轮次计数（仅 idle 有意义）。dedup key 按 `id:round` 去重——对话模式每轮 round
   * 不同，多轮通知互不命中投递日志按 key 的判重；首轮前 round 恒定（0/undefined），
   * key 同旧 id 行为不变。
   */
  round?: number;
  /** [MF#1] worktree 模式下子 agent 改动的 patch 路径（worktree 外，cleanup 后留存）。
   *  done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动
   *  会静默丢失——父 LLM 不知 patch 路径，无法应用。 */
  patchFile?: string;
  /** [wave2 → modeless 波1] 子 agent session 文件路径（全文恢复通道）。
   *  全体透传（toNotifyRecord 无条件携带）——通知末尾追加
   *  "Full transcript: <path>" 指针行，父 LLM 可按需读全文；万物可续下每个
   *  record 都要能被 message/fork 定位。缺失时 buildLlmContent 省略整行。 */
  sessionFile?: string;
  /** [U2] 通知身份键（派生视图边界物化 = dedupe key：`id` / `id:round`；[U5 / §3.2.3]
   *  epoch>0 时扩为 `id:epoch:round` / `id:epoch`（无轮形态——reopen 后第二次
   *  close 不与首轮 close 撞键，epoch=0 恒旧格式，磁盘账本零迁移）。投递日志条目 /
   *  回执匹配 / 幂等判重共用——details 携带（不进文案，G4 字节锁定不受影响），
   *  重复注入条目凭此可识别为同一条（G2 at-least-once 幂等键）。 */
  notifyId?: string;
  /**
   * [U5 / §3.2.3] 通知所属世代（reopen 防撞维度）：notifyId 构造消费——epoch>0 的
   *  key 带 epoch 段（轮次通知 `id:epoch:round`、无轮通知 `id:epoch`）。缺省
   *  （undefined）= epoch 0 旧格式。
   */
  epoch?: number;
  /**
   * [drain-drop 修复] notifyId 构造的显式覆盖（notify() 优先消费；缺省 = 既有
   *  `id` / `id:round` 语义零变化）。供「同轮先导通知与派生通知必须区分」的场景使用：
   *  现行唯一消费方 = drain 队列丢弃通知（`${id}:${round}:drain-drop`）——同轮
   *  settleRoundFailed 失败通知缺省 key 为 `id:round`，丢弃通知若沿用同 key 会被
   *  投递日志按 key 永久判重吞掉（「队列消息被丢」的显式反馈永不可达）。
   */
  dedupKey?: string;
  /** [C-2] close 终态通知的轮次统计（文案 "completed after N rounds." 用）。
   *  仅收尾写入 journal 记录的提示语义（notifyClosed）构造时携带——此时 dedup 身份 round 已被
   *  置 undefined（与轮次通知的 id:round key 区分，终态不被吞），轮数改由本字段进
   *  文案。one-shot 完成通知不设置，文案保持 "completed. Result:" 逐字节（G4）。 */
  totalRounds?: number;
  /**
   * [subagent-observability §3.3.7① 轮应答文案事实化] 本轮轮收条事实（lastRound
   * 透传——失败分类/停因/接管三态），buildLlmContent 的五分支判定输入：
   * 失败轮（failure 非空非 user.cancelled）写失败摘要 + cause + 恢复指引；中止轮
   * （user.cancelled / aborted 停因）写「本轮被中止」+ 来源；被接管轮
   * （promptDisposition=handled）写接管事实；正常轮带结果正文（空正文写「本轮
   * 完成，无文本输出」——UC-15）。缺省 = 轮收条缺席（迁移期回落帧），文案回落
   * 既有形态。 */
  lastRoundFailure?: FailureCause;
  lastRoundStopReason?: "stop" | "error" | "aborted";
  lastRoundDisposition?: "started" | "queued" | "handled";
}

/** notifier 依赖的宿主最小接口（解耦，便于测试）。
 *  迁移后：仅用于构造 DeliveryPort 的底层依赖。 */
export interface NotifierHost {
  /** 注入消息到主对话（U2 单通道：options 只接受 triggerTurn——多通道投递已删）。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean },
  ): void;
  /** 主 agent 是否空闲（非 streaming）。可选：未注入时 flush 不 gate。 */
  isIdle?: () => boolean;
  /**
   * 原生 settled 事件订阅能力（D8）：注册 handler 监听主 agent settled 边沿。
   * 退订不依赖 pi 返回值（0.84.4 的 `pi.on(...)` 返回 void 且无 off；pi 1.0.0 起 on
   * 返回 unsubscribe，本模块不消费）——退订由本模块的 disposed
   * 标志包装兑现（见下方 port 装配）。可选：未注入时内核退化退避轮询（busy 消息
   * 靠退避达上限强发，不走 settled 边沿驱动）。
   */
  onAgentSettled?(handler: () => void): void;
}

/**
 * 失败通知的恢复指引尾段（[T2-③/LC-1] 可达性语义——失败原因 + 恢复指引必须可达宿主）。
 * 定义于本模块（notify 域）：本模块 buildLlmContent 的 failed 通知与轮应答 ③' 迁移期
 * 回落支消费——单一权威禁散改。载荷 error 字段不嵌本尾段（失败摘要原文纪律——恢复
 * 指引由通知正文尾部单点承载，error 再嵌即双段指引）。
 * [勿重做警示] 失败通知与恢复轮完成通知之间存在时序窗：主 agent 若在窗口内改判
 * 「亲自接管」并同时重发 message，会产生并行恢复轮 + 重复劳动（2026-09-24 事故 S1
 * 实测形态）——接管前必须先 list 确认无在跑恢复轮。
 */
export const FAILURE_RECOVERY_TAIL =
  "Recovery: re-send your message (action:'message') to continue — the conversation " +
  "context is preserved (session file intact), or use action:'close' to discard it. " +
  "If you decide to take over the work yourself instead, first run action:'list' to check " +
  "whether a resumed round is already running for this subagent — do not redo work that a " +
  "recovery round may have already started or finished.";

/**
 * 轮应答恢复指引尾段（[§3.3.7①] 失败轮恢复指引——续聊重试 / 换模型；设计明令
 * 轮应答正文如实，失败摘要 + FailureCause + 恢复指引必须可达宿主）。
 */
export const ROUND_REPLY_RECOVERY_TAIL =
  "Recovery: re-send your message (action:'message') to continue this conversation " +
  "and retry the round (context is preserved), or re-dispatch with a different model.";

/**
 * 轮应答正文五分支事实化（[subagent-observability §3.3.7①]）——轮应答是债权兑现的
 * 轮收条如实呈现，不再硬编码 `finished a round`（文案说谎是故障 B 的呈现面）。
 * 判定序（先特殊后一般，输入 = BgNotifyRecord 轮事实字段，数据源 record.lastRound）：
 *   ① 被接管轮（promptDisposition=handled）：回执层成功 + 引擎未执行——简短事实；
 *   ② 中止轮（取消支——失败分类事实优先）：user.cancelled 写「本轮被中止 + 用户
 *      取消」；迁移期回落 = 旧引擎 aborted 停因且无 failure 事实（分类不可得，维持
 *      取消文案）；带 failure 事实的中止轮（engine_aborted / turn_budget_exhausted，
 *      §3.3.1 三源判别）不走本支——落 ③ 失败分支，失败分类与恢复指引不丢；
 *   ③ 失败轮（failure 非空非 user.cancelled）：失败摘要 + cause 点拼 + 恢复指引；
 *   ④ 正常轮空正文：「本轮完成，无文本输出」（UC-15 空值语义——不告警不谎报）；
 *   ⑤ 正常轮：结果正文（多轮与 one-shot 同形）。
 */
/** 取消族轮判据（事实优先：failure 分类 user = 取消；迁移期回落 = 旧引擎 aborted 停因无分类事实）。
 *  轮应答取消支与 transcript 指针判读共用，防两份手写判据漂移。 */
function isCancelledLikeRound(record: BgNotifyRecord): boolean {
  return (
    record.lastRoundFailure?.class === "user" ||
    (record.lastRoundFailure === undefined && record.lastRoundStopReason === "aborted")
  );
}

function buildRoundReplyContent(record: BgNotifyRecord): string {
  const agent = record.agent;
  const id = record.id;
  const roundLabel = record.round != null ? ` round ${record.round}` : "";
  const failure = record.lastRoundFailure;
  // [§3.3.1 取消支判据事实优先] 有 failure 事实时以分类为准（user = 取消族，其余
  // class = 失败轮）；仅旧引擎 aborted 停因而无分类事实时回落取消文案（迁移期回落）。
  const isCancelledRound = isCancelledLikeRound(record);
  if (record.lastRoundDisposition === "handled") {
    // ① 被接管（§3.3.1 第三形态：回执层成功 + 轮终事实词——引擎未执行，无成败）
    return `Subagent "${agent}" (${id})${roundLabel} was taken over by an extension before the engine ran it (prompt disposition: handled) — the round never executed; re-dispatch if the work is still needed.${transcriptTail(record)}`;
  }
  if (isCancelledRound) {
    // ② 中止轮（cancelled 族——「本轮被中止」+ 来源）
    const source =
      failure?.class === "user" ? "cancelled by user" : "aborted";
    return `Subagent "${agent}" (${id})${roundLabel} was aborted (${source}).${transcriptTail(record)}`;
  }
  if (failure !== undefined) {
    // ③ 失败轮：失败摘要 + FailureCause 点拼 + 恢复指引
    return (
      `Subagent "${agent}" (${id})${roundLabel} failed (${failure.class}.${failure.kind}).` +
      ` Error: ${record.error ?? "(no error text)"}\n\n${ROUND_REPLY_RECOVERY_TAIL}${transcriptTail(record)}`
    );
  }
  if (record.error !== undefined) {
    // ③' 迁移期回落：轮失败但轮收条分类缺席（旧格式 record / 合成失败）——如实出
    // 失败形态，禁落 ⑤「completed」把失败轮包装成成功应答（判定输入 = error 字段
    // 非空；分类事实在场时走 ③ 结构化文案）。
    return `Subagent "${agent}" (${id})${roundLabel} failed: ${record.error}\n\n${FAILURE_RECOVERY_TAIL}${transcriptTail(record)}`;
  }
  if (record.result == null || record.result === "") {
    // ④ 正常轮空正文（UC-15：空输出不是异常——简短事实，不谎报结果）
    return `Subagent "${agent}" (${id})${roundLabel} completed with no text output (the round finished; tool-only turns produce no reply text).${transcriptTail(record)}`;
  }
  // ⑤ 正常轮：结果正文
  return `Subagent "${agent}" (${id})${roundLabel} completed. Reply:\n${record.result}${transcriptTail(record)}`;
}

/** transcript 指针行（cancelled/gc-failed 不追加的对齐判据同样适用于轮应答——
 *  中止/接管轮无成功结果可读，指针无意义；失败/正常轮追加）。取消判据 =
 *  isCancelledLikeRound（与 buildRoundReplyContent 同源）＋接管轮。 */
function transcriptTail(record: BgNotifyRecord): string {
  const cancelledLike = isCancelledLikeRound(record) || record.lastRoundDisposition === "handled";
  return !cancelledLike && record.sessionFile ? `\n\nFull transcript: ${record.sessionFile}` : "";
}

/**
 * 将 BgNotifyRecord 格式化为 LLM 可读的 notification content。
 *
 * 模块内唯一消费方是下方 createNotifier 的 notify()（预格式化后传 delivery.send，
 * 内核只做拼接——多条以 "\n\n---\n\n" join）。
 */
function buildLlmContent(record: BgNotifyRecord): string {
  const agent = record.agent;
  const id = record.id;
  // [wave2 指针行 → modeless 波1] 轮次通知携带本轮增量，异步 flush 窗口丢失时不可
  // 重发，恢复通道是 session 文件全文。全体透传 sessionFile（万物可续——每个
  // record 都要能被 message/fork 定位）；cancelled/gc-failed 不追加（无成功结果
  // 可读，指针无意义）；缺失时省略整行（追加空串 = 输出逐字节不变）。
  const transcriptPointer = record.sessionFile
    ? `\n\nFull transcript: ${record.sessionFile}`
    : "";
  switch (record.status) {
    case "closed": {
      // U3 C-outcome：终态文案只读 outcome（notify() 派生视图边界已物化；?? 兜底为防御
      // 完整性——单一权威函数，非同构重写）。判定先于 patchFile——失败轮也会写
      // patchFile（doFinalizeRecord Step 0 对 worktreeHandle 无条件 collectPatch），
      // failed 分支不展示 patch 提示，否则 worktree 失败并存时 LLM 被告知 completed
      // （历史 bug 存档见 deriveOutcome 注释）。
      const outcome = record.outcome ?? deriveOutcome(record.closedReason, record.error);
      if (outcome === "cancelled") {
        return `Subagent "${agent}" (${id}) cancelled.`;
      }
      if (outcome === "failed") {
        // [LC-1 补口] failed 通知带上恢复指引尾段（此前仅轮失败 error 携带，通知侧
        // 丢失——主 agent 收到裸 error 无恢复路径，误判「任务全损」改判亲自重做）
        return `Subagent "${agent}" (${id}) failed: ${record.error}\n\n${FAILURE_RECOVERY_TAIL}${transcriptPointer}`;
      }
      // 成功完成或通用结束：展示结果。
      // [C-2] close 收尾提示附轮次统计（设计 D2 路径①"completed after N rounds"）。
      // totalRounds 仅 notifyClosed（收尾提示）携带；轮次通知不设置（轮次身份由
      // round 承载），文案保持 "completed. Result:" 逐字节（G4 硬约束锚定）。
      const roundsSuffix =
        record.totalRounds != null && record.totalRounds > 0
          ? ` after ${record.totalRounds} round${record.totalRounds === 1 ? "" : "s"}`
          : "";
      const base = `Subagent "${agent}" (${id}) completed${roundsSuffix}. Result:\n${record.result ?? "(empty)"}`;
      if (record.patchFile) {
        // [wave2 review] 长 return 拆行：模板串内不可直接换行（会改变输出内容），提取 patchHint 中转变量
        const patchHint = `\n\nThis subagent ran in an isolated worktree; its file changes were captured as a patch:\n  ${record.patchFile}\nTo bring these changes into the current repo, run: \`git apply ${record.patchFile}\``;
        return `${base}${patchHint}${transcriptPointer}`;
      }
      return `${base}${transcriptPointer}`;
    }
    case "running":
      // v4 B-1: 对话模式轮次完成（旧 idle 折入 running）：携带本轮结果送回主 agent，等待下一轮 message。
      // [subagent-observability §3.3.7①] 正文五分支事实化（失败/中止/正常/空正文/被接管
      // ——判定序与文案见 buildRoundReplyContent；`finished a round` 硬编码文案废除）。
      return buildRoundReplyContent(record);
  }
}

/**
 * Background 完成通知器接口（迁移后由内核实现）。
 *
 * 保持与旧 BgNotifier 类相同的公共 API，避免消费方（subagent-service）改动范围过大。
 */
export interface BgNotifier {
  /** 入队一条完成通知（边沿即投，判重由投递日志按 notifyId 承载）。dispose 后短路。 */
  notify(record: BgNotifyRecord): void;
  /** 立即 flush（session_shutdown 调用，防丢失）。 */
  flushPendingNotifications(): void;
  /** session 结束：清队列，dispose 内核 handle。 */
  dispose(): void;
  /** /resume /fork /new 后复活。 */
  revive(): void;
}

/**
 * 投递工厂缺席降级（投递端口槽缺席）时的最小直发 handle：send 直接调 port.send，
 * 无 gate / 合批窗口 / dedupe / 耐久。
 *
 * 缺席形态 = 投递端口未装配（base-tool-enhance session_start 装配异常 / 版本混装
 * 窗口，生产不可达常态）或测试未装配。降级是「消息仍能发出」的安全侧退化，降级
 * 代价显式登记（unified-delivery 设计 §3.7）：无判重无耐久（重复提交可能双投），
 * 仅覆盖装配异常窗口、不作为常态路径（fail-fast 导向：warn 即修复信号）。
 */
function createDirectSendHandle(port: DeliveryPort): DeliveryHandle {
  return {
    send: (msg) => {
      // 直发唯一形态 = triggerTurn（steer 形态注入）；回执（receipt）为扩展位，
      // 直发路径不消费。
      void port.send(msg, "interrupt-at-turn-boundary");
    },
    flush: () => {}, // 无队列（每条 send 即投），无待 flush 内容
    dispose: () => {}, // 无 timer / 订阅需清理
  };
}

/**
 * 创建 Background 完成通知器（薄工厂）。
 *
 * 投递统一走 pi 半区投递端口（getDeliveryPort 进程级槽，经 NotifyDomainPorts 注入
 * 访问器——core 闭包红线禁 import 该包）：受理前落投递日志、直达唯一队列、details-id
 * 送达凭据、重启差集重放均在端口侧（本函数零时机代码）。端口缺席：降级直发兜底
 * （createDirectSendHandle）+ warn 留痕 + 诊断计数（per-notifier 首次 + 计数递增
 * 限流——降级是装配级状态而非逐条通知事件）。
 * 本函数职责：BgNotifyRecord → 预格式化 content + notifyId 物化。
 *
 * @param host 宿主能力注入（直发兜底的 sendMessage）
 * @returns BgNotifier 接口
 */
export function createNotifier(host: NotifierHost): BgNotifier {
  let disposed = false;

  // 直发兜底的底层端口（pi.sendMessage 适配器——仅缺席降级路径消费）。
  const directPort: DeliveryPort = {
    supportedPayloads: ["custom"],
    isIdle: () => {
      if (host.isIdle) {
        return host.isIdle();
      }
      // 未注入 isIdle → 视为 idle（不 gate，向后兼容旧 host）
      return true;
    },
    send: (_msg, _intent) => {
      // 直发单通道：sendMessage({triggerTurn:true})（steer 形态注入）。返回 void =
      // 受理成功（同步无异常；SendReceipt 扩展位留待升级方接入）。
      host.sendMessage(
        {
          customType: NOTIFY_CUSTOM_TYPE,
          content: _msg.payload.content,
          display: true,
          details: _msg.payload.kind === "custom" ? _msg.payload.details : undefined,
        },
        { triggerTurn: true },
      );
    },
  };

  // 直发兜底 handle：无内核无状态，dispose 不可逆问题不存在（内核时代 revive 重建
  // handle 的 #5 语义随内核路径退役——直发 handle 恒可复用）。
  const directHandle: DeliveryHandle = createDirectSendHandle(directPort);

  /** port 缺席降级的 warn 与诊断计数（per-notifier 首次 + 1/10/100 递增限流）。
   *  降级代价：无判重无耐久（重复提交可能双投），仅覆盖装配异常窗口。 */
  let directFallbackCount = 0;
  function warnDirectFallback(notifyId: string): void {
    directFallbackCount += 1;
    const crossedMagnitude =
      directFallbackCount === 1 ||
      Math.floor(Math.log10(directFallbackCount)) !== Math.floor(Math.log10(directFallbackCount - 1));
    if (!crossedMagnitude) {
      return; // 限流：仅在 1 / 10 / 100 … 量级跨越时刷 warn
    }
    // 错误必须可操作：指出恢复动作（检查 base-tool-enhance 装配）与降级代价。
    notifyLogger.warn(
      "delivery port not bound - falling back to direct-send delivery (no dedupe / no durability; " +
        "check base-tool-enhance session_start bindDeliveryPort wiring)",
      { detail: { notifyId, fallbackTotal: directFallbackCount } },
    );
  }

  /**
   * 投递主路径：port.deliver（受理前落投递日志 + 直达唯一队列 + details-id 凭据 +
   * 重启差集重放，端口侧内包）。
   *
   * rejected（persist-failed = 受理前落盘失败）不降级直发：绕过耐久承诺制造
   * at-most-once 双语义，首败即停 + warn 显式上报（ADR-0122 ⑧）。
   */
  function deliverViaPort(
    notifyId: string,
    content: string,
    details: object,
    collectKey: string[] | undefined,
  ): boolean {
    const port = getNotifyDomainPorts().getDeliveryPort?.();
    if (port) {
      const result = port.deliver(
        {
          payload: {
            kind: "custom",
            customType: NOTIFY_CUSTOM_TYPE,
            content,
            display: true,
            details,
          },
          id: notifyId,
        },
        // [subagent-observability §3.3.7③] 攒批窗退役后边沿即投：无合批选项，
        // collectKey 债权申报（result-collect 设计 §3.4）保留——世代首个通知携带
        // （见 notify() 内申报判据），后续轮次 undefined。
        { ...(collectKey !== undefined ? { collectKey } : {}) },
      );
      if (result.kind === "rejected") {
        notifyLogger.warn(
          "delivery port rejected notification (idempotency key not registered; will retry on next notify)",
          { detail: { notifyId, reason: result.reason } },
        );
        return false;
      }
      return true;
    }
    // port 缺席：直发兜底（无判重无耐久——降级代价见 warnDirectFallback）。
    warnDirectFallback(notifyId);
    directHandle.send(
      {
        payload: {
          kind: "custom",
          customType: NOTIFY_CUSTOM_TYPE,
          content,
          display: true,
          details,
        },
        dedupeKey: notifyId,
      },
    );
    return true;
  }

  return {
    notify(record: BgNotifyRecord): void {
      if (disposed) return;

      // U3 C-outcome：派生视图边界物化 outcome——closed payload 缺省时按单一权威
      // deriveOutcome 兜底填充，content 与 details（GUI pane 消费）均携带一等 outcome；
      // 所有可达流程下与 record.outcome 等价（toNotifyRecord 在 completeLegacyClosed 之后
      // 构造）。running（轮次通知）语义上无 outcome，不物化。消源自 record 的浅拷贝
      // ——不改写入方对象（BgNotifyRecord 由调用方持有）。notifyId 同批物化（U2：
      // dedupe key 与账本身份键同源，details 携带供回执匹配）。
      // notifyId 构造：dedupKey 显式覆盖优先（drain 丢弃通知等派生通知的独立去重
      // 身份），缺省 = `id:round` / `id` 旧格式；[U5 / §3.2.3] epoch>0 时两种形态都
      // 带 epoch 段——轮次通知 `id:epoch:round`（reopen 后 round 归零不与历史轮撞
      // 键）、无轮通知 `id:epoch`（notifyClosed 显式清 round，reopen 后第二次 close
      // 的终态提示若沿用裸 id 会与首轮 close 撞键，被投递日志按「同 notifyId 已
      // 终局」永久判重吞掉——同 key 撞车吞通知是本代码库已修复过的事故类，epoch 是
      // 同族防御的构造性根治）。epoch=0 恒旧格式，磁盘投递日志零迁移。
      const withEpoch = record.epoch !== undefined && record.epoch > 0;
      const roundKey =
        record.round != null
          ? (withEpoch ? `${record.id}:${record.epoch}:${record.round}` : `${record.id}:${record.round}`)
          : (withEpoch ? `${record.id}:${record.epoch}` : record.id);
      const notifyId = record.dedupKey ?? roundKey;
      // collectKey 债权申报判据（result-collect 设计 §3.3 多轮通知条目）= 该操作
      // 世代的第一个通知：
      //  - round === 1：markRoundIdle 同位的首个轮终通知——轮终簿记先于通知发出
      //    （finalizeRoundOutcome 内 rec.round = (rec.round ?? 0) + 1，record-store-
      //    rounds.ts），世代内 round 从 0/undefined 单调递增、reopen 归零重计，故
      //    round === 1 在一个世代内恰出现一次 = 首个轮终（后续轮次 2,3,… 不申报，
      //    collect 等到首轮即返回，后续轮次正常 push）。
      //  - round == null：one-shot 完成通知 / close 收尾提示等无轮次身份的完成通知
      //    （notifyClosed 显式清 round），设计明示同样申报。
      //  - dedupKey 非 null：派生通知（drain 丢弃通知等，notifyId 已非世代主身份），
      //    非终态信号不申报。
      //  - reopen 新世代（epoch+1、round 归零）：首个轮终通知 round 重新 = 1 →
      //    重新申报、重新可收（collected 终局属旧世代条目，新世代条目无终局）。
      const collectKey =
        record.dedupKey === undefined && (record.round == null || record.round === 1)
          ? [record.id]
          : undefined;
      const payload: BgNotifyRecord =
        record.status === "closed"
          ? { ...record, outcome: record.outcome ?? deriveOutcome(record.closedReason, record.error), notifyId }
          : { ...record, notifyId };

      const content = buildLlmContent(payload);

      // 投递主路径（unified-delivery 波 2）：port.deliver 主投（受理前落投递日志 +
      // 直达唯一队列 + details-id 凭据 + 重启差集重放，端口侧内包）。port 缺席降级
      // 直发兜底 + warn。单条通知为 fire-and-forget，返回值忽略。
      deliverViaPort(notifyId, content, payload, collectKey);
    },

    flushPendingNotifications(): void {
      // 端口路径：强制投递尝试（窗口缓冲提前出站 + 内核 flush）；缺席（直发）无队列
      // 可 flush——no-op。
      getNotifyDomainPorts().getDeliveryPort?.()?.flush();
    },

    dispose(): void {
      disposed = true;
      // 直发兜底 handle 无资源（无 timer / 订阅）；端口生命周期归装配点
      // （base-tool-enhance session_start 对称 dispose），notifier 不越权销毁。
      directHandle.dispose();
    },

    revive(): void {
      disposed = false;
      // 直发 handle 无 disposed 不可逆问题（内核时代 revive 重建 handle 的 #5 语义
      // 随内核路径退役）——复位外层标志即可。
    },
  };
}
