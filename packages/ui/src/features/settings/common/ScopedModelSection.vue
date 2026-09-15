<!--
  Scoped Model Section —— 模型白名单配置组件（props/emits 接线，ui 包零 renderer import）。

  设计决策：scoped-model-design D5（picker）、D6（包拓扑）。
  列表行：模型名 + provider 名 + 警示标记 + 上移/下移/移除。
  添加面板：按 provider 分组全量模型列表 + 搜索 + 多选确认。
-->
<template>
  <section data-testid="scoped-model-section" class="overflow-hidden rounded-card bg-card">
    <div class="flex items-center justify-between px-4 py-3">
      <div>
        <h3 class="text-[13px] font-medium text-neutral-fg">{{ t('settings.scopedModel.title') }}</h3>
        <p class="mt-0.5 text-[11px] text-neutral-mid">{{ t('settings.scopedModel.desc') }}</p>
      </div>
      <Button
        variant="secondary"
        size="dense"
        data-testid="scoped-add-btn"
        @click="showAddPanel = !showAddPanel"
      >
        <Plus class="size-3.5" />
        {{ t('settings.scopedModel.add') }}
      </Button>
    </div>

    <!-- 空状态 -->
    <div
      v-if="!scopedList.length && !showAddPanel"
      data-testid="scoped-empty"
      class="px-4 pb-3 text-[11px] text-neutral-dim"
    >
      {{ t('settings.scopedModel.emptyHint') }}
    </div>

    <!-- 已配置列表 -->
    <div v-if="scopedList.length" class="border-t border-border">
      <div
        v-for="(item, idx) in scopedList"
        :key="item.scoped"
        data-testid="scoped-row"
        class="flex items-center gap-2 px-4 py-2 text-[12px]"
        :class="{ 'border-t border-border': idx > 0 }"
      >
        <!-- 模型名 -->
        <span class="flex-1 truncate font-medium text-neutral-fg" data-testid="scoped-model-name">
          {{ item.modelName }}
        </span>
        <!-- provider 名 -->
        <span class="shrink-0 text-[11px] text-neutral-mid" data-testid="scoped-provider-name">
          {{ item.providerName }}
        </span>
        <!-- 警示标记：apiKeySet=false -->
        <span
          v-if="!item.apiKeySet"
          data-testid="scoped-warn-nokey"
          class="shrink-0 rounded-sm bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn"
        >
          {{ t('settings.scopedModel.noKey') }}
        </span>
        <!-- 已不存在标记 -->
        <span
          v-if="item.missing"
          data-testid="scoped-warn-missing"
          class="shrink-0 rounded-sm bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger"
        >
          {{ t('settings.scopedModel.missing') }}
        </span>
        <!-- 操作按钮 -->
        <div class="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            data-testid="scoped-move-up"
            class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
            :disabled="idx === 0"
            :aria-label="t('settings.scopedModel.moveUp')"
            @click="emit('move', { scoped: item.scoped, dir: 'up' })"
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="scoped-move-down"
            class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
            :disabled="idx === scopedList.length - 1"
            :aria-label="t('settings.scopedModel.moveDown')"
            @click="emit('move', { scoped: item.scoped, dir: 'down' })"
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="scoped-remove"
            class="size-7 rounded-sm p-0 text-danger hover:bg-danger-soft"
            :aria-label="t('settings.scopedModel.remove')"
            @click="emit('remove', item.scoped)"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>

    <!-- 添加面板 -->
    <div
      v-if="showAddPanel"
      data-testid="scoped-add-panel"
      class="border-t border-border"
    >
      <!-- 搜索框 -->
      <div class="px-4 pt-3 pb-2">
        <Input
          v-model="searchQuery"
          :placeholder="t('settings.scopedModel.searchPlaceholder')"
          class="h-8 text-[12px]"
          data-testid="scoped-search"
        />
      </div>

      <!-- 按 provider 分组的全量模型列表 -->
      <div class="max-h-[240px] overflow-y-auto px-4">
        <div v-if="filteredGroups.length === 0" class="py-4 text-center text-[11px] text-neutral-dim">
          {{ t('settings.scopedModel.noResults') }}
        </div>
        <div
          v-for="group in filteredGroups"
          :key="group.providerId"
          data-testid="scoped-group"
        >
          <div class="sticky top-0 bg-surface-2 px-2 py-1.5 text-[11px] font-semibold text-neutral-fg">
            {{ group.providerName }}
          </div>
          <div
            v-for="model in group.models"
            :key="model.fullId"
            class="flex items-center gap-2 px-2 py-1.5"
            :class="{ 'opacity-40': model.alreadyAdded }"
            data-testid="scoped-add-item"
          >
            <Checkbox
              :model-value="selectedToAdd.has(model.fullId)"
              :disabled="model.alreadyAdded"
              class="shrink-0"
              @update:model-value="toggleSelection(model.fullId)"
            />
            <span class="flex-1 truncate text-[12px] text-neutral-fg">{{ model.name || model.modelId }}</span>
            <span
              v-if="!model.apiKeySet"
              data-testid="scoped-add-warn"
              class="shrink-0 rounded-sm bg-warn-soft px-1 py-0.5 text-[10px] text-warn"
            >
              {{ t('settings.scopedModel.noKey') }}
            </span>
            <span
              v-if="model.alreadyAdded"
              class="shrink-0 text-[10px] text-neutral-dim"
            >
              {{ t('settings.scopedModel.added') }}
            </span>
          </div>
        </div>
      </div>

      <!-- 确认按钮 -->
      <div class="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
        <Button variant="ghost" size="dense" @click="cancelAdd">
          {{ t('settings.providerEdit.cancel') }}
        </Button>
        <Button
          size="dense"
          :disabled="selectedToAdd.size === 0"
          data-testid="scoped-confirm-add"
          @click="confirmAdd"
        >
          {{ t('settings.scopedModel.confirmAdd', selectedToAdd.size, { named: { count: selectedToAdd.size } }) }}
        </Button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, ChevronUp, ChevronDown, Trash2 } from '@lucide/vue'
import { Button, Input, Checkbox } from '@taiji/ui'
import type { ScopedRenderItem, SelectableModel } from './scoped-model-types'

// 签名保持单行紧凑形态：root unit 集成契约（C4/C5）对此做逐字文本匹配
const props = defineProps<{ scopedList: ScopedRenderItem[]; selectableModels: SelectableModel[] }>()

const emit = defineEmits<{ add: [models: string[]]; remove: [scoped: string]; move: [{ scoped: string; dir: 'up' | 'down' }] }>()

const { t } = useI18n()

// ── 添加面板状态 ──
const showAddPanel = ref(false)
const searchQuery = ref('')
const selectedToAdd = ref<Set<string>>(new Set())

/** 已配置的 scoped 集合（快速查找，用于禁选重复项） */
const scopedSet = computed(() => new Set(props.scopedList.map((s) => s.scoped)))

/** 按 provider 分组 + 搜索过滤 */
const filteredGroups = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  const grouped = new Map<string, { providerId: string; providerName: string; models: Array<SelectableModel & { alreadyAdded: boolean }> }>()
  for (const m of props.selectableModels) {
    if (q && !m.name?.toLowerCase().includes(q) && !m.modelId.toLowerCase().includes(q) && !m.providerName.toLowerCase().includes(q)) continue
    let group = grouped.get(m.providerId)
    if (!group) {
      group = { providerId: m.providerId, providerName: m.providerName, models: [] }
      grouped.set(m.providerId, group)
    }
    group.models.push({ ...m, alreadyAdded: scopedSet.value.has(m.fullId) })
  }
  return Array.from(grouped.values())
})

function toggleSelection(fullId: string): void {
  const next = new Set(selectedToAdd.value)
  if (next.has(fullId)) next.delete(fullId)
  else next.add(fullId)
  selectedToAdd.value = next
}

/** 添加面板重置（清空多选 + 关面板 + 清搜索词）。 */
function resetAddPanel(): void {
  selectedToAdd.value = new Set()
  showAddPanel.value = false
  searchQuery.value = ''
}

function confirmAdd(): void {
  if (selectedToAdd.value.size === 0) return
  emit('add', Array.from(selectedToAdd.value))
  resetAddPanel()
}

function cancelAdd(): void {
  resetAddPanel()
}
</script>
