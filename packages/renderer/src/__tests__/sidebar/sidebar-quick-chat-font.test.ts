/**
 * Sidebar 外观快捷面板「对话流字号」快捷段补测（chat-flow-text-color 分支增量覆盖）。
 *
 * 分支增量 = 面板内 4 档 segmented（PopoverContent 模板段）+ chatTier SSOT 回落 computed +
 * applyChatTier 写入链。此前无任何用例打开过该面板，模板段与写入链零覆盖。
 *
 * 行为断言（用户可见 DOM 优先，真实 reka popover 打开 → portal 内容）：
 * - hover 打开外观快捷面板 → 「对话流字号」段 + 4 档按钮渲染，选中态 aria-pressed
 *   命中 settings.fontScales.chat
 * - fontScales 缺 chat key（存量数据浅合并缺 key）→ 选中态回落 DEFAULT_FONT_SCALES.chat
 *   （SSOT 常量，非写死字面量）
 * - 点档位 → setSystem({ fontScales: { ...原值, chat: tier } })：store 更新 + 持久化落盘
 *   （浅合并语义：sidebar/drawer 等其他分区档位不丢）+ 选中态迁移（aria-pressed 跟随）
 * - setSystem reject → toastError 上报，选中态不迁移（失败不静默、UI 不提前分叉）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-quick-chat-font.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

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
  sidebarStoreModule,
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
vi.mock('@/composables/usePlatformShortcut', () => platformShortcutModule())
vi.mock('@taiji/core/transport/api', () => coreTransportApiModule())

import Sidebar from '@/components/sidebar/Sidebar.vue'
import { DEFAULT_FONT_SCALES, providePlatform, provideSettingsStore, createSettingsStore, getSettingsStore } from '@taiji/core'
import type { KVStorage } from '@taiji/core'

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
function mountSidebar() {
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
async function openQuickAppearancePanel(wrapper: ReturnType<typeof mountSidebar>) {
  const trigger = wrapper.find('[data-testid="sidebar-quick-appearance"]')
  expect(trigger.exists()).toBe(true)
  await trigger.trigger('mouseenter')
  await vi.waitFor(() => {
    expect(document.body.querySelector('[data-testid="sidebar-quick-appearance-panel"]')).toBeTruthy()
  })
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
    const wrapper = mountSidebar()
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
    const wrapper = mountSidebar()
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
    const wrapper = mountSidebar()
    try {
      await openQuickAppearancePanel(wrapper)

      chatTierButton('large').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.waitFor(() => {
        expect(settingsStore.system.value.fontScales?.chat).toBe('large')
      })

      // 选中态迁移（用户可见：aria-pressed 移到 large）
      expect(chatTierButton('large').getAttribute('aria-pressed')).toBe('true')
      expect(chatTierButton('small').getAttribute('aria-pressed')).toBe('false')

      // 浅合并不丢其他分区：原值 sidebar=medium / drawer=medium 保持
      expect(settingsStore.system.value.fontScales?.sidebar).toBe('medium')
      expect(settingsStore.system.value.fontScales?.drawer).toBe('medium')

      // 持久化落盘（PlatformPort.storage 写入 taiji:system-settings，含更新后 fontScales）
      await vi.waitFor(() => {
        expect(platformStorage.dump.get('taiji:system-settings')).toBeTruthy()
      })
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
    const wrapper = mountSidebar()
    try {
      await openQuickAppearancePanel(wrapper)

      chatTierButton('xlarge').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('rpc down')
      })

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
