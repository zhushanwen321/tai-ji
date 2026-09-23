/**
 * choice/text 问题的答案编辑状态（FormOverlay 壳持有，渲染器经 v-model 编辑）。
 *
 * 状态留在壳的原因：tab 绿点 / allAnswered Submit 门 / onSubmit 编码都消费全量状态
 * （AskUserOverlay 逐字继承语义）；渲染器只做单题的呈现与编辑上报。
 */
export interface QuestionState {
  /** 选中的 option label（单选长度 0/1，多选任意；含 OTHER_VALUE 占位符） */
  selectedValues: string[]
  /** Other 自由文本 / text 题答案 */
  otherText: string
}

export function initialQuestionState(): QuestionState {
  return { selectedValues: [], otherText: '' }
}

/** Other 特殊选项的占位值（卡片化，选中后展开输入框；提交时过滤出真实选项） */
export const OTHER_VALUE = '__other__'
