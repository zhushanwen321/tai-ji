// src/stdin-writer.ts
//
// 向 rpc 子进程 stdin 写入命令的 helper 集合（W7 迁 pi 包——设计 §3.8 D2 表第 3 行：
// sendPromptCommand / EPIPE 兜底 / 冷续轮 resume 是 pi RPC 语义，归 pi 包）。
//
// pi --mode rpc 通过 stdin 的 JSON RpcCommand / RpcExtensionUIResponse 驱动：
//   - extension_ui_response（主进程回答子进程的 UI 请求，如 ask_user）
//   - prompt（驱动子进程开始处理 task / chat 续聊统一投递 streamingBehavior）
// 两者共用 child.stdin.write + 背压检查，提取到此模块统一维护。
//
// 本文件是 core engines/pi/stdin-writer.ts 的迁移副本（日志走 SDK facade；
// UiResponse 类型改 SDK ui-types SSOT——结构等价）。core 侧原件过渡期保留（W11 删）。
//
// [U1 归并] 帧组装切 @zhushanwen/pi-rpc commands 模块（buildUiResponseFrame /
// buildPromptCommandFrame / buildGetStateCommandFrame——行为逐字等价提取的单源）；
// 裸写与 EPIPE 判别切 pi-rpc frame 模块原语（tryWriteStdinLine / isBrokenPipeError）。
// 刻意保留在本文件的：裸写错误策略——对 EPIPE throw 驱动冷恢复路径（pi-rpc README
// 「刻意不统一清单」第 3 条：runtime sendRaw 吞错 vs 本侧 throw，策略归消费方）。

import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";

import {
  buildGetStateCommandFrame,
  buildPromptCommandFrame,
  buildSetModelCommandFrame,
  buildUiResponseFrame,
  isBrokenPipeError,
  tryWriteStdinLine,
} from "@zhushanwen/pi-rpc";
import { getLogger, type UiResponse } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";

const logger = getLogger("subagents");

/**
 * 按 UiResponse 形状构造 Pi 原生 extension_ui_response 并写 stdin。
 *
 * SR-5：ack（fire-and-forget）不写 stdin——Pi 对 fire-and-forget method 不期待响应。
 * 其他三种 shape（value/confirmed/cancelled）按对应字段写。
 *
 * [R1] 背压检查：write 返回 false 时记 warn（不阻塞，内核缓冲会随后排空）。
 * [R2] 序列化失败（循环引用/BigInt）降级 cancelled——宁可取消单次 dialog 也不崩进程。
 */
export function respond(child: ChildProcess, id: string, out: UiResponse, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const line = buildUiResponseFrame(id, out, {
    onSerializeError: (err) => {
      logger.warn(`[subagents] JSON.stringify failed for ui response ${id}, degrading to cancelled`, {
        detail: toErrorMessage(err),
      });
    },
  });
  // ack: fire-and-forget，不写 stdin（SR-5）
  if (line === undefined) return;
  writeStdinLine(child, line, `ui response for request ${id}`);
}

/**
 * spawn 后向 rpc 子进程 stdin 写 prompt 命令，驱动 agent 开始处理 task。
 *
 * pi 的 runRpcMode 只通过 stdin RpcCommand 驱动——positional task arg / -p flag
 * 在 rpc mode 下被 resolveAppMode 无视，必须在 spawn 后主动喂 prompt 命令。
 *
 * [V2 决策 3] 续聊热路径用 prompt + streamingBehavior 统一投递，pi 权威
 * 裁决 busy/idle：busy 时 followUp 入队/steer 抢占；idle 时开新 turn。省略
 * streamingBehavior 时行为不变（首帧 prompt）。
 *
 * [M2 D3 送达回执] 判别式返回 + 回调装配（原静默返回改显式 delivered:false，
 * 由调用方 failNow 立即失败——静默返回会让 run 悬挂到退出路径才收敛）：
 *   - 顺序（D3「onRequestId 只在确实会尝试写入时调用」为准）：生成 id → 检查
 *     stdin（缺失/销毁 → delivered:false，**不登记**，避免 tracker 悬挂计时）→
 *     onRequestId(id) 登记 → 组帧 → 写 stdin → onBytesWritten 计数。登记先于写，
 *     两者同步完成，不存在「response 先到、监听未登记」竞态（单线程，stdout
 *     最早也要下个 tick 才投递）。
 *   - EPIPE 照旧 throw（writeStdinLine 错误策略），调用方 catch 后 failNow("epipe")。
 *
 * @returns delivered:true 携带 requestId（已登记、已写入）；delivered:false =
 *          stdin 缺失/已销毁（未写、未登记），reason 带形态文案。
 */
export function sendPromptCommand(
  child: ChildProcess,
  task: string,
  options?: {
    streamingBehavior?: "followUp" | "steer";
    onRequestId?: (id: string) => void;
    onBytesWritten?: (n: number) => void;
  },
): { delivered: boolean; requestId: string; reason?: string } {
  const requestId = crypto.randomUUID();
  if (!child.stdin || child.stdin.destroyed) {
    // prompt 是 rpc mode 唯一任务驱动通道：投递失败 = 任务不会被驱动。返回
    // delivered:false 让调用方立即失败（M2 D3——原静默 warn 挂到退出路径收敛）。
    // 不调 onRequestId：tracker 不登记、零输出计时器不武装（避免悬挂计时）。
    const reason = "child stdin missing or already destroyed";
    logger.warn(`[subagents] prompt command not delivered: ${reason}; failing the run via prompt-ack failNow`);
    return { delivered: false, requestId, reason };
  }
  // 登记先于写入（D3：避免「response 先到、监听还没登记」的竞态形态）
  options?.onRequestId?.(requestId);
  const line = buildPromptCommandFrame(requestId, {
    message: task,
    ...(options?.streamingBehavior !== undefined ? { streamingBehavior: options.streamingBehavior } : {}),
  });
  writeStdinLine(child, line, "prompt command");
  // 诊断计数 = 实际写出的字节（writeStdinLine 补的换行计入）
  options?.onBytesWritten?.(Buffer.byteLength(line, "utf8") + 1);
  return { delivered: true, requestId };
}

/**
 * 向子进程 stdin 写 get_state 命令，查询 sessionFile/sessionId（FR-4 RPC 握手）。
 *
 * @returns 请求 id（用于匹配 response）
 */
export function sendGetStateCommand(child: ChildProcess): string {
  const id = crypto.randomUUID();
  writeStdinLine(child, buildGetStateCommandFrame(id), "get_state command");
  return id;
}

/**
 * [subagent-model-switch §7.3] 向子进程 stdin 写 set_model 命令（setModel 通路：
 * 命令写入接线复用本模块既有原语——pi-rpc buildSetModelCommandFrame 组帧 +
 * tryWriteStdinLine 裸写 + isBrokenPipeError 判别）。
 *
 * 与 prompt 路径的 writeStdinLine 错误策略刻意不同：setModel 是控制范围操作，投递
 * 失败（no-stdin / destroyed / EPIPE——均为子进程已死或将死的形态）必须以判别式
 * 结果上浮，让调用方按「无活进程」形态处置（§7.5 命令写入窗口退出行），而不是
 * throw 驱动冷恢复或静默返回后悬挂等待。
 *
 * @returns delivered:true 携带请求 id（调用方用它在 awaitControlResponse 等应答）；
 *          delivered:false = 投递失败（子进程无活形态，含非 EPIPE 写异常——debug
 *          留痕后同判，不让异常路径逃出判别式）
 */
export function sendSetModelCommand(
  child: ChildProcess,
  input: { provider: string; modelId: string },
): { delivered: true; requestId: string } | { delivered: false } {
  const id = crypto.randomUUID();
  const outcome = tryWriteStdinLine(child.stdin, buildSetModelCommandFrame(id, input));
  if (outcome.ok) {
    if (outcome.backpressure) {
      logger.warn("[subagents] stdin backpressure on set_model command");
    }
    return { delivered: true, requestId: id };
  }
  if (outcome.reason === "error" && !isBrokenPipeError(outcome.error)) {
    logger.warn("[subagents] unexpected stdin write error on set_model command", {
      detail: toErrorMessage(outcome.error),
    });
  }
  return { delivered: false };
}

/**
 * 向子进程 stdin 写一行（自动补换行），带背压检查 + EPIPE 检测。
 * 写入与判别原语在 pi-rpc frame 模块（tryWriteStdinLine / isBrokenPipeError），
 * 本函数只承载错误策略（EPIPE throw 驱动冷恢复——见文件头注 [U1 归并]）。
 *
 * [R3] write 抛 EPIPE / ERR_STREAM_DESTROYED 时 throw 含 EPIPE 关键词的 Error，
 *      让上层能捕获并转冷路径处理。
 *
 * @throws Error 含 "EPIPE" 关键词——stdin 管道已断（子进程已退出 / stdin 被销毁）
 */
function writeStdinLine(child: ChildProcess, line: string, warnTag: string): void {
  const outcome = tryWriteStdinLine(child.stdin, line);
  if (!outcome.ok) {
    // no-stdin / destroyed：静默跳过（guard 生效，不触发 write）
    if (outcome.reason === "error") {
      if (isBrokenPipeError(outcome.error)) {
        throw new Error(
          `[subagents] EPIPE on stdin write (${warnTag}): pipe broken, child process likely exited. ` +
            `Recovery: treat as dead process and resume via cold path.`,
        );
      }
      // 非 EPIPE 错误（不应发生，但兜底降级为 warn 不崩溃）
      logger.warn(`[subagents] unexpected stdin write error on ${warnTag}`, {
        detail: toErrorMessage(outcome.error),
      });
    }
    return;
  }
  if (outcome.backpressure) {
    logger.warn(`[subagents] stdin backpressure on ${warnTag}`);
  }
}
