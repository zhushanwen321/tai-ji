// src/execution/conversation-continuation.ts
//
// [H1 U2] ConversationContinuation——chat 域统一进 run 域的唯一新增组件（设计
// docs/design/subagent-chat-run-unification.md §3.4，伪码即实现契约）。
//
// 一个 chatMode record 一个实例：对话容器 = record，续聊轮 = 「新 run + resume 锚点」
//（pi --session 续写原 session 文件）。本类承载三面：
//   - onMessage：D4 状态迁移表的 message 行（终态分流 / 在途轮打断入队 / 轮间直派）；
//   - dispatchRound：每轮派发（stale-child 兜底 → 载荷组装守卫 → 泛化派发主干）；
//   - onRunSettled：run 应答回调（resolve 时点 = agent_settled，D7）——终态守卫整体
//     early-return → settle 段交棒 → 成功/失败轮末分流（D7）→ drain 队列。
//
// 红线（单写者不变量，两级声明）的实现归属：
//   - cancel/正常路径 = 构造性保证：本类单飞——abort 收敛（进程退出 = run 应答收敛）
//     是 drain 派发下一轮的前置事件，编排上不存在并发派发（dispatchRoundGuarded
//     同步段占位 activeRunId，异步窗内重入被拒）。
//   - 崩溃路径 = 引擎退出链收割（engine-client teardownProcess，红线①）+ 派发前
//     stale-child 兜底（host.killStaleChild，红线②）+ 宿主重启单窗口（经验性，登记）。
//
// 编排能力经 ContinuationHost 注入（service 闭包）——本模块可独立编译与单测；
// 通知门（notifyGateAllowsDelivery）双闸消费：成功分支 route 前 + 失败分支独立
// 载荷发出前（B#19 投递门照迁移），与 onRunSettled 的 status 终态面正交双闸。

import type { AgentOutcome, ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "../core/error-message.ts";
import { getLogger } from "../core/logger.ts";

import { resurrectClosed } from "./execution-record.ts";
// 轮终 outcome 入参（权威定义在 finalize-record.ts，本文件 re-export 供 host 契约引用；
// finalize-record 不反向依赖本模块，无循环）。
import { type RoundSettlementOutcome } from "./finalize-record.ts";
export type { RoundSettlementOutcome };
import { engineConversationUpgradeUnsupportedError } from "./engine/common/capability-gate.ts";
import { PI_POOL_KEY } from "./engine/host/pi-host-binding.ts";
import { type BgNotifyRecord, notifyGateAllowsDelivery } from "./notifier.ts";
import {
  type SettledWatchdogFireInfo,
  disarmRoundFromProtocol,
  noteRoundSettledFromProtocol,
} from "./settled-watchdog.ts";
import { isReconnectableFinalReason } from "./types.ts";
import type { ExecutionRecord } from "./types.ts";

const logger = getLogger("subagents");

/** 失败通知的恢复指引尾段（[T2-③/LC-1] 可达性语义——失败原因 + 恢复指引必须可达宿主）。 */
const FAILURE_RECOVERY_TAIL =
  "Recovery: re-send your message (action:'message') to continue — the conversation " +
  "context is preserved (session file intact), or use action:'close' to discard it.";

/**
 * 泛化派发主干的轮次回调面（service.kickOffChatRound 泛化参数，D6）。
 * run resolve（= agent_settled）/ run reject（prepare 期失败）/ acquire 被打断
 * （无 run 产生）三分，全部回流 Continuation 单点收口。
 */
export interface ContinuationRoundHandlers {
  /** run 应答（resolve = agent_settled，D7 定案）。 */
  onSettled(outcome: AgentOutcome): void;
  /** run reject（prepare 期失败——进程创建前；转失败轮末分流）。 */
  onRejected(err: unknown): void;
  /** acquire 排队窗被打断/取消（无 run 产生）：不终态化、不通知，直接 drain。 */
  onAbandoned(): void;
  /** settled-watchdog fire（中段无进展 / 收尾段上界）：kill 在途轮，run 收敛后
   *  经 onSettled/onRejected 走失败分支统一收口。 */
  onWatchdogFire(fire: SettledWatchdogFireInfo): void;
}

/** dispatchRound ④ 经泛化派发主干发起 run 的入参（每轮语义载荷）。 */
export interface ContinuationDispatchInput {
  /** 本轮聚合消息正文（多条排队消息聚合为一轮输入，§3.1 打断路径）。 */
  task: string;
  /** resume 锚点（续聊轮恒带；首轮 undefined）。 */
  resume?: ResumeAnchor;
  /** 轮级 abort 通道（record controller 级联 + 打断通道，见 dispatchRound）。 */
  signal: AbortSignal;
  handlers: ContinuationRoundHandlers;
}

/**
 * Continuation 对宿主编排能力的窄依赖（service 闭包注入；单测全 mock）。
 */
export interface ContinuationHost {
  /** 泛化派发主干（D6：kickOffChatRound 共享部分——pool acquire / stream / chat 键
   *  组装 / armMidRoundNoProgress），应答经 handlers 回流。 */
  dispatchChatRound(record: ExecutionRecord, input: ContinuationDispatchInput): void;
  /** 轮终簿记（doFinalizeRoundToIdle wrapper，D7 outcome 入参）。 */
  finalizeRoundOutcome(record: ExecutionRecord, outcome: RoundSettlementOutcomeAlias): Promise<void>;
  /** 成功通知路由（collectCoordinator.route——正文权威 = record.result）。 */
  routeRecord(record: ExecutionRecord): void;
  /** 失败通知直投（独立构造载荷——不经 route，正文不读 record.result）。 */
  notifyRecord(record: BgNotifyRecord): void;
  /** 红线②派发前兜底：镜像在途子进程活着 → kill 等退出（引擎存活期状态错配）。 */
  killStaleChild(recordId: string): Promise<void>;
  /** watchdog fire 的 kill 手段（kill + 协议 cancel——run 收敛由杀链驱动）。 */
  killRoundChild(recordId: string, source: string): void;
  /** D5 gate 判据：record 所属引擎 conversation 位（unsupported / 未注册 = false）。 */
  upgradeGateAllows(record: ExecutionRecord): boolean;
  /** D4 revive 格的宿主面：revive 后的 record register + 迁移上报（entry 落盘）。 */
  reviveClosedRecord(record: ExecutionRecord): void;
  /** 轮始簿记（store.markRoundStarted：status=running + result/resumable 清除 +
   *  迁移上报 entry 落盘——[U2b 修复轮/D2] 归口原 dispatchRoundAsync 三行现场写）。 */
  markRoundStarted(record: ExecutionRecord): void;
  /** D4 close 行的立即终态化收口（closeChatIdle：doFinalizeRecord 语义 + notifyClosed）。 */
  closeNow(record: ExecutionRecord): Promise<void>;
}

/** host 契约内的 outcome 形态（RoundSettlementOutcome，见顶部 import）。 */
type RoundSettlementOutcomeAlias = RoundSettlementOutcome;

/** Mutable 断言（chatMode readonly 字段的升级写点——actions-core 写点①同款形态）。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * ConversationContinuation（每 chatMode record 一个实例；§3.4 全规格）。
 */
export class ConversationContinuation {
  /** 在途轮标识（单飞守卫；undefined = 无在途轮。派发异步窗内为占位值）。 */
  private activeRunId: string | undefined;
  /** 在途轮打断通道（D2：abort 轮 signal，非 record 级 cancel——cancelBackground 会
   *  终态化销毁 record，不可用于打断）。 */
  private activeController: AbortController | undefined;
  /** FIFO 待发消息（在途轮打断窗内到达的 message；abort 收敛后 drain 聚合为一轮）。 */
  private readonly queue: string[] = [];

  constructor(
    private readonly record: ExecutionRecord,
    private readonly host: ContinuationHost,
  ) {}

  /** 当前绑定的 record（service 侧缓存刷新判定用——跨重启冷查重建新对象）。 */
  get boundRecord(): ExecutionRecord {
    return this.record;
  }

  get hasActiveRound(): boolean {
    return this.activeRunId !== undefined;
  }

  /** 待发队列长度（诊断/测试）。 */
  get pendingCount(): number {
    return this.queue.length;
  }

  // ── 首轮派发（conversation:true start，§3.5 终态数据流入口）──────────

  /**
   * 首轮派发：不经 D4 分流与锚点守卫（新 record 无 sessionFile——run 应答回填），
   * 无 resume（新 session）。守卫 throw 直达调用方（executeViaEngine 同步段）。
   */
  startFirstRound(task: string): void {
    this.dispatchRoundGuarded([task], true);
  }

  // ── D4 状态迁移表：message 行 ────────────────────────────────────

  /**
   * message 入口（chatActions.deliverChatMessage 改写后的编排落点）。
   *
   * D4 表逐格：
   *   - record 已终态（user-close/cancelled）→ 硬拒（endedMessageGuard 同语义）；
   *   - record closed 但属可重连终态（disconnected/parent-shutdown）→ revive +
   *     非 chatMode 升级格（D4 revive 格：gate 放行 → 置位 chatMode=true 再续聊；
   *     gate 不过 → 硬拒 + fork/重派指引）；
   *   - running（有在途轮）→ D2 打断：abort 在途轮 signal（record 不终态化）+
   *     入队，abort 收敛后 drain；
   *   - running（轮间 idle）→ 直接派发新轮。
   *
   * @throws Error 终态硬拒 / 锚点缺失 / worktree 绑定丢失（同步拒绝，文案即指引）。
   */
  onMessage(text: string): void {
    const record = this.record;
    if (record.status !== "running") {
      this.reviveOrThrow();
    }
    if (this.activeRunId !== undefined) {
      // D2 打断语义：消息即时生效，永不「忙」拒绝。占位窗（activeController 未建）
      // 到达的消息仅入队——派发完成后轮终 drain 承接。
      this.activeController?.abort();
      this.queue.push(text);
      return;
    }
    this.dispatchRoundGuarded([text], false);
  }

  // ── D4 状态迁移表：close 行（abort + 清队列；立即终态化由 host.closeNow 承接）──

  /**
   * close 的 Continuation 侧职责：abort 在途轮 + 清空队列（D4——chat 域不再置
   * closeAfterRound 挂起标志，不等轮终）。终态化（closed/user-close + notifyClosed）
   * 由 host.closeNow（closeChatIdle 收口序列）承接，二者由 service.closeSubagent 编排。
   */
  abortAndClearQueue(): void {
    this.activeController?.abort();
    this.queue.length = 0;
  }

  // ── run 应答回调（resolve = agent_settled，D7）────────────────────

  /**
   * 轮末分流唯一入口（设计 §3.4 onRunSettled）。
   *
   * 【终态守卫 = 整体 early-return，先于一切分支】record 已终态化（close/cancel
   * 抢先）→ 直接返回：不 roundIdle（否则 close 终态化被 doFinalizeRoundToIdle 的
   * 「覆盖 closed 回滚为 running」机制回滚）、不通知、不 drain——S7 精确语义。
   * notifyGate 门与此正交并存（门判 closedReason 编排面、守卫判 status 终态面，
   * 两闸判据不同源不互替）。
   */
  onRunSettled(outcome: AgentOutcome): void {
    this.clearActiveRound();
    if (this.record.status !== "running") {
      this.queue.length = 0;
      return;
    }
    // settle 段交棒（run 应答驱动，D7 v5 轻形态——零协议扩展）：先于轮终簿记，
    // watchdog 停表早于状态写。resource 未挂载时幂等 no-op。
    noteRoundSettledFromProtocol(this.record.id);
    if (outcome.error !== undefined) {
      void this.settleRoundFailed(outcome.error);
      return;
    }
    void this.settleRoundSuccess(outcome);
  }

  /** run reject（prepare 期失败——进程创建前）：合成失败轮末分流。 */
  onRoundRejected(err: unknown): void {
    this.clearActiveRound();
    if (this.record.status !== "running") return;
    void this.settleRoundFailed(toErrorMessage(err));
  }

  /** acquire 被打断/排队窗取消（无 run 产生）：不终态化、不通知，直接 drain。 */
  onRoundAbandoned(): void {
    this.clearActiveRound();
    if (this.record.status !== "running") return;
    this.drain();
  }

  /** settled-watchdog fire：kill 在途轮（协议 cancel + 镜像置死）+ abort 轮 signal
   *  ——run 收敛（进程退出）后经 onSettled/onRejected 走失败分支统一收口（含失败
   *  通知），不在回调内直接簿记（单写者：收口只走 run 应答一条路）。 */
  onWatchdogFire(fire: SettledWatchdogFireInfo): void {
    this.host.killRoundChild(this.record.id, `settled watchdog (${fire.phase})`);
    this.activeController?.abort();
  }

  // ── 派发（§3.4 dispatchRound）────────────────────────────────────

  /**
   * 同步守卫段 + 占位（构造性单飞）：守卫 throw 直达调用方（tool 错误面——
   * async 函数内的 throw 会变 rejected promise，`void` 调用丢传导，故守卫必须
   * 在同步段完成）；activeRunId 同步占位，dispatchRoundAsync 的 await 窗内
   * 重入被拒（单写者构造性保证的实现面）。
   */
  private dispatchRoundGuarded(msgs: string[], firstRound: boolean): void {
    const record = this.record;
    if (record.status !== "running") return;
    if (this.activeRunId !== undefined) return; // 双保险（正常路径 onMessage 已分流）
    if (!firstRound) {
      if (!record.sessionFile) {
        // §3.1 失败路径表：锚点缺失同步拒绝，文案即指引。
        throw new Error(`no transcript anchor on record ${record.id}; re-dispatch (action:'start')`);
      }
      if (record.hadWorktree === true && !record.worktreeHandle) {
        // 跨重启 worktree 绑定丢失守卫（承接 resumeColdRound 同款）：防 resume 的
        // spawn cwd 静默回落主 repo，子 agent 直接编辑主仓库。
        throw new Error(
          `subagent ${record.id} was created with worktree isolation, but that binding was lost when the parent process restarted; ` +
          `resuming it now would run in the main repository and bypass the isolation. ` +
          `Recovery: use action:'close' to release this subagent, then action:'start' a new one with worktree isolation.`,
        );
      }
    }
    if (!record.controller) {
      // chatMode background record 创建时一定有 controller；防御性检查（MF-4 行动语言）。
      throw new Error(
        `subagent ${record.id} is not ready for a new message (internal state error). ` +
        `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
      );
    }
    // 占位（正式 roundId 在派发段定稿）：单飞窗从本同步段开始。
    this.activeRunId = `${record.id}#dispatching`;
    void this.dispatchRoundAsync(msgs, firstRound);
  }

  private async dispatchRoundAsync(msgs: string[], firstRound: boolean): Promise<void> {
    const record = this.record;
    // ① stale-child 兜底（红线第二级②）：镜像在途子进程活着 → kill 等退出。
    //    引擎已死场景的孤儿由引擎退出链收割兜底（红线第二级①，engine-client）。
    try {
      await this.host.killStaleChild(record.id);
    } catch (err) {
      // 兜底失败不阻断派发（与 terminateChatSession 的 best-effort 同语义）；失败
      // 信号已在 host 侧留痕。残余双写窗由 S4 实测与红线③登记承接。
      void err;
    }
    if (record.status !== "running") {
      // 兜底窗内 close/cancel 抢先终态化 → 本轮作废（终态守卫同构语义）。
      this.clearActiveRound();
      this.queue.length = 0;
      return;
    }

    // ② 载荷组装：轮级 signal（record controller 级联 + 打断通道）。
    //    model 身份重建 / resume 锚点 / chat 键组装 / sessionRootId 注入 / pool
    //    acquire / priority 在泛化派发主干（host.dispatchChatRound——归自
    //    resumeColdRound/kickOffChatRound 现有实现，D6）。
    const controller = new AbortController();
    const onRecordAbort = (): void => controller.abort();
    const recordSignal = record.controller!.signal;
    if (recordSignal.aborted) controller.abort();
    else recordSignal.addEventListener("abort", onRecordAbort, { once: true });

    const roundNo = (record.round ?? 0) + 1;
    this.activeRunId = `${record.id}#${roundNo}`;
    this.activeController = controller;
    // 轮始簿记归口（[U2b 修复轮/D2] store.markRoundStarted：status=running 重申 +
    // 清上一轮 result 与 resumable——§5.4 isStreaming 公式要求 result undefined 才
    // 显示 streaming，不清则续轮流仍显示 waiting、spinner 无法恢复；迁移上报 entry
    // 落盘让 GUI 派生缓存失效、从 waiting 切回 spinner。U1 原语簿记为原三行现场写
    // 的超集，多出 notifyChange 刷新）。record 不在 store 内存的形态 = false 旁路
    // debug 留痕（生产链路 Continuation 绑定的 record 恒在册）。
    this.host.markRoundStarted(record);
    const concludeRound = (): void => {
      recordSignal.removeEventListener("abort", onRecordAbort);
    };
    try {
      this.host.dispatchChatRound(record, {
        // 多条聚合为一轮输入（§3.1：cancel 宽限窗内多条消息按序聚合）。
        task: msgs.join("\n\n"),
        resume: firstRound ? undefined : this.resumeAnchor(),
        signal: controller.signal,
        handlers: {
          onSettled: (outcome) => {
            concludeRound();
            this.onRunSettled(outcome);
          },
          onRejected: (err) => {
            concludeRound();
            this.onRoundRejected(err);
          },
          onAbandoned: () => {
            concludeRound();
            this.onRoundAbandoned();
          },
          onWatchdogFire: (fire) => this.onWatchdogFire(fire),
        },
      });
    } catch (err) {
      // 主干同步段 throw（stream 创建 / 端口解析等）：转失败轮末分流（与 run reject
      // 同语义——record 保持 running-resumable，宿主经失败通知感知）。
      concludeRound();
      this.onRoundRejected(err);
    }
  }

  /** resume 锚点 = record identity（sessionFile 续写原文件；pi 无池化 poolKey 恒 'shared'）。 */
  private resumeAnchor(): ResumeAnchor {
    return {
      sessionRef: {
        recordId: this.record.id,
        ...(this.record.sessionFile !== undefined ? { sessionFile: this.record.sessionFile } : {}),
      },
      poolKey: PI_POOL_KEY,
    };
  }

  // ── 轮末分流（D7）────────────────────────────────────────────────

  /** 轮终守护清理（旧 idle 相位帧 disarmRoundFromProtocol 语义的 run 应答驱动承接）：
   *  轮终簿记完成 = 本轮等待窗口终结，两段守护一并清（收尾段不残留 armed——fire 会对
   *  已收敛轮误发 kill/cancel）。drain 派发下一轮时 armMidRoundNoProgress 重挂新窗。 */
  private disarmRoundWatchdog(): void {
    disarmRoundFromProtocol(this.record.id);
  }

  /** 成功分支：轮终簿记（success）→ notifyGate 门 → route（次序：route 晚于簿记）。 */
  private async settleRoundSuccess(outcome: AgentOutcome): Promise<void> {
    const record = this.record;
    await this.host.finalizeRoundOutcome(record, { kind: "success", content: outcome.content });
    this.disarmRoundWatchdog();
    // 成功通知：「门 → route」双闸（v6 显式迁移自 settleChatRoundFromResponse——
    // 门判 closedReason 编排面，拦 parent-new/parent-fork 编排性关闭的迟到应答与
    // cancelled 的迟到帧；route 正文权威 = record.result = 本轮 content）。
    if (notifyGateAllowsDelivery(record.closedReason)) {
      this.host.routeRecord(record);
    }
    this.drain();
  }

  /**
   * 失败/中断分支：lastError + 轮终簿记（failed——round 同样 +1，result = 前值 ??
   * 失败摘要）+ 失败通知（独立构造载荷——不经 route(record)：其正文恒读
   * record.result = 前值，直接复用会以旧正文冒充失败通知；正文 = 失败摘要 + 恢复
   * 指引，可达性迁移自 [T2-③/LC-1]）+ record 保持 running-resumable（MF-6）。
   * 发前过 notifyGate 门（B#19 投递门照迁移：拦 cancelled 竞态窗防双发、
   * parent-new/parent-fork 竞态窗防僵尸回执注入已切换 session——守卫是入口一次性
   * 判定，覆盖不了簿记 await 链内的中途关闭窗）。
   */
  private async settleRoundFailed(reason: string): Promise<void> {
    const record = this.record;
    await this.host.finalizeRoundOutcome(record, { kind: "failed", reason });
    this.disarmRoundWatchdog();
    if (!notifyGateAllowsDelivery(record.closedReason)) {
      this.drain();
      return;
    }
    // dedup key = record:round（notifier 65 行口径不变）：round 已随簿记 +1，
    // 失败轮通知与上一轮成功通知天然分离（60s 窗不吞）。
    const notify: BgNotifyRecord = {
      id: record.id,
      // status:"closed" + outcome:"failed" 载荷 = buildLlmContent 的失败文案形态
      // `Subagent "agent" (id) failed: <error>`——载荷只是通知文案载体，record 实态
      // 保持 running-resumable（容器未被销毁，status 面 GUI 照常显示运行中）。
      status: "closed",
      closedReason: "gc",
      outcome: "failed",
      agent: record.agent,
      ...(record.model !== undefined ? { model: record.model } : {}),
      error: `round did not complete: ${reason}. ${FAILURE_RECOVERY_TAIL}`,
      startedAt: record.startedAt,
      endedAt: Date.now(),
      round: record.round,
      ...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
    };
    this.host.notifyRecord(notify);
    this.drain();
  }

  /**
   * 队列 drain：abort 收敛（单写者前置满足）后按序派发；多条聚合为一轮输入。
   *
   * [A2] 内部续派路径的守卫 throw 必须就地转错误面：本方法运行在 settle 后续派
   *（settleRoundSuccess/settleRoundFailed 尾部，async 函数体内的同步调用）与
   * onRoundAbandoned 的 fire-and-forget 链上，dispatchRoundGuarded 的同步守卫 throw
   *（锚点缺失 / worktree 绑定丢失 / controller 缺失）若逃逸即成 unhandled rejection
   *（Node ≥15 默认崩宿主）且队列消息静默丢失。可达触发例：首轮在途时 message 打断
   * 入队 → 首轮崩溃（合成 outcome 无 sessionFile）→ 失败 settle → drain 以
   * firstRound=false 走锚点守卫 → throw。转换语义：失败通知（独立载荷过 notifyGate
   * 门，与 settleRoundFailed 失败单发同构——record 保持 running-resumable，载荷
   * closed+failed 仅是文案载体）+ 队列丢弃留痕（warn）。onMessage 同步入口的守卫
   * throw 保留（设计 §3.1 失败路径表的工具错误面，不经本方法）。
   */
  private drain(): void {
    if (this.record.status !== "running") {
      this.queue.length = 0;
      return;
    }
    if (this.queue.length === 0) return;
    const next = this.queue.splice(0);
    try {
      this.dispatchRoundGuarded(next, false);
    } catch (err) {
      const reason = toErrorMessage(err);
      logger.warn(
        `[subagent] queued message dispatch rejected for ${this.record.id}: ${reason} — ` +
        `${next.length} queued message(s) dropped`,
      );
      if (notifyGateAllowsDelivery(this.record.closedReason)) {
        // dedup 身份必须独立于同轮失败通知（settleRoundFailed 缺省 key = `id:round`）：
        // 主可达场景「首轮崩溃 → 失败 settle（通知1 发出）→ drain 守卫 throw → 丢弃
        // 通知（通知2）」中两通知同轮同 key，沿用缺省 key 会被 ledger/内核按 key 永久
        // 去重吞掉（notifier dedupe 永久 + ledger 幂等）——「队列消息被丢」的显式反馈
        // 永不可达。故经 dedupKey 传 `id:round:drain-drop`：
        //   - 带 round：不同轮的 drain 丢弃是不同事件（各轮 queue 的消息不同，每次都
        //     应显式反馈），不带 round 会让本 bug 在「第二轮及以后」以同构路径复现；
        //   - 同轮重放同 key 合理：同轮 drain 丢弃是同一事件的反馈（queue 已 splice
        //     清空，单飞守卫下同轮不会二次丢弃），at-least-once 幂等语义成立。
        const dropDedupKey = this.record.round != null
          ? `${this.record.id}:${this.record.round}:drain-drop`
          : `${this.record.id}:drain-drop`;
        this.host.notifyRecord({
          id: this.record.id,
          // status:"closed" + outcome:"failed" 载荷 = 失败文案形态（settleRoundFailed
          // 同构）——载荷只是通知文案载体，record 实态保持 running-resumable。
          status: "closed",
          closedReason: "gc",
          outcome: "failed",
          agent: this.record.agent,
          ...(this.record.model !== undefined ? { model: this.record.model } : {}),
          error: `queued message could not be dispatched: ${reason}`,
          startedAt: this.record.startedAt,
          endedAt: Date.now(),
          round: this.record.round,
          ...(this.record.sessionFile !== undefined ? { sessionFile: this.record.sessionFile } : {}),
          dedupKey: dropDedupKey,
        });
      }
    }
  }

  private clearActiveRound(): void {
    this.activeRunId = undefined;
    this.activeController = undefined;
  }

  // ── D4 revive 格（closed 可重连终态 → revive [+ 非 chatMode 升级] → 续聊）──

  /**
   * 终态分流（onMessage 入口的 record.status !== "running" 分支）。
   *
   *   - user-close/cancelled → 硬拒（D4 表 closed 硬拒格；文案与 endedMessageGuard
   *     的主动告别分支同语义）；
   *   - 可重连终态（disconnected/parent-shutdown，RECONNECTABLE_FINAL_REASONS）→
   *     非 chatMode 升级格（D4 revive 格 v4 显式化：水合保留持久化 chatMode 后，
   *     `chatMode !== true` 的 record 收到 message → 升级置位 chatMode=true 再续聊；
   *     语义承接原 cold-resurrect 的无条件置位（U6 已删）——session shutdown 时被
     *     disposeAllRecords 关成 parent-shutdown 的在途 one-shot 正靠此路径保持可续）
   *     + D5 gate 前置（conversation 位检查，gate 不过 → 硬拒 + fork/重派指引）；
   *   - 其余 closed（gc/parent-new/parent-fork）→ 按不可重连硬拒（fork-from 指引）。
   */
  private reviveOrThrow(): void {
    const record = this.record;
    if (record.status !== "closed" || !isReconnectableFinalReason(record.closedReason)) {
      const reasonDesc = record.closedReason !== undefined ? ` (closedReason: ${record.closedReason})` : "";
      throw new Error(
        `subagent ${record.id} was deliberately closed by user${reasonDesc} — ` +
        `it cannot be messaged or resumed; nothing can reattach to it. ` +
        `Recovery: start a new subagent (action:'start'); use action:'list' with includeFinished:true to review its final output (add includeWorkflow:true to also see workflow-dispatched subagents).`,
      );
    }
    if (record.chatMode !== true) {
      // D5 gate 前置（双写点②）：gate 不过 → 硬拒 + fork/重派指引，防 unsupported
      // 引擎升级后续聊行为悬空。
      if (!this.host.upgradeGateAllows(record)) {
        throw engineConversationUpgradeUnsupportedError(record.engine ?? "pi");
      }
      (record as Mutable<ExecutionRecord>).chatMode = true;
    }
    if (!resurrectClosed(record)) {
      // closed → running 回边失败 = 竞态终态化（close/cancel 抢先）——按已终态硬拒。
      throw new Error(
        `subagent ${record.id} was closed while the message was being processed — it cannot be messaged. ` +
        `Recovery: start a new subagent (action:'start').`,
      );
    }
    // revive 宿主面：register（跨重启重建后不在内存的形态）+ 迁移上报（entry 落盘，
    // live/reload 视图同步）。
    this.host.reviveClosedRecord(record);
  }
}
