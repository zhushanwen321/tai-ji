// src/host/inflight-reporter.ts
//
// 壳层在途上报出口（u7a，设计权威源：docs/architecture/crash-forensics-and-watchdog.md
// §3.3 D5「extension 聚合上报」）。本文件属壳侧（shell），对 pi SDK（ExtensionContext
// 的 ctx.ui.select 通道）的消费收敛在 host/ 层——core 闭包红线只约束 core（出口回调
// 由 core 的 inflight-snapshot 注入，见组合根 index.ts 的 setInFlightListener 接线）。
//
// 链路：core 状态迁移点（session-runner 子进程注册/移除、idle timer arm/disarm）
// → notifyInFlightChanged（同步回调）→ 本 reporter（绝对计数快照 → select 通道帧，
// title = SUBAGENT_INFLIGHT_MARKER）→ runtime event-adapter（u7b）。
//
// D5 接线三约束的落点：
//   ① 不阻塞生命周期主链——onInFlightChanged 同步返回，推送全部 void fire-and-forget，
//      绝不进 agent_settled handler await 链；
//   ② 事件产生点在 core、上报出口在壳层——本文件即出口（core 零 pi SDK）；
//   ③ marker 路由不广播前端是 u7b（runtime 侧）的约束，本文件不涉及。
//
// 环境门控（2026-09-13 oe-audit + 裸 TUI 闪框事故）：上报的消费方是 xyz-agent
// runtime 的 event-adapter marker 路由，而 runtime spawn pi 恒为 --mode rpc——
// ctx.mode !== 'rpc' 即无拦截方（裸 pi TUI 下 marker select 会弹真框超时，2026-09-12
// 实测无限闪框），此时不启动上报（ask-user channel-handler 的 mode 二值判定同款
// 先例）。非 rpc 会话的 inFlight 判定归 runtime 侧镜像（spawn 预置 0），无信息损失。
//
// 语义（D5）：每帧携带**绝对计数**（getInFlightSnapshot，谓词与 core 内
// hasRunningBackground 同源），非增量；初始上报触发时点 = extension 加载完成
// （session_start 是 pi 启动序列里最早带 ctx 的钩子 = 「session 就绪」，即设计所指
// 加载完成时点；不挂任何懒触发（无 subagent 的 session 也必上报）。
//
// 失败语义（D5 缺席语义②，2026-09-13 oe-audit 修订）：select 失败（超时/通道异常/
// 非确认回包）折叠后延迟重试，**累计 MAX_REPORT_ATTEMPTS 次放弃**（原「重试直至
// 成功一次」的无界语义为「旧版 runtime」版本错配场景设计——该场景已被同 bundle
// 发布 + pi 随 runtime 退出销毁两条事实证伪；有界化的防挂死兜底对齐 plugin-bridge
// MAX_SYNC_ATTEMPTS 形态。session_start 首帧早于 runtime adapter attach 的竞态
// （R2 实证）在 30×2s=60s 窗口内必然自愈）。送达判据 = runtime resolve 的确认回包
// （INFLIGHT_REPORT_ACK）——fire-and-forget 下 resolve(undefined) 与超时不可区分，
// 靠显式 ack 区分「已送达」与「无路由」；放弃后镜像按 absent-report 走 errs 推迟
// （30min 有界），不丢 errs-safe 兜底。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_INFLIGHT_MARKER, callMarkerRpc, isInFlightReportAck } from "@xyz-agent/extension-protocol";
import { getInFlightSnapshot } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";

/** select 通道级超时（控制面单请求，秒级校准——超时默认原则规则 19）。取值对齐
 *  plugin-bridge 启动 sync 的 2s 自愈闸：session_start 首帧可能早于 runtime adapter
 *  attach（R2 实证），超时折叠后重试必然自愈；fire-and-forget 帧不留 pending 挂死面。 */
const SELECT_TIMEOUT_MS = 2_000;

/** 失败重试退避（对齐 plugin-bridge SYNC_RETRY_MS 控制面节奏）。 */
const RETRY_DELAY_MS = 2_000;

/** 累计失败放弃上限（对齐 plugin-bridge MAX_SYNC_ATTEMPTS：60s 窗口覆盖 attach 竞态，
 *  有界防 rpc-but-非-xyz orchestrator 场景的永久空转）。 */
const MAX_REPORT_ATTEMPTS = 30;

/** 在途上报器（组合根 index.ts 持有；per-factory 实例，session_start/shutdown 驱动）。 */
export interface InFlightReporter {
  /**
   * session_start 注入当前 ctx 并发起初始上报（fire-and-forget——本方法同步返回，
   * 不阻塞 session_start 装配链；初始帧 count 为当下绝对计数）。非 rpc 模式
   * （ctx.mode !== 'rpc'）下为 no-op：无 runtime 拦截方，上报通道不该启动。
   */
  attachSession(ctx: ExtensionContext): void;
  /** session_shutdown 摘除 ctx 并停止重试（session 已死，上报通道随之终结）。 */
  detachSession(): void;
  /** core 出口回调（notifyInFlightChanged 直连）：同步返回，内部合并 + void 推送。 */
  onInFlightChanged(): void;
}

export interface InFlightReporterOpts {
  /** 测试注入：select 超时（ms）。缺省 SELECT_TIMEOUT_MS。 */
  selectTimeoutMs?: number;
  /** 测试注入：重试退避（ms）。缺省 RETRY_DELAY_MS。 */
  retryDelayMs?: number;
  /** 测试注入：累计失败放弃上限。缺省 MAX_REPORT_ATTEMPTS。 */
  maxAttempts?: number;
}

/**
 * sessionId 从 ctx 取（plugin-bridge getSessionId 同款防御）：pi session 文件延迟写入
 * 窗口内取失败不阻断上报——sessionId 缺席时 runtime 按无法归属丢弃整帧（契约
 * SubagentInFlightReport.sessionId 可选语义），不视为协议错误。
 */
function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

export function createInFlightReporter(opts: InFlightReporterOpts = {}): InFlightReporter {
  const selectTimeoutMs = opts.selectTimeoutMs ?? SELECT_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_REPORT_ATTEMPTS;
  const logger = getLogger("subagents");

  // 闭包状态（per-factory 实例；禁模块级 let——同进程多 factory 实例会串台）。
  let ctx: ExtensionContext | null = null;
  /** 一次推送尝试在途（串行化——绝对计数语义下中间值可安全合并丢弃）。 */
  let attemptInFlight = false;
  /** 有待推帧（onInFlightChanged 在推送在途期间置位，成功后立即补推最新值）。 */
  let dirty = false;
  /** 重试定时器句柄（单飞；成功/dispose 即清）。 */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 累计失败次数（成功清零；达 maxAttempts 放弃——本 session 不再重试）。 */
  let failureCount = 0;
  /** 已放弃（累计到顶；session 内终态，成功路径永不触及）。 */
  let givenUp = false;
  /** 首次失败已 warn 留痕（重试循环不刷屏）。 */
  let firstFailureLogged = false;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** 推送在途、已放弃或无 ctx 时仅置脏；否则发起一次尝试（void，不阻塞调用方）。 */
  function kick(): void {
    if (attemptInFlight || givenUp || ctx === null) {
      dirty = true;
      return;
    }
    dirty = false;
    attemptInFlight = true;
    void attempt();
  }

  async function attempt(): Promise<void> {
    const active = ctx;
    if (active === null) {
      attemptInFlight = false;
      return;
    }
    // 帧内容在发送时刻现取：绝对计数 = 此刻快照（「当前非 idle 句柄数」）、
    // 产生时点 = 此刻（runtime 收到任何帧即「在场」，errs 判别按帧到达置位）。
    const snapshot = getInFlightSnapshot();
    const payload = JSON.stringify({
      inFlight: snapshot.inFlight,
      sessionId: getSessionId(active),
      emittedAt: Date.now(),
    });
    // 发送+折叠半边走 protocol 的 callMarkerRpc 原语（D8，fire-and-forget：void 发起
    // 不变）：ok:false 四态（cancelled/timeout/channel-error/non-json）统一折叠进下方
    // 延迟重试路径；送达判据 = ack 全等匹配（不是 JSON 消费），留在本侧。原语的失败
    // 留痕经注入的 log 承载本侧「首败 warn / 后续 debug」防刷屏策略。
    // guiCtx = ExtensionContext 的 GuiContext 最小子集（ask-user runRpcInteraction 同款
    // 先例：ui.custom 泛型签名静态不兼容，callMarkerRpc 只读 ui.select）。
    const guiCtx = {
      mode: active.mode,
      hasUI: active.hasUI,
      ui: { select: active.ui.select.bind(active.ui) },
    };
    const result = await callMarkerRpc(guiCtx, SUBAGENT_INFLIGHT_MARKER, payload, {
      timeout: selectTimeoutMs,
      log: primitiveLog,
    });
    attemptInFlight = false;
    if (result.ok && isInFlightReportAck(result.value)) {
      // 送达确认：清重试与失败计数，补推积压脏帧。
      failureCount = 0;
      clearRetryTimer();
      if (dirty && ctx !== null) kick();
      return;
    }
    // 失败折叠（resolve undefined = 超时/取消/无路由 / 回包非 ack / 通道异常）→ 延迟
    // 重试，累计到顶放弃（放弃后镜像按 absent-report 走 errs 推迟，30min 有界，
    // errs-safe 兜底不丢）。
    logFailure(
      result.ok ? "no ack (non-ack response)" : `no ack (${result.reason})`,
      result.ok ? result.value : undefined,
    );
    failureCount += 1;
    if (failureCount >= maxAttempts) {
      givenUp = true;
      clearRetryTimer();
      logger.warn(
        `[subagent-inflight] in-flight report gave up after ${failureCount} attempts; ` +
          `mirror will treat this session as absent-report (errs-deferred, bounded)`,
      );
      return;
    }
    if (ctx !== null && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        kick();
      }, retryDelayMs);
      // unref：不阻塞进程退出（退出收割由既有 process hook 负责，与 plugin-bridge 同款）。
      retryTimer.unref?.();
    }
  }

  /** 原语留痕注入（D8）：msg/detail 由 callMarkerRpc 产出；防刷屏策略（首败 warn /
   * 后续 debug）留本侧 logFailure。detail 是原语侧小对象，序列化保信息。 */
  function primitiveLog(msg: string, detail?: object): void {
    logFailure(msg, detail === undefined ? undefined : JSON.stringify(detail));
  }

  function logFailure(reason: string, detail: unknown): void {
    if (!firstFailureLogged) {
      firstFailureLogged = true;
      logger.warn(`[subagent-inflight] in-flight report failed (${reason}); retrying every ${retryDelayMs}ms (bounded at ${maxAttempts} attempts)`, {
        detail: detail instanceof Error ? detail.message : String(detail),
      });
      return;
    }
    logger.debug(`[subagent-inflight] in-flight report retry failed (${reason})`);
  }

  return {
    attachSession(target: ExtensionContext): void {
      // 环境门控：非 rpc 模式（裸 pi TUI / json / print）无 runtime 拦截方，marker
      // select 会弹真框（2026-09-12 裸 TUI 无限闪框事故根因）——不设 ctx，本 session
      // 全程 no-op。ask-user 的 ctx.mode === "rpc" 二值判定同款先例。
      if (target.mode !== "rpc") return;
      // attach = 新 reporting epoch（新 session / respawn 后重载）：放弃态与失败计数
      // 随旧 session 终结，重置重试资格（同一 session 内放弃不恢复——absent-report 兜底）。
      givenUp = false;
      failureCount = 0;
      firstFailureLogged = false;
      ctx = target;
      clearRetryTimer();
      // 初始上报（count=当下绝对计数；session 就绪时点恒为 0——子进程只会在后续
      // subagent 调用里出现）。fire-and-forget：不阻塞 session_start 装配链。
      kick();
    },

    detachSession(): void {
      ctx = null;
      dirty = false;
      clearRetryTimer();
    },

    onInFlightChanged(): void {
      // 同步返回（D5 约束①）：core 迁移点直连本方法，任何 await 都会进
      // agent_settled 等生命周期链——这里只置脏 + void 发起。
      kick();
    },
  };
}
