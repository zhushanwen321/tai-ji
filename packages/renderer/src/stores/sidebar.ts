/**
 * Sidebar store —— tab 切换 + 折叠态（UC-3 / P2）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * activeTab 不持久化：每次应用/页面加载默认锚定到「会话」（启动入口最常用）。
 * 用户会话内切换 tab 不记忆——桌面应用冷启动少，换默认入口的稳定预期优先于个性化恢复。
 * collapsed 持久化（demo shell spec §3.6/§3.8 tj:sideCollapsed 同语义）：刷新后折叠态保持；
 * 窄窗自动折叠（useNarrowWindowCollapse）与手动切换共用同一真源，持久化挂在 store 单点。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/** 折叠态持久化 key（demo tj:sideCollapsed 同语义；real localStorage 前缀约定 = taiji:，同 useDrawerSplitWidth 的 taiji:drawer-width） */
const SIDE_COLLAPSED_KEY = 'taiji:side-collapsed'

/** 读持久化折叠态：解析异常/缺失静默回落 false（隐私模式不崩，demo spec §3.8 同语义） */
function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDE_COLLAPSED_KEY) === 'true'
  } catch (e) {
    console.warn('[sidebar] 读取折叠态持久化失败，回落展开态', e)
    return false
  }
}

function persistCollapsed(v: boolean): void {
  try {
    localStorage.setItem(SIDE_COLLAPSED_KEY, String(v))
  } catch (e) {
    // 隐私模式等写入失败：折叠态是 UI 偏好，丢持久化不损功能，warn 留痕即可
    console.warn('[sidebar] 写入折叠态持久化失败（本会话内折叠仍生效）', e)
  }
}

/**
 * 'plugins' tab：ExtensionHost sidebar view 宿主（挂载点 sidebar.tab，ViewHost view-id=sidebar.tab 同名路由）。
 * 无 plugin 贡献时 ViewHost 空态自隐藏（empty="hidden"），tab 内容区空白不破坏布局。
 *
 * [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：两个任务 tab 对应的联合成员随 Agents/Flows
 * tab 退役删除（任务观察入口唯一化收口到 composer 任务托盘）——类型收窄后按旧成员值摘取的
 * 类型（Extract<SidebarTab, ...>）编译期即断，无需迁移存量值（activeTab 本就不持久化）。
 */
export type SidebarTab = 'sessions' | 'files' | 'plugins'

export const useSidebarStore = defineStore('sidebar', () => {
  const activeTab = ref<SidebarTab>('sessions')
  const collapsed = ref(loadCollapsed())

  /** 折叠态持久化：watch 单点挂（手动切换/窄窗自动折叠/⌘B 全部写入口都经此 ref） */
  watch(collapsed, persistCollapsed)

  /** 切换折叠态（app-nav-controls 收起按钮 + ⌘B 调用） */
  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  return { activeTab, collapsed, toggleCollapsed }
})
