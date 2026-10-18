/**
 * provider-edit-form —— Provider 编辑「表单草稿 + dirty/快照」module（[C4] 拆分自
 * use-provider-edit.ts）。
 *
 * 承载：凭据/名称/端点表单草稿（form，含 D7 headers/authHeader + B-1 authMethod）+ headers
 * 行编辑 CRUD + isDirty 快照对比（D13）+ save 持久化（D15b 校验 → 防线① catalog/custom 分体系
 * → transport.setProvider）+ **D8 广播并发对齐的调用点**（规则纯核 = provider-edit-reconcile.ts，
 * deep watch 退化为 reconcileBroadcast 的一个调用点）。
 *
 * 接口即测试面（interface is the test surface）：行为矩阵见 provider-edit-form.test.ts
 * （并发对齐规则本体在 provider-edit-reconcile.test.ts 纯核矩阵）。
 */
import { ref, reactive, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { ProviderInfo, SetProviderData } from '@taiji/shared'
import { toErrorMessage } from '../../utils/error-message'
import { getSettingsTransport } from './transport'
import type { FormSnapshot, SaveResult, Translate } from './provider-edit-types'
import { formPatchFromProvider, reconcileBroadcast, type ProviderFormPatch } from './provider-edit-reconcile'
import { buildModelsPayload, type ProviderEditModelsModule } from './provider-edit-models'

// ── 常量 / 纯函数 helpers ──

/**
 * apiKey「清除」哨兵值（D18）。
 * 表单内 draft.apiKey 默认 ''=不变（save 时 `apiKey || undefined` 跳过）。
 * 用户点「清除」时把 draft.apiKey 置为此哨兵，save 识别后发送空串给 runtime
 * ——runtime 防线②把空串转译为删键（delete merged.apiKey），不落空串。
 */
export const API_KEY_CLEAR_SENTINEL = '__CLEAR__'

/**
 * 计算 save 时实际发送的 apiKey（D18，纯）。
 * - 哨兵 → ''（清空已配置的 key）
 * - 空 → undefined（保持不变）
 * - 非空 → 原值
 */
export function resolveApiKeyForSave(apiKey: string): string | undefined {
  if (apiKey === API_KEY_CLEAR_SENTINEL) return ''
  return apiKey || undefined
}

/** 从 headerRows 构建 headers Record + 重复 key 检测（syncHeadersFromRows 提取，纯） */
export function buildHeadersFromRows(
  rows: Array<{ key: string; value: string }>,
): { headers: Record<string, string>; hasDuplicate: boolean } {
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  let hasDuplicate = false
  for (const r of rows) {
    const k = r.key.trim()
    if (!k) continue
    if (seen.has(k)) hasDuplicate = true
    seen.add(k)
    headers[k] = r.value
  }
  return { headers, hasDuplicate }
}

/**
 * 把 headers Record 转成行数组（纯）。
 * headers 是已知 schema 的 Record<string,string>（非任意用户输入），Object.keys +
 * 索引取值即可（无需 entries 解构断言）。
 */
export function headerRowsFromHeaders(headers: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.keys(headers).map((k) => ({ key: k, value: headers[k] }))
}

// ── module 契约 ──

/**
 * 动作错误来源标签（MF-1-7）：错误归属判定按来源，不比对展示文案（i18n 文案运行时值
 * 随 locale 变化，作判据会在切换后失效导致旧错误滞留）。
 * - save：保存校验 / setProvider 失败
 * - headers：headers 行编辑重复 key
 * - discover：test / discover 探活失败（use-provider-edit 装配时经写通道注入落标签）
 * - models：模型清单 CRUD 校验错（ProviderEditBody onAddModel 捕获填入）
 * - reveal：回显已存 API Key 失败（2026-10-18 眼睛按钮）
 */
export type ActionErrorSource = 'save' | 'headers' | 'discover' | 'models' | 'reveal'

/** 动作错误内部态（带来源标签；null = 无错误） */
export interface ActionErrorState {
  source: ActionErrorSource
  message: string
}

/** 凭据/名称/端点表单草稿（ProviderEditBody 模板 v-model 直绑） */
export interface ProviderEditFormDraft {
  name: string
  api: string
  baseUrl: string
  apiKey: string
  /** form.headers/authHeader（D7）：provider 级自定义请求头 + 是否把 apiKey 写入 Authorization。
   *  headers 用 Record 形态（save 时回写 setProvider），UI 通过 headerRows 行编辑驱动。 */
  headers: Record<string, string>
  authHeader: boolean
  /**
   * 凭证形态（B-1 条件化凭证区）：编辑态副本，切换经确认弹窗（I9 双凭据互斥），
   * save 时随 payload 回传（runtime 写 providers.json authMethod 标注）。
   */
  authMethod: ProviderInfo['authMethod']
}

/**
 * 表单 + dirty/快照 module（[C4] 3 组子 interface 之一）。
 */
export interface ProviderEditFormModule {
  /** 表单草稿 */
  readonly draft: ProviderEditFormDraft
  /**
   * headers 行编辑态（D7）：每行一对 key/value，UI 双向绑定。
   * 与 draft.headers 双向同步：headerRows 改 → 同步回 draft.headers（save 用）；
   * provider 加载时从 p.headers 初始化 headerRows。
   */
  readonly headerRows: Ref<Array<{ key: string; value: string }>>
  /** apiKey 明文显示开关 */
  readonly showKey: Ref<boolean>
  /** 正在拉取已存 API Key（眼睛按钮禁用态；2026-10-18 回显） */
  readonly revealingApiKey: Ref<boolean>
  /**
   * 回显已存 API Key（眼睛按钮，按需 RPC——只对 api_key 凭据生效，OAuth token 不走本通道）：
   * 拉取成功填入草稿并置 showKey；草稿已非空（用户已输入）时为空操作。
   * 回显值不构成 dirty、保存时不回写（回显 = 所存值，回写会改变凭据来源语义）。
   * 失败（无可回显凭据 / RPC 错误）返回 ok:false + 可直接展示的文案——保存条仅在 dirty
   * 时渲染，回显失败必须由调用方给可见反馈（C-proc-21，禁静默无动作）。
   */
  revealApiKey(): Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * 配额区 carry-in 槽位用「真实未保存草稿」：回显值（= 所存值）不算待保存，返回 ''。
   * 供 useQuotaConfigure 的 providerCredentialPendingSave 判定（防回显触发「已填未保存」误报）。
   */
  readonly apiKeyPendingDraft: ComputedRef<string>
  /** 保存中（save-bar 按钮禁用） */
  readonly saving: Ref<boolean>
  /**
   * 动作错误（保存/测试/发现/模型 CRUD 失败时显示在底栏，非静默吞）。
   * MF-1-7：对外是只露 message 的投影（空串 = 无错误）；写入走 setActionError（带来源
   * 标签），headers 来源错误的自动清除按 source 判定——不比对展示文案，locale 切换安全。
   */
  readonly actionError: ComputedRef<string>
  /** 动作错误唯一写入口（MF-1-7）：message 空 = 清除 */
  setActionError(source: ActionErrorSource, message: string): void
  /** 动作错误清除（provider 切换重置 / 动作置况 / headers 重复 key 消除时） */
  clearActionError(): void
  /**
   * form 相对初始快照是否有变更（D13 取消确认 + W3 过期快照刷新用）。
   * 对比 name/api/baseUrl/apiKey 状态/models 整体/authHeader/headers/authMethod。
   * snapshot=null（未初始化）→ false。models 用 JSON 串整体对比：增删 id 与内部字段
   * （compat/thinkingLevelMap/contextWindow/input 等）任一变更都判 dirty——避免用户改
   * compat 等字段后 isDirty=false 静默丢改（问题 1）。
   */
  readonly isDirty: ComputedRef<boolean>
  /**
   * 保存：校验 → transport.setProvider。调用方据 result.ok emit close；
   * result.wroteApiKey 供父组件做「apikey 配置完成即自动启用」（ProviderPage afterApiKeySave）。
   */
  save(): Promise<SaveResult>
  /** 清除 apiKey（D18）：置哨兵，save 时识别为清空。仅已配置 key 时有意义 */
  clearApiKey(): void
  /** 新增一个空 header 行 */
  addHeader(): void
  /** 移除指定下标的 header 行，并同步回 draft.headers */
  removeHeader(index: number): void
  /** 把 headerRows 同步回 draft.headers（filter 掉空 key 的行 + 重复 key 校验） */
  syncHeadersFromRows(): void
  /** provider 切换/打开时的表单载入（含 apiKey 重置=「不变」；null = 新增态清空） */
  applyProvider(p: ProviderInfo | null): void
  /** 瞬态态重置（编辑/新增两分支共用）：明文开关、错误提示 */
  resetTransient(): void
  /** 记录当前 draft/localModels 为初始快照（provider 切换/打开后 + D8 重拍后调） */
  captureSnapshot(): void
}

/** module 工厂输入 */
export interface ProviderEditFormInputs {
  /** 当前编辑的 provider（null = 弹窗关闭/新增态） */
  providerRef: Ref<ProviderInfo | null>
  /** 广播 provider 列表（settingsStore.providers，D8 过期快照刷新数据源） */
  providers: Ref<ProviderInfo[]>
  /** 模型清单 module（isDirty 的 modelsJson 对比 + D8 重拍的清单对齐） */
  models: ProviderEditModelsModule
  /** TC4 注入：t（i18n 翻译函数） */
  t: Translate
}

// ── module 实现 ──

export function createProviderEditForm(input: ProviderEditFormInputs): ProviderEditFormModule {
  const { providerRef, providers, models, t } = input

  const draft = reactive<ProviderEditFormDraft>({
    name: '',
    api: 'anthropic-messages',
    baseUrl: '',
    apiKey: '',
    headers: {},
    authHeader: false,
    authMethod: undefined,
  })
  const headerRows = ref<Array<{ key: string; value: string }>>([])
  const showKey = ref(false)
  /** 回显的已存 apiKey（null = 未回显）。与草稿同值时不构成 dirty、保存不回写（2026-10-18） */
  const revealedApiKey = ref<string | null>(null)
  const revealingApiKey = ref(false)
  const saving = ref(false)
  // 动作错误内部态（MF-1-7：带来源标签）；对外只投影 message（下方 actionError computed）
  const actionErrorState = ref<ActionErrorState | null>(null)
  const actionError = computed<string>(() => actionErrorState.value?.message ?? '')
  const snapshot = ref<FormSnapshot | null>(null)

  function setActionError(source: ActionErrorSource, message: string): void {
    actionErrorState.value = message ? { source, message } : null
  }

  function clearActionError(): void {
    actionErrorState.value = null
  }

  function applyPatch(patch: ProviderFormPatch): void {
    draft.name = patch.name
    draft.api = patch.api
    draft.baseUrl = patch.baseUrl
    draft.headers = { ...patch.headers }
    draft.authHeader = patch.authHeader
    draft.authMethod = patch.authMethod
  }

  function captureSnapshot(): void {
    snapshot.value = {
      name: draft.name,
      api: draft.api,
      baseUrl: draft.baseUrl,
      apiKeyChanged: draft.apiKey !== '',
      modelsJson: JSON.stringify(models.localModels.value),
      authHeader: draft.authHeader,
      headersJson: JSON.stringify(draft.headers),
      authMethod: draft.authMethod,
    }
  }

  const isDirty = computed<boolean>(() => {
    const s = snapshot.value
    if (!s) return false
    if (draft.name !== s.name) return true
    if (draft.api !== s.api) return true
    if (draft.baseUrl !== s.baseUrl) return true
    // apiKey：用户输入了值 或 点了清除（哨兵）都算变更；**等于回显值 = 未改动**
    //（2026-10-18 回显：回显只是把已存值展示出来，不得因此进入 dirty）
    const apiKeyChangedNow = draft.apiKey !== '' && draft.apiKey !== revealedApiKey.value
    if (apiKeyChangedNow !== s.apiKeyChanged) return true
    // models 整体对比（增删 + 内部字段改都触发 dirty）
    if (JSON.stringify(models.localModels.value) !== s.modelsJson) return true
    // W3 D7：authHeader / headers 变更即 dirty
    if (draft.authHeader !== s.authHeader) return true
    if (JSON.stringify(draft.headers) !== s.headersJson) return true
    // B-1：凭证形态切换即 dirty
    if (draft.authMethod !== s.authMethod) return true
    return false
  })

  function applyProvider(p: ProviderInfo | null): void {
    // edit 模式：用现有 provider 数据填充表单；新增模式：重置为初始空状态。
    // apiKey 恒重置为 ''（=「不变」）：明文/env 引用/哨兵都是草稿态，随 provider 切换清空。
    // 回显态（revealedApiKey）同批清空——回显值属于「当前 provider 的已存值」，不得跨 provider 复用。
    applyPatch(formPatchFromProvider(p))
    draft.apiKey = ''
    revealedApiKey.value = null
    headerRows.value = headerRowsFromHeaders(draft.headers)
  }

  function resetTransient(): void {
    showKey.value = false
    clearActionError()
  }

  /**
   * 保存前校验：返回错误文案，null = 通过。
   * - D15b：供应商名称必填
   * - B-1 形态切换守卫：oauth → api_key 切换后必须提供新 key——确认弹窗承诺「退出 OAuth
   *   登录」，空 key 保存会让 auth.json OAuth 凭证残留（catalog 的覆写只发生在携带 apiKey 时）
   */
  function validateBeforeSave(): string | null {
    if (!draft.name.trim()) return t('composable.providerNameRequired')
    if (snapshot.value?.authMethod === 'oauth' && draft.authMethod === 'api_key'
      && resolveApiKeyChange() === undefined) {
      return t('composable.oauthSwitchNeedsKey')
    }
    return null
  }

  /**
   * setProvider 载荷构造（防线①：catalog / custom 的 provider 级字段分体系）。
   * isCatalog / baseUrl 由调用方先算后传（保持原求值时点）；条件键各自按 isCatalog 与 truthy
   * 守卫决定带不带键。
   */
  function buildSetProviderPayload(isCatalog: boolean, baseUrl: string): SetProviderData {
    return {
      // 防线①：custom 空串 name 不带键（truthy 守卫，对齐 use-quick-setup-form 既有先例）；
      // catalog 的 name 是 provider 展示名（正常态非空），保持回传。
      ...(isCatalog || draft.name.trim() ? { name: draft.name } : {}),
      // 防线①：catalog 不带 type 键——协议是模型级属性，provider 级 api 对 catalog 无用户语义
      // （前端回传的是快照 artifact，runtime 侧对 catalog 的 type 同样忽略；不发是双保险）。
      ...(isCatalog ? {} : { type: draft.api }),
      // 防线①：catalog 的 baseUrl **恒显式带键**（值 = trim 结果：非空 = 设置网关 / '' = 清除
      // 网关——「undefined = 不变」是既有 merge 协议，清空输入框必须走显式空串带键，否则网关
      // 回退通道不可达）；custom 空串不带键（runtime 对 custom 空串同样是「不变」）。
      ...(isCatalog || baseUrl ? { baseUrl } : {}),
      // D18：apiKey 空=不变（undefined）；哨兵=清空（''）；非空=原值。
      // 2026-10-18 回显：草稿 === 回显值（未改动）时不发键——回显只是展示，直接回写会
      // 改变凭据来源语义（如 catalog 的 auth.json → 被误当作新 key 重写）。
      apiKey: resolveApiKeyChange(),
      // B-1：凭证形态回传（undefined = 不变；runtime 写 providers.json authMethod 标注）
      authMethod: draft.authMethod,
      // W3 D7：headers（空对象时不传，避免覆盖 runtime 既有值）+ authHeader 回写。
      headers: Object.keys(draft.headers).length > 0 ? draft.headers : undefined,
      authHeader: draft.authHeader,
      // 透传 model 级字段（B-2 builtin 不回传 + B-4b round-trip 规则见 buildModelsPayload）
      models: buildModelsPayload(models.localModels.value),
    }
  }

  /**
   * 保存：校验 → transport.setProvider。调用方据 result.ok emit close；
   * result.wroteApiKey 供父组件做「apikey 配置完成即自动启用」（ProviderPage afterApiKeySave）。
   */
  async function save(): Promise<SaveResult> {
    const validationError = validateBeforeSave()
    if (validationError) {
      setActionError('save', validationError)
      return { ok: false, wroteApiKey: false }
    }
    saving.value = true
    clearActionError()
    const providerId = providerRef.value?.id ?? draft.name
    // 防线①（设计 D1）：catalog / custom 的 provider 级字段分体系。kind 缺失（旧数据 / 新建态
    // 无 providerRef）按 custom 处理（自定义 provider 需要 provider 级协议）。
    const isCatalog = providerRef.value?.kind === 'catalog'
    // 网关输入框值：trim 后判定（纯空白串与空串同视，runtime 侧同样按 trim 判定）
    const baseUrl = draft.baseUrl.trim()
    try {
      const res = await getSettingsTransport().setProvider(providerId, buildSetProviderPayload(isCatalog, baseUrl))
      // 哨兵→''、空→undefined 均为 falsy：只有本次真正写入非空 key（明文或 $ENV 引用）才 true
      return { ok: true, wroteApiKey: Boolean(resolveApiKeyChange()), quotaAutoEnabled: res?.quotaAutoEnabled }
    } catch (e) {
      setActionError('save', toErrorMessage(e))
      return { ok: false, wroteApiKey: false }
    } finally {
      saving.value = false
    }
  }

  function clearApiKey(): void {
    draft.apiKey = API_KEY_CLEAR_SENTINEL
  }

  /**
   * 本次保存实际要写的 apiKey（D18 + 2026-10-18 回显）：
   * - 草稿 === 回显值（未改动）→ undefined（不发键：回显只是展示，不得被当作新值回写）
   * - 空 → undefined（不变）；哨兵 → ''（清空）；非空 → 原值
   */
  function resolveApiKeyChange(): string | undefined {
    if (draft.apiKey === revealedApiKey.value) return undefined
    return resolveApiKeyForSave(draft.apiKey)
  }

  /**
   * 回显已存 API Key（2026-10-18，眼睛按钮按需拉取；草稿已非空时为空操作——用户输入优先）。
   * 只对 api_key 凭据生效：runtime 端 OAuth token 永不出协议（见协议 config.revealProviderApiKey）。
   * 回显值写入草稿 + 置 showKey（明文可见），但不进入 dirty、save 不回写（见 resolveApiKeyChange）。
   */
  async function revealApiKey(): Promise<{ ok: true } | { ok: false; error: string }> {
    const p = providerRef.value
    if (!p || draft.apiKey !== '' || revealingApiKey.value) return { ok: true }
    revealingApiKey.value = true
    try {
      const res = await getSettingsTransport().revealProviderApiKey(p.id)
      if (res.available && res.apiKey) {
        draft.apiKey = res.apiKey
        revealedApiKey.value = res.apiKey
        showKey.value = true
        if (actionErrorState.value?.source === 'reveal') clearActionError()
        return { ok: true }
      }
      const error = t('composable.revealApiKeyUnavailable')
      setActionError('reveal', error)
      return { ok: false, error }
    } catch (e) {
      const error = toErrorMessage(e)
      setActionError('reveal', error)
      return { ok: false, error }
    } finally {
      revealingApiKey.value = false
    }
  }

  /** 真实未保存草稿（回显值排除）——配额区 pendingSave 判定槽位（见接口 JSDoc） */
  const apiKeyPendingDraft = computed<string>(() => (
    draft.apiKey === revealedApiKey.value ? '' : draft.apiKey
  ))

  function syncHeadersFromRows(): void {
    const { headers, hasDuplicate } = buildHeadersFromRows(headerRows.value)
    draft.headers = headers
    if (hasDuplicate) {
      setActionError('headers', t('composable.duplicateHeaderKey'))
    } else if (actionErrorState.value?.source === 'headers') {
      // 清除判定按来源标签（MF-1-7）：locale 切换后文案运行时值变化不会滞留旧错误；
      // save/discover/models 来源的错误不被 headers 同步误清
      clearActionError()
    }
  }

  function addHeader(): void {
    headerRows.value.push({ key: '', value: '' })
  }

  function removeHeader(index: number): void {
    headerRows.value.splice(index, 1)
    syncHeadersFromRows()
  }

  /**
   * D8 调用点（规则纯核 = reconcileBroadcast，三分支语义见 provider-edit-reconcile.ts）：
   * 弹窗打开期间外部广播更新了同 provider（onProviders 整体替换 store.providers），
   * 按裁决机械应用——① 非 dirty 整体重拍（+重捕获快照）② dirty 的 authMethod 单字段例外
   * （含「手改快照」的 authMethod 位）③ 不动。
   */
  function applyReconcile(fresh: ProviderInfo): void {
    const decision = reconcileBroadcast(fresh, draft, isDirty.value, snapshot.value)
    if (decision.action === 'ignore') return
    if (decision.action === 'align-auth-method') {
      draft.authMethod = decision.authMethod
      // 手改快照：单独重拍快照的 authMethod 位（保持其余快照位不动，isDirty 语义不被扰动）
      if (snapshot.value) snapshot.value.authMethod = decision.authMethod
      return
    }
    applyPatch(decision.form)
    headerRows.value = headerRowsFromHeaders(draft.headers)
    models.localModels.value = decision.models
    // 刷新后重新捕获快照（新基线，避免下次广播触发不必要的「dirty」）
    captureSnapshot()
  }

  // D8：编辑弹窗过期快照刷新（watch 本体退化为 reconcileBroadcast 的一个调用点）。
  // 仅编辑态（providerRef 非 null）刷新；新增态无 provider 可对齐；广播缺该 id 同样不动。
  watch(
    providers,
    (list) => {
      const editingId = providerRef.value?.id
      if (!editingId) return
      const fresh = list.find((p) => p.id === editingId)
      if (!fresh) return
      applyReconcile(fresh)
    },
    { deep: true },
  )

  return {
    draft,
    headerRows,
    showKey,
    revealingApiKey,
    revealApiKey,
    apiKeyPendingDraft,
    saving,
    actionError,
    setActionError,
    clearActionError,
    isDirty,
    save,
    clearApiKey,
    addHeader,
    removeHeader,
    syncHeadersFromRows,
    applyProvider,
    resetTransient,
    captureSnapshot,
  }
}
