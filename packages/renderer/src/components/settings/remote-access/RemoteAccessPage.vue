<!--
  Settings · 远程访问页。
  开关（切换弹「重启 runtime 生效」确认，确认后 main 自动重启 runtime 并返回最新连接信息）
  + 连接入口（链接 + 二维码 + 复制 + 轮换 token）+ Tailscale 跨网指引。
  关态时入口/指引卡隐藏，只留开关卡。数据流单向：本页持 info 单一状态，
  ConnectionEntrySection 为纯展示子组件。
-->
<template>
  <!--
    [w3b] demo 对照：RemoteAccessSection.vue 三卡（.gcard 结构）——
    开关卡 = 卡头 gc-title + gc-sub（enableDesc）+ tight body + SettingRow（启用 Switch）；
    连接入口卡 = 卡头 gc-title + actions 轮换钮（demo .btn.secondary + icon 14px），E5 显形条保留
    （real 功能结构，warn 软底令牌 + 13px 文案）；Tailscale 指引卡 = demo 无折叠（static body desc）。
    关态时入口/指引卡隐藏，只留开关卡。容器不设 gap：卡间距由 GroupCard 相邻 margin（16px）承担。
    数据流单向：本页持 info 单一状态，ConnectionEntrySection 为纯展示子组件。
  -->
  <div class="flex flex-col">
    <!-- 卡 1：开关 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.remoteAccess.enableTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.remoteAccess.enableDesc') }}</p>
        </div>
      </template>
      <div class="px-[10px] pt-[4px] pb-[8px]">
        <SettingRow :label="t('settings.remoteAccess.enableLabel')">
          <Switch
            data-testid="remote-access-switch"
            :model-value="info.enabled"
            :disabled="toggling"
            @update:model-value="onSwitchIntent"
          />
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 卡 2：连接入口 + 轮换（开态渲染；关态隐藏） -->
    <GroupCard v-if="info.enabled" data-testid="remote-access-entry">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.remoteAccess.entryTitle') }}</h3>
        </div>
      </template>
      <template #actions>
        <Button
          variant="secondary"
          class="h-[32px] px-[12px] text-[length:var(--text-sm)] [&_svg]:size-[14px]"
          :disabled="rotating"
          data-testid="remote-access-rotate"
          @click="onRotate"
        >
          <Loader2 v-if="rotating" class="animate-spin" />
          <RefreshCw v-else />
          {{ t('settings.remoteAccess.rotate') }}
        </Button>
      </template>
      <div class="p-[12px_16px]">
        <!-- 移动壳 dist 缺失显形（E5）：enabled 但产物缺失时 runtime 静态面已禁用，手机端 404 -->
        <div
          v-if="!info.mobileDistReady"
          role="alert"
          class="mb-[8px] flex items-start gap-2 rounded-sm bg-warn-soft px-3 py-2"
          data-testid="remote-access-dist-missing"
        >
          <AlertTriangle class="mt-0.5 size-[14px] shrink-0 text-warn" />
          <p class="text-[length:var(--text-sm)] leading-[1.55] text-warn">{{ distMissingText }}</p>
        </div>
        <ConnectionEntrySection :info="info" />
      </div>
    </GroupCard>

    <!-- 卡 3：跨网络 Tailscale 指引（开态渲染；demo 无折叠形态，static body） -->
    <GroupCard v-if="info.enabled">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.remoteAccess.tailscaleTitle') }}</h3>
        </div>
      </template>
      <div class="p-[12px_16px]">
        <p class="text-[length:var(--text-sm)] leading-[1.55] text-[color:var(--neutral-fg-2)]" data-testid="remote-access-tailscale-hint">
          {{ t('settings.remoteAccess.tailscaleHint') }}
        </p>
      </div>
    </GroupCard>

    <!-- 开关切换确认（重启 runtime 生效；取消则开关回弹，不落地） -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="t('settings.remoteAccess.enableConfirmTitle')"
      :description="t(pendingEnable ? 'settings.remoteAccess.enableConfirmDescOn' : 'settings.remoteAccess.enableConfirmDescOff')"
      :loading="toggling"
      @confirm="onToggleConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/composables/useToast'
import ConnectionEntrySection from './ConnectionEntrySection.vue'
import {
  getRemoteAccessInfo,
  rotateRemoteAccessToken,
  setRemoteAccessEnabled,
} from '@/lib/ipc'
import type { RemoteAccessInfo } from '@taiji/shared'
import { toErrorMessage } from '@taiji/core'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

/** 远程访问配置 + LAN 候选（单一状态；onMounted 拉取，开关/轮换后由 IPC 返回值刷新） */
const info = ref<RemoteAccessInfo>({ enabled: false, token: '', createdAt: '', urls: [], mobileDistReady: false })

/**
 * 移动壳 dist 缺失提示文案（E5 显形）：dev 指向本地恢复命令，prod 指向重装——
 * 两类受众的可执行恢复动作不同，文案 dev/prod 分流。
 */
const distMissingText = computed(() =>
  t(import.meta.env.DEV ? 'settings.remoteAccess.distMissingDev' : 'settings.remoteAccess.distMissingProd'),
)

onMounted(async () => {
  try {
    info.value = await getRemoteAccessInfo()
  } catch (e) {
    // 降级空态（关态 + 无候选）：加载失败不打断面板，开关仍可操作。
    // 必须 toast 显形（红线③：降级不显形）——读取失败渲染成「确认关态」会误导安全判断
    // （实际远程访问可能开着且手机端正持有效链接）。
    console.error('[remote-access] getRemoteAccessInfo failed:', e)
    toastError(toErrorMessage(e))
  }
})

// ── 开关切换（确认后调 IPC；main 侧自动重启 runtime 并返回最新信息）──
const confirmOpen = ref(false)
const pendingEnable = ref(false)
const toggling = ref(false)

function onSwitchIntent(next: unknown): void {
  const enabled = next === true
  // 值未变化（同态点击）不弹确认
  if (enabled === info.value.enabled) return
  pendingEnable.value = enabled
  confirmOpen.value = true
}

async function onToggleConfirm(): Promise<void> {
  toggling.value = true
  try {
    const result = await setRemoteAccessEnabled(pendingEnable.value)
    info.value = result
    confirmOpen.value = false
    toastInfo(t(result.restarted ? 'settings.remoteAccess.toggleRestarted' : 'settings.remoteAccess.toggleSavedOnly'))
  } catch (e) {
    // IPC 失败保持原开关态（info 未更新 → model-value 回弹），错误经 toast 反馈
    confirmOpen.value = false
    toastError(toErrorMessage(e))
  } finally {
    toggling.value = false
  }
}

// ── 轮换 token（main 重写文件即生效不重启；旧链接即刻失效）──
const rotating = ref(false)

async function onRotate(): Promise<void> {
  rotating.value = true
  try {
    info.value = await rotateRemoteAccessToken()
    toastInfo(t('settings.remoteAccess.rotated'))
  } catch (e) {
    toastError(toErrorMessage(e))
  } finally {
    rotating.value = false
  }
}
</script>
