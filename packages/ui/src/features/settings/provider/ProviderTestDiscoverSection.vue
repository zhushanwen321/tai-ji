<template>
  <!--
    ProviderTestDiscoverSection —— 「测试连接 / 模型发现」按钮行 + 结果反馈。
    从 ProviderEditBody 抽出的独立模板块（纯展示 + 事件上抛，零内部状态）：
    RPC 编排与结果状态（testing/discovering/testResult/testResults/testError/discoverResult）
    由父组件的 useProviderEdit 持有，本组件经 @test/@discover 通知父组件发起。

    M3b（设计 D4）：测试连接改为「按协议分组」结果展示——runtime 按模型 api 分组发真实
    最小请求，每协议一行（代表模型 + 成败 + 真实失败原因）；「模型发现」（GET /v1/models）
    只对 custom provider 渲染——catalog 的模型清单是 pi 编译期权威（pi 无 fetchModels），
    发现无语义且现状必失败。
  -->
  <div>
    <div class="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        class="gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-mid [&_svg]:size-3.5"
        :disabled="testing || discovering"
        @click="emit('test')"
      >
        <Loader2 v-if="testing" class="animate-spin" />
        <Wifi v-else />
        {{ testing ? t('settings.providerEdit.testing') : t('settings.providerEdit.testConnection') }}
      </Button>
      <!-- M3b：catalog provider 不渲染「模型发现」（pi 无 fetchModels，清单编译期权威） -->
      <Button
        v-if="canDiscover"
        variant="secondary"
        class="gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-mid [&_svg]:size-3.5"
        :disabled="discovering || testing"
        @click="emit('discover')"
      >
        <Loader2 v-if="discovering" class="animate-spin" />
        <RefreshCw v-else />
        {{ discovering ? t('settings.providerEdit.discovering') : t('settings.providerEdit.autoDiscover') }}
      </Button>
    </div>

    <!-- 按协议分组结果（test 模式 results 非空） -->
    <div v-if="testRows.length > 0" class="mt-2 space-y-1" data-testid="provider-test-results">
      <div class="text-[11px] font-semibold text-neutral-mid">{{ t('settings.providerEdit.testConnTitle') }}</div>
      <div
        v-for="row in testRows"
        :key="row.key"
        class="flex items-start gap-1.5 text-[12px]"
        :class="row.ok ? 'text-success' : 'text-danger'"
      >
        <CheckCircle2 v-if="row.ok" class="size-3.5 shrink-0" />
        <AlertCircle v-else class="size-3.5 shrink-0" />
        <span>{{ row.text }}</span>
      </div>
    </div>

    <!-- 整体性失败（无分组结果，如未找到 API Key / 无可用模型） -->
    <div
      v-else-if="testResult === 'error'"
      class="mt-2 flex items-center gap-1.5 text-[12px] text-danger"
      data-testid="provider-test-overall-error"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      {{ overallMessage || t('settings.providerEdit.testFail') }}
    </div>

    <!-- 旧成功反馈行（runtime 未回分组结果时的兜底） -->
    <div
      v-else-if="testResult === 'ok'"
      class="mt-2 flex items-center gap-1.5 text-[12px] text-success"
      data-testid="provider-test-ok"
    >
      <CheckCircle2 class="size-3.5 shrink-0" />
      {{ t('settings.providerEdit.testOk', { count: modelCount }) }}
    </div>

    <!-- 恢复指引（按失败类型，testHint* 系列；无对应失败类型则不渲染） -->
    <div v-if="recoveryHints.length > 0" class="mt-1 space-y-0.5" data-testid="provider-test-hints">
      <div v-for="(hint, i) in recoveryHints" :key="i" class="text-[12px] text-neutral-mid">{{ hint }}</div>
    </div>

    <div v-if="discoverResult" class="mt-1 text-[12px] text-neutral-mid">{{ discoverResult }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@taiji/ui'
import { useI18n } from 'vue-i18n'
import { Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle } from '@lucide/vue'
import type { TestConnectionResult } from '@taiji/core/domain/settings'

/**
 * results[].error 语法（M3a runtime 逐字产出，权威 = `packages/runtime/src/infra/model-connection-tester.ts`
 * 头注「错误编码」+ `model-service.ts` 的 ConnectionTestRowErrorCode / PROVIDER_CONNECTION_TEST_ERRORS）：
 *
 *   行级（results[].error）：
 *     `http_error|<status>|<响应体截断>`  非 2xx（真实状态码 + 响应原因）
 *     `network_error|<message>`           fetch 层失败（不可达 / 超时 / DNS，无状态码）
 *     `unsupported` / `no_base_url` / `no_enabled_model`  已定论行（未发包）
 *   整体（success=false 的 error，provider 级硬停）：
 *     `no_api_key` / `no_models` / `provider_not_found` / `test_unavailable`
 *
 * 解析约定（runtime 头注逐字）：按 `|` 切分，首段 = code、末段（含自身 `|`）= message；
 * 未知 code 走通用失败文案并原样展示运行时文本（不吞真实错误）。
 */
type RowCategory = 'success' | 'http' | 'network' | 'unsupported' | 'noBaseUrl' | 'noEnabledModel' | 'other'

/** provider 级失败 code（M3a PROVIDER_CONNECTION_TEST_ERRORS 子集，前端有专属文案的两类） */
const PROVIDER_ERROR_NO_API_KEY = 'no_api_key'
const PROVIDER_ERROR_NO_MODELS = 'no_models'

type OverallCategory = 'noApiKey' | 'noModels' | 'other'

interface TestRowView {
  key: string
  ok: boolean
  category: RowCategory
  api: string
  modelId: string
  status: string
  message: string
}

/** 单条 results 元素 → 行视图（纯函数，不触 i18n；文案在 rowText 里组装） */
function classifyRow(r: TestConnectionResult): TestRowView {
  const base = { key: `${r.api}/${r.modelId}`, api: r.api, modelId: r.modelId, status: '', message: '' }
  if (r.ok) return { ...base, ok: true, category: 'success' }
  const error = r.error ?? ''
  const codeEnd = error.indexOf('|')
  const code = codeEnd === -1 ? error : error.slice(0, codeEnd)
  const rest = codeEnd === -1 ? '' : error.slice(codeEnd + 1)
  switch (code) {
    case 'unsupported':
      return { ...base, ok: false, category: 'unsupported' }
    case 'no_base_url':
      return { ...base, ok: false, category: 'noBaseUrl' }
    case 'no_enabled_model':
      return { ...base, ok: false, category: 'noEnabledModel' }
    case 'http_error': {
      // `http_error|<status>|<message>`：第二段是状态码，其余（可含 `|`）是响应截断
      const statusEnd = rest.indexOf('|')
      return {
        ...base,
        ok: false,
        category: 'http',
        status: statusEnd === -1 ? rest : rest.slice(0, statusEnd),
        message: statusEnd === -1 ? '' : rest.slice(statusEnd + 1),
      }
    }
    case 'network_error':
      // fetch 层失败无 HTTP 状态码：状态位留空，真实原因进 message（同一行文案 key）
      return { ...base, ok: false, category: 'network', message: rest }
    default:
      return { ...base, ok: false, category: 'other', message: error }
  }
}

function classifyOverall(error: string): OverallCategory {
  if (error === PROVIDER_ERROR_NO_API_KEY) return 'noApiKey'
  if (error === PROVIDER_ERROR_NO_MODELS) return 'noModels'
  return 'other'
}

const props = withDefaults(
  defineProps<{
    /** 测试连接进行中（spinner + 按钮互斥 disabled） */
    testing: boolean
    /** 模型发现进行中 */
    discovering: boolean
    /** 测试连接结果（null = 未测试；ok/error 决定成功/失败反馈行） */
    testResult: 'ok' | 'error' | null
    /** 模型发现结果文案（空 = 未发现） */
    discoverResult: string
    /** 测试成功文案的模型数（t 的 {count} 命名参数） */
    modelCount: number
    /**
     * provider 体系（M3b）：catalog 不渲染「模型发现」——pi 无 fetchModels，模型清单是
     * 编译期权威，发现对本体系无语义。缺省 custom 保持既有渲染（向后兼容）。
     */
    providerKind?: 'catalog' | 'custom'
    /** test 模式按协议分组结果（runtime config.discoveredModels.results，M3b） */
    testResults?: TestConnectionResult[]
    /** test 模式整体性失败原因（success=false 的 error，M3b） */
    testError?: string
    /** 当前生效端点（testHintHttpError 的 {baseUrl} 命名参数，M3b） */
    providerBaseUrl?: string
  }>(),
  {
    providerKind: 'custom',
    testResults: () => [],
    testError: '',
    providerBaseUrl: '',
  },
)

const emit = defineEmits<{
  /** 发起测试连接（RPC 编排在父组件 useProviderEdit.testConnection） */
  test: []
  /** 发起模型发现 */
  discover: []
}>()

const { t } = useI18n()

/** catalog 无「模型发现」语义（M3b） */
const canDiscover = computed(() => props.providerKind !== 'catalog')

/** 每行文案（i18n key 与设计 §3.5 错误规格表一一对应） */
function rowText(row: TestRowView): string {
  switch (row.category) {
    case 'success':
      return t('settings.providerEdit.testRowSuccess', { api: row.api, modelId: row.modelId })
    case 'unsupported':
      return t('settings.providerEdit.testRowUnsupported', { api: row.api })
    case 'noBaseUrl':
      return t('settings.providerEdit.testRowNoBaseUrl', { api: row.api })
    case 'noEnabledModel':
      return t('settings.providerEdit.testRowNoEnabledModel', { api: row.api })
    case 'http':
    case 'network':
    case 'other':
      // network：无 HTTP 状态码（状态位留空）、响应原因进 {message}；other：运行时原文进 {message}
      return t('settings.providerEdit.testRowHttpError', {
        api: row.api,
        modelId: row.modelId,
        status: row.status,
        message: row.message,
      })
  }
}

const testRows = computed(() =>
  props.testResults.map((r) => {
    const view = classifyRow(r)
    return { ...view, text: rowText(view) }
  }),
)

/** 整体性失败文案（有分组结果时不参与渲染） */
const overallMessage = computed<string>(() => {
  if (!props.testError) return ''
  const category = classifyOverall(props.testError)
  if (category === 'noApiKey') return t('settings.providerEdit.testNoApiKey')
  if (category === 'noModels') return t('settings.providerEdit.testNoModels')
  return props.testError
})

/** 恢复指引（按出现的失败类型去重，每类一条；每行失败配「去哪修」的动作） */
const recoveryHints = computed<string[]>(() => {
  const hints: string[] = []
  const categories = new Set(testRows.value.map((r) => r.category))
  if (categories.has('http') || categories.has('network') || categories.has('other')) {
    hints.push(t('settings.providerEdit.testHintHttpError', { baseUrl: props.providerBaseUrl || '—' }))
  }
  if (categories.has('noBaseUrl')) hints.push(t('settings.providerEdit.testHintNoBaseUrl'))
  if (categories.has('noEnabledModel')) hints.push(t('settings.providerEdit.testHintNoEnabledModel'))
  if (testRows.value.length === 0 && props.testResult === 'error' && props.testError) {
    const category = classifyOverall(props.testError)
    if (category === 'noApiKey') hints.push(t('settings.providerEdit.testHintNoApiKey'))
    if (category === 'noModels') {
      hints.push(
        t(
          props.providerKind === 'catalog'
            ? 'settings.providerEdit.testHintNoModelsCatalog'
            : 'settings.providerEdit.testHintNoModelsCustom',
        ),
      )
    }
  }
  return hints
})
</script>
