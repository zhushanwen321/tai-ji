<script setup lang="ts">
/**
 * 选择类 popover 尾部动作项（架构审查 F5）。
 *
 * 统一 DirSelectPopover（打开文件夹 / 远程连接）与 BranchSelectPopover（创建分支 / Git 图谱）
 * 逐字相同的 Button markup：基础类 + hover 高亮。与 PopoverListItem 的差异：无选中态
 * （动作无「当前值」概念），结构固定为单 leading-icon + 单行 label。
 * 共享基础类抽自 composables/logic/popover-styles.ts。
 */
// ui 包内相对导入（不经 @taiji/ui 顶层 barrel）：primitives 是顶层 barrel 的
// 再导出来源，顶层 barrel 自引用会闭合循环依赖环
import { Button } from '../button'
import { POPOVER_LIST_ITEM_CLASS } from './styles'

const props = defineProps<{
  /** 是否为键盘/鼠标导航焦点项（hover 底色高亮） */
  active?: boolean
  /** 测试锚点（data-testid） */
  testId?: string
}>()

const emit = defineEmits<{
  (e: 'click'): void
  (e: 'mouseenter'): void
}>()
</script>

<template>
  <Button
    :data-testid="props.testId"
    variant="ghost"
    :class="[
      POPOVER_LIST_ITEM_CLASS,
      props.active ? 'bg-surface-hover' : '',
    ]"
    @click="emit('click')"
    @mouseenter="emit('mouseenter')"
  >
    <!-- leading icon（FolderPlus / Cloud / Plus / GitGraph） -->
    <slot name="icon" />
    <span><slot /></span>
  </Button>
</template>
