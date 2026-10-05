// src/get-state-handshake.ts
//
// FR-4: get_state RPC 握手逻辑（W7 自 core engines/pi/get-state-handshake.ts 迁入。
// 2026-09 S2 契约修复后与旧副本分叉：应答缺 sessionFile 不再悬挂，见
// performGetStateHandshake 的停表分支——修复仅限本文件）。
//
// 通过 get_state RPC 查询子进程 sessionFile/sessionId（单次、有界）。
// [ADR-0122] 握手重试已删（原 3 次 × 2s 超时 + 500ms 间隔）：单次超时即 settle，
// 调用方走兜底反查（LC-4 按 sessionId 后缀匹配，行为仍收敛）——不猜「慢启动下轮
// 就绪」。加速路径保留：sessionFile 一旦拿到立即 resolve。
//   - 应答不完整（缺 sessionFile）：单次超时照常 settle 已收集字段（契约：一次
//     尝试后必 settle）。
//   - 发送/注册同步抛错（stdin 已断的 EPIPE 形态）：同样按「未应答」处理——异常
//     不得逃出 promise executor（逃出即 reject，违反「必 settle」契约），warn 留痕
//     后 settle 已收集字段。
//   - 超时：resolve 已收集字段（调用方走兜底查找）。

import type { ChildProcess } from "node:child_process";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";
import { sendGetStateCommand } from "./stdin-writer.ts";

const logger = getLogger("subagents");

/** FR-4: get_state RPC 握手单次超时（ms）。 */
const GET_STATE_TIMEOUT_MS = 2000;

/** get_state 握手结果。 */
export interface GetStateResult {
  sessionFile?: string;
  sessionId?: string;
}

/** get_state response 监听器注册函数形态（stdout pump / 测试注入）。 */
export type AddGetStateResponseListener = (
  id: string,
  resolver: (data: unknown) => void,
) => void | (() => void);

/** 从 get_state response data 提取 sessionFile/sessionId（提取规则单一来源）。 */
export function extractGetStateFields(data: unknown, into: GetStateResult): void {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.sessionFile === "string" && d.sessionFile.length > 0) {
      into.sessionFile = d.sessionFile;
    }
    if (typeof d.sessionId === "string" && d.sessionId.length > 0) {
      into.sessionId = d.sessionId;
    }
  }
}

/**
 * FR-4: 通过 get_state RPC 查询子进程获取 sessionFile/sessionId（单次尝试，
 * 超时 GET_STATE_TIMEOUT_MS 后 settle 已收集字段——[ADR-0122] 无重试）。
 */
export function performGetStateHandshake(
  child: ChildProcess,
  addResponseListener: AddGetStateResponseListener,
): Promise<GetStateResult> {
  return new Promise<GetStateResult>((resolve) => {
    const collected: GetStateResult = {};
    let resolved = false;

    let timer: ReturnType<typeof setTimeout> | undefined;

    /** settle 已收集字段（唯一出口——超时与同步抛错两条入口共用，幂等）。 */
    function settle(): void {
      if (timer !== undefined) clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve(collected);
    }

    try {
      const reqId = sendGetStateCommand(child);

      timer = setTimeout(() => {
        settle();
      }, GET_STATE_TIMEOUT_MS);
      timer.unref();

      addResponseListener(reqId, (data: unknown) => {
        if (resolved) return;
        extractGetStateFields(data, collected);
        if (collected.sessionFile) {
          // 应答完整才提前停表（S2 契约修复）：缺 sessionFile 视同未应答，等
          // 单次超时 settle（调用方走兜底反查）。
          settle();
        }
      });
    } catch (err) {
      // 同步抛错（stdin 已断的 EPIPE 等）按「未应答」处理——异常绝不逃出
      // promise executor（见头注契约），warn 留痕后 settle 已收集字段。
      logger.warn(
        `[subagents] get_state handshake failed (treated as no answer): ${toErrorMessage(err)}`,
      );
      settle();
    }
  });
}
