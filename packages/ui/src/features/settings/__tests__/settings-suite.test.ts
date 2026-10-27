import type { NormalizedQuotaRow } from '@taiji/shared';
import type { QuotaConfigureModule } from '@taiji/core';
import type { QuotaFailureKind } from '@taiji/core';
import type { QuotaTestStatus } from '@taiji/core';
import type { ReadinessMissing } from '@taiji/core';
import type { SystemSettings } from '@taiji/core';
import { applySystemToDom, resolveTheme } from '../apply-system-to-dom';
import CodingPlanSection from '../coding-plan/CodingPlanSection.vue';
import LoadPaths from '../common/LoadPaths.vue';
import CompatEditor from '../compat/CompatEditor.vue';
import { QUOTA_CONFIGURE_MODULE_KEY, SETTINGS_CHOOSE_DIRECTORY_KEY } from '../injection-keys';
import ProviderTestDiscoverSection from '../provider/ProviderTestDiscoverSection.vue';
import { QUOTA_SECRET_MASK } from '@taiji/core';
import { makeQuotaModuleStub } from '@taiji/core/testing';
import type { SkillDirConfig } from '@taiji/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← CompatEditor.test.ts
// ======================================================================

describe('CompatEditor', () => {
  it('essential 字段区默认渲染（api=openai-completions）', () => {
    const wrapper = mount(CompatEditor, {
      props: { api: 'openai-completions', modelValue: undefined },
    })
    // essential 分组标签 i18n key 渲染
    expect(wrapper.text()).toContain('settings.compat.essential')
    // essential 至少渲染一个 CompatField（thinkingFormat 等）
    expect(wrapper.findAllComponents({ name: 'CompatField' }).length).toBeGreaterThan(0)
  })

  it('advanced 区默认折叠，点击展开后渲染 advanced 字段', async () => {
    const wrapper = mount(CompatEditor, {
      props: { api: 'openai-completions', modelValue: undefined },
    })
    // 折叠态：advanced toggle 按钮存在，文案为「展开」语义 key
    const toggle = wrapper.find('button.text-accent')
    expect(toggle.exists()).toBe(true)
    // 展开前 advanced 字段不渲染（only essential CompatField）
    const beforeCount = wrapper.findAllComponents({ name: 'CompatField' }).length
    await toggle.trigger('click')
    // 展开后 CompatField 数量增加（advanced 字段加入）
    const afterCount = wrapper.findAllComponents({ name: 'CompatField' }).length
    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  it('清空按钮在已有 modelValue 时显示', () => {
    const wrapper = mount(CompatEditor, {
      props: { api: 'openai-completions', modelValue: { thinkingFormat: 'openai' } },
    })
    // 清空按钮 i18n key 存在
    expect(wrapper.text()).toContain('settings.compat.clearAll')
  })
})

// ======================================================================
// ← LoadPaths.test.ts
// ======================================================================

function makeDirs(): SkillDirConfig[] {
  return [
    { path: '~/projects/my-skills', enabled: true, scope: 'project' },
    { path: './.taiji/skills', enabled: false, scope: 'project' },
    { path: '~/work/shared-skills', enabled: true, scope: 'global' },
  ]
}

function mountLoadPaths(
  overrides: { dirs?: SkillDirConfig[]; chooseDirectory?: () => Promise<string | null> } = {},
) {
  return mount(LoadPaths, {
    props: {
      forcedDirs: ['~/.taiji/skills'],
      dirs: overrides.dirs ?? makeDirs(),
      kind: 'skill' as const,
    },
    global: {
      provide: {
        [SETTINGS_CHOOSE_DIRECTORY_KEY]:
          overrides.chooseDirectory ?? (async () => '/mock/selected'),
      },
    },
  })
}

describe('LoadPaths', () => {
  it('首屏冒烟：渲染两组 + ↑↓ 按钮 + forcedDirs 行', () => {
    const wrapper = mountLoadPaths()
    // ① 项目/全局两组 DOM 存在
    const groups = wrapper.findAll('[data-testid="dir-group"]')
    expect(groups.length).toBe(2)
    expect(wrapper.find('[data-testid="group-head-project"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="group-head-global"]').exists()).toBe(true)
    // ② ↑↓ 按钮存在
    expect(wrapper.find('[data-testid="move-up-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="move-down-btn"]').exists()).toBe(true)
    // ⑤ forcedDirs 行存在
    expect(wrapper.find('[data-testid="forced-dir-row"]').exists()).toBe(true)
  })

  it('Checkbox 未选态可见（全局 Checkbox.vue !border + border-strong 保证）', () => {
    const wrapper = mountLoadPaths()
    const checkbox = wrapper.find('button[role="checkbox"]')
    expect(checkbox.exists()).toBe(true)
    // 可见性修复在全局 Checkbox.vue：!border（绕过 renderer 全局 *{border-width:0} unlayered 覆盖）+ border-border-strong（demo .chk 未选边框档）
    const cls = checkbox.attributes('class') ?? ''
    expect(cls).toContain('!border')
    expect(cls).toContain('border-border-strong')
  })

  it('点击 ↓ 下移项目组首行后顺序变化（emit update-dirs）', async () => {
    const wrapper = mountLoadPaths({
      dirs: [
        { path: '/a', enabled: true, scope: 'project' },
        { path: '/b', enabled: true, scope: 'project' },
      ],
    })
    const moveDownBtns = wrapper.findAll('[data-testid="move-down-btn"]')
    // 项目组第一行的 ↓（enabled，非组末）
    await moveDownBtns[0].trigger('click')
    const emitted = wrapper.emitted('update-dirs')
    expect(emitted).toBeTruthy()
    const payload = (emitted![0] as [SkillDirConfig[]])[0]
    const projectOrder = payload.filter((d) => d.scope === 'project').map((d) => d.path)
    // a 与 b 交换
    expect(projectOrder).toEqual(['/b', '/a'])
  })

  it('点击 ↑ 上移项目组次行后顺序变化', async () => {
    const wrapper = mountLoadPaths({
      dirs: [
        { path: '/a', enabled: true, scope: 'project' },
        { path: '/b', enabled: true, scope: 'project' },
      ],
    })
    const moveUpBtns = wrapper.findAll('[data-testid="move-up-btn"]')
    // 项目组第二行的 ↑
    await moveUpBtns[1].trigger('click')
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    const projectOrder = payload.filter((d) => d.scope === 'project').map((d) => d.path)
    expect(projectOrder).toEqual(['/b', '/a'])
  })

  it('forcedDirs 在项目目录组顶部（forced-dir-row 出现在 dir-row 之前）', () => {
    const wrapper = mountLoadPaths()
    const projectGroup = wrapper.find('[data-scope="project"]')
    // 项目组内：forced 行先于用户目录行
    const forced = projectGroup.find('[data-testid="forced-dir-row"]')
    const userRow = projectGroup.find('[data-testid="dir-row"]')
    expect(forced.exists()).toBe(true)
    expect(userRow.exists()).toBe(true)
    expect(forced.element.compareDocumentPosition(userRow.element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('组首↑ 与 组末↓ disabled（边界行不可点）', () => {
    const wrapper = mountLoadPaths({
      dirs: [
        { path: '/a', enabled: true, scope: 'project' },
        { path: '/b', enabled: true, scope: 'project' },
      ],
    })
    const moveUpBtns = wrapper.findAll('[data-testid="move-up-btn"]')
    const moveDownBtns = wrapper.findAll('[data-testid="move-down-btn"]')
    // 项目组首行 ↑ disabled
    expect(moveUpBtns[0].attributes('disabled')).toBeDefined()
    // 项目组末行 ↓ disabled
    expect(moveDownBtns[1].attributes('disabled')).toBeDefined()
    // 非边界行 enabled
    expect(moveDownBtns[0].attributes('disabled')).toBeUndefined()
    expect(moveUpBtns[1].attributes('disabled')).toBeUndefined()
  })

  it('目录选择 dialog 选完后追加到对应组末尾', async () => {
    const chooseDirectory = vi.fn(async () => '/chosen/global/dir')
    const wrapper = mountLoadPaths({ chooseDirectory })
    await wrapper.find('[data-testid="choose-dir-btn-global"]').trigger('click')
    expect(chooseDirectory).toHaveBeenCalled()
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    const added = payload.find((d) => d.path === '/chosen/global/dir')
    expect(added).toEqual({ path: '/chosen/global/dir', enabled: true, scope: 'global' })
  })

  it('全局组手动添加限绝对路径（相对路径报格式错误，不 emit）', async () => {
    const wrapper = mountLoadPaths()
    const input = wrapper.find('[data-testid="new-path-input-global"]')
    await input.setValue('relative/path')
    await wrapper.find('[data-testid="add-path-btn-global"]').trigger('click')
    expect(wrapper.find('[data-testid="path-error-global"]').exists()).toBe(true)
    expect(wrapper.emitted('update-dirs')).toBeFalsy()
  })

  it('项目组手动添加允许相对路径', async () => {
    const wrapper = mountLoadPaths()
    const input = wrapper.find('[data-testid="new-path-input-project"]')
    await input.setValue('.agents/skills')
    await wrapper.find('[data-testid="add-path-btn-project"]').trigger('click')
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    expect(payload.some((d) => d.path === '.agents/skills' && d.scope === 'project')).toBe(true)
  })

  it('Checkbox 勾选触发 update-dirs 且仅改对应行 enabled', async () => {
    const wrapper = mountLoadPaths()
    // 定位用户目录行（非 forced）的 Checkbox
    const userCheckbox = wrapper.find('[data-testid="dir-row"] button[role="checkbox"]')
    expect(userCheckbox.exists()).toBe(true)
    await userCheckbox.trigger('click')
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    expect(payload.some((d) => typeof d.enabled === 'boolean')).toBe(true)
  })

  // ── RD-4#1 保存失败回弹：saveError 置位 → localDirs 回弹至最近落盘值（props.dirs）+ 常驻红字 ──
  describe('saveError 保存失败常驻态（RD-4#1）', () => {
    const persistedDirs = (): SkillDirConfig[] => [
      { path: '/persisted/dir', enabled: false, scope: 'global' },
    ]

    it('saveError 置位 → 乐观编辑回弹至 props.dirs（最近落盘值）+ 常驻红字出现', async () => {
      const wrapper = mountLoadPaths({ dirs: persistedDirs() })
      // 用户勾选（LoadPaths 乐观编辑，emit 后父组件持久化）
      const checkbox = wrapper.find('[data-testid="dir-row"] button[role="checkbox"]')
      await checkbox.trigger('click')
      expect(wrapper.emitted('update-dirs')).toBeTruthy()
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(false)

      // 父组件保存失败 → 置位 saveError
      await wrapper.setProps({ saveError: true })

      // 常驻红字（toast 之外的非瞬态失败标注）
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(true)
      // 回弹：勾选态回到最近落盘值（unchecked）
      expect(checkbox.attributes('data-state')).toBe('unchecked')
    })

    it('saveError 复位（下次保存尝试起点）→ 常驻红字消失，后续编辑不受影响', async () => {
      const wrapper = mountLoadPaths({ dirs: persistedDirs() })
      await wrapper.setProps({ saveError: true })
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(true)

      await wrapper.setProps({ saveError: false })
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(false)

      // 复位后仍可正常编辑 + emit
      const checkbox = wrapper.find('[data-testid="dir-row"] button[role="checkbox"]')
      await checkbox.trigger('click')
      expect(wrapper.emitted('update-dirs')).toBeTruthy()
    })
  })
})

// ======================================================================
// ← apply-system-to-dom.test.ts
// ======================================================================

function makeSystem(over: Partial<SystemSettings> = {}): SystemSettings {
  return {
    locale: 'zh-CN',
    theme: 'dark',
    themePreset: '',
    fontSize: 'medium',
    ...over,
  } as SystemSettings
}

describe('applySystemToDom', () => {
  let setAttribute: ReturnType<typeof vi.fn>
  let matchMediaMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setAttribute = vi.fn()
    matchMediaMock = vi.fn()
    // happy-dom 提供 document.documentElement
    vi.stubGlobal('document', {
      ...((globalThis as any).document ?? {}),
      documentElement: { setAttribute, dataset: {} as Record<string, string> },
    })
    vi.stubGlobal('window', { matchMedia: matchMediaMock })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('theme=light 直写 data-theme=light', () => {
    applySystemToDom(makeSystem({ theme: 'light' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'light')
  })

  it('theme=dark 直写 data-theme=dark', () => {
    applySystemToDom(makeSystem({ theme: 'dark' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
  })

  it('theme=system + matchMedia matches=true → data-theme=light', () => {
    matchMediaMock.mockReturnValue({ matches: true })
    applySystemToDom(makeSystem({ theme: 'system' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'light')
  })

  it('theme=system + matchMedia matches=false → data-theme=dark', () => {
    matchMediaMock.mockReturnValue({ matches: false })
    applySystemToDom(makeSystem({ theme: 'system' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
  })

  it('themePreset 写 data-theme-preset，缺省空串', () => {
    applySystemToDom(makeSystem({ themePreset: 'warm-amber' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme-preset', 'warm-amber')
  })

  it('themePreset 缺省回落空串', () => {
    applySystemToDom(makeSystem({ themePreset: undefined }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme-preset', '')
  })

  it('fontSize 写 dataset.fontSize，缺省 medium', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontSize: 'large' }))
    expect(doc.documentElement.dataset.fontSize).toBe('large')
  })

  it('fontSize 缺省回落 medium', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontSize: undefined }))
    expect(doc.documentElement.dataset.fontSize).toBe('medium')
  })

  it('fontScales 写 data-fs-* dataset，逐区域独立档位', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontScales: { sidebar: 'small', chat: 'xlarge', drawer: 'large' } }))
    expect(doc.documentElement.dataset.fsSidebar).toBe('small')
    expect(doc.documentElement.dataset.fsChat).toBe('xlarge')
    expect(doc.documentElement.dataset.fsDrawer).toBe('large')
  })

  it('fontScales 缺省/部分缺省 → 逐区域回落 DEFAULT_FONT_SCALES（sidebar=medium，chat=small，drawer=medium）', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontScales: { chat: 'large' } }))
    expect(doc.documentElement.dataset.fsSidebar).toBe('medium') // 默认标准（对齐 main bc16c0e10：sidebar 默认 medium）
    expect(doc.documentElement.dataset.fsChat).toBe('large')
    expect(doc.documentElement.dataset.fsDrawer).toBe('medium')
    applySystemToDom(makeSystem())
    expect(doc.documentElement.dataset.fsSidebar).toBe('medium')
    expect(doc.documentElement.dataset.fsChat).toBe('small') // chat-font-default-small：chat 默认小档
    expect(doc.documentElement.dataset.fsDrawer).toBe('medium')
  })

  it('locale 非空 + deps.setLocale 存在 → 调用 setLocale', () => {
    const setLocale = vi.fn()
    applySystemToDom(makeSystem({ locale: 'en-US' }), { setLocale })
    expect(setLocale).toHaveBeenCalledWith('en-US')
  })

  it('无 deps.setLocale → 不抛错（locale 不切换）', () => {
    expect(() => applySystemToDom(makeSystem({ locale: 'en-US' }))).not.toThrow()
  })

  it('resolveTheme 纯函数：system 无 window.matchMedia → dark 兜底', () => {
    vi.stubGlobal('window', {}) // 无 matchMedia
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })
})

// ======================================================================
// ← coding-plan-section.test.ts
// ======================================================================

/** 三窗口 fixture：5h 带绝对量（requests）、周仅 pct、月 ∞（pct=null 隐藏） */
const ROW_WITH_ABS: NormalizedQuotaRow = {
  label: 'Kimi Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: 41, used: null, limit: null, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

let wrapper: ReturnType<typeof mount> | null = null
/** 当前用例的 module 桩（写动作断言经它） */
let quota: QuotaConfigureModule

beforeEach(() => {
  vi.clearAllMocks()
  quota = makeQuotaModuleStub({ state: 'ready' })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/**
 * mount CodingPlanSection（module 实例经注入 seam 提供；attachTo 供 portal 查询）。
 * 默认桩态 = 「已选 api-key 类类型且齐备」的常规态；各用例先改 quota 再 mount。
 */
function mountSection(): ReturnType<typeof mount> {
  return mount(CodingPlanSection, {
    global: {
      provide: {
        [QUOTA_CONFIGURE_MODULE_KEY]: quota,
      },
    },
    attachTo: document.body,
  })
}

/**
 * 布置失败态（test 透镜）：分档 + cookie 形态 + 兜底消息。
 * opts.form 供 cookie 类失败场景顺带布置 view.credential.form（两态高频成对出现）。
 */
function arrangeFailure(kind: QuotaFailureKind, opts: { cookieAuth?: boolean; message?: string; status?: QuotaTestStatus; form?: 'cookie' } = {}): void {
  quota.test.value.status = opts.status ?? 'error'
  quota.test.value.failure = { kind, cookieAuth: opts.cookieAuth ?? false, message: opts.message ?? '' }
  if (opts.form) quota.view.value.credential.form = opts.form
}

/** 布置「未选类型 / preset 未命中」态：readiness 恒 missing ['type']（module 派生契约，两分支 UI 同形态 §7.2） */
function arrangeTypeUndetermined(selected: string | undefined): void {
  quota.view.value.type.selected = selected
  quota.view.value.type.undetermined = true
  quota.view.value.readiness = { ready: false, missing: ['type'] }
}

/** 布置 cookie 类（mimo）+ 指定 missing 键的齐备性态 */
function arrangeCookieMissing(missing: ReadinessMissing[]): void {
  quota.view.value.credential.form = 'cookie'
  quota.view.value.type.selected = 'mimo'
  quota.view.value.readiness = { ready: false, missing }
}

/** 布置 cookie 类（opencode-go 资源维度类型）+ workspace 必填 + 指定 missing 键 */
function arrangeCookieWorkspaceMissing(missing: ReadinessMissing[]): void {
  quota.view.value.credential.form = 'cookie'
  quota.view.value.type.selected = 'opencode-go'
  quota.view.value.workspace.required = true
  quota.view.value.readiness = { ready: false, missing }
}

/** 布置专属 Key 失效态：草稿来源 exclusive + Key 空 + minimax，readiness 报 missing ['apiKey']（typeChanged 归属失效） */
function arrangeExclusiveKeyInvalid(): void {
  quota.draft.value.credentialSource = 'exclusive'
  quota.draft.value.apiKey = ''
  quota.view.value.type.selected = 'minimax'
  quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
}

/** 断言三键字段级提示（cookie / apiKey / workspace）均不渲染（'type' 在 §7.4 白名单外，结构性无文案） */
function expectNoFieldHints(w: ReturnType<typeof mount>): void {
  expect(w.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
  expect(w.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
  expect(w.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
}

/** 断言未选类型态的首屏说明：类型下拉仍在 + quotaTypeFirstHint 一句文案（D8 与探针③同形态） */
function expectNoTypeHint(w: ReturnType<typeof mount>): void {
  expect(w.find('[data-testid="quota-type-select"]').exists()).toBe(true)
  const hint = w.find('[data-testid="quota-no-type-hint"]')
  expect(hint.exists()).toBe(true)
  expect(hint.text()).toContain('settings.providerEdit.quotaTypeFirstHint')
}

/** 单按钮（唯一主动作） */
const SAVE_TEST = '[data-testid="quota-save-test-btn"]'

// ══ ① D8：未选类型态 ═══════════════════════════════════════════════════════

describe('① D8 未选类型态：只渲染下拉 + 一句说明', () => {
  it('type.undetermined → 渲染类型下拉与 quotaTypeFirstHint，且不渲染开关/凭证区/按钮/结果块', async () => {
    // 契约里未选类型的 readiness 恒为 { ready:false, missing:['type'] }（module 派生）
    arrangeTypeUndetermined(undefined)
    wrapper = mountSection()
    await flushPromises()

    // 用户可见：下拉仍在（区块对所有 provider 显示）+ 说明文案
    expectNoTypeHint(wrapper)

    // 观察者：参数区 / 动作区 / 结果区整体缺席（D8 的「不渲染」）
    expect(wrapper.find('[data-testid="quota-enabled-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-cookie-block"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-workspace-block"]').exists()).toBe(false)
    expect(wrapper.find(SAVE_TEST).exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-error"]').exists()).toBe(false)
  })

  it('未选类型时 missing=["type"] 不产生字段级提示（白名单三键之外无文案，§7.4）', async () => {
    arrangeTypeUndetermined(undefined)
    wrapper = mountSection()
    await flushPromises()

    expectNoFieldHints(wrapper)
  })
})

// ══ ② D1：单按钮置灰矩阵 + 字段级提示 ═══════════════════════════════════════

describe('② D1 齐备性门控：唯一按钮「保存并测试」的置灰矩阵', () => {
  it('readiness.ready=false → 按钮 disabled 且渲染 quotaReadyHint 旁注', async () => {
    quota.view.value.readiness = { ready: false, missing: ['cookie'] }
    quota.view.value.credential.form = 'cookie'
    wrapper = mountSection()
    await flushPromises()

    const btn = wrapper.find<HTMLButtonElement>(SAVE_TEST)
    expect(btn.exists()).toBe(true)
    expect(btn.element.disabled).toBe(true)
    expect(btn.text()).toContain('settings.providerEdit.quotaSaveAndTest')
    expect(wrapper.find('[data-testid="quota-ready-hint"]').text()).toContain(
      'settings.providerEdit.quotaReadyHint',
    )
  })

  it('readiness.ready=true → 按钮可点且不渲染置灰旁注（两个态同一个按钮，动作合一）', async () => {
    quota.view.value.credential.form = 'cookie'
    wrapper = mountSection()
    await flushPromises()

    const btn = wrapper.find<HTMLButtonElement>(SAVE_TEST)
    expect(btn.element.disabled).toBe(false)
    expect(wrapper.find('[data-testid="quota-ready-hint"]').exists()).toBe(false)
  })

  it('configuring=true → 按钮禁用且文案切 quotaSaveAndTestRunning（进行中不可重复提交）', async () => {
    quota.view.value.configuring = true
    wrapper = mountSection()
    await flushPromises()

    const btn = wrapper.find<HTMLButtonElement>(SAVE_TEST)
    expect(btn.element.disabled).toBe(true)
    expect(btn.text()).toContain('settings.providerEdit.quotaSaveAndTestRunning')
  })

  it('missing=["cookie"]（cookie 类）→ 字段下方渲染 quotaMissingCookie 提示', async () => {
    arrangeCookieMissing(['cookie'])
    wrapper = mountSection()
    await flushPromises()

    const hint = wrapper.find('[data-testid="quota-missing-cookie"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingCookie')
    // 逐键显式：其余两键不渲染
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
  })

  it('missing=["apiKey"]（来源=专属 Key）→ 专属 Key 输入下方渲染 quotaMissingApiKey 提示', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
    const hint = wrapper.find('[data-testid="quota-missing-apikey"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingApiKey')
    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
  })

  it('missing=["workspace"]（资源维度类型）→ workspace 输入下方渲染 quotaMissingWorkspace 提示', async () => {
    arrangeCookieWorkspaceMissing(['workspace'])
    wrapper = mountSection()
    await flushPromises()

    const hint = wrapper.find('[data-testid="quota-missing-workspace"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingWorkspace')
  })

  it('missing 同时含多键 → 逐键各渲染自己的提示（不写兜底循环，§7.4 显式白名单）', async () => {
    arrangeCookieWorkspaceMissing(['cookie', 'workspace'])
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-missing-cookie"]').text()).toBe(
      'settings.providerEdit.quotaMissingCookie',
    )
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').text()).toBe(
      'settings.providerEdit.quotaMissingWorkspace',
    )
  })

  it("missing 含 'type'（preset 未命中）→ 走 D8 同形态：三键提示与参数区按钮全不渲染（'type' 结构性无文案）", async () => {
    // 草稿有值但不在预设表（历史数据 / 手工编辑 providers.json）是「有值 + missing=['type']」的
    // 唯一可达来源；readiness 该分支与「未选类型」同形态（§7.2），UI 必须同样收起到下拉 + 说明。
    arrangeTypeUndetermined('legacy-unknown')
    wrapper = mountSection()
    await flushPromises()

    expectNoFieldHints(wrapper)
    // 参数区整体不渲染（类型未定不展示永远无法生效的控件，D8），故没有「保存并测试」按钮
    expect(wrapper.find(SAVE_TEST).exists()).toBe(false)
  })
})

// ══ ③ D3：凭证来源分段控件 ═══════════════════════════════════════════════════

describe('③ D3 凭证来源分段控件（api-key 类专用）', () => {
  it('providerAvailable=true → provider 项可点；exclusive 项也可点', async () => {
    wrapper = mountSection()
    await flushPromises()

    const providerBtn = wrapper.find<HTMLButtonElement>('[data-testid="quota-source-provider-btn"]')
    const exclusiveBtn = wrapper.find<HTMLButtonElement>('[data-testid="quota-source-exclusive-btn"]')
    expect(providerBtn.exists()).toBe(true)
    expect(providerBtn.element.disabled).toBe(false)
    expect(exclusiveBtn.element.disabled).toBe(false)
    // 语义标签
    expect(providerBtn.text()).toContain('settings.providerEdit.quotaSourceProvider')
    expect(exclusiveBtn.text()).toContain('settings.providerEdit.quotaSourceExclusive')
  })

  it('providerAvailable=false → provider 项置 disabled（无可用凭据不能选它），exclusive 项仍可点', async () => {
    quota.view.value.credential.providerAvailable = false
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
    wrapper = mountSection()
    await flushPromises()

    const providerBtn = wrapper.find<HTMLButtonElement>('[data-testid="quota-source-provider-btn"]')
    expect(providerBtn.element.disabled).toBe(true)
    expect(
      wrapper.find<HTMLButtonElement>('[data-testid="quota-source-exclusive-btn"]').element.disabled,
    ).toBe(false)
  })

  it('点 exclusive 项 → 草稿来源写为 exclusive；选中态渲染专属 Key 输入块 + 来源说明', async () => {
    wrapper = mountSection()
    await flushPromises()

    // 未选 exclusive 时不渲染专属 Key 输入块
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)

    await wrapper.find('[data-testid="quota-source-exclusive-btn"]').trigger('click')
    // 写动作回写草稿（D3：随 saveAndTest 落盘）
    expect(quota.draft.value.credentialSource).toBe('exclusive')

    // 父组件回流后（credentialSource='exclusive'）渲染专属 Key 块 + 来源说明
    wrapper.unmount()
    quota.draft.value.credentialSource = 'exclusive'
    quota.view.value.credential.sourceHint = 'exclusive'
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-source-hint"]').text()).toBe(
      'settings.providerEdit.quotaSourceExclusiveHint',
    )
  })

  it('点 provider 项（可用时）→ 草稿来源写为 provider；aria-pressed 表达当前选择', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    wrapper = mountSection()
    await flushPromises()

    const providerBtn = wrapper.find('[data-testid="quota-source-provider-btn"]')
    expect(providerBtn.attributes('aria-pressed')).toBe('false')
    await providerBtn.trigger('click')
    expect(quota.draft.value.credentialSource).toBe('provider')
  })

  it('来源说明按 module 分档渲染：providerOauth → OAuth 文案；providerApiKey → API Key 文案', async () => {
    quota.view.value.credential.sourceHint = 'providerOauth'
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-source-hint"]').text()).toBe(
      'settings.providerEdit.quotaSourceProviderOauthHint',
    )

    wrapper.unmount()
    quota.view.value.credential.sourceHint = 'providerApiKey'
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-source-hint"]').text()).toBe(
      'settings.providerEdit.quotaSourceProviderApiKeyHint',
    )
  })

  it('cookie 类不渲染分段控件（来源只对 api-key 类有意义）', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-cookie-block"]').exists()).toBe(true)
  })

  it('⑤d exclusiveApplicable=false（如 auth=[oauth]）→ 分段控件与专属 Key 块都不渲染（§7 残留 11）', async () => {
    // UI 不得显示 runtime 不会采用的选项：auth=['oauth'] 时 runtime 的 resolveCredential
    // 不收窄 exclusive（supportsExclusiveCredential=false），module 判定同源，UI 只管渲染。
    quota.view.value.credential.exclusiveApplicable = false
    quota.draft.value.credentialSource = 'exclusive'
    quota.view.value.type.selected = 'oauth-only'
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)
    // 只隐藏不适用控件，参数区其余部分仍在（不是整块不渲染）
    expect(wrapper.find('[data-testid="quota-enabled-switch"]').exists()).toBe(true)
  })

  it('⑤d exclusiveApplicable=true → 分段控件仍渲染（防回归：门控不得藏掉 api-key 类）', async () => {
    quota.view.value.type.selected = 'zhipu'
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(true)

    wrapper.unmount()
    quota.view.value.type.selected = 'kimi-coding'
    quota.draft.value.credentialSource = 'exclusive'
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
  })
})

// ══ ④ §7.4：Provider 凭据不可用的两套文案 ═══════════════════════════════════

describe('④ §7.4 跨区块时序：provider 凭据不可用的两套文案', () => {
  it("providerWarning='missing'（草稿也空）→ 「还没有可用的 API Key，请先填写，或改用专属 Key」", async () => {
    quota.draft.value.credentialSource = 'provider'
    quota.view.value.credential.providerAvailable = false
    quota.view.value.credential.providerWarning = 'missing'
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
    wrapper = mountSection()
    await flushPromises()

    const warn = wrapper.find('[data-testid="quota-provider-credential-warning"]')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toBe('settings.providerEdit.quotaProviderCredentialMissing')
  })

  it("providerWarning='pendingSave'（表单已填但未保存 provider）→ 「已填写 API Key，保存 provider 配置后即可查询」", async () => {
    quota.draft.value.credentialSource = 'provider'
    quota.view.value.credential.providerAvailable = false
    quota.view.value.credential.providerWarning = 'pendingSave'
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
    wrapper = mountSection()
    await flushPromises()

    const warn = wrapper.find('[data-testid="quota-provider-credential-warning"]')
    expect(warn.text()).toBe('settings.providerEdit.quotaProviderCredentialPendingSave')
    // 两套文案必须不同（这条断言即「按钮灰但屏幕上明明填了 Key」矛盾的消除证据）
    expect(warn.text()).not.toBe('settings.providerEdit.quotaProviderCredentialMissing')
  })

  it('providerWarning=null → 不渲染该警告（有凭据时无话可说）', async () => {
    quota.draft.value.credentialSource = 'provider'
    quota.view.value.credential.providerAvailable = true
    quota.view.value.credential.providerWarning = null
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-provider-credential-warning"]').exists()).toBe(false)
  })

  it('来源=exclusive 时不渲染 provider 警告（改走专属 Key 提示）', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    quota.view.value.credential.providerAvailable = false
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-provider-credential-warning"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(true)
  })
})

// ══ ⑤ D7：掩码哨兵（已保存密文显示 QUOTA_SECRET_MASK） ══════════════════════

describe('⑤ D7 掩码哨兵：已保存密文显示 QUOTA_SECRET_MASK，「已配置」是独立标记', () => {
  it('cookie 已配置 → 输入框显示掩码哨兵（非空非密文），旁边标 quotaConfiguredBadge', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    quota.draft.value.cookie = QUOTA_SECRET_MASK
    wrapper = mountSection()
    await flushPromises()

    const input = wrapper.find<HTMLTextAreaElement>('[data-testid="quota-cookie-input"]')
    expect(input.element.value).toBe(QUOTA_SECRET_MASK)
    // 独立标记：「已配置」（不靠输入框内容表达）
    expect(wrapper.find('[data-testid="quota-cookie-block"]').text()).toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
  })

  it('cookie 未配置 → 标 quotaRequiredBadge（必填），与「已配置」互斥', async () => {
    arrangeCookieMissing(['cookie'])
    wrapper = mountSection()
    await flushPromises()

    const block = wrapper.find('[data-testid="quota-cookie-block"]').text()
    expect(block).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(block).not.toContain('settings.providerEdit.quotaConfiguredBadge')
  })

  it('专属 Key 已配置 → 输入框显示掩码哨兵（非空非密文）', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    quota.draft.value.apiKey = QUOTA_SECRET_MASK
    wrapper = mountSection()
    await flushPromises()

    const input = wrapper.find<HTMLInputElement>('[data-testid="quota-apikey-input"]')
    expect(input.element.value).toBe(QUOTA_SECRET_MASK)
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').text()).toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
  })

  it('专属 Key 掩码哨兵聚焦 → 全选（粘贴即覆盖）；真实输入聚焦不劫持选区', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    quota.draft.value.apiKey = QUOTA_SECRET_MASK
    wrapper = mountSection()
    await flushPromises()

    const input = wrapper.find<HTMLInputElement>('[data-testid="quota-apikey-input"]')
    await input.trigger('focus')
    expect(input.element.selectionStart).toBe(0)
    expect(input.element.selectionEnd).toBe(QUOTA_SECRET_MASK.length)

    quota.draft.value.apiKey = 'user-input'
    await flushPromises()
    // 先清选区再聚焦：断言 handler 未触发全选（若误触发，selectionEnd 会变成掩码长度）
    input.element.setSelectionRange(0, 0)
    await input.trigger('focus')
    expect(input.element.selectionEnd).toBe(0)
  })

  it('掩码哨兵聚焦 → 全选（粘贴即覆盖）；真实输入聚焦不劫持选区', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    quota.draft.value.cookie = QUOTA_SECRET_MASK
    wrapper = mountSection()
    await flushPromises()

    const input = wrapper.find<HTMLTextAreaElement>('[data-testid="quota-cookie-input"]')
    await input.trigger('focus')
    expect(input.element.selectionStart).toBe(0)
    expect(input.element.selectionEnd).toBe(QUOTA_SECRET_MASK.length)

    quota.draft.value.cookie = 'user-input'
    await flushPromises()
    // 先清选区再聚焦：断言 handler 未触发全选（若误触发，selectionEnd 会变成掩码长度）
    input.element.setSelectionRange(0, 0)
    await input.trigger('focus')
    expect(input.element.selectionEnd).toBe(0)
  })

  it('用户输入草稿 → 渲染的 value 即草稿原文（屏幕即真相）', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    quota.draft.value.cookie = 'raw-cookie-value'
    wrapper = mountSection()
    await flushPromises()

    expect(
      wrapper.find<HTMLTextAreaElement>('[data-testid="quota-cookie-input"]').element.value,
    ).toBe('raw-cookie-value')
  })
})

// ══ ⑤b §7.4：徽标与 readiness 同源（反向用例） ══════════════════════════════

describe('⑤b §7.4 徽标取值与 readiness 同源（磁盘标记不参与，徽标只认 readiness）', () => {
  it('反向：missing 含 cookie（类型切换后归属失效）→ 徽标「必填」，与字段提示同屏一致', async () => {
    // 复现 D5 的核心场景：已保存 MiMo cookie，用户把类型改成 opencode-go（同为 cookie 类）后
    // 旧 cookie 归属失效 → readiness 报 ['cookie']。徽标唯一来源是 readiness.missing；若改回读
    // 磁盘标记就会与下方「这里必须填」提示同屏矛盾（S7 反例）。
    arrangeCookieWorkspaceMissing(['cookie', 'workspace'])
    wrapper = mountSection()
    await flushPromises()

    const cookieBlock = wrapper.find('[data-testid="quota-cookie-block"]')
    // 用户可见：徽标文本必须与字段级提示同一判定（都来自 readiness.missing）
    expect(cookieBlock.text()).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(cookieBlock.text()).not.toContain('settings.providerEdit.quotaConfiguredBadge')
    expect(wrapper.find('[data-testid="quota-missing-cookie"]').text()).toBe(
      'settings.providerEdit.quotaMissingCookie',
    )
  })

  it('反向：missing 含 apiKey（类型切换后旧专属 Key 失效）→ 徽标「必填」', async () => {
    arrangeExclusiveKeyInvalid()
    wrapper = mountSection()
    await flushPromises()

    const keyBlock = wrapper.find('[data-testid="quota-exclusive-key-block"]')
    expect(keyBlock.text()).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(keyBlock.text()).not.toContain('settings.providerEdit.quotaConfiguredBadge')
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').text()).toBe(
      'settings.providerEdit.quotaMissingApiKey',
    )
  })

  it('反向：missing 含 workspace（草稿被清空）→ 徽标「必填」（D13 屏幕即真相）', async () => {
    arrangeCookieWorkspaceMissing(['workspace'])
    quota.draft.value.workspace = ''
    wrapper = mountSection()
    await flushPromises()

    const wsBlock = wrapper.find('[data-testid="quota-workspace-block"]')
    expect(wsBlock.text()).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(wsBlock.text()).not.toContain('settings.providerEdit.quotaConfiguredBadge')
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').text()).toBe(
      'settings.providerEdit.quotaMissingWorkspace',
    )
  })
})

// ══ ⑤c 定向复审探针（三条复现路径转正为回归检查） ═════════════════════════════

describe('⑤c 定向复审探针：三条复现路径的真实 DOM 锁定', () => {
  it('探针①：类型已变（D5 旧专属 Key 归属失效）+ 草稿空 → 字段块内无任何「已配置」语义（徽标与占位）', async () => {
    // 磁盘仍有旧专属 Key，readiness 因 typeChanged 判定该归属失效
    arrangeExclusiveKeyInvalid()
    wrapper = mountSection()
    await flushPromises()

    const block = wrapper.find('[data-testid="quota-exclusive-key-block"]')
    expect(block.exists()).toBe(true)
    // 徽标：必填（与 readiness 同源），不得出现「已配置」
    expect(block.text()).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(block.text()).not.toContain('settings.providerEdit.quotaConfiguredBadge')
    // 占位：粘贴 Key 指引，不得出现「已配置，输入新值可覆盖」
    const placeholder = wrapper
      .find('[data-testid="quota-apikey-input"]')
      .attributes('placeholder')
    expect(placeholder).toBe('settings.providerEdit.quotaExclusiveKeyPlaceholder')
    // 字段级提示同屏一致（三者同一判定，不再有「必填 + 已配置」矛盾）
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').text()).toBe(
      'settings.providerEdit.quotaMissingApiKey',
    )
  })

  it('探针②：preset 未命中 + exclusive + 磁盘无 Key → 不出现「已配置」徽标（未判定不得被读成已配置）', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    quota.draft.value.apiKey = ''
    arrangeTypeUndetermined('legacy-unknown')
    wrapper = mountSection()
    await flushPromises()

    // 类型未定 ⇒ 专属 Key 块整体不渲染；整区块文本不得含「已配置」
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="coding-plan-section"]').text()).not.toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
  })

  it('探针③：preset 未命中 → 渲染「重选类型」指引，且参数区不渲染（与 D8 同形态）', async () => {
    arrangeTypeUndetermined('legacy-unknown')
    wrapper = mountSection()
    await flushPromises()

    expectNoTypeHint(wrapper)
    // 参数区（开关 / 凭证区 / 动作区）整体不渲染
    expect(wrapper.find('[data-testid="quota-enabled-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(false)
    expect(wrapper.find(SAVE_TEST).exists()).toBe(false)
  })
})

// ══ ⑥ §5.2：失败态文案与 cookie 变体 ═══════════════════════════════════════

describe('⑥ §5.2 失败路径文案（module 归一分档 + cookie 变体）', () => {
  it('unauthorized + api-key 类 → quotaFetchFailUnauthorized（给「发起一次对话刷新」动作）', async () => {
    arrangeFailure('unauthorized', { cookieAuth: false })
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailUnauthorized')
    // 区分断言：不出现 cookie 变体
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
  })

  it('unauthorized + cookie 类 → quotaFetchFailUnauthorizedCookie（改指「重新复制 Cookie」）', async () => {
    arrangeFailure('unauthorized', { cookieAuth: true, form: 'cookie' })
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
  })

  it('cookie-invalid-format → quotaFetchFailCookieInvalidFormat（与「凭证失效」分流，不混 unauthorized 文案）', async () => {
    arrangeFailure('cookie-invalid-format', { cookieAuth: true, form: 'cookie' })
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailCookieInvalidFormat')
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
  })

  it('no-credential + api-key 类 → quotaFetchFailNoCredential（指向两个可填位置）', async () => {
    arrangeFailure('no-credential', { cookieAuth: false })
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailNoCredential')
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailNoCredentialCookie')
  })

  it('no-credential + cookie 类 → quotaFetchFailNoCredentialCookie（重贴 Cookie，非填 API Key）', async () => {
    arrangeFailure('no-credential', { cookieAuth: true, form: 'cookie' })
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNoCredentialCookie',
    )
    // cookie 类失败态提供「更新 Cookie」快捷入口（清空草稿重贴）
    expect(wrapper.find('[data-testid="quota-update-cookie-btn"]').exists()).toBe(true)
  })

  it('no-subscription + cookie 类 → 既有两可文案（Cookie 变体先例，S5）', async () => {
    arrangeFailure('no-subscription', { cookieAuth: true, form: 'cookie' })
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailNoSubscriptionCookie')
  })

  it('no-subscription + api-key 类 → 非 cookie 文案（与 cookie 变体可区分）', async () => {
    arrangeFailure('no-subscription', { cookieAuth: false })
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailNoSubscription')
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailNoSubscriptionCookie')
  })

  it('network / parse / not-configured → 各自专属文案（逐键断言，不回退通用文案）', async () => {
    arrangeFailure('network')
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNetwork',
    )

    wrapper.unmount()
    arrangeFailure('parse')
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailParse',
    )

    wrapper.unmount()
    arrangeFailure('not-configured')
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNotConfigured',
    )
  })

  it('generic 分档 → 回退 module 兜底消息；无旧数据时不渲染「查看上次成功数据」入口', async () => {
    arrangeFailure('generic', { message: 'boom' })
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain('boom')
    expect(wrapper.find('[data-testid="quota-toggle-last-success"]').exists()).toBe(false)
  })
})

// ══ ⑦ D2：单按钮触发 saveAndTest ═══════════════════════════════════════════

describe('⑦ D2 保存与测试合一：点击单按钮触发 module saveAndTest', () => {
  it('齐备时点击 quota-save-test-btn → saveAndTest 一次（无独立保存/测试按钮）', async () => {
    wrapper = mountSection()
    await flushPromises()

    await wrapper.find(SAVE_TEST).trigger('click')
    expect(quota.saveAndTest).toHaveBeenCalledTimes(1)
    // 合四为一：四个旧按钮 testid 全部不存在
    expect(wrapper.find('[data-testid="quota-save-apikey-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-save-cookie-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-save-workspace-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-test-btn"]').exists()).toBe(false)
  })
})

// ══ 附带保留：B-3 双轨窗口 + 失败态折叠 + workspace 块 ═══════════════════════

describe('B-3 额度显示双轨（used/limit + pct）', () => {
  it('成功态窗口行显示千分位绝对量 + pct 双轨', async () => {
    quota.test.value.status = 'success'
    quota.test.value.row = ROW_WITH_ABS
    quota.test.value.lastFetchAt = Date.now() - 60_000
    wrapper = mountSection()
    await flushPromises()

    const windows = wrapper.find('[data-testid="quota-result-windows"]')
    expect(windows.exists()).toBe(true)
    const text = windows.text()
    expect(text).toContain('settings.providerEdit.quotaUsedOf')
    expect(text).toContain('1,204')
    expect(text).toContain('5,000')
    expect(text).toContain('settings.providerEdit.quotaUnitRequests')
    expect(text).toContain('24%')
    expect(text).toContain('41%')
  })

  it('无绝对量数据 → 维持 pct 单值不显示 used-of', async () => {
    quota.test.value.status = 'success'
    quota.test.value.row = {
      label: 'Zhipu Plan',
      wins: [
        { pct: 55, resetSec: 100 },
        { pct: null, resetSec: null },
        { pct: null, resetSec: null },
      ],
    }
    wrapper = mountSection()
    await flushPromises()

    const windows = wrapper.find('[data-testid="quota-result-windows"]')
    expect(windows.text()).toContain('55%')
    expect(windows.text()).not.toContain('quotaUsedOf')
  })

  it('pct 展示口径 = 2 位小数，与指标聚合页同一 SSOT（formatQuotaPct）', async () => {
    // [HISTORICAL] 回归锚：本组件原用 `Math.round(win.pct)`（0 位小数），与 ContextCapacityCard
    // 的原样插值不同口径——同一窗口在设置页显 3%、指标页显 2.9499999999999997%。
    quota.test.value.status = 'success'
    quota.test.value.row = {
      label: 'OpenDesign Plan',
      wins: [
        { pct: 0.148, resetSec: 10680 },
        { pct: 2.9499999999999997, resetSec: 10680 },
        { pct: null, resetSec: null },
      ],
    }
    wrapper = mountSection()
    await flushPromises()

    const text = wrapper.find('[data-testid="quota-result-windows"]').text()
    expect(text).toContain('0.15%')
    expect(text).toContain('2.95%')
    // 浮点尾数不得泄漏到用户可见文本
    expect(text).not.toContain('2.949999')
  })

  it('计费单位三分支：tokens / credits 渲染各自 i18n 标签', async () => {
    quota.test.value.status = 'success'
    quota.test.value.row = {
      label: 'Mixed Plans',
      wins: [
        { pct: 24, used: 1204, limit: 5000, unit: 'tokens', resetSec: null },
        { pct: 41, used: 30, limit: 100, unit: 'credits', resetSec: null },
        { pct: 55, used: 1, limit: 2, unit: null, resetSec: null },
      ],
    }
    wrapper = mountSection()
    await flushPromises()

    const text = wrapper.find('[data-testid="quota-result-windows"]').text()
    expect(text).toContain('settings.providerEdit.quotaUnitTokens')
    expect(text).toContain('settings.providerEdit.quotaUnitCredits')
    expect(text).not.toContain('settings.providerEdit.quotaUnitRequests')
  })
})

describe('B-3 失败态「查看上次成功数据」折叠', () => {
  it('失败态初始不展示旧数据，展开后显示旧值 + 数据截至标注', async () => {
    arrangeFailure('unauthorized', { cookieAuth: false })
    quota.test.value.row = ROW_WITH_ABS
    quota.test.value.lastFetchAt = Date.now() - 3_600_000
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-last-success"]').exists()).toBe(false)

    await wrapper.find('[data-testid="quota-toggle-last-success"]').trigger('click')
    await flushPromises()
    const stale = wrapper.find('[data-testid="quota-last-success"]')
    expect(stale.exists()).toBe(true)
    expect(stale.text()).toContain('1,204')
    expect(stale.text()).toContain('5,000')
    expect(stale.text()).toContain('settings.providerEdit.quotaLastSuccessAt')
  })
})

describe('workspace 地址块（required 条件渲染 + 输入直写草稿）', () => {
  it('cookie 类 + workspace.required → 渲染块；输入直写 draft.workspace', async () => {
    arrangeCookieWorkspaceMissing(['workspace'])
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-workspace-block"]').exists()).toBe(true)
    await wrapper.find('[data-testid="quota-workspace-input"]').setValue('wrk_123')
    expect(quota.draft.value.workspace).toBe('wrk_123')
  })

  it('workspace.required=false → 不渲染 workspace 块', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.workspace.required = false
    wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-workspace-block"]').exists()).toBe(false)
  })
})

// ══ 交互补口：写动作与草稿直写分支（开关 / 输入草稿 / 重选类型 / 更新 Cookie）════════════

/**
 * 交互分支此前只有渲染断言没有交互断言——handler 未被调用 = 「输入 → module」链路的回归盲区。
 * C1 后验收点从 emits 换成 module 接口回写（interface is the test surface）。
 */
describe('交互补口：写动作与草稿直写（开关 / 输入草稿 / 重选类型 / 更新 Cookie）', () => {
  it('拨动启用开关 → setEnabled(false)（D4 纯配置位，$event === true 布尔窄化）', async () => {
    wrapper = mountSection()
    await flushPromises()

    const sw = wrapper.find('[data-testid="quota-enabled-switch"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    // reka Switch 点击翻转 true → false，窄化后交 module setEnabled（非原始 unknown）
    expect(quota.setEnabled).toHaveBeenCalledWith(false)
  })

  it('cookie 草稿输入 → 直写 draft.cookie（D7 草稿即真相，原文入草稿）', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="quota-cookie-input"]').setValue('draft-cookie')
    expect(quota.draft.value.cookie).toBe('draft-cookie')
  })

  it('专属 Key 草稿输入 → 直写 draft.apiKey（密文不回显，只写草稿原文）', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="quota-apikey-input"]').setValue('sk-draft')
    expect(quota.draft.value.apiKey).toBe('sk-draft')
  })

  it('失败态点「更新 Cookie」→ 清空 draft.cookie（清空草稿引导重贴，非清盘）', async () => {
    arrangeFailure('unauthorized', { cookieAuth: true, form: 'cookie' })
    quota.draft.value.cookie = 'stale-cookie'
    wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="quota-update-cookie-btn"]').trigger('click')
    expect(quota.draft.value.cookie).toBe('')
  })

  it('类型下拉重选 → selectType 收到选中值（非字符串检查在 module 内）', async () => {
    arrangeTypeUndetermined(undefined)
    quota.view.value.type.options = [
      { value: 'alpha', label: 'Alpha Plan' },
      { value: 'beta', label: 'Beta Plan' },
    ]
    wrapper = mountSection()
    await flushPromises()

    // reka Select 触发器 pointerdown 打开（happy-dom 需显式 dispatch，同 renderer
    // system-page-rename-model.test.ts 交互模式），选项经 SelectPortal 落 body
    const trigger = wrapper.find('[data-testid="quota-type-select"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const target = Array.from(document.body.querySelectorAll('[role="option"]'))
      .find((el): el is HTMLElement => (el.textContent ?? '').includes('Beta Plan'))
    if (!target) throw new Error('Beta Plan 选项未渲染')
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target.click()
    await flushPromises()

    expect(quota.selectType).toHaveBeenCalledWith('beta')
  })
})

// ══ DI 失败语义（C1 seam）═══════════════════════════════════════════════════

describe('DI 失败语义：module 缺失 = 接线错误，loud fail', () => {
  it('未提供 QUOTA_CONFIGURE_MODULE_KEY → 抛出可诊断错误（不渲染空壳伪装功能正常）', () => {
    expect(() => mount(CodingPlanSection, { attachTo: document.body })).toThrow(
      /QUOTA_CONFIGURE_MODULE_KEY/,
    )
  })
})

// ======================================================================
// ← provider-test-discover-section.test.ts
// ======================================================================

let wrapper_m2: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  wrapper_m2?.unmount()
  wrapper_m2 = null
})

function mountSection_m2(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderTestDiscoverSection, {
    props: {
      discovering: false,
      discoverResult: '',
      ...props,
    },
    attachTo: document.body,
  })
}

/** 按 i18n key 文本定位按钮（mock t 返回 key） */
function findButtonByKey(w: ReturnType<typeof mount>, key: string) {
  return w.findAll('button').find((b) => b.text().includes(key))
}

describe('模型发现按钮（custom 体系）', () => {
  it('渲染按钮，点击上抛 discover 事件', async () => {
    wrapper_m2 = mountSection_m2()
    const btn = findButtonByKey(wrapper_m2, 'settings.providerEdit.autoDiscover')
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    expect(wrapper_m2.emitted('discover')).toBeTruthy()
  })

  it('discovering=true → 按钮 disabled + 文案切换（进行中防重复点击）', async () => {
    wrapper_m2 = mountSection_m2({ discovering: true })
    const btn = findButtonByKey(wrapper_m2, 'settings.providerEdit.discovering')
    expect(btn).toBeTruthy()
    expect(btn!.attributes('disabled')).toBeDefined()
  })

  it('discoverResult 非空 → 渲染结果文案', () => {
    wrapper_m2 = mountSection_m2({ discoverResult: '已发现 3 个模型' })
    expect(wrapper_m2.text()).toContain('已发现 3 个模型')
  })
})

describe('catalog 门控（providerKind=catalog 不渲染发现按钮）', () => {
  it('providerKind=catalog → 无「模型发现」按钮（pi 无 fetchModels，清单编译期权威）', () => {
    wrapper_m2 = mountSection_m2({ providerKind: 'catalog' })
    expect(findButtonByKey(wrapper_m2, 'settings.providerEdit.autoDiscover')).toBeUndefined()
  })

  it('providerKind 缺省 → 按 custom 渲染（向后兼容既有调用方）', () => {
    wrapper_m2 = mountSection_m2()
    expect(findButtonByKey(wrapper_m2, 'settings.providerEdit.autoDiscover')).toBeTruthy()
  })
})
