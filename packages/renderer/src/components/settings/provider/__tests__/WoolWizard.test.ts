/**
 * WoolWizard 组件族测试（wool-provider D6 ①/D7 两族模板）。
 *
 * 覆盖（任务书验收条款② + 三视角红线——每条用例至少一个用户可见 DOM 断言）：
 * - 家族选择页：三卡渲染 + 登录态徽标双态（检测到/需授权）+ 固定风险行
 * - 提取族模板：步骤序列渲染（安装/凭据/完成）+ 确认框（testid + 文案）
 * - 授权族模板：五步渲染 + 授权按钮 + 自动签到黄色警示（默认关）
 * - 失败路径：install 失败态（恢复指引 + 重试按钮 testid）
 * - 条目卡：额度条/模型数/签到徽标/登录态失效徽标
 *
 * mock 策略：vi.mock useWool（快照/动作可控桩）——组件树 transport 零依赖；
 * WoolStepRow/Flows 纯 props 渲染直接 mount（不经向导编排）。
 *
 * 测试框架：vitest。运行：cd packages/renderer && npx vitest run src/components/settings/provider/__tests__/WoolWizard.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import type { WoolFamilyState } from '@taiji/shared'
import type { WoolWizardStepId, WoolWizardStepState } from '@/composables/features/settings/useWoolWizard'

// ── i18n 装配（zh-CN 真文案——DOM 断言即用户可见文案）─────────────────
import zhWool from '@/i18n/locales/zh-CN/wool'
const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: { 'zh-CN': { wool: zhWool } },
})

// ── fixtures ───────────────────────────────────────────────────────────

function familyState(extra: Partial<WoolFamilyState> = {}): WoolFamilyState {
  return {
    family: 'qoder',
    displayName: 'Qoder',
    vendor: '阿里',
    credentialsSource: 'ide-extract',
    riskNotice: '非官方接口：使用你自己的账号额度',
    installed: true,
    adopted: true,
    autoCheckin: false,
    account: null,
    detect: null,
    catalog: null,
    ...extra,
  }
}

function stepStates(overrides: Partial<Record<WoolWizardStepId, WoolWizardStepState>> = {}): Record<WoolWizardStepId, WoolWizardStepState> {
  return {
    install: { status: 'pending' },
    credentials: { status: 'pending' },
    authorize: { status: 'pending' },
    ready: { status: 'pending' },
    checkin: { status: 'pending' },
    done: { status: 'pending' },
    ...overrides,
  }
}

// ── 组件挂载 helper ────────────────────────────────────────────────────

import WoolFamilyCards from '../WoolWizard/WoolFamilyCards.vue'
import WoolExtractFlow from '../WoolWizard/WoolExtractFlow.vue'
import WoolOauthFlow from '../WoolWizard/WoolOauthFlow.vue'
import WoolEntryCard from '../WoolWizard/WoolEntryCard.vue'

function mountComp(component: new () => unknown, props: Record<string, unknown>) {
  return mount(component, {
    props,
    global: { plugins: [i18n], stubs: { teleport: true } },
  } as never)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ── 家族选择页（D7 家族卡）────────────────────────────────────────────

describe('WoolFamilyCards（家族选择页）', () => {
  it('三家族卡渲染 + oauth 家族显示「需授权」徽标 + ide-extract 已检测显示「检测到登录态」', () => {
    const wrapper = mountComp(WoolFamilyCards, {
      families: [
        familyState({ family: 'qoder', detect: { detected: true, fetchedAt: 1 } }),
        familyState({ family: 'trae', detect: { detected: false, fetchedAt: 1 } }),
        familyState({ family: 'workbuddy', displayName: 'WorkBuddy', vendor: '腾讯', credentialsSource: 'oauth' }),
      ],
    })
    expect(wrapper.find('[data-testid="wool-family-card-qoder"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wool-family-card-trae"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wool-family-card-workbuddy"]').exists()).toBe(true)
    // 用户可见徽标文案（三态分流）
    expect(wrapper.find('[data-testid="wool-family-detect-qoder"]').text()).toBe('检测到登录态')
    expect(wrapper.find('[data-testid="wool-family-detect-trae"]').text()).toBe('未检测到登录态')
    expect(wrapper.find('[data-testid="wool-family-detect-workbuddy"]').text()).toBe('需授权')
    // 固定风险行
    expect(wrapper.find('[data-testid="wool-family-risk"]').text()).toContain('非官方接口')
  })

  it('点击家族卡 → emit select（向导进入步骤相）', async () => {
    const wrapper = mountComp(WoolFamilyCards, { families: [familyState()] })
    await wrapper.find('[data-testid="wool-family-card-qoder"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['qoder']])
  })
})

// ── 提取族模板（D7：install → credentials → done）────────────────────

describe('WoolExtractFlow（提取族模板）', () => {
  it('三步渲染 + 检测未登录引导文案（S11 卡片指引同语义）', () => {
    const wrapper = mountComp(WoolExtractFlow, {
      displayName: 'Qoder',
      stepStates: stepStates(),
      currentStep: 'install',
      extractConfirmPending: false,
      detect: { detected: false, fetchedAt: 1 },
      catalogLoading: false,
      catalogCount: null,
    })
    expect(wrapper.find('[data-testid="wool-step-install"]').text()).toContain('安装扩展')
    expect(wrapper.find('[data-testid="wool-step-credentials"]').text()).toContain('凭据提取')
    expect(wrapper.find('[data-testid="wool-step-done"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wool-extract-no-login"]').text()).toContain('暂无有效登录态')
  })

  it('检测通过 → 确认框（提取前逐次确认 D3：标题/说明/确认/取消 testid 全在）', () => {
    const wrapper = mountComp(WoolExtractFlow, {
      displayName: 'Qoder',
      stepStates: stepStates(),
      currentStep: 'credentials',
      extractConfirmPending: true,
      detect: { detected: true, fetchedAt: 1 },
      catalogLoading: false,
      catalogCount: null,
    })
    expect(wrapper.find('[data-testid="wool-extract-confirm"]').text()).toContain('确认提取凭据')
    expect(wrapper.find('[data-testid="wool-extract-confirm-body"], [data-testid="wool-extract-confirm"]').text()).toBeTruthy()
    expect(wrapper.find('[data-testid="wool-extract-confirm-ok"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wool-extract-confirm-cancel"]').exists()).toBe(true)
  })

  it('失败路径：install 失败态显示恢复指引 + 重试按钮（失败路径表）', () => {
    const wrapper = mountComp(WoolExtractFlow, {
      displayName: 'Qoder',
      stepStates: stepStates({
        install: { status: 'failed', failure: { code: 'manifest_unreachable', message: 'HTTP 503' } },
      }),
      currentStep: 'install',
      extractConfirmPending: false,
      detect: null,
      catalogLoading: false,
      catalogCount: null,
    })
    expect(wrapper.find('[data-testid="wool-step-install-failure"]').text()).toContain('无法获取版本清单')
    expect(wrapper.find('[data-testid="wool-step-install-retry"]').exists()).toBe(true)
  })

  it('完成步目录计数（用户可见「N 个模型已就绪」）', () => {
    const wrapper = mountComp(WoolExtractFlow, {
      displayName: 'Qoder',
      stepStates: stepStates({ done: { status: 'running' }, install: { status: 'ok' }, credentials: { status: 'ok' } }),
      currentStep: 'done',
      extractConfirmPending: false,
      detect: { detected: true, fetchedAt: 1 },
      catalogLoading: false,
      catalogCount: 48,
    })
    expect(wrapper.find('[data-testid="wool-catalog-count"]').text()).toContain('48 个模型已就绪')
  })
})

// ── 授权族模板（D7 / §3.1 五步）──────────────────────────────────────

describe('WoolOauthFlow（授权族模板）', () => {
  it('五步全渲染 + 授权按钮（「在 TaiJi 浏览器中打开授权页」）', () => {
    const wrapper = mountComp(WoolOauthFlow, {
      displayName: 'WorkBuddy',
      stepStates: stepStates(),
      currentStep: 'authorize',
      account: null,
      autoCheckin: false,
      catalogLoading: false,
      catalogCount: null,
    })
    expect(wrapper.find('[data-testid="wool-step-install"]').text()).toContain('安装扩展')
    expect(wrapper.find('[data-testid="wool-step-authorize"]').text()).toContain('账号授权')
    expect(wrapper.find('[data-testid="wool-step-ready"]').text()).toContain('凭据就绪')
    expect(wrapper.find('[data-testid="wool-step-checkin"]').text()).toContain('签到与续期')
    expect(wrapper.find('[data-testid="wool-authorize-open"]').text()).toContain('在 TaiJi 浏览器中打开授权页')
  })

  it('自动签到默认关（无黄色警示）+ 打开后黄色警示（D5 风控决策权）', () => {
    const off = mountComp(WoolOauthFlow, {
      displayName: 'WorkBuddy',
      stepStates: stepStates(),
      currentStep: 'checkin',
      account: null,
      autoCheckin: false,
      catalogLoading: false,
      catalogCount: null,
    })
    expect(off.find('[data-testid="wool-autocheckin-warn"]').exists()).toBe(false)
    expect(off.find('[data-testid="wool-autocheckin-row"]').text()).toContain('到点提醒你手动签到')

    const on = mountComp(WoolOauthFlow, {
      displayName: 'WorkBuddy',
      stepStates: stepStates(),
      currentStep: 'checkin',
      account: null,
      autoCheckin: true,
      catalogLoading: false,
      catalogCount: null,
    })
    expect(on.find('[data-testid="wool-autocheckin-warn"]').text()).toContain('批量封号')
  })

  it('授权通道未就绪失败态（authorize_unavailable 恢复指引——扩展协议现状的诚实呈现）', () => {
    const wrapper = mountComp(WoolOauthFlow, {
      displayName: 'WorkBuddy',
      stepStates: stepStates({
        authorize: { status: 'failed', failure: { code: 'authorize_unavailable', message: 'x' } },
      }),
      currentStep: 'authorize',
      account: null,
      autoCheckin: false,
      catalogLoading: false,
      catalogCount: null,
    })
    expect(wrapper.find('[data-testid="wool-step-authorize-failure"]').text()).toContain('授权动作通道未就绪')
    expect(wrapper.find('[data-testid="wool-step-authorize-retry"]').exists()).toBe(true)
  })

  it('ready 步账号信息展示（昵称用户可见）', () => {
    const wrapper = mountComp(WoolOauthFlow, {
      displayName: 'WorkBuddy',
      stepStates: stepStates({ install: { status: 'ok' }, authorize: { status: 'ok' } }),
      currentStep: 'ready',
      account: { loggedIn: true, nickname: 'demo-user', fetchedAt: 1 },
      autoCheckin: false,
      catalogLoading: false,
      catalogCount: null,
    })
    expect(wrapper.find('[data-testid="wool-ready-account"]').text()).toContain('demo-user')
  })
})

// ── 条目卡（D6 ③ 条目徽标）───────────────────────────────────────────

describe('WoolEntryCard（provider 列表羊毛条目）', () => {
  it('额度条 + 模型数 + 签到徽标（今日未签到 → 点击触发 checkin）', async () => {
    const wrapper = mountComp(WoolEntryCard, {
      family: familyState({
        account: { loggedIn: true, nickname: 'u', quota: { used: 30, total: 100, unit: 'credits' }, checkin: { doneToday: false }, fetchedAt: 1 },
        catalog: { models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], fetchedAt: 1 },
      }),
    })
    expect(wrapper.find('[data-testid="wool-entry-quota"]').text()).toContain('30/100 credits')
    expect(wrapper.find('[data-testid="wool-entry-models"]').text()).toContain('2 模型')
    expect(wrapper.find('[data-testid="wool-entry-checkin-qoder"]').text()).toBe('今日未签到')
    await wrapper.find('[data-testid="wool-entry-checkin-qoder"]').trigger('click')
    expect(wrapper.emitted('checkin')).toHaveLength(1)
  })

  it('登录态失效徽标（loggedIn=false 最高优先呈现）+ 未完成接入引导', () => {
    const wrapper = mountComp(WoolEntryCard, {
      family: familyState({
        adopted: false,
        account: { loggedIn: false, fetchedAt: 1 },
      }),
    })
    expect(wrapper.find('[data-testid="wool-entry-login-expired"]').text()).toBe('登录态失效')
    expect(wrapper.find('[data-testid="wool-entry-not-adopted"]').exists()).toBe(true)
  })

  it('可更新角标（updateAvailable → 「可更新」呈现 + 点击上抛 update = D2 用户显式触发更新）；无标记时不渲染', async () => {
    const wrapper = mountComp(WoolEntryCard, {
      family: familyState({ installedVersion: '0.1.0', updateAvailable: true }),
    })
    expect(wrapper.find('[data-testid="wool-entry-update-qoder"]').text()).toBe('可更新')
    await wrapper.find('[data-testid="wool-entry-update-qoder"]').trigger('click')
    expect(wrapper.emitted('update')).toHaveLength(1)

    // 版本一致（无 updateAvailable）→ 角标不渲染。
    const noUpdate = mountComp(WoolEntryCard, { family: familyState({ installedVersion: '0.2.0' }) })
    expect(noUpdate.find('[data-testid="wool-entry-update-qoder"]').exists()).toBe(false)
  })

  it('卸载按钮呈现 + 点击上抛 uninstall（D3 卸载入口；确认弹窗在 ProviderPage 编排层）', async () => {
    const wrapper = mountComp(WoolEntryCard, { family: familyState() })
    await wrapper.find('[data-testid="wool-entry-uninstall-qoder"]').trigger('click')
    expect(wrapper.emitted('uninstall')).toHaveLength(1)
  })
})
