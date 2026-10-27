<template>
  <!--
    项目分组区降级呈现（connection-datasync-ssot §6.5/§6.7 三形态的非分组侧）：
    - mode='failed'：失败状态条（失败原因 + 重试钮；重试 = 触发 project 域同步，
      连接边沿恢复同样自动重拉，手动通道单独可达）
    - mode='loading'：无数据形态加载占位（idle / 从未成功加载过的 loading）——
      不渲染兜底默认组（把「不可用」显示成「只有一个空默认组」正是事故可见症状）
    只替换项目分组区；区头计数等会话清单消费不受影响（§6.7 会话本体不受影响）。
  -->
  <div
    v-if="mode === 'failed'"
    class="mx-[4px] mt-[2px] flex items-center gap-[6px] rounded-[var(--radius-xs)] border border-hairline bg-warn-soft px-[8px] py-[6px]"
    data-testid="project-load-failed-bar"
    role="alert"
  >
    <span class="min-w-0 flex-1 break-all text-[length:var(--text-2xs)] text-warn">
      {{ t('sidebar.sessionList.projectLoadFailed', { error: loadError }) }}
    </span>
    <Button
      variant="ghost"
      size="sm"
      data-testid="project-load-retry-btn"
      class="h-[22px] shrink-0 rounded-[var(--radius-xs)] px-[8px] text-[length:var(--text-2xs)] text-warn hover:bg-surface-hover hover:text-warn"
      :title="t('sidebar.sessionList.projectLoadRetry')"
      @click="emit('retry')"
    >{{ t('sidebar.sessionList.projectLoadRetry') }}</Button>
  </div>
  <div
    v-else
    class="px-[10px] py-[10px] text-[length:var(--text-2xs)] text-neutral-dim"
    data-testid="project-group-loading-placeholder"
  >
    {{ t('sidebar.sessionList.projectsLoading') }}
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'

defineProps<{
  /** 降级形态：failed = 失败状态条 / loading = 无数据加载占位（调用方按 §6.7 判定） */
  mode: 'failed' | 'loading'
  /** failed 态的失败原因（状态条原因文案） */
  loadError: string
}>()

const emit = defineEmits<{
  /** 重试钮：触发 project 域同步（域同步器 requestDomainSync('project')） */
  retry: []
}>()

const { t } = useI18n()
</script>
