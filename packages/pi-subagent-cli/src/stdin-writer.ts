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
  buildUiResponseFrame,
  isBrokenPipeError,
  tryWriteStdinLine,
} from "@zhushanwen/pi-rpc";
import { getLogger, type UiResponse } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";

const logger = getLogger("subagents");

/**
 * EPIPE 连续失败计数器（record.id → 连续 EPIPE 次数）。
 *
 * 错误处理两半面共用本计数器（合并计数，防 spawn→EPIPE→resume 死循环）：
 *   ① 同步 write 抛错（writeStdinLine throw → interact 热路径 catch 递增）
 *   ② 异步 stream 'error' event（spawn-runner 的 child.stdin.on('error') 递增）
 */
const epipeConsecutiveFailures = new Map<string, number>();

/** 连续 EPIPE 失败阈值：达到即不再尝试 resume（避免无限 spawn → EPIPE → resume 循环）。 */
export const EPIPE_FAILURE_THRESHOLD = 2;

/** 递增 recordId 的 EPIPE 连续失败计数，返回递增后的新计数。 */
export function recordEpipeFailure(recordId: string): number {
  const count = (epipeConsecutiveFailures.get(recordId) ?? 0) + 1;
  epipeConsecutiveFailures.set(recordId, count);
  return count;
}

/** 成功写入时清零某 record 的 EPIPE 连续失败计数（热路径成功 → 重置）。 */
export function clearEpipeFailure(recordId: string): void {
  epipeConsecutiveFailures.delete(recordId);
}

/** dispose 时清空所有 EPIPE 计数（防跨 session 泄漏）。 */
export function resetAllEpipeFailures(): void {
  epipeConsecutiveFailures.clear();
}

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
 */
export function sendPromptCommand(
  child: ChildProcess,
  task: string,
  options?: { streamingBehavior?: "followUp" | "steer" },
): void {
  if (!child.stdin || child.stdin.destroyed) return;
  const line = buildPromptCommandFrame(crypto.randomUUID(), {
    message: task,
    ...(options?.streamingBehavior !== undefined ? { streamingBehavior: options.streamingBehavior } : {}),
  });
  writeStdinLine(child, line, "prompt command");
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
