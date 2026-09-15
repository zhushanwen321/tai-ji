/**
 * PanelHeader 组件单测：session JSONL 文件名展示与复制。
 *
 * 覆盖：
 * - 右侧按钮组内展示短文件名（前 8 位 + .jsonl），点击复制绝对路径
 * - sessionFile 为空时不渲染（aca29110c 移除 overlay 两态后恒用主 sessionFile；
 *   subagent/agent call 详情改由 drawer primary tabs 承接）
 * - i18n 契约
 *
 * 三视角（AGENTS.md 测试规范 #5-8）：
 * - 构建者：props 驱动 displayFile computed
 * - 使用者：点击 → clipboard.writeText 被调用
 * - 观察者：DOM 含 testid + 短文件名文本 + 位置在右侧按钮组
 *
 * 覆盖（review MF-6）：折叠态 chrome 迁入（collapsed → sidebar-collapse-toggle + pl-[88px] 让位；
 * 全屏态回退 pl-4）+ ExtensionHost panel.header 挂载点（sessionId → ViewHost 挂载且
 * viewId/sessionId/empty 正确；不传不渲染）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/PanelHeader.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PanelHeader from '@/components/panel/PanelHeader.vue'
import { useSidebarStore } from '@/stores/sidebar'
import { ViewHost } from '@taiji/ui/extension-host'
import type { DerivedStatus } from '@/types'

/** usePlatformChrome mock：可控 isFullscreen（全屏态 chrome 回退测试）。
 *  真实模块 isFullscreen 是模块级单例 ref 未导出，测试无法直接改值，故 mock 模块。 */
const platformChromeMock = vi.hoisted(() => ({ isFullscreen: { value: false } as { value: boolean } }))
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { ref } = await import('vue')
  const isFullscreen = ref(false)
  platformChromeMock.isFullscreen = isFullscreen
  return {
    usePlatformChrome: () => ({ isFullscreen }),
    detectPlatform: () => 'mac',
  }
})

const SESSION_FILE_PATH =
  '/Users/u/.taiji/agent/sessions/cwd-hash/2026-07-09T11-16-46-632Z_019f4698-2fa8-791c-858f-d02ba39d9676.jsonl'

function mountHeader(overrides: Record<string, unknown> = {}) {
  return mount(PanelHeader, {
    props: {
      sessionLabel: 'test',
      sessionDir: '/repo',
      status: 'done' as DerivedStatus,
      sessionFile: SESSION_FILE_PATH,
      ...overrides,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  })
})

describe('PanelHeader session 文件名展示（正常态）', () => {
  it('U1: 有 sessionFile 时展示短文件名 019f4698.jsonl', () => {
    const wrapper = mountHeader()
    const el = wrapper.find('[data-testid="panel-session-file"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('019f4698.jsonl')
  })

  it('U2: 无 sessionFile 时不渲染', () => {
    const wrapper = mountHeader({ sessionFile: undefined })
    expect(wrapper.find('[data-testid="panel-session-file"]').exists()).toBe(false)
  })

  it('U3: 点击文件名复制主 session 绝对路径', async () => {
    const wrapper = mountHeader()
    await wrapper.find('[data-testid="panel-session-file"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SESSION_FILE_PATH)
  })

  it('U4: 文件名按钮在右侧按钮组内（drawer 按钮之前）', () => {
    const wrapper = mountHeader()
    const fileBtn = wrapper.find('[data-testid="panel-session-file"]')
    const drawerBtn = wrapper.find('[data-testid="drawer-toggle"]')
    expect(fileBtn.exists()).toBe(true)
    // 两个按钮在同一个右侧容器内（父元素含 ml-auto）
    const rightGroup = wrapper.find('.ml-auto')
    expect(rightGroup.exists()).toBe(true)
    expect(rightGroup.element.contains(fileBtn.element)).toBe(true)
    // 文件名按钮在 drawer 按钮之前（DOM 顺序）
    expect(fileBtn.element.compareDocumentPosition(drawerBtn.element as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
})

describe('PanelHeader i18n 契约', () => {
  it('E1: 中英文 locale 均包含 copySessionFile 文案', async () => {
    const { default: zh } = await import('@/i18n/locales/zh-CN/panel')
    const { default: en } = await import('@/i18n/locales/en-US/panel')
    expect(zh.header.copySessionFile).toBe('复制 session 文件路径')
    expect(en.header.copySessionFile).toBe('Copy session file path')
  })
})

describe('PanelHeader 折叠态 chrome 迁入（review MF-6）', () => {
  beforeEach(() => {
    platformChromeMock.isFullscreen.value = false
  })

  it('collapsed=true → header 渲染 sidebar-collapse-toggle + pl-[88px] 让位红黄绿，drawer-toggle 隐藏', () => {
    const sidebar = useSidebarStore()
    sidebar.collapsed = true

    const wrapper = mountHeader()
    const header = wrapper.find('header')
    // 让位类：非全屏留 pl-[88px]（红黄绿原生 x8~60，chrome 起 x≈88 与浮层一致）
    expect(header.classes()).toContain('pl-[88px]')
    // chrome 三按钮组迁入 header（收起按钮 testid 与浮层 AppNavControls 同源）
    expect(wrapper.find('[data-testid="sidebar-collapse-toggle"]').exists()).toBe(true)
    // 折叠态 drawer toggle 不渲染（chrome 按钮组已含侧栏切换）
    expect(wrapper.find('[data-testid="drawer-toggle"]').exists()).toBe(false)
  })

  it('collapsed=true + isFullscreen → header 回退 pl-4（全屏红黄绿 OS 隐藏不占位）', () => {
    const sidebar = useSidebarStore()
    sidebar.collapsed = true
    platformChromeMock.isFullscreen.value = true

    const wrapper = mountHeader()
    const header = wrapper.find('header')
    expect(header.classes()).toContain('pl-4')
    expect(header.classes()).not.toContain('pl-[88px]')
  })

  it('collapsed=false → chrome 不迁入（无 sidebar-collapse-toggle），header 保持 pl-4', () => {
    const wrapper = mountHeader()
    const header = wrapper.find('header')
    expect(header.classes()).toContain('pl-4')
    expect(header.classes()).not.toContain('pl-[88px]')
    expect(wrapper.find('[data-testid="sidebar-collapse-toggle"]').exists()).toBe(false)
    // 非折叠态 drawer toggle 保留
    expect(wrapper.find('[data-testid="drawer-toggle"]').exists()).toBe(true)
  })
})

describe('PanelHeader ExtensionHost panel.header 挂载点（review MF-6）', () => {
  it('传 sessionId → ViewHost 挂载且 viewId/sessionId/empty 正确', () => {
    const wrapper = mountHeader({ sessionId: 'sess-1' })
    const host = wrapper.findComponent(ViewHost)
    expect(host.exists()).toBe(true)
    expect(host.props('viewId')).toBe('panel.header')
    expect(host.props('sessionId')).toBe('sess-1')
    expect(host.props('empty')).toBe('hidden')
  })

  it('不传 sessionId → ViewHost 不渲染（挂载点零 DOM，不挤压右侧内置按钮）', () => {
    const wrapper = mountHeader()
    expect(wrapper.findComponent(ViewHost).exists()).toBe(false)
  })
})
