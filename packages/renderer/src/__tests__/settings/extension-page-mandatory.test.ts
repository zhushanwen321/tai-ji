/**
 * ExtensionPage 三层权限矩阵 UI 测试。
 *
 * 覆盖新的 layer + tier 权限矩阵：
 *  - builtin/infrastructure：可见、不可禁、不可卸、无 autoUpgrade
 *  - builtin/feature：可见、可禁、不可卸、无 autoUpgrade（翻转原 mandatory 行为）
 *  - user：全部操作可见（禁/卸/升级/autoUpgrade）
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 extension 门面替成可断言的 mock（fetchRecommended 空数组避免 onMounted 拉取报错）。
 *  - i18n 由 vitest-i18n-setup.ts 全局 mock（从 zh-CN locale 取值），故 mandatoryBadge 渲染为「内置」。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/extension-page-mandatory.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExtensionItem } from '@taiji/core'

const extensionMock = vi.hoisted(() => ({
  fetchRecommended: vi.fn(() => Promise.resolve([])),
  onExtensions: vi.fn(() => () => {}),
  toggle: vi.fn(() => Promise.resolve()),
  install: vi.fn(() => Promise.resolve()),
  installDir: vi.fn(() => Promise.resolve()),
  installGitRepository: vi.fn(() => Promise.resolve()),
  cancelInstall: vi.fn(() => Promise.resolve()),
  finishInstall: vi.fn(() => Promise.resolve()),
  uninstall: vi.fn(() => Promise.resolve()),
  upgrade: vi.fn(() => Promise.resolve()),
  setAutoUpgrade: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  extension: extensionMock,
  default: { extension: extensionMock },
  config: { detectSources: async () => [] },
}))

import ExtensionPage from '@/components/settings/extension/ExtensionPage.vue'
import { useToast } from '@/composables/useToast'

/** infrastructure builtin fixture（layer='builtin' && tier='infrastructure'，不可禁不可卸） */
function infraBuiltinExt(): ExtensionItem {
  return {
    name: '@zhushanwen/pi-pending-notifications',
    displayName: '@zhushanwen/pi-pending-notifications',
    dirName: 'pi-pending-notifications',
    version: '1.0.0',
    description: 'infra builtin',
    path: '/exts/pi-pending-notifications',
    enabled: true,
    source: 'built-in',
    layer: 'builtin',
    tier: 'infrastructure',
    tools: [],
  }
}

/** feature builtin fixture（layer='builtin' && tier='feature'，可禁不可卸） */
function featureBuiltinExt(): ExtensionItem {
  return {
    name: '@zhushanwen/pi-goal',
    displayName: '@zhushanwen/pi-goal',
    dirName: 'pi-goal',
    version: '0.5.0',
    description: 'feature builtin',
    path: '/exts/pi-goal',
    enabled: true,
    source: 'built-in',
    layer: 'builtin',
    tier: 'feature',
    tools: [],
  }
}

/** user 层扩展 fixture（layer='user'，全部操作可见：禁/卸/升级/autoUpgrade） */
function userExt(): ExtensionItem {
  return {
    name: 'my-tools',
    displayName: 'my-tools',
    dirName: 'my-tools',
    version: '1.0.0',
    description: 'user extension',
    path: '/exts/my-tools',
    enabled: true,
    source: 'user-installed',
    layer: 'user',
    autoUpgrade: false,
    tools: ['tool-a'],
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 清空全局 toasts（useToast 是模块级单例，跨用例共享）
  const { toasts } = useToast()
  toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/**
 * 定位某扩展名对应的「已安装项」根 div。
 * 已安装项根 div 的 class 含 flex items-center gap-3 rounded-card（v6 卡片范式，§5.8 GroupCard；
 * 原 rounded-md border 是 v6 清理的装饰 class，2026-08-04 settings-newtask-v6 wave 修复后改用稳定范式 class）。
 */
function findExtRow(root: ReturnType<typeof mount>, name: string) {
  const rows = root.findAll('div.flex.items-center.gap-3.rounded-card')
  return rows.find((r) => r.text().includes(name))
}

describe('ExtensionPage 三层权限矩阵 UI', () => {
  it('infrastructure builtin 显示「内置」badge + 隐藏启用开关 + 隐藏卸载/升级/autoUpgrade', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [infraBuiltinExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, '@zhushanwen/pi-pending-notifications')
    expect(row).toBeTruthy()
    // badge 含「内置」
    expect(row!.text()).toContain('内置')
    // 启用开关隐藏（infrastructure 不可禁）
    expect(row!.findAll('button[role="switch"]')).toHaveLength(0)
    // 卸载/升级按钮隐藏
    expect(row!.findAll('button[title="卸载"]')).toHaveLength(0)
    expect(row!.findAll('button[title="升级"]')).toHaveLength(0)
    // autoUpgrade 文案不应出现（开关行整体被 v-if 隐藏）
    expect(row!.text()).not.toContain('自动升级')
  })

  it('feature builtin 显示「内置」badge + 显示启用开关（可禁）+ 隐藏卸载/升级/autoUpgrade', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [featureBuiltinExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, '@zhushanwen/pi-goal')
    expect(row).toBeTruthy()
    // badge 含「内置」
    expect(row!.text()).toContain('内置')
    // 启用开关可见（feature builtin 可禁，翻转原 mandatory 行为）
    expect(row!.findAll('button[role="switch"]')).toHaveLength(1)
    // 卸载/升级按钮隐藏（builtin 不可卸，由 runtime 自动升级）
    expect(row!.findAll('button[title="卸载"]')).toHaveLength(0)
    expect(row!.findAll('button[title="升级"]')).toHaveLength(0)
    // autoUpgrade 文案不应出现（开关行整体被 v-if 隐藏）
    expect(row!.text()).not.toContain('自动升级')
  })

  it('user 扩展全部操作可见（禁/卸/升级/autoUpgrade）+ 无「内置」badge', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [userExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, 'my-tools')
    expect(row).toBeTruthy()
    // 卸载 1 + 升级 1
    expect(row!.findAll('button[title="卸载"]')).toHaveLength(1)
    expect(row!.findAll('button[title="升级"]')).toHaveLength(1)
    // enable Switch + autoUpgrade Switch = 2
    expect(row!.findAll('button[role="switch"]')).toHaveLength(2)
    expect(row!.text()).toContain('自动升级')
    // user 层不显示内置 badge
    expect(row!.text()).not.toContain('内置')
  })

  it('首屏渲染 gate：[infra, feature, user] 三行均渲染（防 layer 判断异常导致整行消失）', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [infraBuiltinExt(), featureBuiltinExt(), userExt()] },
    })
    await flushPromises()
    expect(findExtRow(wrapper!, '@zhushanwen/pi-pending-notifications')).toBeTruthy()
    expect(findExtRow(wrapper!, '@zhushanwen/pi-goal')).toBeTruthy()
    expect(findExtRow(wrapper!, 'my-tools')).toBeTruthy()
  })

  it('推荐区为空时不渲染（recommended v-if=false）', async () => {
    // fetchRecommended 默认 resolve([]) → recommended.length === 0 → section 不渲染
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    expect(extensionMock.fetchRecommended).toHaveBeenCalled()
    // 推荐区标题「推荐扩展」不应出现在 DOM
    expect(wrapper!.text()).not.toContain('推荐扩展')
  })

  it('按 layer 分两组渲染：builtin 系统强制组在前、user 用户安装组在后，扩展归入对应组', async () => {
    // 乱序传入：user 在前、builtin 在后，验证分组按 layer 归位而非输入顺序
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt(), infraBuiltinExt(), featureBuiltinExt()] },
    })
    await flushPromises()
    const builtinGroup = wrapper!.find('[data-testid="extension-group-builtin"]')
    const userGroup = wrapper!.find('[data-testid="extension-group-user"]')
    // 两组组头均存在
    expect(builtinGroup.exists()).toBe(true)
    expect(userGroup.exists()).toBe(true)
    // 组头 = 标题 + pill + count + aux
    expect(builtinGroup.text()).toContain('已安装扩展')
    expect(builtinGroup.text()).toContain('系统强制')
    expect(builtinGroup.text()).toContain('runtime 自动安装/升级')
    expect(builtinGroup.text()).toContain('2') // count badge = 2 个 builtin
    expect(userGroup.text()).toContain('用户安装')
    expect(userGroup.text()).toContain('可开关 · 可升级 · 可卸载')
    // builtin 扩展（infrastructure + feature）出现在系统强制组内，user 扩展不在
    expect(builtinGroup.text()).toContain('@zhushanwen/pi-pending-notifications')
    expect(builtinGroup.text()).toContain('@zhushanwen/pi-goal')
    expect(builtinGroup.text()).not.toContain('my-tools')
    // user 扩展出现在用户安装组内，builtin 扩展不在
    expect(userGroup.text()).toContain('my-tools')
    expect(userGroup.text()).not.toContain('@zhushanwen/pi-goal')
    // builtin 组在 user 组之前（DOM 顺序）
    const html = wrapper!.html()
    expect(html.indexOf('extension-group-builtin')).toBeLessThan(html.indexOf('extension-group-user'))
  })

  it('空组不渲染组头（整体隐藏）', async () => {
    // 只有 user 扩展 → builtin 组整体隐藏
    wrapper = mount(ExtensionPage, { props: { extensions: [userExt()] } })
    await flushPromises()
    expect(wrapper!.find('[data-testid="extension-group-builtin"]').exists()).toBe(false)
    expect(wrapper!.find('[data-testid="extension-group-user"]').exists()).toBe(true)
    expect(wrapper!.text()).not.toContain('系统强制')
  })
})
