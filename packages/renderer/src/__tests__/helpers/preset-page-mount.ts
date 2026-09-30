/**
 * PiPresetsPage 测试共享 mock 骨架（src/__tests__/settings/pi-presets-page.test.ts 与
 * src/components/settings/preset/__tests__/pi-presets-page.test.ts 两套同组件测试单源；
 * 范式同 composer-mount.ts——vi.mock 注册留在测试文件，工厂经顶层 import 转发本 helper
 * 导出）。
 *
 * presetMock 实例由各测试文件在 vi.hoisted 内以内联裸 vi.fn() 字面量创建（vi.hoisted
 * 先于 import 执行，引用本 helper 的工厂会 ReferenceError——实测）；默认 impl 统一由
 * primePresetDefaults 在 beforeEach 注入（同时承担逐用例重置）。vitest 按文件隔离模块
 * 图，两套测试互不共享 mock 状态。
 */
import { vi, type Mock } from 'vitest'
import type { PiLaunchPreset } from '@taiji/shared'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from './settings-transport-stub'

/** preset 门面 mock 形状（六个可断言 mock 方法） */
export interface PresetMock { // oe-exempt:20260930:test:测试 helper 三函数（primePresetDefaults/presetApiModule/wirePresetTransport）共用的 mock 形状契约，两测试文件内联构造
  list: Mock
  getDefault: Mock
  setDefault: Mock
  create: Mock
  update: Mock
  remove: Mock
}

/**
 * preset 门面 mock 默认 impl（空列表 / builtin:full 默认 id / create·update 透传入参）。
 * 在 beforeEach 调用：既是首次注入也覆盖上一用例的 mockResolvedValue 类覆写。
 */
export function primePresetDefaults(presetMock: PresetMock): void {
  presetMock.list.mockResolvedValue([])
  presetMock.getDefault.mockResolvedValue('builtin:full')
  presetMock.setDefault.mockResolvedValue(undefined)
  presetMock.create.mockImplementation((p: PiLaunchPreset) => Promise.resolve(p))
  presetMock.update.mockImplementation((p: PiLaunchPreset) => Promise.resolve(p))
  presetMock.remove.mockResolvedValue(undefined)
}

/** '@/api' mock 工厂（preset 门面经 preset / default.preset 双键暴露；project 组供挂载期加载） */
export function presetApiModule(presetMock: PresetMock) {
  return {
    project: {
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    preset: presetMock,
    default: { preset: presetMock },
  }
}

/**
 * '@taiji/ui/features/settings' stub 工厂（PresetModeSection 平替；GroupCard 保留
 * #head / #actions 具名 slot——提示词卡标题与 Switch 在其中，slot 缺失则测试看不到
 * 卡头与开关，与生产结构失真）。
 */
export function presetUiModule() {
  return {
    PresetModeSection: {
      name: 'PresetModeSection',
      props: ['preset', 'disabled'],
      template: '<div data-testid="mode-section" />',
    },
    GroupCard: {
      name: 'GroupCard',
      template: '<div data-testid="group-card"><slot name="head" /><slot name="actions" /><slot /></div>',
    },
  }
}

/** SettingsTransport seam 桩接线（[C3] preset 域 RPC 逐名映射到 presetMock） */
export function wirePresetTransport(presetMock: PresetMock): void {
  provideSettingsTransport(makeSettingsTransportStub({
    listPresets: presetMock.list,
    getDefaultPreset: presetMock.getDefault,
    setDefaultPreset: presetMock.setDefault,
    createPreset: presetMock.create,
    updatePreset: presetMock.update,
    removePreset: presetMock.remove,
  }))
}

/** 预设 fixture 工厂：共有基础字段单源，差异经 overrides 表达 */
export function makePreset(overrides: Partial<PiLaunchPreset> & Pick<PiLaunchPreset, 'id' | 'name'>): PiLaunchPreset {
  return {
    description: '',
    builtin: false,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
    ...overrides,
  }
}

/** 带提示词两段（替换 3 字符 + 追加 2 字符）的自定义预设 fixture */
export function promptPreset(): PiLaunchPreset {
  return makePreset({
    id: 'custom:prompt-preset',
    name: 'Prompt Preset',
    description: 'Custom preset with prompt',
    order: 1,
    prompt: {
      replace: { enabled: true, prompt: 'abc' },
      append: { enabled: true, prompt: 'de' },
    },
  })
}
