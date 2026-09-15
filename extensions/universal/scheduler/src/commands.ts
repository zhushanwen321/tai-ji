import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import { formatSchedule } from './format.js'
import type { SchedulerService } from './service.js'

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

/**
 * 注册 /schedule command。
 * 消歧规则：第一个参数匹配子命令关键词则走对应分支，否则尝试 parseSchedule 创建任务。
 *
 * service 通过 getter 获取：registerScheduleCommand 在 factory 顶层调用，此时 session_start
 * 尚未触发、service 还是 null。getArgumentCompletions / handler 真正执行时才读 service 当前值。
 */
export function registerScheduleCommand(
  pi: ExtensionAPI,
  getService: () => SchedulerService | null,
) {
  pi.registerCommand('schedule', {
    description: 'Manage scheduled tasks. /schedule <schedule> <prompt> to create; /schedule list to see tasks.',
    getArgumentCompletions(prefix: string) {
      const service = getService()
      const trimmed = prefix.trimStart()
      const parts = trimmed.split(/\s+/).filter(Boolean)
      if (parts.length <= 1) {
        return [
          { label: 'list', value: 'list', description: 'Show all scheduled tasks' },
          { label: 'on', value: 'on ', description: 'Enable a task' },
          { label: 'off', value: 'off ', description: 'Disable a task' },
          { label: 'rm', value: 'rm ', description: 'Delete a task' },
          { label: 'run', value: 'run ', description: 'Run a task now' },
          { label: 'once', value: 'once ', description: 'Create a one-time reminder' },
          { label: 'cron', value: "cron '", description: 'Create a cron-based task' },
        ].filter(opt => opt.label.startsWith(trimmed.toLowerCase()))
      }
      // on/off/rm/run 后补全任务 id
      if (['on', 'off', 'rm', 'run'].includes(parts[0]!) && service) {
        const result = service.list()
        if (result.success && result.data) {
          return result.data.tasks.map(t => ({
            label: t.id,
            value: t.id,
            description: `${t.name} · ${formatSchedule(t.schedule, t.kind)}`
          }))
        }
      }
      return null
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const result = await executeScheduleCommand(getService(), args)
      ctx.ui.notify(result, 'info')
    },
  })
}

/** 单个子命令处理器。service 非空由 executeScheduleCommand 前置保证；parts 为 tokenize 后参数。 */
type SubcommandHandler = (service: SchedulerService, parts: string[]) => string | Promise<string>

/**
 * on/off 共享：取 <id>，缺失返回 usage（文案与原 ${first} 一致——handler 仅在
 * first === 'on' | 'off' 时被查表命中，keyword 即 first 的小写值）。
 */
async function handleToggleKeyword(
  service: SchedulerService,
  parts: string[],
  keyword: 'on' | 'off',
): Promise<string> {
  const id = parts[1]
  if (!id) return `Usage: /schedule ${keyword} <id>`
  const result = await service.toggle(id, keyword === 'on')
  return result.message
}

/**
 * 子命令路由表。查表未命中（落空）= 创建任务分支，与原 if 链的顺序语义一致。
 * list/rm 保持同步返回、run 保持 await——不改变 async 边界内的微任务时序。
 * 用 Map 而非普通对象：first 是外部输入（/schedule 命令参数），普通对象查表会命中
 * Object.prototype 上的键（如 "constructor"/"__proto__"），导致错误路由；Map 只查自身键。
 */
const SUBCOMMAND_HANDLERS: ReadonlyMap<string, SubcommandHandler> = new Map<string, SubcommandHandler>([
  ['list', service => service.list().message],
  ['on', (service, parts) => handleToggleKeyword(service, parts, 'on')],
  ['off', (service, parts) => handleToggleKeyword(service, parts, 'off')],
  [
    'rm',
    (service, parts) => {
      const id = parts[1]
      if (!id) return 'Usage: /schedule rm <id>'
      return service.delete(id).message
    },
  ],
  [
    'run',
    async (service, parts) => {
      const id = parts[1]
      if (!id) return 'Usage: /schedule run <id>'
      const result = await service.run(id)
      return result.message
    },
  ],
])

/** 创建任务分支（路由落空）：once 前缀 → once 任务；cron 前缀 → recurring cron 任务；其余按 interval schedule 解析。 */
async function createTaskFromArgs(
  service: SchedulerService,
  parts: string[],
  first: string,
): Promise<string> {
  const kind = first === 'once' ? 'once' as const : first === 'cron' ? 'recurring' as const : undefined
  const scheduleStart = kind ? 1 : 0
  const scheduleInput = parts[scheduleStart]
  if (!scheduleInput) return 'Usage: /schedule <schedule> <prompt>'

  const prompt = parts.slice(scheduleStart + 1).join(' ')
  if (!prompt) return 'Usage: /schedule <schedule> <prompt>'

  const result = await service.create(prompt, scheduleInput, { kind })
  return result.message
}

/**
 * Core logic for /schedule command. Extracted for testability (handler returns
 * void per SDK contract; tests call this function directly to assert output).
 *
 * 命令层只保留参数路由与 usage 文案（C6），业务调用全部走 SchedulerService。
 * 主函数只留编排：service 守卫 → 空 args → tokenize → 查表分发 → 创建分支。
 */
export async function executeScheduleCommand(
  service: SchedulerService | null,
  args: string,
): Promise<string> {
  if (!service) return 'Scheduler not initialized: session not started.'

  const trimmed = args.trim()
  if (!trimmed) {
    // TODO: 打开 TUI 管理器（W5 实现）
    return 'TUI manager not yet implemented. Use /schedule list to see tasks.'
  }

  const parts = tokenizeQuoted(trimmed)
  const first = parts[0]!.toLowerCase()

  // 子命令路由：查表命中走对应分支，落空走创建任务分支
  const handler = SUBCOMMAND_HANDLERS.get(first)
  if (handler) return handler(service, parts)

  return createTaskFromArgs(service, parts, first)
}
