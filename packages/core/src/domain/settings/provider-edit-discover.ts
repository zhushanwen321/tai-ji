/**
 * provider-edit-discover —— Provider 编辑「test / discover 探活」module（[C4] 拆分自
 * use-provider-edit.ts）。runDiscover 是「置况 → 请求 → 分发结果 → 收尾」的线性骨架，
 * 分支细节在下游 helper（buildDiscoverRequest / applyTestResult / applyDiscoverResult）。
 *
 * - test（探活）：M3b 协议分流——只发 providerId + mode（代表模型选择归 runtime，前端零推导），
 *   结果消费 results（每协议一行）/ error（整体性失败）
 * - discover（自动发现）：带 baseUrl/apiKey/providerType 全参，结果合并入模型清单（去重 + D9①）
 *
 * 接口即测试面（interface is the test surface）：行为矩阵见 provider-edit-discover.test.ts。
 */
import { ref, type Ref } from 'vue'
import type { ConnectionTestResultRow, ProviderInfo } from '@taiji/shared'
import { getSettingsTransport } from './transport'
import type { DiscoverModelsRequest, DiscoverModelsResponse } from './transport'
import type { Translate } from './provider-edit-types'
import { resolveApiKeyForSave, type ProviderEditFormDraft } from './provider-edit-form'
import type { ProviderEditModelsModule } from './provider-edit-models'

/** discover 动作：test（探活，结果显示连接成败）/ discover（合并发现的模型） */
export type DiscoverAction = 'test' | 'discover'

/**
 * 测试连接按协议分组的单条结果（runtime `config.discoveredModels.results` 元素，设计 §3.5 D4）：
 * 每协议一条，代表模型 + 成败 + 失败时的真实原因（HTTP 状态码与响应截断）。
 * 形状 SSOT = shared ConnectionTestResultRow（S-9 收编，本名保留为域内语义别名）。
 */
export type TestConnectionResult = ConnectionTestResultRow

/**
 * test / discover 探活 module（[C4] 3 组子 interface 之一）。
 */
export interface ProviderEditDiscoverModule {
  /** test 进行中 */
  readonly testing: Ref<boolean>
  /** discover 进行中 */
  readonly discovering: Ref<boolean>
  /** test 结果：ok=连接成功 / error=失败 / null=未测 */
  readonly testResult: Ref<'ok' | 'error' | null>
  /** test 模式按协议分组的连接结果（runtime results；空数组 = 无分组结果，如整体性失败） */
  readonly testResults: Ref<TestConnectionResult[]>
  /** test 模式整体性失败原因（success=false 的 error；有分组结果时留空） */
  readonly testError: Ref<string>
  /** discover 结果文案（如「已发现 N 个模型，新增 M 个已合并」） */
  readonly discoverResult: Ref<string>
  /** 测试连接（探活，复用 discoverModels，见 runDiscover 'test'） */
  testConnection(): Promise<void>
  /** 自动发现模型（探活 + 合并到清单，见 runDiscover 'discover'） */
  autoDiscover(): Promise<void>
  /** 瞬态态重置（provider 切换/打开时）：测试/发现结果 */
  resetTransient(): void
}

/** module 工厂输入 */
export interface ProviderEditDiscoverInputs {
  /** 当前编辑的 provider（null = 新增态；test/discover 的 providerId 来源） */
  providerRef: Ref<ProviderInfo | null>
  /** 表单草稿（discover 请求的 baseUrl/apiKey/providerType 来源） */
  draft: ProviderEditFormDraft
  /**
   * 动作错误写通道（MF-1-7 带来源标签协议）：本 module 的写入固定归属 discover，
   * 标签由装配方（use-provider-edit）落——错误归属按 source 判定，不比对展示文案。
   */
  reportActionError: (message: string) => void
  /** 动作错误清除（runDiscover 置况阶段清旧错误） */
  clearActionError: () => void
  /** 模型清单 module（discover 合并目标） */
  models: ProviderEditModelsModule
  /** TC4 注入：t（i18n 翻译函数） */
  t: Translate
}

export function createProviderEditDiscover(input: ProviderEditDiscoverInputs): ProviderEditDiscoverModule {
  const { providerRef, draft, reportActionError, clearActionError, models, t } = input

  const testing = ref(false)
  const discovering = ref(false)
  const testResult = ref<'ok' | 'error' | null>(null)
  const testResults = ref<TestConnectionResult[]>([])
  const testError = ref('')
  const discoverResult = ref('')

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
      baseUrl: draft.baseUrl,
      providerId,
      providerType: draft.api,
      apiKey: resolveApiKeyForSave(draft.apiKey),
    }
  }

  /** test 结果消费（M3b）：分组结果与整体性失败互斥——成功走 results（每协议一行），失败走 error */
  function applyTestResult(res: DiscoverModelsResponse): void {
    testResults.value = res.results ?? []
    testError.value = res.success ? '' : res.error ?? ''
    testResult.value = res.success ? 'ok' : 'error'
    if (!res.success && res.error) reportActionError(res.error)
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
    clearActionError()

    try {
      const res = await getSettingsTransport().discoverModels(buildDiscoverRequest(action))
      if (isTest) {
        applyTestResult(res)
        return
      }
      applyDiscoverResult(res)
    } catch (e) {
      if (isTest) testResult.value = 'error'
      reportActionError(e instanceof Error ? e.message : String(e))
    } finally {
      if (isTest) testing.value = false
      else discovering.value = false
    }
  }

  async function testConnection(): Promise<void> {
    await runDiscover('test')
  }

  async function autoDiscover(): Promise<void> {
    await runDiscover('discover')
  }

  function resetTransient(): void {
    testResult.value = null
    testResults.value = []
    testError.value = ''
    discoverResult.value = ''
  }

  return {
    testing,
    discovering,
    testResult,
    testResults,
    testError,
    discoverResult,
    testConnection,
    autoDiscover,
    resetTransient,
  }
}
