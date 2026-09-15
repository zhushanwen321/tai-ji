/**
 * contribution-registry.ts —— ContributionRegistry（IF4）。
 *
 * 声明式贡献注册中心：builtin 静态内建（builtin-contributions.ts，TC3/D1）+ external
 * 经 loadExternal 注入（消费『已到达 core 的数据』，runtime 透传通道归 s3）。
 *
 * 契约（IF4）：
 * - registerBuiltin 初始化即调用（builtin 免 runtime）
 * - loadExternal 幂等：重复注入同一 pluginId 覆盖不翻倍
 * - routeAll 后每条 contribution 的 available 反映挂载点注册态（AC9 置灰依据）；
 *   未注册挂载点 → emit unregistered-mount-point 事件（ERR1，不静默丢弃）
 * - 向后兼容：旧 panels 字段（legacy manifest）映射为 view（deprecated alias）
 * - loadExternal 的 descriptor 无 contributes → 注册为空不抛错（ERR5 降级，
 *   debug 日志——s3 未完成透传前的已知中间态）
 */
import type { InternalEventBus } from './internal-event-bus'
import { builtinContributions } from './builtin-contributions'
import type { MountPointRegistry } from './mount-point-registry'
import type {
  ContributionRecord,
  ContributionType,
  PluginContributes,
  PluginDescriptorLike,
  ViewContributionSummary,
} from './types'

const PLACEMENT_BY_TYPE: Record<Exclude<ContributionType, 'view' | 'menu'>, string> = {
  command: 'commands',
  statusBarItem: 'statusbar',
  slashCommand: 'slash',
  configuration: 'settings',
}

// ── 解析：PluginContributes v2 → ContributionRecord[]（按 type 分段 helper）──
//
// parseContributes 的分段提取：每段只解析一种 contribution type，段内循环体与
// 原内联实现逐字节一致；parseContributes 按原 push 顺序 concat 各段，
// 跨段顺序（view→menu→command→statusBarItem→slashCommand→configuration）即注册顺序。

function parseViewContributions(pluginId: string, c: PluginContributes): ContributionRecord[] {
  const out: ContributionRecord[] = []
  for (const v of c.views ?? []) {
    out.push({
      pluginId,
      contributionId: v.id,
      type: 'view',
      placement: v.placement,
      available: false,
      view: {
        viewType: v.viewType ?? 'gui',
        title: v.title,
        initialVisibility: v.initialVisibility ?? 'hidden',
      },
    })
  }
  return out
}

function parseMenuContributions(pluginId: string, c: PluginContributes): ContributionRecord[] {
  const out: ContributionRecord[] = []
  for (const [placement, items] of Object.entries(c.menus ?? {})) {
    for (const m of items ?? []) {
      out.push({
        pluginId,
        // menus 无天然 id，合成 id（T3 取舍）
        contributionId: `${placement}::${m.command}`,
        type: 'menu',
        placement,
        available: false,
        menu: { group: m.group, when: m.when },
      })
    }
  }
  return out
}

function parseCommandContributions(pluginId: string, c: PluginContributes): ContributionRecord[] {
  const out: ContributionRecord[] = []
  for (const cmd of c.commands ?? []) {
    out.push({
      pluginId,
      contributionId: cmd.command,
      type: 'command',
      placement: PLACEMENT_BY_TYPE.command,
      available: false,
      command: { title: cmd.title, category: cmd.category, keybinding: cmd.keybinding, when: cmd.when },
    })
  }
  return out
}

function parseStatusBarItemContributions(pluginId: string, c: PluginContributes): ContributionRecord[] {
  const out: ContributionRecord[] = []
  for (const item of c.statusBarItems ?? []) {
    out.push({
      pluginId,
      contributionId: item.id,
      type: 'statusBarItem',
      placement: PLACEMENT_BY_TYPE.statusBarItem,
      available: false,
      statusBarItem: {
        text: item.text,
        alignment: item.alignment ?? 'right',
        priority: item.priority,
        scope: item.scope ?? 'global',
        commandId: item.commandId,
      },
    })
  }
  return out
}

function parseSlashCommandContributions(pluginId: string, c: PluginContributes): ContributionRecord[] {
  const out: ContributionRecord[] = []
  for (const s of c.slashCommands ?? []) {
    out.push({
      pluginId,
      contributionId: s.name,
      type: 'slashCommand',
      placement: PLACEMENT_BY_TYPE.slashCommand,
      available: false,
      slashCommand: { name: s.name, description: s.description },
    })
  }
  return out
}

function parseConfigurationContribution(pluginId: string, c: PluginContributes): ContributionRecord[] {
  if (!c.configuration) return []
  return [
    {
      pluginId,
      contributionId: 'configuration',
      type: 'configuration',
      placement: PLACEMENT_BY_TYPE.configuration,
      available: false,
      configuration: { properties: c.configuration.properties },
    },
  ]
}

export class ContributionRegistry {
  private contributions = new Map<string, ContributionRecord>()

  constructor(private bus: InternalEventBus) {}

  /**
   * 注册键：pluginId + type + contributionId 三维唯一（TC4）。
   * 同 pluginId 下 view id 与 slashCommand name 等可同值（如 tasks 的 'todo'/'goal'），
   * 无 type 维度时后者会覆盖前者（扁平 key 空间碰撞）。
   */
  private key(pluginId: string, type: ContributionType, contributionId: string): string {
    return pluginId + '::' + type + '::' + contributionId
  }

  /** 单条注册（同 pluginId+type+contributionId 覆盖）。 */
  registerContribution(c: ContributionRecord): void {
    this.contributions.set(this.key(c.pluginId, c.type, c.contributionId), c)
  }

  /** 扫 builtin-contributions.ts 静态 manifest 注册（初始化即调用）。 */
  registerBuiltin(): void {
    for (const b of builtinContributions) {
      for (const c of this.parseContributes(b.pluginId, b.contributes)) {
        this.registerContribution(c)
      }
    }
  }

  /**
   * 注入 external plugin descriptor（含 contributes，按 PluginContributes v2 解析）。
   * 幂等：重复注入同一 pluginId 覆盖不翻倍。无 contributes → 注册为空不抛错（ERR5 降级）。
   */
  loadExternal(descriptors: PluginDescriptorLike[]): void {
    for (const d of descriptors) {
      // ERR5：数据未就绪（runtime 透传归 s3），debug 日志降级，不抛错
      if (!d.contributes && !d.panels) {
        console.debug(
          `[ContributionRegistry] ${d.pluginId}: no contributes in descriptor (ERR5 EXTERNAL_CONTRIBUTIONS_MISSING, s3 透传未完成)`,
        )
        continue
      }
      // 覆盖式重注入：先清该 pluginId 全部旧 contribution 再注册（幂等不翻倍）
      for (const [k, c] of this.contributions) {
        if (c.pluginId === d.pluginId) this.contributions.delete(k)
      }
      if (d.contributes) {
        for (const c of this.parseContributes(d.pluginId, d.contributes)) {
          this.registerContribution(c)
        }
      }
      // legacy 兼容：旧 panels 字段 → view（deprecated alias）
      if (d.panels) {
        for (const p of d.panels) {
          this.registerContribution({
            pluginId: d.pluginId,
            contributionId: p.id,
            type: 'view',
            placement: p.placement ?? 'sidebar.tab',
            available: false,
            view: { viewType: 'gui', title: p.title ?? p.id, initialVisibility: 'hidden' },
          })
        }
      }
    }
  }

  /**
   * 按 placement 路由到挂载点。未注册挂载点 → emit unregistered-mount-point
   * （含 pluginId+contributionId+expectedMountPoint）+ available=false（ERR1/AC9）。
   */
  routeAll(mounts: MountPointRegistry): void {
    for (const c of this.contributions.values()) {
      if (mounts.has(c.placement)) {
        c.available = true
      } else {
        c.available = false
        this.bus.emit({
          kind: 'unregistered-mount-point',
          pluginId: c.pluginId,
          contributionId: c.contributionId,
          expectedMountPoint: c.placement,
        })
      }
    }
  }

  /** 按 pluginId/type 过滤查询。 */
  getContributions(filter?: { pluginId?: string; type?: ContributionType }): ContributionRecord[] {
    const all = Array.from(this.contributions.values())
    if (!filter) return all
    return all.filter(
      (c) =>
        (!filter.pluginId || c.pluginId === filter.pluginId) &&
        (!filter.type || c.type === filter.type),
    )
  }

  /**
   * 按 placement 查询视图贡献（IF1，视图宿主消费入口）。
   * viewId=contributionId，title 缺省回退 contributionId，icon 显式 undefined，
   * initialVisibility 取记录值（view payload 缺省时回退 'hidden'，legacy panels 固定 'hidden'）。
   */
  getViewsByPlacement(placement: string): ViewContributionSummary[] {
    return this.getContributions({ type: 'view' })
      .filter((c) => c.placement === placement)
      .map((c) => ({
        viewId: c.contributionId,
        title: c.view?.title ?? c.contributionId,
        icon: undefined,
        initialVisibility: c.view?.initialVisibility ?? 'hidden',
      }))
  }

  // ── 解析：PluginContributes v2 → ContributionRecord[] ──────────────

  /**
   * 逐段解析 PluginContributes v2。各 type 段提取为模块级 helper（见文件头分段
   * helper 区），此处只按原 push 顺序 concat——跨段顺序即注册顺序，不可重排。
   */
  private parseContributes(pluginId: string, c: PluginContributes): ContributionRecord[] {
    return [
      ...parseViewContributions(pluginId, c),
      ...parseMenuContributions(pluginId, c),
      ...parseCommandContributions(pluginId, c),
      ...parseStatusBarItemContributions(pluginId, c),
      ...parseSlashCommandContributions(pluginId, c),
      ...parseConfigurationContribution(pluginId, c),
    ]
  }
}
