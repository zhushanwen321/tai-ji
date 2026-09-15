<!--
  Settings · Pi 启动预设管理页（容器）。
  列出全部预设（内置 + 自定义），支持新建/编辑/删除自定义预设。
  内置预设 name/id disabled + 恢复默认按钮。
  职责：数据加载（usePiPresets）+ 新建/设为默认/恢复/删除（store 操作统一在本层，FR7）
  + 删除确认弹窗 + loadError 态。列表渲染在 PresetListSection，详情编辑在 PresetDetailSection。
-->
<template>
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.preset') }}</h1>
        <p class="desc">{{ t('settings.preset.pageDesc') }}</p>
      </div>
      <div class="head-actions">
        <Button size="dense" class="rounded-sm text-[12px]" @click="onCreate">
          <Plus class="size-3.5" />
          {{ t('settings.preset.new') }}
        </Button>
      </div>
    </header>

    <!-- 加载失败提示（S-RN-7：消费 loadError 错误态） -->
    <div
      v-if="loadError"
      class="flex items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-[12px] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="flex-1">{{ loadError }}</span>
      <Button variant="ghost" size="dense" class="rounded-sm text-[11px]" @click="retryLoad">
        {{ t('common.retry') }}
      </Button>
    </div>

    <PresetListSection
      :presets="presets"
      :default-preset-id="defaultPresetId"
      :restoring="restoring"
      @set-default="onSetDefault"
      @restore="onRestore"
      @delete="confirmDeleteId = $event"
    >
      <template #default="{ preset, disabled }">
        <PresetDetailSection
          :preset="preset"
          :disabled="disabled"
          @update-field="onUpdateField"
          @mode-update="onModeUpdate"
        />
      </template>
    </PresetListSection>

    <!-- 删除确认弹窗 -->
    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      variant="danger"
      :title="t('settings.preset.deleteConfirmTitle', { name: deleteTargetName })"
      :description="t('settings.preset.deleteConfirmDesc')"
      :confirm-text="t('settings.preset.deleteConfirmBtn')"
      :cancel-text="t('settings.preset.cancel')"
      :loading="deleting"
      @confirm="onConfirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { Plus, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/settings/usePiPresets'
import { useToast } from '@/composables/useToast'
import { DEFAULT_PRESETS } from '@taiji/shared'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@taiji/shared'
import PresetListSection from './PresetListSection.vue'
import PresetDetailSection from './PresetDetailSection.vue'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()
const store = usePresetStore()
const { presets, defaultPresetId, loadError } = storeToRefs(store)
const { loadPresets, setDefault, create, update, remove } = usePiPresets()

/** base36 进制基数（Math.toString 参数，标准 JS 写法）。 */
const BASE36_RADIX = 36
/** Math.random() 输出 '0.xxx'，slice 跳过前 2 字符（'0.'）取余下随机串。 */
const RANDOM_PREFIX_LEN = 2

// 删除确认
const confirmDeleteId = ref('')
const deleting = ref(false)
const deleteDialogOpen = computed({
  get: () => confirmDeleteId.value !== '',
  set: (open: boolean) => {
    if (!open) confirmDeleteId.value = ''
  },
})
const deleteTargetName = computed(() =>
  presets.value.find((p) => p.id === confirmDeleteId.value)?.name ?? '',
)

// 恢复中集合
const restoring = ref<Set<string>>(new Set())

onMounted(() => {
  if (!presets.value.length) loadPresets()
})

/** 重试加载预设（S-RN-7：loadError 态下的手动重试入口）。 */
async function retryLoad() {
  try {
    await loadPresets()
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** 设为默认预设 */
async function onSetDefault(presetId: string) {
  try {
    await setDefault(presetId)
    toastInfo(t('settings.preset.defaultSet'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** 新建自定义预设 */
async function onCreate() {
  // crypto.randomUUID 在非安全上下文（HTTP / 旧环境）可能不可用，用 Date+random 兜底
  const uuid = crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(BASE36_RADIX).slice(RANDOM_PREFIX_LEN)}`
  const id = `custom:${uuid}`
  const newPreset: PiLaunchPreset = {
    id,
    name: t('settings.preset.newPresetName'),
    builtin: false,
    order: presets.value.length,
    toolMode: 'all',
    extensionMode: 'all',
  }
  try {
    await create(newPreset)
    toastInfo(t('settings.preset.created'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** 字段变更（name/description）→ 容器统一调 store update（FR7）。 */
async function onUpdateField(preset: PiLaunchPreset) {
  try {
    await update(preset)
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** 恢复内置预设到出厂设置 */
async function onRestore(preset: PiLaunchPreset) {
  const original = DEFAULT_PRESETS.find((d) => d.id === preset.id)
  if (!original) return
  const next = new Set(restoring.value)
  next.add(preset.id)
  restoring.value = next
  try {
    await update({ ...original, order: preset.order })
    toastInfo(t('settings.preset.restored'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    const after = new Set(restoring.value)
    after.delete(preset.id)
    restoring.value = after
  }
}

/** 删除自定义预设 */
async function onConfirmDelete() {
  if (!confirmDeleteId.value || deleting.value) return
  deleting.value = true
  try {
    await remove(confirmDeleteId.value)
    confirmDeleteId.value = ''
    toastInfo(t('settings.preset.deleted'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    deleting.value = false
  }
}

/** 工具/扩展模式变更（来自 PresetModeSection，经 PresetDetailSection 透传） */
async function onModeUpdate(payload: { presetId: string; toolMode?: ToolMode; extensionMode?: ExtensionMode; allowedTools?: string[]; deniedTools?: string[]; allowedExtensions?: string[]; deniedExtensions?: string[] }) {
  const target = presets.value.find((p) => p.id === payload.presetId)
  if (!target || target.builtin) return
  const updated: PiLaunchPreset = {
    ...target,
    ...(payload.toolMode !== undefined && { toolMode: payload.toolMode }),
    ...(payload.extensionMode !== undefined && { extensionMode: payload.extensionMode }),
    ...(payload.allowedTools !== undefined && { allowedTools: payload.allowedTools }),
    ...(payload.deniedTools !== undefined && { deniedTools: payload.deniedTools }),
    ...(payload.allowedExtensions !== undefined && { allowedExtensions: payload.allowedExtensions }),
    ...(payload.deniedExtensions !== undefined && { deniedExtensions: payload.deniedExtensions }),
  }
  try {
    await update(updated)
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}
</script>
