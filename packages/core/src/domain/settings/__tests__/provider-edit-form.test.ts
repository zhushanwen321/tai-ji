/**
 * provider-edit-form（表单草稿 + dirty/快照 module）interface 级测试（[C4] 拆分后按 module
 * 打点，原 use-provider-edit.test.ts 的 form/save/headers/B-1 各组用例迁移至此）。
 *
 * 覆盖：isDirty 快照矩阵（D13）/ save 校验与 apiKey 合并协议（D15b + D18 哨兵三态）/
 * wroteApiKey 语义 / 防线① provider 级字段分体系（catalog vs custom，设计 D1）/
 * B-1 凭证形态回传与切换守卫 / headers 行编辑 CRUD（W3 D7）/ D8 调用点应用语义
 * （watch → reconcileBroadcast 纯核 → 机械应用，规则本体矩阵在 provider-edit-reconcile.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Ref } from 'vue'
import { ref, effectScope, nextTick } from 'vue'
import type { ProviderInfo, ProviderId, SetProviderData } from '@taiji/shared'
import {
  provideSettingsTransport,
  type SettingsTransport,
} from '../transport'
import { makeFakeTransport } from './helpers/fake-transport'
import {
  createProviderEditForm,
  API_KEY_CLEAR_SENTINEL,
  type ProviderEditFormModule,
} from '../provider-edit-form'
import { createProviderEditModels, type ProviderEditModelsModule } from '../provider-edit-models'

/** i18n stub：返回 key 本身（校验调用参数而非翻译）。 */
const tStub = vi.fn((key: string) => key)

// fake transport 工厂迁 ./helpers/fake-transport（[C3] seam 方法面全覆盖共享工厂）

/** 当前注入的 fake transport（模块级，供断言用）。 */
let currentTransport: SettingsTransport

function getTransport(): SettingsTransport {
  return currentTransport
}

beforeEach(() => {
  currentTransport = makeFakeTransport()
  provideSettingsTransport(currentTransport)
  tStub.mockClear()
  tStub.mockImplementation((key: string) => key)
})

let scope: ReturnType<typeof effectScope> | null = null

afterEach(() => {
  scope?.stop()
  scope = null
})

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'p1' as ProviderId,
    name: 'P1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.example.com',
    apiKeySet: true,
    status: 'connected',
    headers: { 'X-Test': 'v1' },
    authHeader: false,
    models: [
      { id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true },
    ],
    enabled: true,
    ...overrides,
  }
}

interface MountedForm {
  form: ProviderEditFormModule
  models: ProviderEditModelsModule
  providerRef: Ref<ProviderInfo | null>
  /** D8 广播数据源（测试驱动 providers 整体替换 = onProviders 广播） */
  providers: Ref<ProviderInfo[]>
}

/**
 * 挂 form module（models module 同场装配——isDirty 的 modelsJson 对比 + save 载荷来源）。
 * 载入序对齐 facade：applyProvider → 瞬态重置 → captureSnapshot。
 */
function mountForm(provider: ProviderInfo | null = makeProvider(), options: { captureSnapshot?: boolean } = {}): MountedForm {
  const providerRef = ref<ProviderInfo | null>(provider)
  const providers = ref<ProviderInfo[]>([])
  scope = effectScope()
  // effectScope.run 类型签名 T | undefined——活动 scope 内同步返回值恒非空
  return scope!.run(() => {
    const models = createProviderEditModels({ t: tStub })
    const form = createProviderEditForm({ providerRef, providers, models, t: tStub })
    form.applyProvider(providerRef.value)
    models.applyProvider(providerRef.value)
    form.resetTransient()
    models.resetTransient()
    if (options.captureSnapshot !== false) form.captureSnapshot()
    return { form, models, providerRef, providers }
  })!
}

/** save payload（setProvider 第 2 参） */
function savePayload(index = 0): SetProviderData {
  const spy = getTransport().setProvider as ReturnType<typeof vi.fn>
  expect(spy.mock.calls.length).toBeGreaterThan(index)
  return spy.mock.calls[index]![1] as SetProviderData
}

describe('isDirty 快照矩阵（D13）', () => {
  it('快照未捕获 → false（未初始化不误报 dirty）', () => {
    // 跳过 captureSnapshot 的裸装配形态（snapshot = null）——用户改了字段也不判 dirty
    const { form } = mountForm(makeProvider(), { captureSnapshot: false })
    form.draft.name = 'edited'
    expect(form.isDirty.value).toBe(false)
  })

  it('改 name/api/baseUrl/apiKey/models/authHeader/headers/authMethod 各触发 true（可逆字段复位回 false）', () => {
    const { form, models } = mountForm()
    expect(form.isDirty.value).toBe(false)

    form.draft.name = 'P2'
    expect(form.isDirty.value).toBe(true)
    form.draft.name = 'P1'
    expect(form.isDirty.value).toBe(false)

    form.draft.api = 'openai-completions'
    expect(form.isDirty.value).toBe(true)
    form.draft.api = 'anthropic-messages'
    expect(form.isDirty.value).toBe(false)

    form.draft.baseUrl = 'https://other.example.com'
    expect(form.isDirty.value).toBe(true)
    form.draft.baseUrl = 'https://api.example.com'
    expect(form.isDirty.value).toBe(false)

    // apiKey：输入值 → dirty
    form.draft.apiKey = 'sk-abc'
    expect(form.isDirty.value).toBe(true)
    form.draft.apiKey = ''
    expect(form.isDirty.value).toBe(false)

    // models 整体增删 → dirty
    models.localModels.value.push({ id: 'm2', name: 'M2' })
    expect(form.isDirty.value).toBe(true)
    models.localModels.value.pop()
    expect(form.isDirty.value).toBe(false)

    // authHeader → dirty
    form.draft.authHeader = true
    expect(form.isDirty.value).toBe(true)
    form.draft.authHeader = false
    expect(form.isDirty.value).toBe(false)

    // headers → dirty
    form.draft.headers['X-Test'] = 'v2'
    expect(form.isDirty.value).toBe(true)
    form.draft.headers['X-Test'] = 'v1'
    expect(form.isDirty.value).toBe(false)

    // B-1：凭证形态切换 → dirty
    form.draft.authMethod = 'oauth'
    expect(form.isDirty.value).toBe(true)
    form.draft.authMethod = undefined
    expect(form.isDirty.value).toBe(false)
  })
})

describe('save：校验与 apiKey 合并协议（D15b / D18）', () => {
  it('空 name → false + providerNameRequired（不经 setProvider）', async () => {
    const { form } = mountForm(null)
    const result = await form.save()
    expect(result.ok).toBe(false)
    expect(result.wroteApiKey).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.providerNameRequired')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })

  it('成功：setProvider 参数（apiKey 空 → undefined「不变」；headers 回写；authHeader；models 透传）', async () => {
    const { form } = mountForm()
    form.draft.name = 'P1-renamed'
    form.draft.apiKey = ''
    form.draft.authHeader = true
    const result = await form.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(false)
    expect(getTransport().setProvider).toHaveBeenCalledWith('p1', {
      name: 'P1-renamed',
      type: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: undefined,
      headers: { 'X-Test': 'v1' },
      authHeader: true,
      models: [
        { id: 'm1', name: 'M1', api: undefined, baseUrl: undefined, contextWindow: 200_000, input: undefined, thinkingLevelMap: undefined, compat: undefined, enabled: true },
      ],
    })
  })

  it('apiKey 哨兵 → 发送空串（清空语义 D18），wroteApiKey=false（清除不是配置）', async () => {
    const { form } = mountForm(makeProvider({ kind: 'custom' }))
    form.draft.apiKey = API_KEY_CLEAR_SENTINEL
    const result = await form.save()
    expect(result.wroteApiKey).toBe(false)
    const arg = savePayload()
    // 显式空串带键（不是不传键）——「清除」与「不变」必须可区分
    expect('apiKey' in arg).toBe(true)
    expect(arg.apiKey).toBe('')
  })

  it('apiKey 非空 → 原值透传，wroteApiKey=true（自动启用信号）', async () => {
    const { form } = mountForm()
    form.draft.apiKey = 'sk-foo'
    const result = await form.save()
    expect(result.wroteApiKey).toBe(true)
    expect(savePayload().apiKey).toBe('sk-foo')
  })

  it('headers 空对象 → 不传 headers（undefined，避免覆盖 runtime 既有值）', async () => {
    const { form } = mountForm()
    form.draft.headers = {}
    await form.save()
    expect(savePayload().headers).toBeUndefined()
  })

  it('失败：setProvider reject → false + actionError + saving 收尾', async () => {
    const { form } = mountForm()
    getTransport().setProvider = vi.fn(async () => { throw new Error('save failed') })
    const result = await form.save()
    expect(result.ok).toBe(false)
    expect(result.wroteApiKey).toBe(false)
    expect(form.actionError.value).toBe('save failed')
    expect(form.saving.value).toBe(false)
  })
})

describe('防线① provider 级字段分体系（catalog vs custom，设计 D1）', () => {
  it('catalog：payload 无 type 键（快照 artifact 不回传）+ baseUrl 带键且为 trim 值', async () => {
    const { form } = mountForm(makeProvider({ kind: 'catalog' }))
    form.draft.baseUrl = '  https://gateway.example.com/mirror  '
    await form.save()
    const arg = savePayload()
    expect('type' in arg).toBe(false)
    expect('baseUrl' in arg).toBe(true)
    expect(arg.baseUrl).toBe('https://gateway.example.com/mirror')
  })

  it('catalog：输入框清空 → baseUrl 为显式空串带键（清除网关；不传键=runtime「不变」会让网关回退不可达）', async () => {
    const { form } = mountForm(makeProvider({ kind: 'catalog', baseUrl: 'https://gateway.example.com' }))
    expect(form.draft.baseUrl).toBe('https://gateway.example.com')
    form.draft.baseUrl = ''
    await form.save()
    const arg = savePayload()
    expect('baseUrl' in arg).toBe(true)
    expect(arg.baseUrl).toBe('')
    expect('type' in arg).toBe(false)
  })

  it('custom：空串 baseUrl 不带键（truthy 守卫；runtime 侧空串同为「不变」语义）', async () => {
    // kind 缺失（旧数据/新建态）= custom 分支
    const { form } = mountForm()
    form.draft.baseUrl = '   '
    await form.save()
    const arg = savePayload()
    expect('baseUrl' in arg).toBe(false)
    // custom 的 provider 级协议（api）必须保留
    expect(arg.type).toBe('anthropic-messages')
  })

  it('custom：空串 name 被 D15b 校验拦截（不调 setProvider → payload 不会带 name 键）', async () => {
    // 空 name 在 save() 入口即被 D15b 拒绝，payload 层的 truthy 守卫是纵深防御（正常路径不可达）
    const { form } = mountForm()
    form.draft.name = ''
    const result = await form.save()
    expect(result.ok).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.providerNameRequired')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })
})

describe('save：B-1 凭证形态回传与切换守卫', () => {
  it('切换形态 → isDirty；保存 payload 透传 authMethod', async () => {
    const { form } = mountForm(makeProvider({ authMethod: 'api_key' }))
    expect(form.draft.authMethod).toBe('api_key')
    expect(form.isDirty.value).toBe(false)

    form.draft.authMethod = 'oauth'
    expect(form.isDirty.value).toBe(true)
    await form.save()
    expect(savePayload().authMethod).toBe('oauth')
  })

  it('oauth→api_key 切换 + 空 key → 守卫拦截（oauthSwitchNeedsKey，不经 setProvider）', async () => {
    const { form } = mountForm(makeProvider({ authMethod: 'oauth' }))
    form.draft.authMethod = 'api_key'
    form.draft.apiKey = '' // 未填新 key
    const result = await form.save()
    expect(result.ok).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.oauthSwitchNeedsKey')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })

  it('oauth→api_key 切换 + 新 key → payload authMethod=api_key + apiKey（覆写 OAuth 凭证的写路径）', async () => {
    const { form } = mountForm(makeProvider({ authMethod: 'oauth' }))
    form.draft.authMethod = 'api_key'
    form.draft.apiKey = 'sk-new'
    const result = await form.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(true)
    const arg = savePayload()
    expect(arg.authMethod).toBe('api_key')
    expect(arg.apiKey).toBe('sk-new')
  })

  it('无 authMethod（旧数据/新建）→ payload authMethod=undefined（runtime 跳过不写）', async () => {
    const { form } = mountForm()
    expect(form.draft.authMethod).toBeUndefined()
    await form.save()
    expect(savePayload().authMethod).toBeUndefined()
  })
})

describe('headers 行编辑 CRUD（W3 D7）', () => {
  it('addHeader 新增空行；removeHeader 移除 + 同步 draft.headers', () => {
    const { form } = mountForm()
    form.addHeader()
    expect(form.headerRows.value).toHaveLength(2) // 1（回填）+ 1
    form.headerRows.value[1] = { key: 'X-New', value: 'v2' }
    form.syncHeadersFromRows()
    expect(form.draft.headers['X-New']).toBe('v2')
    form.removeHeader(1)
    expect(form.headerRows.value).toHaveLength(1)
    expect(form.draft.headers['X-New']).toBeUndefined()
  })

  it('重复 key → actionError duplicateHeaderKey（修复后清错误）', () => {
    const { form } = mountForm(null)
    form.headerRows.value = [
      { key: 'X-A', value: '1' },
      { key: 'X-A', value: '2' },
    ]
    form.syncHeadersFromRows()
    expect(form.actionError.value).toBe('composable.duplicateHeaderKey')
    // 去重后错误清除（非永久挂起）
    form.removeHeader(1)
    expect(form.actionError.value).toBe('')
  })

  it('headers 错误清除按来源判定：save 来源错误不被 headers 同步误清（MF-1-7）', () => {
    const { form } = mountForm(null)
    // save 来源错误先置入（保存失败残留形态）
    form.setActionError('save', 'save failed')
    // headers 无重复同步 → save 来源错误保留（不误清）
    form.syncHeadersFromRows()
    expect(form.actionError.value).toBe('save failed')
    // headers 来源错误置入 → 重复 key 消除后仅该错误被清除
    form.headerRows.value = [
      { key: 'X-A', value: '1' },
      { key: 'X-A', value: '2' },
    ]
    form.syncHeadersFromRows()
    expect(form.actionError.value).toBe('composable.duplicateHeaderKey')
    form.removeHeader(1)
    expect(form.actionError.value).toBe('')
  })

  it('locale 切换后 headers 错误仍能被清除（归属按 source 标签，不比对展示文案，MF-1-7）', () => {
    const { form } = mountForm(null)
    form.headerRows.value = [
      { key: 'X-A', value: '1' },
      { key: 'X-A', value: '2' },
    ]
    form.syncHeadersFromRows()
    expect(form.actionError.value).toBe('composable.duplicateHeaderKey')
    // locale 切换：同 key 的文案运行时值变化（stub 由「返回 key」切到「加 en: 前缀」）
    tStub.mockImplementation((key: string) => `en:${key}`)
    // 用户修正重复 key → syncHeadersFromRows（经 removeHeader 触发，与真实 UI 路径一致）
    form.removeHeader(1)
    expect(form.actionError.value).toBe('')
  })
})

describe('save：跨 module 集成（models 供给载荷，B-2 回传规则）', () => {
  it('catalog provider save：models 只含 override + 新条目（builtin 不出现）', async () => {
    const { form, models } = mountForm(makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
      ],
    }))
    models.newModel.name = 'new-model'
    models.addModel()
    await form.save()
    expect((savePayload().models as Array<{ id: string }>).map((m) => m.id)).toEqual(['o1', 'new-model'])
  })

  it('删除唯一 override 条目后保存 → payload models 为空数组（builtin 仍不回传）', async () => {
    const { form, models } = mountForm(makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
      ],
    }))
    models.removeModel(0)
    await form.save()
    expect(savePayload().models).toEqual([])
  })
})

describe('D8/S8 调用点应用语义（watch → reconcileBroadcast → 机械应用）', () => {
  it('非 dirty + 同 id provider 广播 → 表单重拍 + 快照重捕获（仍 isDirty false）', async () => {
    const { form, providers } = mountForm()
    // 外部广播替换 providers（新 name）
    providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(form.draft.name).toBe('P1-broadcast')
    expect(form.isDirty.value).toBe(false) // 快照已重捕获
  })

  it('dirty 后广播 → 不刷新（用户改动优先，分支③）', async () => {
    const { form, providers } = mountForm()
    form.draft.name = 'P1-user-edit'
    expect(form.isDirty.value).toBe(true)
    providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(form.draft.name).toBe('P1-user-edit') // 不刷新
  })

  it('S8-1：dirty（其他字段编辑中）+ 广播 authMethod=oauth → 对齐该字段且不覆盖用户编辑；save 不回写旧标注', async () => {
    const { form, providers } = mountForm(makeProvider({ authMethod: 'api_key' }))
    // 用户有其他未保存编辑（如改 name）→ dirty
    form.draft.name = 'P1-user-edit'
    expect(form.isDirty.value).toBe(true)

    // 父组件完成 OAuth 授权 → setProvider authMethod='oauth' → onProviders 广播回推
    providers.value = [makeProvider({ authMethod: 'oauth' })]
    await nextTick()

    // authMethod 强制对齐（dirty 单字段例外），name 保留用户未保存编辑
    expect(form.draft.authMethod).toBe('oauth')
    expect(form.draft.name).toBe('P1-user-edit')

    // 快照 authMethod 位已手改重拍：保存 payload authMethod='oauth'，apiKey 空 → undefined
    // （不覆写刚登录的 oauth 凭证）
    const result = await form.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(false)
    const arg = savePayload()
    expect(arg.authMethod).toBe('oauth')
    expect(arg.apiKey).toBeUndefined()
  })

  it('S8-2：用户已手动切换形态（pending 未保存）→ 广播不覆写本地切换意图', async () => {
    const { form, providers } = mountForm(makeProvider({ authMethod: 'oauth' }))
    form.draft.authMethod = 'api_key' // 用户 pending 切换（dirty 由 authMethod 贡献）
    expect(form.isDirty.value).toBe(true)

    providers.value = [makeProvider({ authMethod: 'oauth' })]
    await nextTick()

    // 广播携带的 oauth 不强制对齐——本地切换意图优先（保存时按用户选择写 api_key）
    expect(form.draft.authMethod).toBe('api_key')
  })
})
