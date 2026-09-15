/**
 * command-registry.ts —— CommandRegistry（IF6）。
 *
 * 统一命令表：命令面板 + 快捷键 + slash + 菜单按钮的唯一来源（D1）。
 * command 型 contribution 经 registerFromContribution 归一（来自 ContributionRegistry，
 * W1 parseContributes 已解析进 ContributionRecord.command）；api.commands.register
 * （s3 落地）走 registerCommand(CommandRecord)。execute 触发
 * ActivationManager.ensureActivated(pluginId, 'onCommand') + 调注入的 CommandExecutor。
 *
 * 契约（IF6）：
 * - registerCommand 幂等：同 id 重复注册覆盖不翻倍
 * - registerFromContribution：command 型 contribution 转 CommandRecord 注册（id←contributionId），
 *   非 command 型 ignore；slashCommand 型 D1 归一（contributes.slashCommands 唯一声明源进表）归
 *   s3 api.commands.register 落地 + s5（W3 只建表结构，clarify Q4）
 * - execute 未找到命令：emit {kind:'error', source:'CommandRegistry', message:'command not found: <id>'}
 *   （ERR6 出声机制）+ resolve 不 throw——Promise<void> 下 ERR6 的「resolve(false)」退化，消费端
 *   据 error 事件显示禁用态/toast（clarify Q2）；激活/执行失败 reject 上抛（不静默）
 * - 先激活后执行：runtime executeCommand 要求 worker 已存在（TC6 论据），
 *   ensureActivated(pluginId, 'onCommand') 幂等（未声明激活事件 no-op）
 */
import type { InternalEventBus } from './internal-event-bus'
import type { ActivationManager } from './activation-manager'
import type { ContributionRecord } from './types'

/** 裸命令名归一：剥前导 /（声明 id 与 pi 真源 name 统一索引键）。 */
function stripSlashPrefix(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name
}

/** 统一命令记录（命令面板/快捷键/slash/菜单按钮同表条目）。 */
export interface CommandRecord {
  id: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  pluginId: string
  /** 命令处理器引用——api.commands.register 落地（s3）后填充；声明型 contribution 无 handler（执行归 executor/RPC）。 */
  handlerRef?: string
  /**
   * 命令型态：'command'（plugin.commands contribution / api.commands.register）vs
   * 'slashCommand'（contributes.slashCommands 声明）。缺省 'command'（向后兼容既有构造）。
   * slashCommand 型仅供声明查询（resolveSlashCommands 合并源），执行仍走 pi composer（声明与执行分离）。
   */
  type?: 'command' | 'slashCommand'
  /** slashCommand 声明描述（schema v2 仅 {name, description}）。resolveSlashCommands 合并时元数据取声明。 */
  description?: string
}

/** resolveSlashCommands 的 pi 真源输入项（SessionCommand 兼容子集：id/kind/icon 可选）。 */
export interface SlashCommandLike {
  id?: string
  name: string
  description?: string
  kind?: string
  icon?: string
}

/** resolveSlashCommands 的合并结果项（registry 声明 ∪ pi 真源）。 */
export interface ResolvedSlashCommand {
  id: string
  /** 裸命令名（无前导 /，与 pi 真源格式一致；消费端按需补 / 归一化）。 */
  name: string
  description?: string
  kind: string
  /** 声明侧无 icon（schema v2 无 icon 字段）——缺省时消费端用 iconKeyForCommand 兜底推断。 */
  icon?: string
  /** 来源标记：registry 声明 / pi 真源 / 双源（同名去重后）。 */
  source: 'registry' | 'pi' | 'both'
}

/** 命令执行注入接口：壳适配 runtime 的 commands.execute RPC（s3 新增）。 */
export interface CommandExecutor {
  execute(id: string, args?: unknown): Promise<void>
}

export interface CommandRegistryDeps {
  bus: InternalEventBus
  activationManager: ActivationManager
  executor: CommandExecutor
}

export class CommandRegistry {
  private commands = new Map<string, CommandRecord>()

  constructor(private deps: CommandRegistryDeps) {}

  /** 注册命令（api.commands.register 入口，s3）。幂等：同 id 覆盖不翻倍。 */
  registerCommand(cmd: CommandRecord): void {
    this.commands.set(cmd.id, cmd)
  }

  /**
   * command + slashCommand 型 contribution 归一入口（来自 ContributionRegistry.getContributions）。
   * - command 型：id←contributionId（= command id）、title/category/keybinding/when←c.command.*、
   *   pluginId←c.pluginId、handlerRef←undefined（声明型无 handler）
   * - slashCommand 型（W3 收编补全，不再 ignore）：id←contributionId（= 命令名）、title←c.slashCommand.name、
   *   description←c.slashCommand.description、type='slashCommand'——声明侧元数据源（resolveSlashCommands 消费），
   *   执行仍走 pi composer（声明与执行分离，s5 clarify Q3 已裁决）
   * 其余型 ignore。
   */
  registerFromContribution(c: ContributionRecord): void {
    if (c.type === 'slashCommand' && c.slashCommand) {
      this.registerCommand({
        id: c.contributionId,
        title: c.slashCommand.name,
        description: c.slashCommand.description,
        pluginId: c.pluginId,
        type: 'slashCommand',
      })
      return
    }
    if (c.type !== 'command' || !c.command) return
    this.registerCommand({
      id: c.contributionId,
      title: c.command.title,
      category: c.command.category,
      keybinding: c.command.keybinding,
      when: c.command.when,
      pluginId: c.pluginId,
    })
  }

  /** 卸载命令（contribution 移除 / plugin 卸载时）。不存在 id：no-op。 */
  unregisterCommand(id: string): void {
    this.commands.delete(id)
  }

  get(id: string): CommandRecord | undefined {
    return this.commands.get(id)
  }

  /** 全量命令（命令面板/快捷键/slash/菜单按钮唯一来源）。 */
  list(): CommandRecord[] {
    return Array.from(this.commands.values())
  }

  /**
   * slash 命令合并源（W3 收编，D1 归一终态）：registry 声明 ∪ pi 真源。
   *
   * 合并规则（03-slash-command-unify.md §3.2 D3-1/D3-2）：
   * - 同名去重：两源都有 → 1 项，description 元数据取声明（schema v2 声明是 description 唯一来源）
   * - 存在性交叉校验：pi 真源非空（有 session 真源可对照）→ 仅声明侧存在（pi 无）隐藏，避免死命令；
   *   pi 真源为空（landing 态无 session）→ 交叉校验不生效，声明即显示（slice TC2 裁决）
   * - pi 独有项保留（真源为存在性/执行依据）；输出顺序：声明在前（builtin 确定性），pi 独有在后
   * - 执行永远走 pi（本函数只做展示层合并，不触发执行）
   *
   * 纯函数语义：headless 可测（零 Vue/WS 依赖），输入 pi 真源清单（SessionCommand 兼容子集）。
   */
  resolveSlashCommands(piCommands: SlashCommandLike[]): ResolvedSlashCommand[] {
    // 声明集：slash 型记录按裸名索引（声明 id 无前导 /，防御性再剥一层）
    const declared = new Map<string, CommandRecord>()
    for (const cmd of this.commands.values()) {
      if (cmd.type !== 'slashCommand') continue
      declared.set(stripSlashPrefix(cmd.id), cmd)
    }
    // pi 真源按裸名索引（pi get_commands 返回无前缀 'goal'，防御带 / 前缀）
    const pi = new Map<string, SlashCommandLike>()
    for (const c of piCommands) {
      pi.set(stripSlashPrefix(c.name), c)
    }
    // 交叉校验仅在有真源可对照时生效；空数组（landing 无 session）→ 声明即显示
    const crossCheck = piCommands.length > 0
    const out: ResolvedSlashCommand[] = []
    const seen = new Set<string>()
    for (const [name, decl] of declared) {
      if (crossCheck && !pi.has(name)) continue
      const piItem = pi.get(name)
      out.push({
        id: decl.id,
        name,
        description: decl.description,
        kind: 'extension',
        icon: undefined,
        source: piItem ? 'both' : 'registry',
      })
      seen.add(name)
    }
    for (const [name, c] of pi) {
      if (seen.has(name)) continue
      out.push({
        id: c.id ?? name,
        name,
        description: c.description,
        kind: c.kind ?? 'extension',
        icon: c.icon,
        source: 'pi',
      })
    }
    return out
  }

  /** 执行命令：先激活（ensureActivated(pluginId, 'onCommand')）后执行（executor.execute）。 */
  async execute(id: string, args?: unknown): Promise<void> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      // ERR6 COMMAND_NOT_FOUND：出声机制（error 事件）+ resolve 不 throw（消费端据事件显示禁用态）
      this.deps.bus.emit({
        kind: 'error',
        source: 'CommandRegistry',
        message: `command not found: ${id}`,
      })
      return
    }
    // 先激活后执行（懒激活语义，TC6）：未声明 onCommand 激活事件的 plugin 此调用 no-op
    await this.deps.activationManager.ensureActivated(cmd.pluginId, 'onCommand')
    await this.deps.executor.execute(id, args)
  }
}
