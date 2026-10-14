import { Static, Type } from 'typebox'

import { parseSchedule } from './parsing.js'
import type { SchedulerService, ServiceResult } from './service.js'

// ── schedule tool ──

export const ScheduleParams = Type.Object({
  prompt: Type.String({ description: 'Message to inject when the task fires.' }),
  schedule: Type.String({ description: 'Schedule spec: duration (5m/2h/1d) for interval, or cron expression (*/10 * * * *).' }),
  kind: Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('recurring')], { description: 'Task kind. Default: recurring.' })),
  name: Type.Optional(Type.String({ description: 'Human-readable task name. Auto-generated from prompt if omitted.' })),
  expires: Type.Optional(Type.String({ description: 'Expiry duration (30m/2h/7d). Default: 7d. Pass "never" to disable. Only applies to recurring tasks (once tasks fire and are removed, expires is ignored).' })),
  model: Type.Optional(Type.String({ description: 'Scoped model id (provider/model) to run the task with. Omit to use the session\'s current model.' })),
})

export type ScheduleParamsT = Static<typeof ScheduleParams>

// D1 单源化：guidelines 只承载使用纪律（何时调用 / 结果复述 / 撤销方式）；
// 参数格式与默认值（duration/cron、kind、expires、model 语义）单源在 ScheduleParams
// 字段说明，此处不再复述；「会话内存活」等行为边界在工具 description。
export const scheduleGuidelines = [
  'Only call this tool when the user asks to create a scheduled task AND the timing is already expressed (a duration, an explicit wall-clock time, or a cron expression); if the timing or the reminder content is missing or ambiguous, clarify with the user first (ask-user tool or chat) — never guess a schedule and never create the task silently.',
  'After creation, repeat the schedule, the next run time(s), and the task id back to the user so they can verify or undo it.',
  'To undo a task, use schedule_control delete (or toggle it off) — do not create a duplicate instead.',
]

/** 用户取消（abort）时的 tool result 文案：取消不是错误，正常返回不 throw。 */
const CANCELLED_NOTICE =
  'Cancelled. The task was NOT created. Do not assume a configuration and do not retry — ' +
  'wait for further user instructions or explicit approval before creating it.'

/** 取消结果：正常返回 + cancelled details，不 throw（标错会诱导 LLM 重试） */
function cancelledCreateResult(): {
  content: { type: 'text'; text: string }[]
  details: unknown
} {
  return {
    content: [{ type: 'text' as const, text: CANCELLED_NOTICE }],
    details: { cancelled: true },
  }
}

/**
 * 创建前预校验：prompt 空 / schedule 非法 → 不创建直接 throw
 *（错误可自修复：修正参数后重调 schedule）。
 */
function assertValidScheduleParams(prompt: string, scheduleInput: string): void {
  if (!prompt || prompt.trim() === '') {
    throw new Error('Invalid parameters: prompt must not be empty. Fix the parameters and call schedule again.')
  }
  if (!parseSchedule(scheduleInput)) {
    throw new Error(
      `Invalid parameters: unrecognized schedule "${scheduleInput}". ` +
      'Use duration (5m/2h/1d) or cron expression (*/10 * * * *). Fix the parameters and call schedule again.',
    )
  }
}

/**
 * schedule tool handler（直建流：预校验 → abort 检查 → service.create）。
 *
 * 触发反转（设计 §6.1 D1）：不再有确认门，也不再有 headless 附注——模型路径无论会话模式
 * 一律直建；人侧表单入口在 `/schedule` 命令（interaction.ts 的 openScheduleFormAsync）。
 *
 * 业务失败 → throw（pi 只对 execute throw 置 isError:true——W4）；abort → cancelled result
 * （正常返回，不 throw）。service 未初始化等初始化异常不在此 catch——穿透到 index.ts execute
 * 的 catch 兜底。
 */
export async function handleSchedule(
  service: SchedulerService,
  params: ScheduleParamsT,
  signal: AbortSignal | undefined,
) {
  const { prompt, schedule: scheduleInput, kind, name, expires, model } = params

  // 预校验：参数非法是可自修复错误，先于任何副作用 throw。
  assertValidScheduleParams(prompt, scheduleInput)

  // abort 早退（交互已移除，只剩创建前一次检查）：signal 已中止 → 取消语义，不创建。
  if (signal?.aborted) {
    return cancelledCreateResult()
  }

  const result = await service.create(prompt, scheduleInput, { kind, name, expires, model })
  return toToolResult(result)
}

// ── schedule_control tool ──

export const ScheduleControlParams = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('toggle'), Type.Literal('delete'), Type.Literal('run')], {
    description:
      'Action to perform. run dispatches the task now: the message is sent immediately via steer (interrupting the current turn if the agent is busy).',
  }),
  id: Type.Optional(Type.String({ description: 'Task id. Required for toggle/delete/run.' })),
  enabled: Type.Optional(Type.Boolean({ description: 'Target enabled state. Required for toggle.' })),
})

export type ScheduleControlParamsT = Static<typeof ScheduleControlParams>

// D1 单源化：action 枚举与 run 的派发语义在 ScheduleControlParams.action 字段说明，
// guidelines 只留操作纪律（先 list 拿 id、暂停优先 toggle）。
export const controlGuidelines = [
  'After listing, use the returned id for toggle/delete/run.',
  'Prefer toggle(enabled=false) over delete for temporary pauses.',
]

export async function handleScheduleControl(service: SchedulerService, params: ScheduleControlParamsT) {
  const { action, id, enabled } = params

  let result: ServiceResult
  switch (action) {
    case 'list':
      result = service.list()
      break
    case 'toggle':
      result = await service.toggle(id, enabled)
      break
    case 'delete':
      result = service.delete(id)
      break
    case 'run':
      result = await service.run(id)
      break
    default:
      result = {
        success: false,
        message: `Unknown action: ${action}`,
      }
  }
  return toToolResult(result)
}

/**
 * ServiceResult → tool execute 返回。
 * 成功 → {content: [message], details: data}；失败 → throw（W4：pi 契约只有
 * execute throw 才置 isError:true，pi catch 后 message 原样成为 toolResult content，
 * 错误轮不再被标成功）。
 */
function toToolResult(result: ServiceResult): {
  content: { type: 'text'; text: string }[]
  details: unknown
} {
  if (!result.success) {
    throw new Error(result.message)
  }
  return {
    content: [{ type: 'text' as const, text: result.message }],
    details: result.data ?? {},
  }
}
