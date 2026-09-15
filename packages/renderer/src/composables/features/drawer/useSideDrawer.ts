/**
 * useSideDrawer —— SideDrawer 打开/钉住/tab 状态控制（per-session 分区，ADR-0053）。
 *
 * 兼容层（W1 迁移后 core/domain/drawer 为 SSOT）。
 *
 * 架构演进（ADR-0053 → W1 core 归位）：isOpen/activeTab/docked 从全局模块级单例 ref 改为
 * per-session Map 分区（useSessionScopedState，ADR-0049），分区键 focusedSessionId（panel
 * store 派生：active panel 绑定的 sessionId）；W1 将控制态（control.ts）+ 协同逻辑
 * （coordination.ts：pendingOpen 守卫 / 瞬时参数 / openTasksDrawerOnFirstData）整体迁入
 * @taiji/core/domain/drawer。本文件不再持有任何业务状态，仅做两件事：
 *
 * 1. 绑定分区键：bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
 *    ——惰性 computed（首次求值 pinia 已 active，避免模块加载期 pinia 未初始化）
 * 2. re-export + 函数形状兼容：useSideDrawer() 返回形状与旧版逐字段一致（isOpen/activeTab/
 *    docked/selectedCommandName/detailFilePath/browserUrl/consumeBrowserUrl/open/close/
 *    toggle/setTab/toggleDock），~20 处旧调用方（SideDrawer.vue/PanelContainer.vue/
 *    useSidebar/useDetailPane/chat.ts 等）import '@/composables/
 *    features/useSideDrawer' 路径不变、零改动。
 *
 * 旧 SideDrawer 删除后本兼容层可一并移除（core/domain/drawer 已是 SSOT，新代码直接 import core）。
 *
 * ── 兼容层消费方清单（W5 drawer-boundaries-gate 登记，删除前置知识）──
 * 删除本文件前置条件：B + C + D 全部解除后，本文件可删除（core/domain/drawer 为 SSOT，
 * 新代码直接 import '@taiji/core/domain/drawer'）。
 *
 * A 已直连 core、仅注释提及（无 import）：PanelContainer.vue（line 19/173 注释）、
 *   PanelContainer.test.ts（注释）、useSearchModal.ts（注释）、stores/panel.ts（注释）、
 *   turn-skill-badge.test.ts（注释）。无需迁移。
 * [P4 s5 drawer-widget-removal] 原 B 项（useSidebar.ts consumePendingOpen）已随本 wave 删除
 *   （pendingOpen 机制整体移除）。
 * C 待 chat-w6 迁移（认知外文件，不触碰）：useChatViewDeps.ts:35 import
 *   { useSideDrawer, type SideDrawerTab }——chat-w6 迁移后改指向 core API。
 * D 可平滑迁移（改 import 指向 '@taiji/core/domain/drawer' 即可，~11 生产 + ~14 测试）：
 *   生产：useRunInTerminal.ts / useCloseShortcut.ts
 *   （isOpen/close）/ useDetailPane.ts（detailFilePath）/ useSidebar.ts（open）/ stores/chat.ts
 *   （open('tasks') + setPendingOpenForSid）/ FileTreeRow.vue / Sidebar.vue（open）/ GitPanel.vue /
 *   CommandDocPanel.vue（selectedCommandName）/ lib/search-types.ts（类型 re-export）。
 *   测试：useSideDrawer.test.ts（兼容层自身）/ useDetailPane.test.ts / useCloseShortcut.test.ts /
 *   fast-fork-e2e-journeys.test.ts /
 *   drawer-injection-entries.test.ts / command-doc-panel.test.ts / FileTreeRow.test.ts /
 *   tasks-tool-name-resolution.test.ts / fork-entry-behavior.test.ts / turn-file-badge.test.ts /
 *   panel-container-drawer-mode.test.ts（vi.mock 或 re-export 依赖，改 mock core 或随消费方迁移）。
 * 清单维护：消费方迁移后同步从本清单移除（删除文件时清单应为空）。
 *
 * 单实例（Q2=A 单例）：core controlState 是模块级单例（控制态物理只有一份），SideDrawer
 * 单实例跟随 active panel。双 panel standby 无独立 drawer 状态——切到 standby（变 active）
 * 时其 session 分区状态自然显示（drawer 物理只有一份）。
 *
 * 依赖方向：panel store（读 focusedSessionId 作分区键）。不触碰 session store / api。
 * widget 订阅在 SideDrawer.vue 内按 sessionId 独立接入；git 数据由 PanelContainer provide。
 */
import { computed } from 'vue'
import { usePanelStore } from '@/stores/panel'
import {
  bindDrawerSessionId,
  useDrawerControl,
  openDrawerTab,
  closeDrawer,
  toggleDrawer,
  setDrawerTab,
  toggleDrawerDock,
  selectedCommandName,
  detailFilePath,
  browserUrl,
  consumeBrowserUrl,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import type { SideDrawerTab, OpenDrawerOptions } from '@taiji/core/domain/drawer'

// 分区键绑定：focusedSessionId 来自 panel store（active panel 的 sessionId），与 SideDrawer
// 物理挂载归属一致。lazy 调 usePanelStore()（computed 首次求值时 pinia 已 active，
// 避免模块加载期 pinia 未初始化）。core controlState 按此分区（null = 未绑定，no-op 语义）。
bindDrawerSessionId(computed<string | null>(() => usePanelStore().focusedSessionId))

// re-export 类型：SideDrawer.test / useDrawerWidgetBuffers 等类型消费方零改动
export type { SideDrawerTab, OpenDrawerOptions }

/**
 * SideDrawer 状态访问器（兼容层，返回形状与旧版逐字段一致）。
 * 控制态 computed 读 core 当前分区字段（切 session 切分区，响应式自动跟随）；
 * 方法逐字段委托 core 公开 API（openDrawerTab 等）。
 */
export function useSideDrawer() {
  const { isOpen, activeTab, docked } = useDrawerControl()
  return {
    // 控制态：computed 读当前分区字段（切 session 切分区，响应式自动跟随）
    isOpen,
    activeTab,
    docked,
    // 瞬时参数（core coordination 模块级单例，消费后清空）
    selectedCommandName,
    detailFilePath,
    browserUrl,
    /** 消费 browserUrl：读取并清空（BrowserPane 挂载时调，取到非空值触发导航） */
    consumeBrowserUrl,
    open: openDrawerTab,
    close: closeDrawer,
    toggle: toggleDrawer,
    setTab: setDrawerTab,
    toggleDock: toggleDrawerDock,
  }
}

/**
 * 重置 SideDrawer 状态（测试隔离用）。
 * 委托 core _resetDrawerForTest（清 control 分区 + 瞬时参数）。
 * 注：per-session 分区清理通过清 controlState 内部 Map 实现，生产代码不应调用。
 */
export function resetSideDrawer(): void {
  _resetDrawerForTest()
}
