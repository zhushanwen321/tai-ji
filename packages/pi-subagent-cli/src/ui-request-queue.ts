// src/ui-request-queue.ts
//
// 子进程 extension_ui_request 的 FIFO 串行队列 + 转发处理（W7 迁 pi 包，
// impl-plan §2.7 / R2 MF-X2——迁移边界裁决方案 (a)：
//
//   ui-request-queue 属「引擎侧发射逻辑」（ExtensionUiRequest → UiRequest 构造 +
//   respond stdin 回写 + FIFO 串行），随 pi 包迁移；core 侧原件过渡期保留
//   （engines/pi inproc 消费，W11 删）。core 壳侧应答端不消费本队列——它走
//   W6 host-ui-endpoint（host/askUser 反向请求 → SubagentService
//   init.uiRequestHandler 注入点 → dialog-queue 应答链路），两链互不相交。
//
// 与 core 版的差异（MF-X2 5 处依赖逐个去向的落地）：
//   - logger → SDK facade（经 host/log + stderr 兜底）；
//   - UiRequest/UiResponse/UiRequestHandler 类型 → SDK ui-types SSOT；
//   - dialogQueue（L2 壳侧全局串行队列）→ 不随迁：跨进程后 L2 在宿主侧
//     （host/askUser ack 两阶段语义已承载跨子进程串行），引擎侧只保本 child 的
//     L1 FIFO + close abort；
//   - notifyMissingHandlerGlobal（globalThis 观测桥）→ 引擎包内自持去重告警
//     （跨进程 globalThis 桥断裂，按 §2.7 既定裁决「本地实现 + host/log 上报」）；
//   - toErrorMessage → 包内 error-message 副本。

import type { ChildProcess } from "node:child_process";

import { getLogger, type UiRequest, type UiRequestHandler, type UiResponse } from "@zhushanwen/subagent-engine-sdk";

// 类型再导出（对齐 core 版惯例）：测试/消费方从本模块取契约类型，
// SSOT = SDK ui-types（core 反向再导出保壳侧消费面）。
export type { UiRequest, UiRequestHandler, UiResponse } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";
import type { ExtensionUiRequest } from "./spawn-event-adapter.ts";
import { respond } from "./stdin-writer.ts";
import { parseChannel } from "./ui-channels.ts";

const logger = getLogger("subagents");

/** 队列依赖（引擎侧形态：host/askUser 反向请求的应答回调由 server 注入）。 */
export interface UiRequestQueueDeps {
  /**
   * UI 请求处理回调（= host/askUser 反向请求的两阶段等待体）。未设置时不再
   * 静默忽略——本地去重告警 + respond(cancelled)（子进程不永久挂起）。
   */
  uiRequestHandler?: UiRequestHandler;
}

/**
 * 创建 UI 请求队列。返回 enqueue 函数，调用方将 extension_ui_request 入队。
 *
 * 多个 extension_ui_request 并发到达时，队列保证 FIFO 串行处理。
 *
 * 设计：队列是 run 生命周期内的闭包状态（非模块级），每个子进程实例独立队列，
 * 无跨 session 泄漏。
 *
 * @param child 子进程（stdin 写入 extension_ui_response）
 * @param deps 队列依赖（含 uiRequestHandler 回调）
 * @returns enqueue 函数：(id, request) => void
 */
export function createUiRequestQueue(
  child: ChildProcess,
  deps: UiRequestQueueDeps,
): (id: string, request: ExtensionUiRequest) => void {
  // [R3] AbortController 取消 pending handler——子进程退出时队列不再阻塞
  const abortController = new AbortController();
  const queue: Array<{ id: string; request: ExtensionUiRequest; signal: AbortSignal }> = [];
  let processing = false;
  let closed = false;

  // 引擎包内自持去重告警（同 key 只告警一次——对齐 core notifyMissingHandlerGlobal
  // 的 per-session 去重语义，key 用 child.pid 稳定标识）
  const warnedKeys = new Set<string>();

  function processNext(): void {
    if (processing || queue.length === 0 || closed) return;
    processing = true;
    const { id, request, signal } = queue.shift()!;
    // [F2] .catch 在 .finally 之前：handleUiRequest 是 async 函数，任何同步异常
    // 都会变成 rejection；记 error 后吞掉，.finally 照常释放 processing 推进队列。
    handleUiRequest(child, id, request, deps, signal, warnedKeys)
      .catch((err: unknown) => {
        const m = toErrorMessage(err);
        logger.error(`[subagents] ui request ${id} (${request.method}) failed unexpectedly: ${m}`);
      })
      .finally(() => {
        processing = false;
        processNext();
      });
  }

  // [R3] 子进程退出时 abort 所有 pending handler，队列不再阻塞（幂等守卫：
  // close + error 可能都触发）
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    abortController.abort();
    queue.length = 0;
  };
  child.on("close", onClose);
  child.on("error", onClose);

  return function enqueue(id: string, request: ExtensionUiRequest): void {
    if (closed) return;
    queue.push({ id, request, signal: abortController.signal });
    processNext();
  };
}

/**
 * 处理子进程发来的 extension_ui_request（ask_user 及其他 Pi UI method）。
 *
 * 流程：从 ExtensionUiRequest 构造 UiRequest（含 channel/channelPayload）
 *  → 调用 uiRequestHandler（host/askUser 反向请求的两阶段等待体）
 *  → 按 UiResponse 形状回写 stdin。
 *
 * handler 未设置时不再静默忽略——去重告警 + respond(cancelled)
 * （等价于用户主动取消的语义，子进程不永久挂起等 response）。
 */
async function handleUiRequest(
  child: ChildProcess,
  id: string,
  request: ExtensionUiRequest,
  deps: UiRequestQueueDeps,
  signal: AbortSignal | undefined,
  warnedKeys: Set<string>,
): Promise<void> {
  const handler = deps.uiRequestHandler;
  if (!handler) {
    const key = child.pid?.toString() ?? id;
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      logger.warn(
        `[subagents] no ui request handler bound (host/askUser unsupported?); subsequent requests from this child will be auto-cancelled`,
        { pid: child.pid, method: request.method },
      );
    }
    respond(child, id, { cancelled: true }, signal);
    return;
  }

  // 从 ExtensionUiRequest 构造 UiRequest（含 channel/channelPayload）
  const { channel, channelPayload } = parseChannel(request);
  const uiReq: UiRequest = {
    id,
    method: request.method,
    ...(child.pid !== undefined ? { _childPid: child.pid } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(channelPayload !== undefined ? { channelPayload } : {}),
    ...extractMethodFields(request),
  };

  try {
    const result: UiResponse = await handler(uiReq);
    // [R3] 子进程已退出，跳过写入
    if (signal?.aborted) return;
    respond(child, id, result, signal);
  } catch (err) {
    if (signal?.aborted) return;
    logger.error("[subagents] uiRequestHandler threw", {
      detail: toErrorMessage(err),
    });
    respond(child, id, { cancelled: true }, signal);
  }
}

/** method-specific 字段值守卫（与原 inline 判定 1:1）。 */
function isStringValue(value: unknown): boolean {
  return typeof value === "string";
}

function isNumberValue(value: unknown): boolean {
  return typeof value === "number";
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

/** extractMethodFields 字段复制规格表（与 Pi rpc-types.ts 1:1，序 = 原复制序）。
 *  guard = in 命中后的值类型守卫（验不过不复制）；null = 仅 in 检查直赋。 */
const METHOD_FIELD_COPY_SPECS: ReadonlyArray<{
  key: string;
  guard: ((value: unknown) => boolean) | null;
}> = [
  { key: "title", guard: isStringValue },
  { key: "options", guard: isArrayValue },
  { key: "message", guard: isStringValue },
  { key: "placeholder", guard: isStringValue },
  { key: "prefill", guard: isStringValue },
  { key: "notifyType", guard: isStringValue },
  { key: "statusKey", guard: isStringValue },
  { key: "statusText", guard: null },
  { key: "widgetKey", guard: isStringValue },
  { key: "widgetLines", guard: null },
  { key: "widgetPlacement", guard: null },
  { key: "text", guard: isStringValue },
  { key: "timeout", guard: isNumberValue },
];

/** 从 ExtensionUiRequest 提取 method-specific 字段到 UiRequest（与 Pi rpc-types.ts 1:1）。
 *  按 method 变体类型安全地复制对应字段；缺失字段不复制（保持 UiRequest 可选）。 */
function extractMethodFields(req: ExtensionUiRequest): Partial<UiRequest> {
  const out: Partial<UiRequest> = {};
  const source: Record<string, unknown> = req;
  for (const { key, guard } of METHOD_FIELD_COPY_SPECS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (guard !== null && !guard(value)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
