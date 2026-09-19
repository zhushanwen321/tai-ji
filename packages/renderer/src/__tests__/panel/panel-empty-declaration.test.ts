/**
 * Panel 空会话声明行挂载点回归（e2e E2E-CF-6 真实缺口的单测锁）。
 *
 * 缺陷现场：`ModeDeclarationRow.vue` 组件层已满足「声明行渲染不得依赖消息数」
 * （mode-declaration-row.test.ts 的 MessageStream 集成块已锁），但应用层 Panel.vue 把
 * MessageStream 的挂载判据写成 `conversation && hasMessages`——空会话走「空对话态」分支，
 * 声明行整条无处渲染。e2e mock fixture `s3`（零消息的非默认模式会话）因此断言不到
 * `mode-declaration-row`（E2E-CF-6）。
 *
 * 本文件在 **Panel.vue 层**（真 pinia + 真 ModeDeclarationRow，仅 stub 重子组件）锁：
 * - 空会话 + 非默认模式 → `mode-declaration-row` 存在（缺陷回归断言）；
 * - 空会话 + 默认模式 / presets 未加载 / 加载失败 → 不存在（E7 三态反向语义）；
 * - 有消息 + 非默认模式 → 仍走 MessageStream 分支（既有布局与行为不变）。
 *
 * 设计依据：`.tmp/tech-design/mode-system-composer-density.md` §6.5 D5 + §7.4（声明行）
 * + §7.5 E7（三态降级）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-empty-declaration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import { useChatStore } from '@/stores/chat'
import type { PiLaunchPreset } from '@taiji/shared'

// ── useExtensionUI mock（usePanelView 的 overlay 订阅：无 pending 请求）──
const uiMock = vi.hoisted(() => ({
  askUserReq: { value: undefined as undefined | { askUser?: boolean } },
  respond: () => {},
  cancel: () => {},
}))
vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentAskUserRequest: uiMock.askUserReq,
    respond: uiMock.respond,
    cancel: uiMock.cancel,
  }),
  askUserFilter: (req: { askUser?: boolean } | undefined) => req?.askUser === true,
}))

/** 重子组件 stub（ModeDeclarationRow 保持真实——它是被测挂载点） */
const panelStubs = {
  PanelHeader: { template: '<div />' },
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer-box" />' },
  Landing: { template: '<div data-testid="landing" />' },
  InboundFrameDroppedNotice: { template: '<div />' },
}

const FULL: PiLaunchPreset = {
  id: 'builtin:full', name: '全工具模式', builtin: true, order: 0,
  toolMode: 'all', extensionMode: 'all',
}

/** 自定义非默认模式（allowlist 工具 + append 提示词，声明行有内容可断言） */
function dispatchPreset(): PiLaunchPreset {
  return {
    id: 'custom:dispatch', name: '调度模式', builtin: false, order: 1,
    toolMode: 'allowlist', allowedTools: ['read', 'grep', 'find'],
    extensionMode: 'denylist', deniedExtensions: ['@zhushanwen/pi-subagent-workflow'],
    prompt: { append: { enabled: true, prompt: '派发前写自包含 brief' } },
  }
}

/** 写会话列表（含 launchPresetId）；groups 整表覆盖 = store 唯一写入口 */
function setSession(id: string, launchPresetId?: string): void {
  useSessionStore().applySnapshot({
    groups: [{
      cwd: '/repo',
      sessions: [{
        id, label: id, cwd: '/repo', status: 'idle',
        lastActiveAt: 1, modelId: 'm', tokenCount: 0, launchPresetId,
      }],
    }],
  })
}

/** 非默认模式 + presets 已加载的公共前置 */
function loadPresets(): void {
  const presetStore = usePresetStore()
  presetStore.setPresets([FULL, dispatchPreset()])
  presetStore.setDefaultPresetId('builtin:full')
}

function mountPanel(sessionId: string) {
  return mount(Panel, {
    props: { panelId: 'panel-root', sessionId, sessionDir: '/repo' },
    global: { stubs: panelStubs },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  uiMock.askUserReq.value = undefined
  const presetStore = usePresetStore()
  presetStore.setPresets([])
  presetStore.setDefaultPresetId('')
  presetStore.setLoadError(null)
})

describe('Panel 空会话声明行挂载点（e2e E2E-CF-6 回归）', () => {
  it('空会话（零消息）+ 非默认模式 → 渲染 mode-declaration-row', () => {
    loadPresets()
    setSession('s1', 'custom:dispatch')
    // 显式锁前置事实：本用例零消息（走「空对话态」分支，非 MessageStream）
    expect(useChatStore().getMessages('s1')).toHaveLength(0)

    const wrapper = mountPanel('s1')

    const row = wrapper.find('[data-testid="mode-declaration-row"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('调度模式')
    // 走的是空对话态分支（MessageStream 未挂载）
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(false)
    // 空态文案仍在（形态未被吞掉）
    expect(wrapper.text()).toContain('开始对话')
  })

  it('空会话 + 默认模式 → 不渲染声明行（判据不变）', () => {
    loadPresets()
    setSession('s1', 'builtin:full')
    expect(mountPanel('s1').find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
  })

  it('空会话 + 非默认模式但 presets 未加载（E7 ①）→ 不渲染', () => {
    setSession('s1', 'custom:dispatch')
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模式已删除')
  })

  it('空会话 + 非默认模式但 presets 加载失败（E7 ③）→ 不渲染', () => {
    setSession('s1', 'custom:dispatch')
    usePresetStore().setLoadError('rpc failed')
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
  })

  it('有消息 + 非默认模式 → 仍走 MessageStream 分支（既有布局不变，声明行由流顶承载）', () => {
    loadPresets()
    setSession('s1', 'custom:dispatch')
    useChatStore().applyMessageEvent('s1', {
      type: 'message.message_start',
      payload: { sessionId: 's1', messageId: 'm1' },
    })
    expect(useChatStore().getMessages('s1').length).toBeGreaterThan(0)

    const wrapper = mountPanel('s1')
    // 有消息 → MessageStream 分支（stub 可见），空对话态不出现
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('开始对话')
  })
})
