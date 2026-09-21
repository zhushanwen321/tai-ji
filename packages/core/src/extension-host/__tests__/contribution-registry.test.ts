/**
 * contribution-registry.test.ts —— ContributionRegistry 契约（TC-1 AC9 + TC-5 IF4 其余）。
 *
 * TC-1（AC9/ERR1）：routeAll 未注册挂载点 → unregistered-mount-point 事件 emit + available=false；
 *   已注册挂载点 → available=true 不 emit
 * TC-5：registerBuiltin 双插件骨架（DM5）/ loadExternal 幂等覆盖 / ERR5 降级 /
 *   getContributions filter / legacy panels 映射 view
 */
import { describe, it, expect, vi } from 'vitest'
import { ContributionRegistry } from '../contribution-registry'
import { InternalEventBus } from '../internal-event-bus'
import { MountPointRegistry } from '../mount-point-registry'
import { builtinContributions } from '../builtin-contributions'
import type { PluginDescriptorLike } from '../types'

function setup() {
  const bus = new InternalEventBus()
  const emit = vi.spyOn(bus, 'emit')
  const registry = new ContributionRegistry(bus)
  const mounts = new MountPointRegistry()
  return { bus, emit, registry, mounts }
}

describe('ContributionRegistry.routeAll（AC9/ERR1）', () => {
  it('TC-1a: 未注册挂载点 → unregistered-mount-point 事件 + available=false', () => {
    const { emit, registry, mounts } = setup()
    mounts.register('statusbar') // 只注册 statusbar
    registry.registerContribution({
      pluginId: 'p1',
      contributionId: 'v1',
      type: 'view',
      placement: 'sidebar.tab', // 未注册
      available: false,
      view: { viewType: 'gui', title: 'My View', initialVisibility: 'hidden' },
    })
    registry.routeAll(mounts)
    // 事件 emit
    const evt = emit.mock.calls.map((c) => c[0]).find((e) => e.kind === 'unregistered-mount-point')
    expect(evt).toBeDefined()
    expect(evt).toMatchObject({
      kind: 'unregistered-mount-point',
      pluginId: 'p1',
      contributionId: 'v1',
      expectedMountPoint: 'sidebar.tab',
    })
    // available=false（AC9 置灰依据）
    expect(registry.getContributions({ pluginId: 'p1' })[0].available).toBe(false)
  })

  it('TC-1b: 已注册挂载点 → available=true 且不 emit unregistered', () => {
    const { emit, registry, mounts } = setup()
    mounts.register('statusbar')
    registry.registerContribution({
      pluginId: 'p1',
      contributionId: 'sb1',
      type: 'statusBarItem',
      placement: 'statusbar', // 已注册
      available: false,
      statusBarItem: { text: 'x', alignment: 'right', priority: 0, scope: 'global' },
    })
    registry.routeAll(mounts)
    expect(registry.getContributions({ pluginId: 'p1' })[0].available).toBe(true)
    expect(emit.mock.calls.filter((c) => c[0].kind === 'unregistered-mount-point')).toHaveLength(0)
  })

  it('TC-1c: routeAll 可重复调用（幂等，事件按当前挂载点集重算）', () => {
    const { emit, registry, mounts } = setup()
    registry.registerContribution({
      pluginId: 'p1', contributionId: 'v1', type: 'view', placement: 'sidebar.tab', available: false,
    })
    registry.routeAll(mounts) // 未注册 → 1 次事件
    mounts.register('sidebar.tab')
    registry.routeAll(mounts) // 已注册 → 无新事件，available=true
    expect(emit.mock.calls.filter((c) => c[0].kind === 'unregistered-mount-point')).toHaveLength(1)
    expect(registry.getContributions()[0].available).toBe(true)
  })
})

describe('ContributionRegistry.registerBuiltin（DM5）', () => {
  it('TC-5a: registerBuiltin 注册 statusline statusBarItem + tasks slashCommand 骨架', () => {
    const { registry, mounts } = setup()
    mounts.register('statusbar')
    mounts.register('slash')
    registry.registerBuiltin()
    const all = registry.getContributions()
    const statusline = all.find((c) => c.pluginId === 'statusline')
    expect(statusline).toBeDefined()
    expect(statusline?.type).toBe('statusBarItem')
    expect(statusline?.contributionId).toBe('statusline') // id 在 contributionId（DM1 字段归位）
    expect(statusline?.statusBarItem).toMatchObject({ text: '', priority: 0 })
    // 同 pluginId 下 view 与 slashCommand 共存（TC4），slashCommand 断言先按 type 过滤
    const tasks = all.filter((c) => c.pluginId === 'tasks')
    const taskSlash = tasks.filter((c) => c.type === 'slashCommand')
    expect(taskSlash.map((t) => t.slashCommand?.name)).toEqual(['goal', 'todo'])
    registry.routeAll(mounts)
    expect(statusline?.available).toBe(true)
  })

  it('TC-5b: builtin 插件骨架与 manifest 声明一致', () => {
    // composer-task-tray D10：「后台命令」view 贡献随该 native 视图退役
    expect(builtinContributions.map((b) => b.pluginId)).toEqual(['statusline', 'tasks', 'scheduler'])
    expect(builtinContributions[0].contributes.statusBarItems).toHaveLength(1)
    expect(builtinContributions[1].contributes.slashCommands).toHaveLength(2)
    expect(builtinContributions[2].contributes.slashCommands).toHaveLength(2) // scheduler + schedule alias
    // tasks 不声明 views——todo/goal 经 extension widget 推送由 Composer 托盘 widget 区承接，
    // 不进 sidebar（D5）；该视图退役后 builtin 整体零 view 声明
    expect(builtinContributions[1].contributes.views).toBeUndefined()
    expect(builtinContributions.every((b) => b.contributes.views === undefined)).toBe(true)
  })
})

describe('ContributionRegistry.loadExternal（IF4/ERR5）', () => {
  it('TC-5c: 解析 external contributes 全部 type，placement 推导正确', () => {
    const { registry } = setup()
    const d: PluginDescriptorLike = {
      pluginId: 'ext1',
      contributes: {
        views: [{ id: 'w1', title: 'W1', placement: 'sidebar.tab' }],
        menus: { 'composer.toolbar': [{ command: 'ext1.cmd1', group: 'nav' }] },
        commands: [{ command: 'ext1.cmd1', title: 'Cmd 1' }],
        statusBarItems: [{ id: 'sb1', text: 'S', priority: 1, alignment: 'left' }],
        slashCommands: [{ name: 'hello', description: 'hi' }],
        configuration: { properties: { a: { type: 'string' } } },
      },
    }
    registry.loadExternal([d])
    const all = registry.getContributions({ pluginId: 'ext1' })
    expect(all.map((c) => c.type).sort()).toEqual([
      'command', 'configuration', 'menu', 'slashCommand', 'statusBarItem', 'view',
    ])
    expect(all.find((c) => c.type === 'view')?.placement).toBe('sidebar.tab')
    expect(all.find((c) => c.type === 'menu')?.placement).toBe('composer.toolbar')
    expect(all.find((c) => c.type === 'command')?.placement).toBe('commands')
    expect(all.find((c) => c.type === 'statusBarItem')?.placement).toBe('statusbar')
    expect(all.find((c) => c.type === 'slashCommand')?.placement).toBe('slash')
    expect(all.find((c) => c.type === 'configuration')?.placement).toBe('settings')
  })

  it('TC-5h: 跨 type 输出顺序固定（view→menu→command→statusBarItem→slashCommand→configuration）', () => {
    // contributes 字段按逆序声明，验证解析顺序由 parseContributes 的段 concat 顺序决定，
    // 与 descriptor 字段声明顺序无关（注册顺序契约：同 placement 下先注册先排位）
    const { registry } = setup()
    registry.loadExternal([{
      pluginId: 'ord1',
      contributes: {
        configuration: { properties: { a: { type: 'string' } } },
        slashCommands: [{ name: 's1', description: '' }],
        statusBarItems: [{ id: 'sb1', text: '', priority: 0 }],
        commands: [{ command: 'c1', title: '' }],
        menus: { 'composer.toolbar': [{ command: 'm1' }] },
        views: [{ id: 'v1', title: '', placement: 'sidebar.tab' }],
      },
    }])
    expect(registry.getContributions({ pluginId: 'ord1' }).map((c) => c.type)).toEqual([
      'view', 'menu', 'command', 'statusBarItem', 'slashCommand', 'configuration',
    ])
  })

  it('TC-5d: 重复注入同一 pluginId 覆盖不翻倍（幂等）', () => {
    const { registry } = setup()
    const d: PluginDescriptorLike = {
      pluginId: 'ext1',
      contributes: { commands: [{ command: 'ext1.a', title: 'A' }] },
    }
    registry.loadExternal([d])
    registry.loadExternal([d])
    expect(registry.getContributions({ pluginId: 'ext1' })).toHaveLength(1)
    // 覆盖语义：新注入替换旧的全部
    const d2: PluginDescriptorLike = {
      pluginId: 'ext1',
      contributes: { commands: [{ command: 'ext1.b', title: 'B' }] },
    }
    registry.loadExternal([d2])
    const all = registry.getContributions({ pluginId: 'ext1' })
    expect(all).toHaveLength(1)
    expect(all[0].contributionId).toBe('ext1.b')
  })

  it('TC-5e: 无 contributes → 注册为空不抛错（ERR5 降级）', () => {
    const { registry } = setup()
    expect(() => registry.loadExternal([{ pluginId: 'ext2' }])).not.toThrow()
    expect(registry.getContributions({ pluginId: 'ext2' })).toEqual([])
  })

  it('TC-5f: legacy panels 字段映射为 view（deprecated alias，向后兼容）', () => {
    const { registry } = setup()
    registry.loadExternal([{
      pluginId: 'legacy1',
      panels: [{ id: 'panel-a', title: 'Old Panel', placement: 'sidebar.tab' }],
    }])
    const all = registry.getContributions({ pluginId: 'legacy1' })
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe('view')
    expect(all[0].contributionId).toBe('panel-a')
    expect(all[0].placement).toBe('sidebar.tab')
    expect(all[0].view?.title).toBe('Old Panel')
  })
})

describe('ContributionRegistry.getViewsByPlacement（IF1）', () => {
  it('AC1: registerBuiltin 后 sidebar.tab 零 builtin view；external view 字段映射与顺序正确', () => {
    const { registry } = setup()
    registry.registerBuiltin()
    // 「后台命令」视图退役（composer-task-tray D10）后 builtin 无 sidebar.tab view 声明
    expect(registry.getViewsByPlacement('sidebar.tab')).toEqual([])

    // 字段映射与顺序用 external 注入验证（manifest 数组序保留）
    registry.loadExternal([{
      pluginId: 'p1',
      contributes: {
        views: [
          { id: 'todo', title: '任务', placement: 'sidebar.tab', initialVisibility: 'visible' },
          { id: 'goal', title: '目标', placement: 'sidebar.tab', initialVisibility: 'visible' },
        ],
      },
    }])
    const views = registry.getViewsByPlacement('sidebar.tab')
    expect(views).toHaveLength(2)
    expect(views.map((v) => v.viewId)).toEqual(['todo', 'goal'])
    expect(views[0]).toEqual({
      viewId: 'todo',
      title: '任务',
      icon: undefined,
      initialVisibility: 'visible',
    })
    expect(views[1]).toEqual({
      viewId: 'goal',
      title: '目标',
      icon: undefined,
      initialVisibility: 'visible',
    })
  })

  it('AC2: 非 sidebar.tab placement 返回空数组不抛错', () => {
    const { registry } = setup()
    registry.registerBuiltin()
    expect(() => registry.getViewsByPlacement('foo.bar')).not.toThrow()
    expect(registry.getViewsByPlacement('foo.bar')).toEqual([])
  })

  it('TC4: 同 pluginId 跨 type 同 id 共存（view 不被 slashCommand 覆盖）', () => {
    const { registry } = setup()
    // builtin tasks 仅剩 slashCommands（D5）；跨 type 共存语义用同 descriptor 内
    // view id='x' + slashCommand name='x' 验证
    registry.loadExternal([{
      pluginId: 'tasks',
      contributes: {
        views: [{ id: 'x', title: 'X', placement: 'sidebar.tab' }],
        slashCommands: [{ name: 'x', description: 'x' }],
      },
    }])
    const tasks = registry.getContributions({ pluginId: 'tasks' })
    expect(tasks).toHaveLength(2)
    expect(tasks.filter((c) => c.type === 'view')).toHaveLength(1)
    expect(tasks.filter((c) => c.type === 'slashCommand')).toHaveLength(1)
    // 视图查询不受 slashCommand 同名影响
    expect(registry.getViewsByPlacement('sidebar.tab')).toHaveLength(1)
  })
})

describe('ContributionRegistry.getContributions（IF4）', () => {
  it('TC-5g: filter 按 pluginId/type 过滤；无 filter 返回全部', () => {
    const { registry } = setup()
    registry.registerBuiltin()
    expect(registry.getContributions({ type: 'slashCommand' }).map((c) => c.slashCommand?.name)).toEqual(['goal', 'todo', 'scheduler', 'schedule'])
    expect(registry.getContributions({ pluginId: 'statusline' })).toHaveLength(1)
    expect(registry.getContributions()).toHaveLength(5) // 1 statusline + 2 tasks + 2 scheduler slashCommands（「后台命令」view 已退役）
  })
})
