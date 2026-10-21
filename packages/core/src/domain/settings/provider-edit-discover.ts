/**
 * provider-edit-discover —— Provider 编辑「discover + per-model 测试」编排 module（[C4] 拆分自
 * use-provider-edit.ts）。
 *
 * - autoDiscover：带 baseUrl/apiKey/providerType 全参，结果合并入模型清单（去重 + D9①）
 *   apiKey 取「真实未保存草稿」投影（回显值 = 所存值不发，MF-1-1），由装配方注入 pendingApiKey
 * - testModel（2026-10-21 per-model 行内入口）：只测指定模型——测试入口从凭据区「测试连接」
 *   按钮下沉到每个模型行（用户拍板移除一键全测；provider 级分组测试 RPC 保留作协议兼容，
 *   core/ui 不再消费）。结果写 modelTestResults[modelId]，行内展示成败 + 真实失败原因。
 *
 * 接口即测试入口（interface is the test surface）：行为矩阵见 provider-edit-discover.test.ts。
 */
import { computed, ref, type Ref } from 'vue'
import type { ConnectionTestResultRow, ProviderInfo } from '@taiji/shared'
import { toErrorMessage } from '../../utils/error-message'
import { getSettingsTransport } from './transport'
import type { DiscoverModelsRequest, DiscoverModelsResponse } from './transport'
import type { Translate } from './provider-edit-types'
import type { ProviderEditFormDraft } from './provider-edit-form'
import type { ProviderEditModelsModule } from './provider-edit-models'

/**
 * 单模型行内测试的单条结果（runtime `config.discoveredModels.results` 元素）：
 * 成败 + 失败时的真实原因（HTTP 状态码与响应截断）+ 往返耗时。
 * 形状 SSOT = shared ConnectionTestResultRow（S-9 收编，本名保留为域内语义别名）。
 */
export type TestConnectionResult = ConnectionTestResultRow

/**
 * discover + per-model 测试 module（[C4] 3 组子 interface 之一）。
 */
export interface ProviderEditDiscoverModule {
  /** discover 进行中 */
  readonly discovering: Ref<boolean>
  /** discover 结果文案（如「已发现 N 个模型，新增 M 个已合并」） */
  readonly discoverResult: Ref<string>
  /** 单模型测试进行中的 modelId 列表（行内按钮 spinner 态） */
  readonly testingModelIds: Ref<string[]>
  /** 单模型测试结果（key = modelId；每轮覆盖写该 key，跨轮保留其他模型结果） */
  readonly modelTestResults: Ref<Record<string, TestConnectionResult>>
  /** 测试可用性（providerRef 非空 = 已保存 provider）：新增态测试按钮据此禁用（见 testModel） */
  readonly canTest: Ref<boolean>
  /** 自动发现模型（探活 + 合并到清单，见 runDiscover） */
  autoDiscover(): Promise<void>
  /** 单模型行内测试（只测该模型；顶层 provider 级失败走 reportActionError，行内不覆盖旧结果） */
  testModel(modelId: string): Promise<void>
  /** 瞬态态重置（provider 切换/打开时）：discover 结果 + per-model 测试状态 */
  resetTransient(): void
}

/** module 工厂输入 */
export interface ProviderEditDiscoverInputs {
  /** 当前编辑的 provider（null = 新增态；discover/testModel 的 providerId 来源） */
  providerRef: Ref<ProviderInfo | null>
  /** 表单草稿（discover 请求的 baseUrl/providerType 来源） */
  draft: ProviderEditFormDraft
  /**
   * discover 请求的 apiKey 取值器（MF-1-1）：「真实未保存草稿」投影——回显值（= 所存值）
   * 不算待保存，返回 undefined 让 runtime 走 resolver；清除哨兵经 resolveApiKeyForSave
   * 转成 ''（wire 语义 = 不带 key，runtime 走 resolver——discover 不承担凭据删除，删除由 save
   * 承担）。装配方注入 form 的同源判据，避免 discover 自建第二套谓词。
   */
  pendingApiKey: () => string | undefined
  /**
   * 动作错误写通道（MF-1-7 带来源标签协议）：本 module 的写入固定归属 discover，
   * 标签由装配方（use-provider-edit）落——错误归属按 source 判定，不比对展示文案。
   */
  reportActionError: (message: string) => void
  /** 动作错误清除（动作发起时清旧错误） */
  clearActionError: () => void
  /** 模型清单 module（discover 合并目标） */
  models: ProviderEditModelsModule
  /** TC4 注入：t（i18n 翻译函数） */
  t: Translate
}

export function createProviderEditDiscover(input: ProviderEditDiscoverInputs): ProviderEditDiscoverModule {
  const { providerRef, draft, pendingApiKey, reportActionError, clearActionError, models, t } = input

  const discovering = ref(false)
  const discoverResult = ref('')
  const testingModelIds = ref<string[]>([])
  const modelTestResults = ref<Record<string, TestConnectionResult>>({})
  /**
   * 测试可用性：testModel 的 providerId 取自已保存 provider（runtime 凭据 resolver 按
   * providerId 路由），新增态（providerRef = null）无 providerId 可测。UI 按此禁用按钮
   * + tooltip 提示先保存；testModel 内的静默 return 仅作直调兜底，不承担用户反馈。
   */
  const canTest = computed(() => providerRef.value !== null)

  /**
   * discover 请求构造：显式带 mode（协议缺省即 discover，显式化防默认值将来变化）；
   * baseUrl 是协议形状必填键，discover 模式必填。
   */
  function buildDiscoverRequest(): DiscoverModelsRequest {
    return {
      mode: 'discover',
      baseUrl: draft.baseUrl,
      providerId: providerRef.value?.id,
      providerType: draft.api,
      apiKey: pendingApiKey(),
    }
  }

  /**
   * discover 结果消费：成功则合并去重入清单 + 结果文案，失败则写 actionError。
   * D9①：合并进来的模型出厂显式 reasoning（对齐 addModel）——规则在 models.mergeDiscovered。
   */
  function applyDiscoverResult(res: DiscoverModelsResponse): void {
    if (!res.success) {
      reportActionError(res.error ?? t('composable.discoverFailed'))
      return
    }
    const { total, addedCount } = models.mergeDiscovered(res.models ?? [])
    discoverResult.value = t('composable.discoveredModels', { count: total, merged: addedCount > 0 ? t('composable.newMerged', { count: addedCount }) : t('composable.allExisted') })
  }

  async function autoDiscover(): Promise<void> {
    discovering.value = true
    discoverResult.value = ''
    clearActionError()
    try {
      applyDiscoverResult(await getSettingsTransport().discoverModels(buildDiscoverRequest()))
    } catch (e) {
      reportActionError(toErrorMessage(e))
    } finally {
      discovering.value = false
    }
  }

  /**
   * 单模型行内测试（per-model 入口）：runtime 侧凭据解析与 baseUrl 回落链与 provider 级
   * 测试同源。顶层 success:false = provider 级硬停（no_api_key 等，无行可报）→ actionError；
   * 行级失败（HTTP / 网络 / unsupported）如实写 modelTestResults，由行内结果条展示。
   */
  async function testModel(modelId: string): Promise<void> {
    if (testingModelIds.value.includes(modelId)) return
    const providerId = providerRef.value?.id
    // 新增态无 providerId（UI 已按 canTest 禁用按钮，此 return 仅直调兜底）
    if (!providerId) return
    clearActionError()
    testingModelIds.value = [...testingModelIds.value, modelId]
    try {
      // test 模式 baseUrl 协议必填占位（runtime 忽略，端点回落链归 runtime）
      const res = await getSettingsTransport().discoverModels({ mode: 'test', baseUrl: '', providerId, modelId })
      if (!res.success) {
        reportActionError(res.error ?? t('composable.discoverFailed'))
        return
      }
      const row = res.results?.[0]
      if (row) modelTestResults.value = { ...modelTestResults.value, [modelId]: row }
    } catch (e) {
      reportActionError(toErrorMessage(e))
    } finally {
      testingModelIds.value = testingModelIds.value.filter(id => id !== modelId)
    }
  }

  function resetTransient(): void {
    discoverResult.value = ''
    testingModelIds.value = []
    modelTestResults.value = {}
  }

  return {
    discovering,
    discoverResult,
    testingModelIds,
    modelTestResults,
    canTest,
    autoDiscover,
    testModel,
    resetTransient,
  }
}
