/**
 * select+marker 通道 RPC 原语（D8）。
 *
 * 消费方（session-manager / subagent-workflow inflight-reporter）各自手写过
 * 「ctx.ui.select(marker, [payload], opts) + 失败折叠 + JSON 检测」传输核，
 * 形态同构、留痕/超时策略各异。本原语只收敛传输核与失败折叠契约，真差异留在调用方：
 *
 * - 判别结果而非抛错（调用方统一按 reason 折叠 isError / 重试）；
 * - 回包只做 JSON 合法性检测（`non-json` 判别 + 留痕），parsed 结果的消费留调用方——
 *   value 恒 raw string（session-manager raw 透传 / inflight ack 全等匹配，回包消费
 *   是真差异，不进原语）；
 * - payload 调用方已序列化（原语不 stringify——各协议序列化形状各异：嵌套
 *   {action,params} / 快照帧，不引入内部 stringify 异常面）；
 * - mode 门控留调用方（inflight 在 attachSession 处 / session-manager 无门控——
 *   四态 reason 无 non-rpc 语义）；
 * - `ui.select` 缺席（非 GUI ctx）由调用方前置判定（沿已退役的 ask-user askUserInteract
 *   先例——`isGuiCapable(ctx) && ctx.ui?.select`，git 历史可溯；isGuiCapable 现存于本包
 *   core/helpers 并经包入口导出）；误用即 throw 明确错误。
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

/** 错误回包底层形状：select+marker 通道各协议（session-manager）
 * runtime 侧异常折叠的共用单源（不裸 reject，error 闭环走同一回包通道）。
 * SessionManagerErrorResult 是本形状的 alias（D8 单源化）。
 *
 * `code`（session-manager-archive-delete U2，additive optional）：结构化错误码
 * 透传通道（如 ArchiveError 的 `archive_generating`）——旧 runtime 不产出、旧
 * extension 不消费，只加字段不破坏现有消费方。 */
export interface ChannelErrorResult {
  error: string
  hint?: string
  code?: string
}

/** 运行时形状检查：{error: string}（hint 可选，不校验其类型；code additive 宽容
 * ——缺席放行（旧 runtime 兼容象限）、present 须为 string；排数组） */
export function isChannelErrorResult(v: unknown): v is ChannelErrorResult {
  const rec = v as Record<string, unknown>
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof rec.error === 'string' &&
    (rec.code === undefined || typeof rec.code === 'string')
  )
}

/** error + code + hint 文本拼接（code/hint 缺席各自省略对应行）——plugin-bridge
 * errorResult 与 session-manager 错误闭环文本的共用单源。code present 时以
 * `error_code: <code>` 行拼入（session-manager-archive-delete 决策 5：结构化错误码
 * 对模型可见——工具 description 教 agent 认的码词在 throw 文本里在场，善后层恢复
 * 指引的第一跳不断链）；code 缺席（旧 runtime 回包 / canvas 等无码消费方）行为不变 */
export function formatChannelErrorText(err: ChannelErrorResult): string {
  const lines = [err.error]
  if (err.code) lines.push(`error_code: ${err.code}`)
  if (err.hint) lines.push(`hint: ${err.hint}`)
  return lines.join('\n')
}

/** 失败留痕单点（channel-error / non-json 两态调用）：`opts?.log` 双层可选链收敛，
 * msg + detail 由调用点产出；log 缺席时静默（日志策略归调用方，D8 真差异保留） */
function emitRpcLog(opts: MarkerRpcOptions | undefined, msg: string, detail: object): void {
  opts?.log?.(msg, detail)
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
        'Non-GUI ctx must be gated by the caller first — gate with ' +
        'isGuiCapable(ctx) && ctx.ui?.select (exported from @zhushanwen/extension-protocol), or a mode check.',
    )
  }
  let value: string | undefined
  try {
    value = await select(marker, [payload], { signal: opts?.signal, timeout: opts?.timeout })
  } catch (err) {
    emitRpcLog(opts, `select channel threw (marker ${JSON.stringify(marker)})`, {
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
    emitRpcLog(opts, `select resolved non-string value (marker ${JSON.stringify(marker)})`, {
      valueType: typeof value,
    })
    return { ok: false, reason: 'channel-error' }
  }
  try {
    JSON.parse(value)
  } catch {
    // 非 JSON 回包 = 协议版本不匹配类故障，必须留痕不静默
    emitRpcLog(opts, `non-JSON response (marker ${JSON.stringify(marker)})`, {
      responseHead: value.slice(0, RESPONSE_PREVIEW_LENGTH),
    })
    return { ok: false, reason: 'non-json' }
  }
  // 只检测不消费：value 恒 raw string
  return { ok: true, value }
}
