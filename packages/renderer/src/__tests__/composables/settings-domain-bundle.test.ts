/**
 * settings 域零 mock 合并产物（round 6 renderer 测试压缩）：三文件同产物，环境默认
 * （happy-dom；三原文件均默认环境，全零 vi.mock，SettingsTransport seam 经
 * helpers/settings-transport-stub 在 beforeEach 注入）。
 *
 * 并入来源（基名）：
 *  - use-provider-oauth（oauth 四态状态机 + 来源路由 + presence，34 例）
 *  - use-quota-configure（readiness 矩阵 + 凭证归属 + payload 构造，55 例）
 *  - use-project-skills（cwd 触发加载 + Wave3 订阅失效信号，11 例）
 *
 * mock 注册与互斥核查：
 *  - 三文件全零 vi.mock（quotaApi/getProjectSkillsMock 等为 hoisted 的 seam 桩成员，
 *    经 makeSettingsTransportStub 注入，不触模块图）。
 *  - use-project-skills Wave3 节 beforeEach 用 vi.resetModules() + 动态 import 取全新
 *    模块实例——该节排产物最后，resetModules 后无其他节消费模块图；oauth/quota 节
 *    静态 import 绑定不受 resetModules 影响（ESM binding 保持原实例）。
 *  - 各文件级 beforeEach/afterEach 已下沉进各自 describe（oauth 的 afterEach 含
 *    wrapper unmount + toast 清空；Wave3 节保留其原有 resetModules beforeEach，
 *    插入的 pinia+stub hook 先于其执行，与原「顶层先于 describe 内」顺序一致）。
 *
 * 互斥登记：use-api-key-auto-enable（mock '@/composables/useToast' 与本产物 oauth 节
 * 真 useToast 单例断言结构性互斥）保留独立。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/composables/settings-domain-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref, nextTick, onBeforeUnmount, type Ref } from 'vue'
import type { BuiltinProviderTemplate, ProviderInfo, SkillInfo } from '@taiji/shared'
import { provideSettingsTransport, getSettingsStore } from '@taiji/core'
import type { QuotaConfigureModule, QuotaFailureKind, QuotaSnapshot, Translate } from '@taiji/core'
import { QUOTA_SECRET_MASK } from '@taiji/core'
import { QUOTA_PRESETS } from '@taiji/shared'
import type { NormalizedQuotaRow, ProviderId, QuotaConfigurePayload, QuotaFetchFailureReason, QuotaPreset } from '@taiji/shared'
import { makeSettingsTransportStub, type SettingsTransportStubOverrides } from '../helpers/settings-transport-stub'
import {
  authEventCbs,
  type DeviceCodeEvent,
  type AuthUrlEvent,
  type AuthSuccessEvent,
  type AuthErrorEvent,
} from '../helpers/oauth-auth-events-mock'


// ═══════════ 来源节：use-provider-oauth ═══════════

// auth.* 订阅回调捕获（onMounted 注册后由测试手动派发事件；实现须返回 disposer 供 onScopeDispose）。
// 类型化捕获 mock 与事件 payload 类型单源在 helpers/oauth-auth-events-mock.ts。
// 本文件无 vi.mock（SettingsTransport seam 注入在 beforeEach），mock 集无需 vi.hoisted。
const authCbs = authEventCbs()

const configMock = {
  // OAuth flow 启动（login）：默认成功
  oauthLogin: vi.fn(async (): Promise<{ started: boolean; error?: string }> => ({ started: true })),
  oauthCancel: vi.fn(async () => ({ cancelled: false })),
  oauthLogout: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  hasOAuth: vi.fn(async () => false),
  setProvider: vi.fn(async () => ({})),
  checkEnvVars: vi.fn(async () => ({})),
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => ({ providers: [] })),
  deleteProvider: vi.fn(async () => {}),
  listBuiltinProviders: vi.fn(async () => []),
  onDefaultsWithSource: vi.fn(() => () => {}),
  onAuthDeviceCode: authCbs.onAuthDeviceCode,
  onAuthAuthUrl: authCbs.onAuthAuthUrl,
  onAuthError: authCbs.onAuthError,
  onAuthSuccess: authCbs.onAuthSuccess,
}

// [C3] OAuth/config 调用经 SettingsTransport seam 桩注入（替换原 @/api 门面 mock）

import { useProviderOAuth, type ProviderOauthModule } from '@/composables/features/settings/useProviderOAuth'
import { useToast } from '@/composables/useToast'

// ── fixture ──

/** oauthSupported 的 builtin 模板（QuickSetup 登录入口数据源） */
const KIMI_TEMPLATE: BuiltinProviderTemplate = {
  id: 'kimi-coding',
  name: 'Kimi Coding',
  api: 'openai-completions',
  baseUrl: 'https://api.kimi.com/v1',
  authMode: 'both',
  envVars: [],
  oauthSupported: true,
  oauthName: 'Kimi 账号',
  modelCount: 2,
  models: [],
}

/** 编辑体中的 oauth 型 provider（authMethod=oauth） */
const KIMI_PROVIDER: ProviderInfo = {
  id: 'kimi-coding',
  name: 'Kimi Coding',
  api: 'openai-completions',
  baseUrl: 'https://api.kimi.com/v1',
  apiKeySet: false,
  authMethod: 'oauth',
  status: 'connected',
  enabled: true,
  models: [],
}

let wrapper: ReturnType<typeof mount> | null = null
/** harness setup 内写入的 composable 实例（onMounted 需组件上下文） */
let api: ProviderOauthModule | null = null
/** module 依赖注入的 refs（测试驱动 QuickSetup 选中态 / 手风琴展开） */
let harnessRefs: {
  builtinProviders: Ref<BuiltinProviderTemplate[]>
  providers: Ref<ProviderInfo[]>
  selectedTemplate: Ref<BuiltinProviderTemplate | null>
  expandedId: Ref<string | null>
} | null = null

/** 挂 harness：setup 中调用 useProviderOAuth（获得 onMounted/onScopeDispose 上下文） */
function mountOauth(): ProviderOauthModule {
  api = null
  const builtinProviders = ref<BuiltinProviderTemplate[]>([KIMI_TEMPLATE])
  const providers = ref<ProviderInfo[]>([KIMI_PROVIDER])
  const selectedTemplate = ref<BuiltinProviderTemplate | null>(null)
  const expandedId = ref<string | null>(null)
  harnessRefs = { builtinProviders, providers, selectedTemplate, expandedId }
  const Harness = defineComponent({
    setup() {
      api = useProviderOAuth({
        builtinProviders,
        providers,
        selectedTemplate,
        expandedId,
        newId: '__new__',
      })
      return () => h('div')
    },
  })
  wrapper = mount(Harness, { attachTo: document.body })
  if (!api) throw new Error('composable 实例未捕获（harness setup 未执行）')
  return api
}

/** 取已注册的 auth.* handler（订阅先行断言：未注册 = onMounted 未执行，直接炸） */
function registered<F extends (...args: never[]) => unknown>(spy: { mock: { calls: Parameters<F>[] } }): F {
  const first = spy.mock.calls[0]
  if (!first) throw new Error('auth.* 订阅未注册（onMounted 未执行——订阅先行被破坏）')
  return first[0]
}

async function emitDeviceCode(payload: DeviceCodeEvent): Promise<void> {
  registered<(p: DeviceCodeEvent) => void>(authCbs.onAuthDeviceCode)(payload)
  await flushPromises()
}

async function emitAuthUrl(payload: AuthUrlEvent): Promise<void> {
  registered<(p: AuthUrlEvent) => void>(authCbs.onAuthAuthUrl)(payload)
  await flushPromises()
}

async function emitAuthSuccess(providerId: string): Promise<void> {
  registered<(p: AuthSuccessEvent) => void>(authCbs.onAuthSuccess)({ providerId })
  await flushPromises()
}

async function emitAuthError(payload: AuthErrorEvent): Promise<void> {
  registered<(p: AuthErrorEvent) => void>(authCbs.onAuthError)(payload)
  await flushPromises()
}

/** 模块级 toast 单例的当前消息列表（用户可见反馈断言） */
function toastMessages(): string[] {
  return useToast().toasts.value.map((t) => t.message)
}

describe('四态状态机（device / authUrl / success / error）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('device 态：auth.deviceCode → Dialog open + pending + deviceCode 信息（userCode/验证 URL）', async () => {
    const page = mountOauth()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()

    await emitDeviceCode({
      providerId: 'kimi-coding',
      userCode: 'ABCD-1234',
      verificationUri: 'https://verify.example.com',
      verificationUriComplete: 'https://verify.example.com/ABCD-1234',
      expiresIn: 900,
    })

    expect(page.state.value.open).toBe(true)
    expect(page.state.value.status).toBe('pending')
    expect(page.state.value.deviceInfo).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://verify.example.com',
      verificationUriComplete: 'https://verify.example.com/ABCD-1234',
      expiresIn: 900,
    })
    expect(page.state.value.authUrl).toBeNull()
  })

  it('authUrl 态：auth.authUrl → pending + 回调 URL（deviceInfo 清空不混显）', async () => {
    const page = mountOauth()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()

    await emitAuthUrl({ providerId: 'kimi-coding', url: 'https://oauth.example.com/authorize', callbackPort: 18_923 })

    expect(page.state.value.open).toBe(true)
    expect(page.state.value.status).toBe('pending')
    expect(page.state.value.authUrl).toEqual({ url: 'https://oauth.example.com/authorize', callbackPort: 18_923 })
    expect(page.state.value.deviceInfo).toBeNull()
  })

  it('success 态：auth.success → 关 Dialog + status success + authorized 回写', async () => {
    const page = mountOauth()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    await emitAuthSuccess('kimi-coding')

    expect(page.state.value.open).toBe(false)
    expect(page.state.value.status).toBe('success')
    expect(page.authorized.value.has('kimi-coding')).toBe(true)
  })

  it('error 态：auth.error → status error + 错误信息上屏（可展示状态，不抛全局）', async () => {
    const page = mountOauth()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    await emitAuthError({ providerId: 'kimi-coding', message: '授权被拒绝' })

    expect(page.state.value.status).toBe('error')
    expect(page.state.value.errorMessage).toBe('授权被拒绝')
  })

  it('非活跃 provider 的 auth.* 事件被过滤（不串台：activeProviderId 之外不动状态机）', async () => {
    const page = mountOauth()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()

    await emitDeviceCode({ providerId: 'other-provider', userCode: 'XXXX', verificationUri: 'https://x' })
    await emitAuthError({ providerId: 'other-provider', message: 'x' })

    expect(page.state.value.status).toBe('pending')
    expect(page.state.value.deviceInfo).toBeNull()
    expect(page.state.value.errorMessage).toBe('')
  })

  it('login 非 started → error 态 + runtime error；无 error 文案走兜底（Dialog 不卡 pending）', async () => {
    const page = mountOauth()
    configMock.oauthLogin.mockResolvedValueOnce({ started: false, error: 'flow 启动失败' })
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    expect(page.state.value.status).toBe('error')
    expect(page.state.value.errorMessage).toBe('flow 启动失败')

    configMock.oauthLogin.mockResolvedValueOnce({ started: false })
    await page.login('kimi-coding')
    expect(page.state.value.status).toBe('error')
    expect(page.state.value.errorMessage).toBe('OAuth 启动失败')
  })

  it('login transport reject（断连/超时）→ error 态 + 错误消息（重置 pending，项目规则 #3）', async () => {
    const page = mountOauth()
    configMock.oauthLogin.mockRejectedValueOnce(new Error('WebSocket 断连'))
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()

    expect(page.state.value.status).toBe('error')
    expect(page.state.value.errorMessage).toBe('WebSocket 断连')
    expect(page.state.value.open).toBe(true)
  })

  it('cancel → 关 Dialog + oauthCancel（幂等）；retry（error 态）→ 重新启动 flow', async () => {
    const page = mountOauth()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()

    await page.cancel()
    expect(page.state.value.open).toBe(false)
    expect(configMock.oauthCancel).toHaveBeenCalledWith('kimi-coding')

    await emitAuthError({ providerId: 'kimi-coding', message: 'x' })
    await page.retry()
    expect(configMock.oauthLogin).toHaveBeenCalledTimes(2)
    expect(configMock.oauthLogin).toHaveBeenLastCalledWith('kimi-coding')
    expect(page.state.value.status).toBe('pending')
  })
})

describe('来源路由（MF-1：只有 edit 来源 auth.success 后持久化 authMethod）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('QuickSetup 登录 → 共享状态机启动（oauthLogin 调 template.id + Dialog pending）；success 后**不**发 setProvider', async () => {
    const page = mountOauth()

    page.onQuickSetupOauthLogin(KIMI_TEMPLATE)
    await flushPromises()

    expect(configMock.oauthLogin).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogin).toHaveBeenCalledWith('kimi-coding')
    expect(page.state.value.open).toBe(true)
    expect(page.state.value.status).toBe('pending')
    // quicksetup 来源：auth.success 后不走 setProvider 收尾（保存时才落 authMethod）
    await emitAuthSuccess('kimi-coding')
    expect(configMock.setProvider).not.toHaveBeenCalled()
  })

  it('edit 来源成功路径：setProvider 只传 authMethod=oauth（不随行 name/type/baseUrl）+ toast + presence 刷新', async () => {
    const page = mountOauth()

    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    await emitAuthSuccess('kimi-coding')

    // 防线⑤（设计 D1）：只传 authMethod——name/type/baseUrl 是展示派生值/快照 artifact，
    // 回传会把 artifact 冻进 models.json override；runtime 侧「不物化空壳」防线兜底
    expect(configMock.setProvider).toHaveBeenCalledTimes(1)
    expect(configMock.setProvider).toHaveBeenCalledWith('kimi-coding', { authMethod: 'oauth' })
    const payload = configMock.setProvider.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(payload)).toEqual(['authMethod'])
    // 用户可见反馈：授权成功 toast（zh-CN locale：已授权（{name}））
    expect(toastMessages().some((m) => m.includes('已授权') && m.includes('Kimi Coding'))).toBe(true)
    // presence 刷新（凭证区「已登录」态数据源）
    expect(configMock.hasOAuth).toHaveBeenCalledWith('kimi-coding')
    // 登录目标已清空（oauthDialogProvider 回 null，Dialog 信息不再指向旧目标）
    expect(page.oauthDialogProvider.value).toBeNull()
  })

  it('edit 来源失败路径：setProvider 拒绝 → toast.error + presence 仍刷新（凭据已写 auth.json）', async () => {
    configMock.setProvider.mockRejectedValueOnce(new Error('models.json 写入失败'))
    const page = mountOauth()

    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    await emitAuthSuccess('kimi-coding')

    expect(toastMessages().some((m) => m.includes('models.json 写入失败'))).toBe(true)
    // 失败不阻断 presence 刷新（auth.json 凭据已落，重开编辑体应见已登录态）
    expect(configMock.hasOAuth).toHaveBeenCalledWith('kimi-coding')
  })

  it('auth.success 无登录目标（editOauthTarget 已清空）→ 静默跳过 setProvider 不崩', async () => {
    const page = mountOauth()

    // 编辑体登录后目标已清空（如二次 success 事件），再派发不应再调 setProvider
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    await emitAuthSuccess('kimi-coding')
    configMock.setProvider.mockClear()

    await emitAuthSuccess('kimi-coding')

    expect(configMock.setProvider).not.toHaveBeenCalled()
  })
})

describe('派生（Dialog 信息 / QuickSetup 授权态）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('oauthDialogProvider：编辑体登录目标 → { id, name, oauthName }（oauthName 从 builtin 模板取）', async () => {
    const page = mountOauth()

    expect(page.oauthDialogProvider.value).toBeNull()
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()

    expect(page.oauthDialogProvider.value).toEqual({
      id: 'kimi-coding',
      name: 'Kimi Coding',
      oauthName: 'Kimi 账号',
    })
  })

  it('oauthDialogInfo：QuickSetup 模板优先，编辑体目标兜底，均无 → null', async () => {
    const page = mountOauth()
    expect(page.oauthDialogInfo.value).toBeNull()

    // 编辑体目标兜底
    page.onEditOauthLogin(KIMI_PROVIDER)
    await flushPromises()
    expect(page.oauthDialogInfo.value?.id).toBe('kimi-coding')

    // QuickSetup 模板优先
    harnessRefs!.selectedTemplate.value = KIMI_TEMPLATE
    await flushPromises()
    expect(page.oauthDialogInfo.value).toEqual({ id: 'kimi-coding', name: 'Kimi Coding', oauthName: 'Kimi 账号' })
  })

  it('quickSetupOauthAuthorized：authorized ∪ oauthPresent 任一命中；无模板 = 未授权', async () => {
    const page = mountOauth()
    expect(page.quickSetupOauthAuthorized.value).toBe(false)

    // presence 命中（auth.json 已有凭据的旧场景）
    configMock.hasOAuth.mockResolvedValueOnce(true)
    await page.refreshOAuthPresence('kimi-coding')
    harnessRefs!.selectedTemplate.value = KIMI_TEMPLATE
    await flushPromises()
    expect(page.quickSetupOauthAuthorized.value).toBe(true)

    // authorized 命中（本次 flow 成功）
    harnessRefs!.selectedTemplate.value = null
    page.authorized.value = new Set(['kimi-coding'])
    harnessRefs!.selectedTemplate.value = KIMI_TEMPLATE
    await flushPromises()
    expect(page.quickSetupOauthAuthorized.value).toBe(true)

    // 无模板 = 未授权
    harnessRefs!.selectedTemplate.value = null
    await flushPromises()
    expect(page.quickSetupOauthAuthorized.value).toBe(false)
  })

  it('isOauthSupported 按模板 oauthSupported 判定（custom / 未列 provider 恒 false）', () => {
    const page = mountOauth()
    expect(page.isOauthSupported(KIMI_PROVIDER.id)).toBe(true)
    expect(page.isOauthSupported('my-custom' as ProviderInfo['id'])).toBe(false)
  })
})

describe('presence（MF-3 has ? add : delete）与展开刷新', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('refreshOAuthPresence：has=true → 加入；重查 false → 移除（只增不减是 bug）', async () => {
    const page = mountOauth()
    configMock.hasOAuth.mockResolvedValueOnce(true)
    await page.refreshOAuthPresence('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(true)

    configMock.hasOAuth.mockResolvedValueOnce(false)
    await page.refreshOAuthPresence('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(false)
  })

  it('clearOAuthPresence（删除 provider 后）→ presence + authorized 双清（防重开 QuickSetup 假已授权态）', async () => {
    const page = mountOauth()
    configMock.hasOAuth.mockResolvedValueOnce(true)
    await page.refreshOAuthPresence('kimi-coding')
    await page.login('kimi-coding')
    await emitAuthSuccess('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(true)
    expect(page.authorized.value.has('kimi-coding')).toBe(true)

    page.clearOAuthPresence('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(false)
    expect(page.authorized.value.has('kimi-coding')).toBe(false)
  })

  it('hasOAuth 查询失败不阻断（presence 不误加，调用方回退 stored authMethod）', async () => {
    const page = mountOauth()
    configMock.hasOAuth.mockRejectedValueOnce(new Error('runtime 断连'))
    await page.refreshOAuthPresence('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(false)
    // MF-1-2 三态：查询失败 = 未知（undefined），不得当成「已确认无 OAuth 凭据」渲染回显入口
    expect(page.oauthPresenceStatus('kimi-coding')).toBeUndefined()
  })

  it('oauthPresenceStatus 三态：未查询 → undefined；查询 true/false → true/false；hasOauthPresence 仅 true 命中', async () => {
    const page = mountOauth()
    expect(page.oauthPresenceStatus('kimi-coding')).toBeUndefined()
    expect(page.hasOauthPresence('kimi-coding')).toBe(false)

    configMock.hasOAuth.mockResolvedValueOnce(false)
    await page.refreshOAuthPresence('kimi-coding')
    expect(page.oauthPresenceStatus('kimi-coding')).toBe(false)
    expect(page.hasOauthPresence('kimi-coding')).toBe(false)

    configMock.hasOAuth.mockResolvedValueOnce(true)
    await page.refreshOAuthPresence('kimi-coding')
    expect(page.oauthPresenceStatus('kimi-coding')).toBe(true)
    expect(page.hasOauthPresence('kimi-coding')).toBe(true)
  })

  it('展开 provider → 自动刷新 presence（每个 provider 都查，含 authMethod 缺省的遗留行）；newId 不查询', async () => {
    mountOauth()
    if (!harnessRefs) throw new Error('harness refs 未捕获')
    harnessRefs.providers.value = [
      KIMI_PROVIDER,
      { ...KIMI_PROVIDER, id: 'my-custom', authMethod: undefined, name: 'My Custom' },
    ]

    harnessRefs.expandedId.value = 'kimi-coding'
    await flushPromises()
    expect(configMock.hasOAuth).toHaveBeenCalledWith('kimi-coding')

    configMock.hasOAuth.mockClear()
    // MF-1-2：旧门控（authMethod=oauth / 模板 oauthSupported）会让遗留行永不查询——
    // presence 恒「未知当无凭据」→ 假眼睛按钮，故展开即查（hasOAuth 只回布尔、单次 RPC）
    harnessRefs.expandedId.value = 'my-custom'
    await flushPromises()
    expect(configMock.hasOAuth).toHaveBeenCalledWith('my-custom')

    configMock.hasOAuth.mockClear()
    harnessRefs.expandedId.value = '__new__'
    await flushPromises()
    expect(configMock.hasOAuth).not.toHaveBeenCalled()
  })
})

describe('onEditOauthLogout（B-1 场景 C 退出登录）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('成功路径：config.oauthLogout(id) + toast.info 已退出 + presence 刷新（凭证区回未登录态）', async () => {
    // 预置已登录 presence（退出后应被刷新移除）
    configMock.hasOAuth.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const page = mountOauth()
    await page.refreshOAuthPresence('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(true)
    configMock.hasOAuth.mockClear()

    await page.onEditOauthLogout(KIMI_PROVIDER)
    await flushPromises()

    expect(configMock.oauthLogout).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogout).toHaveBeenCalledWith('kimi-coding')
    // 用户可见反馈：退出成功 toast（zh-CN locale：已退出登录（{name}））
    expect(toastMessages().some((m) => m.includes('已退出登录') && m.includes('Kimi Coding'))).toBe(true)
    // presence 刷新（hasOAuth 重查 → false → 移除，凭证区回「未登录」态）
    expect(configMock.hasOAuth).toHaveBeenCalledWith('kimi-coding')
    expect(page.oauthPresent.value.has('kimi-coding')).toBe(false)
  })

  it('失败路径：ok=false → 透传 reply.error（勿自造文案）+ 不刷新 presence', async () => {
    configMock.oauthLogout.mockResolvedValueOnce({ ok: false, error: 'auth.json 写入失败' })
    const page = mountOauth()

    await page.onEditOauthLogout(KIMI_PROVIDER)
    await flushPromises()

    expect(toastMessages().some((m) => m.includes('auth.json 写入失败'))).toBe(true)
    expect(configMock.hasOAuth).not.toHaveBeenCalled()
  })

  it('transport reject（断连/超时）→ 错误上屏 + 不刷新 presence（不静默吞）', async () => {
    configMock.oauthLogout.mockRejectedValueOnce(new Error('WebSocket 断连'))
    const page = mountOauth()

    await page.onEditOauthLogout(KIMI_PROVIDER)
    await flushPromises()

    expect(toastMessages().some((m) => m.includes('WebSocket 断连'))).toBe(true)
    expect(configMock.hasOAuth).not.toHaveBeenCalled()
  })
})

describe('checkEnv（QuickSetup env 检测桥接）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('三分支：无 envVars → undefined 不显示检测态；成功 → 映射；reject → undefined 不阻断配置', async () => {
    const page = mountOauth()

    await page.checkEnv({ envVars: [] })
    expect(page.envCheck.value).toBeUndefined()

    configMock.checkEnvVars.mockResolvedValueOnce({ ANTHROPIC_API_KEY: true })
    await page.checkEnv({ envVars: ['ANTHROPIC_API_KEY'] })
    expect(page.envCheck.value).toEqual({ ANTHROPIC_API_KEY: true })

    configMock.checkEnvVars.mockRejectedValueOnce(new Error('runtime 断连'))
    await page.checkEnv({ envVars: ['ANTHROPIC_API_KEY'] })
    expect(page.envCheck.value).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// 来源：registry-flags.test.ts（modal-surface-registry 双键旗标语义）。
// 顶层 beforeEach 与上节并集（reset 幂等，互不干扰）；describe/it 原样搬运。
// ══════════════════════════════════════════════════════════════════
import {
  registerModalSurface,
  anyModalSurfaceYieldsEsc,
  anyModalSurfaceYieldsCmdW,
  openShieldingSurfaces,
  isModalSurfaceOpen,
  resetModalSurfaceRegistry,
  type ModalSurfaceId,
} from '@/composables/features/app/modal-surface-registry'

/** 挂载点模拟：一个带开合按钮的表面（挂载即注册、卸载即注销，DOM 显示当前开合态） */
function mountSurface(surface: ModalSurfaceId, key: string) {
  const open = ref(false)
  const wrapper = mount(defineComponent({
    setup() {
      const dispose = registerModalSurface({ surface, key, isOpen: () => open.value })
      onBeforeUnmount(dispose)
      return () =>
        h('div', [
          h('button', { 'data-testid': `toggle-${key}`, onClick: () => { open.value = !open.value } }, 'toggle'),
          h('span', { 'data-testid': `state-${key}` }, open.value ? 'open' : 'closed'),
        ])
    },
  }))
  return { wrapper, open }
}

beforeEach(() => {
  resetModalSurfaceRegistry()
})

describe('双键旗标（yieldsEsc / yieldsCmdW）按家族分立', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('模态族开着：Esc 让位 + ⌘W 让位（S8 锚）；关合后复位', async () => {
    const { wrapper } = mountSurface('settings-modal', 'modal')
    expect(wrapper.get('[data-testid="state-modal"]').text()).toBe('closed')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)

    await wrapper.get('[data-testid="toggle-modal"]').trigger('click')
    expect(wrapper.get('[data-testid="state-modal"]').text()).toBe('open')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(true)

    await wrapper.get('[data-testid="toggle-modal"]').trigger('click')
    expect(wrapper.get('[data-testid="state-modal"]').text()).toBe('closed')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('弹出层族开着：Esc 让位但 ⌘W 不让位（S7「Select 开着按 ⌘W 照常关容器」R4 双键拆分锚）', async () => {
    const { wrapper } = mountSurface('popover-content', 'pop')
    await wrapper.get('[data-testid="toggle-pop"]').trigger('click')
    expect(wrapper.get('[data-testid="state-pop"]').text()).toBe('open')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('Toast 族开着：双键都不让位（S8「Toast 显示期 Esc 照常走层级序」锚）', async () => {
    const { wrapper } = mountSurface('toast-container', 'toast')
    await wrapper.get('[data-testid="toggle-toast"]').trigger('click')
    expect(wrapper.get('[data-testid="state-toast"]').text()).toBe('open')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('多成员混开：任一让位族成员开着即让位（模态 + 弹层 + Toast 同开）', async () => {
    const modal = mountSurface('settings-modal', 'm')
    const pop = mountSurface('popover-content', 'p')
    const toast = mountSurface('toast-container', 't')
    await toast.wrapper.get('[data-testid="toggle-t"]').trigger('click')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    await pop.wrapper.get('[data-testid="toggle-p"]').trigger('click')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    await modal.wrapper.get('[data-testid="toggle-m"]').trigger('click')
    expect(anyModalSurfaceYieldsCmdW()).toBe(true)
  })
})

describe('shieldsView 分档报告（S9 view 遮蔽联动的数据源）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('全屏阻塞遮罩 = unconditional；弹出层/横幅 = intersecting；行内确认态 = none 不参报', async () => {
    const modal = mountSurface('search-modal', 'sm')
    const banner = mountSurface('rolling-restart-banner', 'rb')
    const confirm = mountSurface('session-delete-confirm', 'sc')
    expect(openShieldingSurfaces()).toEqual([])

    await modal.wrapper.get('[data-testid="toggle-sm"]').trigger('click')
    await banner.wrapper.get('[data-testid="toggle-rb"]').trigger('click')
    await confirm.wrapper.get('[data-testid="toggle-sc"]').trigger('click')

    const report = openShieldingSurfaces().sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(report).toEqual([
      { id: 'rolling-restart-banner', mode: 'intersecting' },
      { id: 'search-modal', mode: 'unconditional' },
    ])
  })
})

describe('注册红线与 refCount（构建者白盒）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useToast().toasts.value = []
    provideSettingsTransport(makeSettingsTransportStub(configMock))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    api = null
    harnessRefs = null
    document.body.innerHTML = ''
    useToast().toasts.value = []
  })

  it('未登记表面 id 注册即抛错（新增表面必须先入登记表）', () => {
    expect(() =>
      registerModalSurface({ surface: 'not-registered' as ModalSurfaceId, key: 'x', isOpen: () => true }),
    ).toThrow(/未登记|not-registered|manifest/)
  })

  it('同 key 不同表面：拒绝复用（防 key 冲突静默换主）', () => {
    registerModalSurface({ surface: 'settings-modal', key: 'shared', isOpen: () => true })
    expect(() =>
      registerModalSurface({ surface: 'popover-content', key: 'shared', isOpen: () => true }),
    ).toThrow()
  })

  it('refCount 防重复注册：同 key 双注册，注销一次不摘除、归零才移除、注销幂等', () => {
    const open = ref(true)
    const dispose1 = registerModalSurface({ surface: 'settings-modal', key: 'dup', isOpen: () => open.value })
    const dispose2 = registerModalSurface({ surface: 'settings-modal', key: 'dup', isOpen: () => open.value })
    expect(isModalSurfaceOpen('settings-modal')).toBe(true)

    dispose1()
    dispose1() // 幂等：重复注销只生效一次
    expect(isModalSurfaceOpen('settings-modal'), 'refCount 未归零不得摘除').toBe(true)

    open.value = false
    expect(isModalSurfaceOpen('settings-modal')).toBe(false)
    open.value = true

    dispose2()
    expect(isModalSurfaceOpen('settings-modal'), '归零后移除').toBe(false)
  })

  it('三实例交接（D3 S9 真机实锤回归）：rect 读点随最新活实例覆盖，交接窗口不指死实例、归零后重注册起新条目', async () => {
    // 形态还原：ToastContainer 以固定 key 'toast-container' 在 App.vue(connecting 态) →
    // PanelContainer / MainPanel 三挂载点交接——新实例先注册、旧实例后注销（Vue 挂载点
    // 切换的真实事件序，真实组件 mount/unmount 驱动注册/注销，非手工桩时序）。
    // 旧缺陷：refCount 条目保留首注册者 getters ⇒ 活实例注册后读点仍指已卸载实例
    // （containerRef=null ⇒ rect 恒 null ⇒ main 侧保守恒相交，几何相交判定失效）。
    // 每实例 rect 带实例序号标记（x=序号），卸载后 el=null ⇒ 死实例 getter 返回 null——
    // 三种形态（死实例=null / 首注册者=1 / 活实例=2,3）可判别。
    let instanceSeq = 0
    function mountToastInstance() {
      const seq = ++instanceSeq
      const el = ref<HTMLElement | null>(null)
      const visible = ref(false)
      const wrapper = mount(defineComponent({
        setup() {
          const dispose = registerModalSurface({
            surface: 'toast-container',
            key: 'toast-container',
            isOpen: () => visible.value,
            rect: () => (el.value ? { x: seq, y: 0, width: 100, height: 40 } : null),
          })
          onBeforeUnmount(dispose)
          return () => h('div', { ref: el, 'data-testid': `toast-host-${seq}` })
        },
      }))
      return { wrapper, visible, seq }
    }
    const reportedXs = () => openShieldingSurfaces().map((s) => s.rect?.x ?? null)

    // ① 实例 A 注册并开：rect = A（x=1）
    const a = mountToastInstance()
    a.visible.value = true
    await nextTick()
    expect(reportedXs(), '单实例在册：读点 = A').toEqual([1])

    // ② 实例 B 注册（交接窗口开启——A 尚未注销）+ 开：条目读点立即覆盖为 B（最新注册者 wins）
    const b = mountToastInstance()
    b.visible.value = true
    await nextTick()
    expect(reportedXs(), '交接窗口内读点必须已切到 B，不得保留首注册者 A').toEqual([2])

    // ③ 实例 A 注销（refCount 2→1，条目保留）：rect 仍 = B 活实例——
    //    A 已卸载（el=null ⇒ 其 getter 返回 null），读点若残留 A 则 rect 键直接消失
    a.wrapper.unmount()
    await nextTick()
    expect(reportedXs(), '交接完成：读点 = 活实例 B，死实例 A（null）不得浮现').toEqual([2])
    expect(isModalSurfaceOpen('toast-container'), 'refCount 未归零条目保留').toBe(true)

    // ④ 实例 B 注销（refCount 归零 → 条目摘除，「挂载⇔开」语义保持）
    b.wrapper.unmount()
    await nextTick()
    expect(openShieldingSurfaces()).toEqual([])
    expect(isModalSurfaceOpen('toast-container'), '归零后摘除').toBe(false)

    // ⑤ 实例 C 重注册（摘除后全新条目）并开：读点 = C（x=3）
    const c = mountToastInstance()
    c.visible.value = true
    await nextTick()
    expect(reportedXs(), '重注册起新条目：读点 = C').toEqual([3])

    // 收尾：卸载 C，不给后续用例留活条目（beforeEach 也有 reset 兜底）
    c.wrapper.unmount()
    await nextTick()
    expect(isModalSurfaceOpen('toast-container')).toBe(false)
  })
})

// ═══════════ 来源节：use-quota-configure ═══════════

// 逐名映射到本 mock 集，替换原 domains/quota 模块 mock；断言范围不变，仍打 quotaApi.*）。
// fetchQuota 不在 seam 方法侧（useQuotaConfigure 结构上不可达），保留仅供「零查询调用」负向断言。
const quotaApi = vi.hoisted(() => ({
  getCached: vi.fn<(providerId: string) => Promise<QuotaSnapshot>>(),
  fetchQuota: vi.fn<(providerId: string) => Promise<QuotaSnapshot>>(),
  refreshQuota: vi.fn<(providerId: string) => Promise<QuotaSnapshot>>(),
  configure: vi.fn<(payload: QuotaConfigurePayload) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
}))

import { useQuotaConfigure } from '@/composables/features/settings/useQuotaConfigure'
import { useQuotaStore } from '@/stores/quota'

const P = (fetcher: string): QuotaPreset | undefined => QUOTA_PRESETS.find((p) => p.fetcher === fetcher)

const ZHIPU_PRESET = P('zhipu')
const KIMI_PRESET = P('kimi-coding')
const MIMO_PRESET = P('mimo')
const OPENCODE_PRESET = P('opencode-go')

/** Provider fixture（默认 api-key 类、有 provider 凭据；quota 由各用例显式给出）。
 *  id 是 brand 类型（shared/provider.ts:14），fixture 用裸字符串提升（同 renderer 既有惯例）。 */
function provider(overrides: Partial<Omit<ProviderInfo, 'id'>> & { id?: string } = {}): ProviderInfo {
  const { id = 'p1', ...rest } = overrides
  return {
    name: 'Test Provider',
    api: 'openai-completions',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [],
    ...rest,
    id: id as ProviderId,
  } as ProviderInfo
}

/** module 装配（对齐 QuotaConfigureInputs）：返回实例 + provider ref（广播重置用例要换快照）。
 *  t 注入 fake（key 前缀 T: 渲染）：文案断言全部走「注入 t 的渲染值」，证明 i18n 出口来自
 *  注入而非模块级 cast（失败文案用例见 ⑧ describe 的显式打点断言）。 */
function mountModule(
  providerInit: ProviderInfo,
  opts: { preset?: QuotaPreset | undefined; oauthPresent?: boolean; providerApiKeyDraft?: string } = {},
): { module: QuotaConfigureModule; provider: Ref<ProviderInfo | null>; t: Translate } {
  const providerRef = ref<ProviderInfo | null>(providerInit)
  const t = vi.fn<(key: string, params?: Record<string, unknown>) => string>((key) => `T:${key}`)
  const module = useQuotaConfigure({
    t,
    provider: providerRef,
    preset: ref(opts.preset),
    providerOauthPresent: ref(opts.oauthPresent ?? false),
    providerApiKeyDraft: ref(opts.providerApiKeyDraft ?? ''),
  })
  return { module, provider: providerRef, t }
}

// ── 高频基线装配（文件内单源）────────────────────────────────────────────────
// 三类 fetcher 的「无覆写」provider 快照 + preset 组合是十余处用例的公共装配侧（差异全在
// 断言侧动作与期望值）；基线收敛在此，变体形态（enabled 翻转 / 已保存 workspace /
// apiKeySet·credentialSource 覆写 / 未选类型等）仍直接走 mountModule 内联。

/** 基线键 = fetcher 名（与 QUOTA_PRESETS 的 fetcher 对齐）。 */
type BaselineKey = 'mimo' | 'kimi-coding' | 'opencode-go'

const BASELINES: Record<BaselineKey, { preset: QuotaPreset | undefined; providerInit: ProviderInfo }> = {
  // cookie 类基线：已保存 cookie、类型未变
  mimo: {
    preset: MIMO_PRESET,
    providerInit: provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
  },
  // api-key 类基线：source=provider（provider.apiKeySet 默认 true，凭据可用）
  'kimi-coding': {
    preset: KIMI_PRESET,
    providerInit: provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
  },
  // cookie+workspace 类基线：已保存 cookie、workspace 未保存
  'opencode-go': {
    preset: OPENCODE_PRESET,
    providerInit: provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true } }),
  },
}

/** mount 基线并落定（原用例内联形态「mountModule(...) + await Promise.resolve()」的单源化）。 */
async function mountBaseline(key: BaselineKey) {
  const mounted = mountModule(BASELINES[key].providerInit, { preset: BASELINES[key].preset })
  await Promise.resolve()
  return mounted
}

/** 读取最近一次 configure 的 payload（逐键断言用；避免 toEqual 对 undefined 键的宽松处理掩盖 ''）。 */
function lastConfigurePayload() {
  return vi.mocked(quotaApi.configure).mock.calls[0]?.[0]
}

const mockRow: NormalizedQuotaRow = {
  label: 'Kimi Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: 41, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

// ── ① readiness 齐备性矩阵 ──────────────────────────────────────────────────
describe('readiness 齐备性矩阵（D1 / D13）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('未选类型 → missing [type] + type.undetermined（UI 走 D8 分支，不渲染按钮）', async () => {
    const { module } = mountModule(provider({ quota: undefined }))
    await Promise.resolve()

    expect(module.view.value.type.selected).toBeUndefined()
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['type'] })
    expect(module.view.value.type.undetermined).toBe(true)
  })

  it('cookie 类：草稿空且未保存 cookie → missing [cookie]；填入草稿即齐备', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo' } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['cookie'] })

    module.draft.value.cookie = 'session=abc'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('cookie 类：已保存 cookie 且类型未变 → 齐备（密文取「草稿 ∨ 已保存」并集）', async () => {
    const { module } = await mountBaseline('mimo')

    // 已保存密文以掩码哨兵展示（D7），非空草稿本身就满足齐备
    expect(module.draft.value.cookie).toBe(QUOTA_SECRET_MASK)
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('草稿类型不在 QUOTA_PRESETS（历史数据 / 手工编辑 providers.json）→ missing [type]，不静默按 api-key 放行', async () => {
    // 未知 fetcher 无法判定凭证形态（是否 cookie 类 / 是否需要 workspace）：旧行为是
    // isCookieAuth / needsWorkspace 双双落 false 后走 api-key 分支，provider 凭据可用时
    // readiness.ready=true → 放行一条带未知 fetcher 的 configure。按「类型缺失」处理（D8 同形态）。
    const { module } = mountModule(
      provider({
        id: 'legacy-p',
        apiKeySet: true,
        quota: { enabled: false, fetcher: 'legacy-unknown', apiKeySet: true },
      }),
    )
    await Promise.resolve()

    expect(module.view.value.type.selected).toBe('legacy-unknown')
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['type'] })

    // 重选一个有效预设类型 → 判定恢复常态（检查不是「命中一次就永久卡死」）
    module.selectType('kimi-coding')
    expect(module.view.value.readiness.missing).not.toContain('type')
  })

  it('api-key 类 source=provider：看 providerAvailable（provider.apiKeySet）', async () => {
    const ready = mountModule(
      provider({ id: 'kimi-p', apiKeySet: true, quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()
    expect(ready.module.view.value.credential.providerAvailable).toBe(true)
    expect(ready.module.view.value.readiness).toEqual({ ready: true, missing: [] })

    const missing = mountModule(
      provider({ id: 'kimi-p', apiKeySet: false, quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()
    expect(missing.module.view.value.credential.providerAvailable).toBe(false)
    expect(missing.module.view.value.readiness).toEqual({ ready: false, missing: ['apiKey'] })
  })

  it('api-key 类 source=exclusive：已保存 apiKeySet 且类型未变 → 齐备；填草稿仍齐备', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.credentialSource).toBe('exclusive')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.draft.value.apiKey = 'sk-draft'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('cookie 类 fetcher（auth 不含 api-key）+ credentialSource=exclusive → 不走专属 Key 判定，仍按 cookie 齐备性', async () => {
    // §7 残留 11：exclusive 只对声明了 api-key 形态的 fetcher 适用。cookie 类即使磁盘上残留
    // credentialSource='exclusive'，判定也必须落回 cookie 分支（与 runtime 忽略 exclusive、
    // 按 auth 数组序解析一致），不得因「专属 Key 缺失」置灰（apiKeySet=false 也不会误报 apiKey）。
    const { module } = mountModule(
      provider({
        id: 'mimo-p',
        quota: { enabled: false, fetcher: 'mimo', credentialSource: 'exclusive', cookieSet: true },
      }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.credential.form).toBe('cookie')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    // 无 cookie 且未保存 → 只报 cookie（不报 apiKey，证明 exclusive 未参与判定）
    const noCookie = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', credentialSource: 'exclusive' } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()
    expect(noCookie.module.view.value.readiness).toEqual({ ready: false, missing: ['cookie'] })
  })

  it('requiresWorkspace 只看草稿：已保存 workspace 不计入，清空即置灰（D13）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        quota: {
          enabled: false,
          fetcher: 'opencode-go',
          cookieSet: true,
          workspace: 'https://opencode.ai/workspace/wrk_saved/go',
        },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.workspace).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.draft.value.workspace = ''
    // 磁盘上仍有 workspace，但判定只看草稿 —— 两个密文字段才是并集规则
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['workspace'] })
  })

  it('多个缺口按 cookie → workspace 顺序累积', async () => {
    const { module } = mountModule(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go' } }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['cookie', 'workspace'] })
  })
})

// ── ② 凭证归属（D5） ────────────────────────────────────────────────────────
describe('凭证归属 typeChanged（D5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('savedFetcher undefined 不算类型已变（无既存归属可比）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    // 草稿类型来自自动匹配 preset；quota.fetcher 未保存过
    expect(module.view.value.type.selected).toBe('mimo')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    await module.saveAndTest()

    // 若把 undefined 也算变更，这里会传 '' 制造一次用户从未请求的 cookie 清除
    expect(lastConfigurePayload()?.cookie).toBeUndefined()
  })

  it('类型切换后旧 cookie 归属失效：不计入齐备', async () => {
    const { module } = await mountBaseline('mimo')

    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.selectType('opencode-go')
    module.draft.value.workspace = 'wrk_abc'
    // 旧 MiMo cookie 不再算「已填」；workspace 草稿已填
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['cookie'] })

    module.draft.value.cookie = 'opencode-session'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('类型切换后旧专属 Key 归属失效（exclusive 来源）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.selectType('minimax')
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['apiKey'] })

    module.draft.value.apiKey = 'sk-new'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })
})

// ── ③ saveAndTest payload 构造（§7.2 细节 4） ───────────────────────────────
describe('saveAndTest payload 构造（§7.2 细节 4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('cookie 类：草稿空 + 类型未变 → cookie 缺省；fetcher / credentialSource / enabled 恒传', async () => {
    const { module } = await mountBaseline('mimo')

    await module.saveAndTest()

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(lastConfigurePayload()).toEqual({
      providerId: 'mimo-p',
      enabled: false,
      fetcher: 'mimo',
      credentialSource: 'provider',
      cookie: undefined,
      apiKey: undefined,
      workspace: undefined,
    })
  })

  it('cookie 类：草稿非空 → 传 trim 后的草稿', async () => {
    const { module } = await mountBaseline('mimo')

    module.draft.value.cookie = '  session=abc  '
    await module.saveAndTest()

    expect(lastConfigurePayload()?.cookie).toBe('session=abc')
  })

  it('类型变更 + cookie 草稿空 → 传空串清除（归属失效无条件清除）', async () => {
    const { module } = await mountBaseline('mimo')

    module.selectType('zhipu')
    await module.saveAndTest()

    expect(lastConfigurePayload()).toEqual({
      providerId: 'mimo-p',
      enabled: false,
      fetcher: 'zhipu',
      credentialSource: 'provider',
      cookie: '',
      apiKey: undefined,
      workspace: undefined,
    })
  })

  it('exclusive 来源：草稿非空 → 传 apiKey；enabled 跟随当前值恒传', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: true, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    module.draft.value.apiKey = ' sk-own '
    await module.saveAndTest()

    expect(lastConfigurePayload()).toEqual({
      providerId: 'zhipu-p',
      enabled: true,
      fetcher: 'zhipu',
      credentialSource: 'exclusive',
      cookie: undefined,
      apiKey: 'sk-own',
      workspace: undefined,
    })
  })

  it('exclusive 来源：草稿空 → apiKey 永不传空串（undefined 保留既存）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    // 初始态是掩码哨兵（apiKeySet: true），显式清空以覆盖「空草稿」分支
    module.draft.value.apiKey = ''
    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()

    vi.mocked(quotaApi.configure).mockClear()
    module.draft.value.apiKey = '   '
    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('exclusive 来源：掩码哨兵草稿 → 不发送哨兵（undefined 保留既存，D7）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.apiKey).toBe(QUOTA_SECRET_MASK)
    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('cookie 类：掩码哨兵草稿 → 不发送哨兵；输入新值照常落盘（D7）', async () => {
    const { module } = await mountBaseline('mimo')

    expect(module.draft.value.cookie).toBe(QUOTA_SECRET_MASK)
    await module.saveAndTest()
    expect(lastConfigurePayload()?.cookie).toBeUndefined()

    vi.mocked(quotaApi.configure).mockClear()
    module.draft.value.cookie = ' session=new '
    await module.saveAndTest()
    expect(lastConfigurePayload()?.cookie).toBe('session=new')
  })

  it('source=provider 时即使草稿填了 apiKey 也不传（专属 Key 失效由来源表达，D3）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', credentialSource: 'provider' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    module.draft.value.apiKey = 'sk-ignored'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('workspace 必填：草稿非空 → 传归一化 URL（永不空串）', async () => {
    const { module } = await mountBaseline('opencode-go')

    module.draft.value.workspace = 'wrk_newid77'
    await module.saveAndTest()

    expect(lastConfigurePayload()).toEqual({
      providerId: 'oc-p',
      enabled: false,
      fetcher: 'opencode-go',
      credentialSource: 'provider',
      cookie: undefined,
      apiKey: undefined,
      workspace: 'https://opencode.ai/workspace/wrk_newid77/go',
    })
  })

  it('workspace 草稿空 → 本地拦截，不发 RPC（D13：不再有空串 = 清除通道）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true, workspace: 'https://opencode.ai/workspace/wrk_x/go' },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.workspace = ''
    await module.saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaWorkspaceRequired')
  })

  it('非 requiresWorkspace 类型不传 workspace 键', async () => {
    const { module } = await mountBaseline('kimi-coding')

    await module.saveAndTest()
    expect(lastConfigurePayload()?.workspace).toBeUndefined()
  })

  it('保存成功不清空密文草稿；provider 广播重建后转掩码哨兵（D7）', async () => {
    const { module, provider: providerRef } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.apiKey).toBe(QUOTA_SECRET_MASK)
    module.draft.value.apiKey = 'sk-own'
    await module.saveAndTest()

    // 用户输入保留在框内（不再「保存即消失」）
    expect(module.draft.value.apiKey).toBe('sk-own')

    // 掩码哨兵展示态单源来自磁盘态重建（真实链路 = configure 成功后 runtime 广播 provider 列表）
    providerRef.value = provider({
      id: 'zhipu-p',
      quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
    })
    await vi.waitFor(() => { expect(module.draft.value.apiKey).toBe(QUOTA_SECRET_MASK) })
  })

  it('落盘成功后触发一次查询（D2：保存并测试合一）', async () => {
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: mockRow, lastFetchAt: 2000 })
    const { module } = await mountBaseline('kimi-coding')

    await module.saveAndTest()

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('kimi-p')
    expect(module.test.value.status).toBe('success')
    expect(module.test.value.row).toEqual(mockRow)
  })

  it('测试查询结果同步写回全局 quota store（套餐浮层 / 容量卡单源镜像跟随）', async () => {
    const { module } = await mountBaseline('kimi-coding')

    // 成功：setCache 写 data 清 error
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: mockRow, lastFetchAt: 2000 })
    await module.saveAndTest()
    const store = useQuotaStore()
    expect(store.getEntry('kimi-p')?.data).toEqual(mockRow)
    expect(store.getEntry('kimi-p')?.lastFetchAt).toBe(2000)
    expect(store.getEntry('kimi-p')?.error).toBeNull()

    // 失败态（A2-4）：保留旧 data、写 error（与 useQuotaQuery 失败路径同口径）
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: 2000, reason: 'unauthorized' })
    await module.saveAndTest()
    expect(store.getEntry('kimi-p')?.data).toEqual(mockRow)
    expect(store.getEntry('kimi-p')?.error).not.toBeNull()
  })

  it('落盘失败 → 不触发查询，失败态走 i18n', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const { module } = await mountBaseline('kimi-coding')

    await module.saveAndTest()

    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaSaveAndTestFail')
  })

  it('payload 在 await 之前捕获：configure 期间 provider 广播重置草稿，提交的 fetcher 仍是调用时刻的草稿值', async () => {
    // 防的回归：payload 组装被移到 await 之后（§7.1 时序约定 1）。真实链路里 configure 成功后
    // runtime 广播 provider 列表 → watch(providerRef) → syncFromProvider 把草稿重置为磁盘态，
    // 此时再读草稿读到的是被重置后的值（用户选的类型丢失）。
    // 此时再读草稿读到的是被重置后的值（用户选的类型丢失）。
    const { module, provider: providerRef } = await mountBaseline('kimi-coding')

    // 草稿：用户把类型从磁盘值 kimi-coding 改成 zhipu
    module.selectType('zhipu')

    // 调用期间改写 providerRef（新对象引用触发 watch → syncFromProvider 重置草稿）
    vi.mocked(quotaApi.configure).mockImplementation(async () => {
      providerRef.value = provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } })
      return { ok: true }
    })

    await module.saveAndTest()

    expect(lastConfigurePayload()?.fetcher).toBe('zhipu')
    // 反证：重置确实发生了（否则本用例空转 —— 草稿本来就还是 'zhipu'）
    expect(module.view.value.type.selected).toBe('kimi-coding')
  })
})

// ── ④ setEnabled（D4） ──────────────────────────────────────────────────────
describe('setEnabled 纯配置位（D4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('只发 { providerId, enabled } 且零查询调用（草稿类型 / 来源不被偷偷落盘）', async () => {
    const { module } = await mountBaseline('kimi-coding')

    // 草稿里制造未提交的类型选择：开关不得把它带出去
    module.selectType('mimo')
    await module.setEnabled(true)

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(vi.mocked(quotaApi.configure).mock.calls[0]![0]).toEqual({ providerId: 'kimi-p', enabled: true })
    expect(module.view.value.enabled).toBe(true)
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })

  it('关闭同样只发单字段；失败回滚开关并落 i18n 文案', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await vi.waitFor(() => { expect(module.view.value.enabled).toBe(true) })

    await module.setEnabled(false)

    expect(vi.mocked(quotaApi.configure).mock.calls[0]![0]).toEqual({ providerId: 'kimi-p', enabled: false })
    expect(module.view.value.enabled).toBe(true) // 回滚
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaConfigureFail')
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
  })

  it('transport 抛错 → 回滚开关并落 i18n 文案', async () => {
    vi.mocked(quotaApi.configure).mockRejectedValue(new Error('transport unavailable'))
    const { module } = await mountBaseline('kimi-coding')

    await module.setEnabled(true)

    expect(module.view.value.enabled).toBe(false)
    // 抛错路径沿用 message（诊断信息优先），非 i18n 默认串
    expect(module.view.value.configureError).toBe('transport unavailable')
  })
})

// ── ⑤ 掩码哨兵（D7） ────────────────────────────────────────────────────────
describe('掩码哨兵（D7）：已保存密文显示 QUOTA_SECRET_MASK', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('syncFromProvider 后已保存的 cookie / 专属 Key 显示掩码哨兵（密文本身不回传）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        apiKeySet: true,
        quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true, apiKeySet: true },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.cookie).toBe(QUOTA_SECRET_MASK)
    expect(module.draft.value.apiKey).toBe(QUOTA_SECRET_MASK)
  })

  it('未保存的密文草稿保持空（不预填哨兵）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo' } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.cookie).toBe('')
  })

  it('provider 快照更新（广播）重跑 syncFromProvider → 已保存密文显示为掩码哨兵（磁盘态单源）', async () => {
    const { module, provider: providerRef } = mountModule(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go' } }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = 'draft-cookie'
    providerRef.value = provider({
      id: 'oc-p',
      quota: {
        enabled: false,
        fetcher: 'opencode-go',
        cookieSet: true,
        workspace: 'https://opencode.ai/workspace/wrk_saved/go',
      },
    })

    await vi.waitFor(() => { expect(module.draft.value.workspace).toBe('https://opencode.ai/workspace/wrk_saved/go') })
    expect(module.draft.value.cookie).toBe(QUOTA_SECRET_MASK)
  })
})

// ── ⑥ 类型草稿写入（D5 细节 2） ─────────────────────────────────────────────
describe('类型草稿写入（D5 细节 2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('同值选中不重置凭证草稿、不发 RPC（reka Select 同值也 emit）', async () => {
    const { module } = await mountBaseline('mimo')

    module.draft.value.cookie = 'unsubmitted'
    module.selectType('mimo')

    expect(module.draft.value.cookie).toBe('unsubmitted')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })

  it('类型真变 → 清凭证草稿，但 Workspace 草稿保留（D13）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        quota: {
          enabled: false,
          fetcher: 'opencode-go',
          cookieSet: true,
          workspace: 'https://opencode.ai/workspace/wrk_saved/go',
        },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = 'unsubmitted'
    module.selectType('mimo')

    expect(module.draft.value.cookie).toBe('')
    expect(module.draft.value.workspace).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })

  it('非字符串 payload 被检查拦下（reka Select 宽联合类型；不许 String() 强转出 "undefined"）', async () => {
    const { module } = await mountBaseline('mimo')

    module.draft.value.cookie = 'unsubmitted'
    module.selectType(undefined)
    module.selectType({ weird: true })

    expect(module.view.value.type.selected).toBe('mimo')
    expect(module.draft.value.cookie).toBe('unsubmitted')
  })
})

// ── ⑦ loadCached reason（D6 影响面表修正） ──────────────────────────────────
describe('loadCached reason 透传', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('data=null 但带 reason → 整体呈失败态（不再丢成 idle）', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'no-credential' })
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )

    await vi.waitFor(() => { expect(module.test.value.status).toBe('error') })
    expect(module.test.value.failure).toEqual({ kind: 'no-credential', cookieAuth: true, message: '' })
    expect(module.test.value.row).toBeNull()
    expect(module.test.value.lastFetchAt).toBe(5000)
  })

  it('缓存携带 reason + 旧数据 → 失败态且旧数据保留（「查看上次成功数据」数据源）', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )

    await vi.waitFor(() => { expect(module.test.value.status).toBe('error') })
    expect(module.test.value.failure?.kind).toBe('unauthorized')
    expect(module.test.value.row).toEqual(mockRow)
  })

  it('缓存无 reason → success 态；provider 无 quota 配置 → idle 且不调 getCached', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000 })
    const kimi = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await vi.waitFor(() => { expect(kimi.module.test.value.status).toBe('success') })
    expect(kimi.module.test.value.failure).toBeNull()

    vi.mocked(quotaApi.getCached).mockClear()
    const noQuota = mountModule(
      provider({ id: 'kimi-p', quota: undefined }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()
    expect(noQuota.module.test.value.status).toBe('idle')
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })
})

// ── ⑧ configureError 走 i18n（D9） ─────────────────────────────────────────
describe('configureError i18n（D9）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('saveAndTest 返回 ok:false 且带 error → 优先透传 error（跳过 i18n 兜底）', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: 'disk full' })
    const { module } = await mountBaseline('kimi-coding')

    await module.saveAndTest()
    expect(module.view.value.configureError).toBe('disk full')
  })

  it('saveAndTest 非 Error 抛错 → 兜底走 quotaSaveAndTestFail', async () => {
    vi.mocked(quotaApi.configure).mockRejectedValue('boom')
    const { module } = await mountBaseline('kimi-coding')

    await module.saveAndTest()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaSaveAndTestFail')
  })

  it('workspace 非法输入 → i18n 文案且不发 RPC', async () => {
    const { module } = await mountBaseline('opencode-go')

    module.draft.value.workspace = 'https://evil.example.com/workspace/wrk_x/go'
    await module.saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaWorkspaceInvalid')
  })

  it('cookie 无 name=value 对（DevTools 表格粘贴形态）→ 本地拦下：专属文案且不发任何 RPC（2026-10-18）', async () => {
    const { module } = await mountBaseline('mimo')

    // 制表符/换行分隔，无任何 '=' —— 归一化后为空（与 runtime fetcher 同一函数判据）
    module.draft.value.cookie = 'auth\toc_fake123\nsession\txyz789'
    await module.saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaCookieFormatInvalid')
  })

  it('cookie 合法（name=value; name=value）→ 通过校验正常发 configure', async () => {
    const { module } = await mountBaseline('mimo')

    module.draft.value.cookie = 'auth=abc; session=xyz'
    await module.saveAndTest()

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(lastConfigurePayload().cookie).toBe('auth=abc; session=xyz')
  })

  it('失败文案经注入 t 渲染（i18n 出口来自入参注入，与 provider-edit deps.t 同范式）', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const { module, t } = await mountBaseline('kimi-coding')

    await module.saveAndTest()

    expect(t).toHaveBeenCalledWith('settings.providerEdit.quotaSaveAndTestFail')
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaSaveAndTestFail')
  })
})

// ── ⑨ 既有回归：reason 透传 / preset 派生 ───────────────────────────────────
describe('既有回归（reason 透传 / preset 派生）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('saveAndTest 内查询失败 → failure 分档 + lastFetchAt = 最近成功时间', async () => {
    const { module } = await mountBaseline('kimi-coding')
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'network' })

    await module.saveAndTest()

    expect(module.test.value.status).toBe('error')
    expect(module.test.value.failure).toEqual({ kind: 'network', cookieAuth: false, message: 'T:settings.providerEdit.quotaTestFail' })
    expect(module.test.value.lastFetchAt).toBe(5000)
  })

  it('查询抛错 → error 态 + failure generic + 错误消息透传', async () => {
    const { module } = await mountBaseline('kimi-coding')
    vi.mocked(quotaApi.refreshQuota).mockRejectedValue(new Error('transport unavailable'))

    await module.saveAndTest()

    expect(module.test.value.status).toBe('error')
    expect(module.test.value.failure).toEqual({ kind: 'generic', cookieAuth: false, message: 'transport unavailable' })
  })

  it('凭证形态 / workspace 需求随草稿类型派生（view.credential.form / view.workspace.required）', async () => {
    const { module } = await mountBaseline('kimi-coding')

    expect(module.view.value.type.selected).toBe('kimi-coding')
    expect(module.view.value.credential.form).toBe('apiKey')
    expect(module.view.value.credential.exclusiveApplicable).toBe(true)
    expect(module.view.value.workspace.required).toBe(false)

    module.selectType('opencode-go')
    expect(module.view.value.credential.form).toBe('cookie')
    expect(module.view.value.workspace.required).toBe(true)
  })

  it('store quotaPresets 为空数组（RPC 未回包 / 拉取失败）→ 类型下拉回落编译期基线，不永久为空', async () => {
    // dmg-r3-1 回归：settings-store 的 quotaPresets 初值是 `[]`（非 undefined），裸读 .value
    // 会让 fetcherOptions 恒空、isCookieAuth 对已选类型判不出 cookie 形态（C-proc-21 禁静默空值）。
    getSettingsStore().setQuotaPresets([])
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    await Promise.resolve()

    expect(module.view.value.type.options).toHaveLength(QUOTA_PRESETS.length)
    expect(module.view.value.type.options.map((o) => o.value)).toEqual(QUOTA_PRESETS.map((p) => p.fetcher))
    // 空态回落后已选 cookie 类类型的凭证形态仍可判定（否则 readiness 会误判成 api-key 分支）
    expect(module.view.value.credential.form).toBe('cookie')
  })
})

// ── ⑩ 收拢进 implementation 的派生逻辑（C1） ──────────────────────────────────
describe('派生逻辑收拢（C1：失败归一 / 警示分档 / 来源提示 / 类型分层）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W3c 后 presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
    // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: quotaApi.getCached,
      refreshQuota: quotaApi.refreshQuota,
      configureQuota: quotaApi.configure,
    }))
  })

  it('失败原因归一：reason → 分档；无 reason / 未分类 reason → generic 带兜底消息', async () => {
    const reasonKind: Array<[QuotaFetchFailureReason, QuotaFailureKind]> = [
      ['unauthorized', 'unauthorized'],
      ['parse', 'parse'],
      ['not_configured', 'not-configured'],
      ['credential-unavailable', 'generic'],
    ]
    for (const [reason, kind] of reasonKind) {
      vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null, reason })
      const { module } = await mountBaseline('kimi-coding')
      await module.saveAndTest()
      expect(module.test.value.failure?.kind, reason).toBe(kind)
    }
  })

  it('providerWarning 分档：表单草稿「已填未保存」→ pendingSave；空 → missing；有凭据 → null', async () => {
    // §7.4 判定输入是 provider 表单草稿（carry-in 槽位 providerApiKeyDraft）
    const pending = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: false, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: 'sk-draft-key' },
    )
    await Promise.resolve()
    expect(pending.module.view.value.credential.providerWarning).toBe('pendingSave')

    const missing = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: false, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: '' },
    )
    await Promise.resolve()
    expect(missing.module.view.value.credential.providerWarning).toBe('missing')

    const satisfied = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: true, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: 'sk-draft-key' },
    )
    await Promise.resolve()
    expect(satisfied.module.view.value.credential.providerWarning).toBeNull()
  })

  it('清除哨兵 __CLEAR__ 非空但语义是无凭据 → pendingSave 判定排除（否则文案与事实相反）', async () => {
    const { module } = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: false, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: '__CLEAR__' },
    )
    await Promise.resolve()

    expect(module.view.value.credential.providerWarning).toBe('missing')
  })

  it('来源提示分档：exclusive / Provider-OAuth 已登录 / Provider-API Key 三分支', async () => {
    const base = provider({ id: 'kimi-p', apiKeySet: true, quota: { enabled: false, fetcher: 'kimi-coding' } })

    const exclusive = mountModule(base, { preset: KIMI_PRESET })
    await Promise.resolve()
    exclusive.module.draft.value.credentialSource = 'exclusive'
    expect(exclusive.module.view.value.credential.sourceHint).toBe('exclusive')

    const oauth = mountModule(base, { preset: KIMI_PRESET, oauthPresent: true })
    await Promise.resolve()
    expect(oauth.module.view.value.credential.sourceHint).toBe('providerOauth')

    const apiKey = mountModule(base, { preset: KIMI_PRESET, oauthPresent: false })
    await Promise.resolve()
    expect(apiKey.module.view.value.credential.sourceHint).toBe('providerApiKey')
  })

  it('type.undetermined：草稿空 ∨ preset 未命中；help 随选中 fetcher 派生（无帮助 → null）', async () => {
    const { module } = mountModule(
      provider({ id: 'legacy-p', quota: { enabled: false, fetcher: 'legacy-unknown' } }),
      { preset: undefined },
    )
    await Promise.resolve()
    expect(module.view.value.type.undetermined).toBe(true)
    expect(module.view.value.help).toBeNull()

    module.selectType('opencode-go')
    expect(module.view.value.type.undetermined).toBe(false)
    expect(module.view.value.help?.url).toBe('https://opencode.ai/')
    expect(module.view.value.workspace.required).toBe(true)
  })
})

// ═══════════ 来源节：use-project-skills ═══════════

// onSkillCacheInvalidated stub（Wave3 失效信号订阅调用；W4 用例不验证订阅，stub 为空实现）。
const getProjectSkillsMock = vi.hoisted(() => vi.fn())
const onSkillCacheInvalidatedMock = vi.hoisted(() => vi.fn().mockReturnValue(() => {}))
// [C3] 读 RPC 与失效信号订阅经 SettingsTransport seam 桩注入（替换原 @/api 门面 mock）

/** resetModules 后 @taiji/core 是新模块实例（transport 单例重置）——从同实例 provide。 */
async function provideSeam(overrides: SettingsTransportStubOverrides): Promise<void> {
  const { provideSettingsTransport: provide } = await import('@taiji/core')
  provide(makeSettingsTransportStub(overrides))
}

import { useProjectSkills } from '@/composables/features/settings/useProjectSkills'

const SKILLS_A: SkillInfo[] = [
  { id: 's-a1', name: 'proj-a-skill', description: 'a', enabled: true, source: 'agents', effective: true },
]
const SKILLS_B: SkillInfo[] = [
  { id: 's-b1', name: 'proj-b-skill', description: 'b', enabled: true, source: 'agents', effective: true },
]

describe('useProjectSkills (W4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    provideSettingsTransport(makeSettingsTransportStub({
      getProjectSkills: getProjectSkillsMock,
      onSkillCacheInvalidated: onSkillCacheInvalidatedMock,
    }))
  })

  it('currentCwd 变化触发 getProjectSkills(cwd)，projectSkills 更新', async () => {
    getProjectSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)

    // 初始 cwd=/proj-a → 触发 RPC
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).toHaveBeenCalledWith('/proj-a')
    })
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual(SKILLS_A)
    })
  })

  it('切到新 cwd → 触发新 RPC，projectSkills 更新为新 cwd 的 skill', async () => {
    getProjectSkillsMock.mockResolvedValueOnce(SKILLS_A).mockResolvedValueOnce(SKILLS_B)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))

    cwd.value = '/proj-b'
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).toHaveBeenCalledWith('/proj-b')
    })
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
  })

  it('切回旧 cwd 命中缓存，不重复 RPC', async () => {
    getProjectSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(1)

    cwd.value = '/proj-b'
    getProjectSkillsMock.mockResolvedValue(SKILLS_B)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(2)

    // 切回 /proj-a → 命中缓存，不触发第 3 次 RPC
    cwd.value = '/proj-a'
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(2)
  })

  it('currentCwd 为 null → projectSkills 为空数组，不 RPC', async () => {
    const cwd = ref<string | null>(null)
    const { projectSkills } = useProjectSkills(cwd)

    // 等待一个 tick 确保 watch 不触发
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).not.toHaveBeenCalled()
      expect(projectSkills.value).toEqual([])
    })
  })

  it('getProjectSkills 抛错 → projectSkills 为空数组 + loadError 置位（RD-4#13 显形）', async () => {
    getProjectSkillsMock.mockRejectedValue(new Error('rpc fail'))
    const cwd = ref<string | null>('/proj-x')

    const { projectSkills, loadError } = useProjectSkills(cwd)

    await vi.waitFor(() => expect(getProjectSkillsMock).toHaveBeenCalled())
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual([])
    })
    // RD-4#13：失败不再仅 warn——loadError 置位供列表区插可重试提示
    expect(loadError.value).toBe(true)
  })

  it('RD-4#13：retry() 重新拉取成功 → projectSkills 填充 + loadError 清除', async () => {
    getProjectSkillsMock.mockRejectedValueOnce(new Error('rpc fail'))
    const cwd = ref<string | null>('/proj-x')

    const { projectSkills, loadError, retry } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(loadError.value).toBe(true))
    expect(projectSkills.value).toEqual([])

    // 重试：mock 改成功
    getProjectSkillsMock.mockResolvedValueOnce(SKILLS_A)
    retry()
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual(SKILLS_A)
    })
    expect(loadError.value).toBe(false)
  })
})

// ── Wave3 TC1-TC4：订阅 skill 缓存失效信号 + 失败不永久失败 ──────────
// 模块级状态（globalLoaded/globalInvalidateSubscribed/projectInvalidateSubscribed）跨 it 持久，
// 需每个 it 重置：vi.resetModules() 清模块缓存 + 重新 vi.mock + 动态 import 拿全新模块实例。
// onSkillCacheInvalidated 订阅指向的 events 模块也需一起重置（否则旧订阅残留导致检查计数错误）。

const SKILL_1: SkillInfo[] = [
  { id: 's1', name: 'skill1', description: 'one', enabled: true, source: 'agents', effective: true },
]
const SKILL_1_2: SkillInfo[] = [
  { id: 's1', name: 'skill1', description: 'one', enabled: true, source: 'agents', effective: true },
  { id: 's2', name: 'skill2', description: 'two', enabled: true, source: 'agents', effective: true },
]
const SKILL_A: SkillInfo[] = [
  { id: 'sa', name: 'skillA', description: 'a', enabled: true, source: 'agents', effective: true },
]
const SKILL_A_B: SkillInfo[] = [
  { id: 'sa', name: 'skillA', description: 'a', enabled: true, source: 'agents', effective: true },
  { id: 'sb', name: 'skillB', description: 'b', enabled: true, source: 'agents', effective: true },
]

describe('useGlobalSkills / useProjectSkills (Wave3: 订阅失效信号)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    provideSettingsTransport(makeSettingsTransportStub({
      getProjectSkills: getProjectSkillsMock,
      onSkillCacheInvalidated: onSkillCacheInvalidatedMock,
    }))
  })

  beforeEach(() => {
    vi.resetModules()
  })

  /**
   * 订阅 mock 工厂：记录所有注册的 handler，并按 scope 暴露「派发」入口。
   * 用途：
   * - 用 vi.fn 断言注册次数（检查验证）
   * - emit(scope) 直接调对应 handler（绕开 events，隔离 project/global handler 各测各的）
   * 关键：首次 useProjectSkills 实例化时 project 订阅先注册（calls[0] scope=project），
   * useGlobalSkills() 内 global 订阅后注册（calls[1] scope=global）。两者各自带 scope 检查。
   */
  function makeInvalidateMock() {
    const handlers: Array<(p: { scope: 'global' | 'project'; cwd?: string }) => void> = []
    const onSkillCacheInvalidated = vi.fn(
      (handler: (p: { scope: 'global' | 'project'; cwd?: string }) => void) => {
        handlers.push(handler)
        return () => {}
      },
    )
    function emit(payload: { scope: 'global' | 'project'; cwd?: string }): void {
      // 拷贝避免遍历中 handler 改 handlers 数组
      for (const h of [...handlers]) h(payload)
    }
    function emitGlobal(): void {
      emit({ scope: 'global' })
    }
    function emitProject(cwd?: string): void {
      emit({ scope: 'project', cwd })
    }
    return { onSkillCacheInvalidated, emit, emitGlobal, emitProject }
  }

  it('TC1: useGlobalSkills RPC 失败不置 globalLoaded（修复永久失败 bug，可重试）', async () => {
    const getGlobalSkills = vi.fn().mockRejectedValue(new Error('network'))
    const inv = makeInvalidateMock()
    await provideSeam({ getGlobalSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated })

    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { globalSkills } = useGlobalSkills()
    await vi.waitFor(() => expect(getGlobalSkills).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(globalSkills.value).toEqual([]))

    // 关键断言：失败后可重试（globalLoaded 未被置 true）。mock 改 resolve([skill1]) 后，
    // 模拟 global scope 失效信号 → loadGlobal(true) 强制重新拉取 → globalSkills 刷新为 [skill1]
    getGlobalSkills.mockResolvedValue(SKILL_1)
    inv.emitGlobal()
    await vi.waitFor(() => expect(globalSkills.value).toEqual(SKILL_1))
    expect(getGlobalSkills).toHaveBeenCalledTimes(2)

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('TC2: useGlobalSkills 订阅 global scope 失效信号触发 force 重新拉取', async () => {
    const getGlobalSkills = vi.fn().mockResolvedValue(SKILL_1)
    const inv = makeInvalidateMock()
    await provideSeam({ getGlobalSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated })

    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    const { globalSkills } = useGlobalSkills()
    await vi.waitFor(() => expect(globalSkills.value).toEqual(SKILL_1))
    expect(getGlobalSkills).toHaveBeenCalledTimes(1)

    // mock 改返回 [skill1, skill2]，模拟 runtime 重扫后缓存更新
    getGlobalSkills.mockResolvedValue(SKILL_1_2)
    // 派发 global scope 失效信号 → loadGlobal(true) force 重新拉取
    inv.emitGlobal()
    await vi.waitFor(() => expect(globalSkills.value).toEqual(SKILL_1_2))
    expect(getGlobalSkills).toHaveBeenCalledTimes(2)

    // 再次调用 useGlobalSkills 不重复挂 global 订阅（globalInvalidateSubscribed 检查）
    const callsBefore = inv.onSkillCacheInvalidated.mock.calls.length
    useGlobalSkills()
    expect(inv.onSkillCacheInvalidated.mock.calls.length).toBe(callsBefore)
  })

  it('TC2-B1: Composer 重挂后失效信号仍刷新活跃实例（globalSkills 模块级共享 ref）', async () => {
    const getGlobalSkills = vi.fn().mockResolvedValue(SKILL_1)
    const inv = makeInvalidateMock()
    await provideSeam({ getGlobalSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated })

    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    // 第一次挂载（模拟首个 Composer 实例）
    const first = useGlobalSkills()
    await vi.waitFor(() => expect(first.globalSkills.value).toEqual(SKILL_1))
    expect(getGlobalSkills).toHaveBeenCalledTimes(1)

    // 重挂：再次调用 useGlobalSkills（模拟 Composer unmount→remount，拿到新返回值）
    const second = useGlobalSkills()

    // B1 回归断言：两次返回的 globalSkills 是同一个模块级 ref（共享，非各自独立）
    expect(second.globalSkills).toBe(first.globalSkills)

    // runtime 重扫后缓存更新，派发 global 失效信号 → 活跃实例（second）应刷新
    getGlobalSkills.mockResolvedValue(SKILL_1_2)
    inv.emitGlobal()
    await vi.waitFor(() => expect(second.globalSkills.value).toEqual(SKILL_1_2))
    expect(first.globalSkills.value).toEqual(SKILL_1_2) // 同一 ref，first 也同步
    expect(getGlobalSkills).toHaveBeenCalledTimes(2)
  })

  it('TC3: useProjectSkills 订阅 project scope 失效信号清缓存重新拉取（版本号机制）', async () => {
    const getProjectSkills = vi.fn().mockResolvedValue(SKILL_A)
    const inv = makeInvalidateMock()
    await provideSeam({ getProjectSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated })

    const { useProjectSkills } = await import('@/composables/features/settings/useProjectSkills')
    const cwd = ref<string | null>('/proj1')
    const { projectSkills } = useProjectSkills(cwd)

    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILL_A))
    expect(getProjectSkills).toHaveBeenCalledTimes(1)

    // mock 改返回 [skillA, skillB]，模拟项目目录变更后重扫
    getProjectSkills.mockResolvedValue(SKILL_A_B)
    // 派发 project scope 失效信号 → 版本号++ → watch 清 skillsByCwd → 重新拉取当前 cwd
    inv.emitProject('/proj1')
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILL_A_B))
    expect(getProjectSkills).toHaveBeenCalledTimes(2)
  })

  it('TC4: 多实例 useProjectSkills 共享一份模块级订阅', async () => {
    const getProjectSkills = vi.fn().mockResolvedValue(SKILL_A)
    const inv = makeInvalidateMock()
    await provideSeam({ getProjectSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated })

    const { useProjectSkills } = await import('@/composables/features/settings/useProjectSkills')
    // 两次实例化（模拟多个 Composer 实例）
    useProjectSkills(ref('/a'))
    useProjectSkills(ref('/b'))

    // 关键断言：project 模块级订阅只挂一次（projectInvalidateSubscribed 检查，[C3] 首次实例化时挂载）。
    // 注意：onSkillCacheInvalidated 总调用次数 = 1（仅 project 顶层订阅）；useGlobalSkills 未调用，无 global 订阅。
    expect(inv.onSkillCacheInvalidated).toHaveBeenCalledTimes(1)

    // 派发 project 信号 → 两实例各自 watch 版本号触发清自己的 skillsByCwd（版本号共享，触发次数=实例数）
    getProjectSkills.mockResolvedValue(SKILL_A_B)
    inv.emitProject()
    // 等待 watch 生效（两实例各重新拉取一次自己的当前 cwd）
    await vi.waitFor(() => expect(getProjectSkills.mock.calls.filter((c) => c[0] === '/a').length).toBeGreaterThanOrEqual(1))
    await vi.waitFor(() => expect(getProjectSkills.mock.calls.filter((c) => c[0] === '/b').length).toBeGreaterThanOrEqual(1))
  })
})
