/**
 * CodingPlanSection 组件测试（契约 v2 重写 —— coding-plan-quota-config-ux §7.4 方案 B）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/ui && npx vitest run src/features/settings/__tests__/coding-plan-section.test.ts
 *
 * 覆盖设计条款（每条用例名标注断言的是哪一条）：
 * ① D8（§6.9）未选类型态：只渲染类型下拉 + 说明，无开关 / 凭证区 / 按钮 / 结果块
 * ② D1（§6.2）单按钮置灰矩阵 + 字段级提示白名单（§7.4：'type' 结构性不进提示渲染）
 * ③ D3（§6.4）凭证来源分段控件：provider 项按 providerCredentialAvailable 置 disabled，切换 emit
 * ④ §7.4 跨区块时序两套 provider 凭据文案（providerCredentialPendingSave 区分）
 * ⑤ D7（§6.8）去掩码：输入框只放草稿，不回填掩码；「已配置 / 必填」为独立标记
 * ⑤b §7.4 徽标取值规则：徽标与字段级提示同源（readiness.missing），磁盘原始标记（provider.quota
 *    下的 cookieSet / apiKeySet / workspace）不再经 prop 传入，也不能越权点亮「已配置」（反向用例）
 * ⑤d §7 残留 11 专属 Key 适用性：authKinds 不含 api-key（如 ['oauth']）→ 不渲染凭证来源控件
 * ⑤c 定向复审三条探针（真实 DOM 回归守卫）：① 类型切换后徽标与专属 Key 占位不得出现「已配置」
 *    语义；② preset 未命中不出现「已配置」徽标；③ preset 未命中渲染「重选类型」指引且参数区不渲染
 * ⑥ §5.2 路径 3/4 失败态文案 + cookie 变体（unauthorized / no-credential / no-subscription）
 * ⑦ D2（§6.3）单按钮触发 saveAndTest emit
 * 附带保留：B-3 used/limit 双轨窗口、「查看上次成功数据」折叠、workspace 块事件上抛
 *
 * 三视角（项目红线：每条用例至少一个用户可见 DOM 断言）：
 *  - 观察者（首屏冒烟）：未选类型态 / 置灰态 / 分段控件 / 窗口双轨的渲染 gate
 *  - 使用者（黑盒）：按钮置灰与可点、提示文案、切换来源、失败态与折叠交互
 *  - 构建者（白盒）：readiness.missing / providerCredentialAvailable / providerCredentialPendingSave
 *    props → DOM 分支的映射
 *
 * 组件纯展示（状态在 useQuotaConfigure），直接 mount 传 props，无 transport/pinia 依赖。
 * i18n 经 ui vitest.setup mock：t() 返回 key（命名参数 append 到末尾），故断言 key 而非中文文案。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import CodingPlanSection from '../coding-plan/CodingPlanSection.vue'

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

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/**
 * 最小 props（纯展示组件，状态全由父注入）。
 * 默认 = 「已选 api-key 类类型且齐备」的常规态；各用例按需覆盖单项。
 * authKinds 必传（prop 无默认值）：凭证来源分段控件由 supportsExclusiveCredential(authKinds)
 * 门控（§7 残留 11），这里给 ['api-key'] 才能让 D3 用例拥有控件。
 */
function mountSection(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(CodingPlanSection, {
    props: {
      fetcherId: 'zhipu',
      enabled: true,
      cookieInput: '',
      apiKeyInput: '',
      credentialSource: 'provider',
      providerCredentialAvailable: true,
      readiness: { ready: true, missing: [] },
      testStatus: 'idle',
      testErrorMsg: '',
      quotaRow: null,
      lastFetchAt: null,
      isCookieAuth: false,
      configuring: false,
      configureErrorMsg: '',
      authKinds: ['api-key'],
      ...props,
    },
    attachTo: document.body,
  })
}

/** 单按钮（唯一主动作） */
const SAVE_TEST = '[data-testid="quota-save-test-btn"]'

// ══ ① D8：未选类型态 ═══════════════════════════════════════════════════════

describe('① D8 未选类型态：只渲染下拉 + 一句说明', () => {
  it('fetcherId 为空 → 渲染类型下拉与 quotaTypeFirstHint，且不渲染开关/凭证区/按钮/结果块', async () => {
    wrapper = mountSection({
      fetcherId: undefined,
      // 契约里未选类型的 readiness 恒为 { ready:false, missing:['type'] }（§7.2 伪码第一分支）
      readiness: { ready: false, missing: ['type'] },
    })
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
    wrapper = mountSection({
      fetcherId: undefined,
      readiness: { ready: false, missing: ['type'] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
  })
})

// ══ ② D1：单按钮置灰矩阵 + 字段级提示 ═══════════════════════════════════════

describe('② D1 齐备性门控：唯一按钮「保存并测试」的置灰矩阵', () => {
  it('readiness.ready=false → 按钮 disabled 且渲染 quotaReadyHint 旁注', async () => {
    wrapper = mountSection({ readiness: { ready: false, missing: ['cookie'] }, isCookieAuth: true })
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
    wrapper = mountSection({ readiness: { ready: true, missing: [] }, isCookieAuth: true })
    await flushPromises()

    const btn = wrapper.find<HTMLButtonElement>(SAVE_TEST)
    expect(btn.element.disabled).toBe(false)
    expect(wrapper.find('[data-testid="quota-ready-hint"]').exists()).toBe(false)
  })

  it('configuring=true → 按钮禁用且文案切 quotaSaveAndTestRunning（进行中不可重复提交）', async () => {
    wrapper = mountSection({ readiness: { ready: true, missing: [] }, configuring: true })
    await flushPromises()

    const btn = wrapper.find<HTMLButtonElement>(SAVE_TEST)
    expect(btn.element.disabled).toBe(true)
    expect(btn.text()).toContain('settings.providerEdit.quotaSaveAndTestRunning')
  })

  it('missing=["cookie"]（cookie 类）→ 字段下方渲染 quotaMissingCookie 提示', async () => {
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'mimo',
      readiness: { ready: false, missing: ['cookie'] },
    })
    await flushPromises()

    const hint = wrapper.find('[data-testid="quota-missing-cookie"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingCookie')
    // 逐键显式：其余两键不渲染
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
  })

  it('missing=["apiKey"]（来源=专属 Key）→ 专属 Key 输入下方渲染 quotaMissingApiKey 提示', async () => {
    wrapper = mountSection({
      credentialSource: 'exclusive',
      readiness: { ready: false, missing: ['apiKey'] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
    const hint = wrapper.find('[data-testid="quota-missing-apikey"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingApiKey')
    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
  })

  it('missing=["workspace"]（资源维度类型）→ workspace 输入下方渲染 quotaMissingWorkspace 提示', async () => {
    wrapper = mountSection({
      needsWorkspace: true,
      fetcherId: 'opencode-go',
      isCookieAuth: true,
      readiness: { ready: false, missing: ['workspace'] },
    })
    await flushPromises()

    const hint = wrapper.find('[data-testid="quota-missing-workspace"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('settings.providerEdit.quotaMissingWorkspace')
  })

  it('missing 同时含多键 → 逐键各渲染自己的提示（不写兜底循环，§7.4 显式白名单）', async () => {
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'opencode-go',
      needsWorkspace: true,
      readiness: { ready: false, missing: ['cookie', 'workspace'] },
    })
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
    wrapper = mountSection({
      fetcherId: 'legacy-unknown',
      readiness: { ready: false, missing: ['type'] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').exists()).toBe(false)
    // 参数区整体不渲染（类型未定不展示永远无法生效的控件，D8），故没有「保存并测试」按钮
    expect(wrapper.find(SAVE_TEST).exists()).toBe(false)
  })
})

// ══ ③ D3：凭证来源分段控件 ═════════════════════════════════════════════════

describe('③ D3 凭证来源分段控件（api-key 类专用）', () => {
  it('providerCredentialAvailable=true → provider 项可点；exclusive 项也可点', async () => {
    wrapper = mountSection({ providerCredentialAvailable: true })
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

  it('providerCredentialAvailable=false → provider 项置 disabled（无可用凭据不能选它），exclusive 项仍可点', async () => {
    wrapper = mountSection({
      providerCredentialAvailable: false,
      readiness: { ready: false, missing: ['apiKey'] },
    })
    await flushPromises()

    const providerBtn = wrapper.find<HTMLButtonElement>('[data-testid="quota-source-provider-btn"]')
    expect(providerBtn.element.disabled).toBe(true)
    expect(
      wrapper.find<HTMLButtonElement>('[data-testid="quota-source-exclusive-btn"]').element.disabled,
    ).toBe(false)
  })

  it("点 exclusive 项 → emit update:credentialSource('exclusive')；选中态渲染专属 Key 输入块", async () => {
    wrapper = mountSection({ credentialSource: 'provider' })
    await flushPromises()

    // 未选 exclusive 时不渲染专属 Key 输入块
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)

    await wrapper.find('[data-testid="quota-source-exclusive-btn"]').trigger('click')
    expect(wrapper.emitted('update:credentialSource')?.at(-1)).toEqual(['exclusive'])

    // 父组件回流后（credentialSource='exclusive'）渲染专属 Key 块 + 来源说明
    wrapper.unmount()
    wrapper = mountSection({ credentialSource: 'exclusive' })
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-source-hint"]').text()).toBe(
      'settings.providerEdit.quotaSourceExclusiveHint',
    )
  })

  it("点 provider 项（可用时）→ emit update:credentialSource('provider')；aria-pressed 表达当前选择", async () => {
    wrapper = mountSection({ credentialSource: 'exclusive', providerCredentialAvailable: true })
    await flushPromises()

    const providerBtn = wrapper.find('[data-testid="quota-source-provider-btn"]')
    expect(providerBtn.attributes('aria-pressed')).toBe('false')
    await providerBtn.trigger('click')
    expect(wrapper.emitted('update:credentialSource')?.at(-1)).toEqual(['provider'])
  })

  it('来源说明按凭据形态分叉：oauth 就绪 → OAuth 文案；否则 API Key 文案', async () => {
    wrapper = mountSection({
      credentialSource: 'provider',
      authKinds: ['api-key', 'oauth'],
      oauthReady: true,
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-source-hint"]').text()).toBe(
      'settings.providerEdit.quotaSourceProviderOauthHint',
    )

    wrapper.unmount()
    wrapper = mountSection({ credentialSource: 'provider', authKinds: ['api-key'], oauthReady: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-source-hint"]').text()).toBe(
      'settings.providerEdit.quotaSourceProviderApiKeyHint',
    )
  })

  it('cookie 类不渲染分段控件（来源只对 api-key 类有意义）', async () => {
    wrapper = mountSection({ isCookieAuth: true, fetcherId: 'mimo' })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-cookie-block"]').exists()).toBe(true)
  })

  it("⑤d authKinds 不含 api-key 且非 cookie（如 ['oauth']）→ 分段控件与专属 Key 块都不渲染（§7 残留 11）", async () => {
    // UI 不得显示 runtime 不会采用的选项：auth=['oauth'] 时 runtime 的 resolveCredential
    // 不收窄 exclusive（supportsExclusiveCredential=false），UI 必须同判据。
    wrapper = mountSection({
      fetcherId: 'oauth-only',
      authKinds: ['oauth'],
      credentialSource: 'exclusive',
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)
    // 只隐藏不适用控件，参数区其余部分仍在（不是整块不渲染）
    expect(wrapper.find('[data-testid="quota-enabled-switch"]').exists()).toBe(true)
  })

  it("⑤d authKinds=['api-key'] / ['api-key','oauth'] → 分段控件仍渲染（防回归：门控不得藏掉 api-key 类）", async () => {
    wrapper = mountSection({ fetcherId: 'zhipu', authKinds: ['api-key'] })
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(true)

    wrapper.unmount()
    wrapper = mountSection({ fetcherId: 'kimi-coding', authKinds: ['api-key', 'oauth'], credentialSource: 'exclusive' })
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-credential-source"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
  })
})

// ══ ④ §7.4：Provider 凭据不可用的两套文案 ═══════════════════════════════════

describe('④ §7.4 跨区块时序：provider 凭据不可用的两套文案', () => {
  it('pendingSave=false（草稿也空）→ 「还没有可用的 API Key，请先填写，或改用专属 Key」', async () => {
    wrapper = mountSection({
      credentialSource: 'provider',
      providerCredentialAvailable: false,
      providerCredentialPendingSave: false,
      readiness: { ready: false, missing: ['apiKey'] },
    })
    await flushPromises()

    const warn = wrapper.find('[data-testid="quota-provider-credential-warning"]')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toBe('settings.providerEdit.quotaProviderCredentialMissing')
  })

  it('pendingSave=true（表单已填但未保存 provider）→ 「已填写 API Key，保存 provider 配置后即可查询」', async () => {
    wrapper = mountSection({
      credentialSource: 'provider',
      providerCredentialAvailable: false,
      providerCredentialPendingSave: true,
      readiness: { ready: false, missing: ['apiKey'] },
    })
    await flushPromises()

    const warn = wrapper.find('[data-testid="quota-provider-credential-warning"]')
    expect(warn.text()).toBe('settings.providerEdit.quotaProviderCredentialPendingSave')
    // 两套文案必须不同（这条断言即「按钮灰但屏幕上明明填了 Key」矛盾的消除证据）
    expect(warn.text()).not.toBe('settings.providerEdit.quotaProviderCredentialMissing')
  })

  it('providerCredentialAvailable=true → 不渲染该警告（有凭据时无话可说）', async () => {
    wrapper = mountSection({ credentialSource: 'provider', providerCredentialAvailable: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-provider-credential-warning"]').exists()).toBe(false)
  })

  it('来源=exclusive 时不渲染 provider 警告（改走专属 Key 提示）', async () => {
    wrapper = mountSection({
      credentialSource: 'exclusive',
      providerCredentialAvailable: false,
      readiness: { ready: false, missing: ['apiKey'] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-provider-credential-warning"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').exists()).toBe(true)
  })
})

// ══ ⑤ D7：去掩码（cookie / 专属 Key 不回填） ════════════════════════════════

describe('⑤ D7 去掩码：输入框只放草稿，「已配置」是独立标记', () => {
  it('cookie 已配置但草稿为空 → 输入框为空（不回填掩码），旁边标 quotaConfiguredBadge', async () => {
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'mimo',
      cookieInput: '',
      readiness: { ready: true, missing: [] },
    })
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
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'mimo',
      readiness: { ready: false, missing: ['cookie'] },
    })
    await flushPromises()

    const block = wrapper.find('[data-testid="quota-cookie-block"]').text()
    expect(block).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(block).not.toContain('settings.providerEdit.quotaConfiguredBadge')
  })

  it('专属 Key 已配置但草稿为空 → 输入框为空 + quotaApiKeySetPlaceholder（不回填密文）', async () => {
    wrapper = mountSection({
      credentialSource: 'exclusive',
      apiKeyInput: '',
      readiness: { ready: true, missing: [] },
    })
    await flushPromises()

    const input = wrapper.find<HTMLInputElement>('[data-testid="quota-apikey-input"]')
    expect(input.element.value).toBe('')
    expect(input.attributes('placeholder')).toBe('settings.providerEdit.quotaApiKeySetPlaceholder')
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').text()).toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
  })

  it('用户输入草稿 → 渲染的 value 即草稿原文（屏幕即真相）', async () => {
    wrapper = mountSection({ isCookieAuth: true, fetcherId: 'mimo', cookieInput: 'raw-cookie-value' })
    await flushPromises()

    expect(
      wrapper.find<HTMLTextAreaElement>('[data-testid="quota-cookie-input"]').element.value,
    ).toBe('raw-cookie-value')
  })
})

// ══ ⑤b §7.4：徽标与 readiness 同源（反向用例） ══════════════════════════════

describe('⑤b §7.4 徽标取值与 readiness 同源（磁盘标记不再经 prop 传入，徽标只认 readiness）', () => {
  it('反向：missing 含 cookie（类型切换后归属失效）→ 徽标「必填」，与字段提示同屏一致', async () => {
    // 复现 D5 的核心场景：已保存 MiMo cookie，用户把类型改成 opencode-go（同为 cookie 类）后
    // 旧 cookie 归属失效 → readiness 报 ['cookie']。磁盘标记（provider.quota.cookieSet）自 §7 残留 7
    // 起不再作为 prop 传入，徽标唯一来源是 readiness.missing；若改回读磁盘标记就会与下方
    // 「这里必须填」提示同屏矛盾（S7 反例）。
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'opencode-go',
      needsWorkspace: true,
      readiness: { ready: false, missing: ['cookie', 'workspace'] },
    })
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
    wrapper = mountSection({
      credentialSource: 'exclusive',
      apiKeyInput: '',
      fetcherId: 'minimax',
      readiness: { ready: false, missing: ['apiKey'] },
    })
    await flushPromises()

    const keyBlock = wrapper.find('[data-testid="quota-exclusive-key-block"]')
    expect(keyBlock.text()).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(keyBlock.text()).not.toContain('settings.providerEdit.quotaConfiguredBadge')
    expect(wrapper.find('[data-testid="quota-missing-apikey"]').text()).toBe(
      'settings.providerEdit.quotaMissingApiKey',
    )
  })

  it('反向：missing 含 workspace（草稿被清空）→ 徽标「必填」（D13 屏幕即真相）', async () => {
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'opencode-go',
      needsWorkspace: true,
      workspaceInput: '',
      readiness: { ready: false, missing: ['workspace'] },
    })
    await flushPromises()

    const wsBlock = wrapper.find('[data-testid="quota-workspace-block"]')
    expect(wsBlock.text()).toContain('settings.providerEdit.quotaRequiredBadge')
    expect(wsBlock.text()).not.toContain('settings.providerEdit.quotaConfiguredBadge')
    expect(wrapper.find('[data-testid="quota-missing-workspace"]').text()).toBe(
      'settings.providerEdit.quotaMissingWorkspace',
    )
  })
})

// ══ ⑤c 定向复审探针（三条复现路径转正为回归守卫） ═════════════════════════

describe('⑤c 定向复审探针：三条复现路径的真实 DOM 锁定', () => {
  it('探针①：类型已变（D5 旧专属 Key 归属失效）+ 草稿空 → 字段块内无任何「已配置」语义（徽标与占位）', async () => {
    wrapper = mountSection({
      credentialSource: 'exclusive',
      // 磁盘仍有旧专属 Key（provider.quota.apiKeySet=true），readiness 因 typeChanged 判定该归属失效
      apiKeyInput: '',
      fetcherId: 'minimax',
      readiness: { ready: false, missing: ['apiKey'] },
    })
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
    wrapper = mountSection({
      fetcherId: 'legacy-unknown',
      credentialSource: 'exclusive',
      apiKeyInput: '',
      readiness: { ready: false, missing: ['type'] },
    })
    await flushPromises()

    // 类型未定 ⇒ 专属 Key 块整体不渲染；整区块文本不得含「已配置」
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="coding-plan-section"]').text()).not.toContain(
      'settings.providerEdit.quotaConfiguredBadge',
    )
  })

  it('探针③：preset 未命中 → 渲染「重选类型」指引，且参数区不渲染（与 D8 同形态）', async () => {
    wrapper = mountSection({
      fetcherId: 'legacy-unknown',
      readiness: { ready: false, missing: ['type'] },
    })
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

describe('⑥ §5.2 失败路径文案（reason 透传 + cookie 变体）', () => {
  /** 失败态 fixture：给定 reason / authKinds */
  function mountFail(reason: string, opts: Record<string, unknown> = {}): ReturnType<typeof mount> {
    return mountSection({
      testStatus: 'error',
      testFailReason: reason,
      testErrorMsg: '',
      ...opts,
    })
  }

  it('unauthorized + api-key 类 → quotaFetchFailUnauthorized（给「发起一次对话刷新」动作）', async () => {
    wrapper = mountFail('unauthorized', { authKinds: ['api-key'] })
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailUnauthorized')
    // 区分断言：不出现 cookie 变体
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
  })

  it('unauthorized + cookie 类 → quotaFetchFailUnauthorizedCookie（改指「重新复制 Cookie」）', async () => {
    wrapper = mountFail('unauthorized', { authKinds: ['cookie'], isCookieAuth: true })
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
  })

  it('no-credential + api-key 类 → quotaFetchFailNoCredential（指向两个可填位置）', async () => {
    wrapper = mountFail('no-credential', { authKinds: ['api-key'] })
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailNoCredential')
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailNoCredentialCookie')
  })

  it('no-credential + cookie 类 → quotaFetchFailNoCredentialCookie（重贴 Cookie，非填 API Key）', async () => {
    wrapper = mountFail('no-credential', { authKinds: ['cookie'], isCookieAuth: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNoCredentialCookie',
    )
    // cookie 类失败态提供「更新 Cookie」快捷入口（清空草稿重贴）
    expect(wrapper.find('[data-testid="quota-update-cookie-btn"]').exists()).toBe(true)
  })

  it('no-subscription + cookie 类 → 既有两可文案（Cookie 变体先例，S5）', async () => {
    wrapper = mountFail('no-subscription', { authKinds: ['cookie'], isCookieAuth: true })
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailNoSubscriptionCookie')
  })

  it('no-subscription + api-key 类 → 非 cookie 文案（与 cookie 变体可区分）', async () => {
    wrapper = mountFail('no-subscription', { authKinds: ['api-key'] })
    await flushPromises()

    const msg = wrapper.find('[data-testid="quota-error-msg"]').text()
    expect(msg).toContain('settings.providerEdit.quotaFetchFailNoSubscription')
    expect(msg).not.toContain('settings.providerEdit.quotaFetchFailNoSubscriptionCookie')
  })

  it('network / parse / not_configured → 各自专属文案（逐键断言，不回退通用文案）', async () => {
    wrapper = mountFail('network')
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNetwork',
    )

    wrapper.unmount()
    wrapper = mountFail('parse')
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailParse',
    )

    wrapper.unmount()
    wrapper = mountFail('not_configured')
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain(
      'settings.providerEdit.quotaFetchFailNotConfigured',
    )
  })

  it('无 reason → 回退 testErrorMsg；无旧数据时不渲染「查看上次成功数据」入口', async () => {
    wrapper = mountSection({ testStatus: 'error', testFailReason: null, testErrorMsg: 'boom' })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain('boom')
    expect(wrapper.find('[data-testid="quota-toggle-last-success"]').exists()).toBe(false)
  })
})

// ══ ⑦ D2：单按钮触发 saveAndTest ═══════════════════════════════════════════

describe('⑦ D2 保存与测试合一：点击单按钮 emit saveAndTest', () => {
  it('齐备时点击 quota-save-test-btn → emit saveAndTest 一次（无独立保存/测试按钮）', async () => {
    wrapper = mountSection({ readiness: { ready: true, missing: [] } })
    await flushPromises()

    await wrapper.find(SAVE_TEST).trigger('click')
    expect(wrapper.emitted('saveAndTest')).toHaveLength(1)
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
    wrapper = mountSection({
      testStatus: 'success',
      quotaRow: ROW_WITH_ABS,
      lastFetchAt: Date.now() - 60_000,
    })
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
    wrapper = mountSection({
      testStatus: 'success',
      quotaRow: {
        label: 'Zhipu Plan',
        wins: [
          { pct: 55, resetSec: 100 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
    await flushPromises()

    const windows = wrapper.find('[data-testid="quota-result-windows"]')
    expect(windows.text()).toContain('55%')
    expect(windows.text()).not.toContain('quotaUsedOf')
  })

  it('计费单位三分支：tokens / credits 渲染各自 i18n 标签', async () => {
    wrapper = mountSection({
      testStatus: 'success',
      quotaRow: {
        label: 'Mixed Plans',
        wins: [
          { pct: 24, used: 1204, limit: 5000, unit: 'tokens', resetSec: null },
          { pct: 41, used: 30, limit: 100, unit: 'credits', resetSec: null },
          { pct: 55, used: 1, limit: 2, unit: null, resetSec: null },
        ],
      },
    })
    await flushPromises()

    const text = wrapper.find('[data-testid="quota-result-windows"]').text()
    expect(text).toContain('settings.providerEdit.quotaUnitTokens')
    expect(text).toContain('settings.providerEdit.quotaUnitCredits')
    expect(text).not.toContain('settings.providerEdit.quotaUnitRequests')
  })
})

describe('B-3 失败态「查看上次成功数据」折叠', () => {
  it('失败态初始不展示旧数据，展开后显示旧值 + 数据截至标注', async () => {
    wrapper = mountSection({
      testStatus: 'error',
      testFailReason: 'unauthorized',
      testErrorMsg: '',
      quotaRow: ROW_WITH_ABS,
      lastFetchAt: Date.now() - 3_600_000,
    })
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

describe('workspace 地址块（needsWorkspace 条件渲染 + 输入上抛）', () => {
  it('cookie 类 + needsWorkspace → 渲染块；输入上抛 update:workspaceInput', async () => {
    wrapper = mountSection({
      isCookieAuth: true,
      fetcherId: 'opencode-go',
      needsWorkspace: true,
      readiness: { ready: false, missing: ['workspace'] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-workspace-block"]').exists()).toBe(true)
    await wrapper.find('[data-testid="quota-workspace-input"]').setValue('wrk_123')
    expect(wrapper.emitted('update:workspaceInput')?.at(-1)).toEqual(['wrk_123'])
  })

  it('needsWorkspace=false → 不渲染 workspace 块', async () => {
    wrapper = mountSection({ isCookieAuth: true, needsWorkspace: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-workspace-block"]').exists()).toBe(false)
  })
})

// ══ R4 review 增量补口：事件上抛分支（开关 / 输入草稿 / 重选类型 / 更新 Cookie）════════════

/**
 * R4 coverage Gate 复跑实测的 6 条未覆盖行，全部是事件 handler 分支：开关 update:enabled、
 * cookie / 专属 Key 草稿输入、「更新 Cookie」清空、onSelectFetcher 守卫 + 上抛。此前只有
 * 渲染断言没有交互断言——handler 未被调用 = 「输入上抛 → 父组件写草稿」链路的回归盲区。
 */
describe('R4 补口：事件上抛分支（开关 / 输入草稿 / 重选类型 / 更新 Cookie）', () => {
  it('拨动启用开关 → emit update:enabled(false)（D4 纯配置位上抛，$event === true 布尔窄化）', async () => {
    wrapper = mountSection({ enabled: true })
    await flushPromises()

    const sw = wrapper.find('[data-testid="quota-enabled-switch"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    // reka Switch 点击翻转 true → false，窄化后上抛 false（非原始 unknown）
    expect(wrapper.emitted('update:enabled')?.at(-1)).toEqual([false])
  })

  it('cookie 草稿输入 → emit update:cookieInput（D7 草稿即真相，原文上抛父组件）', async () => {
    wrapper = mountSection({ isCookieAuth: true, fetcherId: 'mimo' })
    await flushPromises()

    await wrapper.find('[data-testid="quota-cookie-input"]').setValue('draft-cookie')
    expect(wrapper.emitted('update:cookieInput')?.at(-1)).toEqual(['draft-cookie'])
  })

  it('专属 Key 草稿输入 → emit update:apiKeyInput（密文不回显，只上抛草稿原文）', async () => {
    wrapper = mountSection({ credentialSource: 'exclusive' })
    await flushPromises()

    await wrapper.find('[data-testid="quota-apikey-input"]').setValue('sk-draft')
    expect(wrapper.emitted('update:apiKeyInput')?.at(-1)).toEqual(['sk-draft'])
  })

  it('失败态点「更新 Cookie」→ emit update:cookieInput(\'\')（清空草稿引导重贴，非清盘）', async () => {
    wrapper = mountSection({
      testStatus: 'error',
      testFailReason: 'unauthorized',
      authKinds: ['cookie'],
      isCookieAuth: true,
      cookieInput: 'stale-cookie',
    })
    await flushPromises()

    await wrapper.find('[data-testid="quota-update-cookie-btn"]').trigger('click')
    expect(wrapper.emitted('update:cookieInput')?.at(-1)).toEqual([''])
  })

  it('类型下拉重选 → onSelectFetcher 守卫放行字符串并 emit update:fetcherId', async () => {
    wrapper = mountSection({
      fetcherId: undefined,
      readiness: { ready: false, missing: ['type'] },
      fetcherOptions: [
        { value: 'alpha', label: 'Alpha Plan' },
        { value: 'beta', label: 'Beta Plan' },
      ],
    })
    await flushPromises()

    // reka Select 触发器 pointerdown 打开（happy-dom 需显式 dispatch，同 renderer
    // system-page-rename-model.test.ts 交互模式），选项经 SelectPortal 落 body
    const trigger = wrapper.find('[data-testid="quota-type-select"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const target = Array.from(document.body.querySelectorAll('[role="option"]'))
      .find((el): el is HTMLElement => (el.textContent ?? '').includes('Beta Plan'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()

    expect(wrapper.emitted('update:fetcherId')?.at(-1)).toEqual(['beta'])
  })
})
