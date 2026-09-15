/**
 * W6 D16 · 快捷键配置测试（U12）—— 降级只读版。
 *
 * 实现程度：降级只读展示。原因（见 SystemPage.vue template TODO）：
 *  - 监听器在 Sidebar.vue keymap 硬编码按 key 匹配（keymap 数组用固定 'k'/'n'/'b'），
 *    非「读 useAppCommands 内存值派发」。完整实现需 keymap 改读 commandStore +
 *    shortcut override 持久化 + 实时生效，风险高（可能破坏 ⌘K/⌘N/⌘B 核心交互）。
 *  - 故降级为只读展示当前快捷键 + TODO 注释。
 *
 * U12 验证目标（降级版）：
 *  - useAppCommands 注册的应用命令含 new-session(⌘N) / toggle-sidebar(⌘B)
 *  - SystemPage 据此展示当前快捷键（commandStore.appCommands 含 shortcut 字段）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// [w5] useAppCommands 改经壳单例 useCommandStore（core createCommandStore + getPlatform().storage）。
// mock 壳单例捕获 registerApp 参数，避免依赖真实 getPlatform（AppShell 时序）。
const appCmdsMock = vi.hoisted(() => ({
  registerApp: vi.fn<(cmds: Array<{ id: string; shortcut?: string }>) => void>(),
}))

vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    registerApp: appCmdsMock.registerApp,
  }),
}))

describe('U12: 快捷键配置（降级只读展示）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // useAppCommands 依赖 commandStore + sidebarStore，均在 pinia 下
    vi.resetModules()
  })

  it('registerAppCommands 注册 new-session(⌘N) / toggle-sidebar(⌘B)，含 shortcut 字段', async () => {
    const { registerAppCommands } = await import('@/composables/features/command/useAppCommands')
    const { useSidebarStore } = await import('@/stores/sidebar')

    const sidebarStore = useSidebarStore()

    registerAppCommands({
      newSession: vi.fn(),
      goOverview: vi.fn(),
    })

    const cmds = appCmdsMock.registerApp.mock.calls[0]![0] as Array<{ id: string; shortcut?: string }>
    const newSession = cmds.find((c) => c.id === 'new-session')
    const toggleSidebar = cmds.find((c) => c.id === 'toggle-sidebar')
    const goOverview = cmds.find((c) => c.id === 'go-overview')

    expect(newSession).toBeDefined()
    // shortcut 格式随平台变化（Mac=⌘N，其他=Ctrl+N），断言包含主键即可
    expect(newSession?.shortcut).toContain('N')
    expect(toggleSidebar).toBeDefined()
    expect(toggleSidebar?.shortcut).toContain('B')
    expect(goOverview).toBeDefined()
    // go-overview 无快捷键（只注册命令）
    expect(goOverview?.shortcut).toBeUndefined()

    // sidebarStore 被使用（toggleCollapsed 绑定），不报错即说明注册成功
    expect(sidebarStore).toBeDefined()
  })

  // （原用例 2「appCommands 可被 SystemPage 筛选展示」已删：在测试内复刻 SystemPage 的
  //  filter 白名单再 filter——断言的是测试自己写的 filter，实现改坏时不红，恒真风险；
  //  原用例 3 i18n 文案断言与 settings-i18n.test.ts 重复，go-overview 增量已并入该文件。）
})
