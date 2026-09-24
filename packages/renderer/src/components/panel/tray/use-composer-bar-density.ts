/**
 * useComposerBarDensity —— composer 底栏密度接线（D6 修订「三步聚合」的测量回路落实点）。
 *
 * 职责边界（与 `components/panel/composer-density.ts` 的分工）：
 * - 状态机（只读，不属本单元领地）：`resolveComposerDensity(capabilities, fitLevel, anchorOverflow)` ——
 *   纯函数，「级 → 形态」映射全在那边；本文件**不复制任何形态判据**。
 * - 本文件：壳侧接线——① ResizeObserver 触发重测；② 供给能力标志；③ **实测「内容放不下」并逐级
 *   收敛 fit 退化级（0–3）+ 顶格锚点保护**；④ 暴露 `density` 与分组容器 class 给模板做形态→DOM 映射。
 *
 * 测量收敛回路：
 * tier 固定阈值轴退役后（[HISTORICAL] 原 ≥640/≥520 三档判「起始形态」——固定阈值判不出内容是否
 * 放得下：模型名长短 / i18n / 归因文案都会改变实宽，且曾导致「放得下也截模型名」），**唯一判据 =
 * 实测**：渲染后量左右两簇占宽之和（中簇是可压缩占位，可压到 0）与底栏可用宽比较——
 * 放不下 → fit 级 +1（形态收敛 → 需求宽下降），放得下且比定级时更宽裕 → fit 级 −1；
 * fit=L3 顶格仍放不下 → 置锚点保护（隐藏左簇聚合与指标按钮，只留模型聚合按钮 + 两侧锚点），
 * 保护仅在「窗口比定级时更宽裕」时解除（单边迟滞，防隐藏↔显示抖动）。
 *
 * 为什么不用 `scrollWidth` 自检：底栏是 `justify-end`，溢出时内容整体**左移**（跑出盒外的是
 * 「+」/托盘侧），而 `scrollWidth` 只统计右侧溢出——纯 JS 自检会漏报。故判据取「两簇占宽之和
 * vs 可用宽」（与 `scrollWidth` 无关，方向无关）。锚点保护即为该左裁行为的兜底：顶格仍溢出时
 * 先让中部让位，`+` 与发送按钮永不被裁。
 *
 * 观测三节点（一个 ResizeObserver，多目标）：`.composer-bar`（可用宽变化）+ 左簇 + 右簇
 * （内容变化：模型名/归因文案/gen-stats 帧刷新都会改实宽）。回调经 rAF 合并成一次测量，
 * 避免同帧多次回流；`fitLevel` 变化本身也会改变簇宽 → RO 再次触发 → 下一轮验证，天然闭环。
 *
 * 能力标志来源：
 * - `pluginToolbarContributionCount`：ViewHost 的 `composer.toolbar` 挂载点当前缓存条目（挂载点把
 *   N 个贡献合成**一个** view，故只有布尔面 → 有内容记 1、无记 0；状态机只判定 `> 0`）。
 * - `hasTrayItems`：**不由本文件推导**（托盘三态的唯一真源是 `useTrayCounts` 数据面，唯一实例在
 *   ComposerTray）——外壳经 `update:has-items` 事件上抛，本文件只承载该 ref。缺省 `true`
 *   （状态机的保守缺省），首帧后即被真实值覆盖。
 *
 * 首帧宽度取 `COMPOSER_DENSITY_EXPANDED_MIN_WIDTH` 种子语义等价物——fitLevel 初值 0（全展开）：
 * 实测回调紧随 observe 到达，「先全展开再按实测收口」是无闪烁的那一侧。
 *
 * [领地说明] 接线件落在 `panel/tray/` 下（u6b 领地 = Composer.vue 底栏区 + tray/**）；底栏其余部分
 * 未抽离是为了控制 Composer.vue 的 script 行数余量（该文件已贴 300 行硬门禁）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import {
  COMPOSER_DENSITY_MAX_FIT_DEGRADATION,
  COMPOSER_FIT_LEVEL_NONE,
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
 * 展开态分组容器类（未聚合时的子组容器：模型+思考、指标三触发器平铺）。
 * [HISTORICAL] 原有 MERGED_CHIP_CLASS（合流单 chip）/ MODEL_MERGED_CHIP_CLASS（88px 截断）/
 * MODEL_SIMPLIFIED_CHIP_CLASS（56px 截断）/ MERGED_CHIP_SEPARATOR_CLASS（发丝分隔）已随
 * tier 合流态与截断态删除——模型名非聚合态恒完整展示，分组视觉仅剩本展开态容器。
 */
export const EXPANDED_GROUP_CLASS = 'flex items-center gap-0'

/**
 * ── btw 按钮退化序登记（btw-question D7，M3-b）─────────────────────────────
 *
 * 左簇新增的 btw 旁路提问入口（`ComposerBtwButton.vue`，位次 = `+` 之后、任务托盘之前）
 * 登记位 = **序 0（不退化）**，与 `+` / 发送位同档：
 *
 * - 徽标（badge）是后台回复的唯一通知载体（PRODUCT 原则 2「通知驱动，不打扰」），
 *   任何密度档都必须在场——隐藏即漏看；故不入三步聚合（左簇→指标→模型+思考）的收敛面。
 * - 按钮形态不随密度档变化（纯 icon + 角标，无可压缩内容）→ **不设状态机槽位**
 *   （`composer-density.ts` 是只读纯状态机，不感知 btw——本单元领地边界）；其宽度需求
 *   计入左簇实测（`CLUSTER_LEFT` ResizeObserver 观测），溢出时由实测收敛回路让位。
 * - 状态机已生效退化序集合（`ComposerDegradationOrder`）的语义与输出不因本按钮改变
 *   （守护用例：`src/__tests__/panel/composer-btw-button.test.ts`「三档宽度常驻 + `+` 仍居首位」）。
 *
 * 值取 0 = 「序 0 不退化」登记位语义（与状态机已生效退化序集合正交——那边是已生效退化序
 * 的集合，这边是新元素的登记位）；测试与后续单元引用此常量，禁止在别处硬编码 0。
 */
export const COMPOSER_BTW_BUTTON_DEGRADATION_ORDER = 0

/**
 * 聚合态分组容器：单图标聚合按钮的挂载位（min-w-0 + shrink-0：不撑宽、不参与截断——按钮本身
 * 是单图标，恒定窄宽）。
 */
export const AGGREGATE_GROUP_CLASS = 'flex min-w-0 shrink-0 items-center'

/** fit 测量的亚像素/整数取整容差：`demand > avail + 此值` 才算溢出，避免 1px 抖动反复降级。 */
const FIT_TOLERANCE_PX = 1
/** 单轮收敛的最大测量次数（rAF 环失控的硬闸；正常 1–3 轮内收敛）。 */
const FIT_MAX_PASSES = 8

export interface UseComposerBarDensityReturn {
  /** 绑到 `.composer-bar` 的模板 ref（ResizeObserver 观测目标） */
  barRef: Ref<HTMLElement | null>
  /** 状态机输出（逐组形态 / fit 级 / 锚点保护）——模板只消费，不二次判定 */
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
  const hasTrayItems = ref(true)
  /** fit 退化级（0–3）：0 = 未触发；由实测回路收敛，见文件头「测量收敛回路」 */
  const fitLevel = ref<ComposerFitDegradationLevel>(0)
  /**
   * 锚点保护态：L3 顶格仍放不下 → 置位（隐藏左簇聚合 + 指标按钮）；仅当窗口比定级时更宽裕才解除。
   * [HISTORICAL] 旧版无此态：顶格仍溢出时 `justify-end` 直接把 `+`/托盘侧裁出盒外（代码自述
   * 「跑出盒外的是 + 侧」）——新规格锚点零裁剪，中部先让位。
   */
  const anchorProtected = ref(false)

  /** 插件 toolbar 贡献面（0/1：挂载点合成单 view，只有布尔面） */
  const pluginToolbarContributionCount = computed(() => {
    const sid = sessionId.value
    if (!sid || !viewHostSource) return 0
    const view = viewHostSource.getView(sid, PLUGIN_TOOLBAR_MOUNT_POINT)
    return view !== undefined && view.guiTree.length > 0 ? 1 : 0
  })

  const density = computed(() =>
    resolveComposerDensity(
      {
        pluginToolbarContributionCount: pluginToolbarContributionCount.value,
        hasTrayItems: hasTrayItems.value,
      },
      fitLevel.value,
      anchorProtected.value,
    ),
  )

  // ── 测量收敛回路 ─────────────────────────────────────────────────────

  /**
   * 上次「定级」（fit 级 +1 / 锚点保护置位）时的可用宽：降级/解保护只看**窗口变宽**。
   * [HISTORICAL] 旧迟滞还看 `demand < settledDemand`（内容变矮）——但自身降级后 demand 必然变小，
   * 该条款被自己造成的变矮污染，会在同一宽度下 1↔2 抖动（MAX_PASSES 只是掩盖）；删之，
   * 内容变矮留在高一级不损失正确性（只是略保守），窗口变宽时自会逐级还原。
   */
  let settledAvail = Number.NaN
  /** rAF 合并闸（同帧多次 RO 回调只测一次） */
  let passScheduled = false
  /** 本轮已跑轮数（硬闸计数） */
  let passCount = 0

  /** 底栏内容可用宽（clientWidth 去内边距；脏值（隐藏中/非有限）按 0 → 逼向最保守聚合态） */
  function availableWidth(bar: HTMLElement): number {
    const style = window.getComputedStyle(bar)
    const pad = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    const width = bar.clientWidth - pad
    return Number.isFinite(width) && width > 0 ? width : 0
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

  /** 单轮测量：放不下 → 升级（顶格则锚点保护）；放得且更宽裕 → 解保护/降级；否则收敛 */
  function runFitPass(): void {
    passScheduled = false
    const bar = barRef.value
    if (!bar) return
    const demand = measureDemand(bar)
    if (demand === null) return
    const avail = availableWidth(bar)
    const overflows = demand > avail + FIT_TOLERANCE_PX
    // 迟滞：仅当「窗口比上次定级时更宽」才降级/解保护（同一宽度 regime 内不反复升降）
    const windowWidened = !Number.isFinite(settledAvail) || avail > settledAvail + FIT_TOLERANCE_PX

    let changed = false
    if (anchorProtected.value) {
      // 保护态：解除条件**只看窗口变宽**（demand 因隐藏而变小是常态，不作解除依据——否则抖动）；
      // 解除不刷新 settledAvail（升到重置保护/重新升级时才重新定级）
      if (!overflows && windowWidened) {
        anchorProtected.value = false
        changed = true
      }
      // 保护态下仍溢出（病理窄宽）→ 维持保护（锚点已是最后底线），不动作
    } else if (overflows) {
      if (fitLevel.value < COMPOSER_DENSITY_MAX_FIT_DEGRADATION) {
        // 常规升级：溢出即升，settledAvail 记录本次定级（降级/解保护只认窗口变宽）
        fitLevel.value = (fitLevel.value + 1) as ComposerFitDegradationLevel
        settledAvail = avail
        changed = true
      } else {
        // 顶格仍溢出 → 置锚点保护（中部让位，`+`/发送/模型入口零裁剪）
        anchorProtected.value = true
        settledAvail = avail
        changed = true
      }
    } else if (fitLevel.value > COMPOSER_FIT_LEVEL_NONE && windowWidened) {
      // 降级（含顶格 L3→L2：解保护后的下一轮就走本支）：不刷新 settledAvail——
      // 窗口一次大幅拉宽可连续降多级，直到某级溢出再升级重新定级
      fitLevel.value = (fitLevel.value - 1) as ComposerFitDegradationLevel
      changed = true
    }

    if (!changed) {
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
    // 非浏览器环境（SSR / 无 RO 的测试宿主）跳过：无实测即停留在全展开态，不崩
    if (typeof ResizeObserver === 'undefined') {
      // 降级留痕（P0/P1 降级纪律）：一次性告警，不随实例数刷屏
      if (!warnedNoResizeObserver) {
        warnedNoResizeObserver = true
        console.warn('[composer-density] ResizeObserver 不可用，底栏停留在全展开态（可能横向溢出）')
      }
      return
    }
    const el = barRef.value
    if (!el) return
    observer = new ResizeObserver(() => {
      // 宽度或任一簇内容变化 → 重新判「放不放得下」（可用宽在 pass 内实测最新 clientWidth，
      // 不从 entry 缓存——fit 级变化后的回验与窗口 resize 走同一读口）
      scheduleFitPass()
    })
    observer.observe(el)
    // 两簇内容变化同样要触发自纠（模型名/归因文案/gen-stats 帧刷新不改容器宽）
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

  // 托盘条目面 / 插件贡献变化会改左簇占宽（散图标 ↔ 聚合 ↔ 缺席），重新判一次
  watch(hasTrayItems, () => scheduleFitPass())
  watch(pluginToolbarContributionCount, () => scheduleFitPass())

  return {
    barRef,
    density,
    onTrayItemsChange: (hasItems: boolean) => {
      hasTrayItems.value = hasItems
    },
  }
}
