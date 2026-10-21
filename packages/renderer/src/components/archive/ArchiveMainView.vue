<template>
  <!--
    容器组件 · 主区归档摘要视图宿主（session-archive 设计 D11 挂载编排，u-renderer-entry）。

    view:'archive' 路由（MainPanel 分支，navigation.push 由 useArchiveView.openSummary
    驱动）的内容区：读 archive store.selected → ArchiveSummaryView（u-renderer-summary
    交付的摘要视图组件）；restore 事件接 useArchiveView.restoreArchive（模块级单例编排——
    恢复成功切回会话列表 + 主区回 chat）。

    卡壳：与对话流卡片同规格（PanelContainer main-area 对话卡的 demo .chat-card 形态：
    rounded-[--radius-card] + hairline 边 + bg-surface，无阴影）——同位置整卡呈现、
    不带右抽屉/底抽屉，三卡化布局下与对话流视觉一致。

    selected 为 null（导航到 archive view 而无选中条目——恢复/彻底删除后编排清空、
    或异常直达）→ 卡内占位空态（不自动回跳：用户可经侧栏重新选择条目）。
  -->
  <div
    class="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-hairline bg-surface"
    data-testid="archive-main-view"
  >
    <ArchiveSummaryView
      v-if="archiveStore.selected"
      :archive="archiveStore.selected"
      @restore="onRestore"
    />
    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="archive-main-empty"
    >
      <Archive class="size-8 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-55">{{ t('archive.main.noSelection') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Archive } from '@lucide/vue'
import ArchiveSummaryView from './ArchiveSummaryView.vue'
import { useArchiveStore } from '@/stores/archive'
import { useArchiveView } from '@/composables/features/sidebar/useArchiveView'

const { t } = useI18n()
const archiveStore = useArchiveStore()
const { restoreArchive } = useArchiveView()

function onRestore(): void {
  const selected = archiveStore.selected
  if (selected) void restoreArchive(selected)
}
</script>
