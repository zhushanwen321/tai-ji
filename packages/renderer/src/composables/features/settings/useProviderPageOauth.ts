/**
 * useProviderPageOauth —— ProviderPage 的 OAuth 编排（Phase B B-1，自 ProviderPage.vue 提取，
 * vue_rules_checker script ≤300 行约束）。
 *
 * 职责：
 * - 持有唯一 useProviderOAuth 实例（QuickSetup 与编辑体凭证区共用 → auth.* listener 单份注册，
 *   AGENTS 事件规则 2「组件可能多实例」由 ProviderPage 单例天然消除，无需 refCount）
 * - 登录来源路由：quicksetup（auth.success 保持 QuickSetup 打开，保存时落 authMethod）/
 *   edit（auth.success 立即 setProvider 持久化 authMethod='oauth' → broadcast 回推编辑体）
 * - OAuthDialog 的 provider 信息派生（QuickSetup 模板优先，编辑体目标兜底）
 * - QuickSetup 的 OAuth 授权态派生（authorized 与 oauthPresence 任一命中）
 * - 编辑体展开时刷新 OAuth presence（has ? add : delete，MF-3 语义）
 * - 编辑体「退出登录」→ config.oauthLogout 移除凭证 + presence 刷新（B-1 场景 C）
 *
 * 依赖注入：builtinProviders（模板表，判 oauthSupported / oauthName）/ providers（props ref）/
 * selectedTemplate（QuickSetup 当前模板，授权态派生用）/ expandedId + newId（手风琴守卫，
 * presence 刷新触发时机）。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BuiltinProviderTemplate, ProviderInfo, ProviderId } from '@taiji/shared'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import { useProviderOAuth } from './useProviderOAuth'
/** OAuth flow 发起方（决定 auth.success 后的收尾路径） */
type OAuthLoginSource = 'quicksetup' | 'edit'

export function useProviderPageOauth(options: {
  builtinProviders: Ref<BuiltinProviderTemplate[]>
  providers: Ref<ProviderInfo[]>
  /** QuickSetup 当前选中模板（null = 未选中，授权态为 false） */
  selectedTemplate: Ref<BuiltinProviderTemplate | null>
  /** 手风琴展开 id（presence 刷新触发时机）。useAccordionGuard 的 expandedId 为宽松 string */
  expandedId: Ref<string | null>
  /** 新建态 sentinel id（不参与 presence 刷新） */
  newId: string
}) {
  const { t } = useI18n()
  const toast = useToast()
  const { builtinProviders, providers, selectedTemplate, expandedId, newId } = options

  const oauth = useProviderOAuth((providerId) => { void onOAuthAuthorized(providerId) })

  /** QuickSetup 的 OAuth 授权态（无模板 = 未授权；authorized 与 oauthPresent 任一命中即可）。 */
  const quickSetupOauthAuthorized = computed(() => {
    const id = selectedTemplate.value?.id
    return id !== undefined && (oauth.authorized.value.has(id) || oauth.oauthPresent.value.has(id))
  })

  /** OAuthDialog 显示用 provider 信息：QuickSetup 模板优先，编辑体目标兜底。 */
  const oauthDialogInfo = computed(() => {
    const tpl = selectedTemplate.value
    if (tpl) return { id: tpl.id, name: tpl.name, oauthName: tpl.oauthName }
    return oauthDialogProvider.value
  })

  const oauthLoginSource = ref<OAuthLoginSource>('quicksetup')
  /** 编辑体凭证区发起登录的目标 provider（null = 无；驱动 OAuthDialog 的 provider 信息） */
  const editOauthTarget = ref<ProviderInfo | null>(null)

  /** 编辑体目标的 OAuthDialog 显示信息（oauthName 从 builtinProviders 模板取，custom
   *  provider 无模板时缺省）。 */
  const oauthDialogProvider = computed(() => {
    const target = editOauthTarget.value
    if (target) {
      const builtin = builtinProviders.value.find((b) => b.id === target.id)
      return { id: target.id, name: target.name, oauthName: builtin?.oauthName }
    }
    return null
  })

  /** provider 是否支持 OAuth 登录（builtinProviders 模板 oauthSupported 判定；custom 恒 false） */
  function isOauthSupported(providerId: ProviderId): boolean {
    return builtinProviders.value.some((b) => b.id === providerId && b.oauthSupported)
  }

  /** 该 provider 的 OAuth presence（auth.json 已有凭据；编辑体凭证区「已登录」态数据源） */
  function hasOauthPresence(providerId: ProviderId): boolean {
    return oauth.oauthPresent.value.has(providerId)
  }

  /** 编辑体凭证区「登录/重新登录」（B-1）→ 共享 oauth 状态机启动 flow */
  function onEditOauthLogin(p: ProviderInfo): void {
    oauthLoginSource.value = 'edit'
    editOauthTarget.value = p
    void oauth.login(p.id)
  }

  /** 编辑体凭证区「退出登录」（B-1 场景 C）→ config.oauthLogout 移除 auth.json 凭证。
   *  成功刷新 presence（凭证区回到「未登录」态 + 额度区 oauthReady 联动）；
   *  ok:false 时 error 由 runtime 透传展示（勿自造）。 */
  async function onEditOauthLogout(p: ProviderInfo): Promise<void> {
    try {
      const reply = await config.oauthLogout(p.id)
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
    await oauth.refreshOAuthPresence(p.id)
  }

  /** QuickSetup「登录」按钮 → quicksetup 来源（auth.success 保持打开，保存时落 authMethod） */
  function onQuickSetupOauthLogin(template: BuiltinProviderTemplate): void {
    oauthLoginSource.value = 'quicksetup'
    void oauth.login(template.id)
  }

  /** auth.success 收尾（编辑体来源）：持久化 authMethod='oauth' + 刷新 OAuth presence。
   *  只传 authMethod（防线⑤ 设计 D1）：name/type/baseUrl 是 ProviderInfo 的展示派生值/快照
   *  artifact，回传会把 artifact 冻进 models.json override；authMethod 落 providers.json extras，
   *  凭据由 pi OAuth flow 写 auth.json，runtime 侧「不物化空壳」防线保证该调用不产生 models.json
   *  条目。 */
  async function onOAuthAuthorized(providerId: string): Promise<void> {
    if (oauthLoginSource.value !== 'edit') return
    const target = editOauthTarget.value
    editOauthTarget.value = null
    if (!target) return
    try {
      await config.setProvider(target.id, { authMethod: 'oauth' })
      toast.info(t('settings.provider.builtinTemplate.oauthAuthorized', { name: target.name }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    await oauth.refreshOAuthPresence(providerId)
  }

  // B-1：展开 provider 时刷新 OAuth presence（凭证区「已登录」态与额度区 oauthReady 的数据源）。
  // 仅 oauth 相关 provider（authMethod=oauth 或模板 oauthSupported）拉取，其余不查询。
  watch(expandedId, (id) => {
    if (!id || id === newId) return
    const p = providers.value.find((x) => x.id === id)
    if (p && (p.authMethod === 'oauth' || isOauthSupported(p.id))) {
      void oauth.refreshOAuthPresence(id)
    }
  })

  return {
    oauth,
    oauthDialogProvider,
    oauthDialogInfo,
    isOauthSupported,
    hasOauthPresence,
    quickSetupOauthAuthorized,
    onEditOauthLogin,
    onEditOauthLogout,
    onQuickSetupOauthLogin,
  }
}
