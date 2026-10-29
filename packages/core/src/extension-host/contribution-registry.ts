/**
 * contribution-registry.ts —— ContributionRegistry（IF4）。
 *
 * 声明式贡献注册中心：builtin 静态内建（builtin-contributions.ts，TC3/D1）+ external
 * 经 loadExternal 注入（消费『已到达 core 的数据』，runtime 透传通道归 s3）。
 *
 * 契约（IF4）：
 * - registerBuiltin 初始化即调用（builtin 免 runtime）
 * - loadExternal 幂等：重复注入同一 pluginId 不翻倍；覆盖粒度 = (type, contributionId)
 *   逐项（声明源合并 §6.2——静态表项不被未被清单覆盖的声明清除，失败模式 D 防线）
 * - routeAll 后每条 contribution 的 available 反映挂载点注册态（AC9 置灰依据）；
 *   未注册挂载点 → emit unregistered-mount-point 事件（ERR1，不静默丢弃）
 * - clearForPlugin(pluginId)：清除该插件全部贡献（崩溃/禁用/卸载清理族，幂等）
 * - 向后兼容：旧 panels 字段（legacy manifest）映射为 view（deprecated alias）
 * - loadExternal 的 descriptor 无清单声明（contributes 缺失或 {}）→ 不清不注册（ERR5 降级，
 *   debug 日志）
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
  slashCommand: 'slash',
  configuration: 'settings',
  // headerAction 复用已注册挂载点名 panel.header（不新增名字，AP-1）
  headerAction: 'panel.header',
}

// ── 解析：PluginContributes v2 → ContributionRecord[]（按 type 分段 helper）──
//
// parseContributes 的分段提取：每段只解析一种 contribution type，段内循环体与
// 原内联实现逐字节一致；parseContributes 按原 push 顺序 concat 各段，
// 跨段顺序（view→menu→command→slashCommand→configuration→headerAction）
// 即注册顺序。

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

function parseHeaderActionContributions(pluginId: string, c: PluginContributes): ContributionRecord[] {
  const out: ContributionRecord[] = []
  for (const h of c.headerActions ?? []) {
    out.push({
      pluginId,
      contributionId: h.id,
      type: 'headerAction',
      placement: PLACEMENT_BY_TYPE.headerAction,
      available: false,
      headerAction: { title: h.title, icon: h.icon, commandId: h.commandId, order: h.order, activation: h.activation },
    })
  }
  return out
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
   *
   * 覆盖粒度（容器扩展点统一 §6.2 声明源合并规则）：按 (type, contributionId) 逐项覆盖——
   * registerContribution 的三维 key 天然按项 set，静态表（registerBuiltin）先注册的项
   * 不被未被清单覆盖的同插件声明清除。整插件清空语义会在接通声明通路后由第一次
   * config.plugins 广播清掉 scheduler-manager 的纯静态声明（其清单无 contributes 段，
   * 贡献只在 builtin 静态表——失败模式 D），故不可回退。
   * 幂等：同一 descriptor 重复注入同 key set 不翻倍。
   * 无清单声明（contributes 缺失或 {} 与缺失同义）→ 不清不注册，不抛错。
   */
  loadExternal(descriptors: PluginDescriptorLike[]): void {
    for (const d of descriptors) {
      // 无清单声明：不触碰既有记录（「不清」与覆盖粒度规则配套——静态项不因空声明丢失）
      if ((!d.contributes || Object.keys(d.contributes).length === 0) && !d.panels) {
        console.debug(`[ContributionRegistry] ${d.pluginId}: no contributes in descriptor (无清单声明，不清不注册)`)
        continue
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
            view: { viewType: 'gui', title: p.title ?? p.id },
          })
        }
      }
    }
  }

  /**
   * 按 placement 路由到挂载点（§5.4 判定表行 1 的判定出口：未注册位置族 →
   * available=false + emit unregistered-mount-point，种类值 'unregistered-mount-point'
   * 与 failure-degradation 的 FAILURE_JUDGEMENT_TABLE 行 1 同名——renderer 订阅侧按
   * 同形去重键 `pluginId::contributionId::unregistered-mount-point` warn 一次）。
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
   * viewId=contributionId，title 缺省回退 contributionId，icon 恒 undefined——
   * record.view 形状（types.ts）未含 icon，声明侧 PluginContributesView.icon 到本通道
   * 的透传缺位（§7.2「parseViewContributions 透传新字段」的 record 扩形未实施）；
   * 图标统一解析入口 = failure-degradation 的 resolveContributionIcon（§6.13），
   * 消费单元直接以声明数据调它，不经本摘要。
   */
  getViewsByPlacement(placement: string): ViewContributionSummary[] {
    return this.getContributions({ type: 'view' })
      .filter((c) => c.placement === placement)
      .map((c) => ({
        viewId: c.contributionId,
        title: c.view?.title ?? c.contributionId,
        icon: undefined,
      }))
  }

  /**
   * 清除该插件全部贡献记录（E2 触发链：插件崩溃/禁用/卸载时由消费方在
   * plugin-status-change / plugin-crashed 订阅回调内调用；
   * 重启用经 registerBuiltin/loadExternal 重放）。幂等：无记录时为 no-op。
   */
  clearForPlugin(pluginId: string): void {
    for (const [k, c] of this.contributions) {
      if (c.pluginId === pluginId) this.contributions.delete(k)
    }
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
      ...parseSlashCommandContributions(pluginId, c),
      ...parseConfigurationContribution(pluginId, c),
      ...parseHeaderActionContributions(pluginId, c),
    ]
  }
}
