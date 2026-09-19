/**
 * composer-density 纯状态机单测（设计 .tmp/tech-design/mode-system-composer-density.md §6.6 决策 D6）。
 *
 * 覆盖：三档阈值与边界归属（640/520）· 720 全展开 · 560 序 1–3 · 440 序 1–4（托盘聚合）·
 * 序 0 任意宽度不退化 · `»` 菜单仅有被收起项时才存在 · 托盘全无条目不渲染 · 纯函数契约。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-density.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH,
  COMPOSER_DENSITY_EXPANDED_MIN_WIDTH,
  DEFAULT_COMPOSER_DENSITY_THRESHOLDS,
  resolveComposerDensity,
  resolveComposerDensityTier,
} from '@/components/panel/composer-density'

const ALL_WIDTHS = [0, 1, 100, 319, 440, 519, 520, 559, 639, 640, 720, 1024, 2560]

describe('三档阈值与边界归属', () => {
  it('默认阈值常量 = 640 / 520（D6 实测推导值）', () => {
    expect(COMPOSER_DENSITY_EXPANDED_MIN_WIDTH).toBe(640)
    expect(COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH).toBe(520)
    expect(DEFAULT_COMPOSER_DENSITY_THRESHOLDS).toEqual({
      expandedMinWidth: 640,
      aggregatedBelowWidth: 520,
    })
  })

  it('640 归 expanded（`>=` 归高档）', () => {
    expect(resolveComposerDensityTier(640)).toBe('expanded')
    expect(resolveComposerDensity(COMPOSER_DENSITY_EXPANDED_MIN_WIDTH).tier).toBe('expanded')
    // 边界上一格即 compact
    expect(resolveComposerDensityTier(639.99)).toBe('compact')
  })

  it('520 归 compact（不是 narrow）；519 才落 narrow', () => {
    expect(resolveComposerDensityTier(520)).toBe('compact')
    expect(resolveComposerDensity(COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH).tier).toBe('compact')
    expect(resolveComposerDensityTier(519)).toBe('narrow')
    expect(resolveComposerDensityTier(519.99)).toBe('narrow')
  })

  it('三档覆盖：720 expanded / 560 compact / 440 narrow', () => {
    expect(resolveComposerDensity(720).tier).toBe('expanded')
    expect(resolveComposerDensity(560).tier).toBe('compact')
    expect(resolveComposerDensity(440).tier).toBe('narrow')
  })

  it('非有限宽度落 narrow（最保守档），不是 expanded', () => {
    expect(resolveComposerDensityTier(Number.NaN)).toBe('narrow')
    expect(resolveComposerDensity(Number.NaN).slots.tray).toBe('aggregated')
  })

  it('阈值可整体覆盖（测试与未来调参入口）', () => {
    const overrides = { expandedMinWidth: 800, aggregatedBelowWidth: 600 }
    expect(resolveComposerDensity(700, {}, overrides).tier).toBe('compact')
    expect(resolveComposerDensity(500, {}, overrides).tier).toBe('narrow')
    expect(resolveComposerDensity(900, {}, overrides).tier).toBe('expanded')
  })

  it('阈值可部分覆盖（未覆盖项回落命名常量）', () => {
    // 只抬 expandedMin：560 < 600 → 不是 expanded；仍 >= 默认 520 → compact
    expect(resolveComposerDensity(560, {}, { expandedMinWidth: 600 }).tier).toBe('compact')
    // 只抬 aggregatedBelow：530 >= 540? 否 → narrow（expandedMin 回落默认 640）
    expect(resolveComposerDensity(530, {}, { aggregatedBelowWidth: 540 }).tier).toBe('narrow')
  })
})

describe('720px（≥640）全展开：不动任何序', () => {
  it('全部元素原形态；插件零贡献 → toolbar 不渲染', () => {
    const layout = resolveComposerDensity(720)
    expect(layout.slots).toEqual({
      add: 'expanded',
      send: 'expanded',
      capacity: 'expanded',
      genStats: 'expanded',
      model: 'expanded',
      thinking: 'expanded',
      pluginToolbar: 'absent',
      tray: 'expanded',
    })
    expect(layout.appliedOrders).toEqual([])
    expect(layout.allowsWrap).toBe(false)
  })

  it('有插件贡献时 toolbar 全展开、无 `»` 菜单、仍无退化序', () => {
    const layout = resolveComposerDensity(720, { pluginToolbarContributionCount: 3 })
    expect(layout.slots.pluginToolbar).toBe('expanded')
    expect(layout.slots.tray).toBe('expanded')
    expect(layout.appliedOrders).toEqual([])
    expect(layout.overflowMenuVisible).toBe(false)
    expect(layout.overflowItems).toEqual([])
  })
})

describe('560px（520–640）序 1–3 生效', () => {
  it('序 1 合流 + 序 2 合体生效；序 4 托盘不聚合；序 0 原样', () => {
    const layout = resolveComposerDensity(560)
    expect(layout.tier).toBe('compact')
    expect(layout.slots.add).toBe('expanded')
    expect(layout.slots.send).toBe('expanded')
    expect(layout.slots.capacity).toBe('merged')
    expect(layout.slots.genStats).toBe('merged')
    expect(layout.slots.model).toBe('merged')
    expect(layout.slots.thinking).toBe('merged')
    expect(layout.slots.tray).toBe('expanded')
    expect(layout.appliedOrders).toEqual([1, 2])
  })

  it('零贡献 → 序 3 无可收项：无 `»` 菜单（不留死入口）', () => {
    const layout = resolveComposerDensity(560, { pluginToolbarContributionCount: 0 })
    expect(layout.slots.pluginToolbar).toBe('absent')
    expect(layout.appliedOrders).toEqual([1, 2])
    expect(layout.overflowMenuVisible).toBe(false)
    expect(layout.overflowItems).toEqual([])
  })

  it('有插件贡献 → 序 3 生效：toolbar 收进 `»`', () => {
    const layout = resolveComposerDensity(560, { pluginToolbarContributionCount: 2 })
    expect(layout.slots.pluginToolbar).toBe('collapsed-to-menu')
    expect(layout.appliedOrders).toEqual([1, 2, 3])
    expect(layout.overflowMenuVisible).toBe(true)
    expect(layout.overflowItems).toEqual(['pluginToolbar'])
    // 序 4 仍未生效
    expect(layout.slots.tray).toBe('expanded')
  })
})

describe('440px（<520）序 4 生效：托盘聚合成单入口', () => {
  it('托盘聚合 + 序 1–3 同时生效（累计退化）', () => {
    const layout = resolveComposerDensity(440, { pluginToolbarContributionCount: 1 })
    expect(layout.tier).toBe('narrow')
    expect(layout.slots.tray).toBe('aggregated')
    expect(layout.slots.capacity).toBe('merged')
    expect(layout.slots.genStats).toBe('merged')
    expect(layout.slots.model).toBe('merged')
    expect(layout.slots.thinking).toBe('merged')
    expect(layout.slots.pluginToolbar).toBe('collapsed-to-menu')
    expect(layout.appliedOrders).toEqual([1, 2, 3, 4])
  })

  it('零插件贡献时窄档 = 序 1、2、4（序 3 无可收项）', () => {
    const layout = resolveComposerDensity(440)
    expect(layout.slots.pluginToolbar).toBe('absent')
    expect(layout.slots.tray).toBe('aggregated')
    expect(layout.appliedOrders).toEqual([1, 2, 4])
    expect(layout.overflowMenuVisible).toBe(false)
  })

  it('窄档仍保留发送位与 `+` 原形态', () => {
    const layout = resolveComposerDensity(440)
    expect(layout.slots.add).toBe('expanded')
    expect(layout.slots.send).toBe('expanded')
  })
})

describe('序 0 在任何宽度都不退化', () => {
  it('参数化跑一组宽度：add / send 恒 expanded', () => {
    for (const width of ALL_WIDTHS) {
      const layout = resolveComposerDensity(width)
      expect(layout.slots.add).toBe('expanded')
      expect(layout.slots.send).toBe('expanded')
    }
  })

  it('叠加能力标志与阈值覆盖后依然不退化', () => {
    const caps = { pluginToolbarContributionCount: 5, hasTrayItems: true }
    const overrides = { expandedMinWidth: 900, aggregatedBelowWidth: 700 }
    for (const width of ALL_WIDTHS) {
      const layout = resolveComposerDensity(width, caps, overrides)
      expect(layout.slots.add).toBe('expanded')
      expect(layout.slots.send).toBe('expanded')
    }
  })

  it('「永不换行」：任何宽度/档位下 allowsWrap 恒 false', () => {
    for (const width of ALL_WIDTHS) {
      expect(resolveComposerDensity(width).allowsWrap).toBe(false)
    }
  })
})

describe('`»` 溢出菜单仅有被收起项时才存在', () => {
  it('全展开档即使有贡献也无菜单（无被收起项）', () => {
    const layout = resolveComposerDensity(640, { pluginToolbarContributionCount: 4 })
    expect(layout.overflowMenuVisible).toBe(false)
    expect(layout.overflowItems).toEqual([])
  })

  it('窄档 + 零贡献：无被收起项 → 无菜单', () => {
    const layout = resolveComposerDensity(300, { pluginToolbarContributionCount: 0 })
    expect(layout.overflowMenuVisible).toBe(false)
    expect(layout.overflowItems).toEqual([])
  })

  it('有被收起项才渲染菜单，且条目 = 被收起槽位', () => {
    const compact = resolveComposerDensity(600, { pluginToolbarContributionCount: 1 })
    const narrow = resolveComposerDensity(400, { pluginToolbarContributionCount: 1 })
    for (const layout of [compact, narrow]) {
      expect(layout.overflowMenuVisible).toBe(true)
      expect(layout.overflowItems).toEqual(['pluginToolbar'])
    }
  })

  it('负贡献数视为零贡献（不留死入口）', () => {
    const layout = resolveComposerDensity(560, { pluginToolbarContributionCount: -1 })
    expect(layout.slots.pluginToolbar).toBe('absent')
    expect(layout.overflowMenuVisible).toBe(false)
  })
})

describe('托盘全无条目时不渲染（既有三态契约在密度层一致）', () => {
  it('hasTrayItems: false → absent，序 4 不生效', () => {
    const layout = resolveComposerDensity(440, { hasTrayItems: false })
    expect(layout.slots.tray).toBe('absent')
    expect(layout.appliedOrders).toEqual([1, 2])
  })

  it('hasTrayItems: false 在全展开档同样 absent', () => {
    expect(resolveComposerDensity(720, { hasTrayItems: false }).slots.tray).toBe('absent')
  })

  it('缺省 = 有托盘面（tray expanded/aggregated 由宽度决定）', () => {
    expect(resolveComposerDensity(720).slots.tray).toBe('expanded')
    expect(resolveComposerDensity(440).slots.tray).toBe('aggregated')
  })
})

describe('纯函数契约', () => {
  it('同输入恒同输出，且每次返回全新对象/数组（无共享可变状态）', () => {
    const caps = { pluginToolbarContributionCount: 1 }
    const a = resolveComposerDensity(560, caps)
    const b = resolveComposerDensity(560, caps)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.slots).not.toBe(b.slots)
    expect(a.overflowItems).not.toBe(b.overflowItems)
    expect(a.appliedOrders).not.toBe(b.appliedOrders)
  })

  it('不修改入参对象', () => {
    const caps = { pluginToolbarContributionCount: 1, hasTrayItems: true }
    const capsSnapshot = { ...caps }
    const overrides = { expandedMinWidth: 700, aggregatedBelowWidth: 500 }
    const overridesSnapshot = { ...overrides }
    resolveComposerDensity(560, caps, overrides)
    expect(caps).toEqual(capsSnapshot)
    expect(overrides).toEqual(overridesSnapshot)
  })

  it('缺省入参安全：只给宽度即可解析', () => {
    const layout = resolveComposerDensity(720)
    expect(layout.tier).toBe('expanded')
    expect(layout.slots.pluginToolbar).toBe('absent')
    expect(layout.slots.tray).toBe('expanded')
  })
})
