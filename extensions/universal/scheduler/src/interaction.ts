import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  isScheduleFormResult,
  uiFormInteract,
  type ScheduleDraft,
  type ScheduleFormResult,
  type ScheduleKind,
} from '@zhushanwen/extension-protocol'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import { ScheduleCreateComponent, type ThemeLike } from './create-form-component.js'
import { readUiLocale, renderResult, renderResultText } from './i18n.js'
import type { SchedulerService } from './service.js'

const logger = getLogger('scheduler')

// ── 命令路径挂起窗口的 AbortController 注册表（模块级）──
//
// pi 的 `ExtensionContext.signal` 在命令 idle 时恒 undefined（不可复用），命令路径的表单
// 挂起窗口必须自持 AbortController；`session_shutdown`（reason ∈ quit/reload/new/resume/fork）
// 时由 index.ts 调 abortPendingScheduleForms() 统一 abort → 交互以取消收尾（不创建、不 toast）。
// 模块级而非 factory 闭包级：registry 需跨 factory 重跑可见（pi 每次 session 替换重跑 factory）。
const pendingFormControllers = new Set<AbortController>()

/** 中止全部挂起中的命令路径表单（index.ts 的 session_shutdown 接线点）。 */
export function abortPendingScheduleForms(): void {
  for (const controller of pendingFormControllers) controller.abort()
  pendingFormControllers.clear()
}

// ── 文案（L2 词典通道，u-p2b 接线）──
// 表单通道错误（channel-error / non-json 协议错配）不再持英文常量：错误对象携带
// `messageKey`，命令路径 catch 经 `renderResult(messageKey, {}, locale)` 单入口渲染
// （r4 S3 载体裁决；本文件不再有用户可见英文串）。

/** L2 词典错误：携带 messageKey，命令路径 catch 经 `renderResult` 渲染。 */
abstract class LocalizedFormError extends Error {
  abstract readonly messageKey: 'form.channelUnavailable' | 'form.protocolMismatch'
}

/** channel-error 异常（命令路径据此设定「本会话通道不可用」并提示；非工具禁用）。 */
class FormChannelUnavailableError extends LocalizedFormError {
  readonly messageKey = 'form.channelUnavailable' as const
}

/** non-json / 回包形状非法（协议版本错配）。 */
class ProtocolMismatchError extends LocalizedFormError {
  readonly messageKey = 'form.protocolMismatch' as const
}

/** 命令路径 catch 分流：错误携带词典 key 则本地化渲染，否则回落 toErrorMessage。 */
function isLocalizedFormError(err: unknown): err is LocalizedFormError {
  return err instanceof LocalizedFormError
}

// ── 草稿构造 ──

/** 命令路径/工具路径共用的表单预填种子（models/currentModel 由 ctx 注入）。 */
export interface ScheduleDraftSeed {
  schedule: string
  prompt: string
  kind?: ScheduleKind
  name?: string
  expires?: string
  model?: string
}

/** 命令路径通道状态（注册闭包持有 = 本会话粒度）。 */
export interface ScheduleFormChannelState {
  /**
   * 本会话已检测到表单通道不可用（channel-error）→ 后续 `/schedule` 直接给提示、
   * 不重复试探（设计 §6.1 步骤 8「本会话后续直接给提示」）。
   */
  unavailable: boolean
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
export function collectModelIds(ctx: ExtensionContext): string[] {
  if (ctx.scopedModels.length > 0) {
    return ctx.scopedModels.map(s => modelRef(s.model))
  }
  return ctx.modelRegistry.getAvailable().map(m => modelRef(m))
}

/** 组装表单预填草稿（seed = 工具参数或命令参数；models/currentModel 由 ctx 注入）。
 *  kind 缺省回落单次（默认单次裁决 2026-09-21）。 */
export function buildDraft(seed: ScheduleDraftSeed, ctx: ExtensionContext): ScheduleDraft {
  const currentModel = ctx.model ? modelRef(ctx.model) : undefined
  return {
    kind: seed.kind ?? 'once',
    schedule: seed.schedule,
    ...(seed.model !== undefined && { model: seed.model }),
    prompt: seed.prompt,
    ...(seed.name !== undefined && { name: seed.name }),
    ...(seed.expires !== undefined && { expires: seed.expires }),
    models: collectModelIds(ctx),
    ...(currentModel !== undefined && { currentModel }),
  }
}

// ── 交互形态（tui / rpc）──

/** TUI 交互分支：挂 ScheduleCreateComponent（ctx.ui.custom）；
 * abort → comp.cancel()（once 监听，挂起期间收到 abort 归 null）。 */
async function interactScheduleFormTui(
  ctx: ExtensionContext,
  draft: ScheduleDraft,
  signal: AbortSignal | undefined,
): Promise<ScheduleFormResult | null | undefined> {
  return ctx.ui.custom<ScheduleFormResult | null>((tui, theme, _kb, done) => {
    // theme as ThemeLike（ask-user runTuiInteraction 同款）：pi Theme.fg 参数是
    // ThemeColor 字面量联合，窄于 ThemeLike.fg(token: string)，结构上不可直接赋值；
    // 运行时组件仅调 theme.inverse（真实 Theme 在场），断言安全。
    const comp = new ScheduleCreateComponent(draft, tui, theme as ThemeLike, done)
    signal?.addEventListener('abort', () => comp.cancel(), { once: true })
    return comp
  })
}

/**
 * RPC 交互分支：uiFormInteract（select + UI_FORM_MARKER 通道，ScheduleQuestion
 * 单问整表单，draft 经 initial 预填——统一表单协议 u6 迁移）+ FormAnswers envelope 解包。
 * cancelled | timeout → 返回 null（调用方统一走取消语义）。
 * channel-error → 抛 FormChannelUnavailableError（调用方设会话状态 + 提示）；
 * non-json / 回包形状非法 → 抛协议错配（throwProtocolMismatch）。
 */
async function interactScheduleFormRpc(
  ctx: ExtensionContext,
  draft: ScheduleDraft,
  signal: AbortSignal | undefined,
): Promise<ScheduleFormResult | null | undefined> {
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
      // expectTurn:false——command handler 内 select（rpc `void run()`）提交后无 turn 跟随，respond 即收尾（D1 段 2）
      expectTurn: false,
      log: (msg, detail) => logger.warn(msg, detail),
    },
  )
  if (!interacted.ok) {
    if (interacted.reason === 'channel-error') {
      // 通道契约破坏：命令路径无工具可禁用 → 设会话状态 + 抛错（调用方提示升级/走 agent）。
      // echo 命中态的升级指引（协议层英文）不再拼接：词典 `form.channelUnavailable` 已含
      // 「宿主版本过旧」语义，避免中文界面中英混排（设计 §7.5）。
      throw new FormChannelUnavailableError()
    }
    if (interacted.reason === 'non-json') {
      throwProtocolMismatch()
    }
    // cancelled | timeout：rpc 模式 GUI 用户取消 resolve undefined，与超时不可区分
    //（signal 未 abort 折叠 timeout），语义同为「未确认」→ null。
    return null
  }
  // FormAnswers envelope 解包（D2 回包契约）：schedule 单问表单恰一键，value =
  // flat ScheduleFormResult JSON（FormOverlay schedule 渲染器提交形态）。回包判别
  // 职责在本包（D3：isScheduleFormResult 从 scheduler-create 模块导出复用）。
  return parseScheduleFormAnswerValue(interacted.answers[SCHEDULE_FORM_QUESTION])
}

/** 交互分发：tui → ScheduleCreateComponent；其余（rpc）→ uiFormInteract。 */
async function interactScheduleForm(
  ctx: ExtensionContext,
  draft: ScheduleDraft,
  signal: AbortSignal | undefined,
): Promise<ScheduleFormResult | null | undefined> {
  return ctx.mode === 'tui'
    ? interactScheduleFormTui(ctx, draft, signal)
    : interactScheduleFormRpc(ctx, draft, signal)
}

// ── 协议错配 / 答案解析 ──

/**
 * schedule 表单的问题标题（统一表单协议 D2：同时是 FormOverlay 单问表头文本
 * 与 FormAnswers 的 answers key——key = header ?? question，此处不用 header，
 * key 与文本同源避免双写漂移）。
 */
const SCHEDULE_FORM_QUESTION = 'Confirm scheduled task'

/** 形状错留痕里回包预览的截断长度（与 extension-protocol RESPONSE_PREVIEW_LENGTH 同规范） */
const RESPONSE_PREVIEW_LENGTH = 200

/** 回包形状非法（envelope 键缺失 / value 非 JSON / 非 ScheduleFormResult）→ throw
 *（与 uiFormInteract 的 non-json 态同折叠，词典 `form.protocolMismatch` 渲染）。 */
function throwProtocolMismatch(): never {
  throw new ProtocolMismatchError()
}

/** 回包 value（FormAnswers 单键的 JSON 字符串）→ ScheduleFormResult；形状非法 → throw
 *（与 uiFormInteract 的 non-json 态同折叠同文案）。 */
function parseScheduleFormAnswerValue(rawResult: unknown): ScheduleFormResult {
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
  return parsed
}

// ── 命令路径入口（异步打开）──

/**
 * 命令路径表单入口：打开创建表单，提交后经 service.create 落库。
 *
 * **契约：返回的 Promise 永不 reject**（内部错误自 catch → `ctx.ui.notify(..., 'error')`；
 * 挂起期间 `session_shutdown` abort → 取消收尾）。因此调用点的 `void openScheduleFormAsync(...)`
 * 不构成漏口。
 *
 * 时序（设计 §6.2）：`rpc` 模式 **异步打开**——handler 不 await 表单，立即返回（规避 prompt
 * RPC 的 60s 回包窗口）；`tui` 模式就地渲染，无 RPC 回包窗口，可 await。
 */
export async function openScheduleFormAsync(
  ctx: ExtensionCommandContext,
  service: SchedulerService,
  seed: ScheduleDraftSeed,
  channelState: ScheduleFormChannelState,
): Promise<void> {
  // channel-error 后本会话不再重复试探（直接给同一提示）。
  if (channelState.unavailable) {
    ctx.ui.notify(renderResult('form.channelUnavailable', {}, readUiLocale()), 'error')
    return
  }

  const controller = new AbortController()
  pendingFormControllers.add(controller)

  const run = async (): Promise<void> => {
    try {
      const draft = buildDraft(seed, ctx)
      const formResult = await interactScheduleForm(ctx, draft, controller.signal)
      // 取消 / abort（session_shutdown 或用户取消）→ 不创建、不 toast（取消不是错误）。
      if (controller.signal.aborted || formResult == null) return
      const result = await service.create(formResult.prompt, formResult.schedule, {
        kind: formResult.kind,
        name: formResult.name,
        expires: formResult.expires,
        model: formResult.model,
      })
      ctx.ui.notify(renderResultText(result, readUiLocale()), result.success ? 'info' : 'error')
    } catch (err) {
      if (err instanceof FormChannelUnavailableError) channelState.unavailable = true
      // rpc/tui 模式用户可见通道只有 ctx.ui.notify（throw 在 rpc 下被静默丢弃）。
      ctx.ui.notify(
        isLocalizedFormError(err)
          ? renderResult(err.messageKey, {}, readUiLocale())
          : toErrorMessage(err),
        'error',
      )
    } finally {
      pendingFormControllers.delete(controller)
    }
  }

  if (ctx.mode === 'tui') {
    await run()
  } else {
    void run()
  }
}
