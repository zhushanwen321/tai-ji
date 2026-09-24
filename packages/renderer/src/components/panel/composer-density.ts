/**
 * composer-density.ts —— composer 底栏「三步聚合」密度状态机（决策 D6 修订版）。
 *
 * ── 现行职责（本版）──
 * 把「底栏各组在当前退化级下长什么样」从组件里剥出来，使该判断可在零渲染成本下被穷举单测，
 * Composer.vue 只负责「形态 → DOM」的映射。
 *
 * 输入 → 输出：
 * - 输入 = 能力标志（插件 toolbar 贡献 / 托盘是否有条目）+ **fit 退化级（0–3）** + 锚点保护标志；
 * - 输出 = 逐组呈现形态（`slots`）+ 已生效退化序（`appliedOrders`）+ 锚点保护态。
 *
 * 退化序（D6 修订「三步聚合」，评审 demo 对齐；累计生效，级数由接线层实测溢出后逐级喂入）：
 * - 序 0（类型级保证，不入序集）：`+` 与发送按钮**恒不退化、不被裁剪**（锚点）。
 * - 序 1（L1）：左簇（托盘 + 插件 toolbar 散图标）→ **1 个单图标聚合按钮**（click 弹全图标列表）。
 * - 序 2（L2）：指标（容量 + 速度 + 缓存）→ **1 个单图标聚合按钮**（hover 弹指标聚合页）。
 * - 序 3（L3）：模型 + 思考等级 → **1 个单图标聚合按钮**（click 弹模型+思考，hover 行内即切换）。
 *   模型名形态域**只有两态**：完整展示 / 聚合按钮——**不存在任何中间截断态**（见 [HISTORICAL]）。
 * - 顶格（L3）仍实测放不下 → `anchorProtected`：左簇与指标聚合按钮隐藏，只留模型聚合按钮 +
 *   两侧锚点（沿用 D6「模型+档位恒留底栏、任何宽度可切模型」约束）；再放不下 = 病理窄宽，交由
 *   接线层测量兜底（记录为已知边界）。
 *
 * 与旧版（tier + fit 双轴）的差异 [HISTORICAL]：
 * - **tier 固定阈值轴（≥640/≥520 三档）已退役**：旧版按容器宽判「起始形态」再叠 fit 轴，
 *   导致「合体 chip 无条件 88px 截断」这类**与实测溢出脱钩**的退化（宽 640 以下即使整栏放得下
 *   也截模型名）。新版全部形态由实测溢出驱动的 fit 级唯一决定；`COMPOSER_DENSITY_EXPANDED_MIN_WIDTH`
 *   仅保留作 ResizeObserver 首回调前的**首帧种子宽**，不是断点。
 * - **88px / 56px 模型名截断态删除**（原 `MODEL_MERGED_CHIP_CLASS` / `MODEL_SIMPLIFIED_CHIP_CLASS`）。
 * - **`»` Ellipsis 溢出菜单退役**（原 `overflowItems` / `overflowMenuVisible`：插件 toolbar 并入
 *   左簇聚合按钮，指标并入指标聚合按钮，底栏不再有省略号入口）。
 * - **simplified / iconic / merged 中间态删除**（原 `ComposerFitForms` 与 slots merged 形态）。
 *
 * 硬约束：
 * 1. **永不换行** —— `allowsWrap` 恒 false；容器 `flex-nowrap` 由消费方落实。
 * 2. **序 0 不退化** —— `slots.add` / `slots.send` 写死 `'expanded'` 字面量，误用被 tsc 拦。
 * 3. **累计退化** —— 级数越高，序 1..N 依次生效（不是互斥选择）。
 * 4. **不留死入口** —— 托盘全无条目且插件零贡献 → `leftCluster: 'absent'`（不渲染聚合按钮）。
 *
 * 纯函数契约：零 Vue / Pinia / DOM 依赖，无副作用——每次调用返回全新对象与数组、不读写模块级
 * 可变状态、不修改入参，同输入恒同输出。**不读容器宽度**：宽度→fit 级的换算（测量回路）在
 * 接线层 `tray/use-composer-bar-density.ts`，本模块只做「级 → 形态」映射。
 */

/**
 * 首帧种子宽：ResizeObserver 首回调前按全展开渲染，避免首帧闪聚合态。
 * [HISTORICAL] 原为全展开档断点（≥640 expanded / ≥520 compact），tier 轴退役后**不再参与形态判定**。
 */
export const COMPOSER_DENSITY_EXPANDED_MIN_WIDTH = 640

/** fit 退化级命名常量（L0–L3，= 退化序 1–3） */
export const COMPOSER_FIT_LEVEL_NONE = 0
/** L1：左簇（托盘 + 插件 toolbar）→ 单图标聚合按钮 */
export const COMPOSER_FIT_LEVEL_LEFT_AGGREGATE = 1
/** L2：指标（容量 + 速度 + 缓存）→ 单图标聚合按钮（hover 聚合页） */
export const COMPOSER_FIT_LEVEL_METRICS_AGGREGATE = 2
/** L3：模型 + 思考 → 单图标聚合按钮（click 弹层 + hover 行内切换） */
export const COMPOSER_FIT_LEVEL_MODEL_AGGREGATE = 3

/**
 * fit 轴最大退化级（L3 顶格）。顶格后仍放不下 → 接线层置锚点保护（`anchorOverflow` 入参），
 * 本模块映射为 `anchorProtected` 形态；再放不下即病理窄宽（< 纯锚点 + 模型按钮宽），已知边界。
 */
export const COMPOSER_DENSITY_MAX_FIT_DEGRADATION = COMPOSER_FIT_LEVEL_MODEL_AGGREGATE

/** 可选能力标志（缺省 = 最保守假设：插件零贡献、托盘有面）。 */
export interface ComposerDensityCapabilities {
  /**
   * 插件 `composer.toolbar` 挂载点的贡献数。缺省 0 = 默认安装零贡献 → 左簇聚合按钮不含插件段
   * （托盘有条目时仍有托盘段）。非正数一律视为零贡献。
   */
  readonly pluginToolbarContributionCount?: number
  /**
   * 托盘当前是否有条目（built-in 三件 + 协议 widget 中任一非「全无」态）。
   * 缺省 true。false = 全无 → 沿托盘三态规则不渲染；与插件零贡献同时成立 → `leftCluster: 'absent'`。
   */
  readonly hasTrayItems?: boolean
}

/** 退化序（序 0 不入序集）：数值升序 = 应用先后（累计退化）。 */
export const COMPOSER_DEGRADATION_ORDER = {
  /** 序 1：左簇 → 单图标聚合按钮。 */
  LEFT_CLUSTER_AGGREGATE: 1,
  /** 序 2：指标 → 单图标聚合按钮。 */
  METRICS_AGGREGATE: 2,
  /** 序 3：模型 + 思考 → 单图标聚合按钮。 */
  MODEL_THINKING_AGGREGATE: 3,
} as const

/** 退化序号（取值见 `COMPOSER_DEGRADATION_ORDER`）。 */
export type ComposerDegradationOrder =
  (typeof COMPOSER_DEGRADATION_ORDER)[keyof typeof COMPOSER_DEGRADATION_ORDER]

/** 逐组形态（各槽位类型即其合法形态域；序 0 槽位被写死为 `'expanded'`）。 */
export interface ComposerDensitySlots {
  /** 序 0：`+`（添加内容）——任何宽度都保留原形态、不被裁剪。 */
  readonly add: 'expanded'
  /** 序 0：发送位——任何宽度都保留原形态（右锚不漂移、不被裁剪）。 */
  readonly send: 'expanded'
  /**
   * 序 1：左簇（托盘 + 插件 toolbar）——`expanded` 散图标 / `aggregated` 单图标聚合按钮 /
   * `absent` 无内容（托盘全无且插件零贡献）或锚点保护态隐藏。
   */
  readonly leftCluster: 'expanded' | 'aggregated' | 'absent'
  /** 序 2：指标（容量 + 速度 + 缓存）——`aggregated` 单图标聚合按钮 / `absent` 锚点保护态隐藏。 */
  readonly metrics: 'expanded' | 'aggregated' | 'absent'
  /**
   * 序 3：模型 + 思考——`aggregated` 单图标聚合按钮 / `expanded` 完整形态（模型名**恒完整展示**，
   * 无截断态）。**恒不为 `absent`** —— 切模型/切档位是底栏核心动作，任何宽度保留可点入口。
   */
  readonly modelThinking: 'expanded' | 'aggregated'
}

/** fit 退化级（0–L3）。 */
// eslint-disable-next-line no-magic-numbers -- 级数字面量即档位语义本身，命名常量见 COMPOSER_FIT_LEVEL_*
export type ComposerFitDegradationLevel = 0 | 1 | 2 | 3

/** 状态机输出：逐组形态 + 生效退化序 + fit 级 + 锚点保护态。 */
export interface ComposerDensityLayout {
  /** 恒 false —— 硬约束「永不换行」（消费方据此上 `flex-nowrap`）。 */
  readonly allowsWrap: false
  /** 逐组呈现形态（由 fit 级 + 能力标志 + 锚点保护唯一决定）。 */
  readonly slots: ComposerDensitySlots
  /** 已生效的退化序（升序）= fit 级前缀对应的序 1..N（由 fitLevel 派生，不引入第二真源）。 */
  readonly appliedOrders: readonly ComposerDegradationOrder[]
  /** 生效的 fit 退化级（0–3；由入参归一后原样带回，供接线层与测试断言收敛结果）。 */
  readonly fitLevel: ComposerFitDegradationLevel
  /**
   * 锚点保护态：L3 顶格仍实测放不下时为 true——`leftCluster` / `metrics` 被置 `absent`
   * （渲染层据此隐藏），只留模型聚合按钮与两侧锚点。
   */
  readonly anchorProtected: boolean
}

/** fit 级归一：`NaN`（脏输入）→ 0；其余收敛到 `[0, MAX]`（`+Infinity` 视为越界 → 顶格）。 */
export function normalizeComposerFitLevel(level: number): ComposerFitDegradationLevel {
  if (Number.isNaN(level)) return COMPOSER_FIT_LEVEL_NONE
  if (level <= COMPOSER_FIT_LEVEL_NONE) return COMPOSER_FIT_LEVEL_NONE
  if (level >= COMPOSER_DENSITY_MAX_FIT_DEGRADATION) return COMPOSER_DENSITY_MAX_FIT_DEGRADATION
  return Math.round(level) as ComposerFitDegradationLevel
}

/** fit 级 → 已生效退化序（前缀累计；与 slots 恒一致——二者同源于 fitLevel，单真源）。 */
function deriveAppliedOrders(fitLevel: ComposerFitDegradationLevel): ComposerDegradationOrder[] {
  const orders: ComposerDegradationOrder[] = []
  if (fitLevel >= COMPOSER_FIT_LEVEL_LEFT_AGGREGATE) orders.push(COMPOSER_DEGRADATION_ORDER.LEFT_CLUSTER_AGGREGATE)
  if (fitLevel >= COMPOSER_FIT_LEVEL_METRICS_AGGREGATE) orders.push(COMPOSER_DEGRADATION_ORDER.METRICS_AGGREGATE)
  if (fitLevel >= COMPOSER_FIT_LEVEL_MODEL_AGGREGATE) orders.push(COMPOSER_DEGRADATION_ORDER.MODEL_THINKING_AGGREGATE)
  return orders
}

/**
 * 三步聚合状态机：能力标志 + fit 退化级 + 锚点保护标志 → 逐组形态。
 *
 * @param capabilities 可选能力标志（缺省 = 插件零贡献 + 托盘有面）
 * @param fitDegradation fit 退化级（0–3；接线层实测溢出后逐级喂入，缺省 0 = 全展开）
 * @param anchorOverflow L3 顶格仍实测放不下（接线层测量喂入；仅在 fit=L3 时有意义）
 */
export function resolveComposerDensity(
  capabilities: ComposerDensityCapabilities = {},
  fitDegradation: number = COMPOSER_FIT_LEVEL_NONE,
  anchorOverflow: boolean = false,
): ComposerDensityLayout {
  const fitLevel = normalizeComposerFitLevel(fitDegradation)
  // 锚点保护只在顶格生效（低级时先走正常的三级退化；调用方语义上也只会在 L3 置位）
  const anchorProtected = fitLevel >= COMPOSER_FIT_LEVEL_MODEL_AGGREGATE && anchorOverflow

  const hasPluginToolbarContributions = (capabilities.pluginToolbarContributionCount ?? 0) > 0
  const hasTrayItems = capabilities.hasTrayItems ?? true

  const slots: ComposerDensitySlots = {
    // 序 0：任何宽度都保留原形态。
    add: 'expanded',
    send: 'expanded',
    // 序 1：左簇。无内容（托盘全无 + 插件零贡献）或锚点保护 → 不渲染；L1 起聚合；否则展开。
    leftCluster:
      !hasTrayItems && !hasPluginToolbarContributions
        ? 'absent'
        : anchorProtected
          ? 'absent'
          : fitLevel >= COMPOSER_FIT_LEVEL_LEFT_AGGREGATE
            ? 'aggregated'
            : 'expanded',
    // 序 2：指标。锚点保护 → 隐藏；L2 起聚合；否则展开（landing 无 session 的隐藏归渲染层 v-if）。
    metrics: anchorProtected
      ? 'absent'
      : fitLevel >= COMPOSER_FIT_LEVEL_METRICS_AGGREGATE
        ? 'aggregated'
        : 'expanded',
    // 序 3：模型 + 思考。L3 起聚合；否则完整形态（模型名恒完整，无中间截断态）；恒不缺席。
    modelThinking: fitLevel >= COMPOSER_FIT_LEVEL_MODEL_AGGREGATE ? 'aggregated' : 'expanded',
  }

  return {
    allowsWrap: false,
    slots,
    appliedOrders: deriveAppliedOrders(fitLevel),
    fitLevel,
    anchorProtected,
  }
}
