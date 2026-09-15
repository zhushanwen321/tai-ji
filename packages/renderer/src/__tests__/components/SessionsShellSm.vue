<!--
  SessionsShellSm —— w5 首屏冒烟临时测试壳组件（TC-6 渲染 gate）。
  setup 调 useSidebar()，渲染 session 列表 + focused chip，defineExpose sidebar 供测试读状态。
  非生产组件——仅冒烟测试消费；2026-08-31 双轨收尾后 useSidebar 已是新轨唯一实现（原
  useSidebar 重命名接管），本组件随之归位，后续冒烟形态演进时可删除。
-->
<script setup lang="ts">
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'

const sidebar = useSidebar()
const sessionStore = useSessionStore()

function pick(id: string): void {
  void sidebar.selectSession(id)
}

defineExpose({ sidebar })
</script>

<template>
  <div class="sessions-shell-sm">
    <div data-testid="focused-chip">
      {{ sidebar.focusedSession.value?.label ?? '(no focus)' }}
    </div>
    <ul data-testid="session-list">
      <li
        v-for="s in sessionStore.list"
        :key="s.id"
        data-testid="session-item"
        :data-id="s.id"
        @click="pick(s.id)"
      >
        {{ s.label }}
      </li>
    </ul>
  </div>
</template>
