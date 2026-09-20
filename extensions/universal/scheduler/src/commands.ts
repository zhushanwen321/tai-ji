import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'

import { formatSchedule } from './format.js'
import {
  openScheduleFormAsync,
  type ScheduleDraftSeed,
  type ScheduleFormChannelState,
} from './interaction.js'
import type { SchedulerService, ServiceResult } from './service.js'

/**
 * Shell-style quote-aware tokenizer.
 * Supports single/double quoted tokens (e.g. cron expressions with spaces).
 * Quoted content is kept as a single token; quote chars are stripped from output.
 */
function tokenizeQuoted(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

// ── 文案占位（待 u-p2a 词典接线）──
// 本单元（u-sched-core）不建 i18n.ts（归 u-p2a，同波次并行），命令层自有串先以英文常量
// 占位；u-p2a 词典落地后由 u-p2b 经 renderResult(messageKey, params, locale) 单入口接线。
// `/scheduler` 的 registerCommand.description 是注册期静态串（切语言不热更 = 已接受滞后）。

/** `/scheduler` 命令描述（GUI slash 浮层渲染；注册期静态）。 */
const SCHEDULER_COMMAND_DESCRIPTION =
  'Manage scheduled tasks. /scheduler opens the create form; /scheduler list shows tasks.'

/** 非交互模式（json / print）无参 / 缺 prompt 的 throw 文案。 */
const NO_INTERACTIVE_CHANNEL_MESSAGE =
  'No interactive channel in this mode: pass a schedule and a prompt, ' +
  'e.g. /scheduler 5m "check build", or create the task through the agent.'

/** service 未初始化（session 未 start）的文案。 */
const SCHEDULER_NOT_INITIALIZED_MESSAGE = 'Scheduler not initialized: session not started.'

/** 无参 `/scheduler`（打开表单路径）的默认预填时间：循环 + 每天 09:00。 */
const DEFAULT_CREATE_SCHEDULE = '0 9 * * *'

/** 子命令 handler：统一返回 ServiceResult（notify severity 按 success 分流）。 */
type SubcommandHandler = (service: SchedulerService, parts: string[]) => ServiceResult | Promise<ServiceResult>

/** 用法错误（缺 id）的失败结果。 */
function usage(message: string): ServiceResult {
  return { success: false, message }
}

/**
 * on/off 共享：取 <id>，缺失返回 usage（文案与原 `${first}` 一致——handler 仅在
 * first === 'on' | 'off' 时被查表命中，keyword 即 first 的小写值）。
 */
async function handleToggleKeyword(
  service: SchedulerService,
  parts: string[],
  keyword: 'on' | 'off',
): Promise<ServiceResult> {
  const id = parts[1]
  if (!id) return usage(`Usage: /scheduler ${keyword} <id>`)
  return service.toggle(id, keyword === 'on')
}

/**
 * 子命令路由表（list/on/off/rm/run 保持子命令语义——同步返回，无人工交互）。
 * 查表未命中 = 创建分支（打开表单 / 非交互模式直建）。
 * 用 Map 而非普通对象：first 是外部输入，普通对象查表会命中 Object.prototype 上的键
 *（如 "constructor"/"__proto__"），导致错误路由；Map 只查自身键。
 */
const SUBCOMMAND_HANDLERS: ReadonlyMap<string, SubcommandHandler> = new Map<string, SubcommandHandler>([
  ['list', service => service.list()],
  ['on', (service, parts) => handleToggleKeyword(service, parts, 'on')],
  ['off', (service, parts) => handleToggleKeyword(service, parts, 'off')],
  [
    'rm',
    (service, parts) => {
      const id = parts[1]
      if (!id) return usage('Usage: /scheduler rm <id>')
      return service.delete(id)
    },
  ],
  [
    'run',
    async (service, parts) => {
      const id = parts[1]
      if (!id) return usage('Usage: /scheduler run <id>')
      return service.run(id)
    },
  ],
])

/** 子命令结果 → toast（severity 按 success 分 'error' / 'info'）。 */
function notifyResult(ctx: ExtensionCommandContext, result: ServiceResult): void {
  ctx.ui.notify(result.message, result.success ? 'info' : 'error')
}

/**
 * 创建分支：rpc / tui → 异步打开（预填）表单；json / print → 带参直建。
 *
 * json / print 下 `ctx.ui.notify` 是 no-op、handler 返回值被丢弃——失败只能走 throw
 *（stderr 是唯一可见通道）；无参 / 缺 prompt 同样 throw（无表单可开）。
 */
async function openFormOrDirectCreate(
  service: SchedulerService,
  ctx: ExtensionCommandContext,
  channelState: ScheduleFormChannelState,
  seed: ScheduleDraftSeed,
): Promise<void> {
  if (ctx.mode === 'json' || ctx.mode === 'print') {
    if (seed.prompt.trim() === '') throw new Error(NO_INTERACTIVE_CHANNEL_MESSAGE)
    const result = await service.create(seed.prompt, seed.schedule, { kind: seed.kind })
    if (!result.success) throw new Error(result.message)
    return
  }
  // rpc：异步打开（handler 不 await，规避 60s prompt RPC 窗口）；tui：就地渲染（可 await）。
  await openScheduleFormAsync(ctx, service, seed, channelState)
}

/**
 * Core logic for the `/scheduler` command. Extracted for testability (handler returns
 * void per SDK contract; tests call this function directly with a mock ctx to assert
 * form-open / direct-create / throw behavior).
 *
 * 消歧规则：第一个参数匹配子命令关键词则走对应子命令，否则按 `<schedule> <prompt>`
 * 打开（预填）表单；无参数 → 打开空草稿表单（非交互模式下 throw）。
 */
export async function executeScheduleCommand(
  service: SchedulerService,
  args: string,
  ctx: ExtensionCommandContext,
  channelState: ScheduleFormChannelState,
): Promise<void> {
  const trimmed = args.trim()
  if (!trimmed) {
    await openFormOrDirectCreate(service, ctx, channelState, {
      kind: 'recurring',
      schedule: DEFAULT_CREATE_SCHEDULE,
      prompt: '',
    })
    return
  }

  const parts = tokenizeQuoted(trimmed)
  const first = parts[0]!.toLowerCase()

  const handler = SUBCOMMAND_HANDLERS.get(first)
  if (handler) {
    notifyResult(ctx, await handler(service, parts))
    return
  }

  // 创建分支：非子命令关键词 → 首 token 为 schedule，其余为 prompt（含空格需引号）。
  await openFormOrDirectCreate(service, ctx, channelState, {
    kind: 'recurring',
    schedule: parts[0]!,
    prompt: parts.slice(1).join(' '),
  })
}

/**
 * 注册 `/scheduler` 命令（`/schedule` 保留为代码级 alias，同一 handler / 补全）。
 *
 * service 通过 getter 获取：registerScheduleCommand 在 factory 顶层调用，此时 session_start
 * 尚未触发、service 还是 null。getArgumentCompletions / handler 真正执行时才读 service 当前值。
 *
 * handler 整体 try/catch 按 mode 分流（设计 §6.2 错误通道矩阵）：rpc / tui 的用户可见通道
 * 只有 `ctx.ui.notify`（pi 把 handler 异常转 `extension_error`，renderer 白名单不含它 → 静默
 * 丢弃）；json / print 必须原样 rethrow（notify 是 no-op，stderr 是唯一可见通道）。
 */
export function registerScheduleCommand(
  pi: ExtensionAPI,
  getService: () => SchedulerService | null,
) {
  // channelState 注册闭包持有 = 本会话粒度（factory 重跑即复位）。
  const channelState: ScheduleFormChannelState = { unavailable: false }

  const commandOptions = {
    description: SCHEDULER_COMMAND_DESCRIPTION,
    getArgumentCompletions(prefix: string) {
      const service = getService()
      const trimmed = prefix.trimStart()
      const parts = trimmed.split(/\s+/).filter(Boolean)
      if (parts.length <= 1) {
        // 子命令补全（once/cron 直建补全已随触发反转退役：创建统一走 /scheduler <spec> <prompt> 打开表单）
        return [
          { label: 'list', value: 'list', description: 'Show all scheduled tasks' },
          { label: 'on', value: 'on ', description: 'Enable a task' },
          { label: 'off', value: 'off ', description: 'Disable a task' },
          { label: 'rm', value: 'rm ', description: 'Delete a task' },
          { label: 'run', value: 'run ', description: 'Run a task now' },
        ].filter(opt => opt.label.startsWith(trimmed.toLowerCase()))
      }
      // on/off/rm/run 后补全任务 id（description 的 formatSchedule 当前 locale 接线待 u-p2a——第三调用点）
      if (['on', 'off', 'rm', 'run'].includes(parts[0]!) && service) {
        const result = service.list()
        if (result.success && result.data) {
          return result.data.tasks.map(t => ({
            label: t.id,
            value: t.id,
            description: `${t.name} · ${formatSchedule(t.schedule, t.kind)}`,
          }))
        }
      }
      return null
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const service = getService()
        if (!service) throw new Error(SCHEDULER_NOT_INITIALIZED_MESSAGE)
        await executeScheduleCommand(service, args, ctx, channelState)
      } catch (err) {
        // json / print：notify 为 no-op，throw 是唯一可见通道 → 原样 rethrow（不被 catch 吞）。
        if (ctx.mode === 'json' || ctx.mode === 'print') throw err
        ctx.ui.notify(toErrorMessage(err), 'error')
      }
    },
  }

  pi.registerCommand('scheduler', commandOptions)
  // /schedule 保留为 alias（同一 handler / 补全），供已发布的 npm 使用者平滑迁移。
  pi.registerCommand('schedule', commandOptions)
}
