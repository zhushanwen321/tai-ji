// src/get-state-handshake.ts
//
// FR-4: get_state RPC 握手逻辑（W7 自 core engines/pi/get-state-handshake.ts 迁入。
// 2026-09 S2 契约修复后与旧副本分叉：应答缺 sessionFile 不再悬挂，见
// performGetStateHandshake 的停表分支——修复仅限本文件）。
//
// 通过 get_state RPC 查询子进程 sessionFile/sessionId，带超时重试。
//   - 重试节奏：单次超时 GET_STATE_TIMEOUT_MS（2s）后，等 GET_STATE_RETRY_INTERVAL_MS
//     （500ms）再发起下一次 get_state，最多 GET_STATE_MAX_RETRIES（3）次。
//   - 加速路径：sessionFile 一旦拿到立即 resolve（不等剩余重试）。
//   - 应答不完整（缺 sessionFile）：视同未应答——不清本轮 timer/retry 驱动，
//     超时照常排 retry，3 轮耗尽 resolve 已收集字段（契约：至多 3 次尝试后必 settle）。
//   - 发送/注册同步抛错（stdin 已断的 EPIPE 形态，stdin-writer.ts writeStdinLine
//     rethrow）：同样按「本轮未应答」处理——有剩余轮次则排下一轮，否则 resolve 已
//     收集字段。异常不得逃出 tryOnce（重试路径经 setTimeout 回调再入，逃出即宿主
//     uncaughtException；首轮经 promise executor 逃出即 reject，两者都违反
//     「至多 3 次尝试后必 settle」契约）。
//   - 全部超时：resolve 空对象（调用方走兜底查找）。

import type { ChildProcess } from "node:child_process";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";
import { sendGetStateCommand } from "./stdin-writer.ts";

const logger = getLogger("subagents");

/** FR-4: get_state RPC 握手最大重试次数。 */
const GET_STATE_MAX_RETRIES = 3;
/** FR-4: get_state RPC 握手重试间隔（ms）。 */
const GET_STATE_RETRY_INTERVAL_MS = 500;
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
 * FR-4: 通过 get_state RPC 查询子进程获取 sessionFile/sessionId。
 *
 * 最多重试 GET_STATE_MAX_RETRIES 次，单次超时 GET_STATE_TIMEOUT_MS 后等待
 * GET_STATE_RETRY_INTERVAL_MS 再发起下一次重试。
 */
export function performGetStateHandshake(
  child: ChildProcess,
  addResponseListener: AddGetStateResponseListener,
): Promise<GetStateResult> {
  return new Promise<GetStateResult>((resolve) => {
    const collected: GetStateResult = {};
    let attempts = 0;
    let resolved = false;

    function tryOnce(): void {
      if (resolved) return;
      attempts++;

      // [#15] 本次 tryOnce 私有的驱动（2s 超时 timer + 超时后派生的 retry）。
      let pendingRetry: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      /**
       * 本轮判「未应答」的唯一出口（超时回调与同步抛错两条入口都汇到这里）：
       * 先把本轮驱动全部停表，再按剩余轮次排下一轮或 resolve 已收集字段。
       */
      function retryOrSettle(): void {
        if (timer !== undefined) clearTimeout(timer);
        if (pendingRetry !== undefined) clearTimeout(pendingRetry);
        if (resolved) return;
        if (attempts < GET_STATE_MAX_RETRIES) {
          pendingRetry = setTimeout(() => tryOnce(), GET_STATE_RETRY_INTERVAL_MS);
          pendingRetry.unref();
          return;
        }
        // 3 轮耗尽：必 settle（resolve 已收集字段，调用方走兜底）
        resolved = true;
        resolve(collected);
      }

      try {
        const reqId = sendGetStateCommand(child);

        timer = setTimeout(() => {
          pendingRetry = undefined;
          retryOrSettle();
        }, GET_STATE_TIMEOUT_MS);
        timer.unref();

        addResponseListener(reqId, (data: unknown) => {
          if (resolved) return;
          extractGetStateFields(data, collected);
          if (collected.sessionFile) {
            // 应答完整才停表（S2 契约修复）：缺 sessionFile 视同未应答，保留 timer
            // 与 pendingRetry 全部驱动——重试的排定权威唯一（timer 超时回调），由它
            // 照常排 retry 直至 3 轮耗尽 resolve collected；多驱动并发安全由既有
            // resolved/attempts 守卫保证。
            if (timer !== undefined) clearTimeout(timer);
            if (pendingRetry !== undefined) clearTimeout(pendingRetry);
            resolved = true;
            resolve(collected);
          }
        });
      } catch (err) {
        // 同步抛错（stdin 已断的 EPIPE 等）按「本轮未应答」处理：与
        // requestGetStateOnce 的「stdin 失败按 miss 处理」同源；剩余轮次照排，
        // 耗尽即 resolve 已收集字段——异常绝不逃出 tryOnce（见头注契约）。
        logger.warn(
          `[subagents] get_state handshake attempt ${attempts}/${GET_STATE_MAX_RETRIES} failed `
            + `(treated as no answer this round): ${toErrorMessage(err)}`,
        );
        retryOrSettle();
      }
    }

    tryOnce();
  });
}

/**
 * [T1/RC-1] 单次 get_state 请求（agent_end 决策点惰性回补专用）。
 *
 * 不做重试循环、不 share 握手语义：调用方在子进程 idle 时现场补一次查询，
 * 超时/失败即放弃，由调用方走既有保守分支。永不 reject——stdin 已断的同步写
 * 失败按「回补失败」处理 resolve 空对象。
 */
export function requestGetStateOnce(
  child: ChildProcess,
  addResponseListener: AddGetStateResponseListener,
  timeoutMs: number,
): Promise<GetStateResult> {
  return new Promise<GetStateResult>((resolve) => {
    let settled = false;
    let removeListener: () => void = () => {};

    const finish = (r: GetStateResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener();
      resolve(r);
    };

    let reqId: string;
    try {
      reqId = sendGetStateCommand(child);
    } catch {
      resolve({});
      return;
    }
    removeListener =
      addResponseListener(reqId, (data: unknown) => {
        const r: GetStateResult = {};
        extractGetStateFields(data, r);
        finish(r);
      }) ?? (() => {});
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish({}), timeoutMs);
    timer.unref();
  });
}
