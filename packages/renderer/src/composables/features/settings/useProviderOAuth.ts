/**
 * Provider OAuth 授权状态机（wave-quick-setup-c T3）+ QuickSetup env 检测桥接。
 *
 * 驱动 OAuthDialog（ui 包四态组件）+ config api 层：
 * - login(providerId)：打开 Dialog（pending）→ config.oauthLogin 启动 flow
 * - auth.* 事件订阅：deviceCode → Dialog device 态；authUrl → Dialog callback 态；
 *   success → 关 Dialog + authorized 回写 + 回调 onAuthorized；error → Dialog error 态
 * - cancel：config.oauthCancel + 关 Dialog
 * - checkEnv(tpl)：template 变化时调 checkEnvVars 供 QuickSetup 检测态
 *
 * 订阅先行（对齐 runtime broadcast 时序教训）：login 前 onMounted 建订阅，事件不丢。
 * token 永不出现在状态（auth.* payload 无 token，脱敏红线由 runtime 保证）。
 */
import { onMounted, onScopeDispose, ref } from 'vue'
import { config } from '@/api'

// OAuthDialog 的 .vue 导出类型在 plain tsc 下不可用（ui 包 shim 不导出命名类型），本地定义结构兼容
interface ProviderOAuthDeviceInfo {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn?: number
}

interface ProviderOAuthAuthUrlInfo {
  url: string
  callbackPort?: number
}

type ProviderOAuthStatus = 'idle' | 'pending' | 'success' | 'error'

interface ProviderOAuthState {
  open: boolean
  status: ProviderOAuthStatus
  deviceInfo: ProviderOAuthDeviceInfo | null
  authUrl: ProviderOAuthAuthUrlInfo | null
  errorMessage: string
}

export function useProviderOAuth(onAuthorized: (providerId: string) => void) {
  /** env 检测结果（template 变化时调 checkEnvVars） */
  const envCheck = ref<Record<string, boolean> | undefined>(undefined)
  const state = ref<ProviderOAuthState>({
    open: false,
    status: 'idle',
    deviceInfo: null,
    authUrl: null,
    errorMessage: '',
  })

  /** 已授权 provider 集合（auth.success 后回写，QuickSetup 显示「已授权」态） */
  const authorized = ref<Set<string>>(new Set())

  /**
   * auth.json 已有 OAuth 凭据的 provider 集合（QuickSetup 打开前查 config.hasOAuth 回填）。
   * 覆盖「未保存即关闭的 OAuth 授权」（auth.json 有 token、models.json 无条目）与
   * 「旧数据无 authMethod 标注」两类场景——供默认 oauth radio + 已授权态。
   * MF-3：has ? add : delete——必须与 auth.json 真实状态同步（只增不减会在删除
   * provider 后残留，重开 QuickSetup 误默认 oauth + 假「已授权」态）。
   */
  const oauthPresent = ref<Set<string>>(new Set())

  let activeProviderId = ''
  const disposers: Array<() => void> = []

  onMounted(() => {
    // 订阅先行：Dialog 打开前事件已挂（broadcast 先于订阅会丢消息）
    disposers.push(
      config.onAuthDeviceCode((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = {
          open: true,
          status: 'pending',
          deviceInfo: {
            userCode: payload.userCode,
            verificationUri: payload.verificationUri,
            verificationUriComplete: payload.verificationUriComplete,
            expiresIn: payload.expiresIn,
          },
          authUrl: null,
          errorMessage: '',
        }
      }),
      config.onAuthAuthUrl((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = {
          open: true,
          status: 'pending',
          deviceInfo: null,
          authUrl: { url: payload.url, callbackPort: payload.callbackPort },
          errorMessage: '',
        }
      }),
      config.onAuthSuccess((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = { ...state.value, open: false, status: 'success' }
        authorized.value = new Set(authorized.value).add(payload.providerId)
        onAuthorized(payload.providerId)
      }),
      config.onAuthError((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = { ...state.value, status: 'error', errorMessage: payload.message }
      }),
    )
  })

  onScopeDispose(() => {
    for (const dispose of disposers) dispose()
  })

  /** 启动 OAuth flow（QuickSetup 的 oauth-login 事件触发） */
  async function login(providerId: string): Promise<void> {
    activeProviderId = providerId
    state.value = { open: true, status: 'pending', deviceInfo: null, authUrl: null, errorMessage: '' }
    try {
      const result = await config.oauthLogin(providerId)
      if (!result.started) {
        state.value = { ...state.value, status: 'error', errorMessage: result.error ?? 'OAuth 启动失败' }
      }
    } catch (e) {
      // transport reject（断连/超时）：重置 pending → error，避免 Dialog 永久卡死（项目规则 #3）
      state.value = { ...state.value, status: 'error', errorMessage: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 用户取消 → 关 Dialog + 通知 runtime 停 flow（幂等） */
  async function cancel(): Promise<void> {
    state.value = { ...state.value, open: false }
    if (activeProviderId) {
      try {
        await config.oauthCancel(activeProviderId)
      } catch (e) {
        // cancel 失败不阻塞关闭 Dialog（幂等，重试由用户再次触发），仅告警
        console.warn('[provider-oauth] oauthCancel failed:', e)
      }
    }
  }

  /** 重试（error 态）→ 重新启动 flow */
  async function retry(): Promise<void> {
    if (activeProviderId) await login(activeProviderId)
  }

  /** env 检测（QuickSetup 打开时调用；失败不显示检测态不阻断配置） */
  async function checkEnv(tpl: { envVars: string[] }): Promise<void> {
    if (tpl.envVars.length === 0) {
      envCheck.value = undefined
      return
    }
    try {
      envCheck.value = await config.checkEnvVars(tpl.envVars)
    } catch {
      envCheck.value = undefined
    }
  }

  /** 刷新单 provider 的 OAuth presence（打开 QuickSetup 前调用；has ? add : delete） */
  async function refreshOAuthPresence(providerId: string): Promise<void> {
    let present = false
    try {
      present = await config.hasOAuth(providerId)
    } catch {
      // 查询失败不阻断：调用方回退 stored authMethod / 默认 env（existingAuthMethod 逻辑）
      console.warn(`[provider-oauth] config.hasOAuth query failed for ${providerId}`)
    }
    oauthPresent.value = new Set(oauthPresent.value)
    if (present) oauthPresent.value.add(providerId)
    else oauthPresent.value.delete(providerId)
  }

  /** 删除 provider 后清理 presence + authorized（MF-3：避免重开 QuickSetup 假已授权态） */
  function clearOAuthPresence(providerId: string): void {
    oauthPresent.value = new Set(oauthPresent.value)
    oauthPresent.value.delete(providerId)
    authorized.value = new Set(authorized.value)
    authorized.value.delete(providerId)
  }

  return { state, authorized, oauthPresent, envCheck, login, cancel, retry, checkEnv, refreshOAuthPresence, clearOAuthPresence }
}
