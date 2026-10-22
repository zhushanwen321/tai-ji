<template>
  <!--
    羊毛向导 · 授权族步骤区（D7 / §3.1 五步：install → authorize → ready → checkin → done）。
    authorize = 「在 TaiJi 浏览器中打开授权页」按钮（真实流程：authorize 动作挂起至用户
    完成授权，授权页 URL 广播到达后浮层打开 + 提示行；旧扩展协议无 authorize 动作时
    进入 authorize_unavailable 失败态 + 更新指引）；
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

    <!-- authorize 步：按钮触发（pending 态显示按钮；running = 等待授权完成；
         授权页 URL 到达（浮层已开）后显示完成授权提示行） -->
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
      <p
        v-if="authorizeUrlOpened && stepStates.authorize.status === 'running'"
        data-testid="wool-authorize-opened-hint"
        class="mt-[6px] text-[length:var(--text-2xs)] text-neutral-mid"
      >{{ t('wool.authorizeOpenedHint') }}</p>
      <!-- 授权确认交互（callback-server 契约：done 信号驱动扩展侧令牌交换，202=未完成可再点；cancel = 取消终态回待授权态） -->
      <div
        v-if="authorizeUrlOpened && stepStates.authorize.status === 'running'"
        class="mt-[6px] flex gap-2"
        data-testid="wool-authorize-signal-row"
      >
        <Button
          variant="default"
          class="h-[24px] rounded-full px-[12px] py-0 text-[length:var(--text-2xs)]"
          data-testid="wool-authorize-done"
          :disabled="authorizeSignaling"
          @click="emit('authorizeDone')"
        >{{ t('wool.authorizeDone') }}</Button>
        <Button
          variant="ghost"
          class="h-[24px] rounded-full px-[12px] py-0 text-[length:var(--text-2xs)]"
          data-testid="wool-authorize-cancel"
          :disabled="authorizeSignaling"
          @click="emit('authorizeCancel')"
        >{{ t('wool.authorizeCancel') }}</Button>
      </div>
      <p
        v-if="authorizeRetryHint"
        data-testid="wool-authorize-retry-hint"
        class="mt-[6px] text-[length:var(--text-2xs)] text-warn"
      >{{ t('wool.authorizeRetryHint') }}</p>
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

withDefaults(defineProps<{
  displayName: string
  stepStates: Readonly<Record<WoolWizardStepId, WoolWizardStepState>>
  currentStep: WoolWizardStepId
  account: WoolAccountStatusView | null
  autoCheckin: boolean
  /** 授权页浮层已打开（wool.authorize_url 广播已到达；authorize running 态提示行）。 */
  authorizeUrlOpened: boolean
  /** 授权确认信号在途（done/cancel 按钮 disabled 判定）。 */
  authorizeSignaling?: boolean
  /** done 信号回 202（浏览器内尚未完成登录）提示行。 */
  authorizeRetryHint?: boolean
  catalogLoading: boolean
  catalogCount: number | null
}>(), {
  authorizeSignaling: false,
  authorizeRetryHint: false,
})

const emit = defineEmits<{
  retryInstall: []
  retryAuthorize: []
  retryReady: []
  authorize: []
  authorizeDone: []
  authorizeCancel: []
  setAutoCheckin: [enabled: boolean]
}>()

const { t } = useI18n()
</script>
