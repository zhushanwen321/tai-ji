<template>
  <!-- 来源选择视图（阶段一）：两选项各配一句来源说明（设计 §3.1）。行形态与候选
       列表行同构（卡片行 + hover），选定即由父层进入阶段二拉取该源候选 -->
  <div data-testid="import-source-picker" class="flex flex-col gap-2 py-1">
    <div
      v-for="opt in sourceOptions"
      :key="opt.kind"
      :data-testid="`import-source-option-${opt.kind}`"
      class="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 transition-colors hover:border-border-strong hover:bg-surface-hover"
      @click="emit('pick', opt.kind)"
    >
      <component :is="opt.icon" class="mt-0.5 size-4 shrink-0 text-neutral-mid" />
      <span class="min-w-0 flex-1">
        <span class="block text-sm text-neutral-fg">{{ opt.title }}</span>
        <span class="mt-0.5 block text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
          {{ opt.desc }}
        </span>
      </span>
      <ChevronRight class="mt-0.5 size-4 shrink-0 text-neutral-dim" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Database, FileText } from '@lucide/vue'
import type { ImportSourceKind } from '@taiji/shared'

const emit = defineEmits<{ pick: [kind: ImportSourceKind] }>()

const { t } = useI18n()

/** 来源选项（两源固定；G2 扩展点 = 第三源在此加一项 + i18n 双语文案） */
const sourceOptions = computed(() => [
  {
    kind: 'pi' as const,
    icon: FileText,
    title: t('importSession.sourcePiTitle'),
    desc: t('importSession.sourcePiDesc'),
  },
  {
    kind: 'zcode' as const,
    icon: Database,
    title: t('importSession.sourceZcodeTitle'),
    desc: t('importSession.sourceZcodeDesc'),
  },
])
</script>
