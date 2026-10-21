<template>
  <!--
    ModelTestButton —— 模型行内「测试此模型」按钮 + 行下结果条（2026-10-21 per-model 入口）。
    测试入口从凭据区「测试连接」按钮下沉到每个模型行（用户拍板移除一键全测），本组件是
    ModelListSection 自定义行与 ProviderEditBody builtin 行共用的展示件：编排与状态
    （testModel / testingIds / results）经 MODEL_LIST_DEPS_KEY.modelTest 注入（core discover
    module 状态切片），组件只做状态转译 + 发起。

    结果条随父级行容器的 flex-wrap 换行占满（根级 w-full）；无结果 / 测试中不渲染。
    结果文案按 runtime 行级错误编码语法解析（`code|...`，SSOT 见 infra/model-connection-tester.ts
    头注），未知 code 走原样展示。
  -->
  <Button
    variant="ghost"
    class="size-5 w-7 shrink-0 rounded-sm p-0 [&_svg]:size-3"
    :class="resultClass"
    :disabled="testing || !canTest"
    :aria-label="buttonTitle"
    :title="buttonTitle"
    :data-testid="`model-test-${modelId}`"
    :aria-busy="testing"
    @click.stop="test(modelId)"
  >
    <Loader2 v-if="testing" class="animate-spin" />
    <CheckCircle2 v-else-if="result?.ok" />
    <AlertCircle v-else-if="result" />
    <Wifi v-else />
  </Button>
  <div
    v-if="result"
    class="w-full rounded-sm px-2 py-1 text-[length:var(--text-3xs)]"
    :class="result.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'"
    :data-testid="`model-test-result-${modelId}`"
    role="status"
  >
    {{ resultText }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@taiji/ui'
import { useI18n } from 'vue-i18n'
import { Loader2, Wifi, CheckCircle2, AlertCircle } from '@lucide/vue'
import { useModelListDeps } from '../injection-keys'

const props = defineProps<{
  /** 测试目标模型 id（core testModel 的入参，也是结果表 key） */
  modelId: string
}>()

const { t } = useI18n()
const { modelTest } = useModelListDeps()

/** 毫秒 → 秒换算基数（durationMs 的展示单位是秒，一位小数） */
const MS_PER_SECOND = 1000

const testing = computed(() => modelTest.testingIds.value.includes(props.modelId))
const result = computed(() => modelTest.results.value[props.modelId])
/** 新增态（provider 未保存）无 providerId 可测：禁用 + tooltip 提示先保存（C-proc-21 可见反馈） */
const canTest = computed(() => modelTest.canTest.value)
const buttonTitle = computed(() =>
  canTest.value ? t('settings.providerEdit.modelTestButton') : t('settings.providerEdit.modelTestNeedsSave'),
)

const resultClass = computed(() => {
  if (result.value?.ok) return 'text-success hover:text-success'
  if (result.value) return 'text-danger hover:text-danger'
  return 'text-neutral-dim hover:text-neutral-fg'
})

/** 行级错误编码解析（`code|rest` 语法，SSOT 见 infra/model-connection-tester.ts 头注）。 */
const resultText = computed<string>(() => {
  const r = result.value
  if (!r) return ''
  if (r.ok) {
    const seconds = r.durationMs !== undefined ? (r.durationMs / MS_PER_SECOND).toFixed(1) : null
    return seconds ? t('settings.providerEdit.modelTestOk', { seconds }) : t('settings.providerEdit.modelTestOkNoTime')
  }
  const error = r.error ?? ''
  const sep = error.indexOf('|')
  const code = sep === -1 ? error : error.slice(0, sep)
  const rest = sep === -1 ? '' : error.slice(sep + 1)
  switch (code) {
    case 'http_error': {
      const statusEnd = rest.indexOf('|')
      return t('settings.providerEdit.modelTestHttpError', {
        status: statusEnd === -1 ? rest : rest.slice(0, statusEnd),
        message: statusEnd === -1 ? '' : rest.slice(statusEnd + 1),
      })
    }
    case 'network_error':
      return t('settings.providerEdit.modelTestNetworkError', { message: rest })
    case 'unsupported':
      return t('settings.providerEdit.modelTestUnsupported')
    case 'no_base_url':
      return t('settings.providerEdit.modelTestNoBaseUrl')
    case 'model_not_found':
      return t('settings.providerEdit.modelTestNotFound')
    default:
      return error
  }
})

const { test } = modelTest
</script>
