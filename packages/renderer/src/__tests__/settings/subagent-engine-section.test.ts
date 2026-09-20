/**
 * SubagentEngineSection 渲染测试（U7：Settings「子代理」页顶部引擎选择器）。
 *
 * 覆盖（三视角：构建者白盒 mock + 使用者黑盒 DOM + 观察者形态）：
 *  - 动态引擎清单渲染（选项来自 RPC，组件零硬编码——未来新引擎零改动出现）；
 *  - 当前 defaultEngine 选中态；
 *  - 选择变更 → setSubagentDefaultEngine 调用 + 本地态更新；
 *  - RPC 失败兜底 ['pi']（runtime 同语义）。
 *
 * mock 策略：vi.mock('@taiji/core/transport/api/domains/session') 替换引擎配置读写。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/subagent-engine-section.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const sessionApiMock = vi.hoisted(() => ({
  getSubagentEngineConfig: vi.fn(async () => ({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })),
  setSubagentDefaultEngine: vi.fn(async () => ({ engineId: 'pi' })),
}))

vi.mock('@taiji/core/transport/api/domains/session', () => sessionApiMock)

import SubagentEngineSection from '@/components/settings/agent/SubagentEngineSection.vue'
import { useToast } from '@/composables/useToast'
import zhCN from '@/i18n/locales/zh-CN/settings'

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

beforeEach(() => {
  vi.clearAllMocks()
  // 清空全局 toasts（useToast 模块级单例，跨用例共享）
  useToast().toasts.value = []
})

describe('SubagentEngineSection（U7 引擎选择器）', () => {
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

  it('选择变更 → 调用 setSubagentDefaultEngine（engineId 透传）+ 选中态更新', async () => {
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
  })

  it('RPC 失败兜底 [pi]（选择器仍可用，不白屏）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down'))
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-section]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('pi')
  })
})
