<!--
  CanvasArgStrip —— 节点卡框内论据条（problem-solve-canvas §3.1(3)，demo v3 arg-strip 平移）。

  支持/反对两条横框收于宿主卡内底部（论据不占画布位——布局法则「论证挂侧翼」的
  落点形态）；行内：fact 论据核实角标（对勾 = 已核实 / 问号 = 未核实——未核实的不
  算数）、标题、互驳留痕徽标（被驳 / 反驳→目标）。超 4 条折叠计数。
-->
<template>
  <div
    class="mt-1.5 rounded-[var(--radius)] px-2 py-1"
    :class="polarity === 'support' ? 'bg-accent-soft' : 'bg-danger-soft'"
    :data-testid="`canvas-arg-strip-${polarity}`"
  >
    <p
      class="font-mono text-[length:var(--text-3xs)] font-semibold"
      :class="polarity === 'support' ? 'text-accent' : 'text-danger'"
    >
      {{ polarity === 'support'
        ? t('panel.canvas.argSupport', { n: args.length })
        : t('panel.canvas.argObject', { n: args.length }) }}
    </p>
    <Button
      v-for="arg in visible"
      :key="arg.id"
      variant="ghost"
      size="sm"
      class="flex w-full items-center gap-1.5 rounded-sm px-1 py-[3px] text-left"
      :class="{ 'ring-1 ring-neutral-fg': focused }"
      :data-testid="`canvas-arg-row`"
      :data-arg-id="arg.id"
      @click.stop="emit('select', arg.id)"
    >
      <span
        v-if="arg.materiality === 'fact'"
        class="flex-none rounded-[var(--radius-xs)] px-1 font-mono text-[length:var(--text-3xs)] font-bold"
        :class="arg.factVerified ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'"
        :title="arg.factVerified ? t('panel.canvas.factVerified') : t('panel.canvas.factUnverified')"
        :data-testid="`canvas-arg-verified-${arg.factVerified ? 'ok' : 'unknown'}`"
      >
        <Check v-if="arg.factVerified" class="size-3" aria-hidden="true" />
        <template v-else>?</template>
      </span>
      <span class="min-w-0 flex-1 truncate text-[length:var(--text-2xs)] text-neutral-fg">{{ arg.content }}</span>
      <span
        v-if="rebuttedIds?.has(arg.id)"
        class="flex-none font-mono text-[length:var(--text-3xs)] text-danger"
        :title="rebuttedTitle"
      >{{ t('panel.canvas.argRebutted') }}</span>
    </Button>
    <span v-if="args.length > VISIBLE_LIMIT" class="block px-1 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
      {{ t('panel.canvas.argMore', { n: args.length - VISIBLE_LIMIT }) }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@lucide/vue'
import type { CanvasNode } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  polarity: 'support' | 'object'
  args: CanvasNode[]
  /** 选中论据 id（选中态留在论据条目上——demo 焦点形态）。 */
  selectedId?: string | null
  /** 被反驳论据 id 集（互驳留痕徽标，逐行判定）。 */
  rebuttedIds?: Set<string>
}>()

const emit = defineEmits<{ select: [nodeId: string] }>()

const { t } = useI18n()

const VISIBLE_LIMIT = 4

const visible = computed(() => props.args.slice(0, VISIBLE_LIMIT))
const focused = computed(() => props.args.some((a) => a.id === props.selectedId))
const rebuttedTitle = computed(() => t('panel.canvas.argRebuttedTitle'))
</script>
