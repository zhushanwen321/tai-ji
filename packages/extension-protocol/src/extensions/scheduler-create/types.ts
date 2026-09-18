/**
 * scheduler 创建确认弹框的协议类型（Draft / FormResult）。
 *
 * 数据流：agent 调 schedule 工具提交预填草稿（Draft）→ ctx.ui.select 经
 * SCHEDULE_CREATE_MARKER 通道透传前端 → 用户在 ScheduleCreateOverlay（GUI）或
 * ScheduleCreateComponent（TUI）中确认/调整 → 回传 FormResult → execute 才真正创建。
 *
 * 取消不走 FormResult：select resolve undefined（cancelled），execute 返回
 * cancelled result（D5），任务不创建。
 *
 * 这是 scheduler 创建路径的定制协议，不是通用富交互协议（与 ask-user 同理）。
 */

/**
 * 执行模式：once = 一次性（schedule 为 dateToOnceCron 折叠的一次性 cron）；
 * recurring = 循环（duration 或 cron）。
 */
export type ScheduleKind = 'once' | 'recurring'

/** 创建确认草稿（extension → 前端，LLM 参数即预填值） */
export interface ScheduleDraft {
  /** LLM 判定的执行模式，用户可改 */
  kind: ScheduleKind
  /**
   * recurring：duration（如 5m/2h）或 cron；once：已折叠的一次性 cron
   * （唯一时间来源，表单时间初值由 onceCronToDate 还原，D2）
   */
  schedule: string
  /** scoped model id；缺省 = 跟随会话当前模型 */
  model?: string
  /** agent 起草的提示词 */
  prompt: string
  /** 任务名（同现有工具参数，高级选项） */
  name?: string
  /** 过期时间（同现有工具参数，高级选项） */
  expires?: string
  /** scoped models 列表，前端不再自取 */
  models: string[]
  /** 会话当前模型 id（前端预选标记） */
  currentModel?: string
}

/**
 * 创建确认回传（前端 → extension）。
 * 取消不走此形状：select resolve undefined → execute 返回 cancelled result（D5）。
 */
export interface ScheduleFormResult {
  action: 'create'
  kind: ScheduleKind
  /** 用户确认后的最终形态（once = 经 dateToOnceCron 折叠的一次性 cron） */
  schedule: string
  /** 用户最终选择；未选 = 缺省（跟随会话当前模型） */
  model?: string
  prompt: string
  name?: string
  expires?: string
}
