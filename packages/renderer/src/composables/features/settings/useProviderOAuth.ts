/**
 * useProviderOAuth —— Provider 页 OAuth 编排 module（[C4·尾项] 状态机 + 来源路由归一）。
 *
 * [合并] 原 useProviderOAuth（四态状态机）+ useProviderPageOauth（登录来源路由 / 派生）合二为一：
 * 双层 composable 只是同一关注点的上下两半（状态机不知道来源、路由层持有状态机实例），合并后
 * 334 行 → 1 个 interface（ProviderOauthModule），auth.* listener 仍单份注册（ProviderPage
 * 持有唯一实例，QuickSetup 与编辑体凭证区共用 → 无双 listener）。
 *
 * 职责全集：
 * - 四态状态机（device / authUrl / success / error）驱动 OAuthDialog（ui 包四态组件）：
 *   login(providerId)：打开 Dialog（pending）→ config.oauthLogin 启动 flow
 *   auth.* 事件订阅：deviceCode → Dialog device 态；authUrl → Dialog callback 态；
 *   success → 关 Dialog + authorized 回写 + 按来源收尾；error → Dialog error 态
 *   cancel：config.oauthCancel + 关 Dialog；retry：error 态重启 flow
 * - 登录来源路由（MF-1）：quicksetup（auth.success 保持 QuickSetup 打开，保存时落 authMethod）/
 *   edit（auth.success 立即 setProvider 持久化 authMethod='oauth' → broadcast 回推编辑体）。
 *   **只有编辑体登录来源发 setProvider**，QuickSetup 来源不发。
 * - OAuthDialog 的 provider 信息派生（QuickSetup 模板优先，编辑体目标兜底）
 * - QuickSetup 的 OAuth 授权态派生（authorized 与 oauthPresence 任一命中）
 * - OAuth presence 管理（MF-3）：has ? add : delete——打开 QuickSetup 前先 refreshOAuthPresence
 *   （调用方时序），删除 provider 后 clearOAuthPresence（防重开 QuickSetup 假已授权态）
 * - 编辑体「退出登录」→ config.oauthLogout 移除凭证 + presence 刷新（B-1 场景 C）
 * - QuickSetup env 检测桥接（checkEnv → config.checkEnvVars）
 *
 * 订阅先行（对齐 runtime broadcast 时序教训）：login 前 onMounted 建订阅，事件不丢。
 * token 永不出现在状态（auth.* payload 无 token，脱敏红线由 runtime 保证）。
 */
import { computed, onMounted, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BuiltinProviderTemplate, ProviderInfo, ProviderId } from '@taiji/shared'
import { getSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'

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

/** OAuthDialog 四态状态机（device / authUrl 都落在 pending，携带各自 info） */
export interface ProviderOAuthState {
  open: boolean
  status: ProviderOAuthStatus
  deviceInfo: ProviderOAuthDeviceInfo | null
  authUrl: ProviderOAuthAuthUrlInfo | null
  errorMessage: string
}

/** OAuthDialog 显示用 provider 信息（oauthName 可缺省：custom provider 无模板） */
export interface ProviderOAuthDialogInfo {
  id: string
  name: string
  oauthName?: string
}

/** OAuth flow 发起方（决定 auth.success 后的收尾路径，MF-1） */
type OAuthLoginSource = 'quicksetup' | 'edit'

/**
 * Provider OAuth 编排 module —— 状态机 + 来源路由的全部消费面（1 个 interface）。
 */
export interface ProviderOauthModule {
  /** OAuthDialog 四态状态机 */
  readonly state: Ref<ProviderOAuthState>
  /** 已授权 provider 集合（auth.success 后回写，QuickSetup 显示「已授权」态） */
  readonly authorized: Ref<Set<string>>
  /**
   * auth.json 已有 OAuth 凭据的 provider 集合（QuickSetup 打开前查 config.hasOAuth 回填）。
   * 覆盖「未保存即关闭的 OAuth 授权」（auth.json 有 token、models.json 无条目）与
   * 「旧数据无 authMethod 标注」两类场景——供默认 oauth radio + 已授权态。
   */
  readonly oauthPresent: Ref<Set<string>>
  /** env 检测结果（template 变化时调 checkEnv；未拉取/失败 = undefined 不显示检测态） */
  readonly envCheck: Ref<Record<string, boolean> | undefined>
  /** 编辑体目标的 OAuthDialog 显示信息（oauthName 从 builtinProviders 模板取；null = 无目标） */
  readonly oauthDialogProvider: ComputedRef<ProviderOAuthDialogInfo | null>
  /** OAuthDialog 显示用 provider 信息：QuickSetup 模板优先，编辑体目标兜底 */
  readonly oauthDialogInfo: ComputedRef<ProviderOAuthDialogInfo | null>
  /** QuickSetup 的 OAuth 授权态（无模板 = 未授权；authorized 与 oauthPresent 任一命中即可） */
  readonly quickSetupOauthAuthorized: ComputedRef<boolean>
  /** provider 是否支持 OAuth 登录（builtinProviders 模板 oauthSupported 判定；custom 恒 false） */
  isOauthSupported(providerId: ProviderId): boolean
  /** 该 provider 的 OAuth presence（auth.json 已有凭据；编辑体凭证区「已登录」态数据源） */
  hasOauthPresence(providerId: ProviderId): boolean
  /** 编辑体凭证区「登录/重新登录」（B-1）→ 状态机启动 flow（auth.success 走 edit 收尾） */
  onEditOauthLogin(p: ProviderInfo): void
  /** 编辑体凭证区「退出登录」（B-1 场景 C）→ config.oauthLogout 移除凭证 + presence 刷新 */
  onEditOauthLogout(p: ProviderInfo): Promise<void>
  /** QuickSetup「登录」按钮 → quicksetup 来源（auth.success 保持打开，保存时落 authMethod） */
  onQuickSetupOauthLogin(template: BuiltinProviderTemplate): void
  /** 启动 OAuth flow（状态机入口；来源路由由 onEditOauthLogin / onQuickSetupOauthLogin 设置） */
  login(providerId: string): Promise<void>
  /** 用户取消 → 关 Dialog + 通知 runtime 停 flow（幂等） */
  cancel(): Promise<void>
  /** 重试（error 态）→ 重新启动 flow */
  retry(): Promise<void>
  /** env 检测（QuickSetup 打开时调用；失败不显示检测态不阻断配置） */
  checkEnv(tpl: { envVars: string[] }): Promise<void>
  /** 刷新单 provider 的 OAuth presence（打开 QuickSetup 前调用；has ? add : delete，MF-3） */
  refreshOAuthPresence(providerId: string): Promise<void>
  /** 删除 provider 后清理 presence + authorized（MF-3：避免重开 QuickSetup 假已授权态） */
  clearOAuthPresence(providerId: string): void
}

/** module 工厂输入（依赖注入：模板表 / providers 列表 / QuickSetup 选中态 / 手风琴守卫） */
export interface ProviderOauthInputs {
  builtinProviders: Ref<BuiltinProviderTemplate[]>
  providers: Ref<ProviderInfo[]>
  /** QuickSetup 当前选中模板（null = 未选中，授权态为 false） */
  selectedTemplate: Ref<BuiltinProviderTemplate | null>
  /** 手风琴展开 id（presence 刷新触发时机）。useAccordionGuard 的 expandedId 为宽松 string */
  expandedId: Ref<string | null>
  /** 新建态 sentinel id（不参与 presence 刷新） */
  newId: string
}

export function useProviderOAuth(options: ProviderOauthInputs): ProviderOauthModule {
  const { t } = useI18n()
  const toast = useToast()
  const { builtinProviders, providers, selectedTemplate, expandedId, newId } = options

  // ── 四态状态机 ──

  const state = ref<ProviderOAuthState>({
    open: false,
    status: 'idle',
    deviceInfo: null,
    authUrl: null,
    errorMessage: '',
  })
  const authorized = ref<Set<string>>(new Set())
  const oauthPresent = ref<Set<string>>(new Set())
  const envCheck = ref<Record<string, boolean> | undefined>(undefined)

  let activeProviderId = ''
  let oauthLoginSource: OAuthLoginSource = 'quicksetup'
  /** 编辑体凭证区发起登录的目标 provider（null = 无；驱动 OAuthDialog 的 provider 信息） */
  const editOauthTarget = ref<ProviderInfo | null>(null)
  const disposers: Array<() => void> = []

  // ── 来源路由收尾（MF-1）──

  /**
   * auth.success 收尾（编辑体来源）：持久化 authMethod='oauth' + 刷新 OAuth presence。
   * 只传 authMethod（防线⑤ 设计 D1）：name/type/baseUrl 是 ProviderInfo 的展示派生值/快照
   * artifact，回传会把 artifact 冻进 models.json override；authMethod 落 providers.json extras，
   * 凭据由 pi OAuth flow 写 auth.json，runtime 侧「不物化空壳」防线保证该调用不产生 models.json
   * 条目。quicksetup 来源直接返回（保存时才落 authMethod）。
   */
  async function onOAuthAuthorized(providerId: string): Promise<void> {
    if (oauthLoginSource !== 'edit') return
    const target = editOauthTarget.value
    editOauthTarget.value = null
    if (!target) return
    try {
      await getSettingsTransport().setProvider(target.id, { authMethod: 'oauth' })
      toast.info(t('settings.provider.builtinTemplate.oauthAuthorized', { name: target.name }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    await refreshOAuthPresence(providerId)
  }

  onMounted(() => {
    // 订阅先行：Dialog 打开前事件已挂（broadcast 先于订阅会丢消息）
    disposers.push(
      getSettingsTransport().onAuthDeviceCode((payload) => {
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
      getSettingsTransport().onAuthAuthUrl((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = {
          open: true,
          status: 'pending',
          deviceInfo: null,
          authUrl: { url: payload.url, callbackPort: payload.callbackPort },
          errorMessage: '',
        }
      }),
      getSettingsTransport().onAuthSuccess((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = { ...state.value, open: false, status: 'success' }
        authorized.value = new Set(authorized.value).add(payload.providerId)
        void onOAuthAuthorized(payload.providerId)
      }),
      getSettingsTransport().onAuthError((payload) => {
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
      const result = await getSettingsTransport().oauthLogin(providerId)
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
        await getSettingsTransport().oauthCancel(activeProviderId)
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

  // ── 派生 ──

  /** 编辑体目标的 OAuthDialog 显示信息（oauthName 从 builtinProviders 模板取，custom
   *  provider 无模板时缺省）。 */
  const oauthDialogProvider = computed<ProviderOAuthDialogInfo | null>(() => {
    const target = editOauthTarget.value
    if (target) {
      const builtin = builtinProviders.value.find((b) => b.id === target.id)
      return { id: target.id, name: target.name, oauthName: builtin?.oauthName }
    }
    return null
  })

  /** OAuthDialog 显示用 provider 信息：QuickSetup 模板优先，编辑体目标兜底。 */
  const oauthDialogInfo = computed<ProviderOAuthDialogInfo | null>(() => {
    const tpl = selectedTemplate.value
    if (tpl) return { id: tpl.id, name: tpl.name, oauthName: tpl.oauthName }
    return oauthDialogProvider.value
  })

  /** QuickSetup 的 OAuth 授权态（无模板 = 未授权；authorized 与 oauthPresent 任一命中即可）。 */
  const quickSetupOauthAuthorized = computed(() => {
    const id = selectedTemplate.value?.id
    return id !== undefined && (authorized.value.has(id) || oauthPresent.value.has(id))
  })

  function isOauthSupported(providerId: ProviderId): boolean {
    return builtinProviders.value.some((b) => b.id === providerId && b.oauthSupported)
  }

  function hasOauthPresence(providerId: ProviderId): boolean {
    return oauthPresent.value.has(providerId)
  }

  // ── 来源路由入口 ──

  /** 编辑体凭证区「登录/重新登录」（B-1）→ 状态机启动 flow（edit 来源） */
  function onEditOauthLogin(p: ProviderInfo): void {
    oauthLoginSource = 'edit'
    editOauthTarget.value = p
    void login(p.id)
  }

  /** QuickSetup「登录」按钮 → quicksetup 来源（auth.success 保持打开，保存时落 authMethod） */
  function onQuickSetupOauthLogin(template: BuiltinProviderTemplate): void {
    oauthLoginSource = 'quicksetup'
    void login(template.id)
  }

  /**
   * 编辑体凭证区「退出登录」（B-1 场景 C）→ config.oauthLogout 移除 auth.json 凭证。
   * 成功刷新 presence（凭证区回到「未登录」态 + 额度区 oauthReady 联动）；
   * ok:false 时 error 由 runtime 透传展示（勿自造）。
   */
  async function onEditOauthLogout(p: ProviderInfo): Promise<void> {
    try {
      const reply = await getSettingsTransport().oauthLogout(p.id)
      if (!reply.ok) {
        toast.error(reply.error ?? t('settings.providerEdit.credentialOauthLogoutFailed'))
        return
      }
      toast.info(t('settings.providerEdit.credentialOauthLoggedOut', { name: p.name }))
    } catch (e) {
      // transport reject（断连/超时）：错误上屏（错误必须可见，不静默吞）
      toast.error(e instanceof Error ? e.message : String(e))
      return
    }
    await refreshOAuthPresence(p.id)
  }

  // ── presence / env ──

  /** 刷新单 provider 的 OAuth presence（has ? add : delete，MF-3） */
  async function refreshOAuthPresence(providerId: string): Promise<void> {
    let present = false
    try {
      present = await getSettingsTransport().hasOAuth(providerId)
    } catch {
      // 查询失败不阻断：调用方回退 stored authMethod / 默认 env（existingAuthMethod 逻辑）
      console.warn(`[provider-oauth] config.hasOAuth query failed for ${providerId}`)
    }
    oauthPresent.value = new Set(oauthPresent.value)
    if (present) oauthPresent.value.add(providerId)
    else oauthPresent.value.delete(providerId)
  }

  function clearOAuthPresence(providerId: string): void {
    oauthPresent.value = new Set(oauthPresent.value)
    oauthPresent.value.delete(providerId)
    authorized.value = new Set(authorized.value)
    authorized.value.delete(providerId)
  }

  /** env 检测（QuickSetup 打开时调用；失败不显示检测态不阻断配置） */
  async function checkEnv(tpl: { envVars: string[] }): Promise<void> {
    if (tpl.envVars.length === 0) {
      envCheck.value = undefined
      return
    }
    try {
      envCheck.value = await getSettingsTransport().checkEnvVars(tpl.envVars)
    } catch {
      envCheck.value = undefined
    }
  }

  // B-1：展开 provider 时刷新 OAuth presence（凭证区「已登录」态与额度区 oauthReady 的数据源）。
  // 仅 oauth 相关 provider（authMethod=oauth 或模板 oauthSupported）拉取，其余不查询。
  watch(expandedId, (id) => {
    if (!id || id === newId) return
    const p = providers.value.find((x) => x.id === id)
    if (p && (p.authMethod === 'oauth' || isOauthSupported(p.id))) {
      void refreshOAuthPresence(id)
    }
  })

  return {
    state,
    authorized,
    oauthPresent,
    envCheck,
    oauthDialogProvider,
    oauthDialogInfo,
    quickSetupOauthAuthorized,
    isOauthSupported,
    hasOauthPresence,
    onEditOauthLogin,
    onEditOauthLogout,
    onQuickSetupOauthLogin,
    login,
    cancel,
    retry,
    checkEnv,
    refreshOAuthPresence,
    clearOAuthPresence,
  }
}
