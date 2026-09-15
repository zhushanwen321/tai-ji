/**
 * Sidebar store —— tab 切换 + 折叠态（UC-3 / P2）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * activeTab 不持久化：每次应用/页面加载默认锚定到「会话」（启动入口最常用）。
 * 用户会话内切换 tab 不记忆——桌面应用冷启动少，换默认入口的稳定预期优先于个性化恢复。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 'plugins' tab：ExtensionHost sidebar view 宿主（挂载点 sidebar.tab，ViewHost view-id=sidebar.tab 同名路由）。
 * 无 plugin 贡献时 ViewHost 空态自隐藏（empty="hidden"），tab 内容区空白不破坏布局。
 */
export type SidebarTab = 'sessions' | 'files' | 'subagents' | 'workflows' | 'plugins'

export const useSidebarStore = defineStore('sidebar', () => {
  const activeTab = ref<SidebarTab>('sessions')
  const collapsed = ref(false)

  /** 切换折叠态（app-nav-controls 收起按钮 + 未来 ⌘B 调用） */
  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  return { activeTab, collapsed, toggleCollapsed }
})
