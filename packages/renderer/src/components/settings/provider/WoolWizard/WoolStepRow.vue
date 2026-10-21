<template>
  <!--
    单步骤行（两族向导共用原子）：状态图标（pending 空点 / running 旋转 / ok 对勾 /
    failed 叉）+ 标签 + 失败态恢复指引 + 重试按钮 + 默认插槽（步骤附属内容——确认框/
    检测结论/授权按钮等由各族 Flow 组件注入）。
  -->
  <div class="flex flex-col" :data-testid="testid">
    <div class="flex items-center gap-2">
      <!-- 状态图标（四态；running = Loader2 旋转动画） -->
      <span class="grid size-[16px] shrink-0 place-items-center">
        <Loader2 v-if="state.status === 'running'" class="size-[13px] animate-spin text-neutral-mid" />
        <Check v-else-if="state.status === 'ok'" class="size-[13px] text-success" />
        <XCircle v-else-if="state.status === 'failed'" class="size-[13px] text-danger" />
        <span v-else class="size-[6px] rounded-full" :class="active ? 'bg-accent' : 'bg-neutral-dim'" />
      </span>

      <span
        class="text-[length:var(--text-sm)]"
        :class="state.status === 'ok' ? 'text-neutral-mid' : 'font-semibold text-neutral-fg'"
      >{{ label }}</span>
      <span v-if="state.status === 'running' && runningLabel" class="text-[length:var(--text-2xs)] text-neutral-mid">{{ runningLabel }}</span>

      <!-- 失败态重试按钮（失败路径表：全部失败形态给重试入口） -->
      <Button
        v-if="state.status === 'failed'"
        variant="ghost"
        class="h-[20px] shrink-0 rounded-full bg-surface px-[8px] py-0 text-[length:var(--text-2xs)] text-accent hover:bg-surface-hover"
        :data-testid="`${testid}-retry`"
        @click="emit('retry')"
      >{{ t('wool.retry') }}</Button>
    </div>

    <!-- 失败态恢复指引（§3.1 失败路径表按 failure.code 映射文案 + 原始 message） -->
    <p
      v-if="state.status === 'failed' && state.failure"
      :data-testid="`${testid}-failure`"
      class="mt-[4px] pl-[24px] text-[length:var(--text-2xs)] leading-relaxed text-danger"
    >{{ failureText(state.failure) }}</p>

    <div v-if="$slots.default" class="pl-[24px]"><slot /></div>
  </div>
</template>

<script setup lang="ts">
/**
 * 步骤失败文案映射（WoolStepFailureCode → i18n key；message 参数按需并入——
 * install/upstream/internal 类失败带原始 message 供定位）。
 */
import { useI18n } from 'vue-i18n'
import { Check, Loader2, XCircle } from '@lucide/vue'
import { Button } from '@taiji/ui'
import type { WoolStepFailureCode } from '@taiji/shared'
import type { WoolWizardStepState } from '@/composables/features/settings/useWoolWizard'

defineProps<{
  label: string
  state: WoolWizardStepState
  active?: boolean
  testid: string
  runningLabel?: string
}>()

const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()

const FAILURE_I18N_KEYS: Record<WoolStepFailureCode, string> = {
  manifest_unreachable: 'wool.errManifestUnreachable',
  manifest_bad_shape: 'wool.errManifestBadShape',
  family_absent: 'wool.errFamilyAbsent',
  install_failed: 'wool.errInstallFailed',
  extension_missing: 'wool.errExtensionMissing',
  not_logged_in: 'wool.errNotLoggedIn',
  upstream_error: 'wool.errUpstreamError',
  authorize_unavailable: 'wool.errAuthorizeUnavailable',
  extract_unavailable: 'wool.errExtractUnavailable',
  manage_unavailable: 'wool.errManageUnavailable',
  internal: 'wool.errInternal',
  cancelled: 'wool.errCancelled',
}

/** 参数化失败文案键集（{message} 占位的键才拼原始 message）。 */
const PARAMETERIZED = new Set(['wool.errInstallFailed', 'wool.errUpstreamError', 'wool.errInternal', 'wool.errManageUnavailable'])

function failureText(failure: { code: WoolStepFailureCode; message: string }): string {
  const key = FAILURE_I18N_KEYS[failure.code]
  return PARAMETERIZED.has(key) ? t(key, { message: failure.message }) : t(key)
}
</script>
