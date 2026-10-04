<!--
  Settings · 远程访问页。
  开关（切换弹「重启 runtime 生效」确认，确认后 main 自动重启 runtime 并返回最新连接信息）
  + 连接入口（链接 + 二维码 + 复制 + 轮换 token）+ Tailscale 跨网指引（折叠）。
  关态时入口/指引区块隐藏，只留开关区。数据流单向：本页持 info 单一状态，
  ConnectionEntrySection 为纯展示子组件。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- 卡 1：开关 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.remoteAccess.enableTitle') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.remoteAccess.enableDesc') }}</p>
      </div>
      <div class="flex items-center justify-between border-t border-border px-4 py-3">
        <Label class="text-[12px] text-fg">{{ t('settings.remoteAccess.enableLabel') }}</Label>
        <Switch
          data-testid="remote-access-switch"
          :model-value="info.enabled"
          :disabled="toggling"
          @update:model-value="onSwitchIntent"
        />
      </div>
    </div>

    <!-- 卡 2：连接入口 + 轮换（开态渲染；关态隐藏） -->
    <div v-if="info.enabled" class="rounded-md border border-border bg-bg" data-testid="remote-access-entry">
      <div class="flex items-center justify-between px-4 pb-1 pt-3">
        <div>
          <h3 class="text-[13px] font-medium text-fg">{{ t('settings.remoteAccess.entryTitle') }}</h3>
        </div>
        <Button
          variant="secondary"
          size="dense"
          class="h-8 px-3 text-[11px]"
          :disabled="rotating"
          data-testid="remote-access-rotate"
          @click="onRotate"
        >
          <Loader2 v-if="rotating" class="size-3.5 animate-spin" />
          <RefreshCw v-else class="size-3.5" />
          {{ t('settings.remoteAccess.rotate') }}
        </Button>
      </div>
      <ConnectionEntrySection :info="info" class="border-t border-border" />
    </div>

    <!-- 卡 3：跨网络 Tailscale 指引（开态渲染；折叠收起，零代码指引） -->
    <GroupCard v-if="info.enabled" collapsible :title="t('settings.remoteAccess.tailscaleTitle')">
      <p class="px-4 pb-3 pt-1 text-[11px] leading-relaxed text-muted" data-testid="remote-access-tailscale-hint">
        {{ t('settings.remoteAccess.tailscaleHint') }}
      </p>
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
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@taiji/ui/features/settings'
import ConfirmDialog from '@/components/ui/dialog/ConfirmDialog.vue'
import { useToast } from '@/composables/useToast'
import ConnectionEntrySection from './ConnectionEntrySection.vue'
import {
  getRemoteAccessInfo,
  rotateRemoteAccessToken,
  setRemoteAccessEnabled,
  type RemoteAccessConnectionInfo,
} from '@/lib/ipc'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

/** 远程访问配置 + LAN 候选（单一状态；onMounted 拉取，开关/轮换后由 IPC 返回值刷新） */
const info = ref<RemoteAccessConnectionInfo>({ enabled: false, token: '', createdAt: '', urls: [] })

onMounted(async () => {
  try {
    info.value = await getRemoteAccessInfo()
  } catch (e) {
    // 降级空态（关态 + 无候选）：加载失败不打断面板，开关仍可操作
    console.error('[remote-access] getRemoteAccessInfo failed:', e)
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
    toastError(e instanceof Error ? e.message : String(e))
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
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    rotating.value = false
  }
}
</script>
