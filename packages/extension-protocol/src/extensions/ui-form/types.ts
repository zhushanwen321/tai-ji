/**
 * 统一提问表单协议（ui-form）的类型定义。
 *
 * 把 plan / scheduler / ask-user 三个 extension 的提问交互收口为一个表单协议：
 * 问题即数据（类型化问题集），GUI 链路统一（wire 协议 + 渲染器）——多问 = 多 tab，
 * 单问 = 单视图。extension 侧经 uiFormInteract() 序列化进 select 的 options[0]，
 * runtime event-adapter 检测 UI_FORM_MARKER 广播 form 帧，前端 FormOverlay
 * 按问题 type 分派渲染器（choice / text / schedule）。
 *
 * 这是提问交互的通用协议（区别于 ask-user / scheduler-create 的定制协议）。
 * formQuestions 在 TUI 无呈现语义——TUI 数据通路各 extension 自行渲染（设计 D8
 * 有意取舍），消费方为 extension 自有组件。
 */

import type { ScheduleDraft } from '../scheduler-create/types'

/**
 * choice 问题：互斥/多选选项。
 * 对应现 AskUserQuestion 有 options 的形态（multiSelect → multi 重命名）。
 */
export interface ChoiceQuestion {
  type: 'choice'
  /** Tab 标签 / 简短标题。answers key 缺省 fallback 到 question 全文（与 askUserKey 同规则） */
  header?: string
  /** 完整问题文本。也作为 answers 的 fallback key（header 缺失时） */
  question: string
  /** 上下文摘要（可选）。显示在问题上方，帮用户理解背景 */
  context?: string
  /** 互斥选项列表（无 options 的纯自由文本问题用 TextQuestion 表达） */
  options: FormOption[]
  /** 是否允许多选 */
  multi?: boolean
  /** 是否允许自由文本输入（Other）。默认 true（同 ask-user 现状），设 false 则不追加 */
  allowOther?: boolean
}

/** 选项声明（label 即选中值：协议无独立 value 字段，回传统一用 label） */
export interface FormOption {
  label: string
  /** 描述（可选）。显示在 label 下方，解释 tradeoff */
  description?: string
}

/**
 * text 问题：纯自由文本输入（无 options）。
 * 协议值域完备性要求保留：AskUserQuestion.options 声明可选，归一层 type 推断
 * 与消费端必须能表达「无 options」的合法旧形态（设计 D2）。
 */
export interface TextQuestion {
  type: 'text'
  header?: string
  question: string
  context?: string
}

/**
 * schedule 问题：时间输入领域原语（非 scheduler 专属形状）。
 * 渲染器 = scheduler 创建确认整表单（ScheduleForm，单 tab 整表单收编，设计 D2）；
 * 预填草稿经 initial 直传，打开即可一键确认。
 */
export interface ScheduleQuestion {
  type: 'schedule'
  header?: string
  question: string
  context?: string
  /** 预填草稿（可选）。ScheduleDraft 复用 scheduler-create 模块定义（零新增依赖方向） */
  initial?: ScheduleDraft
}

/** 类型化问题集（判别联合：按 type 分派渲染器） */
export type FormQuestion = ChoiceQuestion | TextQuestion | ScheduleQuestion

/**
 * 统一表单回传结果。key = header ?? question（fallback 规则与 askUserKey 一致）。
 *
 * 答案编码规则（choice/text 部分与现 AskUserAnswers 逐字兼容，含 Other 键规则
 * 与多选序列化——ask-user 消费方 getAskUserAnswer / getAskUserOther 零改动）：
 * - choice 单选：value = 选中项的 label
 * - choice 多选：value = JSON.stringify(选中项 label 数组)，如 '["pg","mysql"]'
 * - Other 文本：单独 key `${key}__other`，value = 自由文本（不混进选中项数组）
 * - text：value = 自由文本，**键位 `${key}__other`**（逐字继承现状纯 other 形态——
 *   无 options 题答案只写 __other 不写主 key，写主 key 会令 getAskUserAnswer 键位翻转）
 * - schedule：value = JSON.stringify(ScheduleFormResult)（单问表单下 answers 恰一键）
 */
export type FormAnswers = Record<string, string>
