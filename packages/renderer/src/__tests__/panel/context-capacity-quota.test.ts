/**
 * 指标聚合页 coding-plan 区测试（w4；ui-optimize 决策 6 起宿主 = ComposerMetricsAggregate）。
 *
 * [迁移来源] 原宿主为平铺触发器 ContextCapacityPopover（决策 6 退役、组件已删除）——
 * quota 查询触发（hover-enter）与聚合页内容在指标聚合按钮上同构存在（同 HoverCard 结构 +
 * 同 onHoverEnter 挂载），mount 宿主与触发器锚（title → data-testid）随之切换。
 *
 * 覆盖 w4（Composer hover 合并浮层）新增的 coding-plan 额度显示：
 * - hover-enter 触发 quota 查询（先 cached 后 fetch）
 * - provider 未配置额度 → 不调 quota API
 * - 容量区零回归
 *
 * 注意：HoverCardContent 渲染在 reka-ui HoverCardPortal 内，
 * happy-dom 环境下 portal 内容不渲染（hover 状态不触发）。
 * 窗口行渲染、分档配色等视觉测试需 E2E 或浏览器环境验证。
 * 本测试聚焦于：数据流（quota API 调用）+ 容量区回归。
 * 本分支新增：D11 失败态 footer 双入口（刷新 + 配置，66d415f41 / U5）与布局结构断言
 * （f51474d83：两个恢复动作同组贴右端，结构断言不依赖像素坐标）——见「刷新 / 失败态 DOM」describe。
 *
 * mock 策略：vi.mock('@/api') + vi.mock('@taiji/core/transport/api/domains/quota') 替换 RPC，
 * mount 组件 + 手动设置 session/settings store 状态。
 *
 * 单文件多源合并（3 源同装载簇）：context-capacity-quota（本节，最大源）+
 * detail-selection-bubble + block-rendering-regression——vitest 按测试文件隔离模块图，
 * 合并让全部用例共享一份组件树装载与环境初始化。未并入：thinking-md-variant.test.ts
 * （其 `@vitest-environment jsdom` pragma 与包默认 happy-dom 环境冲突，且本文件 quota 区
 * 用例的 portal 断言设计依赖 happy-dom 行为——环境实质冲突，保持独立）。detail 节的
 * useDetailPane/useCopy/useChatViewDeps 等 mock 只覆盖 DetailPane 依赖集（DetailPane
 * 不直接 import '@/api'，与 quota 节 @/api 全量 mock 无交互）；block 节经 mockChatProvide
 * 注入，不经模块 mock。各节以裸块隔离节内 helper。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-capacity-quota.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive, ref } from 'vue'
import type { NormalizedQuotaRow, ProviderId, ProviderInfo, Message } from '@taiji/shared'
import { Turn } from '@taiji/ui'
import { apiConfigDomainMock } from '../helpers/api-facade-mock'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import DetailPane from '@/components/panel/DetailPane.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

// ── mock ──

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }) },
  // session.getContext：组件经 useContextUsage 恢复路径挂载即调（Phase 2.2 纯读改造）——
  // mock 为永不 resolve 的 pending（本文件只测 quota 区与帧直驱显示，恢复路径行为在
  // use-context-usage.test.ts / context-usage-journeys.test.ts 覆盖）
  session: { getContext: vi.fn(() => new Promise(() => {})) },
  // config 域基座单源在 helpers/api-facade-mock.ts（on* 订阅家族 + terminal 读写基线）
  config: apiConfigDomainMock(),
  model: { onModels: vi.fn(() => () => {}) },
  extension: { onExtensions: vi.fn(() => () => {}) },
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: '' })),
    updateSystem: vi.fn(async () => {}),
  },
}))

vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
  refreshQuota: vi.fn(),
  configure: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
  // useQuotaQuery 的 quotaFailReasonText 经 i18n.global.t 映射 reason 文案（mock 返回 key 本身）
  default: { global: { t: (key: string) => key } },
}))

// ── detail-selection-bubble 节的 mock（useDetailPane 可控 state + 选区 bubble 依赖集）──
// 可配置的 detail state（测试切换 viewMode/content）
const detailState = ref({
  path: 'src/foo.ts',
  content: 'line1\nline2\nline3\nline4',
  viewMode: 'preview',
  kind: 'code',
  status: 'success',
  hasGitChange: false,
})
vi.mock('@/composables/features/file-tree/useDetailPane', () => ({
  useDetailPane: () => ({
    state: detailState,
    tabs: ref([]),
    activePath: ref(null),
    toggleView: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    saveScroll: vi.fn(),
    sessionCwd: () => '/cwd',
  }),
}))
vi.mock('@/composables/panel/useCopy', () => ({
  useCopy: () => ({ copied: ref(null), copy: vi.fn() }),
}))
vi.mock('@/composables/logic/file-type', () => ({ extToLang: () => 'ts' }))
vi.mock('@/lib/path-utils', () => ({ resolvePreviewPath: () => ({ absolute: '/cwd/src/foo.ts' }) }))

// [w6 chat-ui-and-shell T7] DetailPane 壳 provide 真 deps（useChatViewDeps）→ mock 该装配器（原 vi.mock 旧组件路径失效，改模板按名 stub）
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/components/panel/detail-renderers/CodeBlock.vue', () => ({
  default: { template: '<div />' },
}))

import ComposerMetricsAggregate from '@/components/panel/ComposerMetricsAggregate.vue'
import ContextCapacityCard from '@/components/panel/ContextCapacityCard.vue'
import { useSessionStore } from '@/stores/session'
import { getSettingsStore, provideSettingsStore, createSettingsStore } from '@taiji/core'
import { useQuotaStore } from '@/stores/quota'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import * as events from '@taiji/core/transport/api'

beforeEach(() => {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  vi.clearAllMocks()
})

// ── fixtures ──

const zhipuProvider: ProviderInfo = {
  id: 'zhipu' as ProviderId,
  name: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api',
  apiKeySet: true,
  status: 'connected',
  models: [{ id: 'glm-4', name: 'GLM-4.6', contextWindow: 200000 }],
  quota: { fetcher: 'zhipu', enabled: true },
}

const deepseekProvider: ProviderInfo = {
  id: 'deepseek' as ProviderId,
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKeySet: true,
  status: 'connected',
  models: [{ id: 'v3', name: 'DeepSeek V3', contextWindow: 128000 }],
  // 无 quota 配置
}

const mockQuotaRow: NormalizedQuotaRow = {
  label: 'Zhipu Coding Plan',
  wins: [
    { pct: 68, resetSec: 4980 },
    { pct: 42, resetSec: 266400 },
    { pct: null, resetSec: null },
  ],
}

/** 设置 session store 有一个 session */
function setupSession(sid: string): void {
  const sessionStore = useSessionStore()
  sessionStore.groups = [{
    cwd: '/test',
    sessions: [{
      id: sid,
      label: 'test',
      cwd: '/test',
      status: 'active' as const,
      lastActiveAt: Date.now(),
    }],
  }]
}

/** 设置 settings store 的 providers */
function setupProviders(providers: ProviderInfo[]): void {
  const settingsStore = getSettingsStore()
  settingsStore.providers.value = providers
}

/** 推送 context.update 消息 */
function pushContextUpdate(sid: string, data: { inputTokens: number; contextLimit: number; usagePercent: number }): void {
  events.dispatchSession(sid, {
    type: 'context.update',
    id: 'ctx-1',
    payload: { sessionId: sid, ...data },
  })
}

// ── tests ──

describe('ComposerMetricsAggregate coding-plan 区', () => {
  describe('hover-enter 查询触发', () => {
    it('hover 按钮 + provider 命中 quota preset → 调 getCached + fetchQuota', async () => {
      setupProviders([zhipuProvider])
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 1000 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 2000 })

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      // hover 按钮触发查询
      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    })

    it('provider 未配置 quota → 不调 quota API', async () => {
      setupProviders([deepseekProvider])

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'deepseek/v3' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
      expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
    })

    it('provider quota enabled=false → 不调 quota API', async () => {
      const disabledProvider: ProviderInfo = {
        ...zhipuProvider,
        quota: { fetcher: 'zhipu', enabled: false },
      }
      setupProviders([disabledProvider])

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
    })

    it('无 modelId → 不调 quota API（未确定模型时不查 quota）', async () => {
      setupProviders([zhipuProvider])

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
    })

    it('[landing] sessionId=undefined 但 modelId 受控下发命中已启用 quota 的 provider → 查 quota API', async () => {
      // [HISTORICAL] 回归：landing composer（sessionId=undefined）之前永远显「未配置」，
      // 因为旧实现只在有 sessionId 时自查 sessionStore 查 modelId。重构为受控范式后，
      // Composer 直接下发 modelId（landing 态由 useComposerModelThinking fallback 到 defaultModel），
      // 子组件不再自查 store。只要 modelId 命中已启用 quota 的 provider 即查。
      setupProviders([zhipuProvider])

      const wrapper = mount(ComposerMetricsAggregate, {
        // landing 态：sessionId=undefined，但 modelId 受控下发
        props: { sessionId: 's1', modelId: 'zhipu/glm-4.6' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    })
  })

  // 未配置态「配置」按钮无独立用例：同文件下方 D11 边界用例（provider 未命中 quota →
  // footer 只有「配置」）经 focus+advanceTimersByTimeAsync 打开 popover，以更强的
  // findBodyButton 断言守护同一契约（2026-10-20 垃圾测试审计 D 类裁决删除原弱断言用例）

  describe('quota store 写入', () => {
    it('hover 后 quota store 写入缓存数据', async () => {
      setupSession('s1')
      setupProviders([zhipuProvider])
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 1000 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 2000 })

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      const quotaStore = useQuotaStore()
      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
      expect(entry!.lastFetchAt).toBe(2000)
    })

    it('quota API 失败时仍保留旧缓存', async () => {
      setupProviders([zhipuProvider])
      // 先预填旧缓存
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)

      // getCached 返回旧值，fetchQuota 失败
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 500 })
      vi.mocked(quotaApi.fetchQuota).mockRejectedValue(new Error('network'))

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      // 旧缓存应保留（fetchQuota 失败，但 getCached 已先写入）
      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
    })

    it('fetch fulfilled 带 reason（A2-4 失败态）→ 保留旧 data + 写 reason 文案，不覆写为 null', async () => {
      // [HISTORICAL] 回归检查（BL round1 #3）：runtime 失败契约是 data=null + reason
      // （非旧缓存 data），消费侧曾把旧缓存覆写为 null 且清空 error——失败既不显提示也不留旧值
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)

      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 500 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: 500, reason: 'unauthorized' })

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
      expect(entry!.error).toBe('panel.context.quotaFailUnauthorized')
    })
  })

  describe('刷新 / 失败态 DOM（A2-4 reason 消费 + D11 双入口）', () => {
    /**
     * 打开 popover：HoverCardContent 渲染在 reka-ui HoverCardPortal（document.body）。
     * trigger('focus') → reka onFocus → onOpen（openDelay 700ms 后 open=true）。
     * 只 fake setTimeout/clearTimeout（reka open 计时器），microtask 不受影响。
     * @param openSettings - AppShell provide('openSettings') 的测试替身（断言 D11「配置」入口可达）
     */
    async function openPopover(openSettings: () => void = () => {}): Promise<ReturnType<typeof mount>> {
      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'zhipu/glm-4' },
        attachTo: document.body,
        global: { provide: { openSettings } },
      })
      await flushPromises()
      await wrapper.find('[data-testid="composer-metrics-aggregate"]').trigger('focus')
      await vi.advanceTimersByTimeAsync(700)
      await flushPromises()
      return wrapper
    }

    /** body 内全部按钮中找文本等于指定值的（portal 内容不在 wrapper 内） */
    function findBodyButton(text: string): HTMLButtonElement | undefined {
      return Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === text,
      )
    }

    /**
     * 刷新三分支用例公共骨架：打开 popover → 点「刷新」→ flush → 读回 store entry。
     * afterOpen 在点击前回调（插入点击前的 DOM 前置锚断言）；entry 的 toBeDefined
     * 断言在此单源执行。返回 wrapper 供用例收尾 unmount 与后续 DOM 断言。
     */
    async function refreshAndReadEntry(afterOpen?: () => void): Promise<{
      wrapper: ReturnType<typeof mount>
      entry: NonNullable<ReturnType<ReturnType<typeof useQuotaStore>['getEntry']>>
    }> {
      const wrapper = await openPopover()
      afterOpen?.()
      const refreshBtn = findBodyButton('刷新')
      expect(refreshBtn).toBeTruthy()
      refreshBtn!.click()
      await flushPromises()
      const entry = useQuotaStore().getEntry('zhipu')
      expect(entry).toBeDefined()
      return { wrapper, entry: entry! }
    }

    /**
     * 失败态 popover 用例共同开场：seed 旧数据 + 置 network error（store 失败态 =
     * 旧 data + error）→ 开 popover → flush。D11 凭证缺失形态不走此助手（error 文案不同）。
     */
    async function openFailedPopover(): Promise<ReturnType<typeof mount>> {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      quotaStore.setError('zhipu', 'panel.context.quotaFailNetwork')
      const wrapper = await openPopover()
      await flushPromises()
      return wrapper
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    afterEach(() => {
      vi.useRealTimers()
      document.body.innerHTML = ''
    })

    it('refresh 按钮 → refreshQuota fulfilled 带 reason → 保留旧 data + 写 reason 文案（onRefresh reason 分支）', async () => {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: 500, reason: 'unauthorized' })

      const { wrapper, entry } = await refreshAndReadEntry()

      // 失败态（R2-S）：保留旧 data 不覆写为 null，error 写 reason 文案
      expect(entry.data).toEqual(mockQuotaRow)
      expect(entry.error).toBe('panel.context.quotaFailUnauthorized')
      wrapper.unmount()
    })

    it('refresh 按钮 → refreshQuota fulfilled 无 reason → setCache 写入新数据且清空 error（onRefresh 成功分支）', async () => {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      // 先置失败态（旧数据 + error）：成功刷新后 error 应被 setCache 清空（MF-1-3 成功分支锚）
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      quotaStore.setError('zhipu', 'panel.context.quotaFailNetwork')
      const freshRow: NormalizedQuotaRow = {
        label: 'Zhipu Coding Plan',
        wins: [{ pct: 90, resetSec: 3600 }, { pct: 80, resetSec: 86400 }, { pct: null, resetSec: null }],
      }
      vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: freshRow, lastFetchAt: 2000 })

      const { wrapper, entry } = await refreshAndReadEntry(() => {
        // 点击前失败态可见（用户可见 DOM 前置锚）
        expect(document.body.textContent).toContain('查询失败：panel.context.quotaFailNetwork')
      })

      // 成功分支：新 data + lastFetchAt 写入，error 清空
      expect(entry.data).toEqual(freshRow)
      expect(entry.lastFetchAt).toBe(2000)
      expect(entry.error).toBeNull()
      // 用户可见 DOM：失败提示随 error 清空退出
      expect(document.body.textContent).not.toContain('查询失败：panel.context.quotaFailNetwork')
      wrapper.unmount()
    })

    it('refresh 按钮 → refreshQuota reject（连接层异常）→ setError 留旧 data + refreshing 复位（onRefresh 异常分支）', async () => {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      vi.mocked(quotaApi.refreshQuota).mockRejectedValue(new Error('boom'))

      const { wrapper, entry } = await refreshAndReadEntry()

      // 异常分支：旧 data 保留，error 写异常消息
      expect(entry.data).toEqual(mockQuotaRow)
      expect(entry.error).toBe('boom')
      // 用户可见 DOM：失败提示带异常消息
      expect(document.body.textContent).toContain('查询失败：boom')
      // refreshing 复位：按钮文案回到「刷新」且不再禁用（可再次点击）
      const btnAfter = findBodyButton('刷新')
      expect(btnAfter).toBeTruthy()
      expect((btnAfter as HTMLButtonElement).disabled).toBe(false)
      wrapper.unmount()
    })

    it('失败态 popover 渲染「查询失败：{error}」（queryFailed DOM 断言，全库首例）', async () => {
      const wrapper = await openFailedPopover()

      // coding-plan 区失败提示渲染（v-if="error" 分支）：「查询失败：{error}」，
      // error 经 '@/i18n' mock 返回 key 本身（vitest-i18n-setup 插值 {error}）
      const bodyText = document.body.textContent ?? ''
      expect(bodyText).toContain('查询失败：panel.context.quotaFailNetwork')
      wrapper.unmount()
    })

    it('失败态兜底：有旧数据时余量三窗口行与失败提示并存（不再整体替换为失败文案）', async () => {
      // 兜底语义：查询失败时最后成功余量（store 的 setError 恒保留旧 data）继续展示，
      // 失败原因降级为一行提示——旧实现 v-if="error" 独占，一次失败即把余量行整个换掉
      const wrapper = await openFailedPopover()

      const bodyText = document.body.textContent ?? ''
      // 余量行仍在：68% 来自 mockQuotaRow.wins[0].pct
      expect(bodyText).toContain('68%')
      // 失败提示并存（非二选一替换）
      expect(bodyText).toContain('查询失败：panel.context.quotaFailNetwork')
      wrapper.unmount()
    })

    // ── D11（coding-plan-quota-config-ux §6.12）：失败态 footer 双入口 ──

    it('D11 失败态 footer 同时给「刷新」与「配置」；点「配置」触发 openSettings（死路给出路）', async () => {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      // 「已启用但凭证缺失」的必经形态：matchedProviderId 存在 + error 非空
      quotaStore.setError('zhipu', 'panel.context.quotaFailNoCredential')

      const openSettings = vi.fn()
      const wrapper = await openPopover(openSettings)
      await flushPromises()

      // 用户可见：失败文案 + 两个恢复动作同屏（原来只有「刷新」，刷新在凭证缺失时只会再失败一次）
      expect(document.body.textContent).toContain('查询失败：panel.context.quotaFailNoCredential')
      const refreshBtn = findBodyButton('刷新')
      const configureBtn = findBodyButton('配置')
      expect(refreshBtn).toBeTruthy()
      expect(configureBtn).toBeTruthy()

      configureBtn!.click()
      await flushPromises()
      expect(openSettings).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('D11 布局：失败态状态文字在左，两个按钮同组贴右端（结构断言，不依赖像素坐标）', async () => {
      // [HISTORICAL] 回归检查：footer 用 justify-between，两按钮若散作直接子项，失败态（3 子项）会把
      // 「刷新」挤到中间，与成功态（2 子项）的贴右位置跳变，且两个恢复动作看起来不相关。
      // jsdom 无布局引擎，故断言结构等价形态：按钮同属一个按钮组容器，且按钮组是 footer 的末子元素
      // （justify-between 下末子元素贴右端），状态文字是首子元素（贴左端）。
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      quotaStore.setError('zhipu', 'panel.context.quotaFailNoCredential')

      const wrapper = await openPopover()
      await flushPromises()

      const refreshBtn = findBodyButton('刷新')
      const configureBtn = findBodyButton('配置')
      const group = document.body.querySelector('[data-testid="quota-footer-actions"]')
      expect(group).toBeTruthy()

      // 成组：两按钮的直接父容器同一个，且就是按钮组容器
      expect(refreshBtn!.parentElement).toBe(group)
      expect(configureBtn!.parentElement).toBe(group)

      // 贴右端 + 状态文字在左：footer 只有「状态文字 + 按钮组」两个元素子节点，次序固定
      const footer = group!.parentElement!
      expect(footer.children).toHaveLength(2)
      expect(footer.firstElementChild!.tagName).toBe('SPAN')
      expect(footer.lastElementChild).toBe(group)

      wrapper.unmount()
    })

    it('D11 边界：成功态（有数据无 error）footer 只有「刷新」，不渲染「配置」（形态不被改变）', async () => {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)

      const wrapper = await openPopover()
      await flushPromises()

      expect(findBodyButton('刷新')).toBeTruthy()
      expect(findBodyButton('配置')).toBeUndefined()
      wrapper.unmount()
    })

    it('D11 边界：无数据态（matchedProviderId 且无 error）footer 只有「刷新」，不渲染「配置」', async () => {
      setupProviders([zhipuProvider])

      const wrapper = await openPopover()
      await flushPromises()

      // 从未查询：无 quotaRow 也无 error → 仍保持单按钮形态
      expect(document.body.textContent).toContain('无 Coding Plan 数据')
      expect(findBodyButton('刷新')).toBeTruthy()
      expect(findBodyButton('配置')).toBeUndefined()
      wrapper.unmount()
    })

    it('D11 边界：provider 未命中 quota → footer 只有「配置」（原 v-else 分支形态保留）', async () => {
      setupProviders([deepseekProvider])

      const wrapper = mount(ComposerMetricsAggregate, {
        props: { sessionId: 's1', modelId: 'deepseek/v3' },
        attachTo: document.body,
        global: { provide: { openSettings: () => {} } },
      })
      await flushPromises()
      await wrapper.find('[data-testid="composer-metrics-aggregate"]').trigger('focus')
      await vi.advanceTimersByTimeAsync(700)
      await flushPromises()

      expect(findBodyButton('配置')).toBeTruthy()
      expect(findBodyButton('刷新')).toBeUndefined()
      wrapper.unmount()
    })
  })

  describe('额度百分比展示口径（2 位小数）', () => {
    /** 卡内三窗口行走的是同一模版直渲染（不经 HoverCard portal，直接 mount 本卡即可断言文本） */
    function mountCardWithRow(row: NormalizedQuotaRow): ReturnType<typeof mount> {
      setupProviders([zhipuProvider])
      useQuotaStore().setCache('zhipu', row, 1000)
      return mount(ContextCapacityCard, { props: { sessionId: 's1', modelId: 'zhipu/glm-4' } })
    }

    it('[HISTORICAL] 浮点尾数不泄漏：2.9499999999999997 → 2.95%（截图事故原值）', async () => {
      // 事故形态：OpenDesign 的 pct = usedCredits/limitCredits*100 是连续量，原模板
      // `{{ win.pct }}%` 直接插值，满屏 `2.9499999999999997%` 撑爆 32px 数字列并溢出行宽。
      const wrapper = mountCardWithRow({
        label: 'OpenDesign Coding Plan',
        wins: [
          { pct: 0.148, resetSec: 10680 },
          { pct: 2.9499999999999997, resetSec: 10680 },
          { pct: null, resetSec: null },
        ],
      })
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('0.15%')
      expect(text).toContain('2.95%')
      // 用户可见文本里不得出现未格式化尾数
      expect(text).not.toContain('2.949999')
      wrapper.unmount()
    })

    it('整数 pct 不补尾零，与设置页同一函数（formatQuotaPct）', async () => {
      const wrapper = mountCardWithRow({
        label: 'Zhipu Coding Plan',
        wins: [{ pct: 68, resetSec: 4980 }, { pct: 100, resetSec: 266400 }, { pct: null, resetSec: null }],
      })
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('68%')
      expect(text).toContain('100%')
      expect(text).not.toContain('68.00%')
      wrapper.unmount()
    })
  })

  describe('容量区零回归', () => {
    // [迁移来源] 原锚为平铺触发器按钮文字（决策 6 退役）——quota 环境下的容量显示回归宿主
    // 换为 ContextCapacityCard（聚合按钮本身无数值文本，数字在 hover 页卡内）。
    it('context.update 仍正常工作', async () => {
      setupSession('s1')
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityCard, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 50000, contextLimit: 100000, usagePercent: 50 })
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('50K')
      expect(text).toContain('50%')
    })

    it('无 quota provider 时卡内正常显示用量', async () => {
      setupSession('s1')
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityCard, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 6900, contextLimit: 200000, usagePercent: 3 })
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('6.9K')
      expect(text).toContain('3%')
    })

    it('有 quota provider 时卡内仍正常显示用量', async () => {
      setupSession('s1')
      setupProviders([zhipuProvider])

      const wrapper = mount(ContextCapacityCard, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 12000, contextLimit: 200000, usagePercent: 6 })
      await flushPromises()

      const text = wrapper.text()
      expect(text).toContain('12K')
      expect(text).toContain('6%')
    })
  })

  // quota store 自身行为（setCache/getEntry/markPending 幂等）的守护归
  // stores/quota-store.test.ts 专用单测，此处不再重复直测（2026-10-20 垃圾测试审计
  // D 类裁决：组件测试内直测 store 内部契约属重复证明）
})

// ══════════ 来源：detail-selection-bubble.test.ts ══════════
{
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const SIMPLE = { template: '<div />' }

  function mountDetailPane() {
    return mount(DetailPane, {
      props: { sessionId: 's1' },
      global: {
        stubs: {
          HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
          CodeBlock: SIMPLE, DiffView: SIMPLE, MarkdownRenderer: SIMPLE,
        },
      },
    })
  }

  describe('W4: DetailPane 选区 bubble（FR-4）', () => {
    it('U13: 无选区时 bubble 不存在', () => {
      const wrapper = mountDetailPane()
      expect(wrapper.find('[data-testid="detail-selection-bubble"]').exists()).toBe(false)
    })

    it('U13b: bubble "引用当前" 按钮注入 path+行范围 target=current（不含 text）', async () => {
      const wrapper = mountDetailPane()
      const store = composerInjectionStore
      // mock window.getSelection 返回模拟选区（content 第 2-3 行）。
      // fakeRange 必须含 startContainer/endContainer —— onContentMouseup 直接访问这俩字段，
      // 缺失会让 findCodeLineIndex(node=undefined) 在 node.nodeType 抛 TypeError。
      // preview 模式下内容区无 .line 节点（CodeBlock stub 成空 div），
      // findCodeLineIndex 返回 null，自然落到文本回退分支。
      const contentEl = wrapper.find('[data-testid="detail-content"]').element
      const fakeRange = { commonAncestorContainer: contentEl, startContainer: contentEl, endContainer: contentEl }
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => fakeRange,
        toString: () => 'line2\nline3',
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      } as unknown as Selection)

      await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
      const bubble = wrapper.find('[data-testid="detail-selection-bubble"]')
      expect(bubble.exists()).toBe(true)

      await wrapper.find('[data-testid="bubble-inject-current"]').trigger('click')
      expect(store.pendingInjection.value).not.toBeNull()
      expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
      expect(store.pendingInjection.value?.lineStart).toBe(2)
      expect(store.pendingInjection.value?.lineEnd).toBe(3)
      expect(store.pendingInjection.value?.target).toBe('current')
      // FR-8: payload 不含 text
      expect((store.pendingInjection as unknown as Record<string, unknown>).text).toBeUndefined()
      vi.restoreAllMocks()
    })

    it('U13c: bubble "新对话" 按钮走 target=new', async () => {
      const wrapper = mountDetailPane()
      const store = composerInjectionStore
      // fakeRange 需含 startContainer/endContainer（详见 U13b 注释）
      const contentEl = wrapper.find('[data-testid="detail-content"]').element
      const fakeRange = { commonAncestorContainer: contentEl, startContainer: contentEl, endContainer: contentEl }
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => fakeRange,
        toString: () => 'line1',
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      } as unknown as Selection)

      await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
      await wrapper.find('[data-testid="bubble-inject-new"]').trigger('click')
      expect(store.pendingInjection.value?.target).toBe('new')
      expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
      expect(store.pendingInjection.value?.sessionId).toBeNull()
      vi.restoreAllMocks()
    })

    it('U13d: diff 模式从选区行元素 data-line 精确反推行号（不再禁用 bubble）', async () => {
      // 切 diff 模式：content 是 patch，DiffView 真实渲染行（带 data-line=newNo）
      detailState.value = {
        path: 'src/foo.ts',
        content: '@@ -1,3 +1,4 @@\n context\n-old\n+new line\n+added\n',
        viewMode: 'diff',
        kind: 'code',
        status: 'success',
        hasGitChange: true,
      }
      const wrapper = mount(DetailPane, {
        props: { sessionId: 's1' },
        global: {
          stubs: {
            HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
            CodeBlock: SIMPLE, MarkdownRenderer: SIMPLE,
            // DiffView 不 stub：真实渲染 patch 行（带 data-line）
          },
        },
      })
      await wrapper.vm.$nextTick()
      const store = composerInjectionStore

      // 找 DiffView 渲染的行 div（带 data-line）。patch 有 newNo 的行：context=1, new line=2, added=3
      const lineEls = wrapper.findAll('[data-line]').filter((w) => w.attributes('data-line') !== '')
      expect(lineEls.length).toBeGreaterThan(0)
      // mock selection：startContainer 指向第一行（data-line=1），endContainer 指向最后一行
      const firstLineEl = lineEls[0].element
      const lastLineEl = lineEls[lineEls.length - 1].element
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => ({
          commonAncestorContainer: wrapper.find('[data-testid="detail-content"]').element,
          startContainer: firstLineEl,
          endContainer: lastLineEl,
        }),
        toString: () => 'some selected text',
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      } as unknown as Selection)

      await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
      // bubble 应显出（diff 模式不再禁用）
      const bubble = wrapper.find('[data-testid="detail-selection-bubble"]')
      expect(bubble.exists()).toBe(true)

      await wrapper.find('[data-testid="bubble-inject-current"]').trigger('click')
      expect(store.pendingInjection.value).not.toBeNull()
      expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
      // 行号从 data-line 读取（首行 newNo 到末行 newNo）
      expect(store.pendingInjection.value?.lineStart).toBe(Number(firstLineEl.getAttribute('data-line')))
      expect(store.pendingInjection.value?.lineEnd).toBe(Number(lastLineEl.getAttribute('data-line')))
      vi.restoreAllMocks()
      // 恢复 preview 模式供后续测试
      detailState.value = {
        path: 'src/foo.ts',
        content: 'line1\nline2\nline3\nline4',
        viewMode: 'preview',
        kind: 'code',
        status: 'success',
        hasGitChange: false,
      }
    })
  })
}

// ══════════ 来源：block-rendering-regression.test.ts ══════════
{
  function msg(over: Partial<Message> = {}): Message {
    return { id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now(), ...over }
  }

  /** 构造 MessageTurn：默认 streaming 态（最后 assistant streaming），含可折叠块 */
  function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
    return {
      index: 1,
      user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() },
      assistants: [msg()],
      isStreaming: true,
      hasFoldable: true,
      ...over,
    }
  }

  /**
   * mount Turn 但用真实 Block（仅 stub 重依赖 ChangeSetCard + 自定义 MarkdownRenderer）。
   * MarkdownRenderer stub 渲染 content 到 .md-stub（区别于 turn-working 的 stub=true：
   * 本文件需要 textContent 可见来断言零跳变无丢失）。
   * 展开/折叠经 deps 注入（isExpanded/toggleExpand 必须用 reactive Set——普通 Set 非响应式，
   * computed 不重算）。
   */
  const expandedTurns = reactive(new Set<string>())
  // isLastTurn 默认 true：单 turn 隔离挂载即末位 turn（D1 折叠作用域，streaming-trace-window design §3.3），
  // session 进行中（streaming）时工作 trace 才展开——TC-REG-1 的 streaming 序列需要末位 turn 展开 trace。
  function mountTurnWithRealBlock(props: { turn: MessageTurn; sessionId?: string; isLastTurn?: boolean }) {
    return mount(Turn, {
      props: { turn: props.turn, sessionId: props.sessionId ?? 's1', isLastTurn: props.isLastTurn ?? true },
      global: {
        plugins: [createPinia()],
        provide: mockChatProvide({
          isExpanded: (key: string) => expandedTurns.has(key),
          toggleExpand: (key: string) => {
            if (expandedTurns.has(key)) expandedTurns.delete(key)
            else expandedTurns.add(key)
          },
        }),
        stubs: {
          ChangeSetCard: true,
          MarkdownRenderer: {
            props: ['content'],
            template: '<div class="md-stub">{{ content }}</div>',
          },
        },
      },
    })
  }

  describe('block-rendering 回归护栏（§8.3）', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      expandedTurns.clear()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    // TC-REG-1：零跳变回归——message_start 序列下窗口内块节点全程同一 DOM 引用。
    // T1=[a1 text streaming] → T2=[a1 text+tool running] → T3=[a1 text+tool, a2 text streaming]。
    // [8be96c5dc 适配] 窗口语义：末位 text 全 turn 单个（不按 assistant 分组）——T3 时 a1 text
    // （非末位）被收编出 visible，visible=[a1 tool, a2 text]；零跳变断言改为「T1→T2 a1 text 引用
    // 稳定 + T2→T3 窗口内 a1 tool 引用稳定」（key=flatIndex keyed v-for 复用）。
    it('TC-REG-1: 零跳变 — 窗口内块 DOM 引用在 T1→T3 全程同一节点，顺序不变，末位 text 无丢失', async () => {
      const a1Text = (over: Partial<Message> = {}): Message =>
        msg({
          id: 'a1',
          status: 'streaming',
          content: '我先读文件',
          contentBlocks: [{ type: 'text', refId: 'text' }],
          ...over,
        })
      const runningTool = { id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'running' as const, startTime: 0 }

      // T1：a1 text streaming（记录 a1 text 的 DOM element 引用）
      const wrapper = mountTurnWithRealBlock({
        turn: makeTurn({ isStreaming: true, hasFoldable: false, assistants: [a1Text()] }),
      })
      const a1TextEl = wrapper.find('.trace .trace-blk > div').element as HTMLElement
      expect(a1TextEl).toBeInstanceOf(HTMLElement)
      expect(wrapper.find('.trace .trace-blk > div').exists()).toBe(true)
      expect(wrapper.find('.trace .trace-blk .md-stub').text()).toBe('我先读文件')
      expect(wrapper.find('.trace').text()).toContain('我先读文件')

      // T2：message_start 后 tool 插入——a1 同 text + toolCall running
      await wrapper.setProps({
        turn: makeTurn({
          isStreaming: true,
          hasFoldable: true,
          assistants: [
            a1Text({
              contentBlocks: [
                { type: 'text', refId: 'text' },
                { type: 'toolCall', refId: 'tc1' },
              ],
              toolCalls: [runningTool],
            }),
          ],
        }),
      })
      // a1 text 引用同一节点（keyed v-for 按 flatIndex=0 复用），textContent 无丢失
      expect(wrapper.find('.trace .trace-blk > div').exists()).toBe(true)
      expect(wrapper.find('.trace .trace-blk > div').element).toBe(a1TextEl)
      // U2 起 text 块行尾含时刻槽（text-time-slot），textContent 含时刻文本——断言「正文无丢失」用 toContain
      expect(a1TextEl.textContent).toContain('我先读文件')
      // 相对顺序不变：a1 text 在 tool 前
      // （顶层单元取子选择器：W3 起成员行直递 ToolRow 无壳根，本就不带 .trace-blk；
      //   子选择器保证「块数 = 顶层单元数」口径与组内成员行无关）
      const blocksT2 = wrapper.findAll('.trace > .trace-blk')
      expect(blocksT2.length).toBe(2)
      expect(blocksT2[0].find('.md-stub').exists()).toBe(true)
      expect(blocksT2[0].find('.md-stub').text()).toBe('我先读文件')
      expect(blocksT2[1].find('.trace-run-group').exists()).toBe(true)
      // 记录 T2 的 run 组 DOM 引用（T3 窗口收编 a1 text 后组仍在窗口内）
      const a1ToolEl = blocksT2[1].element as HTMLElement

      // T3：message_start(a2)——a1 text 收编（非末位），visible=[a1 tool, a2 text]
      await wrapper.setProps({
        turn: makeTurn({
          isStreaming: true,
          hasFoldable: true,
          assistants: [
            a1Text({
              contentBlocks: [
                { type: 'text', refId: 'text' },
                { type: 'toolCall', refId: 'tc1' },
              ],
              toolCalls: [runningTool],
            }),
            msg({ id: 'a2', status: 'streaming', content: '内容是...' }),
          ],
        }),
      })
      // a1 的 run 组引用仍同一节点（run head 锚定 key 不变，窗口内单元零跳变）
      const blocksT3 = wrapper.findAll('.trace > .trace-blk')
      expect(blocksT3.length).toBe(2)
      expect(blocksT3[0].find('.trace-run-group').exists()).toBe(true)
      expect(blocksT3[0].element).toBe(a1ToolEl)
      // 相对顺序不变：a1 tool 在 a2 text（末位 text = 流式正文）前
      expect(blocksT3[1].find('.md-stub').exists()).toBe(true)
      expect(blocksT3[1].find('.md-stub').text()).toBe('内容是...')
      // 末位 text 无丢失（a1 非末位 text 已收编，经 takeover/展开查看——8be96c5dc）
      expect(wrapper.find('.trace').text()).toContain('内容是...')
    })

    // TC-REG-2：折叠态多 assistant 文字可见——showTrace=false 时仅全 turn 末位 text 可见
    // （8be96c5dc：不按 assistant 分组，防 tool-loop 多 assistant visible 爆炸），thinking/tool
    // 不存在，.trace 容器恒渲染；非末位 text 经展开（完成态全量 flatBlocks「回看就是全量」）恢复。
    it('TC-REG-2: 折叠态多 assistant — 仅末位 text 可见，thinking/tool 隐藏；展开后全量恢复', async () => {
      const a1 = msg({
        id: 'a1',
        status: 'complete',
        content: '正文A',
        thinking: [{ id: 'th1', content: 'thinking', collapsed: true }],
        toolCalls: [{ id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'completed', startTime: 0 }],
        contentBlocks: [
          { type: 'thinking', refId: 'th1' },
          { type: 'text', refId: 'text' },
          { type: 'toolCall', refId: 'tc1' },
        ],
      })
      const a2 = msg({ id: 'a2', status: 'complete', content: '正文B' })
      // complete 态 + 不传 isSessionActive → sessionActive 回退 turn.isStreaming=false → showTrace=false
      const wrapper = mountTurnWithRealBlock({
        turn: makeTurn({ isStreaming: false, hasFoldable: true, assistants: [a1, a2] }),
      })
      // .trace 容器恒渲染（v-if 下沉 Block 级）
      expect(wrapper.find('.trace').exists()).toBe(true)
      // 折叠态仅全 turn 末位 text（a2「正文B」）可见；a1 非末位 text 收编
      const blocks = wrapper.findAll('.trace .trace-blk')
      expect(blocks.length).toBe(1)
      expect(blocks[0].find('.md-stub').exists()).toBe(true)
      expect(blocks[0].find('.md-stub').text()).toBe('正文B')
      // thinking/tool 节点不存在（showTrace=false 隐藏）
      expect(wrapper.find('.trace-think').exists()).toBe(false)
      expect(wrapper.find('.trace-tool').exists()).toBe(false)
      expect(wrapper.find('.trace').text()).toContain('正文B')

      // 展开后（showTrace && !isWorkingTurn → 全量 flatBlocks）：a1 thinking/text/tool + a2 text 全恢复
      expandedTurns.add('u1')
      await nextTick()
      const expanded = wrapper.findAll('.trace .trace-blk')
      expect(expanded.length).toBe(4)
      expect(wrapper.find('.trace').text()).toContain('正文A')
      expect(wrapper.find('.trace').text()).toContain('正文B')
      expect(wrapper.find('.trace-think').exists()).toBe(true)
      // a1 的工具行折进 run 组（grep → 探索组，已完成 → 组默认收起，成员行不在 DOM）
      expect(wrapper.find('.trace-run-group').exists()).toBe(true)
    })

    // TC-REG-3：样式统一——展开态多 assistant，所有 text block 含正文 token 锚点
    // （text-[length:var(--text-md)] + leading-[1.8]，D5 正文档；行高 ui-optimize-unified 决策 7 调 1.8），
    // 不含过程样式（text-sm / leading-relaxed）。
    it('TC-REG-3: 展开态多 assistant — 所有 text block 统一正文样式（token 锚点）', async () => {
      const a1 = msg({
        id: 'a1',
        status: 'complete',
        content: '正文A',
        toolCalls: [{ id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'completed', startTime: 0 }],
        contentBlocks: [
          { type: 'text', refId: 'text' },
          { type: 'toolCall', refId: 'tc1' },
        ],
      })
      const a2 = msg({ id: 'a2', status: 'complete', content: '正文B' })
      const wrapper = mountTurnWithRealBlock({
        turn: makeTurn({ isStreaming: false, hasFoldable: true, assistants: [a1, a2] }),
      })
      // 手动展开 trace（reactive Set 驱动 isExpanded → showTrace）
      expandedTurns.add('u1')
      await nextTick()
      const blocks = wrapper.findAll('.trace .trace-blk')
      expect(blocks.length).toBe(3) // a1 text + a1 tool + a2 text
      // 每个 text block 的 class 断言（token 锚点，禁止字面 'text-base' 子串匹配）
      const textEls = wrapper
        .findAll('.trace .trace-blk > div')
        .filter((d) => d.find('.md-stub').exists())
      expect(textEls.length).toBe(2)
      expect(textEls[0].find('.md-stub').text()).toBe('正文A')
      expect(textEls[1].find('.md-stub').text()).toBe('正文B')
      for (const el of textEls) {
        expect(el.classes()).toContain('text-[length:var(--text-md)]')
        // 行高 leading-[1.8]（决策 7：正文行高 1.7/1.75 → 1.8 双生效点同改）
        expect(el.classes()).toContain('leading-[1.8]')
        expect(el.classes()).not.toContain('text-[length:var(--text-sm)]')
        expect(el.classes()).not.toContain('text-[length:var(--text-base)]')
        expect(el.classes()).not.toContain('leading-relaxed')
      }
    })
  })
}
