/**
 * canvas 工具的 marker 通道层（设计 §3.1(2) 通道）。
 *
 * 每个工具 execute 把调用转译为 CANVAS_MARKER 的 {action, params} 嵌套载荷，
 * 经 ctx.ui.select 挂起 → runtime event-adapter 显式分支翻译 → CanvasHandler →
 * 应答经 extension_ui_response 解挂（session-manager 同款；契约 SSOT 在
 * @zhushanwen/extension-protocol 的 src/extensions/canvas/ 契约模块）。
 *
 * 错误闭环（extension-conventions「禁止错误成功模式」）：
 * - 通道失败（cancelled / channel-error / non-json）→ throw（pi agent-loop 置
 *   isError:true，agent 能区分成功与失败以决定重试/放弃）；
 * - runtime 结构化错误回包（{error, hint}）→ throw formatChannelErrorText；
 * - mutate 领域拒绝（CanvasMutateReply ok:false，错误码 + 恢复动作）→ throw——
 *   不变量拦截是确定性失败，文本进 isError 消息，agent 按恢复动作修正后重试。
 *
 * 全 action 不传 timeout（设计：run 的 select 挂起无墙钟超时，对齐超时默认原则
 * ——任务级正常路径不设时限；session-manager watch 先例；ADR-0122 无包内挂死兜底）。
 */
import {
  CANVAS_MARKER,
  callMarkerRpc,
  formatChannelErrorText,
  isChannelErrorResult,
  type CanvasError,
  type CanvasMarkerAction,
  type CanvasMarkerParams,
  type GuiContext,
  type MarkerRpcResult,
} from "@zhushanwen/extension-protocol";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("pi-canvas");

/** 从 ExtensionContext 构造 callMarkerRpc 所需的 GuiContext 最小子集
 * （session-manager 同款：ExtensionContext.ui.custom 泛型签名与 GuiContext
 * 静态不兼容；callMarkerRpc 只读 ui.select）。 */
function toGuiCtx(ctx: {
  mode: GuiContext["mode"];
  hasUI: boolean;
  ui: { select: unknown };
}): GuiContext {
  return {
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    ui: {
      select: ctx.ui.select as NonNullable<GuiContext["ui"]>["select"],
    },
  };
}

/**
 * 发一次 canvas marker 请求并解包应答。
 *
 * @typeParam A marker 词表动作——action 与 params 的对应关系经泛型关联
 *              （params 必须 = CanvasMarkerParams[A]，错配编译期红）。
 * @param action marker 词表动作（CANVAS_MARKER_ACTIONS 成员）
 * @param params 该动作的契约 params（形状由各工具 execute 按契约组装）
 * @returns 成功应答的已解析 JSON（runtime 侧 CanvasMutateReply / CanvasState /
 *          CanvasListReply 形状，由调用方消费）
 * @throws 通道失败 / 结构化错误回包 / mutate 领域拒绝（ok:false）三类，均为
 *         Error 且消息含恢复动作。
 */
export async function callCanvas<A extends CanvasMarkerAction>(
  ctx: { mode: GuiContext["mode"]; hasUI: boolean; ui: { select: unknown } },
  action: A,
  params: CanvasMarkerParams[A],
): Promise<unknown> {
  const payload = JSON.stringify({ action, params });
  const result: MarkerRpcResult = await callMarkerRpc(toGuiCtx(ctx), CANVAS_MARKER, payload, {
    // 不传 timeout（ADR-0122：无包内挂死兜底；无 timer 长挂，任意晚的 respond 按 id 精确 resolve）
    log: (msg, detail) => logger.error(`[canvas] ${msg}`, { ...detail, action }),
  });
  if (!result.ok) {
    const reasonText =
      result.reason === "non-json"
        ? `canvas ${action}: non-JSON response from runtime (protocol mismatch — redeploy same-version runtime + extension; see extension logs).`
        : `canvas ${action}: cancelled or channel error.`;
    throw new Error(reasonText);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.value);
  } catch (error) {
    throw new Error(
      `canvas ${action}: 应答不是合法 JSON（runtime 契约漂移）— ${toErrorMessage(error)}。` +
        `恢复动作：核对 runtime 与 @zhushanwen/pi-canvas 版本一致后重试；详见扩展日志。`,
    );
  }
  if (isChannelErrorResult(parsed)) {
    throw new Error(formatChannelErrorText(parsed));
  }
  if (isMutateRejection(parsed)) {
    throw new Error(formatCanvasError(parsed.error, action));
  }
  return parsed;
}

/** mutate 领域拒绝腿守卫：{ok:false, error:{code,message,recover}}。 */
function isMutateRejection(v: unknown): v is { ok: false; error: CanvasError } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  if (rec.ok !== false) return false;
  const err = rec.error;
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as Record<string, unknown>).code === "string" &&
    typeof (err as Record<string, unknown>).message === "string"
  );
}

/** CanvasError → agent 可读错误文本（错误 → 含义 → 恢复动作闭环）。 */
function formatCanvasError(error: CanvasError, action: CanvasMarkerAction): string {
  return `canvas ${action} 被拒绝 [${error.code}] ${error.message} 恢复动作：${error.recover}`;
}
