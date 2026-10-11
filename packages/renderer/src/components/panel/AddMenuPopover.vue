<template>
  <!--
    + 添加内容 popover（draft-composer-states §1 ①）。
    click 触发，三路：附件（任意文件）/ 图片 / / 命令。
    attach / image 均调 pickFile IPC（附件无 filters / 图片带 image filters）；# 文件改走输入区敲 # 的 inline 触发。
    行形态对齐 demo `.popover` 附加菜单（M4c）：纯文字行（无行首图标）+「命令」行尾 `/`
    提示标（demo .slash-hint：hover 底胶囊，中性档——N14 口径 accent 底保留给未读需关注态）。
  -->
  <Popover v-model:open="open">
    <PopoverTriggerButton
      :open="open"
      variant="icon"
      :show-chevron="false"
      :title="t('panel.composer.addContent')"
    >
      <Plus class="size-[16px]" :stroke-width="1.6" />
    </PopoverTriggerButton>
    <!-- 容器对齐 demo `.popover` 基形态：左锚 / 锚距 10px / 最小宽 160px / r-lg / 4px 内边距 -->
    <PopoverContent
      side="top"
      align="start"
      :side-offset="10"
      class="am-pop-motion min-w-[160px] rounded-lg p-1"
    >
      <Button
        v-for="item in items"
        :key="item.type"
        variant="ghost"
        class="flex min-h-[28px] w-full items-center justify-start gap-2 rounded-sm px-2 py-[5px] font-normal text-[length:var(--text-xs)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
        @click="onSelect(item.type)"
      >
        <span class="flex-1 text-left">{{ item.label }}</span>
        <!-- demo .slash-hint 提示标：hover 底 + mid 字胶囊（仅 slash 项携带 hint） -->
        <span
          v-if="item.hint"
          class="grid h-[15px] min-w-[16px] place-items-center rounded-full bg-surface-hover px-[4px] font-mono text-[length:var(--text-3xs)] [font-weight:var(--fw-mid)] text-neutral-mid"
          role="img"
          :aria-label="item.label"
        >{{ item.hint }}</span>
      </Button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTriggerButton } from '@/components/ui/popover'

type AddType = 'attach' | 'image' | 'slash'

interface AddItem {
  type: AddType
  label: string
  hint?: string
}

const emit = defineEmits<{
  select: [type: AddType]
}>()

const { t } = useI18n()
const open = ref(false)

// 行首图标已删（M4c demo 对齐：demo 附加菜单行 = 纯文字，图标语言只用于线列表行）；
// hint = 行尾提示标文案（demo slash-hint 同位）
const ITEMS: AddItem[] = [
  { type: 'attach', label: t('panel.composer.attach') },
  { type: 'image', label: t('panel.composer.image') },
  { type: 'slash', label: t('panel.composer.command'), hint: '/' },
]

// file 入口移除后无 session 守门需求（attach/slash 均与 cwd 无关），items 退化为常量
const items = ITEMS

function onSelect(type: AddType): void {
  open.value = false
  emit('select', type)
}
</script>

<style>
/*
 * 添加菜单开合动效（demo E5 方向缓动；M4b tray-pop-motion 同范式，机制说明见
 * ModelSelectPopover.vue 文件尾同款块）：进 ease-out / 出 ease-in，位移 3px + 透明度，
 * 120ms；@starting-style 提供进场首帧；reduced-motion 全关。am- 前缀命名空间。
 */
.am-pop-motion[data-state='open'] {
  transform: translateY(0) !important;
  transition-timing-function: var(--ease-out) !important;
}
.am-pop-motion[data-state='closed'] {
  transform: translateY(3px) !important;
  transition-timing-function: var(--ease-in) !important;
}
@starting-style {
  .am-pop-motion[data-state='open'] {
    transform: translateY(3px) !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  .am-pop-motion[data-state='open'],
  .am-pop-motion[data-state='closed'] {
    transition: none !important;
  }
}
</style>
