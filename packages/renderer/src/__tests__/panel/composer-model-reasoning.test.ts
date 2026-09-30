/**
 * Composer 模型 reasoning 派生集成测试（composer-shell getModelReasoning 增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/panel/composer-model-reasoning.test.ts
 *
 * 覆盖：composer-shell.ts getSupportedLevels（settingsStore.providers 按 provider/model
 * 解析 models[].supportedLevels，U6 切源）——ThinkingLevelPopover 的 :supported-levels
 * prop 直连该派生，用透传探针 stub 断言真实 Composer 树上档位可用集随 providers 数据
 * 正确落到 DOM：
 *   - reasoning:true 模型（supportedLevels=['off','high']）→ probe data-supported="off,high"
 *   - reasoning:false 模型（pi 两级门控产物 ['off']）→ probe data-supported="off"
 *
 * 范式参照 composer-fork-mode.test.ts（mock useChat/useNewTaskFlow/api + stub 子组件）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import '../helpers/composer-shell-mount'
import { composerApiModule, composerChildStubs, makeKeyboardComposerInputMock } from '../helpers/composer-mount'

// ── 壳 mock（useChat / useNewTaskFlow / stores/session）：import composer-shell-mount 即
//    注册；本文件无 useChat spy 断言，'@/api' 注册留文件内 ──
vi.mock('@/api', () => composerApiModule())
vi.mock('@/composables/features/settings/useProjectSkills', () => ({
  useProjectSkills: () => ({ projectSkills: [] }),
  useGlobalSkills: () => ({ globalSkills: [] }),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSessionAsk: vi.fn(), forkSession: vi.fn() }),
}))

// ── ComposerInput mock：键盘交互变体（placeholder props + 全 expose 面含
//    getText/moveCaretVertical；单源 helpers/composer-mount.ts）──
const { lastInputText, ComposerInputMock } = makeKeyboardComposerInputMock()

// ── ThinkingLevelPopover 透传探针：把 supportedLevels/level 派生落到 DOM 属性 ──
const ThinkingLevelProbe = defineComponent({
  name: 'ThinkingLevelPopover',
  props: {
    level: { type: String, default: '' },
    levelMap: { type: Object, default: undefined },
    supportedLevels: { type: Array as () => string[] | undefined, default: undefined },
  },
  template:
    '<div data-testid="tlp-probe" :data-supported="supportedLevels === undefined ? \'undef\' : supportedLevels.join(\',\')" :data-level="level" />',
})

// ThinkingLevelPopover 用透传探针顶替默认空 stub（探针在后覆盖 spread 默认值）
const otherStubs = {
  ...composerChildStubs,
  ComposerInput: ComposerInputMock,
  ThinkingLevelPopover: ThinkingLevelProbe,
}

import Composer from '@/components/panel/Composer.vue'

/** 构造单 provider 双模型（reasoning true/false）的 providers 快照。 */
function makeProviders(): ProviderInfo[] {
  return [
    {
      id: 'p1',
      name: 'P1',
      apiKeySet: true,
      status: 'connected',
      models: [
        { id: 'm-r', name: 'reasoning model', reasoning: true, thinkingLevelMap: { off: 'off', high: 'high' }, supportedLevels: ['off', 'high'] },
        { id: 'm-plain', name: 'plain model', reasoning: false, supportedLevels: ['off'] },
      ],
    },
  ]
}

function mountComposer() {
  return mount(Composer, { props: { sessionId: null }, global: { stubs: otherStubs } })
}

describe('Composer 档位可用集派生（composer-shell getSupportedLevels，U6 切源）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    lastInputText.value = ''
  })

  it('defaultModel 指向 reasoning:true 模型 → ThinkingLevelPopover 收到 supportedLevels=["off","high"]', async () => {
    const settings = getSettingsStore()
    settings.providers.value = makeProviders()
    settings.defaultModel.value = 'p1/m-r'

    const wrapper = mountComposer()
    await wrapper.vm.$nextTick()

    const probe = wrapper.find('[data-testid="tlp-probe"]')
    expect(probe.exists()).toBe(true)
    expect(probe.attributes('data-supported')).toBe('off,high')
  })

  it('defaultModel 指向 reasoning:false 模型 → probe 收到 ["off"]（pi 两级门控产物，non-reasoning 只 off 档判据）', async () => {
    const settings = getSettingsStore()
    settings.providers.value = makeProviders()
    settings.defaultModel.value = 'p1/m-plain'

    const wrapper = mountComposer()
    await wrapper.vm.$nextTick()

    const probe = wrapper.find('[data-testid="tlp-probe"]')
    expect(probe.attributes('data-supported')).toBe('off')
  })

  it('模型无 supportedLevels 字段（下发未覆盖的旧数据）→ probe 收到 undef（下游归一默认五档）', async () => {
    const settings = getSettingsStore()
    settings.providers.value = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        models: [{ id: 'm-legacy', name: 'legacy model' }],
      },
    ]
    settings.defaultModel.value = 'p1/m-legacy'

    const wrapper = mountComposer()
    await wrapper.vm.$nextTick()

    const probe = wrapper.find('[data-testid="tlp-probe"]')
    expect(probe.attributes('data-supported')).toBe('undef')
  })
})
