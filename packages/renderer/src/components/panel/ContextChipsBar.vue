<template>
  <!--
    已附上下文 chip 行（draft-composer-states §2f）。
    输入区上方：每条已附上下文（@ 引用 / # 文件 / 图片）一个小徽章，每条都带直接删除按钮。
    数据源：父组件（Composer）从输入区 segments 派生 image chips（id=path），经 props 注入；
    删除经 emit('remove', id) 回传父组件定位 DOM 节点移除（W4：从本地 ref([]) 改 props/emit 接真实数据源）。

    形态权威：demo .ctxchip 22px 档（specs/composer/composer-chips.md 两档同步契约——行内 20px 档
    与本档同一形态家族），消费 .composer 作用域 --chip-* 变量（圆角 --chip-r / 底 --chip-bg，
    改一处两档同变）；删除钮 hover 中性（底 --elevated + 字 --fg），红色只留给真正不可逆动作。

    [窄宽容错] chip 宽 `max-w-[min(200px,100%)]` + `min-w-0`：容器窄于 200px 时 chip 跟着收缩
    （旧 `max-w-[180px] shrink-0` 在 < ~208px 的 composer 盒里被容器 overflow-hidden 切掉右半，
    × 按钮变得不可见且不可达——「无声裁切」）；内层 name span 补 `min-w-0` 让 truncate 真正生效，
    chip 挂 `:title` 兜住被截断的全名。
  -->
  <div v-if="items.length" class="flex flex-wrap items-center gap-1.5 overflow-hidden px-4 pt-[9px]">
    <!-- chip 形态（demo .ctxchip 22px 档）：高 22px / 截断 200px / pl7 pr5 / gap 5px / nowrap，
         hairline 边 + mid 字，统一中性档（无语义色分叉，image 同中性）；圆角与底消费
         .composer 作用域 --chip-r / --chip-bg 族变量（与行内 20px 档同族同变） -->
    <span
      v-for="item in items"
      :key="item.id"
      :title="item.name"
      class="group inline-flex h-[22px] min-w-0 max-w-[min(200px,100%)] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[var(--chip-r)] border border-hairline bg-[var(--chip-bg)] pl-[7px] pr-[5px] text-[length:var(--text-xs)] text-neutral-mid"
    >
      <component :is="iconFor(item)" class="size-3 shrink-0 text-neutral-dim" />
      <span class="min-w-0 truncate">{{ item.name }}</span>
      <Button
        variant="ghost"
        class="-mr-[2px] grid size-3.5 shrink-0 place-items-center rounded-[3px] p-0 text-neutral-dim transition-colors hover:bg-bg-elevated hover:text-neutral-fg"
        :title="t('panel.contextChips.removeFromContext')"
        @click.stop="onRemove(item.id)"
      >
        <X class="size-2.5" />
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
