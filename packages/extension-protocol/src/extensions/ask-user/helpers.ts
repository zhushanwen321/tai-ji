/**
 * ask-user extension 的富交互 helper（定制层）。
 *
 * askUserInteract() 是 ask-user extension 在 RPC 模式下的交互入口。
 * TUI 模式下 extension 必须自行调 ctx.ui.custom()。
 *
 * 走 select 通道 + marker（ASK_USER_MARKER），复用 select 的全部管道逻辑
 * （队列 / 超时 / 回传 / abort），零重复代码。
 */

import type { GuiContext } from '../../core/gui-context'
import { isGuiCapable, stripUndefined } from '../../core/helpers'
import type { AskUserQuestion, AskUserAnswers } from './types'
import { ASK_USER_MARKER } from './marker'

/**
 * ask-user 富交互入口（RPC 模式专用）。
 *
 * RPC 模式：用 select 通道携带 questions 数据，前端渲染富交互 UI。
 * TUI 模式：抛错。extension 必须自行调 ctx.ui.custom()。
 *
 * @param ctx        ExtensionContext（pi 提供）
 * @param questions  交互问题声明
 * @param options    可选：signal（abort）、allowCancel（前端是否显示取消按钮）
 * @returns          answers（key=header/question, value=JSON编码的答案），用户取消返回 null
 */
export async function askUserInteract(
  ctx: GuiContext,
  questions: AskUserQuestion[],
  options?: { signal?: AbortSignal; allowCancel?: boolean },
): Promise<AskUserAnswers | null> {
  // 空 questions 防御（与「用户 Submit 空表单」语义一致，返回 {}）
  if (questions.length === 0) return {}

  // RPC 模式：select 通道携带 questions 数据
  if (isGuiCapable(ctx) && ctx.ui?.select) {
    // questions 数据序列化进 options[0]。
    // pi select 的 request 硬编码 {method, title, options, timeout}（rpc-mode.ts:136-137），
    // helper 无法通过 ctx.ui.select 的标准参数注入自定义字段，只能借用 options 数组。
    // options 是 string[]，JSON.stringify 产出合法 string 元素，pi 原样透传。
    const payload = JSON.stringify(stripUndefined({
      questions,
      allowCancel: options?.allowCancel ?? true,
    }))
    const value = await ctx.ui.select(
      ASK_USER_MARKER,             // title = marker，runtime/前端据此识别
      [payload],                    // options[0] = JSON payload（runtime 解析）
      { signal: options?.signal },
    )
    // select 返回 undefined = 用户取消 / 超时 / abort
    if (value === undefined) return null
    // value 是前端 JSON.stringify 的 answers
    try {
      return JSON.parse(value) as AskUserAnswers
    } catch {
      // parse 失败（中间环节篡改）视为取消
      return null
    }
  }

  // 非 RPC 模式：askUserInteract 不支持 TUI 渲染。
  // TUI Component 是 extension 特定的（AskUserComponent 不能通用），helper 不代劳。
  // 抛错而非返回 null——返回 null 会与「用户取消」混淆，让 extension 误以为用户取消了。
  throw new Error(
    'askUserInteract() is only available in RPC mode. ' +
    'In TUI mode, use ctx.ui.custom() with your own Component directly.',
  )
}

/** answers 的 key：header 缺失时用 question 文本 */
function askUserKey(question: AskUserQuestion): string {
  return question.header ?? question.question
}

/**
 * 从 answers 中提取某个问题的选中值（单选返回 string，多选返回 string[]）。
 *
 * 多选 answers 的 value 是 JSON.stringify(string[])，此 helper 自动 parse。
 * parse 失败时降级返回 [raw]（兼容非标准格式的回传）。
 */
export function getAskUserAnswer(
  answers: AskUserAnswers,
  question: AskUserQuestion,
): string | string[] | undefined {
  const key = askUserKey(question)
  const raw = answers[key]
  if (raw === undefined) return undefined
  if (question.multiSelect) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : [raw]
    } catch { return [raw] }
  }
  return raw
}

/** 从 answers 中提取 Other 自由文本 */
export function getAskUserOther(
  answers: AskUserAnswers,
  question: AskUserQuestion,
): string | undefined {
  return answers[`${askUserKey(question)}__other`]
}

/**
 * 类型守卫：验证 unknown 是否为合法的 AskUserQuestion。
 * 用于前端从 runtime 透传的 askUserQuestions（unknown[]）中安全收窄。
 */
export function isAskUserQuestion(value: unknown): value is AskUserQuestion {
  if (typeof value !== 'object' || value === null) return false
  const q = value as Record<string, unknown>
  return typeof q.question === 'string'
    && (q.header === undefined || typeof q.header === 'string')
    && (q.options === undefined || Array.isArray(q.options))
    && (q.multiSelect === undefined || typeof q.multiSelect === 'boolean')
    && (q.allowOther === undefined || typeof q.allowOther === 'boolean')
}
