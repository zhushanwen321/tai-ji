/**
 * 统一提问表单（ui-form）协议 helper。
 *
 * uiFormInteract() 是 plan / scheduler / ask-user 三方提问在 RPC 模式下的统一入口
 * （设计 ui-presentation-protocol D3）。走 select 通道 + marker（UI_FORM_MARKER），
 * 传输核复用 callMarkerRpc 原语，四态判别返回而非抛错（除 RPC 门外）：
 * - cancelled / timeout → 调用方按「用户未作答」折叠；
 * - channel-error → 通道契约破坏（含 echo 检测命中的旧宿主组合），调用方按各自
 *   策略折叠（scheduler 禁用工具 + throw / plan 折 cancelled result 留 plan mode）；
 * - non-json → 协议版本错配类故障。
 *
 * TUI 模式不代劳渲染（formQuestions 在 TUI 无呈现语义，各 extension 自有组件
 * 消费，设计 D8）：误调抛错指明恢复动作，返回判别失败会与「用户取消」混淆。
 */

import type { GuiContext } from '../../core/gui-context'
import { isGuiCapable, stripUndefined } from '../../core/helpers'
import { callMarkerRpc } from '../../core/select-rpc'
import type { FormAnswers, FormQuestion } from './types'
import { UI_FORM_MARKER } from './marker'
import { isFormAnswers, isFormQuestion } from './guards'

/** uiFormInteract 的判别结果：成功收窄为 FormAnswers；失败按 callMarkerRpc 四态折叠。
 * message 仅 channel-error 的 echo 命中态携带（升级指引，见 uiFormInteract 内注释），
 * 供调用方折叠时透出——各调用方对 channel-error 的折叠策略不同，文案由调用方决定是否使用 */
export type UiFormInteractResult =
  | { ok: true; answers: FormAnswers }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'channel-error' | 'non-json'; message?: string }

export interface UiFormInteractOptions {
  /** 透传 select dialog：abort 后 pi 本地 resolve(undefined) → cancelled */
  signal?: AbortSignal
  /** 前端是否显示取消按钮（默认 true，沿已退役的 askUserInteract 的默认值先例） */
  allowCancel?: boolean
  /** 失败留痕注入（echo 命中 / 形状错），日志策略归调用方 */
  log?: (msg: string, detail?: object) => void
}

/** 形状错留痕里回包预览的截断长度（与 callMarkerRpc 的 RESPONSE_PREVIEW_LENGTH 同规范） */
const RESPONSE_PREVIEW_LENGTH = 200

/** echo 检测命中时的升级指引（D3）：用户可操作的恢复动作 = 升级 taiji 或钉住 extension 版本 */
const ECHO_UPGRADE_HINT = 'taiji host too old for form protocol — upgrade taiji or pin extension version'

/**
 * 统一提问表单入口（RPC 模式专用）。
 *
 * RPC 模式：select 通道携带类型化问题集，前端 FormOverlay 渲染表单，回传 FormAnswers。
 * TUI 模式：抛错，extension 自行渲染（ctx.ui.custom 或原生 select）。
 *
 * 确认交互不设墙钟超时（任务级正常路径无墙钟，AGENTS.md 超时默认原则）：
 * options 不提供 timeout 入口，timeout 态仅由「未 abort 的 undefined resolve」产生。
 */
export async function uiFormInteract(
  ctx: GuiContext,
  form: FormQuestion[],
  opts?: UiFormInteractOptions,
): Promise<UiFormInteractResult> {
  // 空 questions 防御（沿已退役的 askUserInteract 先例：「用户 Submit 空表单」语义，answers = {}）
  if (form.length === 0) return { ok: true, answers: {} }

  // 发送侧守卫（D2 失败策略）：不合法项 = 调用方编码 bug，fail-fast 抛错而非发出坏帧
  const invalidIndex = form.findIndex((q) => !isFormQuestion(q))
  if (invalidIndex >= 0) {
    throw new Error(
      `uiFormInteract(): form[${invalidIndex}] is not a valid FormQuestion ` +
      "(type must be 'choice' | 'text' | 'schedule' with required fields present) — " +
      'fix the question definition at the call site.',
    )
  }

  if (!(isGuiCapable(ctx) && ctx.ui?.select)) {
    // 非 RPC 模式不代劳 TUI 渲染。抛错而非返回判别失败——返回失败态会与
    // 「用户取消」混淆，让 extension 误以为用户取消了（沿已退役的 askUserInteract 先例）。
    throw new Error(
      'uiFormInteract() is only available in RPC mode. ' +
      'In TUI mode, use ctx.ui.custom() with your own Component directly.',
    )
  }

  // questions 数据序列化进 options[0]：pi select 的 request 硬编码
  // {method, title, options, timeout}，自定义数据只能借 options 数组携带
  // （沿已退役的 askUserInteract 同一先例，git 历史可溯），options 是 string[]，
  // JSON.stringify 产出合法元素。
  const payload = JSON.stringify(stripUndefined({
    formQuestions: form,
    allowCancel: opts?.allowCancel ?? true,
  }))
  const rpcResult = await callMarkerRpc(
    ctx,
    UI_FORM_MARKER,
    payload,
    { signal: opts?.signal, log: opts?.log },
  )
  if (!rpcResult.ok) {
    return { ok: false, reason: rpcResult.reason }
  }

  // echo 检测：「旧 taiji + 新 npm」组合下宿主不识别 UI_FORM_MARKER，form 帧降级普通
  // select 落 band，单选项 = payload 自身；用户点选即回显 payload（D7 下三角矩阵）。
  // 收包与发送 payload 逐字节相等 = 确定性识别该不支持组合（payload 是合法 JSON，
  // 必须在 JSON.parse 之前判定），折叠 channel-error + 升级指引。
  if (rpcResult.value === payload) {
    opts?.log?.('ui-form response echoed the request payload (host does not understand UI_FORM_MARKER)', {
      responseHead: rpcResult.value.slice(0, RESPONSE_PREVIEW_LENGTH),
    })
    return { ok: false, reason: 'channel-error', message: ECHO_UPGRADE_HINT }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rpcResult.value)
  } catch {
    // callMarkerRpc 已检测过 JSON 合法性，此处为防御性兜底，保持判别完备
    return { ok: false, reason: 'non-json' }
  }
  if (!isFormAnswers(parsed)) {
    // JSON 合法但非本协议形状 = 协议版本错配类故障，按 non-json 同折叠
    opts?.log?.('ui-form response is not a FormAnswers record', {
      responseHead: rpcResult.value.slice(0, RESPONSE_PREVIEW_LENGTH),
    })
    return { ok: false, reason: 'non-json' }
  }
  return { ok: true, answers: parsed }
}
