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

        <!-- 模式提示词两卡（替换 / 追加）。数据面 preset.prompt，保存走 preset.update；
             上限是两段合计，故两卡共用下方一行合计计数（禁止分卡各自计数）。 -->
        <div
          v-if="promptDrafts[preset.id]"
          class="flex flex-col gap-3 border-t border-border px-3 py-3"
          data-testid="preset-prompt-section"
        >
          <!-- 替换卡（红字警示；保存二次确认由共用写盘闸判定，E2） -->
          <GroupCard>
            <template #head>
              <h3 class="text-[12px] font-semibold text-neutral-fg">{{ t('settings.preset.promptReplaceTitle') }}</h3>
            </template>
            <template #actions>
              <Switch
                data-testid="preset-prompt-replace-switch"
                :model-value="promptDrafts[preset.id].replaceEnabled"
                @update:model-value="(v) => onToggleSegment(preset.id, 'replace', v === true)"
              />
            </template>
            <div class="px-4 py-3">
              <p
                data-testid="preset-prompt-replace-warning"
                class="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger"
              >
                <AlertTriangle class="mt-px size-3.5 shrink-0" />
                <span>{{ t('settings.preset.promptReplaceWarning') }}</span>
              </p>
              <Label class="mb-1 block text-[11px] text-neutral-dim">{{ t('settings.preset.promptReplaceLabel') }}</Label>
              <Textarea
                v-model="promptDrafts[preset.id].replaceText"
                data-testid="preset-prompt-replace-input"
                :disabled="!promptDrafts[preset.id].replaceEnabled"
                :placeholder="t('settings.preset.promptReplacePlaceholder')"
                class="min-h-[120px] resize-y font-mono text-[12px]"
              />
              <div class="mt-1 flex items-center justify-end gap-1.5">
                <Button data-testid="preset-prompt-replace-discard" variant="danger" size="dense" :disabled="!segmentDirty(preset.id, 'replace')" @click="discardPromptCard(preset.id, 'replace')">
                  {{ t('settings.preset.promptDiscard') }}
                </Button>
                <Button data-testid="preset-prompt-replace-reset" variant="secondary" size="dense" :disabled="!segmentDirty(preset.id, 'replace')" @click="resetReplaceCard(preset.id)">
                  {{ t('settings.preset.promptRestoreDefault') }}
                </Button>
                <Button data-testid="preset-prompt-replace-save" size="dense" :disabled="!segmentDirty(preset.id, 'replace')" @click="onSavePrompt(preset.id)">
                  {{ t('settings.preset.promptSave') }}
                </Button>
              </div>
            </div>
          </GroupCard>

          <!-- 追加卡（保存入口与替换卡共用闸门——写盘 payload 恒含两段） -->
          <GroupCard>
            <template #head>
              <h3 class="text-[12px] font-semibold text-neutral-fg">{{ t('settings.preset.promptAppendTitle') }}</h3>
            </template>
            <template #actions>
              <Switch
                data-testid="preset-prompt-append-switch"
                :model-value="promptDrafts[preset.id].appendEnabled"
                @update:model-value="(v) => onToggleSegment(preset.id, 'append', v === true)"
              />
            </template>
            <div class="px-4 py-3">
              <p class="mb-2 text-[11px] leading-relaxed text-neutral-mid">{{ t('settings.preset.promptAppendHint') }}</p>
              <Label class="mb-1 block text-[11px] text-neutral-dim">{{ t('settings.preset.promptAppendLabel') }}</Label>
              <Textarea
                v-model="promptDrafts[preset.id].appendText"
                data-testid="preset-prompt-append-input"
                :disabled="!promptDrafts[preset.id].appendEnabled"
                :placeholder="t('settings.preset.promptAppendPlaceholder')"
                class="min-h-[120px] resize-y font-mono text-[12px]"
              />
              <div class="mt-1 flex items-center justify-end gap-1.5">
                <Button data-testid="preset-prompt-append-discard" variant="danger" size="dense" :disabled="!segmentDirty(preset.id, 'append')" @click="discardPromptCard(preset.id, 'append')">
                  {{ t('settings.preset.promptDiscard') }}
                </Button>
                <Button data-testid="preset-prompt-append-save" size="dense" :disabled="!segmentDirty(preset.id, 'append')" @click="onSavePrompt(preset.id)">
                  {{ t('settings.preset.promptSave') }}
                </Button>
              </div>
            </div>
          </GroupCard>

          <!-- 两卡共用一行合计计数（上限 = 两段合计 16000，非每段各自） -->
          <div class="flex items-center justify-end">
            <span data-testid="preset-prompt-combined-count" class="font-mono text-[10px] text-neutral-dim">
              {{ t('settings.preset.promptCombinedCount', { count: combinedCount(preset.id), max: maxLength }) }}
            </span>
          </div>
        </div>
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

    <!-- 替换提示词保存二次确认（E2：未确认不保存；取消 = 改回仅追加） -->
    <ConfirmDialog
      v-model:open="replaceConfirmOpen"
      variant="danger"
      :title="t('settings.preset.promptReplaceConfirmTitle')"
      :description="t('settings.preset.promptReplaceConfirmDesc')"
      :confirm-text="t('settings.preset.promptReplaceConfirmBtn')"
      :cancel-text="t('settings.preset.promptReplaceConfirmCancel')"
      @confirm="onConfirmReplaceSave"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, reactive, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { Plus, AlertCircle, AlertTriangle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/ui/dialog'
import { GroupCard } from '@taiji/ui/features/settings'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/settings/usePiPresets'
import { useToast } from '@/composables/useToast'
import { DEFAULT_PRESETS, SYSTEM_PROMPT_MAX_LENGTH } from '@taiji/shared'
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

// ── 模式提示词两卡（替换 / 追加）──
// 每预设一份编辑草稿 + 一份已保存快照（per-preset Map 分区，避免跨预设串味）。

/** 提示词两段编辑草稿。 */
interface PromptDraft {
  replaceEnabled: boolean
  replaceText: string
  appendEnabled: boolean
  appendText: string
}

const maxLength = SYSTEM_PROMPT_MAX_LENGTH
const promptDrafts = reactive<Record<string, PromptDraft>>({})
const promptSaved = reactive<Record<string, PromptDraft>>({})

/** 从预设持久态提取提示词快照（缺省 = 两段关闭且空）。 */
function readPromptDraft(preset: PiLaunchPreset): PromptDraft {
  return {
    replaceEnabled: preset.prompt?.replace?.enabled ?? false,
    replaceText: preset.prompt?.replace?.prompt ?? '',
    appendEnabled: preset.prompt?.append?.enabled ?? false,
    appendText: preset.prompt?.append?.prompt ?? '',
  }
}

/** 某卡 dirty（快照 diff）。 */
function segmentDirty(id: string, card: 'replace' | 'append'): boolean {
  const draft = promptDrafts[id]
  const saved = promptSaved[id]
  if (!draft || !saved) return false
  const enabledKey = card === 'replace' ? 'replaceEnabled' : 'appendEnabled'
  const textKey = card === 'replace' ? 'replaceText' : 'appendText'
  return draft[enabledKey] !== saved[enabledKey] || draft[textKey] !== saved[textKey]
}

/** 两段合计字符数（上限针对合计，不分卡各自计数）。 */
function combinedCount(id: string): number {
  const draft = promptDrafts[id]
  return draft ? draft.replaceText.length + draft.appendText.length : 0
}

/** 同步草稿：缺则初始化；用户未编辑（非 dirty）则跟随 store 最新持久态（含 RPC reply 回写）。 */
function syncPromptDrafts(): void {
  for (const preset of presets.value) {
    if (!promptDrafts[preset.id]) {
      const init = readPromptDraft(preset)
      promptDrafts[preset.id] = { ...init }
      promptSaved[preset.id] = { ...init }
    } else if (!segmentDirty(preset.id, 'replace') && !segmentDirty(preset.id, 'append')) {
      const latest = readPromptDraft(preset)
      promptDrafts[preset.id] = { ...latest }
      promptSaved[preset.id] = { ...latest }
    }
  }
}

watch(presets, syncPromptDrafts, { immediate: true, deep: true })

/** 两卡开关（共用入口）。 */
function onToggleSegment(id: string, card: 'replace' | 'append', enabled: boolean): void {
  const draft = promptDrafts[id]
  if (!draft) return
  if (card === 'replace') draft.replaceEnabled = enabled
  else draft.appendEnabled = enabled
}

/** 放弃某卡编辑：还原已保存快照。 */
function discardPromptCard(id: string, card: 'replace' | 'append'): void {
  const draft = promptDrafts[id]
  const saved = promptSaved[id]
  if (!draft || !saved) return
  if (card === 'replace') {
    draft.replaceEnabled = saved.replaceEnabled
    draft.replaceText = saved.replaceText
  } else {
    draft.appendEnabled = saved.appendEnabled
    draft.appendText = saved.appendText
  }
}

/** 恢复默认：清空替换卡文本并关开关（与 SystemPromptPage 范式一致）。 */
function resetReplaceCard(id: string): void {
  const draft = promptDrafts[id]
  if (!draft) return
  draft.replaceEnabled = false
  draft.replaceText = ''
}

const replaceConfirmId = ref('')
const replaceConfirmOpen = computed({
  get: () => replaceConfirmId.value !== '',
  set: (open: boolean) => {
    if (open) return
    const id = replaceConfirmId.value
    replaceConfirmId.value = ''
    // 取消二次确认 = 改回仅追加（E2 恢复通道）
    if (id) onToggleSegment(id, 'replace', false)
  },
})

/** E2 判据：payload 含「启用 + 文案非空」的替换段，且相对已保存快照有变化（改写或此前未启用）。
 * 设计 `.tmp/tech-design/mode-system-composer-density.md` §6.3 D3b / §7.5 E2（用户裁决 ③）。 */
function needsReplaceConfirm(id: string): boolean {
  const draft = promptDrafts[id]
  const saved = promptSaved[id]
  if (!draft?.replaceEnabled || !draft.replaceText.trim()) return false
  return !saved || !saved.replaceEnabled || saved.replaceText !== draft.replaceText
}

/** 两卡共用保存入口——闸门只在唯一写点 persistPrompt（payload 恒含两段）。 */
function onSavePrompt(id: string): void {
  void persistPrompt(id)
}

/** 二次确认通过：放行写盘（confirmed 跳过闸门，避免重入弹窗）。 */
async function onConfirmReplaceSave(): Promise<void> {
  const id = replaceConfirmId.value
  replaceConfirmId.value = ''
  if (id) await persistPrompt(id, { confirmed: true })
}

/** 写盘（两卡唯一入口）；未确认 → 不落盘任何段（避免半成功态）。超限/形状错误由后端返回文案。 */
async function persistPrompt(id: string, opts?: { confirmed?: boolean }): Promise<void> {
  const preset = presets.value.find((p) => p.id === id)
  const draft = promptDrafts[id]
  if (!preset || !draft) return
  if (!opts?.confirmed && needsReplaceConfirm(id)) {
    replaceConfirmId.value = id
    return
  }
  const updated: PiLaunchPreset = {
    ...preset,
    prompt: {
      replace: { enabled: draft.replaceEnabled, prompt: draft.replaceText },
      append: { enabled: draft.appendEnabled, prompt: draft.appendText },
    },
  }
  try {
    await update(updated)
    // 保存成功：快照对齐（watcher 随后也会按 reply 持久态同步）
    promptSaved[id] = { ...draft }
    toastInfo(t('settings.preset.promptSaved'))
  } catch (e) {
    // 超限/形状错误：直接展示后端 preset_guard_error 文案（前端不另造上限判定）
    toastError(e instanceof Error ? e.message : String(e))
  }
}

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
