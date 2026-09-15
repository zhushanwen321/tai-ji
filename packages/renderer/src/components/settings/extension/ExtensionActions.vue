<template>
  <div class="flex shrink-0 flex-col items-end gap-1">
    <div class="flex items-center gap-2">
      <!-- 启用开关：Switch 原语。乐观更新——点击立即改 store（开关即时滑动），API 失败回滚。
           三层权限矩阵：仅 infrastructure builtin（layer='builtin' && tier='infrastructure'）隐藏开关；
           feature builtin 可禁（开关可见可操作）；user 层同理。 -->
      <Switch
        v-if="!(ext.layer === 'builtin' && ext.tier === 'infrastructure')"
        :model-value="ext.enabled"
        class="shrink-0"
        :disabled="toggling.has(ext.name)"
        :aria-label="ext.enabled ? t('settings.extension.disableExt') : t('settings.extension.enableExt')"
        @update:model-value="onToggle(ext, $event)"
      />
      <!-- toggle 中：短暂 loading 反馈（开关乐观已滑动，spinner 表示正在持久化 + 重扫刷新列表） -->
      <Loader2 v-if="toggling.has(ext.name)" class="size-3.5 shrink-0 animate-spin text-neutral-mid" />
      <!-- 升级按钮（仅 user 层 + user-installed 来源扩展显示；builtin 由 runtime 自动升级） -->
      <Button
        v-if="ext.layer !== 'builtin' && ext.source === 'user-installed'"
        variant="ghost"
        class="size-7 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-accent-soft hover:text-accent [&_svg]:size-3.5"
        :title="t('settings.extension.upgradeTitle')"
        :disabled="upgrading.has(ext.name)"
        @click="onUpgrade(ext.name)"
      >
        <Loader2 v-if="upgrading.has(ext.name)" class="animate-spin" />
        <ArrowUpCircle v-else />
      </Button>
      <!-- 卸载按钮（仅 user 层可卸；builtin 不可卸载，discovery 来源不经此入口） -->
      <Button
        v-if="ext.layer !== 'builtin' && ext.source !== 'discovery'"
        variant="ghost"
        class="size-7 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger [&_svg]:size-3.5"
        :title="t('settings.extension.uninstallTitle')"
        @click="confirmTarget = ext.name"
      >
        <Trash2 />
      </Button>
    </div>
    <!-- 操作失败就近反馈（非静默吞，CLAUDE.md 规则 #3） -->
    <div v-if="error" class="flex max-w-[220px] items-center gap-1 text-[10px] text-danger">
      <AlertCircle class="size-3 shrink-0" />
      <span class="truncate">{{ error }}</span>
    </div>

    <!-- 卸载确认弹窗（ConfirmDialog 原语：标题+描述+取消/危险确认，loading 态显 spinner） -->
    <ConfirmDialog
      v-model:open="uninstallDialogOpen"
      variant="danger"
      :title="t('settings.extension.uninstallConfirmTitle', { name: confirmTarget })"
      :description="t('settings.extension.uninstallConfirmDesc')"
      :confirm-text="t('settings.extension.uninstallConfirmBtn')"
      :cancel-text="t('settings.extension.cancel')"
      :loading="uninstalling"
      @confirm="onConfirmUninstall"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, Loader2, AlertCircle, ArrowUpCircle } from '@lucide/vue'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { extension as extensionApi } from '@/api'
import type { ExtensionItem } from '@taiji/core'
import { getSettingsStore } from '@taiji/core'
import { useToast } from '@/composables/useToast'

defineProps<{ ext: ExtensionItem }>()

const settingsStore = getSettingsStore()
const { info: toastInfo } = useToast()
const { t } = useI18n()

/** 启用开关切换中（防双击：API 期间 disable Switch） */
const toggling = ref<Set<string>>(new Set())
/** 升级中（按扩展名 key） */
const upgrading = ref<Set<string>>(new Set())
/** 卸载中 */
const uninstalling = ref(false)
/** 卸载确认目标（非空即打开弹窗） */
const confirmTarget = ref('')
/** 操作失败信息（就近显示在操作按钮下方） */
const error = ref('')

/** 卸载弹窗开关：派生自 confirmTarget（有目标即开），关闭时清空目标 */
const uninstallDialogOpen = computed({
  get: () => confirmTarget.value !== '',
  set: (open: boolean) => {
    if (!open) confirmTarget.value = ''
  },
})

/** 启用开关 → 乐观更新 store（开关即时滑动）+ extension.toggle 持久化。
 * 乐观：先改 store，UI 立即反应；失败回滚 store + 报错。
 * 广播回来时权威值覆盖 store（幂等：若值一致无副作用）。 */
async function onToggle(ext: ExtensionItem, enabled: boolean) {
  if (toggling.value.has(ext.name)) return
  error.value = ''
  // 防双击
  const next = new Set(toggling.value)
  next.add(ext.name)
  toggling.value = next
  // 乐观：立即改 store
  const old = settingsStore.setExtensionEnabled(ext.name, enabled)
  try {
    const reply = await extensionApi.toggle(ext.name, enabled)
    // RPC reply 命中 pending 被 routeInbound 吞掉、不触发 onExtensions 全局订阅，
    // 故手动用 reply 的权威扫描结果刷新列表（替代不可靠的广播）。乐观值与权威值一致时幂等。
    settingsStore.extensions.value = reply.extensions
  } catch (e) {
    // 回滚
    settingsStore.setExtensionEnabled(ext.name, old)
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    const after = new Set(toggling.value)
    after.delete(ext.name)
    toggling.value = after
  }
}

/** 卸载确认 → extension.uninstall（runtime 推 config.extensions 刷新列表） */
async function onConfirmUninstall() {
  if (!confirmTarget.value || uninstalling.value) return
  error.value = ''
  uninstalling.value = true
  const name = confirmTarget.value
  try {
    await extensionApi.uninstall(name)
    confirmTarget.value = ''
    toastInfo(t('settings.extension.uninstalledToast'))
  } catch (e) {
    // 卸载失败保持弹窗打开可重试（ES2）
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    uninstalling.value = false
  }
}

/** 升级扩展：从 npm 拉最新版重装（仅 user-installed） */
async function onUpgrade(name: string) {
  if (upgrading.value.has(name)) return
  error.value = ''
  const next = new Set(upgrading.value)
  next.add(name)
  upgrading.value = next
  try {
    await extensionApi.upgrade(name)
    toastInfo(t('settings.extension.upgradedToast'))
  } catch (e) {
    error.value = e instanceof Error
      ? t('settings.extension.upgradeFailed', { msg: e.message })
      : t('settings.extension.upgradeFailed', { msg: String(e) })
  } finally {
    const after = new Set(upgrading.value)
    after.delete(name)
    upgrading.value = after
  }
}
</script>
