<template>
  <!--
    容器组件 · 主区归档摘要视图宿主（session-archive 设计 D11 挂载编排，u-renderer-entry）。

    view:'archive' 路由（MainPanel 分支，navigation.push 由 useArchiveView.openSummary
    驱动）的内容区：读 archive store.selected → ArchiveSummaryView（u-renderer-summary
    交付的摘要视图组件）+ projectName 按 projectId 解析注入；restore 事件接
    useArchiveView.restoreArchive（模块级单例编排——恢复成功切回会话列表 + 主区回 chat）。

    selected 为 null（导航到 archive view 而无选中条目——恢复/彻底删除后编排清空、
    或异常直达）→ 占位空态（不自动回跳：用户可经侧栏重新选择条目）。
  -->
  <div class="h-full min-h-0" data-testid="archive-main-view">
    <ArchiveSummaryView
      v-if="archiveStore.selected"
      :archive="archiveStore.selected"
      :project-name="projectName"
      @restore="onRestore"
    />
    <div
      v-else
      class="flex h-full flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="archive-main-empty"
    >
      <Package class="size-8 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-55">{{ t('archive.main.noSelection') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Package } from '@lucide/vue'
import ArchiveSummaryView from './ArchiveSummaryView.vue'
import { useArchiveStore } from '@/stores/archive'
import { useProjectStore } from '@/stores/project'
import { useArchiveView } from '@/composables/features/sidebar/useArchiveView'

const { t } = useI18n()
const archiveStore = useArchiveStore()
const projectStore = useProjectStore()
const { restoreArchive } = useArchiveView()

/** 原项目显示名（projectId 解析；未解析/未归类传 undefined——banner 省略该段，D11）。 */
const projectName = computed<string | undefined>(() => {
  const id = archiveStore.selected?.projectId
  if (!id) return undefined
  const name = projectStore.projects.find((p) => p.id === id)?.name
  return name && name.length > 0 ? name : undefined
})

function onRestore(): void {
  const selected = archiveStore.selected
  if (selected) void restoreArchive(selected)
}
</script>
