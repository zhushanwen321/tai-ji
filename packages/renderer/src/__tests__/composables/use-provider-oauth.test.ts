/**
 * useProviderOAuth（Provider 页 OAuth 编排 module）interface 级测试（[C4·尾项] 双层
 * composable 合并后单 interface 打点，原 use-provider-page-oauth.test.ts 迁移 + 四态补全）。
 *
 * 覆盖：
 * - 四态状态机：device（pending + deviceCode 信息）/ authUrl（pending + 回调 URL）/
 *   success（关 Dialog + authorized 回写）/ error（错误信息 + retry 重启）+ 非活跃 provider 事件过滤
 * - 时序：订阅先行（onMounted 先于 login 注册 4 个 auth.* handler，事件不丢）+
 *   login 非 started / transport reject 收尾（不卡 pending，项目规则 #3）
 * - 来源路由（MF-1）：**只有 edit 来源** auth.success 后发 setProvider({authMethod:'oauth'})
 *  （防线⑤：不随行 name/type/baseUrl 快照 artifact）；quicksetup 来源不发（保存时才落）
 * - presence（MF-3）：refreshOAuthPresence has ? add : delete；clearOAuthPresence 清双集合
 *  （删除 provider 后防假已授权态）；展开刷新只对 oauth 相关 provider
 * - 派生：oauthDialogProvider / oauthDialogInfo（模板优先、编辑体兜底）/ quickSetupOauthAuthorized
 * - onEditOauthLogout（B-1 场景 C）三分支 + checkEnv 三分支
 *
 * mock 策略：vi.mock('@/api') 捕获 auth.* 订阅回调（module 内 onMounted 注册——经 harness
 * 组件在 setup 中调用获得组件上下文）；vue-i18n 由 vitest-i18n-setup 全局 mock（t() 从 zh-CN 取值）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-provider-oauth.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref, type Ref } from 'vue'
import type { BuiltinProviderTemplate, ProviderInfo } from '@taiji/shared'

// auth.* 订阅回调捕获（onMounted 注册后由测试手动派发事件；实现须返回 disposer 供 onScopeDispose）。
// vi.fn 显式参数类型 → mock.calls[0][0] 拿到类型化 handler，派发零断言收窄。
interface DeviceCodeEvent { providerId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn?: number }
interface AuthUrlEvent { providerId: string; url: string; callbackPort?: number }
interface AuthSuccessEvent { providerId: string }
interface AuthErrorEvent { providerId: string; message: string }

const authCbs = vi.hoisted(() => ({
  onAuthDeviceCode: vi.fn<(h: (p: DeviceCodeEvent) => void) => () => void>(() => () => {}),
  onAuthAuthUrl: vi.fn<(h: (p: AuthUrlEvent) => void) => () => void>(() => () => {}),
  onAuthSuccess: vi.fn<(h: (p: AuthSuccessEvent) => void) => () => void>(() => () => {}),
  onAuthError: vi.fn<(h: (p: AuthErrorEvent) => void) => () => void>(() => () => {}),
}))

const configMock = vi.hoisted(() => ({
  // OAuth flow 启动（login）：默认成功
  oauthLogin: vi.fn(async () => ({ started: true })),
  oauthCancel: vi.fn(async () => ({ cancelled: false })),
  oauthLogout: vi.fn(async () => ({ ok: true })),
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
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  useToast().toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  api = null
  harnessRefs = null
  document.body.innerHTML = ''
  useToast().toasts.value = []
})

describe('四态状态机（device / authUrl / success / error）', () => {
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
  })

  it('展开 oauth 相关 provider → 自动刷新 presence；非 oauth 相关不查询；newId 不查询', async () => {
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
    harnessRefs.expandedId.value = 'my-custom'
    await flushPromises()
    expect(configMock.hasOAuth).not.toHaveBeenCalled()

    harnessRefs.expandedId.value = '__new__'
    await flushPromises()
    expect(configMock.hasOAuth).not.toHaveBeenCalled()
  })
})

describe('onEditOauthLogout（B-1 场景 C 退出登录）', () => {
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
