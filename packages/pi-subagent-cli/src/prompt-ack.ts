// src/prompt-ack.ts
//
// [relay-spawn-transport §3.4.2 M2 / D3] prompt 送达回执 tracker（单级，per-run）。
//
// 语义锚点（设计 D3，用户裁决）：
//   - **prompt response 是唯一成功回执**——`success === true`（`data.disposition` 可为
//     started / queued / handled，三者都表示 pi 已受理；`started` 不是唯一合法值）；
//   - **stdout 活性只用于零输出判定**——`onChannelActivity()` 只取消零输出计时器，
//     不 settle、不判失败、不是第二回执；`prompt ack delayed` 只是 warn 日志，不是
//     状态（run 不为它改变成功/失败）；
//   - **零输出判定**——prompt 写入后 `TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS`
//     （默认 30s）内**完全没有任何 stdout** → timeout（engine_prompt_not_delivered）；
//     该计时器不是第二个回执，而是「第一级回执为什么没来」的兜底（长 preflight /
//     compaction 有任意 stdout 即免死，S8b）；
//   - `success:false` → rejected（engine_prompt_rejected）——「已送达但被拒绝」与
//     「没送到」分型防误诊（S7b）；立即失败不等 30s；
//   - stdin 缺失/销毁、写入 EPIPE → failNow（lost）——立即失败不等 30s（S9）；
//   - 不重试：prompt 可能已产生副作用，重试会重复执行；失败显式交给上层。
//
// 状态机：`pending → settled(kind) → disposed`。所有入口（dispatch / failNow /
// 超时回调）只在 pending 态生效；settled/disposed 后一律 no-op（迟到 response 留痕
// 忽略——不重复 kill、不覆盖已有 failure、不产生未处理 rejection）。dispose 幂等，
// 挂 runSpawnOnce 的 finally（正常完成 / 异常 / 取消三路必经）。
//
// 诊断五元组（pid / bytesWritten / stdoutBytes / stdoutBytesAfterPrompt /
// getStateAnswered + lastEventType、stdoutSeen）由 spawn-runner 闭包提供
// （`diagnostics()`），tracker 在 timeout/lost 时写结构化日志并把有界摘要拼进
// result.detail（→ outcome.error）。acker 延迟只回答「通道是否完全没动静」，
// 不证明 prompt 已被解析——成功仍然只认 prompt response。

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("session-runner");

/** settled 终态类别（设计 §3.4.2 PromptAckKind）。 */
export type PromptAckKind = "acked" | "rejected" | "timeout" | "lost";

/**
 * 结算结果（onFailure / runEnd.promptAckFailure 的载荷）。
 * detail 有界（pi error 文本与诊断摘要截断，见 {@link REJECTION_DETAIL_MAX_CHARS}）。
 */
export type PromptAckResult =
  | { kind: "acked"; disposition?: "started" | "queued" | "handled" }
  | { kind: "rejected"; detail: string }
  | { kind: "timeout"; detail: string }
  | { kind: "lost"; reason: "stdin-unavailable" | "epipe"; detail: string };

/** 诊断五元组 + 活性快照（spawn-runner 闭包装配；值都是确定性计数/置位，非推测）。 */
export type PromptAckDiagnostics = {
  pid?: number;
  /** stdin 已写字节（stdin-writer onBytesWritten 计数）。 */
  bytesWritten: number;
  /** 子进程 stdout 总字节（chunk 层计数，含 prompt 前的握手应答与未成行字节）。 */
  stdoutBytes: number;
  /** prompt 写入后的 stdout 字节（chunk 层计数，含未成行字节——零输出判定的直接证据）。 */
  stdoutBytesAfterPrompt: number;
  /** prompt 写入后是否见过任意 stdout 字节（onChannelActivity 置位）。 */
  stdoutSeen: boolean;
  /** get_state response 是否已应答（success 与否都算——证明 stdout 活着）。 */
  getStateAnswered: boolean;
  /** 最近一次 SdkEvent 的 type（pump event 分支更新）。 */
  lastEventType?: string;
}

/** prompt 回执 tracker 句柄（pump 持有分发、spawn-runner 持有装配）。 */
export type PromptAckTracker = {
  /**
   * 登记本次 run 的 prompt response id 并武装零输出计时器。
   * 只在「确实会尝试写入」时调用（stdin 不可用时调用方不登记，避免悬挂计时——D3）。
   * 登记即武装：sendPromptCommand 在 onRequestId 回调后同步写 stdin，两者之间无
   * IO 事件窗口（单线程），计时起点与「prompt 写入时」等价。
   */
  register(id: string): void;
  /**
   * response 帧分发（pump 的 response 分支逐帧调用）。只有 `command === "prompt"`
   * 且 id 匹配已登记 id 的帧才结算；settled/disposed 后迟到 response 留痕忽略。
   */
  dispatch(
    id: string | undefined,
    command: string,
    success: boolean,
    data: unknown,
    error?: string,
  ): void;
  /** 立即失败（stdin 不可用 / EPIPE）：清 timer + settle(lost) + onFailure。已 settle 后 no-op。 */
  failNow(reason: "stdin-unavailable" | "epipe", detail: string): void;
  /**
   * prompt 写入后收到任意 stdout 字节时由 pump 在 chunk 层调用（未成行的 partial
   * chunk 同样算活性——D3「任意字节」，防大行慢写被误杀）：取消零输出计时器并置
   * stdoutSeen，**不 settle、不判失败**（S8b：get_state 有应答但 prompt response
   * 延迟 → 不杀不判失败，run 继续；之后 prompt response 到达仍按 acked 结算）。
   * 未武装（register 前）调用为 no-op——prompt 前的 stdout（如握手应答先达）不算
   * 「写入后活性」。
   */
  onChannelActivity(): void;
  /** prompt 写入后是否见过任意 stdout 字节（diagnostics 装配源）。 */
  readonly stdoutSeen: boolean;
  /** 幂等清理：清 timer、清登记表、标记 disposed（runSpawnOnce finally 必达）。 */
  dispose(): void;
}

/** 零输出判定默认窗口（设计 D3：30s，完全零输出才判 not_delivered）。 */
export const DEFAULT_PROMPT_ACK_TIMEOUT_MS = 30_000;

/**
 * 零输出窗口 env 覆盖（设计 D3 / §5.1 M2「回执窗口可配置；可关闭 ack 作逃生舱」）。
 * `0` = 关闭零输出看门狗（逃生舱：只关时间窗，rejected/lost 是确定性事实不经此门，
 * 不受影响）；非法值回落默认。
 */
export const PROMPT_ACK_TIMEOUT_ENV = "TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS";

/** env → 窗口 ms（导出供测试；spawn-runner 装配点消费）。 */
export function resolvePromptAckTimeoutMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number {
  const raw = env[PROMPT_ACK_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_PROMPT_ACK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PROMPT_ACK_TIMEOUT_MS;
  return n;
}

/** pi error 文本进 detail 的截断长度（rejected detail 有界——outcome.error 不爆）。 */
const REJECTION_DETAIL_MAX_CHARS = 500;

/** pi rejected 文本截断（有界，防超长错误文案进终态）。 */
function boundDetail(text: string): string {
  return text.length <= REJECTION_DETAIL_MAX_CHARS
    ? text
    : `${text.slice(0, REJECTION_DETAIL_MAX_CHARS)}…(+${text.length - REJECTION_DETAIL_MAX_CHARS} chars)`;
}

/** 诊断五元组 → 有界单行摘要（timeout/lost 时拼进 detail 与结构化日志）。 */
function formatDiagnostics(d: PromptAckDiagnostics): string {
  return (
    `pid=${d.pid ?? "-"} bytesWritten=${d.bytesWritten} stdoutBytes=${d.stdoutBytes} ` +
    `stdoutBytesAfterPrompt=${d.stdoutBytesAfterPrompt} stdoutSeen=${d.stdoutSeen} ` +
    `getStateAnswered=${d.getStateAnswered} lastEventType=${d.lastEventType ?? "-"}`
  );
}

/** disposition 值域收窄（data.disposition 字段；未知形状 → undefined，不影响 acked 判定）。 */
function extractDisposition(data: unknown): "started" | "queued" | "handled" | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const v = (data as Record<string, unknown>)["disposition"];
  return v === "started" || v === "queued" || v === "handled" ? v : undefined;
}

/**
 * 创建 per-run 的 prompt 回执 tracker（设计 §3.4.2 契约）。装配见 spawn-runner
 * runSpawnOnce：`onFailure` = 记录 runEnd.promptAckFailure + killChild（SIGKILL
 * 直杀，run 以失败 outcome 收尾）；`diagnostics` = 闭包读 pump/写侧计数。
 */
export function createPromptAckTracker(opts: {
  recordId: string;
  /** 零输出窗口 ms；`<=0` = 关闭零输出看门狗（逃生舱，见 PROMPT_ACK_TIMEOUT_ENV）。 */
  timeoutMs: number;
  diagnostics: () => PromptAckDiagnostics;
  onFailure: (result: PromptAckResult) => void;
}): PromptAckTracker {
  const { recordId, timeoutMs, diagnostics, onFailure } = opts;

  let state: "pending" | "settled" | "disposed" = "pending";
  let pendingId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let registeredAt: number | undefined;
  let stdoutSeen = false;
  /** 首次活性已告警（prompt ack delayed 只记一条）。 */
  let delayedWarned = false;

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const settle = (result: PromptAckResult): void => {
    // 先置 settled 再触发 onFailure（设计：超时/failNow 先 settle 再触发——
    // onFailure 内的 killChild → close → 后续回调看到的已是终态，不重入）。
    // pendingId 保留到 dispose：settled 态下仅供迟到 response 的留痕匹配用
    // （pending 分支有 state 门，不会被误结算）。
    state = "settled";
    clearTimer();
    if (result.kind !== "acked") onFailure(result);
  };

  return {
    register(id) {
      if (state !== "pending") {
        logger.warn(`[prompt-ack] ${recordId} register after ${state} (ignored): id=${id}`);
        return;
      }
      if (pendingId !== undefined) {
        // 每 run 只有一次 prompt 投递；重复登记是装配错误，响亮留痕后以最新为准
        logger.warn(`[prompt-ack] ${recordId} duplicate register (replacing): old=${pendingId} new=${id}`);
      }
      pendingId = id;
      registeredAt = Date.now();
      clearTimer();
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (state !== "pending") return;
          const d = diagnostics();
          const detail =
            `zero stdout after prompt write within ${timeoutMs}ms; diagnostics: ${formatDiagnostics(d)}`;
          logger.warn(`[prompt-ack] ${recordId} prompt not delivered (timeout): ${detail}`);
          settle({ kind: "timeout", detail });
        }, timeoutMs);
      }
    },

    dispatch(id, command, success, data, error) {
      if (state !== "pending") {
        // 迟到的 response：留痕忽略（不重复 kill、不覆盖已有 failure、不产生未处理 rejection）
        if (state !== "disposed" && command === "prompt" && id !== undefined && id === pendingId) {
          logger.warn(
            `[prompt-ack] ${recordId} late prompt response after settle (ignored): id=${id}`,
          );
        }
        return;
      }
      if (command !== "prompt") return;
      if (id === undefined || id !== pendingId) return;
      if (success) {
        const disposition = extractDisposition(data);
        const latencyMs = registeredAt !== undefined ? Date.now() - registeredAt : undefined;
        // started / queued / handled 都是「pi 已受理」（D3 不采用只认 started）；
        // ack latency 走 debug（S8/P-6b 的 ack 延迟分布数据源；debug 级不刷 prod info 面）
        logger.debug(
          `[prompt-ack] ${recordId} prompt acked${latencyMs !== undefined ? ` in ${latencyMs}ms` : ""}` +
            `${disposition !== undefined ? ` (disposition=${disposition})` : ""}`,
        );
        settle({ kind: "acked", ...(disposition !== undefined ? { disposition } : {}) });
        return;
      }
      const detail = boundDetail(error !== undefined && error !== "" ? error : "(no error text from pi)");
      logger.warn(`[prompt-ack] ${recordId} prompt rejected by pi: ${detail}`);
      settle({ kind: "rejected", detail });
    },

    failNow(reason, detail) {
      if (state !== "pending") return;
      const d = diagnostics();
      const bound = boundDetail(detail);
      const summary =
        `${reason}: ${bound}; diagnostics: ${formatDiagnostics(d)}`;
      logger.warn(`[prompt-ack] ${recordId} prompt delivery lost (failNow): ${summary}`);
      settle({ kind: "lost", reason, detail: summary });
    },

    onChannelActivity() {
      if (state !== "pending") return;
      if (timer === undefined) return; // 未武装（register 前）或窗口关闭：prompt 前的 stdout 不算写入后活性
      clearTimer();
      stdoutSeen = true;
      if (!delayedWarned) {
        delayedWarned = true;
        const d = diagnostics();
        logger.warn(
          `[prompt-ack] ${recordId} prompt ack delayed: stdout activity observed after prompt write, ` +
            `zero-output timer cancelled (not a settlement; ack still awaited); ` +
            `diagnostics: ${formatDiagnostics(d)}`,
        );
      }
    },

    get stdoutSeen() {
      return stdoutSeen;
    },

    dispose() {
      if (state === "disposed") return; // 幂等
      state = "disposed";
      pendingId = undefined;
      clearTimer();
    },
  };
}
