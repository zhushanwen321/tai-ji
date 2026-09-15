/**
 * Panel store —— 单 panel 状态（v2：移除 split 后退化）。
 *
 * 依赖方向：无（stores 间禁止互相 import；session 关联由 features 层编排）。
 *
 * 历史背景：v1 用 PanelTree 递归树支持单/双 panel split 主从状态机（split/close/isDual）。
 * split 功能移除（2026-07-24）后退化为恒单 panel：layout 是单个 PanelLeaf，无树结构。
 * activePanelId 保留（恒等于 ROOT_PANEL_ID），作为 subagent/workflow store per-panel viewing Map 的 key。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { PanelLeaf } from '@taiji/shared'

/** 唯一 panel 的固定 id（subagent/workflow store per-panel Map 的 key） */
export const ROOT_PANEL_ID = 'panel-root'
const initialLeaf: PanelLeaf = {
  id: ROOT_PANEL_ID,
  sessionId: null,
}

export const usePanelStore = defineStore('panel', () => {
  const layout = ref<PanelLeaf>(initialLeaf)
  const activePanelId = ref<string>(ROOT_PANEL_ID)

  /** 当前唯一 panel leaf（语义别名，供下游读 sessionId 等） */
  const currentLeaf = computed<PanelLeaf>(() => layout.value)

  /** 所有 panel 叶子节点（v2 单 panel 恒 1 个元素）。真实消费方：useMessageEffects 的
   *  message.complete 焦点判定 `panels.find(p => p.id === activePanelId)`（fallback 测试同构
   *  消费）。v1 语义是收集 PanelTree 下所有 PanelLeaf，v2 单 panel 退化为等价 `[layout.value]`。 */
  const panels = computed<PanelLeaf[]>(() => [layout.value])

  /** 找到承载指定 session 的 panel（单 panel 下直接比对 sessionId） */
  function findPanelBySession(sessionId: string): PanelLeaf | null {
    return layout.value.sessionId === sessionId ? layout.value : null
  }

  /** 把 session 载入 panel（传 null 清空绑定，new-task flow 进 landing 时用） */
  function loadSession(panelId: string, sessionId: string | null): void {
    if (panelId !== layout.value.id) return
    layout.value = { ...layout.value, sessionId }
  }

  /** active panel 绑定的 sessionId（drawer / 文件树等 per-session 状态的分区键）。
   *  与 useSidebar.focusedSessionId 同源（经 core use-session 的 panel 端口从本 store 派生），
   *  提升到 store 层供 useSideDrawer 等 composable 直接读，避免经 useSidebar 实例引入循环依赖。*/
  const focusedSessionId = computed<string | null>(() => layout.value.sessionId)

  return {
    layout,
    activePanelId,
    focusedSessionId,
    currentLeaf,
    panels,
    findPanelBySession,
    loadSession,
  }
})
