<!--
  TrayConfirmButton —— 托盘行内两段式确认按钮（bash kill / subagent cancel / workflow abort
  三处同形标记收敛于此）。

  契约：
  - `testid`（基础名）→ `data-testid="${testid}-confirm"`（确认态）/ `${testid}`（常态），
    字面量由调用方给定、本组件不加前后缀以外的词；`data-confirming` 同源派生。
  - `title` / `confirmTitle` 按确认态切换。
  - 视觉：常态 dim + hover 红；确认态 danger 实心。差异面以 props 表达（bash/subagent 有
    rounded-sm、workflow 无；bash 确认态补 opacity-100）——逐字保持三处既有类串。
  - 图标经 `icon` / `confirmIcon` slot 注入（默认 X / Check）；`v-if` 渲染条件与 `@click`
    处理器仍由调用方持有（行级条件差异）。
-->
<template>
  <Button
    variant="ghost"
    size="icon"
    :data-testid="confirming ? `${testid}-confirm` : testid"
    :data-confirming="confirming ? 'true' : 'false'"
    :class="buttonClass"
    :title="confirming ? confirmTitle : title"
  >
    <slot v-if="confirming" name="confirmIcon">
      <Check class="size-3" />
    </slot>
    <slot v-else name="icon">
      <X class="size-3" />
    </slot>
  </Button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Check, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    /** testid 基础名（确认态渲染 `${testid}-confirm`） */
    testid: string
    /** 确认态（原语 isConfirming 判定结果） */
    confirming: boolean
    /** 常态 title */
    title: string
    /** 确认态 title */
    confirmTitle: string
    /** 基础 rounded-sm 档（bash/subagent 有、workflow 行无） */
    rounded?: boolean
    /** 确认态透明度归位（bash kill 行专用） */
    confirmOpacity?: boolean
  }>(),
  { rounded: true, confirmOpacity: false },
)

const buttonClass = computed(() =>
  cn(
    'size-5 shrink-0',
    props.rounded ? 'rounded-sm' : '',
    props.confirming
      ? cn('border border-danger bg-danger text-neutral-fg', props.confirmOpacity ? 'opacity-100' : '')
      : 'text-neutral-dim hover:text-danger',
  ),
)
</script>
