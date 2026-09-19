/**
 * scheduler 创建确认弹框的协议类型（Draft / FormResult）。
 *
 * GUI 创建确认已迁移统一表单协议（ui-form 模块的 uiFormInteract + UI_FORM_MARKER，
 * 交互入口 extensions/universal/scheduler/src/tool.ts：Draft 经 initial 预填为
 * ScheduleQuestion 单问整表单，前端 FormOverlay 的 schedule 渲染器回传
 * ScheduleFormResult）——ScheduleDraft / ScheduleFormResult 即该表单的预填与
 * 回传形状，TUI 侧 ScheduleCreateComponent 同用本类型。
 *
 * 取消不走 FormResult：interact 取消 resolve undefined，execute 返回
 * cancelled result（D5），任务不创建。
 *
 * SCHEDULE_CREATE_MARKER / ScheduleCreateOverlay 为 legacy 窗口语义（旧 npm 帧
 * 由 runtime event-adapter 识别 / 迁移溯源锚点），随 D7 窗口末清理退役。
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
