/**
 * 设置页 nav 派生（容器扩展点统一 §6.1 / U8 验收②③④）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者：注册表派生分组结构 / contentMaxWidth 声明字段 / 分区键映射（纯逻辑断言）；
 * - 使用者：SettingsModal mount 后 nav 分区 testid 可点、点击切换分区（DOM 交互断言）；
 * - 观察者：首屏 17 内置 nav 项 + 三组头渲染；无组插件声明归「其他」组（组头可见）。
 *
 * 插件声明注入 = getContentSlotRegistry().loadExternal（U4 通路落地后同一入口；
 * 本单元直接驱动注册表，声明形状 = ContentSlotDeclaration）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/settings
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  provideSettingsStore,
  createSettingsStore,
} from '@taiji/core'
import type { ContentSlotDeclaration } from '@taiji/core'
import { SETTINGS_TOAST_KEY, QUOTA_CONFIGURE_FACTORY_KEY } from '@taiji/ui/features/settings'

vi.mock('@/api', () => settingsModalApiModule())
vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(async () => ({ sounds: [] })),
  getProxyConfig: vi.fn(async () => ({})),
  setProxyConfig: vi.fn(async () => undefined),
  testProxy: vi.fn(async () => ({ success: true })),
  getDataDir: vi.fn(async () => undefined),
  chooseDirectory: vi.fn(async () => null),
}))

// '@/api' mock 工厂 import 必须先于组件 import 求值（vi.hoisted 同族坑，见 settings-modal-smoke.test.ts）
import { settingsModalApiModule } from '../../helpers/settings-modal-api-mock'
import { inMemoryStorage } from '../../helpers/platform-storage-stub'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import {
  __resetContentSlotsForTesting,
  contentMaxWidthCss,
  getContentSlotRegistry,
  settingsGroupHeadLabel,
  settingsNavKey,
  slotDisplayLabel,
  useSettingsNavGroups,
  useSettingsNavSections,
} from '@/lib/content-slots'
import { makeQuotaModuleStub } from '@taiji/core/testing'
import { makeSettingsTransportStub } from '../../helpers/settings-transport-stub'

const fakeT = (key: string): string => `t:${key}`

/** 插件 settings.section 声明工厂（pluginId 经 loadExternal 传入，id 须同命名空间）。 */
function pluginSection(id: string, group: string | undefined, label = '探针分区'): ContentSlotDeclaration {
  return {
    id,
    placement: 'settings.section',
    label,
    ...(group !== undefined ? { group } : {}),
    scope: 'global',
    pluginId: 'probe',
    renderer: { kind: 'view', viewId: id },
  }
}

beforeEach(() => {
  __resetContentSlotsForTesting()
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  provideSettingsStore(createSettingsStore())
})

// teleport 到 body 的挂载件用例间必须卸载（焦点断言/跨用例 DOM 污染）
enableAutoUnmount(afterEach)

describe('设置页内置 17 项注册表派生（§6.1 设置页行）', () => {
  it('三个内置分组 + 组内分区键顺序与既有 navGroups 一致（零行为变化基线）', () => {
    const groups = useSettingsNavGroups().value
    expect(groups.map((g) => g.group)).toEqual(['resources', 'input-appearance', 'env-system'])
    const keys = groups.flatMap((g) => g.sections.map(settingsNavKey))
    expect(keys).toEqual([
      'provider', 'skill', 'agent', 'extension', 'mcp', 'preset',
      'appearance', 'system-prompt', 'rename-session', 'tts', 'terminal',
      'worktree', 'update', 'remote-access', 'network-proxy', 'system', 'usage',
    ])
  })

  it('contentMaxWidth 三档判据来自声明字段（§7.5 落位）：usage 宽 / mcp·system-prompt·rename-session 中 / 其余缺省', () => {
    const sections = useSettingsNavSections().value
    const maxWidthOf = (key: string): string | undefined =>
      sections.find((s) => settingsNavKey(s) === key)?.contentMaxWidth
    expect(maxWidthOf('usage')).toBe('wide')
    expect(maxWidthOf('mcp')).toBe('medium')
    expect(maxWidthOf('system-prompt')).toBe('medium')
    expect(maxWidthOf('rename-session')).toBe('medium')
    expect(maxWidthOf('provider')).toBeUndefined()
    expect(maxWidthOf('worktree')).toBeUndefined()
    // 档位 → CSS 值映射（现行三档值）
    expect(contentMaxWidthCss('wide')).toBe('var(--content-max-w-wide)')
    expect(contentMaxWidthCss('medium')).toBe('860px')
    expect(contentMaxWidthCss(undefined)).toBe('var(--content-max-w)')
  })

  it('分区键映射：内置项去 ui. 前缀（testid/深链键不变），插件项保留声明 id 全值', () => {
    const sections = useSettingsNavSections().value
    const provider = sections.find((s) => s.id === 'ui.provider')
    expect(provider).toBeDefined()
    expect(settingsNavKey(provider!)).toBe('provider')
    getContentSlotRegistry().loadExternal('probe', [pluginSection('probe.panel', undefined)])
    const plugin = useSettingsNavSections().value.find((s) => s.id === 'probe.panel')
    expect(plugin).toBeDefined()
    expect(settingsNavKey(plugin!)).toBe('probe.panel')
  })
})

describe('插件声明项合并（§6.1：group 归属、无组归「其他」）', () => {
  it('无 group 声明归入「其他」组（undefined 桶），组头文案走 groupOther 键', () => {
    getContentSlotRegistry().loadExternal('probe', [pluginSection('probe.panel', undefined)])
    const groups = useSettingsNavGroups().value
    const other = groups.find((g) => g.group === undefined)
    expect(other).toBeDefined()
    expect(other!.sections.map((s) => s.id)).toEqual(['probe.panel'])
    expect(settingsGroupHeadLabel(undefined, fakeT)).toBe('t:settings.menu.groupOther')
  })

  it('带 group 声明归入同名组：既有内置组并入桶内、新组以声明 group 原文为组头', () => {
    getContentSlotRegistry().loadExternal('probe', [
      pluginSection('probe.extra', 'resources'),
      pluginSection('probe.custom', '我的分组'),
    ])
    const groups = useSettingsNavGroups().value
    const resources = groups.find((g) => g.group === 'resources')
    expect(resources?.sections.map((s) => s.id)).toContain('probe.extra')
    const custom = groups.find((g) => g.group === '我的分组')
    expect(custom?.sections.map((s) => s.id)).toEqual(['probe.custom'])
    // 内置组头走 i18n key；插件组头 = 声明原文
    expect(settingsGroupHeadLabel('resources', fakeT)).toBe('t:settings.menu.groupResources')
    expect(settingsGroupHeadLabel('我的分组', fakeT)).toBe('我的分组')
  })

  it('文案谓词（§6.16④）：内置走 labelKey 翻译，插件走声明 label 原文', () => {
    const sections = useSettingsNavSections().value
    const provider = sections.find((s) => settingsNavKey(s) === 'provider')!
    expect(slotDisplayLabel(provider, fakeT)).toBe('t:settings.menu.provider')
    getContentSlotRegistry().loadExternal('probe', [pluginSection('probe.panel', undefined, '我的面板')])
    const plugin = useSettingsNavSections().value.find((s) => s.id === 'probe.panel')!
    expect(slotDisplayLabel(plugin, fakeT)).toBe('我的面板')
  })
})

// ── 渲染视角（SettingsModal mount，DOM 断言）────────────────────────────

/** mock 平台注入（in-memory storage + 立即关闭的 no-op WebSocket，避免 WS 连接）。 */
function provideMockPlatform(): void {
  providePlatform({
    kind: 'mock',
    storage: inMemoryStorage(),
    webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
  })
}

function mountModal(props: { open: boolean; initialSection?: string } = { open: true }): ReturnType<typeof mount> {
  provideMockPlatform()
  provideSettingsTransport(makeSettingsTransportStub())
  return mount(SettingsModal, {
    props,
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY as symbol]: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
        [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
      },
    },
  })
}

describe('SettingsModal nav 渲染（观察者 + 使用者视角）', () => {
  it('首屏：17 内置分区 testid 全渲染 + 三组头文案可见（§6.1 内置项零行为变化）', () => {
    mountModal()
    const body = document.body
    const keys = [
      'provider', 'skill', 'agent', 'extension', 'mcp', 'preset',
      'appearance', 'system-prompt', 'rename-session', 'tts', 'terminal',
      'worktree', 'update', 'remote-access', 'network-proxy', 'system', 'usage',
    ]
    for (const key of keys) {
      expect(body.querySelector(`[data-testid="settings-nav-${key}"]`)).not.toBeNull()
    }
    const text = body.textContent ?? ''
    expect(text).toContain('模型与资源')
    expect(text).toContain('输入与外观')
    expect(text).toContain('环境与系统')
  })

  it('无组插件声明渲染进「其他」组，插件项 testid = 声明 id（§6.1 合并语义可见）', () => {
    getContentSlotRegistry().loadExternal('probe', [pluginSection('probe.panel', undefined, '探针面板')])
    mountModal()
    const body = document.body
    expect(body.querySelector('[data-testid="settings-nav-probe.panel"]')).not.toBeNull()
    expect(body.textContent).toContain('探针面板')
    expect(body.textContent).toContain('其他')
  })

  it('点击 nav 项切换分区：内容列限宽随声明档位变化（860px / wide / 默认）', async () => {
    mountModal()
    await flushPromises()
    // 组件 teleport 到 document.body，wrapper.find 搜不到 → DOM 查询（smoke 测试同款）
    const column = (): string =>
      document.body.querySelector<HTMLElement>('.content-col-inner')?.getAttribute('style') ?? ''
    // 初始 provider = 缺省档
    expect(column()).toContain('var(--content-max-w)')
    // mcp = 声明 medium → 860px
    document.body.querySelector<HTMLElement>('[data-testid="settings-nav-mcp"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(column()).toContain('860px')
    // usage = 声明 wide → wide token
    document.body.querySelector<HTMLElement>('[data-testid="settings-nav-usage"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(column()).toContain('var(--content-max-w-wide)')
  })

  it('深链 initialSection 裸分区键直达（aria-current 落位；MenuId 去字面量后深链契约不变）', () => {
    mountModal({ open: true, initialSection: 'remote-access' })
    const target = document.body.querySelector('[data-testid="settings-nav-remote-access"]')
    expect(target).not.toBeNull()
    expect(target!.getAttribute('aria-current')).toBe('page')
    expect(document.body.querySelector('[data-testid="settings-nav-provider"]')!.getAttribute('aria-current')).toBeNull()
  })

  it('深链非法值回落内置缺省分区 provider（既有行为保持）', () => {
    mountModal({ open: true, initialSection: 'nonexistent.section' })
    expect(document.body.querySelector('[data-testid="settings-nav-provider"]')!.getAttribute('aria-current')).toBe('page')
  })
})
