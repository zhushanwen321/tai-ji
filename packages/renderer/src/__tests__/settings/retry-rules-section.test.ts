/**
 * SystemRetryRulesSection 测试（subagent-observability §3.3.12 / UC-23，三视角）。
 *
 * 覆盖：
 *  - 首屏渲染：mock getRetryRules → 内置折叠区计数 + 自定义行回填（id/name/verdict/pattern）；
 *  - 内置预设 verdict 徽标（retryable / non_retryable 双档 + source 标注）；
 *  - 保存 round-trip：添加规则 → 组装载荷（source:'custom'、单条件 match、waitHint 传参）
 *    → setRetryRules 调用 + 成功 toast（savedToastKey 通道）；
 *  - 保存校验拒绝：空正则 → setRetryRules 不被调 + 错误 toast（shared 域信封文案透传）；
 *  - 多条件存量规则行锁：编辑控件 disabled + 锁定提示；锁定行保存原样透传
 *    （多条件规则字段逐字保留——写侧 customRules 整段替换，载荷缺行 = 删除该规则）；
 *  - 停用等效文案在位（§3.3.12 停用通道登记：关闭上方卡开关 / maxRetries=0）。
 *
 * mock 策略：SettingsTransport seam 桩（同 llm-retry-section.test.ts）+ useToast mock。
 *
 * 运行：npx vitest run src/__tests__/settings/retry-rules-section.test.ts（packages/renderer 目录）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'

const configApiMock = vi.hoisted(() => ({
  getRetryRules: vi.fn(),
  setRetryRules: vi.fn(),
  onRetryRules: vi.fn(() => () => {}),
}))
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: vi.fn() }),
}))

import SystemRetryRulesSection from '@/components/settings/system/SystemRetryRulesSection.vue'
import zhCN from '@taiji/ui/locale/zh-CN/settings'
import type { RetryableErrorRule } from '@taiji/shared'

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN.default ?? zhCN } },
  })
}

function builtinRule(overrides: Partial<RetryableErrorRule>): RetryableErrorRule {
  return {
    id: 'zhipu-1302',
    name: '智谱 1302 速率限制',
    verdict: 'retryable',
    match: [{ kind: 'jsonPath', path: 'error.code', operator: 'equals', value: '1302' }],
    class: 'provider',
    source: 'builtin',
    ...overrides,
  }
}

function defaultFixture(): { builtinRules: RetryableErrorRule[]; customRules: RetryableErrorRule[] } {
  return {
    builtinRules: [
      builtinRule({}),
      builtinRule({ id: 'generic-quota', name: '配额耗尽', verdict: 'non_retryable', match: [{ kind: 'pattern', pattern: 'insufficient_quota' }] }),
    ],
    customRules: [
      builtinRule({ id: 'my-rule', name: '我的规则', verdict: 'conditional', source: 'custom', match: [{ kind: 'pattern', pattern: 'my-code' }], waitHint: '等窗口重置' }),
    ],
  }
}

function mountSection() {
  return mount(SystemRetryRulesSection, {
    global: { plugins: [makeI18n()] },
  })
}

async function setInput(wrapper: ReturnType<typeof mount>, testid: string, value: string) {
  const input = wrapper.find(`[data-testid="${testid}"]`)
  ;(input.element as HTMLInputElement).value = value
  await input.trigger('input')
  await input.trigger('change')
}

beforeEach(() => {
  vi.clearAllMocks()
  configApiMock.getRetryRules.mockResolvedValue(defaultFixture())
  configApiMock.setRetryRules.mockResolvedValue(defaultFixture())
  provideSettingsTransport(makeSettingsTransportStub(configApiMock))
})

describe('首屏渲染（读侧）', () => {
  it('内置预设计数与自定义行回填', async () => {
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="retry-rules-builtin-toggle"]').text()).toContain('2')
    expect(wrapper.find('[data-testid="retry-rules-id-0"]').element as HTMLInputElement).toBeTruthy()
    expect((wrapper.find('[data-testid="retry-rules-id-0"]').element as HTMLInputElement).value).toBe('my-rule')
    expect((wrapper.find('[data-testid="retry-rules-name-0"]').element as HTMLInputElement).value).toBe('我的规则')
    expect((wrapper.find('[data-testid="retry-rules-pattern-0"]').element as HTMLInputElement).value).toBe('my-code')
  })

  it('verdict 徽标双档 + 停用等效文案在位（UC-23 展示 + §3.3.12 停用通道文案）', async () => {
    const wrapper = mountSection()
    await flushPromises()
    // 内置预设区默认收起（CollapsibleContent 卸载态不渲染），展开后断言徽标
    await wrapper.find('[data-testid="retry-rules-builtin-toggle"]').trigger('click')
    await flushPromises()
    const badges = wrapper.findAll('[data-testid="retry-rules-verdict-badge"]')
    expect(badges).toHaveLength(2)
    expect(wrapper.find('[data-testid="retry-rules-disable-hint"]').exists()).toBe(true)
  })
})

describe('保存 round-trip（写侧）', () => {
  it('添加规则 → 保存组装载荷（source custom + 单条件 match + waitHint）+ 成功 toast', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('[data-testid="retry-rules-add"]').trigger('click')
    const idx = 1
    await setInput(wrapper, `retry-rules-id-${idx}`, 'new-rule')
    await setInput(wrapper, `retry-rules-name-${idx}`, '新规则')
    await setInput(wrapper, `retry-rules-pattern-${idx}`, 'new-code-42')
    await setInput(wrapper, `retry-rules-waithint-${idx}`, '稍等重试')
    await wrapper.find('[data-testid="retry-rules-save-btn"]').trigger('click')
    await flushPromises()
    expect(configApiMock.setRetryRules).toHaveBeenCalledTimes(1)
    const payload = configApiMock.setRetryRules.mock.calls[0][0] as RetryableErrorRule[]
    expect(payload).toHaveLength(2)
    const added = payload.find((r) => r.id === 'new-rule')
    expect(added?.source).toBe('custom')
    expect(added?.verdict).toBe('retryable')
    expect(added?.match).toEqual([{ kind: 'pattern', pattern: 'new-code-42' }])
    expect(added?.waitHint).toBe('稍等重试')
    expect(toastMock.info).toHaveBeenCalled()
  })

  it('校验拒绝（空正则）：setRetryRules 不被调 + 错误 toast', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('[data-testid="retry-rules-add"]').trigger('click')
    await setInput(wrapper, 'retry-rules-id-1', 'bad-rule')
    await setInput(wrapper, 'retry-rules-name-1', '坏规则')
    // pattern 留空 → validateRetryRuleFields 拒绝
    await wrapper.find('[data-testid="retry-rules-save-btn"]').trigger('click')
    await flushPromises()
    expect(configApiMock.setRetryRules).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalled()
  })

  it('id 重复拒绝（与既有自定义行同 id）', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('[data-testid="retry-rules-add"]').trigger('click')
    await setInput(wrapper, 'retry-rules-id-1', 'my-rule')
    await setInput(wrapper, 'retry-rules-name-1', '重名')
    await setInput(wrapper, 'retry-rules-pattern-1', 'x')
    await wrapper.find('[data-testid="retry-rules-save-btn"]').trigger('click')
    await flushPromises()
    expect(configApiMock.setRetryRules).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalled()
  })
})

describe('多条件存量规则行锁', () => {
  /** 多条件 custom 存量规则（含可选字段——逐字保留断言的比对基准）。 */
  function multiMatchRule(overrides: Partial<RetryableErrorRule> = {}): RetryableErrorRule {
    return {
      id: 'multi',
      name: '多条件规则',
      verdict: 'conditional',
      match: [{ kind: 'pattern', pattern: 'a' }, { kind: 'jsonPath', path: 'error.code', operator: 'equals', value: '1302' }],
      class: 'provider',
      kind: 'rate_limited',
      httpStatusClass: 429,
      waitHint: '等窗口重置',
      source: 'custom',
      ...overrides,
    }
  }

  it('match 多条件行编辑控件 disabled + 锁定提示（防单条件编辑器丢条件）', async () => {
    configApiMock.getRetryRules.mockResolvedValue({
      builtinRules: [],
      customRules: [multiMatchRule()],
    })
    const wrapper = mountSection()
    await flushPromises()
    const idInput = wrapper.find('[data-testid="retry-rules-id-0"]')
    expect((idInput.element as HTMLInputElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="retry-rules-locked-0"]').exists()).toBe(true)
  })

  it('锁定行保存原样透传：多条件 custom 规则经保存字段逐字保留（写侧 customRules 整段替换，载荷缺行 = 删除该规则）', async () => {
    const rule = multiMatchRule()
    configApiMock.getRetryRules.mockResolvedValue({ builtinRules: [], customRules: [rule] })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('[data-testid="retry-rules-save-btn"]').trigger('click')
    await flushPromises()
    expect(configApiMock.setRetryRules).toHaveBeenCalledTimes(1)
    const payload = configApiMock.setRetryRules.mock.calls[0][0] as RetryableErrorRule[]
    expect(payload).toHaveLength(1)
    // 逐字保留：不经单条件编辑面重建，读回原对象透传（match 两条件 + 可选字段全部在位）
    expect(payload[0]).toEqual(rule)
    expect(payload[0].match).toHaveLength(2)
  })

  it('锁定行与新增行混合保存：锁行原文与新编辑行同载荷', async () => {
    const rule = multiMatchRule({ id: 'multi', name: '多条件规则' })
    configApiMock.getRetryRules.mockResolvedValue({ builtinRules: [], customRules: [rule] })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('[data-testid="retry-rules-add"]').trigger('click')
    await setInput(wrapper, 'retry-rules-id-1', 'new-rule')
    await setInput(wrapper, 'retry-rules-name-1', '新规则')
    await setInput(wrapper, 'retry-rules-pattern-1', 'new-code')
    await wrapper.find('[data-testid="retry-rules-save-btn"]').trigger('click')
    await flushPromises()
    expect(configApiMock.setRetryRules).toHaveBeenCalledTimes(1)
    const payload = configApiMock.setRetryRules.mock.calls[0][0] as RetryableErrorRule[]
    expect(payload).toHaveLength(2)
    expect(payload[0]).toEqual(rule)
    expect(payload[1].id).toBe('new-rule')
    expect(payload[1].match).toEqual([{ kind: 'pattern', pattern: 'new-code' }])
  })
})
