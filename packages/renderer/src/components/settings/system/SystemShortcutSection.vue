<template>
  <!-- [w2] demo 对照：SystemSection.vue「快捷键」卡——副标题在卡头 gc-sub；行 = .srow
       （min-h 44 / px 6px / border-t hairline，首行无分隔）；键位 = .kbd（surface-2 底 /
       border 边 / r-xs / px 8px py 2px / text-xs / fg-2）；重录钮 = btn ghost（neutral-mid），
       取消态 danger；录制提示 = label 下 desc 行 accent 色（demo 无动画）。 -->
  <GroupCard>
    <template #head>
      <div class="gc-head-text">
        <h3 class="gc-title">{{ t('settings.system.shortcutTitle') }}</h3>
        <p class="gc-sub">{{ t('settings.system.shortcutRecordingHint') }}</p>
      </div>
    </template>
    <div class="px-[10px] pt-[4px] pb-[8px]">
      <div
        v-for="cmd in shortcutRows"
        :key="cmd.id"
        class="flex items-center gap-[16px] border-t border-hairline px-[6px] py-[10px] min-h-[44px] first:border-t-0"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ t(`settings.command.${cmd.id}`) }}</span>
          </div>
          <p v-if="recordingId === cmd.id" class="mt-0.5 text-[length:var(--text-sm)] text-accent">{{ t('settings.system.shortcutRecording') }}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <kbd
            v-if="recordingId !== cmd.id && cmd.shortcut"
            class="inline-flex items-center rounded-[var(--radius-xs)] border border-border bg-surface-2 px-[8px] py-[2px] font-mono text-[length:var(--text-xs)] text-neutral-fg-2"
          >{{ cmd.shortcut }}</kbd>
          <span v-else-if="recordingId !== cmd.id" class="text-[length:var(--text-2xs)] text-neutral-dim">-</span>
          <Button
            variant="ghost"
            size="dense"
            class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
            :class="{ 'text-danger': recordingId === cmd.id }"
            @click="recordingId === cmd.id ? cancelRecording() : startRecording(cmd.id)"
          >{{ recordingId === cmd.id ? t('settings.providerEdit.cancel') : t('settings.system.shortcutReRecord') }}</Button>
          <Button
            v-if="commandStore.shortcutOverrides.value[cmd.id]"
            variant="ghost"
            size="dense"
            class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
            @click="resetShortcut(cmd.id)"
          >{{ t('settings.system.shortcutReset') }}</Button>
        </div>
      </div>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { GroupCard } from '@taiji/ui/features/settings'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import type { SystemSettings } from '@taiji/core'

// 统一 Section 契约（未使用 system/emit：快捷键变更经 commandStore 持久化，不走 props/emit）
defineProps<{
  system: SystemSettings
}>()

defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()

// ── 快捷键重录 ──
const commandStore = useCommandStore()
const { appCommands } = commandStore

const DEFAULT_KEYS: Record<string, string> = {
  'new-session': 'n',
  'toggle-sidebar': 'b',
}

const recordingId = ref<string | null>(null)
const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

function formatShortcut(key: string): string {
  const parts = key.split('+')
  const result: string[] = []
  for (const p of parts) {
    if (p === 'mod') result.push(isMac ? '⌘' : 'Ctrl')
    else if (p === 'shift') result.push(isMac ? '⇧' : 'Shift')
    else if (p === 'alt') result.push(isMac ? '⌥' : 'Alt')
    else if (p === 'enter') result.push('↵')
    else if (p === 'escape') result.push('Esc')
    else if (p === ' ') result.push('Space')
    else result.push(p.toUpperCase())
  }
  return isMac ? result.join('') : result.join('+')
}

function displayShortcut(cmdId: string): string {
  const override = commandStore.shortcutOverrides.value[cmdId]
  if (override) return formatShortcut(override)
  const defaultKey = DEFAULT_KEYS[cmdId]
  if (!defaultKey) return ''
  return isMac ? `⌘${defaultKey.toUpperCase()}` : `Ctrl+${defaultKey.toUpperCase()}`
}

const shortcutRows = computed(() =>
  appCommands.value
    .filter((c) => c.id in DEFAULT_KEYS)
    .map((c) => ({ id: c.id, shortcut: displayShortcut(c.id) })),
)

function startRecording(cmdId: string): void {
  recordingId.value = cmdId
  window.addEventListener('keydown', onRecordKeydown, true)
}

function cancelRecording(): void {
  recordingId.value = null
  window.removeEventListener('keydown', onRecordKeydown, true)
}

function onRecordKeydown(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    cancelRecording()
    return
  }
  const mainKey = e.key.toLowerCase()
  if (['meta', 'control', 'shift', 'alt'].includes(mainKey)) return
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(mainKey)
  const combo = parts.join('+')

  const cmdId = recordingId.value!
  commandStore.setShortcutOverride(cmdId, combo)
  const idx = appCommands.value.findIndex((c) => c.id === cmdId)
  if (idx !== -1) {
    const updated = [...appCommands.value]
    updated[idx] = { ...updated[idx], shortcut: formatShortcut(combo) }
    commandStore.registerApp(updated)
  }
  cancelRecording()
}

function resetShortcut(cmdId: string): void {
  commandStore.setShortcutOverride(cmdId, null)
  const idx = appCommands.value.findIndex((c) => c.id === cmdId)
  if (idx !== -1) {
    const defaultKey = DEFAULT_KEYS[cmdId]
    const updated = [...appCommands.value]
    updated[idx] = {
      ...updated[idx],
      shortcut: isMac ? `⌘${defaultKey.toUpperCase()}` : `Ctrl+${defaultKey.toUpperCase()}`,
    }
    commandStore.registerApp(updated)
  }
}

onBeforeUnmount(() => {
  if (recordingId.value) cancelRecording()
})
</script>
