/**
 * ContextCapacityPopover coding-plan 区测试（w4）。
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
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-capacity-quota.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { NormalizedQuotaRow, ProviderInfo } from '@taiji/shared'

// ── mock ──

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  // session.getContext：组件经 useContextUsage 恢复腿挂载即调（Phase 2.2 纯读改造）——
  // mock 为永不 resolve 的 pending（本文件只测 quota 区与帧直驱显示，恢复腿行为在
  // use-context-usage.test.ts / context-usage-journeys.test.ts 覆盖）
  session: { getContext: vi.fn(() => new Promise(() => {})) },
  config: {
    onProviders: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
    getTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
    setTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
  },
  model: { onModels: vi.fn(() => () => {}) },
  extension: { onExtensions: vi.fn(() => () => {}) },
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
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

import ContextCapacityPopover from '@/components/panel/ContextCapacityPopover.vue'
import { useSessionStore } from '@/stores/session'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'
import { useQuotaStore } from '@/stores/quota'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import * as events from '@taiji/core/transport/api'

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  vi.clearAllMocks()
})

// ── fixtures ──

const zhipuProvider: ProviderInfo = {
  id: 'zhipu',
  name: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api',
  apiKeySet: true,
  status: 'connected',
  models: [{ id: 'glm-4', name: 'GLM-4.6', contextWindow: 200000 }],
  quota: { fetcher: 'zhipu', enabled: true },
}

const deepseekProvider: ProviderInfo = {
  id: 'deepseek',
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKeySet: true,
  status: 'connected',
  models: [{ id: 'v3', name: 'DeepSeek V3', contextWindow: 128000 }],
  // 无 quota 配置
}

const mockQuotaRow: NormalizedQuotaRow = {
  label: '智谱 GLM Coding Plan',
  wins: [
    { pct: 68, resetSec: 4980 },
    { pct: 42, resetSec: 266400 },
    { pct: null, resetSec: null },
  ],
}

/** 设置 session store 有一个 session */
function setupSession(sid: string, modelId: string): void {
  const sessionStore = useSessionStore()
  sessionStore.groups = [{
    cwd: '/test',
    sessions: [{
      id: sid,
      label: 'test',
      cwd: '/test',
      status: 'active' as const,
      lastActiveAt: Date.now(),
      modelId,
      tokenCount: 0,
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

describe('ContextCapacityPopover coding-plan 区', () => {
  describe('hover-enter 查询触发', () => {
    it('hover 按钮 + provider 命中 quota preset → 调 getCached + fetchQuota', async () => {
      setupProviders([zhipuProvider])
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 1000 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 2000 })

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      // hover 按钮触发查询
      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    })

    it('provider 未配置 quota → 不调 quota API', async () => {
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'deepseek/v3' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
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

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
    })

    it('无 modelId → 不调 quota API（未确定模型时不查 quota）', async () => {
      setupProviders([zhipuProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: {},
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
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

      const wrapper = mount(ContextCapacityPopover, {
        // landing 态：sessionId=undefined，但 modelId 受控下发
        props: { modelId: 'zhipu/glm-4.6' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    })
  })

  describe('未配置态「配置」按钮（偏差 #D）', () => {
    it('未配置 provider 时 footer 渲染「配置」按钮（跳转 Settings）', async () => {
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'deepseek/v3' },
        global: {
          provide: { openSettings: () => {} },
        },
      })
      await flushPromises()

      // 注：HoverCardContent 在 reka-ui HoverCardPortal 内，happy-dom 下不渲染。
      // 「配置」按钮在 footer（portal 内），这里断言组件正常渲染不 crash；
      // trigger 按钮在 portal 外，始终可断言。
      const trigger = wrapper.find('[title="上下文容量"]')
      expect(trigger.exists()).toBe(true)
    })
  })

  describe('quota store 写入', () => {
    it('hover 后 quota store 写入缓存数据', async () => {
      setupSession('s1', 'zhipu/glm-4')
      setupProviders([zhipuProvider])
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 1000 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 2000 })

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
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

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      // 旧缓存应保留（fetchQuota 失败，但 getCached 已先写入）
      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
    })

    it('fetch fulfilled 带 reason（A2-4 失败态）→ 保留旧 data + 写 reason 文案，不覆写为 null', async () => {
      // [HISTORICAL] 回归守卫（BL round1 #3）：runtime 失败契约是 data=null + reason
      // （非旧缓存 data），消费侧曾把旧缓存覆写为 null 且清空 error——失败既不显提示也不留旧值
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)

      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 500 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: 500, reason: 'unauthorized' })

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
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
      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
        attachTo: document.body,
        global: { provide: { openSettings } },
      })
      await flushPromises()
      await wrapper.find('[title="上下文容量"]').trigger('focus')
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

      const wrapper = await openPopover()

      const refreshBtn = findBodyButton('刷新')
      expect(refreshBtn).toBeTruthy()
      refreshBtn!.click()
      await flushPromises()

      // 失败态（R2-S）：保留旧 data 不覆写为 null，error 写 reason 文案
      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
      expect(entry!.error).toBe('panel.context.quotaFailUnauthorized')
      wrapper.unmount()
    })

    it('失败态 popover 渲染「查询失败：{error}」（queryFailed DOM 断言，全库首例）', async () => {
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)
      // 模拟上一次查询失败（store 失败态：旧 data + error）
      quotaStore.setError('zhipu', 'panel.context.quotaFailNetwork')

      const wrapper = await openPopover()
      await flushPromises()

      // coding-plan 区失败提示渲染（v-if="error" 分支）：「查询失败：{error}」，
      // error 经 '@/i18n' mock 返回 key 本身（vitest-i18n-setup 插值 {error}）
      const bodyText = document.body.textContent ?? ''
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
      // [HISTORICAL] 回归守卫：footer 用 justify-between，两按钮若散作直接子项，失败态（3 子项）会把
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

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'deepseek/v3' },
        attachTo: document.body,
        global: { provide: { openSettings: () => {} } },
      })
      await flushPromises()
      await wrapper.find('[title="上下文容量"]').trigger('focus')
      await vi.advanceTimersByTimeAsync(700)
      await flushPromises()

      expect(findBodyButton('配置')).toBeTruthy()
      expect(findBodyButton('刷新')).toBeUndefined()
      wrapper.unmount()
    })
  })

  describe('容量区零回归', () => {
    it('context.update 仍正常工作', async () => {
      setupSession('s1', 'deepseek/v3')
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 50000, contextLimit: 100000, usagePercent: 50 })
      await flushPromises()

      const text = wrapper.find('[title="上下文容量"]').text()
      expect(text).toContain('50K')
      expect(text).toContain('50%')
    })

    it('无 quota provider 时按钮正常显示用量', async () => {
      setupSession('s1', 'deepseek/v3')
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 6900, contextLimit: 200000, usagePercent: 3 })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('6.9K')
      expect(btn.text()).toContain('3%')
    })

    it('有 quota provider 时按钮仍正常显示用量', async () => {
      setupSession('s1', 'zhipu/glm-4')
      setupProviders([zhipuProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 12000, contextLimit: 200000, usagePercent: 6 })
      await flushPromises()

      const text = wrapper.find('[title="上下文容量"]').text()
      expect(text).toContain('12K')
      expect(text).toContain('6%')
    })
  })

  describe('quota store 状态', () => {
    it('quota store 独立工作：setCache + getEntry', () => {
      const store = useQuotaStore()
      store.setCache('zhipu', mockQuotaRow, 1000)

      const entry = store.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data!.label).toBe('智谱 GLM Coding Plan')
      expect(entry!.data!.wins[0].pct).toBe(68)
    })

    it('quota store pending 保护', () => {
      const store = useQuotaStore()
      expect(store.markPending('zhipu')).toBe(true)
      expect(store.markPending('zhipu')).toBe(false)
      store.unmarkPending('zhipu')
      expect(store.markPending('zhipu')).toBe(true)
    })
  })
})
