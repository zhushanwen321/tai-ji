// form-protocol —— ui-form 线协议的答案编码/已答判定/schedule 回显共享纯模块（双壳单点）。
//
// 桌面 FormOverlay 与移动 MobileFormCard 是同一线协议（@zhushanwen/extension-protocol
// ui-form/types.ts FormAnswers 注释 = 协议 SSOT）的两套渲染形态（桌面 tab 逐题 / 移动
// 堆叠单列——真差异），但编码规则必须逐字一致：本模块是该契约的唯一实现，双壳只做
// 呈现与状态持有，编码/判定一律 import 此处，禁止壳内副本。
// - 问题 key：header ?? question（协议 fallback 规则）
// - choice 单选 = label / 多选 = JSON.stringify(label[])；Other 与 text 题答案写
//   `${key}__other` 键（text 题不写主 key）
// - schedule：桌面经渲染器句柄取 submit() JSON，移动经 draftToScheduleFormResult 回显；
//   任一 schedule 题不可构造 → encodeFormAnswers 返回 null（调用方中止整表提交）
// - schedule 回显构造（draftToScheduleFormResult）：与桌面 ScheduleForm 打开即确认路径
//   字节等价（once 折叠往返 / recurring 原文 + expires 缺省 7d / model 预选 / prompt 必填门）；
//   时间折叠单点 = 协议包 dateToOnceCron/onceCronToDate（协议注释禁止双端各写一份）
//
// 契约锁定：src/__tests__/form-protocol.test.ts（编码断言）+ 桌面 FormOverlay 组件测试
// + 移动 mobile-form 组件测试三侧互证。
import {
  dateToOnceCron,
  onceCronToDate,
  type FormQuestion,
  type ScheduleDraft,
  type ScheduleFormResult,
  type ScheduleQuestion,
} from '@zhushanwen/extension-protocol'

// ── 问题答案状态（choice/text 编辑态；schedule 状态在回显构造，不进 states）──────

export function initialQuestionState() {
  return {
    /** 选中的 option label（单选长度 0/1，多选任意；含 OTHER_VALUE 占位符） */
    selectedValues: [] as string[],
    /** Other 自由文本 / text 题答案 */
    otherText: '',
  }
}

/** 问题作答状态形状（由唯一工厂推导，消费方经本别名引用——Rule of Three 前不立接口） */
export type QuestionState = ReturnType<typeof initialQuestionState>

/** Other 特殊选项占位值（提交时过滤出真实选项） */
export const OTHER_VALUE = '__other__'

/** 问题 key（answers 编码键，协议 fallback 规则：header 缺省回落 question 全文） */
export function questionKey(q: FormQuestion): string {
  return q.header ?? q.question
}

/**
 * 问题已答判定：choice 需普通选项选中 ≥1（Other 选中须有文本，或另有其他选中）；
 * text / 空 options 退化 choice 需非空文本；schedule 由调用方传入回显可构造性
 * （桌面 = 渲染器 canSubmit 委托，移动 = 预填草稿视为有效）。
 */
export function isQuestionAnswered(
  q: FormQuestion,
  state: QuestionState | undefined,
  scheduleReady: boolean,
): boolean {
  if (q.type === 'schedule') return scheduleReady
  if (!state) return false
  if (q.type === 'text' || q.options.length === 0) return state.otherText.trim().length > 0
  const otherSelected = state.selectedValues.includes(OTHER_VALUE)
  if (otherSelected && !state.otherText.trim()) {
    return state.selectedValues.some((v) => v !== OTHER_VALUE)
  }
  return state.selectedValues.length > 0
}

/**
 * FormAnswers envelope 编码（choice/text + schedule 合一）。
 * schedule 题经 scheduleValue 取回显 JSON；任一 schedule 题不可构造 → 返回 null
 * （调用方中止整表提交——「提交瞬间复核未过整表中止」语义）。
 */
export function encodeFormAnswers(
  questions: FormQuestion[],
  states: Record<string, QuestionState>,
  scheduleValue: (q: ScheduleQuestion) => string | null,
): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const key = questionKey(q)
    if (q.type === 'schedule') {
      const result = scheduleValue(q)
      if (result === null) return null
      answers[key] = result
      continue
    }
    const state = states[key]
    if (!state) continue
    if (q.type === 'choice' && q.options.length > 0) {
      // selected 只含真实选项 label（过滤 OTHER_VALUE 占位符）；多选序列化为 JSON 数组
      const values = state.selectedValues.filter((v) => v !== OTHER_VALUE)
      if (values.length > 0) {
        answers[key] = q.multi ? JSON.stringify(values) : values[0]
      }
    }
    // Other 自由文本写独立键 `${key}__other`；text 题答案只写 __other 不写主 key（协议键位规则）
    if (state.otherText) {
      answers[`${key}__other`] = state.otherText
    }
  }
  return answers
}

// ── schedule 回显：预填草稿未编辑确认 = ScheduleFormResult ──────────────────

/**
 * 草稿回显构造（桌面 ScheduleForm 打开即确认路径的字节等价物）：
 * - once：草稿 cron 经 onceCronToDate 还原（已过时刻顺延到下一发生点——桌面未编辑确认同式）
 *   再 dateToOnceCron 折叠；还原失败（非 once 形态）→ null（桌面退默认时刻需用户重选，
 *   移动壳无时刻编辑 → 仅可取消）
 * - recurring：草稿 cron/duration 原样（trim）；expires 缺省 '7d'（桌面初值同式），once 不携带
 * - model 预选：draft.model ?? currentModel（须在候选列表内），回退列表首项，空列表缺省
 * - prompt 空 → null（桌面 canSubmit 同判：提示词必填）
 * - 无 initial 的 schedule 问题 → null（桌面默认表单需用户填时刻与提示词，移动仅可取消）
 */
export function scheduleEchoResult(question: ScheduleQuestion): ScheduleFormResult | null {
  if (question.initial === undefined) return null
  return draftToScheduleFormResult(question.initial)
}

export function draftToScheduleFormResult(draft: ScheduleDraft): ScheduleFormResult | null {
  const prompt = draft.prompt.trim()
  if (prompt === '') return null
  const kind = draft.kind === 'recurring' ? 'recurring' : 'once'
  let schedule: string
  if (kind === 'once') {
    const restored = onceCronToDate(draft.schedule)
    if (restored === null) return null
    schedule = dateToOnceCron(restored)
  } else {
    schedule = draft.schedule.trim()
  }
  const prefer = draft.model ?? draft.currentModel
  const model = prefer !== undefined && draft.models.includes(prefer) ? prefer : draft.models[0]
  return {
    action: 'create',
    kind,
    schedule,
    ...(model !== undefined ? { model } : {}),
    prompt,
    ...(draft.name !== undefined && draft.name.trim() !== '' ? { name: draft.name.trim() } : {}),
    ...(kind === 'recurring'
      ? { expires: draft.expires === '30d' || draft.expires === 'never' ? draft.expires : '7d' }
      : {}),
  }
}

/** schedule 回显的确认门（= draftToScheduleFormResult 可构造性；提交门与禁用态共用） */
export function isScheduleEchoReady(question: ScheduleQuestion): boolean {
  return scheduleEchoResult(question) !== null
}
