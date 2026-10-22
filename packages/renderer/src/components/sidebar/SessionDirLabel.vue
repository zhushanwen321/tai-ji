<template>
  <!--
    目录静态标签行（demo .gh.gh-static）：无折叠钮、会话始终可见，归属靠缩进表达。
    从 SessionList 抽出（2026-10-13 默认项目平铺区复用同一标签行——目录模式下默认项目的
    目录标签直接平铺在列表顶部，与命名项目组内的标签行同构）。
    行内悬停操作（+ 新建 / 批量删除）= real 独有功能性入口；两段式确认态由父级持有
    （confirming prop 只读展示，确认/复位编排归 SessionList 的 folderConfirmingCwd）。
  -->
  <div class="group/folder flex items-center gap-[6px] pr-[8px] pl-[9px] pt-[9px] pb-[4px]">
    <Folder class="size-[11px] shrink-0 text-neutral-dim" />
    <span class="min-w-0 truncate font-mono text-[length:var(--text-2xs)] text-neutral-dim">
      {{ dirNameOf(cwd) }}
    </span>
    <span class="ml-auto font-mono text-[length:var(--text-2xs)] text-neutral-fg-2">{{ count }}</span>
    <!-- folder 行操作区：+ 新建（非破坏性，恒渲染）与批量删除（两段式确认）。
         右贴由计数 span 的 ml-auto 承接；hover 显隐。
         [review MF-2] 删除按钮显隐由父级 isFolderDeleteAvailable 裁决（deleteAvailable）：
         removeByCwd 是 cwd 全量删除（项目无关），项目分组隐藏了部分 session 时点删除会
         误删用户不可见的其他 project session；+ 按钮无此检查。 -->
    <div
      class="flex items-center gap-1"
      data-testid="folder-actions"
      :class="confirming ? '' : 'opacity-0 group-hover/folder:opacity-100'"
      @mouseleave="emit('leave', cwd)"
    >
      <Button
        variant="ghost"
        size="icon"
        data-testid="folder-new-session-btn"
        class="size-[22px] rounded-sm border border-border-strong bg-surface text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
        :title="t('sidebar.sessionList.newSessionInFolder')"
        @click.stop="emit('newInFolder', cwd)"
      >
        <Plus class="size-[13px]" />
      </Button>
      <Button
        v-if="deleteAvailable"
        variant="ghost"
        size="icon"
        data-testid="folder-delete-btn"
        :class="confirming
          ? 'size-[22px] rounded-sm border border-danger bg-danger text-danger-fg'
          : 'size-[22px] rounded-sm border border-border-strong bg-surface text-neutral-mid hover:bg-surface-hover hover:text-danger'"
        :title="confirming
          ? t('sidebar.sessionList.deleteFolderConfirm')
          : t('sidebar.sessionItem.delete')"
        @click.stop="emit('removeClick', cwd)"
      >
        <Check v-if="confirming" class="size-[13px]" />
        <Trash2 v-else class="size-[13px]" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Folder, Plus, Trash2, Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { dirNameOf } from '@taiji/ui'

const { t } = useI18n()

defineProps<{
  /** 目录 cwd（标签显 cwd 末段 + 操作事件回带，父级按 cwd 路由） */
  cwd: string
  /** 目录内会话数（静态计数） */
  count: number
  /** 该 cwd 处于删除两段式确认态（父级 folderConfirmingCwd 派生视图） */
  confirming: boolean
  /** 批量删除按钮显隐（review MF-2：组内可见数 = 该 cwd 全量数才可删） */
  deleteAvailable: boolean
}>()

const emit = defineEmits<{
  /** 「+」：以该 cwd 为预选目录进 landing 新建 */
  newInFolder: [cwd: string]
  /** 删除钮点击（父级做两段式确认编排：首击进确认态，再击 emit deleteFolder） */
  removeClick: [cwd: string]
  /** 鼠标离开操作区（父级复位确认态） */
  leave: [cwd: string]
}>()
</script>
