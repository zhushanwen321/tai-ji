<template>
  <!--
    展示组件 · 默认项目轻量头行（默认区锚定/新建/拖放入口的单一承载）。
    背景：默认项目 = 未归类收件箱（2026-10-13 裁决：不渲染 ProjectGroup 框——无组头/
    无左线/无缩进），锚定一旦切到命名项目后没有任何 UI 路径切回，新会话从此进不了
    默认项目。本行以「轻量标签行」形态补齐入口，不恢复项目框：无框/无左线/无缩进，
    文字 + 「当前」chip + hover 浮现「+」，与 SessionDirLabel 目录标签行同量级。
    交互：点行主体 = 锚定默认项目（新会话归属随之落默认区）；点「+」= 先锚定再进
    空态新建（与命名组头「+」onCreateTaskIn 同构）；整行是 session 拖拽落点
    （useSessionDropTarget，drop 即归回默认项目）。
  -->
  <div
    class="group/dph flex min-h-[26px] select-none items-center gap-[6px] rounded-sm px-[8px] py-[4px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]"
    :class="dropActive ? 'bg-surface-hover' : ''"
    data-testid="default-project-head"
    :data-dragover="dropActive ? 'true' : undefined"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      role="button"
      tabindex="0"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-[6px] text-left"
      data-testid="default-project-anchor"
      :aria-label="name"
      @click="emit('anchor')"
      @keydown.enter.prevent="emit('anchor')"
      @keydown.space.prevent="emit('anchor')"
    >
      <span class="min-w-0 truncate text-[12.5px] [font-weight:var(--fw-mid)] text-neutral-fg-2 group-hover/dph:text-neutral-fg">
        {{ name }}
      </span>
      <span
        v-if="current"
        class="flex-none rounded-full px-[6px] py-[3px] text-[10px] leading-none text-neutral-fg bg-[var(--sel-bg)] shadow-[inset_0_0_0_1px_var(--sel-edge)]"
        data-testid="default-project-current-chip"
      >
        {{ t('sidebar.projectGroup.currentChip') }}
      </span>
    </div>
    <Button
      variant="ghost"
      size="icon"
      class="relative hidden flex-none grid size-[20px] place-items-center rounded-[5px] p-0 text-neutral-dim after:absolute after:inset-[-2px] after:content-[''] hover:bg-surface-hover hover:text-neutral-fg group-hover/dph:grid group-focus-within/dph:grid [&_svg]:size-[12px]"
      :title="t('sidebar.sessionList.newSessionInDefault')"
      :aria-label="t('sidebar.sessionList.newSessionInDefault')"
      data-testid="default-project-new-task"
      @click.stop="emit('createTask')"
    >
      <Plus :stroke-width="1.8" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useSessionDropTarget } from '@/composables/features/sidebar/use-session-drop-target'

const { t } = useI18n()

defineProps<{
  /** 是否锚定在默认项目（「当前」chip 渲染条件） */
  current: boolean
  /** 头行文字（父级解析默认项目兜底文案后传入，组件不做 i18n 查找耦合） */
  name: string
}>()

const emit = defineEmits<{
  /** 点行主体：锚定默认项目（父级 setActiveProject(DEFAULT_PROJECT_ID)） */
  anchor: []
  /** 点「+」：先锚定默认项目再 emit（父级编排，同 onCreateTaskIn 范式） */
  createTask: []
  /** session 拖入本行：归回默认项目（父级转 setProject，projectId=''） */
  dropSession: [sessionId: string]
}>()

const { dropActive, onDragOver, onDragLeave, onDrop } = useSessionDropTarget((sessionId) =>
  emit('dropSession', sessionId),
)
</script>
