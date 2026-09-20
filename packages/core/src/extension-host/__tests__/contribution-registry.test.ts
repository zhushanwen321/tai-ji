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
    // scheduler-manager 为 plugin-header-action-modal-points AP-1/AP-2 首消费者（u4b 登记）
    expect(builtinContributions.map((b) => b.pluginId)).toEqual(['statusline', 'tasks', 'scheduler-manager'])
    expect(builtinContributions[0].contributes.statusBarItems).toHaveLength(1)
    expect(builtinContributions[1].contributes.slashCommands).toHaveLength(2)
    // tasks 不声明 views——todo/goal 经 extension widget 推送由 Composer 托盘 widget 区承接，
    // 不进 sidebar（D5）；该视图退役后 builtin 整体零 view 声明
    expect(builtinContributions[1].contributes.views).toBeUndefined()
    expect(builtinContributions.every((b) => b.contributes.views === undefined)).toBe(true)
    // scheduler-manager 声明形状（AP-1/AP-2）：headerActions 1 + modals 1 + commands 4
    // （open 点击链配套 + modal 内三个写操作 toggle/run/delete——缺声明则 action-bar
    // 写操作在 CommandRegistry 无注册通路成死链，id 与插件 api.commands.register 逐字一致）
    expect(builtinContributions[2].contributes.headerActions).toHaveLength(1)
    expect(builtinContributions[2].contributes.modals).toHaveLength(1)
    expect(builtinContributions[2].contributes.commands).toHaveLength(4)
    expect(builtinContributions[2].contributes.commands?.map((c) => c.command)).toEqual([
      'scheduler-manager.open',
      'scheduler-manager.toggle',
      'scheduler-manager.run',
      'scheduler-manager.delete',
    ])
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
    expect(registry.getContributions({ type: 'slashCommand' }).map((c) => c.slashCommand?.name)).toEqual(['goal', 'todo'])
    expect(registry.getContributions({ pluginId: 'statusline' })).toHaveLength(1)
    // 1 statusline + 2 tasks slashCommands + scheduler-manager 6 条（AP-1/AP-2：1 headerAction + 1 modal + 4 commands）
    expect(registry.getContributions()).toHaveLength(9)
  })
})

// ── 新点位：headerAction（AP-1）/ modal（AP-2）────────────────────────

describe('ContributionRegistry 新点位路由（AP-1/AP-2）', () => {
  it('AP-1a: headerAction 路由到已注册 panel.header → available=true 且不 emit unregistered', () => {
    const { emit, registry, mounts } = setup()
    mounts.register('panel.header') // bootstrap registerMountPoints 既有挂载点，复用不新增名字
    registry.registerContribution({
      pluginId: 'sched',
      contributionId: 'sched.open',
      type: 'headerAction',
      placement: 'panel.header',
      available: false,
      headerAction: { title: '定时任务', icon: 'clock', commandId: 'sched.open', order: 20 },
    })
    registry.routeAll(mounts)
    expect(registry.getContributions({ pluginId: 'sched' })[0].available).toBe(true)
    expect(emit.mock.calls.filter((c) => c[0].kind === 'unregistered-mount-point')).toHaveLength(0)
  })

  it('AP-2a: modal 路由到已注册 modal 挂载点 → available=true', () => {
    const { emit, registry, mounts } = setup()
    mounts.register('modal') // bootstrap registerMountPoints 新注册挂载点
    registry.registerContribution({
      pluginId: 'sched',
      contributionId: 'sched.panel',
      type: 'modal',
      placement: 'modal',
      available: false,
      modal: { title: '定时任务', width: 'md' },
    })
    registry.routeAll(mounts)
    expect(registry.getContributions({ pluginId: 'sched' })[0].available).toBe(true)
    expect(emit.mock.calls.filter((c) => c[0].kind === 'unregistered-mount-point')).toHaveLength(0)
  })

  it('AP-2b: modal 挂载点未注册 → unregistered-mount-point 事件 + available=false（AC9 置灰）', () => {
    const { emit, registry, mounts } = setup()
    registry.registerContribution({
      pluginId: 'sched',
      contributionId: 'sched.panel',
      type: 'modal',
      placement: 'modal', // 未注册
      available: false,
      modal: { title: '定时任务' },
    })
    registry.routeAll(mounts)
    const evt = emit.mock.calls.map((c) => c[0]).find((e) => e.kind === 'unregistered-mount-point')
    expect(evt).toMatchObject({
      kind: 'unregistered-mount-point',
      pluginId: 'sched',
      contributionId: 'sched.panel',
      expectedMountPoint: 'modal',
    })
    expect(registry.getContributions({ pluginId: 'sched' })[0].available).toBe(false)
  })

  it('AP-1b/AP-2c: loadExternal 解析 headerActions/modals 段，type-specific payload 可读，跨段顺序固定', () => {
    const { registry } = setup()
    registry.loadExternal([{
      pluginId: 'sched',
      contributes: {
        // 声明顺序故意与解析顺序不一致：顺序由 parseContributes 段 concat 决定（TC-5h 同款口径）
        modals: [{ id: 'sched.panel', title: '定时任务', width: 'md' }],
        headerActions: [{ id: 'sched.open', title: '定时任务', icon: 'clock', commandId: 'sched.open', order: 20 }],
      },
    }])
    const all = registry.getContributions({ pluginId: 'sched' })
    expect(all.map((c) => c.type)).toEqual(['headerAction', 'modal'])
    expect(all[0].placement).toBe('panel.header')
    expect(all[0].headerAction).toEqual({ title: '定时任务', icon: 'clock', commandId: 'sched.open', order: 20 })
    expect(all[1].placement).toBe('modal')
    expect(all[1].modal).toEqual({ title: '定时任务', width: 'md' })
  })

  it('AP-2d: modal 声明 width 缺省 → record payload 保留 undefined（renderer fallback 解析源）', () => {
    const { registry } = setup()
    registry.loadExternal([{
      pluginId: 'p1',
      contributes: { modals: [{ id: 'p1.m', title: 'Only Title' }] },
    }])
    const rec = registry.getContributions({ pluginId: 'p1' })[0]
    expect(rec.modal?.title).toBe('Only Title')
    expect(rec.modal?.width).toBeUndefined()
  })
})

describe('ContributionRegistry.clearForPlugin（E2 清理族）', () => {
  it('E2a: 清除该插件全部 type 贡献；其他插件不受扰', () => {
    const { registry } = setup()
    registry.loadExternal([
      {
        pluginId: 'p1',
        contributes: {
          headerActions: [{ id: 'p1.open', title: 'T', icon: 'clock', commandId: 'p1.open' }],
          modals: [{ id: 'p1.m', title: 'M' }],
          commands: [{ command: 'p1.cmd', title: 'C' }],
        },
      },
      {
        pluginId: 'p2',
        contributes: { commands: [{ command: 'p2.cmd', title: 'C2' }] },
      },
    ])
    registry.clearForPlugin('p1')
    expect(registry.getContributions({ pluginId: 'p1' })).toEqual([])
    expect(registry.getContributions({ pluginId: 'p2' })).toHaveLength(1)
  })

  it('E2b: 幂等——清两次不抛错；对不存在 pluginId 为 no-op', () => {
    const { registry } = setup()
    registry.loadExternal([{
      pluginId: 'p1',
      contributes: { headerActions: [{ id: 'p1.open', title: 'T', icon: 'clock', commandId: 'p1.open' }] },
    }])
    expect(() => {
      registry.clearForPlugin('p1')
      registry.clearForPlugin('p1')
      registry.clearForPlugin('nonexistent')
    }).not.toThrow()
    expect(registry.getContributions({ pluginId: 'p1' })).toEqual([])
  })

  it('E2c: 清后 routeAll 不再产出该插件贡献（无 unregistered 事件、getContributions 为空）', () => {
    const { emit, registry, mounts } = setup()
    // 不注册任何挂载点 → routeAll 必 emit unregistered
    registry.loadExternal([{
      pluginId: 'p1',
      contributes: { modals: [{ id: 'p1.m', title: 'M' }] },
    }])
    registry.routeAll(mounts)
    expect(emit.mock.calls.filter((c) => c[0].kind === 'unregistered-mount-point')).toHaveLength(1)
    registry.clearForPlugin('p1')
    emit.mockClear()
    registry.routeAll(mounts) // 清后重路由：该插件零贡献 → 零事件
    expect(emit.mock.calls).toHaveLength(0)
    expect(registry.getContributions({ pluginId: 'p1' })).toEqual([])
  })
})

describe('E2 触发链 core 侧通路（事件订阅回调内调 clearForPlugin）', () => {
  // renderer 接线归 u4b；本组只锁 core 侧事实：plugin-status-change / plugin-crashed
  // 两内部事件可经 InternalEventBus 订阅，订阅回调内可调 clearForPlugin 完成清理。
  it('E2d: plugin-status-change 广播 → 订阅回调 clearForPlugin → 该插件贡献消失', () => {
    const { bus, registry, mounts } = setup()
    registry.loadExternal([{
      pluginId: 'p1',
      contributes: { headerActions: [{ id: 'p1.open', title: 'T', icon: 'clock', commandId: 'p1.open' }] },
    }])
    mounts.register('panel.header')
    registry.routeAll(mounts)
    expect(registry.getContributions({ pluginId: 'p1' })[0].available).toBe(true)

    const unsubscribe = bus.on('plugin-status-change', (e) => {
      if (e.status === 'inactive' || e.status === 'crashed') registry.clearForPlugin(e.pluginId)
    })
    bus.emit({ kind: 'plugin-status-change', pluginId: 'p1', status: 'inactive' })
    expect(registry.getContributions({ pluginId: 'p1' })).toEqual([])

    unsubscribe()
    bus.emit({ kind: 'plugin-status-change', pluginId: 'p1', status: 'active' }) // 退订后不再触发
    expect(registry.getContributions()).toEqual([])
  })

  it('E2e: plugin-crashed 广播 → 订阅回调 clearForPlugin（含 headerAction+modal 两新点位）', () => {
    const { bus, registry } = setup()
    registry.loadExternal([{
      pluginId: 'p1',
      contributes: {
        headerActions: [{ id: 'p1.open', title: 'T', icon: 'clock', commandId: 'p1.open' }],
        modals: [{ id: 'p1.m', title: 'M' }],
      },
    }])
    bus.on('plugin-crashed', (e) => registry.clearForPlugin(e.pluginId))
    expect(registry.getContributions({ pluginId: 'p1' })).toHaveLength(2)
    bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
    expect(registry.getContributions({ pluginId: 'p1' })).toEqual([])
  })
})
