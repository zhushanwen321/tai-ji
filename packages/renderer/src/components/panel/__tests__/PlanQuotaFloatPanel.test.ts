/**
 * PlanQuotaFloatPanel 组件测试（对话流左侧套餐浮层）。
 *
 * 覆盖：展开态渲染全部 quota.enabled provider 的三窗口用量（含无数据窗口「—」）、
 * 「当前」标记命中当前会话生效模型的 provider、用量分档色（≥90 红）、收起把手态
 * 与手动切换 emit、挂载即触发每 provider 查询、查询失败且无缓存的显式失败行。
 *
 * Mock 策略（最小闭合面，quota 数据链走真实 store + useQuotaQuery）：
 * - mock `@taiji/core/transport/api/domains/quota`（getCached/fetchQuota 固定返回）；
 * - mock `@taiji/core` 的 getSettingsStore（providers 清单 + quota.enabled 标记）；
 * - mock `@/stores/session`（当前会话 modelId 的 provider 段）；
 * - i18n 用全局真实实例（panel.quotaFloat / panel.context 键组在 ui locale 域文件）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/PlanQuotaFloatPanel.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { NormalizedQuotaRow, QuotaWindow } from '@taiji/shared'
import i18n from '@/i18n'
import PlanQuotaFloatPanel from '../PlanQuotaFloatPanel.vue'

// ── mock 面 ────────────────────────────────────────────────────────

const quotaApiMock = vi.hoisted(() => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/quota', () => quotaApiMock)

const settingsMock = vi.hoisted(() => ({
  getSettingsStore: vi.fn(),
}))
vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  getSettingsStore: settingsMock.getSettingsStore,
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    list: [{ id: 's1', modelId: 'zai-coding-cn/glm-5.3' }],
  }),
}))

// ── 数据构造 ───────────────────────────────────────────────────────

function win(pct: number | null): QuotaWindow {
  return {
    pct,
    resetSec: pct === null ? null : 3600,
    used: pct === null ? undefined : pct,
    limit: pct === null ? undefined : 100,
    unit: pct === null ? undefined : 'requests',
  }
}

function row(pcts: [number | null, number | null, number | null]): NormalizedQuotaRow {
  return { label: 'mock plan', wins: [win(pcts[0]), win(pcts[1]), win(pcts[2])] }
}

/** providerId → 额度行（fetchQuota mock 的数据源）。 */
const QUOTA_DATA: Record<string, NormalizedQuotaRow> = {
  'kimi-coding': row([100, 73, null]),
  'zai-coding-cn': row([33, null, null]),
}

const ENABLED_PROVIDERS = [
  { id: 'kimi-coding', name: 'Kimi Coding', baseUrl: 'https://api.moonshot.cn', quota: { enabled: true } },
  { id: 'zai-coding-cn', name: 'Z.ai-pro', baseUrl: 'https://open.bigmodel.cn', quota: { enabled: true } },
]

// ── 挂载 helper ────────────────────────────────────────────────────

function mountFloat(props?: Partial<{ sessionId: string | null; collapsed: boolean }>) {
  return mount(PlanQuotaFloatPanel, {
    props: { sessionId: 's1', collapsed: false, ...props },
    global: { plugins: [i18n] },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  quotaApiMock.getCached.mockReset()
  quotaApiMock.fetchQuota.mockReset()
  quotaApiMock.getCached.mockResolvedValue({ data: null, lastFetchAt: null })
  quotaApiMock.fetchQuota.mockImplementation(async (pid: string) => {
    const data = QUOTA_DATA[pid]
    return data ? { data, lastFetchAt: 1_700_000_000_000 } : { data: null, lastFetchAt: null, reason: 'network' }
  })
  settingsMock.getSettingsStore.mockReset()
  settingsMock.getSettingsStore.mockReturnValue({ providers: ref(ENABLED_PROVIDERS) })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('PlanQuotaFloatPanel', () => {
  it('展开态渲染全部套餐的三窗口用量（含无数据窗口显示 —）', async () => {
    const wrapper = mountFloat()
    await flushPromises()

    const body = wrapper.find('[data-testid="plan-quota-body"]')
    expect(body.exists()).toBe(true)
    // 两个 provider 各一项
    expect(wrapper.find('[data-testid="plan-quota-item-kimi-coding"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-quota-item-zai-coding-cn"]').exists()).toBe(true)
    // kimi 三窗口：100% / 73% / 无数据 —
    const kimiPcts = wrapper
      .findAll('[data-testid="plan-quota-item-kimi-coding"] [data-testid="plan-quota-pct"]')
      .map((w) => w.text())
    expect(kimiPcts).toEqual(['100%', '73%', '—'])
    // zai 三窗口：33% / — / —
    const zaiPcts = wrapper
      .findAll('[data-testid="plan-quota-item-zai-coding-cn"] [data-testid="plan-quota-pct"]')
      .map((w) => w.text())
    expect(zaiPcts).toEqual(['33%', '—', '—'])
  })

  it('「当前」标记落在当前会话生效模型所属 provider（zai-coding-cn）', async () => {
    const wrapper = mountFloat()
    await flushPromises()

    const tags = wrapper.findAll('[data-testid="plan-quota-current-tag"]')
    expect(tags).toHaveLength(1)
    // 标记位于 zai 项内（kimi 项内无）
    expect(wrapper.find('[data-testid="plan-quota-item-zai-coding-cn"] [data-testid="plan-quota-current-tag"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-quota-item-kimi-coding"] [data-testid="plan-quota-current-tag"]').exists()).toBe(false)
  })

  it('用量 ≥90% 的窗口转 danger 色', async () => {
    const wrapper = mountFloat()
    await flushPromises()

    const kimi5hFill = wrapper.find('[data-testid="plan-quota-bar-kimi-coding-0"] div')
    expect(kimi5hFill.classes()).toContain('bg-danger')
    const zai5hFill = wrapper.find('[data-testid="plan-quota-bar-zai-coding-cn-0"] div')
    expect(zai5hFill.classes()).not.toContain('bg-danger')
  })

  it('collapsed=true 渲染收起把手（列表隐藏），点击把手发发展开事件', async () => {
    const wrapper = mountFloat({ collapsed: true })
    await flushPromises()

    const rail = wrapper.find('[data-testid="plan-quota-rail"]')
    expect(rail.exists()).toBe(true)
    // v-show 的隐藏效果直接断言 display（用户不可见）
    expect(wrapper.find('[data-testid="plan-quota-body"]').attributes('style')).toContain('display: none')

    await rail.trigger('click')
    expect(wrapper.emitted('update:userCollapsed')).toEqual([[false]])
  })

  it('展开态点击折叠钮发出收起事件', async () => {
    const wrapper = mountFloat()
    await flushPromises()

    await wrapper.find('[data-testid="plan-quota-collapse"]').trigger('click')
    expect(wrapper.emitted('update:userCollapsed')).toEqual([[true]])
  })

  it('挂载即触发每个 provider 的一次查询', async () => {
    mountFloat()
    await flushPromises()

    expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(2)
    expect(quotaApiMock.fetchQuota).toHaveBeenCalledWith('kimi-coding')
    expect(quotaApiMock.fetchQuota).toHaveBeenCalledWith('zai-coding-cn')
  })

  it('查询失败且无旧缓存时渲染显式失败行（不静默空白）', async () => {
    quotaApiMock.fetchQuota.mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
    const wrapper = mountFloat()
    await flushPromises()

    const errors = wrapper.findAll('[data-testid="plan-quota-error"]')
    expect(errors).toHaveLength(2)
  })

  it('无满足条件 provider 时浮层整体不渲染', () => {
    settingsMock.getSettingsStore.mockReturnValue({ providers: ref([{ id: 'p1', name: 'P1', baseUrl: 'https://x' }]) })
    const wrapper = mountFloat()
    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
  })
})
