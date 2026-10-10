/**
 * useNarrowWindowCollapse —— 侧栏窄窗自动折叠（demo shell spec §3.6 P0-3 组件侧）。
 *
 * 挂 matchMedia('(max-width: 960px)')：
 * - 进入 ≤960px 断点 → sidebar.collapsed = true（复用既有折叠形态，不新造「隐藏侧栏」窄窗形态
 *   ——spec §5「窄窗不断链降级」：侧栏功能在窄窗仍可达）；
 * - 离开断点不强制展开（尊重用户手动选择；折叠态持久化归 sidebar store 单点）；
 * - 首屏即窄窗（刷新 / 小窗直开）同步折叠（挂载即查 matches）。
 *
 * 挂载点 = AppShell（demo 对应 Workbench.vue 挂 narrowMq 的壳层位置）。matchMedia 缺失
 * （老环境/SSR）静默跳过：窄窗折叠是增强行为，无 API 时展开态即正确降级。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useSidebarStore } from '@/stores/sidebar'

/** 窄窗断点（demo Workbench.vue narrowMq 同值） */
const NARROW_QUERY = '(max-width: 960px)'

export function useNarrowWindowCollapse(): void {
  const sidebar = useSidebarStore()

  function onNarrowChange(e: MediaQueryListEvent): void {
    if (e.matches) sidebar.collapsed = true
  }

  // 卸载清理句柄在 setup 期声明：onBeforeUnmount 只能在 setup 同步期注册，
  // listener 的实际挂载在 onMounted（句柄就绪后由卸载钩子统一摘除）
  let removeListener: (() => void) | null = null

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const narrowMq = window.matchMedia(NARROW_QUERY)
    narrowMq.addEventListener('change', onNarrowChange)
    if (narrowMq.matches) sidebar.collapsed = true
    removeListener = () => narrowMq.removeEventListener('change', onNarrowChange)
  })

  onBeforeUnmount(() => {
    removeListener?.()
    removeListener = null
  })
}
