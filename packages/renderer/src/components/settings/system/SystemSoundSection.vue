<template>
  <GroupCard :title="t('settings.system.soundTitle')">
    <div class="px-2.5 pt-1 pb-2">
      <SettingRow :label="t('settings.system.successSound')" :desc="t('settings.system.successSoundDesc')">
        <div class="flex items-center gap-2">
          <Select
            :model-value="system.successSound || SOUND_DEFAULT"
            @update:model-value="onSuccessSoundChange"
          >
            <SelectTrigger class="h-8 w-[160px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SOUND_DEFAULT">
                {{ t('settings.system.soundDefault') }}
                <template #action>
                  <SoundPreviewButton
                    :loading="previewingKey === 'success:default'"
                    :title="t('settings.system.soundPreview')"
                    :data-testid="`preview-success-default`"
                    @click="previewSound('success', getDefaultSound(currentPlatform, 'success'), 'default')"
                  />
                </template>
              </SelectItem>
              <SelectItem v-for="s in soundList" :key="s.id" :value="s.id">
                {{ s.name }}
                <template #action>
                  <SoundPreviewButton
                    :loading="previewingKey === `success:${s.id}`"
                    :title="t('settings.system.soundPreview')"
                    :data-testid="`preview-success-${s.id}`"
                    @click="previewSound('success', s.id, s.id)"
                  />
                </template>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            size="dense"
            class="h-8 min-w-[6.5rem] px-3 text-[11px]"
            :disabled="!!previewingKey && !previewingKey.startsWith('success:')"
            :aria-label="t('settings.system.soundPreview')"
            @click="previewSound('success', system.successSound || getDefaultSound(currentPlatform, 'success'), system.successSound || 'default')"
          >
            <Loader2 v-if="previewingKey?.startsWith('success:')" class="size-3.5 animate-spin text-accent" />
            <Volume2 v-else class="size-3.5" />
            {{ previewingKey?.startsWith('success:') ? t('settings.system.soundPreviewing') : t('settings.system.soundPreview') }}
          </Button>
        </div>
      </SettingRow>
      <SettingRow :label="t('settings.system.errorSound')" :desc="t('settings.system.errorSoundDesc')">
        <div class="flex items-center gap-2">
          <Select
            :model-value="system.errorSound || SOUND_DEFAULT"
            @update:model-value="onErrorSoundChange"
          >
            <SelectTrigger class="h-8 w-[160px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SOUND_DEFAULT">
                {{ t('settings.system.soundDefault') }}
                <template #action>
                  <SoundPreviewButton
                    :loading="previewingKey === 'error:default'"
                    :title="t('settings.system.soundPreview')"
                    :data-testid="`preview-error-default`"
                    @click="previewSound('error', getDefaultSound(currentPlatform, 'error'), 'default')"
                  />
                </template>
              </SelectItem>
              <SelectItem v-for="s in soundList" :key="s.id" :value="s.id">
                {{ s.name }}
                <template #action>
                  <SoundPreviewButton
                    :loading="previewingKey === `error:${s.id}`"
                    :title="t('settings.system.soundPreview')"
                    :data-testid="`preview-error-${s.id}`"
                    @click="previewSound('error', s.id, s.id)"
                  />
                </template>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            size="dense"
            class="h-8 min-w-[6.5rem] px-3 text-[11px]"
            :disabled="!!previewingKey && !previewingKey.startsWith('error:')"
            :aria-label="t('settings.system.soundPreview')"
            @click="previewSound('error', system.errorSound || getDefaultSound(currentPlatform, 'error'), system.errorSound || 'default')"
          >
            <Loader2 v-if="previewingKey?.startsWith('error:')" class="size-3.5 animate-spin text-accent" />
            <Volume2 v-else class="size-3.5" />
            {{ previewingKey?.startsWith('error:') ? t('settings.system.soundPreviewing') : t('settings.system.soundPreview') }}
          </Button>
        </div>
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Volume2, Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard, SoundPreviewButton } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { listSystemSounds } from '@/api/domains/settings'
import { playByName } from '@/composables/effects/useCompletionSound'
import { getDefaultSound, detectPlatform } from '@/composables/sound-platform'
import type { SystemSettings } from '@taiji/core'

interface SoundInfo { id: string; name: string }

// 模板经 system.* 访问 props（defineProps 注册后自动暴露），script 侧无需持有句柄
defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()

// ── 系统提示音 ──
const soundList = ref<SoundInfo[]>([])
const currentPlatform = detectPlatform()
const SOUND_DEFAULT = '__default__'

function onSuccessSoundChange(value: unknown): void {
  const v = typeof value === 'string' ? value : ''
  emit('update', { successSound: v === SOUND_DEFAULT ? '' : v })
}
function onErrorSoundChange(value: unknown): void {
  const v = typeof value === 'string' ? value : ''
  emit('update', { errorSound: v === SOUND_DEFAULT ? '' : v })
}

const PREVIEW_LOADING_MS = 300
const previewingKey = ref<string | null>(null)

onMounted(async () => {
  try {
    const result = await listSystemSounds()
    if (result.sounds.length) soundList.value = result.sounds
  } catch (err) {
    // best-effort：音效列表加载失败回退空列表（Select 仍显示默认音），不打扰用户
    console.error('[settings] listSystemSounds failed:', err)
  }
})

async function previewSound(kind: 'success' | 'error', name: string, trackId: string): Promise<void> {
  if (!name) return
  if (previewingKey.value) return
  const key = `${kind}:${trackId}`
  previewingKey.value = key
  try {
    await playByName(name)
  } finally {
    setTimeout(() => {
      if (previewingKey.value === key) previewingKey.value = null
    }, PREVIEW_LOADING_MS)
  }
}
</script>
