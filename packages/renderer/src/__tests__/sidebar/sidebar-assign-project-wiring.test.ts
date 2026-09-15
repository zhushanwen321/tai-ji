/**
 * Sidebar.vue 归入项目接线测试（review MF-1：Sidebar L85 @set-project 模板绑定 + toast 分支）。
 *
 * 链下游：SessionList emit setProject → Sidebar.vue `@set-project="onAssignProject"`（L85）→
 * useSidebarSessionActions.onAssignProject（真实，注入的 assignSessionToProject mock）→
 * 失败 toastError(sidebar.assignProjectFailed)。useSidebar 的 RPC + 乐观更新内部在
 * sidebar-assign-project.test.ts 直测（本文件 mock useSidebar）。
 *
 * 降级说明：Sidebar.vue 整体 mount 依赖 10+ store/composable（同 sidebar-ondeletefolder.test.ts
 * 范式），完整真实 mount 成本过高且偏离本测试目标（验证 @set-project 接线 + toast 分支）。
 * 参照该范式：mock useSidebar（注入可控 assignSessionToProject）+ useToast（捕获 error）
 * + 各 store，shallowMount Sidebar 后经 SessionList 子组件 emit setProject 触发 onAssignProject，
 * 覆盖真实模板绑定 + 事件编排路径。
 *
 * mock 段收敛 __tests__/helpers/sidebar-mount.ts（与 sidebar-import-entry.test.ts 共享单源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-assign-project-wiring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'

import {
  chatComposableModule,
  commandStoreModule,
  coreTransportApiModule,
  fileTreeStoreModule,
  listSyncModule,
  navigationStoreModule,
  panelStoreModule,
  platformShortcutModule,
  sessionDerivationsModule,
  sessionStoreModule,
  sidebarActionMocks,
  sidebarStoreModule,
  sidebarSubagentActionsModule,
  subagentStoreModule,
  toastErrorMock,
  toastModule,
  useSidebarModule,
  workflowStoreModule,
} from '../helpers/sidebar-mount'

vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

vi.mock('@/composables/useToast', () => toastModule())
vi.mock('@/composables/features/sidebar/useSidebar', () => useSidebarModule())
vi.mock('@/stores/sidebar', () => sidebarStoreModule())
vi.mock('@/stores/session', () => sessionStoreModule())
vi.mock('@/stores/fileTree', () => fileTreeStoreModule())
vi.mock('@/stores/panel', () => panelStoreModule())
vi.mock('@/stores/subagent', () => subagentStoreModule())
vi.mock('@/stores/workflow', () => workflowStoreModule())
vi.mock('@/stores/navigation', () => navigationStoreModule())
vi.mock('@/composables/features/command/useCommandStore', () => commandStoreModule())
vi.mock('@/composables/features/chat/useChat', () => chatComposableModule())
vi.mock('@/composables/features/chat/useSessionDerivations', () => sessionDerivationsModule())
vi.mock('@/composables/features/chat/useListSync', () => listSyncModule())
vi.mock('@/composables/features/sidebar/useSidebarSubagentActions', () => sidebarSubagentActionsModule())
vi.mock('@/composables/usePlatformShortcut', () => platformShortcutModule())
vi.mock('@taiji/core/transport/api', () => coreTransportApiModule())

import Sidebar from '@/components/sidebar/Sidebar.vue'
import SessionList from '@/components/sidebar/SessionList.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Sidebar 归入项目接线（review MF-1）', () => {
  it('SessionList emit setProject → onAssignProject → assignSessionToProject(sessionId, projectId)，成功无 toast', async () => {
    sidebarActionMocks.assignSessionToProject.mockResolvedValue(undefined)
    const wrapper = shallowMount(Sidebar)

    // 经子组件 SessionList emit setProject 触发 onAssignProject（覆盖模板 @set-project 绑定 L85）
    wrapper.findComponent(SessionList).vm.$emit('setProject', { sessionId: 's1', projectId: 'p1' })
    await vi.dynamicImportSettled()

    expect(sidebarActionMocks.assignSessionToProject).toHaveBeenCalledWith('s1', 'p1')
    expect(toastErrorMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('assignSessionToProject reject → toastError(assignProjectFailed)，失败不静默', async () => {
    sidebarActionMocks.assignSessionToProject.mockRejectedValueOnce(new Error('rpc-fail'))
    const wrapper = shallowMount(Sidebar)

    wrapper.findComponent(SessionList).vm.$emit('setProject', { sessionId: 's1', projectId: 'p1' })
    await vi.dynamicImportSettled()

    expect(sidebarActionMocks.assignSessionToProject).toHaveBeenCalledWith('s1', 'p1')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // 文案来自 zh-CN locale（vitest-i18n-setup 注入真实 t）：assignProjectFailed = '归入项目失败'
    // （locale 无 {msg} 占位符，失败详情不进 toast——与 renameFailed 带 {msg} 的写法不同，此处按真实文案断言）
    expect(toastErrorMock).toHaveBeenCalledWith('归入项目失败')
    wrapper.unmount()
  })
})
