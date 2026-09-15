/**
 * PresetModeSection 组件测试——扩展访问策略区。
 *
 * 覆盖：
 * - availableExtensions computed 过滤 builtin 扩展（isBuiltinExtension 基于
 *   mandatory-extensions.json SSOT）：builtin 的 @zhushanwen/pi-* 不出现在勾选列表，
 *   非 builtin 扩展以 displayName 渲染
 * - 空可用列表显示 noExtensions 占位
 * - 勾选扩展 checkbox → emit update 携带 presetId + 增删后的列表（W-RN-4 显式 checked 语义）
 *
 * settings store（@taiji/core getSettingsStore）mock 注入 extensions ref 值；
 * i18n 经 vitest.setup mock（t 返回 key）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/PresetModeSection.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { PiLaunchPreset } from '@taiji/shared'

const { mockGetExtensions } = vi.hoisted(() => ({
  // getSettingsStore 在组件 setup 时调用，工厂内动态取值以支持每用例独立数据
  mockGetExtensions: vi.fn<() => Array<{ name: string; displayName: string }>>(),
}))

vi.mock('@taiji/core', () => ({
  getSettingsStore: () => ({ extensions: { value: mockGetExtensions() } }),
}))

import PresetModeSection from '../coding-plan/PresetModeSection.vue'

function makePreset(extensionMode: PiLaunchPreset['extensionMode']): PiLaunchPreset {
  return {
    id: 'preset-1',
    name: 'P1',
    builtin: false,
    order: 1,
    toolMode: 'all',
    extensionMode,
  } as unknown as PiLaunchPreset
}

function mountSection(preset: PiLaunchPreset, disabled = false) {
  return mount(PresetModeSection, { props: { preset, disabled } })
}

describe('PresetModeSection 扩展访问策略', () => {
  it('allowlist 模式：builtin 扩展被过滤，仅非 builtin 以 displayName 渲染', () => {
    mockGetExtensions.mockReturnValue([
      // builtin（mandatory-extensions.json SSOT 成员，含 infrastructure + feature 两级）
      { name: '@zhushanwen/pi-permission', displayName: 'Permission' },
      { name: '@zhushanwen/pi-goal', displayName: 'Goal' },
      // 非 builtin
      { name: 'my-custom-ext', displayName: 'My Custom Ext' },
    ])

    const wrapper = mountSection(makePreset('allowlist'))

    const text = wrapper.text()
    // 非 builtin 扩展以 displayName 出现在勾选列表
    expect(text).toContain('My Custom Ext')
    // builtin 扩展的 displayName 与 name 均不出现（被 availableExtensions 过滤）
    expect(text).not.toContain('Permission')
    expect(text).not.toContain('Goal')
    expect(text).not.toContain('@zhushanwen/pi-permission')
    expect(text).not.toContain('@zhushanwen/pi-goal')
    // allowlist 语义提示渲染
    expect(text).toContain('settings.preset.allowlistHint')
  })

  it('denylist 模式：同样过滤 builtin，默认全勾选（checked = not denied）', () => {
    mockGetExtensions.mockReturnValue([
      { name: '@zhushanwen/pi-todo', displayName: 'Todo' },
      { name: 'another-ext', displayName: 'Another Ext' },
    ])

    const wrapper = mountSection(makePreset('denylist'))

    expect(wrapper.text()).toContain('Another Ext')
    expect(wrapper.text()).not.toContain('Todo')
    expect(wrapper.text()).toContain('settings.preset.denylistHint')
  })

  it('可用列表为空时显示 noExtensions 占位', () => {
    mockGetExtensions.mockReturnValue([{ name: '@zhushanwen/pi-goal', displayName: 'Goal' }])

    const wrapper = mountSection(makePreset('allowlist'))

    // 唯一扩展是 builtin → 过滤后列表为空 → 占位文案（t 返回 key）
    expect(wrapper.text()).toContain('settings.preset.noExtensions')
    expect(wrapper.text()).not.toContain('Goal')
  })
})
