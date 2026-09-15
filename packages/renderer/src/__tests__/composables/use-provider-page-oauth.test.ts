/**
 * useProviderPageOauth composable 单测（PR #187 B-1：ProviderPage OAuth 编排提取）。
 *
 * 覆盖：
 * - onQuickSetupOauthLogin(template)：quicksetup 来源 → oauth.login(template.id)
 *  启动共享状态机（Dialog 打开 pending 态，config.oauthLogin 调用参数正确）
 * - auth.success（edit 来源）成功路径：立即 setProvider 只传 authMethod='oauth'
 *  （防线⑤：不随行 name/type/baseUrl 快照 artifact）+ toast.info 授权成功 + presence 刷新（hasOAuth）
 * - auth.success（edit 来源）setProvider 失败路径：toast.error 展示错误信息
 *  （恢复动作=重试保存），presence 仍刷新（凭据已写 auth.json）
 * - oauthDialogProvider：编辑体登录目标派生（含 builtin 模板 oauthName）
 * - onEditOauthLogout（B-1 场景 C）：config.oauthLogout 移除凭证 → 成功 toast +
 *  presence 刷新；ok:false → 透传 reply.error（勿自造）；transport reject → 错误上屏
 *
 * mock 策略：vi.mock('@/api') 捕获 auth.* 订阅回调（composable 内 useProviderOAuth
 * onMounted 注册——经 harness 组件在 setup 中调用获得组件上下文）；vue-i18n 由
 * vitest-i18n-setup 全局 mock（t() 从 zh-CN 取值）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-provider-page-oauth.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import type { BuiltinProviderTemplate, ProviderInfo } from '@taiji/shared'

// auth.* 订阅回调捕获（onMounted 注册后由测试手动派发 auth.success）。
// 实现须返回 disposer（useProviderOAuth onScopeDispose 逐个调用）
const authCbs = vi.hoisted(() => ({
  onAuthSuccess: vi.fn(() => () => {}),
}))

const configMock = vi.hoisted(() => ({
  // OAuth flow 启动（login）：默认成功
  oauthLogin: vi.fn(async () => ({ started: true })),
  oauthCancel: vi.fn(async () => ({ cancelled: false })),
  oauthLogout: vi.fn(async () => ({ ok: true })),
  hasOAuth: vi.fn(async () => false),
  setProvider: vi.fn(async () => {}),
  checkEnvVars: vi.fn(async () => ({})),
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => ({ providers: [] })),
  deleteProvider: vi.fn(async () => {}),
  listBuiltinProviders: vi.fn(async () => []),
  onDefaultsWithSource: vi.fn(() => () => {}),
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  onAuthSuccess: authCbs.onAuthSuccess,
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import { useProviderPageOauth } from '@/composables/features/settings/useProviderPageOauth'
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

type OauthApi = ReturnType<typeof useProviderPageOauth>

let wrapper: ReturnType<typeof mount> | null = null
/** harness setup 内写入的 composable 实例（onMounted 需组件上下文） */
let api: OauthApi | null = null

/** 挂 harness：setup 中调用 useProviderPageOauth（获得 onMounted/onScopeDispose 上下文） */
function mountOauth(): OauthApi {
  api = null
  const Harness = defineComponent({
    setup() {
      api = useProviderPageOauth({
        builtinProviders: ref([KIMI_TEMPLATE]),
        providers: ref([KIMI_PROVIDER]),
        expandedId: ref<string | null>(null),
        newId: '__new__',
      })
      return () => h('div')
    },
  })
  wrapper = mount(Harness, { attachTo: document.body })
  if (!api) throw new Error('composable 实例未捕获（harness setup 未执行）')
  return api
}

/** 取 useProviderOAuth 注册的 auth.success 回调并派发（模拟 runtime 授权完成） */
async function emitAuthSuccess(providerId: string): Promise<void> {
  const registered = authCbs.onAuthSuccess.mock.calls[0]
  if (!registered) throw new Error('auth.success 订阅未注册（onMounted 未执行）')
  const handler = registered[0] as (payload: { providerId: string }) => void
  handler({ providerId })
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
  document.body.innerHTML = ''
  useToast().toasts.value = []
})

describe('useProviderPageOauth onQuickSetupOauthLogin（quicksetup 来源）', () => {
  it('QuickSetup 登录 → 共享状态机启动（oauthLogin 调 template.id + Dialog 打开 pending 态）', async () => {
    const page = mountOauth()

    page.onQuickSetupOauthLogin(KIMI_TEMPLATE)
    await flushPromises()

    expect(configMock.oauthLogin).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogin).toHaveBeenCalledWith('kimi-coding')
    // Dialog 状态机：open + pending（OAuthDialog 据此渲染 oauth-pending 态）
    expect(page.oauth.state.value.open).toBe(true)
    expect(page.oauth.state.value.status).toBe('pending')
    // quicksetup 来源：auth.success 后不走 setProvider 收尾（保存时才落 authMethod）
    expect(configMock.setProvider).not.toHaveBeenCalled()
  })
})

describe('useProviderPageOauth onEditOauthLogin → auth.success（edit 来源收尾）', () => {
  it('成功路径：setProvider 只传 authMethod=oauth（不随行 name/type/baseUrl）+ toast.info + presence 刷新', async () => {
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
    // presence 刷新（凭证区「已登录」态数据源；hasOAuth=false → delete 分支）
    expect(configMock.hasOAuth).toHaveBeenCalledWith('kimi-coding')
    // 登录目标已清空（oauthDialogProvider 回 null，Dialog 信息不再指向旧目标）
    expect(page.oauthDialogProvider.value).toBeNull()
  })

  it('失败路径：setProvider 拒绝 → toast.error 展示错误信息 + presence 仍刷新（凭据已写 auth.json）', async () => {
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

describe('useProviderPageOauth oauthDialogProvider（Dialog 信息派生）', () => {
  it('编辑体登录目标 → 派生 { id, name, oauthName }（oauthName 从 builtin 模板取）', async () => {
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
})

describe('useProviderPageOauth onEditOauthLogout（B-1 场景 C 退出登录）', () => {
  it('成功路径：config.oauthLogout(id) + toast.info 已退出 + presence 刷新（凭证区回未登录态）', async () => {
    // 预置已登录 presence（退出后应被刷新移除）
    configMock.hasOAuth.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const page = mountOauth()
    await page.oauth.refreshOAuthPresence('kimi-coding')
    expect(page.oauth.oauthPresent.value.has('kimi-coding')).toBe(true)
    configMock.hasOAuth.mockClear()

    await page.onEditOauthLogout(KIMI_PROVIDER)
    await flushPromises()

    expect(configMock.oauthLogout).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogout).toHaveBeenCalledWith('kimi-coding')
    // 用户可见反馈：退出成功 toast（zh-CN locale：已退出登录（{name}））
    expect(toastMessages().some((m) => m.includes('已退出登录') && m.includes('Kimi Coding'))).toBe(true)
    // presence 刷新（hasOAuth 重查 → false → 移除，凭证区回「未登录」态）
    expect(configMock.hasOAuth).toHaveBeenCalledWith('kimi-coding')
    expect(page.oauth.oauthPresent.value.has('kimi-coding')).toBe(false)
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
