/**
 * ContentSlotRegistry 单测 —— 容器扩展点统一 §6.1 容器位注册表与四份派生视图（U3）
 * + §5.4/§6.14 失败降级三件套与 §6.13 图标解析单函数（U13，机制在 ../failure-degradation）。
 *
 * 三视角（core headless node 环境，无 DOM——用户可见断言落在 tab 数/顺序/文案来源/
 * 空态键等派生视图锚上，DOM 渲染断言归渲染层接线单元 U6/U7/U8，对齐 drawer registry.test.ts 先例）：
 * - 构建者白盒：声明校验（§6.12 id / §6.9 上限 / §6.1 白名单）、clearForPlugin 归属清理、
 *   响应式快照刷新、findById 全局 id 空间；U13：去重键进程级持存（§6.14）、判定表
 *   行 1-4 确定断言、图标解析单函数（§6.13）；
 * - 使用者黑盒：四份派生视图的「内置 ∪ 声明」成员、§6.16 排序、scope 归属、文案二态、
 *   空态键——用户可见的标签条成员与顺序即这些数组的字面值；
 * - 观察者形态：内置投影与 domain 静态表（RIGHT_DRAWER_REGISTRY / OVERLAY_REGISTRY）
 *   逐条对账（单一事实源：投影失真即红）。
 *
 * 运行：cd packages/core && npx vitest run src/extension-host/__tests__/content-slot-registry.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { watch } from 'vue'
import { RIGHT_DRAWER_REGISTRY, OVERLAY_REGISTRY } from '../../domain/drawer/registry'
import {
  ContentSlotRegistry,
  CONTENT_SLOT_PLACEMENTS,
  HOST_PLUGIN_ID,
  BUILTIN_NAMESPACE,
  HOST_COMPONENT_WHITELIST,
  validateContentSlotId,
  builtinDrawerSlots,
  builtinOverlayTypeViews,
  compareContentSlotOrder,
} from '../content-slot-registry'
import {
  warnFailureOnce,
  resolveContributionIcon,
  normalizeIconKey,
  CONTRIBUTION_ICON_KEYS,
  FALLBACK_CONTRIBUTION_ICON,
  FAILURE_JUDGEMENT_TABLE,
} from '../failure-degradation'
import type {
  ContentSlotDeclaration,
  ContentSlotView,
} from '../content-slot-registry'
import type { SlotFailureKind } from '../failure-degradation'
import { ContributionRegistry } from '../contribution-registry'
import { MountPointRegistry } from '../mount-point-registry'
import { InternalEventBus } from '../internal-event-bus'
import type { InternalEvent } from '../types'

/** 插件声明 fixture 工厂（pluginId='acme-ext'，id 自动带命名空间前缀 §6.12）。 */
function pluginDeclaration(overrides: Partial<ContentSlotDeclaration> = {}): ContentSlotDeclaration {
  return {
    id: 'acme-ext.panel',
    placement: 'drawer.tab',
    label: 'Acme 面板',
    scope: 'session',
    pluginId: 'acme-ext',
    renderer: { kind: 'view', viewId: 'panel' },
    ...overrides,
  }
}

/** 每用例独立注册表（避免模块级状态串扰）；静默本模块 warning（降级路径用例断言 unavailable 而非输出）。 */
function makeRegistry(): ContentSlotRegistry {
  return new ContentSlotRegistry()
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── 内置投影对账（观察者形态：单一事实源，投影失真即红）───────────────────

describe('内置投影与 domain 静态表逐条对账（§6.1 内置 8 项 / 4 kind 的权威源）', () => {
  it('builtinDrawerSlots(RIGHT_DRAWER_REGISTRY)：8 条、id=ui.<content>、renderer host 组件命中白名单、labelKey 直通', () => {
    const slots = builtinDrawerSlots(RIGHT_DRAWER_REGISTRY)
    expect(slots).toHaveLength(8)
    expect(slots.map((s) => s.id)).toEqual([
      'ui.git', 'ui.doc', 'ui.detail', 'ui.subagent', 'ui.bashTask', 'ui.plan', 'ui.btw', 'ui.trace',
    ])
    for (const slot of slots) {
      expect(slot.pluginId).toBe(HOST_PLUGIN_ID)
      expect(slot.placement).toBe('drawer.tab')
      expect(slot.scope).toBe('session')
      expect(slot.renderer).toEqual({
        kind: 'host',
        component: expect.stringMatching(/^(GitPanel|CommandDocPanel|DetailPane|SubagentTab|BackgroundTaskDetailPanel|PlanDocsPanel|BtwPanel|TraceInspector)$/),
      })
      expect((HOST_COMPONENT_WHITELIST as readonly string[]).includes((slot.renderer as { component: string }).component)).toBe(true)
      expect(slot.labelKey).toBeTruthy()
      expect(slot.emptyTextKey).toBeTruthy()
      expect(slot.emptyHintKey).toBeTruthy()
    }
  })

  it('builtinOverlayTypeViews(OVERLAY_REGISTRY)：4 条、kind 序 = OverlayContent 判别联合成员序、workflow openableWithoutData=false（§6.15 runs 保持既有禁用规则）', () => {
    const views = builtinOverlayTypeViews(OVERLAY_REGISTRY)
    expect(views.map((v) => v.kind)).toEqual(['browser', 'workflow', 'scheduler', 'canvas'])
    expect(views.map((v) => v.openableWithoutData)).toEqual([true, false, true, true])
    for (const view of views) {
      expect(view.source).toBe('builtin')
      expect(view.pluginId).toBe(HOST_PLUGIN_ID)
    }
    // [容器扩展点统一 §6.5/U10 层 4] runs（workflow）= 宿主渲染项登记（host + WorkflowVizDag
    // ——DAG/甘特坐标系 + 连线 + 手势需求原语不足，§6.5 明确保留宿主，非待迁遗留）；
    // component 必须命中宿主组件白名单（登记与白名单对账，漂移即本行红）。
    const runs = views.find((v) => v.kind === 'workflow')
    expect(runs?.renderer).toEqual({ kind: 'host', component: 'WorkflowVizDag' })
    expect(HOST_COMPONENT_WHITELIST as readonly string[]).toContain('WorkflowVizDag')
    // 其余内置 kind 不携带 renderer（browser 独立壳 / scheduler 插件推树 / canvas 白名单外不冒登）
    expect(views.find((v) => v.kind === 'browser')?.renderer).toBeUndefined()
    expect(views.find((v) => v.kind === 'scheduler')?.renderer).toBeUndefined()
    expect(views.find((v) => v.kind === 'canvas')?.renderer).toBeUndefined()
  })
})

// ── 声明校验（§6.12 / §6.9 / §6.1 白名单；§5.4 不可用声明降级）─────────────

describe('声明 id 校验（§6.12 命名空间前缀 / 长度 / 字符集）', () => {
  it.each([
    ['no-namespace', 'id 缺命名空间前缀'],
    ['.leading', 'id 缺命名空间前缀'],
    ['trailing.', 'id 缺命名空间前缀'],
    ['wrong-ns.panel', '命名空间不一致'],
    ['ui.panel', '保留命名空间'],
    ['acme-ext.panel extra', '非法字符'],
    [`${'a'.repeat(129)}.panel`, '超 128 字符'],
  ])('非法 id %j 判不可用（invalid-id）且不派生', (id) => {
    expect(validateContentSlotId(id, 'acme-ext')).not.toBeNull()
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [pluginDeclaration({ id })])
    expect(registry.findById('acme-ext.panel')).toHaveLength(0)
    expect(registry.deriveDrawerTabs()).toHaveLength(0)
  })

  it('大写 id 小写归一化后校验通过；合法 id 命中', () => {
    expect(validateContentSlotId('Acme-Ext.Panel', 'acme-ext')).toBeNull()
    expect(validateContentSlotId('acme-ext.panel', 'acme-ext')).toBeNull()
  })

  it('同批声明 id 重复：仅首条生效（后者判不可用丢弃 + 一行 warning，§5.4 声明 id 重复行）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.panel', label: 'first' }),
      pluginDeclaration({ id: 'acme-ext.panel', label: 'second' }),
    ])
    const views = registry.deriveDrawerTabs()
    expect(views).toHaveLength(1)
    expect(views[0].label).toBe('first')
    // 重复条目丢弃（不保留第二条记录）——在册 = 首条可用 + 一行 warning（§5.4 降级告警口径）
    expect(registry.listEntries().filter((e) => e.declaration.pluginId === 'acme-ext')).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('同批声明 id 重复'))
  })

  it('跨调用同 id：重放覆盖（幂等不翻倍，对齐 ContributionRegistry.loadExternal 同族语义）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [pluginDeclaration({ label: 'v1' })])
    registry.loadExternal('acme-ext', [pluginDeclaration({ label: 'v2' })])
    const views = registry.deriveDrawerTabs()
    expect(views).toHaveLength(1)
    expect(views[0].label).toBe('v2')
  })
})

describe('宿主组件白名单（§6.1 硬约束 3：插件只能命中不能创造）', () => {
  it("renderer.kind='host' 缺 component：不派生（missing-component，§6.1 硬约束 1）", () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ renderer: { kind: 'host', component: '' } }),
    ])
    expect(registry.deriveDrawerTabs()).toHaveLength(0)
    expect(registry.listEntries()[0].unavailable).toBe('missing-component')
  })

  it('component 未命中白名单：不派生（component-not-allowed，未命中路径单测）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ renderer: { kind: 'host', component: 'EvilArbitraryComponent' } }),
    ])
    expect(registry.deriveDrawerTabs()).toHaveLength(0)
    expect(registry.listEntries()[0].unavailable).toBe('component-not-allowed')
  })

  it('component 命中白名单内组件：可用（插件只能命中已登记项）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ renderer: { kind: 'host', component: 'GitPanel' } }),
    ])
    const views = registry.deriveDrawerTabs()
    expect(views).toHaveLength(1)
    expect(views[0].renderer).toEqual({ kind: 'host', component: 'GitPanel' })
  })

  it('白名单初始成员 = 三类重可视化宿主组件 + 右抽屉内置 tab 组件（11 员，§6.5 + 既有内置 tab）', () => {
    expect([...HOST_COMPONENT_WHITELIST]).toEqual([
      'MessageStream', 'WorkflowVizDag', 'WorkflowVizGantt',
      'GitPanel', 'CommandDocPanel', 'DetailPane', 'SubagentTab',
      'BackgroundTaskDetailPanel', 'PlanDocsPanel', 'BtwPanel', 'TraceInspector',
    ])
  })
})

describe('文案与排序输入校验（§6.9：P12 外部插件声明是不可信输入）', () => {
  it('label / emptyState.text / emptyState.hint 超 200 字符截断不拒绝（超限截断 + 不牵连其他字段）', () => {
    const registry = makeRegistry()
    const long = 'x'.repeat(201)
    registry.loadExternal('acme-ext', [
      pluginDeclaration({
        label: long,
        emptyState: { text: long, hint: 'hint-ok' },
      }),
    ])
    const view = registry.deriveDrawerTabs()[0]
    expect(view.label).toHaveLength(200)
    expect(view.emptyState?.text).toHaveLength(200)
    expect(view.emptyState?.hint).toBe('hint-ok')
  })

  it('order 超 32 位整数范围按缺省（排内置项之后，§6.9）', () => {
    const registry = makeRegistry()
    registry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ order: 2147483648 }),
    ])
    const views = registry.deriveDrawerTabs()
    expect(views).toHaveLength(9)
    expect(views[8].id).toBe('acme-ext.panel')
  })
})

// ── 四份派生视图（§6.1 四容器表：内置 ∪ 声明、§6.16 排序、scope 归属）────────

describe('右抽屉派生视图（内置 8 项 ∪ 声明项）', () => {
  it('内置 8 项投影：id/labelKey/空态键/host renderer 逐条对账（用户可见 L1 标签锚）', () => {
    const registry = makeRegistry()
    registry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
    const views = registry.deriveDrawerTabs()
    expect(views).toHaveLength(8)
    expect(views.map((v) => v.id)).toEqual(RIGHT_DRAWER_REGISTRY.map((e) => `ui.${e.content}`))
    expect(views.map((v) => v.labelKey)).toEqual(RIGHT_DRAWER_REGISTRY.map((e) => e.labelKey))
    expect(views.map((v) => v.emptyTextKey)).toEqual(RIGHT_DRAWER_REGISTRY.map((e) => e.emptyTextKey))
    expect(views.map((v) => v.emptyHintKey)).toEqual(RIGHT_DRAWER_REGISTRY.map((e) => e.emptyHintKey))
    expect(views.every((v) => v.source === 'builtin' && v.pluginId === HOST_PLUGIN_ID)).toBe(true)
  })

  it('声明项追加在内置项之后（未声明 order，§6.16②）；文案 = 声明原文（§6.16④）', () => {
    const registry = makeRegistry()
    registry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
    registry.loadExternal('acme-ext', [pluginDeclaration()])
    const views = registry.deriveDrawerTabs()
    expect(views).toHaveLength(9)
    expect(views[8].id).toBe('acme-ext.panel')
    expect(views[8].source).toBe('plugin')
    expect(views[8].label).toBe('Acme 面板')
    expect(views[8].labelKey).toBeUndefined()
  })

  it('§6.16 排序：声明 order 插入对应位（10 = 第 2 位）；同值按 pluginId 字典序决胜', () => {
    const registry = makeRegistry()
    registry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
    // 内置 order = 下标×10：git=0 / doc=10 / detail=20……order:10 与 ui.doc 同值，
    // pluginId 'acme-ext' < 'taiji-host' 字典序 → 插件项排前（§6.16③）
    registry.loadExternal('acme-ext', [pluginDeclaration({ order: 10 })])
    const views = registry.deriveDrawerTabs()
    expect(views.map((v) => v.id).slice(0, 3)).toEqual(['ui.git', 'acme-ext.panel', 'ui.doc'])
    // 内置序保持稳定（其余 6 项相对序不变）
    expect(views.map((v) => v.id).slice(3)).toEqual([
      'ui.detail', 'ui.subagent', 'ui.bashTask', 'ui.plan', 'ui.btw', 'ui.trace',
    ])
  })

  it('声明不可用不牵连同批其他声明（§5.4：声明级失败不牵连插件）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.good' }),
      pluginDeclaration({ id: 'bad' }),
    ])
    const views = registry.deriveDrawerTabs()
    expect(views.map((v) => v.id)).toEqual(['acme-ext.good'])
  })
})

describe('浮层派生视图（内置 4 kind ∪ 声明项，§6.8 内容类型表）', () => {
  it('内置 + 插件声明合并：插件项 kind=plugin、contentId=声明 id、排序在内置后', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.overlay', placement: 'overlay.content', label: 'Acme 浮层' }),
    ])
    const views = registry.deriveOverlayContentTypes(builtinOverlayTypeViews(OVERLAY_REGISTRY))
    expect(views).toHaveLength(5)
    expect(views.slice(0, 4).map((v) => v.kind)).toEqual(['browser', 'workflow', 'scheduler', 'canvas'])
    expect(views[4]).toMatchObject({
      kind: 'plugin',
      contentId: 'acme-ext.overlay',
      label: 'Acme 浮层',
      pluginId: 'acme-ext',
    })
    expect(views[4].renderer).toEqual({ kind: 'view', viewId: 'panel' })
  })

  it('无内置入参时仅声明项（缺省空内置；scope 缺省 session 透传、global 保持）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.s1', placement: 'overlay.content' }),
      pluginDeclaration({ id: 'acme-ext.g1', placement: 'overlay.content', scope: 'global' }),
    ])
    const views = registry.deriveOverlayContentTypes()
    expect(views.map((v) => v.scope)).toEqual(['session', 'global'])
  })
})

describe('侧栏与设置页派生视图（内置经 registerBuiltin 登记）', () => {
  it('侧栏：内置三项（taiji-host）∪ 声明项，内置 order = 登记序×10', () => {
    const registry = makeRegistry()
    registry.registerBuiltin([
      { id: 'ui.sessions', placement: 'sidebar.tab', label: 'sessions', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'sessions' } },
      { id: 'ui.files', placement: 'sidebar.tab', label: 'files', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'files' } },
      { id: 'ui.plugins', placement: 'sidebar.tab', label: 'plugins', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'plugins' } },
    ])
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.side', placement: 'sidebar.tab', label: 'Acme 侧栏' }),
    ])
    const views = registry.deriveSidebarTabs()
    expect(views.map((v) => v.id)).toEqual(['ui.sessions', 'ui.files', 'ui.plugins', 'acme-ext.side'])
    expect(views.map((v) => v.source)).toEqual(['builtin', 'builtin', 'builtin', 'plugin'])
  })

  it('设置页：group 归属二级结构；无组归 undefined 组（消费端呈现「其他」）', () => {
    const registry = makeRegistry()
    registry.registerBuiltin([
      { id: 'ui.general', placement: 'settings.section', label: 'general', group: 'general', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'general' } },
      { id: 'ui.appearance', placement: 'settings.section', label: 'appearance', group: 'general', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'appearance' } },
      { id: 'ui.about', placement: 'settings.section', label: 'about', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'about' } },
    ])
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.setting', placement: 'settings.section', group: 'general' }),
    ])
    const groups = registry.deriveSettingsSections()
    expect(groups.map((g) => g.group)).toEqual(['general', undefined])
    expect(groups[0].sections.map((s) => s.id)).toEqual(['ui.general', 'ui.appearance', 'acme-ext.setting'])
    expect(groups[1].sections.map((s) => s.id)).toEqual(['ui.about'])
  })

  it('registerBuiltin 拒绝非保留值 pluginId（宿主渲染项 pluginId 恒为 taiji-host，fail-fast）', () => {
    const registry = makeRegistry()
    expect(() => registry.registerBuiltin([
      pluginDeclaration({ placement: 'sidebar.tab', pluginId: 'acme-ext' }),
    ])).toThrow(/taiji-host/)
  })

  it('registerBuiltin 拒绝非 ui 命名空间 id（内置保留命名空间，fail-fast 出声）', () => {
    const registry = makeRegistry()
    expect(() => registry.registerBuiltin([
      { id: 'wrong-ns.x', placement: 'sidebar.tab', label: 'x', scope: 'session', pluginId: HOST_PLUGIN_ID, renderer: { kind: 'view', viewId: 'x' } },
    ])).toThrow(/内置声明/)
  })
})

// ── 归属清理 + 响应式快照（§7.2 载体；§6.1 硬约束 2）────────────────────

describe('clearForPlugin 归属清理与响应式快照（§7.2）', () => {
  it('清理插件声明；内置项（taiji-host）不被误清（§6.1 硬约束 2）；幂等', () => {
    const registry = makeRegistry()
    registry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
    registry.loadExternal('acme-ext', [pluginDeclaration()])
    expect(registry.deriveDrawerTabs()).toHaveLength(9)
    registry.clearForPlugin('acme-ext')
    expect(registry.deriveDrawerTabs()).toHaveLength(8)
    expect(registry.findById('acme-ext.panel')).toHaveLength(0)
    // 幂等：再清一次 no-op
    registry.clearForPlugin('acme-ext')
    expect(registry.deriveDrawerTabs()).toHaveLength(8)
    // 内置保留值不可清
    registry.clearForPlugin(HOST_PLUGIN_ID)
    expect(registry.deriveDrawerTabs()).toHaveLength(8)
  })

  it('快照整表替换：registerBuiltin/loadExternal/clearForPlugin 各刷新一次（shallowRef 触发）', () => {
    const registry = makeRegistry()
    let triggers = 0
    // flush:'sync'——逐次赋值即触发（默认 pre-flush 会把同一 tick 内多次整表替换批处理成一次，
    // 计数语义变「有变化」而非「变更次数」）
    watch(registry.snapshot, () => { triggers += 1 }, { flush: 'sync' })
    expect(registry.snapshot.value).toHaveLength(0)

    registry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
    expect(registry.snapshot.value).toHaveLength(8)
    registry.loadExternal('acme-ext', [pluginDeclaration()])
    expect(registry.snapshot.value).toHaveLength(9)
    registry.clearForPlugin('acme-ext')
    expect(registry.snapshot.value).toHaveLength(8)
    expect(triggers).toBe(3)
  })

  it('不可用声明不进快照（snapshot = 可用声明整表）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [
      pluginDeclaration({ id: 'acme-ext.good' }),
      pluginDeclaration({ id: 'bad' }),
    ])
    expect(registry.snapshot.value.map((d) => d.id)).toEqual(['acme-ext.good'])
  })
})

// ── 全局 id 空间与排序比较函数（U5 ContainerSlotLookup 查询原语；§6.16 单点）──

describe('findById 全局 id 空间与排序比较（U5 消费面）', () => {
  it('跨插件命中多条全部返回（歧义判定由调用方做，注册表忠实返回）', () => {
    const registry = makeRegistry()
    registry.loadExternal('acme-ext', [pluginDeclaration({ id: 'acme-ext.panel' })])
    registry.loadExternal('bee-ext', [pluginDeclaration({ id: 'bee-ext.panel', pluginId: 'bee-ext' })])
    expect(registry.findById('acme-ext.panel')).toHaveLength(1)
    expect(registry.findById('bee-ext.panel')).toHaveLength(1)
    expect(registry.findById('missing.panel')).toHaveLength(0)
  })

  it('compareContentSlotOrder：order 升序 → pluginId 字典序 → seq 抵达序（§6.16 单点比较）', () => {
    const view = (pluginId: string): ContentSlotView => ({
      id: `${pluginId}.x`, placement: 'drawer.tab', source: 'plugin', pluginId,
      scope: 'session', openableWithoutData: true,
      renderer: { kind: 'view', viewId: 'x' },
    })
    const mk = (v: ContentSlotView, order: number, seq: number) => ({ view: v, order, seq, pluginId: v.pluginId })
    // order 升序
    expect(compareContentSlotOrder(mk(view('a'), 0, 0), mk(view('a'), 10, 1))).toBeLessThan(0)
    // 同值 pluginId 字典序
    expect(compareContentSlotOrder(mk(view('acme'), 10, 5), mk(view('bee'), 10, 1))).toBeLessThan(0)
    // 同值同 pluginId 抵达序
    expect(compareContentSlotOrder(mk(view('acme'), 10, 1), mk(view('acme'), 10, 2))).toBeLessThan(0)
  })

  it('位置族词表四族（CONTENT_SLOT_PLACEMENTS 与 bootstrap 挂载点三新族对齐）', () => {
    expect([...CONTENT_SLOT_PLACEMENTS]).toEqual([
      'drawer.tab', 'overlay.content', 'sidebar.tab', 'settings.section',
    ])
    expect(BUILTIN_NAMESPACE).toBe('ui')
  })
})

// ── §5.4 失败降级三件套（U13）：去重键 + 判定表行 1-4 ─────────────────────
// 注意：warnedKeys 是模块级集合、跨用例持存（插件重启不清空正是其验收语义）——
// 本节各用例用独立 pluginId/contributionId 组合 + 触发前基线计数断言，互不依赖执行序。

describe('去重键进程级持存（U13 验收①：pluginId::contributionId::失败种类）', () => {
  it('同键只 warn 一次：loadExternal 重放同一坏声明不重复提示（config.plugins 广播重放场景）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = makeRegistry()
    registry.loadExternal('u13-a', [pluginDeclaration({ id: 'bad' })])
    const afterFirst = warn.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    registry.loadExternal('u13-a', [pluginDeclaration({ id: 'bad' })])
    expect(warn.mock.calls.length).toBe(afterFirst)
  })

  it('插件重启不清空：clearForPlugin + loadExternal（重启 = 清理 + 声明重放）后同坏声明仍只提示一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = makeRegistry()
    registry.loadExternal('u13-b', [pluginDeclaration({ id: 'bad' })])
    const afterFirst = warn.mock.calls.length
    registry.clearForPlugin('u13-b')
    registry.loadExternal('u13-b', [pluginDeclaration({ id: 'bad' })])
    expect(warn.mock.calls.length).toBe(afterFirst)
  })

  it('跨容器实例生效：新注册表实例触发同一坏声明不再提示（集合模块级持有，非实例级）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    makeRegistry().loadExternal('u13-c', [pluginDeclaration({ id: 'bad' })])
    const afterFirst = warn.mock.calls.length
    makeRegistry().loadExternal('u13-c', [pluginDeclaration({ id: 'bad' })])
    expect(warn.mock.calls.length).toBe(afterFirst)
  })

  it('不同失败种类 / 不同插件各自独立键（去重不跨键误伤：每键首次都提示）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = makeRegistry()
    registry.loadExternal('u13-d1', [pluginDeclaration({ id: 'acme-ext.ghost', placement: 'nonexistent.slot' })]) // 行 2 种类
    registry.loadExternal('u13-d2', [pluginDeclaration({ id: 'bad' })]) // 行 3 种类
    expect(warn.mock.calls.length).toBe(2)
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('unknown-placement'))).toBe(true)
    expect(messages.some((m) => m.includes('invalid-id'))).toBe(true)
  })

  it('warnFailureOnce 函数级契约：键 = pluginId::contributionId::kind 三段，任一段不同即新键', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnFailureOnce('p', 'c', 'text-truncated', 'msg-a')
    const afterFirst = warn.mock.calls.length
    warnFailureOnce('p', 'c', 'text-truncated', 'msg-a') // 同键 → 静默
    expect(warn.mock.calls.length).toBe(afterFirst)
    warnFailureOnce('p', 'c2', 'text-truncated', 'msg-b') // 贡献不同 → 提示
    warnFailureOnce('p2', 'c', 'text-truncated', 'msg-c') // 插件不同 → 提示
    expect(warn.mock.calls.length).toBe(afterFirst + 2)
  })
})

describe('§5.4 判定表行 1-4（U13 验收②：判定者/用户所见/恢复动作逐行确定）', () => {
  it('行 1 未注册族：routeAll 判 available=false + emit unregistered-mount-point（载荷三字段）；已注册族对照侧 available=true', () => {
    const bus = new InternalEventBus()
    const contributions = new ContributionRegistry(bus)
    const mounts = new MountPointRegistry()
    mounts.register('sidebar.tab')
    const seen: Array<Extract<InternalEvent, { kind: 'unregistered-mount-point' }>> = []
    bus.on('unregistered-mount-point', (e) => seen.push(e))
    contributions.loadExternal([
      { pluginId: 'u13-f1', contributes: { views: [{ id: 'u13-f1.tab', title: 'X', placement: 'nonexistent.slot' }] } },
    ])
    contributions.routeAll(mounts)
    expect(contributions.getContributions({ pluginId: 'u13-f1' })[0]?.available).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      pluginId: 'u13-f1',
      contributionId: 'u13-f1.tab',
      expectedMountPoint: 'nonexistent.slot',
    })
    contributions.loadExternal([
      { pluginId: 'u13-f2', contributes: { views: [{ id: 'u13-f2.tab', title: 'Y', placement: 'sidebar.tab' }] } },
    ])
    contributions.routeAll(mounts)
    expect(contributions.getContributions({ pluginId: 'u13-f2' })[0]?.available).toBe(true)
    expect(FAILURE_JUDGEMENT_TABLE['unregistered-mount-point'].judge).toContain('挂载点路由')
  })

  it('行 2 族内不存在：placement 不在位置族词表 → unavailable=unknown-placement、不派生、warning 含恢复指引；同批其他声明不牵连', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = makeRegistry()
    registry.loadExternal('u13-g', [
      pluginDeclaration({ id: 'u13-g.ghost', placement: 'nonexistent.slot' }),
      pluginDeclaration({ id: 'u13-g.good' }),
    ])
    expect(registry.listEntries().find((e) => e.declaration.id === 'u13-g.ghost')?.unavailable).toBe('unknown-placement')
    expect(registry.deriveDrawerTabs().map((v) => v.id)).toEqual(['u13-g.good'])
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain(FAILURE_JUDGEMENT_TABLE['unknown-placement'].recovery)
    expect(FAILURE_JUDGEMENT_TABLE['unknown-placement'].judge).toContain('容器位注册表')
  })

  it('行 3 id 违规：unavailable=invalid-id、不派生、warning 含插件与声明标识（三段键可定位）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = makeRegistry()
    registry.loadExternal('u13-h', [pluginDeclaration({ id: 'bad' })])
    expect(registry.listEntries()[0].unavailable).toBe('invalid-id')
    expect(registry.deriveDrawerTabs()).toHaveLength(0)
    const message = String(warn.mock.calls.at(-1)?.[0])
    expect(message).toContain('u13-h')
    expect(message).toContain('bad')
    expect(FAILURE_JUDGEMENT_TABLE['invalid-id'].judge).toContain('声明解析')
  })
})

describe('图标解析单函数（§6.13，U13 验收④：四容器共用 / 未命中兜底+warn 一次 / 空串等同未声明）', () => {
  it('判定表行 4：未命中 → fallback + warn 一次（同键二次解析不再提示），warning 含白名单与兜底图标指引', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveContributionIcon({ pluginId: 'u13-i', contributionId: 'acme-ext.tab', icon: 'not-an-icon' })).toEqual({ status: 'fallback' })
    const afterFirst = warn.mock.calls.length
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('CONTRIBUTION_ICON_KEYS')
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain(FALLBACK_CONTRIBUTION_ICON)
    expect(resolveContributionIcon({ pluginId: 'u13-i', contributionId: 'acme-ext.tab', icon: 'not-an-icon' })).toEqual({ status: 'fallback' })
    expect(warn.mock.calls.length).toBe(afterFirst)
    expect(FAILURE_JUDGEMENT_TABLE['icon-not-in-allowlist'].judge).toContain('图标解析函数')
  })

  it('命中白名单 → declared + 登记键；归一化不区分大小写 / 连字符 / 下划线 / 空白（normalizeIconKey 口径）', () => {
    expect(resolveContributionIcon({ pluginId: 'p', contributionId: 'c1', icon: 'git-branch' })).toEqual({ status: 'declared', key: 'git-branch' })
    expect(resolveContributionIcon({ pluginId: 'p', contributionId: 'c2', icon: 'GitBranch' })).toEqual({ status: 'declared', key: 'git-branch' })
    expect(resolveContributionIcon({ pluginId: 'p', contributionId: 'c3', icon: 'git_branch' })).toEqual({ status: 'declared', key: 'git-branch' })
    expect(resolveContributionIcon({ pluginId: 'p', contributionId: 'c4', icon: '  CLOCK ' })).toEqual({ status: 'declared', key: 'clock' })
    expect(normalizeIconKey('List-Check_Big')).toBe('listcheckbig')
  })

  it('空串 / 纯空白 / undefined 等同未声明：unset 且不告警（§6.13 空串条款）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = warn.mock.calls.length
    expect(resolveContributionIcon({ pluginId: 'u13-j', contributionId: 'c', icon: '' })).toEqual({ status: 'unset' })
    expect(resolveContributionIcon({ pluginId: 'u13-j', contributionId: 'c2', icon: '   ' })).toEqual({ status: 'unset' })
    expect(resolveContributionIcon({ pluginId: 'u13-j', contributionId: 'c3' })).toEqual({ status: 'unset' })
    expect(warn.mock.calls.length).toBe(before)
  })

  it('运行时脏数据（非字符串，如 {paths} 形状误传）不抛错：按未命中落兜底（{paths} 自定义形状不在本函数范围）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dirty = { paths: ['M0 0'] } as unknown as string
    expect(resolveContributionIcon({ pluginId: 'u13-k', contributionId: 'c', icon: dirty })).toEqual({ status: 'fallback' })
    expect(warn.mock.calls.length).toBeGreaterThan(0)
  })

  it('白名单 = 全部图标消费点并集（抽屉/托盘/头部 + 设置页 + 浮层）+ layout-grid（兜底自指）+ panel-right（设计 §5.2 示例）；兜底键自身可声明', () => {
    expect([...CONTRIBUTION_ICON_KEYS]).toEqual([
      'terminal', 'globe', 'git-branch', 'book-open', 'file-text', 'bot',
      'square-terminal', 'square-check-big', 'messages-square', 'workflow', 'list-tree',
      'list-checks', 'list-todo', 'circle-check', 'circle-dot', 'target', 'clock', 'zap', 'flag', 'gauge',
      // 设置页 SETTINGS_SECTION_ICONS（bot/git-branch 与抽屉/托盘表重叠，不重复登记）
      'settings', 'sparkles', 'blocks', 'server', 'clipboard-list', 'palette', 'scroll-text', 'tag',
      'volume-2', 'terminal-square', 'download', 'wifi', 'waypoints', 'sliders-horizontal', 'chart-column',
      // 浮层壳段（workflow/clock 已在）
      'network',
      'layout-grid', 'panel-right',
    ])
    expect(FALLBACK_CONTRIBUTION_ICON).toBe('layout-grid')
    expect(resolveContributionIcon({ pluginId: 'p', contributionId: 'self', icon: 'layout-grid' }).status).toBe('declared')
  })
})

describe('§5.4 判定表本体（八行登记完整）', () => {
  it('八行 row 1-8 连续、种类词表与判定表一一对应', () => {
    const kinds = Object.keys(FAILURE_JUDGEMENT_TABLE) as SlotFailureKind[]
    expect(kinds).toHaveLength(8)
    expect(kinds.map((k) => FAILURE_JUDGEMENT_TABLE[k].row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const kind of kinds) {
      const row = FAILURE_JUDGEMENT_TABLE[kind]
      expect(row.judge.length).toBeGreaterThan(0)
      expect(row.userVisible.length).toBeGreaterThan(0)
      expect(row.recovery.length).toBeGreaterThan(0)
    }
  })
})
