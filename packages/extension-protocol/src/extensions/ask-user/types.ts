/**
 * ask-user extension 的富交互类型定义。
 *
 * GUI 提问交互已迁移统一表单协议（../ui-form：FormQuestion 类型化问题集 +
 * UI_FORM_MARKER + uiFormInteract，前端 FormOverlay 渲染）——ask_user 工具的
 * 问题在 ask-user 包内归一 adapter 转为 FormQuestion（choice/text 形态）发送。
 *
 * 本模块保留的 AskUserQuestion / AskUserAnswers 是 ask-user 的 LLM 入参契约与
 * TUI/解码消费形态：FormAnswers 的 choice/text 部分与 AskUserAnswers 逐字兼容
 * （键位规则与多选序列化一致），解码 helper（getAskUserAnswer/getAskUserOther）
 * 消费本类型。legacy 帧（ASK_USER_MARKER → {askUser, askUserQuestions}）在
 * renderer 入口归一层转 FormQuestion（D7 兼容窗口），随窗口末清理退役。
 */

/**
 * ask-user 富交互问题声明。
 */
export interface AskUserQuestion {
  /** Tab 标签 / 简短标题。多问题时用于 tab 切换，≤12 字符。
   *  可选——未提供时前端用 question 文本作为 tab 标签（前 12 字符截断显示）
   *  和 answers key（完整 question 文本，不截断）。 */
  header?: string
  /** 完整问题文本。也作为 answers 的 fallback key（header 缺失时） */
  question: string
  /** 上下文摘要（可选）。显示在问题上方，帮用户理解背景 */
  context?: string
  /** 互斥选项列表（可选）。无 options = 纯自由文本输入 */
  options?: AskUserOption[]
  /** 是否允许多选。仅 options 存在时有效 */
  multiSelect?: boolean
  /** 是否允许自由文本输入（Other）。
   *  - 有 options 时：默认 true，前端在选项末尾追加 Other 输入框；设 false 则不追加
   *  - 无 options 时：整个问题就是自由输入，此字段被忽略 */
  allowOther?: boolean
}

export interface AskUserOption {
  /** 显示标签，回传时作为选中值（D1：proto 无独立 value，选中值统一用 label） */
  label: string
  /** 描述（可选）。显示在 label 下方，解释 tradeoff */
  description?: string
}

/**
 * ask-user 富交互回传结果。key = question.header（header 缺失时用 question 文本）。
 *
 * 答案编码规则（避免逗号歧义）：
 * - 单选：value = 选中项的 label
 * - 多选：value = JSON.stringify(选中项 label 数组)，如 '["pg","mysql"]'
 *   （不用逗号 join——option label 可能含逗号导致 split 歧义）
 * - Other 文本：单独 key `${header}__other`，value = 自由文本（不混进选中项数组）
 *
 * extension 解析示例：
 *   const selected = JSON.parse(answers[header])  // 多选 → string[]
 *   const other = answers[`${header}__other`]     // Other 自由文本
 */
export type AskUserAnswers = Record<string, string>
