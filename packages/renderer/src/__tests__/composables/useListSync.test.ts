/**
 * useListSync 单测 —— sidebar 列表（subagents / workflows）首拉 RPC 的响应式同步。
 *
 * 合并自原 useSubagentListSync.test.ts（u15 listSync 孪生合并）：两槽位参数化跑同一组
 * 场景，断言行为逐点对齐。每个场景覆盖 subagents 与 workflows 两个槽位。
 *
 * 职责：
 * - 挂载即首拉一次（且仅一次）——首个 watch 的 immediate 承载，tab watch 无 immediate
 *   不补刀（V6-a；workflow 版曾有的冗余 tab-immediate 已删，此处「恰一次」断言即守卫）。
 *   V6-a 的 activeTab 非目标 tab，触发条件不重叠；裁决 5 核心场景「挂载时 tab 已激活」
 *   由 V6-a2 直接钉死（该场景下 tab watch 若带 immediate 会叠加第二次 load）
 * - 切 tab 首拉一次（V6-b）
 * - focusedSessionId 变化 → 首拉兜底（不 clear 旧分区，切走不清 ADR-0049）
 * - landing 态（sid=null）不加载
 *
 * runtime 主动推送（session.subagents / session.workflowUpdate 含终态）由
 * useConnection.routeInbound 兜底统一消费，本 composable 不测订阅行为，只测首拉 RPC。
 *
 * 运行：npx vitest run src/__tests__/composables/useListSync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'

// mock sessionApi（loadSubagents / loadWorkflows 内部调用）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getSubagents: vi.fn().mockResolvedValue([]),
  getSubagentHistory: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
}))

// 两个 store 经 @/api 门面导入 session，需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

import { useListSync } from '@/composables/features/chat/useListSync'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import * as sessionApi from '@taiji/core/transport/api/domains/session'

/** 两个消费槽位（与 Sidebar.vue 调用点同形态：tab 名 + 真实 store 的 load 方法引用）。 */
const slots = [
  { name: 'subagents', tab: 'subagents' as const, useStore: useSubagentStore, loadOf: (s: ReturnType<typeof useSubagentStore>) => s.loadSubagents, apiFn: () => sessionApi.getSubagents },
  { name: 'workflows', tab: 'workflows' as const, useStore: useWorkflowStore, loadOf: (s: ReturnType<typeof useWorkflowStore>) => s.loadWorkflows, apiFn: () => sessionApi.getWorkflows },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 设置 panel store 的 active panel 绑定指定 session */
function setPanelSession(panel: ReturnType<typeof usePanelStore>, sessionId: string | null): void {
  panel.loadSession(ROOT_PANEL_ID, sessionId)
}

describe.each(slots)('useListSync — $name 槽位', ({ tab, useStore, loadOf, apiFn }) => {
  it('V6-a：挂载即首拉一次（且仅一次）——immediate 承载，tab watch 无 immediate 不补刀', async () => {
    const panel = usePanelStore()
    setPanelSession(panel, 'session-1')
    // 本用例 activeTab 停在默认 'sessions'（非目标 tab）：tab watch 即便带 immediate 也不命中，
    // 因此只钉死「触发条件单一时恰一次」。触发条件同时成立的场景见下方 V6-a2。
    const scope = effectScope()
    scope.run(() => {
      useListSync({ tab, load: loadOf(useStore()) })
    })

    await vi.waitFor(() => {
      expect(apiFn()).toHaveBeenCalledTimes(1)
      expect(apiFn()).toHaveBeenCalledWith('session-1')
    })
    // microtask flush 后仍恰一次（无第二个触发源补刀）
    await new Promise((r) => setTimeout(r, 0))
    expect(apiFn()).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('V6-a2：挂载时 activeTab 已是目标 tab 仍首拉恰一次（裁决 5 核心场景）', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    setPanelSession(panel, 'session-1')
    // 挂载前即处于目标 tab：首个 watch 的 immediate 与 tab watch 的触发条件同时成立。
    // tab watch 若无 immediate（现状）到此只发生一次 load；加回 immediate 则挂载瞬间叠加第二次
    // ——本用例的回归敏感性即来自此处。
    sidebar.activeTab = tab

    const scope = effectScope()
    scope.run(() => {
      useListSync({ tab, load: loadOf(useStore()) })
    })

    // immediate 同步触发：现状恰一次，tab watch 带 immediate 时为 2
    expect(apiFn()).toHaveBeenCalledTimes(1)
    expect(apiFn()).toHaveBeenCalledWith('session-1')
    // microtask flush 后仍恰一次（确认无异步补刀）
    await new Promise((r) => setTimeout(r, 0))
    expect(apiFn()).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('V6-b：切到目标 tab 首拉一次', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    setPanelSession(panel, 'session-1')
    const scope = effectScope()
    scope.run(() => {
      useListSync({ tab, load: loadOf(useStore()) })
    })
    await vi.waitFor(() => {
      expect(apiFn()).toHaveBeenCalled()
    })
    vi.clearAllMocks() // 清掉挂载首拉，隔离 tab 触发断言

    sidebar.activeTab = tab
    await vi.waitFor(() => {
      expect(apiFn()).toHaveBeenCalledTimes(1)
      expect(apiFn()).toHaveBeenCalledWith('session-1')
    })
    scope.stop()
  })

  it('focusedSessionId 变化时首拉新 session（兜底）', async () => {
    const panel = usePanelStore()
    setPanelSession(panel, 'session-init')
    const scope = effectScope()
    scope.run(() => {
      useListSync({ tab, load: loadOf(useStore()) })
    })
    await vi.waitFor(() => {
      expect(apiFn()).toHaveBeenCalled()
    })
    vi.clearAllMocks()

    setPanelSession(panel, 'session-2')
    await vi.waitFor(() => {
      expect(apiFn()).toHaveBeenCalledWith('session-2')
    })
    scope.stop()
  })

  it('focusedSessionId=null（landing 态）不加载', async () => {
    const panel = usePanelStore()
    // panel 初始 sessionId=null（不预设 session）
    const scope = effectScope()
    scope.run(() => {
      useListSync({ tab, load: loadOf(useStore()) })
    })

    // 0ms 宏任务让步（姊妹用例同款：watch immediate 触发在 microtask flush 内落定）——
    // landing 态无加载触发，让步后即可断言未调用
    await new Promise((r) => setTimeout(r, 0))
    expect(apiFn()).not.toHaveBeenCalled()
    scope.stop()
  })
})

describe('useListSync — 切会话不清旧分区（ADR-0049）', () => {
  it('focusedSessionId 变化时旧 session 分区保留（切走不清）', async () => {
    const panel = usePanelStore()
    const subagentStore = useSubagentStore()
    setPanelSession(panel, 'session-init')
    const scope = effectScope()
    scope.run(() => {
      useListSync({ tab: 'subagents', load: subagentStore.loadSubagents })
    })
    // 等 immediate 的 loadSubagents('session-init') microtask flush 完，避免它后续 resolve 覆盖预置数据
    await new Promise((r) => setTimeout(r, 0))

    // 预置旧数据到 init 分区
    subagentStore.applyRecords('session-init', [{ subagentId: 'old', agent: 'a', slug: 's', task: 't', status: 'done', sessionFile: null }])
    expect(subagentStore.getRecordsBySession('session-init')).toHaveLength(1)

    // 切会话 → 旧分区保留（不 clear）
    setPanelSession(panel, 'session-new')
    await nextTick()

    expect(subagentStore.getRecordsBySession('session-init')).toHaveLength(1)
    scope.stop()
  })
})
