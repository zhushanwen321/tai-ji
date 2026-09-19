/**
 * useComposerBarDensity —— composer 底栏密度接线（u6b / 设计 `.tmp/tech-design/mode-system-composer-density.md`
 * §6.6 D6「实施期以 ResizeObserver 实测 `.composer-bar` 内容宽驱动档位，不硬编码 px 断点」的落实点）。
 *
 * 职责边界（与 `components/panel/composer-density.ts` 的分工）：
 * - 状态机（只读，不属本单元领地）：`resolveComposerDensity(width, capabilities, thresholds)` ——
 *   纯函数，三档阈值与退化序全在那边；本文件**不复制任何阈值/判据**。
 * - 本文件：壳侧接线——① ResizeObserver 实测容器宽；② 供给能力标志；③ 暴露 `density` 给模板做
 *   「形态 → DOM」映射。
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
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import {
  COMPOSER_DENSITY_EXPANDED_MIN_WIDTH,
  resolveComposerDensity,
} from '@/components/panel/composer-density'
import type { ComposerDensityLayout } from '@/components/panel/composer-density'

/** 插件 toolbar 挂载点名（= Composer 模板 `view-id` 字面量，ViewHost viewId 同源） */
const PLUGIN_TOOLBAR_MOUNT_POINT = 'composer.toolbar'

/** ResizeObserver 缺失时的一次性告警闸（模块级：分屏多实例 / 重复挂载不刷屏） */
let warnedNoResizeObserver = false

/**
 * 序 1 / 序 2 合流·合体形态的单 chip 容器类（形态 → class 映射的单点，与状态机输出同处）：
 * 同底色 + 去内部间距，各触发器自身浮层保留为再入路径。序 2 额外对模型名做容器级单行截断，
 * 窄档不横向溢出（子组件不在 u6b 领地，用容器级约束等价收口 D6 的「窄档用模型短名」）。
 */
export const MERGED_CHIP_CLASS =
  'flex min-w-0 shrink-0 items-center gap-0 rounded-sm bg-surface-2 [&_button]:px-1'
export const MODEL_MERGED_CHIP_CLASS = `${MERGED_CHIP_CLASS} [&_button_span]:max-w-[88px] [&_button_span]:truncate`

export interface UseComposerBarDensityReturn {
  /** 绑到 `.composer-bar` 的模板 ref（ResizeObserver 观测目标） */
  barRef: Ref<HTMLElement | null>
  /** 状态机输出（档位 / 逐元素形态 / 溢出菜单可见性）——模板只消费，不二次判定 */
  density: ComputedRef<ComposerDensityLayout>
  /** 托盘三态上抛入口（`@update:has-items` 处理函数：写 `hasTrayItems` 能力标志） */
  onTrayItemsChange: (hasItems: boolean) => void
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
    }),
  )

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
      // 脏输入防御：部分宿主/polyfill 的 entry 可能缺 contentRect 或 width（非有限值交给状态机
      // 按最保守档处理：NaN/±Infinity/负值 → narrow，见 composer-density 的档位判据）
      const width = entries[0]?.contentRect?.width
      if (typeof width === 'number') barWidth.value = width
    })
    observer.observe(el)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return {
    barRef,
    density,
    onTrayItemsChange: (hasItems: boolean) => {
      hasTrayItems.value = hasItems
    },
  }
}
