import { chatComposableModule, commandStoreModule, coreTransportApiModule, fileTreeStoreModule, navigationStoreModule, panelStoreModule, platformShortcutModule, sessionDerivationsModule, sessionStoreModule, sidebarActionMocks, sidebarStoreModule, subagentStoreModule, toastErrorMock, toastModule, useSidebarModule, workflowStoreModule } from '../helpers/sidebar-mount';
import ImportSessionDialog from '@/components/sidebar/ImportSessionDialog.vue';
import SessionList from '@/components/sidebar/SessionList.vue';
import Sidebar from '@/components/sidebar/Sidebar.vue';
import { isImportedFresh, __resetImportedFreshForTest, IMPORT_FRESH_VISIBLE_MS, IMPORT_FRESH_FADE_MS, type ImportSessionImportedPayload } from '@/composables/features/sidebar/useImportSession';
import { DEFAULT_FONT_SCALES, providePlatform, provideSettingsStore, createSettingsStore, getSettingsStore, type KVStorage } from '@taiji/core';
import { mount, shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← sidebar-assign-project-wiring.test.ts
// ======================================================================

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
    // 文案来自 zh-CN locale（vitest-i18n-setup 注入真实 t）：assignProjectFailed = '归入项目失败：{msg}'
    // （失败详情 {msg} 进 toast，与 renameFailed 同款写法——按真实文案断言）
    expect(toastErrorMock).toHaveBeenCalledWith('归入项目失败：rpc-fail')
    wrapper.unmount()
  })
})

// ======================================================================
// ← sidebar-import-entry.test.ts
// ======================================================================

// 注：原版此处另有 vi.mock('@/api/events', ...)——'@/api/events' 模块不存在（Sidebar 实际
// import '@taiji/core/transport/api'，见 Sidebar.vue:248），该 mock 从未命中，已删除。

/** shallowMount Sidebar，Button 用显式 slot stub（真实 <button> 元素 + slot 文本可见） */
function mountSidebar() {
  return shallowMount(Sidebar, {
    global: {
      stubs: {
        Button: { template: '<button><slot /></button>' },
      },
    },
  })
}

/** 构造 keydown 事件派发到 window（useGlobalShortcuts 的 useEventListener 挂点） */
function fireKey(options: { key: string; metaKey?: boolean }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: options.key,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  __resetImportedFreshForTest()
})

describe('Sidebar 导入会话入口接线（import-session u6）', () => {
  it('TC1: 「导入会话」按钮渲染在「新建任务」（nav 外独立主操作）之后、「搜索」之前，带定位 testid', () => {
    const wrapper = mountSidebar()
    try {
      // M1 视觉复刻（demo .sidebar 区块序）：新建任务是 nav 外独立 elevated 卡；
      // nav 内只剩导入会话 / 搜索两个 ghost 行，顺序保持导入在前
      const navTexts = wrapper.find('nav').findAll('button').map((b) => b.text())
      expect(navTexts.length).toBe(2)
      expect(navTexts[0]).toContain('导入会话')
      expect(navTexts[1]).toContain('搜索')
      // 新建任务独立块在导入会话之前（demo .newtask 紧随项目切换条）
      const rootText = wrapper.text()
      expect(rootText).toContain('新建任务')
      expect(rootText.indexOf('新建任务')).toBeLessThan(rootText.indexOf('导入会话'))
      // 入口按钮 testid（E2E 走查 V1 定位锚点）
      expect(wrapper.find('[data-testid="sidebar-import-session-btn"]').exists()).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC2: ⌘I 经 useGlobalShortcuts 打开 ImportSessionDialog；裸 i（无 mod）不触发', async () => {
    const wrapper = mountSidebar()
    try {
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)

      fireKey({ key: 'i', metaKey: true })
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(true)

      // 回归：无 mod 修饰不触发（keymap 默认匹配要求 meta/ctrl）
      wrapper.getComponent(ImportSessionDialog).vm.$emit('update:open', false)
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)
      fireKey({ key: 'i' })
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC3: 点击入口按钮打开 ImportSessionDialog', async () => {
    const wrapper = mountSidebar()
    try {
      const importBtn = wrapper.find('[data-testid="sidebar-import-session-btn"]')
      expect(importBtn.exists()).toBe(true)

      await importBtn.trigger('click')
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC4: imported 事件 → Sidebar 驱动 fresh「导入」徽标状态机（u7：实显 → 淡出 → 移除）', async () => {
    vi.useFakeTimers()
    const wrapper = mountSidebar()
    try {
      const payload: ImportSessionImportedPayload = {
        sessionId: 'imported-fresh-sid',
        sessionName: '会话名',
        projectName: 'Stock',
        targetPath: '/target/copied.jsonl',
      }
      wrapper.getComponent(ImportSessionDialog).vm.$emit('imported', payload)
      await nextTick()

      // 构建者：Sidebar 接线 → markImportedFresh 生效（visible 实显）
      expect(isImportedFresh('imported-fresh-sid')).toBe('visible')
      // 其他 session 不受影响
      expect(isImportedFresh('other-sid')).toBeNull()

      // 观察者：3.2s 后进入淡出阶段，再 200ms 移除（demo doImport 时序）
      vi.advanceTimersByTime(IMPORT_FRESH_VISIBLE_MS)
      expect(isImportedFresh('imported-fresh-sid')).toBe('fading')
      vi.advanceTimersByTime(IMPORT_FRESH_FADE_MS)
      expect(isImportedFresh('imported-fresh-sid')).toBeNull()
    } finally {
      wrapper.unmount()
      __resetImportedFreshForTest()
      vi.useRealTimers()
    }
  })
})

// ======================================================================
// ← sidebar-ondeletefolder.test.ts
// ======================================================================

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')


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

  // delete-generating-error-localization：failed[].code 命中封闭枚举 → error 占位插 i18n
  // 词条（runtime 原文是编译期中文，en 用户不可读——词条化是本修复的核心行为）。
  it('失败条目 code=delete_generating → error 占位插本地化词条，不透传 runtime 原文', async () => {
    sidebarActionMocks.deleteFolder.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: '会话正在生成中，无法删除；请先停止生成或等待完成 (sessionId=s2)', code: 'delete_generating' }],
    })
    const wrapper = await mountAndEmitDeleteFolder()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // deleteFolderPartialFailed × deleteFolderGenerating（zh-CN）='1 个会话删除失败：会话正在生成中，已跳过删除'
    expect(toastErrorMock).toHaveBeenCalledWith('1 个会话删除失败：会话正在生成中，已跳过删除')
    wrapper.unmount()
  })

  // 映射 miss（未知码）回落原文——防把 code 直接当 key 传给 t() 显示出 key 字面量。
  it('失败条目带未知 code → 映射 miss 回落 runtime 原文', async () => {
    sidebarActionMocks.deleteFolder.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM: operation not permitted', code: 'future_unknown_code' }],
    })
    const wrapper = await mountAndEmitDeleteFolder()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('1 个会话删除失败：EPERM: operation not permitted')
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

// ======================================================================
// ← sidebar-quick-chat-font.test.ts
// ======================================================================

vi.stubGlobal('__APP_VERSION__', '0.0.0-test')


/** 内存 KVStorage（setSystem 持久化落盘断言用，不触真实 localStorage） */
function makeMemoryStorage(): { storage: KVStorage; dump: Map<string, string> } {
  const dump = new Map<string, string>()
  return {
    dump,
    storage: {
      get: async (key) => dump.get(key) ?? null,
      set: async (key, value) => { dump.set(key, value) },
      remove: async (key) => { dump.delete(key) },
    },
  }
}

const platformStorage = makeMemoryStorage()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  localStorage.removeItem('taiji:projects')
  localStorage.removeItem('taiji:sidebar-session-mode')
  // setSystem 持久化走 PlatformPort.storage（未注入 fail-fast）——注入内存实现
  providePlatform({
    kind: 'mock',
    storage: platformStorage.storage,
    webSocket: { create: () => { throw new Error('ws not available in test') } },
  })
  // 每用例全新 settings store（getSettingsStore 惰性单例会被 provideSettingsStore 覆盖）
  provideSettingsStore(createSettingsStore())
  platformStorage.dump.clear()
})

/**
 * 完整 mount Sidebar：Popover/PopoverTrigger/PopoverContent/Button 保持真实（受测面板
 * 是 portal 内容），其余重组件 stub（范式同 sidebar-import-entry：Sidebar 依赖 10+
 * store/composable，mock 收敛 helpers/sidebar-mount 单源）。attachTo body 供 reka
 * portal 与 dismissable layer 正常工作；用例后 unmount + 清 body（reka 异步 DOM 更新
 * 在 attach 节点销毁后 flush 会触发 insertBefore(null) 未处理异常）。
 */
function mountSidebar_m2() {
  return mount(Sidebar, {
    attachTo: document.body,
    global: {
      stubs: {
        Brand: true,
        UpdateButton: true,
        SegmentedTab: true,
        SessionList: true,
        FileView: true,
        RenameSessionDialog: true,
        ImportSessionDialog: true,
        SearchModal: true,
        PluginViewContainer: true,
      },
    },
  })
}

/** hover 打开外观快捷面板并等 portal 内容渲染（reka PopoverPortal → body） */
async function openQuickAppearancePanel(wrapper: ReturnType<typeof mountSidebar_m2>) {
  const trigger = wrapper.find('[data-testid="sidebar-quick-appearance"]')
  expect(trigger.exists()).toBe(true)
  await trigger.trigger('mouseenter')
  await vi.waitFor(() => {
    expect(document.body.querySelector('[data-testid="sidebar-quick-appearance-panel"]')).toBeTruthy()
  }, { interval: 1 })
}

/** 按档位定位面板内字号按钮（portal 内容，testid = sidebar-quick-chat-<tier>） */
function chatTierButton(tier: string): HTMLElement {
  const btn = document.body.querySelector(`[data-testid="sidebar-quick-chat-${tier}"]`)
  expect(btn, `sidebar-quick-chat-${tier} 应在面板中渲染`).toBeTruthy()
  return btn as HTMLElement
}

afterEach(async () => {
  // attachTo 挂载的 wrapper 在各用例 finally unmount；此处兜底清残留 portal 节点
  await nextTick()
  document.body.innerHTML = ''
})

describe('Sidebar 外观快捷面板：对话流字号快捷段', () => {
  it('hover 打开面板 → 段标题与 4 档按钮渲染；选中态 aria-pressed 命中 fontScales.chat（默认 small）', async () => {
    const wrapper = mountSidebar_m2()
    try {
      await openQuickAppearancePanel(wrapper)

      const panel = document.body.querySelector('[data-testid="sidebar-quick-appearance-panel"]')!
      // 段标题（zh locale：settings.appearance.quickChatFont）
      expect(panel.textContent).toContain('对话流字号')
      // 4 档齐全 + 档位文案（zh locale tierSmall..tierXLarge）
      const tiers = ['small', 'medium', 'large', 'xlarge'] as const
      for (const tier of tiers) {
        expect(chatTierButton(tier).textContent).toBeTruthy()
      }
      expect(chatTierButton('small').textContent).toContain('小')
      expect(chatTierButton('xlarge').textContent).toContain('特大')
      // 选中态 = DEFAULT_FONT_SCALES.chat（store 初始值），仅该档 aria-pressed
      expect(chatTierButton('small').getAttribute('aria-pressed')).toBe('true')
      expect(chatTierButton('medium').getAttribute('aria-pressed')).toBe('false')
      expect(chatTierButton('large').getAttribute('aria-pressed')).toBe('false')
      expect(chatTierButton('xlarge').getAttribute('aria-pressed')).toBe('false')
    } finally {
      wrapper.unmount()
    }
  })

  it('fontScales 缺 chat key（存量浅合并缺 key）→ 选中态回落 DEFAULT_FONT_SCALES.chat，非默认档 sidebar 不受影响', async () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = {
      ...settingsStore.system.value,
      fontScales: { sidebar: 'large' }, // chat/drawer key 缺失
    }
    const wrapper = mountSidebar_m2()
    try {
      await openQuickAppearancePanel(wrapper)

      // chat 档选中态回落 SSOT 默认（small），不是写死 'medium' 也不是空
      expect(chatTierButton('small').getAttribute('aria-pressed')).toBe('true')
      expect(chatTierButton('large').getAttribute('aria-pressed')).toBe('false')
    } finally {
      wrapper.unmount()
    }
  })

  it('点档位 → setSystem 浅合并写入（chat 档更新、sidebar/drawer 不丢）+ 持久化落盘 + 选中态迁移', async () => {
    const settingsStore = getSettingsStore()
    const wrapper = mountSidebar_m2()
    try {
      await openQuickAppearancePanel(wrapper)

      chatTierButton('large').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.waitFor(() => {
        expect(settingsStore.system.value.fontScales?.chat).toBe('large')
      }, { interval: 1 })

      // 选中态迁移（用户可见：aria-pressed 移到 large）
      expect(chatTierButton('large').getAttribute('aria-pressed')).toBe('true')
      expect(chatTierButton('small').getAttribute('aria-pressed')).toBe('false')

      // 浅合并不丢其他分区：原值 sidebar=medium / drawer=medium 保持
      expect(settingsStore.system.value.fontScales?.sidebar).toBe('medium')
      expect(settingsStore.system.value.fontScales?.drawer).toBe('medium')

      // 持久化落盘（PlatformPort.storage 写入 taiji:system-settings，含更新后 fontScales）
      await vi.waitFor(() => {
        expect(platformStorage.dump.get('taiji:system-settings')).toBeTruthy()
      }, { interval: 1 })
      const raw = platformStorage.dump.get('taiji:system-settings')!
      const persisted = JSON.parse(raw!) as { fontScales?: Record<string, string> }
      expect(persisted.fontScales?.chat).toBe('large')
      expect(persisted.fontScales?.sidebar).toBe('medium')
    } finally {
      wrapper.unmount()
    }
  })

  it('setSystem reject → toastError 上报错误详情，选中态不迁移（失败不静默、UI 不提前分叉）', async () => {
    const settingsStore = getSettingsStore()
    const spy = vi.spyOn(settingsStore, 'setSystem').mockRejectedValueOnce(new Error('rpc down'))
    const wrapper = mountSidebar_m2()
    try {
      await openQuickAppearancePanel(wrapper)

      chatTierButton('xlarge').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('rpc down')
      }, { interval: 1 })

      // 失败不迁移：store 保持原档，aria-pressed 仍在 small
      expect(spy).toHaveBeenCalledTimes(1)
      expect(settingsStore.system.value.fontScales?.chat).toBe(DEFAULT_FONT_SCALES.chat)
      expect(chatTierButton('xlarge').getAttribute('aria-pressed')).toBe('false')
      expect(chatTierButton('small').getAttribute('aria-pressed')).toBe('true')
    } finally {
      wrapper.unmount()
      vi.restoreAllMocks()
    }
  })
})
