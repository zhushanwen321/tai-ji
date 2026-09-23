/**
 * useComposerBarDensity —— composer 底栏密度接线（u6b / 设计 `mode-system-composer-density`
 * §6.6 D6「实施期以 ResizeObserver 实测 `.composer-bar` 内容宽驱动档位，不硬编码 px 断点」的落实点，
 * 外加溢出兜底方案 A「内容自适应」的 fit 收敛回路）。
 *
 * 职责边界（与 `components/panel/composer-density.ts` 的分工）：
 * - 状态机（只读，不属本单元领地）：`resolveComposerDensity(width, capabilities, thresholds, fitLevel)` ——
 *   纯函数，三档阈值 / 退化序 / fit 形态全在那边；本文件**不复制任何阈值/判据**。
 * - 本文件：壳侧接线——① ResizeObserver 实测容器宽；② 供给能力标志；③ **实测「内容放不下」并逐级
 *   收敛 fit 退化级**；④ 暴露 `density` 与合流容器 class 给模板做「形态 → DOM」映射。
 *
 * fit 收敛回路（方案 A 核心，为什么必须有）：
 * tier 只按容器宽判「起始形态」，判不出内容是否放得下——模型名长短 / i18n / 缓存归因文案
 * （「空闲过期」等）/ 插件贡献数都会改变实宽，固定阈值必然漏判（实测：默认场景 main-panel
 * ~450px 起溢，打开插件 toolbar 或归因文案后 600px 也溢）。故渲染后实测左右两簇的占宽之和
 * （中簇是可压缩占位，可压到 0）与底栏可用宽比较：放不下 → fit 级 +1（形态收紧 → 需求宽下降），
 * 放得下且比上次定级时更宽裕 → fit 级 −1。收敛后不再动作。
 *
 * 为什么不用 `scrollWidth` 自检：底栏是 `justify-end`，溢出时内容整体**左移**（跑出盒外的是
 * 「+」/托盘侧），而 `scrollWidth` 只统计右侧溢出——纯 JS 自检会漏报。故判据取「两簇占宽之和
 * vs 可用宽」（与 `scrollWidth` 无关，方向无关）。
 *
 * 观测三节点（一个 ResizeObserver，多目标）：`.composer-bar`（可用宽变化）+ 左簇 + 右簇
 * （内容变化：模型名/归因文案/gen-stats 帧刷新都会改实宽）。回调经 rAF 合并成一次测量，
 * 避免同帧多次回流；`fitLevel` 变化本身也会改变簇宽 → RO 再次触发 → 下一轮验证，天然闭环。
 *
 * 能力标志来源：
 * - `pluginToolbarContributionCount`：ViewHost 的 `composer.toolbar` 挂载点当前缓存条目（挂载点把
 *   N 个贡献合成**一个** view，故只有布尔面 → 有内容记 1、无记 0；状态机只判定 `> 0`）。
 * - `hasTrayItems`：**不由本文件推导**（托盘三态的唯一真源是 `useTrayCounts` 数据面，唯一实例在
 *   ComposerTray）——外壳经 `update:has-items` 事件上抛，本文件只承载该 ref。缺省 `true`（状态机
 *   的保守缺省），首帧后即被真实值覆盖。
 *
 * 首帧宽度取 `COMPOSER_DENSITY_EXPANDED_MIN_WIDTH`（全展开）而非 0：0 会让首帧闪一次聚合态
 * （实测回调紧随 observe 到达，故「先全展开再按实测收口」是无闪烁的那一侧）。
 *
 * [领地说明] 接线件落在 `panel/tray/` 下（u6b 领地 = Composer.vue 底栏区 + tray/**）；底栏其余部分
 * 未抽离是为了控制 Composer.vue 的 script 行数余量（该文件已贴 300 行硬门禁）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import {
  COMPOSER_DENSITY_EXPANDED_MIN_WIDTH,
  COMPOSER_DENSITY_MAX_FIT_DEGRADATION,
  resolveComposerDensity,
} from '@/components/panel/composer-density'
import type {
  ComposerDensityLayout,
  ComposerFitDegradationLevel,
} from '@/components/panel/composer-density'

/** 插件 toolbar 挂载点名（= Composer 模板 `view-id` 字面量，ViewHost viewId 同源） */
const PLUGIN_TOOLBAR_MOUNT_POINT = 'composer.toolbar'

/** 左右两簇的 data 属性（fit 测量定位用；中簇是可压缩占位，不参与需求宽） */
const CLUSTER_LEFT_SELECTOR = '[data-composer-cluster="left"]'
const CLUSTER_RIGHT_SELECTOR = '[data-composer-cluster="right"]'

/** ResizeObserver 缺失时的一次性告警闸（模块级：分屏多实例 / 重复挂载不刷屏） */
let warnedNoResizeObserver = false

/**
 * 序 1 / 序 2 合流·合体形态的单 chip 容器类（形态 → class 映射的单点，与状态机输出同处）。
 *
 * V2 视觉修订：**去掉实心底 `bg-surface-2` 与圆角**——整行出现 2 个实心 chip 会读作「徽章墙」，
 * 与展开态的纯文本触发器风格断裂；分组改由 `MERGED_CHIP_SEPARATOR_CLASS` 的 1px 发丝竖线表达，
 * 视觉连续且不「突然变微章」。`[&_button]:px-1` 收紧合流态内边距（原 px-2 在合流下过胖）。
 */
export const MERGED_CHIP_CLASS =
  'flex min-w-0 shrink-0 items-center gap-0 [&_button]:px-1'
/**
 * 序 2 合体 chip：在合流基础上对模型名做容器级单行截断，窄档不横向溢出（子组件不在 u6b 领地，
 * 用容器级约束等价收口 D6 的「窄档用模型短名」）。
 */
export const MODEL_MERGED_CHIP_CLASS = `${MERGED_CHIP_CLASS} [&_button_span]:max-w-[88px] [&_button_span]:min-w-0 [&_button_span]:truncate`
/**
 * fit L1（序 6）模型名截断收口：实测 L0/L1 仍放不下时把名字压到 56px + 省略号
 * （模型全名仍在 title 与 popover 内可见，信息不丢）。
 */
export const MODEL_SIMPLIFIED_CHIP_CLASS = `${MERGED_CHIP_CLASS} [&_button_span]:max-w-[56px] [&_button_span]:min-w-0 [&_button_span]:truncate`
/** 展开态（未合流）右簇子组容器：无容器级约束，按钮保持自身 px-2。 */
export const EXPANDED_GROUP_CLASS = 'flex items-center gap-0'
/** V2：合流 chip 内两子组的发丝分隔（1px 竖线，替代实心底的分组表达；landing meta-row 同款范式）。 */
export const MERGED_CHIP_SEPARATOR_CLASS = 'h-3.5 w-px shrink-0 bg-border-strong'

/**
 * 序 2 组容器 class（合流态 × fit 态 → **单一** class）。
 *
 * 之所以是函数而非两段 class 拼接：`max-w-[88px]` 与 `max-w-[56px]` 同属 Tailwind 同一层，
 * 拼接后谁生效取决于样式表顺序而非属性顺序（不确定）；此处按形态选出唯一 class，确定性可选。
 *
 * @param merged 是否合体（tier 序 2）
 * @param simplified fit 是否已到 L1+（模型名截断收口）
 */
export function composerModelGroupClass(merged: boolean, simplified: boolean): string {
  if (simplified) return MODEL_SIMPLIFIED_CHIP_CLASS
  return merged ? MODEL_MERGED_CHIP_CLASS : EXPANDED_GROUP_CLASS
}

/** fit 测量的亚像素/整数取整容差：`demand > avail + 此值` 才算溢出，避免 1px 抖动反复降级。 */
const FIT_TOLERANCE_PX = 1
/** 单轮收敛的最大测量次数（rAF 环失控的硬闸；正常 1–3 轮内收敛）。 */
const FIT_MAX_PASSES = 8

export interface UseComposerBarDensityReturn {
  /** 绑到 `.composer-bar` 的模板 ref（ResizeObserver 观测目标） */
  barRef: Ref<HTMLElement | null>
  /** 状态机输出（档位 / 逐元素形态 / fit 形态 / 溢出菜单可见性）——模板只消费，不二次判定 */
  density: ComputedRef<ComposerDensityLayout>
  /** 托盘三态上抛入口（`@update:has-items` 处理函数：写 `hasTrayItems` 能力标志） */
  onTrayItemsChange: (hasItems: boolean) => void
}

/** 下一帧（无 rAF 的宿主退化为宏任务；测试宿主同样可用） */
function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback)
    return
  }
  setTimeout(callback, 0)
}

/**
 * 接线 composer 底栏密度。**必须在组件 setup 同步调用**（内部 onMounted/onBeforeUnmount 与 inject
 * 都依赖实例上下文）。
 *
 * @param sessionId 焦点 session id（插件 toolbar 贡献数按 session 分区读）
 */
export function useComposerBarDensity(sessionId: Ref<string | null>): UseComposerBarDensityReturn {
  const viewHostSource = inject(VIEW_HOST_SOURCE_KEY, null)

  const barRef = ref<HTMLElement | null>(null)
  const barWidth = ref(COMPOSER_DENSITY_EXPANDED_MIN_WIDTH)
  const hasTrayItems = ref(true)
  /** fit 退化级（方案 A 第二轴）：0 = 未触发；由实测回路收敛，见文件头「fit 收敛回路」 */
  const fitLevel = ref<ComposerFitDegradationLevel>(0)

  /** 插件 toolbar 贡献面（0/1：挂载点合成单 view，只有布尔面） */
  const pluginToolbarContributionCount = computed(() => {
    const sid = sessionId.value
    if (!sid || !viewHostSource) return 0
    const view = viewHostSource.getView(sid, PLUGIN_TOOLBAR_MOUNT_POINT)
    return view !== undefined && view.guiTree.length > 0 ? 1 : 0
  })

  const density = computed(() =>
    resolveComposerDensity(barWidth.value, {
      pluginToolbarContributionCount: pluginToolbarContributionCount.value,
      hasTrayItems: hasTrayItems.value,
    }, {}, fitLevel.value),
  )

  // ── fit 收敛回路（方案 A）─────────────────────────────────────────────

  /** 上次「定级」（fit 级 +1）时的可用宽/需求宽：只有比当时更宽裕才允许降级，避免同宽度 regime 内反复升降 */
  let settledAvail = Number.NaN
  let settledDemand = Number.NaN
  /** rAF 合并闸（同帧多次 RO 回调只测一次） */
  let passScheduled = false
  /** 本轮已跑轮数（硬闸计数） */
  let passCount = 0

  /** 底栏内容可用宽（clientWidth 去内边距；与 RO 的 contentRect 同源但始终是最新值） */
  function availableWidth(bar: HTMLElement): number {
    const style = window.getComputedStyle(bar)
    const pad = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    return bar.clientWidth - pad
  }

  /**
   * 需求宽 = 左簇占宽 + 右簇占宽（中簇 `min-w-0 flex-1` 可压到 0，故不计）。
   * 缺簇（测试宿主/极端模板变更）返回 null = 放弃 fit 自纠，保持当前级不动（不崩、不误降级）。
   */
  function measureDemand(bar: HTMLElement): number | null {
    const left = bar.querySelector<HTMLElement>(CLUSTER_LEFT_SELECTOR)
    const right = bar.querySelector<HTMLElement>(CLUSTER_RIGHT_SELECTOR)
    if (!left || !right) return null
    return left.getBoundingClientRect().width + right.getBoundingClientRect().width
  }

  /** 单轮测量：放不下 → 升级；放得下且更宽裕 → 降级；否则收敛 */
  function runFitPass(): void {
    passScheduled = false
    const bar = barRef.value
    if (!bar) return
    const demand = measureDemand(bar)
    if (demand === null) return
    const avail = availableWidth(bar)
    const overflows = demand > avail + FIT_TOLERANCE_PX

    if (overflows && fitLevel.value < COMPOSER_DENSITY_MAX_FIT_DEGRADATION) {
      fitLevel.value = (fitLevel.value + 1) as ComposerFitDegradationLevel
      settledAvail = avail
      settledDemand = demand
    } else if (
      !overflows &&
      fitLevel.value > 0 &&
      // 迟滞：仅在「比定级时更宽裕」时降级，否则同一宽度下会 1↔2 来回抖
      (!Number.isFinite(settledAvail) ||
        avail > settledAvail + FIT_TOLERANCE_PX ||
        demand < settledDemand - FIT_TOLERANCE_PX)
    ) {
      fitLevel.value = (fitLevel.value - 1) as ComposerFitDegradationLevel
    } else {
      passCount = 0
      return
    }

    passCount += 1
    if (passCount >= FIT_MAX_PASSES) {
      passCount = 0
      return
    }
    scheduleFitPass()
  }

  function scheduleFitPass(): void {
    if (passScheduled) return
    passScheduled = true
    nextFrame(runFitPass)
  }

  let observer: ResizeObserver | null = null
  onMounted(() => {
    // 非浏览器环境（SSR / 无 RO 的测试宿主）跳过：无实测即停留在全展开档，不崩
    if (typeof ResizeObserver === 'undefined') {
      // 降级留痕（P0/P1 降级纪律）：一次性告警，不随实例数刷屏
      if (!warnedNoResizeObserver) {
        warnedNoResizeObserver = true
        console.warn('[composer-density] ResizeObserver 不可用，底栏停留在全展开档（可能横向溢出）')
      }
      return
    }
    const el = barRef.value
    if (!el) return
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 无 target 的 entry（部分宿主/polyfill 形态）按底栏条目处理：照常读 contentRect
        if (entry.target && entry.target !== el) continue
        // 脏输入防御：部分宿主/polyfill 的 entry 可能缺 contentRect 或 width（非有限值交给状态机
        // 按最保守档处理：NaN/±Infinity/负值 → narrow，见 composer-density 的档位判据）
        const width = entry.contentRect?.width
        if (typeof width === 'number') barWidth.value = width
      }
      // 宽度或任一簇内容变化 → 重新判「放不放得下」
      scheduleFitPass()
    })
    observer.observe(el)
    // 两簇内容变化同样要触发 fit 自纠（模型名/归因文案/gen-stats 帧刷新不改容器宽）
    const left = el.querySelector<HTMLElement>(CLUSTER_LEFT_SELECTOR)
    const right = el.querySelector<HTMLElement>(CLUSTER_RIGHT_SELECTOR)
    if (left) observer.observe(left)
    if (right) observer.observe(right)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    passScheduled = false
    passCount = 0
  })

  // 托盘条目面变化会改左簇占宽（逐件 ↔ 聚合），重新判一次
  watch(hasTrayItems, () => scheduleFitPass())

  return {
    barRef,
    density,
    onTrayItemsChange: (hasItems: boolean) => {
      hasTrayItems.value = hasItems
    },
  }
}
