/**
 * composer-density.ts —— composer 底栏「三簇 + 按序退化 + 溢出兜底」密度状态机（决策 D6）。
 *
 * 设计来源：`.tmp/tech-design/mode-system-composer-density.md` §6.6（决策 D6）。本模块是该
 * 决策的**纯状态机落点**：把「某可用宽度下每个元素长什么样」从组件里剥出来，使该判断可在
 * 零渲染成本下被穷举单测，也让 Composer.vue（u6b 接线）只负责「形态 → DOM」的映射。
 *
 * 输入 → 输出（唯一职责）：
 * - 输入 = 容器可用宽度（px）+ 可选能力标志（插件 toolbar 贡献数 / 托盘是否有条目）
 *   + 可选阈值覆盖；
 * - 输出 = 每类元素的**呈现形态**。不产出 class 名 / 图标名 / 像素值等 DOM 细节——那些由
 *   消费方决定（如聚合入口的图标 = 层叠图标 + 运行数、溢出入口 = 省略号，是两个不同语义，
 *   不得共用图标；该约束属接线层，本模块不表达）。
 *
 * 硬约束（D6）：
 * 1. **永不换行** —— `allowsWrap` 恒 false，输出域里不存在「换行」这种形态；状态机只做
 *    可见性与形态变化（容器 `flex-nowrap` 由消费方落实）。
 * 2. **序 0 不退化** —— 发送位与 `+` 在任何宽度下都是 `expanded`；这一点写进类型
 *    （`'expanded'` 字面量，不是运行时判断），误用会被 tsc 拦住。
 * 3. **累计退化** —— 档位越低，序 1..N 依次叠加（不是互斥选择）：`narrow` 同时含序 1–4。
 * 4. **`»` 菜单仅有被收起项时才存在** —— `overflowMenuVisible` 由 `overflowItems` 非空
 *    派生；默认安装插件 toolbar 零贡献 → 工具栏不渲染，也不产生死入口。
 * 5. **托盘全无条目时不渲染** —— 托盘既有三态（有进行中 / 仅历史 / 全无）的「全无」侧在
 *    密度层同样成立：`hasTrayItems: false` → `absent`，序 4 不生效。
 *
 * 三档阈值（D6：由实测推导，非拍脑袋；消费方以 ResizeObserver 实测内容宽喂入，
 * **不硬编码断点**——模型名长短 / 插件贡献数量会改变实宽）：
 * - `>= COMPOSER_DENSITY_EXPANDED_MIN_WIDTH`（640）→ `expanded`（全展开，序 0）；
 * - `>= COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH`（520）→ `compact`（序 1–3）；
 * - `< 520` → `narrow`（序 1–4，托盘聚合收口）。
 * 边界归属：640 → expanded；520 → compact（两端都用 `>=` 归高档）。
 *
 * 纯函数契约：零 Vue / Pinia / DOM 依赖，无副作用——每次调用返回全新对象与数组、不读写
 * 模块级可变状态、不修改入参，同输入恒同输出。
 */

/** 全展开档下限：`width >= 此值` → `expanded`（D6 三档之「≥640px 全展开」）。 */
export const COMPOSER_DENSITY_EXPANDED_MIN_WIDTH = 640

/** 序 4 门限：`width < 此值` → `narrow`（序 1–4）；`[此值, EXPANDED_MIN)` → `compact`（序 1–3）。 */
export const COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH = 520

/** 三档阈值（可整体/部分覆盖：测试与未来调参入口）。 */
export interface ComposerDensityThresholds {
  /** 全展开档下限（含）。与 `aggregatedBelowWidth` 冲突时本值优先（决定「全展开」）。 */
  readonly expandedMinWidth: number
  /** 序 4 生效门限（不含）：小于此值才应用托盘聚合。 */
  readonly aggregatedBelowWidth: number
}

/** 默认三档阈值（= 上面两个命名常量，D6 定值）。 */
export const DEFAULT_COMPOSER_DENSITY_THRESHOLDS: ComposerDensityThresholds = {
  expandedMinWidth: COMPOSER_DENSITY_EXPANDED_MIN_WIDTH,
  aggregatedBelowWidth: COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH,
}

/** 宽度档位：`expanded`（全展开）· `compact`（序 1–3）· `narrow`（序 1–4）。 */
export type ComposerDensityTier = 'expanded' | 'compact' | 'narrow'

/**
 * 元素呈现形态。状态机输出域**不含「换行」**（D6）：宽度不足只翻译成形态/可见性变化。
 * - `expanded`：原形态；
 * - `merged`：与他项合流/合体为一个 chip；
 * - `collapsed-to-menu`：收进 `»` 溢出菜单；
 * - `aggregated`：聚合为单入口（托盘：层叠图标 + 运行数）；
 * - `absent`：不渲染（无内容，如零贡献插件 toolbar / 全无条目托盘）。
 */
export type ComposerElementForm =
  | 'expanded'
  | 'merged'
  | 'collapsed-to-menu'
  | 'aggregated'
  | 'absent'

/**
 * 退化序（序 0 永不退化，故不入序集）：1 = 容量 + 生成指标合流 · 2 = 模型 + 推理档位合体 ·
 * 3 = 插件 toolbar 进 `»` · 4 = 托盘聚合。数值升序 = 应用先后（累计退化）。
 */
export const COMPOSER_DEGRADATION_ORDER = {
  CAPACITY_METRICS_MERGE: 1,
  MODEL_THINKING_MERGE: 2,
  PLUGIN_TOOLBAR_OVERFLOW: 3,
  TRAY_AGGREGATION: 4,
} as const

/** 退化序号（取值见 `COMPOSER_DEGRADATION_ORDER`）。 */
export type ComposerDegradationOrder =
  (typeof COMPOSER_DEGRADATION_ORDER)[keyof typeof COMPOSER_DEGRADATION_ORDER]

/** 逐元素形态（各槽位类型即其合法形态域；序 0 槽位被写死为 `'expanded'`）。 */
export interface ComposerDensitySlots {
  /** 序 0：`+`（附件 / 新建）——任何宽度都保留原形态。 */
  readonly add: 'expanded'
  /** 序 0：发送位——任何宽度都保留原形态（右锚不漂移）。 */
  readonly send: 'expanded'
  /** 序 1：上下文容量指示——`merged` 时与生成指标合成一个 chip（细节进 hover 浮层）。 */
  readonly capacity: 'expanded' | 'merged'
  /** 序 1：生成指标（速度 / 缓存命中）——`merged` 时与容量合成一个 chip。 */
  readonly genStats: 'expanded' | 'merged'
  /** 序 2：模型 chip——`merged` 时与推理档位合体（popover 内两段）。 */
  readonly model: 'expanded' | 'merged'
  /** 序 2：推理档位——`merged` 时与模型 chip 合体。 */
  readonly thinking: 'expanded' | 'merged'
  /** 序 3：插件 toolbar（`composer.toolbar` 挂载点）——零贡献 `absent`，窄档 `collapsed-to-menu`。 */
  readonly pluginToolbar: 'expanded' | 'collapsed-to-menu' | 'absent'
  /** 序 4：任务托盘——全无条目 `absent`，窄档 `aggregated`（层叠图标 + 运行数）。 */
  readonly tray: 'expanded' | 'aggregated' | 'absent'
}

/** 槽位键（= `ComposerDensitySlots` 的键集，用于溢出菜单条目等集合型输出）。 */
export type ComposerDensitySlotKey = keyof ComposerDensitySlots

/** 可选能力标志（缺省 = 最保守假设：插件零贡献、托盘有面）。 */
export interface ComposerDensityCapabilities {
  /**
   * 插件 `composer.toolbar` 挂载点的贡献数。缺省 0 = 默认安装零贡献
   * → toolbar 与 `»` 菜单均不渲染（D6：不留死入口）。非正数一律视为零贡献。
   */
  readonly pluginToolbarContributionCount?: number
  /**
   * 托盘当前是否有条目（built-in 三件 + 协议 widget 中任一非「全无」态）。
   * 缺省 true。false = 全无 → 沿既有三态规则不渲染，序 4 不生效。
   */
  readonly hasTrayItems?: boolean
}

/** 状态机输出：档位 + 逐元素形态 + 派生集合。 */
export interface ComposerDensityLayout {
  /** 命中的宽度档位。 */
  readonly tier: ComposerDensityTier
  /** 恒 false —— D6 硬约束「永不换行」（消费方据此上 `flex-nowrap`）。 */
  readonly allowsWrap: false
  /** 逐元素呈现形态。 */
  readonly slots: ComposerDensitySlots
  /** 已生效的退化序（升序；由 `slots` 构造性派生，不含未生效的序）。 */
  readonly appliedOrders: readonly ComposerDegradationOrder[]
  /** `»` 溢出菜单是否存在——仅当确有被收起项（= `overflowItems` 非空）。 */
  readonly overflowMenuVisible: boolean
  /** 被收进 `»` 溢出菜单的槽位（当前仅序 3 的 `pluginToolbar`）。 */
  readonly overflowItems: readonly ComposerDensitySlotKey[]
}

/**
 * 宽度 → 档位（边界：`>=` 归高档，即 640 → `expanded`、520 → `compact`）。
 *
 * @param availableWidth 容器可用宽度（px；非有限值/NaN 落 `narrow`，即最保守档）
 * @param thresholds 三档阈值（默认 `DEFAULT_COMPOSER_DENSITY_THRESHOLDS`）
 */
export function resolveComposerDensityTier(
  availableWidth: number,
  thresholds: ComposerDensityThresholds = DEFAULT_COMPOSER_DENSITY_THRESHOLDS,
): ComposerDensityTier {
  if (availableWidth >= thresholds.expandedMinWidth) return 'expanded'
  if (availableWidth >= thresholds.aggregatedBelowWidth) return 'compact'
  return 'narrow'
}

/**
 * 密度状态机：可用宽度 + 能力标志 → 逐元素形态。
 *
 * @param availableWidth 容器可用宽度（px，由 ResizeObserver 实测 `.composer-bar` 内容宽）
 * @param capabilities 可选能力标志（缺省 = 插件零贡献 + 托盘有面）
 * @param thresholdOverrides 三档阈值的部分覆盖（缺省全用命名常量）
 */
export function resolveComposerDensity(
  availableWidth: number,
  capabilities: ComposerDensityCapabilities = {},
  thresholdOverrides: Partial<ComposerDensityThresholds> = {},
): ComposerDensityLayout {
  const thresholds: ComposerDensityThresholds = {
    expandedMinWidth:
      thresholdOverrides.expandedMinWidth ?? COMPOSER_DENSITY_EXPANDED_MIN_WIDTH,
    aggregatedBelowWidth:
      thresholdOverrides.aggregatedBelowWidth ?? COMPOSER_DENSITY_AGGREGATED_BELOW_WIDTH,
  }
  const tier = resolveComposerDensityTier(availableWidth, thresholds)

  // 档位决定退化面：compact/narrow 用序 1–3；narrow 再用序 4（累计）。
  const mergesOrder1And2 = tier !== 'expanded'
  const aggregatesTray = tier === 'narrow'

  const hasPluginToolbarContributions =
    (capabilities.pluginToolbarContributionCount ?? 0) > 0
  const hasTrayItems = capabilities.hasTrayItems ?? true

  // 序 3：零贡献 → 不渲染（也绝不产生死入口）；有贡献才可能被收起。
  const pluginToolbar: ComposerDensitySlots['pluginToolbar'] = !hasPluginToolbarContributions
    ? 'absent'
    : mergesOrder1And2
      ? 'collapsed-to-menu'
      : 'expanded'

  // 序 4：全无条目 → 不渲染（沿用托盘三态契约）；否则窄档才聚合。
  const tray: ComposerDensitySlots['tray'] = !hasTrayItems
    ? 'absent'
    : aggregatesTray
      ? 'aggregated'
      : 'expanded'

  const slots: ComposerDensitySlots = {
    // 序 0：任何宽度都保留原形态。
    add: 'expanded',
    send: 'expanded',
    // 序 1：容量 + 生成指标合流。
    capacity: mergesOrder1And2 ? 'merged' : 'expanded',
    genStats: mergesOrder1And2 ? 'merged' : 'expanded',
    // 序 2：模型 + 推理档位合体。
    model: mergesOrder1And2 ? 'merged' : 'expanded',
    thinking: mergesOrder1And2 ? 'merged' : 'expanded',
    pluginToolbar,
    tray,
  }

  // 溢出菜单条目：当前唯一来源 = 序 3 的插件 toolbar（有被收起项才有 `»`）。
  const overflowItems: ComposerDensitySlotKey[] =
    pluginToolbar === 'collapsed-to-menu' ? ['pluginToolbar'] : []

  // 已生效退化序由 slots 派生（保证 `appliedOrders` 与形态恒一致，不引入第二真源）。
  const appliedOrders: ComposerDegradationOrder[] = []
  if (slots.capacity === 'merged') {
    appliedOrders.push(COMPOSER_DEGRADATION_ORDER.CAPACITY_METRICS_MERGE)
  }
  if (slots.model === 'merged') {
    appliedOrders.push(COMPOSER_DEGRADATION_ORDER.MODEL_THINKING_MERGE)
  }
  if (slots.pluginToolbar === 'collapsed-to-menu') {
    appliedOrders.push(COMPOSER_DEGRADATION_ORDER.PLUGIN_TOOLBAR_OVERFLOW)
  }
  if (slots.tray === 'aggregated') {
    appliedOrders.push(COMPOSER_DEGRADATION_ORDER.TRAY_AGGREGATION)
  }

  return {
    tier,
    allowsWrap: false,
    slots,
    appliedOrders,
    overflowMenuVisible: overflowItems.length > 0,
    overflowItems,
  }
}
