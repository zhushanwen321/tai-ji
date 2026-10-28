import { extensionApiMock, extensionApiModule, setupExtensionPageTest, teardownExtensionPage } from '../helpers/extension-page-harness';
import { openRekaDropdown, pickRekaOption } from '../helpers/reka-select-harness';
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub';
import SubagentEngineSection from '@/components/settings/agent/SubagentEngineSection.vue';
import ExtensionPage from '@/components/settings/extension/ExtensionPage.vue';
import { useToast } from '@/composables/useToast';
import { createSettingsStore, getSettingsStore, provideSettingsStore, provideSettingsTransport } from '@taiji/core';
import type { SkillDirConfig, ServerMessageMap } from '@taiji/shared';
import zhCN from '@taiji/ui/locale/zh-CN/settings';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← extension-page.test.ts
// ======================================================================

vi.mock('@/api', () => extensionApiModule())

// RD-4#11：ExtensionPage onMounted 读 getDataDir——mock 该域以便注入「读取失败」路径
const settingsDomainMock = vi.hoisted(() => ({
  getDataDir: vi.fn(() => Promise.resolve('~/.taiji-dev')),
  chooseDirectory: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('@/api/domains/settings', () => settingsDomainMock)

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

// beforeEach 重置（pinia / mock 计数 / toast / transport 桩）单源在 helpers/extension-page-harness
setupExtensionPageTest()



/** MF-1-3 / ExtensionDetail 乐观更新用例共用装配：store 预置 userExt，页面 props 与
 *  store.extensions 同引用（生产链路 props 即 store 镜像），挂 body 供开关 DOM 断言 */
async function mountWithPresetStore(): Promise<ReturnType<typeof getSettingsStore>> {
  provideSettingsStore(createSettingsStore())
  const store = getSettingsStore()
  store.extensions.value = [userExt()]
  wrapper = mount(ExtensionPage, {
    props: { extensions: store.extensions.value },
    attachTo: document.body,
  })
  await flushPromises()
  return store
}

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
    expect(extensionApiMock.upgrade).toHaveBeenCalledTimes(1)
    expect(extensionApiMock.upgrade).toHaveBeenCalledWith('my-tools')
  })
})

// ── MF-1-3 · 启用开关乐观更新协议（runOptimisticUpdate 归一）──────────────────
//
// 行为不变量（组件手写 try/catch 回滚迁入协议后必须逐点保持）：
//  B1 乐观翻转：点开关 → store 对应项 enabled 立即翻转（不等 RPC），开关乐观滑动；
//  B2 失败回滚：RPC reject → 回滚到旧值 + 开关回弹 + error ref 就近显示 e.message；
//  B3 权威覆盖：RPC resolve → store.extensions 被 reply.extensions 权威快照整体覆盖
//     （toggle reply 命中 pending 被 routeInbound 吞掉、不走 onExtensions 广播）。
// 走 seam stub（makeSettingsTransportStub + extensionApiMock.toggle）断言，与生产装配同构。
describe('ExtensionActions 启用开关乐观更新协议（MF-1-3）', () => {
  it('点开关 → store enabled 立即翻转 + 开关乐观滑动（不等 RPC，B1）', async () => {
    const store = await mountWithPresetStore()
    // commit 挂起不 resolve：断言乐观翻转发生在 await 之前
    let resolveToggle!: (reply: { extensions: ExtensionItem[] }) => void
    extensionApiMock.toggle.mockImplementationOnce(
      () => new Promise<{ extensions: ExtensionItem[] }>((res) => { resolveToggle = res }),
    )
    const sw = wrapper!.find('button[aria-label="禁用扩展"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('data-state')).toBe('checked')

    await sw.trigger('click')
    // RPC 尚未返回：store 已翻转（乐观写先于 commit），开关已滑动
    // （aria-label 随 enabled 翻转为「启用扩展」——UI 已响应乐观写）
    expect(store.extensions.value[0]!.enabled).toBe(false)
    expect(wrapper!.find('button[aria-label="启用扩展"]').attributes('data-state')).toBe('unchecked')

    resolveToggle({ extensions: [{ ...userExt(), enabled: false }] })
    await flushPromises()
    expect(extensionApiMock.toggle).toHaveBeenCalledWith('my-tools', false)
  })

  it('toggle reject → 回滚到旧值 + 开关回弹 + error ref 显示 e.message（B2）', async () => {
    const store = await mountWithPresetStore()
    extensionApiMock.toggle.mockRejectedValueOnce(new Error('toggle down'))

    await wrapper!.find('button[aria-label="禁用扩展"]').trigger('click')
    await flushPromises()

    // 回滚到旧值 + 开关回弹（现有 catch 行为逐字保持）
    expect(store.extensions.value[0]!.enabled).toBe(true)
    expect(wrapper!.find('button[aria-label="禁用扩展"]').attributes('data-state')).toBe('checked')
    // error ref 就近显示 e.message（非静默吞）
    expect(wrapper!.text()).toContain('toggle down')
  })

  it('toggle resolve → store.extensions 被 reply.extensions 权威快照整体覆盖（B3）', async () => {
    const store = await mountWithPresetStore()
    const authoritative: ExtensionItem[] = [{ ...userExt(), enabled: false, version: '2.0.0' }]
    extensionApiMock.toggle.mockResolvedValueOnce({ extensions: authoritative })

    await wrapper!.find('button[aria-label="禁用扩展"]').trigger('click')
    await flushPromises()

    // reply.extensions 整体覆盖 store（读侧经 reactive 代理，断言内容整体替换而非引用同一）
    expect(store.extensions.value).toStrictEqual(authoritative)
    expect(store.extensions.value[0]!.version).toBe('2.0.0')
  })
})

// ── 自动升级开关乐观更新（ExtensionDetail · runOptimisticUpdate 协议）──────────────
//
// 行为不变量（手写 try/catch 迁入协议后的同一编排侧）：
//  A1 apply 乐观写：点开关 → store 对应项 autoUpgrade 立即翻转（setExtensionAutoUpgrade 返回旧值）
//  A2 commit 持久化：transport.setExtensionAutoUpgrade(name, enabled) 被调
//  A3 失败回滚 + 就近显错：commit reject → store 回滚旧值 + error ref 显示 e.message
describe('ExtensionDetail 自动升级开关（乐观更新协议）', () => {
  it('点开关 → store autoUpgrade 立即翻转 + transport.setExtensionAutoUpgrade 持久化', async () => {
    const store = await mountWithPresetStore()
    const sw = wrapper!.find('button[aria-label="自动升级"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('data-state')).toBe('unchecked')

    await sw.trigger('click')
    await flushPromises()

    // apply 乐观写（store 先翻转）+ commit 持久化
    expect(store.extensions.value[0]!.autoUpgrade).toBe(true)
    expect(extensionApiMock.setAutoUpgrade).toHaveBeenCalledTimes(1)
    expect(extensionApiMock.setAutoUpgrade).toHaveBeenCalledWith('my-tools', true)
  })

  it('commit reject → 回滚旧值 + error 就近显示 e.message', async () => {
    const store = await mountWithPresetStore()
    extensionApiMock.setAutoUpgrade.mockRejectedValueOnce(new Error('persist down'))

    await wrapper!.find('button[aria-label="自动升级"]').trigger('click')
    await flushPromises()

    // rollback：store 回滚旧值，error ref 就近显示（非静默吞）
    expect(store.extensions.value[0]!.autoUpgrade).toBe(false)
    expect(wrapper!.text()).toContain('persist down')
  })
})

// ── 安装流四路径（ExtensionInstallFlow · transport seam 调用范围）──────────────────
/** 切到安装流的 Git URL tab（git 发现两用例共用交互序列） */
async function selectGitTab(): Promise<void> {
  const gitTab = wrapper!.findAll('button').find((b) => b.text() === 'Git URL')
  expect(gitTab).toBeTruthy()
  await gitTab!.trigger('click')
}

/** 在安装输入框填入路径并点「发现」（Git URL / Local Dir 两条发现路径共用交互序列） */
async function fillInstallInputAndDiscover(path: string): Promise<void> {
  await wrapper!.find('[data-testid="install-input"]').setValue(path)
  const discoverBtn = wrapper!.findAll('button').find((b) => b.text() === '发现')
  expect(discoverBtn).toBeTruthy()
  await discoverBtn!.trigger('click')
  await flushPromises()
}

describe('ExtensionInstallFlow 安装流（transport seam）', () => {
  /** 发现一个候选（git tab → installGitRepository → 候选区展开），返回 tempDir */
  async function discoverCandidateViaGit(tempDir: string): Promise<void> {
    extensionApiMock.installGitRepository.mockResolvedValueOnce({ tempDir, candidates: [userExt()] })
    await selectGitTab()
    await fillInstallInputAndDiscover('https://example.com/u/ext')
    expect(wrapper!.find('[data-testid="install-candidates"]').exists()).toBe(true)
  }

  it('推荐扩展一键安装 → installExtension 自动补 npm: 前缀', async () => {
    extensionApiMock.fetchRecommended.mockResolvedValueOnce([
      { name: 'rec-ext', description: 'recommended ext' },
    ] as never)
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()

    // 推荐区 section（v-if recommended.length）按行内包名定位；行内「安装」按钮点击 → npm: 前缀安装
    const recSection = wrapper.findAll('section').find((s) => s.text().includes('rec-ext'))
    expect(recSection).toBeTruthy()
    const installBtn = recSection.findAll('button').find((b) => b.text() === '安装')
    expect(installBtn).toBeTruthy()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(extensionApiMock.install).toHaveBeenCalledWith('npm:rec-ext')
  })

  it('git tab：输入 URL 点发现 → installExtensionGitRepository 被调', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    extensionApiMock.installGitRepository.mockResolvedValueOnce({ tempDir: '/tmp/git', candidates: [] })

    await selectGitTab()
    await fillInstallInputAndDiscover('https://example.com/u/ext')

    expect(extensionApiMock.installGitRepository).toHaveBeenCalledWith('https://example.com/u/ext')
  })

  it('候选确认安装：勾选候选点「安装选中」→ finishInstall(tempDir, names)', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    await discoverCandidateViaGit('/tmp/cand')

    await wrapper.find('[data-testid="install-candidates"] button[role="checkbox"]').trigger('click')
    const confirmBtn = wrapper.findAll('button').find((b) => b.text() === '安装选中')
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')
    await flushPromises()

    expect(extensionApiMock.finishInstall).toHaveBeenCalledWith('/tmp/cand', ['my-tools'])
  })

  it('放弃安装：点「取消」→ cancelInstall(tempDir)（候选区收起）', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    await discoverCandidateViaGit('/tmp/cancel')

    const cancelBtn = wrapper.findAll('button').find((b) => b.text() === '取消')
    expect(cancelBtn).toBeTruthy()
    await cancelBtn!.trigger('click')
    await flushPromises()

    expect(extensionApiMock.cancelInstall).toHaveBeenCalledWith('/tmp/cancel')
    expect(wrapper.find('[data-testid="install-candidates"]').exists()).toBe(false)
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
    extensionApiMock.installDir.mockResolvedValueOnce({
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
    await fillInstallInputAndDiscover('/some/dir')

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
    // [w3b] 候选行改 demo 单行内联形态（无旧两行文字区容器 div），文字元素 = name span 本身
    const clickableArea = candidateText!.element
    clickableArea.dispatchEvent(new Event('click', { bubbles: true }))
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
    expect(extensionApiMock.install).toHaveBeenCalledWith('npm:foo-pkg')
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
    expect(extensionApiMock.uninstall).toHaveBeenCalledWith('my-tools')
    expect(toasts.value.some((t) => t.message === '扩展已卸载' && t.type === 'info')).toBe(true)
  })

  it('upgrade 成功 → toastInfo("扩展已升级")', async () => {
    const { toasts } = useToast()
    wrapper = mount(ExtensionPage, { props: { extensions: [userExt()] } })
    await flushPromises()
    const upgradeBtn = wrapper.find('button[title="升级"]')
    await upgradeBtn.trigger('click')
    await flushPromises()
    expect(extensionApiMock.upgrade).toHaveBeenCalledWith('my-tools')
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
      setProvider: async () => ({}),
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
    provideSettingsStore(createSettingsStore())
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
// 页面常驻「数据目录读取失败，用户级强制目录暂不展示」标注（此前无 try/catch，静默回落
// 写死 ~/.taiji，dev 实例路径误导排查；C-proc-26 后 dev/prod 缺省不同，兜底不断言任一路径）。
describe('ExtensionPage getDataDir 读取失败显形（RD-4#11）', () => {
  it('getDataDir reject → 常驻标注（不伪装真实路径）', async () => {
    settingsDomainMock.getDataDir.mockRejectedValueOnce(new Error('ipc down'))
    wrapper = mount(ExtensionPage, { props: { extensions: [] }, attachTo: document.body })
    await flushPromises()

    const note = document.body.querySelector('[data-testid="extension-datadir-read-failed"]')
    expect(note).not.toBeNull()
    expect(note!.textContent).toContain('读取失败')

    // C-proc-26：dev/prod 数据目录缺省不同，兜底不断言任一具体路径——reject 时
    // user 级强制目录不展示，仅剩 project 级（防回退到写死 ~/.taiji 兜底的旧形态）。
    const forcedRows = document.body.querySelectorAll('[data-testid="forced-dir-row"]')
    expect(forcedRows.length).toBe(1)
    expect(forcedRows[0].textContent).toContain('.taiji/extensions')
    expect(forcedRows[0].textContent).not.toContain('~/.taiji')
  })

  it('getDataDir 成功 → 无标注', async () => {
    settingsDomainMock.getDataDir.mockResolvedValueOnce('~/.taiji-dev')
    wrapper = mount(ExtensionPage, { props: { extensions: [] }, attachTo: document.body })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="extension-datadir-read-failed"]')).toBeNull()

    // 成功路径：user 级强制目录按实际数据目录展示（动态推导，非写死）
    const forcedRows = document.body.querySelectorAll('[data-testid="forced-dir-row"]')
    expect(forcedRows.length).toBe(2)
    expect(forcedRows[0].textContent).toContain('~/.taiji-dev/extensions')
    expect(forcedRows[1].textContent).toContain('.taiji/extensions')
  })
})


// ══════════ 来源：subagent-engine-section.test.ts（子代理引擎选择器；顶层 beforeEach
//             已下沉至本 describe 节内——transport 槽与 extension 节互不覆盖） ══════════

/** getSubagentEngineConfig 的 reply 契约（engineModels/engineDefaults 两 D5 扩展键 optional） */
const sessionApiMock = vi.hoisted(() => ({
  getSubagentEngineConfig: vi.fn(
    async (): Promise<SubagentEngineConfigReply> => ({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' }),
  ),
  setSubagentDefaultEngine: vi.fn(async () => ({ engineId: 'pi' })),
  setSubagentEngineDefaultModel: vi.fn(async (engineId: string, modelRef: string) => ({ engineId, modelRef })),
}))

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN.default ?? zhCN } },
  })
}

function mountSection() {
  return mount(SubagentEngineSection, {
    global: { plugins: [makeI18n()] },
  })
}

/** 挂载前注入一次引擎读取失败，断言 loadError 已显形（两个重试用例的共同前奏）。 */
async function mountWithLoadFailure(): Promise<ReturnType<typeof mountSection>> {
  sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down'))
  const wrapper = mountSection()
  await flushPromises()
  expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(true)
  return wrapper
}

/** saved toast 断言单源（module 统一成功反馈，域文案 settings.subagentEngine.saved）。 */
function expectSavedToast() {
  const { toasts } = useToast()
  expect(toasts.value.some((t) => t.type === 'info' && t.message.includes('已保存'))).toBe(true)
}

describe('SubagentEngineSection（U7 引擎选择器）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 清空全局 toasts（useToast 模块级单例，跨用例共享）
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(sessionApiMock))
  })

  it('渲染动态引擎清单与当前选中态（选项来自 RPC 非硬编码）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode', 'acp'],
      defaultEngine: 'zcode',
    })
    const wrapper = mountSection()
    await flushPromises()

    // 用户可见 DOM：分区标题 + 引擎名出现在 Select 选项数据中
    expect(wrapper.find('[data-testid=subagent-engine-section]').exists()).toBe(true)
    expect(wrapper.text()).toContain('子代理引擎')
    // Select 的 model-value 绑定当前 defaultEngine（触发器展示 zcode）
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('zcode')
    expect(sessionApiMock.getSubagentEngineConfig).toHaveBeenCalledTimes(1)
  })

  it('选择变更 → 调用 setSubagentDefaultEngine（engineId 透传）+ 选中态更新 + saved toast', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
    })
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'pi')
    await flushPromises()

    expect(sessionApiMock.setSubagentDefaultEngine).toHaveBeenCalledWith('pi')
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('pi')
    // module 统一成功反馈：saved toast（域文案 settings.subagentEngine.saved）
    expectSavedToast()
  })

  it('同值选择不发写请求（幂等）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'pi',
    })
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'pi')
    await flushPromises()

    expect(sessionApiMock.setSubagentDefaultEngine).not.toHaveBeenCalled()
  })

  it('切换写失败 → 选中态回滚旧值 + toastError 显形（RD-4#3，不再仅 console）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
    })
    sessionApiMock.setSubagentDefaultEngine.mockRejectedValueOnce(new Error('disk write failed'))
    const { toasts } = useToast()

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'pi')
    await flushPromises()

    expect(sessionApiMock.setSubagentDefaultEngine).toHaveBeenCalledWith('pi')
    // 回滚：Select 受控于 current（仅写成功后前进），触发器仍显示旧值 zcode
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('zcode')
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).not.toContain('pi')
    // 失败显形：error toast 携带 runtime 原始文案
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('disk write failed'))).toBe(true)
    // 回滚路径无成功反馈（saved toast 仅在写成功出现）
    expect(toasts.value.some((t) => t.type === 'info')).toBe(false)
  })

  it('RPC 失败 → loadError 显形：控件禁用 + 顶部常驻提示（RD-4#8，不再 best-effort 冒充已存值）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down'))
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-section]').exists()).toBe(true)
    // 默认 'pi' 仍占位渲染，但明确标注为默认值（控件禁用，禁止当已存值操作）
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('pi')
    // RD-4#8：读取失败常驻提示 + 重试入口
    expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(true)
    expect(wrapper.text()).toContain('读取失败')
    // Select 禁用（loadError 时不可操作）
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(true)
  })

  it('RD-4#8：重试成功后清除 loadError + 控件恢复可用', async () => {
    const wrapper = await mountWithLoadFailure()

    // 重试：mock 改成功
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
    await wrapper.find('[data-testid=subagent-engine-load-retry]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(false)
    // 重新拉取成功后权威值回填：触发器从占位 pi 前进到已存默认 zcode（field reset 回填基准）
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('zcode')
  })

  it('RD-4#8：重试仍失败 → loadError 保持 + 控件保持禁用（占位值不冒充已存值）', async () => {
    const wrapper = await mountWithLoadFailure()

    // 重试：mock 依旧失败
    sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down again'))
    await wrapper.find('[data-testid=subagent-engine-load-retry]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(true)
  })

  // ── D5 per-engine 默认模型行（engine-provider-unification §3.3 D5 / §3.1 S2/S4）──

  it('D5 三形态：zcode 行渲染模型 Select（选项来自 mock 清单）+ pi 行说明文案 + 无清单引擎不渲染行', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode', 'acp'],
      defaultEngine: 'zcode',
      engineModels: {
        zcode: [
          { id: 'prov-a/m-1', name: 'Prov A · m-1' },
          { id: 'prov-b/m-2' },
        ],
      },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    const wrapper = mountSection()
    await flushPromises()

    // zcode 模型行：trigger 存在 + 当前偏好（engineDefaults）回显
    const modelTrigger = wrapper.find('[data-testid=subagent-engine-model-zcode]')
    expect(modelTrigger.exists()).toBe(true)
    expect(modelTrigger.text()).toContain('Prov A · m-1')
    // 打开下拉：选项来自 mock 清单（name 显示名优先，无 name 回落 id）
    const options = await openRekaDropdown(modelTrigger.element)
    expect(options).toHaveLength(2)
    expect(options[0].textContent).toContain('Prov A · m-1')
    expect(options[1].textContent).toContain('prov-b/m-2')
    // pi 行：说明文案行渲染（S4 零配置叙事），无模型 Select
    const piNote = wrapper.find('[data-testid=subagent-engine-pi-note]')
    expect(piNote.exists()).toBe(true)
    expect(piNote.text()).toContain('pi 引擎模型由 pi 自身解析')
    // acp 无清单：不渲染模型行
    expect(wrapper.find('[data-testid=subagent-engine-model-acp]').exists()).toBe(false)
  })

  it('D5：模型选择 → 调用 setSubagentEngineDefaultModel（engineId + modelRef 透传）+ 权威回填 + saved toast', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: {
        zcode: [
          { id: 'prov-a/m-1', name: 'Prov A · m-1' },
          { id: 'prov-b/m-2', name: 'Prov B · m-2' },
        ],
      },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    sessionApiMock.setSubagentEngineDefaultModel.mockResolvedValueOnce({ engineId: 'zcode', modelRef: 'prov-b/m-2' })
    const wrapper = mountSection()
    await flushPromises()

    await pickRekaOption(wrapper.find('[data-testid=subagent-engine-model-zcode]').element, 'Prov B · m-2')

    expect(sessionApiMock.setSubagentEngineDefaultModel).toHaveBeenCalledWith('zcode', 'prov-b/m-2')
    // reply modelRef = 权威回填（触发器前进到新选中）
    expect(wrapper.find('[data-testid=subagent-engine-model-zcode]').text()).toContain('Prov B · m-2')
    // 保存交互与既有区块一致：saved toast（settings.subagentEngine.saved）
    expectSavedToast()
  })

  it('D5：模型保存失败 → 选中态回滚旧值 + modelSaveFailed toast（带 reason）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: {
        zcode: [
          { id: 'prov-a/m-1', name: 'Prov A · m-1' },
          { id: 'prov-b/m-2', name: 'Prov B · m-2' },
        ],
      },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    sessionApiMock.setSubagentEngineDefaultModel.mockRejectedValueOnce(new Error('model not available'))
    const { toasts } = useToast()

    const wrapper = mountSection()
    await flushPromises()

    await pickRekaOption(wrapper.find('[data-testid=subagent-engine-model-zcode]').element, 'Prov B · m-2')

    expect(sessionApiMock.setSubagentEngineDefaultModel).toHaveBeenCalledWith('zcode', 'prov-b/m-2')
    // 回滚：触发器回到已保存基准（旧偏好 Prov A）
    const triggerText = wrapper.find('[data-testid=subagent-engine-model-zcode]').text()
    expect(triggerText).toContain('Prov A · m-1')
    expect(triggerText).not.toContain('Prov B')
    // 失败显形：modelSaveFailed toast 携带 runtime 原始文案（reason 插值）
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('保存失败') && t.message.includes('model not available'))).toBe(true)
  })

  it('D5：同值选择不发写请求（幂等，与引擎切换同款短路）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: { zcode: [{ id: 'prov-a/m-1', name: 'Prov A · m-1' }] },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    const wrapper = mountSection()
    await flushPromises()

    await pickRekaOption(wrapper.find('[data-testid=subagent-engine-model-zcode]').element, 'Prov A · m-1')

    expect(sessionApiMock.setSubagentEngineDefaultModel).not.toHaveBeenCalled()
  })
})

// ======================================================================
// ← extension-page-mandatory.test.ts
// ======================================================================

vi.mock('@/api', () => extensionApiModule())

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
function userExt_m2(): ExtensionItem {
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

let wrapper_m2: ReturnType<typeof mount> | null = null

// beforeEach 重置（pinia / mock 计数 / toast / transport 桩）单源在 helpers/extension-page-harness
setupExtensionPageTest()



/**
 * 定位某扩展名对应的「已安装项」根 div。
 * [w3b] 行根 = demo .srow 形态（min-h-[44px] 行范式，与 w2 设置行口径一致）；
 * 原 v6 卡片范式 class（flex items-center gap-3 rounded-card）已随形态更新退役，
 * 以 min-h-[44px] 子串选择器定位（行内无其他 min-h 消费点）。
 */
function findExtRow(root: ReturnType<typeof mount>, name: string) {
  const rows = root.findAll('div[class*="min-h-[44px]"]')
  return rows.find((r) => r.text().includes(name))
}

/** builtin 行共同断言：卸载/升级按钮隐藏 + autoUpgrade 文案不出现（开关行整体被 v-if 隐藏） */
function expectBuiltinRowHidesActions(row: NonNullable<ReturnType<typeof findExtRow>>): void {
  // 卸载/升级按钮隐藏（builtin 不可卸，由 runtime 自动升级）
  expect(row.findAll('button[title="卸载"]')).toHaveLength(0)
  expect(row.findAll('button[title="升级"]')).toHaveLength(0)
  // autoUpgrade 文案不应出现（开关行整体被 v-if 隐藏）
  expect(row.text()).not.toContain('自动升级')
}

describe('ExtensionPage 三层权限矩阵 UI', () => {
  it('infrastructure builtin 显示「内置」badge + 隐藏启用开关 + 隐藏卸载/升级/autoUpgrade', async () => {
    wrapper_m2 = mount(ExtensionPage, { props: { extensions: [infraBuiltinExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper_m2!, '@zhushanwen/pi-pending-notifications')
    expect(row).toBeTruthy()
    // badge 含「内置」
    expect(row!.text()).toContain('内置')
    // 启用开关隐藏（infrastructure 不可禁）
    expect(row!.findAll('button[role="switch"]')).toHaveLength(0)
    expectBuiltinRowHidesActions(row!)
  })

  it('feature builtin 显示「内置」badge + 显示启用开关（可禁）+ 隐藏卸载/升级/autoUpgrade', async () => {
    wrapper_m2 = mount(ExtensionPage, { props: { extensions: [featureBuiltinExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper_m2!, '@zhushanwen/pi-goal')
    expect(row).toBeTruthy()
    // badge 含「内置」
    expect(row!.text()).toContain('内置')
    // 启用开关可见（feature builtin 可禁，翻转原 mandatory 行为）
    expect(row!.findAll('button[role="switch"]')).toHaveLength(1)
    expectBuiltinRowHidesActions(row!)
  })

  it('user 扩展全部操作可见（禁/卸/升级/autoUpgrade）+ 无「内置」badge', async () => {
    wrapper_m2 = mount(ExtensionPage, { props: { extensions: [userExt_m2()] } })
    await flushPromises()
    const row = findExtRow(wrapper_m2!, 'my-tools')
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
    wrapper_m2 = mount(ExtensionPage, {
      props: { extensions: [infraBuiltinExt(), featureBuiltinExt(), userExt_m2()] },
    })
    await flushPromises()
    expect(findExtRow(wrapper_m2!, '@zhushanwen/pi-pending-notifications')).toBeTruthy()
    expect(findExtRow(wrapper_m2!, '@zhushanwen/pi-goal')).toBeTruthy()
    expect(findExtRow(wrapper_m2!, 'my-tools')).toBeTruthy()
  })

  it('推荐区为空时不渲染（recommended v-if=false）', async () => {
    // fetchRecommended 默认 resolve([]) → recommended.length === 0 → section 不渲染
    wrapper_m2 = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    expect(extensionApiMock.fetchRecommended).toHaveBeenCalled()
    // 推荐区标题「推荐扩展」不应出现在 DOM
    expect(wrapper_m2!.text()).not.toContain('推荐扩展')
  })

  it('按 layer 分两组渲染：builtin 系统强制组在前、user 用户安装组在后，扩展归入对应组', async () => {
    // 乱序传入：user 在前、builtin 在后，验证分组按 layer 归位而非输入顺序
    wrapper_m2 = mount(ExtensionPage, {
      props: { extensions: [userExt_m2(), infraBuiltinExt(), featureBuiltinExt()] },
    })
    await flushPromises()
    const builtinGroup = wrapper_m2!.find('[data-testid="extension-group-builtin"]')
    const userGroup = wrapper_m2!.find('[data-testid="extension-group-user"]')
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
    const html = wrapper_m2!.html()
    expect(html.indexOf('extension-group-builtin')).toBeLessThan(html.indexOf('extension-group-user'))
  })

  it('空组不渲染组头（整体隐藏）', async () => {
    // 只有 user 扩展 → builtin 组整体隐藏
    wrapper_m2 = mount(ExtensionPage, { props: { extensions: [userExt_m2()] } })
    await flushPromises()
    expect(wrapper_m2!.find('[data-testid="extension-group-builtin"]').exists()).toBe(false)
    expect(wrapper_m2!.find('[data-testid="extension-group-user"]').exists()).toBe(true)
    expect(wrapper_m2!.text()).not.toContain('系统强制')
  })
})

// 合并产物专用：两节各自注册 afterEach 时，先执行者清空 body 导致后执行者 unmount 已脱离 DOM
// 的节点（Cannot read properties of null (reading 'nextSibling')，首跑 37 例全红）。
// 收为单一 afterEach：两槽都卸载后再统一清 body。
afterEach(() => {
  // teardownExtensionPage 内部会清 body——两槽都先卸载，最后统一清一次（见上注释）
  wrapper?.unmount()
  wrapper = null
  wrapper_m2?.unmount()
  wrapper_m2 = null
  document.body.innerHTML = ''
})
