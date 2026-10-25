/**
 * provider-edit-form（表单草稿 + dirty/快照 module）interface 级测试（[C4] 拆分后按 module
 * 打点，原 use-provider-edit.test.ts 的 form/save/headers/B-1 各组用例迁移至此）。
 *
 * 覆盖：isDirty 快照矩阵（D13）/ save 校验与 apiKey 合并协议（D15b + D18 哨兵三态）/
 * wroteApiKey 语义 / 防线① provider 级字段分体系（catalog vs custom，设计 D1）/
 * B-1 凭证形态回传与切换检查 / headers 行编辑 CRUD（W3 D7）/ D8 调用点应用语义
 * （watch → reconcileBroadcast 纯核 → 机械应用，规则本体矩阵在 provider-edit-reconcile.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Ref } from 'vue'
import { ref, nextTick } from 'vue'
import type { ProviderInfo, SetProviderData } from '@taiji/shared'
import {
  provideSettingsTransport,
  type SettingsTransport,
} from '../transport'
import { makeFakeTransport } from './helpers/fake-transport'
import {
  makeProvider,
  createTStub,
  resetTStub,
  createEffectScopeTracker,
} from './helpers/provider-edit-testbed'
import {
  createProviderEditForm,
  API_KEY_CLEAR_SENTINEL,
  type ProviderEditFormModule,
} from '../provider-edit-form'
import { createProviderEditModels, type ProviderEditModelsModule } from '../provider-edit-models'

/** i18n stub：返回 key 本身（校验调用参数而非翻译）。 */
const tStub = createTStub()

// fake transport 工厂迁 ./helpers/fake-transport（[C3] seam 方法侧全覆盖共享工厂）
// provider fixture 工厂 / tStub / effectScope 生命周期迁 ./helpers/provider-edit-testbed

/** 当前注入的 fake transport（模块级，供断言用）。 */
let currentTransport: SettingsTransport

function getTransport(): SettingsTransport {
  return currentTransport
}

beforeEach(() => {
  currentTransport = makeFakeTransport()
  provideSettingsTransport(currentTransport)
  resetTStub(tStub)
})

/** effectScope 生命周期（mountForm 挂载 / afterEach 回收）。 */
const scopes = createEffectScopeTracker()

afterEach(() => {
  scopes.stopScope()
})

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
  return scopes.runInScope(() => {
    const models = createProviderEditModels({ t: tStub })
    const form = createProviderEditForm({ providerRef, providers, models, t: tStub })
    form.applyProvider(providerRef.value)
    models.applyProvider(providerRef.value)
    form.resetTransient()
    models.resetTransient()
    if (options.captureSnapshot !== false) form.captureSnapshot()
    return { form, models, providerRef, providers }
  })
}

/** save payload（setProvider 第 2 参） */
function savePayload(index = 0): SetProviderData {
  const spy = getTransport().setProvider as ReturnType<typeof vi.fn>
  expect(spy.mock.calls.length).toBeGreaterThan(index)
  return spy.mock.calls[index]![1] as SetProviderData
}

/**
 * headers 重复 key 场景装配（headers 错误三用例共用 given 步）：置入两行同 key X-A +
 * 同步进 draft，断言 duplicateHeaderKey 已置入（装配自带验证，防 given 静默失效）。
 */
function givenDuplicateHeaderRows(form: ProviderEditFormModule): void {
  form.headerRows.value = [
    { key: 'X-A', value: '1' },
    { key: 'X-A', value: '2' },
  ]
  form.syncHeadersFromRows()
  expect(form.actionError.value).toBe('composable.duplicateHeaderKey')
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

  it('clearApiKey 写清除哨兵 → dirty，且 save 走空串清除语义（D18）', async () => {
    const { form } = mountForm(makeProvider({ kind: 'custom' }))
    expect(form.isDirty.value).toBe(false)

    form.clearApiKey()
    // 哨兵进 draft（不是空串——区分「用户未动」与「显式清除」）
    expect(form.draft.apiKey).toBe(API_KEY_CLEAR_SENTINEL)
    expect(form.isDirty.value).toBe(true)

    const result = await form.save()
    expect(result.wroteApiKey).toBe(false)
    expect(savePayload().apiKey).toBe('')
  })
})

describe('已存 API Key 回显（2026-10-18，眼睛按钮）', () => {
  /** reveal RPC 桩（当前注入 fake transport 的 revealProviderApiKey） */
  function revealSpy() {
    return getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
  }

  it('拉取成功 → 草稿填充（原值，$ENV 引用不解析）+ showKey 置位 + 不构成 dirty', async () => {
    const { form } = mountForm(makeProvider({ apiKeySet: true }))
    revealSpy().mockResolvedValue({ available: true, apiKey: '$OPENAI_API_KEY', source: 'models.json' })

    expect(form.isDirty.value).toBe(false)
    await form.revealApiKey()

    expect(revealSpy()).toHaveBeenCalledWith('p1')
    expect(form.draft.apiKey).toBe('$OPENAI_API_KEY')
    expect(form.showKey.value).toBe(true)
    // 回显 = 展示所存值，不得因此进入 dirty（否则一打开回显就出现「未保存」）
    expect(form.isDirty.value).toBe(false)
  })

  it('回显后未改动直接保存 → 不带 apiKey 值 + wroteApiKey=false（不回写凭据）', async () => {
    const { form } = mountForm(makeProvider())
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()

    form.draft.name = 'P2' // 制造一次真改动，走完整 save 流
    const result = await form.save()

    expect(savePayload().name).toBe('P2')
    expect(savePayload().apiKey).toBeUndefined()
    expect(result.wroteApiKey).toBe(false)
  })

  it('回显后再编辑 → dirty=true 且保存回写新值', async () => {
    const { form } = mountForm(makeProvider())
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.isDirty.value).toBe(false)

    form.draft.apiKey = 'sk-new'
    expect(form.isDirty.value).toBe(true)

    const result = await form.save()
    expect(savePayload().apiKey).toBe('sk-new')
    expect(result.wroteApiKey).toBe(true)
  })

  it('草稿非空时 revealApiKey 为空操作（用户输入优先，不发 RPC）', async () => {
    const { form } = mountForm(makeProvider())
    form.draft.apiKey = 'sk-typed'
    await form.revealApiKey()

    expect(revealSpy()).not.toHaveBeenCalled()
    expect(form.draft.apiKey).toBe('sk-typed')
  })

  it('available:false → 返回 ok:false（不写 actionError，失败文案由调用方 toast 承载，SG-1），不改草稿、不置 showKey', async () => {
    const { form } = mountForm(makeProvider({ apiKeySet: true }))
    revealSpy().mockResolvedValue({ available: false })

    await expect(form.revealApiKey()).resolves.toEqual({
      ok: false,
      error: 'composable.revealApiKeyUnavailable',
    })
    // SG-1：不落 actionError（否则之后的无关编辑会把滞后的回显失败文案带进保存条）
    expect(form.actionError.value).toBe('')
    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
  })

  it('RPC 失败 → 返回 ok:false + 错误文案（调用方负责可见反馈，禁静默无动作），不写 actionError，revealing 复位', async () => {
    const { form } = mountForm(makeProvider({ apiKeySet: true }))
    revealSpy().mockRejectedValue(new Error('runtime down'))

    await expect(form.revealApiKey()).resolves.toEqual({ ok: false, error: 'runtime down' })
    expect(form.actionError.value).toBe('')
    expect(form.revealingApiKey.value).toBe(false)
  })

  it('回显成功返回 ok:true；apiKeyPendingDraft 排除回显值（配额区不误报已填未保存）', async () => {
    const { form } = mountForm(makeProvider())
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })

    await expect(form.revealApiKey()).resolves.toEqual({ ok: true })
    // 回显值 = 所存值，不是待保存草稿
    expect(form.apiKeyPendingDraft.value).toBe('')

    form.draft.apiKey = 'sk-edited'
    expect(form.apiKeyPendingDraft.value).toBe('sk-edited')
  })

  it('切换 provider → 回显态与草稿同批清空（回显值不得跨 provider 复用）', async () => {
    const { form, providerRef } = mountForm(makeProvider())
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-p1', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-p1')

    const other = makeProvider({ id: 'p2' as ProviderInfo['id'], apiKeySet: true })
    providerRef.value = other
    form.applyProvider(other)

    expect(form.draft.apiKey).toBe('')
    // 新 provider 上重新回显应重新拉取（旧回显值不得残留为基线）
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-p2', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-p2')
    expect(form.isDirty.value).toBe(false)
  })

  it('回显期间用户输入 → 迟到响应不覆盖用户输入（MF-1-3）', async () => {
    const { form } = mountForm(makeProvider({ apiKeySet: true }))
    let resolveReveal!: (v: { available: boolean; apiKey?: string; source?: 'auth.json' | 'models.json' }) => void
    revealSpy().mockImplementation(() => new Promise((resolve) => { resolveReveal = resolve }))

    const pending = form.revealApiKey()
    // 等待在途期间用户输入（草稿非空 → 用户输入优先）
    form.draft.apiKey = 'sk-typed'
    resolveReveal({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await expect(pending).resolves.toEqual({ ok: true })

    expect(form.draft.apiKey).toBe('sk-typed')
    expect(form.showKey.value).toBe(false)
    expect(form.revealingApiKey.value).toBe(false)
  })

  it('回显期间切换 provider → 迟到响应不写进新 provider（MF-1-3）', async () => {
    const { form, providerRef } = mountForm(makeProvider({ apiKeySet: true }))
    let resolveReveal!: (v: { available: boolean; apiKey?: string; source?: 'auth.json' | 'models.json' }) => void
    revealSpy().mockImplementation(() => new Promise((resolve) => { resolveReveal = resolve }))

    const pending = form.revealApiKey()
    // 切换 provider（facade 的重置序：applyProvider + 快照重捕获）
    const other = makeProvider({ id: 'p2' as ProviderInfo['id'], name: 'P2', apiKeySet: true })
    providerRef.value = other
    form.applyProvider(other)
    form.captureSnapshot()

    resolveReveal({ available: true, apiKey: 'sk-aaa', source: 'auth.json' })
    await expect(pending).resolves.toEqual({ ok: true })

    // A 的明文不得落到 B 的草稿/明文开关上（否则会成为 B 的非 dirty 基线）
    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.draft.name).toBe('P2')
    expect(form.isDirty.value).toBe(false)
    expect(form.revealingApiKey.value).toBe(false)
  })

  it('SS-1：回显在途期间 apiKeySet=false 广播清空草稿 → 迟到响应不得写回旧明文', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true }))
    let resolveReveal!: (v: { available: boolean; apiKey?: string; source?: 'auth.json' | 'models.json' }) => void
    revealSpy().mockImplementation(() => new Promise((resolve) => { resolveReveal = resolve }))

    const pending = form.revealApiKey()
    // 广播：凭据被移除。草稿被清空后恰好让旧守卫（draft.apiKey !== ''）失效
    providers.value = [makeProvider({ apiKeySet: false })]
    await nextTick()
    expect(form.draft.apiKey).toBe('')

    resolveReveal({ available: true, apiKey: 'sk-stale', source: 'auth.json' })
    await expect(pending).resolves.toEqual({ ok: true })

    // 已删除的旧明文不得被写回草稿（也不得成为非 dirty 基线）
    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.isDirty.value).toBe(false)
  })

  it('SS-2：回显在途时切 provider → 新 provider 的眼皮按钮不被旧请求 disabled，且可立即重新回显', async () => {
    const { form, providerRef } = mountForm(makeProvider({ apiKeySet: true }))
    let resolveReveal!: (v: { available: boolean; apiKey?: string; source?: 'auth.json' | 'models.json' }) => void
    revealSpy().mockImplementation(() => new Promise((resolve) => { resolveReveal = resolve }))

    const pending = form.revealApiKey()
    expect(form.revealingApiKey.value).toBe(true)

    const other = makeProvider({ id: 'p2' as ProviderInfo['id'], name: 'P2', apiKeySet: true })
    providerRef.value = other
    form.applyProvider(other)
    // applyProvider 必须在途标志归零（旧请求收尾也不得清掉新请求的在途态）
    expect(form.revealingApiKey.value).toBe(false)

    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-p2', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-p2')

    resolveReveal({ available: true, apiKey: 'sk-p1', source: 'auth.json' })
    await expect(pending).resolves.toEqual({ ok: true })
    expect(form.draft.apiKey).toBe('sk-p2')
    expect(form.revealingApiKey.value).toBe(false)
  })

  it('SS-3：回显后广播 authMethod=oauth（凭据被 OAuth 替换）→ 回显草稿/明文开关作废', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true, authMethod: 'api_key' }))
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-stored')

    providers.value = [makeProvider({ apiKeySet: true, authMethod: 'oauth' })]
    await nextTick()

    // 旧 api_key 明文已被 OAuth 替换：不得继续以 text 形态展示
    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.isDirty.value).toBe(false)
  })

  it('SS-3：dirty 下 authMethod 对齐到 oauth（align 分支）→ 回显态同批作废，用户其他编辑保留', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true, authMethod: 'api_key' }))
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    form.draft.name = 'P1-edited'
    expect(form.isDirty.value).toBe(true)

    providers.value = [makeProvider({ apiKeySet: true, authMethod: 'oauth' })]
    await nextTick()

    expect(form.draft.authMethod).toBe('oauth')
    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.draft.name).toBe('P1-edited')
  })

  it('SG-4：回显后点清除 → showKey 复位（哨兵不得以明文形态展示）', async () => {
    const { form } = mountForm(makeProvider({ apiKeySet: true }))
    revealSpy().mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.showKey.value).toBe(true)

    form.clearApiKey()
    expect(form.draft.apiKey).toBe(API_KEY_CLEAR_SENTINEL)
    expect(form.showKey.value).toBe(false)
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

  it('初始有 headers + 删空后保存 → 发送 {}（清空语义；不发键=runtime「不变」会让幽灵 header 复活）', async () => {
    // makeProvider 默认 headers {'X-Test': 'v1'}：读侧回显把该行送进编辑表单，用户删行后
    // 草稿为空。旧实现把空草稿映射为 undefined → runtime provider-config-helper.ts:974
    // 的 `if (data.headers !== undefined)` 不写盘，磁盘上的 header 原样保留。
    const { form } = mountForm()
    form.removeHeader(0)
    expect(form.draft.headers).toEqual({})
    expect(form.isDirty.value).toBe(true)
    await form.save()
    const arg = savePayload()
    // 显式空对象带键（不是不传键）——「删空清空」与「空=不变」必须可区分
    expect('headers' in arg).toBe(true)
    expect(arg.headers).toEqual({})
  })

  it('初始无 headers + 保存 → 不传 headers（undefined，避免覆盖 runtime 既有值）', async () => {
    const { form } = mountForm(makeProvider({ headers: undefined }))
    expect(form.draft.headers).toEqual({})
    await form.save()
    expect(savePayload().headers).toBeUndefined()
  })

  it('初始无 headers + 新增行后保存 → 发送草稿值（增路径不受清空语义影响）', async () => {
    const { form } = mountForm(makeProvider({ headers: undefined }))
    form.addHeader()
    form.headerRows.value[0] = { key: 'X-New', value: 'v2' }
    form.syncHeadersFromRows()
    await form.save()
    expect(savePayload().headers).toEqual({ 'X-New': 'v2' })
  })

  it('用户 dirty 期间外部广播新增 headers → 保存不回传 headers（快照基线，广播竞态修复）', async () => {
    // 竞态场景：表单打开（快照基线 = 无 headers）→ 用户改 name（dirty → D8 分支③表单
    // 不随广播重拍）→ 外部广播给同 provider 新增 headers → 保存（用户未触碰 headers）。
    // 实时基线把「草稿空 + 基线非空」误判为删空 → 发 {} 清掉外部新增；快照基线判
    // 「初始无 + 草稿空」→ undefined（不变，外部新增保留在磁盘）。
    const { form, providerRef } = mountForm(makeProvider({ headers: undefined }))
    form.draft.name = 'P-edited'
    providerRef.value = makeProvider({ headers: { 'X-Ext': 'ext' } })
    await form.save()
    expect(savePayload().headers).toBeUndefined()
  })

  it('快照未捕获（snapshot=null）→ 回退实时基线，删空仍发 {}（清空语义保留）', async () => {
    const { form } = mountForm(makeProvider(), { captureSnapshot: false })
    form.removeHeader(0)
    expect(form.draft.headers).toEqual({})
    await form.save()
    expect(savePayload().headers).toEqual({})
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

  it('custom：空串 baseUrl 不带键（truthy 检查；runtime 侧空串同为「不变」语义）', async () => {
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
    // 空 name 在 save() 入口即被 D15b 拒绝，payload 层的 truthy 检查是纵深防御（正常路径不可达）
    const { form } = mountForm()
    form.draft.name = ''
    const result = await form.save()
    expect(result.ok).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.providerNameRequired')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })
})

describe('save：B-1 凭证形态回传与切换检查', () => {
  it('切换形态 → isDirty；保存 payload 透传 authMethod', async () => {
    const { form } = mountForm(makeProvider({ authMethod: 'api_key' }))
    expect(form.draft.authMethod).toBe('api_key')
    expect(form.isDirty.value).toBe(false)

    form.draft.authMethod = 'oauth'
    expect(form.isDirty.value).toBe(true)
    await form.save()
    expect(savePayload().authMethod).toBe('oauth')
  })

  it('oauth→api_key 切换 + 空 key → 检查拦截（oauthSwitchNeedsKey，不经 setProvider）', async () => {
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
    givenDuplicateHeaderRows(form)
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
    givenDuplicateHeaderRows(form)
    form.removeHeader(1)
    expect(form.actionError.value).toBe('')
  })

  it('locale 切换后 headers 错误仍能被清除（归属按 source 标签，不比对展示文案，MF-1-7）', () => {
    const { form } = mountForm(null)
    givenDuplicateHeaderRows(form)
    // locale 切换：同 key 的文案运行时值变化（stub 由「返回 key」切到「加 en: 前缀」）
    tStub.mockImplementation((key: string) => `en:${key}`)
    // 用户修正重复 key → syncHeadersFromRows（经 removeHeader 触发，与真实 UI 路径一致）
    form.removeHeader(1)
    expect(form.actionError.value).toBe('')
  })

  it('空 value 行不落盘（与空 key 同规格过滤）——堵幽灵 header 入口', () => {
    const { form } = mountForm(null)
    form.addHeader()
    // 只填 key 未填 value 的事故形态：{"x-opencode-session": ""} 落盘后压制 pi 的同名头
    // 自动注入（guard 见键即跳过），网关 400 且读链断时界面无法回显删除
    form.headerRows.value[0] = { key: 'x-opencode-session', value: '' }
    form.syncHeadersFromRows()
    expect(form.draft.headers).toEqual({})
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

  it('回显值 + 同 id 广播重拍 → 快照不把回显记成改动（不虚报 dirty，MF-1-2）', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true }))
    const spy = getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
    spy.mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.isDirty.value).toBe(false)

    providers.value = [makeProvider({ apiKeySet: true, name: 'P1-broadcast' })]
    await nextTick()

    // 非 dirty 分支重拍生效 + 回显值与明文开关保留 + 快照 apiKeyChanged 与 dirty 同源
    expect(form.draft.name).toBe('P1-broadcast')
    expect(form.draft.apiKey).toBe('sk-stored')
    expect(form.showKey.value).toBe(true)
    expect(form.isDirty.value).toBe(false)
  })

  it('广播 apiKeySet=false → 回显草稿/回显值/明文开关同批清空（不残留为「用户草稿」，MF-1-2）', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true }))
    const spy = getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
    spy.mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-stored')
    expect(form.showKey.value).toBe(true)

    providers.value = [makeProvider({ apiKeySet: false })]
    await nextTick()

    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.isDirty.value).toBe(false)

    // 回显基线也已清空：重新回显的新值不构成 dirty（残留旧 revealed 会把新值判成用户草稿）
    spy.mockResolvedValue({ available: true, apiKey: 'sk-new', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-new')
    expect(form.isDirty.value).toBe(false)
  })

  it('MF-1-1：dirty（其他字段编辑中）+ 广播 apiKeySet=false → 回显明文作废，用户编辑保留（ignore 分支）', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true }))
    const spy = getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
    spy.mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-stored')
    expect(form.showKey.value).toBe(true)

    // 用户正在编辑 name → dirty → reconcile 走 ignore 分支
    form.draft.name = 'P1-user-edit'
    expect(form.isDirty.value).toBe(true)

    providers.value = [makeProvider({ apiKeySet: false })]
    await nextTick()

    // 已删除的明文不得继续可见，也不得残留为草稿；用户其他编辑不被触碰
    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.draft.name).toBe('P1-user-edit')
    expect(form.isDirty.value).toBe(true)
  })

  it('MF-1-1：dirty + 回显在途 → apiKeySet=false 广播作废在途请求，迟到响应不写回已删除明文', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true }))
    let resolveReveal!: (v: { available: boolean; apiKey?: string; source?: 'auth.json' | 'models.json' }) => void
    const spy = getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
    spy.mockImplementation(() => new Promise((resolve) => { resolveReveal = resolve }))

    form.draft.name = 'P1-user-edit'
    expect(form.isDirty.value).toBe(true)
    const pending = form.revealApiKey()
    expect(form.revealingApiKey.value).toBe(true)

    providers.value = [makeProvider({ apiKeySet: false })]
    await nextTick()
    // ignore 分支同样作废在途回显（世代号推进 + 在途标志复位）
    expect(form.revealingApiKey.value).toBe(false)

    resolveReveal({ available: true, apiKey: 'sk-stale', source: 'auth.json' })
    await expect(pending).resolves.toEqual({ ok: true })

    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.revealingApiKey.value).toBe(false)
    expect(form.isDirty.value).toBe(true)
  })

  it('MF-1-1：回显在途时 providerRef 已换为 apiKeySet=false → 响应侧守卫丢弃迟到明文', async () => {
    const { form, providerRef } = mountForm(makeProvider({ apiKeySet: true }))
    let resolveReveal!: (v: { available: boolean; apiKey?: string; source?: 'auth.json' | 'models.json' }) => void
    const spy = getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
    spy.mockImplementation(() => new Promise((resolve) => { resolveReveal = resolve }))

    const pending = form.revealApiKey()
    // 新对象同 id 但凭据已删除（providerRef 已更新，广播对齐尚未/不再推进世代号）
    providerRef.value = makeProvider({ apiKeySet: false })

    resolveReveal({ available: true, apiKey: 'sk-stale', source: 'auth.json' })
    await expect(pending).resolves.toEqual({ ok: true })

    expect(form.draft.apiKey).toBe('')
    expect(form.showKey.value).toBe(false)
    expect(form.revealingApiKey.value).toBe(false)
    expect(form.isDirty.value).toBe(false)
  })

  it('S-4：回显后用户输入新 key + apiKeySet=false 广播 → 用户 key 保留且可保存（dropRevealed 不清真实草稿）', async () => {
    const { form, providers } = mountForm(makeProvider({ apiKeySet: true }))
    const spy = getTransport().revealProviderApiKey as ReturnType<typeof vi.fn>
    spy.mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await form.revealApiKey()
    expect(form.draft.apiKey).toBe('sk-stored')

    // 用户覆盖输入自己的 key（草稿 ≠ 回显值 → dirty）
    form.draft.apiKey = 'sk-typed'
    expect(form.showKey.value).toBe(true)
    expect(form.isDirty.value).toBe(true)

    // dirty + 凭据被删广播 → ignore 分支的 dropRevealed 只作废回显基线
    providers.value = [makeProvider({ apiKeySet: false })]
    await nextTick()

    // 真实用户输入不得被清空（否则保存会丢用户 key）
    expect(form.draft.apiKey).toBe('sk-typed')
    expect(form.showKey.value).toBe(false)
    expect(form.revealingApiKey.value).toBe(false)
    expect(form.isDirty.value).toBe(true)

    // 下一次保存仍按用户草稿重写凭据（不回退为「不变」）
    const result = await form.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(true)
    expect(savePayload().apiKey).toBe('sk-typed')
  })
})

describe('reconcile 分流入口（SG-8：provider 变化统一经 form.reconcile 分流）', () => {
  it('id 变化 → "reset" + 表单重载（apiKey 清空、headerRows 重建）；快照重捕获留给调用方编排', () => {
    const { form } = mountForm(makeProvider())

    const outcome = form.reconcile(makeProvider({ id: 'p2' as ProviderInfo['id'], name: 'P2' }))

    expect(outcome).toBe('reset')
    expect(form.draft.name).toBe('P2')
    expect(form.draft.apiKey).toBe('')
    expect(form.headerRows.value).toEqual([{ key: 'X-Test', value: 'v1' }])
    // reconcile 只做 form 侧动作：快照未重捕获（isDirty 相对旧基线为 true），由调用方
    // （useProviderEdit watcher 的 'reset' 分支）编排 captureSnapshot 后归 false
    expect(form.isDirty.value).toBe(true)
    form.captureSnapshot()
    expect(form.isDirty.value).toBe(false)
  })

  it('fresh=null（关闭弹窗）→ "reset" + 清空为新增态默认', () => {
    const { form } = mountForm(makeProvider())
    form.draft.name = 'P1-edited'

    expect(form.reconcile(null)).toBe('reset')
    expect(form.draft.name).toBe('')
    expect(form.draft.apiKey).toBe('')
  })

  it('同 id 非 dirty → "refreshed" + 按 applyReconcile 重拍（编辑态不丢失、不虚报 dirty）', () => {
    const { form } = mountForm(makeProvider())

    const outcome = form.reconcile(makeProvider({ name: 'P1-broadcast' }))

    expect(outcome).toBe('refreshed')
    expect(form.draft.name).toBe('P1-broadcast')
    expect(form.isDirty.value).toBe(false)
  })

  it('同 id dirty → "refreshed" + ignore 分支保留用户改动（不走重置）', () => {
    const { form } = mountForm(makeProvider())
    form.draft.apiKey = 'sk-typed'
    form.draft.name = 'P1-user-edit'
    expect(form.isDirty.value).toBe(true)

    expect(form.reconcile(makeProvider({ name: 'P1-broadcast' }))).toBe('refreshed')
    // 用户改动优先：apiKey 草稿与已编辑字段都不被重置/重拍
    expect(form.draft.apiKey).toBe('sk-typed')
    expect(form.draft.name).toBe('P1-user-edit')
    expect(form.isDirty.value).toBe(true)
  })

  it('分流判据 = 已载入 id（非引用相等）：载入后 reconcile 同一对象 → "refreshed" 非 "reset"', () => {
    const { form, providerRef } = mountForm(makeProvider())

    // 同一引用（旧 watcher 契约下不会触发）；reconcile 判据是 loadedProviderId → 同 id 刷新
    expect(form.reconcile(providerRef.value)).toBe('refreshed')
    // 再 reconcile 同 id 新引用（独立构造的 prop，非 store 元素）同样走刷新分支
    expect(form.reconcile(makeProvider({ name: 'P1-prop' }))).toBe('refreshed')
    expect(form.draft.name).toBe('P1-prop')
    expect(form.isDirty.value).toBe(false)
  })

  it('幂等：同 fresh 连续 reconcile → 无副作用累积（值稳定、不虚报 dirty）', () => {
    const { form } = mountForm(makeProvider())
    const fresh = makeProvider({ name: 'P1-broadcast' })

    expect(form.reconcile(fresh)).toBe('refreshed')
    expect(form.reconcile(fresh)).toBe('refreshed')

    expect(form.draft.name).toBe('P1-broadcast')
    expect(form.isDirty.value).toBe(false)
  })
})
