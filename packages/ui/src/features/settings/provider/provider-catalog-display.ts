/**
 * provider 编辑体的展示 / 接线 composable（设计 catalog-provider-field-authority §3.3 D5 + D4）。
 *
 * 从 ProviderEditBody 抽出：该组件受 eslint `max-lines`（500）与 `.githooks/vue_rules_checker.py`
 * 的 `<script setup>` ≤300 行约束，本块展示/派生逻辑内聚、无渲染依赖，按仓库既有先例
 * （ProviderTestDiscoverSection 纯展示块抽件）提取。M4 第二轮把「测试连接接线」一并并入：
 * ProviderTestDiscoverSection 的 M3b 4 个新增 props（providerKind/testResults/testError/
 * providerBaseUrl）在此派生后经 `testDiscoverProps` 整体 v-bind 下发，组件不再逐个解构 test 状态。
 *
 * 职责边界：runtime 聚合层已下发 provider 级派生值（ProviderInfo.api/baseUrl，前端零推导）；
 * 本模块只做**展示转译 + props 接线**——单值直接展示、undefined 按合并模型集归类为
 * 「按模型分发 / 内置目录未提供」（两种事实都下发 undefined，归类需要模型集规模信息，故对已下发的
 * provider.models 做计数归集，不重算派生规则本身）；测试结果状态原样透传，不做二次解释。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ProviderInfo } from '@taiji/shared'
import type { useProviderEdit, TestConnectionResult } from '@taiji/core/domain/settings'

/** i18n 翻译函数（vue-i18n global.t 消费侧的最小结构类型） */
type Translate = (key: string, named?: Record<string, unknown>) => string

/**
 * useProviderEdit 的返回值（本模块从它读取 form / test 状态 / 模型数）。
 * 取 ReturnType 而非结构切片：`testResults` 的元素类型必须与子组件声明同源，重复声明会漂移。
 */
type ProviderEditState = ReturnType<typeof useProviderEdit>

/** 非空字段值 → 出现次数（展示用分布：协议分布 / 端点分布） */
function countNonEmpty(values: Array<string | undefined>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return counts
}

/** 分布文案（按值升序，输出稳定；如「anthropic-messages ×2 / openai-completions ×20」） */
function distributionText(counts: Map<string, number>, t: Translate): string {
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([api, count]) => t('settings.providerEdit.apiDistributionItem', { api, count }))
    .join(' / ')
}

/** ProviderTestDiscoverSection 的 props 快照（键名 = 子组件 props，v-bind 整体直传） */
export interface ProviderTestDiscoverBindings {
  testing: boolean
  discovering: boolean
  testResult: 'ok' | 'error' | null
  /** M3b：按协议分组的测试结果（runtime config.discoveredModels.results，原样透传） */
  testResults: TestConnectionResult[]
  /** M3b：整体性失败原因（success=false 的 error） */
  testError: string
  discoverResult: string
  modelCount: number
  /** M3b：catalog 不渲染「模型发现」（pi 无 fetchModels） */
  providerKind: 'catalog' | 'custom'
  /** M3b：失败指引展示的生效端点（见 effectiveBaseUrl 注释） */
  providerBaseUrl: string
}

export interface CatalogDisplayState {
  /** 「类型」只读文案：单协议 → 协议名；混合 → 「按模型分发（分布）」；无 → 空值占位 */
  apiText: ComputedRef<string>
  /** 端点输入草稿（初值 = 用户网关或 ''；用户输入同步进 form.baseUrl） */
  endpointDraft: Ref<string>
  /** 端点框下方标注：填写 = 自定义网关；留空 = 内置端点态三态之一 */
  endpointHint: ComputedRef<string>
  /** 端点输入处理（草稿 + form.baseUrl 同步） */
  onEndpointInput: (value: string | number) => void
  /** 保存前归一：catalog 的端点语义 = 输入框值（'' = 显式清除网关；绝不回写派生值） */
  syncBeforeSave: () => void
  /** 测试连接区全部 props（含 M3b 4 个新增项），组件 v-bind 直传即可 */
  testDiscoverProps: ComputedRef<ProviderTestDiscoverBindings>
}

/**
 * @param provider 当前编辑的 provider（prop ref）
 * @param edit useProviderEdit 的返回值（本模块读取 form 写 baseUrl，读取 test 状态转 props）
 * @param t i18n 翻译函数
 * @param isCatalog 是否 catalog 体系（custom 不走派生展示）
 */
export function useCatalogDisplay(
  provider: Ref<ProviderInfo | null>,
  edit: ProviderEditState,
  t: Translate,
  isCatalog: ComputedRef<boolean>,
): CatalogDisplayState {
  const { form } = edit
  const apiCounts = computed(() => countNonEmpty((provider.value?.models ?? []).map(m => m.api)))
  const baseUrlCounts = computed(() => countNonEmpty((provider.value?.models ?? []).map(m => m.baseUrl)))

  const apiText = computed<string>(() => {
    const derived = provider.value?.api
    if (derived !== undefined) return derived
    if (apiCounts.value.size === 0) return t('settings.provider.builtinTemplate.emptyValue')
    return t('settings.providerEdit.apiMixedDetail', { distribution: distributionText(apiCounts.value, t) })
  })

  /**
   * 用户网关值（undefined = 无网关）。
   *
   * ProviderInfo.baseUrl 是 D5 的**两级值**（用户网关优先、否则模型集派生），shared 类型无
   * 「来源」判别字段，故按 D5 判定锚归类：派生值恒等于合并模型集的唯一非空 baseUrl；用户网关
   * 则是对全部模型的覆盖式替换（与模型值必然不同）。端点输入框只在存在用户网关时回填——
   * 派生值回填会被 save 当作用户网关写回（artifact 冻结，正是 D5/M1a 要消灭的形态）。
   */
  const gatewayUrl = computed<string | undefined>(() => {
    const derived = provider.value?.baseUrl
    if (!isCatalog.value || derived === undefined) return undefined
    const values = [...baseUrlCounts.value.keys()]
    return values.length === 1 && values[0] === derived ? undefined : derived
  })

  /**
   * 端点输入草稿：初值 = 用户网关或 ''（留空 = 内置端点）。与 form.baseUrl 的初值
   * （runtime 派生值）刻意不同——派生值不是用户网关，不回填、不改写 form（改写会凭空造出
   * dirty）；只有用户真实输入才同步进 form.baseUrl（save 读它）。
   */
  const endpointDraft = ref('')
  watch([provider, isCatalog], () => {
    endpointDraft.value = isCatalog.value ? (gatewayUrl.value ?? '') : ''
  }, { immediate: true })

  /**
   * 端点输入：草稿即用户意图。调用方用 :model-value + @update:model-value 而非 v-model——
   * 需要区分「用户输入」与「provider 切换时的草稿回填」，后者由上面的 watch 负责且不得改写
   * form.baseUrl（否则 form.baseUrl 被置空而快照仍是派生值 → 无端 dirty）。
   */
  function onEndpointInput(value: string | number): void {
    endpointDraft.value = String(value)
    if (isCatalog.value) form.baseUrl = endpointDraft.value
  }

  const endpointHint = computed<string>(() => {
    const draft = endpointDraft.value.trim()
    if (draft) {
      return `${t('settings.providerEdit.endpointGateway', { url: draft })}（${t('settings.providerEdit.endpointGatewayCovers')}）`
    }
    const values = [...baseUrlCounts.value.keys()]
    if (values.length > 1) return t('settings.providerEdit.endpointBuiltinMixed')
    // 单值派生：标注内置端点并展示当前派生端点值（同 pi 生效端点）
    if (values.length === 1) return `${t('settings.providerEdit.endpointBuiltin')} · ${values[0]}`
    return t('settings.providerEdit.endpointNotProvided')
  })

  function syncBeforeSave(): void {
    if (isCatalog.value) form.baseUrl = endpointDraft.value
  }

  /**
   * 生效端点（testHintHttpError 的 {baseUrl} 展示值）：取 ProviderInfo.baseUrl——D5 两级值
   * （用户网关 override 优先，否则模型集派生），即已持久化、runtime 测试连接时真正使用的端点。
   * **不取 form.baseUrl**：catalog 的表单初值是 runtime 派生值回填（artifact，非用户网关），
   * 且用户输入未保存时尚未生效；custom 的 provider 级 baseUrl 同样是定义权威。
   */
  const effectiveBaseUrl = computed<string>(() => provider.value?.baseUrl ?? '')

  /**
   * 测试连接区 props（M3b 接线）：test 状态原样透传，仅 kind 与端点在此派生。
   * 组件侧 v-bind 直传，避免逐个解构 4 个新 props 撑破行数上限。
   */
  const testDiscoverProps = computed<ProviderTestDiscoverBindings>(() => ({
    testing: edit.testing.value,
    discovering: edit.discovering.value,
    testResult: edit.testResult.value,
    testResults: edit.testResults.value,
    testError: edit.testError.value,
    discoverResult: edit.discoverResult.value,
    modelCount: edit.localModels.value.length,
    providerKind: isCatalog.value ? 'catalog' : 'custom',
    providerBaseUrl: effectiveBaseUrl.value,
  }))

  return { apiText, endpointDraft, endpointHint, onEndpointInput, syncBeforeSave, testDiscoverProps }
}
