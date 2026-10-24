// src/handled-settlement.ts
//
// [subagent-observability §3.3.1 P6] disposition=handled 接管信号的结算分派（自
// spawn-runner 提取——该文件触 max-lines 上限，本机制是独立判定块：结算门 → 事件位
// 预筛 → get_state isStreaming 主判据 → EOF 收割）。
//
// 挂起形态根因（pi 1.0.0 实装核实）：handled disposition 在 isStreaming 检查前短路、
// 不进 `_runAgentPrompt`（agent-session.js :1494/:1504），而 `agent_settled` 只在该
// 函数 finally 发射 → 零终态事件、exitPromise 无 resolve 通路。判定分派与 A/B 两形态
// 语义见 createHandledSettlement 头注。

import type { ChildProcess } from "node:child_process";

import { sendGetStateCommand } from "./stdin-writer.ts";
import type { RunEndState, SessionIdentityTracker } from "./spawn-run-pump.ts";
import type { SpawnRunParams } from "./spawn-runner.ts";

/**
 * get_state 单次查询的有界窗（复用 handshake 同款量级）。其超时是通道死亡兜底、
 * 不参与判别（无应答 = 不判定，零时间量）。
 */
const P6_GET_STATE_TIMEOUT_MS = 2_000;

/**
 * get_state 单次查询 → isStreaming（主判据）。复用 handshake 有界形态：超时是通道
 * 死亡兜底、不参与判别——resolve undefined = 无应答（事实不足不产推断，调用方继续
 * 等既有通路）。
 */
function queryChildIsStreaming(
  child: ChildProcess,
  identity: SessionIdentityTracker,
): Promise<boolean | undefined> {
  return new Promise<boolean | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    try {
      const id = sendGetStateCommand(child);
      timer = setTimeout(() => finish(undefined), P6_GET_STATE_TIMEOUT_MS);
      timer.unref();
      // identity.addStateListener 的包装会顺路回填身份字段（无害副作用）；
      // resolver 收到原始应答 data（失败帧以 undefined resolve = 无应答口径）。
      identity.addStateListener(id, (data: unknown) => {
        const isStreaming =
          data !== null && typeof data === "object"
            ? (data as { isStreaming?: unknown }).isStreaming
            : undefined;
        finish(typeof isStreaming === "boolean" ? isStreaming : undefined);
      });
    } catch {
      // 同步写失败（stdin 已断的 EPIPE 形态）= 通道死亡兜底：无应答，不判定。
      finish(undefined);
    }
  });
}

/**
 * disposition=handled 结算分派工厂（prompt-ack onHandled 消费方）。判定分派
 * （设计定稿）：结算门（exitPromise 已结/取消赛跑短路）→ 事件位预筛（本地 runActive
 * 事实位）→ get_state 单次查询 →
 *   isStreaming=true  → 在途 run 的 settled 无条件照发——继续等既有通路（B 形态）；
 *   isStreaming=false → 执行从未启动的确定性立即轮终（A 形态）：EOF 收割走 pi 完整
 *                       shutdown 链（rpc-mode dispose → flush → exit），保留接管者已写
 *                       会话条目的落盘；不用 SIGKILL（跳过全部收尾）。零时间量。
 *   无应答            → 不判定（事实不足不产推断，继续等既有通路）。
 */
export function createHandledSettlement(
  child: ChildProcess,
  params: SpawnRunParams,
  identity: SessionIdentityTracker,
  runEnd: RunEndState,
): () => void {
  return () => {
    // 结算门：exitPromise 已结（settled/close 先达）或取消赛跑（宿主取消优先，
    // run 由信号链收尾）——短路。
    if (runEnd.exitResolved === true) return;
    if (params.signal?.aborted === true) return;
    // 事件位预筛：已见任何 run 活动 SdkEvent = 执行在途形态（B 形态），继续等 settled。
    if (runEnd.sawAgentActivity === true) return;
    void queryChildIsStreaming(child, identity).then((isStreaming) => {
      if (runEnd.exitResolved === true) return; // 查询窗内 run 已结（赛跑短路）
      if (params.signal?.aborted === true) return;
      if (isStreaming !== false) return; // true = 在途继续等；undefined = 无应答不判定
      // A 形态：立即轮终（事实判定，不引入超时——红线安全）。顺序契约（子设计
      // enumeration-p6-disposition §4.2）：先结算应答（对齐 onAgentSettled——应答不等
      // 收割），后 EOF 收割（pi 完整 shutdown 链：dispose → flush stdout → exit）。
      // 不置 endedCleanly——其语义 = agent 终态边沿到达，handled 短路从未进 agent 循环，
      // 不是 agent 轮终边沿；close(code=0) 经 normalizeExitCode(false, 0, null) 折算恒 0，
      // 与先行 resolve(0) 口径一致。不置 settledTurnCount（无轮）——promptHandledNoRun
      // 事实标记承载「有解释的空」，收集侧 P4 防伪按该标记豁免。
      runEnd.promptHandledNoRun = true;
      runEnd.exitResolved = true;
      runEnd.resolveChatRun?.(0);
      child.stdin?.end();
    });
  };
}
