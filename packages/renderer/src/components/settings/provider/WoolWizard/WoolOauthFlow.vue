<template>
  <!--
    羊毛向导 · 授权族步骤区（D7 / §3.1 五步：install → authorize → ready → checkin → done）。
    authorize = 「在 TaiJi 浏览器中打开授权页」按钮（当前扩展协议无 authorize 动作时进入
    authorize_unavailable 失败态 + 重试指引——浮层编排随扩展协议扩展后生效）；
    ready = 账号昵称/令牌有效期（status 拉取）；checkin = 两开关（自动签到默认关 + 黄色警示）；
    done = 模型清单加载态。
  -->
  <div class="flex flex-col gap-[12px]" data-testid="wool-oauth-flow">
    <WoolStepRow
      :label="t('wool.stepInstall')"
      :state="stepStates.install"
      :active="currentStep === 'install'"
      testid="wool-step-install"
      @retry="emit('retryInstall')"
    />

    <!-- authorize 步：按钮触发（pending 态显示按钮；running = 等待授权完成） -->
    <WoolStepRow
      :label="t('wool.stepAuthorize')"
      :state="stepStates.authorize"
      :active="currentStep === 'authorize'"
      testid="wool-step-authorize"
      :running-label="t('wool.authorizePending')"
      @retry="emit('retryAuthorize')"
    >
      <Button
        v-if="stepStates.authorize.status === 'pending'"
        variant="default"
        class="mt-[6px] h-[24px] rounded-full px-[12px] py-0 text-[length:var(--text-2xs)]"
        data-testid="wool-authorize-open"
        @click="emit('authorize')"
      >{{ t('wool.authorizeOpen') }}</Button>
    </WoolStepRow>

    <!-- ready 步：账号信息（昵称/令牌有效期；status 动作数据经快照） -->
    <WoolStepRow
      :label="t('wool.stepReady')"
      :state="stepStates.ready"
      :active="currentStep === 'ready'"
      testid="wool-step-ready"
      @retry="emit('retryReady')"
    >
      <p v-if="account" data-testid="wool-ready-account" class="mt-[6px] text-[length:var(--text-2xs)] text-neutral-mid">
        {{ account.nickname ?? displayName }}
        <span v-if="account.tokenExpiresAt"> · {{ new Date(account.tokenExpiresAt).toLocaleDateString() }}</span>
      </p>
    </WoolStepRow>

    <!-- checkin 步：两项开关（自动签到默认关；开 = 黄色警示 D5；令牌续期默认开） -->
    <WoolStepRow
      :label="t('wool.stepCheckin')"
      :state="stepStates.checkin"
      :active="currentStep === 'checkin'"
      testid="wool-step-checkin"
    >
      <div class="mt-[8px] flex flex-col gap-[8px]">
        <div class="flex items-center gap-2" data-testid="wool-autocheckin-row">
          <Switch :model-value="autoCheckin" :disabled="stepStates.checkin.status === 'running'" @update:model-value="emit('setAutoCheckin', $event)" />
          <span class="text-[length:var(--text-xs)] text-neutral-fg">{{ t('wool.autoCheckinLabel') }}</span>
          <span class="text-[length:var(--text-2xs)] text-neutral-mid">{{ autoCheckin ? '' : t('wool.autoCheckinOffHint') }}</span>
        </div>
        <!-- 黄色警示（开关打开时；D5 风控决策权留给用户） -->
        <p
          v-if="autoCheckin"
          data-testid="wool-autocheckin-warn"
          class="rounded-md bg-warn-soft px-[10px] py-[6px] text-[length:var(--text-2xs)] leading-relaxed text-warn"
        >{{ t('wool.autoCheckinWarn') }}</p>
        <div class="flex items-center gap-2" data-testid="wool-renew-row">
          <Switch :model-value="true" disabled :aria-label="t('wool.renewLabel')" />
          <span class="text-[length:var(--text-xs)] text-neutral-fg">{{ t('wool.renewLabel') }}</span>
          <span class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('wool.renewHint') }}</span>
        </div>
      </div>
    </WoolStepRow>

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
 * 纯渲染（与 WoolExtractFlow 同构）：状态机在父 WoolWizard；动作 emit 上抛。
 * 令牌续期开关为展示态（pi oauth 钩子承载，无宿主动作——D3；disabled Switch 表达
 * 「机制常开」而非可切换项）。
 */
import { useI18n } from 'vue-i18n'
import { Button, Switch } from '@taiji/ui'
import type { WoolAccountStatusView } from '@taiji/shared'
import type { WoolWizardStepId, WoolWizardStepState } from '@/composables/features/settings/useWoolWizard'
import WoolStepRow from './WoolStepRow.vue'

defineProps<{
  displayName: string
  stepStates: Readonly<Record<WoolWizardStepId, WoolWizardStepState>>
  currentStep: WoolWizardStepId
  account: WoolAccountStatusView | null
  autoCheckin: boolean
  catalogLoading: boolean
  catalogCount: number | null
}>()

const emit = defineEmits<{
  retryInstall: []
  retryAuthorize: []
  retryReady: []
  authorize: []
  setAutoCheckin: [enabled: boolean]
}>()

const { t } = useI18n()
</script>
