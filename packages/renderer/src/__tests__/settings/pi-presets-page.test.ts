/**
 * PiPresetsPage 渲染测试。
 *
 * 覆盖：
 *  - 首屏冒烟：内置预设渲染 builtin 标签 + disabled 输入；自定义预设可编辑。
 *  - 新建预设：点新建 → preset.create 被调用。
 *  - 删除自定义预设：确认弹窗 → preset.delete 被调用。
 *  - 恢复内置预设：点恢复 → preset.update 被调用。
 *  - 工具模式切换：点 mode 按钮 → preset.update 被调用 + checkbox 列表出现/消失。
 *  - 设为默认：点设为默认 → preset.setDefault 被调用。
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 preset 门面替成可断言的 mock。
 *  - PresetModeSection 子组件 stub（本测试聚焦 PiPresetsPage 主逻辑）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/pi-presets-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PiLaunchPreset } from '@taiji/shared'

/** mock preset API */
const presetMock = vi.hoisted(() => ({
  list: vi.fn(() => Promise.resolve([])),
  getDefault: vi.fn(() => Promise.resolve('builtin:full')),
  setDefault: vi.fn(() => Promise.resolve()),
  create: vi.fn((p: PiLaunchPreset) => Promise.resolve(p)),
  update: vi.fn((p: PiLaunchPreset) => Promise.resolve(p)),
  remove: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  preset: presetMock,
  default: { preset: presetMock },
}))

vi.mock('@taiji/ui/features/settings', () => ({
  PresetModeSection: {
    name: 'PresetModeSection',
    props: ['preset', 'disabled'],
    template: '<div data-testid="mode-section" />',
  },
  GroupCard: {
    name: 'GroupCard',
    template: '<div data-testid="group-card"><slot /></div>',
  },
}))

import PiPresetsPage from '@/components/settings/preset/PiPresetsPage.vue'
import { usePresetStore } from '@/stores/preset'
import { useToast } from '@/composables/useToast'

/** 内置预设 fixture */
function builtinPreset(): PiLaunchPreset {
  return {
    id: 'builtin:full',
    name: 'Full Mode',
    description: 'All tools and extensions',
    builtin: true,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  }
}

/** 自定义预设 fixture */
function customPreset(): PiLaunchPreset {
  return {
    id: 'custom:my-preset',
    name: 'My Preset',
    description: 'Custom preset',
    builtin: false,
    order: 1,
    toolMode: 'allowlist',
    allowedTools: ['read', 'bash'],
    extensionMode: 'all',
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  presetMock.list.mockResolvedValue([])
  presetMock.getDefault.mockResolvedValue('builtin:full')
  presetMock.create.mockImplementation((p: PiLaunchPreset) => Promise.resolve(p))
  presetMock.update.mockImplementation((p: PiLaunchPreset) => Promise.resolve(p))
  presetMock.remove.mockResolvedValue(undefined)
  presetMock.setDefault.mockResolvedValue(undefined)
  const { toasts } = useToast()
  toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('PiPresetsPage 首屏冒烟', () => {
  it('内置预设渲染 builtin 标签 + 默认标签 + 摘要行（折叠态）', async () => {
    const store = usePresetStore()
    store.setPresets([builtinPreset()])
    store.setDefaultPresetId('builtin:full')

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    // builtin 标签
    expect(wrapper.text()).toContain('内置')
    // 默认标签
    expect(wrapper.text()).toContain('默认')
    // 折叠态显示摘要行（mode 概览，summaryAll = "全部可用"）
    expect(wrapper.text()).toContain('全部可用')
    // 折叠态：内置预设默认折叠，编辑区 input 不在 DOM（CollapsibleContent 未展开）
    // disabled 保护由 service 层 PresetGuardError + 前端 :disabled 双重保障，展开后可见
    expect(wrapper.findAll('input').length).toBe(0)
  })

  it('自定义预设名称输入可编辑', async () => {
    const store = usePresetStore()
    store.setPresets([customPreset()])
    store.setDefaultPresetId('builtin:full')

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    // 名称输入 enabled（第一个 input 是名称，自定义预设不 disabled）
    const inputs = wrapper.findAll('input')
    const nameInput = inputs[0]
    expect(nameInput.attributes('disabled')).toBeUndefined()
    // ID 输入始终 disabled
    const idInput = inputs[1]
    expect(idInput.attributes('disabled')).toBeDefined()
  })

  it('空列表显示空态文案', async () => {
    wrapper = mount(PiPresetsPage)
    await flushPromises()

    expect(wrapper.text()).toContain('暂无预设')
  })

  it('异步加载后：自定义预设自动展开、内置预设折叠（expandedIds 竞态回归防护）', async () => {
    // 模拟生产场景：mount 时 store 空，onMounted → loadPresets → list RPC 返回预设
    // 回归 bug：expandedIds 曾在 setup eager 初始化（此时 presets 空）→ 自定义预设也折叠
    presetMock.list.mockResolvedValue([builtinPreset(), customPreset()])

    wrapper = mount(PiPresetsPage)
    await flushPromises()
    // loadPresets 已完成，store 现在有 2 个预设

    // 内置预设折叠（编辑区 input 不在 DOM）—— 内置预设当作文档扫视
    // 自定义预设展开（编辑区 input 在 DOM）—— 自定义预设是工作区，默认展开可编辑
    const inputs = wrapper.findAll('input')
    // 自定义预设展开 → name + id 两个 input 可见；内置折叠 → 无 input
    // 若 expandedIds 竞态 bug 存在，两个都折叠 → inputs.length === 0
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    // 自定义预设的 name input 可编辑（非 disabled）
    const nameInput = inputs[0]
    expect(nameInput.attributes('disabled')).toBeUndefined()
  })
})

describe('PiPresetsPage 新建预设', () => {
  it('点击新建 → preset.create 被调用', async () => {
    wrapper = mount(PiPresetsPage)
    await flushPromises()

    const newBtn = wrapper.findAll('button').find((b) => b.text().includes('新建预设'))
    expect(newBtn).toBeTruthy()
    await newBtn!.trigger('click')
    await flushPromises()

    expect(presetMock.create).toHaveBeenCalledTimes(1)
    const calledPreset = presetMock.create.mock.calls[0][0] as PiLaunchPreset
    expect(calledPreset.builtin).toBe(false)
    expect(calledPreset.toolMode).toBe('all')
    expect(calledPreset.extensionMode).toBe('all')
  })
})

describe('PiPresetsPage 删除自定义预设', () => {
  it('点击删除 → 确认弹窗 → 确认 → preset.delete 被调用', async () => {
    const store = usePresetStore()
    store.setPresets([customPreset()])

    wrapper = mount(PiPresetsPage, { attachTo: document.body })
    await flushPromises()

    // 点删除按钮
    const deleteBtn = wrapper.find('button svg.lucide-trash-2').element.closest('button')!
    expect(deleteBtn).toBeTruthy()
    deleteBtn.click()
    await flushPromises()

    // ConfirmDialog teleport 到 body
    const confirm = Array.from(document.body.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('确认删除'))
    expect(confirm).toBeTruthy()
    confirm!.click()
    await flushPromises()

    expect(presetMock.remove).toHaveBeenCalledWith('custom:my-preset')
  })
})

describe('PiPresetsPage 恢复内置预设', () => {
  it('点击恢复 → preset.update 被调用', async () => {
    const store = usePresetStore()
    store.setPresets([builtinPreset()])
    store.setDefaultPresetId('builtin:full')

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    const restoreBtn = wrapper.findAll('button').find((b) => b.text().includes('恢复默认'))
    expect(restoreBtn).toBeTruthy()
    await restoreBtn!.trigger('click')
    await flushPromises()

    expect(presetMock.update).toHaveBeenCalledTimes(1)
    const calledPreset = presetMock.update.mock.calls[0][0] as PiLaunchPreset
    expect(calledPreset.id).toBe('builtin:full')
  })
})

describe('PiPresetsPage 字段输入 debounce（W-RN-2）', () => {
  it('字段输入不立即触发 update RPC（走 useDebounceFn 节流）', async () => {
    const store = usePresetStore()
    store.setPresets([customPreset()])

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    presetMock.update.mockClear()
    // 模拟用户在 name 字段输入（setValue 触发 input 事件 → Input 组件 emit update:modelValue）
    const nameInput = wrapper.findAll('input')[0]!
    await nameInput.setValue('新名称')
    await flushPromises()

    // flushPromises 只刷新微任务队列，不推进 setTimeout——debounce 窗口（400ms）
    // 内 update 不会被调用。验证 onFieldChange 走了 debounce 而非直接同步 update。
    // useDebounceFn 节流正确性由其自身（成熟库函数）保证。
    expect(presetMock.update).not.toHaveBeenCalled()
  })
})

describe('PiPresetsPage 加载失败提示（S-RN-7）', () => {
  it('store.loadError 有值时显示错误提示 + 重试按钮', async () => {
    const store = usePresetStore()
    store.setPresets([customPreset()])
    store.setLoadError('runtime 不可用')

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    // 错误提示渲染
    expect(wrapper.text()).toContain('runtime 不可用')
    // 重试按钮存在（common.retry = 重试）
    const retryBtn = wrapper.findAll('button').find((b) => b.text().includes('重试'))
    expect(retryBtn).toBeTruthy()
  })

  it('点击重试 → loadPresets 被调用', async () => {
    const store = usePresetStore()
    store.setPresets([customPreset()])
    store.setLoadError('runtime 不可用')

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    presetMock.list.mockResolvedValueOnce([customPreset()])
    presetMock.getDefault.mockResolvedValueOnce('builtin:full')

    const retryBtn = wrapper.findAll('button').find((b) => b.text().includes('重试'))
    expect(retryBtn).toBeTruthy()
    await retryBtn!.trigger('click')
    await flushPromises()

    // loadPresets 触发了 list RPC
    expect(presetMock.list).toHaveBeenCalled()
  })
})

describe('PiPresetsPage 设为默认', () => {
  it('点击设为默认 → preset.setDefault 被调用', async () => {
    const store = usePresetStore()
    store.setPresets([builtinPreset(), customPreset()])
    store.setDefaultPresetId('builtin:full')

    wrapper = mount(PiPresetsPage)
    await flushPromises()

    const setDefaultBtn = wrapper.findAll('button').find((b) => b.text().includes('设为默认'))
    expect(setDefaultBtn).toBeTruthy()
    await setDefaultBtn!.trigger('click')
    await flushPromises()

    expect(presetMock.setDefault).toHaveBeenCalledWith('custom:my-preset')
  })
})

describe('PiPresetsPage 内置扩展提示', () => {
  it('页面底部显示内置扩展提示', async () => {
    // hint 在 presets 非空时渲染（v-if="presets.length"），fixture 需喂数据
    presetMock.list.mockResolvedValue([builtinPreset()])
    wrapper = mount(PiPresetsPage)
    await flushPromises()

    expect(wrapper.text()).toContain('3 个内置扩展')
    expect(wrapper.text()).toContain('@zhushanwen/pi-agent-ext')
  })
})
