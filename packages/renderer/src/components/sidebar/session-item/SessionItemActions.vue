<template>
  <!--
    SessionItem hover ghost 操作子块（2026-10-10 用户裁决：悬停钮收敛为 3 个 =
    rename / 删除两段确认 / 归入项目 Popover；标记完成与引用到输入区迁右键菜单
    SessionItemContextMenu——「其他的功能都放到右键」）。两段确认的状态在主组件
    （reset 通道：根 div mouseleave / watch active / Esc / onClickOutside 的锚点
    都在主组件），经 v-model:confirming 双向。
  -->
  <!-- 位置 = Display 右槽覆盖层（2026-10-11 用户裁决：absolute inset-0 覆盖「点 + 时间」
       定宽槽、justify-end 贴右；槽定宽 58px 由 Display 声明，名称在槽左缘截断构造性不受遮）。
       钮序 = 重命名 → 归入项目 → 删除（用户裁决 2026-10-13：破坏性操作移至视线动线末端，
       误触路径最长）。删除走两段式确认。
       三钮 tabindex=-1（spec §3.4：键盘不走悬停钮，走行 Tab → Enter/Space → ContextMenu
       右键菜单通道）+ @pointerdown.stop（demo 同款：按下不触发行侧副作用）。
       钮 18px 视觉（缩宽裁决）+ after 伪元素外扩 3px = 24px 热区下限口径（同 .pp-act 技法）。 -->
  <div
    class="absolute inset-0 justify-end gap-[2px]"
    :class="confirming ? 'flex' : 'flex opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100'"
  >
    <Button
      v-if="!confirming"
      variant="ghost"
      size="icon"
      tabindex="-1"
      class="relative size-[18px] rounded-sm text-neutral-dim after:absolute after:inset-[-3px] after:content-[''] hover:bg-surface-hover hover:text-neutral-fg"
      :title="t('sidebar.sessionItem.rename')"
      @click.stop="emit('rename', session.id)"
      @pointerdown.stop
    >
      <Pencil class="size-[12px]" />
    </Button>
    <!-- 归入项目（D14 语义修正 2026-08-04）：Popover 浮层列全部 project，点击即归类。
         归类可逆（可再点其他 project / 默认项目），无需两段确认。
         浮层形态 = spec 待裁决 3 既定方向「复用右键菜单的项目选择浮层」：行渲染与
         SessionItemContextMenu「移动到项目」分组同构（行首 14px 定宽勾标列，当前归属项
         accent Check），仅含项目列表；迁移 toast 在共享 handler（useSidebarSessionActions）统一出。 -->
    <Popover v-if="!confirming" :open="assignOpen" @update:open="assignOpen = $event">
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          tabindex="-1"
          data-testid="assign-project-btn"
          class="relative size-[18px] rounded-sm text-neutral-dim after:absolute after:inset-[-3px] after:content-[''] hover:bg-surface-hover hover:text-neutral-fg"
          :title="t('sidebar.sessionItem.assignToProject')"
          @click.stop="assignOpen = true"
          @pointerdown.stop
        >
          <FolderKanban class="size-[12px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" :collision-padding="8" class="w-44 p-1">
        <div class="flex flex-col">
          <!-- 默认项目项 id=''：未归类 session 的 projectId 是 undefined，必须归一为空串才能命中勾标（review S-2） -->
          <Button
            v-for="p in assignTargets"
            :key="p.id"
            variant="ghost"
            data-testid="assign-project-option"
            class="flex h-[28px] w-full justify-start gap-2 rounded-sm px-[9px] text-[length:var(--text-xs)] text-neutral-fg hover:bg-surface-hover"
            @click="onAssign(p.id)"
          >
            <span class="flex w-[14px] shrink-0 items-center justify-center">
              <Check
                v-if="(session.projectId || '') === p.id"
                class="size-[11px] text-accent"
              />
            </span>
            <span class="min-w-0 truncate">{{ p.name || t('sidebar.projectGroup.defaultName') }}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
    <!-- 删除（两段确认）——钮序末位（用户裁决 2026-10-13：破坏性操作最右） -->
    <Button
      variant="ghost"
      size="icon"
      tabindex="-1"
      class="relative size-[18px] rounded-sm after:absolute after:inset-[-3px] after:content-['']"
      :class="confirming
        ? 'bg-danger text-neutral-fg'
        : 'text-neutral-dim hover:bg-surface-hover hover:text-danger'"
      :title="confirming ? t('sidebar.sessionItem.deleteConfirm') : t('sidebar.sessionItem.delete')"
      @click.stop="onRemoveClick"
      @pointerdown.stop
    >
      <Check v-if="confirming" class="size-[12px]" />
      <Trash2 v-else class="size-[12px]" />
    </Button>
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
