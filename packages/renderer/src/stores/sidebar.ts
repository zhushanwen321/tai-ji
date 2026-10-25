/**
 * Sidebar store —— tab 切换 + 折叠态 + 展开宽度（UC-3 / P2）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * activeTab 不持久化：每次应用/页面加载默认锚定到「会话」（启动入口最常用）。
 * 用户会话内切换 tab 不记忆——桌面应用冷启动少，换默认入口的稳定预期优先于个性化恢复。
 *
 * 展开宽度（widthPx）：唯一写手 = SidebarResizeHandle（拖动 move 实时 setWidth +
 * 拖动结束/键盘微调 persistWidth，拖动中不逐帧写 localStorage——对齐 useDrawerSplitWidth
 * 的持久化时点）。clamp [200, 480]，localStorage 持久化；AsideRegion flexBasis 与
 * Sidebar 内容列宽同源消费此单值。
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

/** 侧栏展开宽度持久化 key（前缀约定同上） */
const SIDE_WIDTH_KEY = 'taiji:side-width'
/** 侧栏默认宽度（px）：demo 权威值 252 + 30（2026-10-21 用户裁决：默认偏窄，放宽到 282；
 *  用户可经 SidebarResizeHandle 拖动/键盘微调覆盖） */
export const SIDE_WIDTH_DEFAULT_PX = 282
/** 侧栏宽度下限（px）：再窄则 footer 三钮行与列表 truncate 挤压不可用 */
export const SIDE_WIDTH_MIN_PX = 200
/** 侧栏宽度上限（px）：常规窗口下不至于把 main 区压到半宽以下 */
export const SIDE_WIDTH_MAX_PX = 480

function clampSideWidth(v: number): number {
  return Math.min(SIDE_WIDTH_MAX_PX, Math.max(SIDE_WIDTH_MIN_PX, v))
}

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

/** 读持久化宽度：缺失/解析异常/越界回落（缺失 key 判 null 走默认——Number(null)=0 会被误 clamp 成下限） */
function loadSideWidth(): number {
  try {
    const raw = localStorage.getItem(SIDE_WIDTH_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? clampSideWidth(n) : SIDE_WIDTH_DEFAULT_PX
  } catch (e) {
    console.warn('[sidebar] 读取宽度持久化失败，回落默认宽度', e)
    return SIDE_WIDTH_DEFAULT_PX
  }
}

function persistSideWidth(v: number): void {
  try {
    localStorage.setItem(SIDE_WIDTH_KEY, String(v))
  } catch (e) {
    // 隐私模式等写入失败：宽度是 UI 偏好，丢持久化不损功能，warn 留痕即可
    console.warn('[sidebar] 写入宽度持久化失败（本会话内宽度仍生效）', e)
  }
}

/**
 * 侧栏 tab 选中值（容器扩展点统一 §6.1/U8：tab 全集从注册表派生后开放，类型降 string）。
 * 已知值常量 = 内置三项的注册表 id（'ui.' 命名空间，与 lib/content-slots.ts 登记的
 * 内置声明同源——常量在此导出供 Sidebar.vue 内容分支消费，注册表登记侧引用同一字面值）。
 *
 * [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：两个任务 tab 对应的联合成员随 Agents/Flows
 * tab 退役删除（任务观察入口唯一化收敛到 composer 任务托盘）——activeTab 本就不持久化。
 * [HISTORICAL] 联合类型降 string（U8）：插件可声明 sidebar.tab，tab 全集不再是编译期
 * 闭集；内置值以常量承载（§6.1 容器类型去枚举同款处理）。
 */
export type SidebarTab = string

export const SIDEBAR_TAB_SESSIONS = 'ui.sessions'
export const SIDEBAR_TAB_FILES = 'ui.files'
export const SIDEBAR_TAB_PLUGINS = 'ui.plugins'

export const useSidebarStore = defineStore('sidebar', () => {
  const activeTab = ref<SidebarTab>(SIDEBAR_TAB_SESSIONS)
  /** 用户意图位：唯一写手 = toggleCollapsed（收起/展开按钮 + ⌘B）。持久化。 */
  const userCollapsed = ref(loadCollapsed())
  /** 视口强制位：唯一写手 = useNarrowWindowCollapse（挂载即查 + matchMedia change）。不持久化。 */
  const viewportNarrow = ref(false)
  /** 最终折叠态（只读派生）：用户意图收起 OR 视口强制收起。 */
  const collapsed = computed(() => userCollapsed.value || viewportNarrow.value)
  /** 展开宽度（px）：唯一写手 = SidebarResizeHandle 的 setWidth。持久化时点归写手（拖动结束/键盘）。 */
  const widthPx = ref(loadSideWidth())

  /** 用户意图持久化：watch 单点挂（toggleCollapsed 是 userCollapsed 唯一写入口） */
  watch(userCollapsed, persistCollapsed)

  /** 宽度写入口（clamp 后写状态，不落盘——持久化由 persistWidth 在拖动结束/键盘微调时点调用） */
  function setWidth(v: number): void {
    widthPx.value = clampSideWidth(v)
  }

  /** 宽度持久化（SidebarResizeHandle 在拖动结束/键盘微调后调用） */
  function persistWidth(): void {
    persistSideWidth(widthPx.value)
  }

  /** 用户意图切换（收起/展开按钮 + ⌘B）：对当前可见形态取反写意图位，不直接写最终 collapsed——
   *  窄窗强制收起态下点开 → 意图=展开（放宽后弹回）；点合 → 意图=收起（放宽后保持收起）。 */
  function toggleCollapsed(): void {
    userCollapsed.value = !collapsed.value
  }

  return { activeTab, userCollapsed, viewportNarrow, collapsed, widthPx, setWidth, persistWidth, toggleCollapsed }
})
