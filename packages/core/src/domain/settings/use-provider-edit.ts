/**
 * use-provider-edit —— Provider 编辑弹窗业务编排（core 域迁移版，F1 拆分自 ProviderEditModal.vue）。
 *
 * [迁移] strangler 迁移自 packages/renderer/src/composables/features/useProviderEdit.ts（559 行），
 * 原样迁移 + deps 注入：
 * - API 调用（discoverModels/setProvider）改走 IF1 SettingsTransport（getSettingsTransport()）。
 * - store（D8 过期快照 watch）经 getSettingsStore()（模块级单例）。
 * - i18n 经 TC4 参数注入：useProviderEdit(providerRef, { t })，core 不 import @/i18n。
 *
 * 承载原组件 3 个非展示职责：② test/discover（合并两套近似 try/catch 为 runDiscover）
 * ③ 模型清单 CRUD ④ save 持久化。凭据 form 也在此持有（组件模板 v-model 绑定）。
 * provider ref 变化时重置全部编辑态（原 watch(props.provider)）。
 *
 * 导出面保留：CONTEXT_OPTIONS / THINKING_STRATEGIES / THINKING_PRESETS /
 * API_KEY_CLEAR_SENTINEL / LocalModel / ThinkingStrategy / DiscoverAction
 * （renderer 组件消费方零改动，W3/W4 再切换 import 源）。
 *
 * 零 '@/' import（core 零 renderer 依赖铁律）。
 */
import { ref, reactive, watch, computed, type Ref } from 'vue'
import type { ProviderInfo, SetProviderData, ConnectionTestResultRow } from '@taiji/shared'
import { getSettingsStore } from './settings-store'
import { getSettingsTransport } from './transport'
import type { DiscoverModelsRequest, DiscoverModelsResponse } from './transport'

// ── 类型 ──

/** 本地编辑态模型（ProviderInfo.models 的可编辑副本）。
 *  含 api/baseUrl/enabled 透传位（与 ProviderInfo.models 元素同构，W4）+
 *  B-4b 透传位（reasoning/maxTokens/cost/headers，对齐 SetProviderData.models 元素）：
 *  编辑保存时这些字段必须回传，否则 model 级配置会在 setProvider 合并时被丢弃
 *  （运行时靠 base spread 保数据不丢，但显式回传才让「编辑→保存」链路真实生效）。 */
export interface LocalModel {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  /** model 级 max output tokens（B-4b 透传位）。 */
  maxTokens?: number
  contextWindow?: number
  input?: Array<'text' | 'image'>
  thinkingLevelMap?: Record<string, string | null>
  /**
   * model 级计费（B-4b 透传位，含可选 tiers 分档定价）。tiers 是运行时透传：
   * ProviderInfo.models[].cost 类型未声明 tiers，但 spread 链（load → LocalModel → save）
   * 保留其运行时值，编辑器不构造 cost 时既有 tiers 不丢。
   */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> }
  /** model 级自定义请求头（B-4b 透传位；当前无行编辑 UI，纯 load→save 保字段）。 */
  headers?: Record<string, string>
  /** model 级 compat 覆盖（OpenAI/Anthropic 兼容性配置，透传到 runtime setProvider）。 */
  compat?: Record<string, unknown>
  /** model 级启停透传（省略时 runtime 默认 true） */
  enabled?: boolean
  /**
   * 条目来源（B-2 聚合层标注透传）：catalog provider 的编辑列表只含非 builtin 条目
   * （见 toEditableModels），save 回传 override 条目、builtin 不回传（runtime 合并语义
   * builtin ∪ override，回传 builtin 会把内置定义冻结成 override）。不参与 setProvider payload。
   */
  source?: 'builtin' | 'override'
}

/**
 * 可编辑模型列表（B-2 混合列表）：catalog provider 过滤掉 builtin 条目（只读展示由
 * ProviderEditBody 直接读 provider.models），custom / kind 缺失（旧数据）全量保留。
 * 整对象 spread：ProviderInfo.models 元素的 B-4b 透传位（reasoning/maxTokens/cost/headers）
 * 一并进编辑副本（load 侧接线），save 时显式回传（见 save 的 models map）。
 */
function toEditableModels(p: ProviderInfo): LocalModel[] {
  const editable = p.kind === 'catalog'
    ? p.models.filter((m) => m.source !== 'builtin')
    : p.models
  return editable.map((m) => ({ ...m }))
}

/** 思考策略预设 key（UI Select 值） */
export type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

/** TC4 注入的 i18n 翻译函数（壳侧传 vue-i18n 的 t）。 */
export interface ProviderEditDeps {
  t: (key: string, params?: Record<string, unknown>) => string
}

/** save 结果：ok=是否成功；wroteApiKey=本次是否写入了非空 apiKey（明文/env 引用，哨兵清空与「不变」均 false） */
export interface SaveResult {
  ok: boolean
  wroteApiKey: boolean
}

// ── 常量 ──

/** 上下文窗口选项（template ctxOptions 来源） */
export const CONTEXT_OPTIONS = [
  { label: '128K', value: 128_000 },
  { label: '200K', value: 200_000 },
  { label: '256K', value: 256_000 },
  { label: '512K', value: 512_000 },
  { label: '1M', value: 1_000_000 },
] as const

/**
 * 思考策略预设 → thinkingLevelMap。thinkingLevelMap 语义是 pi 的**黑名单过滤**，
 * 不是「key = UI 可选档位」的白名单（按白名单心智写预设会多出未列出的默认档）：
 * pi `getSupportedThinkingLevels`（pi-ai dist/models.js:548-558）对 reasoning=true 的
 * 模型遍历 EXTENDED_THINKING_LEVELS（off/minimal/low/medium/high/xhigh/max）逐档判定：
 * - value = null → 剔除该档
 * - xhigh / max → 必须显式列出（未列即视为不支持）
 * - 其余档（off/minimal/low/medium/high）→ 默认保留（未列也参与）
 * 所以「只保留某几档」必须把不要的档显式写 null，不能靠不写 key 实现。
 * value = 发给 pi 的实际 level（如 max 档发 xhigh），不是 key——展示是展示、传递是 value。
 * 预设：all-levels(undefined = pi 默认五档 off~high；xhigh/max 需显式映射，要最高档选 high-max)
 *      / on-off(off+high 两档) / high-max(off+high+max→xhigh 三档)
 */
const THINKING_PRESETS: Record<ThinkingStrategy, Record<string, string | null> | undefined> = {
  'all-levels': undefined,
  'on-off': { off: 'off', high: 'high', minimal: null, low: null, medium: null },
  'high-max': { off: 'off', high: 'high', max: 'xhigh', minimal: null, low: null, medium: null },
}

/** 思考策略 Select 选项（template thinkingStrategies 来源）。
 *  fullLabel 保留为回退展示（向后兼容旧 import）；新代码优先用 labelKey + t()。 */
export const THINKING_STRATEGIES: Array<{
  key: ThinkingStrategy
  fullLabel: string
  labelKey: string
}> = [
  { key: 'all-levels', fullLabel: 'All Levels', labelKey: 'composable.thinkingStrategy.allLevels' },
  { key: 'on-off', fullLabel: 'On / Off', labelKey: 'composable.thinkingStrategy.onOff' },
  { key: 'high-max', fullLabel: 'High / Max', labelKey: 'composable.thinkingStrategy.highMax' },
]

/** discover 动作：test（探活，结果显示连接成败）/ discover（合并发现的模型） */
export type DiscoverAction = 'test' | 'discover'

/**
 * 测试连接按协议分组的单条结果（runtime `config.discoveredModels.results` 元素，设计 §3.5 D4）：
 * 每协议一条，代表模型 + 成败 + 失败时的真实原因（HTTP 状态码与响应截断）。
 * 形状 SSOT = shared ConnectionTestResultRow（S-9 收编，本名保留为域内语义别名）。
 */
export type TestConnectionResult = ConnectionTestResultRow

/**
 * apiKey「清除」哨兵值（D18）。
 * 表单内 form.apiKey 默认 ''=不变（save 时 `apiKey || undefined` 跳过）。
 * 用户点「清除」时把 form.apiKey 置为此哨兵，save 识别后发送空串给 runtime
 * ——runtime 防线②把空串转译为删键（delete merged.apiKey），不落空串。
 */
export const API_KEY_CLEAR_SENTINEL = '__CLEAR__'

/**
 * 计算 save 时实际发送的 apiKey（D18）。
 * - 哨兵 → ''（清空已配置的 key）
 * - 空 → undefined（保持不变）
 * - 非空 → 原值
 */
function resolveApiKeyForSave(apiKey: string): string | undefined {
  if (apiKey === API_KEY_CLEAR_SENTINEL) return ''
  return apiKey || undefined
}

// ── 纯函数 helpers（模块级，不计入 composable 行数）──

/** 从 headerRows 构建 headers Record + 重复 key 检测（syncHeadersFromRows 提取） */
function buildHeadersFromRows(
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

// ── composable ──

/**
 * @param providerRef 当前编辑的 provider（null = 弹窗关闭）。变化时重置全部编辑态。
 * @param deps TC4 注入：t（i18n 翻译函数，壳侧传 vue-i18n 的 global.t）。
 */
export function useProviderEdit(providerRef: Ref<ProviderInfo | null>, deps: ProviderEditDeps) {
  const { t } = deps

  // ── 表单 / 列表状态 ──

  /** form.headers/authHeader（D7）：provider 级自定义请求头 + 是否把 apiKey 写入 Authorization。
   *  headers 用 Record 形态（save 时回写 setProvider），UI 通过 headerRows 行编辑驱动。 */
  const form = reactive({
    name: '',
    api: 'anthropic-messages',
    baseUrl: '',
    apiKey: '',
    headers: {} as Record<string, string>,
    authHeader: false,
    /**
     * 凭证形态（B-1 条件化凭证区）：编辑态副本，切换经确认弹窗（I9 双凭据互斥），
     * save 时随 payload 回传（runtime 写 providers.json authMethod 标注）。
     */
    authMethod: undefined as ProviderInfo['authMethod'],
  })
  const newModel = reactive({
    name: '',
    contextWindow: 200_000,
    inputTypes: ['text'] as Array<'text' | 'image'>,
    thinking: 'on-off' as ThinkingStrategy,
    /**
     * 思考能力开关（D4 addModel reasoning 显式化，U6）：出厂显式 boolean 不允许 undefined——
     * 同一个 undefined pi 解释为「关」而旧本地推算解释为「支持」，写入时语义
     * 坍缩正是事故 B 根因。默认 true；选非 all-levels 思考策略时自动置 true（用户可显式关）。
     */
    reasoning: true,
  })

  // D4：思考策略自动推导——选非 all-levels 策略 → reasoning 自动置 true（用户可显式关；
  // 再切策略会重新推导，保持「策略变化 → 推导、用户拨动 → 直接写」的简单模型）。
  watch(
    () => newModel.thinking,
    (strategy) => {
      if (strategy !== 'all-levels') newModel.reasoning = true
    },
  )
  const localModels = ref<LocalModel[]>([])

  /**
   * headers 行编辑态（D7）：每行一对 key/value，UI 双向绑定。
   * 与 form.headers 双向同步：headerRows 改 → 同步回 form.headers（save 用）；
   * provider 加载时从 p.headers 初始化 headerRows。
   */
  const headerRows = ref<Array<{ key: string; value: string }>>([])

  /**
   * 把 headers Record 转成行数组（W3 D7）。
   * headers 是已知 schema 的 Record<string,string>（非任意用户输入），故直接 entries。
   */
  function rowsFromHeaders(headers: Record<string, string>): Array<{ key: string; value: string }> {
    // eslint-disable-next-line taste/no-unsafe-object-entries -- headers is a known schema Record<string,string>
    return Object.entries(headers).map(([k, v]) => ({ key: k, value: v }))
  }

  /**
   * 打开时的初始快照（用于 isDirty 对比，D13 取消确认）。
   * 每次 provider 变化重置编辑态后记录；手动改 form/localModels 后 isDirty=true。
   * 快照基础字段（name/api/baseUrl/authHeader）+ apiKey 状态（是否清空）+ models 整体序列化
   * + headers（W3 D7：headers 改也算 dirty）。
   */
  interface FormSnapshot {
    name: string
    api: string
    baseUrl: string
    /** apiKey 是否被「清除」（哨兵态或用户输入了值都算 dirty） */
    apiKeyChanged: boolean
    /** models 整体序列化（增删 + 内部字段如 compat/thinkingLevelMap/contextWindow/input 改都触发 dirty） */
    modelsJson: string
    /** provider 级 authHeader（W3 D7） */
    authHeader: boolean
    /** provider 级 headers 序列化（W3 D7：JSON 串对比，键值任一变更即 dirty） */
    headersJson: string
    /** 凭证形态（B-1：形态切换即 dirty，save-bar 出现） */
    authMethod: ProviderInfo['authMethod']
  }
  const snapshot = ref<FormSnapshot | null>(null)

  /** 记录当前 form/localModels 为初始快照（provider 切换/打开后调） */
  function captureSnapshot(): void {
    snapshot.value = {
      name: form.name,
      api: form.api,
      baseUrl: form.baseUrl,
      apiKeyChanged: form.apiKey !== '',
      modelsJson: JSON.stringify(localModels.value),
      authHeader: form.authHeader,
      headersJson: JSON.stringify(form.headers),
      authMethod: form.authMethod,
    }
  }

  /**
   * form 相对初始快照是否有变更（D13 取消确认 + W3 过期快照刷新用）。
   * 对比 name/api/baseUrl/apiKey 状态/models 整体/authHeader/headers。snapshot=null（未初始化）→ false。
   * models 用 JSON 串整体对比：增删 id 与内部字段（compat/thinkingLevelMap/contextWindow/input 等）
   * 任一变更都判 dirty——避免用户改 compat 等字段后 isDirty=false 静默丢改（问题 1）。
   */
  const isDirty = computed<boolean>(() => {
    const s = snapshot.value
    if (!s) return false
    if (form.name !== s.name) return true
    if (form.api !== s.api) return true
    if (form.baseUrl !== s.baseUrl) return true
    // apiKey：用户输入了值 或 点了清除（哨兵）都算变更
    const apiKeyChangedNow = form.apiKey !== ''
    if (apiKeyChangedNow !== s.apiKeyChanged) return true
    // models 整体对比（增删 + 内部字段改都触发 dirty）
    if (JSON.stringify(localModels.value) !== s.modelsJson) return true
    // W3 D7：authHeader / headers 变更即 dirty
    if (form.authHeader !== s.authHeader) return true
    if (JSON.stringify(form.headers) !== s.headersJson) return true
    // B-1：凭证形态切换即 dirty
    if (form.authMethod !== s.authMethod) return true
    return false
  })

  // ── UI 状态（pending / 结果显示）──

  const showKey = ref(false)
  const testing = ref(false)
  const discovering = ref(false)
  /** test 结果：ok=连接成功 / error=失败 / null=未测 */
  const testResult = ref<'ok' | 'error' | null>(null)
  /** test 模式按协议分组的连接结果（runtime results；空数组 = 无分组结果，如整体性失败） */
  const testResults = ref<TestConnectionResult[]>([])
  /** test 模式整体性失败原因（success=false 的 error；有分组结果时留空） */
  const testError = ref('')
  /** discover 结果文案（如「已发现 N 个模型，新增 M 个已合并」） */
  const discoverResult = ref('')
  const showAddModel = ref(false)
  const saving = ref(false)
  /** 动作错误（保存/测试/发现失败时显示在底栏，非静默吞） */
  const actionError = ref('')

  /**
   * 展开了 compat 编辑器的 model id 集合（手风琴态）。
   * 用 reactive Set（Vue 3.5+ 支持）+ 直接 mutate（add/delete），避免每次 toggle 复制整集。
   * per-provider-edit-session 状态：openModal 切换 provider 时 .clear() 重置。
   */
  const expandedCompat = reactive<Set<string>>(new Set())
  /** 切换某 model 的 compat 编辑器展开/收起（直接 mutate，不 new Set 复制——问题 5） */
  function toggleCompatExpand(modelId: string): void {
    if (expandedCompat.has(modelId)) expandedCompat.delete(modelId)
    else expandedCompat.add(modelId)
  }

  // ── provider 同步：打开/切换 provider 时重置编辑态 ──

  /** 瞬态态重置（编辑/新增两分支共用）：测试/发现结果、面板展开、错误提示。 */
  function resetTransientState(): void {
    showKey.value = false
    testResult.value = null
    testResults.value = []
    testError.value = ''
    discoverResult.value = ''
    showAddModel.value = false
    actionError.value = ''
    expandedCompat.clear()
  }

  watch(
    () => providerRef.value,
    (p) => {
      if (p) {
        // 编辑模式：用现有 provider 数据填充表单
        form.name = p.name
        form.api = p.api ?? 'anthropic-messages'
        form.baseUrl = p.baseUrl ?? ''
        form.apiKey = ''
        // W3 D7：回填 headers / authHeader
        form.headers = p.headers ? { ...p.headers } : {}
        form.authHeader = p.authHeader ?? false
        headerRows.value = rowsFromHeaders(form.headers)
        // B-1：凭证形态回填（oauth → 凭证区显示 OAuth 状态而非 apiKey 输入）
        form.authMethod = p.authMethod
        resetTransientState()
        localModels.value = toEditableModels(p)
      } else {
        // 新增模式：重置为初始空状态（providerRef 变 null 时触发，避免残留上次编辑数据）
        form.name = ''
        form.api = 'anthropic-messages'
        form.baseUrl = ''
        form.apiKey = ''
        form.headers = {}
        form.authHeader = false
        form.authMethod = undefined
        headerRows.value = []
        resetTransientState()
        localModels.value = []
      }
      // 记录初始快照（isDirty 对比基线）。重置后立即捕获，确保用户首次输入才变 dirty。
      captureSnapshot()
    },
    { immediate: true },
  )

  // ── 纯函数 helpers（template 也直接调）──

  /**
   * 从 thinkingLevelMap 反推策略预设（Select 回显当前选中）。按可用档位 key 判定：
   * 含 max→high-max；含 high（无 max）→on-off；空→all-levels。
   */
  function getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy {
    if (!map || Object.keys(map).length === 0) return 'all-levels'
    // 可用档位（key 存在且 value 非 null）
    const availableKeys = Object.keys(map).filter((k) => map[k] !== null)
    if (availableKeys.includes('max')) return 'high-max'
    if (availableKeys.includes('high')) return 'on-off'
    return 'all-levels'
  }

  // ── ② test/discover 编排（统一 runDiscover：testConnection 与 autoDiscover 共用）──

  /**
   * 请求构造（M3b/D4）：discover 显式带 mode（协议缺省即 discover，显式化防默认值将来变化）；
   * test 只需 providerId + mode——代表模型选择归 runtime（前端零推导，对齐 view-ready 原则），
   * baseUrl/apiKey/providerType 在 test 模式被 runtime 忽略故不发（baseUrl 是协议形状必填键，
   * 传 '' 占位）。两模式各自构造（非展开合并）：键序 = 协议序，不用的键根本不出现。
   */
  function buildDiscoverRequest(action: DiscoverAction): DiscoverModelsRequest {
    const providerId = providerRef.value?.id
    if (action === 'test') return { mode: 'test', baseUrl: '', providerId }
    return {
      mode: 'discover',
      baseUrl: form.baseUrl,
      providerId,
      providerType: form.api,
      apiKey: resolveApiKeyForSave(form.apiKey),
    }
  }

  /** test 结果消费（M3b）：分组结果与整体性失败互斥——成功走 results（每协议一行），失败走 error */
  function applyTestResult(res: DiscoverModelsResponse): void {
    testResults.value = res.results ?? []
    testError.value = res.success ? '' : res.error ?? ''
    testResult.value = res.success ? 'ok' : 'error'
    if (!res.success && res.error) actionError.value = res.error
  }

  /**
   * discover 结果消费：成功则合并去重入清单 + 结果文案，失败则写 actionError。
   * D9①：合并进来的模型出厂显式 reasoning（对齐 addModel）——pi 两级门控把缺失判「关」，
   * 缺字段会让思考档位恒只有「关」（失败模式 D 用户数据命中此入口）。
   */
  function applyDiscoverResult(res: DiscoverModelsResponse): void {
    if (!res.success) {
      actionError.value = res.error ?? t('composable.discoverFailed')
      return
    }
    const discovered = res.models ?? []
    const existing = new Set(localModels.value.map((m) => m.id))
    const merged = discovered.filter((m) => !existing.has(m.id))
    localModels.value.push(
      ...merged.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        reasoning: true,
      })),
    )
    discoverResult.value = t('composable.discoveredModels', { count: discovered.length, merged: merged.length > 0 ? t('composable.newMerged', { count: merged.length }) : t('composable.allExisted') })
  }

  /**
   * 统一探活（transport.discoverModels）：test 取 success→testResult；discover 合并 models +
   * discoverResult。本函数只留「置况 → 请求 → 分发结果 → 收尾」的线性骨架，分支细节在下游 helper。
   */
  async function runDiscover(action: DiscoverAction): Promise<void> {
    const isTest = action === 'test'
    if (isTest) {
      testing.value = true
      testResult.value = null
    } else {
      discovering.value = true
      discoverResult.value = ''
    }
    actionError.value = ''

    try {
      const res = await getSettingsTransport().discoverModels(buildDiscoverRequest(action))
      if (isTest) {
        applyTestResult(res)
        return
      }
      applyDiscoverResult(res)
    } catch (e) {
      if (isTest) testResult.value = 'error'
      actionError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (isTest) testing.value = false
      else discovering.value = false
    }
  }

  /** 测试连接（探活，复用 discoverModels，见 runDiscover 'test'） */
  async function testConnection(): Promise<void> {
    await runDiscover('test')
  }

  /** 自动发现模型（探活 + 合并到清单，见 runDiscover 'discover'） */
  async function autoDiscover(): Promise<void> {
    await runDiscover('discover')
  }

  // ── ④ save 持久化（校验 → transport.setProvider；D15b：name 空返回 ok:false）──

  /**
   * 保存：校验 → transport.setProvider。调用方据 result.ok emit close；
   * result.wroteApiKey 供父组件做「apikey 配置完成即自动启用」（ProviderPage afterApiKeySave）。
   */
  /**
   * 保存前校验：返回错误文案，null = 通过。
   * - D15b：供应商名称必填
   * - B-1 形态切换守卫：oauth → api_key 切换后必须提供新 key——确认弹窗承诺「退出 OAuth
   *   登录」，空 key 保存会让 auth.json OAuth 凭证残留（catalog 的覆写只发生在携带 apiKey 时）
   */
  function validateBeforeSave(): string | null {
    if (!form.name.trim()) return t('composable.providerNameRequired')
    if (snapshot.value?.authMethod === 'oauth' && form.authMethod === 'api_key'
      && resolveApiKeyForSave(form.apiKey) === undefined) {
      return t('composable.oauthSwitchNeedsKey')
    }
    return null
  }

  /**
   * setProvider 载荷构造（防线①：catalog / custom 的 provider 级字段分体系）。
   * isCatalog / baseUrl 由调用方先算后传（保持原求值时点）；条件键各自按 isCatalog 与 truthy 守卫
   * 决定带不带键。
   */
  function buildSetProviderPayload(isCatalog: boolean, baseUrl: string): SetProviderData {
    return {
      // 防线①：custom 空串 name 不带键（truthy 守卫，对齐 use-quick-setup-form 既有先例）；
      // catalog 的 name 是 provider 展示名（正常态非空），保持回传。
      ...(isCatalog || form.name.trim() ? { name: form.name } : {}),
      // 防线①：catalog 不带 type 键——协议是模型级属性，provider 级 api 对 catalog 无用户语义
      // （前端回传的是快照 artifact，runtime 侧对 catalog 的 type 同样忽略；不发是双保险）。
      ...(isCatalog ? {} : { type: form.api }),
      // 防线①：catalog 的 baseUrl **恒显式带键**（值 = trim 结果：非空 = 设置网关 / '' = 清除
      // 网关——「undefined = 不变」是既有 merge 协议，清空输入框必须走显式空串带键，否则网关
      // 回退通道不可达）；custom 空串不带键（runtime 对 custom 空串同样是「不变」）。
      ...(isCatalog || baseUrl ? { baseUrl } : {}),
      // D18：apiKey 空=不变（undefined）；哨兵=清空（''）；非空=原值
      apiKey: resolveApiKeyForSave(form.apiKey),
      // B-1：凭证形态回传（undefined = 不变；runtime 写 providers.json authMethod 标注）
      authMethod: form.authMethod,
      // W3 D7：headers（空对象时不传，避免覆盖 runtime 既有值）+ authHeader 回写。
      headers: Object.keys(form.headers).length > 0 ? form.headers : undefined,
      authHeader: form.authHeader,
      // 透传 model 级 api/baseUrl/enabled：runtime setProvider 用 spread 合并 base，
      // 缺字段会被 base 兜底，但显式回传避免「编辑保存丢字段」（P1 bug #4/#5）。
      // B-2：catalog provider 的 localModels 只含 override 条目（toEditableModels）——
      // builtin 不回传，runtime 合并语义 builtin ∪ override 会自动补齐内置模型。
      models: localModels.value.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        contextWindow: m.contextWindow,
        input: m.input,
        thinkingLevelMap: m.thinkingLevelMap,
        // B-4b 透传（round-trip 接通）：reasoning/maxTokens/cost/headers 有值才回传
        // （undefined 不传键，runtime 语义 undefined=不变、base spread 保留既有值；
        // 与 provider 级 headers「空对象不传」不同——model 级 {} = 清空是 runtime 的
        // 两态契约，此处值忠实回传）。reasoning 显式 false 是合法值，须用 !== undefined 判定。
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
        ...(m.cost !== undefined ? { cost: m.cost } : {}),
        ...(m.headers !== undefined ? { headers: m.headers } : {}),
        compat: m.compat,
        enabled: m.enabled,
      })),
    }
  }

  /**
   * 保存：校验 → transport.setProvider。调用方据 result.ok emit close；
   * result.wroteApiKey 供父组件做「apikey 配置完成即自动启用」（ProviderPage afterApiKeySave）。
   */
  async function save(): Promise<SaveResult> {
    const validationError = validateBeforeSave()
    if (validationError) {
      actionError.value = validationError
      return { ok: false, wroteApiKey: false }
    }
    saving.value = true
    actionError.value = ''
    const providerId = providerRef.value?.id ?? form.name
    // 防线①（设计 D1）：catalog / custom 的 provider 级字段分体系。kind 缺失（旧数据 / 新建态
    // 无 providerRef）按 custom 处理（自定义 provider 需要 provider 级协议）。
    const isCatalog = providerRef.value?.kind === 'catalog'
    // 网关输入框值：trim 后判定（纯空白串与空串同视，runtime 侧同样按 trim 判定）
    const baseUrl = form.baseUrl.trim()
    try {
      await getSettingsTransport().setProvider(providerId, buildSetProviderPayload(isCatalog, baseUrl))
      // 哨兵→''、空→undefined 均为 falsy：只有本次真正写入非空 key（明文或 $ENV 引用）才 true
      return { ok: true, wroteApiKey: Boolean(resolveApiKeyForSave(form.apiKey)) }
    } catch (e) {
      actionError.value = e instanceof Error ? e.message : String(e)
      return { ok: false, wroteApiKey: false }
    } finally {
      saving.value = false
    }
  }

  /** 清除 apiKey（D18）：置哨兵，save 时识别为清空。仅已配置 key 时有意义 */
  function clearApiKey(): void {
    form.apiKey = API_KEY_CLEAR_SENTINEL
  }

  // ── headers 行编辑 CRUD（W3 D7）：headerRows UI 行态 ↔ form.headers Record ──

  /** 把 headerRows 同步回 form.headers（filter 掉空 key 的行 + 重复 key 校验） */
  function syncHeadersFromRows(): void {
    const { headers, hasDuplicate } = buildHeadersFromRows(headerRows.value)
    form.headers = headers
    if (hasDuplicate) {
      actionError.value = t('composable.duplicateHeaderKey')
    } else if (actionError.value === t('composable.duplicateHeaderKey')) {
      actionError.value = ''
    }
  }
  /** 新增一个空 header 行 */
  function addHeader(): void {
    headerRows.value.push({ key: '', value: '' })
  }
  /** 移除指定下标的 header 行，并同步回 form.headers */
  function removeHeader(index: number): void {
    headerRows.value.splice(index, 1)
    syncHeadersFromRows()
  }

  // ── ③ 模型清单 CRUD ──

  /** 行级输入类型 toggle（点击 text/image icon 切换） */
  function toggleInput(m: LocalModel, type: 'text' | 'image'): void {
    if (!m.input) m.input = []
    const idx = m.input.indexOf(type)
    if (idx >= 0) m.input.splice(idx, 1)
    else m.input.push(type)
  }

  /** 新增模型表单的输入类型 toggle（多选，与行级 toggleInput 同语义） */
  function toggleNewInput(type: 'text' | 'image'): void {
    const idx = newModel.inputTypes.indexOf(type)
    if (idx >= 0) newModel.inputTypes.splice(idx, 1)
    else newModel.inputTypes.push(type)
  }

  /** 行级上下文窗口更新（Select） */
  function updateCtx(m: LocalModel, value: number): void {
    m.contextWindow = value
  }

  /**
   * 行级思考策略（Select → 写 thinkingLevelMap）。
   * D9②：reasoning 缺失时补显式 true——pi 两级门控把缺失判「关」，不补则用户设的策略
   * 根本轮不到被读取（弹层只显示「关」）。永不覆盖用户显式 false（显式选择优先于联动）；
   * all-levels 与其余策略同规则——存量最常见形态正是「从未设策略 = all-levels + reasoning
   * 缺失」，救回路径必须闭合在 all-levels 分支上。
   */
  function pickStrategy(m: LocalModel, strategy: ThinkingStrategy): void {
    if (m.reasoning === undefined) m.reasoning = true
    m.thinkingLevelMap = THINKING_PRESETS[strategy]
      ? structuredClone(THINKING_PRESETS[strategy])
      : undefined
  }

  /**
   * 新增模型到清单（来自底部新增表单）。
   * D15a：空名/重名 id 抛错（调用方 catch 后填 actionError），替代原静默 return。
   * 抛错而非静默：AGENTS.md 关键规则 #3——用户操作无反馈是 bug。
   */
  function addModel(): void {
    const name = newModel.name.trim()
    if (!name) throw new Error(t('composable.modelNameRequired'))
    // 重复 id 校验：localModels 已含同 id → 抛错
    if (localModels.value.some((m) => m.id === name)) {
      throw new Error(t('composable.modelAlreadyExists', { name }))
    }
    localModels.value.push({
      id: name,
      name,
      contextWindow: newModel.contextWindow,
      input: [...newModel.inputTypes],
      thinkingLevelMap: THINKING_PRESETS[newModel.thinking]
        ? structuredClone(THINKING_PRESETS[newModel.thinking])
        : undefined,
      // D4：reasoning 显式 boolean 出厂（不 undefined）——pi 两级门控把缺失判为「关」，
      // 手加模型静默丢字段会让思考档全被钳回 off（事故 B 根因 ②）。
      reasoning: newModel.reasoning,
    })
    newModel.name = ''
  }

  /** 移除清单中指定下标的模型 */
  function removeModel(index: number): void {
    localModels.value.splice(index, 1)
  }

  // ── D8：编辑弹窗过期快照刷新 ──
  // 弹窗打开期间若外部广播更新了同 provider（onProviders 整体替换 store.providers），
  // 弹窗表单不刷新会覆盖并发变更。watch store.providers，仅在「用户未手动改」（!isDirty）时
  // 重新快照 form（name/api/baseUrl/headers/authHeader/models），用户改动优先（isDirty=true 不刷新）。
  const settingsStore = getSettingsStore()
  watch(
    () => settingsStore.providers.value,
    (list) => {
      // 仅编辑态（providerRef 非 null）刷新；新增态无 provider 可对齐。
      const editingId = providerRef.value?.id
      if (!editingId) return
      const fresh = list.find((p) => p.id === editingId)
      if (!fresh) return
      if (isDirty.value) {
        // [BL round1 S4] dirty 单字段例外：用户未手动切换凭证形态（form.authMethod 仍等于
        // 快照值）而广播携带新形态（编辑体内发起 OAuth 授权 → 父组件 setProvider
        // authMethod='oauth' 回推）→ 强制对齐该字段并单独重拍快照的 authMethod 位，
        // 否则后续 save 会用本地旧形态覆写刚写入的 oauth 标注（apiKey 有值还会覆写凭证）。
        // 用户已手动切换（pending 未保存）则不对齐——本地切换意图优先。
        const s = snapshot.value
        if (s && form.authMethod === s.authMethod && form.authMethod !== fresh.authMethod) {
          form.authMethod = fresh.authMethod
          s.authMethod = fresh.authMethod
        }
        return
      }
      // 同步基础字段 + headers/authHeader + models
      form.name = fresh.name
      form.api = fresh.api ?? 'anthropic-messages'
      form.baseUrl = fresh.baseUrl ?? ''
      form.headers = fresh.headers ? { ...fresh.headers } : {}
      form.authHeader = fresh.authHeader ?? false
      headerRows.value = rowsFromHeaders(form.headers)
      // B-1：凭证形态对齐最新广播（如编辑体内 OAuth 登录成功后 authMethod='oauth' 回推）。
      // 此处 isDirty 已为 false（上方守卫），用户未手动切形态，直接对齐安全。
      form.authMethod = fresh.authMethod
      localModels.value = toEditableModels(fresh)
      // 刷新后重新捕获快照（新基线，避免下次广播触发不必要的「dirty」）
      captureSnapshot()
    },
    { deep: true },
  )

  return {
    // 状态（template 绑定）
    form,
    newModel,
    localModels,
    headerRows,
    showKey,
    testing,
    discovering,
    testResult,
    testResults,
    testError,
    discoverResult,
    showAddModel,
    saving,
    actionError,
    /** 展开了 compat 编辑器的 model id 集合（手风琴态） */
    expandedCompat,
    /** form 相对打开时快照是否有变更（D13 取消确认 + W3 过期快照刷新用） */
    isDirty,
    // 纯函数 helper
    getStrategyFromMap,
    // 编排
    testConnection,
    autoDiscover,
    save,
    /** 清除 apiKey（D18）：置哨兵，save 时识别为清空 */
    clearApiKey,
    // 模型 CRUD
    toggleInput,
    toggleNewInput,
    updateCtx,
    pickStrategy,
    addModel,
    removeModel,
    /** 切换某 model 的 compat 编辑器展开/收起 */
    toggleCompatExpand,
    // headers CRUD（W3 D7）
    addHeader,
    removeHeader,
    syncHeadersFromRows,
  }
}
