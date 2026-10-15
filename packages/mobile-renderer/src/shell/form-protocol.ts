// form-protocol —— 移动壳 form 视图辅助薄层（schedule 回显确认门）。
//
// ui-form 线协议的编码契约与帧标记守卫已收敛 @taiji/ui/extension-host form-protocol
// （双壳共享纯模块单点——问题收窄 / 答案编码 / draft 回显构造 / C4 帧判定，消费面直改
// import 该模块）；本模块只留移动壳消费面的 schedule 回显薄包装：
// - schedule 回显：预填草稿未编辑确认 = ScheduleFormResult 构造（委托共享
//   draftToScheduleFormResult；MobileFormCard 的确认门与提交门共用）
//
// 移动壳自建精简 form 视图（触控堆叠单列，区别于桌面 FormOverlay 的 tab 形态——真差异），
// 渲染形态差异不进共享模块。
import type { ScheduleFormResult, ScheduleQuestion } from '@zhushanwen/extension-protocol'
import { draftToScheduleFormResult } from '@taiji/ui/extension-host'

/**
 * schedule 回显构造（桌面 ScheduleForm 打开即确认路径的字节等价物）：
 * 无 initial 的 schedule 题 → null（桌面默认表单需用户填时刻与提示词，移动仅可取消）。
 */
export function scheduleEchoResult(question: ScheduleQuestion): ScheduleFormResult | null {
  if (question.initial === undefined) return null
  return draftToScheduleFormResult(question.initial)
}

/** schedule 回显的确认门（= draftToScheduleFormResult 可构造性；提交门与禁用态共用） */
export function isScheduleEchoReady(question: ScheduleQuestion): boolean {
  return question.initial !== undefined && draftToScheduleFormResult(question.initial) !== null
}
