/**
 * Sidebar store —— tab 切换 + 折叠态（UC-3 / P2）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * activeTab 不持久化：每次应用/页面加载默认锚定到「会话」（启动入口最常用）。
 * 用户会话内切换 tab 不记忆——桌面应用冷启动少，换默认入口的稳定预期优先于个性化恢复。
 *
 * 折叠态 = 两个正交事实源的合成（任一为真即折叠）：
 * - userCollapsed：用户显式意图（点过收起钮 = true，点过展开钮 = false）。持久化
 *   （demo shell spec §3.6/§3.8 tj:sideCollapsed 同语义）——用户亲手表达的偏好跨会话保持；
 * - viewportNarrow：视口强制（窄窗断点 matchMedia match）。不持久化——视口是每次启动时的
 *   当下事实，由 useNarrowWindowCollapse 挂载即查 + change 事件写入；放宽窗口自然解除强制。
 * 最终 collapsed 对外只读。窄窗自动收起因此是纯视口驱动的临时形态：用户没表达过收起意图时，
 * 放宽窗口自动弹回；表达过（userCollapsed=true）则保持收起。
 *
 * [HISTORICAL] 单字段混装缺陷：collapsed 曾是单一 ref，窄窗自动收起与手动切换共写同一位并
 * 全部落盘——离开断点后无人写回展开（不弹回），且视口临时态污染用户偏好持久化（从未点过
 * 收起钮的用户刷新后仍折叠）。拆分两事实源后该类补偿逻辑结构性不存在。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

/** 折叠态持久化 key（demo tj:sideCollapsed 同语义；real localStorage 前缀约定 = taiji:，同 useDrawerSplitWidth 的 taiji:drawer-width） */
const SIDE_COLLAPSED_KEY = 'taiji:side-collapsed'

/** 读持久化用户意图：解析异常/缺失静默回落 false（隐私模式不崩，demo spec §3.8 同语义） */
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
 * tab 退役删除（任务观察入口唯一化收敛到 composer 任务托盘）——类型收窄后按旧成员值摘取的
 * 类型（Extract<SidebarTab, ...>）编译期即断，无需迁移存量值（activeTab 本就不持久化）。
 */
export type SidebarTab = 'sessions' | 'files' | 'plugins'

export const useSidebarStore = defineStore('sidebar', () => {
  const activeTab = ref<SidebarTab>('sessions')
  /** 用户意图位：唯一写手 = toggleCollapsed（收起/展开按钮 + ⌘B）。持久化。 */
  const userCollapsed = ref(loadCollapsed())
  /** 视口强制位：唯一写手 = useNarrowWindowCollapse（挂载即查 + matchMedia change）。不持久化。 */
  const viewportNarrow = ref(false)
  /** 最终折叠态（只读派生）：用户意图收起 OR 视口强制收起。 */
  const collapsed = computed(() => userCollapsed.value || viewportNarrow.value)

  /** 用户意图持久化：watch 单点挂（toggleCollapsed 是 userCollapsed 唯一写入口） */
  watch(userCollapsed, persistCollapsed)

  /** 用户意图切换（收起/展开按钮 + ⌘B）：对当前可见形态取反写意图位，不直接写最终 collapsed——
   *  窄窗强制收起态下点开 → 意图=展开（放宽后弹回）；点合 → 意图=收起（放宽后保持收起）。 */
  function toggleCollapsed(): void {
    userCollapsed.value = !collapsed.value
  }

  return { activeTab, userCollapsed, viewportNarrow, collapsed, toggleCollapsed }
})
