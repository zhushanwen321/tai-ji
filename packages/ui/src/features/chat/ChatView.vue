<template>
  <!--
    ChatView —— ui 包 chat 展示薄壳（w6 chat-ui-and-shell T5，AC1 载体）。

    职责（clarify Q1 方案 2）：
    - 组装迁来的展示子树（Turn 列表 + SystemNotice），不含 virtua/scroll/rail/fork-notice
      （这些留 renderer MessageStream.vue 壳层编排）
    - ChatViewDeps 由 renderer 壳 provide（上层 inject），本组件不 provide

    AC1 冒烟：composer 输入区用 data-testid 占位元素（真实 composer 由 renderer 壳注入，
    composer 域独立 slice，ui 薄壳不耦合 composer 实现）。
  -->
  <div class="chat-view flex flex-col" data-testid="chat-view">
    <template v-for="item in renderItems" :key="renderKey(item)">
      <!-- kind 全集查表（renderer-model 归一 M1）：systemNotice → 一行通知；bashExecution → 输出块；其余 → turn -->
      <SystemNotice v-if="item.kind === 'systemNotice'" :message="item.message" />
      <BashOutputBlock
        v-else-if="item.kind === 'bashExecution'"
        :message="item.message"
        :session-id="sessionId"
      />
      <Turn
        v-else
        :turn="item.turn"
        :session-id="sessionId"
        :is-session-active="isSessionActive"
      />
    </template>
    <!-- composer 占位（AC1：真实 composer 由 renderer 壳注入） -->
    <div data-testid="composer-placeholder" />
  </div>
</template>

<script setup lang="ts">
/**
 * ChatView 展示薄壳：把扁平 messages 按 turn 分组，渲染 Turn 列表 + SystemNotice。
 *
 * 不含壳层编排（virtua/scroll/rail/fork-notice/stick guard provide），这些归 renderer
 * MessageStream.vue。ChatView 只组装展示子树，是 renderer 壳的消费对象 + AC1 冒烟载体。
 */
import { computed } from 'vue'
import { toRenderItems, renderKey } from '@taiji/core/domain/chat'
import type { Message } from '@taiji/shared'
import Turn from './Turn.vue'
import SystemNotice from './SystemNotice.vue'
import BashOutputBlock from './BashOutputBlock.vue'

const props = withDefaults(
  defineProps<{
    messages: Message[]
    sessionId: string
    /** session 是否进行中（透传给 Turn 控制 streaming 态） */
    isSessionActive?: boolean
  }>(),
  { isSessionActive: false },
)

/** 扁平 messages → RenderItem 列表（turn + system 穿插），core 纯函数分组 */
const renderItems = computed(() => toRenderItems(props.messages))
</script>
