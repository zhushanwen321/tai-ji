/**
 * select+marker 通道 RPC 原语（D8）。
 *
 * 三消费方（plugin-bridge / session-manager / subagent-workflow inflight-reporter）
 * 此前各自手写「ctx.ui.select(marker, [payload], opts) + 失败折叠 + JSON 检测」传输核，
 * 形态同构、留痕/超时策略各异。本原语只收敛传输核与失败折叠契约，真差异留在调用方：
 *
 * - 判别结果而非抛错（调用方统一按 reason 折叠 isError / 重试）；
 * - 回包只做 JSON 合法性检测（`non-json` 判别 + 留痕），parsed 结果的消费留调用方——
 *   value 恒 raw string（session-manager raw 透传 / plugin-bridge 各形状守卫 / inflight
 *   ack 全等匹配，三态回包消费是真差异，不进原语）；
 * - payload 调用方已序列化（原语不 stringify——各协议序列化形状各异：嵌套
 *   {action,params} / BridgeRequest / 快照帧，不引入内部 stringify 异常面）；
 * - mode 门控留调用方（三方现状各异：plugin-bridge 在 callBridge 内 / inflight 在
 *   attachSession 处 / session-manager 无门控——四态 reason 无 non-rpc 语义）；
 * - `ui.select` 缺席（非 GUI ctx）由调用方前置判定（沿 ask-user askUserInteract 的
 *   `isGuiCapable(ctx) && ctx.ui?.select` 先例）；误用即 throw 明确错误。
 *
 * 设计权威源：docs/architecture/ext-simplify-17-shared-extraction.md §3.3 D8（v7 冻结形态）。
 */

import type { GuiContext } from './gui-context'

/** 留痕里回包预览的截断长度（防大 payload 刷屏；截断只影响留痕不影响协议） */
const RESPONSE_PREVIEW_LENGTH = 200

/** marker 通道 RPC 的判别结果：成功恒 raw string（不 parse 消费）；失败四态 reason */
export type MarkerRpcResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'channel-error' | 'non-json' }

export interface MarkerRpcOptions {
  /** 透传给 select dialog：abort 后 pi 本地 resolve(undefined) */
  signal?: AbortSignal
  /** 透传给 select dialog（pi 本地计时，到期 resolve(undefined)） */
  timeout?: number
  /** 失败留痕注入（channel-error / non-json 两态调用，msg + detail 由原语产出）。
   * 日志策略（级别 / 前缀 / 防刷屏）归调用方——真差异保留。 */
  log?: (msg: string, detail?: object) => void
}

/** 错误回包底层形状：select+marker 通道各协议（plugin-bridge / session-manager）
 * runtime 侧异常折叠的共用单源（不裸 reject，error 闭环走同一回包通道）。
 * BridgeErrorResponse / SessionManagerErrorResult 是本形状的 alias（D8 单源化）。 */
export interface ChannelErrorResult {
  error: string
  hint?: string
}

/** 运行时形状守卫：{error: string}（hint 可选，不校验其类型；排数组） */
export function isChannelErrorResult(v: unknown): v is ChannelErrorResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).error === 'string'
  )
}

/** error + hint 文本拼接（hint 缺席只回 error）——plugin-bridge errorResult 与
 * session-manager 错误闭环文本的共用单源 */
export function formatChannelErrorText(err: ChannelErrorResult): string {
  return err.hint ? `${err.error}\nhint: ${err.hint}` : err.error
}

/**
 * 经 select 通道发起一次 marker RPC。
 *
 * @param ctx     满足 GuiContext 结构化类型的 ctx（pi ExtensionContext 天然满足；
 *                调用方须已判定 ui.select 在场，缺席即 throw）
 * @param marker  select title（各协议的 NUL 前缀 marker，runtime 据此路由）
 * @param payload 调用方已序列化的请求体（原语原样进 options[0]）
 * @param opts    signal / timeout 透传 select dialog；log 承担失败留痕
 */
export async function callMarkerRpc(
  ctx: GuiContext,
  marker: string,
  payload: string,
  opts?: MarkerRpcOptions,
): Promise<MarkerRpcResult> {
  const select = ctx.ui?.select
  if (!select) {
    throw new Error(
      `callMarkerRpc() requires ctx.ui.select (marker ${JSON.stringify(marker)}). ` +
        'Non-GUI ctx must be gated by the caller first — see askUserInteract precedent ' +
        '(isGuiCapable(ctx) && ctx.ui?.select, or a mode check).',
    )
  }
  let value: string | undefined
  try {
    value = await select(marker, [payload], { signal: opts?.signal, timeout: opts?.timeout })
  } catch (err) {
    opts?.log?.(`select channel threw (marker ${JSON.stringify(marker)})`, {
      reason: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'channel-error' }
  }
  if (value === undefined || value === null) {
    // pi 实装对取消/超时不可区分（rpc-mode 四路——预 abort / 中途 abort / timeout 到期 /
    // 用户 cancelled——均 resolve undefined）。以 signal.aborted 反推 cancelled，其余
    // （含未传 signal）折叠 timeout：判别粒度以底层信息源为界，不虚报可区分性。
    return { ok: false, reason: opts?.signal?.aborted ? 'cancelled' : 'timeout' }
  }
  if (typeof value !== 'string') {
    // pi 契约回包恒 string | undefined；非 string 到达 = 通道契约破坏，按 channel-error 折叠
    opts?.log?.(`select resolved non-string value (marker ${JSON.stringify(marker)})`, {
      valueType: typeof value,
    })
    return { ok: false, reason: 'channel-error' }
  }
  try {
    JSON.parse(value)
  } catch {
    // 非 JSON 回包 = 协议版本不匹配类故障，必须留痕不静默
    opts?.log?.(`non-JSON response (marker ${JSON.stringify(marker)})`, {
      responseHead: value.slice(0, RESPONSE_PREVIEW_LENGTH),
    })
    return { ok: false, reason: 'non-json' }
  }
  // 只检测不消费：value 恒 raw string
  return { ok: true, value }
}
