import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Static, Type } from 'typebox'
import {
  isScheduleFormResult,
  uiFormInteract,
  type ScheduleDraft,
  type ScheduleFormResult,
} from '@zhushanwen/extension-protocol'

import { getLogger } from '@zhushanwen/pi-extension-logger'

import { ScheduleCreateComponent, type ThemeLike } from './create-form-component.js'
import { parseSchedule } from './parsing.js'
import type { SchedulerService, ServiceResult } from './service.js'

const logger = getLogger('scheduler')

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

export const scheduleGuidelines = [
  'This tool creates a scheduled task. The call first opens a confirmation form pre-filled with your draft (time/model/prompt); the task is only created after the user reviews and confirms it.',
  'Only initiate this confirmation when the user asks to create a scheduled task. Do not use the confirmation dialog for trivial changes.',
  'The form\'s confirm button IS the user\'s confirmation: once confirmed, the task is created and active immediately — never disable a just-created task and never ask for another confirmation in chat, even if the user\'s message mentions "confirm" or "wait for me".',
  'If the user cancels the form, the task is NOT created. Do not assume a configuration and do not retry — wait for further instructions or explicit approval.',
  'Schedule accepts duration (5m, 2h, 1d) for interval-based or cron expression for time-based.',
  'Default kind is recurring. Set kind="once" for one-time reminders.',
  'model accepts a scoped model id (provider/model) the task runs with; omit it to follow the session\'s current model.',
  'After creation, the response includes task id and next run time(s).',
  'Default expiry is 7 days. Use expires="never" for long-term tasks.',
]

/** 用户取消确认表单时的 tool result 文案（D5：取消不是错误，正常返回不 throw） */
const CANCELLED_NOTICE =
  'Cancelled. The task was NOT created. Do not assume a configuration and do not retry — ' +
  'wait for further user instructions or explicit approval before creating it.'

/** headless 直通创建时附注在 result 末尾的文案（D4 分支 1） */
const UNCONFIRMED_NOTICE = '\n(Created without user confirmation: this session has no interactive channel.)'

/**
 * 禁用本会话 schedule 工具（§3.5 错误规格：RPC 交互通道不可用时调用，
 * 防 LLM 反复重试；先例 ask-user disableAskUser）。
 */
function disableScheduleTool(pi: ExtensionAPI): void {
  pi.setActiveTools(
    pi
      .getAllTools()
      .map((t: { name: string }) => t.name)
      .filter((n: string) => n !== 'schedule'),
  )
}

/** 结构化 model 引用（provider/id）：scopedModels 与 getAvailable() 两条来源的统一形态（P-SCOPED） */
function modelRef(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`
}

/**
 * Draft.models 组装单点（设计 §3.4 / P-SCOPED 探针结论）：ctx.scopedModels 优先
 * （pi /scoped-models 同集语义）；taiji builtin 装配下恒空（S12）→ 回退
 * modelRegistry.getAvailable()（已配 auth 的可用模型全集）。
 */
function collectModelIds(ctx: ExtensionContext): string[] {
  if (ctx.scopedModels.length > 0) {
    return ctx.scopedModels.map(s => modelRef(s.model))
  }
  return ctx.modelRegistry.getAvailable().map(m => modelRef(m))
}

/** 组装确认草稿（LLM 参数即预填值，原样透传；models/currentModel 由 ctx 注入） */
function buildDraft(params: ScheduleParamsT, ctx: ExtensionContext): ScheduleDraft {
  const { prompt, schedule, kind, name, expires, model } = params
  const currentModel = ctx.model ? modelRef(ctx.model) : undefined
  return {
    kind: kind ?? 'recurring',
    schedule,
    ...(model !== undefined && { model }),
    prompt,
    ...(name !== undefined && { name }),
    ...(expires !== undefined && { expires }),
    models: collectModelIds(ctx),
    ...(currentModel !== undefined && { currentModel }),
  }
}

/** 取消结果（D5）：正常返回 + cancelled details，不 throw（标错会诱导 LLM 重试） */
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
 * schedule 确认表单的问题标题（统一表单协议 D2：同时是 FormOverlay 单问表头文本
 * 与 FormAnswers 的 answers key——key = header ?? question，此处不用 header，
 * key 与文本同源避免双写漂移）。
 */
const SCHEDULE_FORM_QUESTION = 'Confirm scheduled task'

/** 形状错留痕里回包预览的截断长度（与 extension-protocol RESPONSE_PREVIEW_LENGTH 同规范） */
const RESPONSE_PREVIEW_LENGTH = 200

/** 回包形状非法（envelope 键缺失 / value 非 JSON / 非 ScheduleFormResult）→ throw
 * （§3.5 第二行：协议版本错配类故障，与 uiFormInteract 的 non-json 态同折叠同文案） */
function throwProtocolMismatch(): never {
  throw new Error(
    'schedule form response is not valid protocol JSON (extension/runtime protocol ' +
    'version mismatch). Do not retry — report this to the user.',
  )
}

/**
 * schedule tool handler（execute 流：预校验 → headless 分支 → abort 早退 → 交互 →
 * abort 兜底检查 → 取消 → 确认创建；设计 §5 U2 中 abort 检查先于交互）。
 *
 * 业务失败 → throw（pi 只对 execute throw 置 isError:true——W4）；用户取消不是错误，
 * 正常返回 cancelled result（D5）。service 未初始化等初始化异常不在此 catch——穿透到
 * index.ts execute 的 catch 兜底（R3）。
 *
 * @param pi     channel-error 时禁用本会话 schedule 工具（setActiveTools）
 * @param signal tool execute 的 abort signal；交互挂起期间 abort → cancelled 语义
 */
export async function handleSchedule(
  pi: ExtensionAPI,
  service: SchedulerService,
  params: ScheduleParamsT,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const { prompt, schedule: scheduleInput, kind, name, expires, model } = params

  // 步骤 1 预校验（§3.5）：prompt 空 / schedule 非法 → 不发起交互直接 throw
  //（错误可自修复：修正参数后重调 schedule）
  if (!prompt || prompt.trim() === '') {
    throw new Error('Invalid parameters: prompt must not be empty. Fix the parameters and call schedule again.')
  }
  if (!parseSchedule(scheduleInput)) {
    throw new Error(
      `Invalid parameters: unrecognized schedule "${scheduleInput}". ` +
      'Use duration (5m/2h/1d) or cron expression (*/10 * * * *). Fix the parameters and call schedule again.',
    )
  }

  // 步骤 2 headless 分支（D4）：mode 非 tui 非 rpc = 无交互通道 → 参数直接创建 +
  // 附注「未经确认」，不禁用工具（创建无确认也能用，脚本化场景不因确认门失效）
  if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') {
    const result = await service.create(prompt, scheduleInput, { kind, name, expires, model })
    const toolResult = toToolResult(result)
    toolResult.content[0]!.text += UNCONFIRMED_NOTICE
    return toolResult
  }

  // abort 早退（设计 §5 U2：abort 检查先于交互）：signal 已 aborted 时 TUI 分支的
  // addEventListener('abort') 永不触发（会挂出注定取消的表单）、rpc 分支会多发起一次
  // 注定取消的 select——直接走取消语义。交互后的 abort 兜底检查保留（覆盖交互挂起
  // 期间收到 abort 的路径）。
  if (signal?.aborted) {
    return cancelledCreateResult()
  }

  // 步骤 3 交互分支：TUI 挂 ScheduleCreateComponent（ctx.ui.custom）；
  // rpc 走 uiFormInteract（select + UI_FORM_MARKER 通道，ScheduleQuestion 单问整表单，
  // draft 经 initial 预填——统一表单协议 u6 迁移）
  const draft = buildDraft(params, ctx)
  let formResult: ScheduleFormResult | null | undefined
  if (ctx.mode === 'tui') {
    formResult = await ctx.ui.custom<ScheduleFormResult | null>((tui, theme, _kb, done) => {
      // theme as ThemeLike（ask-user runTuiInteraction 同款）：pi Theme.fg 参数是
      // ThemeColor 字面量联合，窄于 ThemeLike.fg(token: string)，结构上不可直接赋值；
      // 运行时组件仅调 theme.inverse（真实 Theme 在场），断言安全。
      const comp = new ScheduleCreateComponent(draft, tui, theme as ThemeLike, done)
      signal?.addEventListener('abort', () => comp.cancel(), { once: true })
      return comp
    })
  } else {
    // GuiContext 最小子集（ask-user runRpcInteraction 同款）：ExtensionContext.ui.custom
    // 的复杂泛型与 GuiContext 简化签名不兼容，直接传会类型冲突。
    const guiCtx = {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      ui: { select: ctx.ui.select.bind(ctx.ui) },
    }
    const interacted = await uiFormInteract(
      guiCtx,
      [{ type: 'schedule', question: SCHEDULE_FORM_QUESTION, initial: draft }],
      {
        signal,
        log: (msg, detail) => logger.warn(msg, detail),
      },
    )
    if (!interacted.ok) {
      if (interacted.reason === 'channel-error') {
        // §3.5 第一行：RPC 通道不可用 → 禁用本会话 schedule 工具 + throw
        //（echo 检测命中态附带升级指引 message，一并透出给用户）
        disableScheduleTool(pi)
        const echoHint = interacted.message ? `${interacted.message} ` : ''
        throw new Error(
          'schedule requires an interactive channel, which is unavailable. ' +
          `${echoHint}` +
          'The tool has been disabled for this session. Execute the immediate parts of the ' +
          'user\'s instructions directly — do not create scheduled tasks and do not retry.',
        )
      }
      if (interacted.reason === 'non-json') {
        // §3.5 第二行：回包形状非法 = 协议版本错配类故障
        throwProtocolMismatch()
      }
      // cancelled | timeout → 取消路径（D5）。rpc 模式 GUI 用户取消 resolve undefined，
      // 与超时不可区分（signal 未 abort 折叠 timeout），语义同为「未确认」。
      return cancelledCreateResult()
    }
    // FormAnswers envelope 解包（D2 回包契约）：schedule 单问表单恰一键，value =
    // flat ScheduleFormResult JSON（FormOverlay schedule 渲染器提交形态）。回包判别
    // 职责在本包（D3：isScheduleFormResult 从 scheduler-create 模块导出复用）。
    const rawResult: unknown = interacted.answers[SCHEDULE_FORM_QUESTION]
    if (typeof rawResult !== 'string') throwProtocolMismatch()
    let parsed: unknown
    try {
      parsed = JSON.parse(rawResult)
    } catch {
      throwProtocolMismatch()
    }
    if (!isScheduleFormResult(parsed)) {
      logger.warn('schedule form answer value is not a ScheduleFormResult', {
        key: SCHEDULE_FORM_QUESTION,
        valueHead: rawResult.slice(0, RESPONSE_PREVIEW_LENGTH),
      })
      throwProtocolMismatch()
    }
    formResult = parsed
  }

  // 步骤 4 abort 检查：agent 被外部终止（goal 取消 / session 切换）→ cancelled 语义
  //（同取消路径：非错误正常返回；TUI 分支 abort 已由 comp.cancel() 归 null）
  if (signal?.aborted) {
    return cancelledCreateResult()
  }

  // 步骤 5 取消路径（D5）：TUI 用户取消 null / abort undefined → cancelled result
  if (formResult == null) {
    return cancelledCreateResult()
  }

  // 步骤 6 确认创建：以用户裁定的最终值创建任务（用户可改 kind/schedule/model/prompt）
  const result = await service.create(formResult.prompt, formResult.schedule, {
    kind: formResult.kind,
    name: formResult.name,
    expires: formResult.expires,
    model: formResult.model,
  })
  return toToolResult(result)
}

// ── schedule_control tool ──

export const ScheduleControlParams = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('toggle'), Type.Literal('delete'), Type.Literal('run')], { description: 'Action to perform.' }),
  id: Type.Optional(Type.String({ description: 'Task id. Required for toggle/delete/run.' })),
  enabled: Type.Optional(Type.Boolean({ description: 'Target enabled state. Required for toggle.' })),
})

export type ScheduleControlParamsT = Static<typeof ScheduleControlParams>

export const controlGuidelines = [
  'Use action="list" to see all scheduled tasks.',
  'After listing, use the returned id for toggle/delete/run.',
  'Prefer toggle(enabled=false) over delete for temporary pauses.',
  'action="run" dispatches the task now: the message is sent immediately via steer (interrupting the current turn if the agent is busy).',
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
