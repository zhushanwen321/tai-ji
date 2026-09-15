/**
 * ask-user extension 的富交互类型定义。
 *
 * custom() 在 RPC 模式不可用（Component 是代码不是数据），ask-user 的「表单类」
 * 交互改走 select 通道：askUserInteract() 把 AskUserQuestion[] 序列化进 select 的
 * options[0]，runtime event-adapter 检测 ASK_USER_MARKER 透传 questions，
 * 前端 AskUserOverlay 渲染富交互 UI。
 *
 * 这是 ask-user 的定制协议，不是通用富交互协议。
 * 设计参考 ask-user 的 Question 结构。
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
