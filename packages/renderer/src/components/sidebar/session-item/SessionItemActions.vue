<template>
  <!--
    SessionItem hover ghost 操作子块（2026-10-10 用户裁决：悬停钮收敛为 3 个 =
    rename / 删除两段确认 / 归入项目 Popover；标记完成与引用到输入区迁右键菜单
    SessionItemContextMenu——「其他的功能都放到右键」）。两段确认的状态在主组件
    （reset 通道：根 div mouseleave / watch active / Esc / onClickOutside 的锚点
    都在主组件），经 v-model:confirming 双向。
  -->
  <!-- 位置右缘垂直居中（demo .si-acts 权威：right 6px / top 50% 平移 / gap 2px）；
       钮序 = 重命名 → 删除 → 归入项目（demo 重设计 2026-10-10）。删除走两段式确认。 -->
  <div
    class="absolute right-[6px] top-1/2 -translate-y-1/2 gap-[2px]"
    :class="confirming ? 'flex' : 'flex opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100'"
  >
    <Button
      v-if="!confirming"
      variant="ghost"
      size="icon"
      class="size-[20px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
      :title="t('sidebar.sessionItem.rename')"
      @click.stop="emit('rename', session.id)"
    >
      <Pencil class="size-[12px]" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      :class="confirming
        ? 'size-[20px] rounded-sm bg-danger text-neutral-fg'
        : 'size-[20px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-danger'"
      :title="confirming ? t('sidebar.sessionItem.deleteConfirm') : t('sidebar.sessionItem.delete')"
      @click.stop="onRemoveClick"
    >
      <Check v-if="confirming" class="size-[12px]" />
      <Trash2 v-else class="size-[12px]" />
    </Button>
    <!-- 归入项目（D14 语义修正 2026-08-04）：Popover 菜单列全部 project，点击即归类。
         归类可逆（可再点其他 project / 默认项目），无需两段确认。 -->
    <Popover v-if="!confirming" :open="assignOpen" @update:open="assignOpen = $event">
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          data-testid="assign-project-btn"
          class="size-[20px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
          :title="t('sidebar.sessionItem.assignToProject')"
          @click.stop="assignOpen = true"
        >
          <FolderKanban class="size-[12px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" :collision-padding="8" class="w-44 p-1">
        <div class="flex flex-col gap-px">
          <!-- 默认项目项 id=''：未归类 session 的 projectId 是 undefined，必须归一为空串才能命中高亮（review S-2） -->
          <Button
            v-for="p in assignTargets"
            :key="p.id"
            variant="ghost"
            data-testid="assign-project-option"
            class="h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-[length:var(--text-xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
            :class="(session.projectId || '') === p.id ? 'text-accent' : ''"
            @click="onAssign(p.id)"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="(session.projectId || '') === p.id ? 'bg-accent' : 'bg-transparent'"
            />
            <span class="truncate">{{ p.name || t('sidebar.projectSwitcher.defaultName') }}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Pencil, Trash2, FolderKanban } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useAssignTargets } from './assign-targets'
import type { SessionItemSession } from './types'

const props = defineProps<{
  session: SessionItemSession
  /** 删除两段式确认态（状态在主组件，reset 多路通道锚点在主组件） */
  confirming: boolean
}>()

const emit = defineEmits<{
  'update:confirming': [value: boolean]
  delete: [sessionId: string]
  rename: [sessionId: string]
  /** 归入项目（D14 语义修正）：payload 单对象（规则 #1）。projectId 空串 = 归回默认项目。 */
  setProject: [{ sessionId: string; projectId: string }]
}>()

const { t } = useI18n()

// ── 归入项目菜单（D14 语义修正 2026-08-04）──
const assignOpen = ref(false)
/** 归类目标列表（与右键菜单「移动到项目」分组共用同一实现，assign-targets.ts）。 */
const assignTargets = useAssignTargets()
/** 点击归类：emit + 关菜单（归类可逆，无需两段确认） */
function onAssign(projectId: string): void {
  emit('setProject', { sessionId: props.session.id, projectId })
  assignOpen.value = false
}

/** 删除两段式确认：首次点击进确认态（不 emit），再次点击才 emit delete。
 *  复位由主组件多路通道执行（见 props.confirming 注释）。 */
function onRemoveClick(): void {
  if (!props.confirming) {
    emit('update:confirming', true)
    return
  }
  emit('update:confirming', false)
  emit('delete', props.session.id)
}

</script>
