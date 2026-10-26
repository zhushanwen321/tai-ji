// internal-event-bus.test.ts —— core C14 簇合并产物（round5-G）。
// 共同被测业务模块：`src/extension-host/internal-event-bus.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/extension-host/__tests__/command-registry.test.ts（15 用例，skip 0）
//   - src/extension-host/__tests__/contribution-registry.test.ts（23 用例，skip 0）
//   - src/extension-host/__tests__/header-action-store.test.ts（14 用例，skip 0）
//   - src/extension-host/__tests__/internal-event-bus.test.ts（7 用例，skip 0）
//   - src/extension-host/__tests__/message-bus-bridge.test.ts（41 用例，skip 0）
//   - src/extension-host/__tests__/notification-host-controller.test.ts（7 用例，skip 0）
//   - src/extension-host/__tests__/overlay-lifecycle.test.ts（10 用例，skip 0）
//   - src/extension-host/__tests__/view-host-store.test.ts（19 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CommandRegistry, type CommandExecutor } from '../command-registry'
import { ActivationManager, type ActivationTrigger } from '../activation-manager'
import { InternalEventBus } from '../internal-event-bus'
import { type ContributionRecord, type PluginDescriptorLike, type InternalEvent } from '../types'
import { ContributionRegistry } from '../contribution-registry'
import { MountPointRegistry } from '../mount-point-registry'
import { builtinContributions } from '../builtin-contributions'
import { HeaderActionStore, type HeaderActionEntry } from '../header-action-store'
import { createSessionScopedMap } from '../utils/session-scoped-map'
import { MockMessageSource, type IncomingPluginMessage } from '../plugin-message-source'
import { MessageBusBridge, parseHeaderActionUpdate } from '../message-bus-bridge'
import { NotificationHostController } from '../notification-host-controller'
import { OverlayLifecycle, GLOBAL_OVERLAY_KEY } from '../overlay-lifecycle'
import { ViewHostStore, type ViewCacheEntry } from '../view-host-store'

// ======== 来源：command-registry.test.ts ========
describe("command-registry", () => {
  function setup() {
    const bus = new InternalEventBus()
    const emit = vi.spyOn(bus, 'emit')
    const activationTrigger = vi.fn<ActivationTrigger['ensureActivated']>().mockResolvedValue(undefined)
    const activationManager = new ActivationManager({ trigger: { ensureActivated: activationTrigger } })
    const executeFn = vi.fn<CommandExecutor['execute']>().mockResolvedValue(undefined)
    const executor: CommandExecutor = { execute: executeFn }
    const registry = new CommandRegistry({ bus, activationManager, executor })
    return { bus, emit, activationTrigger, activationManager, executor, executeFn, registry }
  }

  /** command 型 contribution 样本（W1 parseContributes 产出形状）。 */
  function commandContribution(overrides: Partial<ContributionRecord> = {}): ContributionRecord {
    return {
      pluginId: 'p1',
      contributionId: 'p1.hello',
      type: 'command',
      placement: 'commands',
      available: true,
      command: { title: 'Hello', category: 'Demo', keybinding: 'Ctrl+H', when: 'editorFocus' },
      ...overrides,
    }
  }

  describe('CommandRegistry 统一命令表（TC-1 + registerCommand 幂等）', () => {
    it('TC-1a: registerFromContribution(command 型) → list() 含该命令 + get 字段映射正确', () => {
      const { registry } = setup()
      registry.registerFromContribution(commandContribution())
      expect(registry.list()).toHaveLength(1)
      const cmd = registry.get('p1.hello')
      expect(cmd).toMatchObject({
        id: 'p1.hello',
        title: 'Hello',
        category: 'Demo',
        keybinding: 'Ctrl+H',
        when: 'editorFocus',
        pluginId: 'p1',
      })
      expect(cmd?.handlerRef).toBeUndefined() // 声明型无 handler（R2）
    })

    it('TC-1b: registerCommand 手动注册（api.commands.register 入口）→ get/list 正确', () => {
      const { registry } = setup()
      registry.registerCommand({
        id: 'p1.dynamic',
        title: 'Dynamic',
        pluginId: 'p1',
        handlerRef: 'handler:dynamic',
      })
      expect(registry.get('p1.dynamic')?.handlerRef).toBe('handler:dynamic')
      expect(registry.list().map((c) => c.id)).toEqual(['p1.dynamic'])
    })

    it('TC-1c: 同 id 重复注册覆盖不翻倍（registerCommand 幂等）', () => {
      const { registry } = setup()
      registry.registerCommand({ id: 'x', title: 'A', pluginId: 'p1' })
      registry.registerCommand({ id: 'x', title: 'B', pluginId: 'p1' })
      expect(registry.list()).toHaveLength(1)
      expect(registry.get('x')?.title).toBe('B')
    })

    it('TC-1d: registerFromContribution 非 command 型（view）→ ignore；slashCommand 型 → 归一进表（type=slashCommand）', () => {
      const { registry } = setup()
      registry.registerFromContribution({
        pluginId: 'p1',
        contributionId: 'v1',
        type: 'view',
        placement: 'sidebar.tab',
        available: true,
        view: { viewType: 'gui', title: 'View', initialVisibility: 'hidden' },
      })
      registry.registerFromContribution({
        pluginId: 'tasks',
        contributionId: 'goal',
        type: 'slashCommand',
        placement: 'slash',
        available: true,
        slashCommand: { name: 'goal', description: '创建目标' },
      })
      // view ignore，slashCommand 归一进表（W3 收编：不再 ignore）
      expect(registry.list()).toHaveLength(1)
      const cmd = registry.get('goal')
      expect(cmd).toMatchObject({
        id: 'goal',
        title: 'goal',
        description: '创建目标',
        pluginId: 'tasks',
        type: 'slashCommand',
      })
    })
  })

  describe('CommandRegistry.resolveSlashCommands（W3 收编：声明 ∪ pi 真源 + 交叉校验）', () => {
    /** slashCommand 型 contribution 样本（builtin tasks 声明形状）。 */
    function slashContribution(name: string, description: string, pluginId = 'tasks'): ContributionRecord {
      return {
        pluginId,
        contributionId: name,
        type: 'slashCommand',
        placement: 'slash',
        available: true,
        slashCommand: { name, description },
      }
    }

    function registryWithDeclared(names: Array<[string, string]>): ReturnType<typeof setup>['registry'] {
      const { registry } = setup()
      for (const [name, description] of names) registry.registerFromContribution(slashContribution(name, description))
      return registry
    }

    it('TC1a: 声明 goal/todo + pi 真源含 goal（缺 todo）→ 合并含 goal（description 取声明、source=both）、todo 被交叉校验隐藏', () => {
      const registry = registryWithDeclared([
        ['goal', '创建目标'],
        ['todo', '创建任务'],
      ])
      const merged = registry.resolveSlashCommands([{ name: 'goal', description: 'pi 的 goal desc', kind: 'extension', icon: 'goal' }])
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({
        id: 'goal',
        name: 'goal',
        // 元数据取声明（D3-1），非 pi 真源的 desc
        description: '创建目标',
        source: 'both',
      })
    })

    it('TC1b: pi 真源为空（landing 无 session 真源）→ 交叉校验不生效，声明即显示（slice TC2 裁决）', () => {
      const registry = registryWithDeclared([
        ['goal', '创建目标'],
        ['todo', '创建任务'],
      ])
      const merged = registry.resolveSlashCommands([])
      expect(merged.map((c) => c.name)).toEqual(['goal', 'todo'])
      expect(merged[0]).toMatchObject({ description: '创建目标', source: 'registry' })
    })

    it('TC1c: pi 独有项保留（真源为存在性/执行依据），声明在前 pi 独有在后', () => {
      const registry = registryWithDeclared([['goal', '创建目标']])
      const merged = registry.resolveSlashCommands([
        { name: 'goal', description: 'pi desc', kind: 'extension', icon: 'goal' },
        { name: 'commit', description: '提交', kind: 'extension', icon: 'terminal' },
      ])
      expect(merged.map((c) => c.name)).toEqual(['goal', 'commit'])
      expect(merged[1]).toMatchObject({ name: 'commit', description: '提交', source: 'pi', icon: 'terminal' })
    })

    it('TC1d: 前缀归一——pi 真源带 / 前缀与声明同名 → 去重 1 项（name 统一裸名）', () => {
      const registry = registryWithDeclared([['goal', '创建目标']])
      const merged = registry.resolveSlashCommands([{ name: '/goal', kind: 'extension', icon: 'goal' }])
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ name: 'goal', description: '创建目标', source: 'both' })
    })

    it('TC1e: 无声明（registry 空）→ 纯 pi 真源透传（退化=现状行为）', () => {
      const registry = registryWithDeclared([])
      const merged = registry.resolveSlashCommands([{ name: 'commit', description: '提交', kind: 'extension', icon: 'terminal' }])
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ name: 'commit', source: 'pi' })
    })
  })

  describe('CommandRegistry.execute（TC-2 激活→执行 + TC-4 ERR6）', () => {
    it('TC-2a: execute 触发 ensureActivated(\'p1\',\'onCommand\') + executor.execute(id, args)，顺序先激活后执行', async () => {
      const { activationTrigger, activationManager, executeFn, registry } = setup()
      registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
      activationManager.registerActivationEvents('p1', ['onCommand'])
      await registry.execute('p1.hello', { x: 1 })
      expect(activationTrigger).toHaveBeenCalledWith('p1', 'onCommand')
      expect(executeFn).toHaveBeenCalledWith('p1.hello', { x: 1 })
      // 顺序：激活先于执行
      expect(activationTrigger.mock.invocationCallOrder[0]).toBeLessThan(
        executeFn.mock.invocationCallOrder[0],
      )
    })

    it('TC-2b: 未声明 onCommand 激活事件的 plugin → ensureActivated no-op，但命令仍执行', async () => {
      const { activationTrigger, executeFn, registry } = setup()
      registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
      // 不 registerActivationEvents → no-op 不阻塞
      await registry.execute('p1.hello')
      expect(activationTrigger).not.toHaveBeenCalled()
      expect(executeFn).toHaveBeenCalledWith('p1.hello', undefined)
    })

    it('TC-4a: execute 未注册 id → ERR6 error 事件（kind/source/message）+ resolve 不 throw + executor 零调用', async () => {
      const { emit, executeFn, registry } = setup()
      await expect(registry.execute('ghost.command')).resolves.toBeUndefined()
      const err = emit.mock.calls.map((c) => c[0]).find((e) => e.kind === 'error')
      expect(err).toBeDefined()
      expect(err).toMatchObject({
        kind: 'error',
        source: 'CommandRegistry',
      })
      expect((err as { message: string }).message).toContain('command not found: ghost.command')
      expect(executeFn).not.toHaveBeenCalled()
    })

    it('TC-4b: unregisterCommand 后 get()===undefined + execute 走未注册路径', async () => {
      const { emit, executeFn, registry } = setup()
      registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
      registry.unregisterCommand('p1.hello')
      expect(registry.get('p1.hello')).toBeUndefined()
      await registry.execute('p1.hello')
      expect(executeFn).not.toHaveBeenCalled()
      expect(emit.mock.calls.some((c) => c[0].kind === 'error')).toBe(true)
    })

    it('TC-4c: 执行失败（executor reject）→ execute reject 上抛（不静默吞）', async () => {
      const { registry } = setup()
      registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
      const failingExecutor: CommandExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('exec failed')),
      }
      const reg2 = new CommandRegistry({
        bus: new InternalEventBus(),
        activationManager: new ActivationManager({ trigger: { ensureActivated: vi.fn() } }),
        executor: failingExecutor,
      })
      reg2.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
      await expect(reg2.execute('p1.hello')).rejects.toThrow('exec failed')
    })

    it('TC-4d: 激活失败（trigger reject）→ execute reject 上抛', async () => {
      const failingTrigger: ActivationTrigger = {
        ensureActivated: vi.fn().mockRejectedValue(new Error('activate failed')),
      }
      const am = new ActivationManager({ trigger: failingTrigger })
      am.registerActivationEvents('p1', ['onCommand'])
      const reg2 = new CommandRegistry({
        bus: new InternalEventBus(),
        activationManager: am,
        executor: { execute: vi.fn() },
      })
      reg2.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
      await expect(reg2.execute('p1.hello')).rejects.toThrow('activate failed')
    })
  })
});

// ======== 来源：contribution-registry.test.ts ========
describe("contribution-registry", () => {
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
      mounts.register('panel.header') // 只注册 panel.header
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
      mounts.register('sidebar.tab')
      registry.registerContribution({
        pluginId: 'p1',
        contributionId: 'v1',
        type: 'view',
        placement: 'sidebar.tab', // 已注册
        available: false,
        view: { viewType: 'gui', title: 'My View', initialVisibility: 'hidden' },
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
    it('TC-5a: registerBuiltin 注册 tasks slashCommand 骨架', () => {
      const { registry, mounts } = setup()
      mounts.register('slash')
      registry.registerBuiltin()
      const all = registry.getContributions()
      const tasks = all.filter((c) => c.pluginId === 'tasks')
      const taskSlash = tasks.filter((c) => c.type === 'slashCommand')
      expect(taskSlash.map((t) => t.slashCommand?.name)).toEqual(['goal', 'todo'])
      registry.routeAll(mounts)
      expect(taskSlash.every((t) => t.available)).toBe(true)
    })

    it('TC-5b: builtin 插件骨架与 manifest 声明一致', () => {
      // composer-task-tray D10：「后台命令」view 贡献随该 native 视图退役
      // scheduler-manager 为 headerAction 徽标入口 + overlay 定时任务 tab 内容树供给插件；
      // scheduler 保留 /schedule slash 声明（ADR-0050：landing 态 pi 真源为空、声明即显示，
      // 执行由 pi extension 承担——与 manager 的 GUI 管理侧职责不重叠）
      expect(builtinContributions.map((b) => b.pluginId)).toEqual(['tasks', 'scheduler-manager', 'scheduler'])
      expect(builtinContributions[0].contributes.slashCommands).toHaveLength(2)
      expect(builtinContributions[2].contributes.slashCommands).toHaveLength(1) // 发现侧单条 schedule（pi 侧 scheduler/schedule 同 handler，按用户裁决单条展示）
      // tasks 不声明 views——todo/goal 经 extension widget 推送由 Composer 托盘 widget 区承接，
      // 不进 sidebar（D5）；该视图退役后 builtin 整体零 view 声明
      expect(builtinContributions[0].contributes.views).toBeUndefined()
      expect(builtinContributions.every((b) => b.contributes.views === undefined)).toBe(true)
      // scheduler-manager 声明形状：headerActions 1（activation 直开声明，
      // 无 commandId）+ commands 3（overlay 树内 action-bar 写操作 toggle/run/delete——缺
      // 声明则写操作在 CommandRegistry 无注册通路成死链，id 与插件 api.commands.register 逐字一致）。
      // 声明类型范围无 modals 键（无法再产出该类声明）。
      expect(builtinContributions[1].contributes.headerActions).toHaveLength(1)
      expect(builtinContributions[1].contributes.commands).toHaveLength(3)
      expect(builtinContributions[1].contributes.commands?.map((c) => c.command)).toEqual([
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
          slashCommands: [{ name: 'hello', description: 'hi' }],
          configuration: { properties: { a: { type: 'string' } } },
        },
      }
      registry.loadExternal([d])
      const all = registry.getContributions({ pluginId: 'ext1' })
      expect(all.map((c) => c.type).sort()).toEqual([
        'command', 'configuration', 'menu', 'slashCommand', 'view',
      ])
      expect(all.find((c) => c.type === 'view')?.placement).toBe('sidebar.tab')
      expect(all.find((c) => c.type === 'menu')?.placement).toBe('composer.toolbar')
      expect(all.find((c) => c.type === 'command')?.placement).toBe('commands')
      expect(all.find((c) => c.type === 'slashCommand')?.placement).toBe('slash')
      expect(all.find((c) => c.type === 'configuration')?.placement).toBe('settings')
    })

    it('TC-5h: 跨 type 输出顺序固定（view→menu→command→slashCommand→configuration）', () => {
      // contributes 字段按逆序声明，验证解析顺序由 parseContributes 的段 concat 顺序决定，
      // 与 descriptor 字段声明顺序无关（注册顺序契约：同 placement 下先注册先排位）
      const { registry } = setup()
      registry.loadExternal([{
        pluginId: 'ord1',
        contributes: {
          configuration: { properties: { a: { type: 'string' } } },
          slashCommands: [{ name: 's1', description: '' }],
          commands: [{ command: 'c1', title: '' }],
          menus: { 'composer.toolbar': [{ command: 'm1' }] },
          views: [{ id: 'v1', title: '', placement: 'sidebar.tab' }],
        },
      }])
      expect(registry.getContributions({ pluginId: 'ord1' }).map((c) => c.type)).toEqual([
        'view', 'menu', 'command', 'slashCommand', 'configuration',
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
      expect(registry.getContributions({ type: 'slashCommand' }).map((c) => c.slashCommand?.name)).toEqual(['goal', 'todo', 'schedule'])
      // 2 tasks slashCommands + scheduler-manager 4 条（1 headerAction + 3 commands）+ scheduler 1 条 slashCommand
      expect(registry.getContributions()).toHaveLength(7)
    })
  })

  // ── 新点位：headerAction（AP-1）───────────────────────────────────────

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

    it('AP-1b: loadExternal 解析 headerActions 段，type-specific payload 可读', () => {
      const { registry } = setup()
      registry.loadExternal([{
        pluginId: 'sched',
        contributes: {
          headerActions: [{ id: 'sched.open', title: '定时任务', icon: 'clock', commandId: 'sched.open', order: 20 }],
        },
      }])
      const all = registry.getContributions({ pluginId: 'sched' })
      expect(all.map((c) => c.type)).toEqual(['headerAction'])
      expect(all[0].placement).toBe('panel.header')
      expect(all[0].headerAction).toEqual({ title: '定时任务', icon: 'clock', commandId: 'sched.open', order: 20 })
    })

    it('AP-1c: headerAction 声明 activation/commandId 可选键透传到 ContributionRecord（声明驱动分派键，渲染端消费）', () => {
      const { registry } = setup()
      registry.loadExternal([{
        pluginId: 'sched',
        contributes: {
          headerActions: [
            // overlay 直开声明：无 commandId（点击走 overlay 分派，不经命令链）
            { id: 'sched.open', title: '定时任务', icon: 'clock', order: 20, activation: 'scheduler-overlay' },
            // 命令链声明：带 commandId、无 activation
            { id: 'sched.cmd', title: 'Cmd', icon: 'clock', commandId: 'sched.cmd' },
          ],
        },
      }])
      const all = registry.getContributions({ pluginId: 'sched', type: 'headerAction' })
      const byId = new Map(all.map((c) => [c.contributionId, c]))
      // overlay 声明：activation 透传（renderer 按 activation 分派点击，core 不消费）、commandId 保持 undefined
      expect(byId.get('sched.open')?.headerAction?.activation).toBe('scheduler-overlay')
      expect(byId.get('sched.open')?.headerAction?.commandId).toBeUndefined()
      // 命令链声明：commandId 透传、activation 保持 undefined（渲染端按缺省走命令链）
      expect(byId.get('sched.cmd')?.headerAction?.commandId).toBe('sched.cmd')
      expect(byId.get('sched.cmd')?.headerAction?.activation).toBeUndefined()
    })

    it('AP-1d: builtin scheduler-manager 声明带 activation=scheduler-overlay 且经 registerBuiltin 透传', () => {
      // builtin 字面量声明侧（modal 链退役：声明无 commandId，点击走 overlay 分派）
      const builtinHa = builtinContributions[1].contributes.headerActions?.[0]
      expect(builtinHa?.activation).toBe('scheduler-overlay')
      expect(builtinHa?.commandId).toBeUndefined()
      // registerBuiltin 解析后 record 侧同键（renderer 声明镜像消费的就是 record）
      const { registry } = setup()
      registry.registerBuiltin()
      const rec = registry.getContributions({ pluginId: 'scheduler-manager', type: 'headerAction' })[0]
      expect(rec.contributionId).toBe('scheduler-manager.open')
      expect(rec.headerAction?.activation).toBe('scheduler-overlay')
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
        contributes: { headerActions: [{ id: 'p1.open', title: 'T', icon: 'clock', commandId: 'p1.open' }] },
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

    it('E2e: plugin-crashed 广播 → 订阅回调 clearForPlugin（含 headerAction 新点位）', () => {
      const { bus, registry } = setup()
      registry.loadExternal([{
        pluginId: 'p1',
        contributes: {
          headerActions: [{ id: 'p1.open', title: 'T', icon: 'clock', commandId: 'p1.open' }],
          commands: [{ command: 'p1.cmd', title: 'C' }],
        },
      }])
      bus.on('plugin-crashed', (e) => registry.clearForPlugin(e.pluginId))
      expect(registry.getContributions({ pluginId: 'p1' })).toHaveLength(2)
      bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
      expect(registry.getContributions({ pluginId: 'p1' })).toEqual([])
    })
  })
});

// ======== 来源：header-action-store.test.ts ========
describe("header-action-store", () => {
  function makeStore() {
    const bus = new InternalEventBus()
    const sessionScoped = createSessionScopedMap(() => new Map<string, HeaderActionEntry>())
    const store = new HeaderActionStore({ bus, sessionScoped })
    store.subscribe()
    return { bus, sessionScoped, store }
  }

  describe('HeaderActionStore', () => {
    describe('plugin:headerActionUpdate 帧消费（AP-1）', () => {
      it('帧 → set 写入，get 读回全字段', () => {
        const { bus, store } = makeStore()
        bus.emit({
          kind: 'plugin:headerActionUpdate',
          headerAction: { pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '3', tooltip: '3 启用', disabled: false },
        })
        expect(store.get('s1', 'scheduler-manager.open')).toMatchObject({
          headerActionId: 'scheduler-manager.open',
          pluginId: 'scheduler-manager',
          badge: '3',
          tooltip: '3 启用',
          disabled: false,
        })
      })

      it('可选字段缺省 → 条目对应键 undefined', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'plugin:headerActionUpdate', headerAction: { pluginId: 'p1', headerActionId: 'a1', sessionId: 's1' } })
        const entry = store.get('s1', 'a1')
        expect(entry).toBeDefined()
        expect(entry!.badge).toBeUndefined()
        expect(entry!.tooltip).toBeUndefined()
        expect(entry!.disabled).toBeUndefined()
        expect(entry!.hidden).toBeUndefined()
      })

      it('hidden 字段随帧透传（true/false 均入 store，缺省 undefined）', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'plugin:headerActionUpdate', headerAction: { pluginId: 'p1', headerActionId: 'a1', sessionId: 's1', hidden: true } })
        expect(store.get('s1', 'a1')!.hidden).toBe(true)
        bus.emit({ kind: 'plugin:headerActionUpdate', headerAction: { pluginId: 'p1', headerActionId: 'a1', sessionId: 's1', hidden: false } })
        expect(store.get('s1', 'a1')!.hidden).toBe(false)
      })
    })

    describe('per-session 分区写读', () => {
      it("s1/s2 同 headerActionId 各存各的（多会话徽标互不串，场景 9）", () => {
        const { store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.set('s2', 'a1', { pluginId: 'p1', badge: '7' })
        expect(store.get('s1', 'a1')!.badge).toBe('3')
        expect(store.get('s2', 'a1')!.badge).toBe('7')
      })

      it('同 session 不同 headerActionId 互不影响', () => {
        const { store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.set('s1', 'a2', { pluginId: 'p1', disabled: true })
        expect(store.get('s1', 'a1')!.badge).toBe('3')
        expect(store.get('s1', 'a1')!.disabled).toBeUndefined()
        expect(store.get('s1', 'a2')!.disabled).toBe(true)
      })

      it('set 覆盖语义：同 (sessionId, headerActionId) 二次写入以最新为准（幂等收敛）', () => {
        const { store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.set('s1', 'a1', { pluginId: 'p1', badge: '2' })
        expect(store.get('s1', 'a1')!.badge).toBe('2')
      })

      it('set 覆盖语义对 hidden 同样成立（帧缺 hidden → 条目 hidden 归 undefined）', () => {
        const { store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', hidden: true })
        expect(store.get('s1', 'a1')!.hidden).toBe(true)
        store.set('s1', 'a1', { pluginId: 'p1' })
        expect(store.get('s1', 'a1')!.hidden).toBeUndefined()
      })

      it('未写入的键 get 返回 undefined（声明侧静态形状不在本 store）', () => {
        const { store } = makeStore()
        expect(store.get('s1', 'nope')).toBeUndefined()
        expect(store.get('s1', 'a1')).toBeUndefined()
      })
    })

    describe('session-destroyed → clearForSession（ERR4 同族）', () => {
      it('事件触发分区清空', () => {
        const { bus, sessionScoped, store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
        expect(sessionScoped.has('s1')).toBe(false)
        expect(store.get('s1', 'a1')).toBeUndefined()
      })

      it('clearForSession 幂等（二次调用不抛、其他分区不受扰）', () => {
        const { bus, store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.set('s2', 'a1', { pluginId: 'p1', badge: '7' })
        bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
        bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
        expect(store.get('s1', 'a1')).toBeUndefined()
        expect(store.get('s2', 'a1')!.badge).toBe('7')
      })
    })

    describe('clearForPlugin（AP-1 生命周期：崩溃/禁用/卸载）', () => {
      it('跨会话清该插件条目，其他插件保留', () => {
        const { store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.set('s1', 'a2', { pluginId: 'p2', badge: '1' })
        store.set('s2', 'a1', { pluginId: 'p1', badge: '7' })
        store.clearForPlugin('p1')
        expect(store.get('s1', 'a1')).toBeUndefined()
        expect(store.get('s2', 'a1')).toBeUndefined()
        expect(store.get('s1', 'a2')!.badge).toBe('1')
      })

      it('清空后变空的分区整体移除（不留空 Map）', () => {
        const { sessionScoped, store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.clearForPlugin('p1')
        expect(sessionScoped.has('s1')).toBe(false)
      })

      it('幂等：无匹配条目 / 重复调用 no-op', () => {
        const { store } = makeStore()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.clearForPlugin('pX')
        store.clearForPlugin('pX')
        expect(store.get('s1', 'a1')!.badge).toBe('3')
        store.clearForPlugin('p1')
        store.clearForPlugin('p1')
        expect(store.get('s1', 'a1')).toBeUndefined()
      })
    })

    describe('onChange 响应式粘合（ViewHostStore 同范式）', () => {
      it('set / clearForSession / clearForPlugin 触发监听；unsubscribe 后不再触发', () => {
        const { store } = makeStore()
        const fn = vi.fn()
        const unsub = store.onChange(fn)
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        store.clearForSession('s1')
        store.clearForPlugin('p1')
        expect(fn).toHaveBeenCalledTimes(3)
        unsub()
        store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
        expect(fn).toHaveBeenCalledTimes(3)
      })
    })
  })
});

// ======== 来源：internal-event-bus.test.ts ========
describe("internal-event-bus", () => {
  describe('InternalEventBus', () => {
    it('TC-3a: emit 后 handler 同步收到（emit 返回即已执行）', () => {
      const bus = new InternalEventBus()
      const handler = vi.fn()
      bus.on('plugin-crashed', handler)
      bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
      expect(handler).toHaveBeenCalledTimes(1)
      const e = handler.mock.calls[0]?.[0] as Extract<InternalEvent, { kind: 'plugin-crashed' }>
      expect(e.kind).toBe('plugin-crashed')
      expect(e.pluginId).toBe('p1')
    })

    it('TC-3b: unsubscribe 后不再收到', () => {
      const bus = new InternalEventBus()
      const handler = vi.fn()
      const unsub = bus.on('plugin-crashed', handler)
      unsub()
      bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('TC-3c: 多 consumer 各自收到', () => {
      const bus = new InternalEventBus()
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('session-destroyed', h1)
      bus.on('session-destroyed', h2)
      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
    })

    it('TC-3d: 未订阅的 kind 不误触发', () => {
      const bus = new InternalEventBus()
      const handler = vi.fn()
      bus.on('plugin-crashed', handler)
      bus.emit({ kind: 'extension-notify', notification: { pluginId: 'p1', message: 'hi' } })
      expect(handler).not.toHaveBeenCalled()
    })

    it('TC-3e: 同 handler 重复订阅去重（Set 语义）', () => {
      const bus = new InternalEventBus()
      const handler = vi.fn()
      bus.on('plugin-crashed', handler)
      bus.on('plugin-crashed', handler)
      bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('MockMessageSource', () => {
    it('TC-6a: emit → handler 收到；unsubscribe 后不再收', () => {
      const src = new MockMessageSource()
      const handler = vi.fn()
      const unsub = src.subscribe(handler)
      src.emit({ type: 'plugin:notification', sessionId: 's1', payload: {} })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ type: 'plugin:notification', sessionId: 's1' })
      unsub()
      src.emit({ type: 'plugin:crashed', payload: {} })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('TC-6b: listenerCount 反映订阅数（防 listener 翻倍）', () => {
      const src = new MockMessageSource()
      const unsub1 = src.subscribe(() => {})
      src.subscribe(() => {})
      expect(src.listenerCount()).toBe(2)
      unsub1()
      expect(src.listenerCount()).toBe(1)
    })
  })
});

// ======== 来源：message-bus-bridge.test.ts ========
describe("message-bus-bridge", () => {
  function makeBridge() {
    const source = new MockMessageSource()
    const bus = new InternalEventBus()
    const bridge = new MessageBusBridge({ source, bus })
    return { source, bus, bridge }
  }

  /** emit 后收集 bus 上所有事件（spy on emit）。 */
  function spyEmit(bus: InternalEventBus) {
    const emitted: InternalEvent[] = []
    const spy = vi.spyOn(bus, 'emit')
    spy.mockImplementation((e) => {
      emitted.push(e)
      return
    })
    return { emitted, spy }
  }

  describe('MessageBusBridge', () => {
    beforeEach(() => {
      vi.restoreAllMocks()
    })

    describe('AC8: 10 个 plugin:* 每个 type 都 emit 对应 InternalEvent（无零订阅）', () => {
      it('permissionRequest → plugin-permission-request（permissions 数组完整透传、合成 requestId）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        // 多权限场景：runtime 一次可申请多个权限，数组必须完整透传（不收敛为单数）
        source.emit({ type: 'plugin:permissionRequest', payload: { pluginId: 'tasks', permissions: ['fs.write', 'shell.exec'] } })
        const e = emitted.find((x) => x.kind === 'plugin-permission-request')
        expect(e).toBeDefined()
        expect(e).toMatchObject({
          kind: 'plugin-permission-request',
          request: { pluginId: 'tasks', permissions: ['fs.write', 'shell.exec'], requestId: 'perm_tasks' },
        })
      })

      it('permissionRequest payload 带 requestId → 透传真值（不合成；expired 按 requestId 精确撤窗的依据）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:permissionRequest', payload: { pluginId: 'tasks', permissions: ['fs.write'], requestId: 'req-real-1' } })
        const e = emitted.find((x) => x.kind === 'plugin-permission-request')
        expect(e).toMatchObject({
          kind: 'plugin-permission-request',
          request: { pluginId: 'tasks', requestId: 'req-real-1' },
        })
      })

      it('permissionRequestResolved → plugin-permission-request-resolved（requestId/approved 透传真值）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({
          type: 'plugin:permissionRequestResolved',
          payload: { pluginId: 'tasks', requestId: 'req-real-1', approved: true },
        })
        const e = emitted.find((x) => x.kind === 'plugin-permission-request-resolved')
        expect(e).toBeDefined()
        expect(e).toMatchObject({
          kind: 'plugin-permission-request-resolved',
          resolved: { pluginId: 'tasks', requestId: 'req-real-1', approved: true },
        })
      })

      it('permissionRequestResolved payload 缺 requestId（旧版广播）→ requestId 置空串（消费端回退 pluginId 匹配，不合成伪 id）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({
          type: 'plugin:permissionRequestResolved',
          payload: { pluginId: 'tasks', approved: false },
        })
        const e = emitted.find((x) => x.kind === 'plugin-permission-request-resolved')
        expect(e).toMatchObject({
          kind: 'plugin-permission-request-resolved',
          resolved: { pluginId: 'tasks', requestId: '', approved: false },
        })
        // 空串是消费端回退分支的信号，不能被 error 帧顶掉（ERR2 只对整包坏形状发 error）
        expect(emitted.some((x) => x.kind === 'error')).toBe(false)
      })

      it('crashed → plugin-crashed', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:crashed', payload: { pluginId: 'tasks', workerId: 'w1', error: 'boom' } })
        const e = emitted.find((x) => x.kind === 'plugin-crashed')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'plugin-crashed', pluginId: 'tasks', error: 'boom' })
      })

      it('notification → plugin-notification', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:notification', payload: { pluginId: 'tasks', level: 'warn', message: 'low quota' } })
        const e = emitted.find((x) => x.kind === 'plugin-notification')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'plugin-notification', notification: { pluginId: 'tasks', level: 'warn', message: 'low quota' } })
      })

      it('config → plugin-config-changed', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:config', payload: { pluginId: 'tasks', config: { apiKey: 'x' } } })
        const e = emitted.find((x) => x.kind === 'plugin-config-changed')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'plugin-config-changed', pluginId: 'tasks', config: { apiKey: 'x' } })
      })

      it('messageDecoration → plugin-message-decoration', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:messageDecoration', payload: { messageId: 'm1', decoration: { bold: true } } })
        const e = emitted.find((x) => x.kind === 'plugin-message-decoration')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'plugin-message-decoration', decoration: { messageId: 'm1', decoration: { bold: true } } })
      })

      it('statusChange → plugin-status-change（newStatus 优先）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:statusChange', payload: { pluginId: 'tasks', oldStatus: 'active', newStatus: 'inactive' } })
        const e = emitted.find((x) => x.kind === 'plugin-status-change')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'plugin-status-change', pluginId: 'tasks', status: 'inactive' })
      })

      it('uiRequest → ui-request（kind=method）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:uiRequest', payload: { requestId: 'r1', pluginId: 'tasks', method: 'confirm', title: '确认？' } })
        const e = emitted.find((x) => x.kind === 'ui-request')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'ui-request', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm', title: '确认？', method: 'confirm' } })
      })

      it('10 个 plugin:* 全部有 handler，无零订阅（kind 集合与 IF3 映射表逐一核对）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        const messages: IncomingPluginMessage[] = [
          { type: 'plugin:permissionRequest', payload: { pluginId: 'p', permissions: ['fs.write'] } },
          { type: 'plugin:crashed', payload: { pluginId: 'p', workerId: 'w', error: 'e' } },
          { type: 'plugin:notification', payload: { pluginId: 'p', message: 'm' } },
          { type: 'plugin:config', payload: { pluginId: 'p', config: {} } },
          { type: 'plugin:messageDecoration', payload: { messageId: 'm1' } },
          { type: 'plugin:statusChange', payload: { pluginId: 'p', oldStatus: 'active', newStatus: 'inactive' } },
          { type: 'plugin:uiRequest', payload: { requestId: 'r1', pluginId: 'p', method: 'input' } },
          // MF-1：plugin:viewUpdate 下行（runtime handleViewUpdate 广播形状）→ extension-widget
          { type: 'plugin:viewUpdate', payload: { sessionId: 's1', viewId: 'sidebar.tab', pluginId: 'p', guiTree: [{ type: 'ansi-text', props: { lines: ['hi'] } }], updatedAt: 1 } },
        ]
        for (const m of messages) source.emit(m)
        const expectedKinds = [
          'plugin-permission-request',
          'plugin-crashed',
          'plugin-notification',
          'plugin-config-changed',
          'plugin-message-decoration',
          'plugin-status-change',
          'ui-request',
          'extension-widget',
        ]
        for (const kind of expectedKinds) {
          expect(emitted.some((x) => x.kind === kind), `expected ${kind} emitted`).toBe(true)
        }
        expect(emitted.some((x) => x.kind === 'error')).toBe(false)
        expect(emitted.length).toBe(8)
      })

      it('viewUpdate → extension-widget（sessionId 透传、viewId/pluginId/guiTree 直存，MF-1）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({
          type: 'plugin:viewUpdate',
          payload: { sessionId: 's1', viewId: 'sidebar.tab', pluginId: 'tasks', guiTree: [{ type: 'stats-line', props: { items: [] } }], updatedAt: 123 },
        })
        const e = emitted.find((x) => x.kind === 'extension-widget')
        expect(e).toBeDefined()
        expect(e).toMatchObject({
          kind: 'extension-widget',
          sessionId: 's1',
          widget: { viewId: 'sidebar.tab', pluginId: 'tasks', guiTree: [{ type: 'stats-line', props: { items: [] } }] },
        })
        // 非法形状（guiTree 非数组）→ error 事件（ERR2 不静默吞）
        source.emit({ type: 'plugin:viewUpdate', payload: { sessionId: 's1', viewId: 'v', pluginId: 'p', guiTree: 'nope' } })
        expect(emitted.some((x) => x.kind === 'error')).toBe(true)
      })

      it('viewUpdate 全局域（U2）：mountId 归属 → mountId 事件形态 + generation 透传', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({
          type: 'plugin:viewUpdate',
          payload: { mountId: 'provider.authorize', viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['auth'] } }], updatedAt: 1, generation: 3 },
        })
        const e = emitted.find((x) => x.kind === 'extension-widget')
        expect(e).toMatchObject({
          kind: 'extension-widget',
          mountId: 'provider.authorize',
          widget: { viewId: 'flow', pluginId: 'plug-a', generation: 3 },
        })
        expect((e as { sessionId?: string }).sessionId).toBeUndefined()
      })

      it.each([
        ['都缺（无 sessionId 无 mountId）', { viewId: 'v', pluginId: 'p', guiTree: [] }],
        ['都给（sessionId + mountId）', { sessionId: 's1', mountId: 'provider.authorize', viewId: 'v', pluginId: 'p', guiTree: [] }],
        ['全局域缺 pluginId（分区键无法成形）', { mountId: 'provider.authorize', viewId: 'v', guiTree: [] }],
      ])('viewUpdate 归属非法（U2 二选一）：%s → error 事件（ERR2 不静默吞）', (_label, payload) => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:viewUpdate', payload })
        const errorEvents = emitted.filter((x) => x.kind === 'error')
        expect(errorEvents).toHaveLength(1)
        expect(emitted.some((x) => x.kind === 'extension-widget')).toBe(false)
      })
    })

    describe('FR5: 5 个 extension:* wire type 收敛', () => {
      it('extension:widget → extension-widget（viewId=widgetKey、guiTree=lines）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:widget', payload: { sessionId: 's1', widgetKey: 'terminal', lines: ['line1', 'line2'] } })
        const e = emitted.find((x) => x.kind === 'extension-widget')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'terminal', pluginId: '', guiTree: ['line1', 'line2'] } })
      })

      it('extension:widgetGui → extension-widget（gui 包进 guiTree）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'side', gui: { type: 'container', children: [] } } })
        const e = emitted.find((x) => x.kind === 'extension-widget')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: '', guiTree: [{ type: 'container', children: [] }] } })
      })

      it('extension:widgetGui gui:null → 保留清除语义（[null]）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'side', gui: null } })
        const e = emitted.find((x) => x.kind === 'extension-widget')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', guiTree: [null] } })
      })

      it('extension:notify → extension-notify', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:notify', payload: { sessionId: 's1', message: 'done', level: 'info' } })
        const e = emitted.find((x) => x.kind === 'extension-notify')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'extension-notify', sessionId: 's1', notification: { pluginId: '', message: 'done', level: 'info' } })
      })

      it('extension.dialog → ui-request（与 plugin:uiRequest 归一同一 kind）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension.dialog', payload: { sessionId: 's1', requestId: 'r2', dialogKind: 'select', title: '选择', options: ['a', 'b'] } })
        const e = emitted.find((x) => x.kind === 'ui-request')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r2', pluginId: '', kind: 'select', title: '选择', dialogKind: 'select', options: ['a', 'b'] } })
      })

      it('extension:requestsInvalidated → requests-invalidated（字段逐项透传，P2-2 失效链）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({
          type: 'extension:requestsInvalidated',
          payload: { sessionId: 's1', requestIds: ['req-1', 'req-2'], reason: 'session-closed' },
        })
        const e = emitted.find((x) => x.kind === 'requests-invalidated')
        expect(e).toBeDefined()
        // 整对象精确匹配：锁定 4 字段形状，多字段/少字段漂移都会红
        expect(e).toEqual({ kind: 'requests-invalidated', sessionId: 's1', requestIds: ['req-1', 'req-2'], reason: 'session-closed' })
        expect(emitted.some((x) => x.kind === 'error')).toBe(false)
      })

      it('extension:requestsInvalidated reason 缺省 → "unknown"', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:requestsInvalidated', payload: { sessionId: 's1', requestIds: ['req-1'] } })
        const e = emitted.find((x) => x.kind === 'requests-invalidated')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'requests-invalidated', requestIds: ['req-1'], reason: 'unknown' })
      })

      it('extension:requestsInvalidated requestIds 非数组 / 含非字符串元素 → error（防御分支，不产半成品事件）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:requestsInvalidated', payload: { requestIds: 'req-1' } })
        source.emit({ type: 'extension:requestsInvalidated', payload: { requestIds: ['ok', 42] } })
        const errors = emitted.filter((x) => x.kind === 'error')
        expect(errors).toHaveLength(2)
        expect(errors.every((x) => (x as { source: string }).source === 'extension:requestsInvalidated')).toBe(true)
        expect(emitted.some((x) => x.kind === 'requests-invalidated')).toBe(false)
      })

      it('extension:requestsInvalidated payload 非记录 → error', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:requestsInvalidated', payload: 'nope' })
        const e = emitted.find((x) => x.kind === 'error')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'error', source: 'extension:requestsInvalidated' })
        expect(emitted.some((x) => x.kind === 'requests-invalidated')).toBe(false)
      })

      it('5 个 extension:* wire type 全部收敛，无零订阅', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension:widget', payload: { widgetKey: 'w', lines: [] } })
        source.emit({ type: 'extension:widgetGui', payload: { widgetKey: 'w', gui: null } })
        source.emit({ type: 'extension:notify', payload: { message: 'm' } })
        source.emit({ type: 'extension:requestsInvalidated', payload: { requestIds: ['r1'] } })
        source.emit({ type: 'extension.dialog', payload: { requestId: 'r', dialogKind: 'input' } })
        for (const kind of ['extension-widget', 'extension-notify', 'requests-invalidated', 'ui-request']) {
          expect(emitted.some((x) => x.kind === kind), `expected ${kind} emitted`).toBe(true)
        }
        expect(emitted.some((x) => x.kind === 'error')).toBe(false)
        expect(emitted.length).toBe(5)
      })
    })

    describe('ERR2: 未知 type + payload 解析失败 → error 事件', () => {
      it('未知 type → error（source=msg.type）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'foo.bar', payload: {} })
        const e = emitted.find((x) => x.kind === 'error')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'error', source: 'foo.bar' })
        expect((e as { message: string }).message).toContain('unknown message type: foo.bar')
      })

      it('permissionRequest payload 非 object → error', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:permissionRequest', payload: 'nope' })
        const e = emitted.find((x) => x.kind === 'error')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'error', source: 'plugin:permissionRequest' })
      })

      it('permissionRequestResolved payload 缺 pluginId / approved 非 boolean → error（坏形状不宽容）', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:permissionRequestResolved', payload: { requestId: 'r1', approved: true } })
        source.emit({ type: 'plugin:permissionRequestResolved', payload: { pluginId: 'p', requestId: 'r1', approved: 'yes' } })
        const errors = emitted.filter((x) => x.kind === 'error')
        expect(errors).toHaveLength(2)
        for (const e of errors) {
          expect(e).toMatchObject({ kind: 'error', source: 'plugin:permissionRequestResolved' })
        }
      })

      it('uiRequest 无 requestId → error', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:uiRequest', payload: { pluginId: 'p', method: 'input' } })
        const e = emitted.find((x) => x.kind === 'error')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'error', source: 'plugin:uiRequest' })
      })

      it('messageDecoration 无 messageId → error', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:messageDecoration', payload: { decoration: {} } })
        const e = emitted.find((x) => x.kind === 'error')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'error', source: 'plugin:messageDecoration' })
      })

      it('statusChange 非法 status → error', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:statusChange', payload: { pluginId: 'p', oldStatus: 'active', newStatus: 'zzz' } })
        const e = emitted.find((x) => x.kind === 'error')
        expect(e).toBeDefined()
        expect(e).toMatchObject({ kind: 'error', source: 'plugin:statusChange' })
      })
    })

    describe('dispose 防泄漏（C3 契约）', () => {
      it('dispose 后 listenerCount 归 0 且 emit 无新事件', () => {
        const { source, bus, bridge } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:crashed', payload: { pluginId: 'p', error: 'e' } })
        expect(emitted.length).toBe(1)
        expect(source.listenerCount()).toBe(1)

        bridge.dispose()
        expect(source.listenerCount()).toBe(0)

        emitted.length = 0
        source.emit({ type: 'plugin:notification', payload: { pluginId: 'p', message: 'm' } })
        expect(emitted.length).toBe(0)
      })

      it('dispose 幂等（重复调用安全）', () => {
        const { source, bridge } = makeBridge()
        bridge.dispose()
        expect(source.listenerCount()).toBe(0)
        bridge.dispose()
        expect(source.listenerCount()).toBe(0)
      })
    })

    describe('窄化映射抽查', () => {
      it('uiRequest method=editor → kind 兜底 "input" + 原始 method 经索引签名保留', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'plugin:uiRequest', payload: { requestId: 'r1', pluginId: 'p', method: 'editor', prefill: 'x' } })
        const e = emitted.find((x) => x.kind === 'ui-request')
        expect(e).toBeDefined()
        const req = (e as { request: Record<string, unknown> }).request
        expect(req.kind).toBe('input')
        expect(req.method).toBe('editor')
      })

      it('extension.dialog dialogKind=editor 同样兜底', () => {
        const { source, bus } = makeBridge()
        const { emitted } = spyEmit(bus)
        source.emit({ type: 'extension.dialog', payload: { sessionId: 's1', requestId: 'r2', dialogKind: 'editor' } })
        const e = emitted.find((x) => x.kind === 'ui-request')
        expect(e).toBeDefined()
        const req = (e as { request: Record<string, unknown> }).request
        expect(req.kind).toBe('input')
        expect(req.dialogKind).toBe('editor')
      })
    })

    describe('plugin:headerActionUpdate（plugin-header-action-modal-points u4a 表项）', () => {
      /**
     * bridge + 消费端容器全接线（真实 emit 流转）。不用 spyEmit——其 mockImplementation
     * 会整体替换 emit、真实订阅端收不到事件，无法断言 store 状态更新。
     */
      function makeWired() {
        const source = new MockMessageSource()
        const bus = new InternalEventBus()
        const sessionScoped = createSessionScopedMap(() => new Map<string, HeaderActionEntry>())
        const store = new HeaderActionStore({ bus, sessionScoped })
        store.subscribe()
        const bridge = new MessageBusBridge({ source, bus })
        const headerEvents: Extract<InternalEvent, { kind: 'plugin:headerActionUpdate' }>[] = []
        const errors: InternalEvent[] = []
        bus.on('plugin:headerActionUpdate', (e) => headerEvents.push(e))
        bus.on('error', (e) => errors.push(e))
        return { source, bridge, store, sessionScoped, headerEvents, errors }
      }

      it('headerActionUpdate 帧 → store 按 (sessionId, headerActionId) 分区写入', () => {
        const { source, store, headerEvents, errors } = makeWired()
        source.emit({
          type: 'plugin:headerActionUpdate',
          payload: { pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '3', tooltip: '3 启用', disabled: false },
        })
        expect(headerEvents).toHaveLength(1)
        expect(store.get('s1', 'scheduler-manager.open')).toMatchObject({
          pluginId: 'scheduler-manager', badge: '3', tooltip: '3 启用', disabled: false,
        })
        expect(errors).toHaveLength(0)
      })

      it('多会话徽标互不串（sessionId 分区正确，AP-1 场景 9）', () => {
        const { source, store } = makeWired()
        source.emit({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p', headerActionId: 'a', sessionId: 's1', badge: '3' } })
        source.emit({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p', headerActionId: 'a', sessionId: 's2', badge: '7' } })
        expect(store.get('s1', 'a')!.badge).toBe('3')
        expect(store.get('s2', 'a')!.badge).toBe('7')
      })

      it('缺 sessionId 帧 → 检查失败丢弃 + error，store 状态不变', () => {
        const { source, store, headerEvents, errors } = makeWired()
        source.emit({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p', headerActionId: 'a', badge: '3' } })
        expect(headerEvents).toHaveLength(0)
        expect(errors.map((e) => (e as { source: string }).source)).toEqual(['plugin:headerActionUpdate'])
        expect(store.get('s1', 'a')).toBeUndefined()
      })

      it('headerActionUpdate 缺 headerActionId → null；disabled 非 boolean → 宽容 undefined', () => {
        expect(parseHeaderActionUpdate({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p', sessionId: 's' } })).toBeNull()
        const r = parseHeaderActionUpdate({
          type: 'plugin:headerActionUpdate',
          payload: { pluginId: 'p', headerActionId: 'a', sessionId: 's', disabled: 'yes' },
        })
        expect(r).not.toBeNull()
        expect((r as { headerAction: { disabled?: boolean } }).headerAction.disabled).toBeUndefined()
      })

      it('未注册帧型 → 既有丢帧语义不回归（unknown message type error，无状态污染）', () => {
        const { source, errors } = makeWired()
        source.emit({ type: 'plugin:someFutureFrame', payload: {} })
        expect(errors).toHaveLength(1)
        expect((errors[0] as { message: string }).message).toBe('unknown message type: plugin:someFutureFrame')
      })
    })
  })
});

// ======== 来源：notification-host-controller.test.ts ========
describe("notification-host-controller", () => {
  function makeController() {
    const bus = new InternalEventBus()
    const showToast = vi.fn()
    const log = vi.fn()
    const controller = new NotificationHostController({ bus, deps: { showToast, log } })
    return { bus, controller, showToast, log }
  }

  describe('NotificationHostController', () => {
    it('extension-notify → showToast 透传 message/level/sessionId', () => {
      const { bus, controller, showToast } = makeController()
      controller.subscribe()

      bus.emit({
        kind: 'extension-notify',
        sessionId: 'sid-1',
        notification: { pluginId: '', message: 'Goal blocked.', level: 'warning' },
      })

      expect(showToast).toHaveBeenCalledWith('Goal blocked.', 'warning', 'sid-1')
    })

    it('plugin-notification → 同形处理，sessionId 一并透传', () => {
      const { bus, controller, showToast } = makeController()
      controller.subscribe()

      bus.emit({
        kind: 'plugin-notification',
        sessionId: 'sid-2',
        notification: { pluginId: 'p', message: 'done', level: 'info' },
      })

      expect(showToast).toHaveBeenCalledWith('done', 'info', 'sid-2')
    })

    it('extension-notify 无 level → undefined 透传（壳按 info 兜底）', () => {
      const { bus, controller, showToast } = makeController()
      controller.subscribe()

      bus.emit({
        kind: 'extension-notify',
        sessionId: 'sid-3',
        notification: { pluginId: '', message: 'no level' },
      })

      expect(showToast).toHaveBeenCalledWith('no level', undefined, 'sid-3')
    })

    it('plugin-crashed → error toast（无 sessionId）', () => {
      const { bus, controller, showToast } = makeController()
      controller.subscribe()

      bus.emit({ kind: 'plugin-crashed', pluginId: 'x', error: 'boom' })

      // 无 session 语义：不传第三参（undefined 由壳兜底处理）
      expect(showToast).toHaveBeenCalledWith('插件 x 崩溃: boom', 'error')
    })

    it('log 降级类事件不弹 toast', () => {
      const { bus, controller, showToast, log } = makeController()
      controller.subscribe()

      bus.emit({ kind: 'plugin-config-changed', pluginId: 'p', config: {} })
      bus.emit({ kind: 'plugin-message-decoration', sessionId: 's', decoration: { messageId: 'm', decoration: {} } })
      bus.emit({ kind: 'plugin-status-change', pluginId: 'p', status: 'active' })
      bus.emit({ kind: 'error', source: 'bridge', message: 'bad frame' })

      expect(showToast).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledTimes(4)
    })

    it('subscribe 幂等：重复调用不重复注册（一次 emit 只一次 showToast）', () => {
      const { bus, controller, showToast } = makeController()
      controller.subscribe()
      controller.subscribe()

      bus.emit({
        kind: 'extension-notify',
        sessionId: 's',
        notification: { pluginId: '', message: 'once' },
      })

      expect(showToast).toHaveBeenCalledTimes(1)
    })

    it('dispose 后不再消费', () => {
      const { bus, controller, showToast } = makeController()
      const dispose = controller.subscribe()
      dispose()

      bus.emit({
        kind: 'extension-notify',
        sessionId: 's',
        notification: { pluginId: '', message: 'gone' },
      })

      expect(showToast).not.toHaveBeenCalled()
    })
  })
});

// ======== 来源：overlay-lifecycle.test.ts ========
describe("overlay-lifecycle", () => {
  function makeOverlay() {
    const bus = new InternalEventBus()
    const sessionScoped = createSessionScopedMap(() => new Map<string, 'expanded' | 'minimized' | 'restored'>())
    const overlay = new OverlayLifecycle({ bus, sessionScoped })
    overlay.subscribe()
    return { bus, sessionScoped, overlay }
  }

  describe('OverlayLifecycle', () => {
    beforeEach(() => {
      // 无全局状态残留
    })

    describe('ui-request 自动建分区（IF9）', () => {
      it('emit ui-request → getState==="expanded"（自动建分区）', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm', title: '确认？' } })
        expect(overlay.getState('s1', 'r1')).toBe('expanded')
      })

      it('ui-request 重复到达已存在分区 → 状态不重置', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        overlay.transition('s1', 'r1', 'minimized')
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        expect(overlay.getState('s1', 'r1')).toBe('minimized')
      })
    })

    describe('状态机迁移（IF9）', () => {
      it('transition expanded→minimized', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        overlay.transition('s1', 'r1', 'minimized')
        expect(overlay.getState('s1', 'r1')).toBe('minimized')
      })

      it('transition minimized→restored', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        overlay.transition('s1', 'r1', 'minimized')
        overlay.transition('s1', 'r1', 'restored')
        expect(overlay.getState('s1', 'r1')).toBe('restored')
      })

      it('非法迁移（restored→expanded 未定义）→ no-op 不抛错 + 状态不变', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        overlay.transition('s1', 'r1', 'minimized')
        overlay.transition('s1', 'r1', 'restored')
        expect(() => overlay.transition('s1', 'r1', 'expanded')).not.toThrow()
        expect(overlay.getState('s1', 'r1')).toBe('restored')
      })
    })

    describe('__global__ 分区（clarify Q2）', () => {
      it('ui-request 无 sessionId → getState("__global__", requestId)==="expanded"', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', request: { requestId: 'r2', pluginId: 'tasks', kind: 'select', title: '选择' } })
        expect(overlay.getState(GLOBAL_OVERLAY_KEY, 'r2')).toBe('expanded')
      })

      it('transition 无 sessionId → 作用 __global__ 分区', () => {
        const { bus, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', request: { requestId: 'r2', pluginId: 'tasks', kind: 'select' } })
        overlay.transition(undefined, 'r2', 'minimized')
        expect(overlay.getState(GLOBAL_OVERLAY_KEY, 'r2')).toBe('minimized')
      })
    })

    describe('ERR4: session-destroyed cleanup', () => {
      it('session-destroyed → 分区清空 + getState undefined', () => {
        const { bus, sessionScoped, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        expect(overlay.getState('s1', 'r1')).toBe('expanded')

        bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
        expect(sessionScoped.has('s1')).toBe(false)
        expect(overlay.getState('s1', 'r1')).toBeUndefined()
      })

      it('__global__ 分区不受 session-destroyed 影响', () => {
        const { bus, sessionScoped, overlay } = makeOverlay()
        bus.emit({ kind: 'ui-request', request: { requestId: 'r2', pluginId: 'tasks', kind: 'select' } })
        bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
        bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
        expect(sessionScoped.has(GLOBAL_OVERLAY_KEY)).toBe(true)
        expect(overlay.getState(GLOBAL_OVERLAY_KEY, 'r2')).toBe('expanded')
      })
    })

    describe('getState 边界', () => {
      it('分区或 requestId 不存在 → undefined', () => {
        const { overlay } = makeOverlay()
        expect(overlay.getState('nope', 'r1')).toBeUndefined()
        expect(overlay.getState('s1', 'nope')).toBeUndefined()
      })
    })
  })
});

// ======== 来源：view-host-store.test.ts ========
describe("view-host-store", () => {
  function makeStore() {
    const bus = new InternalEventBus()
    const sessionScoped = createSessionScopedMap(() => new Map<string, ViewCacheEntry>())
    const store = new ViewHostStore({ bus, sessionScoped })
    store.subscribe()
    return { bus, sessionScoped, store }
  }

  const SESSION_SCOPE = { kind: 'session' as const, sessionId: 's1' }

  describe('ViewHostStore', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    describe('extension-widget 窄化（IF10 + clarify Q1）', () => {
      it('widgetGui（GuiComponent）→ getView 返回原 GuiComponent', () => {
        const { bus, store } = makeStore()
        bus.emit({
          kind: 'extension-widget',
          sessionId: 's1',
          widget: { viewId: 'side', pluginId: 'tasks', guiTree: [{ type: 'card', props: { body: [] } }] },
        })
        const view = store.getView(SESSION_SCOPE, 'side')
        expect(view).toBeDefined()
        expect(view!.guiTree).toHaveLength(1)
        expect(view!.guiTree[0]).toMatchObject({ type: 'card', props: { body: [] } })
      })

      it('meta（v1.1 widget 宿主元数据）合法（title: string）→ 缓存透传', () => {
        const { bus, store } = makeStore()
        const meta = { title: 'Todo', status: 'running', progress: { current: 1, total: 3 } }
        bus.emit({
          kind: 'extension-widget',
          sessionId: 's1',
          widget: { viewId: 'todo', pluginId: '', guiTree: [{ type: 'list-tree', props: { items: [] } }], meta },
        })
        const view = store.getView(SESSION_SCOPE, 'todo')
        expect(view!.meta).toEqual(meta)
      })

      it.each([
        ['undefined（v1 旧 wire 无 meta）', undefined],
        ['null', null],
        ['非对象（字符串）', 'Todo'],
        ['缺 title 字符串', { status: 'running' }],
      ])('meta %s → 缓存条目无 meta 键', (_label, meta) => {
        const { bus, store } = makeStore()
        bus.emit({
          kind: 'extension-widget',
          sessionId: 's1',
          widget: { viewId: 'w', pluginId: '', guiTree: [{ type: 'ansi-text', props: { lines: [] } }], meta },
        })
        const view = store.getView(SESSION_SCOPE, 'w')
        expect(view!.meta).toBeUndefined()
      })

      it('widget（string 行）→ 窄化为 ansi-text GuiComponent', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'terminal', pluginId: '', guiTree: ['line1', 'line2'] } })
        const view = store.getView(SESSION_SCOPE, 'terminal')
        expect(view).toBeDefined()
        expect(view!.guiTree).toHaveLength(2)
        expect(view!.guiTree[0]).toEqual({ type: 'ansi-text', props: { lines: ['line1'] } })
        expect(view!.guiTree[1]).toEqual({ type: 'ansi-text', props: { lines: ['line2'] } })
      })

      it('widgetGui gui:null → invalidate 该 viewId（清除语义）', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: 'tasks', guiTree: [{ type: 'card', props: { body: [] } }] } })
        expect(store.getView(SESSION_SCOPE, 'side')).toBeDefined()

        bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: 'tasks', guiTree: [null] } })
        expect(store.getView(SESSION_SCOPE, 'side')).toBeUndefined()
      })

      it('非法对象项丢弃，合法项保留', () => {
        const { bus, store } = makeStore()
        bus.emit({
          kind: 'extension-widget',
          sessionId: 's1',
          widget: { viewId: 'mixed', pluginId: '', guiTree: [{ type: 'card', props: { body: [] } }, { bad: true }, 'txt'] },
        })
        const view = store.getView(SESSION_SCOPE, 'mixed')
        expect(view).toBeDefined()
        expect(view!.guiTree).toHaveLength(2)
        expect(view!.guiTree[0]).toMatchObject({ type: 'card' })
        expect(view!.guiTree[1]).toMatchObject({ type: 'ansi-text' })
      })

      it('归属缺失（U2：sessionId/mountId 二选一皆无）→ 防御丢弃 + warn 留痕', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'extension-widget', widget: { viewId: 'ghost', pluginId: 'p', guiTree: [{ type: 'card', props: { body: [] } }] } })
        expect(store.getView(SESSION_SCOPE, 'ghost')).toBeUndefined()
        expect(store.getViewIds(SESSION_SCOPE)).toHaveLength(0)
      })
    })

    describe('全局域分区（U2：mountId 归属，插件维度并入键）', () => {
      const AUTHORIZE = { kind: 'global' as const, mountId: 'provider.authorize', pluginId: 'plug-a' }

      it('mountId 事件 → 全局域分区；pluginId 取 widget.pluginId', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['auth'] } }], generation: 1 } })
        const view = store.getView(AUTHORIZE, 'flow')
        expect(view).toBeDefined()
        expect(view!.generation).toBe(1)
        // 同挂载位其他插件分区不可见（S25 前置）
        expect(store.getView({ ...AUTHORIZE, pluginId: 'plug-b' }, 'flow')).toBeUndefined()
      })

      it('S25：双插件同挂载位交替推树互不覆盖', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['A1'] } }] } })
        bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-b', guiTree: [{ type: 'ansi-text', props: { lines: ['B1'] } }] } })
        // A 重推（更新自己分区）
        bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['A2'] } }] } })

        expect(store.getView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow')!.guiTree[0]).toMatchObject({ props: { lines: ['A2'] } })
        expect(store.getView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-b' }, 'flow')!.guiTree[0]).toMatchObject({ props: { lines: ['B1'] } })
      })

      it('gui:null 清除语义作用于全局域分区', () => {
        const { bus, store } = makeStore()
        bus.emit({ kind: 'extension-widget', mountId: 'provider.detail-extra', widget: { viewId: 'extra', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }] } })
        bus.emit({ kind: 'extension-widget', mountId: 'provider.detail-extra', widget: { viewId: 'extra', pluginId: 'plug-a', guiTree: [null] } })
        expect(store.getView({ kind: 'global', mountId: 'provider.detail-extra', pluginId: 'plug-a' }, 'extra')).toBeUndefined()
      })

      it('invalidate(scope) 全清只影响该 scope 分区', () => {
        const { store } = makeStore()
        store.setView(AUTHORIZE, 'v1', { viewId: 'v1', pluginId: 'plug-a', guiTree: [], updatedAt: 1 })
        store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.invalidate(AUTHORIZE)
        expect(store.getView(AUTHORIZE, 'v1')).toBeUndefined()
        expect(store.getView(SESSION_SCOPE, 'v1')).toBeDefined()
      })
    })

    describe('setView / getView / invalidate（IF10）', () => {
      it('setView 手动注入 → getView 返回', () => {
        const { store } = makeStore()
        store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        expect(store.getView(SESSION_SCOPE, 'v1')).toBeDefined()
        expect(store.getView(SESSION_SCOPE, 'v1')!.pluginId).toBe('p1')
      })

      it('invalidate(scope, viewId) 单条清除', () => {
        const { store } = makeStore()
        store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.setView(SESSION_SCOPE, 'v2', { viewId: 'v2', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.invalidate(SESSION_SCOPE, 'v1')
        expect(store.getView(SESSION_SCOPE, 'v1')).toBeUndefined()
        expect(store.getView(SESSION_SCOPE, 'v2')).toBeDefined()
      })

      it('invalidate(scope) 无 viewId 清空该 session 全部 view', () => {
        const { store } = makeStore()
        store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.setView(SESSION_SCOPE, 'v2', { viewId: 'v2', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.invalidate(SESSION_SCOPE)
        expect(store.getView(SESSION_SCOPE, 'v1')).toBeUndefined()
        expect(store.getView(SESSION_SCOPE, 'v2')).toBeUndefined()
      })
    })

    describe('ERR4: session-destroyed cleanup', () => {
      it('session-destroyed → 会话域分区清空 + getView undefined（全局域分区不受影响）', () => {
        const { bus, sessionScoped, store } = makeStore()
        store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.setView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow', { viewId: 'flow', pluginId: 'plug-a', guiTree: [], updatedAt: 1 })

        bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
        expect(sessionScoped.has('session:s1')).toBe(false)
        expect(store.getView(SESSION_SCOPE, 'v1')).toBeUndefined()
        expect(store.getView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow')).toBeDefined()
      })
    })

    describe('跨 session 分区隔离', () => {
      it("'s1'/'s2' 同 viewId 各存各的", () => {
        const { store } = makeStore()
        store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
        store.setView({ kind: 'session', sessionId: 's2' }, 'v1', { viewId: 'v1', pluginId: 'p2', guiTree: [], updatedAt: 2 })
        expect(store.getView(SESSION_SCOPE, 'v1')!.pluginId).toBe('p1')
        expect(store.getView({ kind: 'session', sessionId: 's2' }, 'v1')!.pluginId).toBe('p2')
      })
    })
  })
});
