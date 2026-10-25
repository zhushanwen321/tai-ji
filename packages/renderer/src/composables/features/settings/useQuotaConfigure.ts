/**
 * useQuotaConfigure —— ProviderEditBody「Coding Plan 额度查询」deep module 实现。
 *
 * 契约 v2（coding-plan-quota-config-ux §7.1/§7.2）+ C1 收拢：
 * - 对外只暴露 QuotaConfigureModule（core 契约）：3 个状态透镜（draft / view / test）+ 3 个写动作；
 *   27 成员旧契约里的全部规则性成员（类型切换清凭证草稿、齐备性、失败原因归一、
 *   provider 凭据警示分档、来源提示分档等）都内化为本实现的派生量
 * - 类型 / 凭证 / Workspace 进草稿，经 saveAndTest 一次点击提交（D2/D5）；开关只写配置位（D4）
 * - readiness 是「保存并测试」按钮禁用状态的唯一依据；密文字段取「草稿 ∨ 已保存」并集，
 *   明文的 Workspace 只看草稿（D13）
 * - 密文输入掩码哨兵（D7）：已保存的 cookie / 专属 Key 在输入框显示 QUOTA_SECRET_MASK，
 *   保存侧识别哨兵不发送（保留既存）；哨兵展示单源来自 syncFromProvider 的磁盘态重建
 */
import { ref, computed, watch } from 'vue'
import type {
  NormalizedQuotaRow,
  QuotaConfigurePayload,
  QuotaCredentialSource,
  QuotaParamSpec,
  QuotaPreset,
  QuotaAuthKind,
  QuotaFetchFailureReason,
} from '@taiji/shared'
import { normalizeCookieHeader, normalizeQuotaParamValue, resolveQuotaCredentialSource, resolveQuotaPresets, supportsExclusiveCredential } from '@taiji/shared'
// W3c：presets 数据源从编译期基线切到 runtime 下发的合并视图（remote-config 域 2）
import { getSettingsStore } from '@taiji/core'
import type {
  QuotaConfigureInputs,
  QuotaConfigureModule,
  QuotaDraftInput,
  QuotaFailureKind,
  QuotaParamView,
  QuotaReadiness,
  QuotaSectionView,
  QuotaSourceHint,
  QuotaTestStatus,
  QuotaTestView,
  ReadinessMissing,
} from '@taiji/core'
import { API_KEY_CLEAR_SENTINEL, QUOTA_SECRET_MASK, getSettingsTransport } from '@taiji/core'
import { optimisticUpdate, refCell } from '@taiji/core/foundation/optimistic-update'
import { useQuotaStore } from '@/stores/quota'
import { quotaFailReasonText } from '@/composables/features/model/useQuotaQuery'

/**
 * 用户维度参数草稿的保存前归一化（模块级辅助，2026-10 泛化，原 normalizeWorkspaceDraft）。
 * - 空 → required 报错（不发 RPC）。D13：空不再解释为「清除」，UI 侧由 readiness 置灰
 *   拦住这条路，这里只是对称的防御（直接调用 saveAndTest 时也不会产出空串）
 * - 非空 → shared 归一化校验（按 spec.normalize 分流：完整 URL / 裸 id → 规范值；raw 透传）
 * - 非法输入 → invalid 报错（不发 RPC）；errorKey 由调用方经 i18n 渲染
 */
function normalizeParamDraft(
  spec: QuotaParamSpec,
  raw: string,
): { ok: true; payload: string } | { ok: false; errorKey: string } {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, errorKey: 'settings.providerEdit.quotaParamRequired' }
  }
  const normalized = normalizeQuotaParamValue(spec.normalize ?? 'raw', trimmed)
  if (!normalized.ok) {
    return { ok: false, errorKey: 'settings.providerEdit.quotaParamInvalid' }
  }
  return { ok: true, payload: normalized.value }
}

/**
 * 当前 presets 合并视图（空态回落编译期基线）。
 *
 * store 初值是 `[]`（非 undefined）且 RPC 拉取失败只 warn 不写基线——裸读 `.value` 会让
 * 类型下拉在合并视图未下发期间恒空且本挂载期不恢复（C-proc-21：用户可见的辅助能力失败
 * 必须有可见反馈，禁静默空值）。回落判据与 ProviderEditBody 的 matchedPreset 同源。
 */
function currentPresets(): readonly QuotaPreset[] {
  return resolveQuotaPresets(getSettingsStore().quotaPresets.value)
}

/** 当前草稿 fetcher 对应的预设；未选择草稿时 fallback 到自动匹配的 preset。 */
function findPreset(fetcherId: string | undefined, fallback: QuotaPreset | undefined): QuotaPreset | undefined {
  if (fetcherId) return currentPresets().find((p) => p.fetcher === fetcherId)
  return fallback
}

// ── readiness 齐备性判定（§7.2）：按凭证来源分档的纯函数，主流程只做「采集信号 → 汇总缺失」──

/**
 * 密文字段（cookie / 专属 Key）的齐备判据：「草稿 ∨ 已保存」并集。
 * 密文不回显（D7），只看草稿会让每次打开编辑体都是灰的；类型已变时旧归属失效，只认草稿
 * （与 saveAndTest 的「类型一变旧 Cookie 无条件清除」同源）。
 */
function hasDraftOrSaved(draft: string, saved: boolean | undefined, typeChanged: boolean): boolean {
  return draft.trim() !== '' || (!typeChanged && !!saved)
}

/** 单条齐备性判定项：satisfied=false 时 field 记入 missing 清单。 */
interface ReadinessCheck {
  field: ReadinessMissing
  satisfied: boolean
}

/** readiness 判定信号（ref 读取集中在主流程，判定本身是与响应式无关的纯函数）。 */
interface ReadinessSignals {
  /** 当前 fetcher 为 cookie 类（auth 含 cookie）：凭证形态是 cookie 而非 apiKey */
  cookieAuth: boolean
  credentialSource: QuotaCredentialSource
  /** 当前 fetcher 是否声明 api-key 形态（专属 Key 适用性收窄，§7 残留 11） */
  exclusiveSupported: boolean
  /** provider 侧是否有可用凭据（ProviderInfo.apiKeySet） */
  providerCredentialAvailable: boolean
  /** 当前 fetcher 声明的用户维度参数 spec（2026-10 泛化，原 needsWorkspace 单布尔） */
  paramSpecs: readonly QuotaParamSpec[]
  /** 归属判据：savedFetcher !== undefined && draft.fetcher !== savedFetcher */
  typeChanged: boolean
  cookieDraft: string
  apiKeyDraft: string
  cookieSaved: boolean | undefined
  apiKeySaved: boolean | undefined
  paramsDraft: Record<string, string>
}

/**
 * 凭证档判定（§7.2 分档）：cookie 类 → cookie；专属 Key → 专属 Key；其余 → provider 侧凭据。
 * 专属 Key 只对声明了 api-key 形态的 fetcher 适用：判据与 runtime resolveCredential 的收窄、
 * UI 分段控件的渲染同源。不适用（如纯 oauth / 纯 cookie）时落到 provider 凭据判定 —— 与 runtime
 * 「忽略 exclusive、按 auth 数组序解析」完全一致。
 */
function credentialCheck(s: ReadinessSignals): ReadinessCheck {
  if (s.cookieAuth) {
    return { field: 'cookie', satisfied: hasDraftOrSaved(s.cookieDraft, s.cookieSaved, s.typeChanged) }
  }
  if (s.credentialSource === 'exclusive' && s.exclusiveSupported) {
    return { field: 'apiKey', satisfied: hasDraftOrSaved(s.apiKeyDraft, s.apiKeySaved, s.typeChanged) }
  }
  return { field: 'apiKey', satisfied: s.providerCredentialAvailable }
}

/** 判定项清单：凭证档在前、param 在后（missing 顺序 = 本清单顺序）。 */
function readinessChecks(s: ReadinessSignals): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [credentialCheck(s)]
  // param 是明文且始终回显 → 判定只看草稿（D13：屏幕即真相）；逐必填项一条判定
  for (const spec of s.paramSpecs) {
    if (spec.required === false) continue
    checks.push({ field: 'param', satisfied: (s.paramsDraft[spec.key] ?? '').trim() !== '' })
  }
  return checks
}

/** 汇总缺失项（保持判定项构造序）。 */
function toMissingFields(checks: ReadinessCheck[]): ReadinessMissing[] {
  const missing: ReadinessMissing[] = []
  for (const check of checks) {
    if (!check.satisfied) missing.push(check.field)
  }
  return missing
}

// ── 失败原因归一（A2-4）──

/**
 * reason → 失败分档。credential-unavailable / credential-unsupported（IO 层 / 形态不支持）
 * 无专属恢复指引，落 'generic'（UI 回退通用文案，与收拢前的表现一致）。
 * Record 全键登记：新增 reason 时编译器强制在此表态。
 */
const FAILURE_KINDS: Record<QuotaFetchFailureReason, QuotaFailureKind> = {
  unauthorized: 'unauthorized',
  network: 'network',
  'no-subscription': 'no-subscription',
  parse: 'parse',
  not_configured: 'not-configured',
  'no-credential': 'no-credential',
  // 2026-10-18：cookie 归一化为空（粘贴内容无 name=value 对）与「服务端拒绝」分流——
  // 前者恢复动作是「换复制路径重贴」而非「重新登录」，不得复用 unauthorized 文案。
  'cookie-invalid-format': 'cookie-invalid-format',
  'credential-unavailable': 'generic',
  'credential-unsupported': 'generic',
}

/**
 * QuotaConfigure module 实现（契约见 core QuotaConfigureModule）。
 *
 * @param inputs - 工厂输入（业务输入由 ProviderEditBody 按当前编辑体装配；t 由壳层包装
 *   函数注入，见 core QuotaConfigureInputs / useSettingsShell provide 点）
 */
export function useQuotaConfigure(inputs: QuotaConfigureInputs): QuotaConfigureModule {
  const { t, provider: providerRef, preset, providerOauthPresent, providerApiKeyDraft } = inputs
  const quotaStore = useQuotaStore()
  const enabled = ref(false)
  /** 类型草稿底层态：外部经 selectType（同值短路 + 真变清凭证草稿）写入 */
  const fetcherIdDraft = ref<string | undefined>(undefined)
  /**
   * 输入草稿（D7 掩码哨兵：已保存的密文以 QUOTA_SECRET_MASK 展示；真实输入随时覆盖哨兵）。
   * D13 已知代价（设计 §6.14）：UI 不支持清除已保存 param（清空草稿 → readiness 置灰
   * 保存不出去）；换地址直接覆盖、停用关开关。显式清除按钮是登记的重审触发条件，勿在
   * readiness 里单独开「空串 = 清除」后门。
   */
  const draft = ref<QuotaDraftInput>({
    cookie: '',
    apiKey: '',
    credentialSource: 'provider',
    params: {},
  })
  const testStatus = ref<QuotaTestStatus>('idle')
  const testError = ref('')
  const quotaData = ref<NormalizedQuotaRow | null>(null)
  const lastFetchAt = ref<number | null>(null)
  const configuring = ref(false)
  const configureError = ref('')

  /** 最近一次查询失败原因（A2-4 reason 透传；null = 无失败）。旧缓存保留在 quotaData（「查看上次成功数据」） */
  const testFailReason = ref<QuotaFetchFailureReason | null>(null)

  /**
   * 下拉框选项：presets 合并视图映射为 { value, label }。
   * computed 而非 setup 期一次性快照：quotaPresets 由 config.listQuotaPresets RPC 异步填充，
   * 回包晚于本 composable 装配——一次性求值会让下拉恒空且本挂载期不恢复（与 isCookieAuth /
   * activePreset 的 computed 读取路径保持同源新鲜度）。读取经 currentPresets 空态回落基线，
   * RPC 未回包 / 拉取失败期间下拉同样非空。
   */
  const fetcherOptions = computed(() =>
    currentPresets().map((p) => ({ value: p.fetcher, label: p.label })),
  )

  /**
   * 类型草稿写入（§7.1：类型进草稿，由 saveAndTest 一次提交，不再即时落盘）。
   *
   * [D5 检查必须落在值上] CodingPlanSection 用 reka Select 的 `:model-value` + update 事件，
   * 而 reka 的 `SelectItem.handleSelect` 无条件 emit —— 用户重复点选当前类型也会触发写入。
   * 没有同值短路就会丢掉用户未提交的输入（丢的是正在输入的内容，不是磁盘数据）。
   * 类型**真变**才清凭证草稿；Workspace 草稿不清（明文回显字段，清了等于制造屏幕与磁盘背离）。
   */
  function applyFetcherId(newId: string | undefined): void {
    if (newId === fetcherIdDraft.value) return
    fetcherIdDraft.value = newId
    draft.value.cookie = ''
    draft.value.apiKey = ''
  }

  /**
   * selectType（契约写动作）：reka Select 的 update:modelValue 是宽联合类型，做运行时 guard
   * 只放字符串通过。不做 String($event) 强转——undefined 会被转成 "undefined" 这个看似合法的类型值。
   */
  function selectType(value: unknown): void {
    if (typeof value !== 'string') return
    applyFetcherId(value)
  }

  /**
   * isCookieAuth：基于当前选中的 fetcherId 计算（而非 preset.auth）。
   * 用户手动选了 cookie 类 fetcher（mimo/opencode-go）时显示 cookie 输入区。
   * fetcherId 未选择时 fallback 到 preset.auth。
   * [A2-1] auth 数组化后单值判断改 includes：preset 声明含 cookie 形态即视为 cookie 类
   * （内置 5 preset 中仅 mimo/opencode-go 声明，行为与单值时代一致）。
   */
  const isCookieAuth = computed(() => {
    const fid = fetcherIdDraft.value
    if (fid) {
      const opt = currentPresets().find((p) => p.fetcher === fid)
      return opt?.auth.includes('cookie') ?? false
    }
    return preset.value?.auth.includes('cookie') ?? false
  })

  /** 当前选中 fetcher 对应的预设（用于 helpUrl/helpText/params）。 */
  const activePreset = computed<QuotaPreset | undefined>(() => findPreset(fetcherIdDraft.value, preset.value))

  /** 当前 fetcher 声明的用户维度参数 spec（2026-10 泛化，原 needsWorkspace 单布尔） */
  const paramSpecs = computed<readonly QuotaParamSpec[]>(() => activePreset.value?.params ?? [])

  /**
   * 当前选中 fetcher 的凭证能力声明（B-3）：fetcherId 优先、fallback 自动匹配 preset。
   * 凭证态按 fetcher.auth 派生（oauth 就绪/缺失、api-key 回退顺序说明）。
   */
  const authKinds = computed<readonly QuotaAuthKind[]>(() => activePreset.value?.auth ?? [])

  // ── D3 凭证态派生（证据来源见设计 §7.4 / §11 检查点 1）──

  /**
   * Provider 侧是否有可用凭据。「用 Provider 凭据」分段项可点性的唯一依据。
   * 证据 = ProviderInfo.apiKeySet（provider-config-helper 的「auth.json 凭证 id 集合 ∨
   * models.json override.apiKey」聚合）；runtime 才是权威，前端误判由 no-credential 兜底。
   */
  const providerCredentialAvailable = computed<boolean>(() => !!providerRef.value?.apiKeySet)

  /**
   * Provider 侧凭据「已填但未保存」（§7.4 文案区分）判定。证据来源是 provider 表单草稿
   * （carry-in 槽位：form.apiKey 由 ProviderEditBody 经 inputs.providerApiKeyDraft 传入）。
   * 判定式必须排除清除哨兵：用户点「清除」时草稿 === API_KEY_CLEAR_SENTINEL（非空但语义是
   * 无凭据），只用 `!== ''` 会显示与事实相反的「已填写，保存后即可查询」。
   * 不参与 readiness 判定（§7.2 该分支只看 providerCredentialAvailable）。
   */
  const providerCredentialPendingSave = computed<boolean>(
    () => providerApiKeyDraft.value !== '' && providerApiKeyDraft.value !== API_KEY_CLEAR_SENTINEL,
  )

  /**
   * 齐备性派生量（D1）——「保存并测试」按钮禁用状态的唯一依据（§7.2 伪码逐条落地）。
   *
   * 归属判据：`savedFetcher !== undefined && draft.fetcher !== savedFetcher`。「从未按某个
   * 类型保存过」不算类型已变 —— 把 undefined 也算变更会给这类 provider 制造一次用户从未
   * 请求的 cookie 清除。
   */
  const readiness = computed<QuotaReadiness>(() => {
    const fid = fetcherIdDraft.value
    // 草稿类型不在 QUOTA_PRESETS（仅历史数据 / 手工编辑 providers.json 可达，下拉只列预设）：
    // 未知 fetcher 无法判定该类型的凭证形态（是否 cookie 类、是否声明用户维度参数），
    // isCookieAuth / paramSpecs 会双双落空后静默走 api-key 分支 ——
    // providerCredentialAvailable 为 true 时就放行一条带未知 fetcher 的 configure。按「类型
    // 缺失」处理（与 D8「类型未选」同形态），让用户重选一个有效类型，而不是让未知值借
    // api-key 分支混过门控。
    if (!fid || !activePreset.value) return { ready: false, missing: ['type'] }

    const quota = providerRef.value?.quota
    const missing = toMissingFields(readinessChecks({
      cookieAuth: isCookieAuth.value,
      credentialSource: draft.value.credentialSource,
      exclusiveSupported: supportsExclusiveCredential(authKinds.value),
      providerCredentialAvailable: providerCredentialAvailable.value,
      paramSpecs: paramSpecs.value,
      typeChanged: quota?.fetcher !== undefined && fid !== quota.fetcher,
      cookieDraft: draft.value.cookie,
      apiKeyDraft: draft.value.apiKey,
      cookieSaved: quota?.cookieSet,
      apiKeySaved: quota?.apiKeySet,
      paramsDraft: draft.value.params,
    }))

    return { ready: missing.length === 0, missing }
  })

  /** 展示派生逻辑（只读）：UI 分层 / 凭证区形态 / 警示分档 / 帮助链接一次派生到位 */
  const view = computed<QuotaSectionView>(() => {
    const undetermined = !fetcherIdDraft.value || readiness.value.missing.includes('type')
    const exclusiveApplicable = supportsExclusiveCredential(authKinds.value)
    const source = draft.value.credentialSource
    // 专属 Key 输入块是否渲染（§7.4：false 时 provider 警示才有登场资格）
    const exclusiveKeyBlockShown = exclusiveApplicable && source === 'exclusive'
    let sourceHint: QuotaSourceHint = 'providerApiKey'
    if (source === 'exclusive') sourceHint = 'exclusive'
    else if (authKinds.value.includes('oauth') && providerOauthPresent.value) sourceHint = 'providerOauth'
    const helpUrl = activePreset.value?.helpUrl
    // §7.4 跨区块时序：provider 凭据不可用且未改用专属 Key → 警示，两套文案按
    // 「已填未保存」分档（providerCredentialPendingSave 判定式见彼处）
    let providerWarning: 'pendingSave' | 'missing' | null = null
    if (!exclusiveKeyBlockShown && !providerCredentialAvailable.value) {
      providerWarning = providerCredentialPendingSave.value ? 'pendingSave' : 'missing'
    }
    return {
      type: {
        selected: fetcherIdDraft.value,
        options: fetcherOptions.value,
        undetermined,
      },
      enabled: enabled.value,
      configuring: configuring.value,
      configureError: configureError.value,
      readiness: readiness.value,
      credential: {
        form: isCookieAuth.value ? 'cookie' : 'apiKey',
        exclusiveApplicable,
        providerAvailable: providerCredentialAvailable.value,
        sourceHint,
        providerWarning,
      },
      params: paramSpecs.value.map((spec): QuotaParamView => ({
        key: spec.key,
        label: spec.label ?? spec.key,
        ...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
        ...(spec.helpText !== undefined ? { helpText: spec.helpText } : {}),
        required: spec.required !== false,
      })),
      help: helpUrl ? { url: helpUrl, text: activePreset.value?.helpText ?? '' } : null,
    }
  })

  /** 测试结果侧（只读）：成功行 / 失败归一 / 旧缓存保留 */
  const test = computed<QuotaTestView>(() => ({
    status: testStatus.value,
    row: quotaData.value,
    lastFetchAt: lastFetchAt.value,
    failure: testStatus.value === 'error'
      ? {
        kind: testFailReason.value ? FAILURE_KINDS[testFailReason.value] : 'generic',
        cookieAuth: isCookieAuth.value,
        message: testError.value,
      }
      : null,
  }))

  // ── 初始化：从 provider.quota 读取已保存的配置 ──
  function syncFromProvider(): void {
    const p = providerRef.value
    if (!p?.quota) {
      enabled.value = false
      // fetcherId 默认值：provider.quota.fetcher > 自动匹配的 preset.fetcher > undefined
      applyFetcherId(preset.value?.fetcher)
      // 无 quota 条目 = 读侧兜底 'provider'（与 runtime resolveQuotaCredentialSource 同源）
      draft.value = { cookie: '', apiKey: '', credentialSource: resolveQuotaCredentialSource(undefined), params: {} }
      testStatus.value = 'idle'
      testError.value = ''
      testFailReason.value = null
      quotaData.value = null
      lastFetchAt.value = null
      return
    }
    enabled.value = p.quota.enabled
    // fetcherId 初始值：手动指定的 quota.fetcher 优先，未设置时 fallback 到自动匹配值
    applyFetcherId(p.quota.fetcher ?? preset.value?.fetcher)
    // D7 掩码哨兵：runtime 不回传密文，已保存的 cookie / 专属 Key 以 QUOTA_SECRET_MASK 展示
    // 「已保存密文在此」；param 非凭证（用户浏览器地址栏可见的 URL 等），明文回显供编辑
    // D3 读侧：未显式设置时按既存标记推断（历史数据兼容）；两端调用同一函数避免推断背离
    // params 读兼容：extras params 优先，旧版 workspace 单字段映射为 workspaceUrl（runtime 同映射）
    const savedParams: Record<string, string> = { ...(p.quota.params ?? {}) }
    if (p.quota.workspace && savedParams.workspaceUrl === undefined) savedParams.workspaceUrl = p.quota.workspace
    draft.value = {
      cookie: p.quota.cookieSet ? QUOTA_SECRET_MASK : '',
      apiKey: p.quota.apiKeySet ? QUOTA_SECRET_MASK : '',
      credentialSource: resolveQuotaCredentialSource(p.quota),
      params: savedParams,
    }
    // 如果已启用，尝试读缓存
    if (p.quota.enabled) {
      loadCached()
    }
  }

  /** 读缓存（quota.getCached，不发 HTTP 请求） */
  async function loadCached(): Promise<void> {
    const p = providerRef.value
    if (!p) return
    try {
      const result = await getSettingsTransport().getCachedQuota(p.id)
      // 失败态（D6 no-credential 等）data 为 null 但带 reason：只看 data 会把失败态丢成
      // idle，重开编辑体看不到失败原因（§7.3 影响面表「设置页 loadCached」修正）。
      if (result.data || result.reason) {
        quotaData.value = result.data
        lastFetchAt.value = result.lastFetchAt
        if (testStatus.value === 'idle') {
          // 上次查询失败（缓存层透传 reason）：整体呈失败态，旧数据经「查看上次成功数据」
          // 展开可见（design §3.4 失败态与旧缓存并存的展示语义）
          testStatus.value = result.reason ? 'error' : 'success'
          testFailReason.value = result.reason ?? null
        }
      }
    } catch (e) {
      // getCached 失败静默（缓存可能不存在）
      console.debug('[quota] getCached failed:', e instanceof Error ? e.message : e)
    }
  }

  // provider 变化时同步状态
  watch(() => providerRef.value, syncFromProvider, { immediate: true })
  // preset 变化时：若用户未手动指定 fetcherId，跟随自动匹配值更新默认。
  // 不再 reset 全部状态——用户可能已手动选了 fetcher 或填了 cookie。
  watch(preset, (newPreset) => {
    const p = providerRef.value
    const manualFetcher = p?.quota?.fetcher
    if (manualFetcher) {
      // 已手动指定，保留
      applyFetcherId(manualFetcher)
    } else {
      applyFetcherId(newPreset?.fetcher)
    }
  })

  /**
   * 切换启用状态（D4）：纯配置位，唯一语义是「要不要在对话框容量浮层里展示」。
   * 只构造 `{ providerId, enabled }`，其余键一律缺省（= 不变）——否则草稿里的类型 / 来源
   * 选择会经由一次拨开关被偷偷落盘。乐观更新走 optimistic-update 协议值单元形态（快照/回滚
   * 归协议持有，禁止手写并存）：Switch 是受控组件，先翻转再等 RPC 以免视觉回弹；envelope
   * ok:false 转 throw 复用同一回滚语义，外层 catch 把错误映射到 configureError。
   */
  async function setEnabled(v: boolean): Promise<void> {
    const p = providerRef.value
    if (!p) return

    configuring.value = true
    configureError.value = ''
    try {
      await optimisticUpdate(refCell(enabled), v, async (applied) => {
        const result = await getSettingsTransport().configureQuota({ providerId: p.id, enabled: applied })
        if (!result.ok) {
          throw new Error(result.error || t('settings.providerEdit.quotaConfigureFail'))
        }
      })
      // 关闭额度查询：清 renderer quotaStore 镜像（runtime 侧 lastFailure 由 configure 清理）；
      // 开启不做任何查询（D4 边界：拨开关零网络副作用）
      if (!v) quotaStore.clearCache(p.id)
    } catch (e) {
      configureError.value = e instanceof Error ? e.message : t('settings.providerEdit.quotaConfigureFail')
    } finally {
      configuring.value = false
    }
  }

  /**
   * 保存 payload 构造段（§7.2 细节 4 的构造表；从 saveAndTest 拆出，语义注释在彼处）。
   * cookie 粘贴格式 / param 归一化两类本地校验失败 = { ok:false, errorKey }，
   * 调用方落错误终止（不发 RPC）。
   */
  function buildConfigurePayload(p: { id: string }, typeChanged: boolean): { ok: true; payload: QuotaConfigurePayload } | { ok: false; errorKey: string } {
    const source = draft.value.credentialSource
    const cookieDraft = draft.value.cookie.trim()
    const apiKeyDraft = draft.value.apiKey.trim()
    // 掩码哨兵 = 「已保存密文」的展示态（D7），不是用户输入：照常发送会把圆点串写成真实凭证。
    // 哨兵与空串同归「未填新值」；类型切换时哨兵已被 selectType 清空，不落入此分支
    const cookieMasked = cookieDraft === QUOTA_SECRET_MASK
    const apiKeyMasked = apiKeyDraft === QUOTA_SECRET_MASK

    // cookie 粘贴格式前置校验（2026-10-18，用户手动复制路径）：归一化后为空（不含任何
    // name=value 对，典型 = 从 DevTools Application → Cookies 表格复制的制表符文本）
    // 当场拦下并给精确指引——不发 RPC，不落入 runtime 侧「凭证可能已失效」的误报。
    // 归一化实现 SSOT 在 shared（与 runtime fetcher 同一函数，两端判据不得各写一份）。
    // 掩码哨兵无 k=v 形态但不是用户输入，跳过校验
    if (isCookieAuth.value && cookieDraft && !cookieMasked && normalizeCookieHeader(cookieDraft) === '') {
      return { ok: false, errorKey: 'settings.providerEdit.quotaCookieFormatInvalid' }
    }

    // 用户维度参数（2026-10 泛化，原 workspace）：明文回显字段，逐必填项取归一化后的
    // 草稿值传入（D13：永不传 ''——空/非法本地拦截）。归一化分流按当前草稿 fetcher 的
    // param spec（与 runtime 侧同源：同 input 同 spec 同规则）
    const paramsPayload: Record<string, string> = {}
    for (const spec of paramSpecs.value) {
      const raw = draft.value.params[spec.key]
      if (raw === undefined || raw.trim() === '') {
        // 必填项空值只在 readiness 被放行的不可能路径到达（直接调用 saveAndTest 的对称防御）
        if (spec.required !== false) return { ok: false, errorKey: 'settings.providerEdit.quotaParamRequired' }
        continue
      }
      const normalized = normalizeParamDraft(spec, raw)
      if (!normalized.ok) return { ok: false, errorKey: normalized.errorKey }
      paramsPayload[spec.key] = normalized.payload
    }

    return {
      ok: true,
      payload: {
        providerId: p.id,
        // 恒传当前值：保存并测试不改启用状态（开关是独立动作，D4）
        enabled: enabled.value,
        fetcher: fetcherIdDraft.value,
        // 恒传当前选择（幂等）：显式化磁盘字段，消除「未设置」这一中间态
        credentialSource: source,
        // 类型一变旧 Cookie 的归属就不成立 → 无条件清除（''）；类型没变则缺省 = 保留既存
        //（哨兵同归「未填新值」：undefined 保留既存）
        cookie: cookieMasked ? undefined : (cookieDraft || (typeChanged ? '' : undefined)),
        // 专属 Key 永不传 ''：失效由 credentialSource 表达，删文件不可逆（D3）
        apiKey: source === 'exclusive' && apiKeyDraft && !apiKeyMasked ? apiKeyDraft : undefined,
        // 用户维度参数：仅传有值的键（D13 无清除语义——空键缺省 = 不动，与旧 workspace 一致）
        params: Object.keys(paramsPayload).length > 0 ? paramsPayload : undefined,
      },
    }
  }

  /**
   * 保存并测试（D2）：先把草稿落盘（quota.configure），成功后再触发查询（quota.refresh）。
   * 参数构造严格按 §7.2 细节 4 的构造表；credentialSource 恒由 payload 显式值落盘，**写侧禁用**
   * resolveQuotaCredentialSource 推断——该函数是**显式值优先**（`quota?.credentialSource ?? …`），
   * `incoming ?? resolve(...)` 只在 incoming 为 undefined 时触发，不会覆盖显式值。真实危害是把
   * **未设置的字段物化成推断值**：会在磁盘写入用户从未选择过的来源，此后该 provider 不再跟随推断
   * （专属 Key 被清后读侧本应回落 provider，冻结的显式值会把查询带向 no-credential）。
   * 危害与禁令的完整表述见 quota-types.ts 的 resolveQuotaCredentialSource JSDoc（SSOT）。
   *
   * [时序约定] 必须在发起 RPC 前捕获 payload 快照：configure 成功后 runtime 广播
   * provider 列表 → watch(providerRef) → syncFromProvider 把草稿重置为磁盘态；
   * await 之后再读草稿读到的是被重置后的值（会丢用户输入）。
   */
  async function saveAndTest(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    const savedFetcher = p.quota?.fetcher
    const draftFetcher = fetcherIdDraft.value
    // 归属判据同 readiness（§7.2 细节 1）：无既存归属不算类型已变
    const typeChanged = savedFetcher !== undefined && draftFetcher !== savedFetcher

    configureError.value = ''
    const built = buildConfigurePayload(p, typeChanged)
    if (!built.ok) {
      configureError.value = t(built.errorKey)
      return
    }

    configuring.value = true
    try {
      const result = await getSettingsTransport().configureQuota(built.payload)
      // 半提交窗口对齐（runtime 改动 4：清理锚定 persist 成功而非 configure 整体成功）：
      // persist 成功 + secrets 段失败 → runtime 返回 ok:false 但 QuotaCache 已清、fetcher
      // 已换新 —— renderer 镜像失效不能只挂在 ok:true 上，typeChanged 时无条件同步失效
      // （persist 失败多清一次 = 浮层一次后台重新拉取，与半提交自愈同级，无害）。
      if (typeChanged) quotaStore.clearCache(p.id)
      if (!result.ok) {
        configureError.value = result.error || t('settings.providerEdit.quotaSaveAndTestFail')
        return
      }
      // 保存成功：密文草稿不动（用户输入保留在框内，不再「保存即消失」）；掩码哨兵展示态
      // 由 provider 广播 → syncFromProvider 按磁盘态统一重建（展示态单源，见 syncFromProvider）
      await testQuery()
    } catch (e) {
      configureError.value = e instanceof Error ? e.message : t('settings.providerEdit.quotaSaveAndTestFail')
    } finally {
      configuring.value = false
    }
  }

  /**
   * 测试查询（触发 quota.refresh，绕过 throttle）。
   * 结果同步写回全局 quota store（quotaStore 是套餐浮层 / 容量卡的单源镜像）——
   * 浮层常驻不重新挂载，若结果只留在本 composable 本地 ref，用户在设置页「保存并测试」
   * 成功后浮层仍显示旧的失败态/旧数据（实际缺陷）。成功 setCache 清 error；失败 setError
   * 保留旧 data（与 useQuotaQuery 失败路径同口径）。
   */
  async function testQuery(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    testStatus.value = 'loading'
    testError.value = ''
    testFailReason.value = null

    try {
      // 用 refresh 绕过 10s throttle，确保测试查询每次都发真实请求（设计 §2.2.5）
      const result = await getSettingsTransport().refreshQuota(p.id)
      if (result.data) {
        quotaData.value = result.data
        lastFetchAt.value = result.lastFetchAt
        quotaStore.setCache(p.id, result.data, result.lastFetchAt)
        testStatus.value = 'success'
      } else {
        // 失败态（A2-4）：reason 归一给 UI（恢复指引文案按分档渲染）；旧缓存保留在
        // quotaData 不展示（「查看上次成功数据」展开可见）；lastFetchAt = 最近一次成功时间
        testStatus.value = 'error'
        testFailReason.value = result.reason ?? null
        lastFetchAt.value = result.lastFetchAt
        testError.value = t('settings.providerEdit.quotaTestFail')
        if (result.reason) quotaStore.setError(p.id, quotaFailReasonText(result.reason))
      }
    } catch (e) {
      testStatus.value = 'error'
      testError.value = e instanceof Error ? e.message : t('settings.providerEdit.quotaTestFail')
      quotaStore.setError(p.id, e instanceof Error ? e.message : String(e))
    }
  }

  return {
    draft,
    view,
    test,
    selectType,
    setEnabled,
    saveAndTest,
  }
}
