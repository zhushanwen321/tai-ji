/**
 * CodingPlanSection 组件测试（契约 v2 —— coding-plan-quota-config-ux §7.4 方案 B；C1 seam 改打
 * QuotaConfigureModule 接口）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/ui && npx vitest run src/features/settings/__tests__/coding-plan-section.test.ts
 *
 * C1 后的测试面：组件经 QUOTA_CONFIGURE_MODULE_KEY 直接持有 module 实例（无 props / 无 emits），
 * 故用例在 module 接口上布置状态（view / draft 透镜）、在 module 接口上验收写动作
 * （selectType / setEnabled / saveAndTest / 草稿直写）——interface is the test surface。
 * 断言的用户可见形态（DOM testid / 文案 / 置灰）与重构前完全一致。
 *
 * 覆盖设计条款（每条用例名标注断言的是哪一条）：
 * ① D8（§6.9）未选类型态：只渲染类型下拉 + 说明，无开关 / 凭证区 / 按钮 / 结果块
 * ② D1（§6.2）单按钮置灰矩阵 + 字段级提示白名单（§7.4：'type' 结构性不进提示渲染）
 * ③ D3（§6.4）凭证来源分段控件：provider 项按 providerAvailable 置 disabled，切换写草稿
 * ④ §7.4 跨区块时序两套 provider 凭据文案（providerWarning 分档）
 * ⑤ D7（§6.8）去掩码：输入框只放草稿，不回填掩码；「已配置 / 必填」为独立标记
 * ⑤b §7.4 徽标取值规则：徽标与字段级提示同源（readiness.missing），磁盘原始标记不能越权点亮
 * ⑤d §7 残留 11 专属 Key 适用性：exclusiveApplicable=false → 不渲染凭证来源控件
 * ⑤c 定向复审三条探针（真实 DOM 回归守卫）
 * ⑥ §5.2 路径 3/4 失败态文案 + cookie 变体（unauthorized / no-credential / no-subscription）
 * ⑦ D2（§6.3）单按钮触发 saveAndTest
 * 附带保留：B-3 used/limit 双轨窗口、「查看上次成功数据」折叠、workspace 块输入直写
 *
 * 三视角（项目红线：每条用例至少一个用户可见 DOM 断言）：
 *  - 观察者（首屏冒烟）：未选类型态 / 置灰态 / 分段控件 / 窗口双轨的渲染 gate
 *  - 使用者（黑盒）：按钮置灰与可点、提示文案、切换来源、失败态与折叠交互
 *  - 构建者（白盒）：view/draft 透镜 → DOM 分支的映射，写动作 → module 接口回写
 *
 * i18n 经 ui vitest.setup mock：t() 返回 key（命名参数 append 到末尾），故断言 key 而非中文文案。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { NormalizedQuotaRow } from '@taiji/shared'
import type { QuotaConfigureModule, QuotaFailureKind, QuotaTestStatus } from '@taiji/core'
import CodingPlanSection from '../coding-plan/CodingPlanSection.vue'
import { QUOTA_CONFIGURE_MODULE_KEY } from '../injection-keys'
import { makeQuotaModuleStub } from '@taiji/core/testing'

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

/** 布置失败态（test 透镜）：分档 + cookie 形态 + 兜底消息 */
function arrangeFailure(kind: QuotaFailureKind, opts: { cookieAuth?: boolean; message?: string; status?: QuotaTestStatus } = {}): void {
  quota.test.value.status = opts.status ?? 'error'
  quota.test.value.failure = { kind, cookieAuth: opts.cookieAuth ?? false, message: opts.message ?? '' }
}

/** 单按钮（唯一主动作） */
const SAVE_TEST = '[data-testid="quota-save-test-btn"]'

// ══ ① D8：未选类型态 ═══════════════════════════════════════════════════════

describe('① D8 未选类型态：只渲染下拉 + 一句说明', () => {
  it('type.undetermined → 渲染类型下拉与 quotaTypeFirstHint，且不渲染开关/凭证区/按钮/结果块', async () => {
    // 契约里未选类型的 readiness 恒为 { ready:false, missing:['type'] }（module 派生）
    quota.view.value.type.selected = undefined
    quota.view.value.type.undetermined = true
    quota.view.value.readiness = { ready: false, missing: ['type'] }
    wrapper = mountSection()
    await flushPromises()

    // 用户可见：下拉仍在（区块对所有 provider 显示）+ 说明文案
    expect(wrapper.find('[data-testid="quota-type-select"]').exists()).toBe(true)
    const hint = wrapper.find('[data-testid="quota-no-type-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('settings.providerEdit.quotaTypeFirstHint')

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
    quota.view.value.type.selected = undefined
    quota.view.value.type.undetermined = true
    quota.view.value.readiness = { ready: false, missing: ['type'] }
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
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
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    quota.view.value.readiness = { ready: false, missing: ['cookie'] }
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
    quota.view.value.workspace.required = true
    quota.view.value.type.selected = 'opencode-go'
    quota.view.value.credential.form = 'cookie'
    quota.view.value.readiness = { ready: false, missing: ['workspace'] }
    wrapper = mountSection()
    await flushPromises()

    const hint = wrapper.find('[data-testid="quota-missing-workspace"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingWorkspace')
  })

  it('missing 同时含多键 → 逐键各渲染自己的提示（不写兜底循环，§7.4 显式白名单）', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'opencode-go'
    quota.view.value.workspace.required = true
    quota.view.value.readiness = { ready: false, missing: ['cookie', 'workspace'] }
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
    quota.view.value.type.selected = 'legacy-unknown'
    quota.view.value.type.undetermined = true
    quota.view.value.readiness = { ready: false, missing: ['type'] }
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
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

// ══ ⑤ D7：去掩码（cookie / 专属 Key 不回填） ════════════════════════════════

describe('⑤ D7 去掩码：输入框只放草稿，「已配置」是独立标记', () => {
  it('cookie 已配置但草稿为空 → 输入框为空（不回填掩码），旁边标 quotaConfiguredBadge', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    quota.draft.value.cookie = ''
    wrapper = mountSection()
    await flushPromises()

    const input = wrapper.find<HTMLTextAreaElement>('[data-testid="quota-cookie-input"]')
    expect(input.element.value).toBe('')
    // 独立标记：「已配置」（不靠输入框内容表达）
    expect(wrapper.find('[data-testid="quota-cookie-block"]').text()).toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
    // 占位符是「在此粘贴 cookie 字符串」，不是掩码
    expect(input.attributes('placeholder')).toBe('settings.providerEdit.quotaCookiePlaceholder')
  })

  it('cookie 未配置 → 标 quotaRequiredBadge（必填），与「已配置」互斥', async () => {
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'mimo'
    quota.view.value.readiness = { ready: false, missing: ['cookie'] }
    wrapper = mountSection()
    await flushPromises()

    const block = wrapper.find('[data-testid="quota-cookie-block"]').text()
    expect(block).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(block).not.toContain('settings.providerEdit.quotaConfiguredBadge')
  })

  it('专属 Key 已配置但草稿为空 → 输入框为空 + quotaApiKeySetPlaceholder（不回填密文）', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    quota.draft.value.apiKey = ''
    wrapper = mountSection()
    await flushPromises()

    const input = wrapper.find<HTMLInputElement>('[data-testid="quota-apikey-input"]')
    expect(input.element.value).toBe('')
    expect(input.attributes('placeholder')).toBe('settings.providerEdit.quotaApiKeySetPlaceholder')
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').text()).toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
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
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'opencode-go'
    quota.view.value.workspace.required = true
    quota.view.value.readiness = { ready: false, missing: ['cookie', 'workspace'] }
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
    quota.draft.value.credentialSource = 'exclusive'
    quota.draft.value.apiKey = ''
    quota.view.value.type.selected = 'minimax'
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
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
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'opencode-go'
    quota.view.value.workspace.required = true
    quota.draft.value.workspace = ''
    quota.view.value.readiness = { ready: false, missing: ['workspace'] }
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

// ══ ⑤c 定向复审探针（三条复现路径转正为回归守卫） ═════════════════════════════

describe('⑤c 定向复审探针：三条复现路径的真实 DOM 锁定', () => {
  it('探针①：类型已变（D5 旧专属 Key 归属失效）+ 草稿空 → 字段块内无任何「已配置」语义（徽标与占位）', async () => {
    quota.draft.value.credentialSource = 'exclusive'
    // 磁盘仍有旧专属 Key，readiness 因 typeChanged 判定该归属失效
    quota.draft.value.apiKey = ''
    quota.view.value.type.selected = 'minimax'
    quota.view.value.readiness = { ready: false, missing: ['apiKey'] }
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
    quota.view.value.type.selected = 'legacy-unknown'
    quota.view.value.type.undetermined = true
    quota.view.value.readiness = { ready: false, missing: ['type'] }
    quota.draft.value.credentialSource = 'exclusive'
    quota.draft.value.apiKey = ''
    wrapper = mountSection()
    await flushPromises()

    // 类型未定 ⇒ 专属 Key 块整体不渲染；整区块文本不得含「已配置」
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="coding-plan-section"]').text()).not.toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
  })

  it('探针③：preset 未命中 → 渲染「重选类型」指引，且参数区不渲染（与 D8 同形态）', async () => {
    quota.view.value.type.selected = 'legacy-unknown'
    quota.view.value.type.undetermined = true
    quota.view.value.readiness = { ready: false, missing: ['type'] }
    wrapper = mountSection()
    await flushPromises()

    const hint = wrapper.find('[data-testid="quota-no-type-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('settings.providerEdit.quotaTypeFirstHint')
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
    arrangeFailure('unauthorized', { cookieAuth: true })
    quota.view.value.credential.form = 'cookie'
    wrapper = mountSection()
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
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
    arrangeFailure('no-credential', { cookieAuth: true })
    quota.view.value.credential.form = 'cookie'
    wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNoCredentialCookie',
    )
    // cookie 类失败态提供「更新 Cookie」快捷入口（清空草稿重贴）
    expect(wrapper.find('[data-testid="quota-update-cookie-btn"]').exists()).toBe(true)
  })

  it('no-subscription + cookie 类 → 既有两可文案（Cookie 变体先例，S5）', async () => {
    arrangeFailure('no-subscription', { cookieAuth: true })
    quota.view.value.credential.form = 'cookie'
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

  it('无绝对量数据 → 维持 pct 单轨不显示 used-of', async () => {
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
    quota.view.value.credential.form = 'cookie'
    quota.view.value.type.selected = 'opencode-go'
    quota.view.value.workspace.required = true
    quota.view.value.readiness = { ready: false, missing: ['workspace'] }
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
    arrangeFailure('unauthorized', { cookieAuth: true })
    quota.view.value.credential.form = 'cookie'
    quota.draft.value.cookie = 'stale-cookie'
    wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="quota-update-cookie-btn"]').trigger('click')
    expect(quota.draft.value.cookie).toBe('')
  })

  it('类型下拉重选 → selectType 收到选中值（非字符串守卫在 module 内）', async () => {
    quota.view.value.type.selected = undefined
    quota.view.value.type.undetermined = true
    quota.view.value.readiness = { ready: false, missing: ['type'] }
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
