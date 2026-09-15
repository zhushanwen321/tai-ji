<script setup lang="ts">
/**
 * GroupCard —— v6 §5.8 设置分组卡片。
 *
 * 范式（v6-master-spec §5.8）：
 * - bg-card + 圆角 var(--radius-card)，去 border（靠 surface 浮起分层，不叠 border）
 * - header 浮起分层：bg-surface-2 + 顶部 1px 极淡高光（rgba 0.04）
 * - header 左侧 title / actions slot；右侧 actions slot + 可选折叠按钮
 * - body 为默认 slot
 * - 多个 GroupCard 之间 space-4 留白（由 :where 兄弟选择器提供）
 */
import { ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '@taiji/ui'

withDefaults(
  defineProps<{
    title?: string
    collapsible?: boolean
  }>(),
  { collapsible: false },
)

const collapsed = ref(false)
function toggle(): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="group-card">
    <header v-if="title || $slots.head || collapsible" class="group-head">
      <div class="head-left">
        <slot name="head">
          <h3 v-if="title" class="title">{{ title }}</h3>
        </slot>
      </div>
      <div class="head-right">
        <slot name="actions" />
        <Button
          v-if="collapsible"
          variant="ghost"
          class="collapse-btn"
          :class="{ down: collapsed }"
          :title="collapsed ? '展开' : '折叠'"
          :aria-expanded="!collapsed"
          @click="toggle"
        >
          <ChevronDown class="collapse-ico" />
        </Button>
      </div>
    </header>
    <div v-show="!collapsed" class="group-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.group-card {
  background: var(--bg-card);
  border-radius: var(--radius-card);
  overflow: hidden;
}
.group-card + :deep(.group-card),
.group-card + .group-card {
  margin-top: var(--space-4);
}
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 10px 16px;
  background: var(--surface-2);
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.group-head:first-child {
  border-top: 0;
}
.head-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex: 1;
}
.head-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
.title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.collapse-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.collapse-btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.collapse-ico {
  width: 16px;
  height: 16px;
  transition: transform var(--duration-fast) var(--ease);
  transform: rotate(0deg);
}
.collapse-btn.down .collapse-ico {
  transform: rotate(-90deg);
}
</style>
