/**
 * chat store —— defineStore 薄包装（P3 chat 域绞杀 w4）。
 *
 * [归位] store 主体逻辑（messages 分区 / isGenerating 派生 / finalizeSession 收口 /
 * pendingSend 生命周期 / LRU 驱逐 / changeset / handoff / retry-queue 子域）已迁
 * @taiji/core/domain/chat/store.ts 的 createChatStore factory（IF1 契约）。
 * 本文件做三件事：
 *
 * 1. defineStore('chat', () => createChatStore(agentCallLruLinkage())) 注册到 pinia（core 不绑 store id，
 *    pinia store 注册是 shell 关切，factory + wrapper 模式对齐 handoff IF1）。
 *    [B9 agentcall LRU 联动] options 经 features 层装配模块注入（composables/features/
 *    chat/agentcall-lru-linkage.ts：workflow store 映射 ∖ viewedVids panel 枚举豁免），
 *    stores 间禁止互相 import → 装配外置到 features 层（对齐「跨 store 编排由调用方
 *    回调注入」既有约定）。
 * 2. [M2-c btw 重载链] setupBtwReplayWatch(store)——drawer 选中 btw 线时经既有
 *    getHistory 通路回放文件历史注入本 store 分区（详见 ./btw-replay.ts 头注释）；
 *    watch 绑定 store effect scope，$dispose 随 store 回收。
 *
 * [P4 s5 w2] 原唯一跨域依赖 openTasksPanelOnFirstData 回调（首数据到达开 tasks panel）
 * 已随 tasks 域删除一并移除（回调衔接的 useSideDrawer.open('tasks')/setPendingOpenForSid
 * 与 tasks store 同批删除）。
 *
 * ~30 个 useChatStore 消费方 import '@/stores/chat' 不变（factory + wrapper 模式下
 * useChatStore 仍在 renderer，零消费方 churn）。
 *
 * 历史：原文件 906 行（defineStore setup 函数体 + 10 个模块级 helper），w4 全部迁 core。
 * re-export（LRU_MAX_SESSIONS / RetryState / QueueState /
 * FinalizeReason）保持消费方兼容（chat-lru.test.ts /
 * RetryIndicator.vue / QueueBubble.vue 等）。
 */
import { defineStore } from 'pinia'
import { createChatStore } from '@taiji/core'
import { agentCallLruLinkage } from '@/composables/features/chat/agentcall-lru-linkage'
import { setupBtwReplayWatch } from './btw-replay'

export const useChatStore = defineStore('chat', () => {
  const store = createChatStore(agentCallLruLinkage())
  // [M2-c btw 重载链] 重开线回放接线：drawer 选中线翻出时文件 → 分区（applyEntry 投影）
  setupBtwReplayWatch(store)
  return store
})

// re-export 供外部消费（测试 / 组件读常量与类型），保持原 chat.ts 的 export 形状
export { LRU_MAX_SESSIONS } from '@taiji/core'
export type { RetryState, QueueState, FinalizeReason } from '@taiji/core'
