/**
 * PanelHeader 组件单测：卡头控件构成（demo shell spec §3.5 + 审计 R11 + 2026-10-14 裁决回归）。
 *
 * 覆盖：
 * - 卡头身份位：只显会话名；目录/分支次要行按 R11 移除不回归（R11-2）
 * - session JSONL 文件名按钮（2026-10-14 用户裁决回归；R11 曾移除并登记待裁决）：
 *   短文件名展示 / 点击复制绝对路径 / sessionFile 缺失不渲染 / 右侧按钮组最前
 * - i18n 契约（copySessionFile 双语 + 折叠态 chrome 槽位文案）
 *
 * 三视角（AGENTS.md 测试规范 #5-8）：
 * - 构建者：props 驱动（sessionLabel/status/sessionId）
 * - 使用者：折叠态 chrome 按钮可点（toggle collapsed）
 * - 观察者：DOM 含 testid / 无 R11 移除项残留
 *
 * 覆盖（review MF-6 保留范围）：折叠态 chrome 迁入（collapsed → sidebar-collapse-toggle +
 * pl-[88px] 让位；全屏态回退 pl-3.5）+ ExtensionHost panel.header 挂载点（sessionId →
 * ViewHost 挂载且 viewId/sessionId/empty 正确；不传不渲染）。
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
// usePlatformChrome mock（可控 isFullscreen，全屏态 chrome 回退测试）：helper 持单例态
// （beforeEach 经 platformChromeMock 复位；TrafficLight.test.ts 同范式）。工厂内动态
// import——vi.mock 调用被提升到 import 初始化前，工厂必须自包含（无 TDZ 引用）
import { platformChromeMock } from '@/__tests__/helpers/platform-chrome-mock'
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { installPlatformChromeMock } = await import('@/__tests__/helpers/platform-chrome-mock')
  return installPlatformChromeMock('mac')
})

/** session JSONL 磁盘绝对路径 fixture（短名 = id 前 8 位 + .jsonl，与 formatShortSessionFile 同源） */
const SESSION_FILE_PATH =
  '/Users/u/.taiji/agent/sessions/cwd-hash/2026-07-09T11-16-46-632Z_019f4698-2fa8-791c-858f-d02ba39d9676.jsonl'

function mountHeader(overrides: Record<string, unknown> = {}) {
  return mount(PanelHeader, {
    props: {
      sessionLabel: 'test',
      status: 'done' as DerivedStatus,
      ...overrides,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 折叠态持久化跨测试隔离：上一用例写入的折叠态不得泄漏进下一用例的 store 初始化
  localStorage.removeItem('taiji:side-collapsed')
})

describe('PanelHeader 卡头构成（demo spec §3.5 + 审计 R11 + 2026-10-14 裁决回归）', () => {
  it('U1: 有 sessionLabel 时显示会话名', () => {
    const wrapper = mountHeader({ sessionLabel: '修复登录 bug' })
    expect(wrapper.find('[data-testid="panel-session-label"]').text()).toBe('修复登录 bug')
  })

  it('U2: 无 session（空态）显示「新建任务」（workspace.newTask 兜底）', () => {
    const wrapper = mountHeader({ sessionLabel: '' })
    expect(wrapper.find('[data-testid="panel-session-label"]').text()).toContain('新建任务')
  })

  it('R11-1（裁决回归）: sessionFile 存在 → .jsonl 文件名按钮渲染短文件名', () => {
    const wrapper = mountHeader({ sessionFile: SESSION_FILE_PATH })
    const el = wrapper.find('[data-testid="panel-session-file"]')
    expect(el.exists()).toBe(true)
    // 短文件名 = id 前 8 位 + .jsonl（formatShortSessionFile 同源口径）
    expect(el.text()).toContain('019f4698.jsonl')
    // title 提示复制语义（i18n key panel.header.copySessionFile）
    expect(el.attributes('title')).toBe('复制 session 文件路径')
  })

  it('R11-1b: 点击文件名 → clipboard.writeText 收到 JSONL 绝对路径（非短名）', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    })
    const wrapper = mountHeader({ sessionFile: SESSION_FILE_PATH })
    await wrapper.find('[data-testid="panel-session-file"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SESSION_FILE_PATH)
  })

  it('R11-1c: sessionFile 缺失（pi 延迟写入窗口，规则 #6）→ 按钮不渲染', () => {
    const wrapper = mountHeader()
    expect(wrapper.find('[data-testid="panel-session-file"]').exists()).toBe(false)
  })

  it('R11-1d: 文件名按钮在右侧按钮组内且在 drawer 开关之前', () => {
    const wrapper = mountHeader({ sessionFile: SESSION_FILE_PATH })
    const fileBtn = wrapper.find('[data-testid="panel-session-file"]')
    const drawerBtn = wrapper.find('[data-testid="drawer-toggle"]')
    const rightGroup = wrapper.find('.ml-auto')
    expect(rightGroup.exists()).toBe(true)
    expect(rightGroup.element.contains(fileBtn.element)).toBe(true)
    // DOM 顺序：文件名按钮在前（右侧按钮组最前，同旧版落位）
    expect(fileBtn.element.compareDocumentPosition(drawerBtn.element as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('R11-2: 目录/分支次要行不再上卡头（三重重复形态移除，只显会话名）', () => {
    const wrapper = mountHeader()
    const labelWrap = wrapper.find('[data-testid="panel-session-label"]').element.parentElement!
    // 会话名容器内只有会话名一个文本节点（无 mono 目录名/分支后缀）
    expect(labelWrap.querySelectorAll('span').length).toBe(1)
    expect(labelWrap.textContent).toBe('test')
  })
})

describe('PanelHeader 折叠态 chrome 迁入（review MF-6）', () => {
  beforeEach(() => {
    platformChromeMock.isFullscreen.value = false
  })

  it('collapsed=true → header 渲染 sidebar-collapse-toggle + pl-[88px] 让位红黄绿，drawer-toggle 恒显（ui-replica MF-1-49）', async () => {
    const sidebar = useSidebarStore()
    sidebar.userCollapsed = true

    const wrapper = mountHeader()
    const header = wrapper.find('header')
    // 让位类：非全屏留 pl-[88px]（红黄绿原生 x8~60，chrome 起 x≈88 与浮层一致）
    expect(header.classes()).toContain('pl-[88px]')
    // chrome 三按钮组迁入 header（收起按钮 testid 与浮层 AppNavControls 同源）
    expect(wrapper.find('[data-testid="sidebar-collapse-toggle"]').exists()).toBe(true)
    // 折叠态右抽屉开关恒显（demo .app.folded 隐藏规则不波及 .tbtn 开关钮；侧栏折叠后
    // 本钮是右抽屉唯一鼠标入口，demo 两开关折叠态恒渲染）
    expect(wrapper.find('[data-testid="drawer-toggle"]').exists()).toBe(true)
  })

  it('collapsed=true + isFullscreen → header 回退 pl-3.5（全屏红黄绿 OS 隐藏不占位）', () => {
    const sidebar = useSidebarStore()
    sidebar.userCollapsed = true
    platformChromeMock.isFullscreen.value = true

    const wrapper = mountHeader()
    const header = wrapper.find('header')
    expect(header.classes()).toContain('pl-3.5')
    expect(header.classes()).not.toContain('pl-[88px]')
  })

  it('collapsed=false → chrome 不迁入（无 sidebar-collapse-toggle），header 保持 pl-3.5', () => {
    const wrapper = mountHeader()
    const header = wrapper.find('header')
    expect(header.classes()).toContain('pl-3.5')
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
