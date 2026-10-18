// form-protocol —— 移动壳 form 类请求的帧收窄（问题集过滤 / 草稿收窄 / 富交互帧判定）。
//
// ui-form 线协议的编码/判定纯逻辑（initialQuestionState/questionKey/isQuestionAnswered/
// encodeFormAnswers/draftToScheduleFormResult 等）单点在 @taiji/ui/form-protocol（双壳共享，
// 契约测试锁定）；本模块只承载移动壳特有的帧级消费面：
// - 问题集收窄：isFormQuestion 复核过滤（renderer Panel.formQuestions 同式，滤除留痕由调用方）
// - 草稿收窄：legacy scheduleCreate 帧的预填草稿形状检查
// - 富交互帧判定：C4 门放行 form ∨ planReview（桌面 useExtensionUI handler 同式）
import {
  isFormQuestion,
  isScheduleDraft,
  type FormQuestion,
  type ScheduleDraft,
} from '@zhushanwen/extension-protocol'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── 帧标记检查（窄化 ExtensionUIRequest 索引签名承载的 marker 键）──────────────

/** planReview 审批帧（runtime event-adapter PLAN_REVIEW_MARKER 分支产出，selfReview 有界可选） */
export type PlanReviewFrame = ExtensionUIRequest & {
  planReview: true
  selfReview?: string
}

export function isPlanReviewFrame(req: ExtensionUIRequest): req is PlanReviewFrame {
  return (req as { planReview?: unknown }).planReview === true
}

/**
 * C4 富交互帧判定（桌面 useExtensionUI handler 同式：form ∨ planReview 放行——legacy
 * askUser/scheduleCreate 帧的归一已在 runtime event-adapter 完成，此处只认 view-ready 键）。
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

/** legacy scheduleCreate 帧的预填草稿收窄（形状检查失败 → null，不可确认仅可取消） */
export function scheduleDraftOf(req: ExtensionUIRequest): ScheduleDraft | null {
  if (req.scheduleCreate !== true) return null
  return isScheduleDraft(req.scheduleDraft) ? req.scheduleDraft : null
}
