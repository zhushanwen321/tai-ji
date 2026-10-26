/**
 * 合并产物（round5-f S12）：use-provider-oauth（本文件原体）+ registry-flags。
 * 两节均零 vi.mock、默认环境；registry-flags 节 import 全为 @/ 别名，无路径改写。
 *
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
 *  （删除 provider 后防假已授权态）；展开刷新对每个 provider 都查（MF-1-2 三态：未查询 ≠ 无凭据）
 * - 派生：oauthDialogProvider / oauthDialogInfo（模板优先、编辑体兜底）/ quickSetupOauthAuthorized
 * - onEditOauthLogout（B-1 场景 C）三分支 + checkEnv 三分支
 *
 * mock 策略：SettingsTransport seam 桩（[C3] 测试打 seam）捕获 auth.* 订阅回调（onMounted 注册——经 harness
 * 组件在 setup 中调用获得组件上下文）；vue-i18n 由 vitest-i18n-setup 全局 mock（t() 从 zh-CN 取值）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-provider-oauth.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref, nextTick, onBeforeUnmount, type Ref } from 'vue'
import type { BuiltinProviderTemplate, ProviderInfo } from '@taiji/shared'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import {
  authEventCbs,
  type DeviceCodeEvent,
  type AuthUrlEvent,
  type AuthSuccessEvent,
  type AuthErrorEvent,
} from '../helpers/oauth-auth-events-mock'

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
