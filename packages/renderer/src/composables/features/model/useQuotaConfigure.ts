/**
 * useQuotaConfigure —— ProviderEditModal「Coding Plan 额度查询」Section 业务编排。
 *
 * 契约 v2（coding-plan-quota-config-ux §7.1/§7.2）：
 * - 类型 / 凭证 / Workspace 进草稿，经 saveAndTest 一次点击提交（D2/D5）；开关只写配置位（D4）
 * - readiness 是「保存并测试」按钮禁用状态的唯一依据；密文字段取「草稿 ∨ 已保存」并集，
 *   明文的 Workspace 只看草稿（D13）
 * - cookie 输入去掩码（D7）：cookieInput 永远只放用户真实输入，保存成功后清空
 */
import { ref, computed, watch, type Ref } from 'vue'
import type {
  NormalizedQuotaRow,
  QuotaConfigurePayload,
  QuotaCredentialSource,
  QuotaPreset,
  ProviderInfo,
  QuotaAuthKind,
  QuotaFetchFailureReason,
} from '@taiji/shared'
import { QUOTA_PRESETS, normalizeQuotaWorkspaceUrl, resolveQuotaCredentialSource, supportsExclusiveCredential } from '@taiji/shared'
import type { QuotaConfigureState, QuotaTestStatus, ReadinessMissing } from '@taiji/core'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import i18n from '@/i18n'
import { useQuotaStore } from '@/stores/quota'

// i18n.global.t 的类型窄化 cast（对齐 useQuotaQuery 的非 setup composable 模式）：
// 失败文案走 i18n（en-US locale 不再透出硬编码中文，D9）。
const t = i18n.global.t as (key: string) => string

// 状态契约 SSOT 在 core（ui injection-keys 与本 composable 共享，字段语义注释见彼处）
export type { QuotaTestStatus }

/**
 * Workspace 草稿的保存前归一化（模块级辅助）。
 * - 空 → required 报错（不发 RPC）。D13：空不再解释为「清除」，UI 侧由 readiness 置灰
 *   拦住这条路，这里只是对称的防御（直接调用 saveAndTest 时也不会产出空串）
 * - 非空 → shared 归一化校验（完整 URL / 裸 wrk_ id → 规范额度页 URL）
 * - 非法输入 → invalid 报错（不发 RPC）；errorKey 由调用方经 i18n 渲染
 */
function normalizeWorkspaceDraft(
  raw: string,
): { ok: true; payload: string } | { ok: false; errorKey: string } {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, errorKey: 'settings.providerEdit.quotaWorkspaceRequired' }
  }
  const normalized = normalizeQuotaWorkspaceUrl(trimmed)
  if (!normalized.ok) {
    return { ok: false, errorKey: 'settings.providerEdit.quotaWorkspaceInvalid' }
  }
  return { ok: true, payload: normalized.url }
}

/** 当前草稿 fetcher 对应的预设；未选择草稿时 fallback 到自动匹配的 preset。 */
function findPreset(fetcherId: string | undefined, fallback: QuotaPreset | undefined): QuotaPreset | undefined {
  if (fetcherId) return QUOTA_PRESETS.find((p) => p.fetcher === fetcherId)
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
  needsWorkspace: boolean
  /** 归属判据：savedFetcher !== undefined && draft.fetcher !== savedFetcher */
  typeChanged: boolean
  cookieDraft: string
  apiKeyDraft: string
  cookieSaved: boolean | undefined
  apiKeySaved: boolean | undefined
  workspaceDraft: string
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

/** 判定项清单：凭证档在前、workspace 在后（missing 顺序 = 本清单顺序）。 */
function readinessChecks(s: ReadinessSignals): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [credentialCheck(s)]
  // workspace 是明文且始终回显 → 判定只看草稿（D13：屏幕即真相）
  if (s.needsWorkspace) {
    checks.push({ field: 'workspace', satisfied: s.workspaceDraft.trim() !== '' })
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

/**
 * composable 返回类型 = core 契约（[BL round1 monorepo S] 原 ui injection-keys 逐字段
 * 手工镜像本接口，提升 core 后双侧 import 同一类型消除镜像）。
 */
export type UseQuotaConfigureReturn = QuotaConfigureState

/**
 * @param preset - 当前匹配的 QuotaPreset（matchQuotaPreset 命中）
 * @param providerRef - 当前编辑的 ProviderInfo ref（已保存快照；草稿回填与「∨ 已保存」并集读它）
 */
export function useQuotaConfigure(
  preset: Ref<QuotaPreset | undefined>,
  providerRef: Ref<ProviderInfo | null>,
): UseQuotaConfigureReturn {
  const quotaStore = useQuotaStore()
  const enabled = ref(false)
  /** 类型草稿底层态：外部经 fetcherId（writable computed）写入，同值短路在 setter 上 */
  const fetcherIdDraft = ref<string | undefined>(undefined)
  /** cookie 输入草稿（D7 去掩码：永远只放用户真实输入，不回填掩码、不回填密文） */
  const cookieInput = ref('')
  /** 专属 API Key 输入草稿（密文不回显，保存成功后清空） */
  const apiKeyInput = ref('')
  /** 凭证来源选择（D3，api-key 类专用）：UI 显示与 runtime 使用由同一份持久化数据驱动 */
  const credentialSource = ref<QuotaCredentialSource>('provider')
  /** Workspace 地址输入草稿（明文回显，D13：判定只看草稿） */
  // D13 已知代价（设计 §6.14）：UI 不支持清除已保存 workspace（清空草稿 → readiness 置灰
  // 保存不出去）；换地址直接覆盖、停用关开关。显式清除按钮是登记的重审触发条件，勿在
  // readiness 里单独开「空串 = 清除」后门。
  const workspaceInput = ref('')
  const testStatus = ref<QuotaTestStatus>('idle')
  const testError = ref('')
  const quotaData = ref<NormalizedQuotaRow | null>(null)
  const lastFetchAt = ref<number | null>(null)
  const configuring = ref(false)
  const configureError = ref('')

  /** 最近一次查询失败原因（A2-4 reason 透传；null = 无失败）。旧缓存保留在 quotaData（「查看上次成功数据」） */
  const testFailReason = ref<QuotaFetchFailureReason | null>(null)

  /** 下拉框选项：QUOTA_PRESETS 映射为 { value, label } */
  const fetcherOptions = QUOTA_PRESETS.map((p) => ({ value: p.fetcher, label: p.label }))

  /**
   * 类型草稿（§7.1：类型进草稿，由 saveAndTest 一次提交，不再即时落盘）。
   *
   * [D5 守卫必须落在值上] CodingPlanSection 用 reka Select 的 `:model-value` + update 事件，
   * 而 reka 的 `SelectItem.handleSelect` 无条件 emit —— 用户重复点选当前类型也会触发写入。
   * 没有同值短路就会丢掉用户未提交的输入（丢的是正在输入的内容，不是磁盘数据）。
   * 类型**真变**才清凭证草稿；Workspace 草稿不清（明文回显字段，清了等于制造屏幕与磁盘背离）。
   */
  const fetcherId = computed<string | undefined>({
    get: () => fetcherIdDraft.value,
    set: (newId) => {
      if (newId === fetcherIdDraft.value) return
      fetcherIdDraft.value = newId
      cookieInput.value = ''
      apiKeyInput.value = ''
    },
  })

  /**
   * isCookieAuth：基于当前选中的 fetcherId 计算（而非 preset.auth）。
   * 用户手动选了 cookie 类 fetcher（mimo/opencode-go）时显示 cookie 输入区。
   * fetcherId 未选择时 fallback 到 preset.auth。
   * [A2-1] auth 数组化后单值判断改 includes：preset 声明含 cookie 形态即视为 cookie 类
   * （内置 5 preset 中仅 mimo/opencode-go 声明，行为与单值时代一致）。
   */
  const isCookieAuth = computed(() => {
    const fid = fetcherId.value
    if (fid) {
      const opt = QUOTA_PRESETS.find((p) => p.fetcher === fid)
      return opt?.auth.includes('cookie') ?? false
    }
    return preset.value?.auth.includes('cookie') ?? false
  })

  /** 当前选中 fetcher 对应的预设（用于 helpUrl/helpText/requiresWorkspace）。 */
  const activePreset = computed<QuotaPreset | undefined>(() => findPreset(fetcherId.value, preset.value))

  /** 帮助链接（基于当前选中 fetcher）。 */
  const helpUrl = computed<string | undefined>(() => activePreset.value?.helpUrl)
  /** 帮助文案（基于当前选中 fetcher）。 */
  const helpText = computed<string | undefined>(() => activePreset.value?.helpText)

  /** 当前 fetcher 是否需要 workspace 配置（D1-1：资源维度 fetcher 如 opencode-go） */
  const needsWorkspace = computed<boolean>(() => activePreset.value?.requiresWorkspace ?? false)

  /**
   * 当前选中 fetcher 的凭证能力声明（B-3）：fetcherId 优先、fallback 自动匹配 preset。
   * CodingPlanSection 据此渲染凭证态（oauth 就绪/缺失、api-key 回退顺序说明）。
   */
  const authKinds = computed<readonly QuotaAuthKind[]>(() => activePreset.value?.auth ?? [])

  // ── D3 凭证态派生（证据来源见设计 §7.4 / §11 检查点 1）──

  /**
   * Provider 侧是否有可用凭据。「用 Provider 凭据」分段项可点性的唯一依据。
   * 证据 = ProviderInfo.apiKeySet（provider-config-helper 的「auth.json 凭证 id 集合 ∨
   * models.json override.apiKey」聚合）；runtime 才是权威，前端误判由 no-credential 兜底。
   */
  const providerCredentialAvailable = computed<boolean>(() => !!providerRef.value?.apiKeySet)

  /** 专属 Key 是否已保存（D3：单独表达，不再与 provider 侧合并） */
  const quotaApiKeyConfigured = computed<boolean>(() => providerRef.value?.quota?.apiKeySet === true)

  /** 是否已配置 workspace（provider.quota.workspace 非空；明文，回显判定同源） */
  const workspaceConfigured = computed<boolean>(() => !!providerRef.value?.quota?.workspace)

  /**
   * Provider 侧凭据「已填但未保存」（§7.4 文案区分）。证据来源是 provider 表单草稿
   * （form.apiKey 非空且非清除哨兵），而本 composable 的输入只有 (preset, providerRef)，
   * 看不到 provider 表单草稿 —— 它是 **carry-in 槽位**：由 ProviderEditBody 侧（U5 领地）
   * 计算后写入本 ref（或直接作为 prop 传给 CodingPlanSection），composable 不自造该值。
   * 初始 false；不参与 readiness 判定（§7.2 该分支只看 providerCredentialAvailable）。
   */
  const providerCredentialPendingSave = ref(false)

  /**
   * 齐备性派生量（D1）——「保存并测试」按钮禁用状态的唯一依据（§7.2 伪码逐条落地）。
   *
   * 归属判据：`savedFetcher !== undefined && draft.fetcher !== savedFetcher`。「从未按某个
   * 类型保存过」不算类型已变 —— 把 undefined 也算变更会给这类 provider 制造一次用户从未
   * 请求的 cookie 清除。
   */
  const readiness = computed<{ ready: boolean; missing: ReadinessMissing[] }>(() => {
    const fid = fetcherId.value
    // 草稿类型不在 QUOTA_PRESETS（仅历史数据 / 手工编辑 providers.json 可达，下拉只列预设）：
    // 未知 fetcher 无法判定该类型的凭证形态（是否 cookie 类、是否需要 workspace），isCookieAuth /
    // needsWorkspace 会双双落 false 后静默走 api-key 分支 —— providerCredentialAvailable 为 true 时
    // 就放行一条带未知 fetcher 的 configure。按「类型缺失」处理（与 D8「类型未选」同形态），
    // 让用户重选一个有效类型，而不是让未知值借 api-key 分支混过门控。
    if (!fid || !activePreset.value) return { ready: false, missing: ['type'] }

    const quota = providerRef.value?.quota
    const missing = toMissingFields(readinessChecks({
      cookieAuth: isCookieAuth.value,
      credentialSource: credentialSource.value,
      exclusiveSupported: supportsExclusiveCredential(authKinds.value),
      providerCredentialAvailable: providerCredentialAvailable.value,
      needsWorkspace: needsWorkspace.value,
      typeChanged: quota?.fetcher !== undefined && fid !== quota.fetcher,
      cookieDraft: cookieInput.value,
      apiKeyDraft: apiKeyInput.value,
      cookieSaved: quota?.cookieSet,
      apiKeySaved: quota?.apiKeySet,
      workspaceDraft: workspaceInput.value,
    }))

    return { ready: missing.length === 0, missing }
  })

  // ── 初始化：从 provider.quota 读取已保存的配置 ──
  function syncFromProvider(): void {
    const p = providerRef.value
    if (!p?.quota) {
      enabled.value = false
      // fetcherId 默认值：provider.quota.fetcher > 自动匹配的 preset.fetcher > undefined
      fetcherId.value = preset.value?.fetcher
      cookieInput.value = ''
      apiKeyInput.value = ''
      // 无 quota 条目 = 读侧兜底 'provider'（与 runtime resolveQuotaCredentialSource 同源）
      credentialSource.value = resolveQuotaCredentialSource(undefined)
      workspaceInput.value = ''
      testStatus.value = 'idle'
      testError.value = ''
      testFailReason.value = null
      quotaData.value = null
      lastFetchAt.value = null
      return
    }
    enabled.value = p.quota.enabled
    // fetcherId 初始值：手动指定的 quota.fetcher 优先，未设置时 fallback 到自动匹配值
    fetcherId.value = p.quota.fetcher ?? preset.value?.fetcher
    // D7 去掩码：密文（cookie / 专属 Key）一律不回填，输入框只承载用户本次的真实输入
    cookieInput.value = ''
    apiKeyInput.value = ''
    // D3 读侧：未显式设置时按既存标记推断（历史数据兼容）；两端调用同一函数避免推断背离
    credentialSource.value = resolveQuotaCredentialSource(p.quota)
    // workspace 非凭证（用户浏览器地址栏可见的 URL），明文回显供编辑
    workspaceInput.value = p.quota.workspace ?? ''
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
      const result = await quotaApi.getCached(p.id)
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
  watch(providerRef, syncFromProvider, { immediate: true })
  // preset 变化时：若用户未手动指定 fetcherId，跟随自动匹配值更新默认。
  // 不再 reset 全部状态——用户可能已手动选了 fetcher 或填了 cookie。
  watch(preset, (newPreset) => {
    const p = providerRef.value
    const manualFetcher = p?.quota?.fetcher
    if (manualFetcher) {
      // 已手动指定，保留
      fetcherId.value = manualFetcher
    } else {
      fetcherId.value = newPreset?.fetcher
    }
  })

  /**
   * 切换启用状态（D4）：纯配置位，唯一语义是「要不要在对话框容量浮层里展示」。
   * 只构造 `{ providerId, enabled }`，其余键一律缺省（= 不变）——否则草稿里的类型 / 来源
   * 选择会经由一次拨开关被偷偷落盘。乐观更新：Switch 是受控组件，先翻转再等 RPC 以免视觉回弹。
   */
  async function setEnabled(v: boolean): Promise<void> {
    const p = providerRef.value
    if (!p) return

    const prevEnabled = enabled.value
    enabled.value = v
    configuring.value = true
    configureError.value = ''

    try {
      const result = await quotaApi.configure({ providerId: p.id, enabled: v })
      if (!result.ok) {
        enabled.value = prevEnabled
        configureError.value = result.error || t('settings.providerEdit.quotaConfigureFail')
        return
      }
      // 关闭额度查询：清 renderer quotaStore 镜像（runtime 侧 lastFailure 由 configure 清理）；
      // 开启不做任何查询（D4 边界：拨开关零网络副作用）
      if (!v) quotaStore.clearCache(p.id)
    } catch (e) {
      enabled.value = prevEnabled
      configureError.value = e instanceof Error ? e.message : t('settings.providerEdit.quotaConfigureFail')
    } finally {
      configuring.value = false
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
    const draftFetcher = fetcherId.value
    // 归属判据同 readiness（§7.2 细节 1）：无既存归属不算类型已变
    const typeChanged = savedFetcher !== undefined && draftFetcher !== savedFetcher
    const source = credentialSource.value
    const cookieDraft = cookieInput.value.trim()
    const apiKeyDraft = apiKeyInput.value.trim()

    configureError.value = ''

    // Workspace：明文回显字段，传归一化后的草稿（D13：永不传 ''）；空 / 非法输入本地拦截
    let workspacePayload: string | undefined
    if (needsWorkspace.value) {
      const normalized = normalizeWorkspaceDraft(workspaceInput.value)
      if (!normalized.ok) {
        configureError.value = t(normalized.errorKey)
        return
      }
      workspacePayload = normalized.payload
    }

    const payload: QuotaConfigurePayload = {
      providerId: p.id,
      // 恒传当前值：保存并测试不改启用状态（开关是独立动作，D4）
      enabled: enabled.value,
      fetcher: draftFetcher,
      // 恒传当前选择（幂等）：显式化磁盘字段，消除「未设置」这一中间态
      credentialSource: source,
      // 类型一变旧 Cookie 的归属就不成立 → 无条件清除（''）；类型没变则缺省 = 保留既存
      cookie: cookieDraft || (typeChanged ? '' : undefined),
      // 专属 Key 永不传 ''：失效由 credentialSource 表达，删文件不可逆（D3）
      apiKey: source === 'exclusive' && apiKeyDraft ? apiKeyDraft : undefined,
      workspace: workspacePayload,
    }

    configuring.value = true
    try {
      const result = await quotaApi.configure(payload)
      // 半提交窗口对齐（runtime 改动 4：清理锚定 persist 成功而非 configure 整体成功）：
      // persist 成功 + secrets 段失败 → runtime 返回 ok:false 但 QuotaCache 已清、fetcher
      // 已换新 —— renderer 镜像失效不能只挂在 ok:true 上，typeChanged 时无条件同步失效
      // （persist 失败多清一次 = 浮层一次后台重拉，与半提交自愈同级，无害）。
      if (typeChanged) quotaStore.clearCache(p.id)
      if (!result.ok) {
        configureError.value = result.error || t('settings.providerEdit.quotaSaveAndTestFail')
        return
      }
      // 保存成功：密文草稿清空（不回显）；已保存态由 provider 广播 → syncFromProvider 重建
      cookieInput.value = ''
      apiKeyInput.value = ''
      await testQuery()
    } catch (e) {
      configureError.value = e instanceof Error ? e.message : t('settings.providerEdit.quotaSaveAndTestFail')
    } finally {
      configuring.value = false
    }
  }

  /** 测试查询（触发 quota.refresh，绕过 throttle） */
  async function testQuery(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    testStatus.value = 'loading'
    testError.value = ''
    testFailReason.value = null

    try {
      // 用 refresh 绕过 10s throttle，确保测试查询每次都发真实请求（设计 §2.2.5）
      const result = await quotaApi.refreshQuota(p.id)
      if (result.data) {
        quotaData.value = result.data
        lastFetchAt.value = result.lastFetchAt
        testStatus.value = 'success'
      } else {
        // 失败态（A2-4）：reason 透传给 UI（恢复指引文案按 reason 渲染）；旧缓存保留在
        // quotaData 不展示（「查看上次成功数据」展开可见）；lastFetchAt = 最近一次成功时间
        testStatus.value = 'error'
        testFailReason.value = result.reason ?? null
        lastFetchAt.value = result.lastFetchAt
        testError.value = t('settings.providerEdit.quotaTestFail')
      }
    } catch (e) {
      testStatus.value = 'error'
      testError.value = e instanceof Error ? e.message : t('settings.providerEdit.quotaTestFail')
    }
  }

  /** 重置全部状态（派生量随底层引用归零自动重算） */
  function reset(): void {
    enabled.value = false
    fetcherId.value = undefined
    cookieInput.value = ''
    apiKeyInput.value = ''
    credentialSource.value = resolveQuotaCredentialSource(providerRef.value?.quota)
    workspaceInput.value = ''
    testStatus.value = 'idle'
    testError.value = ''
    testFailReason.value = null
    quotaData.value = null
    lastFetchAt.value = null
    configuring.value = false
    configureError.value = ''
  }

  return {
    fetcherId,
    fetcherOptions,
    enabled,
    cookieInput,
    apiKeyInput,
    credentialSource,
    providerCredentialAvailable,
    quotaApiKeyConfigured,
    providerCredentialPendingSave,
    workspaceInput,
    workspaceConfigured,
    needsWorkspace,
    readiness,
    testStatus,
    testError,
    quotaData,
    lastFetchAt,
    isCookieAuth,
    authKinds,
    testFailReason,
    helpUrl,
    helpText,
    configuring,
    configureError,
    setEnabled,
    saveAndTest,
    reset,
  }
}
