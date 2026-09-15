<template>
  <!--
    已附上下文 chip 行（draft-composer-states §2f）。
    输入区上方：每条已附上下文（@ 引用 / # 文件 / 图片）一个小徽章，每条都带直接删除按钮。
    数据源：父组件（Composer）从输入区 segments 派生 image chips（id=path），经 props 注入；
    删除经 emit('remove', id) 回传父组件定位 DOM 节点移除（W4：从本地 ref([]) 改 props/emit 接真实数据源）。
  -->
  <div v-if="items.length" class="flex flex-wrap items-center gap-1.5 overflow-hidden px-3.5 pt-[7px]">
    <span
      v-for="item in items"
      :key="item.id"
      class="group inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[length:var(--text-2xs)] text-neutral-mid"
      :class="item.type === 'image' ? 'text-reasoning' : ''"
    >
      <component :is="iconFor(item)" class="size-3 shrink-0" :class="item.type === 'image' ? 'text-reasoning' : 'text-neutral-dim'" />
      <span class="truncate">{{ item.name }}</span>
      <Button
        variant="ghost"
        class="ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-danger-soft hover:text-danger"
        :title="t('panel.contextChips.removeFromContext')"
        @click.stop="onRemove(item.id)"
      >
        <X class="size-3" />
      </Button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { markRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Image as ImageIcon, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'

/** 单条已附上下文（由父组件从 segments 派生：image → {id:path,name,type:'image'}） */
interface AttachedContextItem {
  id: string
  name: string
  type: '@' | '#' | 'image'
}

defineProps<{ items: AttachedContextItem[] }>()
const emit = defineEmits<{ (e: 'remove', id: string): void }>()

const { t } = useI18n()

function iconFor(item: AttachedContextItem) {
  return item.type === 'image' ? markRaw(ImageIcon) : markRaw(FileText)
}

/** 移除某条已附上下文：转发给父组件 emit('remove', id)，父组件定位 DOM 节点移除 */
function onRemove(id: string): void {
  emit('remove', id)
}
</script>
