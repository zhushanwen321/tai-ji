/**
 * composer-density 纯状态机单测（D6 修订「三步聚合」版）。
 *
 * 覆盖（穷举 = 本模块的 100% 行覆盖承诺）：
 * - fit 级归一（NaN / 负 / 越界 / 取整）与三步累计映射（L1 左簇 / L2 指标 / L3 模型+思考）。
 * - 能力标志：托盘全无 + 插件零贡献 → `leftCluster: 'absent'`（不留死入口）；任一有内容 → 可聚合。
 * - 锚点保护：仅 L3 顶格生效；左簇/指标让位，模型聚合按钮与序 0 锚点恒在。
 * - **构造性回归防线**：模型形态域只有 `expanded`（完整名）/ `aggregated` 两态——穷举矩阵断言
 *   不存在任何截断/进菜单形态；输出域不存在 `tier` / `overflow*` 键（双轴旧语义已退役）。
 * - 纯函数契约：同输入恒等、不改入参、不共享引用。
 *
 * [HISTORICAL] 旧版三档阈值（640/520 tier 轴）、`»` 溢出菜单、simplified/iconic/merged 中间态
 * 的用例已随语义删除——它们曾断言「放得下也截模型名」的行为，正是本次重做的根因。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-density.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_DEGRADATION_ORDER,
  COMPOSER_DENSITY_EXPANDED_MIN_WIDTH,
  COMPOSER_DENSITY_MAX_FIT_DEGRADATION,
  COMPOSER_FIT_LEVEL_LEFT_AGGREGATE,
  COMPOSER_FIT_LEVEL_METRICS_AGGREGATE,
  COMPOSER_FIT_LEVEL_MODEL_AGGREGATE,
  COMPOSER_FIT_LEVEL_NONE,
  normalizeComposerFitLevel,
  resolveComposerDensity,
} from '@/components/panel/composer-density'
import type {
  ComposerDensityCapabilities,
  ComposerDensityLayout,
} from '@/components/panel/composer-density'

/** 穷举矩阵的维度：fit 0–3 × 能力组合 × 锚点保护开关 */
const ALL_LEVELS = [0, 1, 2, 3]
const CAP_VARIANTS: Array<[string, ComposerDensityCapabilities]> = [
  ['缺省（托盘有面 + 插件零贡献）', {}],
  ['托盘全无 + 插件零贡献', { hasTrayItems: false }],
  ['托盘全无 + 插件有贡献', { hasTrayItems: false, pluginToolbarContributionCount: 1 }],
  ['托盘有面 + 插件有贡献', { hasTrayItems: true, pluginToolbarContributionCount: 3 }],
]
const PROTECT_VARIANTS = [false, true]

function allCombos(): Array<{ level: number; caps: ComposerDensityCapabilities; protect: boolean; out: ComposerDensityLayout }> {
  const rows = []
  for (const level of ALL_LEVELS) {
    for (const [, caps] of CAP_VARIANTS) {
      for (const protect of PROTECT_VARIANTS) {
        rows.push({ level, caps, protect, out: resolveComposerDensity(caps, level, protect) })
      }
    }
  }
  return rows
}

describe('常量与归一', () => {
  it('首帧种子宽保留 640（[HISTORICAL] 原全展开档断点，不再参与形态判定）', () => {
    expect(COMPOSER_DENSITY_EXPANDED_MIN_WIDTH).toBe(640)
  })

  it('fit 顶格 = 3，级命名常量与退化序一一对应', () => {
    expect(COMPOSER_DENSITY_MAX_FIT_DEGRADATION).toBe(3)
    expect(COMPOSER_FIT_LEVEL_NONE).toBe(0)
    expect(COMPOSER_FIT_LEVEL_LEFT_AGGREGATE).toBe(COMPOSER_DEGRADATION_ORDER.LEFT_CLUSTER_AGGREGATE)
    expect(COMPOSER_FIT_LEVEL_METRICS_AGGREGATE).toBe(COMPOSER_DEGRADATION_ORDER.METRICS_AGGREGATE)
    expect(COMPOSER_FIT_LEVEL_MODEL_AGGREGATE).toBe(COMPOSER_DEGRADATION_ORDER.MODEL_THINKING_AGGREGATE)
  })

  it('normalize：NaN → 0；负 → 0；越界 → 顶格；小数 → 取整', () => {
    expect(normalizeComposerFitLevel(Number.NaN)).toBe(0)
    expect(normalizeComposerFitLevel(-5)).toBe(0)
    expect(normalizeComposerFitLevel(0.4)).toBe(0)
    expect(normalizeComposerFitLevel(1.6)).toBe(2)
    expect(normalizeComposerFitLevel(99)).toBe(3)
    expect(normalizeComposerFitLevel(Number.POSITIVE_INFINITY)).toBe(3)
  })
})

describe('三步累计映射（fit 级 → 形态）', () => {
  it('L0 全展开：三组均原形态，零退化序', () => {
    const layout = resolveComposerDensity({}, 0)
    expect(layout.slots.leftCluster).toBe('expanded')
    expect(layout.slots.metrics).toBe('expanded')
    expect(layout.slots.modelThinking).toBe('expanded')
    expect(layout.appliedOrders).toEqual([])
    expect(layout.anchorProtected).toBe(false)
    expect(layout.allowsWrap).toBe(false)
  })

  it('L1 只聚合左簇；L2 再聚合指标；L3 再聚合模型+思考（前缀累计）', () => {
    const l1 = resolveComposerDensity({}, COMPOSER_FIT_LEVEL_LEFT_AGGREGATE)
    expect(l1.slots).toMatchObject({
      leftCluster: 'aggregated',
      metrics: 'expanded',
      modelThinking: 'expanded',
    })
    expect(l1.appliedOrders).toEqual([COMPOSER_DEGRADATION_ORDER.LEFT_CLUSTER_AGGREGATE])

    const l2 = resolveComposerDensity({}, COMPOSER_FIT_LEVEL_METRICS_AGGREGATE)
    expect(l2.slots).toMatchObject({
      leftCluster: 'aggregated',
      metrics: 'aggregated',
      modelThinking: 'expanded',
    })
    expect(l2.appliedOrders).toEqual([1, 2])

    const l3 = resolveComposerDensity({}, COMPOSER_FIT_LEVEL_MODEL_AGGREGATE)
    expect(l3.slots).toMatchObject({
      leftCluster: 'aggregated',
      metrics: 'aggregated',
      modelThinking: 'aggregated',
    })
    expect(l3.appliedOrders).toEqual([1, 2, 3])
  })

  it('缺省 fit 入参 = 0（全展开）', () => {
    expect(resolveComposerDensity().fitLevel).toBe(0)
    expect(resolveComposerDensity({}).slots.leftCluster).toBe('expanded')
  })
})

describe('能力标志（不留死入口）', () => {
  it('托盘全无 + 插件零贡献 → leftCluster absent（任何 fit 级都不渲染聚合按钮）', () => {
    for (const level of ALL_LEVELS) {
      const layout = resolveComposerDensity({ hasTrayItems: false }, level)
      expect(layout.slots.leftCluster).toBe('absent')
    }
  })

  it('托盘全无但插件有贡献 → 左簇仍可达（L0 展开 / L1+ 聚合）', () => {
    const caps: ComposerDensityCapabilities = { hasTrayItems: false, pluginToolbarContributionCount: 1 }
    expect(resolveComposerDensity(caps, 0).slots.leftCluster).toBe('expanded')
    expect(resolveComposerDensity(caps, 1).slots.leftCluster).toBe('aggregated')
  })

  it('贡献数非正数一律视为零贡献；缺省 hasTrayItems = true', () => {
    expect(
      resolveComposerDensity({ hasTrayItems: false, pluginToolbarContributionCount: 0 }, 0).slots.leftCluster,
    ).toBe('absent')
    expect(
      resolveComposerDensity({ hasTrayItems: false, pluginToolbarContributionCount: -2 }, 0).slots.leftCluster,
    ).toBe('absent')
    expect(resolveComposerDensity({ pluginToolbarContributionCount: 1 }, 0).slots.leftCluster).toBe('expanded')
  })
})

describe('锚点保护（L3 顶格仍放不下 → 中部让位，锚点与模型入口零裁剪）', () => {
  it('仅 L3 生效：左簇与指标 absent，模型聚合按钮恒在', () => {
    const layout = resolveComposerDensity({}, 3, true)
    expect(layout.anchorProtected).toBe(true)
    expect(layout.slots.leftCluster).toBe('absent')
    expect(layout.slots.metrics).toBe('absent')
    expect(layout.slots.modelThinking).toBe('aggregated')
    expect(layout.slots.add).toBe('expanded')
    expect(layout.slots.send).toBe('expanded')
  })

  it('低 fit 级下 anchorOverflow 入参被忽略（先走正常三级退化）', () => {
    for (const level of [0, 1, 2]) {
      const layout = resolveComposerDensity({}, level, true)
      expect(layout.anchorProtected).toBe(false)
      expect(layout.slots.metrics).not.toBe('absent')
      expect(layout.slots.leftCluster).not.toBe('absent')
    }
  })

  it('保护态下 appliedOrders 仍是 L3 前缀（保护是顶格之上的让位，不新增序号）', () => {
    const layout = resolveComposerDensity({}, 3, true)
    expect(layout.appliedOrders).toEqual([1, 2, 3])
    expect(layout.fitLevel).toBe(3)
  })
})

describe('穷举矩阵不变式（32 组合：4 级 × 4 能力 × 2 保护）', () => {
  it('序 0 恒不退化；模型形态只有两态且恒不缺席；输出域无双轴旧键', () => {
    for (const { out } of allCombos()) {
      // 锚点类型级保证
      expect(out.slots.add).toBe('expanded')
      expect(out.slots.send).toBe('expanded')
      expect(out.allowsWrap).toBe(false)
      // 模型名两态：完整展示 / 聚合按钮——**无截断态、永不缺席**（切模型恒可达）
      expect(['expanded', 'aggregated']).toContain(out.slots.modelThinking)
      // 指标缺席只可能来自锚点保护
      if (out.slots.metrics === 'absent') expect(out.anchorProtected).toBe(true)
      // 双轴旧语义构造性不存在
      expect('tier' in out).toBe(false)
      expect('overflowItems' in out).toBe(false)
      expect('overflowMenuVisible' in out).toBe(false)
      expect('fit' in out).toBe(false)
    }
  })

  it('appliedOrders 恒等于 fitLevel 前缀（单一真源，不漂移）', () => {
    for (const { level, out } of allCombos()) {
      expect(out.appliedOrders).toHaveLength(level)
      expect(out.appliedOrders).toEqual([1, 2, 3].slice(0, level))
      expect(out.fitLevel).toBe(level)
    }
  })
})

describe('纯函数契约', () => {
  it('同输入恒等（深比较）且不共享引用', () => {
    const a = resolveComposerDensity({ hasTrayItems: false }, 2, true)
    const b = resolveComposerDensity({ hasTrayItems: false }, 2, true)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.slots).not.toBe(b.slots)
    expect(a.appliedOrders).not.toBe(b.appliedOrders)
  })

  it('不修改入参（能力标志冻结后调用不抛）', () => {
    const caps = Object.freeze({ hasTrayItems: true, pluginToolbarContributionCount: 2 })
    expect(() => resolveComposerDensity(caps, 3, true)).not.toThrow()
    expect(caps).toEqual({ hasTrayItems: true, pluginToolbarContributionCount: 2 })
  })
})
