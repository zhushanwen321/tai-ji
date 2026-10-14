<template>
  <!--
    已附上下文 chip 行（draft-composer-states §2f）。
    输入区上方：每条已附上下文（@ 引用 / # 文件 / 图片）一个小徽章，每条都带直接删除按钮。
    数据源：父组件（Composer）从输入区 segments 派生 image chips（id=path），经 props 注入；
    删除经 emit('remove', id) 回传父组件定位 DOM 节点移除（W4：从本地 ref([]) 改 props/emit 接真实数据源）。

    形态权威：demo .ctxchip 22px 档（specs/composer/composer-chips.md 两档同步契约——行内 20px 档
    与本档同一形态家族），消费 .composer 作用域 --chip-* 变量（圆角 --chip-r / 底 --chip-bg /
    边 --chip-border，改一处两档同变；上下文档直引 hairline 是契约缺角，已归位变量）；删除钮
    hover 中性（底 --elevated + 字 --fg），红色只留给真正不可逆动作。

    [窄宽容错] chip 宽 `max-w-[min(200px,100%)]`：容器窄于 200px 时百分比盖帽把 chip 压到容器宽
    （旧 `max-w-[180px] shrink-0` 在 < ~208px 的 composer 盒里被容器 overflow-hidden 切掉右半，
    × 按钮变得不可见且不可达——「无声裁切」）。截断的真实生效机制 = max-w 百分比盖帽，与
    shrink-0 无关——shrink-0 只决定多 chip 溢出走 wrap、chip 自身永不收缩，chip 级 min-w-0
    在其下恒无效（已删）；truncate 生效的真实条件 = 被盖帽压窄的 chip 内，内层 name span 的
    `min-w-0` 允许它缩到内容宽以下（ellipsis 才挂得上）。chip 挂 `:title` 兜住被截断的全名。
  -->
  <div v-if="items.length" class="flex flex-wrap items-center gap-1.5 overflow-hidden px-4 pt-[9px]">
    <!-- chip 形态（demo .ctxchip 22px 档）：高 22px / 截断 200px / pl7 pr5 / gap 5px / nowrap，
         chip-border 边 + mid 字，统一中性档（无语义色分叉，image 同中性）；圆角与底消费
         .composer 作用域 --chip-r / --chip-bg 族变量（与行内 20px 档同族同变） -->
    <span
      v-for="item in items"
      :key="item.id"
      :title="item.name"
      class="group inline-flex h-[22px] max-w-[min(200px,100%)] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[var(--chip-r)] border border-[color:var(--chip-border)] bg-[var(--chip-bg)] pl-[7px] pr-[5px] text-[length:var(--text-xs)] text-neutral-mid transition-colors duration-[var(--duration-fast)]"
    >
      <!-- image lead = 16px 真图缩略（demo .ctxchip .thumb 四值：16px / r-3.5px /
           object-fit cover / flex none），经 local-file:// 通道加载（attachments/tmpdir
           白名单落点）；加载失败回退 ImageIcon 占位不留破图（demo 对齐）。
           items 形状 = core AttachedContextItem（type 恒 'image'，refreshAttachedItems 唯一
           构造点），v-else 即失败回退占位——[HISTORICAL] 原 iconFor 的 FileText/'@'/'#'
           分支无构造方，随类型单源化收窄删除 -->
      <img
        v-if="!failedIds.has(item.id)"
        :src="localFileUrl(item.path)"
        :alt="item.name"
        data-testid="context-chip-thumb"
        class="size-4 shrink-0 rounded-[3.5px] object-cover"
        @error="markFailed(item.id)"
      />
      <ImageIcon v-else class="size-3 shrink-0 text-neutral-dim" />
      <span class="min-w-0 truncate">{{ item.name }}</span>
      <Button
        variant="ghost"
        class="-mr-[2px] grid size-3.5 shrink-0 place-items-center rounded-[3px] p-0 text-neutral-dim transition-colors duration-[var(--duration-fast)] hover:bg-surface-hover hover:text-neutral-fg"
        :title="t('panel.contextChips.removeFromContext')"
        @click.stop="onRemove(item.id)"
      >
        <X class="size-2.5" />
      </Button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Image as ImageIcon, X } from '@lucide/vue'
import type { AttachedContextItem } from '@taiji/core/domain/composer'
import { localFileUrl } from '@taiji/shared'
import { Button } from '@/components/ui/button'

/** 单条已附上下文形状单源 = core AttachedContextItem（path = 图片磁盘路径，缩略图 src 源） */
defineProps<{ items: AttachedContextItem[] }>()
const emit = defineEmits<{ (e: 'remove', id: string): void }>()

const { t } = useI18n()

/** 加载失败项 id 集（onerror 置位 → 该 chip 回退 ImageIcon 占位；不可变更新驱动重渲）。
 *  失败标记不随 items 清理：id 是 uuid 恒不复用，失败态对已删除 id 残留无观测面。 */
const failedIds = ref<Set<string>>(new Set())

function markFailed(id: string): void {
  const next = new Set(failedIds.value)
  next.add(id)
  failedIds.value = next
}

/** 移除某条已附上下文：转发给父组件 emit('remove', id)，父组件定位 DOM 节点移除 */
function onRemove(id: string): void {
  emit('remove', id)
}
</script>
