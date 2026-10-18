/**
 * SubagentEngineSection 渲染测试（U7：Settings「子代理」页顶部引擎选择器）。
 *
 * 覆盖（三视角：构建者白盒 mock + 使用者黑盒 DOM + 观察者形态）：
 *  - 动态引擎清单渲染（选项来自 RPC，组件零硬编码——未来新引擎零改动出现）；
 *  - 当前 defaultEngine 选中态；
 *  - 选择变更 → setSubagentDefaultEngine 调用 + 本地态更新；
 *  - RPC 失败兜底 ['pi']（runtime 同语义）；
 *  - D5 per-engine 默认模型行三形态：有清单引擎（zcode）渲染 Select（选项来自 mock 清单）、
 *    pi 行只渲染说明文案、无清单引擎不渲染行；选择 → setSubagentEngineDefaultModel 调用
 *    + 权威回填；保存失败回滚旧值 + modelSaveFailed toast。
 *
 * mock 策略：SettingsTransport seam 桩（makeSettingsTransportStub + provideSettingsTransport，
 * [C3] 测试打 seam 不 mock 路由链）替换引擎配置读写。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/subagent-engine-section.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import { openRekaDropdown, pickRekaOption } from '../helpers/reka-select-harness'

const sessionApiMock = vi.hoisted(() => ({
  getSubagentEngineConfig: vi.fn(async () => ({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })),
  setSubagentDefaultEngine: vi.fn(async () => ({ engineId: 'pi' })),
  setSubagentEngineDefaultModel: vi.fn(async (engineId: string, modelRef: string) => ({ engineId, modelRef })),
}))

// [C3] 引擎配置读写经 SettingsTransport seam 桩注入（替换原 domains/session 模块 mock）

import SubagentEngineSection from '@/components/settings/agent/SubagentEngineSection.vue'
import { useToast } from '@/composables/useToast'
import zhCN from '@taiji/ui/locale/zh-CN/settings'

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

/** 挂载前注入一次引擎读取失败，断言 loadError 已显形（两个重试用例的共同前奏）。 */
async function mountWithLoadFailure(): Promise<ReturnType<typeof mountSection>> {
  sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down'))
  const wrapper = mountSection()
  await flushPromises()
  expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(true)
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  // 清空全局 toasts（useToast 模块级单例，跨用例共享）
  useToast().toasts.value = []
  provideSettingsTransport(makeSettingsTransportStub(sessionApiMock))
})


/** saved toast 断言单源（module 统一成功反馈，域文案 settings.subagentEngine.saved）。 */
function expectSavedToast() {
  const { toasts } = useToast()
  expect(toasts.value.some((t) => t.type === 'info' && t.message.includes('已保存'))).toBe(true)
}

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

  it('选择变更 → 调用 setSubagentDefaultEngine（engineId 透传）+ 选中态更新 + saved toast', async () => {
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
    // module 统一成功反馈：saved toast（域文案 settings.subagentEngine.saved）
    expectSavedToast()
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
    // 回滚路径无成功反馈（saved toast 仅在写成功出现）
    expect(toasts.value.some((t) => t.type === 'info')).toBe(false)
  })

  it('RPC 失败 → loadError 显形：控件禁用 + 顶部常驻提示（RD-4#8，不再 best-effort 冒充已存值）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down'))
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-section]').exists()).toBe(true)
    // 默认 'pi' 仍占位渲染，但明确标注为默认值（控件禁用，禁止当已存值操作）
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('pi')
    // RD-4#8：读取失败常驻提示 + 重试入口
    expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(true)
    expect(wrapper.text()).toContain('读取失败')
    // Select 禁用（loadError 时不可操作）
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(true)
  })

  it('RD-4#8：重试成功后清除 loadError + 控件恢复可用', async () => {
    const wrapper = await mountWithLoadFailure()

    // 重试：mock 改成功
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
    await wrapper.find('[data-testid=subagent-engine-load-retry]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(false)
    // 重新拉取成功后权威值回填：触发器从占位 pi 前进到已存默认 zcode（field reset 回填基准）
    expect(wrapper.find('[data-testid=subagent-engine-select]').text()).toContain('zcode')
  })

  it('RD-4#8：重试仍失败 → loadError 保持 + 控件保持禁用（占位值不冒充已存值）', async () => {
    const wrapper = await mountWithLoadFailure()

    // 重试：mock 依旧失败
    sessionApiMock.getSubagentEngineConfig.mockRejectedValueOnce(new Error('ws down again'))
    await wrapper.find('[data-testid=subagent-engine-load-retry]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid=subagent-engine-load-error]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(true)
  })

  // ── D5 per-engine 默认模型行（engine-provider-unification §3.3 D5 / §3.1 S2/S4）──

  it('D5 三形态：zcode 行渲染模型 Select（选项来自 mock 清单）+ pi 行说明文案 + 无清单引擎不渲染行', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode', 'acp'],
      defaultEngine: 'zcode',
      engineModels: {
        zcode: [
          { id: 'prov-a/m-1', name: 'Prov A · m-1' },
          { id: 'prov-b/m-2' },
        ],
      },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    const wrapper = mountSection()
    await flushPromises()

    // zcode 模型行：trigger 存在 + 当前偏好（engineDefaults）回显
    const modelTrigger = wrapper.find('[data-testid=subagent-engine-model-zcode]')
    expect(modelTrigger.exists()).toBe(true)
    expect(modelTrigger.text()).toContain('Prov A · m-1')
    // 打开下拉：选项来自 mock 清单（name 显示名优先，无 name 回落 id）
    const options = await openRekaDropdown(modelTrigger.element)
    expect(options).toHaveLength(2)
    expect(options[0].textContent).toContain('Prov A · m-1')
    expect(options[1].textContent).toContain('prov-b/m-2')
    // pi 行：说明文案行渲染（S4 零配置叙事），无模型 Select
    const piNote = wrapper.find('[data-testid=subagent-engine-pi-note]')
    expect(piNote.exists()).toBe(true)
    expect(piNote.text()).toContain('pi 引擎模型由 pi 自身解析')
    // acp 无清单：不渲染模型行
    expect(wrapper.find('[data-testid=subagent-engine-model-acp]').exists()).toBe(false)
  })

  it('D5：模型选择 → 调用 setSubagentEngineDefaultModel（engineId + modelRef 透传）+ 权威回填 + saved toast', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: {
        zcode: [
          { id: 'prov-a/m-1', name: 'Prov A · m-1' },
          { id: 'prov-b/m-2', name: 'Prov B · m-2' },
        ],
      },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    sessionApiMock.setSubagentEngineDefaultModel.mockResolvedValueOnce({ engineId: 'zcode', modelRef: 'prov-b/m-2' })
    const wrapper = mountSection()
    await flushPromises()

    await pickRekaOption(wrapper.find('[data-testid=subagent-engine-model-zcode]').element, 'Prov B · m-2')

    expect(sessionApiMock.setSubagentEngineDefaultModel).toHaveBeenCalledWith('zcode', 'prov-b/m-2')
    // reply modelRef = 权威回填（触发器前进到新选中）
    expect(wrapper.find('[data-testid=subagent-engine-model-zcode]').text()).toContain('Prov B · m-2')
    // 保存交互与既有区块一致：saved toast（settings.subagentEngine.saved）
    expectSavedToast()
  })

  it('D5：模型保存失败 → 选中态回滚旧值 + modelSaveFailed toast（带 reason）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: {
        zcode: [
          { id: 'prov-a/m-1', name: 'Prov A · m-1' },
          { id: 'prov-b/m-2', name: 'Prov B · m-2' },
        ],
      },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    sessionApiMock.setSubagentEngineDefaultModel.mockRejectedValueOnce(new Error('model not available'))
    const { toasts } = useToast()

    const wrapper = mountSection()
    await flushPromises()

    await pickRekaOption(wrapper.find('[data-testid=subagent-engine-model-zcode]').element, 'Prov B · m-2')

    expect(sessionApiMock.setSubagentEngineDefaultModel).toHaveBeenCalledWith('zcode', 'prov-b/m-2')
    // 回滚：触发器回到已保存基准（旧偏好 Prov A）
    const triggerText = wrapper.find('[data-testid=subagent-engine-model-zcode]').text()
    expect(triggerText).toContain('Prov A · m-1')
    expect(triggerText).not.toContain('Prov B')
    // 失败显形：modelSaveFailed toast 携带 runtime 原始文案（reason 插值）
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('保存失败') && t.message.includes('model not available'))).toBe(true)
  })

  it('D5：同值选择不发写请求（幂等，与引擎切换同款短路）', async () => {
    sessionApiMock.getSubagentEngineConfig.mockResolvedValueOnce({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: { zcode: [{ id: 'prov-a/m-1', name: 'Prov A · m-1' }] },
      engineDefaults: { zcode: 'prov-a/m-1' },
    })
    const wrapper = mountSection()
    await flushPromises()

    await pickRekaOption(wrapper.find('[data-testid=subagent-engine-model-zcode]').element, 'Prov A · m-1')

    expect(sessionApiMock.setSubagentEngineDefaultModel).not.toHaveBeenCalled()
  })
})
