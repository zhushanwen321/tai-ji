// @vitest-environment node

import { createNotesAxis, extractLocalizedNotes } from '../use-app-update-notes';
import { createUpdateState } from '../use-app-update-state';
import { staleModelRef, useAuthedModelGroups } from '../useAuthedModelGroups';
import { useScopedModels } from '../useScopedModels';
import { SCOPED_MODEL_RENDERER_TOKEN } from './impl-token';
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub';
import { createSettingsStore, getSettingsStore, provideSettingsStore, provideSettingsTransport } from '@taiji/core';
import type { ProviderInfo } from '@taiji/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← useAuthedModelGroups.test.ts
// ======================================================================

/** 双 provider fixture：zai 已配凭证（2 模型）、xiaomi 已配凭证（1 模型）。 */
function mockProviders(extra: Partial<ProviderInfo> = {}): ProviderInfo[] {
  return [
    {
      id: 'zai',
      name: '智谱',
      apiKeySet: true,
      status: 'ok',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'glm-5.2-air', name: 'GLM-5.2-Air' },
      ],
      ...extra,
    },
    {
      id: 'xiaomi',
      name: '小米',
      apiKeySet: true,
      status: 'ok',
      models: [{ id: 'mimo-v2.6-flash', name: 'MiMo v2.6 Flash' }],
      ...extra,
    },
  ] as ProviderInfo[]
}

beforeEach(() => {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
})

describe('useAuthedModelGroups', () => {
  it('检查：scopedModels 非空时候选仍为全量（不受白名单过滤）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    // 模拟旧 bug 场景：settingsStore.models 已被 scoped 过滤为仅 1 项
    store.models.value = [
      { providerId: 'zai', providerName: '智谱', id: 'glm-5.2', name: 'GLM-5.2' },
    ] as never
    store.scopedModels.value = ['zai/glm-5.2']

    const { modelGroups, availableValues } = useAuthedModelGroups()

    // 候选 = providers 全量 3 模型，而非 models 的 1 模型
    expect(availableValues.value).toEqual(
      new Set(['zai/glm-5.2', 'zai/glm-5.2-air', 'xiaomi/mimo-v2.6-flash']),
    )
    expect(modelGroups.value.map((g) => g.providerId)).toEqual(['zai', 'xiaomi'])
    expect(modelGroups.value[1].models[0]).toEqual({
      value: 'xiaomi/mimo-v2.6-flash',
      label: 'MiMo v2.6 Flash',
    })
  })

  it('scopedModels 为空时候选与修复前行为一致（全量）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    store.scopedModels.value = []

    const { availableValues } = useAuthedModelGroups()
    expect(availableValues.value.size).toBe(3)
  })

  it('D1 过滤：未配凭证 / 禁用 provider 的模型不列', () => {
    const store = getSettingsStore()
    store.providers.value = [
      ...mockProviders(),
      {
        id: 'nokey',
        name: '无凭证',
        apiKeySet: false,
        status: 'ok',
        models: [{ id: 'm1', name: 'M1' }],
      },
      {
        id: 'disabled-p',
        name: '禁用 Provider',
        apiKeySet: true,
        enabled: false,
        status: 'ok',
        models: [{ id: 'm2', name: 'M2' }],
      },
    ] as ProviderInfo[]

    const { availableValues } = useAuthedModelGroups()
    expect(availableValues.value.has('nokey/m1')).toBe(false)
    expect(availableValues.value.has('disabled-p/m2')).toBe(false)
    expect(availableValues.value.size).toBe(3)
  })

  it('D1 过滤：model.enabled === false 的模型不列（禁用口径与 Composer 一致）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    store.providers.value[0] = {
      ...store.providers.value[0],
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'glm-5.2-air', name: 'GLM-5.2-Air', enabled: false },
      ],
    }

    const { availableValues } = useAuthedModelGroups()
    expect(availableValues.value.has('zai/glm-5.2-air')).toBe(false)
    expect(availableValues.value.size).toBe(2)
  })

  it('空分组不渲染：有凭证但全部模型禁用的 provider 不占分组', () => {
    const store = getSettingsStore()
    store.providers.value = [
      {
        id: 'all-disabled',
        name: '全禁用',
        apiKeySet: true,
        status: 'ok',
        models: [{ id: 'm1', name: 'M1', enabled: false }],
      },
    ] as ProviderInfo[]

    const { modelGroups } = useAuthedModelGroups()
    expect(modelGroups.value).toEqual([])
  })

  it('label 回退：model.name 缺省时用 id', () => {
    const store = getSettingsStore()
    store.providers.value = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'ok',
        models: [{ id: 'bare-id' }],
      },
    ] as ProviderInfo[]

    const { modelGroups } = useAuthedModelGroups()
    expect(modelGroups.value[0].models[0].label).toBe('bare-id')
  })

  it('staleModelRef：scoped 外 ref 在全量候选内不再误报 stale（D2 语义修正）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    store.scopedModels.value = ['zai/glm-5.2']
    const { availableValues } = useAuthedModelGroups()

    // 旧实现：xiaomi/mimo-v2.6-flash 不在 scoped 过滤列表 → 误报「不可用」
    expect(staleModelRef('xiaomi/mimo-v2.6-flash', availableValues.value)).toBeNull()
    // 真实不可用（模型被删）仍报 stale
    expect(staleModelRef('zai/deleted', availableValues.value)).toBe('zai/deleted')
    // 空串（未设置语义）恒不 stale
    expect(staleModelRef('', availableValues.value)).toBeNull()
  })
})

// ======================================================================
// ← useScopedModels.test.ts
// ======================================================================

const configMock = vi.hoisted(() => ({
  setScopedModels: vi.fn(async () => [] as string[]),
}))

// [C3] setScopedModels 经 SettingsTransport seam 桩注入（替换原 @/api 门面 mock）

const MOCK_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    apiKeySet: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiKeySet: false,
    models: [
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    ],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  configMock.setScopedModels.mockReset()
  provideSettingsTransport(makeSettingsTransportStub(configMock))
})

describe('useScopedModels', () => {
  it('A3: impl-token 存在（红阶段区分力检查）', () => {
    expect(SCOPED_MODEL_RENDERER_TOKEN).toBe('scoped-model-renderer-v1')
  })

  it('A3: scopedRenderItems 从 settingsStore.scopedModels + providers 派生', () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'deleted/missing']

    const { scopedRenderItems } = useScopedModels()
    const items = scopedRenderItems.value
    expect(items.length).toBe(3)

    expect(items[0].modelName).toBe('GPT-4o')
    expect(items[0].providerName).toBe('OpenAI')
    expect(items[0].apiKeySet).toBe(true)
    expect(items[0].missing).toBe(false)

    expect(items[1].modelName).toBe('Claude Sonnet 4.5')
    expect(items[1].providerName).toBe('Anthropic')
    expect(items[1].apiKeySet).toBe(false)
    expect(items[1].missing).toBe(false)

    expect(items[2].missing).toBe(true)
  })

  it('A3: selectableModels 从 providers 派生全量模型列表', () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any

    const { selectableModels } = useScopedModels()
    const models = selectableModels.value
    expect(models.length).toBe(3)
    expect(models[0].fullId).toBe('openai/gpt-4o')
    expect(models[1].fullId).toBe('openai/gpt-4o-mini')
    expect(models[2].fullId).toBe('anthropic/claude-sonnet-4.5')
  })

  it('A3: addScopedModels 乐观更新 + RPC 成功 → 状态保持', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    configMock.setScopedModels.mockResolvedValueOnce(['openai/gpt-4o', 'openai/gpt-4o-mini'])

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o-mini'])

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o', 'openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A3: addScopedModels RPC 失败 → 回滚到旧值 + rethrow（调用方反馈）', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('network error'))

    const { addScopedModels } = useScopedModels()
    await expect(addScopedModels(['openai/gpt-4o-mini'])).rejects.toThrow('network error')

    // 回滚
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })

  it('A3: removeScopedModel 乐观更新 + RPC 成功 → 状态保持', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'openai/gpt-4o-mini']

    configMock.setScopedModels.mockResolvedValueOnce(['openai/gpt-4o-mini'])

    const { removeScopedModel } = useScopedModels()
    await removeScopedModel('openai/gpt-4o')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o-mini'])
  })

  it('A3: removeScopedModel RPC 失败 → 回滚 + rethrow', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'openai/gpt-4o-mini']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('fail'))

    const { removeScopedModel } = useScopedModels()
    await expect(removeScopedModel('openai/gpt-4o')).rejects.toThrow('fail')

    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A3: moveScopedModel 上移 → 顺序变化 + RPC 成功', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockResolvedValueOnce(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('anthropic/claude-sonnet-4.5', 'up')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: moveScopedModel 下移 → 顺序变化 + RPC 成功', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockResolvedValueOnce(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('openai/gpt-4o', 'down')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: moveScopedModel RPC 失败 → 回滚顺序 + rethrow', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('fail'))

    const { moveScopedModel } = useScopedModels()
    await expect(moveScopedModel('openai/gpt-4o', 'down')).rejects.toThrow('fail')

    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4.5'])
  })

  it('A3: move in-flight 时连点第二次触发被忽略（模块级防重入检查）', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    // 第一次 RPC 挂起（deferred），锁定 in-flight 窗口
    let resolveFirst: (v: string[]) => void = () => {}
    configMock.setScopedModels.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveFirst = resolve }),
    )

    const { moveScopedModel } = useScopedModels()
    const first = moveScopedModel('openai/gpt-4o', 'down')
    // 连点：第一次乐观交换后 anthropic 位于 idx0，其 down 本有效（无检查会二次 RPC），
    // 检查生效 → 直接忽略，不排队、不改快照
    await moveScopedModel('anthropic/claude-sonnet-4.5', 'down')

    // 乐观状态 = 仅第一次交换结果
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    resolveFirst(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    await first

    expect(configMock.setScopedModels).toHaveBeenCalledTimes(1)
    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: addScopedModels 跳过已存在的重复项', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o'])

    // 不调 RPC（无新项）
    expect(configMock.setScopedModels).not.toHaveBeenCalled()
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })
})

// ======================================================================
// ← use-app-update-notes.test.ts
// ======================================================================

const i18nMock = vi.hoisted(() => ({ locale: 'zh-CN' }))

vi.mock('@/i18n', () => ({
  getLocale: vi.fn(() => i18nMock.locale),
}))

vi.mock('@taiji/ui/features/chat/markdown', () => ({
  renderMarkdown: vi.fn(async (md: string) => `<p>${md}</p>`),
}))

const BILINGUAL_BODY = '<!-- LANG:en -->\n- Fix bug X\n\n<!-- LANG:zh -->\n- 修复 bug X\n'

describe('extractLocalizedNotes', () => {
  beforeEach(() => {
    i18nMock.locale = 'zh-CN'
  })

  it('带标记：zh locale 提取 zh 段（en 段在标记序中靠前不干扰）', () => {
    expect(extractLocalizedNotes(BILINGUAL_BODY)).toBe('- 修复 bug X')
  })

  it('带标记：en locale 提取 en 段', () => {
    i18nMock.locale = 'en-US'
    expect(extractLocalizedNotes(BILINGUAL_BODY)).toBe('- Fix bug X')
  })

  it('无标记：原文透传（向后兼容旧 release）', () => {
    const plain = '- Fix bug X\n- 修复 bug X\n'
    expect(extractLocalizedNotes(plain)).toBe(plain)
  })

  it('非 LANG 的 HTML 注释不触发解析模式，原文透传', () => {
    const body = '- notes\n<!-- generated-by-ci -->\n- more notes\n'
    expect(extractLocalizedNotes(body)).toBe(body)
  })

  it('目标语言缺失：回退英文段', () => {
    i18nMock.locale = 'zh-CN'
    const body = '<!-- LANG:fr -->Bonjour\n\n<!-- LANG:en -->Hello'
    expect(extractLocalizedNotes(body)).toBe('Hello')
  })

  it('目标语言与英文均缺失：回退第一段', () => {
    i18nMock.locale = 'zh-CN'
    const body = '<!-- LANG:fr -->Bonjour\n\n<!-- LANG:de -->Hallo'
    expect(extractLocalizedNotes(body)).toBe('Bonjour')
  })

  it('标记存在但解析不出任何段落（标记位于末尾无内容）：兜底返回原文', () => {
    i18nMock.locale = 'zh-CN'
    const body = '<!-- LANG:en -->'
    expect(extractLocalizedNotes(body)).toBe(body)
  })

  it('标记值大小写与多余空格归一：LANG:ZH + 尾随空格命中 zh 段', () => {
    const body = '<!-- LANG:ZH  -->中文内容\n\n<!-- LANG:en -->English'
    expect(extractLocalizedNotes(body)).toBe('中文内容')
  })

  it('段内容经 trim（标记后的空白行与首尾空白不进结果）', () => {
    const body = '<!-- LANG:zh -->\n\n  内容  \n\n<!-- LANG:en -->x'
    expect(extractLocalizedNotes(body)).toBe('内容')
  })

  it('首个标记之前的前导内容不归入任何段（标记即分段起点）', () => {
    i18nMock.locale = 'en-US'
    const body = '前言说明（不属任何语言段）\n<!-- LANG:en -->Hello'
    expect(extractLocalizedNotes(body)).toBe('Hello')
  })
})

describe('renderReleaseNotes — 传值矩阵「更新日志」行（设计 markdown-html-sanitize-render D4）', () => {
  beforeEach(() => {
    i18nMock.locale = 'zh-CN'
  })

  it('renderMarkdown 不携带 env（resourceBaseDir 恒 undefined——release notes 无相对资源语义，不回归）', async () => {
    const markdown = await import('@taiji/ui/features/chat/markdown')
    // 容器化后渲染轴经工厂持有 state（C5）：测试建独立容器实例，无需单例复位
    const { renderReleaseNotes } = createNotesAxis(createUpdateState())
    renderReleaseNotes(BILINGUAL_BODY)
    // 既有行为回归断言：UpdateButton 渲染范围调 renderMarkdown 只传内容不传 env（env 缺省 →
    // 净化 hook 的 resourceBaseDir undefined → 相对 src 不重写、④路 preventDefault 无动作）
    expect(markdown.renderMarkdown).toHaveBeenCalledOnce()
    const [notes, env] = vi.mocked(markdown.renderMarkdown).mock.calls[0] ?? []
    expect(notes).toBe('- 修复 bug X')
    expect(env).toBeUndefined()
  })
})
