<script setup lang="ts">
// MobileChatHeader —— 移动聊天视图头部（u13/A5：当前会话模型/思考档只读标签——V11「聊天头部」面）。
//
// 数据源：app-runtime 的 sessionList（core session store 投影），按 props.sessionId 派生当前
// SessionSummary——与列表行同源同值（SessionSummary.modelId/thinkingLevel，显示原始值）。
// summary 无匹配（列表未含当前会话，如创建在途）时整体不渲染，不占位。
// 只读标签面：无切换/无操作入口（桌面切换面在 composer 聚合按钮，移动壳面板族裁剪不承接）。
import { computed } from 'vue'
import { sessionList } from '../shell/app-runtime'

const props = defineProps<{ sessionId: string }>()

const summary = computed(() => sessionList.value.find((s) => s.id === props.sessionId))

/** 模型/思考档只读标签：modelId 必有；thinkingLevel 可选，有值以「 · 」分隔（与列表行同形） */
const modelLine = computed(() => {
  const s = summary.value
  if (!s) return ''
  return s.thinkingLevel ? `${s.modelId} · ${s.thinkingLevel}` : s.modelId
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
