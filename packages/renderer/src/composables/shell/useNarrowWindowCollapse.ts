/**
 * useNarrowWindowCollapse —— 侧栏窄窗自动折叠（demo shell spec §3.6 P0-3 组件侧）。
 *
 * 挂 matchMedia('(max-width: 960px)')，只写 sidebar store 的视口强制位 viewportNarrow
 * （复用既有折叠形态，不新造「隐藏侧栏」窄窗形态——spec §5「窄窗不断链降级」：侧栏功能在
 * 窄窗仍可达）：
 * - 挂载即查 matches（首屏即窄窗的刷新/小窗直开同步生效）；
 * - change 事件跟随：进断点 → 强制收起；出断点 → 强制解除。
 * 最终折叠 = userCollapsed（用户意图）|| viewportNarrow（本位），弹回与否由 store 派生裁决：
 * 用户点过收起钮（意图=收起）放宽后保持收起；没点过则自动弹回。本 composable 不触碰
 * userCollapsed、不触碰持久化——视口事实与用户意图的正交边界。
 *
 * 挂载点 = AppShell（demo 对应 Workbench.vue 挂 narrowMq 的壳层位置）。matchMedia 缺失
 * （老环境/SSR）静默跳过：窄窗折叠是增强行为，无 API 时视口位保持 false 即正确降级。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useSidebarStore } from '@/stores/sidebar'

/** 窄窗断点（demo Workbench.vue narrowMq 同值） */
const NARROW_QUERY = '(max-width: 960px)'

export function useNarrowWindowCollapse(): void {
  const sidebar = useSidebarStore()

  function onNarrowChange(e: MediaQueryListEvent): void {
    sidebar.viewportNarrow = e.matches
  }

  // 卸载清理句柄在 setup 期声明：onBeforeUnmount 只能在 setup 同步期注册，
  // listener 的实际挂载在 onMounted（句柄就绪后由卸载钩子统一摘除）
  let removeListener: (() => void) | null = null

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const narrowMq = window.matchMedia(NARROW_QUERY)
    sidebar.viewportNarrow = narrowMq.matches
    narrowMq.addEventListener('change', onNarrowChange)
    removeListener = () => narrowMq.removeEventListener('change', onNarrowChange)
  })

  onBeforeUnmount(() => {
    removeListener?.()
    removeListener = null
  })
}
