/**
 * Sidebar.vue onDeleteFolder 测试（W2TC6）。
 *
 * 验证 folder 删除后的提示分支（toast 决策）：
 * - 全成功（failed=[]）→ 不 toast
 * - 部分失败（failed.length>0）→ toastError(deleteFolderPartialFailed, count)
 * - 网络异常（deleteFolder reject）→ toastError(deleteFolderFailed, msg)
 *
 * 降级说明：Sidebar.vue 整体 mount 依赖 10+ store/composable（useSidebar / useChat /
 *   useSessionDerivations / 7 个 store / useSearchModal / SearchModal / __APP_VERSION__），
 *   完整真实 mount 成本过高且偏离本测试目标（验证 onDeleteFolder 的 toast 分支）。
 *   这里参照 sidebar-crud-error-handling.test.ts 范式：mock useSidebar（注入 deleteFolder mock）
 *   + useToast（捕获 error）+ 各 store，shallowMount Sidebar 后经 SessionList 子组件
 *   emit deleteFolder 触发 onDeleteFolder，覆盖真实模板绑定 + 事件编排路径。
 *
 * mock 段收敛 __tests__/helpers/sidebar-mount.ts（与 sidebar-assign-project-wiring /
 * sidebar-import-entry 共享单源；vi.mock 声明留测试文件，工厂转发 helper 导出）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-ondeletefolder.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'

import {
  chatComposableModule,
  commandStoreModule,
  coreTransportApiModule,
  fileTreeStoreModule,
  navigationStoreModule,
  panelStoreModule,
  platformShortcutModule,
  sessionDerivationsModule,
  sessionStoreModule,
  sidebarActionMocks,
  sidebarStoreModule,
  subagentStoreModule,
  toastErrorMock,
  toastModule,
  useSidebarModule,
  workflowStoreModule,
} from '../helpers/sidebar-mount'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
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
vi.mock('@/composables/usePlatformShortcut', () => platformShortcutModule())
vi.mock('@taiji/core/transport/api', () => coreTransportApiModule())

import Sidebar from '@/components/sidebar/Sidebar.vue'
import SessionList from '@/components/sidebar/SessionList.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 三用例共用的触发装配：shallowMount Sidebar 后经 SessionList emit deleteFolder。 */
async function mountAndEmitDeleteFolder() {
  const wrapper = shallowMount(Sidebar)
  // 经子组件 SessionList emit deleteFolder 触发 onDeleteFolder（覆盖模板 @delete-folder 绑定）
  wrapper.findComponent(SessionList).vm.$emit('deleteFolder', '/p')
  await vi.dynamicImportSettled()
  return wrapper
}

describe('Sidebar onDeleteFolder（W2TC6）', () => {
  it('全成功（failed=[]）→ deleteFolder 调用但不 toast', async () => {
    sidebarActionMocks.deleteFolder.mockResolvedValueOnce({ cwd: '/p', deleted: ['s1', 's2'], failed: [] })
    const wrapper = await mountAndEmitDeleteFolder()

    expect(sidebarActionMocks.deleteFolder).toHaveBeenCalledWith('/p')
    expect(toastErrorMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('部分失败（failed.length=1）→ toastError(deleteFolderPartialFailed, count:1)', async () => {
    sidebarActionMocks.deleteFolder.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    })
    const wrapper = await mountAndEmitDeleteFolder()

    expect(sidebarActionMocks.deleteFolder).toHaveBeenCalledWith('/p')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // 文案来自 zh-CN locale（vitest-i18n-setup 注入真实 t，支持 vue-i18n 复数签名 t(key, count, params)）：
    // deleteFolderPartialFailed = '{count} 个会话删除失败：{error}'，count=1 + error=EPERM → '1 个会话删除失败：EPERM'
    expect(toastErrorMock).toHaveBeenCalledWith('1 个会话删除失败：EPERM')
    wrapper.unmount()
  })

  it('网络异常（deleteFolder reject）→ toastError(deleteFolderFailed, msg)', async () => {
    sidebarActionMocks.deleteFolder.mockRejectedValueOnce(new Error('network'))
    const wrapper = await mountAndEmitDeleteFolder()

    expect(sidebarActionMocks.deleteFolder).toHaveBeenCalledWith('/p')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // deleteFolderFailed = '删除文件夹会话失败：{msg}'
    expect(toastErrorMock).toHaveBeenCalledWith('删除文件夹会话失败：network')
    wrapper.unmount()
  })
})
