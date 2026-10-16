// form-protocol —— ui-form 线协议的共享纯逻辑单点（双壳逐字节共享，MF-1-8 收敛落点）。
//
// ui-form 线协议的编码契约此前双壳各一份（桌面内联在 renderer FormOverlay + 移动
// shell/form-protocol），协议注释禁止双端各写一份；本模块为该契约的唯一实现，两壳消费面
// 改指此处（协议 SSOT 见 @zhushanwen/extension-protocol ui-form/types.ts FormAnswers 注释）：
// - 帧标记守卫：C4 富交互判定（form ∨ planReview）与 planReview 审批帧窄化
//   （form-request-channel 的 C4 门与读口谓词、双壳入帧路径共用）
// - 问题集编码契约：questionKey（header ?? question fallback）、isQuestionAnswered
//   （Submit 门判定）、encodeFormAnswers（FormAnswers envelope：choice 单选 = label /
//   多选 = JSON.stringify(label[]) / Other 占位符过滤 / `${key}__other` 独立键——text 题
//   不写主 key）、initialQuestionState（choice/text 编辑态形状）
// - schedule 草稿回显：draftToScheduleFormResult（ScheduleFormResult 构造——action/kind/
//   schedule 折叠、model 预选、expires 缺省 7d、recurring 才带 expires），与桌面
//   ScheduleForm 打开即确认路径字节等价；时间折叠单点 = 协议包
//   dateToOnceCron/onceCronToDate（协议注释禁止双端各写一份）
//
// 渲染形态差异（桌面 tab 逐题 / 移动堆叠单列）不进本模块——那是壳的真差异；schedule
// 句柄取值差异（桌面 ref 句柄 canSubmit/submit / 移动参数注入）经参数注入保留在组件。
import {
  dateToOnceCron,
  isFormQuestion,
  isScheduleDraft,
  onceCronToDate,
  type FormQuestion,
  type ScheduleDraft,
  type ScheduleFormResult,
  type ScheduleQuestion,
} from '@zhushanwen/extension-protocol'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── 帧标记守卫（窄化 ExtensionUIRequest 索签名承载的 marker 键）──────────────

/** planReview 审批帧（runtime event-adapter PLAN_REVIEW_MARKER 分支产出，selfReview 有界可选） */
export type PlanReviewFrame = ExtensionUIRequest & {
  planReview: true
  selfReview?: string
}

export function isPlanReviewFrame(req: ExtensionUIRequest): req is PlanReviewFrame {
  return (req as { planReview?: unknown }).planReview === true
}

/**
 * C4 富交互帧判定（双壳共同不变量：form ∨ planReview 放行——legacy askUser/scheduleCreate
 * 帧的归一已在 runtime event-adapter 完成，此处只认 view-ready 键）。
 * 参数取 unknown + 运行时收窄：bus DialogRequest（索引签名承载 marker 键）与
 * ExtensionUIRequest 快照条目两源共用，规避弱类型检查对无公共声明属性源的拒绝。
 */
export function isRichInteractionFrame(req: unknown): boolean {
  if (typeof req !== 'object' || req === null) return false
  const probe = req as { form?: unknown; planReview?: unknown }
  return probe.form === true || probe.planReview === true
}

/** form 帧问题集收窄（isFormQuestion 逐项过滤；非 form 帧恒空） */
export function formQuestionsOf(req: ExtensionUIRequest): FormQuestion[] {
  if (req.form !== true) return []
  const raw = req.formQuestions ?? []
  return raw.filter(isFormQuestion)
}

/** legacy scheduleCreate 帧的预填草稿收窄（形状守卫失败 → null，不可确认仅可取消） */
export function scheduleDraftOf(req: ExtensionUIRequest): ScheduleDraft | null {
  if (req.scheduleCreate !== true) return null
  return isScheduleDraft(req.scheduleDraft) ? req.scheduleDraft : null
}

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

/** Other 特殊选项占位值（协议约定：提交时过滤出真实选项） */
export const OTHER_VALUE = '__other__'

/** 问题 key（answers 编码键，协议 fallback 规则：header 缺省回落 question 全文） */
export function questionKey(q: FormQuestion): string {
  return q.header ?? q.question
}

/**
 * 问题已答判定（Submit 门）：choice 需普通选项选中 ≥1（Other 选中须有文本，或另有其他
 * 选中）；text / 空 options 退化 choice 需非空文本；schedule 由调用方传入回显可构造性
 * （预填草稿视为有效——桌面传渲染器 canSubmit，移动传 isScheduleEchoReady）。
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
 * FormAnswers envelope 编码（choice/text + schedule 合一）。schedule 题经 scheduleValue
 * 取回显 JSON；任一 schedule 题不可构造 → 返回 null（调用方中止整表提交——桌面
 * FormOverlay「提交瞬间复核未过整表中止」同语义）。
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
 *   再 dateToOnceCron 折叠；还原失败（非 once 形态）→ null
 * - recurring：草稿 cron/duration 原样（trim）；expires 缺省 '7d'（桌面初值同式），once 不携带
 * - model 预选：draft.model ?? currentModel（须在候选列表内），回退列表首项，空列表缺省
 * - prompt 空 → null（桌面 canSubmit 同判：提示词必填）
 */
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
