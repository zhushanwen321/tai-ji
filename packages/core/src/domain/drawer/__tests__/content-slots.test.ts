/**
 * content-slots 派生视图单测（容器扩展点统一 U6：右抽屉标签条的读侧投影）。
 *
 * 用例口径 = 文件头注契约：内置项装配（key 去保留命名空间前缀、label 不透传恒走
 * labelKey）、内置 ∪ 插件合并投影、findDrawerTabView / builtinDefaultDrawerTab /
 * effectiveDrawerTab（分区值未命中派生视图 → 回退内置默认项，不回写分区）。
 *
 * 实体用模块级单例 contentSlotRegistry（content-slots.ts 本身绑定单例——独立实例测不到
 * 装配路径）；插件声明在 afterEach clearForPlugin 清理，防跨用例污染。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/content-slots.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'

import { contentSlotRegistry } from '../../../extension-host/content-slot-registry'
import type { ContentSlotDeclaration } from '../../../extension-host/content-slot-registry'
import {
  builtinDefaultDrawerTab,
  drawerTabViews,
  effectiveDrawerTab,
  ensureBuiltinsAssembled,
  findDrawerTabView,
} from '../content-slots'

const PLUGIN_ID = 'wool-workbuddy'

afterEach(() => {
  contentSlotRegistry.clearForPlugin(PLUGIN_ID)
})

describe('内置项装配与投影（key 归一 + 文案二态）', () => {
  it('drawerTabViews：内置 8 项，key = 去保留命名空间前缀的内容 id（ui.git → git）', () => {
    const views = drawerTabViews()
    const builtin = views.filter((v) => v.source === 'builtin')
    expect(builtin.map((v) => v.key)).toEqual(['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'trace'])
    // renderer 直通宿主组件（GitPanel 等），scope 恒 session
    expect(builtin[0]).toMatchObject({ pluginId: 'taiji-host', renderer: { kind: 'host', component: 'GitPanel' } })
  })

  it('内置项 label 不透传（恒走 labelKey）；labelKey/emptyTextKey/emptyHintKey 透传', () => {
    const git = findDrawerTabView('git')
    expect(git).toBeDefined()
    expect(git?.label).toBeUndefined()
    expect(git?.labelKey).toBeDefined()
    expect(git?.emptyTextKey).toBeDefined()
    expect(git?.emptyHintKey).toBeDefined()
  })

  it('ensureBuiltinsAssembled 幂等：重复调用零操作，投影不翻倍', () => {
    ensureBuiltinsAssembled()
    ensureBuiltinsAssembled()
    expect(drawerTabViews().filter((v) => v.source === 'builtin')).toHaveLength(8)
  })
})

describe('插件声明项合并与查询', () => {
  const pluginDecl: ContentSlotDeclaration = {
    id: `${PLUGIN_ID}.extra-tab`,
    placement: 'drawer.tab',
    label: '扩展面板',
    icon: 'puzzle',
    scope: 'session',
    pluginId: PLUGIN_ID,
    renderer: { kind: 'view', viewId: 'extra-view' },
    emptyState: { text: '尚无数据', hint: '稍后再试' },
  }

  it('插件项：key = 声明 id（全局 id 空间），label 用原文；内置项排前（§6.16 无 order 排内置后）', () => {
    contentSlotRegistry.loadExternal(PLUGIN_ID, [pluginDecl])
    const views = drawerTabViews()
    expect(views.map((v) => v.key)).toEqual([
      'git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'trace', `${PLUGIN_ID}.extra-tab`,
    ])
    const plugin = views.find((v) => v.source === 'plugin')
    expect(plugin).toMatchObject({
      key: `${PLUGIN_ID}.extra-tab`,
      label: '扩展面板',
      emptyState: { text: '尚无数据', hint: '稍后再试' },
      renderer: { kind: 'view', viewId: 'extra-view' },
    })
    // findDrawerTabView 按 tab 位查派生条目（命中 / 未命中）
    expect(findDrawerTabView(`${PLUGIN_ID}.extra-tab`)?.label).toBe('扩展面板')
    expect(findDrawerTabView('no-such-tab')).toBeUndefined()
  })

  it('clearForPlugin 后插件项从派生视图消失（内置项不受影响）', () => {
    contentSlotRegistry.loadExternal(PLUGIN_ID, [pluginDecl])
    expect(findDrawerTabView(`${PLUGIN_ID}.extra-tab`)).toBeDefined()
    contentSlotRegistry.clearForPlugin(PLUGIN_ID)
    expect(findDrawerTabView(`${PLUGIN_ID}.extra-tab`)).toBeUndefined()
    expect(drawerTabViews().filter((v) => v.source === 'builtin')).toHaveLength(8)
  })
})

describe('默认项与失效回退（§11.1-1 / §5.4 卸载行）', () => {
  it('builtinDefaultDrawerTab = 首个内置项（git）；插件 order 抢首也不受影响', () => {
    // 插件声明 order 抢到派生视图首位，默认仍必须是内置项
    contentSlotRegistry.loadExternal(PLUGIN_ID, [
      {
        id: `${PLUGIN_ID}.first`,
        placement: 'drawer.tab',
        label: '抢首位',
        scope: 'session',
        pluginId: PLUGIN_ID,
        order: -100,
        renderer: { kind: 'view', viewId: 'first-view' },
      },
    ])
    expect(drawerTabViews()[0]?.key).toBe(`${PLUGIN_ID}.first`)
    expect(builtinDefaultDrawerTab()).toBe('git')
  })

  it('effectiveDrawerTab：分区值命中派生视图原样；未命中（插件卸载）→ 回退内置默认项', () => {
    contentSlotRegistry.loadExternal(PLUGIN_ID, [
      {
        id: `${PLUGIN_ID}.vanishing`,
        placement: 'drawer.tab',
        label: '会消失',
        scope: 'session',
        pluginId: PLUGIN_ID,
        renderer: { kind: 'view', viewId: 'vanishing-view' },
      },
    ])
    expect(effectiveDrawerTab(`${PLUGIN_ID}.vanishing`)).toBe(`${PLUGIN_ID}.vanishing`)
    // 卸载后分区值仍指向已消失的 tab → 生效值回退 git（不回写分区）
    contentSlotRegistry.clearForPlugin(PLUGIN_ID)
    expect(effectiveDrawerTab(`${PLUGIN_ID}.vanishing`)).toBe('git')
    // 内置项恒命中
    expect(effectiveDrawerTab('plan')).toBe('plan')
  })
})
