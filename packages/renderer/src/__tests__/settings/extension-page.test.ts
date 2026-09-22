/**
 * ExtensionPage 渲染测试（W8）。
 *
 * 覆盖：
 *  - 首屏冒烟：user-installed 项渲染升级按钮 + 自动升级开关；built-in 项不渲染。
 *  - 升级交互：点击升级按钮 → extension.upgrade 被调。
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 extension 门面替成可断言的 mock（fetchRecommended 空数组避免 onMounted 拉取报错；
 *    upgrade/setAutoUpgrade 捕获断言）。
 *  - ConfirmDialog 走 reka-ui Dialog，teleport 到 body；ExtensionPage 默认 open=false 不会渲染内容，
 *    故无需 stub。Switch/Checkbox/Label 等 ui 原语直接渲染。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/extension-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExtensionItem } from '@taiji/core'
import {
  getSettingsStore,
  provideSettingsTransport,
  __resetSettingsStoreForTesting,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '@taiji/core'
import type { SkillDirConfig } from '@taiji/shared'

/** mock 捕获 extension.upgrade / setAutoUpgrade 调用。vi.hoisted 保证在 vi.mock 工厂执行前就绪。 */
const extensionMock = vi.hoisted(() => ({
  upgrade: vi.fn(() => Promise.resolve()),
  setAutoUpgrade: vi.fn(() => Promise.resolve()),
  fetchRecommended: vi.fn(() => Promise.resolve([])),
  onExtensions: vi.fn(() => () => {}),
  toggle: vi.fn(() => Promise.resolve()),
  install: vi.fn(() => Promise.resolve()),
  installDir: vi.fn(() => Promise.resolve()),
  installGitRepository: vi.fn(() => Promise.resolve()),
  cancelInstall: vi.fn(() => Promise.resolve()),
  finishInstall: vi.fn(() => Promise.resolve()),
  uninstall: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  extension: extensionMock,
  default: { extension: extensionMock },
  config: { detectSources: async () => [] },
}))

// RD-4#11：ExtensionPage onMounted 读 getDataDir——mock 该域以便注入「读取失败」路径
const settingsDomainMock = vi.hoisted(() => ({
  getDataDir: vi.fn(() => Promise.resolve('~/.taiji-dev')),
  chooseDirectory: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('@/api/domains/settings', () => settingsDomainMock)

import ExtensionPage from '@/components/settings/extension/ExtensionPage.vue'
import { useToast } from '@/composables/useToast'

/** user-installed 扩展 fixture（source='user-installed'，应渲染升级按钮 + 自动升级开关） */
function userExt(): ExtensionItem {
  return {
    name: 'my-tools',
    displayName: 'my-tools',
    dirName: 'my-tools',
    version: '1.0.0',
    description: 'user installed extension',
    path: '/exts/my-tools',
    enabled: true,
    source: 'user-installed',
    autoUpgrade: false,
    tools: ['tool-a'],
  }
}

/** built-in 扩展 fixture（source='built-in'，不应渲染升级按钮 / 自动升级开关） */
function builtinExt(): ExtensionItem {
  return {
    name: 'core',
    displayName: 'core',
    dirName: 'core',
    version: '0.1.0',
    description: 'built-in extension',
    path: '/exts/core',
    enabled: true,
    source: 'built-in',
    tools: [],
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  extensionMock.upgrade.mockClear()
  extensionMock.setAutoUpgrade.mockClear()
  // 清空全局 toasts（useToast 是模块级单例，跨用例共享）
  const { toasts } = useToast()
  toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ExtensionPage 首屏冒烟', () => {
  it('user-installed 项渲染升级按钮，built-in 项不渲染', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt(), builtinExt()] },
    })
    await flushPromises()
    // 升级按钮带 title="升级"（仅 user-installed）
    const upgradeBtns = wrapper.findAll('button[title="升级"]')
    expect(upgradeBtns.length).toBe(1)
    // 卸载按钮两者都有（确认 user 与 built-in 都渲染了行）
    const uninstallBtns = wrapper.findAll('button[title="卸载"]')
    expect(uninstallBtns.length).toBe(2)
  })

  it('自动升级开关：user-installed 项含「自动升级」label，built-in 不含', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt(), builtinExt()] },
    })
    await flushPromises()
    // 「自动升级」文本仅在 user-installed 行出现一次
    const autoLabels = wrapper.findAll('span').filter((s) => s.text() === '自动升级')
    expect(autoLabels.length).toBe(1)
  })
})

describe('ExtensionPage 升级交互', () => {
  it('点击升级按钮 → extension.upgrade 被调用', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt()] },
    })
    await flushPromises()
    const upgradeBtn = wrapper.find('button[title="升级"]')
    expect(upgradeBtn.exists()).toBe(true)
    await upgradeBtn.trigger('click')
    await flushPromises()
    expect(extensionMock.upgrade).toHaveBeenCalledTimes(1)
    expect(extensionMock.upgrade).toHaveBeenCalledWith('my-tools')
  })
})

// ── W2 · D3: 候选项双触发 bug（U3）──────────────────────────────────
//
// bug 根因：候选项用 <Label> 包裹 <Checkbox> + 内层 <div @click="toggleCandidate">。
// Label 渲染原生 <label>，点击内层 div 时浏览器把点击转发给 labelable 子元素（checkbox button），
// 导致 toggleCandidate 被调用两次（一次 label 转发 → checkbox update:model-value，一次 div @click），
// 两次翻转互相抵消，勾选框不变化。
//
// happy-dom 不模拟浏览器「label → labelable 子元素点击转发」，故纯 DOM click 复现不了 bug。
// 这里改用「模拟浏览器转发行为」策略：点击文字区域时，浏览器会同时触发 checkbox 的
// update:model-value。我们手工模拟这个转发（emit checkbox 的 update:model-value=true），
// 然后断言最终 checkbox 选中态。
//   - bug 模式（<Label> 包 + div @click + checkbox @update:model-value 三处都调 toggleCandidate）：
//     转发触发 checkbox update:model-value → toggleCandidate（加），div @click → toggleCandidate（减），抵消 → 仍 unchecked
//   - 修复模式（去掉重复触发源，单一通道）：转发触发唯一 toggleCandidate → 选中态正确翻一次 → checked
describe('ExtensionPage 候选项点击不双触发（W2 D3）', () => {
  it('模拟浏览器 label 转发 + 文字区 click → checkbox 只翻转一次（选中态正确）', async () => {
    // mock installDir 返回 1 个候选，使组件进入候选选择阶段
    extensionMock.installDir.mockResolvedValueOnce({
      tempDir: '/tmp/cand',
      candidates: [{
        name: 'cand-ext',
        displayName: 'cand-ext',
        dirName: 'cand-ext',
        version: '1.0.0',
        description: 'candidate',
        path: '/tmp/cand/cand-ext',
        enabled: true,
        source: 'user-installed',
        tools: [],
      }],
    })
    wrapper = mount(ExtensionPage, {
      props: { extensions: [] },
    })
    await flushPromises()

    // 切到 Local Dir tab，输入路径，点「发现」触发 installDir → 候选区展开
    const dirTab = wrapper.findAll('button').find((b) => b.text() === 'Local Dir')
    expect(dirTab).toBeTruthy()
    await dirTab!.trigger('click')
    // 用 testid 精确定位安装输入框（顶部 LoadPaths 也有 input，避免误中）
    await wrapper.find('[data-testid="install-input"]').setValue('/some/dir')
    const discoverBtn = wrapper.findAll('button').find((b) => b.text() === '发现')
    expect(discoverBtn).toBeTruthy()
    await discoverBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('发现 1 个候选')

    const checkboxBtn = wrapper.find('[data-testid="install-candidates"] button[role="checkbox"]')
    expect(checkboxBtn.exists()).toBe(true)
    // 初始未选中
    expect(checkboxBtn.attributes('data-state')).toBe('unchecked')

    // === 模拟浏览器 label 转发行为 ===
    // 用户点击文字区域（label 内非 checkbox 区域）。浏览器原生行为：
    //   1) 把 click 转发给 checkbox button → reka-ui 点击处理 → emit update:model-value(true)
    //      → 绑定的 @update:model-value="toggleCandidate" → toggleCandidate（加）
    //   2) 文字区 div 的 @click 也会触发（div 上绑了 @click 时）→ toggleCandidate（减）
    // 两条路径都调 toggleCandidate → 两次翻转抵消 → bug。
    //
    // happy-dom 不自动转发 label → labelable，故手工模拟这两条路径：
    //   - 路径1：点 checkbox button（reka-ui 内部会 emit update:model-value）
    //   - 路径2：点文字区 div（div 仍绑 @click 时触发 toggleCandidate）
    await checkboxBtn.trigger('click') // 路径1：label 转发到 checkbox
    await flushPromises()

    // 路径1 后：bug 模式 toggleCandidate 已被调一次 → 选中（true）
    // 此时若继续模拟路径2（div @click）→ bug 模式下第二次翻转 → 回到 unchecked；
    // 修复模式（div 无 @click）→ 路径2 不产生翻转 → 保持 checked。
    const candidateText = wrapper.findAll('span').find((s) => s.text() === 'cand-ext')
    expect(candidateText).toBeTruthy()
    const clickableArea = candidateText!.element.closest('div.min-w-0')
    expect(clickableArea).toBeTruthy()
    clickableArea!.dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    // 修复后：div 无 @click，路径2 不翻转 → 最终选中态 = checked
    // bug 模式：div 有 @click，路径2 二次翻转 → 最终 = unchecked（测试会失败，锁定 bug）
    expect(checkboxBtn.attributes('data-state')).toBe('checked')
  })
})

// ── W4 · D11: 操作成功 toast 反馈（U7）──────────────────────────────
//
// 背景：install/uninstall/upgrade 成功后只清状态不弹 toast，对比 SystemPage 有 toastInfo('已应用')，
// ExtensionPage 缺反馈。修复后这些操作成功应经 useToast info 反馈。
//
// 验证策略：mock extension API resolve → 触发操作 → flushPromises → 断言全局 toasts 含对应文案。
describe('ExtensionPage 操作成功 toast 反馈（W4 D11）', () => {
  it('install（npm 单步）成功 → toastInfo("扩展已安装")', async () => {
    const { toasts } = useToast()
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    // npm tab 默认选中；输入包名点安装（用 testid 精确定位，顶部 LoadPaths 也有 input）
    await wrapper.find('[data-testid="install-input"]').setValue('foo-pkg')
    const installBtn = wrapper.findAll('button').find((b) => b.text().includes('安装'))
    expect(installBtn).toBeTruthy()
    await installBtn!.trigger('click')
    await flushPromises()
    expect(extensionMock.install).toHaveBeenCalledWith('npm:foo-pkg')
    expect(toasts.value.some((t) => t.message === '扩展已安装' && t.type === 'info')).toBe(true)
  })

  it('uninstall 确认成功 → toastInfo("扩展已卸载")', async () => {
    const { toasts } = useToast()
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt()] },
      attachTo: document.body,
    })
    await flushPromises()
    // 点击卸载按钮打开确认弹窗（confirmTarget=ext.name → ConfirmDialog open）
    const uninstallBtn = wrapper.find('button[title="卸载"]')
    await uninstallBtn.trigger('click')
    await flushPromises()
    // ConfirmDialog teleport 到 body，点「卸载」确认按钮（confirm-text="卸载"）。
    // 用 includes 匹配（按钮内可能含 spinner svg 影响精确匹配）
    const confirm = Array.from(document.body.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('卸载') && (b.textContent ?? '').length <= 4)
    expect(confirm).toBeTruthy()
    confirm!.click()
    await flushPromises()
    expect(extensionMock.uninstall).toHaveBeenCalledWith('my-tools')
    expect(toasts.value.some((t) => t.message === '扩展已卸载' && t.type === 'info')).toBe(true)
  })

  it('upgrade 成功 → toastInfo("扩展已升级")', async () => {
    const { toasts } = useToast()
    wrapper = mount(ExtensionPage, { props: { extensions: [userExt()] } })
    await flushPromises()
    const upgradeBtn = wrapper.find('button[title="升级"]')
    await upgradeBtn.trigger('click')
    await flushPromises()
    expect(extensionMock.upgrade).toHaveBeenCalledWith('my-tools')
    expect(toasts.value.some((t) => t.message === '扩展已升级' && t.type === 'info')).toBe(true)
  })
})

// ── RD-4#1 · 扩展加载路径保存失败回弹（skill/agent 同族第三处：onUpdateExtensionDirs）──
//
// 链路：LoadPaths 勾选（乐观编辑）→ emit update-dirs → onUpdateExtensionDirs →
// settingsStore.setExtensionDirs（transport）→ reject → catch 置位 dirsSaveError →
// LoadPaths 回弹至最近落盘值 + 常驻红字。权威值源 = store.extensionDirs 广播镜像
// （dirs 域无 getter RPC，镜像只被成功落盘后的广播写入）。
describe('ExtensionPage 加载路径保存失败回弹（RD-4#1）', () => {
  function stubTransportWithFailingSetExtensionDirs(): SettingsTransport {
    const noopUnsub = (): void => {}
    return {
      listProviders: async () => ({ providers: [] }),
      listModels: async () => [],
      setProvider: async () => undefined,
      setScopedModels: async () => [],
      discoverModels: async () => ({ success: true, models: [] }),
      setSkillDirs: async () => undefined,
      setAgentDirs: async () => undefined,
      setExtensionDirs: () => Promise.reject(new Error('write failed')),
      onProviders: () => noopUnsub,
      onModels: () => noopUnsub,
      onSkills: () => noopUnsub,
      onAgents: () => noopUnsub,
      onExtensions: () => noopUnsub,
      onSkillDirs: () => noopUnsub,
      onAgentDirs: () => noopUnsub,
      onExtensionDirs: () => noopUnsub,
      onDefaults: () => noopUnsub,
      onSystemPrompt: () => noopUnsub,
      onTerminalConfig: () => noopUnsub,
    }
  }

  it('勾选目录保存失败 → toast + 常驻红字 + 勾选态回弹至最近落盘值', async () => {
    __resetSettingsStoreForTesting()
    __resetSettingsTransportForTesting()
    const persisted: SkillDirConfig[] = [{ path: '/persisted/exts', enabled: false, scope: 'global' }]
    getSettingsStore().extensionDirs.value = persisted
    provideSettingsTransport(stubTransportWithFailingSetExtensionDirs())

    const { toasts } = useToast()
    toasts.value = []
    wrapper = mount(ExtensionPage, { props: { extensions: [] }, attachTo: document.body })
    await flushPromises()

    const checkbox = document.body.querySelector<HTMLElement>('[data-testid="dir-row"] button[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox!.getAttribute('data-state')).toBe('unchecked')

    // 用户勾选 → 持久化 reject
    checkbox!.click()
    await flushPromises()

    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('write failed'))).toBe(true)
    expect(document.body.querySelector('[data-testid="load-paths-save-error"]')).not.toBeNull()
    expect(checkbox!.getAttribute('data-state')).toBe('unchecked')
  })
})

// ── RD-4#11 · getDataDir 读取失败显形（不伪装真实路径）──
//
// 链路：ExtensionPage onMounted → getDataDir() reject → catch 置位 dataDirReadFailed →
// 页面常驻「实际路径读取失败，显示的是默认路径 ~/.taiji」标注（此前无 try/catch，静默回落
// 写死 ~/.taiji，dev 实例路径误导排查）。
describe('ExtensionPage getDataDir 读取失败显形（RD-4#11）', () => {
  it('getDataDir reject → 常驻标注（不伪装真实路径）', async () => {
    settingsDomainMock.getDataDir.mockRejectedValueOnce(new Error('ipc down'))
    wrapper = mount(ExtensionPage, { props: { extensions: [] }, attachTo: document.body })
    await flushPromises()

    const note = document.body.querySelector('[data-testid="extension-datadir-read-failed"]')
    expect(note).not.toBeNull()
    expect(note!.textContent).toContain('读取失败')
  })

  it('getDataDir 成功 → 无标注', async () => {
    settingsDomainMock.getDataDir.mockResolvedValueOnce('~/.taiji-dev')
    wrapper = mount(ExtensionPage, { props: { extensions: [] }, attachTo: document.body })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="extension-datadir-read-failed"]')).toBeNull()
  })
})
