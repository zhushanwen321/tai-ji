/**
 * PlanQuotaFloatPanel 组件测试（对话流左侧套餐浮层）。
 *
 * 覆盖：展开态渲染全部 quota.enabled provider 的可见窗口用量（pct=null 窗口整格隐藏）、
 * 浮点尾数经 formatQuotaPct 定点两位、「当前」标记命中当前会话生效模型的 provider、
 * 用量分档色（≥90 红）、收起把手态与手动切换 emit、挂载即触发每 provider 查询、
 * 定时统一刷新（5min 周期，收起暂停 / 展开恢复）、quota 缓存清除自动重查、
 * 查询失败的可见反馈两态（无缓存 → 整行失败提示；有旧缓存 → 旧窗口保留 + 头部失败
 * 标记，C-proc-21）、「查询中」占位两态（未查询/在途 → 显示；已完成但三窗口 pct
 * 全 null → 不显示，占位文案失真）。
 *
 * Mock 策略（最小闭合面，quota 数据链走真实 store + useQuotaQuery）：
 * - mock `@taiji/core/transport/api/domains/quota`（getCached/fetchQuota 固定返回）；
 * - mock `@taiji/core` 的 getSettingsStore（providers 清单 + quota.enabled 标记；quotaPresets 给空清单，
 *   resolveQuotaPresets 回落内置基线——与 ProviderEditBody 的空态口径一致）；
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
import { QUOTA_FLOAT_REFRESH_INTERVAL_MS } from '../plan-quota-float'
import { useQuotaStore } from '@/stores/quota'

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

// [W1 会话架构四层分离] 当前会话模型读**状态层**（按会话 id 寄存），不再读 sessionStore.list
// 条目（applySnapshot 已不写 modelId，列表查找会使「当前」判定恒 null）。选择器入口 =
// useSessionLiveState（内部经 core createSessionLiveStateSelector 读 pinia 薄壳）——本处
// mock composable 即覆盖整条读链。
vi.mock('@/composables/features/session/useSessionLiveState', async () => {
  const { computed } = await import('vue')
  return {
    useSessionLiveState: (sessionIdRef: { value: string | null }) => ({
      liveState: computed(() =>
        sessionIdRef.value === 's1' ? { modelId: 'zai-coding-cn/glm-5.3' } : undefined,
      ),
      modelId: computed(() =>
        sessionIdRef.value === 's1' ? 'zai-coding-cn/glm-5.3' : undefined,
      ),
      thinkingLevel: computed(() => undefined),
    }),
  }
})

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

/**
 * 挂载浮层并断言 kimi 项窗口态（row 无可用窗口的两用例共用装配）：
 * pct 窗口数 0 + 「查询中」占位按 queryingExpected 显隐。
 */
async function expectKimiEmptyRow(queryingExpected: boolean) {
  const wrapper = mountFloat()
  await flushPromises()
  const item = wrapper.find('[data-testid="plan-quota-item-kimi-coding"]')
  expect(item.findAll('[data-testid="plan-quota-pct"]').length).toBe(0)
  expect(item.find('[data-testid="plan-quota-querying"]').exists()).toBe(queryingExpected)
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
  settingsMock.getSettingsStore.mockReturnValue({ providers: ref(ENABLED_PROVIDERS), quotaPresets: ref([]) })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('PlanQuotaFloatPanel', () => {
  it('展开态渲染全部套餐的可见窗口（pct=null 的窗口整格隐藏）', async () => {
    const wrapper = mountFloat()
    await flushPromises()

    const body = wrapper.find('[data-testid="plan-quota-body"]')
    expect(body.exists()).toBe(true)
    // 两个 provider 各一项
    expect(wrapper.find('[data-testid="plan-quota-item-kimi-coding"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-quota-item-zai-coding-cn"]').exists()).toBe(true)
    // kimi 窗口：5h 100% / 本周 73%（本月 pct=null → 整格不渲染，非「—」占位）
    const kimiPcts = wrapper
      .findAll('[data-testid="plan-quota-item-kimi-coding"] [data-testid="plan-quota-pct"]')
      .map((w) => w.text())
    expect(kimiPcts).toEqual(['100%', '73%'])
    // zai 窗口：仅 5h 33%
    const zaiPcts = wrapper
      .findAll('[data-testid="plan-quota-item-zai-coding-cn"] [data-testid="plan-quota-pct"]')
      .map((w) => w.text())
    expect(zaiPcts).toEqual(['33%'])
  })

  it('浮点尾数经 formatQuotaPct 定点两位（14.999… → 15%，不暴露原始尾数）', async () => {
    quotaApiMock.fetchQuota.mockImplementation(async () => ({
      data: row([14.999999333333334, 73.456, 0.005]),
      lastFetchAt: 1_700_000_000_000,
    }))
    const wrapper = mountFloat()
    await flushPromises()

    const pcts = wrapper
      .findAll('[data-testid="plan-quota-item-kimi-coding"] [data-testid="plan-quota-pct"]')
      .map((w) => w.text())
    expect(pcts).toEqual(['15%', '73.46%', '0.01%'])
  })

  it('三窗口全部 pct=null：不渲染空窗口行，也不渲染「查询中」占位（查询已完成，占位文案失真）', async () => {
    quotaApiMock.fetchQuota.mockImplementation(async () => ({
      data: row([null, null, null]),
      lastFetchAt: 1_700_000_000_000,
    }))
    // row 非 null（查询已完成）→ 占位分支不触发，与 ContextCapacityCard 同口径
    await expectKimiEmptyRow(false)
  })

  it('未查询 / 在途态（row 无缓存且无失败）显示「查询中」占位', async () => {
    // fetch 永不 resolve：entry 保持 undefined → row === null ∧ error === null
    quotaApiMock.fetchQuota.mockImplementation(() => new Promise(() => {}))
    await expectKimiEmptyRow(true)
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

  it('用量 ≥90% 的窗口转 danger 色（环保持原色；百分比文字走提亮档 --danger-text）', async () => {
    const wrapper = mountFloat()
    await flushPromises()

    const kimi5hRing = wrapper.find('[data-testid="plan-quota-ring-kimi-coding-0"]')
    expect(kimi5hRing.classes()).toContain('text-danger')
    const kimi5hPct = wrapper.find('[data-testid="plan-quota-cell-kimi-coding-0"] [data-testid="plan-quota-pct"]')
    expect(kimi5hPct.classes()).toContain('text-[color:var(--danger-text)]')
    const zai5hRing = wrapper.find('[data-testid="plan-quota-ring-zai-coding-cn-0"]')
    expect(zai5hRing.classes()).not.toContain('text-danger')
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

  it('查询失败且有旧缓存：旧窗口数据仍渲染 + 失败标记可见（error 与旧数据并存，C-proc-21）', async () => {
    // 旧缓存来自 getCached（runtime 内存里的最后成功值），本次 fetch 失败（带 reason，A2-4 契约）：
    // useQuotaQuery 先以 cached 填 store，再 setError 保留旧 data —— data≠null ∧ error≠null 态
    quotaApiMock.getCached.mockImplementation(async (pid: string) => ({
      data: QUOTA_DATA[pid] ?? null,
      lastFetchAt: 1_700_000_000_000,
    }))
    quotaApiMock.fetchQuota.mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
    const wrapper = mountFloat()
    await flushPromises()

    // 旧窗口数据保留（不被失败整行替换）
    const kimiPcts = wrapper
      .findAll('[data-testid="plan-quota-item-kimi-coding"] [data-testid="plan-quota-pct"]')
      .map((w) => w.text())
    expect(kimiPcts).toEqual(['100%', '73%'])
    // 每个 provider 恰有一个可见失败标记（头部紧凑标记；整行失败提示不出现）
    const errors = wrapper.findAll('[data-testid="plan-quota-error"]')
    expect(errors).toHaveLength(2)
    const kimiMark = wrapper.find('[data-testid="plan-quota-item-kimi-coding"] [data-testid="plan-quota-error"]')
    expect(kimiMark.exists()).toBe(true)
    // 失败原因经 title / aria-label 可达（复用 queryFailed 句式）
    expect(kimiMark.attributes('title')).toContain('查询失败')
    expect(kimiMark.attributes('aria-label')).toContain('查询失败')
    // 整行失败提示属无缓存形态，此处不应出现
    expect(wrapper.text()).not.toContain(i18n.global.t('panel.quotaFloat.fetchFailed'))
  })

  it('定时统一刷新：挂载期间每 5 分钟全部套餐重查，收起态暂停、展开恢复', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountFloat()
      await flushPromises()
      expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(2) // 仅挂载首查

      // 未到 5min 间隔：不刷新
      await vi.advanceTimersByTimeAsync(QUOTA_FLOAT_REFRESH_INTERVAL_MS - 1)
      expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(2)

      // 到 5min：全部 provider 重查
      await vi.advanceTimersByTimeAsync(1)
      await flushPromises()
      expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(4)

      // 收起：定时器暂停（不可见期间的查询无人消费）
      await wrapper.setProps({ collapsed: true })
      await vi.advanceTimersByTimeAsync(QUOTA_FLOAT_REFRESH_INTERVAL_MS * 2)
      expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(4)

      // 展开：定时器恢复
      await wrapper.setProps({ collapsed: false })
      await vi.advanceTimersByTimeAsync(QUOTA_FLOAT_REFRESH_INTERVAL_MS)
      await flushPromises()
      expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(6)

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('quota 缓存被清除（如设置页类型切换）：对应 provider 自动重查', async () => {
    const wrapper = mountFloat()
    await flushPromises()
    expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(2)

    const store = useQuotaStore()
    store.clearCache('kimi-coding')
    await flushPromises()

    expect(quotaApiMock.fetchQuota).toHaveBeenCalledTimes(3)
    expect(quotaApiMock.fetchQuota).toHaveBeenLastCalledWith('kimi-coding')
  })

  it('无满足条件 provider 时浮层整体不渲染', () => {
    settingsMock.getSettingsStore.mockReturnValue({ providers: ref([{ id: 'p1', name: 'P1', baseUrl: 'https://x' }]), quotaPresets: ref([]) })
    const wrapper = mountFloat()
    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
  })
})
