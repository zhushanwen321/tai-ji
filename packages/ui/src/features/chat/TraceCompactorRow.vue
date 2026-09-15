<template>
  <!--
    收编行（streaming-trace-window window wave，D5 零 chrome）。
    双态：折叠态（takeover=false）显示「展开全部（N 步）」+ 可选失败子计数 danger 高亮；
          全展态（takeover=true）显示「恢复精简」。点击 emit toggle。
    零 chrome：无 border/bg/divider/gradient/mask，仅一行 text-neutral-dim + chevron，hover 微亮。
    收编行位置：Turn.vue visible 块之前（design §3.1）。
  -->
  <div
    class="flex cursor-pointer select-none animate-notice-in items-center gap-1 py-1 text-[length:var(--text-2xs)] text-neutral-dim transition-colors hover:text-neutral-fg"
    data-testid="trace-compactor-row"
    @click="emit('toggle')"
  >
    <!-- chevron：折叠态 ▸（右指，可展开）；全展态旋转 90° 成 ▾（下指，已展开可收） -->
    <svg
      class="size-3 shrink-0 transition-transform"
      :class="takeover ? 'rotate-90' : ''"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
    <span class="font-mono uppercase tracking-[0.06em]">
      {{ takeover ? t('panel.message.traceCollapse') : t('panel.message.traceExpandAll', { count: compactedCount }) }}
    </span>
    <span
      v-if="!takeover && failedCount > 0"
      data-testid="trace-compactor-failed"
      class="text-danger"
    >
      · {{ t('panel.message.traceFailed', { count: failedCount }) }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  /** 被收编的已完成过程块数（不含 failed，failed 独立计数） */
  compactedCount: number
  /** 收编区内的失败块数（>0 时 danger 高亮「含 M 次失败」，D4） */
  failedCount: number
  /** 是否处于「展开全部」接管态（true → 显示「恢复精简」CTA） */
  takeover: boolean
}>()

const emit = defineEmits<{
  /** 点击切换 takeover（Turn.vue 落 store） */
  toggle: []
}>()

const { t } = useI18n()
</script>
