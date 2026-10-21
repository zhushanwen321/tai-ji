<template>
  <!--
    羊毛向导 · 提取族步骤区（D7：install → credentials[检测/确认/提取] → done）。
    状态机 = useWoolWizard（父构造注入）；本组件只渲染步骤行 + credentials 步的
    确认框（提取前弹一次，说明读取什么/存哪/仅本机——D3 逐次确认）。
  -->
  <div class="flex flex-col gap-[12px]" data-testid="wool-extract-flow">
    <!-- install 步：进入即自动执行（父组件 startAdoption 触发）；失败态 = 重试按钮 -->
    <WoolStepRow
      :label="t('wool.stepInstall')"
      :state="stepStates.install"
      :active="currentStep === 'install'"
      testid="wool-step-install"
      @retry="emit('retryInstall')"
    />

    <!-- credentials 步：detect 结果 → 确认框 → extract -->
    <WoolStepRow
      :label="t('wool.stepCredentials')"
      :state="stepStates.credentials"
      :active="currentStep === 'credentials'"
      testid="wool-step-credentials"
      @retry="emit('retryCredentials')"
    >
      <!-- 确认框（D3：提取前逐次确认；检测通过且未确认时显示） -->
      <div
        v-if="extractConfirmPending"
        data-testid="wool-extract-confirm"
        class="mt-[8px] rounded-md border border-hairline bg-surface px-3 py-[10px]"
      >
        <p class="text-[length:var(--text-xs)] font-semibold text-neutral-fg">{{ t('wool.extractConfirmTitle') }}</p>
        <p class="mt-[4px] text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
          {{ t('wool.extractConfirmBody', { family: displayName }) }}
        </p>
        <div class="mt-[8px] flex gap-2">
          <Button
            variant="default"
            class="h-[24px] rounded-full px-[12px] py-0 text-[length:var(--text-2xs)]"
            data-testid="wool-extract-confirm-ok"
            @click="emit('confirmExtract')"
          >{{ t('wool.extractConfirmOk') }}</Button>
          <Button
            variant="ghost"
            class="h-[24px] rounded-full px-[12px] py-0 text-[length:var(--text-2xs)]"
            data-testid="wool-extract-confirm-cancel"
            @click="emit('cancelExtract')"
          >{{ t('wool.cancel') }}</Button>
        </div>
      </div>
      <!-- 检测结论（未检测到登录态 = 引导，非失败态——S11 卡片指引同语义） -->
      <p
        v-else-if="stepStates.credentials.status === 'pending' && detect && !detect.detected"
        data-testid="wool-extract-no-login"
        class="mt-[6px] text-[length:var(--text-2xs)] text-neutral-mid"
      >{{ t('wool.errNotLoggedIn') }}</p>
    </WoolStepRow>

    <!-- done 步：目录加载态（模型数）+ 完成按钮（父 emit done） -->
    <WoolStepRow
      :label="t('wool.stepDone')"
      :state="stepStates.done"
      :active="currentStep === 'done'"
      testid="wool-step-done"
    >
      <p
        v-if="stepStates.done.status === 'pending' && catalogLoading"
        data-testid="wool-catalog-loading"
        class="mt-[6px] text-[length:var(--text-2xs)] text-neutral-mid"
      >{{ t('wool.catalogLoading') }}</p>
      <p
        v-else-if="catalogCount !== null"
        data-testid="wool-catalog-count"
        class="mt-[6px] text-[length:var(--text-2xs)] text-success"
      >{{ t('wool.catalogCount', { count: catalogCount }) }}</p>
    </WoolStepRow>
  </div>
</template>

<script setup lang="ts">
/**
 * 纯渲染：步骤态/确认框/检测结论全由 props 注入（状态机在父 WoolWizard 的
 * useWoolWizard 实例内；动作经 emit 上抛由父执行——组件薄渲染利于模板测试）。
 */
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import type { WoolDetectResultView } from '@taiji/shared'
import type { WoolWizardStepId, WoolWizardStepState } from '@/composables/features/settings/useWoolWizard'
import WoolStepRow from './WoolStepRow.vue'

defineProps<{
  displayName: string
  stepStates: Readonly<Record<WoolWizardStepId, WoolWizardStepState>>
  currentStep: WoolWizardStepId
  extractConfirmPending: boolean
  detect: WoolDetectResultView | null
  catalogLoading: boolean
  catalogCount: number | null
}>()

const emit = defineEmits<{
  retryInstall: []
  retryCredentials: []
  confirmExtract: []
  cancelExtract: []
}>()

const { t } = useI18n()
</script>
