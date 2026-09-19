/**
 * ask-user extension 的富交互 helper（解码层）。
 *
 * GUI 提问交互已迁移统一表单协议（ui-form 模块的 uiFormInteract + UI_FORM_MARKER，
 * 设计 ui-presentation-protocol D3）——askUserInteract 传输 helper 随之退役，不保留
 * deprecated 别名；AskUserQuestion↔FormQuestion 的归一职责下沉 ask-user 包内 adapter
 * （extensions/universal/ask-user/src/form-adapter.ts）。
 *
 * 本模块保留 answers 解码 helper（getAskUserAnswer / getAskUserOther）：FormAnswers 的
 * choice/text 部分与 AskUserAnswers 逐字兼容（键位规则：key = header ?? question，
 * 多选 = JSON 数组，Other = `${key}__other`），解码契约在此单源。
 */

import type { AskUserQuestion, AskUserAnswers } from './types'

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
