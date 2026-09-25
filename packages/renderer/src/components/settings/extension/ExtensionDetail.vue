<template>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <div class="flex items-center gap-2">
      <span class="truncate text-[12px] font-medium text-neutral-fg">{{ ext.displayName ?? ext.name }}</span>
      <span class="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] text-neutral-dim">v{{ ext.version }}</span>
      <!-- 来源标签 -->
      <span v-if="ext.source === 'user-installed'" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{{ t('settings.extension.sourceUser') }}</span>
      <span v-if="ext.source === 'discovery'" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{{ t('settings.extension.sourceDiscovery') }}</span>
      <!-- 内置 badge：builtin 层扩展（layer='builtin'，不可卸载；infrastructure 子级亦不可禁） -->
      <span v-if="ext.layer === 'builtin'" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{{ t('settings.extension.mandatoryBadge') }}</span>
    </div>
    <span class="truncate text-[11px] text-neutral-mid">{{ ext.description }}</span>
    <div v-if="ext.tools?.length" class="mt-1 flex flex-wrap gap-1">
      <span v-for="t in ext.tools" :key="t" class="rounded-sm bg-surface px-1 py-0.5 font-mono text-[10px] text-neutral-dim">{{ t }}</span>
    </div>
    <!-- 自动升级开关（仅 user 层 + user-installed 来源扩展显示；builtin 由 runtime 管理） -->
    <div v-if="ext.layer !== 'builtin' && ext.source === 'user-installed'" class="mt-1.5 flex items-center gap-2">
      <Switch
        :model-value="ext.autoUpgrade ?? false"
        class="shrink-0"
        :disabled="toggling.has(ext.name)"
        :aria-label="t('settings.extension.autoUpgrade')"
        @update:model-value="onSetAutoUpgrade(ext, $event)"
      />
      <span class="text-[11px] text-neutral-mid">{{ t('settings.extension.autoUpgrade') }}</span>
    </div>
    <!-- 操作失败就近反馈（非静默吞，AGENTS.md 规则 #3） -->
    <div v-if="error" class="flex items-center gap-1.5 text-[11px] text-danger">
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="truncate">{{ error }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { getSettingsTransport } from '@taiji/core'
import type { ExtensionItem } from '@taiji/core'
import { getSettingsStore } from '@taiji/core'
import { runOptimisticUpdate } from '@taiji/core/foundation/optimistic-update'

defineProps<{ ext: ExtensionItem }>()

const settingsStore = getSettingsStore()
const { t } = useI18n()

/** autoUpgrade 切换中（防双击：API 期间 disable Switch） */
const toggling = ref<Set<string>>(new Set())
/** 操作失败信息（就近显示在 autoUpgrade 行下方） */
const error = ref('')

/** 设置扩展自动升级开关（仅 user-installed）→ 乐观更新 + 持久化。
 * 编排走乐观更新协议（runOptimisticUpdate，apply/rollback/commit 三步，失败回滚后 rethrow），
 * 本地只把 rethrow 的错误映射到既有错误面（error ref），不手写 try/catch 回滚。 */
async function onSetAutoUpgrade(ext: ExtensionItem, enabled: boolean) {
  if (toggling.value.has(ext.name)) return
  error.value = ''
  const next = new Set(toggling.value)
  next.add(ext.name)
  toggling.value = next
  try {
    // apply 内经 setExtensionAutoUpgrade（协议原语，返回旧值）顺带捕获回滚快照
    let old = false
    await runOptimisticUpdate({
      apply: () => {
        old = settingsStore.setExtensionAutoUpgrade(ext.name, enabled)
      },
      rollback: () => {
        settingsStore.setExtensionAutoUpgrade(ext.name, old)
      },
      commit: () => getSettingsTransport().setExtensionAutoUpgrade(ext.name, enabled),
    })
  } catch (e) {
    error.value = e instanceof Error
      ? t('settings.extension.autoUpgradeFailed', { msg: e.message })
      : t('settings.extension.autoUpgradeFailed', { msg: String(e) })
  } finally {
    const after = new Set(toggling.value)
    after.delete(ext.name)
    toggling.value = after
  }
}
</script>
