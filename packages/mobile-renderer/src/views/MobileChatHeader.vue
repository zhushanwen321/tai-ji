<script setup lang="ts">
// MobileChatHeader —— 移动聊天视图头部（u13/A5：当前会话模型/思考档只读标签——V11「聊天头部」面）。
//
// 数据源：app-runtime 的 liveStateOf（状态层，按会话 id 寄存的运行时事实）——与列表行同源
// 同值；sessionList 仍用于确认会话存在（列表未含当前会话如创建在途时整体不渲染，不占位）。
// [W1 会话架构四层分离] 状态层缺失 = 显式未知 → 头部不渲染模型行（不回退列表种子字段）。
// 只读标签面：无切换/无操作入口（桌面切换面在 composer 聚合按钮，移动壳面板族裁剪不承接）。
import { computed } from 'vue'
import { liveStateOf, sessionList } from '../shell/app-runtime'

const props = defineProps<{ sessionId: string }>()

const summary = computed(() => sessionList.value.find((s) => s.id === props.sessionId))

/** 模型/思考档只读标签：状态层 modelId 为显示门槛；thinkingLevel 可选（与列表行同形） */
const modelLine = computed(() => {
  if (!summary.value) return ''
  const live = liveStateOf(summary.value.id)
  if (!live?.modelId) return ''
  return live.thinkingLevel ? `${live.modelId} · ${live.thinkingLevel}` : live.modelId
})
</script>

<template>
  <header
    v-if="modelLine"
    data-testid="mobile-chat-header"
    class="shrink-0 border-b border-border-strong px-3 py-2"
  >
    <p data-testid="mobile-chat-header-model" class="truncate text-xs text-neutral-dim">{{ modelLine }}</p>
  </header>
</template>
