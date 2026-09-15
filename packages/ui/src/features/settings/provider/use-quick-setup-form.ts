/**
 * ProviderQuickSetup 表单逻辑（wave-quick-setup-c，script setup 行数上限拆分）。
 *
 * 认证方式状态机 + 保存构造（I6 authMethod）+ env 检测态派生 + footer hint。
 * 纯逻辑层（无模板）：组件 script 只留 props/emits/渲染数据。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { BuiltinProviderTemplate, SetProviderData } from '@taiji/shared'

export type AuthMethod = 'plaintext' | 'env' | 'oauth' | 'ambient'

/** 「自定义变量名」Select sentinel value（F4 · §6.4：下拉含常见 env var + 自定义入口） */
export const CUSTOM_ENV_VALUE = '__custom__'

/** 已存配置的认证方式（ProviderInfo.authMethod；QuickSetup 重开时恢复上次方式） */
export type ExistingAuthMethod = 'api_key' | 'oauth' | 'env_var' | 'ambient'

export interface UseQuickSetupForm {
  authMethod: Ref<AuthMethod>
  apiKeyInput: Ref<string>
  envVar: Ref<string>
  customEnvVar: Ref<string>
  showKey: Ref<boolean>
  envSupported: ComputedRef<boolean>
  resolvedEnvVar: ComputedRef<string>
  authOptions: ComputedRef<Array<{ id: AuthMethod; titleKey: string; rec?: boolean; available: boolean }>>
  saveDisabled: ComputedRef<boolean>
  footerHintKey: ComputedRef<string>
  envDetected: ComputedRef<boolean | undefined>
  onSave: () => void
}

/**
 * 已存认证方式恢复规则表（顺序敏感：find 取首个 existing 匹配 + 模板适用项，与原 if 链
 * 逐条对应——oauth → env_var → api_key → ambient）。
 */
const EXISTING_AUTH_RESUME_RULES: ReadonlyArray<{
  existing: ExistingAuthMethod
  method: AuthMethod
  /** 该已存方式在当前模板下可恢复的条件（原 if 链各分支谓词，逐条迁移） */
  applicable: (mode: BuiltinProviderTemplate['authMode'], tpl: BuiltinProviderTemplate) => boolean
}> = [
  { existing: 'oauth', method: 'oauth', applicable: (mode) => mode === 'oauth' || mode === 'both' },
  {
    existing: 'env_var',
    method: 'env',
    applicable: (mode, tpl) => (mode === 'api_key' || mode === 'both') && tpl.envVars.length > 0,
  },
  { existing: 'api_key', method: 'plaintext', applicable: (mode) => mode === 'api_key' || mode === 'both' },
  { existing: 'ambient', method: 'ambient', applicable: (mode) => mode === 'ambient' },
]

/** 已存方式恢复：existing 在当前模板下适用的认证方式，不适用时 undefined */
function resolveExistingAuthMethod(
  existing: ExistingAuthMethod,
  mode: BuiltinProviderTemplate['authMode'],
  tpl: BuiltinProviderTemplate,
): AuthMethod | undefined {
  const rule = EXISTING_AUTH_RESUME_RULES.find((r) => r.existing === existing && r.applicable(mode, tpl))
  return rule?.method
}

/** 无已存方式（或已存方式不适用）时的默认回退：推荐 env（有 env var 可选时），否则按 mode 兜底 */
function resolveDefaultAuthMethod(
  mode: BuiltinProviderTemplate['authMode'],
  tpl: BuiltinProviderTemplate,
): AuthMethod {
  if ((mode === 'api_key' || mode === 'both') && tpl.envVars.length > 0) return 'env'
  if (mode === 'oauth') return 'oauth'
  if (mode === 'ambient') return 'ambient'
  return 'plaintext'
}

/**
 * 初始化表单状态。t 是 i18n 翻译函数（key 拼接在组件层做，这里只产 key）。
 * @param template template ref（props.template）
 * @param envCheck env 检测结果（props.envCheck）
 * @param oauthAuthorized OAuth 已授权（props.oauthAuthorized）
 * @param emitSave emit('save') 包装
 */
export function useQuickSetupForm(
  template: Ref<BuiltinProviderTemplate>,
  envCheck: Ref<Record<string, boolean> | undefined>,
  oauthAuthorized: Ref<boolean | undefined>,
  emitSave: (payload: { providerId: string; data: SetProviderData }) => void,
  existingAuthMethod?: Ref<ExistingAuthMethod | undefined>,
): UseQuickSetupForm {
  /** 当前认证方式 */
  const authMethod = ref<AuthMethod>('plaintext')
  /** 明文 API Key 输入 */
  const apiKeyInput = ref('')
  /** 选中的环境变量名（默认预填 template.envVars[0]，或 CUSTOM_ENV_VALUE 走自定义输入） */
  const envVar = ref('')
  /** 自定义环境变量名输入 */
  const customEnvVar = ref('')
  /** 是否明文显示 API Key */
  const showKey = ref(false)

  /** template 是否支持环境变量方式（envVars 非空） */
  const envSupported = computed(() => template.value.envVars.length > 0)

  /** 当前生效的 env var 名（自定义 sentinel 时取输入框值） */
  const resolvedEnvVar = computed(() =>
    envVar.value === CUSTOM_ENV_VALUE ? customEnvVar.value.trim() : envVar.value,
  )

  /** 认证 radio 选项（按 authMode 条件渲染，demo auth-options） */
  const authOptions = computed<Array<{ id: AuthMethod; titleKey: string; rec?: boolean; available: boolean }>>(() => {
    const mode = template.value.authMode
    const options: Array<{ id: AuthMethod; titleKey: string; rec?: boolean; available: boolean }> = []
    if (mode === 'api_key' || mode === 'both') {
      options.push({ id: 'plaintext', titleKey: 'authOptionPlaintext', available: true })
      options.push({ id: 'env', titleKey: 'authOptionEnv', rec: true, available: envSupported.value })
    }
    if (mode === 'oauth' || mode === 'both') {
      options.push({ id: 'oauth', titleKey: 'authOptionOauth', available: true })
    }
    if (mode === 'ambient') {
      options.push({ id: 'ambient', titleKey: 'authOptionAmbient', available: true })
    }
    return options
  })

  /** template 切换时重置表单：已存配置标注过 authMethod 则恢复上次方式（MF-1：both provider 已 OAuth 授权后重开，不默认 env 盲保存清凭据），否则默认 env（推荐）或 plaintext */
  watch(template, (tpl) => {
    envVar.value = tpl.envVars[0] ?? ''
    customEnvVar.value = ''
    apiKeyInput.value = ''
    showKey.value = false
    authMethod.value = resolveInitialAuthMethod(tpl)
  }, { immediate: true })

  /**
   * 初始认证方式（编排）：existingAuthMethod 优先（恢复上次选择，表驱动查
   * EXISTING_AUTH_RESUME_RULES），不适用时回退默认（resolveDefaultAuthMethod）。
   */
  function resolveInitialAuthMethod(tpl: BuiltinProviderTemplate): AuthMethod {
    const existing = existingAuthMethod?.value
    return (
      (existing && resolveExistingAuthMethod(existing, tpl.authMode, tpl)) ??
      resolveDefaultAuthMethod(tpl.authMode, tpl)
    )
  }

  /** 保存禁用：明文模式空 key 禁用；env 模式空变量名禁用（MF-1：空自定义变量不产生无意义 env_var 配置）；OAuth 模式未授权时禁用 */
  const saveDisabled = computed(() => {
    if (authMethod.value === 'plaintext' && !apiKeyInput.value.trim()) return true
    if (authMethod.value === 'env' && !resolvedEnvVar.value) return true
    if (authMethod.value === 'oauth' && !oauthAuthorized.value) return true
    return false
  })

  /** footer hint key（spec §4.1 规格文案列，有意偏离 demo 的明文/env 态） */
  const footerHintKey = computed(() => {
    return {
      plaintext: 'footerHintPlaintext',
      env: 'footerHintEnv',
      oauth: 'footerHintOauth',
      ambient: 'footerHintAmbient',
    }[authMethod.value]
  })

  /** env 检测态：当前 env var 是否已设置。envCheck 未拉取时不显示（undefined）；
   *  自定义变量名不在 envCheck 结果里 → 视为未设置（S-C：demo 显示 ⚠「未设置」，不隐藏检测态） */
  const envDetected = computed<boolean | undefined>(() => {
    if (!envCheck.value) return undefined
    const name = resolvedEnvVar.value
    return name ? (envCheck.value[name] ?? false) : undefined
  })

  /** 保存：构造 SetProviderData（I6 填 authMethod；oauth 不塞 apiKey——凭据在 auth.json）。
   *  防线⑥（设计 D1）：只写凭据相关字段——模板 baseUrl 是快照 artifact（pi 内置定义已自带
   *  baseUrl/api），回传会在「非空放行」语义下写入 override、再被启动清洗剥除，形成写-剥循环；
   *  原 `api` 键与 SetProviderData.type 字段名不匹配，是从未生效的死键，一并去掉。 */
  function onSave(): void {
    const data: SetProviderData = {
      name: template.value.name,
    }
    if (authMethod.value === 'plaintext') {
      data.apiKey = apiKeyInput.value
      data.authMethod = 'api_key'
    } else if (authMethod.value === 'env') {
      // MF-1：空自定义变量不上送 apiKey——apiKey 空串是「清除 models.json apiKey 键」的
      // 哨兵信号（runtime 侧有清除语义），QuickSetup 路径不应发送。空变量名已被 saveDisabled
      // 挡住，此处再守卫一层（防未来调用方绕过 disabled 直调 onSave）。
      if (resolvedEnvVar.value) {
        data.apiKey = `$${resolvedEnvVar.value}`
      }
      data.authMethod = 'env_var'
    } else if (authMethod.value === 'oauth') {
      data.authMethod = 'oauth'
    } else if (authMethod.value === 'ambient') {
      data.authMethod = 'ambient'
    }
    emitSave({ providerId: template.value.id, data })
  }

  return {
    authMethod, apiKeyInput, envVar, customEnvVar, showKey,
    envSupported, resolvedEnvVar, authOptions, saveDisabled, footerHintKey, envDetected,
    onSave,
  }
}
