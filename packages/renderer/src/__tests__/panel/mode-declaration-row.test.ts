/**
 * ModeDeclarationRow（u5 mode-declaration-row）单测。
 *
 * 覆盖设计 `.tmp/tech-design/mode-system-composer-density.md` §6.5 D5（派生行）+ §7.4「声明行」行
 * + §7.5 E7（三态降级）的可执行条款：
 * ① 未加载（presets 空 + 无错误）→ 不渲染（不能当「已删除」）；
 * ② 已加载 + 非默认模式 → 渲染模式名 + 工具面/提示词段数两枚描边 chip；
 * ③ 已加载但缺 id → 「模式已删除（<presetId>）」+「新建会话 ⌘N」出口；
 * ④ 加载失败（loadError 非空）→ 等同未加载：不渲染（不误报删除）。
 * 另锁：判据锚在 `defaultPresetId`（不是硬编码 builtin:full）、无 launchPresetId 不渲染。
 * 挂载点（条款 6）：MessageStream 流顶、**滚动容器之外**（不随滚动消失）。
 *
 * 策略：真 pinia + 真 session/preset store；直接 mount ModeDeclarationRow 做四态断言；
 * MessageStream 集成块按 skill-notice-stream.test.ts 同款 mock（virtua / chat deps / useChat /
 * useSidebar），验证真实挂载点位置。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/mode-declaration-row.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// 必须置于 MessageStream import 之前：useChatViewDeps 的 vi.mock 工厂引用本 helper，
// 而 MessageStream 导入时会触发工厂执行（工厂在 hoist 后运行时 helper 必须已初始化）。
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ModeDeclarationRow from '@/components/panel/ModeDeclarationRow.vue'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import { __resetPresetAutoLoadForTest } from '@/composables/features/settings/usePiPresets'
import type { PiLaunchPreset } from '@taiji/shared'

// ── ws 连接态受控 ref（MessageStream 挂载会安装 preset 自动加载单例；测试保持 disconnected，
//    使挂载不触发 RPC；加载点本身由 use-pi-presets.test.ts 覆盖）──────────────────────────
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref } = await import('vue')
  const stateRef = ref<string>('disconnected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

// ── MessageStream 集成块的轻量 mock（对齐 skill-notice-stream.test.ts；不影响上面的直接 mount）──
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: { data: { type: Array, default: () => [] } },
      render(ctx) {
        const data = (ctx.data as unknown[]) ?? []
        return h(
          'div',
          { class: 'mock-virtualizer' },
          data.flatMap((item, index) => ctx.$slots.default?.({ item, index }) ?? []),
        )
      },
    }),
  }
})
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn(), loadMoreHistory: vi.fn(), hasMoreHistory: () => false }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: vi.fn(), forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// ── 样例数据 ─────────────────────────────────────────────────────────────
const FULL: PiLaunchPreset = {
  id: 'builtin:full', name: '全工具模式', builtin: true, order: 0,
  toolMode: 'all', extensionMode: 'all',
}

/** 自定义模式：allowlist 工具 3 项 + append 提示词 1 段（面摘要断言锚点） */
function dispatchPreset(): PiLaunchPreset {
  return {
    id: 'custom:dispatch', name: '调度模式', description: '主 Agent 只做拆解与派发',
    builtin: false, order: 1,
    toolMode: 'allowlist', allowedTools: ['read', 'grep', 'find'],
    extensionMode: 'denylist', deniedExtensions: ['@zhushanwen/pi-subagent-workflow'],
    prompt: { append: { enabled: true, prompt: '派发前写自包含 brief' } },
  }
}

/** 写会话列表（含 launchPresetId / F1 回落事实）；groups 整表覆盖 = store 唯一写入口。 */
function setSession(id: string, launchPresetId?: string, launchPresetFallbackTo?: string): void {
  useSessionStore().applySnapshot({
    groups: [{
      cwd: '/repo',
      sessions: [{
        id, label: id, cwd: '/repo', status: 'idle',
        lastActiveAt: 1, modelId: 'm', tokenCount: 0, launchPresetId, launchPresetFallbackTo,
      }],
    }],
  })
}

function mountRow(sessionId = 's1') {
  return mount(ModeDeclarationRow, { props: { sessionId } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPresetAutoLoadForTest()
  if (wsMock.ref) wsMock.ref.value = 'disconnected'
  const presetStore = usePresetStore()
  presetStore.setPresets([])
  presetStore.setDefaultPresetId('')
  presetStore.setLoadError(null)
})

describe('ModeDeclarationRow 可见性（D5 判据 + E7 三态）', () => {
  it('① 未加载（presets 空 + 无错误）→ 不渲染，且不误报「模式已删除」', () => {
    setSession('s1', 'custom:dispatch')
    const wrapper = mountRow()
    expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模式已删除')
  })

  it('② 已加载 + 非默认模式 → 渲染模式名 + 工具面/提示词段数两枚描边 chip', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL, dispatchPreset()])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'custom:dispatch')

    const wrapper = mountRow()
    const row = wrapper.find('[data-testid="mode-declaration-row"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('调度模式')
    expect(wrapper.find('[data-testid="mode-declaration-tool"]').text()).toBe('工具 · 允许 3 项')
    expect(wrapper.find('[data-testid="mode-declaration-prompt"]').text()).toBe('提示词 · 1 段')
    // 图标走 lucide（禁 Emoji）
    expect(row.findAll('svg').length).toBeGreaterThanOrEqual(1)
    // 正常态无「已删除」出口
    expect(wrapper.find('[data-testid="mode-declaration-new-session"]').exists()).toBe(false)
  })

  it('默认模式 → 不渲染（判据 = launchPresetId === defaultPresetId）', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'builtin:full')
    expect(mountRow().find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
  })

  it('判据锚在 defaultPresetId（非硬编码 builtin:full）：默认改为自定义模式后它不渲染、builtin:full 反而渲染', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL, dispatchPreset()])
    presetStore.setDefaultPresetId('custom:dispatch')

    setSession('s1', 'custom:dispatch')
    expect(mountRow('s1').find('[data-testid="mode-declaration-row"]').exists()).toBe(false)

    setSession('s2', 'builtin:full')
    expect(mountRow('s2').find('[data-testid="mode-declaration-row"]').exists()).toBe(true)
  })

  it('无 launchPresetId 的历史会话 → 不渲染（不误判为非默认 / 不误报删除）', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', undefined)
    const wrapper = mountRow()
    expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模式已删除')
  })

  it('③ 已加载但缺 id → 「模式已删除（<presetId>）」+「新建会话 ⌘N」出口', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'custom:gone')

    const wrapper = mountRow()
    const row = wrapper.find('[data-testid="mode-declaration-row"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('模式已删除（custom:gone）')
    const exit = wrapper.find('[data-testid="mode-declaration-new-session"]')
    expect(exit.exists()).toBe(true)
    expect(exit.text()).toContain('新建会话')
    // 跨平台快捷键显示（mac ⌘N / win Ctrl+N）——不是裸文案
    expect(exit.text()).toMatch(/⌘N|Ctrl\+N/)
    // 删除态无从计算面摘要 → 不渲染两枚 chip
    expect(wrapper.find('[data-testid="mode-declaration-tool"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mode-declaration-prompt"]').exists()).toBe(false)
  })

  it('③a F1 未回落（无 launchPresetFallbackTo）→ 保持「模式已删除」+ 预告「会话重启后将回落全工具」，不声称本次', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'custom:gone')

    const wrapper = mountRow()
    const row = wrapper.find('[data-testid="mode-declaration-row"]')
    expect(row.text()).toContain('模式已删除（custom:gone）')
    const disclosure = wrapper.find('[data-testid="mode-declaration-fallback"]')
    expect(disclosure.exists()).toBe(true)
    expect(disclosure.text()).toBe('会话重启后将回落全工具')
    // 假陈述闸：未重启窗口内禁声称本次已回落
    expect(row.text()).not.toContain('本次以全工具模式启动')
  })

  it('③b F1 已回落（launchPresetFallbackTo=builtin:full）→ 披露「本次以全工具模式启动」，不预告', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'custom:gone', 'builtin:full')

    const wrapper = mountRow()
    const row = wrapper.find('[data-testid="mode-declaration-row"]')
    expect(row.text()).toContain('模式已删除（custom:gone）')
    const disclosure = wrapper.find('[data-testid="mode-declaration-fallback"]')
    expect(disclosure.exists()).toBe(true)
    expect(disclosure.text()).toBe('本次以全工具模式启动')
    expect(row.text()).not.toContain('会话重启后将回落全工具')
    // 出口仍在（回落不阻断会话，仅多一层披露）
    expect(wrapper.find('[data-testid="mode-declaration-new-session"]').exists()).toBe(true)
  })

  it('③c F1 模式可得时无回落披露（正常态不携带回落文案）', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL, dispatchPreset()])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'custom:dispatch')

    const wrapper = mountRow()
    expect(wrapper.find('[data-testid="mode-declaration-fallback"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('回落全工具')
    expect(wrapper.text()).not.toContain('本次以全工具模式启动')
  })

  it('④ 加载失败（presets 空 + loadError 非空）→ 不渲染（不误报删除）', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([])
    presetStore.setLoadError('rpc failed')
    setSession('s1', 'custom:dispatch')

    const wrapper = mountRow()
    expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模式已删除')
  })

  it('④b 部分成功（list 有数据但 loadError 非空）→ 仍不渲染（加载失败 = 等同未加载）', () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL, dispatchPreset()])
    presetStore.setDefaultPresetId('builtin:full')
    presetStore.setLoadError('getDefault failed')
    setSession('s1', 'custom:dispatch')
    expect(mountRow().find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// MessageStream 挂载点（u5 条款 6）：锚在流顶、滚动容器之外（不随滚动消失）。
// ───────────────────────────────────────────────────────────────────────────
describe('MessageStream 挂载点（u5 条款 6）', () => {
  const streamStubs = {
    Turn: { name: 'Turn', template: '<div class="turn-stub" />' },
    SystemNotice: { name: 'SystemNotice', template: '<div class="system-notice-stub" />' },
    BashOutputBlock: { name: 'BashOutputBlock', template: '<div class="bash-stub" />' },
    ForkNotice: { name: 'ForkNotice', template: '<div />' },
    Button: { name: 'Button', template: '<button><slot /></button>' },
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('非默认模式 → 声明行渲染，且位于滚动容器（.message-stream）之外', async () => {
    // ⑥ 显式锁：本用例**不 hydrate 任何消息**（空会话）——声明行渲染不得依赖消息数
    //（e2e u7a 断言假设空会话也渲染；挂在 renderItems.length > 0 分支下会红）。
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL, dispatchPreset()])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'custom:dispatch')

    const wrapper = mount(MessageStream, {
      props: { sessionId: 's1' },
      global: { stubs: streamStubs },
      attachTo: document.body,
    })
    await nextTick()

    const row = wrapper.find('[data-testid="mode-declaration-row"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('调度模式')
    // 流顶锚点 = 滚动容器外（不随滚动消失的结构性判据）
    const scroll = wrapper.find('.message-stream')
    expect(scroll.exists()).toBe(true)
    expect(scroll.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('默认模式 → MessageStream 不渲染声明行', async () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL])
    presetStore.setDefaultPresetId('builtin:full')
    setSession('s1', 'builtin:full')

    const wrapper = mount(MessageStream, {
      props: { sessionId: 's1' },
      global: { stubs: streamStubs },
      attachTo: document.body,
    })
    await nextTick()
    expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
