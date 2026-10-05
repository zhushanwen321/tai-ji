// src/host/journal-reporter.ts
//
// 壳层 journal 事件推送出口（event-push-channel W-P1，设计权威源
// .tmp/tech-design/event-push-channel.md §3.1/§3.3/§3.4）。本文件属壳侧（shell），
// 对 pi SDK（ExtensionContext 的 ctx.ui.select 通道）的消费收敛在 host/ 层——
// core 闭包红线只约束 core（出口回调由 core 的 journal-notify 注入，见组合根
// workflow-events.ts 的 setJournalAppendListener 接线）。
//
// 链路：core journal 落盘提交点（run 域 terminal-actions / record 域 record-store
// 族）→ notifyJournalAppended（同步回调）→ 本 reporter（事件按 (domain, fileKey)
// 分组合并 → select 通道帧，title = SUBAGENT_JOURNAL_MARKER）→ runtime event-adapter
// marker 路由 → session-records 派生视图（applyJournalReport）。
//
// 语义（设计 §3.3）：单帧报告覆盖一个文件（fileKey 单数）；事件 = 刚落盘的行对象
// （seq 已分配），不做水位协商——去重与缺口判定归消费方（fold seq 单调守卫构造性
// 幂等）。串行化合并：一次推送尝试在途时，后续事件并入待推缓冲；尝试成功后缓冲
// 剩余组继续逐组推送（事件驱动，无 timer）。
//
// 失败语义（设计 D5，与 inflight reporter 的 dirty 重推刻意分叉）：select 失败
// （超时/通道异常/非确认回包）→ 首败 warn 留证 + 待推缓冲整体丢弃——**不重试**
// （本通道消费方有 seq 水位可判缺口，丢失由缺口补读收敛，缓冲重推是重复保险）。
// 无后续事件的丢失场景由终局条目补读触发兜底（设计 §3.3 终局一致性）。
// 送达判据 = runtime resolve 的确认回包（JOURNAL_REPORT_ACK）——回执 = 「已应用」
// （runtime 同步完成 fold 后 resolve）。
//
// 环境门控：上报的消费方是 taiji runtime 的 event-adapter marker 路由，runtime
// spawn pi 恒为 --mode rpc——ctx.mode !== 'rpc' 即无拦截方（裸 pi TUI 下 marker
// select 会弹真框），此时不启动推送（inflight-reporter 环境门控同款）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_JOURNAL_MARKER,
  callMarkerRpc,
  isJournalReportAck,
  type SubagentJournalDomain,
  type SubagentJournalEvent,
} from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";

/** select 通道级超时（控制面单请求，秒级校准——超时默认原则规则 19；与 inflight
 *  reporter 同量级。失败不重试，缺口归消费方补读收敛）。 */
const SELECT_TIMEOUT_MS = 2_000;

/** 单帧报告字节数的观测阈值（设计 W-P4 ④：只观测不拦截——超限 warn 留痕，供
 *  worker-log 高频行合并量级评估；不设硬上限，截断会破坏报告内 seq 连续性判定）。 */
const REPORT_BYTES_WARN_THRESHOLD = 100_000;

/** 单文件待推事件组（报告的逐文件分组形态）。 */
type PendingFileGroup = {
  domain: SubagentJournalDomain;
  fileKey: string;
  events: SubagentJournalEvent[];
};

/** journal 事件推送器（workflow-events 装配点持有；per-factory 实例，session_start/shutdown 驱动）。 */
export interface JournalReporter { // oe-exempt:20261003:framework:host 层对装配点的 reporter 端口契约（attach/detach/onJournalAppended 消费缝先立）
  /**
   * session_start 注入当前 ctx（非 rpc 模式下为 no-op：无 runtime 拦截方，推送
   * 通道不该启动）。journal 推送是纯事件驱动（落盘提交点触发），无初始帧——
   * 与 inflight 的「加载完成初始上报」刻意不同：报告语义是增量事件，空 session
   * 无事件可报，缺席语义归消费方冷读。
   */
  attachSession(ctx: ExtensionContext): void;
  /** session_shutdown 摘除 ctx 并丢弃待推缓冲（session 已死，推送通道随之终结；
   *  未推事件由消费方冷读/缺口补读收敛）。 */
  detachSession(): void;
  /** core 出口回调（notifyJournalAppended 直连）：同步返回，内部分组合并 + void 推送。 */
  onJournalAppended(domain: SubagentJournalDomain, fileKey: string, events: readonly unknown[]): void;
}

export interface JournalReporterOpts { // oe-exempt:20261003:framework:工厂参数契约（测试注入缝，消费方 workflow-events 以不同 opts 实例化）
  /** 测试注入：select 超时（ms）。缺省 SELECT_TIMEOUT_MS。 */
  selectTimeoutMs?: number;
  /** 测试注入：报告字节数观测阈值。缺省 REPORT_BYTES_WARN_THRESHOLD。 */
  reportBytesWarnThreshold?: number;
}

/**
 * sessionId 从 ctx 取：pi session 文件延迟写入窗口内取失败不阻断推送——sessionId
 * 缺席时 runtime 按无法归属丢弃整帧（契约 SubagentJournalReport.sessionId 可选语义），
 * 不视为协议错误。
 */
function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

export function createJournalReporter(opts: JournalReporterOpts = {}): JournalReporter {
  const selectTimeoutMs = opts.selectTimeoutMs ?? SELECT_TIMEOUT_MS;
  const reportBytesWarnThreshold = opts.reportBytesWarnThreshold ?? REPORT_BYTES_WARN_THRESHOLD;
  const logger = getLogger("subagents");

  // 闭包状态（per-factory 实例；禁模块级 let——同进程多 factory 实例会串台）。
  let ctx: ExtensionContext | null = null;
  /** 待推缓冲（(domain,fileKey) → 事件组；推送在途期间新事件并入，尝试启动时取走）。 */
  const pending = new Map<string, PendingFileGroup>();
  /** 一次推送尝试在途（串行化——组间逐帧发送，避免并发 select 帧交叉）。 */
  let attemptInFlight = false;
  /** 首次失败已 warn 留痕（后续失败不刷屏；随 attach 重置——新 session 的首败仍显式上报）。 */
  let firstFailureLogged = false;

  function groupKeyOf(domain: SubagentJournalDomain, fileKey: string): string {
    return `${domain}:${fileKey}`;
  }

  /** core 出口回调直连：事件并入待推缓冲 + 事件驱动 kick（同步返回，不阻塞落盘主链）。 */
  function onJournalAppended(
    domain: SubagentJournalDomain,
    fileKey: string,
    events: readonly unknown[],
  ): void {
    if (ctx === null || events.length === 0) return;
    const key = groupKeyOf(domain, fileKey);
    const group = pending.get(key);
    if (group !== undefined) {
      group.events.push(...(events as SubagentJournalEvent[]));
    } else {
      pending.set(key, { domain, fileKey, events: [...(events as SubagentJournalEvent[])] });
    }
    kick();
  }

  /** 推送在途时不重入（缓冲已承接）；否则逐组发起推送（void，不阻塞调用方）。 */
  function kick(): void {
    if (attemptInFlight || ctx === null) return;
    attemptInFlight = true;
    void attempt();
  }

  async function attempt(): Promise<void> {
    try {
      let active = ctx;
      while (active !== null && pending.size > 0) {
        // 取首组发送（FIFO——Map 插入序 = 事件到达序）；组在发送前移出缓冲：
        // 失败时该组与其余待推组一起丢弃（D5 缓冲即弃），成功时继续下一组。
        const [key, group] = pending.entries().next().value as [string, PendingFileGroup];
        pending.delete(key);
        const payload = JSON.stringify({
          domain: group.domain,
          fileKey: group.fileKey,
          events: group.events,
          sessionId: getSessionId(active),
          emittedAt: Date.now(),
        });
        if (payload.length > reportBytesWarnThreshold) {
          logger.warn(`[subagent-journal] report size exceeds observation threshold (${payload.length} bytes, file=${group.fileKey}, events=${group.events.length}) — observation only, no rejection`);
        }
        const guiCtx = {
          mode: active.mode,
          hasUI: active.hasUI,
          ui: { select: active.ui.select.bind(active.ui) },
        };
        const result = await callMarkerRpc(guiCtx, SUBAGENT_JOURNAL_MARKER, payload, {
          timeout: selectTimeoutMs,
          log: primitiveLog,
        });
        if (!(result.ok && isJournalReportAck(result.value))) {
          logFailure(result.ok ? "no ack (non-ack response)" : `no ack (${result.reason})`);
          pending.clear(); // D5：失败即弃缓冲（不重推）——完整性归消费方 seq 缺口补读
          return;
        }
        active = ctx; // 尝试期间可能 detach/attach——每轮现读
      }
    } finally {
      attemptInFlight = false;
    }
    // 成功路径：detach 后 ctx 为 null（while 退出）——缓冲随 detach 清空，无残留。
  }

  /** 原语留痕注入：msg/detail 由 callMarkerRpc 产出；防刷屏策略留本侧 logFailure。 */
  function primitiveLog(msg: string, detail?: object): void {
    logFailure(detail === undefined ? msg : `${msg} ${JSON.stringify(detail)}`);
  }

  function logFailure(reason: string): void {
    if (!firstFailureLogged) {
      firstFailureLogged = true;
      logger.warn(`[subagent-journal] journal report failed (${reason}); buffer dropped, convergence via consumer seq-gap backfill (no retry)`);
      return;
    }
    logger.debug(`[subagent-journal] journal report failed again (${reason})`);
  }

  return {
    attachSession(target: ExtensionContext): void {
      // 环境门控：非 rpc 模式（裸 pi TUI / json / print）无 runtime 拦截方，marker
      // select 会弹真框——不设 ctx，本 session 全程 no-op（inflight 同款先例）。
      if (target.mode !== "rpc") return;
      // attach = 新 reporting epoch：首败留痕标记随旧 session 终结重置。
      firstFailureLogged = false;
      ctx = target;
    },

    detachSession(): void {
      ctx = null;
      pending.clear();
    },

    onJournalAppended,
  };
}
